import { useLayoutEffect, useRef, useState } from "react";
import { COLUMN_COUNT } from "../stageUtils";

const ROW_HEIGHT = 92;
const FALLBACK_VIEWPORT_HEIGHT = 320;

function colToPercent(col) {
  return ((col + 0.5) / COLUMN_COUNT) * 100;
}

// index 0(10대)이 트랙 맨 아래에서부터 몇 px 위에 있는지. total과 무관하게 항상 고정된 값이라
// 미래 단계가 새로 추가되어도 기존 행의 위치가 전혀 흔들리지 않는다.
function rowBottom(index) {
  return index * ROW_HEIGHT;
}

// Catmull-Rom -> Bezier 변환으로 점들을 부드러운 곡선으로 연결한다.
// 시작점/끝점은 한쪽에만 이웃이 있어 탄젠트를 판단하기 애매하므로, 가로 성분을 0으로
// 고정해(수직으로 진입/이탈) 어느 방향으로 휘어도 절대 튀지 않게 한다. 그래서 과거 곡선이
// "현재"에 닿는 부분과, 미래 곡선이 "현재"에서 출발하는 부분이 같은 규칙으로 매끄럽게 이어진다.
function buildSmoothPath(pts) {
  const n = pts.length;
  if (n < 2) return "";

  function tangent(i) {
    if (i === 0) return { x: 0, y: pts[1].y - pts[0].y };
    if (i === n - 1) return { x: 0, y: pts[n - 1].y - pts[n - 2].y };
    return { x: (pts[i + 1].x - pts[i - 1].x) / 2, y: (pts[i + 1].y - pts[i - 1].y) / 2 };
  }

  let d = `M ${pts[0].x},${pts[0].y} `;
  for (let i = 0; i < n - 1; i++) {
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const t1 = tangent(i);
    const t2 = tangent(i + 1);
    const c1x = p1.x + t1.x / 3;
    const c1y = p1.y + t1.y / 3;
    const c2x = p2.x - t2.x / 3;
    const c2y = p2.y - t2.y / 3;
    d += `C ${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y} `;
  }
  return d;
}

// y는 "트랙 바닥에서부터의 거리"를 음수로 표현한다 (SVG viewBox가 0~-trackHeight 범위를 쓰기 때문).
// index 기반이라 total이 바뀌어도 기존 점의 y값은 변하지 않는다.
function seriesOrderedPoints(stages, series) {
  const pts = [];
  stages.forEach((stage, i) => {
    const point = series.points[stage.id];
    if (point) {
      pts.push({
        x: colToPercent(point.x),
        y: -(rowBottom(i) + ROW_HEIGHT / 2),
      });
    }
  });
  return pts;
}

