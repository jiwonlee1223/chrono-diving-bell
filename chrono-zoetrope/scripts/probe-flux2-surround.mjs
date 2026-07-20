#!/usr/bin/env node
// 넓은 앵커 서라운드 프로브 — 응시 구도(주인공 far-left) 넓은 정면 + image1 조건화한 연속 풍경 2장 + 좁은 이음선.
// 라이브러리는 건드리지 않고 library/_probe/flux2-surround/ 에만 저장한다. Gemini + ComfyUI(Flux Fill) 둘 다 필요.
//
//   node scripts/probe-flux2-surround.mjs 32                 # 나이 32 한 장면
//   node scripts/probe-flux2-surround.mjs 32 --band 192 --feather 48   # 이음선 밴드 튜닝
//   node scripts/probe-flux2-surround.mjs 32 --reuse         # 캐시된 앵커 2장 재사용(Gemini 재과금 없이 이음선만 재보정)
//
// 앵커 2장은 {age}-anchor-front/back.png로 캐시된다 — --reuse면 재생성 없이 이음선만 다시 보정한다.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComfyUIClient } from '../src/main/comfyui/client.js'
import { GeminiClient, resolveGeminiApiKey, resolveGeminiConfig } from '../src/main/comfyui/gemini-client.js'
import { generateSurroundPanoramaFlux2 } from '../src/main/comfyui/panorama-flux2.js'
import { buildScenePlan, composeSurroundGazePrompts } from '../src/main/comfyui/prompt-builder.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))
const gemini = resolveGeminiConfig(config.gemini, root)

const args = process.argv.slice(2)
let bandWidth = config.surround?.bandWidth
let feather = config.surround?.feather
let reuse = false
let sceneOverride = null // --scene "..." : item.scene를 임의 장면으로 덮어씀(교실 외 장면 테스트)
let tag = null // --tag foo : 출력 파일 접두사를 age 대신 foo로(기존 결과 안 덮음)
const ages = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--band') bandWidth = Number(args[++i])
  else if (args[i] === '--feather') feather = Number(args[++i])
  else if (args[i] === '--reuse') reuse = true
  else if (args[i] === '--scene') sceneOverride = args[++i]
  else if (args[i] === '--tag') tag = args[++i]
  else if (Number.isInteger(Number(args[i]))) ages.push(Number(args[i]))
}
const TARGET_AGES = ages.length ? ages : [32]

const profile = { name: '홍길동', birthDate: '1980-03-15', occupation: 'teacher', gender: 'male' }
const outDir = path.join(root, 'library/_probe/flux2-surround')
await fs.mkdir(outDir, { recursive: true })
const tileSize = Math.round((config.panorama?.width || 4096) / 4)

const gclient = new GeminiClient({
  apiKey: await resolveGeminiApiKey(gemini),
  model: gemini.model,
  textModel: gemini.textModel,
  timeoutMs: config.timeoutMs
})
const client = new ComfyUIClient({ host: config.host, timeoutMs: config.timeoutMs })
console.log('Gemini + ComfyUI 연결 확인…')
await gclient.ping()
await client.ping()
console.log(`항공샷 기반 서라운드(pro) · 이음선 band ${bandWidth ?? 256}/${feather ?? 96} · 뷰 ${tileSize * 2}×${tileSize} ×2\n`)

const plan = buildScenePlan(profile, { perStage: 3 })

for (const age of TARGET_AGES) {
  const baseItem = plan.find((p) => p.age === age)
  if (!baseItem) {
    console.log(`(나이 ${age} 플랜에 없음)`)
    continue
  }
  const item = sceneOverride ? { ...baseItem, scene: sceneOverride } : baseItem
  const label = tag || String(age) // 출력 파일 접두사(--tag로 기존 결과 보존)
  // --reuse: 캐시된 앵커 2장(front·back)이 있으면 Gemini 재과금 없이 브리지만 다시.
  let frontAnchor = null
  let backAnchor = null
  if (reuse) {
    frontAnchor = await fs.readFile(path.join(outDir, `${label}-anchor-front.png`)).catch(() => null)
    backAnchor = await fs.readFile(path.join(outDir, `${label}-anchor-back.png`)).catch(() => null)
    if (!frontAnchor || !backAnchor) {
      console.log('(--reuse지만 캐시된 앵커 없음 → 새로 생성)')
      frontAnchor = backAnchor = null
    }
  }
  process.stdout.write(`[${label} · ${item.scene.slice(0, 40)}…] `)
  const t0 = Date.now()
  try {
    const { aerial, front, back, panorama, workflow } = await generateSurroundPanoramaFlux2({
      gclient, // 뷰가 없으면 이 gclient로 항공샷·정면·리버스뷰 생성
      client,
      prompts: composeSurroundGazePrompts(profile, item),
      frontAnchor,
      backAnchor,
      tileSize,
      imageSize: gemini.imageSize || '2K',
      model: gemini.model, // 항공샷·다중레퍼런스는 pro
      bandWidth,
      feather,
      pid: '_probe',
      sceneId: label,
      onProgress: (p) => process.stdout.write(`${p.step} `)
    })
    await Promise.all([
      fs.writeFile(path.join(outDir, `${label}-pano.png`), panorama),
      fs.writeFile(path.join(outDir, `${label}-front.png`), front),
      fs.writeFile(path.join(outDir, `${label}-back.png`), back),
      ...(aerial ? [fs.writeFile(path.join(outDir, `${label}-aerial.png`), aerial)] : []),
      fs.writeFile(path.join(outDir, `${label}-anchor-front.png`), front), // 캐시(--reuse용)
      fs.writeFile(path.join(outDir, `${label}-anchor-back.png`), back),
      fs.writeFile(path.join(outDir, `${label}-workflow.json`), JSON.stringify(workflow, null, 2))
    ])
    console.log(`\n  → ${((Date.now() - t0) / 1000).toFixed(1)}s  ${outDir}/${label}-pano.png`)
  } catch (err) {
    console.log(`\n  실패: ${err.message}`)
  }
}

client.close()
console.log(
  `\n결과: ${path.relative(root, outDir)}/  ({age}-pano.png = 4096×1024 서라운드, {age}-front.png = 앵커, {age}-workflow.json = 생성 그래프)`
)
