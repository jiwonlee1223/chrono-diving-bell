#!/usr/bin/env node
// BrushNet gap-fill 프로브 — "서로 다른 두 시점 사이(gap) 메우기"의 BrushNet 버전.
// 캐시된 wide-anchor front/back(교실, 조인 불연속)을 붙이고, 조인 주변만 crop→BrushNet 밴드 채움→되붙임.
// SDXL은 4096폭에서 반복 아티팩트라 crop(기본 1536)에서만 돌린다. 결과는 library/_probe/brushnet/.
//
//   node scripts/probe-brushnet.mjs                 # 32-front/32-back 사용, band 768
//   node scripts/probe-brushnet.mjs --crop 2048 --band 1024
//   node scripts/probe-brushnet.mjs --ckpt epicrealism-xl.safetensors

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { ComfyUIClient } from '../src/main/comfyui/client.js'
import { buildBrushNetGapFillWorkflow, randomSeed } from '../src/main/comfyui/workflows.js'
import { SEAM_BLEND_PROMPT } from '../src/main/comfyui/prompt-builder.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))

const args = process.argv.slice(2)
let cropW = 1536
let band = 768
let ckpt = 'sd_xl_base_1.0.safetensors'
let steps = 25
let cfg = 7
let label = '32'
let mode = 'brushnet_random' // --mode: brushnet_random | fooocus_inpaint | powerpaint | normal
let tag = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--crop') cropW = Number(args[++i])
  else if (args[i] === '--band') band = Number(args[++i])
  else if (args[i] === '--ckpt') ckpt = args[++i]
  else if (args[i] === '--steps') steps = Number(args[++i])
  else if (args[i] === '--cfg') cfg = Number(args[++i])
  else if (args[i] === '--label') label = args[++i]
  else if (args[i] === '--mode') mode = args[++i]
  else if (args[i] === '--tag') tag = args[++i]
}
const outTag = tag || mode.replace('_', '') // 출력 접두사(모드별 결과 보존)

const srcDir = path.join(root, 'library/_probe/flux2-surround')
const outDir = path.join(root, 'library/_probe/brushnet')
await fs.mkdir(outDir, { recursive: true })

const front = await fs.readFile(path.join(srcDir, `${label}-front.png`))
const back = await fs.readFile(path.join(srcDir, `${label}-back.png`))
const fMeta = await sharp(front).metadata()
const halfW = fMeta.width // 2048
const H = fMeta.height // 1024
const W = halfW * 2 // 4096
const joinX = halfW // 조인 = 가운데 x=2048

// 1) [front|back] 조립
const assembled = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } })
  .composite([
    { input: front, left: 0, top: 0 },
    { input: back, left: halfW, top: 0 }
  ])
  .png()
  .toBuffer()

// 2) 조인 주변 crop [joinX-cropW/2, joinX+cropW/2]
const cropLeft = joinX - Math.floor(cropW / 2)
const crop = await sharp(assembled).extract({ left: cropLeft, top: 0, width: cropW, height: H }).png().toBuffer()

const client = new ComfyUIClient({ host: config.host, timeoutMs: config.timeoutMs })
console.log('ComfyUI 연결…')
await client.ping()
console.log(`Easy inpaint gap-fill · mode=${mode} · ${ckpt} · crop ${cropW}×${H} · band ${band} · steps ${steps} cfg ${cfg}\n`)

const t0 = Date.now()
try {
  const up = await client.uploadImage(crop, `_probe-brushnet-${label}-crop.png`)
  const wf = buildBrushNetGapFillWorkflow({
    referenceImage: up.name,
    prompt: SEAM_BLEND_PROMPT,
    width: cropW,
    height: H,
    bandWidth: band,
    ckpt,
    inpaintMode: mode,
    steps,
    cfg,
    seed: randomSeed(),
    filenamePrefix: `chrono-zoetrope/_probe/inpaint-${label}-${outTag}`
  })
  process.stdout.write('generating ')
  const { images } = await client.generate(wf, { onProgress: () => process.stdout.write('.') })
  const filled = (images.find((im) => /-brush/.test(im.filename)) || images[0]).data // kSampler save_prefix에 -brush 포함

  // 3) 채운 crop을 원본에 되붙임(mask 밖은 원본과 동일하므로 whole-crop paste OK)
  const filledResized = await sharp(filled).resize(cropW, H, { fit: 'fill' }).png().toBuffer()
  const pano = await sharp(assembled).composite([{ input: filledResized, left: cropLeft, top: 0 }]).png().toBuffer()

  // 조인 전/후 비교 crop(±320)
  const joinBefore = await sharp(assembled).extract({ left: joinX - 320, top: 0, width: 640, height: H }).png().toBuffer()
  const joinAfter = await sharp(pano).extract({ left: joinX - 320, top: 0, width: 640, height: H }).png().toBuffer()

  const pre = `${label}-${outTag}`
  await Promise.all([
    fs.writeFile(path.join(outDir, `${pre}-pano.png`), pano),
    fs.writeFile(path.join(outDir, `${pre}-crop-after.png`), filledResized),
    fs.writeFile(path.join(outDir, `${label}-join-before.png`), joinBefore),
    fs.writeFile(path.join(outDir, `${pre}-join-after.png`), joinAfter)
  ])
  console.log(`\n  → ${((Date.now() - t0) / 1000).toFixed(1)}s  ${outDir}/${pre}-pano.png`)
} catch (err) {
  console.log(`\n  실패: ${err.message}`)
}
client.close()
console.log(`\n결과: ${path.relative(root, outDir)}/  (${label}-join-before/after.png = 조인 비교, ${label}-pano.png = 전체)`)
