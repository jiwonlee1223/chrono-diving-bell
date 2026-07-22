#!/usr/bin/env node
// 기존 페르소나 manifest에 저장된 프롬프트에서 '얼굴 blur/smear' 문장을 제거한다.
// 배경: 재생성은 저장된 프롬프트를 재사용하므로(admin-server regenerate), 프롬프트 코드에서 smear를
// 지워도 기존 페르소나엔 반영이 안 된다. 이 스크립트가 저장본에서도 smear 문장을 걷어내, 재생성 시
// 배경 인물 얼굴이 정상으로 나오게 한다. (이미 생성된 이미지 픽셀은 그대로 — 정상 얼굴은 재생성 후.)
//
//   node scripts/strip-face-blur.mjs            # library/ 전체(_probe 제외) 드라이런
//   node scripts/strip-face-blur.mjs --apply    # 실제로 manifest에 반영
//   node scripts/strip-face-blur.mjs <pid> --apply

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))
const LIBRARY = path.join(root, config.outDir || 'library')

let args = process.argv.slice(2)
const apply = args.includes('--apply')
args = args.filter((a) => a !== '--apply')

// 마침표로 구분된 한 문장에 face/faces + smear계열 토큰이 함께 있으면 그 문장을 통째로 제거.
const SMEAR_RE =
  /(?<=\.|^)\s*[^.]*?\b(?:face|faces)\b[^.]*?(?:wiped away|smear|smeared|smudge|brushstroke|featureless)[^.]*?\./gi

function stripPrompt(p) {
  return p
    .replace(SMEAR_RE, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+\./g, '.')
    .trim()
}

let pids
if (args.length) {
  pids = args
} else {
  const entries = await fs.readdir(LIBRARY, { withFileTypes: true })
  pids = entries.filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name)
}

let totalImgs = 0
let totalChanged = 0
let residual = 0
let filesChanged = 0

for (const pid of pids) {
  const mf = path.join(LIBRARY, pid, 'manifest.json')
  let m
  try {
    m = JSON.parse(await fs.readFile(mf, 'utf-8'))
  } catch {
    continue
  }
  let changedHere = 0
  for (const im of m.images || []) {
    if (!im.prompt) continue
    totalImgs++
    const after = stripPrompt(im.prompt)
    if (after !== im.prompt) {
      im.prompt = after
      changedHere++
      totalChanged++
    }
    if (/wiped away|smear|smudge|brushstroke|featureless/i.test(im.prompt)) residual++
  }
  if (changedHere && apply) {
    await fs.writeFile(mf, JSON.stringify(m, null, 2))
    filesChanged++
  }
  if (changedHere) console.log(`[${pid}] ${m.profile?.name || '?'} — ${changedHere}장 프롬프트 정리`)
}

console.log(
  `\n${apply ? '반영' : '드라이런'}: 프롬프트 ${totalImgs}개 중 ${totalChanged}개 변경` +
    ` (manifest ${filesChanged}개 저장) · smear 잔존 ${residual}`
)
if (!apply) console.log('실제 반영하려면 --apply 를 붙이세요.')
