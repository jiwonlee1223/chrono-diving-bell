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
// 얕은 심도(shallow DoF + bokeh)는 배경 인물 얼굴을 아웃포커스로 뭉갠다 — 얼굴 선명 방침(2026-08-04,
// 과거 '주변 인물 얼굴 smear' 연출 폐기)에 따라 깊은 심도 + 전 인물 얼굴 또렷로 교체.
export const STYLE =
  'candid documentary photograph, soft warm natural light, 35mm film grain, muted colors, deep focus with everything sharp, every visible face rendered clearly and in crisp detail, photorealistic, no text, no watermark'

// §1(해석적 자율성)·라인6: 이미지 안에 글자·숫자가 생기면 direct delivery가 된다. Gemini는
// 태그("no text")보다 지시형 문장에 강하게 반응하므로, 프롬프트 끝에 명시적 금지문을 붙인다.
// 간판·표지판·시계·책 등도 글자 없이 빈 채로 두게 한다.
export const NO_TEXT_DIRECTIVE =
  ' Absolutely no text, letters, numbers, words, captions, subtitles, watermarks, signatures or logos anywhere in the image.' +
  ' Any signs, posters, books, screens or clocks must be blank and free of writing or digits.'

// 한국 배경 강제(2026-08-03) — 장면 묘사("school corridor" 등)가 국적 중립이면 모델이 미국식
// 공간(사물함 복도·스쿨버스·교외 주택)을 디폴트로 그린다. 모든 장면 프롬프트에 이 지시를 넣어
// 건축·인테리어·소품·주변 인물까지 한국 컨텍스트를 유지시킨다.
// 시대 규칙(2026-08-10 개편, composeReelPhotoPrompt의 era와 동일 원칙):
//   과거 — 정확한 연도를 프롬프트에 박아 그 해의 분위기를 고증한다(그 해에 없던 물건 금지).
//   미래 — 연도를 밝히되 "오늘의 한국과 거의 똑같아 보이는 미래"로(2026-08-11 사용자 피드백:
//   futuristic·SF풍 결과가 나와 "조용히 진보" 문구를 폐기 — 진보를 그리라는 긍정 지시가 미래풍
//   스타일링을 유도했다). 미래풍 건축·화면 범람·로봇·컨셉카를 명시 금지하되, 오늘 이미 사라져가는
//   물건(종이 신문 등)이 나오면 몰입이 깨지므로(기존 피드백) 그 금지는 유지.
export function koreanContextFor(item = {}) {
  const hasYear = Number.isFinite(item.year)
  const decade = hasYear ? Math.floor(item.year / 10) * 10 : null
  const where =
    item.isPast === false
      ? (hasYear ? `South Korea in the year ${item.year} — ` : 'South Korea some decades from now — ') +
        'a future that looks almost exactly like PRESENT-DAY Korea: the same ordinary streets, apartment complexes, shops and interiors as today, filmed as a plain contemporary photograph. ' +
        'The image must NOT look futuristic in any way — no futuristic or high-tech architecture, no walls of screens or glowing panels, no ambient displays, no robots, no concept-car or streamlined vehicles; any technology visible is ordinary, current-day and inconspicuous. ' +
        'Objects that are already fading from daily life today must NOT appear either (no paper newspapers, no cash handling, no bulky old TVs or appliances, no visibly dated cars or phones). ' +
        'Absolutely NOT science fiction: no holograms, no flying vehicles, no sleek sci-fi styling'
      : hasYear
        ? `South Korea in the year ${item.year} (the ${decade}s) — with period-accurate everyday Korean details of that exact time: the architecture, interiors, clothing, hairstyles, vehicles and objects of ${item.year}, and NOTHING that did not exist yet in that year`
        : 'South Korea'
  return (
    ` IMPORTANT SETTING — unless the scene description above explicitly names a different country or city, this scene takes place in ${where}.` +
    ` Every part of the environment is distinctly KOREAN: Korean-style architecture and interiors, Korean school buildings,` +
    ` classrooms and hallways, Korean high-rise apartment complexes, streets, shops, furniture, food and everyday objects.` +
    ` It must NOT default to American or European looks — no US-style hallway lockers, no yellow school buses, no western suburban houses.` +
    ` Other people present are Korean by default.` +
    ` EXCEPTION: if the scene description explicitly places this moment in another country (living, studying or traveling abroad),` +
    ` depict that country's environment and local people authentically instead — the main subject is still the same Korean person visiting or living there.`
  )
}

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

