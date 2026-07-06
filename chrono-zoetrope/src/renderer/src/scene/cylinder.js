// 실린더 재투영 메시 (CLAUDE.md §4.1).
//
// 실제 치수(반경 0.70m, 높이 1.40m)의 열린 실린더. 파노라마를 벽면에 원통 UV로 감는다.
// CylinderGeometry 기본 UV는 u가 둘레를 0→1로 감고(u=0 이 +Z), v가 아래→위 0→1.
// 경도(파노라마 x) ↔ 방위각(둘레) 1:1 선형이라 수평 왜곡이 구조적으로 없다.
//
// 프로젝터 가상 카메라는 실린더 바깥에서 담당 호를 바라본다. 기본 외향 노멀의
// FrontSide 면이 바깥 카메라에 보이므로 그대로 사용한다. 안쪽 면 기준의 거울상은
// 후면투사 반전(§4.2, post-pass의 UV.x 반전)이 출력 단에서 교정한다.

import * as THREE from 'three'

export function createCylinder(install, opts = {}) {
  const { radius, height, radialSegments } = install.cylinder
  const geometry = new THREE.CylinderGeometry(
    radius,
    radius,
    height,
    radialSegments,
    1,
    true // openEnded: 위/아래 뚜껑 없음.
  )
  const material =
    opts.material ||
    new THREE.MeshBasicMaterial({
      side: THREE.FrontSide,
      toneMapped: false
    })
  const mesh = new THREE.Mesh(geometry, material)
  // 방위 등록(registration) 미세 조정 훅. 기본 0. 프로젝터 중심을 seam에서 떼려면 조정.
  mesh.rotation.y = THREE.MathUtils.degToRad(opts.yawDeg ?? 0)
  mesh.name = 'cylinder'
  return mesh
}

export function setPanorama(mesh, texture) {
  const prev = mesh.material.map
  mesh.material.map = texture
  mesh.material.needsUpdate = true
  if (prev && prev !== texture) prev.dispose()
}
