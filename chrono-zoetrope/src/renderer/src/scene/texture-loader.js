// 파노라마 텍스처 로더.
//
// Phase 1: 자산이 없으므로 절차적(procedural) equirectangular 테스트 파노라마를
// canvas로 생성한다. 방위 눈금·수평선·사분면 색·비대칭 텍스트로 재투영 이음새와
// 후면투사 반전(거울상)을 자산 없이 눈으로 검증한다.
//
// Phase 4: loadPanorama(id)가 ComfyUI /view 출력 또는 캐시 라이브러리 파일을 로드하도록 확장.
// (지금은 인터페이스만 열어둔다.)

import * as THREE from 'three'

// 방위각 → canvas x. az 0 = 좌단(u=0). CylinderGeometry u=0 이 +Z(=P0)라 일치.
function azToX(azDeg, W) {
  return (((azDeg % 360) + 360) % 360) / 360 * W
}

const QUADRANTS = [
  { label: 'FRONT', tint: '#2a1414', centerAz: 0 }, // +Z / P0
  { label: 'RIGHT', tint: '#14220f', centerAz: 90 }, // +X / P1
  { label: 'BACK', tint: '#101a2a', centerAz: 180 }, // -Z / P2
  { label: 'LEFT', tint: '#241f0d', centerAz: 270 } // -X / P3
]

export function createTestPanorama(install) {
  const W = install?.panorama?.testWidth ?? 4096
  const H = install?.panorama?.testHeight ?? 2048
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')

  // 배경: 사분면 색조 (방위 오리엔테이션).
  ctx.fillStyle = '#0a0a0a'
  ctx.fillRect(0, 0, W, H)
  for (const q of QUADRANTS) {
    const x0 = azToX(q.centerAz - 45, W)
    const w = W / 4
    ctx.fillStyle = q.tint
    // 좌단 seam을 넘는 경우 두 조각으로.
    if (x0 + w <= W) {
      ctx.fillRect(x0, 0, w, H)
    } else {
      ctx.fillRect(x0, 0, W - x0, H)
      ctx.fillRect(0, 0, x0 + w - W, H)
    }
  }

  // 위도 격자 (수평선).
  ctx.strokeStyle = 'rgba(120,120,120,0.35)'
  ctx.lineWidth = 2
  for (let lat = 0; lat <= H; lat += H / 12) {
    ctx.beginPath()
    ctx.moveTo(0, lat)
    ctx.lineTo(W, lat)
    ctx.stroke()
  }

  // 수평선 (v=0.5) 강조.
  ctx.strokeStyle = 'rgba(0,220,220,0.9)'
  ctx.lineWidth = 6
  ctx.beginPath()
  ctx.moveTo(0, H / 2)
  ctx.lineTo(W, H / 2)
  ctx.stroke()

  // 방위 눈금: 15° 얇게, 90°(프로젝터 중심) 굵게, 45°(담당 경계) 중간.
  for (let az = 0; az < 360; az += 15) {
    const x = azToX(az, W)
    const isCenter = az % 90 === 0
    const isEdge = az % 90 === 45
    ctx.strokeStyle = isCenter
      ? 'rgba(255,255,255,0.95)'
      : isEdge
        ? 'rgba(255,180,60,0.85)'
        : 'rgba(150,150,150,0.5)'
    ctx.lineWidth = isCenter ? 6 : isEdge ? 4 : 2
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, H)
    ctx.stroke()
  }

  // 방위 라벨 (45°마다). 텍스트 비대칭이 후면투사 반전을 즉시 드러낸다.
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let az = 0; az < 360; az += 45) {
    const x = azToX(az, W)
    const big = az % 90 === 0
    ctx.font = `${big ? 90 : 52}px sans-serif`
    ctx.fillStyle = big ? '#ffffff' : '#ffb84a'
    const text = `${az}°`
    // seam(az 0) 라벨은 양 끝에 그려 클리핑 방지.
    ctx.fillText(text, x, H / 2 - (big ? 150 : 100))
    if (az === 0) ctx.fillText(text, W, H / 2 - 150)
  }

  // 사분면 이름 라벨 (상단).
  ctx.font = '64px sans-serif'
  ctx.fillStyle = '#dddddd'
  for (const q of QUADRANTS) {
    ctx.fillText(q.label, azToX(q.centerAz, W), H * 0.18)
  }

  // 방향 지시 화살표(→): 방위 증가 방향. 반전 시 좌우가 뒤집혀 보인다.
  ctx.font = '80px sans-serif'
  ctx.fillStyle = '#66ff66'
  for (let az = 0; az < 360; az += 90) {
    ctx.fillText('→', azToX(az + 22.5, W), H * 0.72)
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping // 방위 seam 연속.
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.anisotropy = 8
  texture.needsUpdate = true
  return texture
}

// Phase 4 확장 지점. 지금은 테스트 파노라마로 폴백.
export async function loadPanorama(_id, { install } = {}) {
  return createTestPanorama(install)
}
