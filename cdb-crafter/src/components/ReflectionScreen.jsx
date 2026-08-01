import { useMemo, useState } from "react";
import Typewriter from "./Typewriter";
import { REFLECTION_FIELDS, buildObituaryText } from "../questions";

// 마지막 구간 — 한 화면에 한 가지만 둔다.
// 먼저 부고가 타이핑으로 떠오르고, 그다음 질문이 하나씩 나타난다. 한꺼번에 다 보여주면
// 분량에 눌려 형식적으로 채우게 되는데, 이 구간은 그렇게 지나가서는 안 되는 자리다.
//
// step(0=부고, 1부터=REFLECTION_FIELDS[step-1])과 obituarySeen은 App이 들고 있다 —
// 앞 화면("3일 남았다면")으로 갔다 오면 이 컴포넌트가 사라졌다 다시 만들어지기 때문에,
// 여기에 두면 진행 위치가 초기화되고 부고 애니메이션이 다시 흐른다.
// value: { answers: { [key]: string } }
export default function ReflectionScreen({
  age,
  value,
  onChange,
  step,
  onStepChange,
  obituarySeen,
  onObituarySeen,
  onBack,
  onSubmit,
  canSubmit,
  submitting,
  progress,
  error,
}) {
  const answers = value?.answers ?? {};

  // 연기가 한 번 훑고 지나간 뒤에 글자가 시작된다 — 부고가 불쑥 나타나지 않게.
  // 이미 본 부고에는 연기도 타이핑도 없이 곧바로 글이 놓인다.
  const [veilPassed, setVeilPassed] = useState(false);

  const obituaryText = useMemo(() => buildObituaryText(age), [age]);

  const field = REFLECTION_FIELDS[step - 1];
  const isLastField = step === REFLECTION_FIELDS.length;
  const answered = Boolean(field && answers[field.key]?.trim());

  function handleBack() {
    if (step === 0) onBack();
    else onStepChange(step - 1);
  }

  function handleNext() {
    if (isLastField) onSubmit();
    else onStepChange(step + 1);
  }

  return (
    <div className="app-shell">
      {/* key를 바꿔 단계마다 fade가 다시 일어나게 한다. */}
      <div className="step-view" key={step}>
        {step === 0 ? (
          <div className="obituary-scene">
            {!veilPassed && !obituarySeen && (
              <div className="smoke-veil" onAnimationEnd={() => setVeilPassed(true)} />
            )}
            {(veilPassed || obituarySeen) && (
              <Typewriter
                text={obituaryText}
                speed={45}
                instant={obituarySeen}
                onDone={onObituarySeen}
              />
            )}
          </div>
        ) : (
          <div className="step-question">
            <span className="question-lead">{field.prompt}</span>
            <textarea
              className="modal-textarea"
              placeholder={field.placeholder}
              value={answers[field.key] ?? ""}
              onChange={(e) =>
                onChange({ ...value, answers: { ...answers, [field.key]: e.target.value } })
              }
              rows={5}
            />
          </div>
        )}
      </div>

      {error && <p className="onboarding-error">{error}</p>}

      {/* 사진 업로드는 회선에 따라 몇 분씩 걸린다 — 멈춘 게 아님을 보여준다. */}
      {submitting && progress?.total > 0 && (
        <div className="upload-progress">
          <div className="upload-progress-bar">
            <div
              className="upload-progress-fill"
              style={{
                width: `${Math.round(
                  ((progress.current - 1 + (progress.ratio ?? 0)) / progress.total) * 100,
                )}%`,
              }}
            />
          </div>
          <p className="upload-progress-label">
            사진 {progress.current}/{progress.total}장 올리는 중 ({progress.stageLabel}) —{" "}
            {Math.round((progress.ratio ?? 0) * 100)}%
          </p>
        </div>
      )}

      {/* 부고가 흐르는 동안에는 버튼을 아예 두지 않는다 — 읽는 것 말고 할 일이 없어야 한다. */}
      {(step > 0 || obituarySeen) && (
        <div className="graph-controls is-revealed">
          <button type="button" className="control-btn" onClick={handleBack} disabled={submitting}>
            이전
          </button>
          <button
            type="button"
            className="control-btn control-btn-primary"
            onClick={handleNext}
            disabled={submitting || (step > 0 && (!answered || (isLastField && !canSubmit)))}
          >
            {isLastField ? (submitting ? "저장하는 중..." : "저장하기") : "다음"}
          </button>
        </div>
      )}
    </div>
  );
}
