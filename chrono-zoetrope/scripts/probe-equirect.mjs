#!/usr/bin/env node
// 진짜 equirectangular 360° 생성 테스트 — 평면 원근 스티칭(Path B/C)과 투영 기하 비교용.
// Gemini에게 "360 카메라 equirectangular 파노라마"를 직접 요청(곡선 지평선·바닥/천장 극점 왜곡·좌우 wrap).
// 결과는 library/_probe/equirect/. ComfyUI 불필요(Gemini 직접).
//
//   node scripts/probe-equirect.mjs            # 교실+교사, 4:1
//   node scripts/probe-equirect.mjs --ratio 2:1

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GeminiClient, resolveGeminiApiKey, resolveGeminiConfig } from '../src/main/comfyui/gemini-client.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))
const gemini = resolveGeminiConfig(config.gemini, root)

const args = process.argv.slice(2)
let ratio = '4:1'
let gaze = false // --gaze: 주인공 정면(0°) + 응시 대상 반대편(180°) 구성
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ratio') ratio = args[++i]
  else if (args[i] === '--gaze') gaze = true
}

const outDir = path.join(root, 'library/_probe/equirect')
await fs.mkdir(outDir, { recursive: true })

const gclient = new GeminiClient({ apiKey: await resolveGeminiApiKey(gemini), model: gemini.model, textModel: gemini.textModel, timeoutMs: config.timeoutMs })
console.log('Gemini 연결 확인…')
await gclient.ping()

// 진짜 360 기하 공통 지시 — 곡선 지평선, 바닥/천장 극점 스트레치, 직선 휨, 좌우 seamless wrap.
const GEO =
  `TRUE equirectangular projection (spherical panorama unwrapped): the horizon runs straight across the vertical middle; ` +
  `the floor sweeps across the ENTIRE bottom stretching toward the nadir (straight down) and the ceiling across the ENTIRE top toward the zenith; ` +
  `straight architectural lines (window frames, ceiling edges, desks) visibly BOW and CURVE away from the center as in a real 360 camera capture; ` +
  `the room wraps completely around the single viewpoint so the far LEFT and far RIGHT edges are the same direction behind the camera and join seamlessly. ` +
  `Every other person's face is wiped away like a soft featureless smear of paint, painterly, not distorted. Photorealistic, natural daylight, absolutely no text, no watermark, not an illustration.`

// plain: 방 가운데서 그냥 촬영. gaze: 주인공 정면(중앙) + 응시 대상 반대편(등 뒤=좌우 끝) 구성.
const prompt = gaze
  ? `A 360-degree equirectangular panoramic photograph of a Korean high school classroom, captured with a 360 camera from a single fixed point. ` +
    `In the CENTER of the frame, directly in front of the camera, a 32-year-old male teacher stands facing the camera and looking straight into the lens, his face in focus — he is the subject the viewer meets. ` +
    `On the OPPOSITE side of the panorama (the far LEFT and far RIGHT edges, i.e. directly BEHIND the camera) is exactly what the teacher is gazing toward: the rows of his students seated at their desks, filling that far side, seen facing back toward the teacher's direction. ` +
    `So the teacher and the students he watches sit at opposite poles of the same 360 room. ` +
    GEO
  : `A 360-degree equirectangular panoramic photograph of a Korean high school classroom, captured with a 360 camera from a single fixed point standing in the middle of the room. ` +
    `A 32-year-old male teacher stands in the room in front of the camera. ` +
    GEO

const t0 = Date.now()
try {
  const img = await gclient.generateImage({ prompt, references: [], aspectRatio: ratio, imageSize: gemini.imageSize || '2K', model: gemini.model })
  const file = path.join(outDir, `classroom-${gaze ? 'gaze-' : ''}${ratio.replace(':', 'x')}.png`)
  await fs.writeFile(file, img)
  console.log(`  → ${((Date.now() - t0) / 1000).toFixed(1)}s  ${file}`)
} catch (err) {
  console.log(`  실패: ${err.message}`)
}
console.log(`\n결과: ${path.relative(root, outDir)}/`)
