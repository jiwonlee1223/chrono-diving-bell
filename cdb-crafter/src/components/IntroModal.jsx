import { useRef } from "react";

export default function IntroModal({ onClose }) {
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
        if (mouseDownOnBackdrop.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-card">
        <div className="modal-header">
          <span>그리기 전에</span>
          <button type="button" className="modal-close" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </div>

        <ol className="intro-steps">
          <li>각 시기마다 그때 느낀 감정에 맞는 위치를 눌러 점을 찍어요. 왼쪽일수록 부정적인 기억, 오른쪽일수록 긍정적인 기억이에요.</li>
          <li>점을 찍으면 그 순간의 이야기나 사진을 남길 수 있어요.</li>
          <li>이미 찍은 점은 다시 눌러서 내용을 고칠 수 있어요.</li>
        </ol>

        <div className="modal-actions">
          <button type="button" className="modal-save" onClick={onClose}>
            시작할게요
          </button>
        </div>
      </div>
    </div>
  );
}
