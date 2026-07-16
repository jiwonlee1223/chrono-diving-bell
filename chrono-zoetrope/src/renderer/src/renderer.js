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
  setMontageVideo
} from './scene/montage-material.js'
import { createPanoramaPreview } from './scene/panorama-preview.js'
import { PostPass } from './scene/post-pass.js'

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
  let demoPhase = null
  const threadSpeedMul = makeTween(1) // 실타래 시간 배속(가속 연출).
  let threadClock = 0 //                로컬 적분 실타래 시계(배속 변화에도 위상 점프 없음).
  let lastFrameMs = performance.now()

  let videoEl = null
  let videoTexture = null
  let videoSyncTimer = null
  let videoStartAtMs = 0

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

  // 상태 진입 연출. immediate = 부트스트랩 시 트윈 없이 그 국면으로 점프.
  function applyState(state, meta = {}, immediate = false) {
    appState = state
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

  // ---- reel 데모: reel.mp4 1회 재생(loop 없음) → 끝나면 IDLE 실타래(구름)로 복귀 ----
  function playReelOnce(url) {
    teardownVideo()
    if (!url || !montageMaterial) return // reel 없거나 몽타주 재료 없으면 스킵.
    videoEl = document.createElement('video')
    videoEl.muted = true
    videoEl.loop = false // 1회 재생.
    videoEl.playsInline = true
    videoEl.preload = 'auto'
    videoEl.crossOrigin = 'anonymous' // /media ACAO — WebGL 텍스처 오염 방지.
    videoEl.src = url
    videoEl.addEventListener(
      'canplaythrough',
      () => {
        videoTexture = new THREE.VideoTexture(videoEl)
        videoTexture.colorSpace = THREE.NoColorSpace
        setMontageVideo(montageMaterial, videoTexture)
        // reel 표시로 즉시 스냅. rAF 누적 트윈에 의존하지 않아 견고하다.
        videoMix.v = videoMix.from = videoMix.to = 1
        triggerFlash() // reel이 드러나는 순간 섬광 — 섬광이 컷을 덮는다.
        videoEl.play().catch(() => {})
      },
      { once: true }
    )
    // 끝나면 검정으로 페이드 후 IDLE 실타래(구름)로 복귀. 다음 참가자 대기 상태.
    videoEl.addEventListener(
      'ended',
      () => {
        videoEl?.pause()
        tweenTo(videoMix, 0, 1.2) // reel → 검정 페이드
        tweenTo(threadSpeedMul, 1, 3.0) // 구름 회전 정상 속도로 감속
        setTimeout(() => {
          demoPhase = null // 검정에서 실타래(구름) 앰비언트로 (appState=IDLE 따라감)
          teardownVideo()
        }, 1200)
      },
      { once: true }
    )
    videoEl.load()
  }

  window.zoetrope.onReelDemo?.(({ phase, url, spinupMs } = {}) => {
    if (phase === 'spinup') {
      // 실타래 앰비언트로 되돌려 회전을 가속시킨다(주황 구름이 빨라짐).
      demoPhase = 'spinup'
      teardownVideo()
      tweenTo(videoMix, 0, 0.2)
      tweenTo(blur, 0, 0.2)
      tweenTo(threadSpeedMul, SPINUP_MAX, Math.max(0.5, (spinupMs ?? 3500) / 1000))
    } else if (phase === 'reel') {
      // 가속된 상태에서 reel로 컷 → 1회 재생.
      demoPhase = 'reel'
      playReelOnce(url)
    }
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
    const montageActive =
      demoPhase === 'reel'
        ? !!montageMaterial
        : demoPhase === 'spinup'
          ? false
          : montageMaterial && MONTAGE_STATES.has(appState)
    setSurfaceMaterial(montageActive ? montageMaterial : threadMaterial)

    if (montageActive) {
      if (demoPhase === 'reel') {
        // reel 데모: 영상만(정지 이미지 프레임 갱신 안 함). videoMix가 실타래→reel 크로스페이드.
        montageMaterial.uniforms.uBlur.value = 0
        montageMaterial.uniforms.uVideoMix.value = tweenUpdate(videoMix)
      } else {
        // 몽타주 프레임 선택. FREEZE 후에는 eff가 얼어 있어 같은 식이 멈춘 프레임을 유지한다.
        const n = montage.playlist.length
        const durSec = montage.config.frameDurationMs / 1000
        const frame = ((Math.floor(eff / durSec) % n) + n) % n
        if (frame !== currentFrame && textures[frame]) {
          currentFrame = frame
          setMontageImage(montageMaterial, textures[frame])
        }
        montageMaterial.uniforms.uBlur.value = tweenUpdate(blur)
        montageMaterial.uniforms.uVideoMix.value = tweenUpdate(videoMix)
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

  // ---- 입력 (§8) : Electron main의 before-input-event를 페이지 keydown으로 이관 ----
  //  Enter → 멈춤/진입/재개 (server 상태 기계가 상태별 의미 결정)
  //  V     → 뷰 토글(파노라마 ↔ 실린더)
  //  Space → 재생/정지 (개발용)
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === 'Enter') {
      e.preventDefault()
      window.zoetrope.sendInput?.('stopEnter')
    } else if (e.key === 'v' || e.key === 'V') {
      e.preventDefault()
      window.zoetrope.toggleView?.()
    } else if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault()
      window.zoetrope.togglePlay?.()
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
