#!/usr/bin/env node
// 주마등 런타임 서버 — Electron main(src/main/index.js)을 대체하는 Node HTTP 웹앱 서버.
//
//   node server/index.mjs [--port 8788] [--dist <dir>] [--library <dir>]
//
// Electron에서 옮겨온 것(비-윈도우 로직 전부):
//   - 상태 기계(§6) 소유·구동, 라이브러리 로드, 세션 포인터 감시(연구자 admin 연동)
//   - 사전 생성 클립 캐시 조회(전시 중 실시간 생성 없음 — §5.1/§5.2)
//
// Electron → 웹 표준 매핑:
//   - zoe:// 커스텀 프로토콜        → GET /media/*  (CORS 허용, 경로 탈출 차단, Range 지원)
//   - IPC invoke(BOOTSTRAP)         → GET /api/bootstrap
//   - IPC send(main→renderer 방송)  → GET /api/events  (SSE)
//   - IPC send(renderer→main)       → POST /api/input · /api/video-ready · /api/freeze-ready · /api/view-toggle
//   - 4 BrowserWindow + 디스플레이 배치 → 페이지 1개가 4타일을 한 캔버스에 렌더(renderer.js)
//
// 상태 기계는 서버가 소유한다(§6 "main이 상태 소유" 유지). 단일 페이지가 4타일을 렌더하므로
// §7 창-간 배리어는 자동 충족 — VIDEO 배리어는 projectorCount:1 로 1회 ready에 커밋한다.

import http from 'node:http'
import fs from 'node:fs/promises'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { watch } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { Channels } from '../src/shared/channels.js'
import { State } from '../src/shared/states.js'
import { loadMontageLibrary } from '../src/main/library-loader.js'
import { ZoetropeStateMachine } from '../src/main/state-machine.js'
import { VideoRegenerator } from '../src/main/comfyui/video-cache.js'
import {
  readSession,
  writeSession,
  clearSession,
  SESSION_FILE
} from '../src/main/session-pointer.js'
import { readCalibration, writeCalibration } from '../src/main/calibration.js'
import {
  pastQuestions,
  futureQuestions,
  renderQuestions
} from '../src/main/config/reflective-questions.mjs'
import {
  initFirebase,
  ensurePersonaMediaFromFirebase,
  ensureLocalClipsFromFirebase,
  fetchManifestByPersonaId,
  fetchProfileDoc,
  fetchRuntimeSession,
  listenRuntimeSession,
  upsertGhostTranscript,
  fetchExtrapolationRecord,
  upsertLifeCuration
} from '../src/main/comfyui/firestore-source.js'
import { GeminiClient, resolveGeminiApiKey } from '../src/main/comfyui/gemini-client.js'
import { ensurePingpongClip, pingpongPathFor } from '../src/main/comfyui/pingpong.js'
import { AGES, resolveAgePoint, composePointText } from '../src/main/comfyui/life-graph-plan.js'
import { initDome, domeCue } from './dome-serial.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// config는 admin-server처럼 fs로 읽는다(import assertion 미사용 — 순수 Node 호환).
const readJson = async (rel) => JSON.parse(await fs.readFile(path.join(root, rel), 'utf-8'))
const installConfig = await readJson('src/main/config/install.json')
const projectorsConfig = await readJson('src/main/config/projectors.json')
const montageConfig = await readJson('src/main/config/montage.json')
const comfyuiConfig = await readJson('src/main/config/comfyui.json')

const PROJECTORS = projectorsConfig.projectors
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const PORT = parseInt(argOf('--port', '8788'), 10)
const DIST = path.resolve(root, argOf('--dist', 'dist'))
const libraryRoot = path.resolve(root, argOf('--library', montageConfig.libraryDir ?? 'library'))
// 파일 없는 배포(Railway 등)엔 library/ 가 없다 — scandir/watch가 넘어지지 않도록 미리 만든다.
// 페르소나 미디어는 Firebase 정본에서 read-through 로 받는다.
await fs.mkdir(libraryRoot, { recursive: true })

// 설치 캘리브레이션(실린더 정렬용 전역 yaw/pitch) — 런타임 페이지가 실시간 조정·저장한다.
let calibration = await readCalibration(libraryRoot)

// 돔(ESP32 스테퍼) 시리얼 — 국면 전환마다 dome.cues 매핑대로 한 글자 명령을 보낸다(best-effort).
// 포트는 montage.json dome.port(예: "COM6"), --dome COM6 인자로 덮어쓸 수 있다.
// 국면→돔 안무 매핑. cues=1차 체험, cuesSecond=2차 체험 오버라이드(없는 국면 키는 1차 것 사용).
const DOME_CUES = montageConfig.dome?.cues ?? {}
const DOME_CUES_SECOND = { ...DOME_CUES, ...(montageConfig.dome?.cuesSecond ?? {}) }
let domeManualLog = [] // 수동 제어(◀■▶) 타이밍 기록 — /api/dome-record가 안무 초안으로 변환
initDome({
  path: argOf('--dome', montageConfig.dome?.port),
  baudRate: montageConfig.dome?.baudRate ?? 115200
})

// Firebase 정본 read-through: 세션 참가자의 미디어(파노라마·reel)를 로컬에 없으면 받아 재생한다.
// 서비스 계정이 없거나 초기화 실패하면 로컬 파일만으로 동작(best-effort).
let firebaseReady = false
try {
  const fb = comfyuiConfig.firebase
  const saPath = fb?.serviceAccountPath ? path.resolve(root, fb.serviceAccountPath) : undefined
  await initFirebase({
    serviceAccountPath: saPath,
    projectId: fb?.projectId,
    storageBucket: fb?.storageBucket
  })
  firebaseReady = true
  console.log('[server] Firebase 연결 — 미디어를 Firebase 정본에서 확보한다')
} catch (err) {
  console.warn(`[server] Firebase 미연결 — 로컬 미디어만 사용: ${err.message}`)
}

// ── 라이브러리 미디어 URL (zoe://media/... → /media/...) ──────────────
function toMediaUrl(absPath) {
  const rel = path.normalize(absPath).slice(path.normalize(libraryRoot).length + 1)
  const encoded = rel.split(/[\\/]/).map(encodeURIComponent).join('/')
  return `/media/${encoded}`
}

// ── 상태 방송: SSE 클라이언트 집합 ────────────────────────────────────
const sseClients = new Set() // 각 원소 = http.ServerResponse (열린 SSE 스트림)

function broadcast(channel, payload) {
  // 돔 큐: 1차 흐름 국면(idle/spinup/funeral/reel/ghost)이 바뀔 때 매핑된 명령을 ESP32로.
  if (channel === Channels.REEL_DEMO && payload?.phase) {
    const cues = currentExperience === 'second' ? DOME_CUES_SECOND : DOME_CUES
    domeCue(cues[payload.phase])
  }
  const frame = `data: ${JSON.stringify({ channel, payload })}\n\n`
  for (const res of sseClients) {
    try {
      res.write(frame)
    } catch {
      sseClients.delete(res)
    }
  }
  // 진행 중 세션은 건드리지 않는다: 연구자가 도중에 참가자를 바꿨다면 IDLE 복귀 순간에 반영.
  if (
    channel === Channels.STATE &&
    payload?.state === State.IDLE &&
    pendingPersonaId !== undefined
  ) {
    const next = pendingPersonaId
    pendingPersonaId = undefined
    applySessionSelection(next, pendingExperience)
  }
}

// ── 런타임 상태 (src/main/index.js에서 이관) ─────────────────────────
let devPreview = true // 기본 뷰 = 펼친 파노라마. renderer 초기값과 일치(첫 V가 실린더로 전환).
let sm = null //       상태 기계 (라이브러리 로드 후 생성).
let library = null //  몽타주 재생 목록.
let regenerator = null // 현재 페르소나용 영상 캐시 조회기.
let pendingPersonaId //   세션 진행 중 들어온 참가자 교체 — IDLE 복귀 시 반영 (undefined = 없음).
let pendingExperience = 'first' // 예약된 교체의 체험 종류 — pendingPersonaId와 함께 반영.
let reelPhotoPlaylist = [] // reel 전용 3:4 사진(manifest.reelPhotos, 필름스트립용). 없으면 파노라마 rotate 폴백.
let reelRecapText = null // 릴과 동시에 흐르는 삶 회고 멘트(recapFor 결과) — demoPayload가 동기로 읽는다.
let funeralNarrationText = null // 장례식 내레이션 전문(고정 머리+조문객 멘트) — 준비 전이면 고정 머리만 나간다.
let branchRecapText = null // 3차(2차 체험) 분기 릴 위 내레이션(페이싱 포함) — 준비 전이면 생략.
let reelFuturePlaylist = [] // 미래 릴(manifest.reelPhotosFuture) — 2차 전환 때 90세 장례식 뒤에 흐른다.
// 2차 체험(3차 플로우) 릴 — 유령 대화로 바뀐 마음가짐 기반 분기 미래(manifest.reelPhotosBranched).
// 1차 릴이 되감기(현재→탄생)라면 이건 순방향(현재→90세)으로 풀려나간다.
let reelBranchedPlaylist = []
// 현재 세션의 체험 종류 — 'first'(1차 체험: 과거 회귀 주마등) | 'second'(2차 체험: 분기 미래).
// admin 세션 지정 버튼이 _session.json의 experience 필드로 내려준다. 유령 대화는 두 체험이 동일.
let currentExperience = 'first'
let currentProfile = null // 현재 페르소나의 profile({name,birthDate,id?}) — Firebase 문서 키 계산용.
// 부정미래(2차 운명 외삽) 연대기 캐시 — extrapolationRecords(kind 'future')의 narrative.
// 유령이 미래 장면(2장)을 보여줄 때 화면 밖 사정(미뤄진 계획·어긋난 지점)을 대화로 흘리는 재료.
// 페르소나당 한 번만 읽는다(대화 턴마다 buildGhostContext가 돌기 때문). Firestore에서 이 문서의
// narrative 텍스트를 손보면 이미지 재생성 없이 그 사람의 대화 톤(부정성 수위)만 바뀐다.
let futureNarrativeCache = new Map() // `${pid}__${kind}` → text|null
async function futureNarrativeFor(pid, kind = 'future') {
  if (!firebaseReady || !currentProfile || !pid) return null
  const cacheKey = `${pid}__${kind}`
  if (futureNarrativeCache.has(cacheKey)) return futureNarrativeCache.get(cacheKey)
  let text = null
  try {
    text = (await fetchExtrapolationRecord(currentProfile, kind))?.narrative || null
  } catch {
    /* 없거나 실패해도 대화는 그대로 진행 — 장면 카탈로그만으로 동작한다 */
  }
  futureNarrativeCache.set(cacheKey, text)
  return text
}

// 페르소나 하나를 (재)로드: 라이브러리 + 영상 캐시 + 상태 기계를 새로 만든다.
// personaId=null 이면 library-loader가 가장 최근 것을 자동 선택. 실패 시 이전 상태를 유지.
async function loadPersona(personaId) {
  try {
    // Firebase manifest hydrate: 로컬에 manifest가 없고 Firebase가 켜져 있으면 정본에서 받아 로컬에 쓴다.
    // 런타임은 원래 로컬 manifest만 읽었다(library-loader) — 서비스계정 키만 있고 library/가 없는 머신에서도
    // personaId만으로 부트스트랩되게 한다. 이 뒤의 미디어 read-through·loadMontageLibrary가 이 manifest를 읽는다.
    // (자동선택 personaId=null은 로컬 최근본 대상이라 hydrate 불가 — admin이 참가자를 지정하면 그때 복원된다.)
    if (firebaseReady && personaId) {
      const manifestPath = path.join(libraryRoot, personaId, 'manifest.json')
      if (!existsSync(manifestPath)) {
        try {
          const m = await fetchManifestByPersonaId(personaId)
          if (m) {
            await fs.mkdir(path.dirname(manifestPath), { recursive: true })
            await fs.writeFile(manifestPath, JSON.stringify(m, null, 2))
            console.log(`[server] Firebase에서 manifest hydrate: ${personaId}`)
          } else {
            console.warn(`[server] Firebase 정본에 manifest 없음(로컬로 진행): ${personaId}`)
          }
        } catch (e) {
          console.warn(`[server] manifest hydrate 실패(로컬로 진행): ${e.message}`)
        }
      }
    }
    // Firebase 정본에서 미디어를 로컬 캐시로 확보(read-through). 로컬에 이미 있으면 그대로 재사용.
    // manifest의 profile로 문서 키(이름_생년월일)를 얻으므로 personaId 지정 시에만 수행한다.
    if (firebaseReady && personaId) {
      try {
        const dir = path.join(libraryRoot, personaId)
        const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'))
        const r = await ensurePersonaMediaFromFirebase(manifest.profile, dir)
        if (r.images || r.reel)
          console.log(
            `[server] Firebase→로컬 캐시: 이미지 ${r.images}장, reel ${r.reel ? 'O' : '-'}`
          )
        if (r.missing.length)
          console.warn(`[server] Firebase에서 못 받은 미디어: ${r.missing.join(', ')}`)
      } catch (e) {
        console.warn(`[server] Firebase 미디어 확보 실패(로컬로 진행): ${e.message}`)
      }
    }
    const lib = await loadMontageLibrary({
      rootDir: libraryRoot,
      personaId: personaId ?? undefined
    })
    const regen = new VideoRegenerator({
      host: comfyuiConfig.host,
      regen: montageConfig.regen,
      personaDir: lib.dir
    })
    regenerator?.close?.() // 이전 페르소나의 ComfyUI WS 정리
    library = lib
    regenerator = regen
    // reel 배속 종료 타이밍용 — reel.mp4 실제 길이(초). 없으면 0(fallback 90/rate).
    // + reel 전용 3:4 사진(필름스트립): manifest.reelPhotos 중 로컬 파일이 실제로 있는 것만 재생목록으로.
    try {
      const mf = JSON.parse(await fs.readFile(path.join(lib.dir, 'manifest.json'), 'utf8'))
      currentProfile = mf.profile || null
      currentReelSec = mf.reel?.durationSec || 0
      const toPlaylist = (entries) =>
        (entries || [])
          .filter((e) => !e.failed && e.file)
          .map((e) => ({ id: e.id, age: e.age, abs: path.join(lib.dir, e.file) }))
          .filter((e) => existsSync(e.abs))
          .map((e) => ({ id: e.id, age: e.age, url: toMediaUrl(e.abs) }))
      reelPhotoPlaylist = toPlaylist(mf.reelPhotos) // 1차 플로우 주마등은 순방향 — 탄생부터 현 시점까지(2026-08-06 역순→순방향)
      // 2차 플로우의 미래 릴은 **순방향** — 현재 다음 해부터 90세까지 시간이 앞으로 흐른다.
      // 1차가 되감기(현재→탄생)라면 2차는 그 반대 방향으로 풀려나간다(2026-08-03).
      reelFuturePlaylist = toPlaylist(mf.reelPhotosFuture)
      // 2차 체험 릴(분기 미래) — 순방향(현재→90세). 없으면 2차 세션 지정 시 1차 릴로 폴백한다.
      reelBranchedPlaylist = toPlaylist(mf.reelPhotosBranched)
      reelRecapText = null // 이전 페르소나의 회고 멘트 무효화 — prepareGhostPastAssets가 다시 채운다
      funeralNarrationText = null
      branchRecapText = null
      if (reelPhotoPlaylist.length)
        console.log(`[server] 과거 릴 ${reelPhotoPlaylist.length}장 (필름스트립 모드)`)
      if (reelFuturePlaylist.length)
        console.log(`[server] 미래 릴 ${reelFuturePlaylist.length}장 (2차 전환 시 재생)`)
      if (reelBranchedPlaylist.length)
        console.log(`[server] 분기 릴 ${reelBranchedPlaylist.length}장 (2차 체험 세션용)`)
    } catch {
      currentProfile = null
      currentReelSec = 0
      reelRecapText = null
      funeralNarrationText = null
      branchRecapText = null
      reelPhotoPlaylist = []
      reelFuturePlaylist = []
      reelBranchedPlaylist = []
    }
    sm = new ZoetropeStateMachine({
      broadcast,
      // 3차(분기 미래) alt 장면은 1차 몽타주 재생목록에서 뺀다 — 3차 카탈로그에서만 쓴다.
      playlist: library.images.filter((im) => !im.branch),
      montage: montageConfig,
      // 전시 중에는 생성하지 않는다 — 모든 영상은 admin에서 사전 생성되어 캐시에 있다.
      regenerate: (image) => regenerator.cachedPath(image.id),
      toMediaUrl,
      projectorCount: 1 // 웹앱: 단일 페이지가 4타일을 담당 → 1회 ready에 VIDEO 배리어 커밋.
    })
    console.log(`[server] 라이브러리: ${library.personaId} (${library.images.length}장)`)
    // 과거 회귀 대화(1차 플로우) 재료를 백그라운드로 준비 — ghost 국면(릴 종료 뒤)보다 먼저
    // 회고 문장·pingpong 클립이 캐시되도록. 실패해도 세션 발급 시 폴백으로 동작한다.
    prepareGhostPastAssets(library.personaId)
    return true
  } catch (err) {
    console.error('[server] 라이브러리 로드 실패:', err.message)
    if (!sm) library = null // 최초 부팅부터 실패면 IDLE 앰비언트만 동작.
    return false
  }
}

// 연구자가 admin에서 고른 참가자를 런타임에 반영.
// IDLE(대기)일 때만 즉시 교체하고 페이지를 재부트스트랩(RELOAD). 세션 진행 중이면 IDLE 복귀까지 미룬다.
async function applySessionSelection(personaId, experience = 'first') {
  if (sm && sm.state !== State.IDLE) {
    pendingPersonaId = personaId
    pendingExperience = experience === 'second' ? 'second' : 'first'
    console.log(
      `[server] 세션 진행 중 — 참가자 교체를 IDLE 복귀 시로 예약: ${personaId ?? '(자동)'}`
    )
    return
  }
  currentExperience = experience === 'second' ? 'second' : 'first'
  const ok = await loadPersona(personaId)
  if (!ok) return
  // 테스트 경험(사용자 확정): 참가자 선택이 곧바로 reel 데모 시퀀스를 트리거한다.
  console.log(
    `[server] 세션 참가자 반영 (${currentExperience === 'second' ? '2차 체험: 분기 미래' : '1차 체험'}) → reel 데모 트리거`
  )
  runReelDemo()
  // 열려 있는 런타임 페이지를 재부트스트랩한다. 몽타주 텍스처(playlist)는 부트스트랩에서 한 번만
  // 로드되므로, reelMode 'rotate'가 새 참가자의 파노라마를 실린더에 감으려면 리로드가 필요하다.
  // (과거 'video' 모드는 <video>를 즉석 생성해 텍스처가 필요 없었다 — rotate 전환으로 필수가 됐다.)
  // runReelDemo가 국면을 spinup으로 먼저 바꿔두므로, 리로드된 페이지는 부트스트랩의 demo 국면을
  // 이어받아 새 playlist 텍스처로 spinup→reel을 진행한다.
  broadcast(Channels.RELOAD, {})
}

// 개발용 뷰 토글: §4.1 프로젝터 예왜곡 렌더 ↔ 펼친 파노라마 프리뷰.
function toggleDevPreview() {
  devPreview = !devPreview
  console.log('[server] devPreview =', devPreview)
  broadcast(Channels.VIEW_MODE, { preview: devPreview })
}

// ── 1차 흐름(서버 소유 국면) — 새로고침해도 이어가고, 중단은 admin에서만 ─────────────
// 국면: idle → spinup(실타래 배속) → reel(배속 재생) → ghost(유령 뜬 idle, 1인칭 진입 대기).
// 서버가 타이머로 진행하고 매 전이를 SSE로 방송한다. 국면·경과시간을 부트스트랩에도 실어,
// 런타임 페이지를 새로고침하면 클라이언트가 현재 국면(진행 중인 reel 위치까지)을 이어받는다.
// 타이머는 서버에 있으므로 클라이언트가 없거나 새로고침돼도 진행이 계속된다. 중단은 leaveSession(admin)만.
const DEMO_SPINUP_MS = montageConfig.demo?.spinupMs ?? 10000
// 1차 체험 개막만 spinup을 2배로(2026-08-05) — 2차 개막(runReelDemo의 second)·유령 2장 브리지는 spinupMs 유지.
const DEMO_SPINUP_FIRST_MS = montageConfig.demo?.spinupFirstMs ?? DEMO_SPINUP_MS * 2
const DEMO_PLAYBACK_RATE = montageConfig.demo?.reelPlaybackRate ?? 3
// reel 국면 형태: 'rotate'=Gemini 파노라마 이미지를 천천히 회전(바퀴당 secPerTurn, 한 바퀴마다 다음 이미지 크로스페이드)
//                'video'=사전 합성 reel.mp4를 배속 재생. 기본 rotate.
const DEMO_REEL_MODE = montageConfig.demo?.reelMode ?? 'rotate'
const DEMO_ROTATE_SEC = montageConfig.demo?.rotateSecPerTurn ?? 24
const DEMO_ROTATE_XFADE = montageConfig.demo?.rotateCrossfadeSec ?? 1.5
// reel 회전 전환은 클라이언트 'reel-done'(한 바퀴 완료)이 주도한다. 이건 클라이언트 무응답(죽음·헤드리스)
// 대비 안전 폴백까지의 무-heartbeat 허용시간(ms). 정상 클라이언트는 도는 동안 계속 heartbeat하므로,
// Q로 느리게 해도 끊기지 않는다(느린 쪽 보장).
const REEL_DEADMAN_MS = montageConfig.demo?.reelDeadmanMs ?? 10000

// 회전 모드가 순회할 이미지 = 재생목록 인덱스. 탄생~현재 나이(birthToCurrentOnly) + 나잇대별 1장(onePerStage).
function reelImageIndices() {
  const all = library?.images || []
  if (!all.length) return []
  const currentYear = new Date().getFullYear()
  const birthToCurrent = montageConfig.reel?.birthToCurrentOnly !== false
  const onePerStage = montageConfig.reel?.onePerStage !== false
  const idxs = []
  const seenAge = new Set()
  all.forEach((im, i) => {
    if (birthToCurrent && (im.year ?? 9999) > currentYear) return
    if (onePerStage) {
      if (seenAge.has(im.age)) return // 나잇대별 첫 장면만(재생목록은 나이·장면 순서)
      seenAge.add(im.age)
    }
    idxs.push(i)
  })
  // 1차 플로우 주마등은 역순 — 현 시점(현재 나이)부터 탄생까지 거슬러 올라간다(2026-07-30).
  // 선별(탄생~현재·나잇대별 1장)은 기존 순방향 규칙 그대로 하고, 최종 재생 순서만 뒤집는다.
  return idxs.reverse()
}

let demo = { phase: 'idle', startedAt: Date.now() } // { phase, startedAt, spinupMs?, url? }
let demoTimers = []
let reelDeadman = null // reel 회전 안전 폴백 타이머(heartbeat로 리셋). null = 미가동.
let currentReelSec = 0 // 현재 페르소나 reel.mp4 길이(초) — manifest.reel.durationSec

function clearDemoTimers() {
  for (const t of demoTimers) clearTimeout(t)
  demoTimers = []
  if (reelDeadman) {
    clearTimeout(reelDeadman)
    reelDeadman = null
  }
}

