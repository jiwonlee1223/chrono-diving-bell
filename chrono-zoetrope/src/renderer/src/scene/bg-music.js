// 대화 배경음악 — 'ghost' 국면에서 유령과 대화하는 동안 나직하게 깔린다.
//
// 볼륨은 0~10 레벨로 다룬다(TTS 음성 볼륨과 같은 눈금 — level 10 = TTS 발화 크기와 동일).
//   · 평소(idle)        level 10  — 아무도 말하지 않을 때
//   · 에이전트 발화 중   level 3   — 유령의 목소리(TTS)를 덮지 않게 크게 낮춘다
//   · 사용자 청취 중     level 5   — 사용자가 말하는 동안 살짝 낮춘다(STT 방해 최소화)
// 상태가 겹치면 발화(3)가 청취(5)보다 우선한다. 전이는 짧은 램프로 부드럽게.
//
// 반복은 loop 재생처럼 이음매 없이 — 파일 앞뒤를 crossfade 한다. HTMLAudio의 loop는
// 끝→처음에 뚝 끊기므로, Web Audio로 버퍼를 디코드해 두 소스를 겹쳐 틀고 경계에서
// 페이드 교차시킨다(끝 CROSSFADE초 동안 현재는 줄고 다음은 커진다).
//
// 실패는 조용히 삼킨다 — 파일 없음·디코드 실패·오디오 컨텍스트 불가면 음악 없이 진행한다(§1 침묵 폴백).

const LEVEL = { idle: 10, agent: 5, user: 5 } // agent: 유령 발화 중 — 최종 gain 0.05 (5/10 × MASTER 0.1)
const CROSSFADE_SEC = 4 //  앞뒤 이음매 crossfade 길이(초)
const DUCK_RAMP_SEC = 0.5 // 발화/청취 전이 시 볼륨 램프 길이(초)
const MASTER = 0.1 //        level 10 → gain(MASTER). 설치 현장에서 전체 크기만 조정하고 싶을 때 여기만 만진다.
//                          (1.0=파일 원음 크기. 목소리가 음악 위로 또렷하게 들리도록 전체를 낮춰 둠.)

const gainForLevel = (level) => (Math.max(0, Math.min(10, level)) / 10) * MASTER
const TRIM_MIN = 0.05 // 무음 직전까지만 — 완전 0이면 켜져 있는지 알 수 없다
const TRIM_MAX = 3.0 //  MASTER 대비 최대 3배(파일 원음 0.9)까지

