import { useEffect, useRef, useState } from "react";
import { processImageFile } from "../imageUtils";
import { stageQuestionFor } from "../questions";

// 시기별 입력칸 — 그 구간에 배정된 질문 하나와 사진 한 장을 받는다.
// 사진은 모든 시기에서 받는다: 2차 파이프라인이 그 시기 장면을 만들 때 "그 순간의 실제 사진"을
// 레퍼런스로 싣기 때문에(profile-worker.js collectStagePhotoURLs) 시기마다 한 장씩 있어야 한다.
export default function PointModal({
  stageId,
  stageLabel,
  point,
  requirePhoto = false,
  onSave,
  onClose,
}) {
  // image는 이번에 고른 사진(data: URL), imageURL은 지난번 제출 때 올려둔 사진 —
  // 다시 로그인한 사람에게도 그때 올린 사진이 그대로 보여야 한다. 그대로 저장하면
  // 업로드 없이 같은 URL이 다시 쓰인다(saveLifeGraph.js uploadImage).
  const [text, setText] = useState(point?.text ?? "");
  const [image, setImage] = useState(point?.image ?? point?.imageURL ?? "");
  // textarea에서 글을 드래그로 선택하다가 커서가 배경(backdrop) 위로 나가서 놓이면, 그 click의
  // target이 backdrop이 되어 버려 모달이 닫혀버린다. mousedown이 실제로 backdrop 자체에서
  // 시작했을 때만 닫히게 해서 이 오작동을 막는다.
  const mouseDownOnBackdrop = useRef(false);

  useEffect(() => {
    setText(point?.text ?? "");
    setImage(point?.image ?? point?.imageURL ?? "");
  }, [point]);

  async function handleImageChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImage(await processImageFile(file));
  }

  const question = stageQuestionFor(stageId);
  // 글은 항상 있어야 하고, 사진은 "현재"에서만 필수다.
  const canSave = Boolean(text.trim()) && (!requirePhoto || Boolean(image));

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
          <span>{stageLabel}</span>
          <button type="button" className="modal-close" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </div>

        <label className="modal-image-drop">
          {image ? (
            <img src={image} alt="첨부 이미지" />
          ) : (
            <span className="modal-image-placeholder">
              {requirePhoto ? "지금의 사진 추가" : "이 시기의 사진 추가"}
            </span>
          )}
          <input type="file" accept="image/*" onChange={handleImageChange} hidden />
        </label>

        <label className="question-field">
          <span className="question-prompt">{question}</span>
          <textarea
            className="modal-textarea"
            placeholder="떠오르는 대로 적어봅니다."
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
          />
        </label>

        {!canSave && (
          <p className="question-note">
            {requirePhoto
              ? "지금의 사진과 이야기를 모두 채워주세요."
              : "이야기를 적어야 저장할 수 있어요."}
          </p>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="modal-save"
            onClick={() => onSave({ text, image })}
            disabled={!canSave}
          >
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
