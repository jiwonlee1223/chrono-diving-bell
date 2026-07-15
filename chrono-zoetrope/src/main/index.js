import { app, shell, BrowserWindow, ipcMain, globalShortcut, protocol, net } from 'electron'
import { watch } from 'node:fs'
import { join, resolve, normalize } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { Channels } from '../shared/channels.js'
import { State } from '../shared/states.js'
import { computeWindowBounds } from './window-manager.js'
import { loadMontageLibrary } from './library-loader.js'
import { ZoetropeStateMachine } from './state-machine.js'
import { VideoRegenerator } from './comfyui/video-cache.js'
import { readSession, SESSION_FILE } from './session-pointer.js'
import installConfig from './config/install.json'
import projectorsConfig from './config/projectors.json'
import montageConfig from './config/montage.json'
import comfyuiConfig from './config/comfyui.json'

const PROJECTORS = projectorsConfig.projectors
const COUNT = PROJECTORS.length // 4

let windows = [] //    생성된 프로젝터 창들 (브로드캐스트 대상).
let devPreview = true // 기본 뷰 = 펼친 파노라마. renderer 초기값과 일치(첫 V가 실린더로 전환). 설치 런타임 무관.
let sm = null //       상태 기계 (라이브러리 로드 후 생성).
let library = null //  몽타주 재생 목록.
let regenerator = null // 현재 페르소나용 영상 재생성기 (페르소나 교체 시 재생성).
let pendingPersonaId // 세션 진행 중 들어온 참가자 교체 요청 — IDLE 복귀 시 반영 (undefined = 없음).

// 라이브러리 이미지·영상을 renderer에 서빙하는 커스텀 프로토콜.
// dev(HTTP 오리진)·프로덕션(file 오리진) 양쪽에서 file:// 제약 없이 <img>/<video>로 로드된다.
// URL 형식: zoe://media/<library 루트 기준 상대 경로>
const MEDIA_SCHEME = 'zoe'
const libraryRoot = resolve(app.getAppPath(), montageConfig.libraryDir ?? 'library')

// corsEnabled + ACAO 헤더: Three.js 로더·WebGL 텍스처 업로드가 crossOrigin='anonymous'로
// 요청하므로, CORS 승인이 없으면 이미지는 차단되고 비디오는 오염(tainted)돼 업로드가 터진다.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
  }
])

function toMediaUrl(absPath) {
  const rel = normalize(absPath).slice(normalize(libraryRoot).length + 1)
  const encoded = rel.split(/[\\/]/).map(encodeURIComponent).join('/')
  return `${MEDIA_SCHEME}://media/${encoded}`
}

async function handleMediaRequest(request) {
  const { pathname } = new URL(request.url)
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '')
  const abs = normalize(join(libraryRoot, rel))
  if (!abs.startsWith(normalize(libraryRoot))) {
    return new Response('forbidden', { status: 403 }) // 경로 탈출 차단.
  }
  const res = await net.fetch(pathToFileURL(abs).toString())
  const headers = new Headers(res.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  return new Response(res.body, { status: res.status, headers })
}

function broadcast(channel, payload) {
  for (const w of windows) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
  // 진행 중 세션은 건드리지 않는다: 연구자가 도중에 참가자를 바꿨다면 IDLE로 돌아오는
  // 순간에 반영한다. (EXIT→IDLE 배선 전에는 이 경로가 실질적으로 안 타지만 미리 열어 둔다.)
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

// 페르소나 하나를 (재)로드한다: 라이브러리 + 영상 재생성기 + 상태 기계를 새로 만든다.
// personaId=null 이면 library-loader가 가장 최근 것을 자동 선택. 실패 시 이전 상태를 유지한다.
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
      // FREEZE는 그 장면의 사전 생성 클립을 캐시에서 꺼내 재생할 뿐(없으면 정지 이미지 폴백).
      regenerate: (image) => regenerator.cachedPath(image.id),
      toMediaUrl
    })
    console.log(`[main] 라이브러리: ${library.personaId} (${library.images.length}장)`)
    return true
  } catch (err) {
    console.error('[main] 라이브러리 로드 실패:', err.message)
    if (!sm) library = null // 최초 부팅부터 실패면 IDLE 앰비언트만 동작.
    return false
  }
}

// 연구자가 admin에서 고른 참가자를 런타임에 반영한다.
// IDLE(대기)일 때만 즉시 교체하고 4창을 재부트스트랩한다. 세션 진행 중이면 IDLE 복귀까지 미룬다.
async function applySessionSelection(personaId) {
  if (sm && sm.state !== State.IDLE) {
    pendingPersonaId = personaId // IDLE로 돌아올 때 broadcast()가 적용.
    console.log(`[main] 세션 진행 중 — 참가자 교체를 IDLE 복귀 시로 예약: ${personaId ?? '(자동)'}`)
    return
  }
  const ok = await loadPersona(personaId)
  if (!ok) return
  // 4창은 재부트스트랩으로 새 재생목록/텍스처를 다시 불러온다 (IDLE 앰비언트 중이라 잠깐의 리로드 무방).
  console.log('[main] 세션 참가자 반영 → 4창 재부트스트랩')
  for (const w of windows) if (!w.isDestroyed()) w.webContents.reload()
}

// 개발용 뷰 토글: §4.1 프로젝터 예왜곡 렌더 ↔ 펼친 파노라마 프리뷰. 4창 동시(§7 main이 상태 소유).
// 키 처리를 main에 두어 preload/renderer 배선·리로드에 의존하지 않는다.
function toggleDevPreview() {
  devPreview = !devPreview
  console.log('[main] devPreview =', devPreview)
  broadcast(Channels.VIEW_MODE, { preview: devPreview })
}

