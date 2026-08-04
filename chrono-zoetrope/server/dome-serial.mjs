// 돔 시리얼 브리지 — ESP32(TMC2209 스테퍼 4개, BT SPP 'OrigamiDome')에 한 글자 명령을 보낸다.
//
// 명령(ESP32 펌웨어와 약속): 'f'=감기, 'b'=되감기, 's'=정지, 'p'=ESP32 내장 시퀀스 재생.
// 국면 전환(index.mjs의 REEL_DEMO 방송)마다 montage.json dome.cues 매핑에 따라 자동 송신된다.
//
// 연결은 best-effort: 포트가 없거나 끊겨도 전시는 계속된다(명령만 버려짐). 5초마다 재접속 시도.
// Windows에서 ESP32 BT 페어링 시 COM 포트가 두 개 생긴다 — '발신(outgoing)' 쪽을 dome.port에 적는다.

import { SerialPort } from 'serialport'

let port = null
let desiredPath = null
let baudRate = 115200
let retryTimer = null
let lastCmd = null

function scheduleRetry() {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    open()
  }, 5000)
}

function open() {
  if (!desiredPath) return
  port = new SerialPort({ path: desiredPath, baudRate }, (err) => {
    if (err) {
      console.warn(`[dome] ${desiredPath} 열기 실패(5초 후 재시도): ${err.message}`)
      port = null
      scheduleRetry()
      return
    }
    console.log(`[dome] 연결됨: ${desiredPath} @${baudRate}`)
    // 재접속 직후 마지막 명령을 재전송 — 끊긴 사이의 국면을 돔이 따라잡는다.
    if (lastCmd) port.write(lastCmd)
  })
  port.on('close', () => {
    console.warn('[dome] 포트 닫힘 — 재접속 시도')
    port = null
    scheduleRetry()
  })
  port.on('error', () => {}) // open 콜백·close에서 처리 — 프로세스 크래시만 방지
}

/** 서버 기동 시 한 번 호출. path가 없으면(config 미설정) 돔 연동 전체가 조용히 꺼진다. */
export function initDome({ path, baudRate: baud = 115200 } = {}) {
  if (!path) {
    console.log('[dome] dome.port 미설정 — 돔 연동 없이 진행')
    return
  }
  desiredPath = path
  baudRate = baud
  open()
}

/** 한 글자 명령 송신(best-effort). 연결 전/끊김이면 버리고, 재접속 시 마지막 명령만 따라잡는다. */
export function domeCmd(c) {
  if (!c) return
  lastCmd = c
  if (!port?.isOpen) return
  port.write(c, (err) => {
    if (err) console.warn(`[dome] 송신 실패: ${err.message}`)
  })
  console.log(`[dome] → '${c}'`)
}
