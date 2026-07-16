import { doc, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { getDownloadURL, ref, uploadString } from "firebase/storage";
import { db, storage } from "./firebase";
import { BRANCH_DEFS } from "./stageUtils";

// "1965-01-01" -> "650101"
function toShortBirthDate(birthDate) {
  const [year, month, day] = birthDate.split("-");
  return `${year.slice(2)}${month}${day}`;
}

async function uploadImage(image, path) {
  if (!image || !image.startsWith("data:")) return null;
  const imageRef = ref(storage, path);
  await uploadString(imageRef, image, "data_url");
  return getDownloadURL(imageRef);
}

// stageList의 각 단계 중 텍스트가 있는 점만 { stage, x, text } 형태로 뽑는다.
function collectStageEntries(stageList, points) {
  const entries = [];
  stageList.forEach((stage) => {
    const point = points[stage.id];
    if (point?.text?.trim()) {
      entries.push({ stage: stage.label, x: point.x ?? null, text: point.text.trim() });
    }
  });
  return entries;
}

// profile: { name, birthDate, age }
// stages: 과거~현재 단계 목록 (마지막이 현재), futureStages: 갈래가 공유하는 미래 단계
// points: 과거~현재 점, branches: { [branchId]: { points } }
export async function saveLifeGraph({ profile, stages, futureStages, points, branches }) {
  const { name, birthDate } = profile;
  const personaId = `${name}_${toShortBirthDate(birthDate)}`;
  const profileRef = doc(db, "profiles", personaId);

  const pastStages = stages.slice(0, -1);
  const presentStage = stages[stages.length - 1];

  const past = collectStageEntries(pastStages, points);
  const presentPoint = points[presentStage.id];
  const present =
    presentPoint?.text?.trim()
      ? { stage: presentStage.label, x: presentPoint.x ?? null, text: presentPoint.text.trim() }
      : null;

  const future = {};
  for (const branch of BRANCH_DEFS) {
    future[branch.id] = collectStageEntries(futureStages, branches[branch.id].points);
  }

  // 사진은 (지금은) 구조 안 나누고 과거->현재->갈래별 미래 순서로 평평하게 모은다.
  const photoSourcePoints = [
    ...stages.map((s) => points[s.id]),
    ...BRANCH_DEFS.flatMap((b) => futureStages.map((s) => branches[b.id].points[s.id])),
  ];
  const photoURLs = [];
  for (const [index, point] of photoSourcePoints.entries()) {
    if (point?.image?.startsWith("data:")) {
      const url = await uploadImage(point.image, `profile-photos/${personaId}/${index}.jpg`);
      if (url) photoURLs.push(url);
    }
  }

  // Firestore 규칙이 profiles 컬렉션 읽기를 막아놔서(allow read: if false) 미리 getDoc으로
  // 문서 존재 여부를 확인할 수 없다. 대신 update를 먼저 시도해서 — 문서가 이미 있으면
  // update가 성공(createdAt 보존)하고, 없으면 not-found로 실패하니 그때만 새로 만들며
  // createdAt을 채운다.
  const data = { personaId, name, birthDate, photoURLs, past, present, future };
  try {
    await updateDoc(profileRef, data);
  } catch (err) {
    if (err.code === "not-found") {
      await setDoc(profileRef, { ...data, createdAt: serverTimestamp() });
    } else {
      throw err;
    }
  }

  return personaId;
}
