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

// 라이브러리 전체의 시각적 톤 통일 (Flash Back 자산의 필름 사진 톤 + 부드럽고 따뜻한 빛).
// 소용돌이 보케는 빈티지 렌즈 질감 — 프롬프트로 잘 먹힌다. 가장자리 방사형 블러·비네트는
// 여기 넣지 않는다: 생성 모델이 불안정하게 처리하므로 렌더러 포스트 셰이더에서 건다
// (FREEZE→IMMERSION에서 블러가 걷히는 전환도 셰이더 유니폼으로 만든다).
export const STYLE =
  'candid documentary photograph, soft warm natural light, 35mm film grain, muted colors, shallow depth of field with gentle swirly bokeh, photorealistic, no text, no watermark'

// §1(해석적 자율성)·라인6: 이미지 안에 글자·숫자가 생기면 direct delivery가 된다. Gemini는
// 태그("no text")보다 지시형 문장에 강하게 반응하므로, 프롬프트 끝에 명시적 금지문을 붙인다.
// 간판·표지판·시계·책 등도 글자 없이 빈 채로 두게 한다.
export const NO_TEXT_DIRECTIVE =
  ' Absolutely no text, letters, numbers, words, captions, subtitles, watermarks, signatures or logos anywhere in the image.' +
  ' Any signs, posters, books, screens or clocks must be blank and free of writing or digits.'

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

// ── 3인칭 관조(부감) 구도 — 크리스마스 캐롤의 스크루지가 자기 삶을 내려다보듯 ──────────
// 모든 장면은 그 순간을 약간 위에서 내려다보는 3인칭 부감(high angle)으로 본다. 관람객은
// 자기 삶의 한 장면을 바깥에서, 조금 떨어진 위쪽에서 관조한다. 이 부감 구도가 필수다.
//  1. 주인공은 화면 중심에 보이고, 자기 얼굴도 드러난다(초점 안).
//  2. 주인공을 제외한 모든 인물의 얼굴은 붓으로 문질러 지운 듯 매끄럽게 뭉개 흐릿하게 —
//     특징 없는 얼룩처럼. 기형·왜곡이 아니라(그로테스크 금지) 그저 지워진 붓자국.
//     "blurry face"라고 직접 쓰면 뭉개진 기형이 나오기 쉬워, smeared / wiped away like a
//     brushstroke / painterly featureless smudge, not distorted 로 우회해 표현한다.
// 감각적 지시일 뿐 감정·의미 서술이 아니다(§1). 가장자리 방사형 블러는 렌더러 셰이더 몫.
// 주의(이력 역전): POV(1인칭·주인공 비가시)에서 이 3인칭 구도로 되돌린 것이라, 아동 나이
// 얼굴 생성이 걸리던 Gemini IMAGE_SAFETY를 다시 노출할 수 있다. 서버 복구 후 첫 생성에서
// 아동 단계(3·7·14살) 차단 여부를 반드시 확인할 것.

/**
 * Kontext용 장면 프롬프트 — 3인칭 부감 전환. 편집 모델이라 입력(레퍼런스) 이미지가 있어
 * 주인공 얼굴 정체성을 살릴 수 있으나, 아동 나이에서 IMAGE_SAFETY 위험이 있다 — gemini가 주 경로, 이건 폴백.
 */
export function composeKontextPrompt(profile, item) {
  const extra = (profile.descriptors || []).join(', ')
  const who = `a ${item.age}-year-old ${subjectNoun(item.age, profile.gender)}`
  return (
    `Transform this into a high-angle third-person photograph taken from clearly above the scene,` +
    ` the camera raised well above head height and tilted downward, looking down on the moment from an elevated vantage point,` +
    ` the floor or ground filling much of the frame, as if observing a memory from above.` +
    ` ${who} is the central subject, clearly visible in this moment seen from above: ${item.scene}.` +
    ` Keep this main person's own face visible and in focus.` +
    ` Every other person's face is wiped away like a smear of paint — smooth, soft, blurred, featureless,` +
    ` painterly, as if brushed out, not distorted and not grotesque, simply an indistinct smudge.` +
    (extra ? ` ${extra}.` : '') +
    ` ${STYLE}`
  )
}

/**
 * Gemini 장면 프롬프트 — 3인칭 부감(관조) 구도. 크리스마스 캐롤의 스크루지가 자기 삶을
 * 위에서 내려다보듯, 그 순간을 약간 위·바깥에서 관조한다. 주인공은 보이고 자기 얼굴도 드러나며,
 * 나머지 인물의 얼굴은 붓으로 지운 듯 뭉갠다. 레퍼런스 이미지는 쓰지 않는다(순수 텍스트→이미지).
 * 미래 단계는 "그럴듯한 미래의 한 순간"으로만 힌트 — 감정·의미 서술은 넣지 않는다(§1).
 */
