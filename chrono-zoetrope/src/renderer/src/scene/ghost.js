// 유령 에이전트 — 4타일 스트립을 배회하는 앰비언트 발광체.
//
// 요구(대화): 유성별(별똥별) 디자인 — 안에 밝은 심지(core)가 든 하얀 구름 뭉치가 머리,
// 그 뒤로 빛 꼬리가 흐른다. 선명한 외곽선 없이 "구름에 가려진 빛"의 결은 유지(§1).
// 앱 실행 후 4개 화면을 돌아다닌다.
//
// 구현: WebGL 렌더 경로(preview/installation)와 무관하게 항상 보이도록 DOM/SVG 오버레이로 띄운다.
//  - 머리: 뭉게구름 실루엣(원 클러스터) + 난류 변위·블러로 가장자리가 구름결로 흩어진다.
//  - 심지: 구름 중심의 작고 밝은 핵. 말할 때 glow 부스트로 이 심지가 도드라진다.
//  - 꼬리: 머리 왼쪽으로 흐르는 테이퍼 광류 2가닥(linearGradient로 소멸). 진행 방향에 따라
//    facing 플립이 꼬리를 항상 진행 반대쪽으로 흘린다.
//  - 배회: getStrip()이 준 4타일 영역 안에서 x를 느리게 좌우 왕복(전 타일 순회) + 세로 bob + 호흡.
//    자막·해설은 붙이지 않는다(§1).
//
// 시선(가시성 요구): 첫 실행의 선택 화면(어두운 베일) 위에서도 보이도록 z-index를 베일 위에 둔다.
// pointer-events:none 이라 카드 클릭을 막지 않는다.

const SVG_NS = 'http://www.w3.org/2000/svg'

// viewBox 340×180. 머리(구름 뭉치) 중심 ≈ (252, 96), 꼬리는 x=0 방향(왼쪽)으로 흐른다.
// facing=+1(오른쪽 이동)일 때 scale(+1)이라 꼬리가 왼쪽 = 진행 반대. 변위·블러가 외곽을
// 구름처럼 먹으므로 형태는 근사면 충분하다.

// 오버레이 마크업. 필터/그라디언트는 defs에.
// zg-cloud: 난류 변위로 가장자리를 구름결로 흩고 살짝 블러 → "구름에 가려진" 외곽.
// zg-soft : 넓은 헤일로·심지 번짐용 강한 블러.
// zg-tail : 꼬리 전용 — 결이 길게 늘어지도록 가로로 성긴 난류 + 블러.
function ghostSVG() {
  return `
<svg viewBox="0 0 340 180" xmlns="${SVG_NS}" style="width:100%;height:100%;overflow:visible">
  <defs>
    <radialGradient id="zg-core" cx="50%" cy="50%" r="60%">
      <stop offset="0%"  stop-color="#fffdf7" stop-opacity="0.95"/>
      <stop offset="34%" stop-color="#fff6ea" stop-opacity="0.62"/>
      <stop offset="70%" stop-color="#ffe9cf" stop-opacity="0.20"/>
      <stop offset="100%" stop-color="#ffe9cf" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="zg-wick" cx="50%" cy="50%" r="50%">
      <stop offset="0%"  stop-color="#ffffff" stop-opacity="1"/>
      <stop offset="45%" stop-color="#fffaf0" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="#fff3e0" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="zg-halo" cx="50%" cy="50%" r="58%">
      <stop offset="0%"  stop-color="#fff3e0" stop-opacity="0.50"/>
      <stop offset="55%" stop-color="#fff3e0" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#fff3e0" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="zg-trail" x1="1" y1="0" x2="0" y2="0">
      <stop offset="0%"  stop-color="#fff6ea" stop-opacity="0.55"/>
      <stop offset="45%" stop-color="#ffe9cf" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#ffe9cf" stop-opacity="0"/>
    </linearGradient>
    <filter id="zg-cloud" x="-70%" y="-70%" width="240%" height="240%">
      <feTurbulence type="fractalNoise" baseFrequency="0.013 0.019" numOctaves="2" seed="7" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="20"
        xChannelSelector="R" yChannelSelector="G" result="d"/>
      <feGaussianBlur in="d" stdDeviation="4"/>
    </filter>
    <filter id="zg-soft" x="-90%" y="-90%" width="280%" height="280%">
      <feGaussianBlur stdDeviation="13"/>
    </filter>
    <filter id="zg-tail" x="-40%" y="-120%" width="180%" height="340%">
      <feTurbulence type="fractalNoise" baseFrequency="0.006 0.03" numOctaves="2" seed="11" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="26"
        xChannelSelector="R" yChannelSelector="G" result="d"/>
      <feGaussianBlur in="d" stdDeviation="6"/>
    </filter>
  </defs>

  <!-- 머리를 감싸는 넓은 헤일로: 형태 없는 빛무리 -->
  <ellipse cx="252" cy="96" rx="90" ry="82" fill="url(#zg-halo)" filter="url(#zg-soft)"/>

  <!-- 꼬리: 머리에서 왼쪽으로 테이퍼되며 소멸하는 광류 2가닥 -->
  <g filter="url(#zg-tail)">
    <path d="M 252,78 C 190,70 110,78 18,90 C 110,92 190,100 252,108 Z" fill="url(#zg-trail)"/>
    <path d="M 250,96 C 200,100 150,106 92,116 C 152,114 202,112 250,116 Z"
      fill="url(#zg-trail)" opacity="0.7"/>
  </g>

  <!-- 머리: 하얀 뭉게구름(원 클러스터) — 외곽이 난류에 먹혀 구름결이 된다 -->
  <g filter="url(#zg-cloud)">
    <circle cx="252" cy="82"  r="34" fill="url(#zg-core)"/>
    <circle cx="224" cy="100" r="26" fill="url(#zg-core)"/>
    <circle cx="280" cy="102" r="27" fill="url(#zg-core)"/>
    <circle cx="252" cy="112" r="28" fill="url(#zg-core)"/>
  </g>

  <!-- 심지: 구름 안의 밝은 핵. '구름 뒤의 빛'이자 말할 때 밝아지는 중심 -->
  <ellipse cx="252" cy="96" rx="30" ry="30" fill="url(#zg-core)" filter="url(#zg-soft)"/>
  <circle cx="252" cy="96" r="15" fill="url(#zg-wick)" filter="url(#zg-soft)"/>
</svg>`
}

