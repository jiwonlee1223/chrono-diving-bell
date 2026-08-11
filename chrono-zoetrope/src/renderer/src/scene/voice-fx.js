// 유령 목소리 공용 이펙트 체인(2026-08-10) — 부스트·리미터·에코·(선택)스테레오 패닝.
// 종전엔 ghost-voice.js(대화)만 이 체인을 타고 내레이션(playNarration — 장례식·릴 회고)은
// 맨 <audio>로 재생돼 "장례식 목소리가 다르다"(에코·울림 없음)는 문제가 있었다. 한 모듈로 빼서
// 두 경로가 같은 상수·같은 그래프를 쓰게 한다 — 목소리의 결(속도는 서버 TTS, 울림은 여기)이
// 앱 전체에서 고정된다. 상수를 바꾸면 대화·내레이션이 함께 움직인다.

// 패닝 — 유령 위치를 따라 좌우(입체감). 후면투사 반전 설치에서 좌우가 뒤집히면 PAN_INVERT=-1.
const PAN_INVERT = 1
const MAX_PAN = 0.85
const VOICE_GAIN = 5 // 목소리 배율 — HTMLAudio volume은 1.0 상한이라 Web Audio 게인으로 키운다.
// 에코 — 먼 곳에서 울려오는 느낌. 원음(dry)은 그대로 두고 젖은 신호만 섞는다.
const ECHO_DELAY = 0.28 //    반복 간격(초). 짧으면 방 울림, 길면 동굴 울림.
const ECHO_FEEDBACK = 0.25 // 반복마다 감쇠율(0~1). 높을수록 꼬리가 길게 남는다.
const ECHO_WET = 0.15 //      에코 섞는 비율. 0이면 에코 없음(원음만).

let audioCtx = null //      지연 생성 AudioContext(대화·내레이션 공유).
const mediaSources = new WeakMap() // <audio> → MediaElementSource(요소당 한 번만 생성 가능).
let panRaf = 0 //           재생 중 pan 추종 rAF.

export function ensureVoiceCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    audioCtx = new AC()
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
  return audioCtx
}

// 첫 발화 워밍업 — AudioContext 생성·resume과 OS 출력 스트림이 열리는 첫 100~300ms 동안은
// 소리가 버려져 TTS 앞 반 음절이 잘린다. 첫 재생 전에 무음 버퍼를 한 번 틀어 출력을 깨운다.
let voiceWarmedUp = false
export async function warmUpVoiceAudio() {
  if (voiceWarmedUp) return
  voiceWarmedUp = true // 실패해도 재시도로 발화를 계속 지연시키지 않는다
  const ctx = ensureVoiceCtx()
  if (!ctx) return
  try {
    if (ctx.state !== 'running') await ctx.resume()
    const buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.05), ctx.sampleRate)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    src.start()
    await new Promise((r) => setTimeout(r, 150)) // 출력 스트림이 실제로 열릴 시간
  } catch {
    /* 워밍업 실패 — 그냥 재생(기존 동작) */
  }
}

/**
 * <audio>를 공용 이펙트 체인(부스트→리미터, 에코 병렬 합류)에 연결한다. getPan이 있으면
 * 재생 중 매 프레임 유령 위치를 따라 스테레오 패닝을 갱신하고, 없으면(내레이션) 중앙 고정.
 * Web Audio 불가·CORS 등으로 실패하면 조용히 그대로 둔다(<audio>가 기본 출력으로 재생).
 * @returns {() => void} 정리 함수
 */
export function attachVoiceFx(a, getPan = null) {
  const ctx = ensureVoiceCtx()
  if (!ctx) return () => {}
  let panner
  try {
    let src = mediaSources.get(a)
    if (!src) {
      src = ctx.createMediaElementSource(a)
      mediaSources.set(a, src)
    }
    panner = ctx.createStereoPanner()
    const boost = ctx.createGain()
    boost.gain.value = VOICE_GAIN
    // 리미터 — 증폭으로 0dB를 넘는 피크만 눌러 클리핑(찢어짐)을 막는다. 평상시 음색엔 거의 관여 안 함.
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -3
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.002
    limiter.release.value = 0.1
    src.connect(panner)
    panner.connect(boost)
    boost.connect(limiter)
    // 에코 — boost에서 갈라져 delay→feedback 루프를 돌며 잦아드는 젖은 신호를 리미터에 합류.
    // 원음(dry) 경로는 위에서 그대로 유지되므로 대사 명료도는 잃지 않는다.
    if (ECHO_WET > 0) {
      const delay = ctx.createDelay(2)
      delay.delayTime.value = ECHO_DELAY
      const feedback = ctx.createGain()
      feedback.gain.value = ECHO_FEEDBACK
      const wet = ctx.createGain()
      wet.gain.value = ECHO_WET
      boost.connect(delay)
      delay.connect(feedback)
      feedback.connect(delay)
      delay.connect(wet)
      wet.connect(limiter)
    }
    limiter.connect(ctx.destination)
  } catch {
    return () => {} // 이 요소는 이미 라우팅됐거나 패닝 불가 — 그냥 둔다.
  }
  if (typeof getPan === 'function') {
    const follow = () => {
      const p = Math.max(-1, Math.min(1, (getPan() || 0) * PAN_INVERT)) * MAX_PAN
      // 부드럽게 수렴(급격한 위치 점프에도 소리가 튀지 않게).
      panner.pan.value += (p - panner.pan.value) * 0.15
      panRaf = requestAnimationFrame(follow)
    }
    panner.pan.value = Math.max(-1, Math.min(1, (getPan() || 0) * PAN_INVERT)) * MAX_PAN
    follow()
  } else {
    panner.pan.value = 0 // 내레이션 — 중앙 고정
  }
  return () => {
    cancelPanFollow()
    try {
      panner.disconnect()
    } catch {
      /* 무시 */
    }
  }
}

/** 진행 중인 pan 추종 rAF 중지 — ghost-voice stop() 등 전역 정리에서 부른다. */
export function cancelPanFollow() {
  if (panRaf) {
    cancelAnimationFrame(panRaf)
    panRaf = 0
  }
}
