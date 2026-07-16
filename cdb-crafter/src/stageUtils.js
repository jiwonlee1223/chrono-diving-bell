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

// 현재 이후 갈라지는 네 갈래의 미래 (각 갈래 모두 같은 3개 시기를 공유하며, 이 순서대로 안내한다)
export const BRANCH_DEFS = [
  { id: "normal", label: "평범한 미래", prompt: "평범한 미래를 상상하며 그려주세요." },
  { id: "positive", label: "긍정적 미래", prompt: "긍정적인 미래를 상상하며 그려주세요." },
  { id: "negative", label: "부정적 미래", prompt: "부정적인 미래를 상상하며 그려주세요." },
  { id: "unexpected", label: "예기치못한 미래", prompt: "예기치못한 미래를 상상하며 그려주세요." },
];

export const BRANCH_COLORS = {
  positive: "#3fc5ff",
  negative: "#c774ff",
  normal: "#ffcf5c",
  unexpected: "#4ff0a8",
};

// 과거~현재(pastStages) 이후 남은 생애주기 단계 전부를 미래로 넘긴다 — 보간하지 않으므로
// "정착기" 같은 단계가 계산 중 건너뛰어지는 일이 없다. 모든 갈래가 이 같은 시점들을 공유한다.
export function computeFutureStages(pastStages) {
  return LIFE_STAGES.slice(pastStages.length).map((s) => ({
    id: `future-${s.id}`,
    label: s.label,
    sublabel: s.sublabel,
  }));
}