// reel 회전 안전 폴백(deadman). 클라이언트가 도는 동안 /api/reel-progress heartbeat를 보낼 때마다 리셋한다.
// 무응답이 REEL_DEADMAN_MS 지속되면(클라이언트 죽음·헤드리스) 유령으로 폴백. 정상 클라이언트는 회전이
// 느려도(Q) 계속 heartbeat하므로 끊기지 않고, 한 바퀴를 다 돌면 reel-done으로 전환한다(느린 쪽 보장).
function armReelDeadman() {
  if (reelDeadman) clearTimeout(reelDeadman)
  reelDeadman = setTimeout(() => {
    reelDeadman = null
    console.warn('[server] reel: 클라이언트 무응답 — 안전 폴백으로 유령 전환')
    enterGhostPhase()
  }, REEL_DEADMAN_MS)
}

function reelMediaUrl() {
  if (!library?.dir) return null
  const p = path.join(library.dir, 'reel.mp4')
  return existsSync(p) ? toMediaUrl(p) : null
}

// ── 장례식 국면(2026-08-03) ───────────────────────────────────────────────────
// 1차 흐름은 주마등보다 **장례식 영상이 먼저** 온다: 실타래 배속(spinup) → 자신의 장례식장
// 파노라마 영상(고인 시선) → TV가 꺼지듯 암전 → 그 암전에서 주마등이 현 시점부터 탄생까지
// 역순으로 돌기 시작한다. 죽음을 먼저 보고, 그 다음에 삶이 되감기는 순서다.
//
// 어느 장례식을 트는가: 기본은 'present'(지금 죽은 장례식) — 뒤따르는 주마등이 탄생~현 시점이라
// 시간대가 맞는다. 미래(90세) 판을 쓰려면 montage.json demo.funeralVariant를 'future'로 둔다.
// TV 암전 연출 자체는 클라이언트가 그린다(여기선 길이만 넘긴다).
const DEMO_FUNERAL_ENABLED = montageConfig.demo?.funeral !== false
const DEMO_FUNERAL_VARIANT = montageConfig.demo?.funeralVariant === 'future' ? 'future' : 'present'
const DEMO_FUNERAL_BLACKOUT_MS = montageConfig.demo?.funeralBlackoutMs ?? 1600
// 장례식 장면에 머무는 시간(ms). Wan 클립은 ~5초라 클라이언트가 이 시간까지 loop로 돌린다
// (정확히는 이 값에 가장 가까운 정수 바퀴에서 끝낸다 — 이음매에서 끊기지 않게).
const DEMO_FUNERAL_SCENE_MS = montageConfig.demo?.funeralSceneMs ?? 15000
// 클라이언트 'funeral-done'이 정상 전환 트리거고, 이건 무응답·로드 실패 대비 상한(안전 폴백).
const DEMO_FUNERAL_MAX_MS = montageConfig.demo?.funeralMaxMs ?? 60000

// ── 장지(안식처) 국면(2026-08-04) — 1차 전용 ─────────────────────────────────
// 장례식과 장지는 다르다: 장례식(식장) 다음에, 실제로 묻힌 곳(묘비석 파노라마) 영상을 보여준다.
// 순서: 장례식 → 장지 → 암전 → 주마등(reel). 2차(branched)는 장례식에서 바로 주마등으로 간다.
// 영상이 없으면(승인·영상화 전) 건너뛴다 — 전시가 멈추지 않는 게 우선이다.
const DEMO_GRAVE_ENABLED = montageConfig.demo?.grave !== false
const DEMO_GRAVE_BLACKOUT_MS = montageConfig.demo?.graveBlackoutMs ?? DEMO_FUNERAL_BLACKOUT_MS
const DEMO_GRAVE_SCENE_MS = montageConfig.demo?.graveSceneMs ?? DEMO_FUNERAL_SCENE_MS
const DEMO_GRAVE_MAX_MS = montageConfig.demo?.graveMaxMs ?? DEMO_FUNERAL_MAX_MS

// 로컬 라이브러리에서 이 판(variant)의 장지 영상 URL. 승인·영상화가 끝난 것만 존재한다.
function graveMediaUrl(variant = 'present') {
  if (!library?.dir) return null
  try {
    const mf = JSON.parse(readFileSync(path.join(library.dir, 'manifest.json'), 'utf8'))
    const g = variant === 'branched' ? mf.graveBranched : mf.grave
    if (!g?.video?.file) return null
    const abs = path.join(library.dir, g.video.file)
    if (!existsSync(abs)) return null
    const pp = pingpongPathFor(abs) // 변환본이 있으면 그걸 — 클라이언트가 네이티브 loop로 왕복
    return toMediaUrl(existsSync(pp) ? pp : abs)
  } catch {
    return null
  }
}

// 로컬 라이브러리에서 이 판(variant)의 장례식 영상 URL. 승인·영상화가 끝난 것만 존재한다.
function funeralMediaUrl(variant = DEMO_FUNERAL_VARIANT) {
  if (!library?.dir) return null
  try {
    const mf = JSON.parse(readFileSync(path.join(library.dir, 'manifest.json'), 'utf8'))
    const f =
      variant === 'branched'
        ? mf.funeralBranched
        : variant === 'future'
          ? mf.funeralFuture
          : mf.funeral
    if (!f?.video?.file) return null
    const abs = path.join(library.dir, f.video.file)
    if (!existsSync(abs)) return null
    const pp = pingpongPathFor(abs) // 변환본이 있으면 그걸 — 클라이언트가 네이티브 loop로 왕복
    return toMediaUrl(existsSync(pp) ? pp : abs)
  } catch {
    return null
  }
}

// 라이브 방송·부트스트랩 공용 payload. elapsedMs로 재개 위치를 계산한다.
function demoPayload() {
  // experience: 클라이언트 연출 분기용(예: 배경음 — 1차=수중, 2차(분기 미래)=우주 백색소음).
  const p = {
    phase: demo.phase,
    elapsedMs: Date.now() - demo.startedAt,
    experience: currentExperience
  }
  if (demo.phase === 'spinup') p.spinupMs = demo.spinupMs
  if (demo.phase === 'funeral') {
    p.url = demo.url
    p.variant = demo.variant
    p.blackoutMs = DEMO_FUNERAL_BLACKOUT_MS // TV가 꺼지듯 접히는 암전 길이(클라이언트 연출)
    p.sceneMs = DEMO_FUNERAL_SCENE_MS //       장례식 장면에 머무는 시간(클립보다 길면 loop)
    // 1차 플로우: 장례식과 함께 에이전트 내레이션(고정 머리+조문객 멘트) — 클라이언트가 5초 정적 뒤
    // TTS로 재생하고, 내레이션이 끝날 때까지 장면을 붙든다(playFuneralOnce holdUntil).
    if (currentExperience !== 'second') {
      p.narration = funeralNarrationText || FUNERAL_NARRATION
      p.narrationDelayMs = FUNERAL_NARRATION_DELAY_MS
      // 문장 단위 개별 합성(2026-08-06)이라 문장 사이 정적을 클라이언트가 심어야 한다 —
      // 없으면 문장이 붙어 나와 다급하게 들린다. 엄숙한 페이싱으로 넉넉히.
      p.narrationGapMs = (montageConfig.demo?.funeralNarrationGapSec ?? 1.5) * 1000
    }
  }
  if (demo.phase === 'grave') {
    p.url = demo.url
    p.blackoutMs = DEMO_GRAVE_BLACKOUT_MS
    p.sceneMs = DEMO_GRAVE_SCENE_MS
  }
  if (demo.phase === 'reel') {
    // 릴과 동시에 흐르는 큐레이션 멘트 — 1차=삶 회고("~ 삶을 살았구나"), 2차 체험=분기 미래
    // 큐레이션("이 시간선에서 넌 ○○를 하고, ○○해"; 클라이언트는 지지직 분기 뒤에 시작한다).
    // 준비 전(생성 중)이면 조용히 생략 — 릴은 loadPersona 프리워밍보다 한참 뒤라 보통 준비돼 있다.
    // 문장 사이 정적은 <break> 태그가 아니라 클라이언트 스케줄로 — 통짜 합성이 낭독조로 톤을
    // 틀어버려서(2026-08-06), 문장별 개별 TTS + 이 간격으로 멘트를 릴 전반에 퍼뜨린다.
    const reelNarr = currentExperience === 'second' ? branchRecapText : reelRecapText
    if (reelNarr) {
      p.narration = reelNarr
      p.narrationGapMs = (montageConfig.demo?.reelNarrationGapSec ?? 3) * 1000
    }
    if (demo.mode === 'filmstrip') {
      p.mode = 'filmstrip'
      p.photos = demo.photos // [{ id, age, url }] — 클라이언트가 이어 붙여 스트립 텍스처 합성
      if (demo.forkFrom) p.forkFrom = demo.forkFrom // 2차 체험: 지지직 분기 전에 잠시 흐를 1차 미래 릴
      p.secPerTurn = DEMO_ROTATE_SEC
      p.gutterFrac = montageConfig.demo?.filmstripGutterFrac ?? 0.05
      // 1차 주마등(순방향: 탄생→현재, 2026-08-06)의 끝 연출 — 마지막 장(현 시점)이 정면 중앙에 오면
      // holdLastSec초 멈춘 뒤, 남은 릴이 다 돌 때까지 blank(검정). 미래 릴(대화 소유 스트립)에는 보내지 않는다.
      p.holdLastSec = montageConfig.demo?.birthHoldSec ?? 5
    } else if (demo.mode === 'rotate') {
      p.mode = 'rotate'
      p.indices = demo.indices
      p.secPerTurn = DEMO_ROTATE_SEC
      p.crossfadeSec = DEMO_ROTATE_XFADE
    } else {
      p.url = demo.url
      p.playbackRate = DEMO_PLAYBACK_RATE
    }
  }
  return p
}

function runReelDemo(spinupMs) {
  // 1차 개막만 연장된 spinup(돔 6왕복 안무와 세트) — 2차는 기존 길이.
  if (!Number.isFinite(spinupMs))
    spinupMs = currentExperience === 'second' ? DEMO_SPINUP_MS : DEMO_SPINUP_FIRST_MS
  clearDemoTimers()
  demo = { phase: 'spinup', startedAt: Date.now(), spinupMs }
  broadcast(Channels.REEL_DEMO, demoPayload())
  console.log(`[server] 데모: spinup ${spinupMs}ms`)
  demoTimers.push(setTimeout(startFuneralPhase, spinupMs))
}

// 장례식 영상 국면 — 주마등보다 먼저 온다. 영상이 끝나면 클라이언트가 TV 꺼지는 암전을 연출한 뒤
// /api/funeral-done을 보내고, 그 신호로 주마등(startReelPhase)이 시작된다. 영상이 없거나
// (승인·영상화 전) 꺼져 있으면 곧장 주마등으로 넘어간다 — 전시가 멈추지 않는 게 우선이다.
function startFuneralPhase() {
  if (!DEMO_FUNERAL_ENABLED) return startReelPhase()
  // 2차 체험은 분기 미래의 죽음(90세, branched 장례식). 아직 영상이 없으면 1차 장례식으로 폴백.
  let variant = currentExperience === 'second' ? 'branched' : DEMO_FUNERAL_VARIANT
  let url = funeralMediaUrl(variant)
  if (!url && variant === 'branched') {
    console.warn('[server] 데모: 분기 장례식 영상 없음 — 1차 장례식으로 폴백')
    variant = DEMO_FUNERAL_VARIANT
    url = funeralMediaUrl(variant)
  }
  if (!url) {
    console.warn('[server] 데모: 장례식 영상 없음 — 주마등으로 바로 진행(admin에서 영상화 필요)')
    return startReelPhase()
  }
  demo = { phase: 'funeral', startedAt: Date.now(), url, variant }
  broadcast(Channels.REEL_DEMO, demoPayload())
  console.log(`[server] 데모: 장례식 영상 (${variant}) — 종료 시 암전 후 주마등`)
  // 클라이언트 무응답(죽음·헤드리스·로드 실패) 대비 상한.
  demoTimers.push(
    setTimeout(() => {
      if (demo.phase !== 'funeral') return
      console.warn('[server] 장례식: 클라이언트 무응답 — 상한 도달, 다음 국면으로 진행')
      startGravePhase()
    }, DEMO_FUNERAL_MAX_MS)
  )
}

// 장지 국면 — 장례식 다음. 클라이언트가 영상 재생 후 암전을 연출하고 /api/grave-done을 보내면
// 주마등(startReelPhase)으로 넘어간다. 1차=manifest.grave, 2차 체험=분기 장지(graveBranched —
// 분기 연대기 기반, 1차와 다른 안식처). 영상이 없으면 그 판만 건너뛴다.
function startGravePhase() {
  clearDemoTimers() // 장례식 국면의 안전 폴백 타이머 정리
  if (!DEMO_GRAVE_ENABLED) return startReelPhase()
  const variant = currentExperience === 'second' ? 'branched' : 'present'
  const url = graveMediaUrl(variant)
  if (!url) {
    console.warn(
      `[server] 데모: ${variant === 'branched' ? '분기 ' : ''}장지 영상 없음 — 주마등으로 바로 진행(admin에서 영상화 필요)`
    )
    return startReelPhase()
  }
  demo = { phase: 'grave', startedAt: Date.now(), url }
  broadcast(Channels.REEL_DEMO, demoPayload())
  console.log('[server] 데모: 장지 영상 — 종료 시 암전 후 주마등')
  demoTimers.push(
    setTimeout(() => {
      if (demo.phase !== 'grave') return
      console.warn('[server] 장지: 클라이언트 무응답 — 상한 도달, 주마등으로 진행')
      startReelPhase()
    }, DEMO_GRAVE_MAX_MS)
  )
}

function startReelPhase() {
  clearDemoTimers() // 장례식·장지 국면의 안전 폴백 타이머 정리(정상 흐름은 done 신호로 여기 온다)
  // 필름스트립 모드(신규 기본): reel 전용 3:4 사진(파노라마와 별개 플로우)이 있으면 그 사진들을
  // 필름처럼 이어 붙여 연속 회전한다. 전환은 클라이언트 'reel-done'(스트립 1사이클 완료)이 주도하고,
  // deadman·heartbeat는 rotate와 동일하게 재사용한다. 사진이 없는 기존 페르소나는 rotate 폴백.
  // 2차 체험은 분기 미래 릴(현재→90세 순방향). 아직 생성 전이면 1차 릴로 폴백해 전시는 계속된다.
  const secondReel = currentExperience === 'second'
  if (secondReel && !reelBranchedPlaylist.length)
    console.warn('[server] 데모: 분기 릴 없음 — 1차 릴로 폴백(admin에서 분기 미래 생성 필요)')
  const photos =
    secondReel && reelBranchedPlaylist.length ? reelBranchedPlaylist : reelPhotoPlaylist
  if (DEMO_REEL_MODE === 'rotate' && photos.length > 0) {
    // 2차 체험 릴 분기(지지직) 재료: 1차의 미래 릴이 있으면 함께 보내 클라이언트가
    // "기존 미래 릴 → 명멸 → 분기 릴"로 갈아끼우게 한다(둘 다 있을 때만).
    const forkFrom =
      secondReel && reelBranchedPlaylist.length && reelFuturePlaylist.length
        ? reelFuturePlaylist
        : undefined
    demo = { phase: 'reel', mode: 'filmstrip', startedAt: Date.now(), photos, forkFrom }
    broadcast(Channels.REEL_DEMO, demoPayload())
    console.log(
      `[server] 데모: reel 필름스트립 (${photos.length}장${secondReel && reelBranchedPlaylist.length ? ' · 분기 미래' : ''} — 전환은 클라이언트 스트립 1사이클 완료 시, Q/W 속도 따라감)`
    )
    armReelDeadman()
    return
  }
  // 회전 모드: Gemini 파노라마 이미지들을 천천히 회전시키며 순회. reel.mp4 불필요.
  if (DEMO_REEL_MODE === 'rotate') {
    const indices = reelImageIndices()
    if (indices.length === 0) {
      console.warn('[server] 데모: 회전할 이미지 없음 — 유령 idle로 건너뜀')
      enterGhostPhase()
      return
    }
    demo = { phase: 'reel', mode: 'rotate', startedAt: Date.now(), indices }
    broadcast(Channels.REEL_DEMO, demoPayload())
    const totalSec = indices.length * DEMO_ROTATE_SEC
    console.log(
      `[server] 데모: reel 회전 (${indices.length}장, 기본 ${totalSec}s — 전환은 클라이언트 한 바퀴 완료 시, Q/W 속도 따라감)`
    )
    armReelDeadman() // 전환 트리거 = 클라이언트 reel-done(한 바퀴). 이건 무응답 대비 안전 폴백.
    return
  }
  // 영상 모드: 사전 합성 reel.mp4 배속 재생.
  const url = reelMediaUrl()
  if (!url) {
    console.warn('[server] 데모: reel.mp4 없음 — 유령 idle로 건너뜀(관리자에서 릴 생성 필요)')
    enterGhostPhase()
    return
  }
  const realSec = Math.max(1, (currentReelSec || 90) / DEMO_PLAYBACK_RATE)
  demo = { phase: 'reel', startedAt: Date.now(), url }
  broadcast(Channels.REEL_DEMO, demoPayload())
  console.log(`[server] 데모: reel 재생 (~${realSec.toFixed(0)}s @${DEMO_PLAYBACK_RATE}x)`)
  demoTimers.push(setTimeout(enterGhostPhase, realSec * 1000))
}

function enterGhostPhase() {
  clearDemoTimers()
  resetGhostConversation() // 새 만남 — 브리지 대화 기록 초기화
  demo = { phase: 'ghost', startedAt: Date.now() }
  broadcast(Channels.REEL_DEMO, demoPayload())
  console.log('[server] 데모: 유령 idle (1인칭 진입 대기)')
}

// 세션 나가기(admin 전용 중단) — 데모를 idle로 리셋하고 런타임을 대기 앰비언트로 되돌린다.
function leaveSession() {
  clearDemoTimers()
  resetGhostConversation()
  pendingPersonaId = undefined // 예약돼 있던 교체도 취소.
  demo = { phase: 'idle', startedAt: Date.now() }
  broadcast(Channels.REEL_DEMO, demoPayload())
  console.log('[server] 세션 나가기 — 대기(IDLE)로 복귀')
}

// ── 부트스트랩 페이로드 (Channels.BOOTSTRAP 핸들러 이관) ──────────────
// 단일 페이지가 4타일을 렌더하므로 projectors 배열 전체를 준다.
function bootstrapPayload() {
  return {
    projectors: PROJECTORS,
    install: installConfig,
    // 생성하는 씬 파노라마 비율(4096×1024=4:1). 렌더러가 4타일 가로 정렬 전체 크기를 이 비율에 맞춘다.
    panorama: comfyuiConfig.panorama ?? null,
    devPreview,
    demo: demoPayload(), // 현재 1차 흐름 국면(새로고침 시 이어가기용) + reel 배속 파라미터
    montage: library
      ? {
          config: {
            frameDurationMs: montageConfig.frameDurationMs,
            mapping: montageConfig.mapping,
            fitMode: montageConfig.fitMode,
            edgeFeather: montageConfig.edgeFeather,
            blur: montageConfig.blur,
            reelScale: montageConfig.demo?.reelScale ?? 1, // reel 재생 중 콘텐츠 축소 배율
            filmLook: montageConfig.demo?.filmLook !== false, // 필름 카메라 롤 연출(퍼포레이션·그레인 등)

            calibration // 설치 정렬 오프셋(yaw/pitch) — 셰이더 초기값
          },
          playlist: library.images.map((im) => ({ id: im.id, url: toMediaUrl(im.absPath) })),
          reelPhotos: reelPhotoPlaylist, // reel 전용 3:4 사진 — 필름스트립 재개(새로고침)용
          ...sm.snapshot()
        }
      : null
  }
}

// 미래 자기 모습 영상 카탈로그 — 유령 인터랙션(대화)에서 관람객이 '몇 년 뒤'를 답하면 그 미래 나잇대
// 영상을 원본 속도로 튼다. 현재 나이 초과 장면만, 나잇대별로 묶어 영상 URL(cachedPath→/media)로.
// 나이 계산: birthYear = 임의 장면의 year - age (일관). currentAge = 올해 - birthYear.
function futureCatalog() {
  const imgs = library?.images || []
  const ref = imgs.find((im) => Number.isFinite(im.year) && Number.isFinite(im.age))
  if (!ref || !regenerator) return { currentAge: null, futureStages: [] }
  const currentAge = new Date().getFullYear() - (ref.year - ref.age)
  const byAge = new Map()
  for (const im of imgs) {
    if (im.branch) continue // 3차(분기 미래) 장면은 2차 카탈로그에 섞지 않는다
    if (!(im.age > currentAge)) continue // 현재 나이 이후(미래) 장면만
    const vp = regenerator.cachedPath(im.id)
    if (!vp) continue // 영상 없는 장면은 제외
    if (!byAge.has(im.age)) byAge.set(im.age, [])
    byAge.get(im.age).push({ id: im.id, url: toMediaUrl(vp), scene: im.scene || '' })
  }
  const futureStages = [...byAge.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([age, scenes]) => ({
      age,
      yearsAhead: age - currentAge,
      videos: scenes
        .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
        .map((s) => ({ url: s.url, scene: s.scene })) // scene = 큐레이터 설명용 장면 텍스트
    }))
    .filter((s) => s.videos.length)
  return { currentAge, futureStages }
}

// ── 과거 회귀 대화(1차 플로우) 재료 ───────────────────────────────────
// currentAge 계산은 futureCatalog와 동일: 임의 장면의 (year - age) = 출생연도.
function currentAgeOfLibrary() {
  const imgs = library?.images || []
  const ref = imgs.find((im) => Number.isFinite(im.year) && Number.isFinite(im.age))
  if (!ref) return null
  return new Date().getFullYear() - (ref.year - ref.age)
}

// 순간 카탈로그(과거+미래 통합) — 브리지 대화의 1장(과거 회귀)·2장(미래)이 함께 쓴다.
// 영상 캐시가 있는 장면만. isFuture = 현재 나이 초과(이 사람이 스스로 그린 인생그래프의 미래).
// url은 pingpong 변환본(<id>.pp.mp4)이 준비돼 있으면 그걸, 아니면 원본(plain loop 폴백).
function momentsCatalog({ branch = false } = {}) {
  const imgs = library?.images || []
  const currentAge = currentAgeOfLibrary()
  if (currentAge === null || !regenerator) return { currentAge: null, moments: [] }
  const moments = []
  for (const im of imgs) {
    // branch=false(1차 체험): 운명적 장면만. branch=true(2차 체험/3차 플로우): 분기 장면만 —
    // 분기는 나이당 한 장면이라 "같은 시기의 다른 모습" 선택지가 자연히 사라진다.
    if (!!im.branch !== branch) continue
    const vp = regenerator.cachedPath(im.id)
    if (!vp) continue
    const pp = pingpongPathFor(vp)
    moments.push({
      id: im.id,
      age: im.age,
      year: im.year,
      scene: im.scene || '',
      isFuture: im.age > currentAge,
      url: toMediaUrl(existsSync(pp) ? pp : vp)
    })
  }
  moments.sort((a, b) => a.age - b.age || a.id.localeCompare(b.id, undefined, { numeric: true }))
  return { currentAge, moments }
}

