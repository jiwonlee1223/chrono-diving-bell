// 렌더러 창 부트스트랩.
//
// 1) main에서 부트스트랩 config(담당 프로젝터 + 설치 파라미터 + 몽타주 국면)를 받는다.
// 2) 실린더 메시에 재료를 감고, 담당 프로젝터 카메라로 RT에 렌더한다.
//    - IDLE/ENTRY/EXIT: thread 앰비언트 (기존 UI 유지)
//    - ZOETROPE 이후: 몽타주 재료 (라이브러리 이미지 고속 교체 → 멈춤 블러 → 영상 크로스페이드)
// 3) post-pass로 후면투사 반전을 적용해 화면에 출력한다.
//
// 시간·상태는 전부 main이 소유한다(§7). 이 파일은 유효 시간과 상태를 받아 그리기만 한다.
// 몽타주 프레임 = floor(유효시간 / frameDuration) % N — 4창이 같은 벽시계로 같은 프레임.
// FREEZE 후에는 유효시간 자체가 얼어 있으므로 같은 식이 그대로 멈춘 프레임을 가리킨다.

import * as THREE from 'three'
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

// 선형 트윈 (main 브로드캐스트가 목표를 주면 각 창이 로컬로 보간 — 수 ms 오차 허용 구간).
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
  const boot = await window.zoetrope.getBootstrap()
  const { projector, install, montage } = boot

  const canvas = document.getElementById('view')
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)

  // 재료 둘: thread(앰비언트, 기존 UI)와 montage(주마등). 상태에 따라 실린더·프리뷰가 같이 갈아탄다.
  const threadMaterial = createThreadMaterial(install)
  const montageMaterial = montage ? createMontageMaterial(install, montage.config) : null
  const cylinder = createCylinder(install, { material: threadMaterial })
  scene.add(cylinder)

  const camera = createProjectorCamera(projector, install, window.innerWidth / window.innerHeight)

  // 개발용 펼친 파노라마 프리뷰(이 창의 90° 슬라이스). 재료를 공유해 애니메이션이 일치한다.
  const preview = createPanoramaPreview(projector, threadMaterial)
  let previewMode = true // 기본 뷰 = 펼친 파노라마. 실린더(§4.1 예왜곡) 렌더는 V로만 본다.
  window.zoetrope.onViewMode?.(({ preview: on } = {}) => {
    previewMode = !!on
  })

  // ---- 상태·시간 모델 (main 소유, 여기서는 수신·계산만) ----

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

  // 상태 진입 연출. immediate = 부트스트랩(리로드) 시 트윈 없이 그 국면으로 점프.
  function applyState(state, meta = {}, immediate = false) {
    appState = state
    const dur = (sec) => (immediate ? 0.001 : sec)
    if (state === 'REGEN_WAIT') {
      tweenTo(blur, blurCfg.max, dur(blurCfg.inSec)) // 멈춘 순간이 흐려진다 — 기다림의 의례(§5.2)
    } else if (state === 'IMMERSION') {
      // 영상이 있으면 크로스페이드 인, 없으면(폴백) 정지 이미지가 그대로 또렷해진다.
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
  applyState(appState, {}, true) // 리로드된 창도 현재 국면을 이어받는다.

  // ---- IMMERSION 영상 배리어 (§7): 프리로드 → 준비 보고 → 벽시계 동시 시작 ----

  window.zoetrope.onVideoPrepare?.(({ url } = {}) => {
    teardownVideo()
    videoEl = document.createElement('video')
    videoEl.muted = true
    videoEl.loop = true
    videoEl.playsInline = true
    videoEl.preload = 'auto'
    videoEl.crossOrigin = 'anonymous' // WebGL 텍스처 업로드 오염(taint) 방지 — zoe:가 ACAO를 준다.
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

  // ---- 출력 파이프라인 (기존 유지) ----

  const post = new PostPass({
    backProjection: install.backProjection,
    blendFraction: projector.blendFraction,
    verticalShift: 0
  })

  const size = new THREE.Vector2()
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
    rt.setSize(size.x, size.y)
    updateAspect(camera, w / h)
  }
  window.addEventListener('resize', resize)
  resize()

  let currentFrame = -1
  let surfaceMaterial = threadMaterial
  function setSurfaceMaterial(mat) {
    if (surfaceMaterial === mat) return
    surfaceMaterial = mat
    cylinder.material = mat
    preview.mesh.material = mat
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
      // 재생/정지가 반영된 유효 시간. 4창이 같은 모델 + 절대 벽시계로 계산 → 일치.
      updateThread(threadMaterial, eff, install)
    }

    if (previewMode) {
      // 개발용: 펼친 파노라마 슬라이스를 화면에 직접(예왜곡·반전·블렌딩 없이).
      renderer.setRenderTarget(null)
      renderer.render(preview.scene, preview.camera)
    } else {
      // 설치 렌더: 프로젝터 카메라로 실린더 → 후면투사 반전·블렌딩 post-pass.
      renderer.setRenderTarget(rt)
      renderer.clear()
      renderer.render(scene, camera)
      post.render(renderer, rt.texture)
    }
  })

  // 리프트 신호 경로(§9 미결). 지금은 수신만 하고 horizon-lock 훅에 전달. 기본 no-op.
  window.zoetrope.onLift?.(({ position } = {}) => {
    if (typeof position === 'number') post.setVerticalShift(0) // 의미 미정: 하드코딩 금지.
  })
}

main().catch((err) => {
  // 부트스트랩 실패 시 콘솔에 남긴다(자막·해설을 화면에 붙이지 않는다, §1).
  console.error('[renderer] bootstrap failed:', err)
})
