// 유령 음성 대화 컨트롤러 — reel 종료 후 'ghost' 국면에서만 유령이 말을 건다.
//
// 목소리 엔진: ElevenLabs Conversational AI (@elevenlabs/client).
//   - 마이크·스피커가 런타임 머신(브라우저)에 있으므로 오디오는 브라우저가 소유한다.
//   - API 키는 서버에만 둔다: 서버(/api/ghost/session)가 ElevenLabs 서명 URL을 발급하고,
//     §1 경계 페르소나·첫 질문·언어·보이스를 오버라이드로 함께 내려준다(ghost-persona.md).
//   - STT·LLM 두뇌·TTS·턴테이킹(끼어들기 포함)을 SDK가 한 세션으로 처리한다 → "인간다운" 대화.
//
// §1(해석적 자율성): 유령은 'ghost' 국면에서만 말한다. 1인칭 진입(IMMERSION)·몽타주 재생 등
//   다른 모든 국면에서는 renderer가 stop()을 불러 목소리를 끈다. 이 파일은 시작/종료만 관리한다.
//
// 실패는 조용히 삼킨다 — 미설정·키 없음·마이크 거부·비보안 컨텍스트면 목소리 없이 유령만 뜬다(§1 침묵 폴백).

import { Conversation } from '@elevenlabs/client'

