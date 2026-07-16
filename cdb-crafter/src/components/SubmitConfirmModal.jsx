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

  return (
    <div className="modal-backdrop" onClick={submitting ? undefined : onCancel}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
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