/**
 * 나이별 폴백 장면 문구 — 인생그래프(cdb-crafter) 세션에서 그 단계에 사용자 글이 없을 때 쓴다.
 * AI가 없는 데이터로 새로 지어내는 대신, 여기 STAGES에 미리 써둔 감각 재료 풀에서
 * 결정론적으로 count개를 고른다(§1 — occupation 플로우와 동일한 원칙).
 * life-graph 쪽 나이 격자(AGES)가 STAGES의 10개 나이보다 촘촘해서, 정확히 일치하는 나이가
 * 없으면 가장 가까운 STAGES 나이의 재료 풀을 쓴다.
 * @param {number} age            임의의 나이 — 가장 가까운 STAGES 나이로 매칭된다.
 * @param {string} seedString     결정론 시드(보통 `${name}|${birthDate}|${age}`).
 * @param {number} [count=3]
 * @returns {string[]}  count개(STAGES가 비어 있을 때만 0개).
 */
export function fallbackScenesForAge(age, seedString, count = 3) {
  let stage = STAGES[0]
  for (const s of STAGES) if (Math.abs(s.age - age) < Math.abs(stage.age - age)) stage = s
  if (!stage) return []
  const rand = mulberry32(hashString(seedString))
  return pick(rand, stage.scenes, Math.min(count, stage.scenes.length)).map((s) =>
    s.replaceAll('{occ}', 'worker')
  ) // 인생그래프 프로필엔 occupation이 없다
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

// ── reel 전용 사진 플랜 재료 (파노라마와 별개 플로우) ─────────────────────────────
// reel(주마등 회전)은 이제 파노라마가 아니라 3:4 일반 사진 12장을 필름스트립으로 돌린다.
// 나이 배열·장면 선택·프롬프트를 여기 모아 결정론(§1 — 같은 프로필 = 같은 재료)을 유지한다.

/**
 * reel 사진의 나이 배열 — 기억이 시작되는 startAge(3)부터 현재 나이까지 균등 count(12)개.
 * 어린 사용자는 반올림으로 나이가 중복될 수 있다(장면은 idx 시드로 다르게 뽑힌다).
 * currentAge < startAge면 0~currentAge로 클램프(극단 케이스 안전판).
 * @param {number} currentAge
 * @param {{count?:number, startAge?:number}} [opts]
 * @returns {number[]} 오름차순 정수 count개
 */
export function reelAges(currentAge, { count = 12, startAge = 3 } = {}) {
  const end = Math.max(0, Math.floor(currentAge))
  const start = Math.min(startAge, end)
  if (count <= 1) return [end]
  const ages = []
  for (let i = 0; i < count; i++) ages.push(Math.round(start + ((end - start) * i) / (count - 1)))
  return ages
}

/**
 * 미래 릴의 나이 사다리 — 현재 나이 **다음 해**부터 endAge(90)까지 균등 count개.
 * 현재를 포함하지 않는 이유: 과거 릴의 마지막 장이 이미 현재 나이라, 두 릴을 이어 보면
 * 같은 나이가 두 번 나온다. 미래 릴은 현재 바로 다음부터 시작해 그 지점에서 이어진다.
 * 이미 90세를 넘겼거나 남은 해가 count보다 적으면 중복 없이 있는 만큼만 돌려준다.
 * @param {number} currentAge
 * @param {object} [opts] { count=12, endAge=90 }
 * @returns {number[]}
 */
export function reelFutureAges(currentAge, { count = 12, endAge = 90 } = {}) {
  const start = Math.max(0, Math.floor(currentAge)) + 1
  const end = Math.floor(endAge)
  if (start > end) return []
  if (count <= 1) return [end]
  const ages = []
  for (let i = 0; i < count; i++) ages.push(Math.round(start + ((end - start) * i) / (count - 1)))
  return [...new Set(ages)] // 남은 해가 짧으면 반올림이 겹친다 — 같은 나이를 두 번 만들지 않는다
}

/**
 * reel 사진 한 장의 장면 문구 — STAGES에서 그 나이에 가장 가까운 단계의 감각 재료 풀에서
 * 결정론적으로 1개 뽑는다({occ} 치환은 호출부 몫). 나이가 중복되는 어린 사용자를 위해
 * seedString에 idx를 섞어 같은 나이라도 다른 장면이 나오게 한다.
 * @param {number} age
 * @param {string} seedString  보통 `${name}|${birthDate}|reel|${idx}`
 * @returns {string}
 */
export function reelSceneForAge(age, seedString) {
  let stage = STAGES[0]
  for (const s of STAGES) if (Math.abs(s.age - age) < Math.abs(stage.age - age)) stage = s
  const rand = mulberry32(hashString(seedString))
  return pick(rand, stage.scenes, 1)[0]
}

/**
 * reel 사진 프롬프트 — 일반 사진(파노라마·부감 지시 없음). 인물이 프레임 정중앙에서
 * 그 순간의 행동을 능동적으로 수행하고, 시대 배경(과거 연대의 한국)을 입힌다. 복장·헤어는
 * 장면·시대를 따르게 한다(얼굴 정체성 유지는 face-anchor 접두어가 담당 — 여기서는 장면만).
 * §1: 장소·빛·사물·행동만 서술, 감정·의미 서술어 없음.
 * orientation은 생성 aspectRatio(config.reelPhotos)에서 유도돼 들어온다 — 프롬프트 문구와
 * 실제 출력 비율이 어긋나면 모델이 구도를 비틀어 채우므로 반드시 함께 움직여야 한다.
 * @param {{gender?:string, descriptors?:string[]}} profile
 * @param {{age:number, year:number, scene:string}} item
 * @param {{orientation?:'portrait'|'landscape'}} [opts]  기본 portrait(3:4 세로 — 1차 플로우 확정)
 */
export function composeReelPhotoPrompt(profile, item, { orientation = 'portrait' } = {}) {
  const who = `a ${item.age}-year-old ${subjectNoun(item.age, profile?.gender)}`
  // 시대 문구(2026-08-10 개편, koreanContextFor와 동일 원칙) — 과거는 정확한 연도 고증,
  // 미래는 연도를 밝힌 "조용히 진보한 근미래"(오늘 사라져가는 물건 금지, SF 소품도 여전히 금지).
  const decade = Math.floor(item.year / 10) * 10
  const era =
    item.isPast === false
      ? `Korea in the year ${item.year} — a future that looks almost exactly like present-day Korea:` +
        ` the same ordinary streets, buildings, interiors, vehicles and fashions as today, nothing futuristic` +
        ` or high-tech looking (no walls of screens, no glowing panels, no robots, no concept-car vehicles);` +
        ` nothing that is already fading from daily life today either (no paper newspapers, no cash,` +
        ` no dated appliances or cars), and absolutely NOT science fiction: no holograms, no flying vehicles,` +
        ` no sleek sci-fi styling`
      : `Korea in the year ${item.year} (the ${decade}s) — everyday period-accurate details of that exact time` +
        ` and place, with nothing that did not exist yet in ${item.year}`
  const extra = (profile?.descriptors || []).join(', ')
  const frame =
    orientation === 'landscape'
      ? 'A landscape-orientation candid snapshot photograph (wider than tall)'
      : 'A portrait-orientation candid snapshot photograph (taller than wide)'
  // 인물 크기 제어: "face clearly visible and in sharp focus"가 클로즈업을 유도해 얼굴이 세로
  // 40~50%를 차지했다(실측 2026-07-27). 완곡한 표현은 무시되므로(위 2026-07-13 실측과 동일)
  // 거리(미터)·전신·환경 우위를 단정적으로 선언하고, 얼굴 지시는 "작지만 알아볼 수 있게"로 완화한다.
  return (
    `${frame} of ONE single person: ${who} in this moment — ${item.scene}.` +
    ` A wide shot taken from several meters away — NOT a close-up and NOT a headshot:` +
    ` the person's entire body is visible from head to toe, occupying only a small part of the frame,` +
    ` while the surrounding place fills most of the picture.` +
    ` The person is at the exact CENTER of the frame,` +
    ` actively doing what this moment is about (not posing for the camera);` +
    ` their face, small at this distance, is still unobstructed and recognizable.` +
    ` The setting, clothing and hairstyle authentically reflect ${era} —` +
    ` with a distinctly Korean environment (Korean schools, apartment complexes, streets and interiors, never defaulting to American or European looks),` +
    ` UNLESS the scene above explicitly places this moment in another country, in which case depict that country authentically while the person remains Korean.` +
    ` Anyone else present is only a background bystander.` +
    (extra ? ` ${extra}.` : '') +
    ` ${STYLE}` +
    NO_TEXT_DIRECTIVE
  )
}

/**
 * 과거 릴 마지막 장 — 탄생 사진 프롬프트. 주마등이 탄생까지 되감긴 끝점으로,
 * "태어나자마자 보는 첫 기억"을 형상화한다: 산부인과 분만실에서 갓 태어난 나를 안아든 엄마.
 * 일반 릴 프롬프트(composeReelPhotoPrompt)와 달리 주인공은 신생아가 아니라 엄마의 모습이며,
 * 얼굴 레퍼런스를 쓰지 않는다(신생아 얼굴 정체성은 무의미하고 엄마 얼굴은 모른다 — 호출부가
 * reference 없이 부른다). 시대(출생 연대의 한국 산부인과)와 스타일 규칙은 릴과 동일하게 입힌다.
 * @param {{gender?:string}} profile
 * @param {{age:number, year:number}} item  age=0, year=출생년
 * @param {{orientation?:'portrait'|'landscape'}} [opts]
 */
export function composeBirthPhotoPrompt(profile, item, { orientation = 'portrait' } = {}) {
  const decade = Math.floor(item.year / 10) * 10
  const frame =
    orientation === 'landscape'
      ? 'A landscape-orientation candid snapshot photograph (wider than tall)'
      : 'A portrait-orientation candid snapshot photograph (taller than wide)'
  return (
    `${frame} of the very first moment of a life — the first thing a newborn ever sees:` +
    ` a young Korean mother in a hospital delivery room, just after giving birth,` +
    ` cradling her swaddled newborn baby in her arms and gazing down at the baby's face.` +
    ` The photograph is taken from close to the newborn's point of view, looking up at the mother,` +
    ` so the mother's tired, gentle face and the wrapped baby are at the exact CENTER of the frame.` +
    ` The setting is a maternity hospital delivery room in ${decade}s South Korea,` +
    ` with period-accurate everyday Korean hospital details of that time —` +
    ` warm soft hospital lighting, blankets and simple medical equipment softly out of the way.` +
    ` It must NOT default to American or European looks; everyone present is Korean.` +
    ` Any nurses are only background bystanders.` +
    ` ${STYLE}` +
    NO_TEXT_DIRECTIVE
  )
}

// 나이에 맞는 성별 명사. gender가 없으면 중립 표현으로 폴백한다.
// 'Korean'을 명사에 내장한다 — 레퍼런스 이미지가 안 실리는 장면(아동 폴백·hydrate 유실)에서
// 인물 단서가 프롬프트에 전혀 없으면 모델이 서양인 디폴트로 그린다(2026-08-03 금발 외국인 실측).
export function subjectNoun(age, gender) {
  const child = age <= 14
  if (gender === 'male') return child ? 'Korean boy' : 'Korean man'
  if (gender === 'female') return child ? 'Korean girl' : 'Korean woman'
  return child ? 'Korean child' : 'Korean person'
}

// ── 2단계 얼굴 앵커 A단계: "그 나이의 얼굴" 포트레이트 ─────────────────────────────
// 파노라마(flash 4:1)는 얼굴이 작고 왜곡돼 정체성+aging을 동시에 못 살린다. 그래서 얼굴 앵커
// 사진 하나에서 "그 나이의 같은 사람" 얼굴을 pro로 크게(3:4) 먼저 뽑아 두고, 그 포트레이트를
// 파노라마 단계의 레퍼런스로 넘긴다(파노라마는 aging을 안 하고 이 얼굴을 배치만 한다). 배선·캐시는
// aged-anchor.js. Kontext 노트 교훈: 모델은 "N살로 바꿔라" 같은 추상 지시를 무시하므로 나이대별로
// '무엇이 물리적으로 달라지는지'를 직접 나열한다.

// 목표 나이의 표면적 노화/성장 특징. 정체성(골격·이목구비 간격·눈 모양)은 유지하고, 여기 나열한
// 표면 특징만 그 나이에 맞게 바뀌도록 한다.
function ageTraitsFor(age) {
  // 아동·청소년 — 얼굴 참조 최대화(2026-08-03): 아동 나이도 앵커 없이 두지 않고 그 나이 얼굴
  // 포트레이트를 시도한다(IMAGE_SAFETY로 실패하면 호출부가 텍스트 폴백). 골격·이목구비 비율은
  // 유지한 채 나이대의 표면 특징만 나열한다.
  if (age <= 6)
    return 'the soft round face of a small child — chubby cheeks, eyes large relative to the face, a delicate small nose and mouth, fine soft hair'
  if (age <= 12)
    return 'the face of a school-age child — round soft features, perfectly smooth skin, bright clear eyes, fine youthful hair'
  if (age < 18)
    return 'the fresh face of a teenager — youthful smooth skin, adolescent facial proportions between child and adult, thick full hair'
  if (age < 25)
    return 'youthful smooth clear taut skin, no wrinkles, full thick hair, bright fresh under-eyes — a young adult face in its early bloom'
  if (age < 35)
    return 'smooth skin with only the faintest early expression lines, still-full hair, a healthy adult face in its prime'
  if (age < 45)
    return 'light forehead lines and eye-corner creases beginning to set in, subtly maturing skin, hair still mostly full but perhaps a touch thinner'
  if (age < 55)
    return 'clear forehead lines and crow’s-feet, softening cheeks and early nasolabial folds, hair thinning and greying at the temples'
  if (age < 65)
    return 'deeper wrinkles across the forehead and around the eyes and mouth, a loosening jawline, visibly grey and thinning hair, mature older-adult skin'
  if (age < 75)
    return 'deep-set wrinkles, sagging jowls and a creased neck, age spots, sparse grey or white hair — clearly elderly features'
  return 'heavily wrinkled and creased skin, hollowed and sagging features, thin white hair, prominent age spots — a frail, very old face'
}

/**
 * A단계 포트레이트 프롬프트 — 얼굴 앵커 사진을 "그 나이의 같은 사람" 근접 포트레이트로 변환.
 * pro 모델 + 3:4 근접 프레임 전제(장면·배경·왜곡 없음)라, 모델이 픽셀을 오롯이 정체성+나이 변환에
 * 쓴다. 결과 포트레이트가 파노라마 단계(flash)의 레퍼런스가 된다. §1 무관(감정·서사 없이 얼굴만).
 * @param {{gender?:string}} profile
 * @param {number} age
 * @param {{isPast?:boolean}} [opts]  과거=젊게, 미래=늙게 (문구만 다르고 특징은 age가 결정)
 */
export function composeAgedPortraitPrompt(profile, age, { isPast = false } = {}) {
  const noun = subjectNoun(age, profile?.gender)
  const when = isPast
    ? `exactly as this same person looked when they were ${age} years old`
    : `exactly as this same person will realistically look when they are ${age} years old in the future`
  return (
    `A clear, evenly lit head-and-shoulders portrait photograph of ONE single person — ${when}.` +
    ` The attached photograph is the reference for this person’s facial identity: keep the SAME underlying bone structure,` +
    ` the same eye shape, and the same spacing and proportions of the eyes, nose and mouth — unmistakably the same individual.` +
    ` Change ONLY what genuinely changes with age: ${ageTraitsFor(age)}.` +
    ` A ${age}-year-old ${noun}, face turned toward the camera, calm neutral relaxed expression,` +
    ` a plain softly-lit neutral studio background, the face large in frame and in sharp focus.` +
    ` Photorealistic, natural realistic skin texture, soft warm light, 35mm photograph.` +
    NO_TEXT_DIRECTIVE
  )
}

// ── 3인칭 관조(부감) 구도 — 크리스마스 캐롤의 스크루지가 자기 삶을 내려다보듯 ──────────
// 모든 장면은 그 순간을 약간 위에서 내려다보는 3인칭 부감(high angle)으로 본다. 관람객은
// 자기 삶의 한 장면을 바깥에서, 조금 떨어진 위쪽에서 관조한다. 이 부감 구도가 필수다.
//  1. 주인공은 화면 중심에 보이고, 자기 얼굴도 드러난다(초점 안).
//  2. (폐기, 2026-08-04) 과거엔 주인공 외 인물 얼굴을 smear로 뭉갰으나, 이제 모든 얼굴을
//     선명하게 그린다 — STYLE도 deep focus + 전 인물 얼굴 또렷로 교체됨.
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
    koreanContextFor(item) +
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
    koreanContextFor(item) +
    future +
    (extra ? ` ${extra}.` : '') +
    ` ${STYLE}` +
    NO_TEXT_DIRECTIVE
  )
}

