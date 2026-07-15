#!/usr/bin/env node
// A안 프로브 — 로컬 SDXL + circular padding(x_only)으로 seamless 파노라마를 생성해
// 좌우가 실제로 이어지는지, 3인칭 부감 대신 어떤 1인칭 몰입 구도로 나오는지 눈으로 확인한다.
//
// ComfyUI 서버(143.248.107.38:8188) 필요. 라이브러리는 건드리지 않고 결과를
// library/_probe/seamless/ 에만 저장한다.
//
//   node scripts/probe-seamless-panorama.mjs                 # 기본 나이 7 32 82
//   node scripts/probe-seamless-panorama.mjs 32              # 특정 나이만
//   node scripts/probe-seamless-panorama.mjs 32 --width 2048 --height 1024
//
// 나이마다 두 파일:
//   {age}-pano.png  파노라마 본체 (실린더 둘레에 감길 소스)
//   {age}-seam.png  파노라마를 좌우로 이어붙인 [A|A]. 중앙 세로선이 곧 실린더 wrap 지점 —
//                   x_only tiling이 먹었으면 중앙이 매끈하고, 아니면 뚜렷한 경계가 보인다.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComfyUIClient } from '../src/main/comfyui/client.js'
import { buildSeamlessPanoramaWorkflow, randomSeed } from '../src/main/comfyui/workflows.js'
import { buildScenePlan, composePanoramaScenePrompt } from '../src/main/comfyui/prompt-builder.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))

// CLI 파싱: 정수는 나이, --width/--height 는 파노라마 크기.
const args = process.argv.slice(2)
let width = 1536
let height = 768
const ages = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--width') width = Number(args[++i])
  else if (args[i] === '--height') height = Number(args[++i])
  else if (Number.isInteger(Number(args[i]))) ages.push(Number(args[i]))
}
const TARGET_AGES = ages.length ? ages : [7, 32, 82]

// 실측 프로필 — 결정론적 플랜을 위해 고정 (probe-scene-safety.mjs 와 동일 규칙).
const profile = { name: '홍길동', birthDate: '1980-03-15', occupation: 'teacher', gender: 'male' }

const outDir = path.join(root, 'library/_probe/seamless')
await fs.mkdir(outDir, { recursive: true })

const client = new ComfyUIClient({ host: config.host, timeoutMs: config.timeoutMs })
console.log(`ComfyUI 연결 확인… ${config.host}`)
await client.ping()
console.log(`SDXL realvisxl Lightning · seamless x_only · ${width}×${height}\n`)

const plan = buildScenePlan(profile, { perStage: 3 })

for (const age of TARGET_AGES) {
  const item = plan.find((p) => p.age === age)
  if (!item) {
    console.log(`(나이 ${age} 플랜에 없음, 건너뜀)`)
    continue
  }
  const prompt = composePanoramaScenePrompt(profile, item)
  const seed = randomSeed()
  process.stdout.write(`[${age}살 · ${item.id}] 생성 중… `)
  const t0 = Date.now()
  try {
    const wf = buildSeamlessPanoramaWorkflow({
      prompt,
      width,
      height,
      seed,
      seamCheck: true,
      filenamePrefix: `chrono-zoetrope/_probe-seamless/${age}`
    })
    const out = await client.generate(wf)
    const saved = []
    for (const img of out.images) {
      // img.filename 은 basename (예: "32-seam_00001_.png"). "-seam_" 로 구분.
      const kind = /-seam_/.test(img.filename) ? 'seam' : 'pano'
      const dest = path.join(outDir, `${age}-${kind}.png`)
      await fs.writeFile(dest, img.data)
      saved.push(`${age}-${kind}.png`)
    }
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  → ${saved.join(' , ')}  (seed ${seed})`)
  } catch (err) {
    console.log(`실패: ${err.message}`)
  }
}

client.close()
console.log(
  `\n결과: ${path.relative(root, outDir)}/` +
    `\n  · *-pano.png : 실린더에 감길 파노라마 본체` +
    `\n  · *-seam.png : [A|A] 이어붙임 — 중앙 세로선(=wrap 지점)이 매끈하면 x_only 성공`
)
