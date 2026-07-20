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
  ' Absolutely no text of any kind anywhere in the image — no letters, no words, no numbers or digits,' +
  ' in ANY language or script including Korean (Hangul), English and Chinese; no captions, subtitles, watermarks,' +
  ' signatures, labels or logos. Any signs, posters, books, screens, banners, packaging or clocks must be completely' +
  ' blank and free of any writing or digits.'

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
  if (!Number.isFinite(birthYear))
    throw new Error(`birthDate 형식이 잘못됨: ${profile.birthDate} (YYYY-MM-DD)`)
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
    ` ${STYLE}` +
    NO_TEXT_DIRECTIVE
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
  return `strong high angle shot, elevated camera raised well above and tilted downward looking down on the scene, third person view seen from above, floor and ground filling much of the frame, observing a memory from outside, ${who} as the central subject clearly visible with their own face in focus, ${item.scene}, all other people with faces smeared and wiped away like erased brushstrokes, featureless indistinct smudged faces, not distorted, not grotesque${extra ? `, ${extra}` : ''}, ${STYLE}${NO_TEXT_DIRECTIVE}`
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
  'seamless continuous plain background surface, a bare wall, blank wallpaper, a simple smooth pillar or column, or empty floor, ' +
  'empty, no people, no person, no face, no figure, no furniture, no complex objects, no clutter, no detailed items, ' +
  'one plain uninterrupted surface flowing together, soft warm natural light, 35mm film grain, ' +
  'muted colors, photorealistic, no text'

/**
 * 서라운드 조립본의 타일 접합선 블렌드 전용 프롬프트 (surround seam blend).
 *
 * seamfix의 SEAM_BAND_PROMPT는 wrap 이음매를 '민무늬 벽'으로 강제한다 — 파노라마 좌우 끝이라 벽이 자연스러웠다.
 * 하지만 surround의 접합선은 방 한가운데(책상·사람·바닥)를 가로지른다. 여기에 민무늬 벽 프롬프트를 쓰면
 * 교실 한복판에 벽 기둥이 세로로 박혀 더 이상해진다. 그래서 블렌드 프롬프트는 '이미 양쪽에 있는 표면·사물을
 * 이어서 섞으라'고만 한다 — 새 인물·새 사물은 금지(유령 방지), 있는 것(바닥·책상·벽)은 자연히 연장.
 * Flux Fill은 주변 픽셀에 조건화되므로 좁은 띠에서 양쪽을 다리 놓듯 잇는다.
 */
export const SEAM_BLEND_PROMPT =
  'seamlessly blend and continue the existing scene across this narrow vertical strip, ' +
  'smoothly matching the surfaces, colors, lighting, floor, walls and objects already present on both the left and right sides, ' +
  'one single continuous room with no visible seam or break, ' +
  'do not add any new people, no new person, no new face, no new figure, and do not add any new objects or furniture — ' +
  'only bridge and continue what is already there, ' +
  'soft warm natural light, 35mm film grain, muted colors, photorealistic, no text'

/**
 * mode별 장면 프롬프트 선택 — 여러 호출처(life-library 생성, admin 재생성·성별수정)의
 * 분기 중복을 한 곳으로 모은다. 새 mode를 추가할 때 여기만 고치면 된다.
 *   sdxl → 3인칭 부감 태그형 / gemini → 3인칭 부감 서술형 /
 *   seamfix → 1인칭 360° 파노라마(구 B안) / surround → 1인칭 서라운드 앵커(대표 프롬프트) /
 *   그 외(kontext, 구 hybrid) → 편집형 부감
 *
 * surround는 실제로 4문구(composeSurroundPrompts)를 쓴다 — 여기서는 매니페스트·로그용 '대표'
 * 프롬프트로 앵커(정면) 문구만 돌려준다. 생성 코어는 composeSurroundPrompts를 직접 호출한다.
 */
