import { BRANCH_COLORS, BRANCH_DEFS } from "../stageUtils";

export default function BranchPickerModal({ branches, futureStages, onSelect, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>어떤 미래를 그려볼까요?</span>
          <button type="button" className="modal-close" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </div>

        <p className="branch-picker-desc">
          같은 현재에서 네 가지 다른 미래로 이어질 수 있어요. 
          <br />
          하나씩 골라서 그려보세요.
        </p>

        <div className="branch-picker-list">
          {BRANCH_DEFS.map((branch) => {
            const done = futureStages.filter((s) => branches[branch.id].points[s.id]).length;
            const isComplete = done === futureStages.length;
            const color = BRANCH_COLORS[branch.id];
            return (
              <button
                key={branch.id}
                type="button"
                className="branch-picker-item"
                onClick={() => onSelect(branch.id)}
              >
                <span
                  className="branch-picker-dot"
                  style={{ background: color, boxShadow: `0 0 8px 1px ${color}` }}
                />
                <span className="branch-picker-text">
                  <span className="branch-picker-label">{branch.label}</span>
                  <span className="branch-picker-hint">
                    {isComplete ? "완료됨 · 다시 보기" : `${done} / ${futureStages.length}`}
                  </span>
                </span>
                {isComplete && <span className="branch-picker-check">✓</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
