import { useEffect, useState } from "react";
import Onboarding from "./components/Onboarding";
import LifeGraph from "./components/LifeGraph";
import PointModal from "./components/PointModal";
import BranchPickerModal from "./components/BranchPickerModal";
import SubmitConfirmModal from "./components/SubmitConfirmModal";
import {
  computeStages,
  computeFutureStages,
  BRANCH_DEFS,
  BRANCH_COLORS,
} from "./stageUtils";
import { saveLifeGraph } from "./saveLifeGraph";
import "./App.css";

function noop() {}

function makeEmptyBranches() {
  const entries = BRANCH_DEFS.map((b) => [b.id, { points: {}, activeIndex: 0 }]);
  return Object.fromEntries(entries);
}

function App() {
  const [profile, setProfile] = useState(null); // { name, birthDate, age }
  const [stages, setStages] = useState(null);
  const [points, setPoints] = useState({});
  const [activeIndex, setActiveIndex] = useState(0); // 과거~현재 구간 안에서의 위치

  // focusZone: 지금 커서가 과거~현재 쪽에 있는지, 미래 쪽에 있는지
  const [focusZone, setFocusZone] = useState("main"); // "main" | "future"
  const [currentBranchId, setCurrentBranchId] = useState(BRANCH_DEFS[0].id);
  const [branches, setBranches] = useState(makeEmptyBranches);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [confirmSubmitOpen, setConfirmSubmitOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  // { branchId: null | string, stageId } — null branchId면 과거~현재 그래프의 점
  const [modal, setModal] = useState(null);

  // 미래 쪽에 있거나 미래를 고르는 모달이 떠 있을 때 다크 모드 — 과거/현재로 돌아가면 바로 라이트 모드로 복귀한다.
  useEffect(() => {
    if (focusZone === "future" || branchPickerOpen) {
      document.documentElement.setAttribute("data-theme", "dark");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }, [focusZone, branchPickerOpen]);

  function handleOnboardingSubmit({ name, birthDate, age }) {
    setProfile({ name, birthDate, age });
    setStages(computeStages(age));
    setPoints({});
    setActiveIndex(0);
    setFocusZone("main");
    setCurrentBranchId(BRANCH_DEFS[0].id);
    setBranches(makeEmptyBranches());
    setBranchPickerOpen(false);
    setConfirmSubmitOpen(false);
    setSubmitted(false);
    setSubmitting(false);
    setSubmitError("");
  }

  // ---------- 점 찍기 / 모달 열기 (과거~현재, 미래 갈래 공통) ----------
  function handleCellClick(seriesId, stageId, col) {
    if (seriesId === "main") {
      setPoints((prev) => ({
        ...prev,
        [stageId]: { ...(prev[stageId] || {}), x: col },
      }));
      setModal({ branchId: null, stageId });
      return;
    }
    setBranches((prev) => ({
      ...prev,
      [seriesId]: {
        ...prev[seriesId],
        points: {
          ...prev[seriesId].points,
          [stageId]: { ...(prev[seriesId].points[stageId] || {}), x: col },
        },
      },
    }));
    setModal({ branchId: seriesId, stageId });
  }

  function handlePointClick(seriesId, stageId) {
    // main 시리즈의 점이거나, 갈래들이 공유하는 "현재" 지점이면 과거~현재 데이터를 보여준다.
    if (seriesId === "main" || stageId === presentStage.id) {
      setModal({ branchId: null, stageId });
      return;
    }
    setModal({ branchId: seriesId, stageId });
  }

  // ---------- 이전 / 다음 ----------
  function handlePrev() {
    if (focusZone === "main") {
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    const branchActiveIndex = branches[currentBranchId].activeIndex;
    if (branchActiveIndex === 0) {
      // 갈래의 첫 단계에서 한 번 더 이전 -> 현재로 되돌아간다.
      setFocusZone("main");
      setActiveIndex(stages.length - 1);
      return;
    }
    setBranches((prev) => ({
      ...prev,
      [currentBranchId]: { ...prev[currentBranchId], activeIndex: branchActiveIndex - 1 },
    }));
  }

  function handleNext() {
    if (focusZone === "main") {
      if (activeIndex < stages.length - 1) {
        setActiveIndex((i) => i + 1);
      } else if (futureStages.length > 0) {
        // 현재에서 한 번 더 다음 -> 어떤 미래를 그릴지 모달로 선택하게 한다.
        setBranchPickerOpen(true);
      }
      return;
    }
    const branchActiveIndex = branches[currentBranchId].activeIndex;
    if (branchActiveIndex < futureStages.length - 1) {
      setBranches((prev) => ({
        ...prev,
        [currentBranchId]: { ...prev[currentBranchId], activeIndex: branchActiveIndex + 1 },
      }));
      return;
    }
    // 이 갈래를 완성했다 -> 다른 미래를 고를 수 있도록 다시 선택 모달을 연다.
    setBranchPickerOpen(true);
  }

  function handleChooseBranch(branchId) {
    setCurrentBranchId(branchId);
    setFocusZone("future");
    setBranchPickerOpen(false);
  }

  async function handleConfirmSubmit() {
    setSubmitting(true);
    setSubmitError("");
    try {
      await saveLifeGraph({ profile, stages, futureStages, points, branches });
      setConfirmSubmitOpen(false);
      setSubmitted(true);
    } catch (err) {
      console.error(err);
      setSubmitError("저장 중 문제가 발생했어요. 다시 시도해주세요.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleRestart() {
    setProfile(null);
    setStages(null);
    setPoints({});
    setActiveIndex(0);
    setFocusZone("main");
    setCurrentBranchId(BRANCH_DEFS[0].id);
    setBranches(makeEmptyBranches());
    setBranchPickerOpen(false);
    setConfirmSubmitOpen(false);
    setSubmitted(false);
    setSubmitting(false);
    setSubmitError("");
    setModal(null);
  }

  // ---------- 모달 저장 ----------
  function handleModalSave({ text, image }) {
    if (!modal) return;
    if (modal.branchId) {
      setBranches((prev) => ({
        ...prev,
        [modal.branchId]: {
          ...prev[modal.branchId],
          points: {
            ...prev[modal.branchId].points,
            [modal.stageId]: {
              ...(prev[modal.branchId].points[modal.stageId] || {}),
              text,
              image,
            },
          },
        },
      }));
    } else {
      setPoints((prev) => ({
        ...prev,
        [modal.stageId]: { ...(prev[modal.stageId] || {}), text, image },
      }));
    }
    setModal(null);
  }

  if (!stages) {
    return <Onboarding onSubmit={handleOnboardingSubmit} />;
  }

  const presentStage = stages[stages.length - 1];
  const futureStages = computeFutureStages(stages);
  const hasFuture = futureStages.length > 0;

  const isFuture = focusZone === "future";
  const branchIndex = BRANCH_DEFS.findIndex((b) => b.id === currentBranchId);
  const branchActiveIndex = branches[currentBranchId].activeIndex;
  const activeStageObj = isFuture ? futureStages[branchActiveIndex] : stages[activeIndex];
  const hasActivePoint = isFuture
    ? Boolean(branches[currentBranchId].points[activeStageObj.id])
    : Boolean(points[activeStageObj.id]);
  const isLastMainStage = !isFuture && activeIndex === stages.length - 1;
  const isLastBranchStage = isFuture && branchActiveIndex === futureStages.length - 1;
  const allBranchesComplete = BRANCH_DEFS.every((b) =>
    futureStages.every((s) => branches[b.id].points[s.id]),
  );
  const readyToSubmit =
    (isFuture && isLastBranchStage && hasActivePoint && allBranchesComplete) ||
    (!isFuture && !hasFuture && isLastMainStage && hasActivePoint);

  let modalStageLabel = "";
  let modalPoint = null;
  if (modal) {
    if (modal.branchId) {
      const futureStage = futureStages.find((s) => s.id === modal.stageId);
      const branchDef = BRANCH_DEFS.find((b) => b.id === modal.branchId);
      modalStageLabel = `${branchDef?.label} · ${futureStage?.label}`;
      modalPoint = branches[modal.branchId].points[modal.stageId];
    } else {
      modalStageLabel = stages.find((s) => s.id === modal.stageId)?.label;
      modalPoint = points[modal.stageId];
    }
  }

  // 과거~현재와 미래를 처음부터 하나의 트랙으로 계산한다 (다크 모드만 나중에 켜질 뿐, 구조는 동일).
  const allStages = [...stages, ...futureStages];
  const combinedActiveIndex = isFuture ? stages.length + branchActiveIndex : activeIndex;
  const series = [
    { id: "main", points, color: null, interactive: !isFuture },
    ...BRANCH_DEFS.map((b) => ({
      id: b.id,
      color: BRANCH_COLORS[b.id],
      interactive: isFuture && b.id === currentBranchId,
      points: { [presentStage.id]: points[presentStage.id], ...branches[b.id].points },
    })),
  ];

  const currentBranch = BRANCH_DEFS[branchIndex];

  // 제출 후에는 어떤 갈래도 다시 편집/이동할 수 없는 읽기 전용 그래프로 보여준다.
  const displaySeries = submitted ? series.map((s) => ({ ...s, interactive: false })) : series;

  let hint;
  if (submitted) {
    hint = "제출이 완료됐어요. 소중한 이야기를 들려주셔서 감사합니다.";
  } else if (!isFuture) {
    if (!hasActivePoint) {
      hint = `“${activeStageObj.label}”에서 느낀 감정에 맞는 위치를 눌러 점을 찍어주세요.`;
    } else if (isLastMainStage && hasFuture) {
      hint = "여기서부터 미래가 네 갈래로 나뉘어요.";
    } else if (isLastMainStage) {
      hint = "제출하기를 눌러주세요.";
    } else {
      hint = "다음을 눌러 다음 시기로 넘어가세요.";
    }
  } else if (readyToSubmit) {
    hint = "네 가지 미래를 모두 그렸어요! 제출하기를 눌러주세요.";
  } else if (hasActivePoint && isLastBranchStage) {
    hint = "다음을 누르면 다른 미래를 선택할 수 있어요.";
  } else {
    hint = currentBranch.prompt;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>{profile?.name ? `${profile.name}님의 인생 그래프` : "인생 그래프"}</h1>
        <p className="app-subtitle">
          왼쪽은 부정적인 기억, 오른쪽은 긍정적인 기억이에요.
        </p>
      </header>

      <div className="axis-legend">
        <span>← 부정</span>
        <span>긍정 →</span>
      </div>

      <LifeGraph
        stages={allStages}
        series={displaySeries}
        activeIndex={combinedActiveIndex}
        onCellClick={submitted ? noop : handleCellClick}
        onPointClick={submitted ? noop : handlePointClick}
        focusRatio={modal ? 0.28 : 0.5}
        rootStageId={presentStage.id}
        scrollable={submitted}
      />

      <p className="graph-hint">{hint}</p>

      <div className="graph-controls">
        {submitted ? (
          <button type="button" className="control-btn control-btn-primary" onClick={handleRestart}>
            처음으로 돌아가기
          </button>
        ) : (
          <>
            <button
              type="button"
              className="control-btn"
              onClick={handlePrev}
              disabled={!isFuture && activeIndex === 0}
            >
              이전
            </button>
            <button
              type="button"
              className="control-btn control-btn-primary"
              onClick={readyToSubmit ? () => setConfirmSubmitOpen(true) : handleNext}
              disabled={!hasActivePoint}
            >
              {readyToSubmit
                ? "제출하기"
                : !isFuture && isLastMainStage
                  ? "미래 그리기"
                  : isFuture && isLastBranchStage
                    ? "다른 미래 선택"
                    : "다음"}
            </button>
          </>
        )}
      </div>

      {branchPickerOpen && (
        <BranchPickerModal
          branches={branches}
          futureStages={futureStages}
          onSelect={handleChooseBranch}
          onClose={() => setBranchPickerOpen(false)}
        />
      )}

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
          allowImage={!modal.branchId}
          onSave={handleModalSave}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

export default App;
