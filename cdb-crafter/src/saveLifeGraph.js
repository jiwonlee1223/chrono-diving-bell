import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { getDownloadURL, ref, uploadBytesResumable } from "firebase/storage";
import { authReady, db, storage } from "./firebase";

// "1965-01-01" -> "650101"
function toShortBirthDate(birthDate) {
  const [year, month, day] = birthDate.split("-");
  return `${year.slice(2)}${month}${day}`;
}

export function personaIdFor({ name, birthDate }) {
  return `${name}_${toShortBirthDate(birthDate)}`;
}

const LOAD_TIMEOUT_MS = 10000;

// Firestore SDK가 네트워크·설정 문제로 요청을 그냥 계속 물고 있을 때(에러도 안 던지고
// 응답도 안 옴) 로그인 화면이 "확인하는 중..."에서 영원히 멈추는 걸 막는다.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

// uploadBytesResumable은 data: URL 문자열이 아니라 바이트를 받는다.
function dataUrlToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(",");
  const contentType = header.match(/:(.*?);/)?.[1] || "image/jpeg";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: contentType });
}

// 재개형(resumable) 업로드를 쓴다 — 느리거나 자주 끊기는 회선에서 한 번 실패했다고 처음부터
// 다시 올리지 않고 끊긴 지점부터 이어간다. onProgress(0~1)로 진행률을 흘려보낸다.
// contentType을 명시하는 이유: Storage 규칙이 image/* 만 허용한다.
async function uploadImage(image, path, onProgress) {
  if (!image || !image.startsWith("data:")) return image || null;
  const blob = dataUrlToBlob(image);
  const task = uploadBytesResumable(ref(storage, path), blob, { contentType: blob.type });
  await new Promise((resolve, reject) => {
    task.on(
      "state_changed",
      (snap) => {
        if (snap.totalBytes > 0) onProgress?.(snap.bytesTransferred / snap.totalBytes);
      },
      reject,
      resolve,
    );
  });
  return getDownloadURL(task.snapshot.ref);
}

// 세션 하나(첫번째/두번째/세번째)는 과거~현재~그 세션의 미래를 통째로 담는다.
// stageList 순서대로 훑으며 x가 찍힌 점만 { x, text, imageURL }로 남긴다 (이미지는
// 과거~현재만 해당 — 미래는 사진을 안 받음).
// 과거~현재 사진은 세션이 바뀌어도 같은 사진이라 personaId+stageId로만 경로를 잡는다
// (세션 폴더로 나누면 같은 사진을 세 번 올리게 됨). point.image는 이번에 새로 고른
// data: URL, point.imageURL은 이전 세션에서 이미 올려진 URL — 둘 중 있는 걸 쓴다.
// 사진 업로드 실패(네트워크 차단 등)가 세션 전체를 날리지 않게 한다 — 그래프 위치와 글은
// Firestore에만 있으면 되고, 그쪽은 Storage와 별개로 살아 있는 경우가 많다. 실패한 사진은
// 그 점만 사진 없이 저장하고, 어느 시기의 사진이 빠졌는지 호출부에 돌려준다.
async function collectSessionPoints(stageList, points, personaId, onProgress) {
  const sessionPoints = {};
  const failedImageStages = [];

  // 이미 올라간 사진(https URL)은 다시 올리지 않으므로 진행률 분모에서 뺀다.
  const pending = stageList.filter((stage) => {
    const point = points[stage.id];
    if (!point || point.x === undefined || point.x === null) return false;
    return (point.image ?? point.imageURL ?? "").startsWith("data:");
  });
  const total = pending.length;
  let done = 0;

  for (const stage of stageList) {
    const point = points[stage.id];
    if (!point || point.x === undefined || point.x === null) continue;
    const rawImage = point.image ?? point.imageURL;
    const isNewUpload = (rawImage ?? "").startsWith("data:");
    let imageURL = null;
    if (rawImage) {
      try {
        imageURL = await uploadImage(rawImage, `profile-photos/${personaId}/${stage.id}.jpg`, (ratio) =>
          onProgress?.({ current: done + 1, total, stageLabel: stage.label ?? stage.id, ratio }),
        );
      } catch (err) {
        console.error(`사진 업로드 실패 (${stage.id}) — 이 점은 사진 없이 저장합니다.`, err);
        failedImageStages.push(stage.label ?? stage.id);
      }
      if (isNewUpload) done += 1;
    }
    sessionPoints[stage.id] = { x: point.x, text: point.text?.trim() || "", imageURL };
  }
  return { sessionPoints, failedImageStages };
}

// 기존에 저장된 프로필을 불러온다. 없으면 null.
export async function loadProfile(personaId) {
  await authReady;
  const snap = await withTimeout(getDoc(doc(db, "profiles", personaId)), LOAD_TIMEOUT_MS);
  return snap.exists() ? snap.data() : null;
}

export const SESSION_KEYS = ["first", "second", "third"];

// 세션 1: 과거~현재~미래1을 통째로 "first" 필드에 담아 새 프로필을 만든다.
// profile: { name, birthDate, age }
// stages: 과거~현재 단계 목록, futureStages: 미래 단계
// points: 과거~현재 점, futurePoints: 이번에 그린 첫 미래의 점
export async function saveInitialProfile({
  profile,
  stages,
  futureStages,
  points,
  futurePoints,
  onProgress,
}) {
  await authReady;
  const { name, birthDate, age } = profile;
  const personaId = personaIdFor({ name, birthDate });
  const profileRef = doc(db, "profiles", personaId);

  const merged = { ...points, ...futurePoints };
  const { sessionPoints, failedImageStages } = await collectSessionPoints(
    [...stages, ...futureStages],
    merged,
    personaId,
    onProgress,
  );

  const data = {
    personaId,
    name,
    birthDate,
    age,
    [SESSION_KEYS[0]]: sessionPoints,
    // admin 큐가 "제출됨"을 감지하는 신호 — 세션마다 따로 찍혀야 admin에 세션별로 한 줄씩 뜬다.
    [`${SESSION_KEYS[0]}SubmittedAt`]: serverTimestamp(),
    // admin이 실제로 claim(생성 시작)할 수 있는 상태 필드. submitted → generating → done|error로
    // admin-server.mjs가 관리한다 — 여기서는 최초 제출만 표시한다.
    [`${SESSION_KEYS[0]}Status`]: "submitted",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await setDoc(profileRef, data);

  return { personaId, failedImageStages };
}

// 세션 2, 3: 과거~현재(이전 세션과 동일한 값)와 새 미래를 통째로 "second"/"third" 필드에 담는다.
// pastPresentPoints: 직전 세션에서 불러온 과거~현재 점 (수정 없이 그대로 다시 담김).
// sessionIndex: 1이면 second, 2면 third.
export async function saveFollowUpSession({
  personaId,
  sessionIndex,
  stages,
  futureStages,
  pastPresentPoints,
  futurePoints,
  onProgress,
}) {
  await authReady;
  const profileRef = doc(db, "profiles", personaId);
  const key = SESSION_KEYS[sessionIndex];

  const merged = { ...pastPresentPoints, ...futurePoints };
  const { sessionPoints, failedImageStages } = await collectSessionPoints(
    [...stages, ...futureStages],
    merged,
    personaId,
    onProgress,
  );

  await updateDoc(profileRef, {
    [key]: sessionPoints,
    [`${key}SubmittedAt`]: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return { personaId, failedImageStages };
}
