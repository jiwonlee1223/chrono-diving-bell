// 프로필 → 생애 장면 플랜(기본 10단계 × 3장 = 30장).
//
// §1(해석적 자율성) 준수 지점:
//  - LLM으로 "이 사람의 생애를 어떤 서사로 구성할지"를 판단시키지 않는다.
//    장면은 감각적 재료(장소·빛·사물)의 결정론적 조합이고, 감정·의미 서술어를 넣지 않는다.
//  - 이미지 안에 텍스트·자막이 생기지 않도록 프롬프트/네거티브에서 차단한다.
//  - 같은 프로필이면 같은 플랜이 나온다(이름+생년월일 시드). 흩어놓는 재료의 배열일 뿐,
//    서사 완성이 아니다. 의미는 사용자가 멈춰 서서 스스로 읽는다.
//
// 프로필 스키마 (수집 앱은 별도 — todo):
//   { name: string, birthDate: 'YYYY-MM-DD', occupation: string,
//     photos: string[]            — 로컬 파일 경로 2~3장 (첫 장을 레퍼런스로 사용),
//     gender?: 'male'|'female',   — 없으면 레퍼런스 사진에서 자동 감지(gender-detect.js)
//     descriptors?: string[]      — 향후 더 descriptive한 입력 확장 지점 }

// 라이브러리 전체의 시각적 톤 통일 (Flash Back 자산의 필름 사진 톤을 따른다).
export const STYLE =
  'candid documentary photograph, cinematic natural light, 35mm film grain, muted colors, shallow depth of field, no text, no watermark'

// 생애 10단계. Flash Back의 Age Profiles(3~82살)와 같은 골격.
// {occ}는 직업, 장면 문구는 장소·빛·사물만 — 감정 서술 금지.
const STAGES = [
  {
    age: 3,
    scenes: [
      'taking a wobbly step across a living room floor, afternoon sun through a window',
      'sitting in a plastic basin bath, steam and warm light',
      'asleep on a cotton blanket laid on a warm floor',
      'reaching for a toy on a playground sandpit',
      'held on a parent’s back wrapped in a carrier cloth, evening alley'
    ]
  },
  {
    age: 7,
    scenes: [
      'standing at an elementary school gate on the first day, oversized backpack',
      'mid-run on a dusty school field during a sports day relay',
      'crouching in front of a corner stationery shop, coins in hand',
      'riding a bicycle with training wheels down an apartment complex path',
      'drawing with crayons at a low table, papers scattered'
    ]
  },
  {
    age: 14,
    scenes: [
      'sitting by a classroom window, chin on hand, summer light on the desk',
      'walking home at night past shuttered shops, backpack on one shoulder',
      'playing basketball on an outdoor court at dusk',
      'in a crowded school cafeteria holding a steel food tray',
      'lying on a bedroom floor with comic books and a fan'
    ]
  },
  {
    age: 18,
    scenes: [
      'studying alone in a classroom at night, rows of empty desks, fluorescent light',
      'standing before an exam hall gate on a cold early morning, breath visible',
      'throwing a uniform jacket in the air on a graduation day field',
      'looking out a train window on a first trip alone, countryside passing',
      'in a cramped noodle shop with friends after class, steam rising'
    ]
  },
  {
    age: 25,
    scenes: [
      'first day at work as a {occ}, standing at the building entrance in new clothes',
      'carrying boxes into a small one-room apartment, bare walls',
      'asleep at a library desk between stacked books',
      'laughing over grilled food and glasses at a late-night table with friends',
      'checking a phone at a bus stop in the rain under a shared umbrella'
    ]
  },
  {
    age: 32,
    scenes: [
      'working as a {occ}, absorbed, hands mid-task, workplace light',
      'in the office long after dark, one desk lamp on in a dim floor',
      'standing at a wedding hall entrance in formal clothes',
      'hiking a ridge on a weekend morning, city haze below',
      'cooking in a small kitchen, two plates set on the table'
    ]
  },
  {
    age: 45,
    scenes: [
      'a seasoned {occ} at work, showing something to a younger colleague',
      'at a family dinner table, side dishes crowded, steam over rice',
      'waiting in a hospital corridor chair beside an aging parent',
      'photographing a child’s school event from the back row',
      'driving at dawn on an empty highway, coffee in the cup holder'
    ]
  },
  {
    age: 55,
    scenes: [
      'a {occ} of thirty years, tidying up the workspace at the end of a day',
      'tending a small weekend vegetable plot at the city’s edge',
      'walking an old apartment complex path under ginkgo trees',
      'at a class reunion table, faces changed, same laughter mid-toast',
      'reading glasses on, newspaper spread over a low table'
    ]
  },
  {
    age: 68,
    scenes: [
      'a morning walk in a park, retired, hands clasped behind the back',
      'pushing a grandchild on a playground swing',
      'picking vegetables at a traditional market stall, cart in hand',
      'revisiting an old neighborhood, standing before a rebuilt street',
      'napping in an armchair by a sunlit window, radio on'
    ]
  },
  {
    age: 82,
    scenes: [
      'sitting by a window in low afternoon sun, hands resting on knees',
      'aged hands opening an old photo album on a blanket',
      'watering plants in pots on a narrow veranda',
      'in a quiet care-home garden among cosmos flowers',
      'watching first snow through a window, tea steaming'
    ]
  }
]