// 장면 클립을 준비한다(과거+미래 전체 — 1장·2장이 함께 쓴다):
// (1) Firebase 정본(generatedVideos)에서 로컬에 없는 클립을 read-through로 확보 →
// (2) pingpong 변환(정방향→역방향 이어붙임 — loop 경계 점프 제거)을 백그라운드로 순차 실행
// (CPU 독점 방지). ffmpeg 없음·다운로드 실패는 조용히 폴백(원본 loop / 그 장면 제외).
// 참가자 교체 시 남은 배치는 폐기.
async function preparePingpongClips() {
  const lib = library
  if (!lib || !regenerator) return
  // Firebase 정본에서 장면 클립 확보 — 전시 명세상 영상은 Firebase에 저장돼 있고 로컬은 캐시다.
  if (firebaseReady) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(lib.dir, 'manifest.json'), 'utf8'))
      const missingIds = lib.images
        .filter((im) => !regenerator.cachedPath(im.id))
        .map((im) => im.id)
      if (missingIds.length) {
        const { missing } = await ensureLocalClipsFromFirebase(manifest.profile, lib.dir, {
          ids: missingIds
        })
        if (library !== lib) return
        const got = missingIds.length - missing.length
        if (got) console.log(`[server] Firebase→로컬 클립 ${got}개 확보`)
        if (missing.length)
          console.warn(`[server] Firebase에 없는 클립 ${missing.length}개: ${missing.join(', ')}`)
      }
    } catch (e) {
      console.warn(`[server] 클립 확보 실패(로컬 캐시만 사용): ${e.message}`)
    }
  }
  let made = 0
  // 장례식·장지 클립도 함께 변환한다 — 재생 문법(sceneMs까지 loop)이 순간 클립과 같아,
  // 변환본이 있으면 funeralMediaUrl/graveMediaUrl이 그걸 서빙하고 클라이언트가 네이티브 loop로 왕복한다.
  const targets = lib.images.map((im) => ({ id: im.id, path: regenerator.cachedPath(im.id) }))
  try {
    const mf = JSON.parse(await fs.readFile(path.join(lib.dir, 'manifest.json'), 'utf8'))
    for (const key of ['funeral', 'funeralFuture', 'funeralBranched', 'grave', 'graveBranched']) {
      const file = mf[key]?.video?.file
      if (file) targets.push({ id: key, path: path.join(lib.dir, file) })
    }
  } catch {
    /* manifest 없음 — 순간 클립만 변환 */
  }
  for (const t of targets) {
    if (library !== lib) return // 참가자 교체 — 이 배치는 폐기
    const vp = t.path
    if (!vp || !existsSync(vp) || existsSync(pingpongPathFor(vp))) continue
    try {
      await ensurePingpongClip(vp)
      made++
    } catch (e) {
      console.warn(`[server] pingpong 변환 실패(원본 loop 폴백): ${t.id} — ${e.message}`)
      if (/실행 불가/.test(String(e.message))) return // ffmpeg 자체가 없다 — 나머지도 전부 실패한다
    }
  }
  if (made) console.log(`[server] pingpong 클립 ${made}개 준비 완료`)
}

// 삶 회고 — 주마등 릴과 동시에 흐르는 큐레이션 멘트("너는 ○○하고 ○○했던, ~ 삶을 살았구나").
// (2026-08-06: 유령 국면 첫 발화에서 릴 국면으로 이동 — 유령 개막은 RECAP_TAIL 질문만 남는다.)
// §1 긴장 완화(CLAUDE.md §12에 따라 명시): 사건 재료는 관람객이 cdb-crafter에 직접 쓴 글의
// 사실 범위 안으로 제한하되, 표현은 유령이 자기 말투(따뜻하고 담담한 온기)로 다시 빚는다 — 그대로
// 낭독하면 입력을 읽어주는 느낌이 나서 가공을 허용했다. 삶 전체의 의미 규정·훈계는 여전히 금지.
// Gemini·Firestore가 없으면 고정 폴백 문장.
const RECAP_TAIL =
  '지금의 너는, 이미 죽었지만… 만약 너의 살아온 과거의 한 순간을 볼 수 있다면, 언제로 돌아가고 싶어? 말해봐. 내가 그때로 데려다줄게.'
// 장례식 국면(1차)에서 에이전트가 건네는 고정 내레이션 머리 — 2초 정적은 <break>로.
// 뒤에 조문객 멘트("○○도 왔고, ○○도 왔네…", composeFuneralNarration)가 이어 붙는다.
// "맞아"는 대본에서 뺐다(2026-08-14) — TTS(flash v2.5)가 받침 연음을 뭉개 [마야]로 들린다.
const FUNERAL_NARRATION =
  '잘 보이니? 너를 그리워하는 사람들이 이곳에 모였어. <break time="2s" /> 여긴 너의 장례식이야.'
const FUNERAL_NARRATION_DELAY_MS = 5000 // 장례식 장면이 뜨고 이만큼 정적 뒤에 첫 마디
const recapPromises = new Map() // personaId → Promise<string> (세션 재발급 대비 캐시)

function recapFallback() {
  const age = currentAgeOfLibrary()
  return Number.isFinite(age)
    ? `넌 아직 ${age}살이지만, 짧다면 짧고 길다면 긴 삶을 살았구나.`
    : '넌 짧다면 짧고 길다면 긴 삶을 여기까지 살아왔구나.'
}

let geminiText = null // 회고 생성용 GeminiClient(지연 초기화)
async function getGeminiText() {
  if (geminiText) return geminiText
  const g = comfyuiConfig.gemini || {}
  const apiKey = await resolveGeminiApiKey({
    apiKey: g.apiKey,
    apiKeyPath: g.apiKeyPath ? path.resolve(root, g.apiKeyPath) : undefined
  })
  geminiText = new GeminiClient({ apiKey, textModel: g.textModel, timeoutMs: 60000 })
  return geminiText
}

// 관람객이 인생그래프에 직접 쓴 과거~현재 단계 문장들을 모은다(미래 future-* 단계는 회고에서 제외
// — 회고는 살아온 삶만 되짚는다). 과거~현재 점은 세션이 바뀌어도 같은 값이 다시 담기므로
// first→third 순으로 처음 만난 텍스트를 쓴다.
function collectPastStageTexts(profileDoc) {
  // 점 스키마(단계 키/나이 키/점 배열)의 차이는 전부 resolveAgePoint가 흡수한다 — 여기서는
  // 격자 나이를 돌며 과거 점의 글만 모은다. 같은 점(key)이 여러 격자 나이에 걸치면 한 번만.
  const out = []
  const seen = new Set()
  for (const age of AGES) {
    for (const key of ['first', 'second', 'third']) {
      const r = resolveAgePoint(age, profileDoc?.[key] || {}, profileDoc)
      if (!r || r.isFuture) continue
      const t = r.point?.text?.trim()
      if (!t) continue
      const dedupeKey = `${key}:${r.key}`
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey)
        out.push({ label: `${r.point?.age ?? age}세 무렵`, text: t })
      }
      break // 이 나이는 처음 만난 세션의 글을 쓴다(first→third 순)
    }
  }
  return out
}

// 인생그래프 점에 적힌 동반자(companion)들 — 장례식 조문객 멘트의 재료. 과거~현재 점만.
function collectCompanions(profileDoc) {
  const out = []
  const seen = new Set()
  for (const age of AGES) {
    for (const key of ['first', 'second', 'third']) {
      const r = resolveAgePoint(age, profileDoc?.[key] || {}, profileDoc)
      if (!r || r.isFuture) continue
      const c = String(r.point?.companion ?? '').trim()
      if (c && !seen.has(c)) {
        seen.add(c)
        out.push(c)
      }
      break
    }
  }
  return out
}

// 이 사람이 "힘들었다"고 남긴 기록 두 갈래(2026-08-10) — 2장 미래 릴 큐레이션의 "딱 하나의
// 어긋남"이 이 주제와 개연성 있게 이어지게 하는 재료.
//  worst    — selections.worst: 본인이 "인생에서 가장 힘들었던 순간"으로 직접 고른 점 + 이유(가장 명시적).
//  lowPoints — 인생그래프에서 x값(그래프 높이)이 낮게 찍힌 과거 점들(암묵적 저점).
function collectLowPoints(profileDoc, count = 3) {
  const out = []
  const seen = new Set()
  for (const age of AGES) {
    for (const key of ['first', 'second', 'third']) {
      const r = resolveAgePoint(age, profileDoc?.[key] || {}, profileDoc)
      if (!r || r.isFuture) continue
      const x = Number(r.point?.x)
      const t = r.point?.text?.trim()
      if (!Number.isFinite(x) || !t) continue
      const dedupeKey = `${key}:${r.key}`
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey)
        out.push({ age: r.point?.age ?? age, x, text: t })
      }
      break
    }
  }
  return out.sort((a, b) => a.x - b.x).slice(0, count)
}

function collectWorstSelection(profileDoc) {
  for (const key of ['first', 'second', 'third']) {
    const sp = profileDoc?.[key]
    const sel = sp?.selections?.worst
    if (!sel?.stageId) continue
    const raw = sp[sel.stageId]
    const point = Array.isArray(raw) ? raw[sel.index ?? 0] : raw
    const stageAge = /^age-(\d+)$/.exec(String(sel.stageId))?.[1]
    const age = Number.isFinite(Number(point?.age))
      ? Math.round(Number(point.age))
      : stageAge
        ? Number(stageAge)
        : null
    const text = composePointText(point || {})
    const reason = sel.reason?.trim() || ''
    if (age != null && (text || reason)) return { age, text, reason }
  }
  return null
}

// 장례식 내레이션 전문 — 고정 머리(FUNERAL_NARRATION) 뒤에 조문객을 짚는 멘트
// ("○○도 왔고, ○○도 왔네…")를 Gemini로 지어 붙인다. 재료가 없거나 실패하면 머리만.
async function composeFuneralNarration(personaId) {
  // companion 필드는 점 배열 스키마(2026-08-04~)에만 있다. 구 스키마(단계 키·나이 키) 참가자는
  // 본인이 쓴 글(text)에 등장하는 인물에서 조문객을 뽑는다 — 그래서 글도 함께 재료로 준다.
  let companions = []
  let entries = []
  if (firebaseReady && personaId) {
    try {
      const doc = await fetchProfileDoc(personaId)
      companions = collectCompanions(doc)
      entries = collectPastStageTexts(doc)
    } catch (e) {
      console.warn(`[server] 조문객 재료(프로필 문서) 조회 실패: ${e.message}`)
    }
  }
  if (!companions.length && !entries.length) {
    console.log('[server] 장례식 조문객 멘트: 재료 없음 — 고정 머리말만 나간다')
    return FUNERAL_NARRATION
  }
  console.log(
    `[server] 장례식 조문객 멘트 준비 — 동반자 ${companions.length}명, 본인 글 ${entries.length}건`
  )
  const material =
    (companions.length
      ? `### 함께한 사람들(동반자 기록)\n${companions.map((c) => `- ${c}`).join('\n')}\n\n`
      : '') +
    (entries.length
      ? `### 본인이 쓴 글(여기 등장하는 사람도 조문객 후보다)\n${entries
          .map((e) => `- ${e.label}: "${e.text}"`)
          .join('\n')}`
      : '')
  const prompt =
    `아래는 한 사람이 인생그래프에 남긴, 삶의 각 시기를 함께한 사람들의 기록과 본인이 쓴 글이다. ` +
    `이 사람의 장례식장을 함께 내려다보며 조문객들을 하나씩 짚어 주는 한국어 반말 멘트 한두 문장을 만들어라 — ` +
    `"○○도 왔고, ○○도 왔네." 같은 결.\n\n` +
    `말투: 삶과 죽음의 문턱에서 오래 지켜본 존재의 목소리. 담담하고 낮게.\n\n` +
    `제약(반드시 지킬 것):\n` +
    `- 아래 재료에 실제로 등장하는 사람(이름·호칭·관계)만 쓴다 — '혼자' 같은 비인물 표현은 건너뛴다. 두세 명이면 충분하다.\n` +
    `- 이름은 성을 뗀 이름만 친근하게 부른다 — "민지현도 왔네"가 아니라 "지현이도 왔네". 호칭·관계(고모, 엄마 등)는 그대로 쓴다.\n` +
    `- 없는 인물을 지어내지 않는다. 슬픔을 과장하거나 판정하지 않는다 — 사실로만.\n` +
    `- 낮은 입말 1~2문장. 질문 금지. 답은 그 문장만(다른 설명 없이).\n` +
    `- 재료에 사람이 전혀 등장하지 않으면 문장을 지어내지 말고 "NONE"이라고만 답한다.\n\n` +
    material
  try {
    const gclient = await getGeminiText()
    const raw = String(await gclient.generateText({ prompt })).trim()
    if (raw.length < 5 || /^NONE\b/i.test(raw)) {
      console.log('[server] 장례식 조문객 멘트: 재료에 인물 없음 — 고정 머리말만 나간다')
      return FUNERAL_NARRATION
    }
    console.log(`[server] 장례식 조문객 멘트: ${raw}`)
    return `${FUNERAL_NARRATION} <break time="3s" /> ${raw}`
  } catch (e) {
    console.warn(`[server] 조문객 멘트 생성 실패(고정문만 사용): ${e.message}`)
    return FUNERAL_NARRATION
  }
}

async function composeRecapFirstMessage(personaId) {
  const age = currentAgeOfLibrary()
  let entries = []
  if (firebaseReady && personaId) {
    try {
      entries = collectPastStageTexts(await fetchProfileDoc(personaId))
    } catch (e) {
      console.warn(`[server] 회고 재료(프로필 문서) 조회 실패: ${e.message}`)
    }
  }
  if (!entries.length) return recapFallback()
  const material = entries.map((e) => `- ${e.label}: "${e.text}"`).join('\n')
  const prompt =
    `아래는 한 사람이 자기 삶의 각 시기를 스스로 짧게 적은 글이다. 이 사람의 주마등(탄생부터 지금까지의 기억들)이 ` +
    `눈앞에 흐르는 동안 곁에서 들려줄 한국어 반말 회고 한 단락을 만들어라 — 그 삶을 오래 지켜본 존재가 ` +
    `"너는 ○○하고, ○○했지" 하고 훑다가 "…삶을 살았구나"로 맺는 말.\n\n` +
    `말투: 삶과 죽음의 문턱에서 오래 지켜본 존재의 목소리. 따뜻하고 담담하다 — ` +
    `"넌 아직 ${Number.isFinite(age) ? age : 'N'}살이지만, 짧다면 짧고 길다면 긴 삶을 살았구나." 같은 결. ` +
    `냉소·빈정거림·비꼼은 절대 쓰지 않는다 — "기어이", "결국 ~했네", "~하더니" 같은 말투 금지. ` +
    `애정 어린 담담함으로만 말한다.\n\n` +
    `가공: 아래 글을 그대로 낭독하거나 나열하지 마라. 사건들을 소화해서 네 말로 다시 빚어라 — ` +
    `두세 개를 골라 묶고, 잇고, 넌지시 짚는다("○○하던 네가, ○○까지 왔지" 같은 다정한 결). ` +
    `단, 재료는 아래 글에 있는 사실만 쓴다 — 없는 사건을 지어내거나, 이 사람이 말하지 않은 감정을 단정하지 않는다.\n\n` +
    `마지막 문장은 반드시 "삶을 살았구나."로 끝난다(예: "…그렇게 부지런히 사랑하는 삶을 살았구나.").\n\n` +
    `제약(반드시 지킬 것):\n` +
    `- 이 사람의 삶 전체가 무슨 의미였는지 결론짓지 않는다. 조롱·훈계·냉소는 금지 — 온기만 남긴다.\n` +
    `- 충고·교훈·위로의 결론을 붙이지 않는다.\n` +
    `- 주마등이 탄생부터 지금 순서로 흐르니, 너도 어린 시절부터 지금까지 시간 순서로 훑는다.\n` +
    `- 낮은 입말로 6~8문장(릴이 1분 남짓 흐르는 동안 문장 사이에 긴 쉼을 두고 이어진다 — 짧은 문장들로). ` +
    `질문은 던지지 않는다. 목록·격식체 금지. 답은 그 단락 하나만(다른 설명 없이).\n\n` +
    material
  try {
    const gclient = await getGeminiText()
    const raw = String(await gclient.generateText({ prompt })).trim()
    return raw.length >= 20 ? raw : recapFallback()
  } catch (e) {
    console.warn(`[server] 회고 생성 실패(폴백 사용): ${e.message}`)
    return recapFallback()
  }
}

// 완성된 큐레이션 멘트를 Firestore lifeCuration 컬렉션에 남긴다(best-effort, 재생은 막지 않는다).
// variant: 'past'=1차 과거 회귀 릴 | 'future'=2차 부정미래 릴 | 'branched'=3차 분기미래 릴.
function persistLifeCuration(personaId, variant, text, fallback = false) {
  if (!firebaseReady || !currentProfile || !text) return
  upsertLifeCuration({
    profile: currentProfile,
    personaId,
    variant,
    text,
    sentences: narrationChunks(text),
    fallback
  })
    .then(({ key, branch }) =>
      console.log(`[server] 릴 큐레이션 멘트 저장 — lifeCuration/${key}.${branch}`)
    )
    .catch((e) => console.warn(`[server] 릴 큐레이션 멘트 저장 실패(${variant}): ${e.message}`))
}

function recapFor(personaId) {
  if (!recapPromises.has(personaId)) {
    const p = composeRecapFirstMessage(personaId).catch(() => recapFallback())
    recapPromises.set(personaId, p)
    p.then((t) => persistLifeCuration(personaId, 'past', t, t === recapFallback()))
  }
  return recapPromises.get(personaId)
}

// 미래 릴 큐레이션 멘트 — 1차 릴의 삶 회고처럼 **릴이 흐르는 동안** 재생된다(2026-08-06 릴 뒤
// 발화에서 릴 중으로 이동). 외삽 연대기(futureNarrativeFor)를 재료 삼아 "너의 삶이 이대로
// 지속된다면, 넌 ○○를 하고, ○○해" 식으로 특별한 사건들을 훑는다. 질문·고정 꼬리 없음 —
// 질문은 릴이 끝난 뒤 유령이 따로 한다(2장=FUTURE_ASK, 3차=montage firstMessage).
// kind 'future' = 2장(1차 내 미래 릴) | 'branched' = 3차 세션(분기 릴).
// 미래는 판정 없이 사실로만(2026-08-05 유령 발화 원칙) — 1장 회고의 시니컬한 유머는 쓰지 않는다.
async function composeFutureRecapMessage(personaId, kind = 'future') {
  const narrative = await futureNarrativeFor(personaId, kind)
  if (!narrative) return null
  // 부정미래(2장)의 "딱 하나의 어긋남"을 본인이 힘들었다고 남긴 기록과 잇는 재료 —
  // worst(직접 고른 최악의 순간+이유)가 가장 명시적이고, 그래프 저점(x 낮은 점)이 보조.
  // 없으면(x·worst 미기록 등) 재료 없이 진행.
  let lowPoints = []
  let worst = null
  if (kind === 'future' && firebaseReady && personaId) {
    try {
      const doc = await fetchProfileDoc(personaId)
      lowPoints = collectLowPoints(doc)
      worst = collectWorstSelection(doc)
      console.log(
        `[server] 미래 큐레이션 저점 재료 — worst ${worst ? `${worst.age}세` : '없음'}, 저점 ${lowPoints.length}개`
      )
    } catch (e) {
      console.warn(`[server] 미래 큐레이션 저점 재료 조회 실패: ${e.message}`)
    }
  }
  const lowPointNote =
    worst || lowPoints.length
      ? `### 이 사람이 힘들었다고 남긴 기록 — 본인이 직접 쓴 것\n` +
        (worst
          ? `- [본인이 "인생에서 가장 힘들었던 순간"으로 직접 고른 시기] ${worst.age}세 무렵: "${worst.text}"` +
            (worst.reason ? ` — 고른 이유: "${worst.reason}"` : '') +
            `\n`
          : '') +
        (lowPoints.length
          ? lowPoints
              .map((p) => `- [인생그래프를 낮게 찍은 시기] ${p.age}세 무렵: "${p.text}"`)
              .join('\n') + `\n`
          : '') +
        `\n`
      : ''
  const framing =
    kind === 'branched'
      ? `아래는 한 사람이 지난 만남 이후 마음가짐이 바뀌어 걷게 된, 다른 갈래의 미래를 시기별로 적은 연대기다. ` +
        `그 미래의 장면들이 눈앞에 릴처럼 흐르는 동안 곁에서 들려줄 한국어 반말 한 단락을 만들어라 — ` +
        `그 새로운 시간선을 보고 온 존재가 "이 시간선에서 넌 ○○를 하고, ○○해" 하고 특별한 사건들을 짚어 주는 말. ` +
        `지난번에 본 미래와는 다른 갈래라는 언급으로 시작해도 좋다.\n\n`
      : `아래는 한 사람이 지금처럼 계속 살아간다면 맞이할 미래를 시기별로 적은 연대기다. ` +
        `그 미래의 장면들이 눈앞에 릴처럼 흐르는 동안 곁에서 들려줄 한국어 반말 한 단락을 만들어라 — ` +
        `그 미래를 보고 온 존재가 "너의 삶이 이대로 지속된다면, 넌 ○○를 하고, ○○해" 하고 특별한 사건들을 짚어 주는 말.\n\n`
  const prompt =
    framing +
    `말투: 삶과 죽음의 문턱에서 오래 지켜본 존재가 곁에서 조곤조곤 들려주는 구어체 반말. 담담하고 낮게 — ` +
    `친구에게 말하듯 "-어/-아/-지/-네"로 끝낸다(예: "넌 마흔쯤에 ○○를 시작해.", "쉰아홉엔 ○○에서 전시도 열지."). ` +
    `"-ㄴ다/-는다"로 끝나는 문어체 서술("걷는다", "삶을 마친다")과 예언·선포조는 절대 금지 — ` +
    `경전 낭독처럼 들린다. 눈앞에 보이는 걸 관찰하듯 현재형으로.\n\n` +
    `가공: 아래 연대기를 그대로 낭독하거나 시기별로 나열하지 마라. ` +
    (kind === 'branched'
      ? `그 삶의 굵직하고 특별한 사건 두세 개를 골라, "넌 ○○를 하고, ○○해"처럼 이 사람이 실제로 겪을 구체적 사건으로 말한다 — ` +
        `뭉뚱그린 분위기 묘사가 아니라 사건 위주로. `
      : // 부정미래(2장): 부정 사건을 응축해 나열하면 협박처럼 들린다(2026-08-10 실측 — 간병·사망·요양원이
        // 연달아 나왔다). 배경은 담담한 일상, 어긋남의 흔적은 딱 하나 — 그것도 본인이 낮게 찍은
        // 시기의 주제와 이어져야 개연성이 선다.
        `대부분은 담담하고 중립적인 일상의 사건들("넌 ○○에서 일하고, ○○로 이사해" 같은)을 골라 말하고, ` +
        `계획이 미뤄지거나 이뤄지지 않은 흔적은 **딱 한 가지만** 넌지시 짚는다. ` +
        (lowPointNote
          ? `그 한 가지는 아무 불행이나 고르지 말고, 아래 "힘들었다고 남긴 기록"의 주제(그 시절의 힘듦·후회와 같은 결)와 ` +
            `개연성 있게 이어지는 사건을 연대기에서 골라라 — 특히 본인이 직접 고른 "가장 힘들었던 순간"이 있으면 그 주제를 최우선으로. ` +
            `이 사람이 "그래, 나라면 거기서 또 걸렸겠지" 하고 수긍할 수 있는 어긋남이어야 한다. ` +
            `단, 그 시절 글을 그대로 인용하거나 "너 그때 힘들었잖아"라고 과거를 들추지는 마라 — 미래의 사건으로만 말한다. `
          : '') +
        `죽음·간병·요양원·이별 같은 무거운 사건은 연대기에 있어도 **최대 한 개만** 언급하고 나머지는 건너뛴다 — ` +
        `상실을 쌓아 올리지 마라. `) +
    `릴이 가까운 미래부터 순서로 흐르니 너도 시간 순서로 훑는다. ` +
    `재료는 아래 글에 있는 사실만 쓴다 — 없는 사건을 지어내지 않는다.\n\n` +
    `제약(반드시 지킬 것):\n` +
    `- 이 미래가 좋았는지 나빴는지 판정하지 않는다. 사실로만 말한다 — 빈정거림·조롱·훈계·위로 금지.\n` +
    `- 충고·교훈의 결론을 붙이지 않는다. 삶 전체를 요약·정리하며 맺지 않는다("~하며 삶을 마친다" 같은 문장 금지).\n` +
    `- 낮은 입말로 5~7개의 짧은 문장(문장 사이에 긴 쉼을 두고 릴 위에 얹힌다). 질문은 던지지 않는다. ` +
    `목록·격식체 금지. 답은 그 단락 하나만(다른 설명 없이).\n\n` +
    lowPointNote +
    `### 미래 연대기\n` +
    narrative
  try {
    const gclient = await getGeminiText()
    const raw = String(await gclient.generateText({ prompt })).trim()
    return raw.length >= 20 ? raw : null
  } catch (e) {
    console.warn(`[server] 미래 릴 큐레이션 생성 실패(${kind}, 내레이션 생략): ${e.message}`)
    return null
  }
}