export function composeScenePromptFor(mode, profile, item) {
  if (mode === 'sdxl') return composeSdxlPrompt(profile, item)
  if (mode === 'gemini') return composeGeminiScenePrompt(profile, item)
  if (mode === 'seamfix') return composePanoramaScenePrompt(profile, item)
  if (mode === 'surround') return composeSurroundAnchorPrompt(profile, item)
  if (mode === 'equirect') return composeEquirectGazePrompt(profile, item)
  return composeKontextPrompt(profile, item)
}

// ── equirect-native 360° (현재 채택) ─────────────────────────────────────────
// Gemini에 "360 카메라 equirectangular 파노라마"를 직접 요청 → 한 콜로 진짜 360 기하.
// gaze 구도: 주인공은 정면 중앙(0°, 카메라 응시), 그가 바라보는 대상은 반대편(등 뒤/좌우 끝)에.
// 진짜 투영 기하(곡선 지평선·바닥 nadir·천장 zenith·직선 휨·방 wrap)를 명시하고, 장면 내 텍스트도 억제한다.

/** equirect 360° 기하 + 무텍스트 강제 지시(장면 내 간판·현수막 텍스트까지). */
const EQUIRECT_GEO =
  ` TRUE equirectangular projection (spherical panorama unwrapped): the horizon runs straight across the vertical middle;` +
  ` the floor/ground sweeps across the ENTIRE bottom stretching toward the nadir (straight down) and the ceiling/sky across the ENTIRE top toward the zenith;` +
  ` straight lines (window frames, ceiling edges, desks, poles) visibly BOW and CURVE away from the center as in a real 360 camera capture;` +
  ` the place wraps completely around the single viewpoint so the far LEFT and far RIGHT edges are the same direction behind the camera.` +
  ` Photorealistic, natural light. Absolutely NO text anywhere — no signs, no banners, no writing on walls, boards or screens, no watermark; not an illustration.`

/** 1인칭 360° equirect gaze 프롬프트 — 주인공 정면 + 응시 대상 반대편, 진짜 360 기하. 레퍼런스 없이 텍스트→이미지. */
export function composeEquirectGazePrompt(profile, item) {
  const who = `a ${item.age}-year-old ${subjectNoun(item.age, profile.gender)}`
  const extra = (profile.descriptors || []).join(', ')
  const future = item.isPast ? '' : ` An imagined moment further along in this life.`
  return (
    `A 360-degree equirectangular panoramic photograph captured with a 360 camera from a single fixed point standing inside this moment: ${item.scene}.` +
    ` In the CENTER of the frame, directly in front of the camera, ${who} stands facing the camera and looking straight into the lens, their face shown and in focus — the person whose memory this is.` +
    ` The whole place of this moment wraps around them; across the far sides and directly behind the camera is the rest of the scene they are surrounded by and gazing toward.` +
    ` Every other person's face is wiped away like a soft featureless smear of paint, smooth, painterly, not distorted, not grotesque, like a face erased from memory.` +
    EQUIRECT_GEO +
    future +
    (extra ? ` ${extra}.` : '')
  )
}

// ── 1인칭 서라운드(4타일 캔버스 아웃페인팅) 프롬프트 ─────────────────────────────────
// 관람객이 그 순간 '안에' 서서 눈높이로 사방을 둘러본다(§5.2, 부감이 아님). 주인공은 정면
// 타일에만 나타나고(자기 얼굴 보임), 나머지 인물 얼굴은 붓으로 지운 smear. 각 타일은 '광각 없이'
// 자연스러운 한 장의 사진 — 초광각·파노라마 왜곡을 금지한다. 이음 타일(좌·우·등 뒤)은 새 서사를
// 저작하지 않고(§1) 앵커의 '환경을 이어서' 확장하는 지시만 준다 — 픽셀 연속성은 레퍼런스가 담당.

