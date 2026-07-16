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
import { readSession, SESSION_FILE } from '../src/main/session-pointer.js'

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
  // (페이지 리로드 없이 SSE로 구동 — 실타래·reel은 몽타주 텍스처가 필요 없다. 되돌리려면 여기서 RELOAD로.)
  console.log('[server] 세션 참가자 반영 → reel 데모 트리거')
  runReelDemo()
}

// 개발용 뷰 토글: §4.1 프로젝터 예왜곡 렌더 ↔ 펼친 파노라마 프리뷰.
function toggleDevPreview() {
  devPreview = !devPreview
  console.log('[server] devPreview =', devPreview)
  broadcast(Channels.VIEW_MODE, { preview: devPreview })
}

// ── reel 데모 시퀀스(테스트 경험, §1 긴장 有 — 되돌릴 수 있는 경로) ─────
// 참가자 선택 → 실타래 회전 가속(spinup) → 사전 빌드 reel.mp4 1회 재생.
const REEL_SPINUP_MS = 3500
let reelTimer = null

function reelMediaUrl() {
  if (!library?.dir) return null
  const p = path.join(library.dir, 'reel.mp4')
  return existsSync(p) ? toMediaUrl(p) : null
}

function runReelDemo(spinupMs = REEL_SPINUP_MS) {
  clearTimeout(reelTimer)
  const url = reelMediaUrl()
  if (!url) console.warn('[server] reel 데모: reel.mp4 없음 — spinup만 실행(관리자에서 릴 생성 필요)')
  console.log(`[server] reel 데모 시작 (spinup ${spinupMs}ms → reel ${url ?? '(없음)'})`)
  broadcast(Channels.REEL_DEMO, { phase: 'spinup', spinupMs })
  reelTimer = setTimeout(() => {
    broadcast(Channels.REEL_DEMO, { phase: 'reel', url })
  }, spinupMs)
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
    montage: library
      ? {
          config: {
            frameDurationMs: montageConfig.frameDurationMs,
            mapping: montageConfig.mapping,
            fitMode: montageConfig.fitMode,
            edgeFeather: montageConfig.edgeFeather,
            blur: montageConfig.blur
          },
          playlist: library.images.map((im) => ({ id: im.id, url: toMediaUrl(im.absPath) })),
          ...sm.snapshot()
        }
      : null
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

    // reel 데모 수동 트리거(테스트용 — 참가자 교체 없이 현재 페르소나로 시퀀스 실행).
    if (req.method === 'POST' && url.pathname === '/api/reel-demo') {
      const body = await readBody(req)
      runReelDemo(Number.isFinite(body?.spinupMs) ? body.spinupMs : undefined)
      return sendJson(res, 200, { ok: true, reel: reelMediaUrl() })
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
const session = await readSession(libraryRoot)
const initialPersonaId = session?.personaId ?? montageConfig.personaId ?? null
if (session) console.log(`[server] 세션 참가자: ${session.name || session.personaId}`)
await loadPersona(initialPersonaId)

// 세션 포인터 감시 — 연구자가 admin에서 참가자를 바꾸면(_session.json 갱신) 런타임이 따라간다.
let watchDebounce = null
try {
  watch(libraryRoot, (_evt, filename) => {
    if (filename !== SESSION_FILE) return
    clearTimeout(watchDebounce)
    watchDebounce = setTimeout(async () => {
      const sel = await readSession(libraryRoot)
      const next = sel?.personaId ?? montageConfig.personaId ?? null
      if (library && next === library.personaId) return // 실질적 변화 없음.
      console.log(`[server] 세션 선택 변경 감지 → ${sel?.name || next || '(자동)'}`)
      applySessionSelection(next)
    }, 200)
  })
} catch (err) {
  console.warn('[server] 세션 포인터 감시 실패 (부팅 시 선택만 반영됨):', err.message)
}

server.listen(PORT, () => {
  console.log(`[server] 주마등 웹앱 → http://localhost:${PORT}`)
  if (!existsSync(path.join(DIST, 'index.html'))) {
    console.log('[server] (dist 없음 — `npm run build` 후 접속하거나, 개발은 `npm run dev`)')
  }
})