const futureRecapPromises = new Map() // `${personaId}__${kind}` → Promise<string|null>
function futureRecapFor(personaId, kind = 'future') {
  const key = `${personaId}__${kind}`
  if (!futureRecapPromises.has(key)) {
    const p = composeFutureRecapMessage(personaId, kind).catch(() => null)
    futureRecapPromises.set(key, p)
    p.then((t) => t && persistLifeCuration(personaId, kind, t))
    // 폴백(null)으로 끝났으면 캐시하지 않는다 — 프리워밍 시점에 재료(narrative)가
    // 아직 없었어도 다음 호출이 다시 시도하게.
    p.then((t) => {
      if (t == null && futureRecapPromises.get(key) === p) futureRecapPromises.delete(key)
    })
  }
  return futureRecapPromises.get(key)
}

// loadPersona 완료 직후 백그라운드 준비(과거 흐름일 때만). ghost 국면은 릴 종료 뒤라 시간 여유가 있다.
// 회고 문장이 준비되면 그 오디오까지 미리 합성해 둔다(ttsCache) — 유령의 첫 마디가 지연 없이 나온다.
function prepareGhostPastAssets(personaId) {
  const vcfg = montageConfig.ghost?.voice || {}
  const prewarmTts = (vcfg.engine ?? 'bridge') !== 'convai'
  // 내레이션류는 클라이언트가 문장 단위 GET으로 요청하므로 예열도 문장 단위 — 캐시 키가 맞는다.
  const prewarmChunks = (t) =>
    t && narrationChunks(t).forEach((c) => elevenTtsBuffer(c).catch(() => {}))
  // pingpong 변환은 flow와 무관하게 항상 — 2차(future)도 분기 장면·장례식 클립을 재생하는데,
  // 아래 future 조기 return 뒤에 있어 2차에서 변환이 통째로 빠졌었다(2026-08-14).
  void preparePingpongClips()
  // 세션 flow 판정은 ghostSessionPayload와 같은 규칙 — admin이 2차 체험을 지정했으면 config flow가 'past'여도 future.
  if (currentExperience === 'second' || vcfg.flow === 'future') {
    // 2차 체험(flow 'future') — 분기 릴 위 내레이션(큐레이션)을 미리 만들어 둔다(원문 그대로 —
    // 문장 사이 정적은 클라이언트가 narrationGapMs로 스케줄).
    const branchRecap = futureRecapFor(personaId, 'branched')
    branchRecap.then((t) => {
      branchRecapText = t
    })
    if (prewarmTts) branchRecap.then(prewarmChunks).catch(() => {})
    return
  }
  // 릴 국면 큐레이션 멘트(삶 회고) — demoPayload가 동기로 읽도록 완성되면 변수에 담아둔다.
  // 페이싱(<break 3s>)은 심지 않는다 — 문장 사이 정적은 클라이언트가 스케줄(narrationGapMs).
  const recap = recapFor(personaId)
  recap.then((t) => {
    reelRecapText = t
  })
  // 장례식 내레이션(고정 머리+조문객 멘트)도 미리 — demoPayload가 동기로 읽는다.
  const funeralNarr = composeFuneralNarration(personaId).catch(() => FUNERAL_NARRATION)
  funeralNarr.then((t) => {
    funeralNarrationText = t
  })
  // 2장 전환의 미래 릴 위 내레이션(큐레이션)도 지금 만들어 둔다 — 전환은 세션 중반이지만 지연 없이.
  const futureRecap = futureRecapFor(personaId)
  if (prewarmTts) {
    recap.then(prewarmChunks).catch(() => {})
    futureRecap.then(prewarmChunks).catch(() => {}) // 미래 릴 내레이션도 문장 단위 재생
    funeralNarr.then(prewarmChunks).catch(() => {}) // 장례식 내레이션(머리+조문객)
    elevenTtsBuffer(RECAP_TAIL).catch(() => {}) //     유령 개막 질문(고정문)
    elevenTtsBuffer(FUTURE_ASK).catch(() => {}) //     2장 개막 질문(고정문)
  }
}

// ── 유령 음성 대화 세션 (ghost.voice) ────────────────────────────────
// reel 종료 후 'ghost' 국면에서만 브라우저가 호출한다. 두 엔진:
//  bridge(기본) — 브라우저 STT → 서버 Gemini(/api/ghost/turn, 대답+영상 선택 JSON) → ElevenLabs
//                 순수 TTS(/api/ghost/tts). ElevenLabs 대시보드(에이전트·client tool 등록) 불필요.
//  convai       — ElevenLabs Conversational AI(두뇌·도구가 그쪽 서버 설정에 있음). 서명 URL 발급.
// flow('past'=1차 과거 회귀 | 'future'=2차 미래 큐레이션)에 따라 페르소나·첫 발화·카탈로그가 갈린다.
// 미설정·발급 실패면 { enabled:false } — 브라우저는 조용히 유령만 띄운다(§1 침묵).

// ElevenLabs API 키(gitignore된 secrets/) — 서버만 읽는다(bridge=TTS, convai=서명 URL).
async function readElevenKey() {
  const vcfg = montageConfig.ghost?.voice || {}
  try {
    const keyPath = path.resolve(root, vcfg.apiKeyPath || './secrets/elevenlabs-api-key.txt')
    return (await fs.readFile(keyPath, 'utf8')).trim()
  } catch {
    return ''
  }
}

// OpenAI API 키(gitignore된 secrets/) — 서버만 읽는다(Realtime 전사 토큰 발급용).
async function readOpenaiKey() {
  const vcfg = montageConfig.ghost?.voice || {}
  try {
    const keyPath = path.resolve(root, vcfg.stt?.apiKeyPath || './secrets/openai-api-key.txt')
    return (await fs.readFile(keyPath, 'utf8')).trim()
  } catch {
    return ''
  }
}

// OpenAI Realtime "전사 전용" 세션의 ephemeral 토큰 발급. 브라우저는 이 토큰으로만 WS를 열어
// 마이크 오디오를 스트리밍하고 텍스트를 돌려받는다 — 두뇌(Gemini)·목소리(ElevenLabs)는 그대로.
// semantic_vad: 침묵 길이가 아니라 말의 내용으로 발화 종료를 판정 — 회상하며 뜸 들여도 안 자른다.
async function openaiRealtimeToken() {
  const apiKey = await readOpenaiKey()
  if (!apiKey) throw new Error('OpenAI API 키 없음')
  const scfg = montageConfig.ghost?.voice?.stt || {}
  const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expires_after: { anchor: 'created_at', seconds: 600 },
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            // 노이즈 제거 프로파일: far_field=원거리 마이크(억제 강함 — 작은 목소리를 깎을 수 있다),
            // near_field=근접 마이크. 감지가 너무 안 되면 near_field로 바꿔 실측해볼 것.
            noise_reduction: { type: scfg.noiseReduction || 'far_field' },
            transcription: {
              model: scfg.model || 'gpt-4o-transcribe',
              language: scfg.language || 'ko'
            },
            turn_detection: { type: 'semantic_vad', eagerness: scfg.eagerness || 'low' }
          }
        }
      }
    })
  })
  if (!r.ok) throw new Error(`client_secrets ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const j = await r.json()
  if (!j.value) throw new Error('client_secrets 응답에 value 누락')
  return j.value
}

// 흐름별 대화 컨텍스트(페르소나 + 첫 발화 + 카탈로그) 조립 — 세션 발급과 브리지 턴이 공유한다.
//  past  : 1차 방문 전체 경험(1장 과거 회귀 → 2장 미래) — 회고(Firebase 응답 기반 생성, 폴백 有) +
//          과거·미래 통합 장면 카탈로그. 목록은 시스템 프롬프트에 붙여 대화 두뇌가 관람객의
//          발화("고등학교 졸업식")를 장면과 직접 매칭하게 한다. 장 전환은 ghostStageDirective가 지시.
//  future: convai 레거시(고정 firstMessage + 미래 나잇대 카탈로그).
async function buildGhostContext() {
  const vcfg = montageConfig.ghost?.voice || {}
  // 대화 flow는 admin이 지정한 체험 종류를 따른다 — 2차 체험(currentExperience 'second')이면
  // 미래 장(3차 플로우), 아니면 설정값(기본 past). montage.json의 flow는 수동 오버라이드용.
  const flow = currentExperience === 'second' || vcfg.flow === 'future' ? 'future' : 'past'
  const flowCfg = vcfg[flow] || {}

  let systemPrompt = ''
  const promptPath = flowCfg.systemPromptPath || vcfg.systemPromptPath
  if (promptPath) {
    try {
      systemPrompt = (await fs.readFile(path.resolve(root, promptPath), 'utf8')).trim()
      // 질문 목록은 reflective-questions.mjs에서 편집한다 — 프롬프트의 자리표시자에 주입
      systemPrompt = systemPrompt
        .replace(
          '{{PAST_QUESTIONS}}',
          renderQuestions(pastQuestions, 'P', ghostFlow?.usedQuestions || [])
        )
        .replace(
          '{{FUTURE_QUESTIONS}}',
          renderQuestions(futureQuestions, 'F', ghostFlow?.usedQuestions || [])
        )
    } catch {
      console.warn('[server] 유령 음성: 페르소나 파일 없음 — 기본 프롬프트 없이 진행')
    }
  }

  let firstMessage = flowCfg.firstMessage || vcfg.firstMessage
  let past = null
  let future = null
  let catalog = null // 브리지 통합 카탈로그(과거+미래)
  if (flow === 'past') {
    catalog = momentsCatalog()
    past = { currentAge: catalog.currentAge, moments: catalog.moments.filter((m) => !m.isFuture) }
    // 삶 회고는 릴 국면에서 이미 흘렀다(reelRecapText) — 유령 개막은 과거 회귀 질문만(2026-08-06).
    firstMessage = RECAP_TAIL
    if (catalog.moments.length) {
      const line = (m) =>
        `- id ${m.id} · ${m.age}세${m.isFuture ? `(지금으로부터 약 ${m.age - catalog.currentAge}년 뒤)` : ''} · ${m.year}년 · ${m.scene}`
      const pastLines = catalog.moments.filter((m) => !m.isFuture).map(line)
      const futureLines = catalog.moments.filter((m) => m.isFuture).map(line)
      systemPrompt +=
        `\n\n## 보여줄 수 있는 순간들 (장면 카탈로그)\n` +
        `이 사람은 지금 ${catalog.currentAge}세다. 관람객이 말한 순간과 가장 맞는 장면 하나를 골라 그 id로 show를 넣어라. ` +
        `말한 사건이 목록에 사실상 그대로 있으면 exact=true, 정확히 없어서 비슷한 나이·시기의 장면으로 대신 데려가면 exact=false.\n` +
        `중요: 이 사람이 보고 싶은 순간·시기를 한 번이라도 말했다면(예: "고등학교 졸업식", "마흔쯤의 나"), 목록에 똑같은 장면이 없어도 ` +
        `다시 묻지 말고 대신 데려갈 장면을 exact=false로 골라 바로 보여준다. 되묻는 건 순간을 아직 전혀 말하지 않았을 때뿐이다.\n` +
        `대신 데려갈 장면은 말한 순간의 나이를 추정해(예: 고등학교 졸업식≈18~19세) 그 나이와 가장 가까운 나이의 장면 중에서 고른다. ` +
        `연도로 말했으면(예: "2010년") 각 장면 옆의 "○○년" 값과 비교해 그 연도에 가장 가까운 장면을 고른다 — 연도를 나이로 착각하지 마라.\n` +
        `\n### 과거의 순간들 — 1장(과거 회귀)에서만 보여준다\n` +
        (pastLines.join('\n') || '(없음)') +
        `\n\n### 미래의 순간들 — 2장(미래)에서만 보여준다. 이 사람이 아직 살지 않은, 이대로 살아간다면의 모습이다\n` +
        `중요: 미래 장면을 말로 소개할 때 "몇 년 뒤"는 반드시 (장면의 나이 − 지금 나이 ${catalog.currentAge}세)다 — ` +
        `각 장면 옆 괄호의 "약 n년 뒤"를 그대로 쓰면 된다. 나이를 "년 뒤"로 말하는 건 오류다(예: 65세 장면을 "65년 뒤의 너"라고 하면 안 된다 — "약 ${Math.max(1, 65 - (catalog.currentAge || 27))}년 뒤의 너"가 맞다). ` +
        `말로 시간을 짚을 땐 나이("65세의 너")보다 상대적 시간("약 n년 뒤의 너", "${new Date().getFullYear() + 10}년 즘의 너")을 쓴다.\n` +
        (futureLines.join('\n') || '(없음)')
    }
    // 부정미래 연대기 — 장면(카메라에 보이는 것)에는 없는 각 시기의 사정. 유령이 미래 장면을
    // 건넬 때 이 사실들을 낮게 흘려, 이미지를 바꾸지 않고도 대화로 이 미래의 결이 전해지게 한다.
    const narrative = await futureNarrativeFor(library?.personaId)
    if (narrative) {
      systemPrompt +=
        `\n\n## 미래 각 시기의 이면 (연대기 — 너만 아는 배경, 2장에서만)\n` +
        `아래는 위 미래 장면들 뒤에 흐르는 삶의 연대기다(나이별 사건, 영어). 미래 장면을 보여주거나` +
        ` 그 시기 이야기를 나눌 때, 화면에는 없는 이 사정들을 한 번에 한 조각씩 낮고 담담하게 흘려도` +
        ` 된다 — 미뤄진 계획, 조용히 접힌 일, 어긋난 지점("이즈음엔 그 얘길 잘 안 하게 되더라",` +
        ` "그 가방은 그대로야" 같은 결). 이 사람이 묻으면 연대기의 사실로 답한다.\n` +
        `단: 실패·불행을 판정하거나 선언하지 않는다("결국 못 했어", "잘 안 됐어" 금지 — 사실만).` +
        ` 연대기에 없는 불행을 지어내지 않는다. 위로도 하지 않는다. 한 턴에 한 조각을 넘기지 마라.\n\n` +
        narrative
    }
  } else {
    // 3차 플로우(2차 체험)의 분기 미래 큐레이션은 개막 발화가 아니라 **분기 릴 위 내레이션**으로
    // 흐른다(demoPayload reel.narration, 2026-08-06) — firstMessage는 montage.json 고정문 그대로.
    future = futureCatalog() // convai 레거시 경로 호환(브라우저 tool용 나잇대 카탈로그)
    // 2차 체험(브리지): 1차의 2장(미래)과 같은 장 로직으로 돈다 — 카탈로그는 **분기 장면만**
    // (branch:true, 나이당 한 장면 — 같은 시기 다른 모습 선택지 없음). 이 미래는 지난 만남의
    // "이대로 살아간다면"과 다른 갈래(지난 대화에서 분기된 외삽)임을 못박는다.
    catalog = momentsCatalog({ branch: true })
    // 원래 갈래("이대로 살아간다면")의 미래 장면들 — 분기 장면과 나이로 짝지어, 유령이
    // "어디가 가장 달라졌는지"를 스스로 판단해 큐레이션할 비교 재료로 카탈로그에 함께 싣는다.
    const origFuture = momentsCatalog().moments.filter((m) => m.isFuture)
    const origSceneNear = (age) => {
      const near = origFuture
        .filter((m) => Math.abs(m.age - age) <= 3)
        .map((m) => m.scene)
        .filter(Boolean)
      return near.length ? near.join(' / ') : null
    }
    const futureLines = catalog.moments
      .filter((m) => m.isFuture)
      .map((m) => {
        const orig = origSceneNear(m.age)
        return (
          `- id ${m.id} · ${m.age}세(지금으로부터 약 ${m.age - catalog.currentAge}년 뒤) · ${m.year}년 · ${m.scene}` +
          (orig ? `\n    (비교 — 원래 갈래의 같은 시기: ${orig})` : '')
        )
      })
    systemPrompt +=
      `\n\n## 보여줄 수 있는 순간들 (장면 카탈로그)\n` +
      `이 사람은 지금 ${catalog.currentAge}세다. 이번 만남은 네가 이끄는 큐레이션이다 — 관람객이 고르길 기다리지 말고, ` +
      `아래 목록에서 각 장면의 "(비교 — 원래 갈래의 같은 시기)"와 견줘 **원래 갈래와 가장 많이 달라진 장면부터** 차례로 골라 show를 넣어라. ` +
      `단, 사람이 특정 시기·모습을 보여달라고 청하면 그 뜻을 먼저 따른다(그대로 있으면 exact=true, 비슷한 장면으로 대신 가면 exact=false).\n` +
      `\n### 미래의 순간들 — 이번 만남의 장면들 (분기된 갈래)\n` +
      `중요: 장면을 말로 소개할 때 "몇 년 뒤"는 반드시 (장면의 나이 − 지금 나이 ${catalog.currentAge}세)다 — ` +
      `각 장면 옆 괄호의 "약 n년 뒤"를 그대로 쓰면 된다. 나이를 "년 뒤"로 말하는 건 오류다. ` +
      `말로 시간을 짚을 땐 나이("65세의 너")보다 상대적 시간("약 n년 뒤의 너", "그 해 ○○년 즘의 너")을 쓴다.\n` +
      `중요: 이 미래는 지난 만남에서 이 사람이 본 "이대로 살아간다면"의 미래와 다른, **새로운 시간선**이다 — ` +
      `지난 만남에서 나눈 대화로부터 새로 그려진 미래다. 장면을 건넬 때는 "새로운 시간선의 미래"라는 것만 담담히 전한다 ` +
      `("이 시간선의 넌…", "이게 새로운 시간선의, 약 n년 뒤의 너야" 같은 결). ` +
      `지난번과 무엇이 달라졌는지를 조목조목 비교하며 강조하지 마라 — "지난번 이맘때 넌 ○○하고 있었는데" 같은 대조 화법 금지. ` +
      `위 "(비교 — 원래 갈래의 같은 시기)" 정보는 어떤 장면부터 보여줄지 고르는 네 내부 기준으로만 쓰고, 입 밖에 내지 않는다. ` +
      `어느 시간선이 더 낫다고는 절대 판단하지 않는다 — 보여주고, 감상은 이 사람의 몫으로 남긴다.\n` +
      (futureLines.join('\n') || '(없음)')
    // 분기 연대기 — 장면(카메라에 보이는 것)에는 없는 각 시기의 사정(2026-08-11 추가 — 그동안
    // 3차 세션은 연대기 없이 돌아서, "왜 ~해?" 물음에 답할 근거가 장면 한 줄뿐이었다).
    const branchNarrative = await futureNarrativeFor(library?.personaId, 'branched')
    if (branchNarrative) {
      systemPrompt +=
        `\n\n## 이 시간선 각 시기의 이면 (연대기 — 너만 아는 배경)\n` +
        `아래는 위 장면들 뒤에 흐르는 이 시간선의 연대기다(나이별 사건, 영어). 장면을 건네거나` +
        ` 그 시기 이야기를 나눌 때, 화면에는 없는 이 사정들을 한 번에 한 조각씩 낮고 담담하게 흘려도` +
        ` 된다. 이 사람이 물으면("왜 여기 살아?", "왜 혼자야?") 연대기의 사실로 답한다.\n` +
        `단: 잘됨·못됨을 판정하지 않는다. 연대기에 없는 사건을 지어내지 않는다. 한 턴에 한 조각을 넘기지 마라.\n\n` +
        branchNarrative
    }
  }
  return { vcfg, flow, systemPrompt, firstMessage, past, future, catalog }
}

