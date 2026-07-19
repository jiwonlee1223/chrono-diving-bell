import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { getDownloadURL, ref, uploadString } from "firebase/storage";
import { db, storage } from "./firebase";

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

async function uploadImage(image, path) {
  if (!image || !image.startsWith("data:")) return image || null;
  const imageRef = ref(storage, path);
  await uploadString(imageRef, image, "data_url");
  return getDownloadURL(imageRef);
}

// 세션 하나(첫번째/두번째/세번째)는 과거~현재~그 세션의 미래를 통째로 담는다.
// stageList 순서대로 훑으며 x가 찍힌 점만 { x, text, imageURL }로 남긴다 (이미지는
// 과거~현재만 해당 — 미래는 사진을 안 받음).
// 과거~현재 사진은 세션이 바뀌어도 같은 사진이라 personaId+stageId로만 경로를 잡는다
// (세션 폴더로 나누면 같은 사진을 세 번 올리게 됨). point.image는 이번에 새로 고른
// data: URL, point.imageURL은 이전 세션에서 이미 올려진 URL — 둘 중 있는 걸 쓴다.
async function collectSessionPoints(stageList, points, personaId) {
  const sessionPoints = {};
  for (const stage of stageList) {
    const point = points[stage.id];
    if (!point || point.x === undefined || point.x === null) continue;
    const rawImage = point.image ?? point.imageURL;
    const imageURL = rawImage
      ? await uploadImage(rawImage, `profile-photos/${personaId}/${stage.id}.jpg`)
      : null;
    sessionPoints[stage.id] = { x: point.x, text: point.text?.trim() || "", imageURL };
  }
  return sessionPoints;
}

// 기존에 저장된 프로필을 불러온다. 없으면 null.
export async function loadProfile(personaId) {
  const snap = await withTimeout(getDoc(doc(db, "profiles", personaId)), LOAD_TIMEOUT_MS);
  return snap.exists() ? snap.data() : null;
}

export const SESSION_KEYS = ["first", "second", "third"];

// 세션 1: 과거~현재~미래1을 통째로 "first" 필드에 담아 새 프로필을 만든다.
// profile: { name, birthDate, age }
// stages: 과거~현재 단계 목록, futureStages: 미래 단계
// points: 과거~현재 점, futurePoints: 이번에 그린 첫 미래의 점
export async function saveInitialProfile({ profile, stages, futureStages, points, futurePoints }) {
  const { name, birthDate, age } = profile;
  const personaId = personaIdFor({ name, birthDate });
  const profileRef = doc(db, "profiles", personaId);

  const merged = { ...points, ...futurePoints };
  const sessionPoints = await collectSessionPoints([...stages, ...futureStages], merged, personaId);

  const data = {
    personaId,
    name,
    birthDate,
    age,
    [SESSION_KEYS[0]]: sessionPoints,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await setDoc(profileRef, data);

  return personaId;
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
}) {
  const profileRef = doc(db, "profiles", personaId);
  const key = SESSION_KEYS[sessionIndex];

  const merged = { ...pastPresentPoints, ...futurePoints };
  const sessionPoints = await collectSessionPoints([...stages, ...futureStages], merged, personaId);

  await updateDoc(profileRef, {
    [key]: sessionPoints,
    updatedAt: serverTimestamp(),
  });

  return personaId;
}
