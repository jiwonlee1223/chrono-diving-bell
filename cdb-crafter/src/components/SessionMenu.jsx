const ORDINALS = ["첫번째", "두번째", "세번째"];

// doneCount: 이미 그려서 저장된 미래 개수 (0~maxSessions). 딱 하나만 "active"이고
// 나머지는 done(완료) 또는 locked(아직 순서가 안 됨)이다.
export default function SessionMenu({ personaName, doneCount, maxSessions, onSelect }) {
  const allDone = doneCount >= maxSessions;

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <h1>{personaName}님의 인생 그래프</h1>
        <p className="onboarding-desc">
          {allDone
            ? "세 가지 미래를 모두 그리셨어요. 소중한 이야기를 들려주셔서 감사합니다."
            : "그릴 인생그래프를 선택해주세요."}
        </p>

        <div className="branch-picker-list">
          {ORDINALS.slice(0, maxSessions).map((ordinal, i) => {
            const state = i < doneCount ? "done" : i === doneCount ? "active" : "locked";
            return (
              <button
                key={ordinal}
                type="button"
                className={`branch-picker-item is-${state}`}
                disabled={state !== "active"}
                onClick={() => onSelect(i)}
              >
                <span className="branch-picker-text">
                  <span className="branch-picker-label">{ordinal} 인생그래프 그리기</span>
                </span>
                {state === "done" && <span className="branch-picker-check">✓</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
