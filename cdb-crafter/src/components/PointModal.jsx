import { useEffect, useState } from "react";

const MAX_DIMENSION = 1280;
const JPEG_QUALITY = 0.82;

// 휴대폰 원본 사진(수 MB)을 그대로 올리면 느린/불안정한 네트워크에서 업로드가 자주
// 끊기므로, 브라우저에서 미리 리사이즈·압축해서 훨씬 가벼운 JPEG로 만든다.
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > MAX_DIMENSION) {
          height = Math.round((height * MAX_DIMENSION) / width);
          width = MAX_DIMENSION;
        } else if (height > MAX_DIMENSION) {
          width = Math.round((width * MAX_DIMENSION) / height);
          height = MAX_DIMENSION;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function PointModal({ stageLabel, point, allowImage = true, onSave, onClose }) {
  const [text, setText] = useState(point?.text ?? "");
  const [image, setImage] = useState(point?.image ?? "");

  useEffect(() => {
    setText(point?.text ?? "");
    setImage(point?.image ?? "");
  }, [point]);

  async function handleImageChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setImage(await compressImage(file));
    } catch {
      // 압축이 실패하면 원본이라도 쓴다.
      const reader = new FileReader();
      reader.onload = () => setImage(reader.result);
      reader.readAsDataURL(file);
    }
  }

  function handleSave() {
    onSave({ text, image });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{stageLabel}</span>
          <button type="button" className="modal-close" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </div>

        {allowImage && (
          <label className="modal-image-drop">
            {image ? (
              <img src={image} alt="첨부 이미지" />
            ) : (
              <span className="modal-image-placeholder">사진 추가</span>
            )}
            <input type="file" accept="image/*" onChange={handleImageChange} hidden />
          </label>
        )}

        <textarea
          className="modal-textarea"
          placeholder="이 시기에 대해 남기고 싶은 이야기를 적어주세요."
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
        />

        <div className="modal-actions">
          <button type="button" className="modal-save" onClick={handleSave}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
