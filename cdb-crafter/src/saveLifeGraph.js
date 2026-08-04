import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { getDownloadURL, ref, uploadBytesResumable } from "firebase/storage";
import { authReady, db, storage } from "./firebase";
import { composeReflectionText, trimAnswers } from "./questions";

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

// 이번에 새로 올려야 하는 사진인지(이미 올라간 https URL은 다시 올리지 않는다).
function isNewUpload(image) {
  return typeof image === "string" && image.startsWith("data:");
}

// 재개형(resumable) 업로드를 쓴다 — 느리거나 자주 끊기는 회선에서 한 번 실패했다고 처음부터
// 다시 올리지 않고 끊긴 지점부터 이어간다. onProgress(0~1)로 진행률을 흘려보낸다.
// contentType을 명시하는 이유: Storage 규칙이 image/* 만 허용한다.
async function uploadImage(image, path, onProgress) {
  if (!isNewUpload(image)) return image || null;
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

// 기존에 저장된 프로필을 불러온다. 없으면 null.
export async function loadProfile(personaId) {
  await authReady;
  const snap = await withTimeout(getDoc(doc(db, "profiles", personaId)), LOAD_TIMEOUT_MS);
  return snap.exists() ? snap.data() : null;
}

// chrono-zoetrope 생성 파이프라인이 읽는 필드 이름 — 바꾸지 않는다(profile-worker.js 참조).
const SESSION_KEY = "first";

// 저장된 문서를 앱 상태로 되돌린다 — 같은 사람이 다시 로그인하면 지난번에 쓴 것이 그대로
// 들어 있는 채로 이어서 진행한다. 사진은 Firestore에 URL(imageURL)로만 남아 있고, 그 URL은
// 다시 제출할 때 재업로드 없이 그대로 통과한다(collectStagePoints의 point.image ?? point.imageURL).
// 세션 맵에는 그래프 점이 아닌 두 답(transition·reflection)도 같은 자리에 들어 있어 키로 걸러낸다.
export function restoreSession(data) {
  const session = data?.[SESSION_KEY];
  if (!session) return null;

  const points = {};
  for (const [stageId, value] of Object.entries(session)) {
    if (stageId === "transition" || stageId === "reflection") continue;
    if (!value || value.x === undefined || value.x === null) continue;
    points[stageId] = {
      x: value.x,
      text: value.text ?? "",
      imageURL: value.imageURL ?? null,
    };
  }

  return {
    points,
    transitionText: session.transition?.text ?? "",
    reflection: { answers: { ...(session.reflection?.answers ?? {}) } },
  };
}

// ── 진행 중 저장(체크포인트) ──────────────────────────────────────────────
// 예전에는 마지막 "저장하기"에서 한 번에 다 올렸다. 그 사이 창이 닫히거나 회선이 끊기면 쓴 게
// 통째로 사라졌고, 사진 여러 장을 끝에 몰아 올리느라 마지막에만 오래 기다려야 했다.
// 이제 로그인할 때 문서를 만들어두고 단계마다 그 자리에서 저장한다.
//
// 제출 표시(`${SESSION_KEY}SubmittedAt`/`Status`)는 여기서 찍지 않는다 — 마지막
// saveInitialProfile에서만 찍는다. 그전까지 이 문서는 admin 큐에 뜨지 않아서
// (admin-server.mjs lifeGraphSessionStatus가 둘 다 없으면 null로 본다) 아직 그리는 중인
// 사람이 생성 대기열에 잘못 올라가지 않는다.

// 로그인 직후 프로필 문서를 만들어(또는 확인해) 둔다. 이 문서가 있어야 이후 단계별 저장이
// 얹힐 자리가 생기고, 다시 로그인했을 때 되살릴 것도 여기에 쌓인다.
export async function ensureProfile({ name, birthDate, age }) {
  await authReady;
  const personaId = personaIdFor({ name, birthDate });
  const profileRef = doc(db, "profiles", personaId);
  const snap = await getDoc(profileRef);

  const data = { personaId, name, birthDate, age, updatedAt: serverTimestamp() };
  if (!snap.exists()) {
    // 보안 규칙이 모든 쓰기에서 first/second/third 중 하나를 요구한다(firebase.rules.txt) —
    // 아직 점이 하나도 없는 첫 문서에는 빈 맵으로 그 자리를 만들어 둔다. 이후 단계별 저장은
    // 이 맵 안에 하나씩 얹힌다. 이미 있는 문서에는 절대 쓰지 않는다 — 빈 맵을 merge로 다시
    // 쓰면 그동안 쌓인 점을 통째로 지울 수 있다.
    data[SESSION_KEY] = {};
  }
  // admin 큐가 createdAt으로 정렬해 읽는다(firestore-source.js listenProfiles) —
  // 이 필드가 없는 문서는 큐에 아예 뜨지 않으므로 없으면 반드시 채운다.
  if (!snap.exists() || !snap.data()?.createdAt) data.createdAt = serverTimestamp();
  await setDoc(profileRef, data, { merge: true });

  return personaId;
}

// 시기 하나를 그 자리에서 저장한다. 새로 고른 사진(data: URL)이면 먼저 올려 URL로 바꾼다.
// @returns {{ imageURL: string|null }} 호출부가 메모리에 든 data: URL을 이 URL로 갈아끼운다 —
//   사진 여러 장을 data: URL로 들고 있으면 태블릿에서 메모리가 금방 무거워진다.
export async function saveStagePoint({ personaId, stageId, point, onProgress }) {
  await authReady;

  const rawImage = point.image ?? point.imageURL;
  const imageURL = rawImage
    ? await uploadImage(rawImage, `profile-photos/${personaId}/${stageId}.jpg`, onProgress)
    : null;

  await setDoc(
    doc(db, "profiles", personaId),
    {
      [SESSION_KEY]: {
        [stageId]: {
          x: point.x,
          text: point.text?.trim() || "",
          imageURL,
        },
      },
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  return { imageURL };
}

// 전환 질문("3일 남았다면") 답변을 그 자리에서 저장한다.
export async function saveTransition({ personaId, text }) {
  const trimmed = text?.trim();
  if (!trimmed) return;
  await authReady;
  await setDoc(
    doc(db, "profiles", personaId),
    { [SESSION_KEY]: { transition: { text: trimmed } }, updatedAt: serverTimestamp() },
    { merge: true },
  );
}

// "지금 죽는다면" 답변을 지금까지 쓴 만큼 저장한다(문항 하나 넘어갈 때마다).
export async function saveReflection({ personaId, reflection }) {
  const reflectionData = buildReflectionData(reflection);
  if (!reflectionData) return;
  await authReady;
  await setDoc(
    doc(db, "profiles", personaId),
    { [SESSION_KEY]: { reflection: reflectionData }, updatedAt: serverTimestamp() },
    { merge: true },
  );
}

// 그래프에 찍힌 점만 { x, text, imageURL }로 남긴다.
// 사진 업로드 실패(네트워크 차단 등)가 제출 전체를 날리지 않게 한다 — 그래프 위치와 글은
// Firestore에만 있으면 되고, 그쪽은 Storage와 별개로 살아 있는 경우가 많다. 실패한 사진은
// 그 점만 사진 없이 저장하고, 어느 시기의 사진이 빠졌는지 호출부에 돌려준다.
async function collectStagePoints(stageList, points, personaId, onProgress) {
  const sessionPoints = {};
  const failedImageStages = [];

  const drawn = stageList.filter((stage) => {
    const point = points[stage.id];
    return point && point.x !== undefined && point.x !== null;
  });
  // 이미 올라간 사진(https URL)은 다시 올리지 않으므로 진행률 분모에서 뺀다.
  const total = drawn.filter((stage) => isNewUpload(points[stage.id].image)).length;
  let done = 0;

  for (const stage of drawn) {
    const point = points[stage.id];
    // point.image는 이번에 새로 고른 data: URL, point.imageURL은 이미 올려진 URL.
    const rawImage = point.image ?? point.imageURL;
    let imageURL = null;
    if (rawImage) {
      try {
        imageURL = await uploadImage(
          rawImage,
          `profile-photos/${personaId}/${stage.id}.jpg`,
          (ratio) =>
            onProgress?.({ current: done + 1, total, stageLabel: stage.label ?? stage.id, ratio }),
        );
      } catch (err) {
        console.error(`사진 업로드 실패 (${stage.id}) — 이 점은 사진 없이 저장합니다.`, err);
        failedImageStages.push(stage.label ?? stage.id);
      }
      if (isNewUpload(rawImage)) done += 1;
    }
    sessionPoints[stage.id] = {
      x: point.x,
      text: point.text?.trim() || "",
      imageURL,
    };
  }

  return { sessionPoints, failedImageStages };
}

// "지금 죽는다면" 답변. 아무것도 안 남겼으면 null(=저장 생략).
// text는 2차 파이프라인이 읽는 합본, answers는 문항별 원본 — 나중에 문항 단위로 다시 꺼내
// 쓸 수 있게 둘 다 남긴다.
function buildReflectionData(reflection) {
  const text = composeReflectionText(reflection);
  if (!text) return null;
  return { text, answers: trimAnswers(reflection?.answers) };
}

// 과거~현재 점을 "first" 필드에 담아 프로필을 만든다. 같은 사람이 다시 로그인해 고쳐 내면
// 같은 문서를 다시 쓴다(restoreSession으로 되살린 내용 위에 덮어쓰는 셈).
// profile: { name, birthDate, age }
// stages: 과거~현재 단계 목록, points: 그 단계들에 찍은 점
// transitionText: 그래프와 "지금 죽는다면" 사이의 전환 질문("3일 남았다면") 답변(선택)
// reflection: "지금 죽는다면" 화면의 답변(선택) — { answers }
export async function saveInitialProfile({
  profile,
  stages,
  points,
  transitionText,
  reflection,
  onProgress,
}) {
  await authReady;
  const { name, birthDate, age } = profile;
  const personaId = personaIdFor({ name, birthDate });
  const profileRef = doc(db, "profiles", personaId);

  // 그래프 점이 아닌 두 답변(전환·지금죽는다면)은 x가 없다 — 같은 맵에 담되 키로 구분한다.
  // 2차 파이프라인은 LIFE_STAGES id만 훑으므로 이 둘은 자연히 건너뛴다.
  const { sessionPoints, failedImageStages } = await collectStagePoints(
    stages,
    points,
    personaId,
    onProgress,
  );

  if (transitionText?.trim()) {
    sessionPoints.transition = { text: transitionText.trim() };
  }

  const reflectionData = buildReflectionData(reflection);
  if (reflectionData) {
    sessionPoints.reflection = reflectionData;
  }

  const data = {
    personaId,
    name,
    birthDate,
    age,
    [SESSION_KEY]: sessionPoints,
    updatedAt: serverTimestamp(),
  };

  const existing = await getDoc(profileRef);
  // admin 큐가 createdAt으로 정렬해 읽는다 — 없는 문서에는 반드시 채운다.
  if (!existing.exists() || !existing.data()?.createdAt) data.createdAt = serverTimestamp();

  // 워커가 지금 이 세션을 생성 중이면 상태를 건드리지 않는다. 'submitted'로 되돌리면 워커가
  // 붙잡고 있는 세션이 큐에 대기로 다시 떠서 상태가 어긋난다. 고쳐 쓴 내용은 그대로 저장되고,
  // 그 내용으로 다시 만들지는 생성이 끝난 뒤 admin에서 판단한다.
  const generating = existing.data()?.[`${SESSION_KEY}Status`] === "generating";
  if (!generating) {
    // admin 큐가 "제출됨"을 감지하는 신호와, 실제로 claim할 수 있는 상태 필드.
    // submitted → generating → done|error 생명주기는 admin-server.mjs가 관리한다.
    data[`${SESSION_KEY}SubmittedAt`] = serverTimestamp();
    data[`${SESSION_KEY}Status`] = "submitted";
  }

  // merge로 쓴다 — 재제출일 때 이 앱이 모르는 필드(2차 파이프라인이 붙이는 생성 결과·오류 등)를
  // 통째로 날리지 않기 위해서다. 점은 UI에서 지울 수 없으므로 세션 맵의 깊은 병합도 안전하다.
  await setDoc(profileRef, data, { merge: true });

  return { personaId, failedImageStages, queued: !generating };
}