/** 앵커(타일1, 정면) — 주인공이 나타나는 유일한 타일. 레퍼런스 없이 텍스트→이미지. */
export function composeSurroundAnchorPrompt(profile, item) {
  const who = `a ${item.age}-year-old ${subjectNoun(item.age, profile.gender)}`
  const extra = (profile.descriptors || []).join(', ')
  const future = item.isPast ? '' : ` An imagined moment further along in this life.`
  return (
    `First-person eye-level photograph, looking straight ahead from inside the scene, a single natural view directly in front of the viewer.` +
    ` Ahead of the viewer, ${who} in this moment: ${item.scene}.` +
    ` This central person is the subject and is clearly visible, their own face shown and in focus.` +
    ` Every other person's face is wiped away like a smear of paint — smooth, soft, featureless and blurred, painterly,` +
    ` not distorted, not grotesque, simply an indistinct smudge where the face would be, like a face erased from memory.` +
    ` A normal lens, a single ordinary photograph — not a wide-angle, fisheye or panoramic shot, no lens distortion.` +
    future +
    (extra ? ` ${extra}.` : '') +
    ` ${STYLE}` +
    NO_TEXT_DIRECTIVE
  )
}

/**
 * 이음 타일(좌·우·등 뒤) 아웃페인팅 fill 지시. 레퍼런스 캔버스는 [이웃 | 빈칸](또는 [좌|빈칸|우]).
 * @param {'right'|'left'|'back'} side
 *   right : 앵커의 오른쪽으로 이어지는 90°(주인공의 좌측 환경).
 *   left  : 앵커의 왼쪽으로 이어지는 90°(주인공의 우측 환경).
 *   back  : 등 뒤 90°. 캔버스 좌·우 두 사진 사이 빈칸을 채워 양쪽 모두에 매끄럽게 잇는다(폐곡선).
 */
export function composeSurroundContinuationPrompt(profile, item, side) {
  const extra = (profile.descriptors || []).join(', ')
  const common =
    ` Keep the same place, the same light, the same photographic style and the same horizon and scale as the reference,` +
    ` one single continuous environment with no visible seam. Do NOT add another main subject or repeat the central person —` +
    ` only the surrounding environment of this same place continues here. Any people present have their faces wiped away like a smear of paint,` +
    ` smooth, soft, featureless and blurred, painterly, not distorted, not grotesque. A normal lens, not a wide-angle, fisheye or panoramic shot, no lens distortion.`
  const gap =
    side === 'back'
      ? `The reference image shows two photographs of one surrounding place with a blank gray gap in the middle:` +
        ` fill only that middle gap so it continues seamlessly from the scene on its left edge and into the scene on its right edge,` +
        ` joining the two sides into one unbroken environment (this is the far side of the place, behind the viewer).`
      : side === 'right'
        ? `The reference image is a photograph on the left with a blank gray area on the right:` +
          ` fill only that blank right area, continuing the scene seamlessly to the right — the part of this same place immediately to the right.`
        : `The reference image is a photograph on the right with a blank gray area on the left:` +
          ` fill only that blank left area, continuing the scene seamlessly to the left — the part of this same place immediately to the left.`
  return gap + common + (extra ? ` ${extra}.` : '') + ` ${STYLE}` + NO_TEXT_DIRECTIVE
}

/**
 * 서라운드 한 장면의 4문구 묶음 — (구) Gemini 캔버스 아웃페인팅 generateSurroundPanorama가 소비한다.
 * @returns {{ anchor:string, right:string, left:string, back:string }}
 */
export function composeSurroundPrompts(profile, item) {
  return {
    anchor: composeSurroundAnchorPrompt(profile, item),
    right: composeSurroundContinuationPrompt(profile, item, 'right'),
    left: composeSurroundContinuationPrompt(profile, item, 'left'),
    back: composeSurroundContinuationPrompt(profile, item, 'back')
  }
}

/**
 * Flux.2 마스크 아웃페인팅용 연속 프롬프트 — 캔버스 메타설명('빈 회색 영역을 채워라')을 쓰면 안 된다.
 * Flux.2는 마스크 인페인팅이라 프롬프트를 '그릴 내용'으로 읽는다. "blank gray area" 같은 말을 넣으면
 * 그 영역을 회색으로 남긴다(실측 2026-07-18). 그래서 '이 장소를 옆으로 자연스럽게 이어 그려라'라고 내용만 지시한다.
 * 픽셀 연속성은 마스크 밖 실제 이웃 픽셀이 담당한다.
 */
