#!/usr/bin/env node
// 현재 equirect 워크플로우로 나이대별 생애 장면 출력 — Gemini gaze-equirect(21:9) → 4:1 중앙 crop.
// buildScenePlan에서 나이별 scene을 가져와 각각 equirect gaze 파노라마 생성. seamfix는 생략(raw 4:1).
// 결과: library/_probe/equirect/ages/{age}-{id}.png (+ -raw21x9.png)
//
//   node scripts/probe-equirect-ages.mjs                 # 플랜 전 나이대(perStage 1)
//   node scripts/probe-equirect-ages.mjs 7 14 32 82      # 특정 나이만

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { GeminiClient, resolveGeminiApiKey, resolveGeminiConfig } from '../src/main/comfyui/gemini-client.js'
import { buildScenePlan, subjectNoun } from '../src/main/comfyui/prompt-builder.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))
const gemini = resolveGeminiConfig(config.gemini, root)

const args = process.argv.slice(2).map(Number).filter(Number.isInteger)
const outDir = path.join(root, 'library/_probe/equirect/ages')
await fs.mkdir(outDir, { recursive: true })

const profile = { name: '홍길동', birthDate: '1980-03-15', occupation: 'teacher', gender: 'male', descriptors: [] }
const plan = buildScenePlan(profile, { perStage: 1 })
const items = args.length ? plan.filter((p) => args.includes(p.age)) : plan

// equirect 360 기하 + gaze 구도 프롬프트 (nadir/zenith·곡선·wrap + 주인공 정면·응시 대상 반대편)
const GEO =
  ` TRUE equirectangular projection (spherical panorama unwrapped): horizon straight across the middle, the floor/ground sweeps across the entire bottom toward the nadir and the sky/ceiling across the entire top toward the zenith, ` +
  `straight lines visibly BOW and CURVE away from center as in a real 360 camera capture, the place wraps completely around the single viewpoint so far left and far right edges are the same direction behind the camera. ` +
  `Photorealistic, natural light, absolutely no text, no watermark, not an illustration.`

function equirectGazePrompt(profile, item) {
  const who = `a ${item.age}-year-old ${subjectNoun(item.age, profile.gender)}`
  const future = item.isPast ? '' : ` An imagined moment further along in this life.`
  return (
    `A 360-degree equirectangular panoramic photograph captured with a 360 camera from a single fixed point standing inside this moment: ${item.scene}. ` +
    `In the CENTER of the frame, directly in front of the camera, ${who} stands facing the camera and looking straight into the lens, their face shown and in focus — the person whose memory this is. ` +
    `The whole place of this moment wraps around them; across the far sides and directly behind the camera is the rest of the scene they are surrounded by and gazing toward. ` +
    `Every other person's face is wiped away like a soft featureless smear of paint, smooth, painterly, not distorted.` +
    GEO +
    future
  )
}

const gclient = new GeminiClient({ apiKey: await resolveGeminiApiKey(gemini), model: gemini.model, textModel: gemini.textModel, timeoutMs: config.timeoutMs })
console.log('Gemini 연결 확인…')
await gclient.ping()
console.log(`equirect 나이대별 출력 · ${items.length}장 · 21:9 → 4:1 crop\n`)

for (const item of items) {
  process.stdout.write(`[${item.age}살 · ${item.id} · ${item.scene.slice(0, 32)}…] `)
  const t0 = Date.now()
  try {
    const raw = await gclient.generateImage({ prompt: equirectGazePrompt(profile, item), references: [], aspectRatio: '21:9', imageSize: gemini.imageSize || '2K', model: gemini.model })
    const { width, height } = await sharp(raw).metadata()
    const targetH = Math.round(width / 4)
    const top = Math.round((height - targetH) / 2)
    const cropped = await sharp(raw).extract({ left: 0, top, width, height: targetH }).png().toBuffer()
    await Promise.all([
      fs.writeFile(path.join(outDir, `${item.age}-${item.id}.png`), cropped),
      fs.writeFile(path.join(outDir, `${item.age}-${item.id}-raw21x9.png`), raw)
    ])
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`)
  } catch (err) {
    console.log(`실패: ${err.message}`)
  }
}
console.log(`\n결과: ${path.relative(root, outDir)}/  ({age}-{id}.png = 4:1)`)
