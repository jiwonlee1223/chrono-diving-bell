#!/usr/bin/env node
// 서라운드 프로브 — 4타일 캔버스 아웃페인팅으로 1인칭 360° 파노라마를 짓고, 접합선 연속성을 눈으로 검증한다.
// 라이브러리는 건드리지 않고 결과를 library/_probe/surround/ 에만 저장한다. ComfyUI 불필요(순수 Gemini).
//
//   node scripts/probe-surround.mjs                 # 기본 나이 7 32 82
//   node scripts/probe-surround.mjs 32              # 특정 나이만
//   node scripts/probe-surround.mjs 32 --size 4K    # 타일 imageSize 상향(키스톤 손실↓)
//
// 나이마다 저장물:
//   {age}-pano.png                  조립된 파노라마(4:1, [타일4|타일1|타일2|타일3])
//   {age}-t1..t4.png                개별 타일(front / right / back / left)
//   {age}-seam-41.png 등            각 접합선 [왼타일 오른모서리 | 오른타일 왼모서리]를 확대해 붙인 검증 이미지
//                                   (41=타일4↔타일1, 12=타일1↔타일2, 23=타일2↔타일3, 34=타일3↔타일4 등 뒤 wrap)

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { GeminiClient, resolveGeminiApiKey, resolveGeminiConfig } from '../src/main/comfyui/gemini-client.js'
import { ComfyUIClient } from '../src/main/comfyui/client.js'
import { generateSurroundPanorama } from '../src/main/comfyui/panorama-tiles.js'
import { buildScenePlan, composeSurroundPrompts, SEAM_BLEND_PROMPT } from '../src/main/comfyui/prompt-builder.js'
import { buildSurroundSeamBlendWorkflow, randomSeed } from '../src/main/comfyui/workflows.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))
const gemini = resolveGeminiConfig(config.gemini, root)

const args = process.argv.slice(2)
let imageSize = gemini.imageSize || '2K'
let tileSize = Math.round((config.panorama?.width || 4096) / 4)
let blend = false // --blend: 조립 후 ComfyUI Flux Fill로 접합선 블렌드해 {age}-blend.png 추가(원본과 비교)
let bandWidth = config.surround?.bandWidth
let feather = config.surround?.feather
const ages = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--size') imageSize = args[++i]
  else if (args[i] === '--tile') tileSize = Number(args[++i])
  else if (args[i] === '--blend') blend = true
  else if (args[i] === '--band') bandWidth = Number(args[++i])
  else if (args[i] === '--feather') feather = Number(args[++i])
  else if (Number.isInteger(Number(args[i]))) ages.push(Number(args[i]))
}
const TARGET_AGES = ages.length ? ages : [7, 32, 82]

// probe-gemini-seamfix.mjs와 동일 프로필로 맞춰 비교.
const profile = { name: '홍길동', birthDate: '1980-03-15', occupation: 'teacher', gender: 'male' }

const outDir = path.join(root, 'library/_probe/surround')
await fs.mkdir(outDir, { recursive: true })

const gclient = new GeminiClient({
  apiKey: await resolveGeminiApiKey(gemini),
  model: gemini.model,
  textModel: gemini.textModel,
  timeoutMs: config.timeoutMs
})

const client = blend ? new ComfyUIClient({ host: config.host, timeoutMs: config.timeoutMs }) : null

console.log('Gemini 연결 확인…')
await gclient.ping()
if (blend) await client.ping()
const sceneModel = gemini.sceneModel || gemini.model
console.log(
  `Gemini scene: ${sceneModel} · 타일 ${tileSize}² · imageSize ${imageSize}` +
    (blend ? ` · 접합선 블렌드 band ${bandWidth ?? 200} feather ${feather ?? 100}` : '') +
    '\n'
)

const plan = buildScenePlan(profile, { perStage: 3 })

