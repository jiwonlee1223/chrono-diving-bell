#!/usr/bin/env node
// Seedance FLF 미니 릴 프로브 — 3~4장면을 "기억→기억" 전이로 이어 하나의 흐르는 릴로.
//  ① 각 전이마다 두 장면(나이·상황)에 맞는 컨텍스트 프롬프트를 자동 생성한다.
//  ② 화질 1080p (480p 대비 대폭 향상).
//  ③ 전이 클립들을 크로스페이드 없이 이어붙임(FLF 경계가 원본 장면과 일치 → 매끄러움).
//
//   COMFY_API_KEY=<키> node scripts/probe-seedance-minireel.mjs
//
// 결과: library/_probe/compare/minireel.mp4

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { ComfyUIClient } from '../src/main/comfyui/client.js'
import { buildScenePlan } from '../src/main/comfyui/prompt-builder.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOST = 'http://143.248.107.38:8188'
const KEY = process.env.COMFY_API_KEY
if (!KEY) throw new Error('COMFY_API_KEY 필요')
const MODEL = 'seedance-1-5-pro-251215'
const RESOLUTION = '1080p' // 화질 향상 (480p→1080p)

// 실제 장면 메타데이터로 컨텍스트를 만든다. 프로브 이미지(age-03/07/14/32)와 나이를 맞춘다.
const profile = { name: '홍길동', birthDate: '1980-03-15', occupation: 'teacher', gender: 'male' }
const plan = buildScenePlan(profile, { perStage: 3 })
const AGES = [3, 7, 14, 32]
const scenes = AGES.map((age) => {
  const item = plan.find((p) => p.age === age)
  return { age, scene: item.scene, img: `library/_probe/scene-safety/age-${String(age).padStart(2, '0')}.png` }
})

// ── 컨텍스트 자동 생성 — 두 장면(상황·나이)에 맞춘 전이 프롬프트 ──────────────
// 죽기 직전 주마등: 한 기억이 붙잡혔다가 다음 기억으로 꿈결처럼 녹아든다. 부감·얼굴 지움 유지.
function flfPrompt(a, b) {
  return (
    `A single life flashing by, one memory dissolving into the next. ` +
    `The scene begins in this moment — ${a.scene} — around age ${a.age}, held softly for a breath, ` +
    `then dreamlike melts and transforms into the next memory — ${b.scene} — around age ${b.age}. ` +
    `Seen from a slightly elevated high angle looking gently down, quietly observing this life from just above. ` +
    `The central person is the subject and stays visible; every other person's face remains soft, blurred and indistinct, ` +
    `wiped away like a brushstroke, never sharp. Warm faded film grain, gentle drifting motion, cinematic, no text, no captions.`
  )
}

const client = new ComfyUIClient({ host: HOST, timeoutMs: 300000 })
const outDir = join(root, 'library/_probe/compare')
await mkdir(outDir, { recursive: true })

// 이미지 한 번씩만 업로드 (연속 전이가 공유)
const uploads = {}
for (const s of scenes) uploads[s.age] = (await client.uploadImage(await readFile(resolve(root, s.img)), `mini-${s.age}.png`)).name

async function genTransition(a, b, idx) {
  const workflow = {
    1: { class_type: 'LoadImage', inputs: { image: uploads[a.age] } },
    2: { class_type: 'LoadImage', inputs: { image: uploads[b.age] } },
    3: {
      class_type: 'ByteDanceFirstLastFrameNode',
      inputs: {
        model: MODEL,
        prompt: flfPrompt(a, b),
        first_frame: ['1', 0],
        last_frame: ['2', 0],
        resolution: RESOLUTION,
        aspect_ratio: '16:9',
        duration: 5,
        seed: Math.floor(Math.random() * 2147483647),
        camera_fixed: false,
        watermark: false
      }
    },
    4: {
      class_type: 'SaveVideo',
      inputs: { video: ['3', 0], filename_prefix: `chrono-compare/mini-${idx}`, format: 'mp4', codec: 'h264' }
    }
  }
  const t0 = Date.now()
  const res = await fetch(`${HOST}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: 'mini-reel', extra_data: { api_key_comfy_org: KEY } })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.prompt_id) throw new Error(`큐잉 실패 ${res.status}: ${JSON.stringify(body).slice(0, 500)}`)
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    const h = await fetch(`${HOST}/history/${body.prompt_id}`).then((r) => r.json()).catch(() => ({}))
    const e = h[body.prompt_id]
    if (!e) continue
    if ((e.status?.messages || []).some((m) => m[0] === 'execution_error'))
      throw new Error(`실행 에러: ${JSON.stringify(e.status).slice(0, 600)}`)
    if (e.outputs && Object.keys(e.outputs).length) {
      let vid = null
      for (const node of Object.values(e.outputs))
        for (const arr of Object.values(node))
          if (Array.isArray(arr)) for (const f of arr) if (f?.filename && /\.mp4$/i.test(f.filename)) vid = f
      if (!vid) throw new Error('영상 출력 없음')
      const q = new URLSearchParams({ filename: vid.filename, subfolder: vid.subfolder || '', type: vid.type || 'output' })
      const data = Buffer.from(await (await fetch(`${HOST}/view?${q}`)).arrayBuffer())
      const p = join(outDir, `mini-${idx}.mp4`)
      await writeFile(p, data)
      console.log(`  ✓ 전이 ${idx}: ${a.age}살→${b.age}살 (${(data.length / 1e6).toFixed(1)}MB, ${((Date.now() - t0) / 1000).toFixed(0)}s)`)
      return p
    }
  }
  throw new Error('타임아웃')
}

console.log(`미니 릴: ${scenes.map((s) => s.age + '살').join(' → ')} | ${MODEL} @ ${RESOLUTION}`)
const clips = []
for (let i = 0; i < scenes.length - 1; i++) {
  console.log(`전이 ${i}: ${scenes[i].age}살 → ${scenes[i + 1].age}살 생성 중…`)
  clips.push(await genTransition(scenes[i], scenes[i + 1], i))
}
client.close()

// 크로스페이드 없이 이어붙임 (FLF 경계가 일치)
const listFile = join(outDir, 'mini-list.txt')
await writeFile(listFile, clips.map((c) => `file '${c}'`).join('\n'))
const outPath = join(outDir, 'minireel.mp4')
await new Promise((res, rej) => {
  const p = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath])
  p.on('close', (c) => (c === 0 ? res() : rej(new Error('concat 실패'))))
})
console.log(`\n✓ 미니 릴: ${outPath} (${clips.length}개 전이 이어붙임)`)
