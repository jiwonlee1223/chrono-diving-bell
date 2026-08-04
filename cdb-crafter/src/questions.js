// 임종체험 기반 질문 세트 (임종체험_기반_질문설계.md).
//
// 문서의 두 그룹을 그대로 옮겼다.
//   - 자서전 + 질문모음(회고형) → 인생그래프의 시기별 질문 (STAGE_QUESTIONS)
//   - 편지 + 묘비명 + 전사본 입관체험 멘트 → "지금 죽는다면" (REFLECTION_FIELDS)
//   - 그 사이를 잇는 전환 질문 (TRANSITION_QUESTION) — "3일 남았다"는 상황을 먼저 깔아준다.
//
// CLAUDE.md §1(해석적 자율성): 질문은 재료를 꺼내게 할 뿐 그 삶의 의미를 대신 말하지 않는다.
// 모든 문항은 필수다 — 시기별 점은 사진과 글이 모두 있어야 하고, 전환 질문과 마지막 문항도
// 빠짐없이 채워야 다음으로 넘어간다.

// 시기별 질문 — 학습지 질문의 범위를 "이 시기"로 좁혀 구간마다 하나씩 배치했다.
// 키는 stageUtils.js의 LIFE_STAGES id와 1:1로 맞춰야 한다(구간이 바뀌면 여기도 같이 고칠 것).
export const STAGE_QUESTIONS = {
  "age-3": "태어난 곳과 그때 가족의 모습은 어땠나요?",
  "age-9": "가장 오래된 기억 속 장면과, 그때 함께 있던 사람은?",
  "age-15": "가장 친했던 친구나 기억에 남는 사람, 그때 자랑스러웠던 일은?",
  "age-22": "이 시기 가장 큰 고민이나 선택은 무엇이었나요?",
  "age-28": "이 시기 가장 몰입했던 일은 무엇이었나요?",
  "age-34": "이 시기 내 인생의 가장 큰 뉴스는 무엇이었나요?",
  "age-40": "이 시기 가장 소중했던 것, 가장 감사했던 일은?",
  "age-47": "이 시기 내 삶에서 배운 가장 큰 교훈은 무엇인가요?",
  "age-53": "가장 자랑스러운 일과 가장 아쉬운 일은?",
  "age-59": "아직 마음이 풀리지 않은 사람이 있나요?",
  "age-65": "이 시기 내 삶의 가장 큰 기쁨은 무엇이었나요?",
  "age-71": "요즘 하루 중 가장 감사한 순간은 언제인가요?",
  "age-78": "지금 가장 고마운 사람은 누구인가요?",
  "age-84": "가장 소중했던 순간과, 아직 남은 미련은?",
  "age-90": "가장 먼저 떠오르는 사람과, 하고 싶은 말은?",
};

// 구간 id에 질문이 없을 때를 대비한 기본 문구 — 구간 정의만 바뀌고 질문이 안 따라온 경우에도
// 입력칸이 빈 채로 뜨지 않게 한다.
const STAGE_QUESTION_FALLBACK = "이 시기 하면 가장 먼저 떠오르는 장면은?";

export function stageQuestionFor(stageId) {
  return STAGE_QUESTIONS[stageId] ?? STAGE_QUESTION_FALLBACK;
}

// 그래프 → "지금 죽는다면"으로 넘어가는 전환 질문.
// 학습지 원문은 "6개월"이지만 전사본2 32:02("나에게 3일의 시간이 남았습니다")에 맞춰 3일로 뒀다.
// 뒤에 오는 고마운 사람·후회 질문들이 전부 이 "3일" 설정 위에서 나온 것이라, 이 질문이
// 상황을 먼저 깔아주는 자리다.
// lead(상황을 까는 가정)를 크게, prompt(실제로 묻는 것)를 작게 두 단으로 보여준다.
export const TRANSITION_QUESTION = {
  key: "threeDays",
  lead: "나에게 삶이 3일밖에 남지 않았다면,",
  prompt: "꼭 하고 싶은 일, 가고 싶은 곳, 만나고 싶은 사람은?",
  placeholder: "떠오르는 것을 순서 없이 적어 봅니다.",
};

