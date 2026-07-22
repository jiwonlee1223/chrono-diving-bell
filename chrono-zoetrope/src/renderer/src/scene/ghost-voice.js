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

// getSession: () => Promise<{ enabled, signedUrl, overrides, startDelayMs } | { enabled:false }>
// onSpeaking: (boolean) => void  — 유령이 말하는 동안 true (발광 부스트 등 시각 연동용).
export function createGhostVoice({ getSession, onSpeaking } = {}) {
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

      convo = await Conversation.startSession({
        signedUrl: session.signedUrl,
        connectionType: 'websocket',
        // §1 경계·페르소나·첫 질문·언어·보이스는 서버가 만든 오버라이드에 담겨 있다.
        overrides: session.overrides,
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
