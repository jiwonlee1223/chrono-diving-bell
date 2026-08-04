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
import { createBgMusic } from './scene/bg-music.js'
import { createSfxLayer } from './scene/sfx-layer.js'

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
  // ghost 국면(주마등 종료 후) 동안 ZOETROPE 앰비언트 몽타주(현재 시점 사진 플레이리스트)를 막는다 —
  // 릴이 탄생에서 끝난 직후 현재 사진이 이어 보이면 역행의 종결이 깨진다. 실타래 앰비언트로 대신한다.
  // 대화 영상(convoVideoActive)·1인칭 진입(IMMERSION 등 다른 상태)은 그대로 보인다.
  let ghostIdleDark = false
  const threadSpeedMul = makeTween(1) // 실타래 시간 배속(가속 연출).
  let threadClock = 0 //                로컬 적분 실타래 시계(배속 변화에도 위상 점프 없음).
  let lastFrameMs = performance.now()

  let videoEl = null
  let videoTexture = null
  let videoSyncTimer = null
  let videoStartAtMs = 0
  let convoVideoActive = false // 유령 대화 영상(과거 회귀/미래) 재생 중(ghost 대화 tool). frame()이 보면 영상 재료를 렌더.

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

  // 대화 배경음악(ghost 국면에서만). ghostVoice의 발화·청취 콜백이 음량을 덕킹한다(발화 3·청취 5·평소 10).
  const bgMusic = createBgMusic({ src: '/resources/Where_Light_Ends.mp3' })

  // 앰비언스 효과음 레이어 — 대화 영상의 장면 맥락에 맞는 환경음을 BGM 위에 한 겹 더 깐다.
  // 장면 텍스트는 playConversationVideo opts.scene으로 들어온다(ghost-voice의 tool·턴 응답이 전달).
  const sfx = createSfxLayer()

  // 장례식 국면의 앰비언스 — 조문객들의 낮은 웅성거림(resources/sfx/에 그대로 있는 파일명).
  // 장면 텍스트 매칭이 아니라 국면 자체가 정하는 소리라 sfx.play()로 직접 지정한다.
  const FUNERAL_SFX_SLUG = 'Crowd Talking'
  const FUNERAL_SFX_GAIN = 0.2
  // 장례식 장면을 머무는 시간(ms). Wan 클립 자체는 ~5초라 이 시간까지 loop로 돈다.
  // 서버가 국면 payload로 실제 값을 내려주면 그걸 쓰고, 없으면 이 기본값.
  const FUNERAL_SCENE_MS = 15000

  // 상태 진입 연출. immediate = 부트스트랩 시 트윈 없이 그 국면으로 점프.
  function applyState(state, meta = {}, immediate = false) {
    appState = state
    // §1: 1인칭 진입·몽타주 재생(ZOETROPE/FREEZE/REGEN_WAIT/IMMERSION)에 들어가면 유령 목소리를 끈다.
    if (MONTAGE_STATES.has(state)) {
      ghostVoice?.stop()
      bgMusic.stop()
      sfx.stop()
    }
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

  // ---- 전환 베일: 모든 화면 전환은 무조건 fade in/out ----
  // 검정 전면 오버레이 하나로 통일한다 — 국면 전환(spinup↔reel↔ghost↔idle)과 대화 영상 교체가
  // 전부 "cover(어두워짐) → 전환 → uncover(밝아짐)"를 거친다. z-index 15: 캔버스 위,
  // 섬광(20)·유령(31) 아래 — 유령은 어둠 위로 떠오른다.
  const veil = (() => {
    const el = document.createElement('div')
    el.style.cssText =
      'position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;z-index:15;'
    document.body.appendChild(el)
    function to(opacity, sec) {
      return new Promise((resolve) => {
        const from = parseFloat(getComputedStyle(el).opacity) || 0
        const anim = el.animate([{ opacity: from }, { opacity }], {
          duration: Math.max(1, sec * 1000),
          easing: 'ease-in-out',
          fill: 'forwards'
        })
        const done = () => {
          el.style.opacity = String(opacity)
          resolve()
        }
        anim.onfinish = done
        anim.oncancel = done // 새 전환이 덮어써도 대기 중 promise는 풀어준다
      })
    }
    return {
      cover: (sec = 0.6) => to(1, sec), //   fade-out: 화면이 어두워진다
      uncover: (sec = 0.9) => to(0, sec) // fade-in: 새 화면이 떠오른다
    }
  })()

  // ---- TV 꺼짐 암전 ----
  // 브라운관이 꺼질 때처럼: 화면이 세로로 확 접혀 가로 한 줄의 빛이 되고, 그 줄이 가운데 점으로
  // 빨려들어 사라진 뒤 완전한 검정이 남는다. 장례식 영상과 주마등 사이의 전환 연출이다(2026-08-03).
  // 캔버스 자체에 CSS 변환을 걸어 접고(그 뒤는 body의 검정), 접히는 순간의 잔광은 흰 줄 오버레이로 그린다.
  // 끝나면 캔버스 변환을 원상복구하고 베일(검정)을 남겨둔다 — 다음 국면이 그 어둠 위에서 떠오른다.
  const tvLine = (() => {
    const el = document.createElement('div')
    el.style.cssText =
      'position:fixed;left:0;right:0;top:50%;height:3px;background:#fff;opacity:0;' +
      'pointer-events:none;z-index:16;transform:translateY(-50%);box-shadow:0 0 24px 6px rgba(255,255,255,.8);'
    document.body.appendChild(el)
    return el
  })()

  async function tvOff({ totalMs = 1600 } = {}) {
    const collapseMs = Math.max(120, totalMs * 0.35) // 세로로 접힘
    const lineMs = Math.max(120, totalMs * 0.3) // 한 줄이 가운데 점으로 수축
    const holdMs = Math.max(0, totalMs - collapseMs - lineMs) // 완전한 검정
    const ease = 'cubic-bezier(.6,0,.9,.4)'
    const anims = []
    anims.push(
      canvas.animate([{ transform: 'scaleY(1)' }, { transform: 'scaleY(0.004)' }], {
        duration: collapseMs,
        easing: ease,
        fill: 'forwards'
      })
    )
    anims.push(
      tvLine.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: collapseMs,
        easing: 'ease-in',
        fill: 'forwards'
      })
    )
    await new Promise((r) => setTimeout(r, collapseMs))
    // 접힌 줄이 가운데 점으로 빨려들어간다 — 캔버스는 이미 안 보이므로 줄만 줄인다.
    anims.push(
      tvLine.animate(
        [
          { transform: 'translateY(-50%) scaleX(1)', opacity: 1 },
          { transform: 'translateY(-50%) scaleX(0)', opacity: 0 }
        ],
        { duration: lineMs, easing: 'ease-in', fill: 'forwards' }
      )
    )
    await new Promise((r) => setTimeout(r, lineMs))
    // 캔버스를 되돌리기 전에 베일을 먼저 덮는다 — 안 그러면 접혔던 마지막 장례식 프레임이
    // 원상복구되는 순간 한 번 번쩍 되살아난다. 이 검정이 그대로 다음 국면의 배경이 된다.
    await veil.cover(0.001)
    await new Promise((r) => setTimeout(r, holdMs))
    for (const a of anims) a.cancel()
    canvas.style.transform = ''
    tvLine.style.opacity = '0'
    tvLine.style.transform = 'translateY(-50%)'
  }

  // ---- reel 배속 재생. 종료(→유령 idle)는 서버가 국면으로 방송하므로 여기선 재생만 한다. ----
  //  seekSec: 새로고침 재개 시 영상 위치(실경과 × 배속). flash: 시작 섬광(재개 땐 생략).
  function playReelOnce(
    url,
    { seekSec = 0, playbackRate = REEL_PLAYBACK_RATE, flash = true } = {}
  ) {
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

  // ---- 장례식 영상(주마등 앞) — 고인 시선의 장례식장 파노라마 클립을 등속 재생 ----
  // 장면 길이는 sceneMs(기본 15초)로 잡는다. Wan 클립 자체는 ~5초라 그 길이에 닿을 때까지
  // loop로 돌린다(향·촛불·조문객의 미세한 움직임뿐이라 이음매가 거의 보이지 않는다).
  // 잘린 프레임에서 끊기지 않도록, 목표 시간에 가장 가까운 **정수 바퀴** 지점에서 끝낸다
  // (5.06초 클립이면 3바퀴 = 15.2초). 그 지점에서 TV가 꺼지듯 암전시키고 서버에 알린다
  // → 서버가 주마등(역순) 국면을 방송한다.
  // 로드 실패·재생 실패로 canplaythrough가 영영 안 오는 경우를 대비해 상한 타이머를 함께 건다
  // (서버에도 폴백이 있지만, 여기서 끝내야 TV 암전 연출까지 정상적으로 들어간다).
  //  convo: ghost 대화 중(2차 플로우 미래 진입)에 트는 경우 — 'ghost' 국면에는 demoPhase가 없으므로
  //   convoVideoActive를 켜야 실린더에 그려진다. 끝나면 Promise가 resolve된다(대화가 이어짐).
  function playFuneralOnce(
    url,
    { seekSec = 0, blackoutMs = 1600, sceneMs = FUNERAL_SCENE_MS, convo = false } = {}
  ) {
    let settled = false
    let resolveDone
    const done = new Promise((r) => (resolveDone = r))
    const finish = async () => {
      if (settled) return done
      settled = true
      await tvOff({ totalMs: blackoutMs })
      teardownVideo()
      if (convo) convoVideoActive = false
      else window.zoetrope.sendFuneralDone?.()
      resolveDone()
      return done
    }
    teardownVideo()
    if (convo) convoVideoActive = true
    if (!url || !montageMaterial) return finish()
    videoEl = document.createElement('video')
    videoEl.muted = true
    videoEl.loop = true // 클립(~5초)이 짧아 sceneMs에 닿을 때까지 돈다
    videoEl.playsInline = true
    videoEl.preload = 'auto'
    videoEl.crossOrigin = 'anonymous'
    videoEl.src = url
    videoEl.playbackRate = 1 // 장례식은 배속하지 않는다 — 느린 애도의 결이 연출의 전부다
    const el = videoEl
    let guard = setTimeout(finish, sceneMs + 15000) // 로드 자체가 안 되는 경우의 상한
    el.addEventListener(
      'canplaythrough',
      () => {
        videoTexture = new THREE.VideoTexture(el)
        videoTexture.colorSpace = THREE.NoColorSpace
        setMontageVideo(montageMaterial, videoTexture)
        videoMix.v = videoMix.from = videoMix.to = 1
        const durSec = isFinite(el.duration) && el.duration > 0 ? el.duration : 0
        // 목표 시간에 가장 가까운 정수 바퀴로 장면 길이를 확정한다 — 이음매에서 끝나므로
        // 마지막 바퀴가 중간에 잘리지 않는다. 길이를 못 읽으면 sceneMs를 그대로 쓴다.
        const cycles = durSec ? Math.max(1, Math.round(sceneMs / 1000 / durSec)) : 0
        const totalMs = cycles ? cycles * durSec * 1000 : sceneMs
        // 새로고침 재개 — 이미 지난 만큼은 건너뛰고 남은 시간만 튼다(등속이라 경과=재생 위치).
        if (seekSec > 0 && durSec) el.currentTime = (seekSec % durSec) + 0
        const remainMs = Math.max(500, totalMs - Math.max(0, seekSec) * 1000)
        clearTimeout(guard)
        guard = setTimeout(finish, remainMs)
        el.play().catch(finish)
      },
      { once: true }
    )
    el.addEventListener('error', finish, { once: true })
    el.load()
    return done
  }

  // 2차 플로우(미래) 진입 연출 ⓪ — 과거 장이 닫힌 유령 idle의 실타래가 다시 감겨 올라간다.
  // 1차 개막 spinup(세션 지정 직후)과 같은 문법: 배속이 mul(기본 10배)까지 가속되다 정점에서
  // 어둠으로 저물고, 그 어둠에서 90세 장례식(→ 미래 릴)이 떠오른다. 속도는 어둠 속에서 원복.
  async function playFutureSpinupIntro({ ms = 10000, mul = 10 } = {}) {
    teardownVideo()
    convoVideoActive = false // 실타래 앰비언트가 표면을 갖는다(clearVideo 뒤라 보통 이미 해제 상태)
    tweenTo(threadSpeedMul, mul, Math.max(0.3, ms / 1000))
    await new Promise((r) => setTimeout(r, ms))
    await veil.cover(0.6) // 가속의 정점에서 어둠으로
    tweenTo(threadSpeedMul, 1, 0.001) // 다음에 실타래가 보일 땐 평상 속도
  }

  // 2차 플로우(미래) 진입 연출 — 1장(과거)이 닫히고 미래로 넘어가는 그 자리에서, 90세에 맞는
  // 자신의 장례식을 먼저 본다. 1차가 "장례식 → 암전 → 주마등(역순)"이듯, 2차도 "장례식 →
  // 암전 → 미래의 순간들"로 열린다 — 죽음이 먼저고 그 다음이 삶이라는 같은 문법이다.
  // ghost-voice가 chapterTurned 시점에 부르고, 끝나면(암전까지) resolve되어 전환 발화가 이어진다.
  async function playFutureFuneralIntro(url, { blackoutMs = 1600, sceneMs } = {}) {
    if (!url) return
    sfx.play(FUNERAL_SFX_SLUG, { gain: FUNERAL_SFX_GAIN }) // 조문객 웅성거림 — 1차 장례식과 같은 결
    await veil.cover(0.6) // 유령 idle이 어둠으로 저문다
    const done = playFuneralOnce(url, { blackoutMs, sceneMs, convo: true })
    veil.uncover(0.9) // 장례식장이 떠오른다
    await done
    sfx.stop()
  }

  // 2차 플로우의 미래 주마등 — 90세 장례식이 암전으로 닫힌 그 자리에서 미래 릴이 흐른다.
  // 1차 주마등이 현재→탄생으로 되감기는 것과 반대로, 이건 현재 다음 해→90세로 풀려나간다
  // (순서는 서버가 재생목록을 그 방향으로 넘겨 정한다). 스트립이 정확히 1사이클 돌면 resolve되고,
  // 그 다음에 유령이 전환 발화를 시작한다. 사진이 없거나 로드에 실패하면 즉시 resolve — 대화가 멈추지 않는다.
  function playFutureReelIntro(payload) {
    return new Promise((resolve) => {
      if (!payload?.photos?.length || !montageMaterial) return resolve()
      let settled = false
      const finish = async () => {
        if (settled) return
        settled = true
        await veil.cover(0.6) // 미래가 어둠으로 저문다 — 그 어둠 위에서 유령이 말을 건다
        stopFilmstrip()
        convoVideoActive = false
        resolve()
      }
      teardownVideo()
      rotate = null
      convoVideoActive = true // 'ghost' 국면엔 demoPhase가 없다 — 이걸 켜야 실린더에 그려진다
      startFilmstrip(payload, finish)
      veil.uncover(0.9)
      // 안전장치: 스트립 1사이클이 어떤 이유로든 안 끝나도 대화가 영영 멈추지 않게 상한을 둔다.
      const capSec = (payload.secPerTurn || 24) * (payload.photos.length + 2)
      setTimeout(finish, capSec * 1000)
    })
  }

  // 유령 대화 영상 하나를 원본 속도로 loop 재생(ghost 대화 client tool이 호출). Promise 반환 —
  // loop라 얼지 않고 계속 살아 움직인다. 'ended'가 안 오므로, 첫 한 바퀴(대략 영상 길이) 뒤에 resolve해
  // 에이전트가 다음 대사로 넘어가게 하고, 영상은 다음 영상 재생/국면 전환(teardown) 전까지 계속 loop로 흐른다.
  // convoVideoActive=true인 동안 frame()이 실린더에 영상을 그린다(국면 전환 시 applyDemo가 해제).
  // 안전장치: 로드/재생 실패나 canplaythrough 누락 시에도 상한 뒤 resolve해 대화가 멈추지 않게 한다.
  //  fadeIn: 과거 회귀 연출("화면이 fade in된다") — 베일로 이전 화면을 어둠에 내려놓고(cover),
  //  영상이 준비되면 베일을 걷어(uncover) 그 순간이 떠오른다. 미래 흐름(2차)은 기존대로 즉시 표시.
  //  resolveAfterSec: 지정하면 재생 시작 후 그 시간 뒤에 resolve(대화가 빨리 이어짐 — 과거 회귀).
  //  미지정이면 첫 한 바퀴(영상 길이) 뒤 resolve(기존 미래 흐름 동작 유지).
  //  scene: 장면 설명 텍스트 — 맥락에 맞는 앰비언스 효과음(sfx-layer)을 BGM 위에 깐다. 매칭 없으면 무음.
  async function playConversationVideo(
    url,
    { fadeIn = false, fadeInSec = 1.5, resolveAfterSec = 0, scene = '' } = {}
  ) {
    sfx.playForScene(scene) // 영상과 함께 페이드 인(매칭 없으면 이전 앰비언스만 걷는다)
    if (fadeIn) await veil.cover(0.6) // 이전 화면(릴·직전 장면)이 어둠으로 저문다
    return new Promise((resolve) => {
      teardownVideo()
      if (!url || !montageMaterial) {
        if (fadeIn) veil.uncover(0.6) // 검정에 갇히지 않게
        resolve()
        return
      }
      convoVideoActive = true
      if (fadeIn) {
        // 베일 아래에서 이전 텍스처(필름스트립·몽타주 잔상)를 치워 검정 베이스로.
        setMontageImage(montageMaterial, null)
        videoMix.v = videoMix.from = videoMix.to = 0
      }
      const v = document.createElement('video')
      v.muted = true // 클립은 무음(-an). 자동재생 안전 위해 muted.
      v.loop = true // 계속 loop — 얼지 않고 살아 움직인다(pingpong 변환본이면 경계 점프 없는 왕복).
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
        if (fadeIn) veil.uncover(0.6) // 어떤 경로로 끝나든 화면이 검정에 갇히지 않게(이미 걷혔으면 no-op)
        resolve() // pause하지 않는다 — loop로 계속 재생(살아 움직임 유지)
      }
      v.addEventListener(
        'canplaythrough',
        () => {
          videoTexture = new THREE.VideoTexture(v)
          videoTexture.colorSpace = THREE.NoColorSpace
          setMontageVideo(montageMaterial, videoTexture)
          videoMix.v = videoMix.from = videoMix.to = 1 // 영상 표시(fade는 베일이 담당)
          v.play().catch(() => {})
          if (fadeIn) veil.uncover(fadeInSec) // 어둠이 걷히며 그 순간이 떠오른다
          clearTimeout(timer)
          const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 8
          const waitMs =
            resolveAfterSec > 0 ? resolveAfterSec * 1000 : Math.min(dur * 1000 + 300, 18000)
          timer = setTimeout(finish, waitMs) // 대화 재개 시점(영상은 계속 loop)
        },
        { once: true }
      )
      v.addEventListener('error', finish, { once: true }) // 로드 실패해도 대화는 진행
      v.load()
    })
  }

  // 대화 영상을 걷고 유령 idle 앰비언트(실타래 + 유령)로 되돌린다 — 1장(과거)→2장(미래) 전환 발화
  // ("이제 넌, 미래로 갈 거야…") 시점에 ghost-voice가 부른다. 'ghost' 국면 자체는 유지되므로
  // 유령·음성·배경음악은 그대로 두고 영상 재료만 베일 뒤에서 치운다.
  async function clearConversationVideo({ fadeSec = 0.6 } = {}) {
    sfx.stop() // 장면이 걷히면 앰비언스도 함께 저문다
    await veil.cover(fadeSec) // 직전 장면이 어둠으로 저문다
    teardownVideo()
    convoVideoActive = false
    if (montageMaterial) setMontageImage(montageMaterial, null)
    videoMix.v = videoMix.from = videoMix.to = 0 // 앰비언트(실타래) 베이스로 복귀
    veil.uncover(0.9) // 유령 뜬 idle이 떠오른다
  }

  // reel 회전 모드 — Gemini 파노라마 이미지들을 천천히 회전시키며 순회(한 바퀴=secPerTurn초, 바퀴마다
  // 다음 이미지로 크로스페이드). uYaw 합성(설치 캘리브레이션 + 회전)은 frame()이 한다(cal이 그때
  // 정의돼 있어 TDZ 회피). 크로스페이드는 uTexVideo 슬롯을 다음 이미지로 재사용해 uVideoMix로 섞는다.
  let rotate = null // { indices, secPerTurn, crossSec, startMs, idx, shownIdx, xfadeStartMs } | null
  let rotateSpeedMul = 1 // [debug] reel 회전(surround) 속도 배수. q/w로 실시간 조절. 1 = montage.json rotateSecPerTurn 기준.
  // [debug] 회전 속도를 factor배 하되 startMs를 재기준해 위상 점프 없이 바꾼다.
  //  현재 실효 secPerTurn(= rotateSecPerTurn / 배수)을 콘솔에 찍어 montage.json에 옮겨 적을 수 있게 한다.
  function nudgeRotateSpeed(factor) {
    const target = rotate || filmstrip // 필름스트립도 같은 배수·위상 재기준 규칙을 공유한다
    if (!target) {
      console.log('[debug] q/w: reel 회전(rotate/filmstrip) 중에만 동작합니다')
      return
    }
    const now = performance.now()
    const oldMul = rotateSpeedMul
    const newMul = Math.max(0.05, Math.min(40, oldMul * factor))
    target.startMs = now - (now - target.startMs) * (oldMul / newMul) // 위상 연속 유지(점프 방지)
    rotateSpeedMul = newMul
    const effSec = target.secPerTurn / newMul
    console.log(
      `[debug] reel 회전 속도 ×${newMul.toFixed(2)} → 1바퀴 ${effSec.toFixed(1)}s (montage.json demo.rotateSecPerTurn)`
    )
  }
  // reel 필름스트립 모드 — reel 전용 3:4 사진들을 한 장의 스트립 텍스처(캔버스)로 이어 붙여
  // 실린더에 종횡비 유지한 채 감고(uMapping=3, uStripScale), 필름처럼 연속 스크롤한다.
  // 스크롤 속도 = 실린더 1바퀴 / secPerTurn(rotate와 동일 파라미터·Q/W 배수 공유).
  // 스트립이 정확히 1사이클(모든 사진이 한 번씩 지나감) 돌면 reel-done을 서버에 1회 보낸다.
  let filmstrip = null // { secPerTurn, startMs, stripScale, texture, doneSent, lastTickMs } | null
  const baseMapping = montageMaterial?.uniforms.uMapping.value ?? 2
  // reel 축소 배율(montage.json demo.reelScale) — 릴이 실린더 세로를 꽉 채우지 않게 중앙 기준 축소.
  const reelScale = Math.min(1, Math.max(0.2, montage?.config?.reelScale ?? 1))
  function setReelScale(on) {
    if (montageMaterial) montageMaterial.uniforms.uReelScale.value = on ? reelScale : 1
  }
  function setStripMapping(on) {
    if (montageMaterial) montageMaterial.uniforms.uMapping.value = on ? 3 : baseMapping
  }
  // 필름 롤 연출(montage.json demo.filmLook, 기본 on) — 스트립 합성(퍼포레이션)과 셰이더 질감을 함께 켠다.
  const filmLook = montage?.config?.filmLook !== false
  function stopFilmstrip() {
    setReelScale(false) // rotate=null 경로들도 stopFilmstrip을 거치므로 여기서 함께 원복
    if (montageMaterial) montageMaterial.uniforms.uFilmLook.value = 0
    if (!filmstrip) return
    filmstrip.texture?.dispose()
    filmstrip = null
    setStripMapping(false)
  }

  // 사진들을 순서대로 이어 붙인 스트립 캔버스 합성. 각 프레임은 그 사진의 실제 비율 그대로
  // (생성 설정이 4:3 가로형이든 과거 3:4든 자동 적응 — 크롭 없음), 프레임 사이·양 끝에
  // 검정 거터(필름 프레임 간격) — 스트립 좌우 끝이 거터라 wrap 이음매가 검정 안에 떨어져 안 보인다.
  //  padEndAspect: 마지막 프레임 뒤에 붙일 검정 꼬리의 종횡비(w/H). 1차 주마등(탄생으로 끝)에서
  //  실린더 한 바퀴만큼 붙여, 탄생 장이 중앙에 멈춰 있는 동안 wrap으로 스트립 첫 장(현재)이
  //  등 뒤에서 미리 보이는 걸 막는다.
  //  filmLook: 옛날 필름 카메라 롤 연출 — 스트립 위아래에 퍼포레이션(스프로킷 구멍) 밴드를 두고
  //  사진을 그 사이에 끼운다(35mm 네거티브 롤의 단면). 검정 꼬리(padEndAspect)에는 아무것도 안
  //  그린다 — 탄생 이후 blank 구간은 빈 필름조차 아니라 완전한 어둠이다.
  function buildFilmstripTexture(photos, gutterFrac, onDone, padEndAspect = 0, filmLook = false) {
    const H = 1024
    const imgs = new Array(photos.length).fill(null)
    let remaining = photos.length
    if (!remaining) return onDone(null)
    const finish = () => {
      const loaded = imgs.filter(Boolean)
      if (!loaded.length) return onDone(null)
      const gutter = Math.round(H * (gutterFrac ?? 0.05))
      const band = filmLook ? Math.round(H * 0.13) : 0 // 퍼포레이션 밴드(위·아래 각각)
      const innerH = H - band * 2 // 사진이 차지하는 세로
      const frameWs = loaded.map((im) => Math.round(innerH * (im.width / im.height)))
      const cv = document.createElement('canvas')
      const photosW = frameWs.reduce((a, w) => a + w + gutter, 0)
      cv.width = photosW + Math.round(H * padEndAspect)
      cv.height = H
      const ctx = cv.getContext('2d')
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, cv.width, cv.height)
      if (filmLook) {
        // 필름 베이스 — 사진 구간만 아주 어두운 갈빛(현상된 네거티브의 바탕).
        ctx.fillStyle = '#151007'
        ctx.fillRect(0, 0, photosW, H)
      }
      let x = 0
      let lastCenter = 0
      loaded.forEach((im, i) => {
        ctx.drawImage(im, 0, 0, im.width, im.height, x + gutter / 2, band, frameWs[i], innerH)
        if (filmLook) {
          // 프레임 가장자리 — 희미한 따뜻한 윤곽선(인화지 프레임 경계).
          ctx.strokeStyle = 'rgba(232, 214, 170, 0.14)'
          ctx.lineWidth = 3
          ctx.strokeRect(x + gutter / 2 + 1.5, band + 1.5, frameWs[i] - 3, innerH - 3)
        }
        lastCenter = x + gutter / 2 + frameWs[i] / 2
        x += frameWs[i] + gutter
      })
      if (filmLook) {
        // 퍼포레이션 — 위·아래 밴드 중앙에 일정한 피치로 도는 둥근 사각 구멍(영사광에 밝게 비침).
        const holeH = Math.round(band * 0.5)
        const holeW = Math.round(holeH * 1.35)
        const pitch = holeW * 2
        ctx.fillStyle = '#cfc6b2'
        for (let hx = Math.round(pitch / 2); hx + holeW < photosW; hx += pitch) {
          for (const cy of [band / 2, H - band / 2]) {
            ctx.beginPath()
            ctx.roundRect(hx, cy - holeH / 2, holeW, holeH, holeH * 0.3)
            ctx.fill()
          }
        }
      }
      const tex = new THREE.CanvasTexture(cv)
      tex.colorSpace = THREE.NoColorSpace
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping // wrap은 셰이더 fract가 담당(이음매는 거터 안)
      onDone({ texture: tex, aspect: cv.width / cv.height, lastCenterFrac: lastCenter / cv.width })
    }
    photos.forEach((p, i) => {
      const im = new Image()
      im.crossOrigin = 'anonymous'
      im.onload = () => {
        imgs[i] = im
        if (--remaining === 0) finish()
      }
      im.onerror = () => {
        if (--remaining === 0) finish() // 실패 장은 빠진 채 진행
      }
      im.src = p.url
    })
  }

  //  onDone: 스트립이 정확히 1사이클 돌면 부른다(2차 미래 릴 — 대화가 다음으로 넘어가는 신호).
  //   미지정이면 기존 동작(서버에 reel-done 전송).
  function startFilmstrip(payload, onDone = null) {
    const photos = payload?.photos || []
    stopFilmstrip()
    if (!photos.length || !montageMaterial) {
      onDone?.() // 사진이 없으면 즉시 다음 단계로(대화가 멈추지 않게)
      return
    }
    const secPerTurn = payload?.secPerTurn || 24
    const elapsedSec = Math.max(0, (payload?.elapsedMs ?? 0) / 1000)
    // 실린더 둘레 종횡비(2πR/H) — 스트립이 종횡비를 유지한 채 감기도록 uStripScale의 분자가 된다.
    const circumAspect = (2 * Math.PI * install.cylinder.radius) / install.cylinder.height
    // 1차 주마등 끝 연출(서버 payload holdLastSec): 마지막 장(탄생)이 정면 중앙에 오면 정지 →
    // holdLastSec초 머문 뒤 blank. 미래 릴 payload에는 이 필드가 없어 기존 동작 그대로다.
    const holdLastSec = payload?.holdLastSec ?? 0
    const fs = {
      secPerTurn,
      startMs: performance.now() - elapsedSec * 1000, // 벽시계 기준 — 새로고침 재개 반영
      stripScale: 1,
      stripTurns: 1, // 스트립 1사이클에 필요한 실린더 바퀴 수(= stripAspect / circumAspect)
      texture: null,
      doneSent: false,
      lastTickMs: 0,
      holdLastSec,
      lastCenterFrac: null, // 마지막 장 중심의 스트립 x 비율(0..1) — 정지 위상 계산용
      blanked: false, // 탄생 정지 후 blank 처리 1회 플래그
      onDone
    }
    filmstrip = fs
    setReelScale(true)
    teardownVideo()
    setMontageImage(montageMaterial, null) // 스트립 준비 전까지 이전 텍스처 대신 검정
    buildFilmstripTexture(
      photos,
      payload?.gutterFrac,
      (result) => {
        if (filmstrip !== fs) {
          result?.texture?.dispose() // 이미 다른 국면으로 넘어감
          return
        }
        if (!result) {
          console.warn('[filmstrip] 사진 로드 전부 실패 — 검정 화면 유지')
          if (fs.onDone && !fs.doneSent) {
            fs.doneSent = true
            fs.onDone() // 대화가 검정 화면에 갇히지 않게 바로 다음 단계로
          }
          return
        }
        fs.texture = result.texture
        fs.stripScale = circumAspect / result.aspect
        // 셰이더가 uStripScale/reelScale로 샘플하므로, 1사이클에 필요한 바퀴 수도 같은 비로 줄어든다.
        fs.stripTurns = (result.aspect / circumAspect) * reelScale
        fs.lastCenterFrac = result.lastCenterFrac
        setMontageImage(montageMaterial, result.texture)
        montageMaterial.uniforms.uStripScale.value = fs.stripScale
        setStripMapping(true)
        montageMaterial.uniforms.uFilmLook.value = filmLook ? 1 : 0
        montageMaterial.uniforms.uBlur.value = 0
        montageMaterial.uniforms.uVideoMix.value = 0
        montageMaterial.uniforms.uHasVideo.value = 0
      },
      // 검정 꼬리: 탄생 정지 중 wrap으로 첫 장(현재)이 다시 보이지 않게 실린더 한 바퀴(리일 축소
      // 배율 반영)만큼 검정을 잇는다 — "탄생 이후엔 모든 릴이 다 돌 때까지 blank".
      holdLastSec > 0 ? circumAspect / reelScale : 0,
      filmLook
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
    setReelScale(true)
    teardownVideo()
    if (montageMaterial) {
      montageMaterial.uniforms.uBlur.value = 0
      montageMaterial.uniforms.uVideoMix.value = 0
      montageMaterial.uniforms.uHasVideo.value = 0
    }
  }

  // 서버 소유 1차 흐름 국면 적용. immediate=true는 부트스트랩 재개(트윈 없이 그 국면으로 점프).
  //  idle: 앰비언트(유령 숨김, admin 세션 나가기) · spinup: 실타래 배속 · reel: 회전/배속 재생 · ghost: 유령 뜬 idle
  // 전환은 무조건 fade: 국면이 실제로 바뀌면(재개·동일국면 갱신 제외) 베일로 화면을 덮은 뒤 새 국면을
  // 세팅하고 베일을 걷는다 — reel→ghost, spinup→reel 등 모든 화면 전환이 검정을 거쳐 부드럽게 넘어간다.
  let lastDemoPhase = null
  async function applyDemo(payload, immediate = false) {
    const phase = payload?.phase ?? 'idle'
    const transition = !immediate && phase !== lastDemoPhase
    lastDemoPhase = phase
    if (transition) await veil.cover(0.6) // 이전 국면이 어둠으로 저문다
    applyDemoInner(payload, immediate)
    if (transition) veil.uncover(0.9) // 새 국면이 떠오른다 (필름스트립 로드 중이면 검정 위에서 뜬다)
  }

  function applyDemoInner(payload, immediate = false) {
    const phase = payload?.phase ?? 'idle'
    const elapsedSec = Math.max(0, (payload?.elapsedMs ?? 0) / 1000)
    ghostIdleDark = phase === 'ghost' // 유령 idle 배경에서 현재 시점 사진 플레이리스트 차단
    convoVideoActive = false // 국면 전환 시 대화 영상 재생 해제(ghost 대화 tool이 다시 켠다)
    sfx.stop() // 앰비언스는 대화 영상에만 속한다 — 국면이 바뀌면 함께 걷는다
    const dur = (s) => (immediate ? 0.001 : s)
    if (phase === 'spinup') {
      demoPhase = 'spinup'
      rotate = null
      stopFilmstrip()
      ghost.hide()
      ghostVoice?.stop()
      bgMusic.stop()
      teardownVideo()
      tweenTo(videoMix, 0, dur(0.2))
      tweenTo(blur, 0, dur(0.2))
      const total = (payload?.spinupMs ?? 10000) / 1000
      threadSpeedMul.v = 1 + (SPINUP_MAX - 1) * Math.min(1, elapsedSec / total) // 재개 시 진행률 반영
      tweenTo(threadSpeedMul, SPINUP_MAX, Math.max(0.3, total - elapsedSec))
    } else if (phase === 'funeral') {
      // 주마등에 앞서 자기 장례식을 본다 — 등속 1회 재생, 끝나면 TV가 꺼지듯 암전(playFuneralOnce).
      demoPhase = 'funeral'
      rotate = null
      stopFilmstrip()
      ghost.hide()
      ghostVoice?.stop()
      bgMusic.start() // 장례식부터 주마등까지 같은 배경음악이 끊기지 않고 이어진다
      // 배경음악 위에 조문객들의 웅성거림을 한 겹 더 깐다 — 식장의 공기. 다른 앰비언스보다
      // 더 낮게(0.2) 깔아, 소리의 정체가 드러나기보다 배경으로만 남게 한다.
      sfx.play(FUNERAL_SFX_SLUG, { gain: FUNERAL_SFX_GAIN })
      tweenTo(blur, 0, dur(0.2))
      playFuneralOnce(payload?.url, {
        seekSec: elapsedSec, // 새로고침 재개 — 등속이라 경과 시간이 곧 재생 위치
        blackoutMs: payload?.blackoutMs ?? 1600,
        sceneMs: payload?.sceneMs ?? FUNERAL_SCENE_MS
      })
    } else if (phase === 'reel') {
      demoPhase = 'reel'
      ghost.hide()
      ghostVoice?.stop()
      bgMusic.start() // 주마등(reel)에도 대화와 같은 배경음악을 깐다
      if (payload?.mode === 'filmstrip') {
        rotate = null
        startFilmstrip(payload) // reel 전용 3:4 사진 스트립을 필름처럼 연속 스크롤
      } else if (payload?.mode === 'rotate') {
        stopFilmstrip()
        startRotate(payload) // Gemini 파노라마 이미지를 천천히 회전시키며 순회
      } else {
        rotate = null
        stopFilmstrip()
        const rate = payload?.playbackRate ?? REEL_PLAYBACK_RATE
        playReelOnce(payload?.url, {
          seekSec: elapsedSec * rate,
          playbackRate: rate,
          flash: !immediate
        })
      }
    } else if (phase === 'ghost') {
      demoPhase = null
      rotate = null
      stopFilmstrip()
      teardownVideo()
      tweenTo(videoMix, 0, dur(0.6))
      tweenTo(blur, 0, dur(0.4))
      tweenTo(threadSpeedMul, 1, dur(1.5))
      ghost.show() // 유령 등장 = 1인칭 진입 가능 신호.
      ghostVoice?.start() // 유령이 나타나면 말을 건다(show 램프 뒤 startDelayMs). §1 경계는 페르소나가 소유.
      bgMusic.start() // 대화 배경음악 시작(crossfade loop). 발화/청취에 따라 음량이 덕킹된다.
    } else {
      // idle (admin 세션 나가기) — 앰비언트, 유령 숨김.
      demoPhase = null
      rotate = null
      stopFilmstrip()
      ghost.hide()
      ghostVoice?.stop()
      bgMusic.stop()
      teardownVideo()
      tweenTo(videoMix, 0, dur(0.6))
      tweenTo(blur, 0, dur(0.4))
      tweenTo(threadSpeedMul, 1, dur(1.5))
    }
  }
  window.zoetrope.onReelDemo?.((payload) => applyDemo(payload, false))

  // [debug] 콘솔 진단용 — window.__cdbState()로 데모/필름스트립 상태를 본다(전시 동작 무관).
  window.__cdbState = () => ({
    demoPhase,
    appState,
    calibrationMode,
    montage: !!montageMaterial,
    mapping: montageMaterial?.uniforms.uMapping.value,
    rotate: !!rotate,
    filmstrip: filmstrip
      ? {
          ready: !!filmstrip.texture,
          stripScale: filmstrip.stripScale,
          stripTurns: filmstrip.stripTurns,
          doneSent: filmstrip.doneSent
        }
      : null
  })

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
    onSpeaking: (on) => {
      ghost.setGlow?.(on ? 1 : 0)
      bgMusic.setAgentSpeaking(on) // 유령 발화 중 배경음악 level 3.
    },
    onListening: (on) => bgMusic.setUserListening(on), // 사용자 청취 중 배경음악 level 5.
    getPan: () => ghost.getPan?.() ?? 0, // 유령 위치 따라 목소리를 좌우로(입체감).
    // 대화 tool이 영상을 원본 속도로 loop 재생(첫 바퀴 뒤 resolve). 과거 회귀는 fadeIn 옵션으로 떠오른다.
    playVideo: (url, opts) => playConversationVideo(url, opts),
    clearVideo: (opts) => clearConversationVideo(opts), // 2장(미래) 전환 발화 때 유령 idle로 복귀
    // 2장(미래) 진입: ⓪ 실타래 감아올리기(10배속) → ① 90세 장례식 → 암전 → ② 미래 릴 1사이클
    // → (그 뒤 유령의 전환 발화)
    playFutureSpinup: (opts) => playFutureSpinupIntro(opts),
    playFutureFuneral: (url, opts) => playFutureFuneralIntro(url, opts),
    playFutureReel: (payload) => playFutureReelIntro(payload)
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
      : convoVideoActive
        ? !!montageMaterial
        : demoPhase === 'reel' || demoPhase === 'funeral'
          ? !!montageMaterial
          : demoPhase === 'spinup'
            ? false
            : ghostIdleDark && appState === 'ZOETROPE'
              ? false // 주마등(탄생) 직후 유령 idle — 현재 사진 몽타주 대신 실타래 앰비언트
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
      } else if (filmstrip) {
        // 필름스트립: 스트립 텍스처를 연속 스크롤. 위상은 벽시계 기준(startMs), Q/W 배수 반영.
        u.uBlur.value = 0
        u.uVideoMix.value = 0
        u.uTime.value = nowMs / 1000 // 필름 질감(그레인·플리커·위브) 시계
        const effSecPerTurn = filmstrip.secPerTurn / rotateSpeedMul
        const turns = (nowMs - filmstrip.startMs) / 1000 / effSecPerTurn
        // 1차 주마등 끝 연출(holdLastSec): 마지막 장(탄생)의 중심이 정면(방위 0, vUv.x=0)에 오는
        // 위상에서 스크롤을 멈추고, holdLastSec초 뒤 blank. 시계(turns)는 계속 흘러 reel-done
        // 타이밍(스트립 1사이클)은 그대로다 — blank인 채 릴이 마저 돈다.
        //  셰이더의 스트립 x = fract((u + cal.yaw + phase) / stripTurns) 이므로,
        //  정면(u=0)에 lastCenterFrac이 오는 위상 = lastCenterFrac·stripTurns − cal.yaw (mod stripTurns).
        let shownTurns = turns
        if (filmstrip.holdLastSec > 0 && filmstrip.lastCenterFrac != null && filmstrip.stripTurns > 0) {
          const st = filmstrip.stripTurns
          const birthTurns = (((filmstrip.lastCenterFrac * st - cal.yaw) % st) + st) % st
          if (turns >= birthTurns) {
            shownTurns = birthTurns // 탄생 이미지 정면 중앙 정지
            if (!filmstrip.blanked && turns >= birthTurns + filmstrip.holdLastSec / effSecPerTurn) {
              filmstrip.blanked = true
              setMontageImage(montageMaterial, null) // 이후엔 검정 — 서버 전환까지 아무 이미지도 안 보인다
            }
          }
        }
        // uYaw는 스트립 주기(stripTurns 바퀴)로 wrap — 장시간 구동 시 float 정밀도 저하 방지.
        const phaseTurns = filmstrip.stripTurns > 0 ? shownTurns % filmstrip.stripTurns : shownTurns
        u.uYaw.value = cal.yaw + phaseTurns
        // 완료: 스트립 1사이클(모든 사진이 한 번씩 지나감) — 이후에도 서버 전환까지 계속 돈다.
        if (!filmstrip.doneSent && filmstrip.texture && turns >= filmstrip.stripTurns) {
          filmstrip.doneSent = true
          // onDone이 있으면 이 스트립은 서버 국면이 아니라 대화 흐름이 주인이다(2차 미래 릴) —
          // 서버에 reel-done을 보내면 엉뚱한 국면 전환이 일어나므로 로컬 콜백만 부른다.
          if (filmstrip.onDone) filmstrip.onDone()
          else window.zoetrope.sendReelDone?.()
        }
        // 도는 동안 ~3s마다 heartbeat → 서버 안전 폴백(deadman) 리셋(Q로 느려도 안 끊김).
        // 텍스처가 준비된 뒤에만 — 사진 로드가 전부 실패하면 heartbeat를 멈춰 deadman이 유령으로 넘긴다.
        // 대화가 주인인 스트립(onDone)은 heartbeat도 보내지 않는다 — 서버는 지금 reel 국면이 아니다.
        if (
          !filmstrip.onDone &&
          !filmstrip.doneSent &&
          filmstrip.texture &&
          nowMs - filmstrip.lastTickMs > 3000
        ) {
          filmstrip.lastTickMs = nowMs
          window.zoetrope.sendReelProgress?.()
        }
        if (window.__reelDebug !== false && nowMs - (filmstrip._logMs || 0) > 1000) {
          filmstrip._logMs = nowMs
          console.log(
            `[debug/frame] filmstrip mul=${rotateSpeedMul.toFixed(2)} effSec=${effSecPerTurn.toFixed(1)}s turns=${turns.toFixed(2)}/${filmstrip.stripTurns.toFixed(2)}`
          )
        }
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
      } else if (demoPhase === 'reel' || demoPhase === 'funeral' || convoVideoActive) {
        // reel 데모/장례식 영상/대화 영상(과거 회귀·미래): videoMix로 영상 표시(fade-in 트윈 포함).
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
  calGuide.style.cssText = 'position:fixed;inset:0;pointer-events:none;display:none;z-index:30;'
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

  // ---- 음량 조절 HUD — A/S(BGM)·Z/X(SFX) 키를 누르면 현재 배율·실효 gain을 잠깐 띄운다 ----
  const volHud = document.createElement('div')
  volHud.style.cssText =
    'position:fixed;left:50%;bottom:48px;transform:translateX(-50%);padding:8px 14px;' +
    'background:rgba(0,0,0,.72);color:rgba(0,255,180,.9);font:13px/1.5 monospace;' +
    'border-radius:6px;pointer-events:none;opacity:0;transition:opacity .25s;z-index:40;white-space:pre;'
  document.body.appendChild(volHud)
  let volHudTimer = null
  function showVolHud(text) {
    volHud.textContent = text
    volHud.style.opacity = '1'
    clearTimeout(volHudTimer)
    volHudTimer = setTimeout(() => {
      volHud.style.opacity = '0'
    }, 1600)
  }
  const VOL_STEP = 1.5 // 키 한 번당 음량 배율(약 3.5dB — 귀로 확실히 구별되는 크기)

  // ---- 입력 (§8) : Electron main의 before-input-event를 페이지 keydown으로 이관 ----
  //  Enter → 멈춤/진입/재개 (server 상태 기계가 상태별 의미 결정)
  //  V     → 뷰 토글(파노라마 ↔ 실린더)
  //  Space → 재생/정지 (개발용)
  //  Q / W → [debug] reel 회전(surround) 속도 느리게 / 빠르게 (실효 secPerTurn 콘솔 출력)
  //  A / S → [debug] 배경음악 음량 다운 / 업 (실효 gain 콘솔 출력)
  //  Z / X → [debug] 효과음(앰비언스) 음량 다운 / 업 (실효 gain 콘솔 출력)
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    // [debug] 모든 키 수신 확인 — W 눌렀는데 이 로그가 없으면 포커스가 페이지가 아님(예: DevTools).
    // 끄기: 콘솔에서 window.__reelDebug = false
    if (window.__reelDebug !== false) console.log('[debug] keydown:', e.key, `(code=${e.code})`)
    const yawStep = e.shiftKey ? 0.02 : 0.004 // 0.004 ≈ 1.4°, shift ≈ 7°
    const pitchStep = e.shiftKey ? 0.02 : 0.004
    // 물리 키 매칭 — e.code(레이아웃 무관) 우선, 한글 IME가 code 없이 자모(e.key='ㅁ' 등)만
    // 줄 때를 대비해 key 값(영문 대소문자 + 두벌식 자모)도 함께 본다.
    const isKey = (code, ...keys) => e.code === code || keys.includes(e.key)
    if (e.key === 'Enter') {
      e.preventDefault()
      window.zoetrope.sendInput?.('stopEnter')
    } else if (isKey('KeyV', 'v', 'V', 'ㅍ')) {
      e.preventDefault()
      window.zoetrope.toggleView?.()
    } else if (isKey('KeyC', 'c', 'C', 'ㅊ')) {
      e.preventDefault()
      toggleCalibrationMode()
    } else if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault()
      window.zoetrope.togglePlay?.()
    } else if (isKey('KeyQ', 'q', 'Q', 'ㅂ', 'ㅃ')) {
      e.preventDefault()
      console.log(
        `[debug] Q(느리게) 눌림 · demoPhase=${demoPhase} · rotate=${rotate ? 'active' : 'null'}`
      )
      nudgeRotateSpeed(1 / 1.25) // [debug] reel 회전 느리게
    } else if (isKey('KeyW', 'w', 'W', 'ㅈ', 'ㅉ')) {
      e.preventDefault()
      console.log(
        `[debug] W(빠르게) 눌림 · demoPhase=${demoPhase} · rotate=${rotate ? 'active' : 'null'}`
      )
      nudgeRotateSpeed(1.25) // [debug] reel 회전 빠르게
    } else if (isKey('KeyA', 'a', 'A', 'ㅁ')) {
      e.preventDefault()
      const r = bgMusic.nudgeVolume(1 / VOL_STEP) // [debug] 배경음악 음량 다운
      showVolHud(
        `BGM ▼ ×${r.trim.toFixed(2)}  gain ${r.gain.toFixed(3)}${r.playing ? '' : '  (정지 중 — 재생되면 적용)'}`
      )
    } else if (isKey('KeyS', 's', 'S', 'ㄴ')) {
      e.preventDefault()
      const r = bgMusic.nudgeVolume(VOL_STEP) // [debug] 배경음악 음량 업
      showVolHud(
        `BGM ▲ ×${r.trim.toFixed(2)}  gain ${r.gain.toFixed(3)}${r.playing ? '' : '  (정지 중 — 재생되면 적용)'}`
      )
    } else if (isKey('KeyZ', 'z', 'Z', 'ㅋ')) {
      e.preventDefault()
      const r = sfx.nudgeVolume(1 / VOL_STEP) // [debug] 효과음 음량 다운
      showVolHud(
        r.playing
          ? `SFX ▼ ×${r.trim.toFixed(2)}  '${r.slug}'  gain ${r.gain.toFixed(3)}`
          : `SFX ▼ ×${r.trim.toFixed(2)}  (재생 중인 효과음 없음)`
      )
    } else if (isKey('KeyX', 'x', 'X', 'ㅌ')) {
      e.preventDefault()
      const r = sfx.nudgeVolume(VOL_STEP) // [debug] 효과음 음량 업
      showVolHud(
        r.playing
          ? `SFX ▲ ×${r.trim.toFixed(2)}  '${r.slug}'  gain ${r.gain.toFixed(3)}`
          : `SFX ▲ ×${r.trim.toFixed(2)}  (재생 중인 효과음 없음)`
      )
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