export function composeSurroundFlux2Continuation(profile, item) {
  const extra = (profile.descriptors || []).join(', ')
  return (
    `A single continuous first-person eye-level photograph of one place, seen from inside it: ${item.scene}.` +
    ` Extend and continue this same scene seamlessly to the side, matching the exact same perspective, horizon line, lighting,` +
    ` floor, walls, surfaces and photographic style already present. One unbroken continuous environment with no seam, no border and no repetition.` +
    ` Do not add another main subject or repeat the central person — only the surrounding environment of this same place continues.` +
    ` Any people present have their faces wiped away like a smear of paint, smooth, soft, featureless and blurred, painterly, not distorted, not grotesque.` +
    ` A normal lens, not a wide-angle, fisheye or panoramic shot, no lens distortion.` +
    (extra ? ` ${extra}.` : '') +
    ` ${STYLE}` +
    NO_TEXT_DIRECTIVE
  )
}

/**
 * Flux.2 서라운드용 프롬프트 묶음 — (구) 슬라이딩 아웃페인팅 경로용.
 * @returns {{ anchor:string, right:string }}
 */
export function composeSurroundFlux2Prompts(profile, item) {
  return {
    anchor: composeSurroundAnchorPrompt(profile, item),
    right: composeSurroundFlux2Continuation(profile, item)
  }
}

// ── 양쪽 브리지 서라운드 프롬프트 (Gemini 정면·맞은편 2장 + Flux 브리지 2장) ────────────────
// 파노라마처럼 보이게: 정면(주인공)과 그 맞은편(주인공이 바라보는 far side)을 Gemini로 2장 만들고,
// 사이 두 장을 Flux가 '양쪽 가장자리에 조건화된' bilateral inpaint로 이어 하나로 흐르게 한다.

/** tile3 = 맞은편 시야(Gemini). 정면의 주인공이 바라보는 같은 장소의 반대쪽. 주인공은 여기 없다. */
export function composeSurroundBackPrompt(profile, item) {
  const extra = (profile.descriptors || []).join(', ')
  return (
    `First-person eye-level photograph looking straight ahead toward the far side of the same place —` +
    ` the opposite direction that the central person is facing toward.` +
    ` The same location: ${item.scene}, but seen looking the other way, so the central person is now behind the viewer and does NOT appear here.` +
    ` Only the surrounding environment of this same place, its far side. Any people present have their faces wiped away like a smear of paint,` +
    ` smooth, soft, featureless and blurred, painterly, not distorted, not grotesque.` +
    ` A single natural photograph, a normal lens, not a wide-angle, fisheye or panoramic shot, no lens distortion. No pillar, column or divider inserted.` +
    (extra ? ` ${extra}.` : '') +
    ` ${STYLE}` +
    NO_TEXT_DIRECTIVE
  )
}

/**
 * Flux 양쪽 브리지 프롬프트 — 캔버스 [왼쪽사진 | 빈칸 | 오른쪽사진]의 가운데를 채워 두 사진을 하나로 잇는다.
 * 캔버스 메타설명("빈 영역을 채워라")은 금지(Flux가 회색으로 남김). '한 장의 연속 파노라마로 이어라'라고 내용만.
 * 핵심: 브리지에 **새 주인공·새 큰 사물·기둥 금지** — 그래야 4장이 '각각 다른 사진 4장'이 아니라 하나로 흐른다.
 */
export function composeSurroundBridgePrompt(profile) {
  const extra = (profile.descriptors || []).join(', ')
  return (
    `A single continuous 360-degree panoramic photograph of one place, one unbroken environment wrapping around the viewer` +
    ` with a consistent horizon, perspective and depth. Continue the architecture and the surroundings — the walls, windows, floor,` +
    ` ceiling and furniture — smoothly from each side into the space between, so both sides flow together with no seam, no break and no repetition,` +
    ` matching the exact same lighting, colors and photographic style on both sides.` +
    ` Do NOT add any new prominent foreground subject, and do NOT insert any new object — no pillar, no column, no wall, no divider —` +
    ` keep continuing the same room and its surfaces. Keep any people few, small and in the far background,` +
    ` their faces wiped away to a soft featureless smear, never a large blurred figure filling the frame.` +
    ` A normal lens, no wide-angle or fisheye distortion, everything in even focus like a panorama.` +
    (extra ? ` ${extra}.` : '') +
    ` ${STYLE}` +
    NO_TEXT_DIRECTIVE
  )
}

