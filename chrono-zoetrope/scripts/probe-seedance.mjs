#!/usr/bin/env node
// Seedance(ByteDance API 노드) I2V 비교 프로브 — Wan2.2와 같은 이미지·프롬프트로 클립 생성.
//
//   COMFY_API_KEY=<comfy.org 키> node scripts/probe-seedance.mjs [이미지] [모델]
//
// API 노드는 ComfyUI가 comfy.org로 브로커링 → /prompt의 extra_data.api_key_comfy_org로 인증(과금).
// 결과: library/_probe/compare/seedance.mp4

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComfyUIClient } from '../src/main/comfyui/client.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOST = 'http://143.248.107.38:8188'
const KEY = process.env.COMFY_API_KEY
if (!KEY) throw new Error('COMFY_API_KEY 환경변수 필요')

const imgPath = resolve(root, process.argv[2] || 'library/_probe/scene-safety/age-07.png')
const model = process.argv[3] || 'seedance-1-5-pro-251215'
const montage = JSON.parse(await readFile(join(root, 'src/main/config/montage.json'), 'utf-8'))
const prompt = `${montage.regen.promptPrefix} Scene: first day at an elementary school gate, oversized backpack, 1980s Korea.`

const client = new ComfyUIClient({ host: HOST, timeoutMs: 300000 })
console.log(`모델: ${model} | 이미지: ${basename(imgPath)}`)

// 1) 이미지 업로드 (표준 /upload/image 재사용)
const uploaded = await client.uploadImage(await readFile(imgPath), `compare-${basename(imgPath)}`)
console.log(`업로드: ${uploaded.name}`)

// 2) Seedance I2V 워크플로우 (480p·5s로 Wan과 조건 맞춤)
const seed = Math.floor(Math.random() * 2147483647)
const workflow = {
  1: { class_type: 'LoadImage', inputs: { image: uploaded.name } },
  2: {
    class_type: 'ByteDanceImageToVideoNode',
    inputs: {
      model,
      prompt,
      image: ['1', 0],
      resolution: '480p',
      aspect_ratio: '16:9',
      duration: 5,
      seed,
      camera_fixed: false,
      watermark: false,
      generate_audio: false
    }
  },
  3: {
    class_type: 'SaveVideo',
    inputs: { video: ['2', 0], filename_prefix: 'chrono-compare/seedance', format: 'mp4', codec: 'h264' }
  }
}

// 3) /prompt 에 API 키 실어 큐잉
const t0 = Date.now()
const res = await fetch(`${HOST}/prompt`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: workflow, client_id: 'seedance-probe', extra_data: { api_key_comfy_org: KEY } })
})
const body = await res.json().catch(() => ({}))
if (!res.ok || !body.prompt_id) {
  console.error('큐잉 실패:', res.status, JSON.stringify(body).slice(0, 800))
  process.exit(1)
}
const promptId = body.prompt_id
console.log(`큐잉됨: ${promptId} — 생성 대기 (API 노드라 수십초~수분)`)

// 4) /history 폴링
let outputs = null
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 3000))
  const h = await fetch(`${HOST}/history/${promptId}`).then((r) => r.json()).catch(() => ({}))
  const entry = h[promptId]
  if (!entry) continue
  const st = entry.status || {}
  if (st.status_str === 'error' || (st.messages || []).some((m) => m[0] === 'execution_error')) {
    console.error('실행 에러:', JSON.stringify(entry.status).slice(0, 1000))
    process.exit(1)
  }
  if (entry.outputs && Object.keys(entry.outputs).length) {
    outputs = entry.outputs
    break
  }
  if (i % 5 === 0) process.stdout.write(`  …${((Date.now() - t0) / 1000).toFixed(0)}s\r`)
}
if (!outputs) throw new Error('타임아웃 (6분)')

// 5) 영상 출력 찾기 → 다운로드
let vid = null
for (const node of Object.values(outputs)) {
  for (const arr of Object.values(node)) {
    if (Array.isArray(arr))
      for (const f of arr) if (f?.filename && /\.(mp4|webm|mov)$/i.test(f.filename)) vid = f
  }
}
if (!vid) throw new Error(`영상 출력 없음: ${JSON.stringify(outputs).slice(0, 600)}`)

const q = new URLSearchParams({ filename: vid.filename, subfolder: vid.subfolder || '', type: vid.type || 'output' })
const data = Buffer.from(await (await fetch(`${HOST}/view?${q}`)).arrayBuffer())
const outDir = join(root, 'library/_probe/compare')
await mkdir(outDir, { recursive: true })
const outPath = join(outDir, `seedance.mp4`)
await writeFile(outPath, data)
console.log(`\n✓ Seedance 완료: ${outPath} (${(data.length / 1e6).toFixed(1)}MB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`)
client.close()
