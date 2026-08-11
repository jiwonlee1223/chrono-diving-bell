// 유령 음성 대화 컨트롤러 — reel 종료 후 'ghost' 국면에서만 유령이 말을 건다.
//
// 두 엔진(서버 /api/ghost/session의 engine 필드가 고른다 — montage.json ghost.voice.engine):
//   bridge(기본) — "중간 다리": STT(OpenAI Realtime 전사+semantic_vad, 실패 시 Web Speech 폴백)
//     → 서버 Gemini가 대답과
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
import { attachVoiceFx, warmUpVoiceAudio, cancelPanFollow } from './voice-fx.js'

// getSession: () => Promise<{ enabled, flow, signedUrl, overrides, startDelayMs, past?, future? } | { enabled:false }>
// onSpeaking: (boolean) => void  — 유령이 말하는 동안 true (발광 부스트·배경음악 덕킹 등 연동용).
// onListening: (boolean) => void — 사용자 발화를 듣는 동안 true (배경음악 덕킹 등 연동용).
// getPan: () => number — 유령의 현재 좌우 위치 -1(왼쪽)~+1(오른쪽). 목소리(TTS)를 이 위치에서
//   들리게 스테레오 패닝한다(입체감). 없으면 중앙 고정.
// playVideo: (url, opts?) => Promise — 대화 tool이 부르는 영상 재생. opts.fadeIn=true면 검정에서
//   서서히 떠오른다(과거 회귀 연출). 첫 한 바퀴 뒤 resolve하고 영상은 loop로 계속 흐른다.
// clearVideo: (opts?) => Promise — 대화 영상을 걷고 유령 idle 앰비언트로 복귀. 1장(과거)→2장(미래)
//   전환 발화("이제 넌, 미래로 갈 거야…") 시점에 부른다 — 서버 턴 응답의 chapterTurned 신호.
// playFutureSpinup: (opts?) => Promise — 2장(미래) 진입의 개막: 유령 idle의 실타래가 10배속까지
//   감겨 올라가다 어둠으로 저문다(1차 개막 spinup과 같은 문법). clearVideo 직후, 장례식 앞에 부른다.
// playFutureFuneral: (url, opts?) => Promise — 2장(미래) 진입의 첫 장면(90세 장례식)을 1회 재생하고
//   TV 꺼지듯 암전시킨다. clearVideo 직후에 부른다.
// playFutureReel: (payload) => Promise — 그 암전에서 미래 릴(필름스트립)을 흘린다. 1사이클이 끝나면
//   resolve — 그때서야 유령이 2장 전환 발화를 시작한다(장례식 → 미래 릴 → 발화 순서).
// playFinale: (opts?) => Promise — 체험 종료 연출: 종결 발화가 끝난 뒤 태풍소리와 함께
//   실 감김 모션이 역재생되고 암전으로 저문다 — 1차 체험 전체의 닫힘.
export function createGhostVoice({
  getSession,
  onSpeaking,
  onListening,
  getPan,
  playVideo,
  clearVideo,
  playFutureSpinup,
  playFutureFuneral,
  playFutureReel,
  playFinale
} = {}) {
  let convo = null //     현재 Conversation 세션(없으면 null, convai 엔진 전용).
  let starting = false // start 진행 중(중복 시작 방지).
  let stopped = true //   stop 요청 상태 — 시작 지연 도중 취소를 감지한다.
  let startTimer = null // show 램프 뒤 말 걸기까지의 지연 타이머.
  let bridgeAudio = null //       bridge: 재생 중 <audio> (ElevenLabs TTS) — stop()이 끊는다.
  let bridgeRecognition = null // bridge: 진행 중 SpeechRecognition — stop()이 abort한다.
  let bridgeRealtimeStop = null // bridge: 진행 중 Realtime 전사 세션의 정리 함수 — stop()이 부른다.

  // ── 목소리 이펙트(부스트·리미터·에코·패닝) — voice-fx.js 공용 체인(2026-08-10 추출) ──
  // 내레이션(playNarration — 장례식·릴 회고)과 같은 체인을 공유해 목소리의 결이 앱 전체에서
  // 동일하게 고정된다. 상수(에코 등)를 바꾸려면 voice-fx.js 한 곳만 만지면 된다.
  const attachPanFollow = (a) =>
    attachVoiceFx(a, typeof getPan === 'function' ? getPan : null)

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

  // 완성 오디오 프리페치(POST → blob URL). GET 스트리밍은 합성이 재생을 못 따라가면 Chrome이
  // 버퍼 끝에서 ended를 조기 발화해 긴 대사가 중간에 잘린다 — 앞선 연출(장례식·미래 릴)로 시간을
  // 벌 수 있는 긴 전환 발화는 그 동안 전체를 미리 받아 재생한다. 실패는 null(스트리밍 경로로 폴백).
  function prefetchTtsBlob(text) {
    return fetch('/api/ghost/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b ? URL.createObjectURL(b) : null))
      .catch(() => null)
  }

  // 한 마디를 소리로 낸다: 서버 TTS(ElevenLabs)를 GET 스트리밍으로 — <audio src>가 첫 청크부터
  // 점진 재생하므로 합성 전체를 기다리지 않는다(발화 시작 지연 최소화). 실패 시 브라우저 TTS 폴백.
  // srcOverride(프리페치된 blob URL)가 있으면 그걸 재생한다 — 끝까지 잘리지 않는 완성본.
  async function speak(text, srcOverride) {
    if (!text || stopped) return
    await warmUpVoiceAudio() // 첫 발화 앞 잘림 방지 — 출력이 열린 뒤에 재생 시작
    if (stopped) return
    onSpeaking?.(true)
    try {
      const ok = await new Promise((resolve) => {
        const a = new Audio(srcOverride || `/api/ghost/tts?text=${encodeURIComponent(text)}`)
        a.crossOrigin = 'anonymous' // 동일 오리진이지만 MediaElementSource 라우팅 시 taint 방지.
        bridgeAudio = a
        const detachPan = attachPanFollow(a) // 유령 위치 따라 목소리를 좌우로(입체감).
        let settled = false
        const done = (good) => {
          if (settled) return
          settled = true
          detachPan()
          if (bridgeAudio === a) bridgeAudio = null
          if (srcOverride) URL.revokeObjectURL(srcOverride)
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
  // noSpeechMs > 0이면: 그 시간 동안 말이 전혀 시작되지 않을 때 NO_SPEECH를 돌려준다 —
  // 유령의 침묵 되물음(한 번만) 트리거용. 말이 시작되면 이 타이머는 해제된다.
  const NO_SPEECH = Symbol('no-speech')
  function listenUtterance({ endSilenceMs = 2500, maxUtteranceMs = 45000, noSpeechMs = 0 } = {}) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      let finalText = ''
      let interim = ''
      let done = false
      let noSpeech = false
      let silenceTimer = null
      let overallTimer = null
      let noSpeechTimer = null
      let rec = null
      onListening?.(true) // 사용자 발화 듣기 시작 — 배경음악 덕킹(level 5).
      if (noSpeechMs > 0)
        noSpeechTimer = setTimeout(() => {
          if (!done && !`${finalText}${interim}`.trim()) {
            noSpeech = true
            finish()
          }
        }, noSpeechMs)

      function finish() {
        if (done) return
        done = true
        onListening?.(false) // 듣기 종료 — 배경음악 원래대로.
        clearTimeout(silenceTimer)
        clearTimeout(overallTimer)
        clearTimeout(noSpeechTimer)
        if (bridgeRecognition === rec) bridgeRecognition = null
        try {
          rec?.stop()
        } catch {
          /* 무시 */
        }
        resolve(`${finalText} ${interim}`.trim() || (noSpeech ? NO_SPEECH : null))
      }

      // 무슨 말이든 들리기 시작한 뒤에만 침묵 타이머를 돌린다 — 아무 말 없을 땐 계속 기다린다.
      function armSilence() {
        clearTimeout(noSpeechTimer) // 말이 시작됐다 — 무응답 되물음 타이머 해제
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

  // ── Realtime 전사 듣기 — OpenAI Realtime transcription 모드 + semantic_vad ──
  // 침묵 타이머(endSilenceMs) 대신 말의 **내용**으로 발화 종료를 판정한다: "그때 제가…"처럼
  // 문장이 안 끝났으면 침묵이 길어도 기다리고, 끝났으면 그때 전사 전체를 돌려준다.
  // 서버(/api/ghost/stt-token)가 10분짜리 ephemeral 토큰을 발급 — OpenAI 키는 브라우저에 안 온다.
  // 반환 규약은 listenUtterance와 동일: 텍스트 | NO_SPEECH | null. 실패는 throw — 호출부가
  // Web Speech로 폴백한다(유령이 귀를 잃지 않는다).
  // inputGain: 마이크 신호 증폭 배율 — 전시장처럼 마이크가 멀어 신호가 약하면 Realtime의 내부
  // VAD가 말로 안 잡는다. 여기서 키워 보내면 소리 지르게 하지 않아도 감지된다(클리핑은 변환에서 클램프).
  async function listenUtteranceRealtime({
    maxUtteranceMs = 45000,
    noSpeechMs = 0,
    inputGain = 1
  } = {}) {
    const tokenRes = await fetch('/api/ghost/stt-token', { method: 'POST' })
    if (!tokenRes.ok) throw new Error(`stt-token ${tokenRes.status}`)
    const { value: token } = await tokenRes.json()

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    // Realtime 입력 포맷(PCM16 24kHz)에 맞춰 캡처 전용 컨텍스트를 24k로 연다 — 리샘플링 불필요.
    const captureCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 })

    return new Promise((resolve, reject) => {
      let settled = false
      let transcript = '' //  완료된 세그먼트 누적(completed)
      let sawSpeech = false
      let noSpeechTimer = null
      let overallTimer = null
      let ws = null
      let workletNode = null
      let sourceNode = null

      function cleanup() {
        clearTimeout(noSpeechTimer)
        clearTimeout(overallTimer)
        if (bridgeRealtimeStop === abort) bridgeRealtimeStop = null
        try {
          workletNode?.disconnect()
          sourceNode?.disconnect()
        } catch {
          /* 무시 */
        }
        stream.getTracks().forEach((t) => t.stop())
        captureCtx.close().catch(() => {})
        if (ws && ws.readyState <= WebSocket.OPEN) {
          try {
            ws.close()
          } catch {
            /* 무시 */
          }
        }
      }

      function finish(result) {
        if (settled) return
        settled = true
        onListening?.(false)
        cleanup()
        resolve(result)
      }
      function fail(err) {
        if (settled) return
        settled = true
        onListening?.(false)
        cleanup()
        reject(err)
      }
      function abort() {
        // stop() 경유 — 국면 전환 등. 오류가 아니라 "들은 것 없음"으로 조용히 닫는다.
        finish(null)
      }
      bridgeRealtimeStop = abort

      onListening?.(true)
      if (noSpeechMs > 0)
        noSpeechTimer = setTimeout(() => {
          if (!sawSpeech && !transcript.trim()) finish(NO_SPEECH)
        }, noSpeechMs)

      // 브라우저 WebSocket은 헤더를 못 실으므로 서브프로토콜에 ephemeral 토큰을 싣는다(공식 브라우저 패턴).
      ws = new WebSocket('wss://api.openai.com/v1/realtime', [
        'realtime',
        `openai-insecure-api-key.${token}`
      ])
      ws.onerror = () => fail(new Error('realtime WS 오류'))
      ws.onclose = () => {
        if (settled) return
        // 서버가 세션을 닫음(토큰 만료 등) — 들은 게 있으면 그걸로 마감, 없으면 폴백으로.
        if (transcript.trim()) finish(transcript.trim())
        else fail(new Error('realtime WS 조기 종료'))
      }
      ws.onmessage = (e) => {
        let msg
        try {
          msg = JSON.parse(e.data)
        } catch {
          return
        }
        if (msg.type === 'error') {
          fail(new Error(msg.error?.message || 'realtime 세션 오류'))
        } else if (msg.type === 'input_audio_buffer.speech_started') {
          sawSpeech = true
          clearTimeout(noSpeechTimer) // 말이 시작됐다 — 무응답 되물음 타이머 해제
          if (!overallTimer)
            overallTimer = setTimeout(() => {
              // 발화 상한 — 그때까지 완료된 전사로 마감(없으면 계속은 무의미, 침묵 취급).
              finish(transcript.trim() || null)
            }, maxUtteranceMs)
        } else if (msg.type === 'conversation.item.input_audio_transcription.completed') {
          // semantic_vad가 "말이 끝났다"고 판정한 한 턴의 전사 — 이걸로 발화 하나 완성.
          transcript = `${transcript} ${msg.transcript || ''}`.trim()
          finish(transcript || null)
        }
      }
      ws.onopen = async () => {
        // 마이크 → AudioWorklet(PCM 캡처) → base64 append. 워크릿은 블롭 모듈로 즉석 등록.
        try {
          const workletSrc = `registerProcessor('pcm-capture', class extends AudioWorkletProcessor {
            process(inputs) {
              const ch = inputs[0] && inputs[0][0]
              if (ch) this.port.postMessage(ch.slice(0))
              return true
            }
          })`
          const blobUrl = URL.createObjectURL(
            new Blob([workletSrc], { type: 'application/javascript' })
          )
          await captureCtx.audioWorklet.addModule(blobUrl)
          URL.revokeObjectURL(blobUrl)
          if (settled) return
          sourceNode = captureCtx.createMediaStreamSource(stream)
          workletNode = new AudioWorkletNode(captureCtx, 'pcm-capture')
          const inGain = captureCtx.createGain()
          inGain.gain.value = Math.max(1, inputGain)
          // ~100ms씩 모아 보낸다 — 프레임(128샘플)마다 보내면 메시지 폭주.
          let pending = []
          let pendingLen = 0
          workletNode.port.onmessage = ({ data }) => {
            if (settled || ws.readyState !== WebSocket.OPEN) return
            pending.push(data)
            pendingLen += data.length
            if (pendingLen < 2400) return // 24kHz × 0.1s
            const f32 = new Float32Array(pendingLen)
            let off = 0
            for (const c of pending) {
              f32.set(c, off)
              off += c.length
            }
            pending = []
            pendingLen = 0
            const i16 = new Int16Array(f32.length)
            for (let i = 0; i < f32.length; i++) {
              const s = Math.max(-1, Math.min(1, f32[i]))
              i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
            }
            let bin = ''
            const bytes = new Uint8Array(i16.buffer)
            for (let i = 0; i < bytes.length; i += 8192)
              bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
            ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(bin) }))
          }
          sourceNode.connect(inGain)
          inGain.connect(workletNode)
          // 워크릿 출력은 스피커로 보내지 않는다(마이크 루프백 방지) — 무음 게인 종단.
          const mute = captureCtx.createGain()
          mute.gain.value = 0
          workletNode.connect(mute)
          mute.connect(captureCtx.destination)
        } catch (err) {
          fail(err)
        }
      }
    })
  }

  // 듣기 진입점 — 세션 설정이 realtime이면 Realtime 전사를 시도하고, 토큰·연결·워크릿 어느
  // 단계든 실패하면 그 자리에서 Web Speech로 폴백한다(이후 턴은 재시도 없이 바로 Web Speech).
  let realtimeBroken = false
  async function listen(session, opts) {
    if (session.stt?.engine === 'realtime' && !realtimeBroken && !stopped) {
      try {
        return await listenUtteranceRealtime({ ...opts, inputGain: session.stt?.inputGain })
      } catch (err) {
        realtimeBroken = true
        console.warn('[ghost-voice] Realtime 전사 실패 — Web Speech 폴백:', err?.message || err)
      }
    }
    return listenUtterance(opts)
  }

  // bridge 대화 본 루프: 인사(회고) → [듣기 → 턴 → 말하기 → (영상 → 상황 알림 턴 → 말하기)] 반복.
  async function runBridge(session) {
    // 2차 체험의 개막 연출(분기 장례식·릴 분기)은 입장 의례(데모 국면)가 이미 재생했다 —
    // 유령은 인사부터 시작한다(중복 재생 금지, 2026-08-05).
    await speak(session.greeting)
    if (stopped) return
    const hasWebSpeech = !!(window.SpeechRecognition || window.webkitSpeechRecognition)
    if (!hasWebSpeech && session.stt?.engine !== 'realtime') {
      console.warn('[ghost-voice] SpeechRecognition 미지원 — 인사만 하고 조용히 곁에 머문다')
      return
    }
    // 침묵 되물음(2026-08-05): 유령이 말을 마친 뒤 35초 동안 아무 말이 없으면 딱 한 번,
    // 서버에 침묵 event 턴을 보내 나직한 되물음을 받는다. 그 뒤로는 무한정 기다린다
    // (관람객이 실제로 말하면 카운터가 리셋돼 다음 질문에서 다시 한 번 쓸 수 있다).
    let silenceNudged = false
    while (!stopped) {
      const heard = await listen(session, {
        ...(session.listen || {}),
        noSpeechMs: silenceNudged ? 0 : 35000
      })
      if (stopped) return
      if (heard === NO_SPEECH) {
        silenceNudged = true
        try {
          const nudge = await postTurn('(침묵: 35초 넘게 대답이 없다)', 'event')
          if (!stopped && nudge?.say) await speak(nudge.say)
        } catch {
          /* 되물음 실패 — 그냥 계속 기다린다 */
        }
        continue
      }
      if (!heard) {
        // 침묵은 재촉하지 않는다(페르소나) — 곧바로 다시 귀 기울인다(listenUtterance가 이미 오래 기다렸다).
        await new Promise((r) => setTimeout(r, 300))
        continue
      }
      silenceNudged = false // 실제 발화가 들렸다 — 다음 질문에서 되물음을 다시 한 번 허용
      let reply
      try {
        reply = await postTurn(heard, 'user')
      } catch (e) {
        console.warn('[ghost-voice] 턴 실패:', e?.message || e)
        continue
      }
      if (stopped) return
      // 1장(과거)→2장(미래) 전환 — 직전 장면 영상을 걷고, 미래로 들어가는 첫 장면으로
      // **90세 장례식**을 튼다(2차 플로우의 initiate). 1차가 "장례식 → 암전 → 주마등"으로 열리듯
      // 2차도 같은 문법으로 열린다: 이 사람이 이대로 살아 맞이할 죽음을 먼저 보고, 그 암전에서
      // 미래의 순간들로 넘어간다. 영상이 아직 없으면(승인·영상화 전) 서버가 url을 안 주고 건너뛴다.
      let saySrc = null // 릴 뒤 고정 질문의 프리페치 오디오 — 연출이 흐르는 동안 미리 받는다
      if (reply?.chapterTurned) {
        if (reply.say) saySrc = prefetchTtsBlob(reply.say)
        // 전환 선언도 이제 두세 문장이라 스트리밍 조기 종료에 잘릴 수 있다 — 완성본을 받아 재생.
        const spinupSrc = reply.spinup?.say ? prefetchTtsBlob(reply.spinup.say) : null
        await clearVideo?.()
        if (stopped) return
        // ⓪ 전환 선언 — 감아올리기 모션 직전, 유령 idle에서 말한다("…내가 좀 보여줄게. 거기 가만히 앉아서 잘 따라와.").
        if (reply.spinup?.say) await speak(reply.spinup.say, (await spinupSrc) || undefined)
        if (stopped) return
        // 물리 돔: 2장 전환 안무(왕복 3회 + b 7초) — 전환 발화가 끝나고 연출이 시작되는 이 순간 트리거.
        fetch('/api/dome-future', { method: 'POST' }).catch(() => {})
        // ⓪ 실타래 감아올리기(10배속 가속 → 어둠). 이어질 재료(장례식·미래 릴)가 하나도 없으면
        // 건너뛴다 — 어둠에서 아무것도 떠오르지 못해 화면이 검정에 갇히는 걸 막는다.
        if (reply.spinup && (reply.funeral?.url || reply.futureReel?.photos?.length))
          await playFutureSpinup?.(reply.spinup)
        if (stopped) return
        if (reply.funeral?.url) await playFutureFuneral?.(reply.funeral.url, reply.funeral)
        if (stopped) return
        // 장례식이 암전으로 닫히면 그 자리에서 미래 릴이 흐른다(현재 다음 해 → 90세).
        // 1사이클이 끝나야 아래 전환 발화로 넘어간다 — 유령은 미래를 다 보여준 뒤에 말을 건다.
        if (reply.futureReel?.photos?.length) await playFutureReel?.(reply.futureReel)
      }
      if (stopped) return
      if (reply?.say) await speak(reply.say, saySrc ? await saySrc : undefined) // 예: "기다려봐. 그때의 기억으로 돌아가자."
      if (stopped) return
      if (reply?.end && !reply?.video) {
        // 체험 종료(종결 발화까지 마쳤다) — 태풍소리와 함께 실 감김 역재생 → 암전으로 닫는다.
        console.log('[ghost-voice] 체험 종료 — 마침 연출 후 암전')
        await playFinale?.()
        return
      }
      if (reply?.video?.url) {
        // 물리 돔: 장면 이동 안무 — TTS가 끝나고 장면이 떠오르는 바로 이 순간 트리거(fire-and-forget).
        fetch('/api/dome-scene', { method: 'POST' }).catch(() => {})
        // 검정 → 그 순간이 떠오른다(pingpong loop). resolveAfterSec: 첫 loop 한 바퀴(최대 18s)를
        // 기다리지 않고 fade-in 직후 후속 대사로 넘어간다 — 영상은 뒤에서 계속 돈다.
        await playVideo?.(reply.video.url, {
          fadeIn: true,
          resolveAfterSec: 3,
          scene: reply.video.scene // 장면 맥락 → 앰비언스 효과음(sfx-layer) 매칭
        })
        if (stopped) return
        // 영상이 떠오른 상황을 서버 두뇌에 알려 다음 대사("이때 쯤을 이야기하는 거지?" /
        // "왜 이때의 모습이 보고싶었어?")를 받는다.
        try {
          const follow = await postTurn(
            `(방금 ${reply.video.age}살(${reply.video.year}년${Number.isFinite(reply.video.yearsAhead) ? `, 지금으로부터 약 ${reply.video.yearsAhead}년 뒤` : ''}) 장면 영상이 화면에 떠올랐다. exact=${reply.video.exact}. 장면: ${reply.video.scene})`,
            'event'
          )
          if (!stopped && follow?.say) await speak(follow.say)
          if (follow?.end) {
            console.log('[ghost-voice] 체험 종료 — 마침 연출 후 암전')
            await playFinale?.()
            return
          }
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
        await playVideo?.(m.url, { fadeIn: true, scene: m.scene }) // scene → 앰비언스 매칭
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
        await playVideo?.(v.url, { scene: v.scene }) // scene → 앰비언스 매칭
        cursor = 1
        return describe(v, stage.videos.length - cursor, true)
      },
      show_another: async () => {
        if (!stage) return '아직 보여준 시기가 없어. 먼저 show_future_self를 써.'
        if (cursor >= stage.videos.length) return '이 시기 장면은 이게 마지막이었어. 더 없어.'
        const v = stage.videos[cursor]
        await playVideo?.(v.url, { scene: v.scene }) // scene → 앰비언스 매칭
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
        onModeChange: ({ mode } = {}) => {
          onSpeaking?.(mode === 'speaking')
          onListening?.(mode === 'listening')
        },
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
    if (bridgeRealtimeStop) {
      try {
        bridgeRealtimeStop()
      } catch {
        /* 무시 */
      }
      bridgeRealtimeStop = null
    }
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
    cancelPanFollow()
    try {
      speechSynthesis?.cancel()
    } catch {
      /* 무시 */
    }
    onSpeaking?.(false)
    onListening?.(false)
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
