import { TRANSITION_QUESTION } from "../questions";

// 그래프와 "지금 죽는다면" 사이의 한 걸음 — "3일 남았다"는 상황을 깔아주는 자리라
// 질문 하나만 두고 다른 요소를 넣지 않는다.
export default function TransitionScreen({ text, onChange, onBack, onNext }) {
  return (
    <div className="app-shell">
      <div className="question-list">
        <label className="question-field">
          <span className="question-lead">{TRANSITION_QUESTION.lead}</span>
          <span className="question-prompt">{TRANSITION_QUESTION.prompt}</span>
          <textarea
            className="modal-textarea is-tall"
            placeholder={TRANSITION_QUESTION.placeholder}
            value={text}
            onChange={(e) => onChange(e.target.value)}
            rows={6}
            autoFocus
          />
        </label>
      </div>

      <div className="graph-controls">
        <button type="button" className="control-btn" onClick={onBack}>
          이전
        </button>
        <button
          type="button"
          className="control-btn control-btn-primary"
          onClick={onNext}
          disabled={!text.trim()}
        >
          다음
        </button>
      </div>
    </div>
  );
}
