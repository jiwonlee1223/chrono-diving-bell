// 생애의 실타래를 실린더 벽에 감아 올리는 웜톤 셰이더 (hybrid).
//
// 평소(앰비언트): 따뜻한 구름 난류 위로, 서로 반대로 감기는 두 겹의 얇은 가닥(ridged)이
// 끝없이 위로 스크롤한다. 촛불 흔들림(flame flicker)과 종이 그레인이 주마등 조명의 결을 낸다.
// 가끔(사건): rise.periodSec 마다 한 번, 아래(탄생)→위(현재)로 밝은 파동이 실 가닥을 따라
// 감겨 오르며 색이 ember→pale 로 흐른다 — "한 생애가 스쳐 지나감". 파동이 지나가면 다시 앰비언트.
//
// 이름표도 서사도 없다. 색·두께·매듭 같은 재료만 흩어놓아 관람자가 스스로 의미를 잡게 둔다
// (CLAUDE.md §1). 수직축=생애 타임라인 읽기(§9)는 이 rise 파동 안에만 잠깐 실려 지나간다.
//
// seamless: 둘레(u)는 uPeriod 정수 주기 노이즈로 u=0/1 이음새가 연속이다. 그래서 이 재료를
// 실린더 안쪽 UV에 그대로 감아도 seam이 보이지 않고, 4대 프로젝터의 가상 카메라가 각자 담당
// 호를 렌더하므로 곡률·후면반전·블렌딩은 기존 파이프라인(projector-camera + post-pass)이 처리한다.

