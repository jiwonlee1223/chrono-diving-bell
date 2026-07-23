// 렌더러 — 웹앱(단일 페이지)이 4개 프로젝터 뷰를 한 캔버스에 2×2 타일로 렌더한다.
//
// Electron 시절 4개 창(각 창=1 프로젝터)을 단일 페이지 4타일로 합쳤다. 창-간 동기화(§7 배리어)는
// 한 페이지·한 시계로 자동 충족된다. 각 타일은 담당 프로젝터 카메라로 실린더를 예왜곡 렌더(§4.1)하고
// 후면투사 반전·엣지 블렌딩 post-pass(§4.2/§4.3)를 걸어 그 타일 영역에 출력한다.
//
// 1) server /api/bootstrap 에서 projectors[] + install + montage 국면을 받는다.
// 2) 실린더 메시에 재료를 감고(4타일 공유), 4개 프로젝터 카메라로 각 타일에 렌더한다.
//    - IDLE/ENTRY/EXIT: thread 앰비언트
//    - ZOETROPE 이후: 몽타주 재료 (라이브러리 이미지 고속 교체 → 멈춤 블러 → 영상 크로스페이드)
// 3) V(펼친 파노라마 프리뷰 ↔ 실린더 예왜곡)·Space(재생/정지)·Enter(멈춤/진입/재개)는 페이지 keydown.
//
// 시간·상태는 전부 server가 소유한다(§7). 이 파일은 유효 시간과 상태를 받아 그리기만 한다.

import * as THREE from 'three'
import { installZoetropeWeb } from './net/zoetrope-web.js'
import { createCylinder } from './scene/cylinder.js'
import { createProjectorCamera, updateAspect } from './scene/projector-camera.js'
import { createThreadMaterial, updateThread } from './scene/thread-material.js'
import {
  createMontageMaterial,
  setMontageImage,
  setMontageVideo,
  setMontageCalibration
} from './scene/montage-material.js'
import { createPanoramaPreview } from './scene/panorama-preview.js'
import { PostPass } from './scene/post-pass.js'
import { createGhost } from './scene/ghost.js'
import { createGhostVoice } from './scene/ghost-voice.js'

// 테스트 패턴·사진 색을 그린 그대로 통과시킨다(색 관리 이중변환 회피).
THREE.ColorManagement.enabled = false

// 몽타주 재료를 쓰는 상태들. 나머지는 thread 앰비언트.
const MONTAGE_STATES = new Set(['ZOETROPE', 'FREEZE', 'REGEN_WAIT', 'IMMERSION'])

// 타일 배치: 프로젝터를 방위 순서대로 가로 한 줄(P0|P1|P2|P3 = 0°|90°|180°|270°).
// 4타일이 이어진 전체 영역은 생성 씬 파노라마 비율(4096×1024=4:1)에 맞춰 창 안에 레터박스한다
// → 각 타일은 (파노라마비율 / 타일수) = 1:1. preview 모드면 4슬라이스가 이어져 온전한 파노라마가 된다.

// 선형 트윈 (server 방송이 목표를 주면 로컬로 보간 — 수 ms 오차 허용 구간).
function makeTween(v = 0) {
  return { v, from: v, to: v, t0: 0, dur: 0 }
}
function tweenTo(tw, to, durSec) {
  tw.from = tw.v
  tw.to = to
  tw.t0 = performance.now()
  tw.dur = Math.max(1, durSec * 1000)
}
function tweenUpdate(tw) {
  const t = Math.min(1, (performance.now() - tw.t0) / tw.dur)
  const e = t * t * (3 - 2 * t) // smoothstep
  tw.v = tw.from + (tw.to - tw.from) * e
  return tw.v
}

