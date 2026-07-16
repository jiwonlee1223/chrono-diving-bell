#!/usr/bin/env node
// FREEZE→영상 실제 런타임 경로 테스트 — 상태 기계가 호출하는 VideoRegenerator를 그대로 써서
// (montage.json regen 설정 + 현재 mode의 워크플로우 + client.js) 한 번에 검증한다.
// mode=wan(로컬 Wan2.2 I2V) / seedance(ByteDance API 노드, comfy-api-key.txt 필요) / mock 모두 지원.
//
//   node scripts/probe-regen.mjs [이미지경로]
//
// 결과 mp4: <이미지 폴더>/videos/<id>.mp4 (VideoRegenerator 캐시 규칙 그대로).

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VideoRegenerator } from '../src/main/comfyui/video-cache.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const montage = JSON.parse(
  await fs.readFile(path.join(root, 'src/main/config/montage.json'), 'utf-8')
)
const comfyui = JSON.parse(
  await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8')
)

const imgArg = process.argv[2] || 'library/_probe/scene-safety/age-07.png'
const absPath = path.resolve(root, imgArg)
const personaDir = path.dirname(absPath) // videos/ 캐시가 이 옆에 생긴다

// 상태 기계가 넘기는 재생목록 항목 형태: { id, absPath, scene }
const image = {
  id: `regen-${path.basename(absPath, path.extname(absPath))}`,
  absPath,
  scene: 'first day at an elementary school gate, oversized backpack, 1980s Korea'
}

// regen 설정은 mode별로 하위 섹션에 나뉜다(regen.wan.* / regen.seedance.*). mode에 맞춰 요약.
const mode = montage.regen.mode
const modeInfo =
  mode === 'wan'
    ? `wan.video: ${JSON.stringify(montage.regen.wan.video)}`
    : mode === 'seedance'
      ? `seedance: ${JSON.stringify(montage.regen.seedance)}`
      : mode === 'mock'
        ? `mockDelayMs: ${montage.regen.mockDelayMs}`
        : '(알 수 없는 mode)'

console.log(`입력 이미지: ${imgArg}`)
console.log(`regen.mode: ${mode} | ${modeInfo}`)
if (mode === 'wan') console.log(`프롬프트 prefix: ${montage.regen.wan.promptPrefix.slice(0, 80)}…`)
console.log('')

// seedance(API 노드)는 comfy.org 키가 필요하다 — admin-server와 동일하게 secrets에서 읽어 넘긴다.
let apiKey = null
if (mode === 'seedance' && montage.regen.seedance?.apiKeyPath) {
  apiKey = await fs
    .readFile(path.resolve(root, montage.regen.seedance.apiKeyPath), 'utf-8')
    .then((s) => s.trim())
    .catch(() => null)
}

const regen = new VideoRegenerator({ host: comfyui.host, regen: montage.regen, personaDir, apiKey })
const t0 = Date.now()
try {
  const out = await regen.regenerate(image, {
    onProgress: (e) => {
      if (e.type === 'progress' && e.max) process.stdout.write(`\r  샘플링 ${e.value}/${e.max}   `)
    }
  })
  const sec = ((Date.now() - t0) / 1000).toFixed(1)
  if (out) {
    const st = await fs.stat(out)
    console.log(
      `\n✓ 영상 생성: ${path.relative(root, out)} (${(st.size / 1e6).toFixed(1)}MB, ${sec}s)`
    )
  } else {
    console.log(`\n⚠ null 반환 (mock 모드이거나 폴백 경로) — ${sec}s`)
  }
} catch (err) {
  console.log(`\n✗ 실패: ${err.message}`)
  process.exitCode = 1
} finally {
  regen.close()
}