/**
 * 양쪽 브리지 서라운드 프롬프트 묶음 — (구) 브리지 경로용.
 * @returns {{ anchor:string, back:string, bridge:string }}
 */
export function composeSurroundBridgePrompts(profile, item) {
  return {
    anchor: composeSurroundAnchorPrompt(profile, item),
    back: composeSurroundBackPrompt(profile, item),
    bridge: composeSurroundBridgePrompt(profile)
  }
}

// ── 넓은 앵커 서라운드 프롬프트 (A안: 넓은 2:1 정면·맞은편 2장 + 좁은 이음선) ──────────────
// 90°짜리 4장은 조각 사이 갭이 구조적으로 흐려진다(실측). 대신 좌·정면·우가 한 장에 다 담긴 넓은 2:1
// 앵커 2장(정면 hemisphere + 맞은편 hemisphere)을 만들면 좌우가 애초에 정면과 같은 이미지라 선명하게
// 이어진다. 두 앵커를 붙인 뒤 좁은 이음선 2곳만 Flux Fill로 채운다(seamfix에서 검증된 선명한 밴드 보정).

/** 넓은 정면 앵커 — 좌·정면·우를 한 2:1 프레임에. 주인공은 가운데, 자기 얼굴 노출. */
export function composeSurroundWideAnchorPrompt(profile, item) {
  const who = `a ${item.age}-year-old ${subjectNoun(item.age, profile.gender)}`
  const extra = (profile.descriptors || []).join(', ')
  const future = item.isPast ? '' : ` An imagined moment further along in this life.`
  return (
    `A wide panoramic first-person eye-level photograph — a broad immersive view that takes in the scene to the left,` +
    ` straight ahead, and to the right all at once, as if slowly turning to look around one place.` +
    ` In the middle of the frame, ${who} in this moment: ${item.scene}, the central person clearly visible with their own face shown and in focus.` +
    ` The same room and surroundings spread continuously across the whole wide frame, from the far-left edge to the far-right edge — one connected space.` +
    ` Every other person's face is wiped away like a smear of paint, smooth, soft, featureless and blurred, painterly, not distorted, not grotesque.` +
    ` A wide but natural panoramic perspective, gentle and photographic, no fisheye and no extreme lens distortion.` +
    future +
    (extra ? ` ${extra}.` : '') +
    ` ${STYLE}` +
    NO_TEXT_DIRECTIVE
  )
}

/** 넓은 맞은편 앵커 — 주인공이 바라보는 반대쪽 hemisphere. 주인공은 없음(등 뒤). */
export function composeSurroundWideBackPrompt(profile, item) {
  const extra = (profile.descriptors || []).join(', ')
  return (
    `A wide panoramic first-person eye-level photograph of the opposite side of the same place —` +
    ` the far view that the central person is facing toward, taking in left, straight ahead and right all at once.` +
    ` The same location: ${item.scene}, seen looking the other way, so the central person is behind the viewer and does NOT appear here.` +
    ` The room and surroundings spread continuously across the whole wide frame, one connected space from the far-left to the far-right edge.` +
    ` Any other people have their faces wiped away like a smear of paint, smooth, soft, featureless and blurred, painterly.` +
    ` A wide but natural panoramic perspective, no fisheye, no extreme lens distortion. No pillar, column or divider inserted.` +
    (extra ? ` ${extra}.` : '') +
    ` ${STYLE}` +
    NO_TEXT_DIRECTIVE
  )
}

