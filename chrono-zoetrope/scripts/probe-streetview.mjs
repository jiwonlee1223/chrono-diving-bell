#!/usr/bin/env node
// Path B 프로브 — rotate-and-outpaint(생성형 Street View). front 한 장에서 좌우로 이어 그려 방위각 연속 파노라마.
// 라이브러리는 안 건드리고 library/_probe/streetview/ 에만 저장. 기본은 flux2-surround 프로브의 캐시 front 재사용
// (승인된 교실 앵커로 wide-anchor 버전과 직접 비교). --fresh면 front도 새로 생성.
//
//   node scripts/probe-streetview.mjs 32                 # 캐시 front 재사용
//   node scripts/probe-streetview.mjs 32 --step 512      # 아웃페인팅 스텝 512(더 안전·느림)
//   node scripts/probe-streetview.mjs 32 --fresh         # front도 새로 생성
//   node scripts/probe-streetview.mjs 32 --tag beach --scene "..."   # 다른 장면

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComfyUIClient } from '../src/main/comfyui/client.js'
import { GeminiClient, resolveGeminiApiKey, resolveGeminiConfig } from '../src/main/comfyui/gemini-client.js'
import { generateStreetViewPanorama } from '../src/main/comfyui/panorama-streetview.js'
import { buildScenePlan, composeSurroundGazeAnchorPrompt, composeSurroundFlux2Continuation } from '../src/main/comfyui/prompt-builder.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))
const gemini = resolveGeminiConfig(config.gemini, root)

const args = process.argv.slice(2)
let step = 1024
let context = 1024
let bandWidth = 256
let fresh = false
let sceneOverride = null
let tag = null
const ages = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--step') step = Number(args[++i])
  else if (args[i] === '--context') context = Number(args[++i])
  else if (args[i] === '--band') bandWidth = Number(args[++i])
  else if (args[i] === '--fresh') fresh = true
  else if (args[i] === '--scene') sceneOverride = args[++i]
  else if (args[i] === '--tag') tag = args[++i]
  else if (Number.isInteger(Number(args[i]))) ages.push(Number(args[i]))
}
const TARGET_AGES = ages.length ? ages : [32]

const profile = { name: '홍길동', birthDate: '1980-03-15', occupation: 'teacher', gender: 'male' }
const outDir = path.join(root, 'library/_probe/streetview')
const surroundDir = path.join(root, 'library/_probe/flux2-surround')
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
console.log(`Path B rotate-and-outpaint · front ${tileSize * 2}×${tileSize} · step ${step} · context ${context} · wrap band ${bandWidth}\n`)

const plan = buildScenePlan(profile, { perStage: 3 })

for (const age of TARGET_AGES) {
  const baseItem = plan.find((p) => p.age === age)
  if (!baseItem) {
    console.log(`(나이 ${age} 플랜에 없음)`)
    continue
  }
  const item = sceneOverride ? { ...baseItem, scene: sceneOverride } : baseItem
  const label = tag || String(age)

  // 캐시 front 재사용(기본) — flux2-surround 프로브가 만든 승인된 앵커
  let frontAnchor = null
  if (!fresh) {
    frontAnchor = await fs.readFile(path.join(surroundDir, `${label}-anchor-front.png`)).catch(() => null)
    if (!frontAnchor) console.log(`(캐시 front 없음: ${label}-anchor-front.png → --fresh로 새로 생성)`)
  }

  process.stdout.write(`[${label} · ${item.scene.slice(0, 36)}…] `)
  const t0 = Date.now()
  try {
    const { front, rightExt, leftExt, assembled, panorama, workflow } = await generateStreetViewPanorama({
      gclient,
      client,
      prompts: {
        anchor: composeSurroundGazeAnchorPrompt(profile, item),
        continuation: composeSurroundFlux2Continuation(profile, item)
      },
      frontAnchor,
      tileSize,
      imageSize: gemini.imageSize || '2K',
      model: gemini.model,
      step,
      context,
      bandWidth,
      pid: '_probe',
      sceneId: label,
      onProgress: (p) => process.stdout.write(`${p.step}${p.value != null ? '' : ' '}`)
    })
    await Promise.all([
      fs.writeFile(path.join(outDir, `${label}-pano.png`), panorama),
      fs.writeFile(path.join(outDir, `${label}-assembled.png`), assembled),
      fs.writeFile(path.join(outDir, `${label}-front.png`), front),
      fs.writeFile(path.join(outDir, `${label}-rightExt.png`), rightExt),
      fs.writeFile(path.join(outDir, `${label}-leftExt.png`), leftExt),
      fs.writeFile(path.join(outDir, `${label}-workflow.json`), JSON.stringify(workflow, null, 2))
    ])
    console.log(`\n  → ${((Date.now() - t0) / 1000).toFixed(1)}s  ${outDir}/${label}-pano.png`)
  } catch (err) {
    console.log(`\n  실패: ${err.message}`)
  }
}

client.close()
console.log(
  `\n결과: ${path.relative(root, outDir)}/  (${'{label}'}-pano.png = wrap 닫은 최종, -assembled.png = 닫기 전, -rightExt/-leftExt = 확장 스트립)`
)
