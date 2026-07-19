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

// 세로축 단위: 나이대가 아니라 인생의 생애주기(mode of life)로 구분한다.
export const LIFE_STAGES = [
  { id: "protect", label: "보호기", sublabel: "0~7세", maxAge: 7 },
  { id: "growth", label: "성장기", sublabel: "8~19세", maxAge: 19 },
  { id: "independence", label: "독립기", sublabel: "20대 초중반", maxAge: 24 },
  { id: "settling", label: "정착기", sublabel: "20대 후반~30대", maxAge: 39 },
  { id: "responsibility", label: "책임기", sublabel: "30대~50대", maxAge: 54 },
  { id: "transition", label: "전환기", sublabel: "50대~60대", maxAge: 64 },
  { id: "settlement", label: "정리기", sublabel: "60대 이후", maxAge: Infinity },
];

// 사용자가 입력한 나이를 기준으로 보호기~현재 단계 목록을 만든다.
// 나이는 "지금이 전체 생애주기 중 어디인지"만 정하는 용도이고, 그 뒤 단계는 전부 미래로 넘어간다.
export function computeStages(age) {
  const reachedIndex = LIFE_STAGES.findIndex((s) => age <= s.maxAge);
  const lastIndex = reachedIndex === -1 ? LIFE_STAGES.length - 1 : reachedIndex;

  return LIFE_STAGES.slice(0, lastIndex + 1).map((s) => ({
    id: s.id,
    label: s.label,
    sublabel: s.sublabel,
  }));
}

// 미래는 이제 타입을 구분하지 않는다. 한 번 로그인할 때마다(=한 세션마다) 미래를 하나씩
// 이어 그리고, 최대 세 번까지 쌓인다. 각 세션의 미래는 색으로만 구분한다.
export const MAX_FUTURE_SESSIONS = 3;

export const FUTURE_COLORS = ["#ffcf5c", "#3fc5ff", "#c774ff"];

// 과거~현재(pastStages) 이후 남은 생애주기 단계 전부를 미래로 넘긴다 — 보간하지 않으므로
// "정착기" 같은 단계가 계산 중 건너뛰어지는 일이 없다. 모든 갈래가 이 같은 시점들을 공유한다.
export function computeFutureStages(pastStages) {
  return LIFE_STAGES.slice(pastStages.length).map((s) => ({
    id: `future-${s.id}`,
    label: s.label,
    sublabel: s.sublabel,
  }));
}