/** SDXL 폴백용 서술형 프롬프트 — 3인칭 부감 구도 동일 유지. "high angle"은 SDXL이 잘 아는 태그다. */
export function composeSdxlPrompt(profile, item) {
  const who = `a ${item.age}-year-old ${subjectNoun(item.age, profile.gender)}`
  const extra = (profile.descriptors || []).join(', ')
  return `strong high angle shot, elevated camera raised well above and tilted downward looking down on the scene, third person view seen from above, floor and ground filling much of the frame, observing a memory from outside, ${who} as the central subject clearly visible with their own face in focus, ${item.scene}, set in South Korea with distinctly Korean architecture and everyday details unless the scene names another country${extra ? `, ${extra}` : ''}, ${STYLE}`
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
 * mode별 장면 프롬프트 선택 — 여러 호출처(life-library 생성, admin 재생성·성별수정)의
 * 4-way 분기 중복을 한 곳으로 모은다. 새 mode를 추가할 때 여기만 고치면 된다.
 *   sdxl → 3인칭 부감 태그형 / gemini → 3인칭 부감 서술형 /
 *   seamfix → 1인칭 360° 파노라마(B안) / 그 외(kontext, 구 hybrid) → 편집형 부감
 */
// 스케일·깊이 지시(2026-08-03, 장례식 파노라마에서 검증된 블록의 범용판) — 거리 지시가 없으면
// 모델이 주인공·소품을 화면 가득 채워 배경(공간)이 죽는다. 실측 360 실내 사진처럼 카메라를
// 피사체에서 몇 미터 떼고, 인물·사물을 작게, 바닥·천장·공간 자체가 프레임 대부분을 차지하게 한다.
// 장면 내용을 오염시키는 이미지 레퍼런스(장례식 사진 등) 없이 텍스트만으로 거리감을 강제한다.
// 주인공 얼굴은 여전히 알아볼 수 있어야 한다(정체성 앵커) — "작지만 전신+식별 가능한 얼굴"로 절충.
// 전신 불변식(2026-08-04 사용자 확정) — 모든 파노라마(장면·장례식 공통)의 포인트는 등장 인물
// 전원의 전신이 잘리지 않고 나오는 것. 프레임 가장자리에 머리·다리가 잘리는 인물이 하나라도
// 있으면 실패다. 장례식 프롬프트(funeral.js)도 이 상수를 import해 같은 규칙을 쓴다.
export const FULL_BODY_RULE =
  ` FULL BODIES, NOTHING CROPPED: EVERY person in the scene — the main subject and every background figure —` +
  ` is shown in COMPLETE FULL FIGURE from the top of the head to the soles of the feet, entirely inside the frame.` +
  ` NO person is cropped by any edge of the image: no cut-off heads, no cut-off legs, and the FEET and the patch of` +
  ` floor or ground directly beneath each person are always visible, with their shadow falling on it.` +
  ` If in doubt, render people SMALLER within the frame rather than ever cropping any part of anyone.`

const EQUIRECT_SCALE =
  ` IMPORTANT SCALE: shot like a real 360 camera on a tripod at eye height, standing FAR AWAY — a good 8 to 10 meters — from the` +
  // "small fraction"이 인물을 픽셀 몇 줌으로 몰아 해부학이 뭉개졌다(2026-08-04) — 이후 1/4~1/3로
  // 절충했으나 거리감이 부족하다는 피드백(2026-08-04)으로 세로 1/5 기준으로 다시 낮춤.
  // 해부학 보호는 "cleanly and completely rendered" 지시로 유지한다.
  ` main subject — everything is seen from a distance, as in a real interior/exterior panorama. The main subject appears` +
  ` far away within the wide space: full figure from head to toe, standing only about ONE FIFTH of the image height tall —` +
  ` clearly distant, yet their body and face are still cleanly and completely rendered, with their face recognizable.` +
  ` Do NOT fill the frame with the person or with large close objects.` +
  ` A wide expanse of open ground or floor stretches across the bottom of the panorama between the camera and everything else,` +
  ` and the ceiling or sky spreads across the entire top; the environment itself — walls, buildings, furniture, landscape,` +
  ` empty space — reads as a subject in its own right and fills most of the frame, with generous open space around every person and object.` +
  FULL_BODY_RULE

// equirect 360° 기하 강제 지시(장면 내 간판·현수막 텍스트까지 억제).
const EQUIRECT_GEO =
  ` TRUE equirectangular projection (spherical panorama unwrapped): the horizon runs straight across the vertical middle;` +
  ` the floor/ground sweeps across the ENTIRE bottom stretching toward the nadir (straight down) and the ceiling/sky across the ENTIRE top toward the zenith;` +
  ` straight lines (window frames, ceiling edges, desks, poles) visibly BOW and CURVE away from the center as in a real 360 camera capture;` +
  ` the place wraps completely around the single viewpoint so the far LEFT and far RIGHT edges are the same direction behind the camera.` +
  // 인체 예외(2026-08-04) — 위 "직선은 휘어라" 지시를 모델이 사람 몸에도 적용해 인체가 휘거나
  // 상하체가 어긋나는 사례가 잦았다. 왜곡은 건축·공간에만 걸고 인물은 명시적으로 보호한다
  // (실제 360 사진에서도 화면 중앙 부근 인물은 거의 왜곡되지 않는다 — 물리적으로도 맞는 지시).
  ` IMPORTANT: this bending applies ONLY to the architecture and environment — HUMAN BODIES are NEVER bent, warped, stretched, split or distorted.` +
  ` Every person, especially the central subject near the middle of the frame where a real 360 camera shows almost no distortion,` +
  ` has a complete, correctly proportioned, anatomically intact body — head, torso and legs naturally connected.` +
  ` Photorealistic, natural light. Absolutely NO text anywhere — no signs, no banners, no writing on walls, boards or screens, no watermark; not an illustration.`

/**
 * 1인칭 360° equirect gaze 프롬프트 — 주인공이 화면 중앙에서 그 장면의 행동을 능동적으로 수행하고,
 * 360°로 그 행동의 맥락(주변)을 보여준다. 주인공은 "그냥 서 있는" 역할이 아니라 그 순간의 주체다.
 * 다른 인물은 배경 조연일 뿐 주인공의 역할을 대신하지 않는다(얼굴 blur/smear 처리는 제거함, 2026-07-22). 진짜 360 기하.
 * 순수 Gemini 생성이라 Flux(seamfix 이음매·kontext) 단계가 없다.
 */
export function composeEquirectGazePrompt(profile, item) {
  const who = `a ${item.age}-year-old ${subjectNoun(item.age, profile.gender)}`
  const extra = (profile.descriptors || []).join(', ')
  const future = item.isPast ? '' : ` An imagined moment further along in this life.`
  return (
    // 거리 선언을 최선두로(2026-08-04 widefirst 프로브 검증) — 뒤쪽 EQUIRECT_SCALE만으로는
    // 모델이 앞의 "얼굴 선명" 지시를 우선해 인물을 화면 가득 채웠다(세로 70~80%). 카메라 위치를
    // 문장 처음에 확정하고 얼굴 지시를 "식별 가능" 수준으로 완화하니 세로 ~40%까지 물러남.
    `EXTREME WIDE SHOT, camera VERY FAR from every person. The environment is the primary subject;` +
    ` all people are small distant figures. The main subject stands only about ONE FIFTH of the image height tall.` +
    // "at the very heart of" → "inside" — 스케일 블록(FAR AWAY, 8~10m)과 모순되지 않게.
    ` A 360-degree equirectangular panoramic photograph, captured with a 360 camera from a single fixed point inside this moment: ${item.scene}.` +
    ` At the exact horizontal CENTER of the frame, far away, is ${who} — the person whose memory this is and the one and only main subject.` +
    ` THEY are unmistakably the one performing the action of this moment, fully and actively engaged in it (not merely standing or posing); their face, small at this distance, is still recognizable, though they need not face the camera.` +
    ` The place wraps a full 360 degrees around them, revealing the surroundings and the context of what they are doing.` +
    ` Anyone else present is only a secondary bystander in the background and never takes over the main action — the central person is the sole active protagonist.` +
    ` Every face in the scene is natural and undistorted — no smeared or mangled faces anywhere.` +
    koreanContextFor(item) +
    EQUIRECT_SCALE +
    EQUIRECT_GEO +
    future +
    (extra ? ` ${extra}.` : '')
  )
}

export function composeScenePromptFor(mode, profile, item) {
  if (mode === 'sdxl') return composeSdxlPrompt(profile, item)
  if (mode === 'gemini') return composeGeminiScenePrompt(profile, item)
  if (mode === 'seamfix') return composePanoramaScenePrompt(profile, item)
  if (mode === 'equirect') return composeEquirectGazePrompt(profile, item)
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
    ` The surrounding environment of this moment, seen from within: ${item.scene}.` +
    ` At the center of it is ${who} — the one and only main subject, actively and unmistakably performing the action of this moment (not merely standing or posing), their face clearly visible and in focus.` +
    ` Any other people are only secondary bystanders in the background and never take over the action.` +
    ` Every face in the scene, including background people, is natural, sharp and clearly rendered — no blurred, smeared or obscured faces anywhere.` +
    koreanContextFor(item) +
    EQUIRECT_SCALE +
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
