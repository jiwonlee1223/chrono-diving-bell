#!/usr/bin/env node
// Firestore 프로필 → 생애 라이브러리 생성 워커.
// 수집 앱이 제출한 프로필(status:'submitted')을 읽어 생성을 트리거한다.
//
//   node scripts/generate-from-firestore.mjs --once            # 대기분 한 배치 처리 후 종료
//   node scripts/generate-from-firestore.mjs --watch           # 폴링 루프 (전시 중 상시 구동)
//   node scripts/generate-from-firestore.mjs --once --limit 1  # 1건만
//   node scripts/generate-from-firestore.mjs --once --include-errors  # 실패분 재시도 포함
//
// 서비스 계정 키가 필요하다 — README(FIRESTORE.md) 참조.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateLifeLibrary } from '../src/main/comfyui/life-library.js'
import {
  initFirebase,
  fetchPendingProfiles,
  claimProfile,
  setProfileStatus,
  downloadPhotos,
  toGeneratorProfile
} from '../src/main/comfyui/firestore-source.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valOf = (f, d) => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : d)

const WATCH = has('--watch')
const LIMIT = parseInt(valOf('--limit', String(config.firebase?.batchLimit ?? 5)), 10)
const INCLUDE_ERRORS = has('--include-errors')
const POLL_MS = config.firebase?.pollIntervalMs ?? 15000
const OUT_DIR = path.resolve(root, config.outDir)

const ts = () => new Date().toTimeString().slice(0, 8)
const log = (m) => console.log(`[${ts()}] ${m}`)

// 서비스 계정 키 경로: config가 상대경로면 프로젝트 루트 기준으로 해석.
const saPath = config.firebase?.serviceAccountPath
  ? path.resolve(root, config.firebase.serviceAccountPath)
  : undefined

try {
  await initFirebase({ serviceAccountPath: saPath, projectId: config.firebase?.projectId })
} catch (err) {
  console.error(`\n[설정 오류] ${err.message}\n\n서비스 계정 키 준비는 scripts/FIRESTORE.md 참조.`)
  process.exit(1)
}
log(`Firebase 연결됨. library=${OUT_DIR}, comfyui=${config.host}`)

async function processProfile(profile) {
  const pid = profile.id
  const label = `${profile.name || '?'} (${pid})`

  const claimed = await claimProfile(pid, { includeErrors: INCLUDE_ERRORS })
  if (!claimed) {
    log(`건너뜀 (이미 처리 중/완료): ${label}`)
    return
  }
  log(`▶ 생성 시작: ${label}`)

  try {
    // 1) 레퍼런스 사진을 로컬로 내려받기
    const inputDir = path.join(OUT_DIR, pid, '_input')
    const photoPaths = await downloadPhotos(profile, inputDir)
    log(`  사진 ${photoPaths.length}장 다운로드`)

    // 2) 생애 라이브러리 생성 (10단계 × perStage)
    const genProfile = toGeneratorProfile(profile, photoPaths)
    const t0 = Date.now()
    const result = await generateLifeLibrary(genProfile, {
      host: config.host,
      outDir: OUT_DIR,
      workflow: config.workflow,
      perStage: config.perStage,
      image: config.image,
      timeoutMs: config.timeoutMs,
      onProgress: (e) => {
        if (e.type === 'portrait-done') log(`  age ${e.age} 포트레이트`)
        else if (e.type === 'image-done') log(`  [${e.item.id}] ${e.done}/${e.total}`)
      }
    })
    const sec = ((Date.now() - t0) / 1000).toFixed(1)

    // 3) 완료 기록. 검토(admin)는 별개 — 여기서는 생성 완료까지만 책임진다.
    await setProfileStatus(pid, 'done', {
      libraryDir: `library/${pid}`,
      imageCount: result.manifest.images.length,
      generatedAt: new Date().toISOString()
    })
    log(`✓ 완료: ${label} — ${result.manifest.images.length}장 (${sec}s)`)
  } catch (err) {
    log(`✗ 실패: ${label} — ${err.message}`)
    await setProfileStatus(pid, 'error', { error: String(err.message || err) }).catch(() => {})
  }
}

async function runBatch() {
  const profiles = await fetchPendingProfiles({ limit: LIMIT, includeErrors: INCLUDE_ERRORS })
  if (profiles.length === 0) return 0
  log(`대기 프로필 ${profiles.length}건`)
  for (const p of profiles) await processProfile(p) // 순차 처리 — ComfyUI 큐 과부하 방지
  return profiles.length
}

if (WATCH) {
  log(`감시 모드 시작 (폴링 ${POLL_MS}ms). Ctrl+C로 종료.`)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runBatch()
    } catch (err) {
      log(`배치 오류: ${err.message}`)
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
} else {
  const n = await runBatch()
  if (n === 0) log('대기 중인 프로필이 없습니다.')
  process.exit(0)
}
