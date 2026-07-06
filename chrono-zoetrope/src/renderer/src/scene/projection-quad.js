// 프로젝터 슬라이스 렌더 (미디어 아트 프리뷰 경로).
//
// 각 프로젝터는 파노라마(경도 0..1 × 높이 0..1)의 자기 90° 경도 슬라이스를 화면에 채운다.
// 네 창을 방위 순서로 이으면 360° 나선이 이음매 없이 감긴다.
//
// 여기서 '생애의 실'(helix) 자체를 절차적으로 그린다 — 실린더 벽을 감고 오르는 하나의
// 빛의 실. 이름표도 서사도 없다. 색·두께·매듭만 흩어놓아 관람자가 의미를 잡게 둔다(§1).
//
// 실린더 곡률 사전왜곡(§4.1 프로젝터-카메라 모델)은 실제 프로젝터 설치 단계에서
// 이 슬라이스 위에 얹는다. 지금은 평면 슬라이스로 연출을 확정한다.

import * as THREE from 'three'

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform float uTime;
  uniform float uTurns;
  uniform float uProgress;
  uniform float uFade;
  uniform float uRotation;
  uniform float uThickness;
  uniform vec3  uColorLow;
  uniform vec3  uColorHigh;

  uniform float uUStart;      // 이 프로젝터 슬라이스 시작 경도 (0..1)
  uniform float uUSpan;       // 슬라이스 폭 (0..1, 오버랩 포함)
  uniform float uFlipX;       // 1 = 후면투사 반전
  uniform float uBlendLeft;   // 좌 엣지 페더 (화면폭 대비)
  uniform float uBlendRight;  // 우 엣지 페더

  float hash(float n){ return fract(sin(n) * 43758.5453123); }
  float vnoise(float x){
    float i = floor(x); float f = fract(x);
    return mix(hash(i), hash(i + 1.0), smoothstep(0.0, 1.0, f));
  }

  float strand(float u, float v, float offset, float thick){
    float wobble = (vnoise(v * 7.0 + uTime * 0.06) - 0.5) * 0.06;
    float center = fract(v * uTurns + uRotation + offset + wobble);
    float du = u - center;
    du = du - floor(du + 0.5);             // 원형 wrap → [-0.5, 0.5]
    float dist = abs(du);
    float core = smoothstep(thick, thick * 0.3, dist);
    float glow = smoothstep(thick * 7.0, 0.0, dist) * 0.30;
    return core + glow;
  }

  void main(){
    // 화면 x(0..1) → 경도 u. 후면투사 반전을 여기서 반영.
    float sx = mix(vUv.x, 1.0 - vUv.x, uFlipX);
    float u = fract(uUStart + sx * uUSpan);
    float v = vUv.y;

    float lifeShape = 0.35 + 0.65 * sin(3.14159265 * clamp(v, 0.0, 1.0));
    float thick = uThickness * lifeShape;

    float mainStrand = strand(u, v, 0.0, thick);
    float echo = strand(u, v, 0.015, thick * 0.6) * 0.35;
    float line = mainStrand + echo;

    float grown = 1.0 - smoothstep(uProgress - 0.02, uProgress + 0.02, v);
    float head = smoothstep(0.035, 0.0, abs(v - uProgress)) * mainStrand * 1.6;
    float intensity = line * grown + head;

    vec3 col = mix(uColorLow, uColorHigh, clamp(v, 0.0, 1.0));
    float knot = smoothstep(0.92, 1.0, vnoise(v * 44.0)) * mainStrand;
    col += knot * 0.7;

    float aL = uBlendLeft  > 0.0 ? smoothstep(0.0, uBlendLeft,  vUv.x)       : 1.0;
    float aR = uBlendRight > 0.0 ? smoothstep(0.0, uBlendRight, 1.0 - vUv.x) : 1.0;

    gl_FragColor = vec4(col * intensity * uFade * aL * aR, 1.0);
  }
`

// 하나의 생애가 감겨 오르고, 잠시 머문 뒤, 스러지고 다시 시작하는 루프.
const RISE = 30
const HOLD = 4
const FADE = 8
const CYCLE = RISE + HOLD + FADE
const ROT_SPEED = 0.008

export class ProjectionQuad {
  constructor(projector, install) {
    const turns = install?.thread?.turns ?? 9
    const thickness = install?.thread?.thickness ?? 0.011
    const overlapU = (install?.blend?.overlapDeg ?? 10) / 360 // 슬라이스 양쪽 오버랩(경도)
    const centerU = ((projector.azimuthDeg % 360) + 360) % 360 / 360

    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uTurns: { value: turns },
        uProgress: { value: 0 },
        uFade: { value: 1 },
        uRotation: { value: 0 },
        uThickness: { value: thickness },
        uColorLow: { value: new THREE.Color(0.95, 0.45, 0.15) }, // ember (탄생)
        uColorHigh: { value: new THREE.Color(0.7, 0.85, 1.0) }, //  pale twilight (현재)
        uUStart: { value: centerU - 0.125 - overlapU },
        uUSpan: { value: 0.25 + 2 * overlapU },
        uFlipX: { value: install?.backProjection ? 1 : 0 },
        uBlendLeft: { value: projector?.blendFraction?.left ?? 0 },
        uBlendRight: { value: projector?.blendFraction?.right ?? 0 }
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false
    })
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material)
    quad.frustumCulled = false
    this.scene.add(quad)
  }

  update(nowSec) {
    const u = this.material.uniforms
    const t = nowSec % CYCLE
    let progress, fade
    if (t < RISE) {
      const x = t / RISE
      progress = 1 - Math.pow(1 - x, 2) // ease-out 상승
      fade = Math.min(1, t / 1.5)
    } else if (t < RISE + HOLD) {
      progress = 1
      fade = 1
    } else {
      progress = 1
      fade = 1 - (t - RISE - HOLD) / FADE
    }
    u.uTime.value = nowSec
    u.uProgress.value = progress
    u.uFade.value = fade
    u.uRotation.value = nowSec * ROT_SPEED
  }

  setVerticalShift() {
    // 리프트 horizon-lock 훅(§9 미결). 슬라이스 경로에선 아직 no-op.
  }

  render(renderer) {
    renderer.setRenderTarget(null)
    renderer.render(this.scene, this.camera)
  }
}
