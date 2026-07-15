#!/usr/bin/env node
// 3인칭 부감 프롬프트 실측 프로브 — Gemini 이미지 생성이 나이대별로 IMAGE_SAFETY에 걸리는지,
// 구도(부감·주인공 얼굴 노출·타인 얼굴 지움)가 의도대로 나오는지 비파괴로 확인한다.
//
// ComfyUI(143.248.107.38:8188) 불필요 — 이미지 생성은 Gemini API 전용.
// 라이브러리는 건드리지 않고 결과를 library/_probe/scene-safety/ 에만 저장한다.
//
//   node scripts/probe-scene-safety.mjs
//
// POV→3인칭 역전(2026-07-13)의 핵심 리스크(아동 얼굴 IMAGE_SAFETY 차단)를 서버 없이 닫기 위함.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GeminiClient,
  resolveGeminiApiKey,
  resolveGeminiConfig
} from '../src/main/comfyui/gemini-client.js'
import { buildScenePlan, composeGeminiScenePrompt } from '../src/main/comfyui/prompt-builder.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))
const gemini = resolveGeminiConfig(config.gemini, root)

// 실측 프로필 — 결정론적 플랜을 위해 고정. gender male 로 아동 얼굴 케이스를 확실히 만든다.
const profile = { name: '홍길동', birthDate: '1980-03-15', occupation: 'teacher', gender: 'male' }

// 나이대별 대표 장면 1개씩: 아동 3·7·14(핵심 리스크) + 성인 32 + 미래 82.
// CLI 인자로 나이 지정 가능: node scripts/probe-scene-safety.mjs 3 7
const argAges = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n))
const TARGET_AGES = argAges.length ? argAges : [3, 7, 14, 32, 82]

const outDir = path.join(root, 'library/_probe/scene-safety')
await fs.mkdir(outDir, { recursive: true })

const client = new GeminiClient({
  apiKey: await resolveGeminiApiKey(gemini),
  model: gemini.model,
  textModel: gemini.textModel,
  timeoutMs: config.timeoutMs
})

console.log(`Gemini 연결 확인…`)
await client.ping()
console.log(`sceneModel: ${gemini.sceneModel || gemini.model}\n`)

const plan = buildScenePlan(profile, { perStage: 3 })
const results = []

for (const age of TARGET_AGES) {
  const item = plan.find((p) => p.age === age)
  if (!item) continue
  const prompt = composeGeminiScenePrompt(profile, item)
  process.stdout.write(`[${age}살 · ${item.id}] 생성 중… `)
  const t0 = Date.now()
  try {
    const data = await client.generateImage({
      prompt,
      references: [],
      aspectRatio: '16:9',
      imageSize: gemini.imageSize || '2K',
      model: gemini.sceneModel || gemini.model
    })
    const file = path.join(outDir, `age-${String(age).padStart(2, '0')}.png`)
    await fs.writeFile(file, data)
    const sec = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`✓ OK (${sec}s, ${(data.length / 1024).toFixed(0)}KB)`)
    results.push({ age, id: item.id, ok: true, file, scene: item.scene })
  } catch (err) {
    const msg = String(err.message || err)
    const safety = /IMAGE_SAFETY|SAFETY|blocked/i.test(msg)
    console.log(`✗ ${safety ? 'IMAGE_SAFETY 차단' : '실패'} — ${msg}`)
    results.push({ age, id: item.id, ok: false, safety, error: msg, scene: item.scene })
  }
}

console.log(`\n===== 요약 =====`)
for (const r of results) {
  const status = r.ok ? '✓ 생성됨' : r.safety ? '⚠ IMAGE_SAFETY 차단' : '✗ 실패'
  console.log(`  ${String(r.age).padStart(2)}살  ${status}`)
}
const blocked = results.filter((r) => !r.ok && r.safety)
console.log(
  `\n아동 단계 차단: ${results.filter((r) => r.age <= 14 && !r.ok && r.safety).length}/${
    results.filter((r) => r.age <= 14).length
  } | 전체 차단: ${blocked.length}/${results.length}`
)
console.log(`이미지: ${outDir}`)
