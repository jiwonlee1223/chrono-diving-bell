#!/usr/bin/env node
// ComfyUI 서버 output에 남은 클립을 로컬(library/<pid>/videos) + Firebase로 복구한다.
// admin 클립 잡이 생성은 끝냈으나 /view 다운로드 실패로 로컬/Firebase가 비어(clips.done=0) 있을 때 쓴다.
//
//   node scripts/recover-comfy-videos.mjs <pid>        # 예: p-f4e7624d
//   node scripts/recover-comfy-videos.mjs --all        # library/ 전체(_probe 제외)
//   node scripts/recover-comfy-videos.mjs <pid> --no-upload   # 로컬만 복구(Firebase 생략)

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initFirebase, uploadPersonaVideos } from '../src/main/comfyui/firestore-source.js'
import { recoverClipsFromComfy } from '../src/main/comfyui/recover-clips.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))
const LIBRARY = path.join(root, config.outDir || 'library')

let args = process.argv.slice(2)
const noUpload = args.includes('--no-upload')
args = args.filter((a) => a !== '--no-upload')
if (!args.length) {
  console.error('사용법: node scripts/recover-comfy-videos.mjs <pid> | --all  [--no-upload]')
  process.exit(1)
}

let firebaseReady = false
if (!noUpload) {
  const saPath = config.firebase?.serviceAccountPath
    ? path.resolve(root, config.firebase.serviceAccountPath)
    : undefined
  try {
    await initFirebase({
      serviceAccountPath: saPath,
      projectId: config.firebase?.projectId,
      storageBucket: config.firebase?.storageBucket
    })
    firebaseReady = true
  } catch (e) {
    console.warn(`⚠ Firebase 초기화 실패 — 로컬만 복구한다: ${e.message}`)
  }
}

let pids
if (args[0] === '--all') {
  const entries = await fs.readdir(LIBRARY, { withFileTypes: true })
  pids = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('_')) continue
    if (await fs.access(path.join(LIBRARY, e.name, 'manifest.json')).then(() => true, () => false))
      pids.push(e.name)
  }
} else {
  pids = args
}

const host = config.host
console.log(`ComfyUI: ${host}`)

for (const pid of pids) {
  const dir = path.join(LIBRARY, pid)
  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8'))
  } catch {
    console.log(`[${pid}] manifest 없음 — 건너뜀`)
    continue
  }
  const images = (manifest.images || []).filter((im) => !im.failed)
  const ids = images.map((im) => im.id)
  process.stdout.write(`[${pid}] ${manifest.profile?.name || '?'} · ${ids.length}장 복구 `)

  const { recovered, missing } = await recoverClipsFromComfy({
    host,
    ids,
    videosDir: path.join(dir, 'videos'),
    onProgress: (e) => e.phase === 'recover' && e.id && process.stdout.write('.')
  })
  console.log(`\n  회수 ${recovered.length}/${ids.length}${missing.length ? ` · 누락: ${missing.join(', ')}` : ''}`)

  // manifest.clips 갱신 (완료 배지 = 로컬 파일 수 기준이므로 실제 회수분을 반영)
  manifest.clips = {
    mode: manifest.clips?.mode || config?.regen?.mode || 'wan',
    done: recovered.length,
    total: ids.length,
    builtAt: new Date().toISOString(),
    recoveredAt: new Date().toISOString()
  }
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  if (firebaseReady && recovered.length > 0) {
    try {
      const up = await uploadPersonaVideos({
        profile: manifest.profile,
        personaId: pid,
        dir,
        images: manifest.images,
        kind: 'clips',
        onProgress: () => process.stdout.write('↑')
      })
      console.log(`\n  → Firebase 'generatedVideos'/${up.key} (${up.count}개)`)
    } catch (e) {
      console.error(`\n  ⚠ Firebase 업로드 실패(로컬 보존됨): ${e.message}`)
    }
  }
}

console.log('완료.')
process.exit(0)
