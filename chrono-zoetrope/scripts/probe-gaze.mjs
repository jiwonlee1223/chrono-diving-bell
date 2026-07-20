#!/usr/bin/env node
// Path C 프로브 — aerial 공유 + 응시대상 back anchor + ±90° continuation 크로스페이드.
// 기본은 flux2-surround 캐시(aerial/front/back) 재사용 → 조인 방식만 바꿔 wide-anchor와 직접 비교(재생성 없음).
// 결과는 library/_probe/gaze/.
//
//   node scripts/probe-gaze.mjs 32                # 캐시 재사용, ov=256
//   node scripts/probe-gaze.mjs 32 --ov 384       # 조인 크로스페이드 폭
//   node scripts/probe-gaze.mjs 32 --fresh        # aerial/front/back 새로 생성

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComfyUIClient } from '../src/main/comfyui/client.js'
import { GeminiClient, resolveGeminiApiKey, resolveGeminiConfig } from '../src/main/comfyui/gemini-client.js'
import { generateGazePanorama } from '../src/main/comfyui/gaze-panorama.js'
import { buildScenePlan } from '../src/main/comfyui/prompt-builder.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))
const gemini = resolveGeminiConfig(config.gemini, root)

const args = process.argv.slice(2)
let ov = 256
let context = 768
let fresh = false
let tag = null
let frontRatio = 2 // front 앵커 비율: 2(=2:1,180°) | 3(=3:1,270°)
const ages = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ov') ov = Number(args[++i])
  else if (args[i] === '--context') context = Number(args[++i])
  else if (args[i] === '--front') frontRatio = Number(args[++i])
  else if (args[i] === '--fresh') fresh = true
  else if (args[i] === '--tag') tag = args[++i]
  else if (Number.isInteger(Number(args[i]))) ages.push(Number(args[i]))
}
const TARGET_AGES = ages.length ? ages : [32]
if (frontRatio !== 2 && !fresh) {
  console.log(`(front 비율 ${frontRatio}:1 → 2:1 캐시 재사용 불가, --fresh 강제)`)
  fresh = true
}

const profile = { name: '홍길동', birthDate: '1980-03-15', occupation: 'teacher', gender: 'male' }
const outDir = path.join(root, 'library/_probe/gaze')
const cacheDir = path.join(root, 'library/_probe/flux2-surround')
await fs.mkdir(outDir, { recursive: true })
const tileSize = Math.round((config.panorama?.width || 4096) / 4)

const gclient = new GeminiClient({ apiKey: await resolveGeminiApiKey(gemini), model: gemini.model, textModel: gemini.textModel, timeoutMs: config.timeoutMs })
const client = new ComfyUIClient({ host: config.host, timeoutMs: config.timeoutMs })
console.log('Gemini + ComfyUI 연결 확인…')
await gclient.ping()
await client.ping()
console.log(`Path C gaze-streetview · aerial 공유 + 응시 back + ±90° continuation 크로스페이드 · ov ${ov}\n`)

const plan = buildScenePlan(profile, { perStage: 3 })

for (const age of TARGET_AGES) {
  const item = plan.find((p) => p.age === age)
  if (!item) {
    console.log(`(나이 ${age} 없음)`)
    continue
  }
  const label = tag || String(age)
  let frontAnchor = null
  let backAnchor = null
  let aerialImg = null
  if (!fresh) {
    frontAnchor = await fs.readFile(path.join(cacheDir, `${age}-anchor-front.png`)).catch(() => null)
    backAnchor = await fs.readFile(path.join(cacheDir, `${age}-anchor-back.png`)).catch(() => null)
    aerialImg = await fs.readFile(path.join(cacheDir, `${age}-aerial.png`)).catch(() => null)
    if (!frontAnchor || !backAnchor) console.log(`(캐시 anchor 없음 → --fresh 권장)`)
  }

  process.stdout.write(`[${label}] `)
  const t0 = Date.now()
  try {
    const { aerial, front, back, panorama, workflow, meta } = await generateGazePanorama({
      gclient,
      client,
      profile,
      item,
      frontAnchor,
      backAnchor,
      aerialImg,
      tileSize,
      frontW: frontRatio * tileSize,
      imageSize: gemini.imageSize || '2K',
      model: gemini.model,
      ov,
      context,
      pid: '_probe',
      sceneId: label,
      onProgress: (p) => process.stdout.write(`${p.step} `)
    })
    await Promise.all([
      fs.writeFile(path.join(outDir, `${label}-pano.png`), panorama),
      fs.writeFile(path.join(outDir, `${label}-front.png`), front),
      fs.writeFile(path.join(outDir, `${label}-back.png`), back),
      fs.writeFile(path.join(outDir, `${label}-workflow.json`), JSON.stringify(workflow, null, 2)),
      ...(aerial ? [fs.writeFile(path.join(outDir, `${label}-aerial.png`), aerial)] : [])
    ])
    console.log(`\n  → ${((Date.now() - t0) / 1000).toFixed(1)}s  joins@±${meta.joinsAtDeg[0]}°  ${outDir}/${label}-pano.png`)
  } catch (err) {
    console.log(`\n  실패: ${err.message}`)
  }
}
client.close()
console.log(`\n결과: ${path.relative(root, outDir)}/`)