// src: 배경음악 파일 URL(예: '/resources/Where_Light_Ends.mp3')
export function createBgMusic({ src } = {}) {
  let ctx = null //        AudioContext
  let buffer = null //     디코드된 오디오 버퍼
  let duck = null //       덕킹 게인 노드(상태에 따라 레벨 조절) → destination
  let started = false //   재생 시작됨
  let stopped = true //    stop 요청 상태
  let loopTimer = null //  다음 소스 예약 타이머
  let sources = [] //      살아있는 BufferSource들(stop()이 모두 끊는다)
  let agentSpeaking = false
  let userListening = false
  let trim = 1 // 런타임 배율(A/S 키) — 덕킹 레벨에 곱해진다. 1 = MASTER 그대로.

  async function ensureLoaded() {
    if (buffer) return true
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)()
      const res = await fetch(src)
      if (!res.ok) throw new Error(`fetch ${res.status}`)
      const arr = await res.arrayBuffer()
      buffer = await ctx.decodeAudioData(arr)
      return true
    } catch (e) {
      console.warn('[bg-music] 로드 실패 — 음악 없이 진행:', e?.message || e)
      return false
    }
  }

  // 현재 상태의 목표 레벨: 발화(3) > 청취(5) > idle(10).
  function targetLevel() {
    if (agentSpeaking) return LEVEL.agent
    if (userListening) return LEVEL.user
    return LEVEL.idle
  }

  function applyLevel(rampSec = DUCK_RAMP_SEC) {
    if (!ctx || !duck) return
    const now = ctx.currentTime
    const g = duck.gain
    g.cancelScheduledValues(now)
    g.setValueAtTime(g.value, now)
    g.linearRampToValueAtTime(gainForLevel(targetLevel()) * trim, now + rampSec)
  }

  // A/S 키 — 재생 중 음량 배율을 곱해 조절한다(예: 1.5 = 업, 1/1.5 = 다운).
  // 반환: { trim, gain, playing } — 호출부(HUD)가 현재 값을 표시한다.
  function nudgeVolume(factor) {
    trim = Math.max(TRIM_MIN, Math.min(TRIM_MAX, trim * factor))
    applyLevel(0.1)
    const gain = gainForLevel(targetLevel()) * trim
    console.log(`[bg-music] trim ×${trim.toFixed(2)} → 실효 gain ${gain.toFixed(3)}`)
    return { trim, gain, playing: started }
  }

  // 한 바퀴 소스를 지금 시각(when)에 예약하고, 자기 몫의 crossfade 페이드를 건다.
  // 그리고 (길이 - CROSSFADE)초 뒤 다음 바퀴를 이어 예약한다 — 이음매 없이 계속 돈다.
  function scheduleLoop(when) {
    if (stopped || !ctx || !buffer) return
    const dur = buffer.duration
    const xf = Math.min(CROSSFADE_SEC, dur / 2) // 짧은 곡이면 crossfade를 반으로 제한

    const srcGain = ctx.createGain()
    srcGain.connect(duck)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(srcGain)

    // 시작 페이드인(앞 바퀴의 페이드아웃과 교차) — 첫 바퀴는 이미 소리나던 게 없으니 그대로 페이드인.
    const g = srcGain.gain
    g.setValueAtTime(0, when)
    g.linearRampToValueAtTime(1, when + xf)
    // 끝 페이드아웃(다음 바퀴의 페이드인과 교차).
    g.setValueAtTime(1, when + dur - xf)
    g.linearRampToValueAtTime(0, when + dur)

    src.start(when)
    src.stop(when + dur + 0.05)
    sources.push(src)
    src.onended = () => {
      sources = sources.filter((s) => s !== src)
      try {
        srcGain.disconnect()
      } catch {
        /* 무시 */
      }
    }

    // 다음 바퀴는 이 바퀴가 페이드아웃을 시작하는 시점(끝-xf)에 페이드인을 시작한다.
    const nextWhen = when + dur - xf
    const delayMs = Math.max(0, (nextWhen - ctx.currentTime) * 1000)
    loopTimer = setTimeout(() => scheduleLoop(nextWhen), delayMs)
  }

  async function start() {
    stopped = false
    if (started) return
    if (!(await ensureLoaded())) return
    if (stopped) return
    started = true
    // 사용자 제스처 뒤라면 resume가 필요할 수 있다(자동재생 정책).
    try {
      await ctx.resume()
    } catch {
      /* 무시 */
    }
    if (ctx.state !== 'running') {
      // 자동재생 차단 — 제스처 없이 만든 컨텍스트는 suspended로 남는다. 첫 입력에서 재개.
      console.warn(
        `[bg-music] AudioContext '${ctx.state}' — 자동재생 정책으로 무음. 클릭/키 입력 시 재개됩니다.`
      )
      const resume = () => {
        ctx
          .resume()
          .then(() => console.log(`[bg-music] AudioContext 재개됨 (state=${ctx.state})`))
          .catch(() => {})
      }
      window.addEventListener('pointerdown', resume, { once: true })
      window.addEventListener('keydown', resume, { once: true })
    } else {
      console.log('[bg-music] 재생 시작 (AudioContext running)')
    }
    duck = ctx.createGain()
    duck.gain.setValueAtTime(gainForLevel(targetLevel()) * trim, ctx.currentTime)
    duck.connect(ctx.destination)
    scheduleLoop(ctx.currentTime + 0.05)
  }

  function stop() {
    stopped = true
    started = false
    if (loopTimer) {
      clearTimeout(loopTimer)
      loopTimer = null
    }
    for (const s of sources) {
      try {
        s.stop()
      } catch {
        /* 무시 */
      }
    }
    sources = []
    agentSpeaking = false
    userListening = false
    if (duck) {
      try {
        duck.disconnect()
      } catch {
        /* 무시 */
      }
      duck = null
    }
  }

  // 유령이 말하는 동안 true — 음악을 level 3으로 낮춘다.
  function setAgentSpeaking(on) {
    agentSpeaking = !!on
    applyLevel()
  }
  // 사용자 발화를 듣는 동안 true — 음악을 level 5로 낮춘다.
  function setUserListening(on) {
    userListening = !!on
    applyLevel()
  }

  return { start, stop, setAgentSpeaking, setUserListening, nudgeVolume, dispose: stop }
}
