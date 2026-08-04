#!/usr/bin/env node
// 방향 1의 2패스 프로브 — pass1(pro 21:9, probe-pro-pano.mjs 산출물)을 flash에 레퍼런스로 주고
// 같은 장면을 4:1 equirect로 '재구성'시킨다. 크롭이 아니라 재생성이라 인물이 잘리지 않고,
// flash는 인물을 발명하지 않고 pro 결과를 복사만 하므로(aged 포트레이트와 같은 원리) 인체가
// 깨질 여지가 훨씬 적다. 4:1 재배치 과정에서 이음매 프롬프트도 함께 작동한다.
//
//   node scripts/probe-pro-pano-pass2.mjs <personaDir> <sceneId>
//   예: node scripts/probe-pro-pano-pass2.mjs 이태현_030109 22-1
//
// 산출: library/_probe/pro21/{sceneId}-pass2-41.png

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GeminiClient, resolveGeminiApiKey, resolveGeminiConfig } from '../src/main/comfyui/gemini-client.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))
const gemini = resolveGeminiConfig(config.gemini, root)

const [personaId, sceneId] = process.argv.slice(2)
if (!personaId || !sceneId) {
  console.error('사용법: node scripts/probe-pro-pano-pass2.mjs <personaDir> <sceneId>')
  process.exit(1)
}

const probeDir = path.join(root, 'library/_probe/pro21')
const pass1Path = path.join(probeDir, `${sceneId}-pro219.png`)
const pass1 = await fs.readFile(pass1Path) // 없으면 그대로 던짐 — pass1 먼저 실행 필요

const prompt =
  `The attached image is the master reference for this scene — reproduce it as faithfully as possible.` +
  ` Recreate this EXACT same scene as a TRUE 360-degree equirectangular panorama in this wider 4:1 frame:` +
  ` the same place, the same lighting, the same people in the same positions doing the same things.` +
  ` The main subject at the center must be copied precisely — the SAME face, SAME age, SAME clothing, SAME pose,` +
  ` their complete body visible from head to shoes, anatomically intact, never cropped, bent, warped or distorted.` +
  ` The same applies to EVERY other person in the scene: each background person must have a complete, fully connected,` +
  ` anatomically intact body — never a partial figure, never a headless torso, never legs without an upper body,` +
  ` never a body half-dissolved into glass or walls. If a person from the reference would end up partially hidden,` +
  ` awkwardly cut by an object, or incomplete, either draw them fully visible or leave them out of the scene entirely.` +
  ` Extend the environment naturally to fill the wider 360-degree view: continue the same architecture and surroundings` +
  ` to the left and right so the place wraps completely around the single viewpoint.` +
  ` The extended architecture must stay COHERENT and continuous with the reference — walls, floors, ceilings, buildings and` +
  ` streets connect logically at consistent heights and angles, structures never clash, misalign, or contradict each other;` +
  ` it reads as ONE single believable place photographed from one point,` +
  ` and the far LEFT and far RIGHT edges show the same direction behind the camera, flowing seamlessly into one another` +
  ` — let the two ends meet on a simple plain surface (a bare wall or pillar), never across a person or complex object.` +
  ` The horizon stays level across the vertical middle; the floor sweeps across the entire bottom and the ceiling/sky across the entire top.` +
  ` Photorealistic, natural light. Absolutely no text, letters, signs, watermarks anywhere.`

const gclient = new GeminiClient({
  apiKey: await resolveGeminiApiKey(gemini),
  model: gemini.sceneModel, // flash — 4:1 지원
  textModel: gemini.textModel,
  timeoutMs: config.timeoutMs
})

console.log(`flash(${gemini.sceneModel}) 4:1 재구성 중... (pass1: ${path.basename(pass1Path)})`)
const t0 = Date.now()
const data = await gclient.generateImage({
  prompt,
  references: [pass1],
  aspectRatio: '4:1',
  imageSize: gemini.imageSize || '2K',
  model: gemini.sceneModel
})
const outPath = path.join(probeDir, `${sceneId}-pass2-41.png`)
await fs.writeFile(outPath, data)
console.log(`완료 (${((Date.now() - t0) / 1000).toFixed(1)}s): ${outPath}`)
