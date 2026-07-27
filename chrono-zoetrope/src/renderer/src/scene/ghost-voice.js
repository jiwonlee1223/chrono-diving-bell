// 유령 음성 대화 컨트롤러 — reel 종료 후 'ghost' 국면에서만 유령이 말을 건다.
//
// 두 엔진(서버 /api/ghost/session의 engine 필드가 고른다 — montage.json ghost.voice.engine):
//   bridge(기본) — "중간 다리": 브라우저 STT(Web Speech, 끝점 감지=VAD) → 서버 Gemini가 대답과
//     띄울 장면을 JSON으로 생성(/api/ghost/turn) → ElevenLabs 순수 TTS(/api/ghost/tts, 실패 시
//     브라우저 TTS 폴백). ElevenLabs 대시보드 설정(에이전트·client tool 등록)이 필요 없다.
//     턴 단위 대화라 끼어들기(barge-in)는 없다 — 나직하고 느린 유령 페르소나에 맞춘 트레이드오프.
//   convai — ElevenLabs Conversational AI (@elevenlabs/client). STT·두뇌·TTS·턴테이킹을 SDK 한
//     세션이 처리. 도구는 ElevenLabs 대시보드의 에이전트 설정에 선언돼 있어야 호출된다.
//   - 마이크·스피커가 런타임 머신(브라우저)에 있으므로 오디오는 브라우저가 소유한다.
//   - API 키는 서버에만 둔다(bridge=TTS 중계, convai=서명 URL 발급).
//
// §1(해석적 자율성): 유령은 'ghost' 국면에서만 말한다. 1인칭 진입(IMMERSION)·몽타주 재생 등
//   다른 모든 국면에서는 renderer가 stop()을 불러 목소리를 끈다. 이 파일은 시작/종료만 관리한다.
//
// 실패는 조용히 삼킨다 — 미설정·키 없음·마이크 거부·비보안 컨텍스트면 목소리 없이 유령만 뜬다(§1 침묵 폴백).

import { Conversation } from '@elevenlabs/client'

