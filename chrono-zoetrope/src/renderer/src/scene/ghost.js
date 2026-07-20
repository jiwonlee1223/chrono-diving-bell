// 유령 에이전트 — 4타일 스트립을 배회하는 앰비언트 발광체.
//
// 요구(대화): 눈코입 없는 부끄부끄(Boo) 실루엣(둥근 몸 + 너덜한 밑단 + 작은 팔),
// 단 "구름에 가려진 빛"처럼 아웃라인이 잘 안 보이는 발광체. 앱 실행 후 4개 화면을 돌아다닌다.
//
// 구현: WebGL 렌더 경로(preview/installation)와 무관하게 항상 보이도록 DOM/SVG 오버레이로 띄운다.
//  - 실루엣: 돔형 상단 + 4개 스캘롭 밑단 path, 양옆 작은 팔 nub.
//  - 흐린 빛: 중심 발광 → 가장자리 소멸 radialGradient + feTurbulence 변위(구름결 가장자리) + blur.
//    → 선명한 외곽선이 없다. 밝은 중심만 있고 테두리는 구름에 먹힌다(§1 침묵하는 앰비언트와 결).
//  - 배회: getStrip()이 준 4타일 영역 안에서 x를 느리게 좌우 왕복(전 타일 순회) + 세로 bob + 호흡.
//    이동 방향에 따라 좌우로 뒤집혀(facing) 살아있는 느낌. 자막·해설은 붙이지 않는다(§1).
//
// 시선(가시성 요구): 첫 실행의 선택 화면(어두운 베일) 위에서도 보이도록 z-index를 베일 위에 둔다.
// pointer-events:none 이라 카드 클릭을 막지 않는다.

const SVG_NS = 'http://www.w3.org/2000/svg'

// Boo 실루엣: viewBox 220×210, 중심 x=110. 세로로 길쭉하지 않고 통통·동글동글(귀여움은 비율에서).
// 돔 상단(y≈36) + 얕고 부드러운 밑단 굽이(4굽이, 너무 너덜하지 않게) + 양옆 작은 앞팔 nub.
// 변위·블러가 외곽을 구름처럼 먹으므로 형태는 근사면 충분하다.
const BODY_PATH = [
  'M 30,132',
  'C 30,74 62,36 110,36', // 왼쪽 볼 → 정수리 (넓은 통통 돔)
  'C 158,36 190,74 190,132', // 정수리 → 오른쪽 볼
  'L 190,150',
  'q -20,15 -40,0', // 밑단 굽이 4개(얕게 = 동글동글한 자락)
  'q -20,-15 -40,0',
  'q -20,15 -40,0',
  'q -20,-15 -40,0',
  'L 30,132',
  'Z'
].join(' ')

// 오버레이 마크업. 필터/그라디언트는 defs에, 몸체는 group에.
// zg-cloud: 난류 변위로 가장자리를 구름결로 흩고 살짝 블러 → "구름에 가려진" 외곽.
// zg-soft : 넓은 헤일로용 강한 블러.
function ghostSVG() {
  return `
<svg viewBox="0 0 220 210" xmlns="${SVG_NS}" style="width:100%;height:100%;overflow:visible">
  <defs>
    <radialGradient id="zg-core" cx="50%" cy="42%" r="62%">
      <stop offset="0%"  stop-color="#fffdf7" stop-opacity="0.95"/>
      <stop offset="34%" stop-color="#fff6ea" stop-opacity="0.62"/>
      <stop offset="70%" stop-color="#ffe9cf" stop-opacity="0.20"/>
      <stop offset="100%" stop-color="#ffe9cf" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="zg-halo" cx="50%" cy="46%" r="58%">
      <stop offset="0%"  stop-color="#fff3e0" stop-opacity="0.50"/>
      <stop offset="55%" stop-color="#fff3e0" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#fff3e0" stop-opacity="0"/>
    </radialGradient>
    <filter id="zg-cloud" x="-70%" y="-70%" width="240%" height="240%">
      <feTurbulence type="fractalNoise" baseFrequency="0.013 0.019" numOctaves="2" seed="7" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="20"
        xChannelSelector="R" yChannelSelector="G" result="d"/>
      <feGaussianBlur in="d" stdDeviation="5"/>
    </filter>
    <filter id="zg-soft" x="-90%" y="-90%" width="280%" height="280%">
      <feGaussianBlur stdDeviation="13"/>
    </filter>
  </defs>

  <!-- 넓게 번지는 헤일로: 형태 없는 빛무리 (가로로 넓은 통통한 빛) -->
  <ellipse cx="110" cy="112" rx="104" ry="94" fill="url(#zg-halo)" filter="url(#zg-soft)"/>

  <!-- 작은 앞팔 nub(양옆 아래) + 몸체: 난류 변위로 외곽이 구름에 먹힌다 -->
  <g filter="url(#zg-cloud)">
    <ellipse cx="36"  cy="140" rx="14" ry="16" fill="url(#zg-core)"/>
    <ellipse cx="184" cy="140" rx="14" ry="16" fill="url(#zg-core)"/>
    <path d="${BODY_PATH}" fill="url(#zg-core)"/>
  </g>

  <!-- 밝은 속심: '구름 뒤의 빛' 핵 -->
  <ellipse cx="110" cy="92" rx="38" ry="38" fill="url(#zg-core)" filter="url(#zg-soft)"/>
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
  const GW = 280
  const GH = (GW * 210) / 220 // 실루엣 viewBox 비율 유지(가로로 넓은 통통 비율)
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

  const t0 = performance.now()
  let facing = 1 // +1: 오른쪽 향함, -1: 왼쪽. 이동 방향으로 부드럽게 수렴.
  let prevCx = null
  let raf = 0

  function fallbackStrip() {
    // getStrip 미제공/미준비 시: 창 중앙의 4:1 스트립으로 근사.
    const w = window.innerWidth
    const h = window.innerHeight
    const sw = Math.min(w, h * 4)
    const sh = sw / 4
    return { x: (w - sw) / 2, y: (h - sh) / 2, w: sw, h: sh }
  }

  function tick(now) {
    const t = (now - t0) / 1000
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
    const fadeIn = Math.min(1, t / 3.5) // 실행 직후 3.5초간 서서히 나타난다
    const alpha = fadeIn * (0.42 + 0.12 * Math.sin(t * 0.45)) // 은은한 밝기 호흡

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
    dispose() {
      cancelAnimationFrame(raf)
      layer.remove()
    }
  }
}