// 부고는 사용자가 채우는 게 아니라 이미 아는 사실(나이·오늘 날짜)만으로 조립해 화면에 띄운다.
// §1(해석적 자율성)을 지키려면 여기에 "어떤 사람이었다" 같은 판단이 들어가서는 안 된다 —
// 그 삶이 무엇이었는지는 이어지는 질문에서 본인이 말할 몫이다.
// 뒷부분(장례식 조망)은 전사본2 36:51~38:47의 진행자 멘트를 따랐다. 이건 그 사람의 삶에
// 대한 판단이 아니라 임사체험이라는 설치 전체의 고정 프레임이고, 그 자리에서 무엇이
// 떠오르는지는 이어지는 질문에서 본인이 답한다.
export function buildObituaryText(age, today = new Date()) {
  const date = `${today.getFullYear()}년 ${today.getMonth() + 1}월 ${today.getDate()}일`;
  return [
    `나는 오늘 ${age}세를 일기로 세상을 떠났다.`,
    `${date}, 나의 시간은 여기서 멈췄다.`,
    "",
    "몸을 떠나, 조금 위에서 나를 내려다본다.",
    "사람들이 하나둘 모여 앉는다.",
    "누군가는 울고, 누군가는 말없이 앉아 있다.",
    "",
    "지나온 시간이 천천히 떠오른다.",
  ].join("\n");
}

// "지금 죽는다면"의 서술형 문항 — 앞 넷은 전사본 입관체험 멘트, 뒤 둘은 마지막 편지와 묘비명.
// 한 화면에 하나씩 순서대로 묻는다(ReflectionScreen).
export const REFLECTION_FIELDS = [
  {
    key: "person",
    label: "가장 먼저 떠오르는 사람",
    prompt: "지금 가장 먼저 떠오르는 사람은?",
    placeholder: "이름이나 관계를 적어 봅니다.",
  },
  {
    key: "regret",
    label: "가장 후회되는 것",
    prompt: "지금 가장 후회되는 것은?",
    placeholder: "미루지 말았어야 할 일을 떠올려 봅니다.",
  },
  {
    key: "precious",
    label: "가장 소중했던 것",
    prompt: "지난 삶에서 가장 소중했던 것은?",
    placeholder: "사람도, 시간도, 물건도 좋습니다.",
  },
  {
    key: "reborn",
    label: "다시 태어난다면",
    prompt: "다시 태어난다면 어떤 삶을 살고 싶나요?",
    placeholder: "어디서, 누구와, 무엇을 하며 살고 싶은지 적어 봅니다.",
  },
  {
    key: "letter",
    label: "마지막으로 남기고 싶은 말",
    prompt: "마지막으로 남기고 싶은 말은?",
    placeholder: "누구에게 하는 말이어도 좋습니다.",
    rows: 4,
  },
  {
    key: "epitaph",
    label: "나를 한 문장으로",
    prompt: "나를 한 문장으로 남긴다면?",
    placeholder: "묘비에 새긴다고 생각하고 적어 봅니다.",
  },
];

// 빈 답과 앞뒤 공백을 털어낸 답만 남긴다 — Firestore에 빈 문자열을 쌓지 않기 위해서다.
export function trimAnswers(answers) {
  const cleaned = {};
  for (const [key, value] of Object.entries(answers ?? {})) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) cleaned[key] = trimmed;
  }
  return cleaned;
}

// "지금 죽는다면"은 문항 하나도 비울 수 없다.
export function isReflectionComplete(answers) {
  const cleaned = trimAnswers(answers);
  return REFLECTION_FIELDS.every((field) => cleaned[field.key]);
}

// 문항별 답을 한 줄 문자열로 합친다. 2차 파이프라인(chrono-zoetrope life-graph-plan.js)이
// 점마다 text 하나만 읽어 LLM 프롬프트에 꽂기 때문에, 구조화된 답과 별개로 이 합본을 함께 저장한다.
// 라벨을 붙여 두면 어떤 질문에 대한 답인지가 프롬프트에서도 유지된다.
export function composeReflectionText({ answers } = {}) {
  const cleaned = trimAnswers(answers);
  return REFLECTION_FIELDS.map((field) =>
    cleaned[field.key] ? `${field.label}: ${cleaned[field.key]}` : null,
  )
    .filter(Boolean)
    .join(" / ");
}