import * as THREE from 'three'

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform float uTime;        // 초 (벽시계를 WRAP로 접은 작은 값 — highp 정밀도 보존)
  uniform float uSpeed;       // 실타래 감김 드리프트 속도
  uniform float uIntensity;   // 전체 밝기
  uniform float uPeriod;      // 둘레 주기 (seamless의 열쇠, 정수)
  uniform float uTurns;       // 주 가닥 감김 바퀴
  uniform float uTurns2;      // 반대로 감기는 촘촘한 가닥 바퀴
  uniform float uReveal;      // 빛 임계 (0..1, 높을수록 검정이 많아짐)
  uniform float uRise;        // 0..1, 사건 파동 head 높이
  uniform float uRiseFade;    // 0..1, 사건 강도 (0이면 순수 앰비언트)
  uniform vec3  uColorLow;    // 아래(탄생) 색 — rise 파동 안에서만 쓰임
  uniform vec3  uColorHigh;   // 위(현재) 색

  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

  // 둘레(x) 방향으로 period 주기의 seamless value noise.
  float pnoise(vec2 p, float period){
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float x0 = mod(i.x, period);
    float x1 = mod(i.x + 1.0, period);
    float a = hash(vec2(x0, i.y));
    float b = hash(vec2(x1, i.y));
    float c = hash(vec2(x0, i.y + 1.0));
    float d = hash(vec2(x1, i.y + 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float fbm(vec2 p, float period){
    float v = 0.0, amp = 0.5, per = period;
    for (int i = 0; i < 5; i++){
      v += amp * pnoise(p, per);
      p *= 2.0; per *= 2.0; amp *= 0.5;
    }
    return v;
  }

  void main(){
    vec2 uv = vUv;
    float t = uTime;
    float P = uPeriod;

    // 느린 흔들림 (구름 속에 있는 듯한)
    float sway = 0.06 * sin(uv.y * 3.0 + t * 0.6)
               + 0.05 * fbm(vec2(uv.y * 2.0, t * 0.2), P);

    // --- 따뜻한 구름 베이스 (난류를 웜톤으로) ---
    vec2 cp = vec2(uv.x * P + sway, uv.y * 2.4 - t * 0.10);
    vec2 q  = vec2(fbm(cp + vec2(0.0, t * 0.15), P),
                   fbm(cp + vec2(4.3, 1.2), P));
    float clouds = fbm(cp + 3.0 * q, P);

    // --- 실타래 1: 위로 감겨 올라가는 가닥 ---
    float twist = uv.y * uTurns;                       // 감김 횟수
    float ang   = uv.x + twist + t * 0.05 * uSpeed;    // 둘레로 서서히 회전
    vec2  tp    = vec2(ang * P, uv.y * 7.0 - t * 0.50 * uSpeed + sway * 2.0);
    float nf    = fbm(tp, P);
    float ridge = pow(clamp(1.0 - abs(2.0 * nf - 1.0), 0.0, 1.0), 3.0);

    // --- 실타래 2: 반대로 감기는 촘촘한 가닥 ---
    float twist2 = uv.y * uTurns2;
    float ang2   = uv.x - twist2 - t * 0.03 * uSpeed;
    vec2  tp2    = vec2(ang2 * P, uv.y * 11.0 - t * 0.32 * uSpeed);
    float nf2    = fbm(tp2, P);
    float ridge2 = pow(clamp(1.0 - abs(2.0 * nf2 - 1.0), 0.0, 1.0), 4.0);

    float threads = clamp(ridge * 0.9 + ridge2 * 0.6, 0.0, 1.0);

    // --- 웜톤을 임계 이상만 남긴다: 대부분을 검게 둬 빛 면적을 줄인다 (uReveal↑ = 검정↑) ---
    // 후면투사에서 넓은 발광이 뭉개져 산만해지는 걸 막고, 어둠 속에 빛 가닥이 떠오르게 한다.
    float lit = smoothstep(uReveal, uReveal + 0.22, clouds);

    float flame = 0.90 + 0.10 * fbm(vec2(t * 3.0, 5.0), P);
    vec3 warm   = vec3(0.55, 0.26, 0.10);
    vec3 warmHi = vec3(1.00, 0.72, 0.38);

    // 어두운 웜톤 앰비언트 (희소한 배경).
    vec3 col = warm * lit;                       // 임계 아래는 순수 검정.
    col = mix(col, warmHi, pow(lit, 2.0) * 0.7); // 밝은 코어만 하이라이트.
    col *= flame;

    // (기하학적 helix 흰 실선은 2026-07-06 제거 — 직선으로 읽혀 산만했다.)

    // 보조 가닥은 은은한 웜 필라멘트로 밀도만 (밝은 구름 코어 안에서만, 산만함 억제).
    col += vec3(1.0, 0.72, 0.42) * ridge2 * 0.22 * lit;

    // --- 사건: 가끔 아래→위로 감겨 오르는 '한 생애' 파동 ---
    // uRiseFade==0 이면 이 블록은 소멸 → 순수 앰비언트. 파동 중에는 head 밴드가 타오르고,
    // head 아래는 '이미 감긴' 여운으로 뻗으며, 색이 아래(ember)→위(pale)로 흐른다 (§9).
    float head   = smoothstep(0.06, 0.0, abs(uv.y - uRise));         // head 밴드
    float below  = smoothstep(uRise - 0.30, uRise, uv.y);            // 아래에서 head로 접근하며 1
    float above  = 1.0 - smoothstep(uRise, uRise + 0.02, uv.y);      // head 위는 아직 안 감김
    float trail  = below * above;                                    // head 아래 여운
    float rise   = (head * 1.4 + trail * 0.35) * threads;            // 실 가닥을 따라서만 밝아짐
    vec3 riseCol = mix(uColorLow, uColorHigh, clamp(uv.y, 0.0, 1.0));
    col += riseCol * rise * uRiseFade;

    // 세로 감쇠 (바닥·천장은 어둡게 — CLAUDE.md §2 세로 프레이밍)
    float vig = smoothstep(0.0, 0.10, uv.y) * smoothstep(1.0, 0.90, uv.y);
    col *= mix(0.18, 1.0, vig);

    // 종이 질감 (seamless)
    float gf = P * 50.0;
    float grain = pnoise(vec2(uv.x * gf, uv.y * 150.0), gf);
    col *= 0.95 + 0.05 * grain;

    col *= uIntensity;
    gl_FragColor = vec4(col, 1.0);
  }
`

export function createThreadMaterial(install) {
  const th = install?.thread ?? {}
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSpeed: { value: th.speed ?? 1.0 },
      uIntensity: { value: 1.0 },
      uPeriod: { value: th.period ?? 6 }, // 정수여야 둘레 이음새가 연속.
      uTurns: { value: th.turns ?? 2.5 },
      uTurns2: { value: th.turns2 ?? 4.0 },
      uReveal: { value: th.reveal ?? 0.55 },
      uRise: { value: 1.0 },
      uRiseFade: { value: 0.0 },
      uColorLow: { value: new THREE.Color(0.95, 0.45, 0.15) }, // ember (탄생)
      uColorHigh: { value: new THREE.Color(0.7, 0.85, 1.0) } //   pale twilight (현재)
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.FrontSide,
    depthWrite: true
  })
}

// 셰이더에 넘기는 시간을 벽시계에서 이 주기로 접는다. 벽시계 초(~1.75e9)를 highp float에
// 그대로 넣으면 소수부가 뭉개져 in-shader 애니메이션이 멈춘다. WRAP로 접으면 값이 작아져
// 정밀도가 보존되고, 4창이 같은 벽시계에서 같은 값을 계산하므로 별도 동기화 없이 일치한다.
// (WRAP 경계에서 미세한 히칭이 있으나 앰비언트 헤이즈에서는 감지되지 않는다.)
const TIME_WRAP = 1000

// 사건 스케줄은 CPU(double)에서 계산해 정밀도 손실이 없다. 모든 창이 같은 벽시계로 계산 → 일치.
function easeOut(x) {
  return 1 - Math.pow(1 - x, 2)
}

export function updateThread(material, nowSec, install) {
  const u = material.uniforms
  u.uTime.value = nowSec % TIME_WRAP

  // rise 사건: periodSec 마다 한 번, travelSec 동안 head가 바닥→꼭대기로 통과.
  const rise = install?.rise ?? {}
  const period = rise.periodSec ?? 48
  const travel = rise.travelSec ?? 16
  const t = ((nowSec % period) + period) % period

  if (t < travel) {
    const x = t / travel
    u.uRise.value = easeOut(x) // head 바닥→꼭대기
    const fadeIn = Math.min(1, t / 2) //  진입 2초 페이드 인
    const fadeOut = Math.min(1, (travel - t) / 3) // 종료 3초 페이드 아웃
    u.uRiseFade.value = fadeIn * fadeOut
  } else {
    u.uRise.value = 1.0
    u.uRiseFade.value = 0.0 // 앰비언트 (사건 없음)
  }
}