// getStrip(): 현재 4타일 스트립 영역 {x,y,w,h}(CSS px). 리사이즈에 따라 매 프레임 갱신된다.
export function createGhost({ getStrip, zIndex = 31 } = {}) {
  const layer = document.createElement('div')
  Object.assign(layer.style, {
    position: 'fixed',
    inset: '0',
    pointerEvents: 'none',
    zIndex: String(zIndex),
    overflow: 'hidden'
  })

  const el = document.createElement('div')
  const GW = 340
  const GH = (GW * 180) / 340 // 유성별 viewBox 비율 유지(꼬리 포함 가로로 긴 비율)
  Object.assign(el.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    width: `${GW}px`,
    height: `${GH}px`,
    transformOrigin: 'center center',
    willChange: 'transform, opacity',
    opacity: '0'
  })
  el.innerHTML = ghostSVG()
  layer.appendChild(el)
  document.body.appendChild(layer)

  let facing = 1 // +1: 오른쪽 향함, -1: 왼쪽. 이동 방향으로 부드럽게 수렴.
  let prevCx = null
  let raf = 0
  // 정지(경청) — 사용자의 말을 듣는 동안 배회·바운스가 멈춘다(귀 기울이는 몸짓).
  // 모든 움직임이 시간 t의 함수이므로, t 자체의 흐름 속도를 0으로 램프해 그 자리에서
  // 부드럽게 멎게 한다(위치 점프 없음). 해제되면 같은 자리에서 다시 흘러간다.
  let motionT = 0 //     움직임 전용 시계(초) — freeze 동안 흐름이 멎는다.
  let prevNow = null
  let speed = 1 //       시계 배속 0(정지)~1(평소). 매 프레임 speedTarget으로 수렴.
  let speedTarget = 1
  let pan = 0 // 유령의 좌우 위치 -1(왼쪽)~+1(오른쪽) — 목소리 스테레오 패닝에 쓴다(매 프레임 갱신).

  // 가시성 램프 — 기본 숨김. show()/hide()로 ~2.5s 부드럽게 나타나고 사라진다.
  // (유령은 주마등이 끝난 뒤의 idle에서만 등장 = 1인칭 진입 가능 신호. spinup·reel 중엔 숨긴다.)
  const VIS_RAMP_SEC = 2.5
  let vis = 0
  let visTarget = 0
  let visFrom = 0
  let visStart = performance.now()
  // 발광 부스트 — 유령이 '말할 때' 살짝 밝아진다(음성 speaking 상태를 시각으로). 0..1, 매 프레임 부드럽게 수렴.
  let glow = 0
  let glowTarget = 0
  function setVis(on) {
    const target = on ? 1 : 0
    if (target === visTarget) return
    visTarget = target
    visFrom = vis
    visStart = performance.now()
  }

  function fallbackStrip() {
    // getStrip 미제공/미준비 시: 창 중앙의 4:1 스트립으로 근사.
    const w = window.innerWidth
    const h = window.innerHeight
    const sw = Math.min(w, h * 4)
    const sh = sw / 4
    return { x: (w - sw) / 2, y: (h - sh) / 2, w: sw, h: sh }
  }

  function tick(now) {
    if (prevNow === null) prevNow = now
    const dt = Math.min(0.1, (now - prevNow) / 1000) // 탭 복귀 등 큰 프레임 갭은 잘라낸다
    prevNow = now
    speed += (speedTarget - speed) * 0.06 // 정지/재개 모두 부드럽게
    motionT += dt * speed
    const t = motionT
    const strip = (getStrip && getStrip()) || fallbackStrip()
    if (!strip.w || !strip.h) {
      raf = requestAnimationFrame(tick)
      return
    }

    // 가로 배회: 느린 좌우 왕복(전 타일 순회) + 유기적 흔들림. u ∈ [0,1].
    let u = 0.5 + 0.42 * Math.sin(t * 0.16) + 0.1 * Math.sin(t * 0.37 + 1.3)
    u = Math.max(0, Math.min(1, u))
    // 세로: 스트립 중앙 근처를 완만히 오르내림 + 통통 튀는 hop(귀여운 바운스). v ∈ [0,1].
    const hop = Math.sin(t * 1.5) // 젤리 바운스 위상
    let v = 0.5 + 0.24 * Math.sin(t * 0.23 + 0.7) + 0.08 * Math.sin(t * 0.53) - 0.035 * hop
    v = Math.max(0.08, Math.min(0.92, v))

    const cx = strip.x + u * strip.w // 유령 중심(px). 가장자리 밖으로 살짝 넘겨(overhang) 화면을 넘나든다.
    const cy = strip.y + v * strip.h
    pan = (u - 0.5) * 2 // 스트립 좌우 위치를 -1~+1로. 목소리를 이 위치에서 들리게 한다(입체감).

    // 진행 방향으로 facing 수렴 → 이동할 때 몸을 그쪽으로 튼다.
    if (prevCx !== null) {
      const dx = cx - prevCx
      if (Math.abs(dx) > 0.05) {
        const target = dx < 0 ? -1 : 1
        facing += (target - facing) * 0.06
      }
    }
    prevCx = cx

    // 젤리 스쿼시&스트레치: hop과 반대 위상으로 가로/세로를 눌렀다 늘렸다(통통 튀는 느낌).
    const breathe = 1 + 0.04 * Math.sin(t * 0.6) // 느린 크기 호흡
    const sx = breathe * (1 + 0.07 * hop) // 내려갈 때 가로로 눌리고
    const sy = breathe * (1 - 0.07 * hop) //          세로로 납작해진다
    const sway = 4 * Math.sin(t * 0.45) + 2 * facing // 좌우 흔들림 + 진행 방향으로 살짝 기울임
    // 가시성 램프(smoothstep) — show/hide 시 부드럽게 나타나고/사라진다.
    const vp = Math.min(1, (now - visStart) / (VIS_RAMP_SEC * 1000))
    vis = visFrom + (visTarget - visFrom) * (vp * vp * (3 - 2 * vp))
    glow += (glowTarget - glow) * 0.08 // 말하기 상태로 부드럽게 수렴
    const alpha = vis * (0.66 + 0.14 * Math.sin(t * 0.45)) * (1 + 0.4 * glow) // 밝기 호흡 + 말할 때 부스트

    const x = cx - GW / 2
    const y = cy - GH / 2
    el.style.transform =
      `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) ` +
      `rotate(${sway.toFixed(2)}deg) ` +
      `scale(${(facing * sx).toFixed(3)}, ${sy.toFixed(3)})`
    el.style.opacity = alpha.toFixed(3)

    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return {
    el: layer,
    show: () => setVis(true), //  주마등 종료 후 idle 진입 시 호출.
    hide: () => setVis(false), // spinup·reel·세션 나가기 시 호출.
    setGlow: (level) => {
      glowTarget = Math.max(0, Math.min(1, level || 0))
    }, // 음성 speaking 상태 → 발광 부스트(유령이 말하는 걸 시각으로).
    setFrozen: (on) => {
      speedTarget = on ? 0 : 1
    }, // 사용자 발화 청취 중 true → 그 자리에서 부드럽게 멎는다(귀 기울이는 몸짓).
    getPan: () => pan, // 유령의 현재 좌우 위치 -1~+1 — 목소리(TTS) 스테레오 패닝용.
    dispose() {
      cancelAnimationFrame(raf)
      layer.remove()
    }
  }
}
