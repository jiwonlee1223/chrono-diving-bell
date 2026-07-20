#!/usr/bin/env node
// 이미 생성된 라이브러리(library/<pid>)의 파노라마를 Firebase Storage에 올리고
// 링크를 'generatedPanoramaImages' 컬렉션에 프로필(이름_생년월일6자)별로 기록한다.
// 백필 + 업로드 기능 테스트용. (신규 생성은 profile-worker가 완료 시 자동 업로드.)
//
//   node scripts/upload-panoramas.mjs <pid|이름_생년월일6자>      # 예: p-f4e7624d
//   node scripts/upload-panoramas.mjs --all                       # library/ 전체(_probe 제외)

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initFirebase, uploadPersonaPanoramas, uploadPersonaVideos } from '../src/main/comfyui/firestore-source.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))
const LIBRARY = path.join(root, config.outDir || 'library')

let args = process.argv.slice(2)
const withVideos = args.includes('--videos') // 파노라마 + 영상(videos/*.mp4, reel.mp4) 함께 업로드
args = args.filter((a) => a !== '--videos')
if (!args.length) {
  console.error('사용법: node scripts/upload-panoramas.mjs <pid> | --all  [--videos]')
  process.exit(1)
}

const saPath = config.firebase?.serviceAccountPath ? path.resolve(root, config.firebase.serviceAccountPath) : undefined
await initFirebase({ serviceAccountPath: saPath, projectId: config.firebase?.projectId, storageBucket: config.firebase?.storageBucket })

let pids
if (args[0] === '--all') {
  const entries = await fs.readdir(LIBRARY, { withFileTypes: true })
  pids = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('_')) continue
    if (await fs.access(path.join(LIBRARY, e.name, 'manifest.json')).then(() => true, () => false)) pids.push(e.name)
  }
} else {
  pids = args
}

for (const pid of pids) {
  const dir = path.join(LIBRARY, pid)
  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8'))
  } catch {
    console.log(`[${pid}] manifest 없음 — 건너뜀`)
    continue
  }
  const ok = (manifest.images || []).filter((im) => !im.failed && im.file)
  process.stdout.write(`[${pid}] ${manifest.profile?.name || '?'} · ${ok.length}장 업로드 `)
  const t0 = Date.now()
  try {
    const res = await uploadPersonaPanoramas({
      profile: manifest.profile,
      personaId: pid,
      dir,
      images: manifest.images,
      onProgress: () => process.stdout.write('.')
    })
    console.log(`\n  → ${((Date.now() - t0) / 1000).toFixed(1)}s · 'generatedPanoramaImages'/${res.key} (${res.count}장)`)
    console.log(`     첫 링크: ${res.images[0]?.url || '(없음)'}`)
  } catch (err) {
    console.log(`\n  실패: ${err.message}`)
  }
  if (withVideos) {
    process.stdout.write(`  영상 업로드 `)
    try {
      const v = await uploadPersonaVideos({ profile: manifest.profile, personaId: pid, dir, images: manifest.images, kind: 'clips', onProgress: () => process.stdout.write('.') })
      let reel = ''
      if (await fs.access(path.join(dir, 'reel.mp4')).then(() => true, () => false)) {
        const r = await uploadPersonaVideos({ profile: manifest.profile, personaId: pid, dir, images: manifest.images, kind: 'reel' })
        reel = ` + reel(${r.reel ? 'OK' : '-'})`
      }
      console.log(`\n  → 'generatedVideos'/${v.key} (${v.count}개${reel})`)
    } catch (err) {
      console.log(`\n  영상 실패: ${err.message}`)
    }
  }
}
console.log('\n완료.')
