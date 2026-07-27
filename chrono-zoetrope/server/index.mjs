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
import { createReadStream, existsSync } from 'node:fs'
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
  initFirebase,
  ensurePersonaMediaFromFirebase,
  ensureLocalClipsFromFirebase,
  fetchManifestByPersonaId,
  fetchProfileDoc,
  fetchRuntimeSession,
  listenRuntimeSession
} from '../src/main/comfyui/firestore-source.js'
import { GeminiClient, resolveGeminiApiKey } from '../src/main/comfyui/gemini-client.js'
import { ensurePingpongClip, pingpongPathFor } from '../src/main/comfyui/pingpong.js'
import { LIFE_STAGES } from '../src/main/comfyui/life-graph-plan.js'

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
    applySessionSelection(next)
  }
}

// ── 런타임 상태 (src/main/index.js에서 이관) ─────────────────────────
let devPreview = true // 기본 뷰 = 펼친 파노라마. renderer 초기값과 일치(첫 V가 실린더로 전환).
let sm = null //       상태 기계 (라이브러리 로드 후 생성).
let library = null //  몽타주 재생 목록.
let regenerator = null // 현재 페르소나용 영상 캐시 조회기.
let pendingPersonaId //   세션 진행 중 들어온 참가자 교체 — IDLE 복귀 시 반영 (undefined = 없음).
let reelPhotoPlaylist = [] // reel 전용 3:4 사진(manifest.reelPhotos, 필름스트립용). 없으면 파노라마 rotate 폴백.

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
      currentReelSec = mf.reel?.durationSec || 0
      reelPhotoPlaylist = (mf.reelPhotos || [])
        .filter((e) => !e.failed && e.file)
        .map((e) => ({ id: e.id, age: e.age, abs: path.join(lib.dir, e.file) }))
        .filter((e) => existsSync(e.abs))
        .map((e) => ({ id: e.id, age: e.age, url: toMediaUrl(e.abs) }))
      if (reelPhotoPlaylist.length)
        console.log(`[server] reel 사진 ${reelPhotoPlaylist.length}장 (필름스트립 모드)`)
    } catch {
      currentReelSec = 0
      reelPhotoPlaylist = []
    }
    sm = new ZoetropeStateMachine({
      broadcast,
      playlist: library.images,
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
async function applySessionSelection(personaId) {
  if (sm && sm.state !== State.IDLE) {
    pendingPersonaId = personaId
    console.log(
      `[server] 세션 진행 중 — 참가자 교체를 IDLE 복귀 시로 예약: ${personaId ?? '(자동)'}`
    )
    return
  }
  const ok = await loadPersona(personaId)
  if (!ok) return
  // 테스트 경험(사용자 확정): 참가자 선택이 곧바로 reel 데모 시퀀스를 트리거한다.
  console.log('[server] 세션 참가자 반영 → reel 데모 트리거')
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
  return idxs
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

// 라이브 방송·부트스트랩 공용 payload. elapsedMs로 재개 위치를 계산한다.
function demoPayload() {
  const p = { phase: demo.phase, elapsedMs: Date.now() - demo.startedAt }
  if (demo.phase === 'spinup') p.spinupMs = demo.spinupMs
  if (demo.phase === 'reel') {
    if (demo.mode === 'filmstrip') {
      p.mode = 'filmstrip'
      p.photos = demo.photos // [{ id, age, url }] — 클라이언트가 이어 붙여 스트립 텍스처 합성
      p.secPerTurn = DEMO_ROTATE_SEC
      p.gutterFrac = montageConfig.demo?.filmstripGutterFrac ?? 0.05
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

function runReelDemo(spinupMs = DEMO_SPINUP_MS) {
  clearDemoTimers()
  demo = { phase: 'spinup', startedAt: Date.now(), spinupMs }
  broadcast(Channels.REEL_DEMO, demoPayload())
  console.log(`[server] 데모: spinup ${spinupMs}ms`)
  demoTimers.push(setTimeout(startReelPhase, spinupMs))
}

function startReelPhase() {
  // 필름스트립 모드(신규 기본): reel 전용 3:4 사진(파노라마와 별개 플로우)이 있으면 그 사진들을
  // 필름처럼 이어 붙여 연속 회전한다. 전환은 클라이언트 'reel-done'(스트립 1사이클 완료)이 주도하고,
  // deadman·heartbeat는 rotate와 동일하게 재사용한다. 사진이 없는 기존 페르소나는 rotate 폴백.
  if (DEMO_REEL_MODE === 'rotate' && reelPhotoPlaylist.length > 0) {
    demo = { phase: 'reel', mode: 'filmstrip', startedAt: Date.now(), photos: reelPhotoPlaylist }
    broadcast(Channels.REEL_DEMO, demoPayload())
    console.log(
      `[server] 데모: reel 필름스트립 (${reelPhotoPlaylist.length}장 — 전환은 클라이언트 스트립 1사이클 완료 시, Q/W 속도 따라감)`
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

// 과거 순간 카탈로그 — 관람객이 "언제로 돌아가고 싶어"에 답하면 대화 두뇌가 이 목록에서 장면을
// 골라 client tool(show_past_moment)로 부른다. 현재 나이 이하 장면 + 영상 캐시가 있는 것만.
// url은 pingpong 변환본(<id>.pp.mp4)이 준비돼 있으면 그걸, 아니면 원본(plain loop 폴백).
function pastCatalog() {
  const imgs = library?.images || []
  const currentAge = currentAgeOfLibrary()
  if (currentAge === null || !regenerator) return { currentAge: null, moments: [] }
  const moments = []
  for (const im of imgs) {
    if (!(im.age <= currentAge)) continue
    const vp = regenerator.cachedPath(im.id)
    if (!vp) continue
    const pp = pingpongPathFor(vp)
    moments.push({
      id: im.id,
      age: im.age,
      year: im.year,
      scene: im.scene || '',
      url: toMediaUrl(existsSync(pp) ? pp : vp)
    })
  }
  moments.sort((a, b) => a.age - b.age || a.id.localeCompare(b.id, undefined, { numeric: true }))
  return { currentAge, moments }
}

// 과거 장면 클립을 준비한다: (1) Firebase 정본(generatedVideos)에서 로컬에 없는 과거 클립을
// read-through로 확보 → (2) pingpong 변환(정방향→역방향 이어붙임 — loop 경계 점프 제거)을
// 백그라운드로 순차 실행(CPU 독점 방지). ffmpeg 없음·다운로드 실패는 조용히 폴백
// (원본 loop / 그 장면 제외). 참가자 교체 시 남은 배치는 폐기.
async function preparePingpongClips() {
  const lib = library
  const currentAge = currentAgeOfLibrary()
  if (currentAge === null || !regenerator) return
  // Firebase 정본에서 과거 장면 클립 확보 — 전시 명세상 영상은 Firebase에 저장돼 있고 로컬은 캐시다.
  if (firebaseReady) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(lib.dir, 'manifest.json'), 'utf8'))
      const missingIds = lib.images
        .filter((im) => im.age <= currentAge && !regenerator.cachedPath(im.id))
        .map((im) => im.id)
      if (missingIds.length) {
        const { missing } = await ensureLocalClipsFromFirebase(manifest.profile, lib.dir, {
          ids: missingIds
        })
        if (library !== lib) return
        const got = missingIds.length - missing.length
        if (got) console.log(`[server] Firebase→로컬 과거 클립 ${got}개 확보`)
        if (missing.length)
          console.warn(
            `[server] Firebase에 없는 과거 클립 ${missing.length}개: ${missing.join(', ')}`
          )
      }
    } catch (e) {
      console.warn(`[server] 과거 클립 확보 실패(로컬 캐시만 사용): ${e.message}`)
    }
  }
  let made = 0
  for (const im of lib.images) {
    if (library !== lib) return // 참가자 교체 — 이 배치는 폐기
    if (!(im.age <= currentAge)) continue
    const vp = regenerator.cachedPath(im.id)
    if (!vp || existsSync(pingpongPathFor(vp))) continue
    try {
      await ensurePingpongClip(vp)
      made++
    } catch (e) {
      console.warn(`[server] pingpong 변환 실패(원본 loop 폴백): ${im.id} — ${e.message}`)
      if (/실행 불가/.test(String(e.message))) return // ffmpeg 자체가 없다 — 나머지도 전부 실패한다
    }
  }
  if (made) console.log(`[server] pingpong 클립 ${made}개 준비 완료`)
}

// 회고 firstMessage — "너는 N년의 삶을 …" (플로우 2번 발화, Firebase 응답 기반).
// §1 긴장 완화(CLAUDE.md §12에 따라 명시): "정말 ○○하게 살았구나"는 시스템이 삶을 성격규정할
// 위험이 있다. 그래서 사건·형용사 재료를 관람객이 cdb-crafter에 직접 쓴 문장으로만 제한한다 —
// 시스템의 평가가 아니라 본인 말의 반향. Gemini·Firestore가 없으면 고정 폴백 문장.
const RECAP_TAIL =
  '그렇다면 혹시, 언제로 돌아가고 싶어? 너가 돌아가고 싶은 순간이 있다면 말해줘. 내가 데려다줄게.'
const recapPromises = new Map() // personaId → Promise<string> (세션 재발급 대비 캐시)

function recapFallback() {
  const age = currentAgeOfLibrary()
  const head = Number.isFinite(age)
    ? `너는 ${age}년의 삶을 여기까지 살아왔구나.`
    : '너는 너의 삶을 여기까지 살아왔구나.'
  return `${head} ${RECAP_TAIL}`
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
  const out = []
  for (const stage of LIFE_STAGES) {
    let text = null
    for (const key of ['first', 'second', 'third']) {
      const t = profileDoc?.[key]?.[stage.id]?.text?.trim()
      if (t) {
        text = t
        break
      }
    }
    if (text) out.push({ label: `${stage.label}(${stage.sublabel})`, text })
  }
  return out
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
    `아래는 한 사람이 자기 삶의 각 시기를 스스로 짧게 적은 글이다. 이 사람에게 건넬 한국어 반말 회고 인사 한 단락을 만들어라.\n\n` +
    `형식: "너는 ${Number.isFinite(age) ? age : 'N'}년의 삶을 정말 ○○하게 살았구나. ○○도 했고, ○○도 했고…"처럼 시작해, ` +
    `이 사람이 실제로 적은 사건·표현을 두세 개 짧게 되짚는다. 마지막은 반드시 다음 문장으로 끝낸다(토씨 그대로): "${RECAP_TAIL}"\n\n` +
    `제약(반드시 지킬 것):\n` +
    `- 사건·형용사·표현은 전부 아래 글에 이미 있는 것에서만 가져온다. 이 사람의 삶이 어땠는지 새로 평가·해석·요약하지 않는다(본인이 쓴 말의 반향만).\n` +
    `- 충고·교훈·위로의 결론을 붙이지 않는다.\n` +
    `- 낮고 따뜻한 입말로 3~5문장. 목록·격식체 금지. 답은 그 단락 하나만(다른 설명 없이).\n\n` +
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

function recapFor(personaId) {
  if (!recapPromises.has(personaId)) {
    recapPromises.set(
      personaId,
      composeRecapFirstMessage(personaId).catch(() => recapFallback())
    )
  }
  return recapPromises.get(personaId)
}

// loadPersona 완료 직후 백그라운드 준비(과거 흐름일 때만). ghost 국면은 릴 종료 뒤라 시간 여유가 있다.
// 회고 문장이 준비되면 그 오디오까지 미리 합성해 둔다(ttsCache) — 유령의 첫 마디가 지연 없이 나온다.
function prepareGhostPastAssets(personaId) {
  const vcfg = montageConfig.ghost?.voice || {}
  if ((vcfg.flow ?? 'past') !== 'past') return
  const recap = recapFor(personaId)
  if ((vcfg.engine ?? 'bridge') !== 'convai') {
    recap.then((t) => elevenTtsBuffer(t)).catch(() => {})
  }
  void preparePingpongClips()
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

// 흐름별 대화 컨텍스트(페르소나 + 첫 발화 + 카탈로그) 조립 — 세션 발급과 브리지 턴이 공유한다.
//  past  : 회고(Firebase 응답 기반 생성, 폴백 有) + 과거 순간 카탈로그. 카탈로그 목록은 시스템
//          프롬프트에 붙여 대화 두뇌가 관람객의 발화("고등학교 졸업식")를 장면과 직접 매칭하게 한다.
//  future: 기존 2차 흐름 그대로(고정 firstMessage + 미래 나잇대 카탈로그).
async function buildGhostContext() {
  const vcfg = montageConfig.ghost?.voice || {}
  const flow = vcfg.flow === 'future' ? 'future' : 'past'
  const flowCfg = vcfg[flow] || {}

  let systemPrompt = ''
  const promptPath = flowCfg.systemPromptPath || vcfg.systemPromptPath
  if (promptPath) {
    try {
      systemPrompt = (await fs.readFile(path.resolve(root, promptPath), 'utf8')).trim()
    } catch {
      console.warn('[server] 유령 음성: 페르소나 파일 없음 — 기본 프롬프트 없이 진행')
    }
  }

  let firstMessage = flowCfg.firstMessage || vcfg.firstMessage
  let past = null
  let future = null
  if (flow === 'past') {
    past = pastCatalog()
    firstMessage = await recapFor(library?.personaId ?? '(none)')
    if (past.moments.length) {
      const lines = past.moments.map((m) => `- id ${m.id} · ${m.age}세 · ${m.year}년 · ${m.scene}`)
      systemPrompt +=
        `\n\n## 돌아갈 수 있는 순간들 (장면 카탈로그)\n` +
        `이 사람은 지금 ${past.currentAge}세다. 아래는 보여줄 수 있는 이 사람의 과거 장면 영상 목록이다. ` +
        `이 사람이 돌아가고 싶다고 말한 순간과 가장 맞는 장면 하나를 골라 그 id로 show_past_moment를 불러라. ` +
        `말한 사건이 목록에 사실상 그대로 있으면 exact=true, 정확히 없어서 비슷한 나이·시기의 장면으로 대신 데려가면 exact=false.\n` +
        `중요: 이 사람이 돌아가고 싶은 순간·시기를 한 번이라도 말했다면(예: "고등학교 졸업식"), 목록에 똑같은 장면이 없어도 ` +
        `다시 묻지 말고 대신 데려갈 장면을 exact=false로 골라 바로 보여준다. 되묻는 건 순간을 아직 전혀 말하지 않았을 때뿐이다.\n` +
        `대신 데려갈 장면은 말한 순간의 나이를 추정해(예: 고등학교 졸업식≈18~19세) 그 나이와 가장 가까운 나이의 장면 중에서 고른다.\n` +
        lines.join('\n')
    }
  } else {
    future = futureCatalog()
  }
  return { vcfg, flow, systemPrompt, firstMessage, past, future }
}

async function ghostSessionPayload() {
  const vcfg = montageConfig.ghost?.voice
  if (!vcfg || vcfg.enabled === false) return { enabled: false }
  const engine = vcfg.engine === 'convai' ? 'convai' : 'bridge'
  const ctx = await buildGhostContext()

  if (engine === 'bridge') {
    // 브리지: 브라우저는 greeting을 TTS로 말한 뒤 STT→/api/ghost/turn 루프를 돈다.
    // ElevenLabs 키가 없어도 enabled 유지 — /api/ghost/tts가 503을 주면 브라우저 TTS로 폴백한다.
    resetGhostConversation() // 세션 발급 = 새 만남 — 대화 기록 초기화
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
let ghostHistory = [] // [{ who:'유령'|'사람'|'상황', text }]
function resetGhostConversation() {
  ghostHistory = []
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
        show: j.show && j.show.id !== undefined ? j.show : null
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
  return { say: text, show: null }
}

/**
 * 브리지 대화 한 턴: 관람객 발화(kind='user') 또는 상황 알림(kind='event', 예: 영상이 떠오른 뒤)을
 * 받아 Gemini가 유령의 다음 대사(say)와 띄울 장면(show)을 정한다. show.id는 카탈로그로 검증하고,
 * 없으면 나이 근접 장면으로 폴백(exact=false) — convai 시절 client tool의 폴백 규칙과 동일.
 * @returns {Promise<{ say:string, video:null|{id,age,year,scene,url,exact} }>}
 */
async function ghostBridgeTurn(userText, kind = 'user') {
  const ctx = await buildGhostContext()
  const moments = ctx.past?.moments || []
  ghostHistory.push({ who: kind === 'event' ? '상황' : '사람', text: userText })
  if (ghostHistory.length > 24) ghostHistory = ghostHistory.slice(-24)

  const transcript = [{ who: '유령', text: ctx.firstMessage }, ...ghostHistory]
    .map((t) => `${t.who}: ${t.text}`)
    .join('\n')
  const prompt =
    ctx.systemPrompt +
    `\n\n## 출력 형식 (반드시 지킬 것)\n` +
    `JSON 객체 하나만 출력한다(다른 설명·코드펜스 없이): {"say":"...","show":{"id":"3-1","exact":true}}\n` +
    `- say: 지금 음성으로 말할 한두 문장(입말). 도구·시스템 언급 등 메타발언 금지.\n` +
    `- show: 장면 영상을 새로 띄울 때만 포함한다(위 카탈로그의 id). 띄우지 않으면 show 자체를 생략.\n` +
    `- '상황:' 줄은 시스템 알림이다(관람객의 말이 아님) — 영상이 뜬 뒤 이어갈 대사를 만들 때 참고만 한다.\n` +
    `- 규칙: 사람의 마지막 말이 돌아가고 싶은 순간·시기를 담고 있으면(조금이라도), 이번 응답에 반드시 show를 넣는다 — ` +
    `카탈로그에 똑같은 장면이 없으면 그 시기의 나이와 가장 가까운 나이의 장면을 exact=false로. ` +
    `"잘 못 들었어" 같은 되묻기는 순간을 전혀 말하지 않았을 때만 허용된다.\n` +
    `\n## 지금까지의 대화\n${transcript}\n\n유령의 다음 응답 JSON:`

  const gclient = await getGeminiText()
  // thinkingBudget 0: 대화는 저지연이 생명 — flash의 사고 단계를 끈다(생성 파이프라인 호출은 그대로).
  const raw = String(await gclient.generateText({ prompt, thinkingBudget: 0 }))
  console.log(`[server] 유령 브리지 응답: ${raw.replace(/\s+/g, ' ').slice(0, 220)}`)
  const parsed = parseGhostReply(raw)

  let video = null
  if (parsed.show && moments.length) {
    const wantId = String(parsed.show.id)
    let m = moments.find((x) => String(x.id) === wantId)
    let exact = parsed.show.exact === true
    if (!m) {
      const n = parseInt(wantId, 10)
      m = Number.isFinite(n)
        ? moments.reduce((best, x) => (Math.abs(x.age - n) < Math.abs(best.age - n) ? x : best))
        : moments[moments.length - 1]
      exact = false
    }
    if (m) video = { id: m.id, age: m.age, year: m.year, scene: m.scene, url: m.url, exact }
  }
  if (parsed.say) ghostHistory.push({ who: '유령', text: parsed.say })
  return { say: parsed.say, video }
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
      body: JSON.stringify({ text, model_id: vcfg.ttsModelId || 'eleven_flash_v2_5' })
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
  if (ttsCache.size > 16) ttsCache.delete(ttsCache.keys().next().value)
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
  '.mp4': 'video/mp4'
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

    // ---- 유령 브리지 TTS 중계 — ElevenLabs 키는 서버에만. 실패 시 503(브라우저 TTS 폴백). ----
    // GET(?text=…)이 기본: <audio src>가 첫 청크부터 점진 재생해 발화 시작 지연을 크게 줄인다.
    // 캐시 적중(예열된 회고 첫 마디)은 버퍼로 즉시. POST는 완성 버퍼 응답(구형 경로 호환).
    if (req.method === 'GET' && url.pathname === '/api/ghost/tts') {
      const text = String(url.searchParams.get('text') ?? '').trim()
      if (!text) return sendJson(res, 400, { error: 'text 필요' })
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
      console.log(`[server] 세션 선택 반영 → ${sel.name || sel.personaId}`)
      applySessionSelection(sel.personaId)
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