// getSession: () => Promise<{ enabled, signedUrl, overrides, startDelayMs, future } | { enabled:false }>
// onSpeaking: (boolean) => void  — 유령이 말하는 동안 true (발광 부스트 등 시각 연동용).
// playFutureVideo: (url) => Promise — 미래 자기 모습 영상을 원본 속도로 재생하고 끝나면 resolve(대화 tool용).
export function createGhostVoice({ getSession, onSpeaking, playFutureVideo } = {}) {
  let convo = null //     현재 Conversation 세션(없으면 null).
  let starting = false // start 진행 중(중복 시작 방지).
  let stopped = true //   stop 요청 상태 — 시작 지연 도중 취소를 감지한다.
  let startTimer = null // show 램프 뒤 말 걸기까지의 지연 타이머.

  async function start() {
    stopped = false
    if (convo || starting) return // 이미 말하는 중이거나 시작 중.
    starting = true
    try {
      // 비보안 컨텍스트(http://LAN-IP 등)에서는 getUserMedia가 막힌다 → 마이크 대화 불가.
      // localhost 접속이거나 https면 통과. 막히면 조용히 유령만 띄운다(§1 침묵 폴백).
      if (!navigator.mediaDevices?.getUserMedia) {
        console.warn('[ghost-voice] 마이크 불가(비보안 컨텍스트?) — 목소리 없이 진행')
        return
      }

      const session = await getSession?.()
      if (stopped) return // 시작 절차 도중 stop됨.
      if (!session || session.enabled === false || !session.signedUrl) {
        // 음성 미설정(agentId·키 없음 등) — 조용히 유령만. 콘솔에만 남긴다(§1: 화면 자막 없음).
        return
      }

      // 유령이 나타난(show 램프) 뒤에 말을 건다. 그 전에 국면이 바뀌어 stop되면 시작하지 않는다.
      const delay = Math.max(0, session.startDelayMs ?? 0)
      if (delay > 0) {
        await new Promise((resolve) => {
          startTimer = setTimeout(resolve, delay)
        })
      }
      if (stopped) return

      // 미래 자기 모습 영상 재생용 client tools — 에이전트(대화 두뇌)가 대화 중 호출한다.
      //  show_future_self(years_ahead): '몇 년 뒤'에 가장 가까운 미래 나잇대의 첫 영상 재생.
      //  show_another(): 같은 나잇대의 다음 영상(그 시기 3장면을 차례로). 반환 문자열이 에이전트에 전달돼
      //   다음 대사('다른 것도 보여줄게' 등)를 잇게 한다. 영상은 renderer가 원본 속도로 재생하고 끝까지 대기한다.
      const future = session.future || { currentAge: null, futureStages: [] }
      let stage = null // 현재 보여주는 미래 나잇대 { age, yearsAhead, videos:[url…] }
      let cursor = 0 //   그 나잇대에서 다음에 보여줄 장면 인덱스
      const pickStage = (yearsAhead) => {
        const stages = future.futureStages || []
        if (!stages.length) return null
        // 가장 가까운 미래 나잇대(사용자 확정): |나잇대.yearsAhead - 말한 년수| 최소.
        return stages.reduce((best, s) =>
          Math.abs(s.yearsAhead - yearsAhead) < Math.abs(best.yearsAhead - yearsAhead) ? s : best
        )
      }
      // tool 반환은 문자열 — 에이전트가 이걸 읽고 큐레이터처럼 [화면 속 장면]을 2인칭으로 풀어 주고
      // 미래를 상상하게 묻는다(페르소나 흐름). 장면 텍스트를 그대로 실어 보낸다.
      const describe = (v, remaining, first) => {
        const head = `${stage.age}세(약 ${stage.yearsAhead}년 뒤)의 ${first ? '' : '다른 '}모습이야.`
        const desc = v.scene ? ` [화면 속 장면] ${v.scene}` : ''
        const more = remaining > 0 ? ` (이 시기 장면 ${remaining}개 더 있음)` : ' (이 시기 마지막 장면)'
        return head + desc + more
      }
      const clientTools = {
        show_future_self: async (params = {}) => {
          const yearsAhead = Number(params.years_ahead) || 0
          stage = pickStage(yearsAhead)
          cursor = 0
          if (!stage || !stage.videos.length) return '보여줄 미래 영상이 없어.'
          const v = stage.videos[cursor]
          await playFutureVideo?.(v.url)
          cursor = 1
          return describe(v, stage.videos.length - cursor, true)
        },
        show_another: async () => {
          if (!stage) return '아직 보여준 시기가 없어. 먼저 show_future_self를 써.'
          if (cursor >= stage.videos.length) return '이 시기 장면은 이게 마지막이었어. 더 없어.'
          const v = stage.videos[cursor]
          await playFutureVideo?.(v.url)
          cursor += 1
          return describe(v, stage.videos.length - cursor, false)
        }
      }

      convo = await Conversation.startSession({
        signedUrl: session.signedUrl,
        connectionType: 'websocket',
        // §1 경계·페르소나·첫 질문·언어·보이스는 서버가 만든 오버라이드에 담겨 있다.
        overrides: session.overrides,
        clientTools, // 미래 영상 재생 tool 구현(에이전트가 호출 → renderer가 재생)
        onModeChange: ({ mode } = {}) => onSpeaking?.(mode === 'speaking'),
        onStatusChange: () => {},
        onError: (message) => console.warn('[ghost-voice] 세션 오류:', message),
        onDisconnect: () => {
          convo = null
          onSpeaking?.(false)
        }
      })

      // 시작과 stop이 경쟁했다면(지연 없이 곧장 stop) 방금 연결을 즉시 정리.
      if (stopped) {
        const c = convo
        convo = null
        try {
          await c?.endSession()
        } catch {
          /* 무시 */
        }
      }
    } catch (err) {
      console.warn('[ghost-voice] start 실패:', err?.message || err)
      convo = null
    } finally {
      starting = false
    }
  }

  async function stop() {
    stopped = true
    if (startTimer) {
      clearTimeout(startTimer)
      startTimer = null
    }
    onSpeaking?.(false)
    const c = convo
    convo = null
    if (c) {
      try {
        await c.endSession()
      } catch {
        /* 이미 끊겼을 수 있음 — 무시 */
      }
    }
  }

  return {
    start, //     'ghost' 국면 진입 시 호출.
    stop, //      그 외 모든 국면·상태(§1: IMMERSION 침묵)에서 호출.
    dispose: stop
  }
}
