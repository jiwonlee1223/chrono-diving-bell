// 돔 시리얼 브리지 — ESP32(TMC2209 스테퍼 4개, BT SPP 'OrigamiDome')에 한 글자 명령을 보낸다.
//
// 명령(ESP32 펌웨어와 약속): 'f'=감기, 'b'=되감기, 's'=정지, 'p'=ESP32 내장 시퀀스 재생.
// 국면 전환(index.mjs의 REEL_DEMO 방송)마다 montage.json dome.cues 매핑에 따라 자동 송신된다.
//
// 연결은 best-effort: 포트가 없거나 끊겨도 전시는 계속된다(명령만 버려짐). 5초마다 재접속 시도.
// 단, 열기 실패가 3번 연속되면 포기한다(2026-08-05) — 포트가 아예 없는 날 5초마다 경고가 쌓이는 걸 막는다.
// 연결에 성공하면 카운터가 리셋되므로, 전시 중 끊김에는 다시 3번의 재시도 기회가 생긴다.
// Windows에서 ESP32 BT 페어링 시 COM 포트가 두 개 생긴다 — '발신(outgoing)' 쪽을 dome.port에 적는다.

import { SerialPort } from 'serialport'

let port = null
let desiredPath = null
let baudRate = 115200
let retryTimer = null
let lastCmd = null
const MAX_OPEN_FAILURES = 3
let openFailures = 0

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
      port = null
      openFailures++
      if (openFailures >= MAX_OPEN_FAILURES) {
        console.warn(
          `[dome] ${desiredPath} 열기 실패 ${openFailures}회 — 재시도 중단(돔 연동 없이 진행): ${err.message}`
        )
        return
      }
      console.warn(
        `[dome] ${desiredPath} 열기 실패(${openFailures}/${MAX_OPEN_FAILURES}, 5초 후 재시도): ${err.message}`
      )
      scheduleRetry()
      return
    }
    openFailures = 0
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

// ── 시퀀스 재생 — 안무({c:명령, ms:지속시간} 목록)를 타이머로 순서대로 송신 ──
let seqTimer = null

/** 진행 중인 시퀀스 중단(모터는 건드리지 않음 — 멈추려면 이어서 domeCmd('s')). */
export function domeStopSequence() {
  if (seqTimer) clearTimeout(seqTimer)
  seqTimer = null
}

/**
 * 시퀀스 재생. steps=[{c:'f',ms:1500}, ...], loop=true면 끝나면 처음부터 반복.
 * 새 시퀀스·단일 명령이 오면 이전 시퀀스는 교체된다(국면 전환 = 안무 교체).
 */
export function domePlay(steps, { loop = false } = {}) {
  domeStopSequence()
  if (!Array.isArray(steps) || !steps.length) return
  let i = 0
  const tick = () => {
    const st = steps[i]
    domeCmd(st.c)
    i++
    if (i >= steps.length) {
      if (!loop) {
        seqTimer = null
        return
      }
      i = 0
    }
    seqTimer = setTimeout(tick, Math.max(0, st.ms ?? 0))
  }
  tick()
}

/** 국면 큐 실행 — 문자열('f')이면 단일 명령, {steps,loop}면 시퀀스. */
export function domeCue(cue) {
  if (!cue) return
  if (typeof cue === 'string') {
    domeStopSequence()
    domeCmd(cue)
  } else if (Array.isArray(cue.steps)) {
    domePlay(cue.steps, { loop: !!cue.loop })
  }
}
