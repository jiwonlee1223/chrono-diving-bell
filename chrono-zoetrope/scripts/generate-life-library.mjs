#!/usr/bin/env node
// 생애 라이브러리 생성 CLI — 수집 앱(todo)이 생기기 전까지의 실행 진입점이자 검증 도구.
//
//   node scripts/generate-life-library.mjs --profile scripts/sample-profile.json            # 30장 전부
//   node scripts/generate-life-library.mjs --profile ... --limit 2                          # 앞 2장만
//   node scripts/generate-life-library.mjs --profile ... --dry-run                          # 플랜만 출력
//   node scripts/generate-life-library.mjs --profile ... --workflow sdxl                    # 폴백 강제
//   node scripts/generate-life-library.mjs --profile ... --workflow gemini                  # 전부 Gemini
//
// 옵션: --host URL, --out DIR, --per-stage N (config/comfyui.json 기본값을 덮어쓴다)

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateLifeLibrary } from '../src/main/comfyui/life-library.js'
import { resolveGeminiConfig } from '../src/main/comfyui/gemini-client.js'
import {
  buildScenePlan,
  composeGeminiScenePrompt,
  composeKontextPrompt,
  composeSdxlPrompt,
  personaId
} from '../src/main/comfyui/prompt-builder.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a.startsWith('--')) args[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i]
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.profile) {
  console.error('사용법: node scripts/generate-life-library.mjs --profile <profile.json> [--limit N] [--dry-run] [--workflow auto|kontext|sdxl|gemini]')
  process.exit(1)
}

const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))
const profilePath = path.resolve(args.profile)
const profile = JSON.parse(await fs.readFile(profilePath, 'utf-8'))
// 프로필 내 사진 경로는 프로필 파일 기준 상대 경로 허용
profile.photos = (profile.photos || []).map((p) => path.resolve(path.dirname(profilePath), p))

const perStage = args.perStage ? parseInt(args.perStage, 10) : config.perStage
const workflow = args.workflow || config.workflow

if (args.dryRun) {
  const plan = buildScenePlan(profile, { perStage })
  const mode = workflow === 'auto' ? (profile.photos.length ? 'kontext' : 'sdxl') : workflow
  console.log(`persona: ${personaId(profile)}  workflow: ${mode}  total: ${plan.length}장\n`)
  for (const item of plan) {
    const prompt =
      mode === 'sdxl'
        ? composeSdxlPrompt(profile, item)
        : mode === 'gemini'
          ? composeGeminiScenePrompt(profile, item)
          : composeKontextPrompt(profile, item)
    console.log(`[${item.id}] age ${item.age} (${item.year}${item.isPast ? '' : ', 미래'})\n  ${prompt}\n`)
  }
  process.exit(0)
}

const t0 = Date.now()
const result = await generateLifeLibrary(profile, {
  host: args.host || config.host,
  outDir: path.resolve(root, args.out || config.outDir),
  workflow,
  perStage,
  limit: args.limit ? parseInt(args.limit, 10) : Infinity,
  image: config.image,
  panorama: config.panorama, // seamfix 파노라마 크기 (CLI에도 반영)
  seamfix: config.seamfix, // 이음매 밴드 폭/페더
  timeoutMs: config.timeoutMs,
  gemini: resolveGeminiConfig(config.gemini, root),
  onProgress: (e) => {
    if (e.type === 'plan') console.log(`플랜 ${e.total}장 생성 시작`)
    else if (e.type === 'upload') console.log(`레퍼런스 업로드 완료: ${e.file}`)
    else if (e.type === 'gender-start') console.log('성별 자동감지 중...')
    else if (e.type === 'gender-done')
      console.log(`성별 자동감지: ${e.gender || '판별 불가'}${e.error ? ` (오류: ${e.error})` : ''}`)
    else if (e.type === 'image-start') console.log(`[${e.item.id}] age ${e.item.age} 생성 중... (${e.done + 1}/${e.total})`)
    else if (e.type === 'image-done') console.log(`[${e.item.id}] 저장: ${e.file}`)
  }
})

const sec = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\n완료: ${result.manifest.images.length}장 → ${result.dir} (${sec}s)`)
