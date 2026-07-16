// 웹앱용 zoetrope 클라이언트 — Electron preload(window.zoetrope)를 대체한다.
//
// preload는 IPC를 감쌌다. 여기서는 같은 API 표면을 웹 표준으로 감싼다:
//   - getBootstrap()            → fetch('/api/bootstrap')
//   - onState/onContent/...     → 단일 EventSource('/api/events')를 채널별로 디스패치
//   - sendInput/sendVideoReady/… → fetch(POST /api/...)
//   - toggleView()              → fetch(POST /api/view-toggle)
//
// 서버(server/index.mjs)가 상태를 소유하고 SSE로 방송한다. 단일 페이지가 4타일을 렌더하므로
// projectorIndex 개념은 없다(모든 타일이 같은 재료·같은 시계).
//
// 채널 상수는 서버·shared와 동일해야 한다. 번들에 shared/channels.js를 그대로 import 한다.

import { Channels } from '../../../shared/channels.js'

// 채널 → 구독 콜백 집합. 단일 EventSource가 모든 채널을 실어 나른다.
const listeners = new Map() // channel -> Set<fn>
function on(channel, cb) {
  if (typeof cb !== 'function') return () => {}
  let set = listeners.get(channel)
  if (!set) listeners.set(channel, (set = new Set()))
  set.add(cb)
  return () => set.delete(cb)
}
function dispatch(channel, payload) {
  const set = listeners.get(channel)
  if (set) for (const fn of set) fn(payload)
}

// 단일 SSE 연결. 끊기면 브라우저가 자동 재연결(retry). 각 메시지 = { channel, payload }.
function connectEvents() {
  const es = new EventSource('/api/events')
  es.onmessage = (ev) => {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    if (!msg || !msg.channel) return
    if (msg.channel === Channels.RELOAD) {
      // 참가자 교체 등 — 새 재생목록으로 페이지를 다시 부트스트랩.
      location.reload()
      return
    }
    dispatch(msg.channel, msg.payload)
  }
  es.onerror = () => {
    // EventSource가 알아서 재연결한다. 로그만.
    // (콘솔 소음 최소화를 위해 조용히 둔다.)
  }
  return es
}

async function postJson(pathname, body) {
  try {
    await fetch(pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {})
    })
  } catch (err) {
    console.warn(`[zoetrope-web] POST ${pathname} 실패:`, err.message)
  }
}

export function installZoetropeWeb() {
  connectEvents()

  const zoetrope = {
    // 부트스트랩: projectors[] + install + montage 국면.
    getBootstrap: async () => {
      const r = await fetch('/api/bootstrap')
      if (!r.ok) throw new Error(`bootstrap ${r.status}`)
      return r.json()
    },

    // server → page 구독 (preload와 동일 시그니처).
    onState: (cb) => on(Channels.STATE, cb),
    onContent: (cb) => on(Channels.CONTENT, cb),
    onLift: (cb) => on(Channels.LIFT, cb),
    onFreezePrepare: (cb) => on(Channels.FREEZE_PREPARE, cb),
    onFreezeCommit: (cb) => on(Channels.FREEZE_COMMIT, cb),
    onViewMode: (cb) => on(Channels.VIEW_MODE, cb),
    onPlayState: (cb) => on(Channels.PLAY_STATE, cb),
    onVideoPrepare: (cb) => on(Channels.VIDEO_PREPARE, cb),
    onVideoCommit: (cb) => on(Channels.VIDEO_COMMIT, cb),
    onReelDemo: (cb) => on(Channels.REEL_DEMO, cb),

    // page → server.
    sendInput: (action) => postJson('/api/input', { action }),
    sendVideoReady: () => postJson('/api/video-ready', { projectorIndex: 0 }),
    sendFreezeReady: () => postJson('/api/freeze-ready', { projectorIndex: 0 }),
    toggleView: () => postJson('/api/view-toggle', {}),
    togglePlay: () => postJson('/api/toggle-play', {})
  }

  window.zoetrope = zoetrope
  return zoetrope
}
