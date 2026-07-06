import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { Channels } from '../shared/channels.js'

// 이 창이 담당하는 프로젝터 인덱스. main이 additionalArguments 로 주입.
const arg = process.argv.find((a) => a.startsWith('--projector-index='))
const projectorIndex = arg ? parseInt(arg.split('=')[1], 10) || 0 : 0

function subscribe(channel, cb) {
  const listener = (_event, payload) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// renderer에 노출하는 안전 API. contextIsolation 하에서 IPC를 캡슐화한다.
const zoetrope = {
  projectorIndex,

  // 부트스트랩: 담당 프로젝터 config + 설치 파라미터.
  getBootstrap: () => ipcRenderer.invoke(Channels.BOOTSTRAP, projectorIndex),

  // main → renderer 구독 (Phase 3+).
  onState: (cb) => subscribe(Channels.STATE, cb),
  onContent: (cb) => subscribe(Channels.CONTENT, cb),
  onLift: (cb) => subscribe(Channels.LIFT, cb),
  onFreezePrepare: (cb) => subscribe(Channels.FREEZE_PREPARE, cb),
  onFreezeCommit: (cb) => subscribe(Channels.FREEZE_COMMIT, cb),

  // 개발용 뷰 토글.
  onViewMode: (cb) => subscribe(Channels.VIEW_MODE, cb),
  toggleView: () => ipcRenderer.send(Channels.VIEW_TOGGLE),

  // 재생/정지 상태 구독.
  onPlayState: (cb) => subscribe(Channels.PLAY_STATE, cb),

  // renderer → main.
  sendInput: (action) => ipcRenderer.send(Channels.INPUT, { action }),
  sendFreezeReady: () => ipcRenderer.send(Channels.FREEZE_READY, { projectorIndex })
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('zoetrope', zoetrope)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.zoetrope = zoetrope
}
