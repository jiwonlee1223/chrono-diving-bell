// 가로축(긍정-부정) 칸 정의: 왼쪽이 negative, 오른쪽이 positive
export const COLUMN_LABELS = [
  "매우 부정",
  "부정",
  "약간 부정",
  "보통",
  "약간 긍정",
  "긍정",
  "매우 긍정",
];

export const COLUMN_COUNT = COLUMN_LABELS.length;

// 생년월일은 날짜 선택기 대신 숫자 8자리로 받는다 — 달력 UI로 70년 전을 찾아가는 것보다
// "19650101"을 그대로 치는 게 빠르다. 여기서 그 8자리를 앱 내부 표기("1965-01-01")로 옮긴다.
// 형식이 틀렸거나 없는 날짜(2월 30일 등)거나 미래면 null.
export function parseBirthDate(digits) {
  if (!/^\d{8}$/.test(digits)) return null;

  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));

  // new Date(2001, 1, 30)은 에러 대신 3월 2일로 넘어간다 — 넘어갔으면 없는 날짜였다는 뜻이다.
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  if (date > new Date()) return null;

  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

export function calculateAge(birthDateStr) {
  const birth = new Date(birthDateStr);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const hasHadBirthdayThisYear =
    today.getMonth() > birth.getMonth() ||
    (today.getMonth() === birth.getMonth() && today.getDate() >= birth.getDate());
  if (!hasHadBirthdayThisYear) age -= 1;
  return age;
}

// 세로축 단위: 나이 구간을 촘촘하게 나눠 15구간으로 쪼갠다 (maxAge 기준 확정값).
const STAGE_MAX_AGES = [3, 9, 15, 22, 28, 34, 40, 47, 53, 59, 65, 71, 78, 84, 90];

export const LIFE_STAGES = STAGE_MAX_AGES.map((maxAge, i) => {
  const minAge = i === 0 ? 0 : STAGE_MAX_AGES[i - 1] + 1;
  return { id: `age-${maxAge}`, label: `${minAge}~${maxAge}세`, maxAge };
});

// 사용자가 입력한 나이를 기준으로 과거~현재 단계 목록을 만든다.
// 마지막 단계(=지금 나이가 속한 구간)는 그 구간의 나이대 이름 대신 "현재"로 표시한다.
export function computeStages(age) {
  const reachedIndex = LIFE_STAGES.findIndex((s) => age <= s.maxAge);
  const lastIndex = reachedIndex === -1 ? LIFE_STAGES.length - 1 : reachedIndex;

  const stages = LIFE_STAGES.slice(0, lastIndex + 1).map((s) => ({
    id: s.id,
    label: s.label,
  }));
  const present = stages[stages.length - 1];
  present.sublabel = present.label;
  present.label = "현재";
  return stages;
}