/**
 * 넓은 앵커 서라운드 프롬프트 묶음 — generateSurroundPanoramaFlux2가 소비한다.
 * anchor(넓은 정면), back(넓은 맞은편). 이음선은 SEAM_BLEND_PROMPT 상수 사용.
 * @returns {{ anchor:string, back:string }}
 */
export function composeSurroundWidePrompts(profile, item) {
  return {
    anchor: composeSurroundWideAnchorPrompt(profile, item),
    back: composeSurroundWideBackPrompt(profile, item)
  }
}

// ── 항공샷 기반 서라운드 프롬프트 (배치도 → 눈높이 정면뷰 + 눈높이 리버스뷰) ──────────────────────
// 두 넓은 뷰를 독립 생성하면 공간 모델을 공유하지 못해 C(주인공이 보는 것)가 틀리고 연결도 안 됐다(실측).
// 해법(사용자 아이디어): 먼저 이 순간의 '항공샷(top-down 배치도)'을 만들어 주인공 위치·시선·주변 배치를 고정하고,
// 그 배치도를 참조해 방향별 눈높이 뷰를 생성한다 → 모든 뷰가 같은 3D 배치를 공유해 C가 올바르고 연결된다.
//   front(A+B): 주인공이 카메라(화면 밖 우리)를 정면 응시하는 쪽에서 촬영(주인공은 왼쪽).
//   back(C+D) : 주인공이 바라보는 방향 = 배치도상 그가 향한 far end(진짜 리버스). front를 스타일 레퍼런스로.
// 파노라마 = [front | back]. 이음선 2곳(가운데 join + 등 뒤 wrap)만 Flux Fill 보정.

// 눈높이·사진체 강제 — 항공샷은 배치 참조용일 뿐, 탑다운 각도·일러스트 화풍을 복사하지 못하게 막는다(실측 필수).
const AERIAL_VIEW_DIRECTIVE =
  ` IMPORTANT: the first reference image is only a top-down schematic MAP telling you where things are placed —` +
  ` use it ONLY for the spatial layout, and do NOT copy its overhead angle or its flat drawn/illustrated look.` +
  ` Render a completely normal ground-level EYE-LEVEL photograph, as if a person stands on the floor holding a camera horizontally at head height,` +
  ` looking straight ahead across the space (flat level horizon, NOT looking down, NOT a top-down or high-angle view).` +
  ` A realistic photorealistic photograph, absolutely NOT an illustration, drawing, cartoon or anime.`

/** 항공샷(배치도) — 주인공 위치·시선 방향 + 주변 배치. 방향별 뷰의 공간 기준이 된다. */
export function composeSurroundAerialPrompt(profile, item) {
  const who = `a ${item.age}-year-old ${subjectNoun(item.age, profile.gender)}`
  return (
    `A top-down bird's-eye overhead view looking straight down from directly above at this place: ${item.scene}.` +
    ` Show the full floor layout like an architectural plan: place ${who} standing near the middle and clearly indicate which direction they are facing` +
    ` (show their body orientation from above, facing toward one wall). Arrange everything around them — furniture, seating, walls, windows, doors — in correct positions across the whole space.` +
    ` A clear schematic top-down layout, evenly lit.` +
    NO_TEXT_DIRECTIVE
  )
}

/** front=[A|B] — 눈높이. 주인공이 정면 중앙에서 카메라를 응시, 좌우 양쪽으로 주변. references:[aerial]. */
export function composeSurroundGazeAnchorPrompt(profile, item) {
  const who = `a ${item.age}-year-old ${subjectNoun(item.age, profile.gender)}`
  const extra = (profile.descriptors || []).join(', ')
  const future = item.isPast ? '' : ` An imagined moment further along in this life.`
  return (
    `A wide eye-level photograph taken from inside this place. Using the top-down map for the spatial layout, photograph the scene from the side that ${who} is facing,` +
    ` so that in the CENTER of the frame ${who} stands facing the camera and looking straight out of the picture directly at the viewer, their own face shown and in focus.` +
    ` This is the moment: ${item.scene}. The same place extends symmetrically to both sides around them — the surroundings as arranged in the map spread out to the left AND to the right across the wide frame, flowing off past both the left edge and the right edge.` +
    ` Every other person's face is wiped away like a smear of paint, smooth, soft, featureless and blurred, painterly, not distorted, not grotesque.` +
    AERIAL_VIEW_DIRECTIVE +
    ` A wide but natural panoramic perspective, no fisheye, no extreme lens distortion.` +
    future +
    (extra ? ` ${extra}.` : '') +
    ` ${STYLE}` +
    NO_TEXT_DIRECTIVE
  )
}

