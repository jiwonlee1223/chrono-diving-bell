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

// 2×2 타일 배치(window-manager.js의 방위 인접성 유지): P0|P1 위, P2|P3 아래.
// GL 뷰포트는 원점이 좌하단(y ↑)이므로 위 행 y=halfH, 아래 행 y=0.
const TILE_GRID = [
  { col: 0, row: 0 }, // P0 top-left
  { col: 1, row: 0 }, // P1 top-right
  { col: 0, row: 1 }, // P2 bottom-left
  { col: 1, row: 1 } // P3 bottom-right
]

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

  // ---- 출력 파이프라인: 타일 사이즈 RT 하나를 4타일이 재사용 ----

  // 뷰포트/시저는 CSS(논리) 픽셀 — three.js가 내부에서 pixelRatio를 곱한다.
  // RT는 물리(드로잉버퍼) 픽셀 — pixelRatio가 이미 반영된 값을 그대로 쓴다.
  const size = new THREE.Vector2() // 드로잉버퍼(물리) 크기
  let tileCssW = 1 // 타일 논리 폭(뷰포트/시저용)
  let tileCssH = 1
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
    tileCssW = Math.max(1, Math.floor(w / 2))
    tileCssH = Math.max(1, Math.floor(h / 2))
    // RT는 물리 타일 크기(업스케일 손실 최소화). 카메라 aspect는 타일 비율(= 창 비율).
    rt.setSize(Math.max(1, Math.floor(size.x / 2)), Math.max(1, Math.floor(size.y / 2)))
    const aspect = tileCssW / tileCssH
    cameras.forEach((cam) => updateAspect(cam, aspect))
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

  // 타일 뷰포트(좌하단 원점, CSS 픽셀). col/row 는 화면 기준(row0=위) → GL y 반전.
  function tileRect(i) {
    const { col, row } = TILE_GRID[i] ?? TILE_GRID[0]
    const x = col * tileCssW
    const y = (1 - row) * tileCssH // row0(위) → 아래쪽 큰 y
    return { x, y, w: tileCssW, h: tileCssH }
  }

  renderer.setAnimationLoop(() => {
    const eff = effSeconds()
    const montageActive = montageMaterial && MONTAGE_STATES.has(appState)
    setSurfaceMaterial(montageActive ? montageMaterial : threadMaterial)

    if (montageActive) {
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
    } else {
      updateThread(threadMaterial, eff, install)
    }

    // 4타일 렌더. 화면 전체를 한 번 검게 클리어한 뒤 타일별로 그린다. (CSS 픽셀 뷰포트)
    renderer.setViewport(0, 0, tileCssW * 2, tileCssH * 2)
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
  })

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