// series: [{ id, points, color, interactive }]
// rootStageId: 여러 series가 공유하는 시작점(예: "현재"). 색상 없이 한 번만 그린다.
// scrollable: true면 포커스를 따라가는 대신 트랙 전체를 직접 스크롤해서 볼 수 있게 한다 (미리보기용).
export default function LifeGraph({
  stages,
  series,
  activeIndex,
  onCellClick,
  onPointClick,
  focusRatio = 0.5,
  rootStageId,
  scrollable = false,
}) {
  const viewportRef = useRef(null);
  const [viewportHeight, setViewportHeight] = useState(FALLBACK_VIEWPORT_HEIGHT);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => setViewportHeight(el.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const total = stages.length;
  const trackHeight = total * ROW_HEIGHT;

  // 활성 단계가 항상 뷰포트의 focusRatio 위치에 오도록 트랙을 이동시킨다.
  // (모달이 열려 점을 가릴 때는 focusRatio를 위쪽으로 당겨서 점이 보이게 한다)
  // 트랙이 바닥 기준으로 고정되어 있으므로 이 값은 activeIndex에만 좌우된다 —
  // 단계가 새로 추가돼도(미래 진입) 기존 행은 흔들리지 않고 포커스만 매끄럽게 이동한다.
  const translateY =
    viewportHeight * (focusRatio - 1) + rowBottom(activeIndex) + ROW_HEIGHT / 2;

  // 스크롤 모드에서는 맨 아래(과거의 시작)부터 보이도록 초기 스크롤 위치를 맞춘다.
  useLayoutEffect(() => {
    if (!scrollable) return;
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [scrollable, trackHeight]);

  const interactiveSeries = series.find((s) => s.interactive);

  return (
    <div
      className={"graph-viewport" + (scrollable ? " is-scrollable" : "")}
      ref={viewportRef}
    >
      <div className="graph-fade graph-fade-top" />
      <div className="graph-fade graph-fade-bottom" />

      <div
        className="graph-track"
        style={
          scrollable
            ? { height: trackHeight, position: "static" }
            : { height: trackHeight, transform: `translateY(${translateY}px)` }
        }
      >
        <div className="graph-labels" style={{ height: trackHeight }}>
          {stages.map((stage, i) => (
            <div
              key={stage.id}
              className={
                "graph-label" +
                (i === activeIndex ? " is-active" : "") +
                (i > activeIndex ? " is-upcoming" : "")
              }
              style={{ bottom: rowBottom(i), height: ROW_HEIGHT }}
            >
              <span className="graph-label-main">{stage.label}</span>
              {stage.sublabel && (
                <span className="graph-label-sub">({stage.sublabel})</span>
              )}
            </div>
          ))}
        </div>

        <div className="graph-area" style={{ height: trackHeight }}>
          <div className="graph-center-axis" />

          <svg
            className="graph-lines"
            viewBox={`0 ${-trackHeight} 100 ${trackHeight}`}
            preserveAspectRatio="none"
          >
            {series.map((s) => {
              const pathD = buildSmoothPath(seriesOrderedPoints(stages, s));
              if (!pathD) return null;
              return (
                <path
                  key={s.id}
                  d={pathD}
                  className="graph-line"
                  style={
                    s.color
                      ? {
                          stroke: s.color,
                          filter: `drop-shadow(0 0 3px ${s.color}) drop-shadow(0 0 8px ${s.color})`,
                        }
                      : undefined
                  }
                />
              );
            })}
          </svg>

          {stages.map((stage, i) => {
            const isActive = i === activeIndex;
            return (
              <div
                key={stage.id}
                className={
                  "graph-row" +
                  (isActive ? " is-active" : "") +
                  (i > activeIndex ? " is-upcoming" : "")
                }
                style={{ bottom: rowBottom(i), height: ROW_HEIGHT }}
              >
                <div className="graph-row-axis" />
                {isActive &&
                  interactiveSeries &&
                  Array.from({ length: COLUMN_COUNT }).map((_, col) => (
                    <button
                      key={col}
                      type="button"
                      className="graph-cell"
                      aria-label={`${stage.label} 지점 선택 ${col + 1}`}
                      onClick={() => onCellClick(interactiveSeries.id, stage.id, col)}
                    >
                      <span className="graph-cell-tick" />
                    </button>
                  ))}
              </div>
            );
          })}

          {series.flatMap((s) =>
            stages.map((stage, i) => {
              if (stage.id === rootStageId) return null; // 아래에서 한 번만 그린다
              const point = s.points[stage.id];
              if (!point) return null;
              const isActiveDot = s.interactive && i === activeIndex;
              const dotColor = isActiveDot ? undefined : s.color;
              // 활성 행 위의 점은 (다른 갈래의 점이라도) 클릭을 가로채지 않고 아래 셀 버튼으로
              // 통과시켜야, 같은 칸을 다시 찍거나 다른 갈래 점과 겹친 칸을 눌러도 항상 동작한다.
              return (
                <button
                  key={`${s.id}-${stage.id}`}
                  type="button"
                  className={"graph-point" + (isActiveDot ? " is-active" : "")}
                  style={{
                    left: `${colToPercent(point.x)}%`,
                    bottom: rowBottom(i) + ROW_HEIGHT / 2,
                    pointerEvents: i === activeIndex ? "none" : "auto",
                    ...(dotColor
                      ? {
                          background: dotColor,
                          boxShadow: `0 0 0 1px ${dotColor}, 0 0 8px 2px ${dotColor}`,
                        }
                      : undefined),
                  }}
                  onClick={() => onPointClick(s.id, stage.id)}
                  aria-label={`${stage.label} 기록 보기`}
                />
              );
            }),
          )}

          {rootStageId &&
            (() => {
              const rootIndex = stages.findIndex((st) => st.id === rootStageId);
              const rootPoint = series
                .map((s) => s.points[rootStageId])
                .find(Boolean);
              if (rootIndex === -1 || !rootPoint) return null;
              return (
                <button
                  type="button"
                  className="graph-point"
                  style={{
                    left: `${colToPercent(rootPoint.x)}%`,
                    bottom: rowBottom(rootIndex) + ROW_HEIGHT / 2,
                  }}
                  onClick={() => onPointClick(null, rootStageId)}
                  aria-label={`${stages[rootIndex].label} 기록 보기`}
                />
              );
            })()}
        </div>
      </div>
    </div>
  );
}