/** back=[C|D] — 눈높이 리버스. 관람객 중심 단일시점에서 180° 뒤돈 뷰(1인칭 손·전경 책상 없음). references:[aerial, front(스타일)]. */
export function composeSurroundGazeViewPrompt(profile, item) {
  const extra = (profile.descriptors || []).join(', ')
  return (
    `A wide eye-level photograph of the SAME place, the REVERSE view. The camera stays at the exact same single standpoint as in the second reference photo (the front view of this room) —` +
    ` the viewer stands still at one spot and simply turns 180 degrees to look the opposite way. Show the far side of the same room that lies behind, the space the central person is gazing toward across the room` +
    ` (the far wall / far end, per the top-down map). This is distinctly the opposite side from the front reference.` +
    ` CONTINUITY (critical for a seamless 360° loop): the camera has rotated 180°, so the LEFT edge of this frame is the direct continuation of the RIGHT edge of the second reference photo — begin the left side of the frame with exactly the same side wall, board, windows and objects that appear at the far-RIGHT of the front view, continuing them without any break, then let the room open out toward the far end across the rest of the frame. Likewise the RIGHT edge of this frame continues into the LEFT edge of the front view (what sits just beside the far-LEFT of the front reference).` +
    ` The central person does NOT appear. IMPORTANT: this is a clean straight-ahead eye-level view across the room — do NOT show any hands, arms, shoulders, body or a foreground desk in the immediate foreground; it is NOT a first-person over-the-shoulder or over-the-desk shot, and no body part of the viewer is visible.` +
    ` Any other people are seen more from the front, facing back toward the center, their faces wiped to a soft featureless smear.` +
    ` The same location: ${item.scene}.` +
    AERIAL_VIEW_DIRECTIVE +
    ` Match the exact realistic photographic style, lighting and colors of the SECOND reference image (a photo of the same place). A wide natural perspective, no fisheye, no pillar or divider.` +
    (extra ? ` ${extra}.` : '') +
    ` ${STYLE}` +
    NO_TEXT_DIRECTIVE
  )
}

/**
 * 항공샷 기반 프롬프트 묶음 — 생성 코어가 aerial 먼저 만들고, front(ref:[aerial]), back(ref:[aerial,front])로 조건화.
 * @returns {{ aerial:string, anchor:string, view:string }}
 */
export function composeSurroundGazePrompts(profile, item) {
  return {
    aerial: composeSurroundAerialPrompt(profile, item),
    anchor: composeSurroundGazeAnchorPrompt(profile, item),
    view: composeSurroundGazeViewPrompt(profile, item)
  }
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
    // 이음매(far-left ≡ far-right wrap)의 '접합선 그 자리'만 단순면(벽·기둥)에 걸리게 한다. 콘텐츠를 엣지에서
    // 멀리 떼면 큰 민무늬 여백이 생기므로, 장면은 좌우 끝까지 자연스레 채우되 딱 이어지는 선만 단순면이면 된다.
    ` Only right along the thin vertical line where the far-left and far-right ends join, let the two ends meet on a simple plain surface such as a bare wall or a pillar,` +
    ` and avoid placing a person's face or a complex detailed object directly across that exact joining line. The rest of the scene, including people and furnishings,` +
    ` still fills the view naturally all the way to the edges — only the thin joining line itself falls on a plain surface, not a wide empty margin.` +
    future +
    (extra ? ` ${extra}.` : '') +
    ` ${STYLE}` +
    NO_TEXT_DIRECTIVE
  )
}