function createProjectorWindow(projectorIndex, bounds) {
  const window = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      additionalArguments: [`--projector-index=${projectorIndex}`]
    }
  })

  window.on('ready-to-show', () => {
    window.show()
    if (bounds.fullscreen) window.setFullScreen(true)
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 창이 포커스된 상태에서 키 처리(수식키 없이). main에서 직접 잡는다.
  //  Enter → 멈춤/진입/재개 (상태 기계가 상태별 의미 결정 — §8 버튼과 동일 액션)
  //  V     → 뷰 토글(파노라마 ↔ 실린더)
  //  Space → 재생/정지 (개발용)
  window.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return
    const noMod = !input.control && !input.meta && !input.alt
    if (!noMod) return
    const key = input.key ? input.key.toLowerCase() : ''
    if (key === 'enter' || input.code === 'Enter') sm?.handleEnter()
    else if (key === 'v') toggleDevPreview()
    else if (key === ' ' || input.code === 'Space') sm?.togglePlay()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function createAllWindows() {
  const bounds = computeWindowBounds(COUNT)
  windows = []
  for (let i = 0; i < COUNT; i++) windows.push(createProjectorWindow(i, bounds[i]))
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.chronozoetrope')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  protocol.handle(MEDIA_SCHEME, handleMediaRequest)

  // 어떤 참가자를 재생할지: 연구자가 admin에서 고른 세션 포인터(_session.json)가 최우선,
  // 없으면 montage.json의 고정 personaId, 그것도 없으면 자동(최근) 선택.
  // 라이브러리가 없으면 앱은 뜨되 IDLE 앰비언트만 동작한다.
  const session = await readSession(libraryRoot)
  const initialPersonaId = session?.personaId ?? montageConfig.personaId ?? null
  if (session) console.log(`[main] 세션 참가자: ${session.name || session.personaId}`)
  await loadPersona(initialPersonaId)

  // 부트스트랩: 각 창이 자기 프로젝터 config + 설치 파라미터 + 몽타주 국면을 요청.
  // 몽타주 재생 목록은 zoe:// URL로 넘겨 renderer가 직접 프리로드한다.
  ipcMain.handle(Channels.BOOTSTRAP, (_event, projectorIndex) => {
    const idx = Number.isInteger(projectorIndex) ? projectorIndex : 0
    const projector = PROJECTORS[idx] ?? PROJECTORS[0]
    return {
      projectorIndex: idx,
      projector,
      install: installConfig,
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
  })

  // 개발용 뷰 토글의 renderer 트리거 경로(있으면). 실제 키는 위 before-input-event가 잡는다.
  ipcMain.on(Channels.VIEW_TOGGLE, () => toggleDevPreview())

  // 게임패드(§8) 경로: renderer(창0)가 Gamepad API 이벤트를 INPUT으로 올리면 Enter와 동일 처리.
  ipcMain.on(Channels.INPUT, () => sm?.handleEnter())

  // IMMERSION 영상 배리어: 4창 프리로드 보고 수집.
  ipcMain.on(Channels.VIDEO_READY, (_event, { projectorIndex } = {}) => {
    sm?.onVideoReady(projectorIndex ?? 0)
  })

  createAllWindows()

  // 세션 포인터 감시 — 연구자가 admin에서 참가자를 바꾸면(_session.json 갱신) 런타임이 따라간다.
  // 4창에는 아무 UI도 없다: 교체는 여기서 라이브러리를 다시 로드하고 창을 재부트스트랩할 뿐.
  let watchDebounce = null
  try {
    watch(libraryRoot, (_evt, filename) => {
      if (filename !== SESSION_FILE) return
      clearTimeout(watchDebounce)
      watchDebounce = setTimeout(async () => {
        const sel = await readSession(libraryRoot)
        const next = sel?.personaId ?? montageConfig.personaId ?? null
        if (library && next === library.personaId) return // 실질적 변화 없음.
        console.log(`[main] 세션 선택 변경 감지 → ${sel?.name || next || '(자동)'}`)
        applySessionSelection(next)
      }, 200) // fs.watch가 한 번 쓰기에 여러 이벤트를 내므로 디바운스.
    })
  } catch (err) {
    console.warn('[main] 세션 포인터 감시 실패 (부팅 시 선택만 반영됨):', err.message)
  }

  // 창 포커스가 없어도(예: 터미널에 포커스) 동작하는 전역 단축키.
  const okV = globalShortcut.register('CommandOrControl+Shift+V', () => toggleDevPreview())
  if (!okV) console.warn('[main] 전역 단축키(Cmd/Ctrl+Shift+V) 등록 실패 — 창 포커스 후 V 사용.')
  const okSpace = globalShortcut.register('CommandOrControl+Shift+Space', () => sm?.togglePlay())
  if (!okSpace)
    console.warn('[main] 전역 단축키(Cmd/Ctrl+Shift+Space) 등록 실패 — 창 포커스 후 Space 사용.')
  const okEnter = globalShortcut.register('CommandOrControl+Shift+Return', () => sm?.handleEnter())
  if (!okEnter)
    console.warn('[main] 전역 단축키(Cmd/Ctrl+Shift+Return) 등록 실패 — 창 포커스 후 Enter 사용.')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createAllWindows()
  })
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
