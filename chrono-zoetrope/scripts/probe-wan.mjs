#!/usr/bin/env node
// Wan2.2 I2V 서버 프로브 — REGEN_WAIT 연출 길이를 결정할 실측 도구.
//
// 라이브러리 이미지 한 장을 서버에 업로드하고 Wan2.2 I2V(4-step LoRA) 생성을 돌려
// 단계별 소요 시간(큐 대기 → 샘플링 → 총 시간)을 측정하고 mp4를 로컬에 저장한다.
//
// 사용:
//   node scripts/probe-wan.mjs                          # 기본: 832×480, 81프레임
//   node scripts/probe-wan.mjs --width 1280 --height 720
//   node scripts/probe-wan.mjs --image library/p-f1575a67/5-1.png --length 49
//
// 해상도·프레임 조합별로 몇 번 돌려 60~90초 예산에 맞는 최고 화질을 고른다.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComfyUIClient } from '../src/main/comfyui/client.js'
import { buildWan22I2VWorkflow } from '../src/main/comfyui/workflows.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await readFile(join(root, 'src/main/config/comfyui.json'), 'utf8'))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const imagePath = resolve(root, arg('image', 'library/p-f1575a67/5-1.png'))
const width = Number(arg('width', 832))
const height = Number(arg('height', 480))
const length = Number(arg('length', 81)) // 16fps → 81f = 약 5초
const steps = Number(arg('steps', 4))
const shift = Number(arg('shift', 5.0))
const prompt = arg(
  'prompt',
  'The scene comes alive with subtle natural motion. The person breathes and moves gently, ' +
    'hair and clothing stir in a light breeze, ambient life continues around them. ' +
    'The camera holds nearly still with a very slow drift. Cinematic, realistic motion.'
)

const outDir = join(root, 'library', '_probe')
await mkdir(outDir, { recursive: true })

const client = new ComfyUIClient({ host: config.host, timeoutMs: 900000 })

console.log(`[probe] 서버: ${config.host}`)
await client.ping()
console.log(`[probe] 이미지: ${imagePath}`)
console.log(
  `[probe] 설정: ${width}x${height}, ${length}프레임(${(length / 16).toFixed(1)}s @16fps), ${steps}스텝, shift ${shift}`
)

const buf = await readFile(imagePath)
const uploaded = await client.uploadImage(buf, `probe-${basename(imagePath)}`)
console.log(`[probe] 업로드 완료: ${uploaded.name}`)

const workflow = buildWan22I2VWorkflow({
  prompt,
  startImage: uploaded.name,
  width,
  height,
  length,
  steps,
  boundaryStep: Math.floor(steps / 2),
  shift,
  filenamePrefix: `chrono-zoetrope/probe/${width}x${height}-${length}f`
})

const t0 = Date.now()
let tFirstProgress = null
let lastLog = 0

const { promptId, videos } = await client.generateVideo(workflow, {
  onProgress: (p) => {
    const now = Date.now()
    if (tFirstProgress === null && p.phase === 'sampling') {
      tFirstProgress = now
      console.log(
        `[probe] 샘플링 시작 (+${((now - t0) / 1000).toFixed(1)}s — 모델 로드/인코딩 구간)`
      )
    }
    if (p.phase === 'sampling' && now - lastLog > 3000) {
      lastLog = now
      console.log(`[probe]   step ${p.value}/${p.max} (+${((now - t0) / 1000).toFixed(1)}s)`)
    }
  }
})

const total = (Date.now() - t0) / 1000
for (const v of videos) {
  const outPath = join(outDir, `${width}x${height}-${length}f-${Date.now()}.mp4`)
  await writeFile(outPath, v.data)
  console.log(`[probe] 저장: ${outPath} (${(v.data.length / 1e6).toFixed(1)}MB)`)
}

console.log('')
console.log(`[probe] ===== 결과 =====`)
console.log(`[probe] promptId: ${promptId}`)
console.log(`[probe] 총 소요: ${total.toFixed(1)}s`)
if (tFirstProgress) {
  console.log(`[probe]   샘플링 이전(큐+로드): ${((tFirstProgress - t0) / 1000).toFixed(1)}s`)
  console.log(`[probe]   샘플링+디코드+저장: ${(total - (tFirstProgress - t0) / 1000).toFixed(1)}s`)
}
console.log(`[probe] REGEN_WAIT 예산 판단: 총 소요 + 다운로드 여유 ≈ ${Math.ceil(total + 5)}s`)

client.close()
