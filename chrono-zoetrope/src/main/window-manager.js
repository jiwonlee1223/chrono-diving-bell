// 멀티 윈도우 배치 (CLAUDE.md §10.2).
//
// 프로젝터 4대 = 창 4대. 각 창은 자기 projectorIndex 만 렌더한다.
//  - 디스플레이가 4개 이상: 각 창을 담당 디스플레이에 풀스크린.
//  - 그 미만(개발 모니터 1대): 작업영역을 2×2 타일로 나눠 인접 호 이음새를 나란히 확인.
//
// 타일 배치는 방위 인접성을 살린다: 위 행 P0|P1, 아래 행 P2|P3.
// (P0=0°, P1=90°, P2=180°, P3=270° — 가로로 실제 이웃한 프로젝터끼리 맞붙는다.)

import { screen } from 'electron'

export function computeWindowBounds(count) {
  const displays = screen.getAllDisplays()
  const bounds = []

  if (displays.length >= count) {
    for (let i = 0; i < count; i++) {
      const wa = displays[i].workArea
      bounds.push({ x: wa.x, y: wa.y, width: wa.width, height: wa.height, fullscreen: true })
    }
    return bounds
  }

  // 단일(또는 부족) 모니터: primary 작업영역 2×2 타일.
  const wa = screen.getPrimaryDisplay().workArea
  const halfW = Math.floor(wa.width / 2)
  const halfH = Math.floor(wa.height / 2)
  const grid = [
    [0, 0], // P0 top-left
    [1, 0], // P1 top-right
    [0, 1], // P2 bottom-left
    [1, 1] // P3 bottom-right
  ]
  for (let i = 0; i < count; i++) {
    const [col, row] = grid[i] ?? [0, 0]
    bounds.push({
      x: wa.x + col * halfW,
      y: wa.y + row * halfH,
      width: halfW,
      height: halfH,
      fullscreen: false
    })
  }
  return bounds
}
