// 렌더러 창 부트스트랩 (Phase 1: 단일 프로젝터 뷰).
//
// 1) main에서 부트스트랩 config(담당 프로젝터 + 설치 파라미터)를 받는다.
// 2) 실린더 메시에 절차적 테스트 파노라마를 감고, 담당 프로젝터 카메라로 RT에 렌더한다.
// 3) post-pass로 후면투사 반전을 적용해 화면에 출력한다.
//
// Phase 2에서 창 4개로 늘어나도 이 파일은 그대로. 창마다 projectorIndex 만 다르다.

import * as THREE from 'three'
import { createCylinder } from './scene/cylinder.js'
import { createProjectorCamera, updateAspect } from './scene/projector-camera.js'
import { createThreadMaterial, updateThread } from './scene/thread-material.js'
import { createPanoramaPreview } from './scene/panorama-preview.js'
import { PostPass } from './scene/post-pass.js'

// 테스트 패턴 색을 그린 그대로 통과시킨다(색 관리 이중변환 회피).
THREE.ColorManagement.enabled = false

async function main() {
  const boot = await window.zoetrope.getBootstrap()
  const { projector, install } = boot

  const canvas = document.getElementById('view')
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)

  const threadMaterial = createThreadMaterial(install)
  const cylinder = createCylinder(install, { material: threadMaterial })
  scene.add(cylinder)

  const camera = createProjectorCamera(projector, install, window.innerWidth / window.innerHeight)

  // 개발용 펼친 파노라마 프리뷰(이 창의 90° 슬라이스). 실 재료를 공유해 애니메이션이 일치한다.
  const preview = createPanoramaPreview(projector, threadMaterial)
  let previewMode = true // 기본 뷰 = 펼친 파노라마. 실린더(§4.1 예왜곡) 렌더는 V로만 본다.
  // 뷰 모드는 main이 소유·브로드캐스트한다(키는 main의 before-input-event/전역 단축키가 잡음, §7).
  window.zoetrope.onViewMode?.(({ preview: on } = {}) => {
    previewMode = !!on
  })

  // 재생/정지: main이 소유하는 유효 시간 모델을 받아, 절대 벽시계로 4창이 같은 유효시간을 계산한다.
  // 기본은 재생(offset 0 → 유효시간 = Date.now()/1000, 기존과 동일한 절대 동기).
  const play = { playing: true, offset: 0, frozenEff: 0 }
  window.zoetrope.onPlayState?.((s) => {
    if (!s) return
    play.playing = !!s.playing
    play.offset = s.offset ?? 0
    play.frozenEff = s.frozenEff ?? 0
  })
  const effSeconds = () => (play.playing ? Date.now() / 1000 - play.offset : play.frozenEff)

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

  renderer.setAnimationLoop(() => {
    // 재생/정지가 반영된 유효 시간. 모든 창이 같은 (main 소유) 모델 + 절대 벽시계로 계산 → 4창 일치.
    updateThread(threadMaterial, effSeconds(), install)

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