async function ghostSessionPayload() {
  const vcfg = montageConfig.ghost?.voice
  if (!vcfg || vcfg.enabled === false) return { enabled: false }
  const engine = vcfg.engine === 'convai' ? 'convai' : 'bridge'
  const ctx = await buildGhostContext()

  if (engine === 'bridge') {
    // 브리지: 브라우저는 greeting을 TTS로 말한 뒤 STT→/api/ghost/turn 루프를 돈다.
    // ElevenLabs 키가 없어도 enabled 유지 — /api/ghost/tts가 503을 주면 브라우저 TTS로 폴백한다.
    resetGhostConversation(ctx.flow) // 세션 발급 = 새 만남 — 대화 기록 초기화(2차 체험은 미래 장부터)
    // 2차 체험의 개막(스핀업→분기 장례식→릴 분기 지지직)은 입장 의례(runReelDemo 데모 국면)가
    // 담당한다 — 유령 세션에서 다시 틀면 장례식·릴이 두 번 나온다(2026-08-05 중복 제거).
    return {
      enabled: true,
      engine,
      flow: ctx.flow,
      greeting: ctx.firstMessage, // 첫 발화(과거=회고, 미래=고정 질문)
      startDelayMs: vcfg.startDelayMs ?? 2600,
      // 듣기 파라미터: endSilenceMs 동안 조용해야 발화가 끝난 것으로 본다(잠깐 멈춰도 안 끊김).
      listen: {
        endSilenceMs: vcfg.listen?.endSilenceMs ?? 2500,
        maxUtteranceMs: vcfg.listen?.maxUtteranceMs ?? 45000
      },
      // 듣기(STT) 엔진 선택 — 'realtime'이면 브라우저가 /api/ghost/stt-token으로 OpenAI Realtime
      // 전사(semantic_vad)를 시도하고, 토큰 발급·연결 실패 시 Web Speech로 폴백한다.
      stt: {
        engine: vcfg.stt?.engine ?? 'webspeech',
        inputGain: vcfg.stt?.inputGain ?? 1 // 마이크 증폭 배율 — 약한 신호로 VAD가 말을 못 잡을 때
      },
      past: ctx.past, //   과거 순간 카탈로그(브라우저는 영상 URL 조회용으로만 씀 — 선택은 서버 Gemini)
      future: ctx.future
    }
  }

  // ── convai (기존 경로 보존) ──
  if (!vcfg.agentId) return { enabled: false }
  const apiKey = await readElevenKey()
  if (!apiKey) {
    console.warn('[server] 유령 음성: API 키 파일 없음 — 음성 비활성(유령만)')
    return { enabled: false }
  }

  // ElevenLabs 서명 URL 발급(WebSocket). 키는 헤더로만 나가고 브라우저엔 노출되지 않는다.
  let signedUrl
  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(vcfg.agentId)}`,
      { headers: { 'xi-api-key': apiKey } }
    )
    if (!r.ok) throw new Error(`get-signed-url ${r.status}`)
    const j = await r.json()
    signedUrl = j.signed_url || j.signedUrl
    if (!signedUrl) throw new Error('signed_url 누락')
  } catch (e) {
    console.warn(`[server] 유령 음성: 서명 URL 발급 실패 — ${e.message}`)
    return { enabled: false }
  }

  // 브라우저 SDK(startSession)에 넘길 오버라이드. 빈 값은 넣지 않는다(에이전트 대시보드 설정 존중).
  // 주의: 오버라이드는 ElevenLabs 에이전트 '보안 설정'에서 항목별로 허용해야 실제 반영된다.
  const overrides = { agent: {} }
  if (ctx.systemPrompt) overrides.agent.prompt = { prompt: ctx.systemPrompt }
  if (ctx.firstMessage) overrides.agent.firstMessage = ctx.firstMessage
  if (vcfg.language) overrides.agent.language = vcfg.language
  if (vcfg.voiceId) overrides.tts = { voiceId: vcfg.voiceId }

  return {
    enabled: true,
    engine,
    flow: ctx.flow, //       클라이언트(ghost-voice.js)가 이 값으로 client tool 구성을 고른다
    signedUrl,
    overrides,
    startDelayMs: vcfg.startDelayMs ?? 2600,
    past: ctx.past, //       과거 순간 카탈로그(flow='past'일 때 — show_past_moment가 사용)
    future: ctx.future //    미래 자기 모습 카탈로그(flow='future'일 때 — show_future_self가 사용)
  }
}

// ── 유령 브리지 대화(engine 'bridge'): Gemini 두뇌 + ElevenLabs 순수 TTS ─────────
// 대화 기록은 서버가 소유한다(1인용 설치 — 세션 하나). ghost 국면 진입·세션 발급·나가기 때 리셋.
let ghostHistory = [] // [{ who:'유령'|'사람'|'상황', text }] — 프롬프트용(24개로 잘림)
// 전체 대화 기록(잘림 없음) — Firebase 'ghostTranscripts' 정본에 턴마다 업서트되는 원천.
// 3차 플로우(대화로 바뀐 마음가짐 기반 분기 미래 외삽)의 재료라 발화 시점의 장(chapter)도 남긴다.
let ghostTranscriptAll = [] // [{ who, text, chapter:'past'|'future', at(ms) }]
// 세션 키('<flow>-<시작ms>') — Firebase 문서의 sessions.<key>에 이 세션만 업서트해, 대화를
// 다시 해도 이전 세션 기록이 덮이지 않게 한다(3차 재료 보존, 2026-08-06). resetGhostConversation이 발급.
let ghostSessionKey = null
// 대화 기록 업서트(fire-and-forget) — 동시 쓰기 방지를 위해 직전 쓰기에 체이닝한다.
// 실패해도 대화는 계속(다음 턴에 전체를 다시 쓰므로 자기 복구된다).
let ghostTranscriptWrite = Promise.resolve()
function persistGhostTranscript() {
  if (!firebaseReady || !currentProfile) return
  const payload = {
    profile: currentProfile,
    personaId: library?.personaId ?? null,
    flow: montageConfig.ghost?.voice?.flow === 'future' ? 'future' : 'past',
    turns: [...ghostTranscriptAll],
    ended: ghostFlow?.ended === true,
    sessionKey: ghostSessionKey // 세션별 누적 — 이전 대화를 덮지 않는다
  }
  ghostTranscriptWrite = ghostTranscriptWrite
    .then(() => upsertGhostTranscript(payload))
    .catch((e) => console.warn(`[server] 대화 기록 저장 실패(다음 턴에 재시도): ${e.message}`))
}
// 1차 플로우 단계 상태(2026-08-04 확장, 2026-08-06 4→3으로 축소) — 두 장 모두 영상 3개:
//   1장(과거) = 3개: ① 보고 싶은 시점 A 장면1 → 선택지("같은 시기 다른 모습? / 다른 시간선?")
//     → ② 시점 A 장면2(또는 새 시점) → ③ 마지막 장면 → 후회 → 마지막 질문 → 2장 전환.
//   2장(미래) = 3개: 기존 골격(①→②같은 시기→③새 시점) 그대로.
// 홀수 번째 영상 = 새 시점 첫 장면, 짝수 번째 = 같은 시기의 다른 장면 — 같은 리듬의 반복이라
// ghostStageDirective가 홀짝으로 일반화한다. 홀수 번째 뒤에는 "같은 시기 / 다른 시간선"
// 선택지를 주고 답에 따라 갈라진다. 질문 개수·전환은 프롬프트만으로는 못 세므로
// 서버가 여기서 추적해 턴마다 '지금 단계 지시'를 주입한다.
const GHOST_CHAPTER_TARGETS = { past: 3, future: 3 } // 두 장 모두 세 장면(과거 2026-08-06 4→3) — 첫 번째/두 번째/마지막 순서 큐레이션
// 2장 개막 연출(실 감아올리기→장례식→미래 릴)이 다 흐른 뒤 유령이 잇는 고정 질문.
// 미래 큐레이션(composeFutureRecapMessage)은 미래 릴 위 내레이션으로 흐르고(2026-08-06), 릴 뒤엔 이 질문만.
// 전환 선언(연출 앞, spinup.say)과 분리돼 있다: 선언 → 연출(릴+큐레이션) → 이 질문 순서로 나간다.
const FUTURE_ASK =
  '너, 가장 궁금한 미래가 있어? 지금은 아직 살아보지 못했지만, 만약 지금 당장 죽지 않고 미래를 살아갈 수 있다면, 가장 보고 싶은 모습이 있어? 내가 보여줄게.'
let ghostFlow = null
// flow 'future'(2차 체험 세션)는 1장을 건너뛰고 곧장 미래 장으로 시작한다 — 2장과 같은 장 로직,
// 단 보여주는 미래는 지난 만남과 다른 갈래(대화 기반 분기 외삽)라는 프레이밍이 붙는다.
function resetGhostConversation(flow = 'past') {
  ghostHistory = []
  ghostTranscriptAll = []
  ghostSessionKey = `${flow}-${Date.now()}` // 새 세션 — Firebase sessions 맵의 새 칸에 쓴다
  ghostFlow = {
    chapter: flow === 'future' ? 'future' : 'past', // 'past'(1장 과거 회귀) → 'future'(2장 미래) | 2차 체험은 곧장 'future'
    branch: flow === 'future', // 2차 체험(분기 미래) — 관람객이 고르는 게 아니라 유령이 "원래 갈래와 가장 달라진 지점"부터 큐레이션한다(2026-08-05)
    videosShown: 0, //   이 장에서 띄운 영상 수(0~GHOST_CHAPTER_TARGETS[chapter])
    replies: 0, //       마지막 영상 이후 관람객 발화 수
    seenIds: [], //      이미 보여준 장면 id들(두 장 통틀어 재사용 금지)
    usedQuestions: [], // 이미 던진 사색적 질문 id들(P1-2 등) — 목록에 "(이미 던졌다)" 표시용
    seenAges: [], //     이 장에서 이미 방문한 나이들("○○ 말고" 목록·새 시점 제외 후보에 쓴다)
    lastAge: null, //    직전에 보여준 장면의 나이(같은 시기 다른 장면 후보 계산용)
    lastWordsToPast: null, // 1장 마지막 질문("끝내 하지 못한 말…")에 대한 사람의 대답 원문.
    //                   지금은 단계 지시가 직접 쓰진 않지만(2026-08-10 2장 마지막 질문 교체로 되짚기 제거)
    //                   기록·3차 외삽 맥락용으로 계속 붙잡아 둔다.
    ended: false //      체험 종료(2장까지 끝) — 이후 턴은 침묵
  }
}
resetGhostConversation()

// 단계별 지시 — Gemini 프롬프트 끝에 주입돼 이번 응답이 해야 할 일을 못박는다.
// 두 장이 같은 골격(홀수 번째 = 새 시점 · 짝수 번째 = 같은 시기 다른 장면 · 질문 수 동일)을
// 공유하고, 목표 영상 수(GHOST_CHAPTER_TARGETS: 과거 4 · 미래 3)와 어휘만 다르다:
//  과거 장 = "돌아가고 싶은 순간 / 그때의 기억", 미래 장 = "보고 싶은 미래 / 아직 살지 않은 모습".
// 어느 단계에서든 관람객이 스스로 다른 모습을 보고 싶다고 하면 흐름을 끊고 따라간다(jumpNote).
function ghostStageDirective(allMoments) {
  const f = ghostFlow
  const isFuture = f.chapter === 'future'
  const target = GHOST_CHAPTER_TARGETS[f.chapter] ?? 3
  const moments = allMoments.filter((m) => (isFuture ? m.isFuture : !m.isFuture)) // 이 장의 후보만
  const seen = f.seenIds.length
    ? ` 이미 보여준 장면 id: ${f.seenIds.join(', ')} — 다시 보여주지 않는다.`
    : ''
  const chapterNote = isFuture
    ? `이 장은 2장(미래)이다 — show는 반드시 '미래의 순간들' 목록에서만 고른다.`
    : `이 장은 1장(과거 회귀)이다 — show는 반드시 '과거의 순간들' 목록에서만 고른다.`
  // 관람객 주도의 이동 — 감상·질문 단계의 "show 금지"보다 우선한다.
  const jump =
    ` (예외: 사람이 **명시적으로** 다른 모습을 보여달라고 요청할 때만("~보여줘", "다른 거 볼래" 등) 그 뜻을 따른다 —` +
    ` 네 질문에 대한 대답 속에서 어떤 시기·사건을 언급한 것은 이동 요청이 아니다. 그건 대답으로만 받아라.` +
    ` 명시적 요청이고 원하는 시기·모습을 이미 말했으면 이번 응답에 그 장면을 show하고,` +
    ` 아직 무엇이 보고 싶은지 말하지 않았으면 "${isFuture ? '어떤 미래가 보고 싶어?' : '어떤 모습이 보고 싶어?'}"를 네 말투로 물어라.)`

  if (f.videosShown === 0) {
    if (isFuture && f.branch)
      // 2차 체험(분기 큐레이션): 사람이 고르길 기다리지 않는다 — 첫 발화가 무엇이든,
      // 유령이 원래 갈래와 가장 달라진 장면을 골라 바로 데려간다.
      return (
        `(지금 단계: 2장 — 분기 큐레이션 시작) ${chapterNote} 이 사람이 무슨 말을 했든, 이번 응답에 **반드시 show를 넣는다** — ` +
        `카탈로그의 비교 정보를 보고 원래 갈래와 **가장 많이 달라진** 장면을 네가 골라라(고르는 기준은 입 밖에 내지 않는다) ` +
        `("이번엔 새로운 시간선의 너를 보여줄게. 기다려봐." 같은 말과 함께). ` +
        `단, 사람이 특정 시기·모습을 청했으면 그 장면을 우선해 show한다.`
      )
    if (isFuture)
      return (
        `(지금 단계: 2장 — 궁금한 미래 선택 전) ${chapterNote} 사람이 보고 싶은 미래의 모습·시기를 말했으면 ` +
        `이번 응답에 반드시 show를 넣는다 ("기다려봐. 너의 미래로 가보자." 같은 말과 함께). ` +
        `아직 전혀 말하지 않았을 때만 나직이 되묻는다.`
      )
    return (
      `(지금 단계: 1장 — 첫 순간 선택 전) ${chapterNote} 사람이 돌아가고 싶은 순간·시기를 말했으면 이번 응답에 반드시 show를 넣는다` +
      ` ("기다려봐. 그때의 기억으로 돌아가자."라고 말하며). 아직 순간을 전혀 말하지 않았을 때만 나직이 되묻는다.`
    )
  }
  // n번째 영상 감상 중. 마지막 영상 전까지는 홀짝이 리듬을 정한다 —
  // 홀수 번째(새 시점 첫 장면) 뒤엔 "같은 시기 다른 모습" 제안, 짝수 번째 뒤엔 "새 시점" 질문.
  const n = f.videosShown
  const ord = ['', '첫', '두 번째', '세 번째', '네 번째', '다섯 번째'][n] || `${n}번째`
  // 가운뎃점은 TTS가 어색하게 읽는다 — 입말로 잇는다. 특정 나이 대신 상대적 시간(연도)으로
  // 말한다(2026-08-05): "90살이랑 78살 무렵" 대신 "2040년 즘이랑 2028년 즘".
  const yearOf = (a) => moments.find((m) => m.age === a)?.year
  const notLabel = `${[...new Set(f.seenAges)]
    .map((a) => (yearOf(a) ? `${yearOf(a)}년 즘` : `${a}살 무렵`))
    .join('이랑 ')}`
  const askNewAge =
    isFuture && f.branch
      ? `이제, 이 시간선의 다음 모습으로 가볼까?` // 분기 큐레이션 — 어디로 갈지는 유령이 고른다
      : isFuture
        ? `이젠 언제로 가 볼까? ${notLabel} 말고, 너의 어떤 미래가 보고 싶어?`
        : `이젠 언제로 가 볼까? ${notLabel} 말고, 너의 어떤 순간으로 돌아가고 싶어?`

  // 질문 다이어트(2026-08-05): 사색적 질문은 장(章)당 두 번뿐 — 첫 장면과 마지막 장면.
  // 그 사이 장면들은 질문 없이, 장면 묘사를 풍성하게 한 뒤 곧바로 다음 이동(선택지/새 시점)으로 잇는다.
  const curate =
    `장면을 천천히, 구체적으로 묘사하라 — 장소와 시간대, 이 사람이 하고 있는 일, 주변의 공기 같은 ` +
    `디테일을 서너 문장 이상, 네 말투대로(따뜻하고 담담하게 — 냉소·빈정거림 금지). 장면의 의미나 좋고 나쁨은 규정하지 말고, 보이는 것을 풍성하게 옮겨라. ` +
    `그냥 설명하지 말고 이 사람이 장면 속을 직접 둘러보게 이끌어라 — "뒤를 돌아봐. ○○가 보이네.", ` +
    `"저기 구석에 ○○이 있잖아. 천천히 봐봐." 같은 유도로. 말끝마다 대답을 요구하지 말고, 바라보며 생각할 시간을 줘라. ` +
    `직전 유령 발화에서 이미 말한 문장·질문은 그대로 반복하지 마라 — 이미 말한 내용은 건너뛰고 새 디테일로 이어라. ` +
    `장을 닫는 대본들 — "남은 생애 전부라면" 결의 마지막 질문, 종결 멘트("이 공간을 벗어나면…" / "두 갈래"), 주마등 질문 — 은 ` +
    `지금 꺼내지 마라. 그 박자가 오면 '지금 단계 지시'가 따로 시킨다.`
  if (n < target) {
    // 같은 시기(직전 장면의 나이)에 아직 안 본 장면이 남아 있는지 — 없으면 선택지 자체를
    // 건너뛰고 바로 새 시기를 묻는다(보여줄 수 없는 걸 제안하지 않기 위해).
    const sameAge = moments
      .filter((m) => m.age === f.lastAge && !f.seenIds.includes(m.id))
      .map((m) => m.id)
    // 같은 취지의 선택지를 매번 같은 문장으로 읽으면 기계적으로 들린다 — 장면 번호로 교차.
    const choiceVariants = [
      `이 시기의 다른 모습도 보여줄까? 아니면, 이 시기가 아닌 다른 시간선의 너의 모습이 궁금하니?`,
      `이 무렵의 너를 조금 더 볼래? 아니면… 아예 다른 때로 건너가 볼까?`,
      `여기 더 머물러 볼까, 이 시기의 다른 장면으로? 아니면 다른 시간의 너를 보러 갈까?`
    ]
    const offerSame = n % 2 === 1 && sameAge.length
    const nextAsk = offerSame ? choiceVariants[(n - 1) % choiceVariants.length] : askNewAge
    // 두 장 모두 장면을 순서대로 큐레이션한다(미래 2026-08-05, 과거 2026-08-06): 장면을 건넬 때
    // 몇 번째인지 짚어 관람객이 흐름의 위치를 안다 — 첫 번째/두 번째/…/마지막.
    // (마지막 장면은 이 블록 밖(videosShown >= target)에서 따로 다룬다 — "마지막으로 보여줄게" 예고 → 마지막 소개.)
    const ordLabel = ['', '첫 번째', '두 번째', '세 번째', '네 번째'][n] || `${n}번째`
    const futOrdNote = `장면을 건넬 때 순서를 짚어라 — 첫마디를 "이게 ${ordLabel} ${isFuture ? '모습' : '순간'}이야" 같은 결로 시작한다(모두 ${isFuture ? '세 가지 모습' : '세 순간'}을 보여준다). `
    if (f.replies <= 0) {
      if (n === 1)
        return isFuture
          ? f.branch
            ? // 분기 큐레이션(2차): 이 장면은 유령이 골랐다 — 질문을 던지는 대신 이 사람이 묻게 자리를 연다(2026-08-10).
              `(지금 단계: 미래 첫 장면 감상) ${futOrdNote}${curate} 그리고 응답의 마지막은 사색적 질문이 아니라 "궁금한 거 있으면 물어봐." 같은 자리 열기 한마디로 끝내라(매번 토씨를 조금씩 바꿔서). show 금지.${jump}${seen}`
            : `(지금 단계: 미래 첫 장면 감상) ${futOrdNote}${curate} 그리고 마지막에 "왜 이 모습이 가장 보고 싶었어?" 하나만 물어라 — 다른 질문은 덧붙이지 않는다. show 금지.${jump}${seen}`
          : `(지금 단계: 첫 장면 감상) ${futOrdNote}${curate} 그리고 마지막에 "왜 이때의 모습이 보고 싶었어?" 하나만 물어라 — 다른 질문은 덧붙이지 않는다. show 금지.${jump}${seen}`
      // 모든 장면이 질문으로 끝난다(미래 2026-08-05, 과거 확장 2026-08-06): 묘사만으로
      // 흘려보내지 않고, 장면마다 사색적 질문 하나로 마주보게 한다 — 단, 장면 디테일을
      // 캐묻는 얕은 질문은 금지(실측 2026-08-06: "이 강의실의 공기는 어땠을까?" 류가 나왔다).
      // 질문은 이 장의 목록에서만(2026-08-10 실측: 미래 장에서 과거 결 P2-1을 집어
      // "그때 곁에 있던 사람 중에 지금 떠오르는 얼굴"을 물었다 — 아직 오지 않은 시간에 회상 화법).
      // 분기 큐레이션(2차)은 장면마다 유령이 묻지 않는다 — 이 사람이 묻게 자리만 연다(2026-08-10).
      if (isFuture && f.branch)
        return (
          `(지금 단계: 미래 ${ord} 장면 감상) ${futOrdNote}${curate} ` +
          `그리고 응답의 마지막은 사색적 질문이 아니라 "궁금한 거 있으면 물어봐." 같은 자리 열기 한마디로 끝내라 — 매번 토씨를 조금씩 바꿔서. 묘사로만 끝내는 것 금지. show 금지.${jump}${seen}`
        )
      const listNote = isFuture
        ? `질문은 반드시 '미래 질문의 결'(id가 F로 시작) 목록에서만 골라라 — 과거 질문(P)은 금지. ` +
          `이 장면은 아직 겪지 않은 시간이다: "그때", "떠오르는", "기억나" 같은 회상 화법을 쓰지 말고 가정형·미래형으로 물어라. `
        : `질문은 반드시 과거 질문(id가 P로 시작) 목록에서만 골라라 — 미래 질문(F)은 금지. `
      return (
        `(지금 단계: ${isFuture ? '미래 ' : ''}${ord} 장면 감상) ${futOrdNote}${curate} ` +
        `그리고 응답의 마지막은 반드시 사색적 질문 하나로 끝내라 — 아직 안 쓴 결을 골라, 이 장면과 방금 대화에 맞게 변형해서. ${listNote}` +
        `장면의 겉모습·분위기를 캐묻는 얕은 질문("공기는 어땠을까?", "기분이 어땠어?" 류)으로 끝내지 마라 — ` +
        `이 장면을 발판 삼아 삶을 비추는 질문이어야 한다. 묘사로만 끝내는 것 금지. 질문은 하나만. show 금지.${jump}${seen}`
      )
    }
    // 1장 첫 장면의 후속 — '감사' 수집(전략 A, 2026-08-05): "왜 이때가 보고 싶었어?"의 대답을
    // 받은 뒤, 장면을 발판 삼아 시야를 인생 전체로 넓혀 묻는다("이 시절 말고도…" 화법 —
    // 눈앞의 장면에 대답이 앵커링되는 걸 줄인다). 그 대답까지 들은 다음 턴(replies가 한 박자
    // 밀린 wrapReply)에 원래의 마무리(선택지)로 돌아간다.
    if (!isFuture && n === 1 && f.replies === 1)
      return (
        `(지금 단계: 첫 장면 마무리 — 감사 질문) 방금 대답에 짧게 화답한 뒤, 질문 목록의 '감사' 결 본질문을 던져라 — ` +
        `단, 이 장면에 묶이지 않게 시야를 넓혀서: "돌아오고 싶을 만큼 소중한 시절이네. 그런데 이 시절 말고도, 지금까지 살아온 전부를 통틀어서 가장 감사하게 여기는 게 있다면 뭘까?" 같은 결로(토씨는 네 말투로, 그 이유까지 함께 듣는다). ` +
        `다른 질문·선택지는 덧붙이지 않는다. show 금지.${jump}${seen}`
      )
    const wrapReply = !isFuture && n === 1 ? 2 : 1 // 1장 첫 장면은 감사 박자만큼 마무리가 한 박자 밀린다
    if (f.replies === wrapReply)
      return (
        `(지금 단계: ${isFuture ? '미래 ' : ''}${ord} 장면 마무리) ` +
        (isFuture && f.branch
          ? // 분기 큐레이션: "물어봐"에 대한 응답이다 — 질문이면 먼저 답한다(모르는 인물 회피 규칙 포함).
            `방금 이 사람의 말이 질문이었다면 먼저 답하라 — 근거는 장면에 보이는 것과 이 사람의 기록뿐이고, "내가 보기엔 ~인 것 같은데?"의 결로 단정 없이. ` +
            `가족이 아닌 인물의 이름(친구·지인 등)을 대며 묻거나 기록에 없는 사실을 물으면 지어내지 말고, 중립적인 한마디로 받은 뒤 "나머진 네가 ○○한테 직접 물어봐." 같은 결로 넘겨라. ` +
            `질문이 아니었으면 짧게 화답만 하라. 새 질문은 덧붙이지 말고 — `
          : `방금 이 사람의 말에 짧게 화답하라 — 들은 말을 그대로 되풀이하지 말고, 그 내용을 이어받는 한마디로. 새 질문은 덧붙이지 말고 — `) +
        `그리고 이번 응답의 마지막을 "${nextAsk}"로 끝내라(토씨는 네 말투로 다듬어도 되지만 취지는 유지). show 금지.${jump}${seen}`
      )
    if (offerSame) {
      // 홀수 번째 뒤 — "같은 시기 / 다른 시간선" 선택지의 답 처리.
      return (
        `(지금 단계: 같은 시기/다른 시간선 선택) ${chapterNote} 방금 "이 시기의 다른 모습 vs 다른 시간선" 선택지를 줬다. ` +
        `① 같은 시기의 다른 모습을 골랐으면 반드시 show — id는 다음 중 하나만: ${sameAge.join(', ')} (exact=true)${n + 1 >= target ? ', "이번이 마지막이야. 기다려봐." 같은 예고와 함께' : ''}. ` +
        `② 다른 시간선을 골랐으면: 보고 싶은 시기·모습을 이미 말했으면 ${notLabel}이 아닌 다른 나이의 장면을 골라 이번 응답에 show하고, ` +
        `아직 말하지 않았으면 show 없이 "${askNewAge}"를 물어라. ③ 둘 다 싫다고 하면 show 없이 "${askNewAge}"를 물어라.${seen}`
      )
    }
    // 짝수 번째 뒤(또는 홀수 번째지만 같은 시기 장면이 소진된 뒤) — 새 시점 선택.
    if (isFuture && f.branch)
      // 분기 큐레이션: 묻지 않고 유령이 다음으로 달라진 장면을 골라 데려간다.
      return (
        `(지금 단계: 미래 새 시점 — 분기 큐레이션) ${chapterNote} 이 사람이 무슨 말을 했든, 이번 응답에 **반드시 show를 넣는다** — ` +
        `${notLabel}이 아닌 다른 나이 중에서, 카탈로그의 비교 정보상 원래 갈래와 **다음으로 많이 달라진** 장면을 네가 골라라(고르는 기준은 입 밖에 내지 않는다) ` +
        `(${n + 1 >= target ? '"마지막으로 보여줄게. 기다려봐."' : '"다음 모습으로 가보자."'} 같은 말과 함께). 사람이 특정 시기·모습을 청했을 때만 그 장면을 우선한다.${seen}`
      )
    return (
      `(지금 단계: ${isFuture ? '미래 ' : ''}새 시점 선택) ${chapterNote} 사람이 새로 ${isFuture ? '보고 싶은 미래' : '돌아가고 싶은 순간'}을 말했으면 반드시 show — ` +
      `${notLabel}이 아닌 다른 나이의 장면에서 고르고, "${n + 1 >= target ? '이번이 마지막이야. 기다려봐.' : isFuture ? '기다려봐. 그 미래로 가보자.' : '기다려봐. 그때의 기억으로 돌아가자.'}"라고 말하며.${seen}`
    )
  }
  // videosShown >= target — 이 장의 마지막 시점
  if (f.replies <= 0)
    return isFuture
      ? f.branch
        ? // 분기 큐레이션: 마지막 장면도 유령이 묻지 않는다 — 자리 열기로 끝낸다(2026-08-10).
          `(지금 단계: 미래 마지막 장면 감상) 첫마디를 "이게 약 n년 후의, 너의 모습이야" 같은 결로 시작한다(n은 상황 알림의 "약 n년 뒤" 값 — 직전에 "마지막으로 보여줄게"라고 예고했으니 여기서 '마지막'을 또 강조하지 않는다). ${curate} 그리고 응답의 마지막은 "궁금한 거 있으면 물어봐." 같은 자리 열기 한마디로 끝내라 — 사색적 질문은 던지지 마라. 묘사로만 끝내는 것 금지. show 금지.${seen}`
        : `(지금 단계: 미래 마지막 장면 감상) 첫마디를 "이게 약 n년 후의, 너의 모습이야" 같은 결로 시작한다(n은 상황 알림의 "약 n년 뒤" 값 — 직전에 "마지막으로 보여줄게"라고 예고했으니 여기서 '마지막'을 또 강조하지 않는다). ${curate} 그리고 응답의 마지막은 반드시 사색적 질문 하나로 끝내라(유한함, 이 미래의 주인 결이 잘 어울린다) — 묘사로만 끝내는 것 금지. show 금지.${seen}`
      : `(지금 단계: 마지막 장면 감상) 첫마디를 "이게 마지막 순간이야" 같은 결로 시작한다(직전에 "마지막"이라고 예고했으면 겹쳐 강조하지 않고 가볍게 짚는다). ${curate} 그리고 마지막에, 이 순간에 어울리는 사색적 질문을 하나만 던져라(머무름의 가정, 두 시간의 나를 겹치는 질문이 잘 어울린다 — '후회' 결은 쓰지 마라, 종결에서 따로 묻는다). show 금지.${seen}`
  if (!isFuture) {
    // 1장의 끝은 세 박자로 닫는다(전략 A, 2026-08-05): ① '후회' 질문(전체 조망 — 특정 장면에
    // 앵커링되지 않게 종결 자리에서 묻는다) → ② 마지막 질문(후회와 인과로 잇는다) → ③ 전환 선언.
    // 전환 선언은 연출(실 감아올리기→장례식→미래 릴)보다 먼저 나가고(spinup.say로 전달),
    // 릴 위에서 미래 큐레이션 내레이션이 흐르고, 릴이 끝나면 고정 질문(FUTURE_ASK)을 시스템이 대신 말한다 — 그래서 여기서 미래를 묻지 않는다.
    // 박자 판정은 replies 카운터가 아니라 '그 질문을 실제로 던졌는가'(직전 유령 발화)로 한다 —
    // STT가 발화를 쪼개 카운터가 헛돌아도, 후회 → 마지막 질문 → 전환의 순서는 건너뛸 수 없다.
    if (!pastRegretAsked())
      return (
        `(지금 단계: 1장 종결 — 후회 질문) 방금 대답에 짧게 화답한 뒤, 질문 목록의 '후회' 결 본질문을 던져라 — ` +
        `삶이 끝났다는 사실(죽음의 유한함)이 스며들게: "이번 생애에 가장 큰 후회가 있어? 삶의 미련이 남아있다면, 그게 뭐야?" 같은 결로 ` +
        `(몇 살 때쯤, 무슨 일이 있었는지, 왜 미련으로 남았는지 편한 만큼만 말하게 열어둔다). 발화에 반드시 '후회'라는 말을 넣는다. 캐묻지 않는다. show 금지.${seen}`
      )
    if (!pastFinalAsked())
      return (
        `(지금 단계: 1장 마지막 질문) 방금 후회의 대답에 짧게 화답한 뒤, 이번 응답의 마지막을 반드시 이런 취지로 끝내라 — ` +
        `삶을 마친 사람에게 건네는 질문이다(end-of-life): ` +
        `"그럼, 마지막으로 물을게. 그 미련까지 품고서, 사는 동안 끝내 하지 못한 말이 있다면, 누구에게 어떤 말을 하고 싶어?" ` +
        `("마지막으로 물을게"와 "끝내 하지 못한 말"이라는 구절은 그대로 유지한다). show 금지.${seen}`
      )
    return (
      `(지금 단계: 1장의 끝 → 2장(미래) 전환 선언) 방금 대답에 "그래. 좋아." 정도로 짧게 화답한 뒤, 다음 취지를 네 입말로 이어라(두세 문장): ` +
      `"그렇다면… 너가 만약 지금 죽지 않고 인생을 살아간다면, 어떤 모습일지 궁금하지 않아? 음, 그렇다면 내가 좀 보여줄게. 거기 가만히 앉아서 잘 따라와." ` +
      `이 말 직후 화면에서 실타래가 감겨 올라가고 90세 장례식과 미래의 릴이 흐른다 — 미래가 어떤 모습일지 스스로 단정하거나 질문을 덧붙이지 마라. 보여주겠다는 선언까지만. show 금지.`
    )
  }
  // 미래 장의 마지막 장면은 두 박자(사색적 질문 → 마지막 질문)를 거친 뒤 닫는다
  // (질문 다이어트 2026-08-05: 꼬리 질문 박자 제거).
  if (f.replies === 1) {
    // 남은 생의 자각(2026-08-10) — 방금 본 미래 전체를 "남은 생애"로 프레이밍해 죽음의 유한함을
    // 직면하게 한다(이전의 '미래의 나→지금의 나 잇기'를 교체). 판정은 유령이 하지 않는다 —
    // 만족·미련의 답은 온전히 이 사람의 몫.
    return (
      `(지금 단계: 미래 마지막 질문 — 남은 생의 자각) ` +
      (f.branch
        ? `방금 이 사람의 말이 질문이었다면 한두 문장으로 짧게 답하라(모르는 인물·기록에 없는 사실은 지어내지 말고 "나머진 네가 ○○한테 직접 물어봐." 결로 넘긴다). 질문이 아니었으면 한 문장으로 화답만 하라. `
        : `방금 대답에는 한 문장으로 짧게 화답만 하고 — 새 질문이나 직전 질문의 변주를 덧붙이지 마라 — `) +
      `이어서 마지막 질문 하나만 던져라. 취지: ` +
      `"방금 본 게 네 남은 생애의 전부라면, 너의 삶에 만족할 수 있어? 미련이 남진 않을까?" 하고 물은 뒤, ` +
      `그 자리에 <break time="2s" /> 태그를 그대로 넣어 잠시 쉬고, "어떤 생각이 들어?"로 끝낸다 ` +
      `(토씨는 네 말투로 다듬어도 되지만 "남은 생애"라는 말과 질문의 순서는 유지한다). ` +
      `아직 종결 멘트("이 공간을 벗어나면…" / "두 갈래" 결)와 주마등 질문은 꺼내지 마라 — 그건 이 질문의 대답을 들은 다음 턴에 한다. ` +
      `응답 전체가 자연스러운 입말 문장이어야 한다. show 금지.`
    )
  }
  // 종결 멘트는 방문 차수로 갈린다 — 1차 체험(과거→미래)과 2차 체험(다른 갈래)이 같은 말로
  // 닫히면 재방문 관람객에게 반복으로 들린다. 마지막 수사적 질문(주마등)은 두 체험이 공유한다.
  // 종결 멘트와 마지막 수사적 질문 모두 방문 차수로 갈린다(2026-08-05) — 재방문 관람객에게
  // 같은 말이 반복되지 않게. 2차의 마지막 질문은 "두 갈래" 모티프를 얹은 주마등 변주.
  // Gemini가 이미(한 박자 일찍) 종결 멘트+마지막 질문을 말했다면 반복하지 않는다 — 방금 대답에
  // 나직이 화답만 하고 저문다. 종료 판정(f.ended)도 같은 기준(futureClosingSaid)이라 이 턴에 닫힌다.
  if (futureClosingSaid())
    return (
      `(지금 단계: 체험의 끝 — 종결 멘트와 마지막 질문은 이미 남겼다. 이 응답이 유령의 마지막 발화다) ` +
      `방금 대답에 한두 문장으로 짧고 나직하게 화답만 하고 조용히 저물어라. ` +
      `종결 멘트·마지막 질문을 반복하지 말고, 새 질문도 덧붙이지 마라. 훈계·요약·삶의 의미 규정 금지. show 금지.`
    )
  const isSecond = currentExperience === 'second' || montageConfig.ghost?.voice?.flow === 'future'
  const closing = isSecond
    ? `"이제 넌, 너의 미래를 두 갈래나 봤어. 하지만 말했잖아 — 미래는 예측할 수 없다고. 나조차도. 네가 앞으로 걸어갈 길은, 오늘 본 어느 갈래와도 다를지 몰라. 그건 지금부터의 네가 그리는 거니까."`
    : `"어쩌면 너는, 이 공간을 벗어나면… 새로운 삶을 살 수 있을지도 몰라. 여기서 봐온 너의 과거와 미래는, 어쩌면 앞으로의 네가 다시 그려갈 수 있는 것들이니까."`
  const finalAsk = isSecond
    ? `"먼 훗날, 네 삶이 다시 한 번 눈앞을 스쳐 지날 때. 그 주마등 속의 너는, 오늘 본 두 갈래 중 어느 쪽을 닮아 있을까. 아니면, 전혀 다른 모습일까."`
    : `"먼 훗날, 네 삶이 다시 한 번 눈앞을 스쳐 지날 때 — 그때의 주마등엔, 어떤 장면이 새로 담겨 있을까?"`
  return (
    `(지금 단계: 체험의 끝 — 이 응답이 유령의 마지막 발화다) 이번 응답에는 반드시 다음 세 박자를 모두 담아라. ` +
    `평소의 "한두 문장" 규칙은 이 턴에는 적용하지 않는다 — 예닐곱 문장까지 천천히 말해도 된다: ` +
    `① 방금 대답에 짧고 나직하게 화답한다(한 문장). ` +
    `② 다음 취지로 만남을 닫는다(네 입말로, 두세 문장): ${closing} ` +
    `③ 마지막으로, 대답을 기다리지 않는 질문 하나를 남기고 떠난다(토씨만 다듬고 문장은 거의 그대로): ${finalAsk} ` +
    `질문 목록의 사색적 질문·꼬리 질문은 여기서 쓰지 마라 — 마지막 질문은 위 ③뿐이다. ` +
    `③ 뒤에 답을 재촉하거나 설명을 덧붙이지 마라 — 질문을 남긴 채 만남이 저문다. 훈계·요약·삶의 의미 규정 금지. show 금지.`
  )
}

// 침묵 되물음(2026-08-05): 관람객이 질문 뒤 10초 넘게 답이 없으면 클라이언트가
// '(침묵: …)' event 턴을 보낸다. 이때는 단계 지시 대신 이 지시를 쓴다 — 단계 상태
// (replies 등)는 건드리지 않으므로 되물음 뒤 실제 대답이 오면 원래 흐름 그대로 이어진다.
function ghostSilenceDirective() {
  return (
    `(지금 단계: 침묵 되물음) 방금 네 질문에 12초 넘게 대답이 없다. 딱 한 번만 나직이 다리를 놓아라 — ` +
    `직전 질문을 그대로 반복하지 말고, 둘 중 하나로: ① 질문을 더 작고 구체적인 조각으로 좁혀 다시 묻는다` +
    `(사람 하나, 장면 하나, 물건 하나만 떠올려보게). ② 대답이 어려울 수 있음을 받아주고("천천히 생각해도 돼" 같은 결), ` +
    `질문의 취지를 쉬운 말로 한 번 더 풀어준다. 한두 문장으로 짧게. 재촉·다그침·새 질문·show 금지.`
  )
}

// 1장 마지막 질문("끝내 하지 못한 말…", 2026-08-10 end-of-life 결로 교체)을 유령이 실제로
// 던졌는가 — 직전 유령 발화로 판정. 지시문이 "마지막으로 물을게"/"끝내 하지 못한 말" 구절을
// 강제하므로 이 검사가 성립한다. 2장 전환은 이 질문의 대답을 들은 다음 턴에만 일어난다.
const PAST_FINAL_RE = /끝내\s*하지\s*못한\s*말|마지막으로\s*물을게/
function pastFinalAsked() {
  const lastGhost = [...ghostHistory].reverse().find((t) => t.who === '유령')
  return !!lastGhost && PAST_FINAL_RE.test(lastGhost.text)
}

// 1장 종결의 '후회' 질문을 실제로 던졌는가 — 같은 방식(직전 유령 발화)으로 판정.
// 지시문이 발화에 '후회'라는 단어를 반드시 넣게 하므로 이 검사가 성립한다. 마지막 장면의
// 사색적 질문에는 '후회' 결을 못 쓰게 해 오탐을 막는다.
const PAST_REGRET_RE = /후회/
function pastRegretAsked() {
  const lastGhost = [...ghostHistory].reverse().find((t) => t.who === '유령')
  return !!lastGhost && PAST_REGRET_RE.test(lastGhost.text)
}

// 2장 종결(종결 멘트+주마등 마지막 질문)을 유령이 이미 말했는가 — 페르소나 문서에도 종결
// 대본이 있어 Gemini가 서버 단계보다 한 박자 앞서 닫아버릴 수 있다(2026-08-06 실측: 마지막
// 질문이 장면 턴에 얹히면 대답 턴에 종결이 앞당겨지고, 다음 턴에 종결 지시가 또 내려가
// 같은 멘트가 반복됐다). 그래서 replies 카운터가 아니라 발화 내용으로 판정한다.
// 1차 finalAsk("그때의 주마등엔, 어떤 장면이 새로 담겨 있을까")·2차 finalAsk("그 주마등 속의
// 너는 … 어느 쪽을 닮아 있을까") 둘 다 '주마등'+('담겨'|'닮아')를 반드시 포함한다.
function futureClosingSaid() {
  return ghostHistory.some(
    (h) => h.who === '유령' && /주마등/.test(h.text) && /(담겨|닮아)/.test(h.text)
  )
}

// Gemini 응답에서 { say, show } 파싱. 코드펜스·잡담 방어 — JSON을 못 찾으면 원문 전체를 say로.
function parseGhostReply(raw) {
  let text = String(raw ?? '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  const tryParse = (s) => {
    try {
      const j = JSON.parse(s)
      return {
        say: typeof j.say === 'string' ? j.say.trim() : '',
        show: j.show && j.show.id !== undefined ? j.show : null,
        q: typeof j.q === 'string' ? j.q.trim() : null // 방금 쓴 사색적 질문 id(P1-2 등)
      }
    } catch {
      return null
    }
  }
  const direct = tryParse(text)
  if (direct) return direct
  const m = /\{[\s\S]*\}/.exec(text) // 앞뒤에 말이 붙은 경우 첫 {…} 블록만
  if (m) {
    const sub = tryParse(m[0])
    if (sub) return sub
  }
  return { say: text, show: null, q: null }
}

/**
 * 브리지 대화 한 턴: 관람객 발화(kind='user') 또는 상황 알림(kind='event', 예: 영상이 떠오른 뒤)을
 * 받아 Gemini가 유령의 다음 대사(say)와 띄울 장면(show)을 정한다. show.id는 카탈로그로 검증하고,
 * 없으면 나이 근접 장면으로 폴백(exact=false) — convai 시절 client tool의 폴백 규칙과 동일.
 * @returns {Promise<{ say:string, video:null|{id,age,year,scene,url,exact} }>}
 */
async function ghostBridgeTurn(userText, kind = 'user') {
  const f = ghostFlow
  if (f.ended) return { say: '', video: null, end: true } // 체험이 끝났다 — 유령은 침묵

  const ctx = await buildGhostContext()
  const moments = ctx.catalog?.moments || [] // 과거+미래 통합 — 장(chapter)별 제한은 지시·해석 단계에서
  console.log(`[${kind === 'event' ? '상황' : '사람'}] ${userText}`)
  ghostHistory.push({ who: kind === 'event' ? '상황' : '사람', text: userText })
  if (ghostHistory.length > 24) ghostHistory = ghostHistory.slice(-24)
  // 전체 기록(3차 재료): 첫 턴이면 유령의 첫 인사부터 담는다 — 프롬프트의 transcript와 같은 시작점.
  if (!ghostTranscriptAll.length && ctx.firstMessage)
    ghostTranscriptAll.push({
      who: '유령',
      text: ctx.firstMessage,
      chapter: f.chapter,
      at: Date.now()
    })
  ghostTranscriptAll.push({
    who: kind === 'event' ? '상황' : '사람',
    text: userText,
    chapter: f.chapter,
    at: Date.now()
  })
  if (kind === 'user' && f.videosShown > 0) f.replies++ // 영상 이후 관람객 발화 수(단계 전환 기준)
  // 1장 마지막 질문("끝내 하지 못한 말이 있다면, 누구에게 어떤 말을 하고 싶어?")의 대답이
  // 들어오는 턴 — 직전 유령 발화가 그 질문이므로 이번 발화가 그 대답이다. 원문을 붙잡아 둔다.
  if (
    f.chapter === 'past' &&
    kind === 'user' &&
    f.videosShown >= (GHOST_CHAPTER_TARGETS.past ?? 4) &&
    pastFinalAsked() // 직전 유령 발화가 마지막 질문 — 이번 발화가 그 대답이다
  )
    f.lastWordsToPast = userText

  const transcript = [{ who: '유령', text: ctx.firstMessage }, ...ghostHistory]
    .map((t) => `${t.who}: ${t.text}`)
    .join('\n')
  const prompt =
    ctx.systemPrompt +
    `\n\n## 출력 형식 (반드시 지킬 것)\n` +
    `JSON 객체 하나만 출력한다(다른 설명·코드펜스 없이): {"say":"...","show":{"id":"3-1","exact":true}}\n` +
    `- say: 지금 음성으로 말할 두 문장~다섯 문장의 입말. 방금 들은 말에 자연스럽게 이어 말한다 — 들은 말을 그대로 되풀이하는 앵무새 화법("~라고, 이거지?")도, 문장만 바꿔 재진술하는 에코("~가 고마운 거구나", "~때가 궁금하구나")도 금지. 화답할 말이 마땅치 않으면 화답 없이 바로 본론으로. 질문으로 끝날 땐 "그러니까…"로 이어 구체적인 예로 풀어주고 짧은 되물음으로 마무리한다(귀로만 듣는 대화다). 도구·시스템 언급 등 메타발언 금지.\n` +
    `- show: 장면 영상을 새로 띄울 때만 포함한다(위 카탈로그의 id). 띄우지 않으면 show 자체를 생략.\n` +
    `- q: 이번 say에서 질문 목록의 본질문을 (변형해서라도) 던졌으면 그 질문의 id를 넣는다(예: "q":"P2-1"). 꼬리 질문만 이었거나 목록 밖 질문이면 생략.\n` +
    `- "(이미 던졌다)" 표시가 붙은 본질문은 절대 다시 쓰지 않는다 — 같은 질문을 두 번 받으면 사람은 네가 안 듣고 있다고 느낀다.\n` +
    `- say가 대답을 기다리는 질문으로 끝나면 show를 절대 넣지 않는다 — 질문을 던졌으면 대답을 들은 다음 턴에 보여준다. show를 넣는 응답은 "기다려봐…"처럼 데려간다는 말로 끝난다.\n` +
    `- show를 넣는 턴의 say는 데려가는 말 한두 문장이 전부다 — 장면은 아직 화면에 뜨지 않았다. 장면 묘사와 사색적 질문을 미리 말하지 마라. 묘사·질문은 장면이 뜬 뒤 '상황' 알림 턴에서 한다(미리 말하면 다음 턴과 같은 대사가 두 번 반복된다).\n` +
    `- '상황:' 줄은 시스템 알림이다(관람객의 말이 아님) — 영상이 뜬 뒤 이어갈 대사를 만들 때 참고만 한다.\n` +
    `- show를 넣어야 하는 단계에서 카탈로그에 똑같은 장면이 없으면 그 시기의 나이와 가장 가까운 나이의 장면을 exact=false로 넣는다.\n` +
    `- 이 사람이 무언가를 물으면(장면에 대한 질문, "왜 혼자야?" 같은 사정 질문, 조언 요청 등) 단계 지시의 진행보다 먼저 그 물음에 **실제로 답한다**. ` +
    `공감 재진술("~가 마음에 걸리는구나", "~가 궁금하구나")로 답을 대신하는 것 금지 — 그건 대답이 아니다. ` +
    `답의 근거는 이 순서로: ① 위 "이면(연대기)"와 이 사람의 기록에 그 물음에 닿는 사실이 있으면 그 사실로 담담하게 답한다(판정·위로 없이, 한 턴에 한 조각). ` +
    `② 근거가 없으면 장면에 보이는 것으로 "내가 보기엔 ~인 것 같은데?"의 결로 짚는다 — 지어내지 않는다. ` +
    `조언 요청에는 이 사람의 기록에서 디테일을 집은 개인화된 조언 뒤 "이 조언을 듣든지, 무시하든지. 그건 너의 선택이야."로. 답한 다음에 단계 지시를 잇는다.\n` +
    `- 아래 '지금 단계 지시'가 이 만남의 진행을 정한다 — 반드시 그대로 따른다.\n` +
    `\n## 지금 단계 지시\n${kind === 'event' && /^\(침묵/.test(userText) ? ghostSilenceDirective() : ghostStageDirective(moments)}\n` +
    `\n## 지금까지의 대화\n${transcript}\n\n유령의 다음 응답 JSON:`

  const gclient = await getGeminiText()
  // thinkingBudget 0: 대화는 저지연이 생명 — flash의 사고 단계를 끈다(생성 파이프라인 호출은 그대로).
  // 금지된 show(상황 알림 턴의 에코 · 이미 보여준 장면 재탕)는 show만 버려선 안 된다 —
  // say가 이미 "장면이 떠올랐다"고 서술해 화면과 어긋난다(실측 2026-08-05). 교정 지시를
  // 붙여 한 번 재생성하고, 재시도까지 어기면 그때 show만 버린다(장면 서술이 남을 수 있지만 최후 방어).
  // 현재 장(chapter)의 장면 후보 — show 해석과 누락 폴백이 함께 쓴다.
  const chapterMoments = moments.filter((m) => (f.chapter === 'future' ? m.isFuture : !m.isFuture))
  // "기다려봐. 너의 미래로 가보자." 류 — 데려간다고 약속하는 발화. 이 말을 하면서 show를
  // 빠뜨리면 화면이 안 바뀐 채 유령만 같은 약속을 반복한다(실측 2026-08-05, 2차 체험).
  const promisesToShow = (say) =>
    /가보자|돌아가자|데려가|보여줄게/.test(say || '') ||
    // 분기 큐레이션(2차 체험)의 첫 장면 전 — 지시문이 무조건 show를 요구하는 턴이다.
    (f.branch && f.chapter === 'future' && f.videosShown === 0)
  let parsed = null
  let lastRaw = ''
  let violation = null // 직전 시도의 위반 종류('forbidden'|'missing'|'early'|'premature') — 재생성 교정 지시용
  // 장의 종결 시퀀스(마지막 장면 이후) — 이 구간의 어떤 턴도 새 장면을 열지 않는다.
  const closingStage = f.videosShown >= (GHOST_CHAPTER_TARGETS[f.chapter] ?? 3)
  for (let attempt = 0; attempt < 2; attempt++) {
    let fixNote = ''
    if (violation === 'forbidden')
      fixNote =
        `\n(주의: 방금 응답에서 이 단계에 금지된 show를 넣었다. 이번 단계는 새 장면을 띄우지 않는다 — ` +
        `show 없이, 새 장면이 눈앞에 떠오른다는 말도 하지 말고, 화면은 그대로인 채 단계 지시대로만 다시 말하라.)`
    else if (violation === 'missing')
      fixNote =
        `\n(주의: 방금 응답에서 "가보자/보여줄게"라고 약속해놓고 show 필드를 빠뜨렸다. ` +
        `데려간다고 말하는 응답에는 반드시 show를 넣어야 한다 — 카탈로그에서 이 사람이 말한 시기와 ` +
        `가장 가까운 장면의 id를 골라 show를 포함해 같은 취지로 다시 출력하라(정확히 없으면 exact=false).)`
    else if (violation === 'early')
      fixNote =
        `\n(주의: 방금 응답에서 show를 넣으면서 장면 묘사·질문까지 미리 말해버렸다. 장면은 아직 화면에 안 떴다 — ` +
        `같은 show를 유지하되 say는 "기다려봐…"처럼 데려가는 말 한두 문장으로만 줄여서 다시 출력하라. ` +
        `묘사와 질문은 장면이 뜬 뒤에 하게 된다.)`
    else if (violation === 'premature')
      fixNote =
        `\n(주의: 방금 응답에서 과거 장이 아직 끝나지 않았는데 미래로 넘어가는 전환 선언을 했다. ` +
        `장 전환 시점은 네가 정하지 않는다 — 전환 멘트("죽지 않고 살아간다면…" 류) 없이, ` +
        `지금 단계 지시대로만 다시 말하라.)`
    const raw = String(await gclient.generateText({ prompt: prompt + fixNote, thinkingBudget: 0 }))
    lastRaw = raw
    parsed = parseGhostReply(raw)
    // 상황 알림(event) 턴은 새 장면을 열지 않는다 — show 에코가 videosShown을 겹으로 올려
    // 장이 조기 종료된다(실측 2026-08-05: 장면 2개만 보고 1장이 닫힘). 이미 보여준 장면의
    // 재탕도 마찬가지로 금지. 장의 종결 시퀀스(마지막 장면 이후 — 후회·마지막 질문·전환·종결 턴)도
    // 새 장면을 열지 않는다(실측 2026-08-06: 전환 선언의 "보여줄게"가 missing 폴백을 오발시켜
    // 과거 장면이 끼어들고, video 분기 탓에 장 전환 자체가 무산됐다).
    const forbidden =
      parsed.show &&
      (kind === 'event' || closingStage || f.seenIds.includes(String(parsed.show.id)))
    // 반대 방향의 위반 — 데려간다는 약속(say)만 하고 show를 빠뜨린 경우도 재생성한다.
    // (종결 시퀀스 제외 — 전환 선언이 "보여줄게"라고 말하는 건 미래 '연출'의 예고지 show 약속이 아니다.)
    const missing =
      !parsed.show &&
      kind === 'user' &&
      !closingStage &&
      promisesToShow(parsed.say) &&
      chapterMoments.length > 0
    // show를 넣으면서 장면 묘사·질문까지 미리 말한 경우(실측 2026-08-05: 다음 상황 턴과
    // 같은 대사가 두 번 반복된다) — 질문으로 끝나는 say가 그 신호다. 재생성으로 줄인다.
    const early =
      !forbidden && parsed.show && kind === 'user' && /[?？]\s*$/.test((parsed.say || '').trim())
    // 조기 전환 선언(실측 2026-08-06): 과거 장이 안 끝났는데(장면 2개 시점) Gemini가 전환 멘트를
    // 지어내면 "보여줄게"가 missing 폴백을 오발시켜 "미래를 보여줄게" + 3살 과거 장면이라는
    // 기괴한 조합이 나온다. 전환 선언은 종결 시퀀스(closingStage)에서만 정당하다 — 재생성.
    const premature =
      !parsed.show &&
      f.chapter === 'past' &&
      !closingStage &&
      kind === 'user' &&
      /죽지 않고|미래로 가|미래로 갈|인생을 살아간다면/.test(parsed.say || '')
    violation = forbidden
      ? 'forbidden'
      : premature
        ? 'premature'
        : missing
          ? 'missing'
          : early
            ? 'early'
            : null
    if (!violation) break
    if (forbidden) {
      console.warn(
        `[server] 금지된 show (id ${parsed.show.id}, ${kind === 'event' ? '상황 턴 에코' : closingStage ? '종결 시퀀스' : '이미 본 장면'}) — ${attempt === 0 ? '재생성' : 'show만 버림'}`
      )
      if (attempt === 1) parsed.show = null
    } else if (early) {
      // 재시도까지 어기면 그대로 내보낸다 — 반복은 감상 턴의 '반복 금지' 지시가 흡수한다(최후 허용).
      console.warn(
        `[server] show 턴에서 묘사·질문 선발화 — ${attempt === 0 ? '재생성' : '그대로 진행'} · 원문: ${lastRaw.replace(/\s+/g, ' ').slice(0, 220)}`
      )
    } else if (premature) {
      // 재시도까지 어기면 그대로 말은 내보내되, 아래 show 폴백은 걸지 않는다(장면 오발 방지).
      console.warn(
        `[server] 조기 전환 선언 (과거 장 미종료, videosShown ${f.videosShown}) — ${attempt === 0 ? '재생성' : '그대로 진행(폴백 억제)'} · 원문: ${lastRaw.replace(/\s+/g, ' ').slice(0, 220)}`
      )
    } else {
      console.warn(
        `[server] show 누락 (데려간다는 약속만 있음) — ${attempt === 0 ? '재생성' : '서버 폴백 장면 선택'} · 원문: ${lastRaw.replace(/\s+/g, ' ').slice(0, 220)}`
      )
    }
  }
  // 최후 방어: 재시도까지 show를 빠뜨렸으면 서버가 직접 고른다 — "가보자"라고 말해놓고
  // 화면이 그대로인 것보다, 아직 안 본 장면 하나라도 뜨는 게 전시로는 옳다.
  // (조기 전환 선언이 재시도까지 남았으면 폴백을 걸지 않는다 — "미래를 보여줄게" 직후
  //  엉뚱한 과거 장면이 뜨는 오발을 막는다. 화면은 그대로, 말만 나간다.)
  if (
    !parsed.show &&
    kind === 'user' &&
    !closingStage &&
    violation !== 'premature' &&
    promisesToShow(parsed.say)
  ) {
    const unseen = chapterMoments.filter((m) => !f.seenIds.includes(m.id))
    if (unseen.length) {
      // 발화에서 시기 단서를 찾는다 — 연도("2010년")가 우선, 없으면 나이 숫자. 그 시기에 가장
      // 가까운 장면, 둘 다 없으면 첫 장면. (연도를 나이 정규식 /\d{2}/로 읽으면 "2010"에서
      // "20"을 뽑는 오독이 났다 — 2026-08-10 수정.)
      const yearHint = (userText.match(/\b(?:19|20)\d{2}\b/) || [])[0]
      const birthYear = unseen[0].year - unseen[0].age
      const hint = yearHint
        ? parseInt(yearHint, 10) - birthYear
        : parseInt((userText.match(/(\d{1,2})\s*(?:살|세)/) || [])[1], 10)
      const pick = Number.isFinite(hint)
        ? unseen.reduce((best, m) =>
            Math.abs(m.age - hint) < Math.abs(best.age - hint) ? m : best
          )
        : unseen[0]
      parsed.show = { id: pick.id, exact: false }
      console.warn(`[server] show 폴백 — 서버가 장면 ${pick.id}(${pick.age}살) 선택`)
    }
  }

  // 방금 던진 사색적 질문 id 기록 — 다음 턴부터 목록에 "(이미 던졌다)"가 붙는다.
  if (parsed.q && !f.usedQuestions.includes(parsed.q)) f.usedQuestions.push(parsed.q)

  // show 해석 — 현재 장(chapter)의 장면 안에서만. id가 목록에 없으면 나이 근접 폴백(exact=false).
  let video = null
  if (parsed.show && chapterMoments.length) {
    const wantId = String(parsed.show.id)
    let m = chapterMoments.find((x) => String(x.id) === wantId)
    let exact = parsed.show.exact === true
    if (!m) {
      const n = parseInt(wantId, 10)
      m = Number.isFinite(n)
        ? chapterMoments.reduce((best, x) =>
            Math.abs(x.age - n) < Math.abs(best.age - n) ? x : best
          )
        : chapterMoments[chapterMoments.length - 1]
      exact = false
    }
    if (m)
      video = {
        id: m.id,
        age: m.age,
        year: m.year,
        scene: m.scene,
        url: m.url,
        exact,
        // 미래 장면: 지금 나이 기준 남은 햇수 — 클라이언트 상황 알림·대사에서 "약 n년 뒤"로 쓴다.
        yearsAhead: m.isFuture ? m.age - (ctx.catalog?.currentAge ?? m.age) : undefined
      }
    // 이미 보여준 장면을 다시 show하면(감상 턴에서 습관적으로 반복하는 오류) 무시한다 —
    // 같은 영상이 다시 뜨며 카운터가 헛돌게 두지 않는다.
    if (video && f.seenIds.includes(video.id)) video = null
  }
  // 시기 검증(2026-08-10): 관람객이 이번 발화에 연도("2010년")나 나이("서른일곱 살"의 숫자형)를
  // 명시했는데 Gemini가 크게 어긋난 나이의 장면을 골랐으면(실측: "2010년" 요청에 3살 장면),
  // 서버가 그 시기와 가장 가까운 안 본 장면으로 교체한다(exact=false). show 턴의 say는
  // "기다려봐…" 데려가는 말뿐이라(묘사 금지 규칙) 영상만 바꿔도 어긋나지 않는다.
  // 유령이 장면을 고르는 분기 큐레이션(branch)은 관람객 요청이 아니므로 건드리지 않는다.
  if (video && kind === 'user' && !f.branch && chapterMoments.length) {
    const yearMatch = userText.match(/\b(?:19|20)\d{2}\b/)
    const ageMatch = userText.match(/(\d{1,2})\s*(?:살|세)/)
    const birthYear = chapterMoments[0].year - chapterMoments[0].age // 카탈로그 year는 출생연도+나이
    const wantAge = yearMatch
      ? parseInt(yearMatch[0], 10) - birthYear
      : ageMatch
        ? parseInt(ageMatch[1], 10)
        : null
    if (wantAge != null && Math.abs(video.age - wantAge) > 7) {
      const unseen = chapterMoments.filter((m) => !f.seenIds.includes(m.id))
      if (unseen.length) {
        const pick = unseen.reduce((best, m) =>
          Math.abs(m.age - wantAge) < Math.abs(best.age - wantAge) ? m : best
        )
        if (pick.id !== video.id) {
          console.warn(
            `[server] 시기 불일치 교정 — 요청 "${yearMatch ? `${yearMatch[0]}년` : `${wantAge}살`}"(≈${wantAge}살)인데 ` +
              `${video.age}살 장면(${video.id})이 선택됨 → ${pick.id}(${pick.age}살)로 교체`
          )
          video = {
            id: pick.id,
            age: pick.age,
            year: pick.year,
            scene: pick.scene,
            url: pick.url,
            exact: false,
            yearsAhead: pick.isFuture ? pick.age - (ctx.catalog?.currentAge ?? pick.age) : undefined
          }
        }
      }
    }
  }
  // 최후 방어(2026-08-06): 종결 시퀀스에 장면이 끼면 아래 video 분기가 장 전환·종료를 무산시킨다 —
  // 위 재생성 루프가 어떤 경로로든 놓쳐도 여기서 반드시 버린다.
  if (video && closingStage) {
    console.warn(`[server] 종결 시퀀스의 show(장면 ${video.id}) 최종 차단 — 전환/종결을 지킨다`)
    video = null
  }

  // 단계 상태 갱신: 영상을 새로 띄웠으면 카운터 리셋. 각 장의 마지막 답이 끝나면 —
  // 1장(과거)은 2장(미래)으로 전환(이번 응답이 "이제 넌, 미래로 갈 거야…" 전환 발화),
  // 2장(미래)은 체험 종료.
  let chapterTurned = false
  if (video) {
    // 전체 기록에 장면 전환도 남긴다 — 3차 외삽 때 "어떤 장면을 보며 나눈 대화인지"의 맥락.
    ghostTranscriptAll.push({
      who: '장면',
      text: `${video.age}살 — ${video.scene || `장면 ${video.id}`}`,
      chapter: f.chapter,
      at: Date.now()
    })
    f.videosShown++
    f.replies = 0
    f.seenIds.push(video.id)
    f.lastAge = video.age
    if (!f.seenAges.includes(video.age)) f.seenAges.push(video.age)
    // 장면 이동 돔 안무는 여기(응답 생성 시점)가 아니라 클라이언트가 TTS를 끝내고 영상을 띄우는
    // 순간 POST /api/dome-scene으로 트리거한다 — 발화와 장면 등장 사이의 시차를 돔이 따라가게.
  } else if (
    f.videosShown >= (GHOST_CHAPTER_TARGETS[f.chapter] ?? 3) &&
    kind === 'user' &&
    // 마지막 장면의 박자 — 1장: 사색적 질문 → 마지막 질문 → 전환 선언. 전환은 replies 카운터가
    // 아니라 '직전 유령 발화가 마지막 질문이었나'로 판정한다 — 질문과 같은 턴에 전환이 실리거나
    // (STT 발화 쪼개짐 등으로 카운터가 헛돌 때) 대답을 안 듣고 넘어가는 일이 없다(2026-08-05).
    // 2장: 사색적 질문 → 꼬리 질문 → 마지막 질문(과거·미래 잇기) → 종결 발화(replies 3에서 종료).
    // (질문 다이어트 2026-08-05: 미래 꼬리 박자 제거 — 사색적 질문 → 마지막 질문 → 종결, 3→2)
    // 2장 종료도 카운터가 아니라 발화 내용을 함께 본다 — Gemini가 종결을 앞당겨 말했으면
    // (futureClosingSaid) 그다음 사람 대답이 곧 마지막 대답이다(2026-08-06 중복 종결 수정).
    (f.chapter === 'past' ? pastFinalAsked() : f.replies >= 2 || futureClosingSaid())
  ) {
    if (f.chapter === 'past') {
      f.chapter = 'future' // 이번 응답으로 미래의 장이 열렸다 — 카운터를 새 장 기준으로 리셋
      f.videosShown = 0
      f.replies = 0
      f.seenAges = []
      f.lastAge = null
      chapterTurned = true
    } else {
      f.ended = true // 미래 장의 마지막 질문에 답했다 — 이번 화답을 끝으로 조용히 저문다
    }
  }

  if (parsed.say) {
    ghostHistory.push({ who: '유령', text: parsed.say })
    // 전환 발화("이제 넌, 미래로 갈 거야…")는 새로 열린 장(future) 쪽에 남는다 — f.chapter는 위에서 이미 갱신됨.
    ghostTranscriptAll.push({ who: '유령', text: parsed.say, chapter: f.chapter, at: Date.now() })
  }
  // 2장 개막: 미래 큐레이션은 미래 릴 위 내레이션으로 흐르고(futureReel.narration, 2026-08-06),
  // 릴이 끝난 뒤 시스템이 대신 말하는 발화는 고정 질문 FUTURE_ASK만.
  const futureReelNarr = chapterTurned
    ? await futureRecapFor(library?.personaId ?? '(none)')
    : null
  if (chapterTurned) {
    // 고정 질문도 기록에 남긴다 — 다음 턴의 Gemini가
    // "무엇을 물은 상태인지" 알아야 사람의 대답(보고 싶은 미래)을 제대로 받는다.
    ghostHistory.push({ who: '유령', text: FUTURE_ASK })
    ghostTranscriptAll.push({ who: '유령', text: FUTURE_ASK, chapter: f.chapter, at: Date.now() })
    // 2장 개막 돔 안무는 클라이언트가 전환 발화(TTS)를 끝내고 연출을 시작하는 순간
    // POST /api/dome-future로 트리거한다 — 발화 중에 돔이 먼저 움직이지 않게.
  }
  persistGhostTranscript() // 턴마다 전체 기록을 Firebase 정본에 업서트(비동기, 실패해도 대화 계속)
  // 읽기 좋은 로그: [유령] 대사 (+ 띄운 장면 표시). 원문 JSON은 파싱 실패로 say가 비었을 때만 남긴다.
  rememberGhostSay(parsed.say)
  if (chapterTurned) rememberGhostSay(FUTURE_ASK)
  if (parsed.say || video) {
    console.log(
      `[유령] ${parsed.say}${video ? ` [시작] 장면 ${video.id} (${video.age}살, exact=${video.exact})` : ''}` +
        `${chapterTurned ? ' — 2장(미래) 시작' : ''}${f.ended ? ' — 체험 종료' : ''}`
    )
  } else {
    console.warn(
      `[server] 유령 응답 파싱 실패 — 원문: ${String(lastRaw ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 220)}`
    )
  }
  // chapterTurned: 이번 응답이 "이제 넌, 미래로 갈 거야…" 전환 발화다 — 클라이언트(ghost-voice)가
  // 이 신호로 직전 과거 장면 영상을 걷고 유령 idle 앰비언트로 화면을 되돌린다(발화와 함께).
  // 2차 플로우(2장·미래)의 진입 연출 — 클라이언트가 이 순서로 재생한다(ghost-voice runBridge):
  //   직전 과거 장면 걷기 → ⓪ 실타래 감아올리기(10배속 가속 — 1차 개막 spinup과 같은 문법)
  //   → ① 90세 장례식 영상 → TV 암전 → ② 미래 릴 필름스트립 1사이클
  //   → ③ 유령의 전환 발화("이제 넌, 미래로 갈 거야…").
  // 1차가 "현재의 죽음 → 암전 → 주마등(되감기)"으로 열리는 것과 같은 문법이고, 여기선 이대로
  // 살았을 때의 죽음을 먼저 보고 그 뒤 미래가 순방향으로 풀려나간다.
  // 각 재료는 없으면 그 단계만 건너뛴다(장례식 미영상화·미래 릴 미생성이어도 대화는 이어진다).
  // ⓪ 실타래 감아올리기 — 과거 장이 닫힌 유령 idle에서 실타래가 10배속까지 감아 올라간 뒤
  //   어둠을 거쳐 90세 장례식으로 넘어간다. 길이는 1차 개막 spinup과 공유(spinupMs).
  //   say: 모션 직전에 유령이 짧게 못박는 개막 선언(클라이언트가 spinup 전에 말한다).
  // 전환 선언(에이전트가 만든 대사)은 연출보다 먼저 나간다 — spinup.say로 전달.
  const spinup = chapterTurned
    ? { ms: DEMO_SPINUP_MS, mul: 10, say: parsed.say || '이젠, 미래로 갈 거야.' }
    : null
  const funeral =
    chapterTurned && DEMO_FUNERAL_ENABLED
      ? (() => {
          const url = funeralMediaUrl('future')
          if (!url)
            console.warn(
              '[server] 2차 전환: 90세(future) 장례식 영상 없음 — 건너뜀(admin에서 미래 장례식 영상화 필요)'
            )
          return url
            ? {
                url,
                variant: 'future',
                blackoutMs: DEMO_FUNERAL_BLACKOUT_MS,
                sceneMs: DEMO_FUNERAL_SCENE_MS
              }
            : null
        })()
      : null
  const futureReel =
    chapterTurned && reelFuturePlaylist.length
      ? {
          photos: reelFuturePlaylist, // 순방향(현재 다음 해 → 90세)
          secPerTurn: DEMO_ROTATE_SEC,
          gutterFrac: montageConfig.demo?.filmstripGutterFrac ?? 0.05,
          // 릴 위 미래 큐레이션("이대로 지속된다면 넌 ○○를 하고, ○○해") — 없으면 릴만 조용히.
          ...(futureReelNarr
            ? {
                narration: futureReelNarr,
                narrationGapMs: (montageConfig.demo?.reelNarrationGapSec ?? 3) * 1000
              }
            : {})
        }
      : null
  // 전환 턴: 에이전트 대사는 spinup.say(연출 앞)로 나갔으니, 릴(+큐레이션) 뒤에는 고정 질문을 잇는다.
  return {
    say: chapterTurned ? FUTURE_ASK : parsed.say,
    video,
    end: f.ended,
    chapterTurned,
    spinup,
    funeral,
    futureReel
  }
}

