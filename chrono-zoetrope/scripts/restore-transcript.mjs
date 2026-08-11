// 터미널 콘솔 로그에서 유령 대화 기록을 복구해 Firebase 'ghostTranscripts'의 sessions 맵에
// 되살린다(2026-08-06 — 세션별 누적 도입 전, 재대화가 이전 turns를 덮던 사고의 복구용).
//
// 사용법:
//   node scripts/restore-transcript.mjs --log <로그.txt> --name <이름> --birth <YYMMDD 등 birthDate> \
//        [--flow past|future] [--start <ms 또는 "2026-08-06T10:00:00+09:00">] [--dry]
//
// 로그 형식(server/index.mjs가 찍는 그대로):
//   [사람] 발화…            → who '사람'
//   [상황] 이벤트…          → who '상황'
//   [유령] 대사… [시작] 장면 12-1 (34살, exact=true)   → who '유령' (장면 마커는 잘라낸다)
// 그 외 라인([server] …, HTTP 로그 등)은 무시한다.
// chapter는 휴리스틱: flow 'past'면 'past'로 시작해, 유령이 미래 전환 고정 질문
// ("가장 궁금한 미래")을 말한 턴부터 'future'. flow 'future'면 전부 'future'.
//
// 안전장치: 기존 문서의 최상위 turns·sessions는 건드리지 않고 sessions.restored-<start>에만
// 추가한다(merge). --dry면 파싱 결과만 출력하고 쓰지 않는다.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initFirebase, upsertGhostTranscript } from '../src/main/comfyui/firestore-source.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (k, d = null) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}

const logPath = argOf('--log')
const name = argOf('--name')
const birthDate = argOf('--birth')
const flow = argOf('--flow', 'past') === 'future' ? 'future' : 'past'
const startArg = argOf('--start')
const dry = args.includes('--dry')
if (!logPath || !name || !birthDate) {
  console.error(
    '사용법: node scripts/restore-transcript.mjs --log <로그.txt> --name <이름> --birth <birthDate> [--flow past|future] [--start <시각>] [--dry]'
  )
  process.exit(1)
}
const startMs = startArg
  ? /^\d+$/.test(startArg)
    ? parseInt(startArg, 10)
    : new Date(startArg).getTime()
  : Date.now()
if (!Number.isFinite(startMs)) {
  console.error(`--start 해석 실패: ${startArg}`)
  process.exit(1)
}

const raw = await fs.readFile(path.resolve(logPath), 'utf-8')
const turns = []
let chapter = flow === 'future' ? 'future' : 'past'
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^\[(사람|상황|유령)\]\s?(.*)$/)
  if (!m) continue
  let text = m[2].trim()
  if (m[1] === '유령') {
    // 장면 표시 마커 제거: "… [시작] 장면 12-1 (34살, exact=true)" → 대사만
    text = text.replace(/\s*\[시작\] 장면 .*$/, '').trim()
    // 종료 마커 제거: "… — 체험 종료" (로그 표기일 뿐 발화가 아니다)
    text = text.replace(/\s*—\s*체험 종료\s*$/, '').trim()
  }
  if (!text) continue
  turns.push({ who: m[1], text, chapter, at: startMs + turns.length * 1000 })
  // 미래 장 전환 휴리스틱 — 유령의 고정 전환 질문 이후부터 'future'
  if (m[1] === '유령' && chapter === 'past' && text.includes('가장 궁금한 미래')) chapter = 'future'
}
if (!turns.length) {
  console.error('로그에서 대화 턴을 하나도 찾지 못했다 — [사람]/[유령]/[상황] 라인이 있는지 확인.')
  process.exit(1)
}
console.log(`파싱: ${turns.length}턴 (past ${turns.filter((t) => t.chapter === 'past').length} / future ${turns.filter((t) => t.chapter === 'future').length})`)
for (const t of turns.slice(0, 6)) console.log(`  [${t.chapter}] ${t.who}: ${t.text.slice(0, 60)}`)
if (turns.length > 6) console.log(`  … 외 ${turns.length - 6}턴`)

if (dry) {
  console.log('(--dry: Firebase에 쓰지 않음)')
  process.exit(0)
}

const config = JSON.parse(
  await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8')
)
await initFirebase({
  serviceAccountPath: path.resolve(root, config.firebase.serviceAccountPath),
  projectId: config.firebase.projectId || undefined
})
const { key, count } = await upsertGhostTranscript({
  profile: { name, birthDate },
  personaId: null,
  flow,
  turns,
  ended: true,
  sessionKey: `restored-${startMs}` // 복구본임이 키에 남는다 — 시간순 병합에도 startMs로 낀다
})
console.log(`복구 완료: ghostTranscripts/${key} sessions.restored-${startMs} (${count}턴)`)
process.exit(0)
