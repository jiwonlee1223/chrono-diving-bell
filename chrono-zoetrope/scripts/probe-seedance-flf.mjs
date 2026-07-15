#!/usr/bin/env node
// Seedance first-last-frame 프로브 — 두 장면(기억) 사이를 이어주는 전이 영상.
// 릴을 "독립 클립+크로스페이드"에서 "기억→기억 morph"로 바꿀 수 있는지 검증.
//
//   COMFY_API_KEY=<키> node scripts/probe-seedance-flf.mjs [first.png] [last.png]
//
// 결과: library/_probe/compare/seedance-flf.mp4

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComfyUIClient } from '../src/main/comfyui/client.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOST = 'http://143.248.107.38:8188'
const KEY = process.env.COMFY_API_KEY
if (!KEY) throw new Error('COMFY_API_KEY 필요')

const firstPath = resolve(root, process.argv[2] || 'library/_probe/scene-safety/age-03.png')
const lastPath = resolve(root, process.argv[3] || 'library/_probe/scene-safety/age-07.png')
const model = process.argv[4] || 'seedance-1-5-pro-251215'

// 주마등 전이 프롬프트 — 한 기억이 다음 기억으로 꿈결처럼 녹아든다. 부감·얼굴 흐림 유지.
const prompt =
  'A dreamlike memory dissolving into the next moment of the same life, seen from a slightly elevated high angle looking gently down. ' +
  'One scene flows and morphs softly into another as a life flashes by. The central person is the subject; every other face stays soft, indistinct, wiped away like a brushstroke. ' +
  'Gentle drifting motion, cinematic, soft warm film grain, no text.'

const client = new ComfyUIClient({ host: HOST, timeoutMs: 300000 })
console.log(`FLF: ${basename(firstPath)} → ${basename(lastPath)} | ${model}`)

const up1 = await client.uploadImage(await readFile(firstPath), `flf-first-${basename(firstPath)}`)
const up2 = await client.uploadImage(await readFile(lastPath), `flf-last-${basename(lastPath)}`)

const workflow = {
  1: { class_type: 'LoadImage', inputs: { image: up1.name } },
  2: { class_type: 'LoadImage', inputs: { image: up2.name } },
  3: {
    class_type: 'ByteDanceFirstLastFrameNode',
    inputs: {
      model,
      prompt,
      first_frame: ['1', 0],
      last_frame: ['2', 0],
      resolution: '480p',
      aspect_ratio: '16:9',
      duration: 5,
      seed: Math.floor(Math.random() * 2147483647),
      camera_fixed: false,
      watermark: false
    }
  },
  4: {
    class_type: 'SaveVideo',
    inputs: { video: ['3', 0], filename_prefix: 'chrono-compare/seedance-flf', format: 'mp4', codec: 'h264' }
  }
}

const t0 = Date.now()
const res = await fetch(`${HOST}/prompt`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: workflow, client_id: 'seedance-flf', extra_data: { api_key_comfy_org: KEY } })
})
const body = await res.json().catch(() => ({}))
if (!res.ok || !body.prompt_id) {
  console.error('큐잉 실패:', res.status, JSON.stringify(body).slice(0, 900))
  process.exit(1)
}
console.log(`큐잉됨: ${body.prompt_id}`)

let outputs = null
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 3000))
  const h = await fetch(`${HOST}/history/${body.prompt_id}`).then((r) => r.json()).catch(() => ({}))
  const e = h[body.prompt_id]
  if (!e) continue
  if ((e.status?.messages || []).some((m) => m[0] === 'execution_error')) {
    console.error('실행 에러:', JSON.stringify(e.status).slice(0, 1000))
    process.exit(1)
  }
  if (e.outputs && Object.keys(e.outputs).length) { outputs = e.outputs; break }
  if (i % 5 === 0) process.stdout.write(`  …${((Date.now() - t0) / 1000).toFixed(0)}s\r`)
}
if (!outputs) throw new Error('타임아웃')

let vid = null
for (const node of Object.values(outputs))
  for (const arr of Object.values(node))
    if (Array.isArray(arr)) for (const f of arr) if (f?.filename && /\.(mp4|webm|mov)$/i.test(f.filename)) vid = f
if (!vid) throw new Error(`영상 없음: ${JSON.stringify(outputs).slice(0, 500)}`)

const q = new URLSearchParams({ filename: vid.filename, subfolder: vid.subfolder || '', type: vid.type || 'output' })
const data = Buffer.from(await (await fetch(`${HOST}/view?${q}`)).arrayBuffer())
const outDir = join(root, 'library/_probe/compare')
await mkdir(outDir, { recursive: true })
const outPath = join(outDir, 'seedance-flf.mp4')
await writeFile(outPath, data)
console.log(`\n✓ FLF 완료: ${outPath} (${(data.length / 1e6).toFixed(1)}MB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`)
client.close()