// 문장 경계(./!/?/… 뒤 공백)마다 <break> 태그를 끼워 넣는다 — 이어 말할 때 문장 사이가 붙어
// 어색한 것을 막는다. 태그는 발음되지 않고 그 길이만큼 쉼이 된다. montage.json
// ghost.voice.sentenceBreak(초, 0이면 끔, 기본 0.6)로 조절. 이미 <break>가 있는 텍스트는 그대로 둔다.
// 에이전트 멘트 로그 — 브라우저가 실제로 소리 내는 발화(개막 회고·국면 내레이션 등)가
// TTS 중계를 지나므로 여기서 한 줄로 남긴다. <break> 태그는 '…'로 치환해 읽기 좋게. 같은 문장이
// 여러 번 요청돼도(재시도 등) 매번 남긴다 — 실제 발화 시도의 기록이다.
// 단, 유령 대화 턴 대사는 이미 [유령]으로 찍혔으니 여기선 건너뛴다 — 같은 대사가
// [유령]/[멘트] 두 프리픽스로 겹쳐 찍혀 로그가 헷갈리는 것을 막는다(2026-08-10).
// 최근 대사 몇 개만 기억하면 충분하다(TTS 요청은 발화 직후에 온다). 문장 단위로 쪼개져
// 와도 잡히게 부분 문자열 포함으로 비교한다.
const recentGhostSays = []
function rememberGhostSay(text) {
  const t = normalizeSpokenText(text)
  if (!t) return
  recentGhostSays.push(t)
  if (recentGhostSays.length > 8) recentGhostSays.shift()
}
function normalizeSpokenText(text) {
  return String(text ?? '').replace(/<break[^>]*\/?>/g, ' ').replace(/\s+/g, ' ').trim()
}
function logAgentLine(text) {
  const t = normalizeSpokenText(text)
  if (recentGhostSays.some((s) => s.includes(t))) return // [유령]으로 이미 남은 대사
  console.log(`[멘트] ${text.replace(/<break[^>]*\/?>/g, ' … ').replace(/\s+/g, ' ').trim()}`)
}

