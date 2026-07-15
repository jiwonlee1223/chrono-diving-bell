// 개발용 '펼친 파노라마' 프리뷰 (§4.1 프로젝터 예왜곡 렌더와는 별개의 진단 뷰).
//
// 각 창이 담당 프로젝터의 90° 방위 슬라이스를 평면으로 창에 꽉 채워 그린다. 실 재료(thread
// material)는 둘레(u)가 seamless라, 4창을 방위 순서대로 두면 슬라이스가 1-2-3-4-1 로 연속
// 이어져 하나의 360° 파노라마가 된다 (P0 왼쪽 끝 ≡ P3 오른쪽 끝, 4↔1 wrap).
//
// 주의: 이건 콘텐츠·이음새 연속성을 눈으로 확인하는 개발 도구다. 프로젝터가 실제 곡면에 쏘는
// 예왜곡 영상이 아니다(그건 §4.1 projector-camera 렌더). 후면투사 반전·블렌딩도 걸지 않는다.

import * as THREE from 'three'

// 담당 프로젝터의 방위 중심(azimuthDeg)을 기준으로 ±45°(=±0.125 u) 슬라이스를 만든다.
export function createPanoramaPreview(projector, material) {
  const scene = new THREE.Scene()
  // 2×2 크기의 쿼드가 프러스텀을 정확히 채우도록 맞춘 정사영 카메라.
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
  camera.position.z = 1

  const centerU = ((((projector.azimuthDeg % 360) + 360) % 360) / 360)
  const halfU = 45 / 360 // 90° 담당 호의 절반
  const uStart = centerU - halfU
  const uEnd = centerU + halfU

  const geo = new THREE.PlaneGeometry(2, 2)
  // 기본 UV(0/1)를 담당 방위 슬라이스로 리매핑: 좌→우 = uStart→uEnd, 아래→위 = v 0→1.
  // PlaneGeometry(2,2)의 정점 순서: top-left, top-right, bottom-left, bottom-right.
  const uv = new Float32Array([uStart, 1, uEnd, 1, uStart, 0, uEnd, 0])
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))

  const mesh = new THREE.Mesh(geo, material)
  mesh.frustumCulled = false
  scene.add(mesh)

  // mesh를 노출해 상태에 따른 재료 교체(thread ↔ montage)를 실린더와 함께 받게 한다.
  return { scene, camera, mesh }
}
