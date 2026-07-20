#!/usr/bin/env node
// equirect 4:1의 등 뒤 wrap 이음매를 기존 seamfix(Flux Fill 밴드)로 닫는다.
// 입력: library/_probe/equirect/classroom-gaze-4x1.png → 출력: -sealed.png (+rolled 확인용)
//
//   node scripts/probe-equirect-seamfix.mjs [--band 256] [--in <path>]

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { ComfyUIClient } from '../src/main/comfyui/client.js'
import { buildGeminiSeamFixWorkflow, randomSeed } from '../src/main/comfyui/workflows.js'
import { SEAM_BLEND_PROMPT } from '../src/main/comfyui/prompt-builder.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))

const args = process.argv.slice(2)
let band = 256
let inPath = 'library/_probe/equirect/classroom-gaze-4x1.png'
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--band') band = Number(args[++i])
  else if (args[i] === '--in') inPath = args[++i]
}
const W = 4096
const H = 1024
const outDir = path.join(root, 'library/_probe/equirect')

const src = await sharp(path.join(root, inPath)).resize(W, H, { fit: 'fill' }).png().toBuffer() // 4:1 → 4096×1024
const client = new ComfyUIClient({ host: config.host, timeoutMs: config.timeoutMs })
console.log('ComfyUI 연결…')
await client.ping()
console.log(`equirect wrap seamfix · ${W}x${H} · band ${band}\n`)

const t0 = Date.now()
try {
  const up = await client.uploadImage(src, '_probe-equirect-4x1.png')
  const wf = buildGeminiSeamFixWorkflow({
    referenceImage: up.name,
    prompt: SEAM_BLEND_PROMPT,
    bandPrompt: SEAM_BLEND_PROMPT, // 등 뒤 벽에 내용 있으니 '민무늬 벽'(SEAM_BAND) 대신 '이어 섞기'(SEAM_BLEND)
    width: W,
    height: H,
    bandWidth: band,
    feather: 96,
    seed: randomSeed(),
    filenamePrefix: 'chrono-zoetrope/_probe/equirect'
  })
  process.stdout.write('sealing ')
  const { images } = await client.generate(wf, { onProgress: () => process.stdout.write('.') })
  const sealed = (images.find((im) => /-pano_/.test(im.filename)) || images[0]).data
  await fs.writeFile(path.join(outDir, 'classroom-gaze-4x1-sealed.png'), sealed)

  // 확인용: sealed를 절반 roll → 중앙이 (닫힌) wrap
  const half = W / 2
  const L = await sharp(sealed).extract({ left: 0, top: 0, width: half, height: H }).png().toBuffer()
  const R = await sharp(sealed).extract({ left: half, top: 0, width: half, height: H }).png().toBuffer()
  await sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: R, left: 0, top: 0 }, { input: L, left: half, top: 0 }])
    .png()
    .toFile(path.join(outDir, 'classroom-gaze-4x1-sealed-rolled.png'))
  console.log(`\n  → ${((Date.now() - t0) / 1000).toFixed(1)}s  sealed + sealed-rolled 저장`)
} catch (err) {
  console.log(`\n  실패: ${err.message}`)
}
client.close()
console.log(`\n결과: library/_probe/equirect/ (classroom-gaze-4x1-sealed.png, -sealed-rolled.png=중앙이 닫힌 wrap)`)
