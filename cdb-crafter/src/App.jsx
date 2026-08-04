import { useEffect, useState } from "react";
import Onboarding from "./components/Onboarding";
import LifeGraph from "./components/LifeGraph";
import PointModal from "./components/PointModal";
import IntroModal from "./components/IntroModal";
import TransitionScreen from "./components/TransitionScreen";
import ReflectionScreen from "./components/ReflectionScreen";
import { computeStages, calculateAge } from "./stageUtils";
import {
  ensureProfile,
  loadProfile,
  personaIdFor,
  restoreSession,
  saveInitialProfile,
  saveReflection,
  saveStagePoint,
  saveTransition,
} from "./saveLifeGraph";
import { isReflectionComplete } from "./questions";
import "./App.css";

const EMPTY_REFLECTION = { answers: {} };

// 한 시기가 다 채워졌는지 — 감정 위치(x)와 글이 있어야 한다.
// 사진은 "현재"에서만 필수다(requirePhoto). 옛 시기의 사진이 없는 사람이 거기서 막히면 세션이
// 끝나버리지만, 지금 모습 한 장은 그 자리에서 찍을 수 있고 2차 파이프라인이 얼굴 레퍼런스로
// 쓸 최소 한 장이 반드시 필요하다(profile-worker.js는 사진이 하나도 없으면 바로 실패한다).
// image는 이번에 고른 사진, imageURL은 지난번에 올려둔 사진 — 둘 중 하나만 있으면 된다.
function isPointComplete(point, requirePhoto = false) {
  if (!point || point.x === undefined || point.x === null) return false;
  if (!point.text?.trim()) return false;
  return requirePhoto ? Boolean(point.image || point.imageURL) : true;
}

// 다시 로그인한 사람을 데려다 놓을 자리 — 아직 덜 채운 첫 시기. 이미 다 채웠으면 마지막
// 시기에 두어 곧바로 다음 화면으로 넘어갈 수 있게 한다.
function resumeIndex(stageList, pointsMap) {
  const lastIndex = stageList.length - 1;
  const index = stageList.findIndex((stage, i) =>
    !isPointComplete(pointsMap[stage.id], i === lastIndex),
  );
  return index === -1 ? lastIndex : index;
}