// mulberry32 — 프로필에서 유도한 시드로 장면 선택을 결정론화한다.
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 프로필의 안정 식별자 (출력 디렉토리·시드에 사용). */
export function personaId(profile) {
  const h = hashString(`${profile.name}|${profile.birthDate}`)
  return `p-${h.toString(16).padStart(8, '0')}`
}

// n개 중 k개 비복원 추출 (결정론적).
function pick(rand, arr, k) {
  const pool = [...arr]
  const out = []
  while (out.length < k && pool.length > 0) {
    out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0])
  }
  return out
}

/**
 * 장면 플랜 생성.
 * @param {object} profile  위 스키마
 * @param {{ perStage?: number, now?: Date }} opts
 * @returns {Array<{ stageIndex, sceneIndex, age, year, isPast, scene, id }>}
 *   id는 Flash Back 파일명 규칙과 같은 "{stage}-{n}" 형태.
 */
export function buildScenePlan(profile, { perStage = 3, now = new Date() } = {}) {
  const birthYear = parseInt(String(profile.birthDate).slice(0, 4), 10)
  if (!Number.isFinite(birthYear)) throw new Error(`birthDate 형식이 잘못됨: ${profile.birthDate} (YYYY-MM-DD)`)
  const rand = mulberry32(hashString(`${profile.name}|${profile.birthDate}|${profile.occupation}`))
  const currentYear = now.getFullYear()

  const plan = []
  STAGES.forEach((stage, si) => {
    const year = birthYear + stage.age
    const isPast = year <= currentYear
    // 과거 단계는 실제 연대의 공기를 입힌다. 미래 단계는 연대를 지정하지 않는다 —
    // 미래의 모습을 시스템이 단정하지 않기 위해 시대 표식을 비워 둔다(§1).
    const era = isPast ? `${Math.floor(year / 10) * 10}s Korea` : 'Korea'
    const chosen = pick(rand, stage.scenes, Math.min(perStage, stage.scenes.length))
    chosen.forEach((sceneTemplate, ci) => {
      const scene = sceneTemplate.replaceAll('{occ}', profile.occupation || 'worker')
      plan.push({
        stageIndex: si,
        sceneIndex: ci + 1,
        id: `${si}-${ci + 1}`,
        age: stage.age,
        year,
        isPast,
        scene: `${scene}, ${era}`
      })
    })
  })
  return plan
}

// 나이에 맞는 성별 명사. gender가 없으면 중립 표현으로 폴백한다.
export function subjectNoun(age, gender) {
  const child = age <= 14
  if (gender === 'male') return child ? 'boy' : 'man'
  if (gender === 'female') return child ? 'girl' : 'woman'
  return child ? 'child' : 'person'
}