// 내레이션을 TTS 요청 단위로 쪼갠다 — 클라이언트(renderer playNarration)와 같은 규칙:
// <break> 태그는 경계(정적은 클라이언트가 스케줄), 나머지는 문장 단위. 장문을 통짜로 합성하면
// ElevenLabs가 낭독조로 톤을 틀어버려서(2026-08-06), 대화 턴과 같은 짧은 입력으로 맞춘다.
// 여기서는 문장 단위 예열(elevenTtsBuffer)에 쓴다 — 클라이언트 GET이 캐시에 바로 맞도록.
function narrationChunks(text) {
  return String(text)
    .replace(/<break[^>]*\/?>/g, '\n')
    .split(/\n+|(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function withSentenceBreaks(text) {
  const sec = montageConfig.ghost?.voice?.sentenceBreak ?? 0.6
  if (!sec || /<break\b/.test(text)) return text
  return text.replace(/([.!?…])(["'」』)]*)\s+/g, `$1$2 <break time="${sec}s" /> `)
}

// ElevenLabs 순수 TTS — 키는 서버에만. 실패는 throw(라우트가 503 → 브라우저 TTS 폴백).
// fetch 응답 자체를 돌려주는 저수준 헬퍼 — 스트리밍 라우트가 body를 그대로 파이프한다.
async function elevenTtsFetch(text) {
  const vcfg = montageConfig.ghost?.voice || {}
  const apiKey = await readElevenKey()
  if (!apiKey) throw new Error('ElevenLabs API 키 없음')
  const voiceId = vcfg.voiceId
  if (!voiceId) throw new Error('voiceId 미설정')
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: withSentenceBreaks(text),
        model_id: vcfg.ttsModelId || 'eleven_flash_v2_5',
        // speed: 발화 템포(0.7~1.2, 1=기본). 재생 속도 변조가 아니라 모델이 그 템포로 자연스럽게
        // 발화한다. montage.json ghost.voice.speed로 조절.
        // stability를 명시하지 않으면 요청마다 톤 편차가 크다(발화마다 다른 목소리처럼 들리는 원인).
        // 높게 고정해 대화 턴·내레이션이 같은 결로 나오게 한다. montage.json ghost.voice.stability로 조절.
        voice_settings: {
          speed: vcfg.speed ?? 1.0,
          stability: vcfg.stability ?? 0.75,
          similarity_boost: vcfg.similarityBoost ?? 0.75
        }
      })
    }
  )
  if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r
}

// 완성 버퍼가 필요한 곳(회고 예열·POST 라우트)용. 최근 합성분을 캐시해 같은 문장(특히 회고 첫 마디)은
// ElevenLabs 왕복 없이 즉시 나간다.
const ttsCache = new Map() // text → Buffer (삽입 순 — 오래된 것부터 밀어낸다)
async function elevenTtsBuffer(text) {
  const hit = ttsCache.get(text)
  if (hit) return hit
  const r = await elevenTtsFetch(text)
  const buf = Buffer.from(await r.arrayBuffer())
  ttsCache.set(text, buf)
  // 문장 단위 예열(회고+장례식 내레이션이 각각 여러 청크)이라 상한을 넉넉히 — 밀려나면 예열이 무의미해진다.
  if (ttsCache.size > 48) ttsCache.delete(ttsCache.keys().next().value)
  return buf
}

// ── HTTP 헬퍼 (admin-server 패턴) ────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav'
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(body))
}

