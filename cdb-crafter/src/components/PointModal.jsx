import { useEffect, useRef, useState } from "react";
import heic2any from "heic2any";

const MAX_DIMENSION = 1280;
const JPEG_QUALITY = 0.82;

// 아이폰이 기본으로 찍는 HEIC/HEIF는 브라우저(<img>/Image())가 대부분 못 읽는다 —
// 캔버스에 그리기 전에 JPEG로 먼저 변환해야 한다. 파일 타입이 비표준이라 자주 비어있으니
// 확장자도 같이 본다.
function isHeic(file) {
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  return type.includes("heic") || type.includes("heif") || name.endsWith(".heic") || name.endsWith(".heif");
}

async function toWebSafeFile(file) {
  if (!isHeic(file)) return file;
  const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
  // 드물게 멀티 이미지 HEIC는 배열로 온다 — 첫 장만 쓴다.
  return Array.isArray(converted) ? converted[0] : converted;
}

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
  // textarea에서 글을 드래그로 선택하다가 커서가 배경(backdrop) 위로 나가서 놓이면, 그 click의
  // target이 backdrop이 되어 버려 모달이 닫혀버린다. mousedown이 실제로 backdrop 자체에서
  // 시작했을 때만 닫히게 해서 이 오작동을 막는다.
  const mouseDownOnBackdrop = useRef(false);

  useEffect(() => {
    setText(point?.text ?? "");
    setImage(point?.image ?? "");
  }, [point]);

  async function handleImageChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setImage(await compressImage(await toWebSafeFile(file)));
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