// getSession: () => Promise<{ enabled, flow, signedUrl, overrides, startDelayMs, past?, future? } | { enabled:false }>
// onSpeaking: (boolean) => void  — 유령이 말하는 동안 true (발광 부스트 등 시각 연동용).
// playVideo: (url, opts?) => Promise — 대화 tool이 부르는 영상 재생. opts.fadeIn=true면 검정에서
//   서서히 떠오른다(과거 회귀 연출). 첫 한 바퀴 뒤 resolve하고 영상은 loop로 계속 흐른다.
export function createGhostVoice({ getSession, onSpeaking, playVideo } = {}) {
  let convo = null //     현재 Conversation 세션(없으면 null, convai 엔진 전용).
  let starting = false // start 진행 중(중복 시작 방지).
  let stopped = true //   stop 요청 상태 — 시작 지연 도중 취소를 감지한다.
  let startTimer = null // show 램프 뒤 말 걸기까지의 지연 타이머.
  let bridgeAudio = null //       bridge: 재생 중 <audio> (ElevenLabs TTS) — stop()이 끊는다.
  let bridgeRecognition = null // bridge: 진행 중 SpeechRecognition — stop()이 abort한다.

  // ── bridge 엔진 (기본): 브라우저 STT → 서버 Gemini(/api/ghost/turn) → 서버 TTS(/api/ghost/tts) ──
  // ElevenLabs 대시보드(에이전트·도구 등록)가 필요 없다. 턴 단위 대화: 듣기 → 생각 → 말하기.
  // 끼어들기(barge-in)는 없다 — 유령이 말을 마친 뒤에 귀를 기울인다(나직하고 느린 페르소나에 맞춤).

  async function postTurn(text, kind) {
    const r = await fetch('/api/ghost/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, kind })
    })
    if (!r.ok) throw new Error(`turn ${r.status}`)
    return r.json()
  }

  // 브라우저 내장 TTS 폴백 — 서버 TTS(키 없음·쿼터 초과 등) 실패 시에도 유령이 침묵하지 않게.
  function speakWithBrowserTts(text) {
    return new Promise((resolve) => {
      try {
        const u = new SpeechSynthesisUtterance(text)
        u.lang = 'ko-KR'
        u.onend = resolve
        u.onerror = resolve
        speechSynthesis.speak(u)
      } catch {
        resolve()
      }
    })
  }

  // 한 마디를 소리로 낸다: 서버 TTS(ElevenLabs)를 GET 스트리밍으로 — <audio src>가 첫 청크부터
  // 점진 재생하므로 합성 전체를 기다리지 않는다(발화 시작 지연 최소화). 실패 시 브라우저 TTS 폴백.
  async function speak(text) {
    if (!text || stopped) return
    onSpeaking?.(true)
    try {
      const ok = await new Promise((resolve) => {
        const a = new Audio(`/api/ghost/tts?text=${encodeURIComponent(text)}`)
        bridgeAudio = a
        let settled = false
        const done = (good) => {
          if (settled) return
          settled = true
          if (bridgeAudio === a) bridgeAudio = null
          resolve(good)
        }
        a.onended = () => done(true)
        a.onerror = () => done(false) // 503(키 없음) 등 — 폴백으로
        a.play().catch(() => done(false))
      })
      if (!ok && !stopped) await speakWithBrowserTts(text)
    } finally {
      onSpeaking?.(false)
    }
  }

  // 한 발화를 끝까지 귀 기울여 듣는다 — Web Speech API(Chrome, ko-KR) continuous 모드.
  // 브라우저의 짧은 끝점 감지에 발화 종료를 맡기지 않는다: 말하다 잠깐 멈칫해도 endSilenceMs 동안
  // 조용해질 때까지 기다렸다가 그때까지 쌓인 문장 전체를 돌려준다. 브라우저가 세션을 스스로 닫으면
  // (장시간 무음 등) 들은 게 없을 때 재시작해 계속 기다린다. 침묵이면 null, API 미지원이면 undefined.
  function listenUtterance({ endSilenceMs = 2500, maxUtteranceMs = 45000 } = {}) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      let finalText = ''
      let interim = ''
      let done = false
      let silenceTimer = null
      let overallTimer = null
      let rec = null

      function finish() {
        if (done) return
        done = true
        clearTimeout(silenceTimer)
        clearTimeout(overallTimer)
        if (bridgeRecognition === rec) bridgeRecognition = null
        try {
          rec?.stop()
        } catch {
          /* 무시 */
        }
        resolve(`${finalText} ${interim}`.trim() || null)
      }

      // 무슨 말이든 들리기 시작한 뒤에만 침묵 타이머를 돌린다 — 아무 말 없을 땐 계속 기다린다.
      function armSilence() {
        clearTimeout(silenceTimer)
        silenceTimer = setTimeout(finish, endSilenceMs)
        if (!overallTimer) overallTimer = setTimeout(finish, maxUtteranceMs) // 발화 시작 기준 상한
      }

      function startRec() {
        if (done || stopped) return finish()
        rec = new SR()
        bridgeRecognition = rec
        rec.lang = 'ko-KR'
        rec.continuous = true //      브라우저의 조기 종료 대신 우리가 endSilenceMs로 끝점을 정한다
        rec.interimResults = true //  중간 결과가 올 때마다 침묵 타이머를 리셋
        rec.maxAlternatives = 1
        rec.onresult = (e) => {
          interim = ''
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i]
            if (r.isFinal) finalText += r[0].transcript
            else interim += r[0].transcript
          }
          armSilence()
        }
        rec.onerror = () => {}
        rec.onend = () => {
          if (done) return
          if (`${finalText}${interim}`.trim())
            finish() // 들은 게 있는데 세션이 닫힘 — 발화 종료로 본다
          else if (!stopped)
            setTimeout(startRec, 150) // 무음으로 닫힘 — 다시 귀 기울인다(계속 기다림)
          else finish()
        }
        try {
          rec.start()
        } catch {
          finish()
        }
      }
      startRec()
    })
  }

  // bridge 대화 본 루프: 인사(회고) → [듣기 → 턴 → 말하기 → (영상 → 상황 알림 턴 → 말하기)] 반복.
  async function runBridge(session) {
    await speak(session.greeting)
    if (stopped) return
    if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
      console.warn('[ghost-voice] SpeechRecognition 미지원 — 인사만 하고 조용히 곁에 머문다')
      return
    }
    while (!stopped) {
      const heard = await listenUtterance(session.listen)
      if (stopped) return
      if (!heard) {
        // 침묵은 재촉하지 않는다(페르소나) — 곧바로 다시 귀 기울인다(listenUtterance가 이미 오래 기다렸다).
        await new Promise((r) => setTimeout(r, 300))
        continue
      }
      let reply
      try {
        reply = await postTurn(heard, 'user')
      } catch (e) {
        console.warn('[ghost-voice] 턴 실패:', e?.message || e)
        continue
      }
      if (stopped) return
      if (reply?.say) await speak(reply.say) // 예: "기다려봐. 그때의 기억으로 돌아가자."
      if (stopped) return
      if (reply?.video?.url) {
        // 검정 → 그 순간이 떠오른다(pingpong loop). resolveAfterSec: 첫 loop 한 바퀴(최대 18s)를
        // 기다리지 않고 fade-in 직후 후속 대사로 넘어간다 — 영상은 뒤에서 계속 돈다.
        await playVideo?.(reply.video.url, { fadeIn: true, resolveAfterSec: 3 })
        if (stopped) return
        // 영상이 떠오른 상황을 서버 두뇌에 알려 다음 대사("이때 쯤을 이야기하는 거지?" /
        // "왜 이때의 모습이 보고싶었어?")를 받는다.
        try {
          const follow = await postTurn(
            `(방금 ${reply.video.age}살(${reply.video.year}년) 장면 영상이 화면에 떠올랐다. exact=${reply.video.exact}. 장면: ${reply.video.scene})`,
            'event'
          )
          if (!stopped && follow?.say) await speak(follow.say)
        } catch {
          /* 다음 듣기로 계속 */
        }
      }
    }
  }

  // ── flow별 client tools ────────────────────────────────────────────

  // 1차(과거 회귀): show_past_moment(id, exact) — 서버가 시스템 프롬프트 끝에 붙인 장면 카탈로그에서
  // 에이전트가 고른 과거 장면을 재생한다. 화면은 검정에서 fade-in, 영상은 pingpong loop(서버가 준비,
  // 없으면 원본 loop)로 계속 흐른다. exact=false면 반환 문자열에 힌트를 실어 에이전트가
  // "이때 쯤을 이야기하는 거지?" 대사를 잇게 한다(페르소나 흐름).
  function buildPastTools(session) {
    const moments = session.past?.moments || []
    const byId = new Map(moments.map((m) => [String(m.id), m]))
    const nearestByAge = (age) => {
      if (!moments.length) return null
      if (!Number.isFinite(age)) return moments[moments.length - 1] // 해석 불가 — 가장 최근 장면
      return moments.reduce((best, m) =>
        Math.abs(m.age - age) < Math.abs(best.age - age) ? m : best
      )
    }
    return {
      show_past_moment: async (params = {}) => {
        const id = String(params.id ?? '').trim()
        let m = byId.get(id)
        let idFallback = false
        if (!m) {
          // 에이전트가 카탈로그에 없는 id를 불렀다 — id 앞 숫자(나이 추정)로 가장 가까운 장면 폴백.
          m = nearestByAge(parseInt(id, 10))
          idFallback = true
        }
        if (!m) return '보여줄 과거 영상이 없어.'
        const exact = (params.exact === true || params.exact === 'true') && !idFallback
        await playVideo?.(m.url, { fadeIn: true })
        const head = `${m.age}살(${m.year}년)의 순간이야.`
        const desc = m.scene ? ` [화면 속 장면] ${m.scene}` : ''
        const note = exact
          ? ''
          : ' (말한 순간 그대로는 없어서 비슷한 시기를 보여주는 중 — "이때 쯤을 이야기하는 거지?"라고 확인해줘)'
        return head + desc + note
      }
    }
  }

  // 2차(미래 큐레이션): 기존 흐름 그대로 보존.
  //  show_future_self(years_ahead): '몇 년 뒤'에 가장 가까운 미래 나잇대의 첫 영상 재생.
  //  show_another(): 같은 나잇대의 다음 영상(그 시기 3장면을 차례로). 반환 문자열이 에이전트에 전달돼
  //   다음 대사('다른 것도 보여줄게' 등)를 잇게 한다. 영상은 renderer가 원본 속도로 재생하고 끝까지 대기한다.
  function buildFutureTools(session) {
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
    const describe = (v, remaining, first) => {
      const head = `${stage.age}세(약 ${stage.yearsAhead}년 뒤)의 ${first ? '' : '다른 '}모습이야.`
      const desc = v.scene ? ` [화면 속 장면] ${v.scene}` : ''
      const more =
        remaining > 0 ? ` (이 시기 장면 ${remaining}개 더 있음)` : ' (이 시기 마지막 장면)'
      return head + desc + more
    }
    return {
      show_future_self: async (params = {}) => {
        const yearsAhead = Number(params.years_ahead) || 0
        stage = pickStage(yearsAhead)
        cursor = 0
        if (!stage || !stage.videos.length) return '보여줄 미래 영상이 없어.'
        const v = stage.videos[cursor]
        await playVideo?.(v.url)
        cursor = 1
        return describe(v, stage.videos.length - cursor, true)
      },
      show_another: async () => {
        if (!stage) return '아직 보여준 시기가 없어. 먼저 show_future_self를 써.'
        if (cursor >= stage.videos.length) return '이 시기 장면은 이게 마지막이었어. 더 없어.'
        const v = stage.videos[cursor]
        await playVideo?.(v.url)
        cursor += 1
        return describe(v, stage.videos.length - cursor, false)
      }
    }
  }

  async function start() {
    stopped = false
    if (convo || starting) return // 이미 말하는 중이거나 시작 중.
    starting = true
    try {
      const session = await getSession?.()
      if (stopped) return // 시작 절차 도중 stop됨.
      if (!session || session.enabled === false) {
        // 음성 미설정 — 조용히 유령만. 콘솔에만 남긴다(§1: 화면 자막 없음).
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

      // ── bridge 엔진(기본): 서버 두뇌 대화 루프. 마이크 권한을 미리 받아 첫 듣기 지연을 줄인다.
      // 마이크가 거부·불가(비보안 컨텍스트)면 인사(회고)만 하고 조용히 머문다(§1 침묵 폴백).
      if (session.engine !== 'convai') {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          stream.getTracks().forEach((t) => t.stop())
        } catch {
          console.warn('[ghost-voice] 마이크 불가 — 인사만 하고 듣기는 생략될 수 있음')
        }
        await runBridge(session)
        return
      }

      // ── convai 엔진(기존): ElevenLabs Conversational AI 세션 ──
      // 비보안 컨텍스트(http://LAN-IP 등)에서는 getUserMedia가 막힌다 → 마이크 대화 불가.
      if (!navigator.mediaDevices?.getUserMedia) {
        console.warn('[ghost-voice] 마이크 불가(비보안 컨텍스트?) — 목소리 없이 진행')
        return
      }
      if (!session.signedUrl) return

      // client tools — 에이전트(대화 두뇌)가 대화 중 호출한다. 세션의 flow가 구성을 고른다.
      // tool 반환은 문자열 — 에이전트가 이걸 읽고 [화면 속 장면]을 2인칭으로 풀어 준다(페르소나 흐름).
      const clientTools =
        session.flow === 'future' ? buildFutureTools(session) : buildPastTools(session)

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
    // bridge 엔진 정리 — 듣기 중단·재생 중 목소리 즉시 끊기(§1: 다른 국면에선 침묵).
    if (bridgeRecognition) {
      try {
        bridgeRecognition.abort()
      } catch {
        /* 무시 */
      }
      bridgeRecognition = null
    }
    if (bridgeAudio) {
      try {
        bridgeAudio.pause()
      } catch {
        /* 무시 */
      }
      bridgeAudio = null
    }
    try {
      speechSynthesis?.cancel()
    } catch {
      /* 무시 */
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