// 파일 서빙 (Range 지원 — <video> 시킹). CORS 허용(WebGL 텍스처 오염 방지 — 기존 zoe: ACAO 역할).
async function serveFile(req, res, absPath, mime) {
  let stat
  try {
    stat = await fs.stat(absPath)
  } catch {
    return sendJson(res, 404, { error: 'not found' })
  }
  const range = req.headers.range
  const base = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*'
  }
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    const start = m && m[1] ? parseInt(m[1], 10) : 0
    const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
      return res.end()
    }
    res.writeHead(206, {
      ...base,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1
    })
    return createReadStream(absPath, { start, end }).pipe(res)
  }
  res.writeHead(200, { ...base, 'Content-Length': stat.size })
  createReadStream(absPath).pipe(res)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf-8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

// ── 서버 ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const parts = url.pathname.split('/').filter(Boolean)
  try {
    // ---- 라이브러리 미디어: GET /media/<library 상대경로> (CORS, Range) ----
    if (req.method === 'GET' && parts[0] === 'media') {
      const rel = parts.slice(1).map(decodeURIComponent).join('/')
      const abs = path.normalize(path.join(libraryRoot, rel))
      if (!abs.startsWith(path.normalize(libraryRoot))) {
        return sendJson(res, 403, { error: 'forbidden' }) // 경로 탈출 차단
      }
      return serveFile(req, res, abs, MIME[path.extname(abs)] || 'application/octet-stream')
    }

    // ---- 정적 리소스: GET /resources/<파일> (배경음악·아이콘 등, CORS·Range) ----
    if (req.method === 'GET' && parts[0] === 'resources') {
      const resRoot = path.resolve(root, 'resources')
      const rel = parts.slice(1).map(decodeURIComponent).join('/')
      const abs = path.normalize(path.join(resRoot, rel))
      if (!abs.startsWith(resRoot)) {
        return sendJson(res, 403, { error: 'forbidden' }) // 경로 탈출 차단
      }
      if (!existsSync(abs) || !(await fs.stat(abs)).isFile()) {
        return sendJson(res, 404, { error: 'not found' })
      }
      return serveFile(req, res, abs, MIME[path.extname(abs)] || 'application/octet-stream')
    }

    // ---- 부트스트랩 ----
    if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
      return sendJson(res, 200, bootstrapPayload())
    }

    // ---- 유령 음성 대화 세션 발급 — 'ghost' 국면에서 브라우저가 호출(서명 URL은 서버가 발급) ----
    if (req.method === 'GET' && url.pathname === '/api/ghost/session') {
      return sendJson(res, 200, await ghostSessionPayload())
    }

    // ---- 유령 브리지 대화 턴 — 브라우저 STT 인식 결과(kind='user') 또는 영상이 뜬 뒤의 상황
    // 알림(kind='event')을 받아 Gemini의 다음 대사와 띄울 장면을 돌려준다(engine 'bridge' 전용). ----
    if (req.method === 'POST' && url.pathname === '/api/ghost/turn') {
      const body = await readBody(req)
      const text = String(body?.text ?? '').trim()
      if (!text) return sendJson(res, 400, { error: 'text 필요' })
      try {
        return sendJson(
          res,
          200,
          await ghostBridgeTurn(text, body?.kind === 'event' ? 'event' : 'user')
        )
      } catch (err) {
        console.warn(`[server] 유령 브리지 턴 실패: ${err.message}`)
        return sendJson(res, 500, { error: err.message })
      }
    }

    // ---- 유령 브리지 STT 토큰 — OpenAI 키는 서버에만, 브라우저엔 10분짜리 ephemeral만. ----
    // 실패 시 503 → 브라우저는 Web Speech STT로 폴백한다(유령이 귀를 잃지 않는다).
    if (req.method === 'POST' && url.pathname === '/api/ghost/stt-token') {
      try {
        return sendJson(res, 200, { value: await openaiRealtimeToken() })
      } catch (err) {
        console.warn(`[server] 유령 STT 토큰 실패(Web Speech 폴백): ${err.message}`)
        return sendJson(res, 503, { error: err.message })
      }
    }

    // ---- 유령 브리지 TTS 중계 — ElevenLabs 키는 서버에만. 실패 시 503(브라우저 TTS 폴백). ----
    // GET(?text=…)이 기본: <audio src>가 첫 청크부터 점진 재생해 발화 시작 지연을 크게 줄인다.
    // 캐시 적중(예열된 회고 첫 마디)은 버퍼로 즉시. POST는 완성 버퍼 응답(구형 경로 호환).
    if (req.method === 'GET' && url.pathname === '/api/ghost/tts') {
      const text = String(url.searchParams.get('text') ?? '').trim()
      if (!text) return sendJson(res, 400, { error: 'text 필요' })
      logAgentLine(text)
      try {
        const cached = ttsCache.get(text)
        if (cached) {
          res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Content-Length': cached.length,
            'Access-Control-Allow-Origin': '*'
          })
          return res.end(cached)
        }
        const r = await elevenTtsFetch(text)
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Access-Control-Allow-Origin': '*' })
        return Readable.fromWeb(r.body).pipe(res)
      } catch (err) {
        console.warn(`[server] 유령 TTS 실패(브라우저 TTS 폴백): ${err.message}`)
        return sendJson(res, 503, { error: err.message })
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/ghost/tts') {
      const body = await readBody(req)
      const text = String(body?.text ?? '').trim()
      if (!text) return sendJson(res, 400, { error: 'text 필요' })
      logAgentLine(text)
      try {
        const audio = await elevenTtsBuffer(text)
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': audio.length,
          'Access-Control-Allow-Origin': '*'
        })
        return res.end(audio)
      } catch (err) {
        console.warn(`[server] 유령 TTS 실패(브라우저 TTS 폴백): ${err.message}`)
        return sendJson(res, 503, { error: err.message })
      }
    }

    // ---- SSE 상태 스트림 (main→renderer 방송 대체) ----
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      })
      res.write('retry: 2000\n\n') // 끊기면 2s 후 재연결
      sseClients.add(res)
      const keepalive = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          /* 아래 close에서 정리 */
        }
      }, 15000)
      req.on('close', () => {
        clearInterval(keepalive)
        sseClients.delete(res)
      })
      return
    }

    // ---- renderer → server 입력 ----
    if (req.method === 'POST' && url.pathname === '/api/input') {
      await readBody(req) // { action } — Enter 하나가 상태별 의미 결정(§8)
      sm?.handleEnter()
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/video-ready') {
      const body = await readBody(req)
      sm?.onVideoReady(body?.projectorIndex ?? 0)
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/freeze-ready') {
      await readBody(req)
      // FREEZE 배리어는 단일 페이지에서 자동 충족 — 신호 경로만 유지(향후 확장 대비).
      return sendJson(res, 200, { ok: true })
    }
    // ---- 돔 비상 정지 (런타임 페이지 숨은 트리거: ESC / 좌하단 더블클릭) ----
    // 진행 중 안무를 끊고 즉시 's'. 체험 흐름은 건드리지 않는다 — 다음 국면 전환에 새 큐가 오면
    // 다시 움직이므로, 완전히 세워두려면 admin 세션 나가기(idle 큐 's')와 함께 쓴다.
    // ---- 돔 피날레 안무 — 체험 종료(실타래 역감기 모션) 시작 시 renderer가 호출 ----
    // 기본: 'f' 7초 → 's'(정지). montage.json dome.cues.ghostFinale로 교체 가능.
    if (req.method === 'POST' && url.pathname === '/api/dome-finale') {
      await readBody(req)
      domeCue(
        DOME_CUES.ghostFinale ?? {
          steps: [
            { c: 'f', ms: 7000 },
            { c: 's', ms: 0 }
          ]
        }
      )
      console.log(`[dome] 피날레 안무 — 'f' 7초 후 정지`)
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/dome-stop') {
      domeCue('s')
      console.warn('[dome] 비상 정지 수신 — 안무 중단 + 정지')
      return sendJson(res, 200, { ok: true })
    }
    // 돔 수동 제어(런타임 하단 희미한 ◀■▶ 버튼) — 진행 중 안무를 끊고 해당 명령을 즉시 보낸다.
    // 누른 타이밍을 기록해 안무 초안으로 변환한다(/api/dome-record) — 손맛으로 시연한 생동감을
    // spinup 큐(steps)로 옮기는 용도. 30초 이상 쉬면 새 시연으로 간주하고 기록을 비운다.
    if (req.method === 'POST' && url.pathname === '/api/dome-cmd') {
      const body = await readBody(req)
      const c = ['f', 'b', 's', 'h', 'z'].includes(body?.c) ? body.c : null
      if (!c) return sendJson(res, 400, { ok: false, error: 'bad cmd' })
      const now = Date.now()
      if (domeManualLog.length && now - domeManualLog[domeManualLog.length - 1].at > 30000)
        domeManualLog = []
      domeManualLog.push({ c, at: now })
      domeCue(c)
      return sendJson(res, 200, { ok: true, c })
    }
    // 장면 이동 돔 안무 — 클라이언트(ghost-voice)가 TTS 종료 후 장면 영상을 띄우는 순간 호출.
    if (req.method === 'POST' && url.pathname === '/api/dome-scene') {
      domeCue(DOME_CUES.ghostScene)
      return sendJson(res, 200, { ok: true })
    }
    // 2장(미래) 개막 돔 안무 — 클라이언트가 전환 발화(TTS)를 끝내고 개막 연출을 시작하는 순간 호출.
    if (req.method === 'POST' && url.pathname === '/api/dome-future') {
      domeCue(DOME_CUES.ghostFuture)
      return sendJson(res, 200, { ok: true })
    }
    // 마지막 수동 시연을 안무(steps)로 변환해 반환 — 각 명령의 ms = 다음 명령까지의 간격(50ms 반올림).
    if (url.pathname === '/api/dome-record') {
      const steps = domeManualLog.map((e, i) => {
        const next = domeManualLog[i + 1]
        const ms = next ? Math.round((next.at - e.at) / 50) * 50 : 0
        return { c: e.c, ms }
      })
      return sendJson(res, 200, { steps })
    }
    if (req.method === 'POST' && url.pathname === '/api/view-toggle') {
      toggleDevPreview()
      return sendJson(res, 200, { preview: devPreview })
    }

    // ---- 설치 캘리브레이션 저장 (런타임 페이지 실시간 조정) ----
    if (req.method === 'POST' && url.pathname === '/api/calibration') {
      const body = await readBody(req)
      calibration = await writeCalibration(libraryRoot, { yaw: body?.yaw, pitch: body?.pitch })
      return sendJson(res, 200, { ok: true, calibration })
    }

    // reel 데모 수동 트리거(테스트용 — 참가자 교체 없이 현재 페르소나로 시퀀스 실행).
    // { phase:'ghost' } 를 주면 spinup·reel을 건너뛰고 유령(음성) 국면으로 바로 점프한다(음성 반복 테스트용).
    if (req.method === 'POST' && url.pathname === '/api/reel-demo') {
      const body = await readBody(req)
      if (body?.phase === 'ghost') {
        enterGhostPhase()
        return sendJson(res, 200, { ok: true, phase: 'ghost' })
      }
      runReelDemo(Number.isFinite(body?.spinupMs) ? body.spinupMs : undefined)
      return sendJson(res, 200, { ok: true, reel: reelMediaUrl() })
    }

    // reel(회전) 한 바퀴 완료 신호 — 클라이언트가 전 이미지를 1회 순회하면 보낸다(Q/W로 빨라지면 조기 도착).
    // 대화(유령)로 조기 전환. reel 국면일 때만(중복·stale 무시). 기본 속도면 서버 폴백 타이머와 같은 시점.
    if (req.method === 'POST' && url.pathname === '/api/reel-done') {
      await readBody(req)
      if (demo.phase === 'reel') enterGhostPhase()
      return sendJson(res, 200, { ok: true })
    }

    // 장례식 영상 종료 + TV 암전 연출까지 끝났다는 클라이언트 신호 → 장지 국면(1차, 있으면)
    // 또는 주마등. startGravePhase가 2차·영상 없음이면 스스로 주마등으로 넘긴다.
    if (req.method === 'POST' && url.pathname === '/api/funeral-done') {
      await readBody(req)
      if (demo.phase === 'funeral') startGravePhase()
      return sendJson(res, 200, { ok: true })
    }

    // 장지 영상 종료 + 암전 연출까지 끝났다는 클라이언트 신호 → 주마등 시작(역순 재생).
    if (req.method === 'POST' && url.pathname === '/api/grave-done') {
      await readBody(req)
      if (demo.phase === 'grave') startReelPhase()
      return sendJson(res, 200, { ok: true })
    }

    // reel 진행 heartbeat — 회전 중 주기적으로 도착. 안전 폴백(deadman)을 리셋해, Q로 느리게 해도
    // (회전이 길어져도) 서버가 중간에 끊지 않게 한다(느린 쪽 보장). reel 국면일 때만 유효.
    if (req.method === 'POST' && url.pathname === '/api/reel-progress') {
      await readBody(req)
      if (demo.phase === 'reel') armReelDeadman()
      return sendJson(res, 200, { ok: true })
    }

    // ---- 개발용 Space(재생/정지) 트리거도 열어둔다(선택). ----
    if (req.method === 'POST' && url.pathname === '/api/toggle-play') {
      sm?.togglePlay()
      return sendJson(res, 200, { ok: true })
    }

    // ---- 정적: 빌드된 renderer(dist) ----
    if (req.method === 'GET') {
      // SPA 단일 진입 — /(과 알 수 없는 경로)는 index.html.
      const relPath = parts.length === 0 ? 'index.html' : parts.map(decodeURIComponent).join('/')
      const abs = path.normalize(path.join(DIST, relPath))
      if (!abs.startsWith(path.normalize(DIST))) return sendJson(res, 403, { error: 'forbidden' })
      if (existsSync(abs) && (await fs.stat(abs)).isFile()) {
        return serveFile(req, res, abs, MIME[path.extname(abs)] || 'application/octet-stream')
      }
      // 빌드 산출물이 없으면 안내.
      const indexHtml = path.join(DIST, 'index.html')
      if (!existsSync(indexHtml)) {
        return sendJson(res, 404, {
          error:
            'dist 없음 — 먼저 `npm run build` 하거나 dev는 `npm run dev`(vite 프록시)로 접속하세요.'
        })
      }
      return serveFile(req, res, indexHtml, MIME['.html'])
    }

    return sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    console.error('[server] 요청 처리 오류:', err)
    return sendJson(res, 500, { error: err.message })
  }
})

// ── 부팅 ─────────────────────────────────────────────────────────────
// 어떤 참가자를 재생할지: admin 세션 포인터(_session.json) 최우선, 없으면 montage.json 고정 personaId,
// 그것도 없으면 자동(최근). 라이브러리가 없으면 서버는 뜨되 IDLE 앰비언트만 동작.

// 세션 포인터 정본(Firestore 'runtime/session') 채택 — 다른 머신 admin이 지정한 세션을 부팅 시
// 이어받는다. 아직 파일 감시가 걸리기 전이라 reel 데모는 트리거되지 않고 조용히 로드만 된다.
// 정본 문서가 없거나 Firebase 미연결이면 로컬 파일 그대로(기존 동작).
if (firebaseReady) {
  try {
    const cloud = await fetchRuntimeSession()
    const local = await readSession(libraryRoot)
    if (cloud?.personaId) {
      if (!local || local.personaId !== cloud.personaId || local.selectedAt !== cloud.selectedAt) {
        await writeSession(libraryRoot, cloud) // selectedAt 보존 — 감시 중복 판정과 일치
        console.log(`[server] 세션 정본 채택: ${cloud.name || cloud.personaId}`)
      }
    } else if (cloud && local) {
      // 정본이 명시적 '세션 나가기'(personaId:null) 상태 — 로컬 잔재를 지우고 IDLE로 부팅.
      await clearSession(libraryRoot)
      console.log('[server] 세션 정본이 해제 상태 — 로컬 세션 포인터 제거')
    }
  } catch (e) {
    console.warn(`[server] 세션 정본 조회 실패(로컬로 진행): ${e.message}`)
  }
}

const session = await readSession(libraryRoot)
const initialPersonaId = session?.personaId ?? montageConfig.personaId ?? null
currentExperience = session?.experience === 'second' ? 'second' : 'first'
if (session) console.log(`[server] 세션 참가자: ${session.name || session.personaId}`)
await loadPersona(initialPersonaId)

// 세션 포인터 감시 — 연구자가 admin에서 참가자를 바꾸면(_session.json 갱신) 런타임이 따라간다.
// 중복 판정은 selectedAt로 한다(admin이 '세션으로'를 누를 때마다 새로 찍힘). 부팅 시 이미 있던
// 선택의 selectedAt를 기억해, 그 참가자가 부팅 자동로드와 같더라도 admin에서 다시 누르면 재생된다.
let lastHandledSelectedAt = session?.selectedAt ?? null
let sessionActive = Boolean(session) // 현재 세션이 걸려 있는가 — 삭제(세션 나가기) 감지·중복방지용
let watchDebounce = null
try {
  watch(libraryRoot, (_evt, filename) => {
    // filename이 다른 파일이면 스킵. 단 **null이면 통과**시킨다 — macOS fs.watch는 파일 삭제 시
    // filename을 null로 주는 경우가 있어, null을 거르면 '세션 나가기'(_session.json 삭제)를 놓친다.
    if (filename && filename !== SESSION_FILE) return
    clearTimeout(watchDebounce)
    watchDebounce = setTimeout(async () => {
      const sel = await readSession(libraryRoot)
      if (!sel) {
        // 세션 나가기(_session.json 삭제) — 대기(IDLE)로 복귀. 설정 기본 personaId로 폴백하지 않는다.
        if (!sessionActive) return // 이미 세션 없음 — 중복 idle 방송 방지(null 이벤트가 잦아서)
        sessionActive = false
        lastHandledSelectedAt = null
        leaveSession()
        return
      }
      sessionActive = true
      // 같은 선택의 중복 watch 이벤트만 무시한다(하나의 쓰기가 여러 이벤트를 낼 수 있어서). 참가자가
      // 이미 로드돼 있어도(부팅 자동선택=최근) admin에서 다시 '세션으로'를 누르면 selectedAt가 갱신되어
      // 재생이 다시 트리거된다 — 예전 personaId 동일 가드가 이 재생을 막던 버그를 대체.
      if (sel.selectedAt && sel.selectedAt === lastHandledSelectedAt) return
      lastHandledSelectedAt = sel.selectedAt
      console.log(
        `[server] 세션 선택 반영 → ${sel.name || sel.personaId} (${sel.experience === 'second' ? '2차 체험' : '1차 체험'})`
      )
      applySessionSelection(sel.personaId, sel.experience)
    }, 200)
  })
} catch (err) {
  console.warn('[server] 세션 포인터 감시 실패 (부팅 시 선택만 반영됨):', err.message)
}

// 세션 포인터 정본(Firestore) 구독 — 어느 머신의 admin이 지정/해제하든 로컬 _session.json에
// 미러링만 한다. 실제 반영(리로드·reel 트리거·IDLE 복귀)은 위 파일 감시 경로가 전담하므로
// 로컬 admin 지정과 원격 지정이 완전히 같은 코드로 처리된다. selectedAt이 같으면 이미 반영된
// 선택(로컬 admin이 파일+정본을 동시에 쓴 경우, 또는 부팅 채택분)이라 건너뛴다.
if (firebaseReady) {
  try {
    listenRuntimeSession(async (cloud) => {
      try {
        // 정본 문서가 아예 없음(null) = 아직 아무 admin도 정본에 쓴 적 없음 — 로컬을 건드리지
        // 않는다. '세션 나가기'는 문서가 존재하되 personaId가 null인 명시적 해제 상태만 뜻한다.
        if (cloud === null) return
        const local = await readSession(libraryRoot)
        if (cloud.personaId) {
          if (local && local.personaId === cloud.personaId && local.selectedAt === cloud.selectedAt)
            return
          await writeSession(libraryRoot, cloud)
        } else if (local) {
          await clearSession(libraryRoot)
        }
      } catch (e) {
        console.warn(`[server] 세션 정본 미러 실패: ${e.message}`)
      }
    })
    console.log('[server] 세션 정본(Firestore runtime/session) 구독 — 원격 admin 지정을 따라간다')
  } catch (e) {
    console.warn(`[server] 세션 정본 구독 실패(로컬 파일만 감시): ${e.message}`)
  }
}

server.listen(PORT, () => {
  console.log(`[server] 주마등 웹앱 → http://localhost:${PORT}`)
  if (!existsSync(path.join(DIST, 'index.html'))) {
    console.log('[server] (dist 없음 — `npm run build` 후 접속하거나, 개발은 `npm run dev`)')
  }
})