export function composeGeminiScenePrompt(profile, item) {
  const who = `a ${item.age}-year-old ${subjectNoun(item.age, profile.gender)}`
  const extra = (profile.descriptors || []).join(', ')
  const future = item.isPast
    ? ''
    : ` This is an imagined moment further along in this person's life.`
  // 샷 타입 선언(강한 부감·3인칭)을 맨 앞에 — 카메라 위치를 먼저 확정해야 모델이 구도를 지킨다.
  // "slightly/gently"는 모델이 무시하므로(실측 2026-07-13, 전부 눈높이로 나옴) 부감을 분명히 밀어붙인다.
  return (
    `High-angle shot, elevated camera. A third-person photograph taken from clearly above the scene:` +
    ` the camera is raised well above the subject's head and tilted downward, looking down on the moment from an elevated vantage point.` +
    ` The floor or ground fills much of the frame and we look down onto the scene from above —` +
    ` as if the viewer were floating a little above and behind, quietly watching a memory of their own life pass by below them.` +
    ` In the scene, seen from this high angle looking down, ${who} in this moment: ${item.scene}.` +
    ` This central person is the subject and is clearly visible, their own face shown and in focus.` +
    ` Every other person in the scene has their face wiped away as if smeared out with a single brushstroke:` +
    ` smooth, soft, featureless and blurred — painterly, not distorted, not grotesque, simply an indistinct smudge where the face would be,` +
    ` like a face erased from memory.` +
    future +
    (extra ? ` ${extra}.` : '') +
    ` ${STYLE}` +
    NO_TEXT_DIRECTIVE
  )
}

/** SDXL 폴백용 서술형 프롬프트 — 3인칭 부감 구도 동일 유지. "high angle"은 SDXL이 잘 아는 태그다. */
export function composeSdxlPrompt(profile, item) {
  const who = `a ${item.age}-year-old Korean ${subjectNoun(item.age, profile.gender)}`
  const extra = (profile.descriptors || []).join(', ')
  return `strong high angle shot, elevated camera raised well above and tilted downward looking down on the scene, third person view seen from above, floor and ground filling much of the frame, observing a memory from outside, ${who} as the central subject clearly visible with their own face in focus, ${item.scene}, all other people with faces smeared and wiped away like erased brushstrokes, featureless indistinct smudged faces, not distorted, not grotesque${extra ? `, ${extra}` : ''}, ${STYLE}`
}

/**
 * 파노라마(A안 seamless) 장면 프롬프트 — 1인칭 360° 몰입 환경 (§4.1 실린더 둘러쌈).
 *
 * 3인칭 부감(위에서 내려다봄)과 달리, 관람객이 그 순간의 '안에' 서서 사방을 둘러본다.
 * 가로로 이어지는 equirectangular 파노라마라 실린더 둘레에 그대로 감긴다. 이 구도 전환은
 * seamless 파노라마의 필연(360°를 위에서 내려다볼 수 없음)이며, 07-08 몽타주 1인칭 POV
 * 결정과도 정합한다.
 *
 * §1 유지: 미래·과거의 의미나 감정을 서술하지 않는다. 장소·빛·사물만. 주인공 외 인물의
 * 얼굴은 붓으로 지운 자국(smear)으로 뭉갠다 — 특징 없는 얼룩, 기형·그로테스크가 아니다.
 */
/**
 * 이음매 밴드 inpaint 전용 프롬프트 (B안 seamfix wrap 보정).
 *
 * 장면 프롬프트(인물·얼굴 서술 포함)를 좁은 이음매 띠에 쓰면 Flux Fill이 그 띠 안에 인물을
 * 그려 넣어 유령 같은 신체·얼굴 조각으로 기괴해진다(실측 2026-07-15). 그래서 밴드에는 인물을
 * 일절 언급하지 않고 '이어지는 배경'만 지시한다 — Flux Fill은 주변 픽셀에 조건화되므로 벽·바닥
 * 등 배경은 자연히 맞춰지고, 프롬프트는 사람이 끼어들지 않게만 하면 된다.
 */
export const SEAM_BAND_PROMPT =
  'seamless continuous background environment, empty, no people, no person, no face, no figure, ' +
  'plain surfaces and furnishings flowing together, soft warm natural light, 35mm film grain, ' +
  'muted colors, photorealistic, no text'

/**
 * mode별 장면 프롬프트 선택 — 여러 호출처(life-library 생성, admin 재생성·성별수정)의
 * 4-way 분기 중복을 한 곳으로 모은다. 새 mode를 추가할 때 여기만 고치면 된다.
 *   sdxl → 3인칭 부감 태그형 / gemini → 3인칭 부감 서술형 /
 *   seamfix → 1인칭 360° 파노라마(B안) / 그 외(kontext, 구 hybrid) → 편집형 부감
 */
export function composeScenePromptFor(mode, profile, item) {
  if (mode === 'sdxl') return composeSdxlPrompt(profile, item)
  if (mode === 'gemini') return composeGeminiScenePrompt(profile, item)
  if (mode === 'seamfix') return composePanoramaScenePrompt(profile, item)
  return composeKontextPrompt(profile, item)
}

export function composePanoramaScenePrompt(profile, item) {
  const who = `a ${item.age}-year-old ${subjectNoun(item.age, profile.gender)}`
  const extra = (profile.descriptors || []).join(', ')
  const future = item.isPast ? '' : ` An imagined moment further along in this life.`
  // 파노라마 선언(360°·equirectangular·seamless wrap)을 맨 앞에 — 카메라/투영을 먼저 확정한다.
  return (
    `360 degree equirectangular panorama, seamless horizontal wrap, first-person immersive view:` +
    ` standing inside the scene and surrounded by it on every side, the place of this memory wrapping all the way around the viewer.` +
    ` The surrounding environment, seen from within: ${item.scene}.` +
    ` ${who} is present in this moment, seen from inside the scene; every other person's face is wiped away like a smear of paint —` +
    ` smooth, soft, featureless and blurred, painterly, not distorted, not grotesque, simply an indistinct smudge where the face would be,` +
    ` like a face erased from memory.` +
    ` One continuous unbroken environment with no visible seam, edge or border; the far left and far right flow into one another.` +
    future +
    (extra ? ` ${extra}.` : '') +
    ` ${STYLE}` +
    NO_TEXT_DIRECTIVE
  )
}
