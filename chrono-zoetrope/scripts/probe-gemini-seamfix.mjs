#!/usr/bin/env node
// B안 프로브 — Gemini로 파노라마를 생성한 뒤 좌우 이음매를 후처리(roll→중앙 띠 inpaint→roll back)로
// 보정한다. Gemini 화질을 넓은 영역에 유지하면서 wrap 지점만 잇는 방식. A안(SDXL seamless)과 비교용.
//
// Gemini API + ComfyUI 서버(143.248.107.38:8188) 둘 다 필요.
// 라이브러리는 건드리지 않고 결과를 library/_probe/seamfix/ 에만 저장한다.
//
//   node scripts/probe-gemini-seamfix.mjs                 # 기본 나이 7 32 82, Flux Fill 보정
//   node scripts/probe-gemini-seamfix.mjs 32              # 특정 나이만
//   node scripts/probe-gemini-seamfix.mjs 32 --model sdxl # SDXL 폴백으로 비교
//   node scripts/probe-gemini-seamfix.mjs 32 --band 320 --denoise 0.9
//
// 나이마다 네 파일:
//   {age}-raw.png      Gemini 원본(2:1 정규화)      {age}-rawseam.png  원본 [A|A] (보정 전 이음매)
//   {age}-pano.png     이음매 보정 결과             {age}-seam.png     보정 [A|A] (보정 후 이음매)
// rawseam→seam 중앙선을 비교하면 보정 효과가 보인다.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComfyUIClient } from '../src/main/comfyui/client.js'
import {
  GeminiClient,
  resolveGeminiApiKey,
  resolveGeminiConfig
} from '../src/main/comfyui/gemini-client.js'
import { randomSeed } from '../src/main/comfyui/workflows.js'
import { buildGeminiSeamFixWorkflow } from '../src/main/comfyui/seamfix-legacy.js' // LEGACY: seamfix 이음매 보정 프로브
import { buildScenePlan, composePanoramaScenePrompt } from '../src/main/comfyui/prompt-builder.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(
  await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8')
)
const gemini = resolveGeminiConfig(config.gemini, root)

// CLI: 정수는 나이, --band/--denoise/--width/--height 는 보정 파라미터.
const args = process.argv.slice(2)
let width = 2048
let height = 1024
let bandWidth = 256
let denoise // 미지정 시 모델별 기본(flux 1.0 / sdxl 0.7)
let bandModel = 'flux-fill'
const ages = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--band') bandWidth = Number(args[++i])
  else if (args[i] === '--denoise') denoise = Number(args[++i])
  else if (args[i] === '--model') bandModel = args[++i]
  else if (args[i] === '--width') width = Number(args[++i])
  else if (args[i] === '--height') height = Number(args[++i])
  else if (Number.isInteger(Number(args[i]))) ages.push(Number(args[i]))
}
const TARGET_AGES = ages.length ? ages : [7, 32, 82]

// A안 프로브와 동일 프로필·프롬프트로 맞춰 공정 비교.
const profile = { name: '홍길동', birthDate: '1980-03-15', occupation: 'teacher', gender: 'male' }

const outDir = path.join(root, 'library/_probe/seamfix')
await fs.mkdir(outDir, { recursive: true })

const gclient = new GeminiClient({
  apiKey: await resolveGeminiApiKey(gemini),
  model: gemini.model,
  textModel: gemini.textModel,
  timeoutMs: config.timeoutMs
})
const client = new ComfyUIClient({ host: config.host, timeoutMs: config.timeoutMs })

console.log(`Gemini + ComfyUI 연결 확인…`)
await gclient.ping()
await client.ping()
const sceneModel = gemini.sceneModel || gemini.model
const dnLabel = denoise ?? (bandModel === 'flux-fill' ? 1.0 : 0.7)
console.log(
  `Gemini scene: ${sceneModel} · 보정 ${bandModel} band ${bandWidth}px denoise ${dnLabel} · ${width}×${height}\n`
)

const plan = buildScenePlan(profile, { perStage: 3 })

for (const age of TARGET_AGES) {
  const item = plan.find((p) => p.age === age)
  if (!item) {
    console.log(`(나이 ${age} 플랜에 없음, 건너뜀)`)
    continue
  }
  const prompt = composePanoramaScenePrompt(profile, item)
  process.stdout.write(`[${age}살 · ${item.id}] Gemini 생성… `)
  const t0 = Date.now()
  try {
    // 1) Gemini 파노라마 (가장 넓은 표준 비율 16:9 → ComfyUI에서 2:1로 정규화)
    const data = await gclient.generateImage({
      prompt,
      references: [],
      aspectRatio: '16:9',
      imageSize: '2K',
      model: sceneModel
    })
    const tGen = Date.now()
    const uploaded = await client.uploadImage(data, `seamfix-${age}.png`)
    process.stdout.write(`업로드→보정… `)

    // 2) 이음매 보정 워크플로우
    const wf = buildGeminiSeamFixWorkflow({
      referenceImage: uploaded.name,
      prompt,
      width,
      height,
      bandWidth,
      bandModel,
      ...(denoise != null ? { denoise } : {}),
      seed: randomSeed(),
      seamCheck: true,
      filenamePrefix: `chrono-zoetrope/_probe-seamfix/${age}`
    })
    const out = await client.generate(wf)
    const saved = []
    for (const img of out.images) {
      const f = img.filename // basename
      const kind = /-rawseam_/.test(f)
        ? 'rawseam'
        : /-raw_/.test(f)
          ? 'raw'
          : /-seam_/.test(f)
            ? 'seam'
            : 'pano'
      await fs.writeFile(path.join(outDir, `${age}-${kind}.png`), img.data)
      saved.push(kind)
    }
    console.log(
      `gen ${((tGen - t0) / 1000).toFixed(1)}s + fix ${((Date.now() - tGen) / 1000).toFixed(1)}s  → ${saved.sort().join(',')}`
    )
  } catch (err) {
    console.log(`실패: ${err.message}`)
  }
}

client.close()
console.log(
  `\n결과: ${path.relative(root, outDir)}/` +
    `\n  · {age}-raw.png / -rawseam.png : Gemini 원본과 그 이음매(보정 전)` +
    `\n  · {age}-pano.png / -seam.png   : 보정 결과와 그 이음매(보정 후)` +
    `\n  rawseam vs seam 중앙선(=wrap 지점)을 비교.`
)
