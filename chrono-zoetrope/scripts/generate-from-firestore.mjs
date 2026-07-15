#!/usr/bin/env node
// Firestore 프로필 → 생애 라이브러리 생성 워커.
// 수집 앱이 제출한 프로필(status:'submitted')을 읽어 생성을 트리거한다.
//
//   node scripts/generate-from-firestore.mjs --once            # 대기분 한 배치 처리 후 종료
//   node scripts/generate-from-firestore.mjs --watch           # 폴링 루프 (15초 간격)
//   node scripts/generate-from-firestore.mjs --listen          # 실시간 리스너 (전시 중 상시 구동, 권장)
//   node scripts/generate-from-firestore.mjs --once --limit 1  # 1건만
//   node scripts/generate-from-firestore.mjs --once --include-errors  # 실패분 재시도 포함
//
// --listen은 폴링 대신 Firestore 리스너로 제출을 즉시 감지한다(수백 ms 내 생성 시작).
// 생성 머신이 전시 내내 켜져 인터넷에 연결돼 있다는 전제 — 아웃바운드 연결만 쓰므로
// 방화벽·포트포워딩 설정이 필요 없다. 전시 중에는 이 모드를 계속 띄워둔다.
//
// 서비스 계정 키가 필요하다 — README(FIRESTORE.md) 참조.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { processProfile as runProfile } from '../src/main/comfyui/profile-worker.js'
import { resolveGeminiConfig } from '../src/main/comfyui/gemini-client.js'
import {
  initFirebase,
  fetchPendingProfiles,
  listenForSubmissions,
  resetOrphanGenerating
} from '../src/main/comfyui/firestore-source.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(
  await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8')
)
config.gemini = resolveGeminiConfig(config.gemini, root) // apiKeyPath를 절대경로로

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valOf = (f, d) => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : d)

const LISTEN = has('--listen')
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
log(
  `Firebase 연결됨. library=${OUT_DIR}, workflow=${config.workflow}` +
    (['gemini', 'seamfix'].includes(config.workflow) ? ` gemini=${config.gemini?.model}` : '') +
    (config.workflow === 'gemini' ? '' : ` comfyui=${config.host}`)
)

// 이전 실행이 생성 도중 죽어 generating에 갇힌 프로필 복구 (resume이 이어서 생성).
const orphans = await resetOrphanGenerating()
if (orphans.length > 0) log(`중단됐던 생성 ${orphans.length}건을 큐로 복구: ${orphans.join(', ')}`)

// 생성 로직 본체는 공유 모듈(profile-worker.js)에 있다 — admin-server의 자동 큐와 동일 코드.
// 여기서는 CLI 설정(OUT_DIR·config·includeErrors)과 진행 로그만 주입하는 얇은 래퍼.
const processProfile = (profile) =>
  runProfile(profile, {
    config,
    outDir: OUT_DIR,
    includeErrors: INCLUDE_ERRORS,
    log,
    onProgress: (e) => {
      if (e.type === 'gender-done')
        log(`  성별 자동감지: ${e.gender || '판별 불가'}${e.error ? ` (오류: ${e.error})` : ''}`)
      else if (e.type === 'image-done') log(`  [${e.item.id}] ${e.done}/${e.total}`)
    }
  })

async function runBatch() {
  const profiles = await fetchPendingProfiles({ limit: LIMIT, includeErrors: INCLUDE_ERRORS })
  if (profiles.length === 0) return 0
  log(`대기 프로필 ${profiles.length}건`)
  for (const p of profiles) await processProfile(p) // 순차 처리 — ComfyUI 큐 과부하 방지
  return profiles.length
}

if (LISTEN) {
  log(`실시간 리스너 시작. 제출을 즉시 감지한다. Ctrl+C로 종료.`)
  // ComfyUI 과부하 방지를 위해 감지된 순서대로 한 건씩 순차 처리하는 큐.
  const queue = []
  let draining = false
  async function drain() {
    if (draining) return
    draining = true
    while (queue.length > 0) await processProfile(queue.shift())
    draining = false
  }
  listenForSubmissions(
    (profile) => {
      log(`감지: ${profile.name || '?'} (${profile.id})`)
      queue.push(profile)
      drain()
    },
    { includeErrors: INCLUDE_ERRORS }
  )
} else if (WATCH) {
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
