import { useRef } from "react";
import LifeGraph from "./LifeGraph";

function noop() {}

export default function SubmitConfirmModal({
  stages,
  series,
  activeIndex,
  rootStageId,
  onConfirm,
  onCancel,
  submitting,
  error,
}) {
  // 미리보기는 어떤 갈래도 편집할 수 없도록 읽기 전용으로 보여준다.
  const previewSeries = series.map((s) => ({ ...s, interactive: false }));
  // 드래그로 텍스트를 선택하다 커서가 backdrop 위에서 풀리면 모달이 닫혀버리는 오작동 방지 —
  // mousedown이 실제로 backdrop 자체에서 시작했을 때만 닫는다.
  const mouseDownOnBackdrop = useRef(false);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        mouseDownOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (!submitting && mouseDownOnBackdrop.current && e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="modal-card">
        <div className="modal-header">
          <span>제출할까요?</span>
          <button
            type="button"
            className="modal-close"
            onClick={onCancel}
            disabled={submitting}
            aria-label="닫기"
          >
            ×
          </button>
        </div>

        <p className="branch-picker-desc">
          지금까지 그린 인생 그래프예요.
        </p>

        <div className="submit-preview">
          <LifeGraph
            stages={stages}
            series={previewSeries}
            activeIndex={activeIndex}
            onCellClick={noop}
            onPointClick={noop}
            rootStageId={rootStageId}
            scrollable
          />
        </div>

        {error && <p className="onboarding-error">{error}</p>}

        <div className="graph-controls">
          <button type="button" className="control-btn" onClick={onCancel} disabled={submitting}>
            아니요
          </button>
          <button
            type="button"
            className="control-btn control-btn-primary"
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? "저장하는 중..." : "네, 제출할게요"}
          </button>
        </div>
      </div>
    </div>
  );
}
