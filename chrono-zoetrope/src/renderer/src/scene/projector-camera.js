// 프로젝터 가상 카메라 (CLAUDE.md §4.1).
//
// 담당 프로젝터의 실제 포즈(방위·거리·높이)와 렌즈 스펙에 맞춘 PerspectiveCamera.
// 이 카메라로 실린더를 렌더한 결과가 그 프로젝터가 쏴야 할 사전왜곡 영상이다.
// 곡률 보정·키스톤·오프액시스가 이 한 번의 렌더에 자동으로 들어간다.
//
// 캘리브레이션 = projectors.json 편집으로 이 포즈를 실제 프로젝터에 맞추는 작업.

import * as THREE from 'three'

export function createProjectorCamera(projector, install, aspect) {
  const camera = new THREE.PerspectiveCamera(projector.fov, aspect, 0.01, 100)
  positionProjectorCamera(camera, projector)
  applyLensOffset(camera, projector)
  return camera
}

export function positionProjectorCamera(camera, projector) {
  const az = THREE.MathUtils.degToRad(projector.azimuthDeg)
  const d = projector.distance
  const y = projector.heightOffset ?? 0
  // 방위 0 = +Z (P0), 증가 방향이 +X (P1=90°) — CylinderGeometry u=0 이 +Z 인 것과 일치.
  camera.position.set(Math.sin(az) * d, y, Math.cos(az) * d)
  camera.up.set(0, 1, 0)
  camera.lookAt(0, y, 0) // 실린더 축을 같은 높이로 바라본다.
}

// 렌즈 오프셋 훅. 기본(0,0)은 no-op. 실제 프로젝터의 렌즈 시프트(오프액시스)를
// 반영해야 할 때 setViewOffset로 근사하도록 확장한다. 미결 파라미터를 하드코딩하지 않는다.
export function applyLensOffset(camera, projector) {
  const o = projector.lensOffset || { x: 0, y: 0 }
  if (!o.x && !o.y) {
    camera.clearViewOffset()
    return
  }
  // 확장 지점: 필요 시 camera.setViewOffset(...) 로 렌즈 시프트 근사.
  camera.clearViewOffset()
}

export function updateAspect(camera, aspect) {
  camera.aspect = aspect
  camera.updateProjectionMatrix()
}
