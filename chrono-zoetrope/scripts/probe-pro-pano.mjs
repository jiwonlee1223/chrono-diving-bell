#!/usr/bin/env node
// 방향 1 프로브 — pro(gemini-3-pro-image)는 4:1을 거부하지만 21:9는 지원한다.
// pro 21:9로 파노라마를 뽑고 세로 중앙 밴드를 4:1로 크롭하면, flash 4:1의 인체 붕괴를
// pro의 인체·정체성 품질로 대체할 수 있는지 검증한다. 라이브러리는 건드리지 않고
// library/_probe/pro21/ 에만 저장한다.
//
//   node scripts/probe-pro-pano.mjs <personaDir> <sceneId>
//   예: node scripts/probe-pro-pano.mjs 이태현_030109 22-1
//
// 산출: {sceneId}-pro219.png (21:9 원본). 4:1 크롭은 뷰어/후처리에서 중앙 밴드를 잘라 비교.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GeminiClient, resolveGeminiApiKey, resolveGeminiConfig } from '../src/main/comfyui/gemini-client.js'
import { composeEquirectGazePrompt } from '../src/main/comfyui/prompt-builder.js'
import { KEEP_FACE_PREFIX } from '../src/main/comfyui/face-anchor.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))
const gemini = resolveGeminiConfig(config.gemini, root)

const [personaId, sceneId] = process.argv.slice(2)
if (!personaId || !sceneId) {
  console.error('사용법: node scripts/probe-pro-pano.mjs <personaDir> <sceneId>')
  process.exit(1)
}

const personaDir = path.join(root, 'library', personaId)
const manifest = JSON.parse(await fs.readFile(path.join(personaDir, 'manifest.json'), 'utf-8'))
const entry = manifest.images.find((i) => i.id === sceneId)
if (!entry) throw new Error(`장면 없음: ${sceneId}`)

// 레퍼런스: 그 장면의 기록된 앵커(aged 포트레이트 등) 우선, 없으면 원본 얼굴.
let refBuf = null
if (entry.referenceFile) refBuf = await fs.readFile(path.join(personaDir, entry.referenceFile)).catch(() => null)
if (!refBuf && manifest.referenceImage?.local) refBuf = await fs.readFile(manifest.referenceImage.local).catch(() => null)
console.log(`장면: ${sceneId} (${entry.age}세) — "${entry.scene}"`)
console.log(`레퍼런스: ${refBuf ? entry.referenceFile || '원본 얼굴' : '없음'}`)

// 본 파이프라인과 같은 프롬프트 + 21:9→4:1 크롭 대비 "중요 내용은 세로 중앙 밴드에" 지시 추가.
const CROP_BAND =
  ' COMPOSITION FOR CROPPING: all important content — every person, especially the main subject, and the key objects of the scene —' +
  ' stays within the vertical MIDDLE band of the frame (the middle half of the image height), near the horizon line.' +
  ' The top quarter is only ceiling/sky and the bottom quarter is only floor/ground, safe to crop away.'

const prompt =
  (refBuf ? KEEP_FACE_PREFIX : '') +
  composeEquirectGazePrompt(manifest.profile || {}, entry) +
  CROP_BAND

const gclient = new GeminiClient({
  apiKey: await resolveGeminiApiKey(gemini),
  model: gemini.model, // pro
  textModel: gemini.textModel,
  timeoutMs: config.timeoutMs
})

const outDir = path.join(root, 'library/_probe/pro21')
await fs.mkdir(outDir, { recursive: true })

console.log(`pro(${gemini.model}) 21:9 생성 중...`)
const t0 = Date.now()
const data = await gclient.generateImage({
  prompt,
  references: refBuf ? [refBuf] : [],
  aspectRatio: '21:9',
  imageSize: gemini.imageSize || '2K',
  model: gemini.model
})
const outPath = path.join(outDir, `${sceneId}-pro219.png`)
await fs.writeFile(outPath, data)
console.log(`완료 (${((Date.now() - t0) / 1000).toFixed(1)}s): ${outPath}`)
