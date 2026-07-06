// 출력 후처리 패스 (CLAUDE.md §4.2, §4.3).
//
// 프로젝터 카메라로 렌더한 결과(RenderTarget)를 풀스크린 쿼드로 화면에 그리며:
//  - 후면투사 반전: UV.x 반전 (막 뒤에서 쏘므로 거울상 교정). 4대 일괄 셰이더 처리.
//  - 엣지 블렌딩: 좌/우 밴드 밝기 페더링. 겹침 구간에서 인접 프로젝터 합이 ~1.
//  - uVerticalShift: 리프트 horizon-lock 훅(§9 미결). 기본 0 = no-op.

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
  uniform sampler2D tDiffuse;
  uniform float uFlipX;         // 1 = 후면투사 반전 on
  uniform float uBlendLeft;     // 좌측 페더 폭 (화면 폭 대비 0..0.5)
  uniform float uBlendRight;    // 우측 페더 폭
  uniform float uVerticalShift; // 리프트 훅. 기본 0.

  void main() {
    vec2 uv = vUv;
    uv.x = mix(uv.x, 1.0 - uv.x, uFlipX);
    uv.y = clamp(uv.y + uVerticalShift, 0.0, 1.0);
    vec3 col = texture2D(tDiffuse, uv).rgb;

    float aL = uBlendLeft  > 0.0 ? smoothstep(0.0, uBlendLeft,  vUv.x)       : 1.0;
    float aR = uBlendRight > 0.0 ? smoothstep(0.0, uBlendRight, 1.0 - vUv.x) : 1.0;
    col *= aL * aR;

    gl_FragColor = vec4(col, 1.0);
  }
`

export class PostPass {
  constructor({ backProjection = true, blendFraction = { left: 0, right: 0 }, verticalShift = 0 } = {}) {
    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uFlipX: { value: backProjection ? 1 : 0 },
        uBlendLeft: { value: blendFraction?.left ?? 0 },
        uBlendRight: { value: blendFraction?.right ?? 0 },
        uVerticalShift: { value: verticalShift }
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

  setBackProjection(on) {
    this.material.uniforms.uFlipX.value = on ? 1 : 0
  }

  setBlend(left, right) {
    this.material.uniforms.uBlendLeft.value = left
    this.material.uniforms.uBlendRight.value = right
  }

  // 리프트 horizon-lock 훅. 신호 경로만 열어둠. 기본 0.
  setVerticalShift(v) {
    this.material.uniforms.uVerticalShift.value = v
  }

  setSize() {
    // 풀스크린 쿼드는 NDC 고정이라 리사이즈 시 갱신 불필요. 시그니처만 유지.
  }

  render(renderer, inputTexture) {
    this.material.uniforms.tDiffuse.value = inputTexture
    renderer.setRenderTarget(null)
    renderer.render(this.scene, this.camera)
  }

  dispose() {
    this.material.dispose()
    this.scene.traverse((o) => o.geometry?.dispose?.())
  }
}