async function main() {
  installZoetropeWeb() // window.zoetrope = 웹 클라이언트(fetch + SSE)

  const boot = await window.zoetrope.getBootstrap()
  const { projectors, install, montage } = boot
  const count = projectors.length // 4
  // 4타일 이어붙인 전체 영역의 목표 종횡비 = 생성 씬 파노라마 비율. 없으면 count:1(=4:1) 기본.
  const panoAspect = boot.panorama?.width / boot.panorama?.height || count

  const canvas = document.getElementById('view')
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace
  renderer.autoClear = false // 타일별로 직접 클리어한다.

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)

  // 재료 둘: thread(앰비언트)와 montage(주마등). 4타일이 같은 재료를 공유한다.
  const threadMaterial = createThreadMaterial(install)
  const montageMaterial = montage ? createMontageMaterial(install, montage.config) : null
  const cylinder = createCylinder(install, { material: threadMaterial })
  scene.add(cylinder)

  // 프로젝터별 카메라·post-pass·펼친 파노라마 프리뷰. 초기 aspect는 resize에서 확정.
  const cameras = projectors.map((p) => createProjectorCamera(p, install, 1))
  const posts = projectors.map(
    (p) =>
      new PostPass({
        backProjection: install.backProjection,
        blendFraction: p.blendFraction,
        verticalShift: 0
      })
  )
  const previews = projectors.map((p) => createPanoramaPreview(p, threadMaterial))

  let previewMode = boot.devPreview ?? true // 기본 뷰 = 펼친 파노라마. 실린더 예왜곡은 V로만.
  window.zoetrope.onViewMode?.(({ preview: on } = {}) => {
    previewMode = !!on
  })

  // ---- 상태·시간 모델 (server 소유, 여기서는 수신·계산만) ----

  let appState = montage?.state ?? 'IDLE'
  const play = montage?.play ?? { playing: true, offset: 0, frozenEff: 0 }
  window.zoetrope.onPlayState?.((s) => {
    if (!s) return
    play.playing = !!s.playing
    play.offset = s.offset ?? 0
    play.frozenEff = s.frozenEff ?? 0
  })
  const effSeconds = () => (play.playing ? Date.now() / 1000 - play.offset : play.frozenEff)

  // ---- 몽타주 텍스처 프리로드 ----

  const textures = [] // playlist 순서와 동일한 인덱스
  if (montage) {
    const loader = new THREE.TextureLoader()
    montage.playlist.forEach((item, i) => {
      loader.load(item.url, (tex) => {
        tex.colorSpace = THREE.NoColorSpace
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
        textures[i] = tex
      })
    })
  }

  // ---- 멈춤 블러·영상 크로스페이드 연출 ----

  const blurCfg = montage?.config?.blur ?? { max: 1.0, inSec: 2.5, revealSec: 5.0 }
  const blur = makeTween(0)
  const videoMix = makeTween(0)

  // ---- reel 데모 시퀀스(테스트 경험, §1 긴장 有 — 되돌릴 수 있게 기존 상태기계와 병존) ----
  // demoPhase: null(일반) | 'spinup'(실타래 회전 가속) | 'reel'(reel.mp4 1회 재생 후 멈춤).
  const SPINUP_MAX = 8 // 실타래 회전 최대 배속.
  const REEL_PLAYBACK_RATE = 3 // 릴(90초)을 3배속 재생 → ~30초.
  let demoPhase = null
  const threadSpeedMul = makeTween(1) // 실타래 시간 배속(가속 연출).
  let threadClock = 0 //                로컬 적분 실타래 시계(배속 변화에도 위상 점프 없음).
  let lastFrameMs = performance.now()

  let videoEl = null
  let videoTexture = null
  let videoSyncTimer = null
  let videoStartAtMs = 0
  let futureVideoActive = false // 미래 자기 모습 영상 재생 중(ghost 대화 tool). frame()이 보면 영상 재료를 렌더.

  function teardownVideo() {
    if (videoSyncTimer) clearInterval(videoSyncTimer)
    videoSyncTimer = null
    if (videoEl) {
      videoEl.pause()
      videoEl.removeAttribute('src')
      videoEl.load()
      videoEl = null
    }
    if (montageMaterial) setMontageVideo(montageMaterial, null)
    videoTexture?.dispose()
    videoTexture = null
  }

  // 유령 음성 대화 컨트롤러(아래 ghost 생성 후 주입). 'ghost' 국면에서만 말한다 — §1: 다른 국면·상태에선 stop.
  let ghostVoice = null

  // 상태 진입 연출. immediate = 부트스트랩 시 트윈 없이 그 국면으로 점프.
  function applyState(state, meta = {}, immediate = false) {
    appState = state
    // §1: 1인칭 진입·몽타주 재생(ZOETROPE/FREEZE/REGEN_WAIT/IMMERSION)에 들어가면 유령 목소리를 끈다.
    if (MONTAGE_STATES.has(state)) ghostVoice?.stop()
    const dur = (sec) => (immediate ? 0.001 : sec)
    if (state === 'REGEN_WAIT') {
      tweenTo(blur, blurCfg.max, dur(blurCfg.inSec)) // 멈춘 순간이 흐려진다 — 기다림의 의례(§5.2)
    } else if (state === 'IMMERSION') {
      tweenTo(blur, 0, dur(blurCfg.revealSec))
      if (meta.video) tweenTo(videoMix, 1, dur(blurCfg.revealSec))
    } else if (state === 'ZOETROPE') {
      tweenTo(blur, 0, dur(0.6))
      tweenTo(videoMix, 0, dur(0.4))
      teardownVideo()
    } else {
      // IDLE·ENTRY·EXIT: thread 앰비언트로 복귀.
      tweenTo(blur, 0, dur(0.3))
      tweenTo(videoMix, 0, dur(0.3))
      teardownVideo()
    }
  }
  window.zoetrope.onState?.((payload) => {
    if (payload?.state) applyState(payload.state, payload, false)
  })
  applyState(appState, {}, true) // 부트스트랩된 페이지도 현재 국면을 이어받는다.

  // ---- IMMERSION 영상 배리어 (§7): 프리로드 → 준비 보고 → 벽시계 동시 시작 ----

  window.zoetrope.onVideoPrepare?.(({ url } = {}) => {
    teardownVideo()
    videoEl = document.createElement('video')
    videoEl.muted = true
    videoEl.loop = true
    videoEl.playsInline = true
    videoEl.preload = 'auto'
    videoEl.crossOrigin = 'anonymous' // WebGL 텍스처 오염(taint) 방지 — /media가 ACAO를 준다.
    videoEl.src = url
    videoEl.addEventListener(
      'canplaythrough',
      () => {
        videoTexture = new THREE.VideoTexture(videoEl)
        videoTexture.colorSpace = THREE.NoColorSpace
        if (montageMaterial) setMontageVideo(montageMaterial, videoTexture)
        window.zoetrope.sendVideoReady?.()
      },
      { once: true }
    )
    videoEl.load()
  })

  window.zoetrope.onVideoCommit?.(({ startAtMs } = {}) => {
    if (!videoEl) return
    videoStartAtMs = startAtMs ?? Date.now()
    setTimeout(() => videoEl?.play(), Math.max(0, videoStartAtMs - Date.now()))
    // 루프 드리프트 보정: 벽시계 기준 기대 위상에서 0.12s 이상 벗어나면 스냅.
    videoSyncTimer = setInterval(() => {
      if (!videoEl || !videoEl.duration || videoEl.paused) return
      const d = videoEl.duration
      const expected = ((((Date.now() - videoStartAtMs) / 1000) % d) + d) % d
      let diff = videoEl.currentTime - expected
      diff = ((((diff + d / 2) % d) + d) % d) - d / 2 // 루프 경계 감안한 최소 차
      if (Math.abs(diff) > 0.12) videoEl.currentTime = expected
    }, 4000)
  })

  // 죽기 직전 섬광 — spinup→reel 전환 순간 화면을 짧게 번쩍인다(§관람 연출). Web Animations라 rAF 무관.
  const flashEl = document.getElementById('flash')
  function triggerFlash() {
    flashEl?.animate([{ opacity: 0 }, { opacity: 0.95, offset: 0.18 }, { opacity: 0 }], {
      duration: 420,
      easing: 'ease-out'
    })
  }

  // ---- reel 배속 재생. 종료(→유령 idle)는 서버가 국면으로 방송하므로 여기선 재생만 한다. ----
  //  seekSec: 새로고침 재개 시 영상 위치(실경과 × 배속). flash: 시작 섬광(재개 땐 생략).
  function playReelOnce(url, { seekSec = 0, playbackRate = REEL_PLAYBACK_RATE, flash = true } = {}) {
    teardownVideo()
    if (!url || !montageMaterial) return // reel 없거나 몽타주 재료 없으면 스킵.
    videoEl = document.createElement('video')
    videoEl.muted = true
    videoEl.loop = false
    videoEl.playsInline = true
    videoEl.preload = 'auto'
    videoEl.crossOrigin = 'anonymous' // /media ACAO — WebGL 텍스처 오염 방지.
    videoEl.src = url
    videoEl.playbackRate = playbackRate
    videoEl.addEventListener(
      'canplaythrough',
      () => {
        videoTexture = new THREE.VideoTexture(videoEl)
        videoTexture.colorSpace = THREE.NoColorSpace
        setMontageVideo(montageMaterial, videoTexture)
        videoMix.v = videoMix.from = videoMix.to = 1 // reel 표시로 즉시 스냅
        if (seekSec > 0 && isFinite(videoEl.duration)) {
          videoEl.currentTime = Math.min(seekSec, Math.max(0, videoEl.duration - 0.05))
        }
        if (flash) triggerFlash() // reel이 드러나는 순간 섬광
        videoEl.playbackRate = playbackRate
        videoEl.play().catch(() => {})
      },
      { once: true }
    )
    // 끝나면 마지막 프레임에서 멈춰 유지 — 서버의 'ghost' 국면 방송이 앰비언트+유령으로 전환한다.
    videoEl.addEventListener('ended', () => videoEl?.pause(), { once: true })
    videoEl.load()
  }

  // 미래 자기 모습 영상 하나를 원본 속도로 loop 재생(ghost 대화 client tool이 호출). Promise 반환 —
  // loop라 얼지 않고 계속 살아 움직인다. 'ended'가 안 오므로, 첫 한 바퀴(대략 영상 길이) 뒤에 resolve해
  // 에이전트가 다음 대사로 넘어가게 하고, 영상은 다음 영상 재생/국면 전환(teardown) 전까지 계속 loop로 흐른다.
  // futureVideoActive=true인 동안 frame()이 실린더에 영상을 그린다(국면 전환 시 applyDemo가 해제).
  // 안전장치: 로드/재생 실패나 canplaythrough 누락 시에도 상한 뒤 resolve해 대화가 멈추지 않게 한다.
  function playFutureVideoLoop(url) {
    return new Promise((resolve) => {
      teardownVideo()
      if (!url || !montageMaterial) {
        resolve()
        return
      }
      futureVideoActive = true
      const v = document.createElement('video')
      v.muted = true // 클립은 무음(-an). 자동재생 안전 위해 muted.
      v.loop = true // 계속 loop — 얼지 않고 살아 움직인다. 다음 영상/국면 전환 때 teardown으로 교체·정지.
      v.playsInline = true
      v.preload = 'auto'
      v.crossOrigin = 'anonymous'
      v.src = url
      v.playbackRate = 1 // 원본 속도(배속 아님)
      videoEl = v
      let settled = false
      let timer = setTimeout(finish, 18000) // 로드 지연 대비 상한(에이전트 tool 타임아웃 20s 전에)
      function finish() {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve() // pause하지 않는다 — loop로 계속 재생(살아 움직임 유지)
      }
      v.addEventListener(
        'canplaythrough',
        () => {
          videoTexture = new THREE.VideoTexture(v)
          videoTexture.colorSpace = THREE.NoColorSpace
          setMontageVideo(montageMaterial, videoTexture)
          videoMix.v = videoMix.from = videoMix.to = 1 // 영상 즉시 표시
          v.play().catch(() => {})
          clearTimeout(timer)
          const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 8
          timer = setTimeout(finish, Math.min(dur * 1000 + 300, 18000)) // 첫 한 바퀴 뒤 에이전트 진행
        },
        { once: true }
      )
      v.addEventListener('error', finish, { once: true }) // 로드 실패해도 대화는 진행
      v.load()
    })
  }

  // reel 회전 모드 — Gemini 파노라마 이미지들을 천천히 회전시키며 순회(한 바퀴=secPerTurn초, 바퀴마다
  // 다음 이미지로 크로스페이드). uYaw 합성(설치 캘리브레이션 + 회전)은 frame()이 한다(cal이 그때
  // 정의돼 있어 TDZ 회피). 크로스페이드는 uTexVideo 슬롯을 다음 이미지로 재사용해 uVideoMix로 섞는다.
  let rotate = null // { indices, secPerTurn, crossSec, startMs, idx, shownIdx, xfadeStartMs } | null
  let rotateSpeedMul = 1 // [debug] reel 회전(surround) 속도 배수. q/w로 실시간 조절. 1 = montage.json rotateSecPerTurn 기준.
  // [debug] 회전 속도를 factor배 하되 startMs를 재기준해 위상 점프 없이 바꾼다.
  //  현재 실효 secPerTurn(= rotateSecPerTurn / 배수)을 콘솔에 찍어 montage.json에 옮겨 적을 수 있게 한다.
  function nudgeRotateSpeed(factor) {
    if (!rotate) {
      console.log('[debug] q/w: reel 회전(rotate) 중에만 동작합니다')
      return
    }
    const now = performance.now()
    const oldMul = rotateSpeedMul
    const newMul = Math.max(0.05, Math.min(40, oldMul * factor))
    rotate.startMs = now - (now - rotate.startMs) * (oldMul / newMul) // 위상 연속 유지(점프 방지)
    rotateSpeedMul = newMul
    const effSec = rotate.secPerTurn / newMul
    console.log(
      `[debug] reel 회전 속도 ×${newMul.toFixed(2)} → 1바퀴 ${effSec.toFixed(1)}s (montage.json demo.rotateSecPerTurn)`
    )
  }
  function startRotate(payload) {
    const indices = payload?.indices || []
    if (!indices.length) {
      rotate = null
      return
    }
    const secPerTurn = payload?.secPerTurn || 24
    const elapsedSec = Math.max(0, (payload?.elapsedMs ?? 0) / 1000)
    // 벽시계 기준 — fps와 무관하게 회전 속도가 일정하고, 새로고침 재개도 startMs로 자연히 반영된다.
    rotate = {
      indices,
      secPerTurn,
      crossSec: payload?.crossfadeSec ?? 1.5,
      startMs: performance.now() - elapsedSec * 1000,
      idx: Math.floor(elapsedSec / secPerTurn) % indices.length,
      shownIdx: -1,
      xfadeStartMs: 0,
      doneSent: false // reel 한 바퀴 완료 신호를 서버에 1회만 보내기 위한 플래그
    }
    teardownVideo()
    if (montageMaterial) {
      montageMaterial.uniforms.uBlur.value = 0
      montageMaterial.uniforms.uVideoMix.value = 0
      montageMaterial.uniforms.uHasVideo.value = 0
    }
  }

  // 서버 소유 1차 흐름 국면 적용. immediate=true는 부트스트랩 재개(트윈 없이 그 국면으로 점프).
  //  idle: 앰비언트(유령 숨김, admin 세션 나가기) · spinup: 실타래 배속 · reel: 회전/배속 재생 · ghost: 유령 뜬 idle
  function applyDemo(payload, immediate = false) {
    const phase = payload?.phase ?? 'idle'
    const elapsedSec = Math.max(0, (payload?.elapsedMs ?? 0) / 1000)
    futureVideoActive = false // 국면 전환 시 미래 영상 재생 해제(ghost 대화 tool이 다시 켠다)
    const dur = (s) => (immediate ? 0.001 : s)
    if (phase === 'spinup') {
      demoPhase = 'spinup'
      rotate = null
      ghost.hide()
      ghostVoice?.stop()
      teardownVideo()
      tweenTo(videoMix, 0, dur(0.2))
      tweenTo(blur, 0, dur(0.2))
      const total = (payload?.spinupMs ?? 10000) / 1000
      threadSpeedMul.v = 1 + (SPINUP_MAX - 1) * Math.min(1, elapsedSec / total) // 재개 시 진행률 반영
      tweenTo(threadSpeedMul, SPINUP_MAX, Math.max(0.3, total - elapsedSec))
    } else if (phase === 'reel') {
      demoPhase = 'reel'
      ghost.hide()
      ghostVoice?.stop()
      if (payload?.mode === 'rotate') {
        startRotate(payload) // Gemini 파노라마 이미지를 천천히 회전시키며 순회
      } else {
        rotate = null
        const rate = payload?.playbackRate ?? REEL_PLAYBACK_RATE
        playReelOnce(payload?.url, { seekSec: elapsedSec * rate, playbackRate: rate, flash: !immediate })
      }
    } else if (phase === 'ghost') {
      demoPhase = null
      rotate = null
      teardownVideo()
      tweenTo(videoMix, 0, dur(0.6))
      tweenTo(blur, 0, dur(0.4))
      tweenTo(threadSpeedMul, 1, dur(1.5))
      ghost.show() // 유령 등장 = 1인칭 진입 가능 신호.
      ghostVoice?.start() // 유령이 나타나면 말을 건다(show 램프 뒤 startDelayMs). §1 경계는 페르소나가 소유.
    } else {
      // idle (admin 세션 나가기) — 앰비언트, 유령 숨김.
      demoPhase = null
      rotate = null
      ghost.hide()
      ghostVoice?.stop()
      teardownVideo()
      tweenTo(videoMix, 0, dur(0.6))
      tweenTo(blur, 0, dur(0.4))
      tweenTo(threadSpeedMul, 1, dur(1.5))
    }
  }
  window.zoetrope.onReelDemo?.((payload) => applyDemo(payload, false))

  // 테스트용 수동 트리거 버튼(좌하단) — 참가자 교체 없이 현재 페르소나로 데모 시퀀스 실행.
  document.getElementById('demoBtn')?.addEventListener('click', () => {
    fetch('/api/reel-demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    }).catch(() => {})
  })

  // ---- 출력 파이프라인: 타일 사이즈 RT 하나를 4타일이 재사용 ----

  // 뷰포트/시저는 CSS(논리) 픽셀 — three.js가 내부에서 pixelRatio를 곱한다.
  // RT는 물리(드로잉버퍼) 픽셀 — pixelRatio가 이미 반영된 값을 그대로 쓴다.
  const size = new THREE.Vector2() // 드로잉버퍼(물리) 크기
  // 레터박스된 타일 영역(CSS 픽셀): 가로 count개 정렬, 전체가 panoAspect. originX/Y = 창 안 좌상단 오프셋.
  const layout = { tileW: 1, tileH: 1, originX: 0, originY: 0 }
  const rt = new THREE.WebGLRenderTarget(2, 2, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true
  })

  function resize() {
    const w = window.innerWidth
    const h = window.innerHeight
    renderer.setSize(w, h, false)
    renderer.getDrawingBufferSize(size)
    // 전체 타일 영역을 panoAspect 비율로 창에 레터박스. 창이 더 넓으면 높이 기준, 좁으면 폭 기준.
    let totalW, totalH
    if (w / h >= panoAspect) {
      totalH = h
      totalW = h * panoAspect
    } else {
      totalW = w
      totalH = w / panoAspect
    }
    layout.tileW = totalW / count
    layout.tileH = totalH
    layout.originX = (w - totalW) / 2
    layout.originY = (h - totalH) / 2
    // RT는 물리 타일 크기(업스케일 손실 최소화). CSS→물리 스케일 = 드로잉버퍼/창.
    const scaleX = size.x / w
    const scaleY = size.y / h
    rt.setSize(
      Math.max(1, Math.round(layout.tileW * scaleX)),
      Math.max(1, Math.round(layout.tileH * scaleY))
    )
    cameras.forEach((cam) => updateAspect(cam, layout.tileW / layout.tileH))
  }
  window.addEventListener('resize', resize)
  resize()

  // 유령 에이전트: 4타일 스트립을 배회하는 앰비언트 발광체(눈코입 없는 부끄부끄, 구름에 가려진 빛).
  // 렌더 경로(preview/installation)와 무관한 DOM 오버레이. 기본 숨김 — 주마등(reel) 종료 후 idle에서만
  // 나타난다(1인칭 진입 가능 신호). spinup·reel 재생 중엔 숨긴다.
  const ghost = createGhost({
    getStrip: () => ({
      x: layout.originX,
      y: layout.originY,
      w: layout.tileW * count,
      h: layout.tileH
    })
  })

  // 유령 음성 대화: 'ghost' 국면에서만 유령이 말을 건다. 말할 때 유령 발광을 살짝 키운다.
  // 목소리 엔진·페르소나·§1 경계는 서버(/api/ghost/session)와 ghost-persona.md가 소유한다.
  ghostVoice = createGhostVoice({
    getSession: () => window.zoetrope.getGhostSession?.(),
    onSpeaking: (on) => ghost.setGlow?.(on ? 1 : 0),
    playFutureVideo: (url) => playFutureVideoLoop(url) // 대화 tool이 미래 영상을 원본 속도로 loop 재생(첫 바퀴 뒤 resolve)
  })

  // 새로고침 재개: 서버가 준 현재 1차 흐름 국면으로 즉시 점프(진행 중인 reel은 위치까지 이어감).
  if (boot.demo && boot.demo.phase && boot.demo.phase !== 'idle') applyDemo(boot.demo, true)

  let currentFrame = -1
  let surfaceMaterial = threadMaterial
  function setSurfaceMaterial(mat) {
    if (surfaceMaterial === mat) return
    surfaceMaterial = mat
    cylinder.material = mat
    for (const p of previews) p.mesh.material = mat
  }

  // 타일 뷰포트(좌하단 원점, CSS 픽셀). 가로 한 줄이라 x만 증가, y는 레터박스 오프셋으로 고정.
  // GL 원점은 좌하단(y↑)이므로 창 상단 기준 originY를 하단 기준으로 뒤집는다.
  function tileRect(i) {
    const x = layout.originX + i * layout.tileW
    const y = window.innerHeight - (layout.originY + layout.tileH)
    return { x, y, w: layout.tileW, h: layout.tileH }
  }

  function frame() {
    const eff = effSeconds()
    // 실타래 시계를 배속만큼 적분(가속 연출). 배속이 변해도 위상 점프 없음.
    const nowMs = performance.now()
    const dt = Math.min(0.1, (nowMs - lastFrameMs) / 1000)
    lastFrameMs = nowMs
    threadClock += dt * tweenUpdate(threadSpeedMul)

    // demoPhase가 설정되면 데모가 표면을 결정: 'reel'=영상 재료, 그 외=실타래. 없으면 기존 상태기계.
    // 캘리브레이션 모드면 상태와 무관하게 몽타주(정적 기준 프레임)를 강제한다.
    const montageActive = calibrationMode
      ? !!montageMaterial
      : futureVideoActive
        ? !!montageMaterial
        : demoPhase === 'reel'
          ? !!montageMaterial
          : demoPhase === 'spinup'
            ? false
            : montageMaterial && MONTAGE_STATES.has(appState)
    setSurfaceMaterial(montageActive ? montageMaterial : threadMaterial)

    if (montageActive) {
      const u = montageMaterial.uniforms
      if (calibrationMode) {
        // 정적 기준 프레임(첫 로드된 파노라마)로 고정 — 정렬 중 콘텐츠가 움직이지 않게.
        const tex = textures.find(Boolean)
        if (tex && currentFrame !== -2) {
          currentFrame = -2
          setMontageImage(montageMaterial, tex)
        }
        u.uBlur.value = 0
        u.uVideoMix.value = 0
        // uYaw/uPitch는 방향키(setMontageCalibration)가 관리한다.
      } else if (rotate) {
        // 회전 모드: 파노라마 이미지를 천천히 회전(uYaw 자동 증가) + 한 바퀴마다 다음 이미지로 크로스페이드.
        // 벽시계 기준(startMs): 지난 바퀴 수 = 현재 이미지, 나머지 = 회전 위상.
        u.uBlur.value = 0
        const effSecPerTurn = rotate.secPerTurn / rotateSpeedMul // [debug] q/w 속도 배수 반영
        const turns = (nowMs - rotate.startMs) / 1000 / effSecPerTurn
        // 각 이미지는 딱 한 번만 등장 — 랩(모듈로) 금지. 0→1→…→마지막까지 단일 패스로 순회하고,
        // 마지막 이미지를 지나면 그 이미지에 머문 채(반복 없이) reel 완료를 서버에 알려 대화로 전환한다.
        // Q/W로 빨라지면 이 순회를 더 빨리 끝내 전환도 그만큼 앞당겨진다(전환 시각 = 이미지수 × 24s / 속도배수).
        const targetIdx = Math.min(Math.floor(turns), rotate.indices.length - 1)
        const yaw = turns - Math.floor(turns)
        if (!rotate.doneSent && turns >= rotate.indices.length) {
          rotate.doneSent = true
          window.zoetrope.sendReelDone?.() // reel당 1회만. 기본 속도면 서버 폴백 타이머와 같은 시점.
        }
        // 느린 쪽도 보장: 도는 동안 ~3s마다 heartbeat → 서버 안전 폴백(deadman) 리셋. Q로 느려도 안 끊긴다.
        if (!rotate.doneSent && nowMs - (rotate.lastTickMs || 0) > 3000) {
          rotate.lastTickMs = nowMs
          window.zoetrope.sendReelProgress?.()
        }
        // [debug] 매초 실효 회전값 — 이 줄이 안 뜨면 rotate 국면이 아님. W 누를 때 effSec가 줄면 정상 동작.
        if (window.__reelDebug !== false && nowMs - (rotate._logMs || 0) > 1000) {
          rotate._logMs = nowMs
          console.log(
            `[debug/frame] rotate mul=${rotateSpeedMul.toFixed(2)} effSec=${effSecPerTurn.toFixed(1)}s turns=${turns.toFixed(2)} yaw=${yaw.toFixed(3)}`
          )
        }
        if (targetIdx !== rotate.idx) {
          // 바퀴 넘어감 → 이전 이미지를 uTexVideo 슬롯에 두고 crossSec 동안 새 이미지(uTexImage)로 페이드.
          const fromTex = textures[rotate.indices[rotate.idx]]
          if (fromTex) {
            u.uTexVideo.value = fromTex
            u.uHasVideo.value = 1
            rotate.xfadeStartMs = nowMs
          }
          rotate.idx = targetIdx
          rotate.shownIdx = -1 // 아래 보장 블록이 새 이미지를 uTexImage로 세팅
        }
        if (rotate.shownIdx !== rotate.idx) {
          // 새/지연 로드 이미지를 본 이미지 슬롯에 세팅(늦게 로드되는 텍스처 대응).
          const tex = textures[rotate.indices[rotate.idx]]
          if (tex) {
            setMontageImage(montageMaterial, tex)
            rotate.shownIdx = rotate.idx
          }
        }
        if (rotate.xfadeStartMs) {
          const xf = (nowMs - rotate.xfadeStartMs) / 1000
          if (xf < rotate.crossSec) {
            u.uVideoMix.value = 1 - xf / rotate.crossSec // 이전(video) → 새(image) 크로스페이드
          } else {
            u.uVideoMix.value = 0
            u.uHasVideo.value = 0
            rotate.xfadeStartMs = 0
          }
        } else {
          u.uVideoMix.value = 0
        }
        // 설치 캘리브레이션 오프셋 + 회전 위상 합성
        u.uYaw.value = (((cal.yaw + yaw) % 1) + 1) % 1
      } else if (demoPhase === 'reel' || futureVideoActive) {
        // reel 데모/미래 영상(ghost 대화): videoMix로 영상 표시.
        u.uBlur.value = 0
        u.uVideoMix.value = tweenUpdate(videoMix)
        u.uYaw.value = cal.yaw // 회전 override 복원
      } else {
        // 몽타주 프레임 선택. FREEZE 후에는 eff가 얼어 있어 같은 식이 멈춘 프레임을 유지한다.
        const n = montage.playlist.length
        const durSec = montage.config.frameDurationMs / 1000
        const frame = ((Math.floor(eff / durSec) % n) + n) % n
        if (frame !== currentFrame && textures[frame]) {
          currentFrame = frame
          setMontageImage(montageMaterial, textures[frame])
        }
        u.uBlur.value = tweenUpdate(blur)
        u.uVideoMix.value = tweenUpdate(videoMix)
        u.uYaw.value = cal.yaw // 회전 override 복원
      }
    } else {
      // 실타래 앰비언트. 데모 spinup이면 threadClock이 가속돼 회전이 빨라진다.
      updateThread(threadMaterial, threadClock, install)
    }

    // 창 전체를 한 번 검게 클리어(레터박스 여백 포함)한 뒤 타일별로 그린다. (CSS 픽셀 뷰포트)
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight)
    renderer.setScissorTest(false)
    renderer.setRenderTarget(null)
    renderer.clear()
    renderer.setScissorTest(true)

    for (let i = 0; i < count; i++) {
      const r = tileRect(i)
      if (previewMode) {
        // 개발용: 펼친 파노라마 슬라이스를 타일에 직접(예왜곡·반전·블렌딩 없이).
        renderer.setRenderTarget(null)
        renderer.setViewport(r.x, r.y, r.w, r.h)
        renderer.setScissor(r.x, r.y, r.w, r.h)
        renderer.render(previews[i].scene, previews[i].camera)
      } else {
        // 설치 렌더: 프로젝터 카메라로 실린더 → RT → 후면투사 반전·블렌딩 post-pass를 타일에 출력.
        // RT 렌더는 setRenderTarget(rt)가 뷰포트를 RT 전체로 잡으므로 별도 setViewport 불필요.
        renderer.setScissorTest(false)
        renderer.setRenderTarget(rt)
        renderer.clear()
        renderer.render(scene, cameras[i])

        renderer.setScissorTest(true)
        renderer.setViewport(r.x, r.y, r.w, r.h)
        renderer.setScissor(r.x, r.y, r.w, r.h)
        posts[i].render(renderer, rt.texture) // 내부에서 setRenderTarget(null) 후 쿼드 렌더
      }
    }
    renderer.setScissorTest(false)
  }
  renderer.setAnimationLoop(frame)

  // 리프트 신호 경로(§9 미결). 지금은 수신만 하고 horizon-lock 훅에 전달. 기본 no-op.
  window.zoetrope.onLift?.(({ position } = {}) => {
    if (typeof position === 'number') for (const p of posts) p.setVerticalShift(0)
  })

  // ---- 설치 캘리브레이션(실린더 정렬) 실시간 조정 ----
  //  ← →  : 둘레 회전(yaw)  ↑ ↓ : 상하 이동(pitch)  ·  Shift=거친 스텝  ·  0=리셋
  //  부트스트랩의 calibration이 셰이더 초기값(createMontageMaterial). 조정값은 debounce로 서버 저장 → 재시작에도 유지.
  const cal = { ...(montage?.config?.calibration ?? { yaw: 0, pitch: 0 }) }
  let calSaveTimer = null
  function applyCalibration() {
    if (!montageMaterial) return
    const norm = setMontageCalibration(montageMaterial, cal)
    cal.yaw = norm.yaw
    cal.pitch = norm.pitch
    clearTimeout(calSaveTimer)
    calSaveTimer = setTimeout(() => window.zoetrope.setCalibration?.(cal), 400)
  }
  function nudgeCalibration(dYaw, dPitch) {
    cal.yaw += dYaw
    cal.pitch += dPitch
    applyCalibration()
  }

  // 캘리브레이션 모드(C키): IDLE/reel과 무관하게 정적 기준 프레임(첫 파노라마)을 띄우고 중앙 가이드선을
  // 표시해, 콘텐츠 재생을 기다리지 않고도 얼굴 위치를 실린더에 맞출 수 있게 한다. frame()이 이 플래그를 본다.
  let calibrationMode = false
  const calGuide = document.createElement('div')
  calGuide.style.cssText =
    'position:fixed;inset:0;pointer-events:none;display:none;z-index:30;'
  calGuide.innerHTML =
    '<div style="position:absolute;left:50%;top:0;bottom:0;width:1px;transform:translateX(-0.5px);background:rgba(0,255,180,.55)"></div>' +
    '<div style="position:absolute;top:50%;left:0;right:0;height:1px;transform:translateY(-0.5px);background:rgba(0,255,180,.35)"></div>' +
    '<div style="position:absolute;left:12px;top:10px;font:11px/1.4 monospace;color:rgba(0,255,180,.8)">CALIBRATION · ←→ 회전 · ↑↓ 상하 · Shift 크게 · 0 리셋 · C 종료</div>'
  document.body.appendChild(calGuide)
  function toggleCalibrationMode() {
    calibrationMode = !calibrationMode
    calGuide.style.display = calibrationMode ? 'block' : 'none'
    if (calibrationMode) currentFrame = -1 // 기준 프레임 재적용 유도
  }

  // ---- 입력 (§8) : Electron main의 before-input-event를 페이지 keydown으로 이관 ----
  //  Enter → 멈춤/진입/재개 (server 상태 기계가 상태별 의미 결정)
  //  V     → 뷰 토글(파노라마 ↔ 실린더)
  //  Space → 재생/정지 (개발용)
  //  Q / W → [debug] reel 회전(surround) 속도 느리게 / 빠르게 (실효 secPerTurn 콘솔 출력)
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    // [debug] 모든 키 수신 확인 — W 눌렀는데 이 로그가 없으면 포커스가 페이지가 아님(예: DevTools).
    // 끄기: 콘솔에서 window.__reelDebug = false
    if (window.__reelDebug !== false) console.log('[debug] keydown:', e.key)
    const yawStep = e.shiftKey ? 0.02 : 0.004 // 0.004 ≈ 1.4°, shift ≈ 7°
    const pitchStep = e.shiftKey ? 0.02 : 0.004
    if (e.key === 'Enter') {
      e.preventDefault()
      window.zoetrope.sendInput?.('stopEnter')
    } else if (e.key === 'v' || e.key === 'V' || e.code === 'KeyV') {
      e.preventDefault()
      window.zoetrope.toggleView?.()
    } else if (e.key === 'c' || e.key === 'C' || e.code === 'KeyC') {
      e.preventDefault()
      toggleCalibrationMode()
    } else if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault()
      window.zoetrope.togglePlay?.()
    } else if (e.key === 'q' || e.key === 'Q' || e.code === 'KeyQ') {
      // e.code = 물리 키 → 한글 IME(e.key='ㅂ')·레이아웃과 무관하게 잡힌다.
      e.preventDefault()
      console.log(`[debug] Q(느리게) 눌림 · demoPhase=${demoPhase} · rotate=${rotate ? 'active' : 'null'}`)
      nudgeRotateSpeed(1 / 1.25) // [debug] reel 회전 느리게
    } else if (e.key === 'w' || e.key === 'W' || e.code === 'KeyW') {
      // e.code = 물리 키 → 한글 IME(e.key='ㅈ')·레이아웃과 무관하게 잡힌다.
      e.preventDefault()
      console.log(`[debug] W(빠르게) 눌림 · demoPhase=${demoPhase} · rotate=${rotate ? 'active' : 'null'}`)
      nudgeRotateSpeed(1.25) // [debug] reel 회전 빠르게
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      nudgeCalibration(-yawStep, 0)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      nudgeCalibration(yawStep, 0)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      nudgeCalibration(0, pitchStep)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      nudgeCalibration(0, -pitchStep)
    } else if (e.key === '0') {
      e.preventDefault()
      cal.yaw = 0
      cal.pitch = 0
      applyCalibration()
    }
  })

  // Gamepad(§8): Xbox 컨트롤러 버튼 → Enter와 동일 액션. 에지 감지(눌림 순간 1회).
  const gpPrev = Object.create(null)
  function pollGamepads() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : []
    for (const pad of pads) {
      if (!pad) continue
      pad.buttons.forEach((btn, bi) => {
        const key = `${pad.index}:${bi}`
        const pressed = btn.pressed
        if (pressed && !gpPrev[key]) {
          // 버튼 0(A) = 멈춤/진입/재개. 다른 버튼은 열어둠(§8 재개/퇴장 배선 확정 시 추가).
          if (bi === 0) window.zoetrope.sendInput?.('stopEnter')
        }
        gpPrev[key] = pressed
      })
    }
    requestAnimationFrame(pollGamepads)
  }
  requestAnimationFrame(pollGamepads)
}

main().catch((err) => {
  // 부트스트랩 실패 시 콘솔에 남긴다(자막·해설을 화면에 붙이지 않는다, §1).
  console.error('[renderer] bootstrap failed:', err)
})
