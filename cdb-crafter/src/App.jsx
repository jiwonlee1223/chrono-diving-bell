import { useEffect, useState } from "react";
import Onboarding from "./components/Onboarding";
import SessionMenu from "./components/SessionMenu";
import LifeGraph from "./components/LifeGraph";
import PointModal from "./components/PointModal";
import SubmitConfirmModal from "./components/SubmitConfirmModal";
import {
  computeStages,
  computeFutureStages,
  calculateAge,
  MAX_FUTURE_SESSIONS,
  FUTURE_COLORS,
} from "./stageUtils";
import {
  loadProfile,
  personaIdFor,
  saveInitialProfile,
  saveFollowUpSession,
  SESSION_KEYS,
} from "./saveLifeGraph";
import "./App.css";

// pointsMap(과거~현재~미래가 뒤섞인 세션 전체 점)에서 stageList에 속한 것만 골라낸다.
function pickPoints(pointsMap, stageList) {
  const out = {};
  stageList.forEach((s) => {
    if (pointsMap?.[s.id]) out[s.id] = pointsMap[s.id];
  });
  return out;
}

function App() {
  // screen: "login" -> "menu" -> "draw" -> "saved"
  const [screen, setScreen] = useState("login");

  const [profile, setProfile] = useState(null); // { name, birthDate, age }
  const [personaId, setPersonaId] = useState("");
  const [stages, setStages] = useState(null);

  // 기존에 저장된 세션들 (다시 로그인했을 때 불러온 것) — [pointsMap, ...],
  // 각 pointsMap은 과거~현재~그때의 미래 점을 통째로 담고 있다. 이 세션에서 절대 다시 쓰지 않는다.
  const [existingSessions, setExistingSessions] = useState([]);

  // 이번에 그리는 미래가 몇 번째인지 (0-based). 0이면 과거~현재도 이번 세션에서 그린다.
  const [sessionFutureIndex, setSessionFutureIndex] = useState(0);

  const [points, setPoints] = useState({}); // 과거~현재 점 (session 1에서만 편집됨)
  const [futurePoints, setFuturePoints] = useState({}); // 이번 세션에서 그리는 미래의 점
  const [activeIndex, setActiveIndex] = useState(0); // 과거~현재 구간 안에서의 위치
  const [futureActiveIndex, setFutureActiveIndex] = useState(0); // 미래 구간 안에서의 위치

  // focusZone: 지금 커서가 과거~현재 쪽에 있는지, 미래 쪽에 있는지
  const [focusZone, setFocusZone] = useState("main"); // "main" | "future"

  const [confirmSubmitOpen, setConfirmSubmitOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  // { zone: "main" | "future", stageId }
  const [modal, setModal] = useState(null);

  const mainInteractive = sessionFutureIndex === 0;

  // 미래 쪽에 있을 때만 다크 모드 — 로그인/메뉴/저장완료 화면과 과거~현재 구간은 항상 라이트 모드.
  useEffect(() => {
    if (screen === "draw" && focusZone === "future") {
      document.documentElement.setAttribute("data-theme", "dark");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }, [screen, focusZone]);

  // ---------- 로그인 (이름+생년월일로 기존 프로필을 찾아오거나 새로 시작) ----------
  async function handleOnboardingSubmit({ name, birthDate, age }) {
    const id = personaIdFor({ name, birthDate });
    try {
      const data = await loadProfile(id);
      if (data) {
        // 예전 스키마로 만들어진 문서는 age가 없을 수 있다 — 그럴 때만 다시 계산한다.
        const age = typeof data.age === "number" ? data.age : calculateAge(birthDate);
        setProfile({ name, birthDate, age });
        setStages(computeStages(age));
        setExistingSessions(SESSION_KEYS.map((key) => data[key]).filter(Boolean));
      } else {
        setProfile({ name, birthDate, age });
        setStages(computeStages(age));
        setExistingSessions([]);
      }
      setPersonaId(id);
      setScreen("menu");
    } catch (err) {
      console.error(err);
      return { error: "정보를 불러오는 중 문제가 발생했어요. 다시 시도해주세요." };
    }
  }

  // ---------- 메뉴에서 그릴 세션 선택 ----------
  function handleSelectSession(index) {
    const isMain = index === 0;
    setSessionFutureIndex(index);
    setPoints(
      isMain ? {} : pickPoints(existingSessions[existingSessions.length - 1], stages),
    );
    setFuturePoints({});
    setActiveIndex(0);
    setFutureActiveIndex(0);
    setFocusZone(isMain ? "main" : "future");
    setModal(null);
    setConfirmSubmitOpen(false);
    setSubmitError("");
    setScreen("draw");
  }

  // ---------- 점 찍기 / 모달 열기 ----------
  // LifeGraph는 그 순간의 유일한 interactive 시리즈에 대해서만 셀 클릭을 보내므로
  // (과거~현재 세션이면 "main", 아니면 이번 세션의 미래) 여기선 그 둘만 구분하면 된다.
  function handleCellClick(seriesId, stageId, col) {
    if (seriesId === "main") {
      setPoints((prev) => ({
        ...prev,
        [stageId]: { ...(prev[stageId] || {}), x: col },
      }));
      setModal({ zone: "main", stageId });
      return;
    }
    setFuturePoints((prev) => ({
      ...prev,
      [stageId]: { ...(prev[stageId] || {}), x: col },
    }));
    setModal({ zone: "future", stageId });
  }

  const currentFutureId = `future-${sessionFutureIndex}`;

  function handlePointClick(seriesId, stageId) {
    // main 시리즈의 점이거나, 모든 시리즈가 공유하는 "현재" 지점이면 과거~현재 데이터.
    if (seriesId === "main" || stageId === presentStage.id) {
      if (!mainInteractive) return; // 잠긴 과거/현재는 탭해도 안 열린다.
      setModal({ zone: "main", stageId });
      return;
    }
    if (seriesId !== currentFutureId) return; // 이전 세션에 그린 미래는 잠겨 있다.
    setModal({ zone: "future", stageId });
  }

  // ---------- 이전 / 다음 ----------
  function handlePrev() {
    if (focusZone === "main") {
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (futureActiveIndex === 0) {
      if (mainInteractive) {
        setFocusZone("main");
        setActiveIndex(stages.length - 1);
      }
      return;
    }
    setFutureActiveIndex((i) => i - 1);
  }

  function handleNext() {
    if (focusZone === "main") {
      if (activeIndex < stages.length - 1) {
        setActiveIndex((i) => i + 1);
      } else {
        setFocusZone("future");
      }
      return;
    }
    if (futureActiveIndex < futureStages.length - 1) {
      setFutureActiveIndex((i) => i + 1);
    }
  }

  async function handleConfirmSubmit() {
    setSubmitting(true);
    setSubmitError("");
    try {
      if (sessionFutureIndex === 0) {
        await saveInitialProfile({ profile, stages, futureStages, points, futurePoints });
      } else {
        await saveFollowUpSession({
          personaId,
          sessionIndex: sessionFutureIndex,
          stages,
          futureStages,
          pastPresentPoints: points,
          futurePoints,
        });
      }
      setConfirmSubmitOpen(false);
      setScreen("saved");
    } catch (err) {
      console.error(err);
      setSubmitError("저장 중 문제가 발생했어요. 다시 시도해주세요.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleRestartAll() {
    setProfile(null);
    setPersonaId("");
    setStages(null);
    setExistingSessions([]);
    setSessionFutureIndex(0);
    setPoints({});
    setFuturePoints({});
    setActiveIndex(0);
    setFutureActiveIndex(0);
    setFocusZone("main");
    setConfirmSubmitOpen(false);
    setSubmitting(false);
    setSubmitError("");
    setModal(null);
    setScreen("login");
  }

  // ---------- 모달 저장 ----------
  function handleModalSave({ text, image }) {
    if (!modal) return;
    if (modal.zone === "future") {
      setFuturePoints((prev) => ({
        ...prev,
        [modal.stageId]: { ...(prev[modal.stageId] || {}), text, image },
      }));
    } else {
      setPoints((prev) => ({
        ...prev,
        [modal.stageId]: { ...(prev[modal.stageId] || {}), text, image },
      }));
    }
    setModal(null);
  }

  if (screen === "login") {
    return <Onboarding onSubmit={handleOnboardingSubmit} />;
  }

  // login 이후엔 profile/stages가 항상 준비돼 있다.
  const presentStage = stages[stages.length - 1];
  const futureStages = computeFutureStages(stages);
  const hasFuture = futureStages.length > 0;
  const maxSessions = hasFuture ? MAX_FUTURE_SESSIONS : 1;

  if (screen === "menu") {
    return (
      <SessionMenu
        personaName={profile.name}
        doneCount={existingSessions.length}
        maxSessions={maxSessions}
        onSelect={handleSelectSession}
      />
    );
  }

  if (screen === "saved") {
    return (
      <div className="app-shell">
        <header className="app-header">
          <h1>{profile.name}님의 인생 그래프</h1>
        </header>
        <p className="graph-hint">저장이 완료됐어요. 소중한 이야기를 들려주셔서 감사합니다.</p>
        <div className="graph-controls">
          <button type="button" className="control-btn control-btn-primary" onClick={handleRestartAll}>
            처음으로 돌아가기
          </button>
        </div>
      </div>
    );
  }

  // screen === "draw"
  const isFuture = focusZone === "future";
  const activeStageObj = isFuture ? futureStages[futureActiveIndex] : stages[activeIndex];
  const hasActivePoint = isFuture
    ? Boolean(futurePoints[activeStageObj.id])
    : Boolean(points[activeStageObj.id]);
  const isLastMainStage = !isFuture && activeIndex === stages.length - 1;
  const isLastFutureStage = isFuture && futureActiveIndex === futureStages.length - 1;
  const readyToSubmit =
    (isFuture && isLastFutureStage && hasActivePoint) ||
    (!isFuture && !hasFuture && isLastMainStage && hasActivePoint);

  // 과거~현재와 미래를 하나의 트랙으로 계산한다 (다크 모드만 나중에 켜질 뿐, 구조는 동일).
  const allStages = [...stages, ...futureStages];
  const combinedActiveIndex = isFuture ? stages.length + futureActiveIndex : activeIndex;
  const series = [
    { id: "main", points, color: null, interactive: mainInteractive && !isFuture },
    ...existingSessions.map((s, i) => ({
      id: `future-${i}`,
      color: FUTURE_COLORS[i],
      interactive: false,
      points: { [presentStage.id]: points[presentStage.id], ...pickPoints(s, futureStages) },
    })),
    {
      id: currentFutureId,
      color: FUTURE_COLORS[sessionFutureIndex],
      interactive: isFuture,
      points: { [presentStage.id]: points[presentStage.id], ...futurePoints },
    },
  ];

  let modalStageLabel = "";
  let modalPoint = null;
  if (modal) {
    if (modal.zone === "future") {
      modalStageLabel = futureStages.find((s) => s.id === modal.stageId)?.label ?? "";
      modalPoint = futurePoints[modal.stageId];
    } else {
      modalStageLabel = stages.find((s) => s.id === modal.stageId)?.label ?? "";
      modalPoint = points[modal.stageId];
    }
  }

  let hint;
  if (!isFuture) {
    if (!hasActivePoint) {
      hint = `"${activeStageObj.label}"에서 느낀 감정에 맞는 위치를 눌러 점을 찍어주세요.`;
    } else if (isLastMainStage && hasFuture) {
      hint = "여기서부터 미래를 그려요.";
    } else if (isLastMainStage) {
      hint = "저장하기를 눌러주세요.";
    } else {
      hint = "다음을 눌러 다음 시기로 넘어가세요.";
    }
  } else if (readyToSubmit) {
    hint = "미래를 다 그렸어요! 저장하기를 눌러주세요.";
  } else if (!hasActivePoint) {
    hint = `"${activeStageObj.label}"에서 그 미래의 감정에 맞는 위치를 눌러 점을 찍어주세요.`;
  } else {
    hint = "다음을 눌러 다음 시기로 넘어가세요.";
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>{profile.name}님의 인생 그래프</h1>
        <p className="app-subtitle">왼쪽은 부정적인 기억, 오른쪽은 긍정적인 기억이에요.</p>
      </header>

      <div className="axis-legend">
        <span>← 부정</span>
        <span>긍정 →</span>
      </div>

      <LifeGraph
        stages={allStages}
        series={series}
        activeIndex={combinedActiveIndex}
        onCellClick={handleCellClick}
        onPointClick={handlePointClick}
        focusRatio={modal ? 0.28 : 0.5}
        rootStageId={presentStage.id}
      />

      <p className="graph-hint">{hint}</p>

      <div className="graph-controls">
        <button
          type="button"
          className="control-btn"
          onClick={handlePrev}
          disabled={isFuture ? futureActiveIndex === 0 && !mainInteractive : activeIndex === 0}
        >
          이전
        </button>
        <button
          type="button"
          className="control-btn control-btn-primary"
          onClick={readyToSubmit ? () => setConfirmSubmitOpen(true) : handleNext}
          disabled={!hasActivePoint}
        >
          {readyToSubmit ? "저장하기" : !isFuture && isLastMainStage ? "미래 그리기" : "다음"}
        </button>
      </div>

      {confirmSubmitOpen && (
        <SubmitConfirmModal
          stages={allStages}
          series={series}
          activeIndex={allStages.length - 1}
          rootStageId={presentStage.id}
          onConfirm={handleConfirmSubmit}
          onCancel={() => setConfirmSubmitOpen(false)}
          submitting={submitting}
          error={submitError}
        />
      )}

      {modal && (
        <PointModal
          stageLabel={modalStageLabel}
          point={modalPoint}
          allowImage={modal.zone === "main"}
          onSave={handleModalSave}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

export default App;