// 나이대별 구체적 신체 묘사. "나이를 바꿔라"라는 추상 지시는 Kontext가 무시하므로
// (정체성 보존이 이겨버린다) 바뀌어야 할 물리적 특징을 직접 나열한다. 실서버 검증 결과.
// 성별 명사를 박아 큰 나이 점프에서 성별이 드리프트하는 것도 같이 막는다.
function ageTraits(age, gender) {
  // 아동 명사(boy/girl/child)와 성인 명사(man/woman/person)
  const c = gender === 'male' ? 'boy' : gender === 'female' ? 'girl' : 'child'
  const a = gender === 'male' ? 'man' : gender === 'female' ? 'woman' : 'person'
  if (age <= 4)
    return `a toddler ${c === 'child' ? '' : `${c} `}with a round baby face, chubby cheeks, large eyes, a tiny nose, a completely smooth face without any facial hair, wispy baby hair`
  if (age <= 10)
    return `a young ${c} with a round face, bright eyes, a completely smooth face without any facial hair`
  if (age <= 16)
    return `an adolescent ${c === 'child' ? '' : `${c} `}with youthful smooth skin, no facial hair, soft features`
  if (age <= 22)
    return c === 'child'
      ? 'a teenager with smooth youthful skin and a slim face'
      : `a teenage ${c} with smooth youthful skin and a slim face`
  if (age <= 40) return `a young ${a === 'person' ? 'adult' : a}`
  if (age <= 50) return `a middle-aged ${a} with faint wrinkles and mature features`
  if (age <= 60) return `a middle-aged ${a} with visible wrinkles and graying hair`
  if (age <= 75) return `an elderly ${a} with wrinkles and gray hair`
  return `a very old ${a} with deep wrinkles, thin white hair, and age spots`
}

/**
 * 나이별 포트레이트(1단계)용 지시형 프롬프트 — Flash Back의 Age Profiles에 해당.
 * Kontext는 정체성 보존이 강해 장면 전환과 큰 나이 변화를 한 번에 시키면 나이가 무시된다.
 * 포트레이트만 먼저 나이를 옮겨 놓고, 장면 생성은 그 포트레이트를 레퍼런스로 쓴다(2단계).
 */
export function composeAgePortraitPrompt(profile, age) {
  return (
    `Replace the person with a ${age}-year-old version of the same person: ${ageTraits(age, profile.gender)},` +
    ` wearing a plain white t-shirt. Keep the same facial identity recognizable.` +
    ` A neutral studio portrait photograph, plain light gray background, facing the camera,` +
    ` natural expression, soft even light, photorealistic. no text, no watermark`
  )
}

/** Kontext용 장면 프롬프트(2단계) — 나이별 포트레이트의 인물을 장면에 배치. */
export function composeKontextPrompt(profile, item) {
  const extra = (profile.descriptors || []).join(', ')
  const who = profile.gender ? `${subjectNoun(item.age, profile.gender)}` : ''
  return (
    `Place this person, a ${item.age}-year-old${who ? ` ${who}` : ''}, in a new scene: ${item.scene}.` +
    ` Keep the same facial identity. Full scene visible, person within the environment.` +
    (extra ? ` ${extra}.` : '') +
    ` ${STYLE}`
  )
}

/**
 * Gemini 장면 프롬프트(2단계) — 나이별 포트레이트의 인물을 장면에 배치.
 * Kontext보다 지시 이해력이 좋으므로, 얼굴 정체성은 유지하되 헤어·복장·차림새를
 * 장면 맥락(나이·시대·상황)에 맞게 바꾸라는 지시를 함께 준다 —
 * 포트레이트의 흰 티·스튜디오 배경이 장면으로 새는 것을 막는다.
 * 미래 단계는 "그럴듯한 미래의 한 순간"으로만 힌트 — 감정·의미 서술은 넣지 않는다(§1).
 */
export function composeGeminiScenePrompt(profile, item) {
  const who = `${item.age}-year-old ${subjectNoun(item.age, profile.gender)}`
  const extra = (profile.descriptors || []).join(', ')
  const future = item.isPast
    ? ''
    : ` This is an imagined moment further along in this person's life — keep the appearance a plausible continuation of the reference.`
  return (
    `Using the person in the reference image, create a new photograph of the same person as a ${who} in this scene: ${item.scene}.` +
    ` Keep the same facial identity and features recognizable.` +
    ` Change the hairstyle, clothing, and grooming so they naturally fit the scene, the person's age, and the era —` +
    ` do not keep the plain white t-shirt or the studio background from the reference.` +
    future +
    (extra ? ` ${extra}.` : '') +
    ` Full scene visible, person within the environment. ${STYLE}`
  )
}

/** SDXL 폴백용 서술형 프롬프트 — 인물 일관성 없음. */
export function composeSdxlPrompt(profile, item) {
  const who = `a ${item.age}-year-old Korean ${subjectNoun(item.age, profile.gender)}`
  const extra = (profile.descriptors || []).join(', ')
  return `${who}, ${item.scene}${extra ? `, ${extra}` : ''}, ${STYLE}`
}