function App() {
  // screen: "login" -> "draw" -> "transition" -> "reflection" -> "saved"
  const [screen, setScreen] = useState("login");

  const [profile, setProfile] = useState(null); // { name, birthDate, age }
  const [personaId, setPersonaId] = useState("");
  const [stages, setStages] = useState(null);

  const [points, setPoints] = useState({}); // 과거~현재 점
  const [activeIndex, setActiveIndex] = useState(0);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  // 저장은 됐지만 사진 일부가 업로드되지 못한 경우 저장완료 화면에서 알려준다.
  const [failedImageStages, setFailedImageStages] = useState([]);
  // 업로드 진행률 — 느린 회선에서 몇 분씩 걸리므로 멈춘 게 아님을 보여준다.
  const [uploadProgress, setUploadProgress] = useState(null);
  // 단계별 저장(체크포인트)의 진행 표시. 진행을 막지는 않는다 — 내용은 화면에 그대로
  // 남아 있고, 마지막 "저장하기"에서 못 올라간 것까지 다시 한번 올린다. 실패는 화면에
  // 띄우지 않는다(콘솔 로그만) — 관람객에게 굳이 알릴 만한 정보가 아니다.
  const [checkpoint, setCheckpoint] = useState(null); // { label, ratio } | null

  // 점을 찍고 있는 stageId (없으면 null) — 모달이 열려 있는지 여부이자 대상이다.
  const [modal, setModal] = useState(null);

  // 그리기를 시작할 때 딱 한 번 보여주는 사용법 안내.
  const [showIntro, setShowIntro] = useState(false);

  // 그래프와 "지금 죽는다면" 사이의 전환 질문("3일 남았다면") 답변.
  const [transitionText, setTransitionText] = useState("");

  // "지금 죽는다면" 화면의 답변 — 서술형 문항.
  const [reflection, setReflection] = useState(EMPTY_REFLECTION);
  // 그 화면의 진행 위치와 부고를 이미 봤는지. ReflectionScreen 안에 두면 앞 화면으로
  // 갔다 오는 사이 컴포넌트가 사라져 상태가 초기화되고, 부고 애니메이션이 다시 흐른다.
  const [reflectionStep, setReflectionStep] = useState(0);
  const [obituarySeen, setObituarySeen] = useState(false);

  // login 이후에 항상 준비됨
  const presentStage = stages?.[stages.length - 1];

  // "3일 남았다면"부터 다크 모드로 — 여기서 "지금 죽는다"는 가정이 깔리고, 그 앞
  // (로그인·과거~현재)은 항상 라이트 모드다.
  useEffect(() => {
    if (screen === "transition" || screen === "reflection") {
      document.documentElement.setAttribute("data-theme", "dark");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }, [screen]);

  // ---------- 로그인 (이름+생년월일로 기존 프로필을 찾아오거나 새로 시작) ----------
  // 전에 쓴 게 있으면 그대로 되살려 이어서 진행한다 — 중간에 끊겼든 이미 제출했든,
  // 같은 이름·생년월일로 들어오면 지난번 내용이 채워진 채로 시작한다.
  async function handleOnboardingSubmit({ name, birthDate }) {
    const id = personaIdFor({ name, birthDate });
    try {
      const data = await loadProfile(id);
      // 예전 스키마로 만들어진 문서는 age가 없을 수 있다 — 그럴 때만 다시 계산한다.
      const resolvedAge = typeof data?.age === "number" ? data.age : calculateAge(birthDate);
      const stageList = computeStages(resolvedAge);
      const saved = restoreSession(data);
      const savedPoints = saved?.points ?? {};

      // 이 시점에 문서를 만들어 둔다 — 이후 단계별 저장이 얹힐 자리다. 아직 제출 표시는
      // 찍지 않으므로 그리는 중인 사람이 생성 대기열에 뜨지는 않는다.
      await ensureProfile({ name, birthDate, age: resolvedAge });

      setProfile({ name, birthDate, age: resolvedAge });
      setPersonaId(id);
      setStages(stageList);
      setPoints(savedPoints);
      setTransitionText(saved?.transitionText ?? "");
      setReflection(saved?.reflection ?? EMPTY_REFLECTION);
      setReflectionStep(0);
      setObituarySeen(false);
      setActiveIndex(resumeIndex(stageList, savedPoints));
      setShowIntro(!saved); // 사용법 안내는 처음 오는 사람에게만
      setScreen("draw");
    } catch (err) {
      console.error(err);
      return { error: "정보를 불러오는 중 문제가 발생했어요. 다시 시도해주세요." };
    }
  }

  // ---------- 점 찍기 / 모달 열기 ----------
  function handleCellClick(_seriesId, stageId, col) {
    setPoints((prev) => ({
      ...prev,
      [stageId]: { ...(prev[stageId] || {}), x: col },
    }));
    setModal(stageId);
  }

  function handlePointClick(_seriesId, stageId) {
    setModal(stageId);
  }

  // ---------- 이전 / 다음 ----------
  function handlePrev() {
    setActiveIndex((i) => Math.max(0, i - 1));
  }

  function handleNext() {
    setActiveIndex((i) => Math.min(stages.length - 1, i + 1));
  }

  async function handleConfirmSubmit() {
    setSubmitting(true);
    setSubmitError("");
    setUploadProgress(null);
    try {
      const result = await saveInitialProfile({
        profile,
        stages,
        points,
        transitionText,
        reflection,
        onProgress: setUploadProgress,
      });
      setFailedImageStages(result?.failedImageStages ?? []);
      setScreen("saved");
    } catch (err) {
      console.error(err);
      setSubmitError("저장 중 문제가 발생했어요. 다시 시도해주세요.");
    } finally {
      setSubmitting(false);
      setUploadProgress(null);
    }
  }

  // ---------- 단계별 저장(체크포인트) ----------
  // 각 저장은 실패해도 진행을 막지 않는다 — 쓴 내용은 화면 상태에 그대로 있고, 마지막
  // "저장하기"가 전체를 한 번 더 올리면서 못 올라간 것까지 마저 올린다.
  async function checkpointStage(stageId, point) {
    if (!personaId) return;
    const label = stages?.find((s) => s.id === stageId)?.label ?? "";
    try {
      const { imageURL } = await saveStagePoint({
        personaId,
        stageId,
        point,
        onProgress: (ratio) => setCheckpoint({ label, ratio }),
      });
      // 올라간 사진은 메모리에 든 data: URL을 URL로 갈아끼운다 — 사진을 여러 장 들고 있으면
      // 태블릿에서 금방 무거워지고, 마지막 제출 때 같은 사진을 다시 올리지 않게 된다.
      if (imageURL) {
        setPoints((prev) => ({
          ...prev,
          [stageId]: { ...prev[stageId], image: null, imageURL },
        }));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setCheckpoint(null);
    }
  }

  async function checkpointTransition() {
    if (!personaId) return;
    try {
      await saveTransition({ personaId, text: transitionText });
    } catch (err) {
      console.error(err);
    }
  }

  async function checkpointReflection() {
    if (!personaId) return;
    try {
      await saveReflection({ personaId, reflection });
    } catch (err) {
      console.error(err);
    }
  }

  function handleRestartAll() {
    setProfile(null);
    setPersonaId("");
    setStages(null);
    setPoints({});
    setActiveIndex(0);
    setTransitionText("");
    setReflection(EMPTY_REFLECTION);
    setReflectionStep(0);
    setObituarySeen(false);
    setSubmitting(false);
    setSubmitError("");
    setFailedImageStages([]);
    setCheckpoint(null);
    setModal(null);
    setScreen("login");
  }

  // ---------- 모달 저장 ----------
  function handleModalSave({ text, image }) {
    if (modal == null) return;
    const stageId = modal;
    const point = { ...(points[stageId] || {}), text, image };
    setPoints((prev) => ({ ...prev, [stageId]: point }));
    setModal(null);
    checkpointStage(stageId, point);
  }

  if (screen === "login") {
    return <Onboarding onSubmit={handleOnboardingSubmit} />;
  }

  if (screen === "transition") {
    return (
      <TransitionScreen
        text={transitionText}
        onChange={setTransitionText}
        onBack={() => setScreen("draw")}
        onNext={() => {
          checkpointTransition();
          setScreen("reflection");
        }}
      />
    );
  }

  if (screen === "reflection") {
    return (
      <ReflectionScreen
        age={profile.age}
        value={reflection}
        onChange={setReflection}
        step={reflectionStep}
        onStepChange={(next) => {
          checkpointReflection(); // 문항 하나 넘어갈 때마다 지금까지 쓴 답을 저장한다
          setReflectionStep(next);
        }}
        obituarySeen={obituarySeen}
        onObituarySeen={() => setObituarySeen(true)}
        onBack={() => {
          checkpointReflection();
          setScreen("transition");
        }}
        onSubmit={handleConfirmSubmit}
        canSubmit={isReflectionComplete(reflection.answers)}
        submitting={submitting}
        progress={uploadProgress}
        error={submitError}
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
        {failedImageStages.length > 0 && (
          <p className="graph-hint">
            다만 네트워크 문제로 {failedImageStages.join(", ")}의 사진은 저장하지 못했어요.
            그래프와 글은 모두 저장됐어요.
          </p>
        )}
        <div className="graph-controls">
          <button type="button" className="control-btn control-btn-primary" onClick={handleRestartAll}>
            처음으로 돌아가기
          </button>
        </div>
      </div>
    );
  }

  // screen === "draw"
  const activeStageObj = stages[activeIndex];
  const activePoint = points[activeStageObj.id];
  const isLastStage = activeIndex === stages.length - 1;
  const activeComplete = isPointComplete(activePoint, isLastStage);
  const readyForTransition = isLastStage && activeComplete;

  const series = [{ id: "main", points, color: null, interactive: true }];

  let modalStageLabel = "";
  let modalPoint = null;
  if (modal) {
    modalStageLabel = stages.find((s) => s.id === modal)?.label ?? "";
    modalPoint = points[modal];
  }

  let hint;
  if (!activePoint) {
    // 마지막 단계는 라벨이 나이대가 아니라 "현재"라 "현재 때는"이 되어버린다 — 따로 쓴다.
    hint = isLastStage
      ? "지금은 어떠신가요? 지금 마음과 가까운 점을 눌러주세요."
      : `${activeStageObj.label} 때는 어떠셨나요? 그때 마음과 가까운 점을 눌러주세요.`;
  } else if (!activeComplete) {
    hint = isLastStage
      ? "점을 다시 눌러 지금의 사진과 이야기를 채워주세요."
      : "점을 다시 눌러 그 시기의 이야기를 적어주세요.";
  } else {
    hint = "점을 다시 누르면 그 시기의 사진과 이야기를 고칠 수 있어요.";
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
        stages={stages}
        series={series}
        activeIndex={activeIndex}
        onCellClick={handleCellClick}
        onPointClick={handlePointClick}
        focusRatio={modal ? 0.28 : 0.5}
        rootStageId={presentStage.id}
      />

      <p className="graph-hint">
        {checkpoint
          ? `${checkpoint.label} 사진을 올리는 중... ${Math.round((checkpoint.ratio ?? 0) * 100)}%`
          : hint}
      </p>

      <div className="graph-controls">
        <button
          type="button"
          className="control-btn"
          onClick={handlePrev}
          disabled={activeIndex === 0}
        >
          이전
        </button>
        <button
          type="button"
          className="control-btn control-btn-primary"
          onClick={readyForTransition ? () => setScreen("transition") : handleNext}
          disabled={!activeComplete}
        >
          다음
        </button>
      </div>

      {showIntro && <IntroModal onClose={() => setShowIntro(false)} />}

      {modal && (
        <PointModal
          stageId={modal}
          stageLabel={modalStageLabel}
          point={modalPoint}
          requirePhoto={modal === presentStage.id}
          onSave={handleModalSave}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

export default App;
