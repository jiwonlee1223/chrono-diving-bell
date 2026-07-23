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
import { fileURLToPath } from 'node:url'

import { Channels } from '../src/shared/channels.js'
import { State } from '../src/shared/states.js'
import { loadMontageLibrary } from '../src/main/library-loader.js'
import { ZoetropeStateMachine } from '../src/main/state-machine.js'
import { VideoRegenerator } from '../src/main/comfyui/video-cache.js'
import { readSession, writeSession, clearSession, SESSION_FILE } from '../src/main/session-pointer.js'
import { readCalibration, writeCalibration } from '../src/main/calibration.js'
import {
  initFirebase,
  ensurePersonaMediaFromFirebase,
  fetchManifestByPersonaId,
  fetchRuntimeSession,
  listenRuntimeSession
} from '../src/main/comfyui/firestore-source.js'

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
    try {
      const mf = JSON.parse(await fs.readFile(path.join(lib.dir, 'manifest.json'), 'utf8'))
      currentReelSec = mf.reel?.durationSec || 0
    } catch {
      currentReelSec = 0
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
    if (demo.mode === 'rotate') {
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
  demo = { phase: 'ghost', startedAt: Date.now() }
  broadcast(Channels.REEL_DEMO, demoPayload())
  console.log('[server] 데모: 유령 idle (1인칭 진입 대기)')
}

// 세션 나가기(admin 전용 중단) — 데모를 idle로 리셋하고 런타임을 대기 앰비언트로 되돌린다.
function leaveSession() {
  clearDemoTimers()
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

// ── 유령 음성 대화 세션 (ghost.voice) ────────────────────────────────
// reel 종료 후 'ghost' 국면에서만 브라우저가 호출한다. API 키는 서버에만 두고
// ElevenLabs Conversational AI 서명 URL을 발급해 넘긴다. §1 경계·첫 질문·언어·보이스는
// ghost-persona.md + montage.json(ghost.voice)에서 읽어 오버라이드로 함께 내려준다.
// 미설정(agentId·키 없음)·발급 실패면 { enabled:false } — 브라우저는 조용히 유령만 띄운다(§1 침묵).
async function ghostSessionPayload() {
  const vcfg = montageConfig.ghost?.voice
  if (!vcfg || vcfg.enabled === false || !vcfg.agentId) return { enabled: false }

  // API 키(gitignore된 secrets/) — 서버만 읽는다.
  let apiKey = ''
  try {
    const keyPath = path.resolve(root, vcfg.apiKeyPath || './secrets/elevenlabs-api-key.txt')
    apiKey = (await fs.readFile(keyPath, 'utf8')).trim()
  } catch {
    console.warn('[server] 유령 음성: API 키 파일 없음 — 음성 비활성(유령만)')
    return { enabled: false }
  }
  if (!apiKey) return { enabled: false }

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

  // §1 경계 페르소나(프로즈 파일) — 대화 두뇌의 시스템 프롬프트로 오버라이드.
  let systemPrompt = ''
  if (vcfg.systemPromptPath) {
    try {
      systemPrompt = (await fs.readFile(path.resolve(root, vcfg.systemPromptPath), 'utf8')).trim()
    } catch {
      console.warn('[server] 유령 음성: 페르소나 파일 없음 — 에이전트 기본 프롬프트 사용')
    }
  }

  // 브라우저 SDK(startSession)에 넘길 오버라이드. 빈 값은 넣지 않는다(에이전트 대시보드 설정 존중).
  // 주의: 오버라이드는 ElevenLabs 에이전트 '보안 설정'에서 항목별로 허용해야 실제 반영된다.
  const overrides = { agent: {} }
  if (systemPrompt) overrides.agent.prompt = { prompt: systemPrompt }
  if (vcfg.firstMessage) overrides.agent.firstMessage = vcfg.firstMessage
  if (vcfg.language) overrides.agent.language = vcfg.language
  if (vcfg.voiceId) overrides.tts = { voiceId: vcfg.voiceId }

  return {
    enabled: true,
    signedUrl,
    overrides,
    startDelayMs: vcfg.startDelayMs ?? 2600,
    future: futureCatalog() // 미래 자기 모습 영상 카탈로그(대화 client tool이 사용)
  }
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
      if (
        !local ||
        local.personaId !== cloud.personaId ||
        local.selectedAt !== cloud.selectedAt
      ) {
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
          if (
            local &&
            local.personaId === cloud.personaId &&
            local.selectedAt === cloud.selectedAt
          )
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