// 두 타일의 접합면([왼타일 오른쪽 절반 | 오른타일 왼쪽 절반])을 붙여 접합선을 확대 검증.
async function seamStrip(leftBuf, rightBuf) {
  const half = Math.round(tileSize / 2)
  const l = await sharp(leftBuf).resize(tileSize, tileSize, { fit: 'fill' }).extract({ left: tileSize - half, top: 0, width: half, height: tileSize }).toBuffer()
  const r = await sharp(rightBuf).resize(tileSize, tileSize, { fit: 'fill' }).extract({ left: 0, top: 0, width: half, height: tileSize }).toBuffer()
  return sharp({ create: { width: half * 2, height: tileSize, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: l, left: 0, top: 0 }, { input: r, left: half, top: 0 }])
    .png()
    .toBuffer()
}

for (const age of TARGET_AGES) {
  const item = plan.find((p) => p.age === age)
  if (!item) {
    console.log(`(나이 ${age} 플랜에 없음, 건너뜀)`)
    continue
  }
  process.stdout.write(`[${age}살 · ${item.id}] 생성… `)
  const t0 = Date.now()
  try {
    const { tiles, panorama } = await generateSurroundPanorama({
      gclient,
      prompts: composeSurroundPrompts(profile, item),
      tileSize,
      imageSize,
      model: sceneModel,
      onProgress: (p) => process.stdout.write(`${p.step} `)
    })
    // 스트립 순서 [타일4(left) | 타일1(front) | 타일2(right) | 타일3(back)] — 접합선 4개.
    const seams = {
      41: await seamStrip(tiles.left, tiles.front), //  타일4 ↔ 타일1
      12: await seamStrip(tiles.front, tiles.right), // 타일1 ↔ 타일2
      23: await seamStrip(tiles.right, tiles.back), //  타일2 ↔ 타일3
      34: await seamStrip(tiles.back, tiles.left) //    타일3 ↔ 타일4 (등 뒤 wrap)
    }
    await Promise.all([
      fs.writeFile(path.join(outDir, `${age}-pano.png`), panorama),
      fs.writeFile(path.join(outDir, `${age}-t1.png`), tiles.front),
      fs.writeFile(path.join(outDir, `${age}-t2.png`), tiles.right),
      fs.writeFile(path.join(outDir, `${age}-t3.png`), tiles.back),
      fs.writeFile(path.join(outDir, `${age}-t4.png`), tiles.left),
      ...Object.entries(seams).map(([k, buf]) => fs.writeFile(path.join(outDir, `${age}-seam-${k}.png`), buf))
    ])
    process.stdout.write(`gen ${((Date.now() - t0) / 1000).toFixed(1)}s`)

    if (blend) {
      // 조립본을 ComfyUI Flux Fill로 접합선 블렌드 → {age}-blend.png (+ 검증 -pano/-raw/-seam).
      const tBlend = Date.now()
      const uploaded = await client.uploadImage(panorama, `surround-${age}-assembled.png`)
      const wf = buildSurroundSeamBlendWorkflow({
        referenceImage: uploaded.name,
        bandPrompt: SEAM_BLEND_PROMPT,
        width: config.panorama?.width || tileSize * 4,
        height: config.panorama?.height || tileSize,
        tileCount: 4,
        bandWidth,
        feather,
        seed: randomSeed(),
        seamCheck: true,
        filenamePrefix: `chrono-zoetrope/_probe-surround/${age}`
      })
      const out = await client.generate(wf)
      for (const img of out.images) {
        const kind = /-rawseam_/.test(img.filename)
          ? 'blend-rawseam'
          : /-raw_/.test(img.filename)
            ? 'blend-raw'
            : /-seam_/.test(img.filename)
              ? 'blend-seam'
              : 'blend'
        await fs.writeFile(path.join(outDir, `${age}-${kind}.png`), img.data)
      }
      process.stdout.write(` + blend ${((Date.now() - tBlend) / 1000).toFixed(1)}s`)
    }
    console.log()
  } catch (err) {
    console.log(`\n  실패: ${err.message}`)
  }
}

if (client) client.close()

console.log(
  `\n결과: ${path.relative(root, outDir)}/` +
    `\n  · {age}-pano.png       조립 파노라마` +
    `\n  · {age}-t1..t4.png     개별 타일(front/right/back/left)` +
    `\n  · {age}-seam-XY.png    각 접합선 확대(12·23·41 내부, 34=등 뒤 wrap) — 중앙선 연속성 확인.`
)
