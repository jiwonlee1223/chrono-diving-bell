// 폰에서 고른 사진을 그대로 올리면 한 장에 5~10MB라 현장 회선에서 업로드가 몇 분씩 걸린다.
// 긴 변을 MAX_EDGE로 줄이고 JPEG로 다시 인코딩해 한 장을 수백 KB 수준으로 낮춘다.
// 2차 파이프라인이 이 사진을 레퍼런스로만 쓰기 때문에 이 해상도로 충분하다.
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

// createImageBitmap의 imageOrientation 옵션은 브라우저에 따라 없을 수 있다(구형 사파리).
// 그 경우 <img>로 우회한다 — 요즘 브라우저는 img 디코드 단계에서 EXIF 회전을 반영한다.
async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

// 파일 하나를 화면에 바로 띄울 수 있고 Storage에 그대로 올릴 수 있는 data: URL로 만든다.
export async function processImageFile(file) {
  const source = await decode(file);
  const width = source.width ?? source.naturalWidth;
  const height = source.height ?? source.naturalHeight;

  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);

  const ctx = canvas.getContext("2d");
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();

  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}
