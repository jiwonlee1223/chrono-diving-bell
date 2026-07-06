import { app, shell, BrowserWindow, ipcMain, globalShortcut } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { Channels } from '../shared/channels.js'
import { computeWindowBounds } from './window-manager.js'
import installConfig from './config/install.json'
import projectorsConfig from './config/projectors.json'

const PROJECTORS = projectorsConfig.projectors
const COUNT = PROJECTORS.length // 4

let windows = [] //    생성된 프로젝터 창들 (뷰 토글 브로드캐스트 대상).
let devPreview = true // 기본 뷰 = 펼친 파노라마. renderer 초기값과 일치(첫 V가 실린더로 전환). 설치 런타임 무관.

// 개발용 뷰 토글: §4.1 프로젝터 예왜곡 렌더 ↔ 펼친 파노라마 프리뷰. 4창 동시(§7 main이 상태 소유).
// 키 처리를 main에 두어 preload/renderer 배선·리로드에 의존하지 않는다.
function toggleDevPreview() {
  devPreview = !devPreview
  console.log('[main] devPreview =', devPreview)
  for (const w of windows) {
    if (!w.isDestroyed()) w.webContents.send(Channels.VIEW_MODE, { preview: devPreview })
  }
}

// 재생/정지(Space). main이 '유효 시간' 모델을 소유하고 4창에 브로드캐스트해 동기 유지(§7).
// 재생 중: 유효시간 = Date.now()/1000 - offset. 정지 중: frozenEff 고정.
// 재생 재개 시 offset을 정지했던 만큼 늘려, 멈춘 지점부터 이어서 감긴다. Phase 3 FREEZE의 선행.
let playing = true
let playOffset = 0 // 누적 정지 시간(초)
let frozenEff = 0 //  정지 시점의 유효 시간
function broadcastPlay() {
  for (const w of windows) {
    if (!w.isDestroyed()) {
      w.webContents.send(Channels.PLAY_STATE, { playing, offset: playOffset, frozenEff })
    }
  }
}
function togglePlay() {
  const nowSec = Date.now() / 1000
  if (playing) {
    frozenEff = nowSec - playOffset // 지금 유효 시간에 정지.
    playing = false
  } else {
    playOffset = nowSec - frozenEff // 정지했던 만큼 offset을 늘려 이어서 재생.
    playing = true
  }
  console.log('[main] playing =', playing)
  broadcastPlay()
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
  //  V     → 뷰 토글(파노라마 ↔ 실린더)
  //  Space → 재생/정지
  window.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return
    const noMod = !input.control && !input.meta && !input.alt
    if (!noMod) return
    const key = input.key ? input.key.toLowerCase() : ''
    if (key === 'v') toggleDevPreview()
    else if (key === ' ' || input.code === 'Space') togglePlay()
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

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.chronozoetrope')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 부트스트랩: 각 창이 자기 프로젝터 config + 설치 파라미터를 요청.
  ipcMain.handle(Channels.BOOTSTRAP, (_event, projectorIndex) => {
    const idx = Number.isInteger(projectorIndex) ? projectorIndex : 0
    const projector = PROJECTORS[idx] ?? PROJECTORS[0]
    return { projectorIndex: idx, projector, install: installConfig }
  })

  // 개발용 뷰 토글의 renderer 트리거 경로(있으면). 실제 키는 위 before-input-event가 잡는다.
  ipcMain.on(Channels.VIEW_TOGGLE, () => toggleDevPreview())

  createAllWindows()

  // 창 포커스가 없어도(예: 터미널에 포커스) 동작하는 전역 단축키.
  const okV = globalShortcut.register('CommandOrControl+Shift+V', () => toggleDevPreview())
  if (!okV) console.warn('[main] 전역 단축키(Cmd/Ctrl+Shift+V) 등록 실패 — 창 포커스 후 V 사용.')
  const okSpace = globalShortcut.register('CommandOrControl+Shift+Space', () => togglePlay())
  if (!okSpace) console.warn('[main] 전역 단축키(Cmd/Ctrl+Shift+Space) 등록 실패 — 창 포커스 후 Space 사용.')

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
