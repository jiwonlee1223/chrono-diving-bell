#!/usr/bin/env node
// Firebase 'generatedVideos'에 저장된 클립을 내려받아(로컬 캐시) fast-forward reel로 합성하고,
// 완성된 reel.mp4를 다시 Firebase에 업로드한다. 로컬 클립 캐시가 비어 있어도 Firebase만으로 동작한다.
//
//   node scripts/build-reel-from-firebase.mjs <pid>        # 예: p-f4e7624d
//   node scripts/build-reel-from-firebase.mjs <pid> --no-upload   # reel 로컬 생성만(업로드 생략)

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  initFirebase,
  ensureLocalClipsFromFirebase,
  uploadPersonaVideos
} from '../src/main/comfyui/firestore-source.js'
import { ReelBuilder } from '../src/main/comfyui/reel-builder.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))
const montage = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/montage.json'), 'utf-8'))
const LIBRARY = path.join(root, config.outDir || 'library')

let args = process.argv.slice(2)
const noUpload = args.includes('--no-upload')
args = args.filter((a) => a !== '--no-upload')
const pid = args[0]
if (!pid) {
  console.error('사용법: node scripts/build-reel-from-firebase.mjs <pid> [--no-upload]')
  process.exit(1)
}

const saPath = config.firebase?.serviceAccountPath
  ? path.resolve(root, config.firebase.serviceAccountPath)
  : undefined
await initFirebase({
  serviceAccountPath: saPath,
  projectId: config.firebase?.projectId,
  storageBucket: config.firebase?.storageBucket
})

const dir = path.join(LIBRARY, pid)
const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8'))
const profile = manifest.profile
let images = (manifest.images || []).filter((im) => !im.failed)
// 릴 범위 = 탄생~현재 나이만(montage.reel.birthToCurrentOnly, 기본 true). 미래 장면은 인터랙션용으로 제외.
if (montage.reel?.birthToCurrentOnly !== false) {
  const birthYear = parseInt(String(profile?.birthDate || '').slice(0, 4), 10)
  const currentYear = new Date().getFullYear()
  if (Number.isFinite(birthYear)) {
    const before = images.length
    images = images.filter((im) => birthYear + (im.age ?? 0) <= currentYear)
    console.log(`[${pid}] 릴 범위: 탄생~현재(${currentYear - birthYear}세) → ${images.length}/${before}장 (미래 제외)`)
  }
}
// 나잇대별 1장만(montage.reel.onePerStage, 기본 true) — 단계별 첫 장면.
if (montage.reel?.onePerStage !== false) {
  const seenAge = new Set()
  const before = images.length
  images = images.filter((im) => {
    if (seenAge.has(im.age)) return false
    seenAge.add(im.age)
    return true
  })
  console.log(`[${pid}] 나잇대별 1장: ${images.length}/${before}장`)
}
const ids = images.map((im) => im.id) // 출생→죽음 순서 유지

console.log(`[${pid}] ${profile?.name || '?'} · Firebase 클립 ${ids.length}장 확보 중…`)
const { paths, missing } = await ensureLocalClipsFromFirebase(profile, dir, {
  ids,
  onProgress: (e) => e.id && process.stdout.write('.')
})
if (missing.length) console.log(`\n  ⚠ Firebase 문서에 없는 id: ${missing.join(', ')}`)
const clipPaths = ids.map((id) => paths.get(id)).filter(Boolean)
console.log(`\n  확보 ${clipPaths.length}/${ids.length}`)
if (clipPaths.length === 0) {
  console.error('합성할 클립이 없다.')
  process.exit(1)
}

const builder = new ReelBuilder({ reel: montage.reel, log: (m) => console.log('  ' + m) })
const outPath = path.join(dir, 'reel.mp4')
console.log(`[${pid}] reel 합성(fast-forward) → reel.mp4`)
const meta = await builder.concat(clipPaths, outPath, {
  onProgress: (e) => e.phase === 'done' && console.log(`  ffmpeg: ${e.durationSec.toFixed(1)}s · ${e.clipCount}개`)
})

manifest.reel = {
  file: 'reel.mp4',
  mode: manifest.clips?.mode || 'wan',
  durationSec: meta.durationSec,
  clipCount: meta.clipCount,
  builtAt: new Date().toISOString(),
  source: 'firebase',
  rev: (manifest.reel?.rev || 0) + 1
}
await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`  ✓ reel.mp4 ${meta.durationSec.toFixed(1)}s (${meta.clipCount}개)`)

if (!noUpload) {
  try {
    const up = await uploadPersonaVideos({
      profile,
      personaId: pid,
      dir,
      images: manifest.images,
      kind: 'reel',
      reelMeta: meta
    })
    console.log(`  → Firebase 'generatedVideos'/${up.key} reel ${up.reel ? 'OK' : '-'}`)
  } catch (e) {
    console.error(`  ⚠ Firebase reel 업로드 실패(로컬 보존됨): ${e.message}`)
  }
}
console.log('완료.')
process.exit(0)
