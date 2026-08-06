// cdb-crafter(인생그래프 앱) 세션 → 장면 플랜.
//
// life-library.js/prompt-builder.js의 옛 파이프라인은 occupation + 고정 10단계 나이 템플릿을
// 전제로 한다. cdb-crafter는 완전히 다른 재료를 준다 — 사용자가 실제로 그린 감정곡선의
// 15개 나이 구간(0~3세부터 85~90세까지)마다 { x(감정 위치), text(직접 쓴 글), imageURL(사진, 과거~현재만) }.
//
// 2단계 파이프라인:
//   1) 합성 — 세션의 7단계 text 전체를 한 번에 LLM에 넣어, 3~90세를 15등분한 나이 격자
//      (AGE_TO_STAGE, 15개 나이)마다 장면 후보 SCENES_PER_AGE(2)개로 "그 사람 고유"의 장면 데이터를
//      만든다(buildSynthesisPrompt → synthesizeAgeScenes). 텍스트가 없는 단계는 합성 대상에서
//      제외하고 prompt-builder.js의 fallbackScenesForAge()가 옛 STAGES 후보 풀로 채운다.
//   2) 플랜 — buildLifeGraphPlan()이 합성 결과(또는 폴백)를 16나이 × 2장 = 32장짜리
//      plan(life-library.js의 manifest.images 항목과 같은 모양)으로 편다.
//
// §1(해석적 자율성) 준수:
//   - 감정 위치(x)는 이 플랜에 기록만 하고 장면 문구(scene)에는 섞지 않는다.
//   - 합성 프롬프트는 "장소·빛·사물·행동" 같은 감각 재료만 요청하고 감정·의미 해석을 명시적으로 금지한다.
//     사용자 문장에 없는 인접 장면을 상상하는 건 허용하지만(느슨한 확장), 그 삶에 어떤 의미가
//     있었는지를 AI가 판단하는 건 금지 — 서사를 완성하는 게 아니라 재료를 흩어놓는 역할로 제한한다.
//   - 텍스트가 없는 단계는 AI가 없는 데이터로 지어내지 않고, 미리 써둔(사람이 쓴) STAGES 후보
//     풀에서 결정론적으로 고른다(fallbackScenesForAge).
//
// LIFE_STAGES는 cdb-crafter/src/stageUtils.js의 LIFE_STAGES와 반드시 짝을 맞춰야 한다(별도
// 리포지토리라 import 공유 불가) — 그쪽이 바뀌면 여기도 같이 고칠 것.
// (2026-07-30: cdb-crafter가 7단계 생애주기 그룹에서 3/9/15/22/28/34/40/47/53/59/65/71/78/84/90세
// 15구간으로 전환 — id가 `age-{maxAge}`로 바뀌어 AGE_TO_STAGE와 1:1로 맞춰 갱신함.)
import { fallbackScenesForAge } from './prompt-builder.js'

export const LIFE_STAGES = [
  { id: 'age-3', label: '0~3세' },
  { id: 'age-9', label: '4~9세' },
  { id: 'age-15', label: '10~15세' },
  { id: 'age-22', label: '16~22세' },
  { id: 'age-28', label: '23~28세' },
  { id: 'age-34', label: '29~34세' },
  { id: 'age-40', label: '35~40세' },
  { id: 'age-47', label: '41~47세' },
  { id: 'age-53', label: '48~53세' },
  { id: 'age-59', label: '54~59세' },
  { id: 'age-65', label: '60~65세' },
  { id: 'age-71', label: '66~71세' },
  { id: 'age-78', label: '72~78세' },
  { id: 'age-84', label: '79~84세' },
  { id: 'age-90', label: '85~90세' }
]

// 합성 프롬프트(영어)에서 쓰는 단계 라벨 — LIFE_STAGES의 label은 cdb-crafter UI와 짝이 맞아야
// 해서 한국어로 둔다. 프롬프트에는 이쪽 영어 라벨만 쓴다.
const STAGE_LABELS_EN = {
  'age-3': 'early infancy (ages 0-3)',
  'age-9': 'early childhood (ages 4-9)',
  'age-15': 'adolescence (ages 10-15)',
  'age-22': 'young adulthood (ages 16-22)',
  'age-28': 'early independence (ages 23-28)',
  'age-34': 'settling into adult life (ages 29-34)',
  'age-40': 'building a career and family (ages 35-40)',
  'age-47': 'midlife responsibility (ages 41-47)',
  'age-53': 'later midlife (ages 48-53)',
  'age-59': 'approaching a life transition (ages 54-59)',
  'age-65': 'a time of transition (ages 60-65)',
  'age-71': 'early later life (ages 66-71)',
  'age-78': 'later life (ages 72-78)',
  'age-84': 'advanced age (ages 79-84)',
  'age-90': 'very late life (ages 85-90)'
}

// 한 나이당 만드는 장면(=이미지) 수. 나이 격자를 촘촘하게 가져가는 대신 나이마다 2장만 만든다
// — 같은 나이에서 3장 이상은 서로 비슷해져서 얻는 게 없다.
// 두 장은 역할이 다르다(2026-08-04, 아래 합성 프롬프트): scene 1 = 그 시기의 반복되는 일상,
// scene 2 = 그 시기의 특정한 하루(사건). 같은 재료에서 비슷한 변주 2개가 나오는 걸 막는 장치라
// SCENES_PER_AGE를 바꾸면 두 프롬프트의 역할 문구도 같이 고쳐야 한다.
export const SCENES_PER_AGE = 2
// 3차(분기 미래)는 시기당 **한 장면**만 만든다(2026-08-05 사용자 확정) — 분기 체험(3차 플로우)에서는
// "같은 시기의 다른 모습" 선택지가 없다. 대화 카탈로그도 나이당 장면 하나라 그 분기가 자연히 닫힌다.
export const BRANCH_SCENES_PER_AGE = 1

// 나이별 장면 생성 기준 — 3세부터 90세까지를 15등분한 나이 격자(× SCENES_PER_AGE = 30장).
// 3 + i×(87/14), i=0..14 를 반올림한 값이다.
// 각 나이는 정확히 하나의 LIFE_STAGE sublabel 범위 안에 들어간다(예: growth 8~19세 → 9·15세 둘 다 포함).
// prompt-builder.js STAGES의 10개 나이와 더는 일치하지 않는다 — 폴백은 가장 가까운 STAGES 나이로 매칭된다.
export const AGE_TO_STAGE = {
  3: 'protect',
  9: 'growth',
  15: 'growth',
  22: 'independence',
  28: 'settling',
  34: 'settling',
  40: 'responsibility',
  47: 'responsibility',
  53: 'transition',
  59: 'transition',
  65: 'settlement',
  71: 'settlement',
  78: 'settlement',
  84: 'settlement',
  90: 'settlement'
}

// crafter 격자에 없는 나이 → 점을 빌려올 격자 나이. 새(나이 키) 스키마 전용 —
// 옛 단계 스키마는 AGE_TO_STAGE의 단계 키로 이미 같은 점을 공유한다.
export const AGE_POINT_ALIAS = { 2: 6 }
export const AGES = Object.keys(AGE_TO_STAGE)
  .map(Number)
  .sort((a, b) => a - b)

// 마지막 나이(90세)의 마지막 한 장은 AI 합성이 아니라 여기 고정된 장면으로 만든다 — 주마등의
// 끝을 임종의 자리로 닫는 연출적 결정이다. §1과의 긴장을 의식적으로 남겨둔다: 이건 AI가
// "이 삶이 이렇게 끝났다"고 판단한 게 아니라 설치 전체가 임사체험을 은유로 쓰는 데서 오는
// 고정 프레임이고, 그 자리에서 무엇을 볼지는 여전히 사용자에게 열려 있다. 문구는 다른 장면과
// 같은 영어 캡션 문체 — 감정·의미 서술 없이 감각 재료만.
export const FINAL_SCENE =
  'lying in a hospital bed in a quiet ward, a thin blanket drawn up to the chest,' +
  ' late afternoon light through a window, an empty chair beside the bed'

// ── 세션 점 스키마 어댑터(2026-08-03, 배열 스키마 2026-08-04) ──────────────────
//
// cdb-crafter가 점의 키·모양을 바꿔 왔다. 세 형태가 공존한다:
//
//   [옛] 단계 키   — { protect|growth|…|settlement: {x,text,imageURL}, future-<id>: {…} }
//                    7개 생애주기 단계마다 점 하나. 미래는 `future-` 접두. 한 단계에 나이가
//                    여럿 매달린다(growth = 9세·15세) — 그 나이들이 같은 글·같은 사진을 공유했다.
//   [중간] 나이 키 — { "age-3", "age-9", … : {x,text,imageURL} }
//                    AGE_TO_STAGE의 나이 격자와 1:1. 나이마다 자기 글과 자기 사진을 갖는다.
//                    `future-` 접두가 없고, **문서의 age보다 큰 나이가 곧 미래**다.
//   [새] 점 배열   — { "age-6": [ {age,x,event,companion,place,imageURL}, … 최대 3개 ], … }
//                    구간(id)마다 점이 배열로 최대 3개, 점마다 **자기 정확한 나이(age)**와
//                    구조화된 필드(event=사건, companion=함께한 사람, place=장소)를 갖는다.
//                    옛 text 자리는 event가 잇는다(composePointText가 세 필드를 한 줄로 합친다).
//                    구간 id 격자는 crafter 쪽 사정으로 계속 흔들리므로 여기서는 믿지 않고,
//                    각 점의 age를 AGES 격자의 가장 가까운 나이에 배정해 쓴다.
//
// 옛 문서는 기존 참가자의 재생성이 걸려 있어 계속 받는다 — 아래 resolveAgePoint 하나가 그
// 차이를 전부 흡수하고, 나머지 코드는 "나이 → 점 {x,text,imageURL,age?}"로만 생각한다.

/** 이 세션이 새(나이 키) 스키마인가 — `age-<숫자>` 키가 하나라도 있으면 그렇다. */
export function isAgeKeyedSession(sessionPoints = {}) {
  return Object.keys(sessionPoints).some((k) => /^age-\d+$/.test(k))
}

/** 이 세션이 점 배열 스키마인가 — 구간 값이 배열인 키가 하나라도 있으면 그렇다. */
export function isArrayPointSession(sessionPoints = {}) {
  return Object.values(sessionPoints).some(Array.isArray)
}

/**
 * 점 배열 스키마의 점 하나 → 옛 text 한 줄(한국어). 합성·회고·장례식 프롬프트가 전부
 * "본인이 쓴 글"로 원문 인용하므로, 구조화 필드를 사람이 쓴 문장처럼 한 줄로 합친다.
 */
export function composePointText(point = {}) {
  const event = point.event?.trim() || point.text?.trim() || ''
  const extras = []
  if (point.companion?.trim()) extras.push(`함께한 사람: ${point.companion.trim()}`)
  if (point.place?.trim()) extras.push(`장소: ${point.place.trim()}`)
  if (!event) return extras.length ? extras.join(', ') : ''
  return extras.length ? `${event} (${extras.join(', ')})` : event
}

/** age와 가장 가까운 AGES 격자 나이(동률이면 젊은 쪽). */
export function nearestGridAge(age) {
  let best = AGES[0]
  for (const a of AGES) if (Math.abs(a - age) < Math.abs(best - age)) best = a
  return best
}

/**
 * 점 배열 스키마를 편다 → 격자 나이(AGES) → 그 나이에 배정된 점들.
 * 각 점은 자기 age 기준 **가장 가까운 격자 나이 하나**에만 배정된다 — 격자→점의 역방향으로
 * 당기면(가까운 점 아무거나) 참가자가 안 찍은 미래 나이까지 과거 점이 흘러 들어가
 * 외삽(extrapolationAges) 판정이 깨진다.
 * key는 '구간id#인덱스'(점 1개면 구간id 그대로) — plan.stageId·사진 맵이 이 키로 점을 되찾는다.
 */
function arrayPointsByGridAge(sessionPoints = {}) {
  const byAge = new Map()
  for (const [stageId, value] of Object.entries(sessionPoints)) {
    if (!Array.isArray(value)) continue
    value.forEach((p, i) => {
      if (!p || typeof p !== 'object') return
      const own = Number(p.age)
      const age = Number.isFinite(own) ? Math.round(own) : ageOfStageId(stageId)
      if (age == null) return
      const grid = nearestGridAge(age)
      if (!byAge.has(grid)) byAge.set(grid, [])
      byAge.get(grid).push({
        key: value.length > 1 ? `${stageId}#${i}` : stageId,
        age,
        x: p.x ?? null,
        text: composePointText(p),
        imageURL: p.imageURL ?? null
      })
    })
  }
  return byAge
}

/**
 * 프로필의 현재 나이 — 새 스키마의 과거/미래 판정 기준선. doc.age가 있으면 그것,
 * 없으면 birthDate로 센다. 둘 다 없으면 null(그 경우 전부 과거로 본다 — 옛 동작과 같음).
 */
export function currentAgeOf(profile = {}) {
  if (Number.isFinite(profile.age) && profile.age > 0) return Math.round(profile.age)
  const birthYear = parseInt(String(profile.birthDate ?? '').slice(0, 4), 10)
  if (!Number.isFinite(birthYear)) return null
  const age = new Date().getFullYear() - birthYear
  return age > 0 && age < 130 ? age : null
}

/**
 * 나이 하나에 해당하는 세션 점을 두 스키마 모두에서 찾는다.
 * @param {number} age
 * @param {object} sessionPoints
 * @param {object} [profile]  현재 나이 판정용(새 스키마의 미래 구분)
 * @returns {{ key:string, isFuture:boolean, point:object }|null}
 *   key는 이 점의 문서상 키다 — 사진 맵(collectStagePhotoURLs)과 plan의 stageId가 이 값을 쓴다.
 *   옛 스키마에선 여러 나이가 같은 key를 공유하고(= 같은 사진), 새 스키마에선 나이마다 다르다.
 */
export function resolveAgePoint(age, sessionPoints = {}, profile = {}) {
  // 점 배열 스키마 — 이 격자 나이에 배정된 점들 중 나이가 가장 가까운 점을 대표로 쓰되,
  // 같은 격자 나이에 배정된 다른 점들의 글도 잃지 않고 합쳐 싣는다(사진은 대표 우선).
  if (isArrayPointSession(sessionPoints)) {
    const gridAge = AGE_POINT_ALIAS[age] ?? age
    const entries = arrayPointsByGridAge(sessionPoints).get(gridAge)
    if (!entries?.length) return null
    const primary = [...entries].sort(
      (a, b) => Math.abs(a.age - gridAge) - Math.abs(b.age - gridAge) || a.age - b.age
    )[0]
    const texts = entries.map((e) => e.text).filter(Boolean)
    const cur = currentAgeOf(profile)
    return {
      key: primary.key,
      isFuture: cur != null && age > cur,
      point: {
        age: primary.age, // 점의 실제 나이 — 프롬프트 표기가 격자 나이 대신 이걸 쓴다
        x: primary.x,
        text: texts.join(' / '),
        imageURL: primary.imageURL || entries.find((e) => e.imageURL)?.imageURL || null
      }
    }
  }
  // 격자 밖 나이(2세)는 별칭 격자 나이(6세)의 점을 그대로 빌린다 — key도 그 점의 키라서
  // 사진 맵·합성 프롬프트가 자연히 "한 점에 나이 여럿"(옛 스키마와 같은 모양)으로 묶인다.
  const ageKey = `age-${AGE_POINT_ALIAS[age] ?? age}`
  if (sessionPoints[ageKey]) {
    const cur = currentAgeOf(profile)
    // 미래 = 지금 나이를 넘어선 나이. 기준을 못 구하면 전부 과거로 둔다(사진·앵커 규칙이 과거 전제).
    return { key: ageKey, isFuture: cur != null && age > cur, point: sessionPoints[ageKey] }
  }
  const stageId = AGE_TO_STAGE[age]
  if (!stageId) return null
  const futureId = `future-${stageId}`
  if (sessionPoints[futureId])
    return { key: futureId, isFuture: true, point: sessionPoints[futureId] }
  if (sessionPoints[stageId])
    return { key: stageId, isFuture: false, point: sessionPoints[stageId] }
  return null
}

// ── 세션 부가 데이터(2026-08-04) ─────────────────────────────────────────────
//
// crafter는 점(나이별 글·사진) 외에도 sessionPoints 안에 같은 레벨로 이것들을 담는다:
//   selections — { influential|best|worst: { stageId: "age-33", reason } } 인생의 세 순간
//   funeral    — { messages: [{to,text}], epitaph } 장례식 상상(마지막 편지·묘비명)
//   myLife     — { motto, bucketList }
// 전부 사용자가 직접 쓴 글이므로 §1(해석적 자율성)의 "본인 재료" 범주다 — 합성·외삽 프롬프트에
// 원문 그대로 실어 LLM이 장소·사물·사건을 더 그 사람답게 추측하는 근거로 쓴다.
// 감정 위치(x)는 여전히 프롬프트에 넣지 않는다(§1 경계 유지).

const SELECTION_LABELS_EN = {
  influential: 'the most influential moment of their life',
  best: 'the best moment of their life',
  worst: 'the hardest moment of their life'
}

function ageOfStageId(stageId) {
  const m = /^age-(\d+)$/.exec(String(stageId ?? ''))
  return m ? Number(m[1]) : null
}

// ── myLife 스키마 두 벌(2026-08-06) ──────────────────────────────────────────
// 예전: 맵 하나 { motto, bucketList }. 새 스키마: 회차별 배열 [{ motto, bucketList, createdAt }]
// — 체험(유령 대화) 뒤 crafter가 새 항목을 **추가**한다(덮어쓰지 않음). 최초 작성분은
// createdAt이 null일 수 있다. 저장 위치도 세션 맵 안(first.myLife)일 수도, profiles 문서
// 최상위(profile.myLife)일 수도 있어 읽는 쪽이 둘 다 본다.

/**
 * myLife에서 항목 하나를 고른다. 배열이면 createdAt 문자열 정렬로 first(체험 전 원본) 또는
 * latest(체험 후 갱신본)를 택한다 — createdAt null(빈 문자열 취급)이 자연히 맨 앞에 온다.
 * @param {object|Array|null} myLife
 * @param {'first'|'latest'} [which='latest']
 * @returns {{motto?:string, bucketList?:string}|null}
 */
export function pickMyLifeEntry(myLife, which = 'latest') {
  if (!myLife) return null
  if (!Array.isArray(myLife)) return myLife
  const arr = myLife.filter(Boolean)
  if (!arr.length) return null
  const sorted = [...arr].sort((a, b) =>
    String(a?.createdAt || '').localeCompare(String(b?.createdAt || ''))
  )
  return which === 'first' ? sorted[0] : sorted[sorted.length - 1]
}

/**
 * selections 항목 하나가 가리키는 점의 실제 나이. 점 배열 스키마는 { stageId, index }가
 * 배열 속 점 하나를 가리키므로 그 점의 age를 쓰고, 아니면 stageId의 숫자로 폴백.
 */
function selectionAge(sessionPoints, sel) {
  if (!sel) return null
  const arr = sessionPoints[sel.stageId]
  if (Array.isArray(arr)) {
    const p = arr[sel.index ?? 0]
    const own = Number(p?.age)
    if (Number.isFinite(own)) return Math.round(own)
  }
  return ageOfStageId(sel.stageId)
}

/**
 * 세션의 부가 데이터를 프롬프트 재료로 편다.
 * @returns {{ marks: Record<number, Array<{kind,label,reason}>>, lines: string[] }}
 *   marks — 나이 → 그 나이에 찍힌 선택(influential/best/worst)들. 해당 나이의 "사건" 장면이 이걸 딛는다.
 *   lines — 사람 전체를 설명하는 영어 불릿(직업·모토·버킷리스트·묘비명·마지막 편지). 원문은 한국어 그대로.
 */
export function collectSessionContext(
  profile = {},
  sessionPoints = {},
  { myLifePick = 'latest' } = {}
) {
  const marks = {}
  for (const kind of ['influential', 'best', 'worst']) {
    const s = sessionPoints.selections?.[kind]
    const pointAge = selectionAge(sessionPoints, s)
    if (pointAge == null) continue
    // marks는 격자 나이로 조회된다(buildSynthesisPrompt의 entry.ages) — 점의 실제 나이(33 등)를
    // 그 점이 배정되는 격자 나이로 스냅해 같은 자리에서 만나게 한다.
    const age = nearestGridAge(pointAge)
    ;(marks[age] ??= []).push({
      kind,
      label: SELECTION_LABELS_EN[kind],
      reason: s.reason?.trim() || ''
    })
  }
  const lines = []
  const job = profile.job || profile.occupation
  if (job) lines.push(`- Occupation: ${job}`)
  // myLife는 세션 맵 안(예전) 또는 profiles 문서 최상위(새 스키마) — 있는 쪽을 읽는다.
  const myLifeEntry = pickMyLifeEntry(sessionPoints.myLife ?? profile.myLife, myLifePick)
  const motto = myLifeEntry?.motto?.trim()
  if (motto) lines.push(`- Their life motto (their own words, Korean): "${motto}"`)
  const bucketList = myLifeEntry?.bucketList?.trim()
  if (bucketList) lines.push(`- Their bucket list (their own words, Korean): "${bucketList}"`)
  const epitaph = sessionPoints.funeral?.epitaph?.trim()
  if (epitaph) lines.push(`- The epitaph they imagined for their own grave (Korean): "${epitaph}"`)
  for (const msg of sessionPoints.funeral?.messages || []) {
    const text = msg?.text?.trim()
    if (!text) continue
    lines.push(
      `- A farewell letter they imagined leaving${msg.to ? ` to "${msg.to}"` : ''} (Korean): "${text}"`
    )
  }
  return { marks, lines }
}

// 두 프롬프트가 공유하는 장면 역할·차별성 규칙 — scene 1(일상)과 scene 2(사건)를 갈라놓는 핵심.
const SCENE_ROLE_RULES =
  `The ${SCENES_PER_AGE} scenes of one age have DIFFERENT ROLES:\n` +
  `- scene 1 — an ORDINARY, RECURRING moment of daily life in that period: something that happened` +
  ` again and again (a commute, a meal at home, homework at a desk, a routine at work).\n` +
  `- scene 2 — ONE SPECIFIC day or event of that period: something that happened once or rarely` +
  ` (a move to a new home, a trip, a ceremony, a first day, an accident of weather or luck).\n` +
  `The two scenes of one age must ALSO differ in every one of: location, activity, and either` +
  ` time of day or who is present. Never write two variations of the same moment.`

/**
 * 1차 합성 프롬프트 — 사용자가 실제로 글을 남긴 점만 모아, 그 점이 맡은 나이마다 장면 후보
 * SCENES_PER_AGE개를 요청하는 LLM 프롬프트를 조립한다. 글이 하나도 없으면 prompt: null
 * (호출자는 합성을 건너뛰고 전부 폴백으로 채운다).
 *
 * 나이를 돌며 점을 찾고 **같은 점(key)에 매달린 나이들을 묶는다** — 옛 단계 스키마에선 한 단계에
 * 나이가 여럿 묶이고(growth = 9·15세), 새 나이 스키마에선 나이마다 점이 하나라 자연히 1:1이 된다.
 * 두 스키마가 같은 코드를 탄다.
 * @param {object} profile        { name, birthDate, age? }
 * @param {object} sessionPoints  Firestore 문서의 first/second/third 필드
 * @returns {{ prompt: string|null, ages: number[] }}  ages는 프롬프트가 요청한 나이 목록(중복 없음)
 */
export function buildSynthesisPrompt(profile, sessionPoints) {
  const byKey = new Map() // 점 key → { ages[], isFuture, text }
  for (const age of AGES) {
    const resolved = resolveAgePoint(age, sessionPoints, profile)
    if (!resolved) continue
    const text = resolved.point.text?.trim()
    if (!text) continue // 빈 점은 합성 대상에서 제외 — buildLifeGraphPlan이 폴백으로 채운다
    const entry = byKey.get(resolved.key) || {
      ages: [],
      isFuture: resolved.isFuture,
      text,
      stageId: AGE_TO_STAGE[age]
    }
    entry.ages.push(age)
    byKey.set(resolved.key, entry)
  }
  const entries = [...byKey.values()]
  if (entries.length === 0) return { prompt: null, ages: [] }

  // 부가 데이터 — 인물 설명 불릿과, 나이별 influential/best/worst 표시(사건 장면의 재료).
  const ctx = collectSessionContext(profile, sessionPoints)

  const lines = entries.map(({ stageId, ages, isFuture, text }) => {
    const en = STAGE_LABELS_EN[stageId]
    const timeLabel = isFuture ? `${en} (an imagined future)` : en
    const ageLabel = ages.length > 1 ? `ages ${ages.join(', ')}` : `age ${ages[0]}`
    const markNotes = ages
      .flatMap((a) => (ctx.marks[a] || []).map((m) => ({ ...m, age: a })))
      .map(
        (m) =>
          `\n  (they marked age ${m.age} as ${m.label}${m.reason ? ` — in their words: "${m.reason}"` : ''})`
      )
      .join('')
    return `- ${timeLabel} [${ageLabel}]: "${text}"${markNotes}`
  })

  // 필요한 키를 문장으로 설명만 하면(예: "ages 9, 15") 모델이 "9·15"처럼 묶은 키를 쓰거나
  // 하나를 빠뜨린다. 요구 키를 그대로 나열해 오해의 여지를 없앤다.
  const requiredKeys = [...new Set(entries.flatMap((e) => e.ages))].sort((a, b) => a - b)

  const sampleAges = requiredKeys.slice(0, 2)
  const sampleLabel =
    sampleAges.length > 1 ? `age ${sampleAges[0]} and age ${sampleAges[1]}` : `age ${sampleAges[0]}`
  const sceneArray = Array.from({ length: SCENES_PER_AGE }, (_, i) => `"scene ${i + 1}"`).join(', ')

  // 출력(장면 문구)은 반드시 영어다 — 이 문자열이 그대로 이미지 생성 프롬프트 한가운데에 꽂히고
  // (prompt-builder.js composeScenePromptFor), 나머지 프롬프트는 전부 영어라 한국어가 섞이면
  // 이미지 모델이 그 구절을 흘린다. STAGES 폴백 풀의 문체(현재분사 구 + 장소·빛·사물)와 맞춘다.
  // 지시문 자체는 영어지만 사용자 글은 원문(한국어) 그대로 넣는다 — 번역하면 재료가 뭉개진다.
  const prompt =
    `Below, a person has written short notes about each period of their own life (in Korean).` +
    ` Do not interpret or judge what their life meant — deal only with sensory detail that could` +
    ` plausibly have been there: places, light, objects, actions.\n\n` +
    `For each age listed, write ${SCENES_PER_AGE} scenes, each a different moment that could have` +
    ` happened within the period that note describes. You may imagine events not stated explicitly,` +
    ` as long as they fit that same period — but never write a sentence describing emotion or meaning,` +
    ` only what is visible. When one note covers several ages (e.g. ${sampleLabel}), make each age a` +
    ` distinct moment appropriate to that age.\n\n` +
    SCENE_ROLE_RULES +
    `\nWhen an age is marked below as an influential/best/hardest moment, let scene 2 (the specific` +
    ` event) of that age grow out of what they wrote about that moment — still only what is visible.` +
    ` Do not describe facial features, and do not include names, text, letters or captions.\n\n` +
    (ctx.lines.length
      ? `### About this person\n` +
        `Use these, written by the person themselves, to make your guesses about settings, objects and` +
        ` events more specific to THIS life — as background inference only, never quoted or depicted as` +
        ` text in a scene:\n${ctx.lines.join('\n')}\n\n` +
        `### What they wrote about each period\n`
      : '') +
    // 배경 국가 규칙(2026-08-03): 장면 문장이 국적 중립이면 이미지 모델이 미국식 공간을 디폴트로
    // 그린다. 기본은 한국이되, 사용자가 특정 나라를 언급한 시기("미국에서 학창시절", "영국 여행")는
    // 그 나라를 장면 문장에 그대로 명시하게 한다 — 이 문장이 이미지 프롬프트에 직접 꽂히기 때문.
    `This person is Korean and, by default, every scene takes place in South Korea — so where it helps,` +
    ` ground the scene in Korean specifics (a Korean classroom, a high-rise apartment complex, a Korean street).` +
    ` HOWEVER, if a note says a period happened in, or involved travel to, a specific other country or city` +
    ` (e.g. school years in the USA, a trip to England), then the scenes for those ages must explicitly name` +
    ` that place in the sentence (e.g. "walking through an American high school hallway", "riding a red double-decker bus in London")` +
    ` so the image model sets the scene there instead of Korea.\n\n` +
    `Write every scene in ENGLISH, one sentence each, in the style of a present-participle image` +
    ` caption — e.g. "riding a bicycle with training wheels down an apartment complex path" or` +
    ` "sitting by a classroom window, chin on hand, summer light on the desk".` +
    ` Never answer in Korean.\n\n` +
    lines.join('\n') +
    `\n\nRespond with JSON only, no other explanation: ` +
    `{ "<age>": [${sceneArray}], ... }\n` +
    `The keys must be exactly these ${requiredKeys.length} and none may be missing: ` +
    requiredKeys.map((a) => `"${a}"`).join(', ') +
    `\nEach value is an array of exactly ${SCENES_PER_AGE} English strings.` +
    ` Do not merge ages into one key like "${sampleAges.join('·')}".`

  const ages = entries.flatMap((e) => e.ages)
  return { prompt, ages }
}

// 한 나이의 두 장면이 "같은 순간의 변주"인지 판별 — 내용어 겹침 비율로 잡는다.
// 임베딩까지는 과하다: 겹치면 재요청 1회 비용뿐이라 오탐도 싸다. 실패 사유가 repair 프롬프트에
// 실려 다음 시도에서 같은 실수를 반복하지 않게 된다(runSynthesis 참조).
const SIMILARITY_STOPWORDS = new Set(
  'a an the in on at of with and or to by from for their his her its over under through into beside near light late morning afternoon evening'.split(
    ' '
  )
)
function sceneContentWords(s) {
  return new Set(
    String(s)
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !SIMILARITY_STOPWORDS.has(w))
  )
}
export function scenesTooSimilar(a, b) {
  const A = sceneContentWords(a)
  const B = sceneContentWords(b)
  if (!A.size || !B.size) return false
  let shared = 0
  for (const w of A) if (B.has(w)) shared += 1
  return shared / Math.min(A.size, B.size) >= 0.6
}

/**
 * buildSynthesisPrompt가 만든 프롬프트에 대한 LLM 응답 텍스트를 파싱·검증한다.
 * 형식 검증에 더해, 한 나이의 두 장면이 사실상 같은 순간이면(내용어 60%+ 겹침) 실패로 친다 —
 * 두 장은 일상/사건으로 역할이 갈라져야 한다(SCENE_ROLE_RULES).
 * @param {string} raw            gclient.generateText()가 반환한 원문
 * @param {number[]} expectedAges 응답에 반드시 있어야 하는 나이 키 목록
 * @returns {Record<number, string[]>}  { [age]: [장면1, 장면2] } — 길이는 SCENES_PER_AGE
 */
export function parseSynthesizedScenes(raw, expectedAges, perAge = SCENES_PER_AGE) {
  let text = String(raw ?? '').trim()
  text = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()

  let data
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error(`장면 합성 응답이 JSON이 아님: ${err.message} — 원문: ${text.slice(0, 300)}`)
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`장면 합성 응답이 객체가 아님: ${text.slice(0, 300)}`)
  }

  const out = {}
  for (const age of expectedAges) {
    const arr = data[String(age)]
    if (
      !Array.isArray(arr) ||
      arr.length !== perAge ||
      arr.some((s) => typeof s !== 'string' || !s.trim())
    ) {
      // 키가 통째로 없을 때 JSON.stringify(undefined)는 "undefined"라 원인 파악이 안 된다 —
      // 모델이 실제로 무슨 키를 줬는지 함께 보여준다.
      throw new Error(
        `장면 합성 응답에 나이 ${age}의 장면 ${perAge}개가 없음 (받은 값: ${JSON.stringify(arr) ?? 'undefined'}` +
          `, 응답 키: ${JSON.stringify(Object.keys(data))}, 요구 키: ${JSON.stringify(expectedAges.map(String))})`
      )
    }
    const scenes = arr.map((s) => s.trim())
    for (let i = 0; i < scenes.length; i += 1) {
      for (let j = i + 1; j < scenes.length; j += 1) {
        if (scenesTooSimilar(scenes[i], scenes[j])) {
          throw new Error(
            `나이 ${age}의 장면 ${i + 1}·${j + 1}이 사실상 같은 순간임 — scene 1은 반복되는 일상,` +
              ` scene 2는 특정한 하루의 사건으로, 장소·행동이 서로 달라야 한다.` +
              ` (받은 값: ${JSON.stringify(scenes[i])} / ${JSON.stringify(scenes[j])})`
          )
        }
      }
    }
    out[age] = scenes
  }
  return out
}

/**
 * 1차 합성 — 세션의 7단계 text를 종합해 나이별 장면 후보 SCENES_PER_AGE개씩을 LLM으로 만든다.
 * 글이 하나도 없는 세션이면 LLM을 호출하지 않고 빈 객체를 반환한다(전부 폴백으로 채워짐).
 * @param {import('./gemini-client.js').GeminiClient} gclient
 * @param {object} profile
 * @param {object} sessionPoints
 * @returns {Promise<Record<number, string[]>>}  글이 있던 단계의 나이만 포함 — 나머지는
 *   buildLifeGraphPlan이 fallbackScenesForAge로 채운다.
 */
async function runSynthesis(gclient, prompt, ages, attempts, perAge = SCENES_PER_AGE) {
  // 글이 있는 단계는 폴백으로 대체하지 않는 게 설계 의도라(§1), 형식 이탈은 폴백이 아니라
  // 재요청으로 푼다. 실패한 이유를 다음 시도의 프롬프트에 붙여 같은 실수를 반복하지 않게 한다.
  let lastErr
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const repair = lastErr
      ? `\n\n이전 응답이 형식을 어겼다: ${lastErr.message}\n요구한 키를 하나도 빠뜨리지 말고 다시 답하라.`
      : ''
    try {
      const raw = await gclient.generateText({ prompt: prompt + repair, responseJson: true })
      return parseSynthesizedScenes(raw, ages, perAge)
    } catch (err) {
      lastErr = err
      console.warn(`[life-graph-plan] 장면 합성 ${attempt}/${attempts} 실패: ${err.message}`)
    }
  }
  throw lastErr
}

/**
 * 사용자가 아직 점을 찍지 않은 **미래** 나이 목록 — 2차 합성(외삽)의 대상.
 * 현재 나이를 못 구하면 빈 배열(외삽하지 않는다 — 기준이 없으면 무엇이 미래인지 알 수 없다).
 */
export function extrapolationAges(profile, sessionPoints = {}) {
  const cur = currentAgeOf(profile)
  if (cur == null) return []
  return AGES.filter((age) => {
    if (age <= cur) return false
    const r = resolveAgePoint(age, sessionPoints, profile)
    return !r?.point?.text?.trim() // 본인이 쓴 미래가 있으면 그건 1차 합성이 이미 다뤘다
  })
}

/**
 * 2차 합성(미래 외삽) 프롬프트 — 사용자가 안 채운 미래 나이의 장면을 과거 기록에서 이어 만든다.
 *
 * 왜 폴백이 아니라 합성인가(사용자 확정, 2026-08-03): 전시의 2차 플로우는 **AI가 만든 미래를
 * 보는 과정**이다. 일반 노년 장면(STAGES 폴백 풀)으로는 "그 사람의 미래"가 아니라 아무의 노년이
 * 되어 2차가 성립하지 않는다. 그래서 여기서만은 없는 데이터를 확장한다.
 *
 * §1과의 관계를 분명히 해둔다: 이건 의식적인 예외다. 그래도 경계는 유지한다 — 이 삶이 어떤
 * 의미였는지 판단하거나 성공·실패를 매기지 않고, 감각 재료(장소·빛·사물·행동)만 잇는다.
 * 관람객에게는 이것이 AI의 상상이라고 말하지 않는 게 연출이지만, 코드와 manifest에는 그렇게
 * 남긴다(plan의 sceneSource='extrapolated' — 장면 출처를 나중에 되짚을 수 있어야 한다).
 *
 * 예측의 근거 배합(사용자 확정, 2026-08-03) — 프롬프트에 가중치를 명시해 한 갈래로 쏠리지 않게 한다:
 *   50% 인구통계 — 비슷한 배경(출생연도·성별·직업·지역)의 사람들이 실제로 밟는 삶의 궤적
 *   30% 본인이 쓴 미래 — 단, **어긋난 형태로**(아래 방향성 참조)
 *   10% 사주 — 생년월일의 대운(10년 주기)·소운 흐름
 *   10% 예기치 못함 — 계획대로 흐르지 않는 전환(삶은 예측대로 가지 않는다)
 * 그 위에 프로필·과거·현재를 얹어 "누구의 미래든 같은 노년"이 아니라 이 사람의 미래가 되게 한다.
 *
 * 방향성 변경(사용자 확정, 2026-08-05): 2차 미래는 **희망·버킷리스트가 이뤄지지 않은 미래**다 —
 * 어딘가 문제가 생겨 계획이 미뤄지고, 좌절되고, 조용히 접히는 궤적. 3차(분기 미래)가 "원하는
 * 대로 잘 풀린 미래"를 맡으면서 두 미래가 대비를 이룬다. §1 경계는 유지 — 성공·실패를 서술로
 * **판정하지 않고**, 이뤄지지 않았다는 사실만 카메라가 볼 수 있는 사건으로 보여준다.
 */
// 운명(2차) 외삽의 공용 재료 블록 — 연대기(1단계)와 장면 분해(2단계) 프롬프트가 공유한다.
// 근거가 하나도 없으면 null(폴백으로 둔다).
function futureExtrapolationMaterials(profile, sessionPoints, futureAges) {
  if (!futureAges?.length) return null
  const pastNotes = []
  const futureNotes = []
  const seen = new Set()
  for (const age of AGES) {
    const r = resolveAgePoint(age, sessionPoints, profile)
    if (!r || seen.has(r.key)) continue
    seen.add(r.key)
    const t = r.point?.text?.trim()
    if (!t) continue
    // 별칭 나이(2세)로 처음 만나도 점의 실제 나이(point.age 또는 age-6 → 6)로 표기한다 — LLM이 시기를 오해하지 않게.
    ;(r.isFuture ? futureNotes : pastNotes).push(
      `- age ${r.point?.age ?? ageOfStageId(r.key) ?? age}: "${t}"`
    )
  }
  // 부가 데이터(버킷리스트·모토·묘비명·마지막 편지) — 미래 외삽의 "본인이 쓴 미래" 재료를 두껍게 한다.
  // 2차(부정미래)는 **체험 전 원본** myLife를 딛는다 — "그때 품었던 소망이 이뤄지지 않은" 궤적이므로,
  // 체험 후 새로 쓴 갱신본(latest)이 아니라 첫 작성분(first)이 재료다.
  const ctx = collectSessionContext(profile, sessionPoints, { myLifePick: 'first' })
  if (pastNotes.length === 0 && futureNotes.length === 0 && ctx.lines.length === 0) return null // 근거가 없으면 폴백으로 둔다
  const cur = currentAgeOf(profile)
  const who = [
    profile.name ? `Name: ${profile.name}` : null,
    profile.birthDate ? `Born: ${profile.birthDate}` : null,
    cur != null ? `Current age: ${cur}` : null,
    profile.gender ? `Gender: ${profile.gender}` : null,
    profile.job || profile.occupation ? `Occupation: ${profile.job || profile.occupation}` : null
  ]
    .filter(Boolean)
    .join(' · ')
  const materials =
    `### The person\n${who}\n\n` +
    (pastNotes.length
      ? `### What they wrote about their life so far (Korean, verbatim)\n${pastNotes.join('\n')}\n\n`
      : '') +
    (futureNotes.length
      ? `### What they themselves said about their future (Korean, verbatim)\n${futureNotes.join('\n')}\n\n`
      : '') +
    (ctx.lines.length
      ? `### What else they wrote about themselves in this session (Korean, verbatim)\n` +
        `Their motto and bucket list say where they hoped to go; the epitaph and farewell letters say` +
        ` who and what they hold dearest — the people named there should still appear, older, in these` +
        ` future scenes:\n${ctx.lines.join('\n')}\n\n`
      : '') +
    `### The direction of this future\n` +
    `This is the future in which their hopes do NOT arrive. Somewhere along the way something goes` +
    ` wrong — quietly, plausibly — and the plans, wishes and bucket-list items they wrote above are` +
    ` postponed, derailed, or silently shelved. Show this ONLY as visible facts and events (a saved-for` +
    ` trip replaced by a hospital corridor, an instrument still in its case, a shop that never opened);` +
    ` never narrate disappointment, never state that they failed. The life must remain ordinary and` +
    ` believable — not tragedy or spectacle, just a life that bent away from what they wanted.\n\n` +
    `### How to weigh your prediction\n` +
    `Blend these four sources in roughly these proportions. Do not let any single one dominate:\n` +
    `- 50% — DEMOGRAPHIC TRAJECTORY: what actually tends to happen to people of this birth cohort,` +
    ` gender, occupation and social background as they age, in their society. Ordinary statistical life:` +
    ` typical work arcs, family patterns, housing, health, retirement, how social circles thin or shift.\n` +
    `- 30% — THEIR OWN STATED FUTURE, UNFULFILLED: the changes, plans, bucket list and motto they` +
    ` described above — present in the life, but not realized. Let them surface as traces: a plan` +
    ` deferred year after year, an item prepared for but never used, a hoped-for move that quietly` +
    ` stops being mentioned. Their wishes shape what is visibly missing.\n` +
    `- 10% — SAJU (사주): read the flow of their 대운 (ten-year luck cycles) and 소운 from their birth date` +
    ` above, and let that colour the timing and texture of the periods — when things close down, when they` +
    ` turn inward. Keep this as an undercurrent that shapes tone, never as a stated prophecy.\n` +
    `- 10% — THE UNFORESEEN: life does not follow plans. Choose exactly ONE of these ages to carry the` +
    ` single turn that knocked things off course — a health event, a family obligation, work that` +
    ` consumed the years, money that went elsewhere. Every other age shows NO new misfortune — only` +
    ` ordinary life and the quiet traces of plans that never arrived, downstream of that one turn.` +
    ` It should still look like a life, not a spectacle.\n\n`
  return { materials, cur }
}

/**
 * 1단계 — 운명 미래의 **생애 연대기** 프롬프트(2026-08-05). 장면을 그리기 전에 먼저 삶 자체를
 * 쓴다: 나이별로 무슨 일이 있었는지(일·집·관계·건강·장소의 구체적 사건). 2단계(장면 분해)가
 * 이 연대기를 그대로 따르므로, 나이들 사이의 인과·연속성이 한 서사에서 나온다.
 */
export function buildFutureNarrativePrompt(profile, sessionPoints, futureAges) {
  const m = futureExtrapolationMaterials(profile, sessionPoints, futureAges)
  if (!m) return null
  return (
    `A person has recorded their own life. Before any imagery, write the LIFE ITSELF: extrapolate how` +
    ` this particular life continues from age ${m.cur} to 90.\n\n` +
    m.materials +
    `### Your task\n` +
    `Write a compact chronicle of this person's future as concrete EVENTS — what changes in work, home,` +
    ` relationships, health and place; what begins, what ends, what returns. One short paragraph per age` +
    ` (${futureAges.join(', ')}), each flowing from the previous one — a single continuous life.\n` +
    `- Factual in tone ("moves to ...", "closes the shop", "a first grandchild arrives"). Do NOT narrate` +
    ` emotion or meaning, do not judge success or failure.\n` +
    `- Do not describe death or a deathbed.\n\n` +
    `Return plain text only, one line per age, exactly this shape:\n` +
    `AGE <age>: <two or three sentences>`
  )
}

/**
 * 2단계 — 연대기를 나이별 **장면**으로 분해하는 프롬프트. narrative(1단계 결과)가 있으면 장면은
 * 그 연대기의 사건을 그대로 그린다(이미지 생성 프롬프트의 재료). 없으면(1단계 실패) 종전처럼
 * 재료에서 바로 장면을 뽑는 단일 단계로 동작한다 — 하위 호환.
 */
export function buildFutureExtrapolationPrompt(profile, sessionPoints, futureAges, narrative = '') {
  const m = futureExtrapolationMaterials(profile, sessionPoints, futureAges)
  if (!m) return null
  const sceneArray = Array.from({ length: SCENES_PER_AGE }, (_, i) => `"scene ${i + 1}"`).join(', ')
  const keys = futureAges.map(String)
  return (
    `A person has recorded their own life. Extrapolate how this particular life continues, and describe` +
    ` what could be seen at ages ${futureAges.join(', ')}.\n\n` +
    m.materials +
    (narrative
      ? `### The life chronicle to depict (already decided — follow it faithfully)\n${narrative}\n\n`
      : '') +
    `### Rules for the scenes\n` +
    (narrative
      ? `- Every scene must depict a concrete moment from the chronicle above for that age — do not` +
        ` invent events that contradict it, only stage what it says as visible moments.\n`
      : '') +
    `- Continue THIS life, not a generic one: carry forward the places, relationships, work and habits` +
    ` that actually appear above, and let them age — the same people grow older, a craft deepens,` +
    ` a place is revisited or left behind, new ordinary things enter.\n` +
    `- Describe only what a camera could see: places, light, objects, actions, who is present.` +
    ` Do NOT interpret or judge what this life meant, and do not narrate success, failure or regret.\n` +
    `- Do not depict death or a deathbed — the final scene of this life is fixed elsewhere.\n` +
    `- Be specific and physical. No captions, no lettering, no text of any kind in the scene.\n` +
    `- ${SCENE_ROLE_RULES.replaceAll('\n', '\n- ')}\n` +
    `- Each scene: one English present-participle phrase, the same style as: ` +
    `"sitting on a low porch step in late afternoon light, a chipped mug beside a worn cushion".\n\n` +
    `Return ONLY JSON, exactly these keys, ${SCENES_PER_AGE} scenes each:\n` +
    `{${keys.map((k) => `"${k}": [${sceneArray}]`).join(', ')}}`
  )
}

export async function synthesizeAgeScenes(
  gclient,
  profile,
  sessionPoints,
  { attempts = 3, trace = null } = {}
) {
  const { prompt, ages } = buildSynthesisPrompt(profile, sessionPoints)
  const past = prompt ? await runSynthesis(gclient, prompt, ages, attempts) : {}

  // 2차 합성 — 사용자가 안 채운 미래 나이를 과거 기록에서 이어 만든다(위 주석의 예외).
  // 2단계(2026-08-05): ① 생애 연대기(사건 서사)를 먼저 쓰고 → ② 그걸 나이별 장면으로 분해한다.
  // ①이 실패하면 종전처럼 재료에서 바로 장면을 뽑는다(단일 단계 폴백).
  // best-effort: 실패하면 그 나이들만 폴백 장면으로 남고 생성은 계속된다(1차 결과는 지키는 게 우선).
  const futureAges = extrapolationAges(profile, sessionPoints)
  let narrative = ''
  const narrativePrompt = buildFutureNarrativePrompt(profile, sessionPoints, futureAges)
  if (narrativePrompt) {
    try {
      narrative = String(await gclient.generateText({ prompt: narrativePrompt })).trim()
    } catch (err) {
      console.warn(`[life-graph-plan] 미래 연대기 합성 실패(장면 직행 폴백): ${err.message}`)
    }
  }
  if (trace) trace.futureNarrative = narrative || null
  const futurePrompt = buildFutureExtrapolationPrompt(profile, sessionPoints, futureAges, narrative)
  if (trace) trace.futureScenePrompt = futurePrompt || null
  if (!futurePrompt) return past
  try {
    const future = await runSynthesis(gclient, futurePrompt, futureAges, attempts)
    return { ...past, ...future }
  } catch (err) {
    console.warn(`[life-graph-plan] 미래 외삽 합성 실패(폴백 장면으로 진행): ${err.message}`)
    return past
  }
}

// ── 3차 플로우: 분기된 미래(branched) 외삽 ──────────────────────────────────────
//
// 2차 외삽(buildFutureExtrapolationPrompt)이 "희망이 이뤄지지 않은 미래"라면, 3차는
// 유령과의 대화 기록(ghostTranscripts)을 재료로 "원하는 대로 잘 풀린 미래"를 만든다
// (사용자 확정, 2026-08-05 — 종전의 '좋고 나쁨 없는 분기' 컨셉을 대체). 대화에서 드러난
// 소망·후회·버킷리스트가 실제로 이뤄지는 궤적이되, 성공을 서술로 판정하지 않고 이뤄졌다는
// 사실만 장면으로 보여준다. 관람객은 같은 형식의 두 생애(2차 vs 3차)를 나란히 보게 된다.
//
// §1과의 관계: 2차와 같은 의식적 예외다. 단, 3차는 근거가 한 겹 더 있다 — 관람객이 유령에게
// 실제로 말한 문장들(후회·망설임·새로 발견한 욕망)에서만 변화의 단서를 읽고, 대화에 없는
// 심경 변화를 지어내지 않는다. manifest에는 sceneSource='branched'로 출처를 남긴다.

/** 분기 미래의 대상 나이 — 현재보다 뒤의 격자 나이 전부(사용자 점 유무와 무관: 전부 다시 산다). */
export function branchedAges(profile) {
  const cur = currentAgeOf(profile)
  if (cur == null) return []
  return AGES.filter((age) => age > cur)
}

/** 유령 대화 기록(turns)을 프롬프트용 대본으로 편다. 장(chapter) 표기로 시기 맥락을 남긴다. */
function formatTranscriptTurns(turns) {
  const label = { 유령: 'GHOST', 사람: 'VISITOR', 상황: '(system)', 장면: '(scene shown)' }
  return turns
    .filter((t) => t?.text && t.who !== '상황') // 시스템 알림은 대화가 아니다
    .map(
      (t) =>
        `- [${t.chapter === 'future' ? 'ch.2 future' : 'ch.1 past'}] ${label[t.who] || t.who}: "${t.text}"`
    )
    .join('\n')
}

/**
 * 3차 합성(분기 외삽) 프롬프트 — 대화 기록에서 바뀐 마음가짐을 읽어, 오늘부터 90세까지의
 * 분기된 삶을 나이별 장면으로 만든다. 근거가 없으면(대화 기록이 비면) null.
 * @param {object} profile         { name, birthDate, age?, gender?, occupation? }
 * @param {object} sessionPoints   최신 세션 점들 — 과거 사실(장소·관계·일)의 연속성 재료
 * @param {Array}  transcriptTurns ghostTranscripts 문서의 turns
 * @param {number[]} futureAges    branchedAges() 결과
 */
// 분기(3차) 외삽의 공용 재료 블록 — 연대기(1단계)와 장면 분해(2단계) 프롬프트가 공유한다.
function branchedExtrapolationMaterials(profile, sessionPoints, transcriptTurns, futureAges) {
  if (!futureAges?.length || !transcriptTurns?.length) return null
  const transcript = formatTranscriptTurns(transcriptTurns)
  if (!transcript) return null
  const pastNotes = []
  const seen = new Set()
  for (const age of AGES) {
    const r = resolveAgePoint(age, sessionPoints, profile)
    if (!r || seen.has(r.key) || r.isFuture) continue
    seen.add(r.key)
    const t = r.point?.text?.trim()
    if (t) pastNotes.push(`- age ${r.point?.age ?? ageOfStageId(r.key) ?? age}: "${t}"`)
  }
  // 3차(긍정미래)는 최신 myLife를 딛는다(pickMyLifeEntry 기본값 'latest') — 체험 뒤 crafter가
  // 새로 추가한 항목이 있으면 그것이 "지금 원하는 것"의 가장 또렷한 진술이다.
  const ctx = collectSessionContext(profile, sessionPoints)
  const myLifeRaw = sessionPoints.myLife ?? profile.myLife
  const myLifeRenewed = Array.isArray(myLifeRaw) && myLifeRaw.filter(Boolean).length > 1
  const cur = currentAgeOf(profile)
  const who = [
    profile.name ? `Name: ${profile.name}` : null,
    profile.birthDate ? `Born: ${profile.birthDate}` : null,
    cur != null ? `Current age: ${cur}` : null,
    profile.gender ? `Gender: ${profile.gender}` : null,
    profile.job || profile.occupation ? `Occupation: ${profile.job || profile.occupation}` : null
  ]
    .filter(Boolean)
    .join(' · ')
  const materials =
    `### The person\n${who}\n\n` +
    (pastNotes.length
      ? `### What they wrote about their life so far (Korean, verbatim)\n${pastNotes.join('\n')}\n\n`
      : '') +
    (ctx.lines.length
      ? `### What else they wrote about themselves (Korean, verbatim)\n${ctx.lines.join('\n')}\n\n`
      : '') +
    `### The conversation with the ghost (Korean, verbatim — your PRIMARY source)\n${transcript}\n\n` +
    `### Rules for the divergence\n` +
    `- Ground every change in something the visitor actually said in the conversation above — a moment` +
    ` they wanted to return to, a regret, a wish, a hesitation before an answer. Do NOT invent a change` +
    ` of heart that has no trace in their words.\n` +
    `- This is the life in which things WORK OUT: the wishes, hopes and bucket-list items that surfaced` +
    ` in their words (and in what they wrote) actually come to pass, each at a plausible age. Regrets` +
    ` voiced to the ghost become the choices they finally made; shelved dreams get picked back up and` +
    ` carried through. Show fulfillment ONLY as visible facts and events — the trip taken, the door of` +
    ` the shop finally open, the person still at the table — never narrate happiness or declare success.\n` +
    (myLifeRenewed
      ? `- Their life motto and bucket list quoted above are the version they REWROTE right after this` +
        ` experience — treat them, together with the conversation, as the clearest statement of what` +
        ` they now want. The diverged life must visibly realize those bucket-list items, each at a` +
        ` plausible age.\n`
      : '') +
    `- Keep demographic realism: ordinary work, money, family, health and aging in their society. The` +
    ` life goes well, but it stays a believable everyday life, not a fantasy — quiet arrival, not` +
    ` spectacle.\n` +
    `- Keep continuity of facts: the same places, people and skills from their past may reappear —` +
    ` but carried where they hoped (a shelved dream picked back up, a relationship tended and kept,` +
    ` a place finally left or returned to).\n` +
    `- Do not depict death or a deathbed — the final scene of this life is fixed elsewhere.\n\n`
  return { materials, cur }
}

/** 1단계 — 분기된 삶의 **생애 연대기** 프롬프트: 대화에서 읽은 바뀐 마음가짐으로 다른 선택을
 * 하며 살았을 때, 나이별로 무슨 일이 있었는지를 사건으로 쓴다. 2단계가 이 연대기를 그대로 그린다. */
export function buildBranchedNarrativePrompt(profile, sessionPoints, transcriptTurns, futureAges) {
  const m = branchedExtrapolationMaterials(profile, sessionPoints, transcriptTurns, futureAges)
  if (!m) return null
  return (
    `A person has just been through an immersive experience: guided by a ghost-like voice, they` +
    ` revisited moments of their past, then watched an AI-extrapolated version of the future that` +
    ` would follow if their life simply kept its current course. Below is the full conversation.\n\n` +
    `Your task: read what THEY actually said — regrets voiced, hesitations, things they lingered on,` +
    ` wishes that surfaced — and infer what they truly want. Before any imagery, write the FULFILLED` +
    ` LIFE ITSELF: the one in which, starting today at age ${m.cur}, they act on those wishes and` +
    ` things genuinely work out — the hoped-for turns actually arrive.\n\n` +
    m.materials +
    `### Your task\n` +
    `Write a compact chronicle of the diverged future as concrete EVENTS — what changes in work, home,` +
    ` relationships, health and place; what begins, what ends, what returns. One short paragraph per age` +
    ` (${futureAges.join(', ')}), each flowing from the previous one — a single continuous life.\n` +
    `- Factual in tone ("quits and moves to ...", "reopens the shelved dream as ..."). Do NOT narrate` +
    ` emotion or meaning, do not judge success or failure.\n` +
    `- Do not describe death or a deathbed.\n\n` +
    `Return plain text only, one line per age, exactly this shape:\n` +
    `AGE <age>: <two or three sentences>`
  )
}

/** 2단계 — 분기 연대기를 나이별 장면(이미지 생성 프롬프트 재료)으로 분해. narrative가 없으면
 * 종전처럼 단일 단계로 동작한다(하위 호환). */
export function buildBranchedExtrapolationPrompt(
  profile,
  sessionPoints,
  transcriptTurns,
  futureAges,
  narrative = ''
) {
  const m = branchedExtrapolationMaterials(profile, sessionPoints, transcriptTurns, futureAges)
  if (!m) return null
  // 분기 미래는 나이당 한 장면 — 3차 플로우에는 "같은 시기의 다른 모습" 선택지가 없다.
  const sceneArray = Array.from(
    { length: BRANCH_SCENES_PER_AGE },
    (_, i) => `"scene ${i + 1}"`
  ).join(', ')
  const keys = futureAges.map(String)
  return (
    `A person has just been through an immersive experience: guided by a ghost-like voice, they` +
    ` revisited moments of their past, then watched an AI-extrapolated version of the future that` +
    ` would follow if their life simply kept its current course. Below is the full conversation.\n\n` +
    `Your task: read what THEY actually said — regrets voiced, hesitations, things they lingered on,` +
    ` wishes that surfaced — and infer what they truly want. Then extrapolate the FULFILLED life:` +
    ` the one in which, starting today at age ${m.cur}, they act on those wishes and things genuinely` +
    ` work out — the hoped-for turns actually arrive. Describe what could be seen at ages` +
    ` ${futureAges.join(', ')}.\n\n` +
    m.materials +
    (narrative
      ? `### The diverged life chronicle to depict (already decided — follow it faithfully)\n${narrative}\n\n`
      : '') +
    `### Rules for the scenes\n` +
    (narrative
      ? `- Every scene must depict a concrete moment from the chronicle above for that age — do not` +
        ` invent events that contradict it, only stage what it says as visible moments.\n`
      : '') +
    `- Describe only what a camera could see: places, light, objects, actions, who is present.` +
    ` Never narrate emotion, meaning, success or failure.\n` +
    `- ONE scene per age: the single moment that best carries what this period of the diverged life` +
    ` looks like — a recurring, representative moment of that period's daily texture (not a` +
    ` once-in-a-lifetime spectacle). Across ages, vary location, activity, and who is present.\n` +
    `- This person is Korean and, by default, every scene takes place in South Korea — ground scenes in` +
    ` Korean specifics unless the conversation or notes above explicitly place a period in another` +
    ` country, in which case name that place in the sentence.\n` +
    `- Be specific and physical. No captions, no lettering, no text of any kind in the scene.\n` +
    `- Each scene: one English present-participle phrase, the same style as: ` +
    `"repotting seedlings on a sunlit balcony rail, soil scattered on yesterday's newspaper".\n\n` +
    `Return ONLY JSON, exactly these keys, ${BRANCH_SCENES_PER_AGE} scene(s) each:\n` +
    `{${keys.map((k) => `"${k}": [${sceneArray}]`).join(', ')}}`
  )
}

/**
 * 3차 합성 실행 — 대화 기록 기반 분기 미래 장면을 나이별 BRANCH_SCENES_PER_AGE개씩 만든다.
 * 근거가 없으면(빈 대화·현재 나이 불명) 빈 객체를 반환한다 — 호출자가 재료 부족을 판단한다.
 */
export async function synthesizeBranchedScenes(
  gclient,
  profile,
  sessionPoints,
  transcriptTurns,
  { attempts = 3, trace = null } = {}
) {
  const ages = branchedAges(profile)
  // 2단계(2026-08-05): ① 분기된 삶의 연대기를 먼저 쓰고 → ② 나이별 장면으로 분해한다.
  let narrative = ''
  const narrativePrompt = buildBranchedNarrativePrompt(
    profile,
    sessionPoints,
    transcriptTurns,
    ages
  )
  if (narrativePrompt) {
    try {
      narrative = String(await gclient.generateText({ prompt: narrativePrompt })).trim()
    } catch (err) {
      console.warn(`[life-graph-plan] 분기 연대기 합성 실패(장면 직행 폴백): ${err.message}`)
    }
  }
  if (trace) trace.branchedNarrative = narrative || null
  const prompt = buildBranchedExtrapolationPrompt(
    profile,
    sessionPoints,
    transcriptTurns,
    ages,
    narrative
  )
  if (trace) trace.branchedScenePrompt = prompt || null
  if (!prompt) return {}
  return runSynthesis(gclient, prompt, ages, attempts, BRANCH_SCENES_PER_AGE)
}

/**
 * 분기 미래 플랜 — 현재 다음 격자 나이부터 90세까지 × SCENES_PER_AGE장. manifest.images 항목과
 * 같은 모양이되 id가 'alt-<나이>-<n>'이고 branch:true 플래그가 붙는다 — 기존 32장과 한 배열에
 * 살면서도(영상화·업로드·재생성 기계 재사용) 1·2차 재생목록·카탈로그에서는 이 플래그로 걸러진다.
 * 마지막 나이의 마지막 한 장은 2차와 같은 FINAL_SCENE(임종)으로 고정 — 분기된 삶도 같은 자리에서 닫힌다.
 * @param {object} profile  { name, birthDate, age? }
 * @param {Record<number,string[]>} branchedScenes  synthesizeBranchedScenes() 결과
 */
export function buildBranchedPlan(profile, branchedScenes = {}) {
  const birthYear = parseInt(String(profile.birthDate).slice(0, 4), 10)
  if (!Number.isFinite(birthYear))
    throw new Error(`birthDate 형식이 잘못됨: ${profile.birthDate} (YYYY-MM-DD)`)
  const ages = branchedAges(profile)
  if (!ages.length) throw new Error('분기 미래 나이가 없다 — 현재 나이를 구할 수 없거나 90세 이상')
  const plan = []
  ages.forEach((age, stageIndex) => {
    const synthesized = branchedScenes[age]
    const scenes =
      synthesized ||
      fallbackScenesForAge(
        age,
        `${profile.name}|${profile.birthDate}|branched|${age}`,
        BRANCH_SCENES_PER_AGE
      )
    if (!scenes || scenes.length !== BRANCH_SCENES_PER_AGE)
      throw new Error(`분기 나이 ${age}의 장면 데이터가 없음 (합성 결과 누락 또는 폴백 실패)`)
    const isFinalAge = age === ages[ages.length - 1]
    scenes.forEach((scene, i) => {
      const sceneIndex = i + 1
      const isFinal = isFinalAge && sceneIndex === BRANCH_SCENES_PER_AGE
      plan.push({
        stageIndex,
        sceneIndex,
        id: `alt-${age}-${sceneIndex}`,
        stageId: `age-${age}`,
        age,
        year: birthYear + age,
        isPast: false,
        branch: true, // 3차(분기 미래) 표식 — 1·2차 재생목록·카탈로그가 이걸로 거른다
        scene: isFinal ? FINAL_SCENE : scene,
        sceneSource: isFinal ? 'final' : synthesized ? 'branched' : 'fallback',
        isFinal,
        emotion: null
      })
    })
  })
  return plan
}

/**
 * 세션 하나의 최종 장면 플랜을 만든다. **항상 16개 나이(AGES) 전체 × 2장 = 32장**이다.
 * 맨 마지막 한 장은 FINAL_SCENE으로 고정된다(아래 상수 주석 참조).
 *
 * 나이 격자를 하나도 비우지 않는 이유(2026-08-03): 전시는 1차(과거 회귀)와 2차(미래)가 한 자리에서
 * 이어져 진행된다. 2차에서 유령이 미래의 순간을 불러올 때 그 이미지·영상이 이미 있어야 하므로,
 * 0~90세 전부를 **생성 시점에 한 번에** 만들어 둔다. crafter의 나이 키 스키마는 참가자가 실제로
 * 찍은 점만 담고 있어(예: 41세 참가자면 age-48까지) 그 뒤 나이엔 점이 없는데, 그 나이들은
 * 2차 합성(buildFutureExtrapolationPrompt)이 만든 미래 장면으로 채운다. 그것마저 실패하면
 * 폴백 풀로 채워서라도 격자를 비우지 않는다 — 전시 도중엔 생성할 수 없기 때문이다.
 * life-library.js의 manifest.images 항목과 같은 모양이라 admin UI가 그대로 읽는다.
 * @param {object} profile        { name, birthDate, age }
 * @param {object} sessionPoints  Firestore 문서의 first/second/third 필드 —
 *   점 배열 스키마 `{ "age-<구간>": [ {age,x,event,companion,place,imageURL}, … ] }`,
 *   나이 키 스키마 `{ "age-<나이>": { x, text, imageURL? } }`, 옛 단계 키 스키마
 *   `{ [stageId]: {…}, [future-stageId]: {…} }` 전부 (resolveAgePoint가 셋 다 흡수).
 * @param {Record<number, string[]>} [ageScenes]  synthesizeAgeScenes() 결과 — 본인 글에서 나온 나이와
 *   미래 외삽으로 만든 나이의 장면 SCENES_PER_AGE개씩. 둘 다 없는 나이는 fallbackScenesForAge().
 * @returns {Array<{ stageIndex, sceneIndex, id, stageId, age, year, isPast, scene, sceneSource, emotion }>}
 *   sceneSource: 'user'(본인 글) | 'extrapolated'(AI가 이은 미래) | 'fallback'(후보 풀) | 'final'(고정 임종 장면)
 *   stageId는 사진 레퍼런스를 찾을 때 쓴다(collectStagePhotoURLs 참조) — 같은 LIFE_STAGE에
 *   배정된 나이가 여럿이면(예: 9세·15세) 모두 같은 stageId(그리고 같은 레퍼런스 사진)를 가진다.
 */
export function buildLifeGraphPlan(profile, sessionPoints, ageScenes = {}) {
  const birthYear = parseInt(String(profile.birthDate).slice(0, 4), 10)
  if (!Number.isFinite(birthYear))
    throw new Error(`birthDate 형식이 잘못됨: ${profile.birthDate} (YYYY-MM-DD)`)

  const currentAge = currentAgeOf(profile)
  const plan = []
  AGES.forEach((age, stageIndex) => {
    // 점이 없는 나이(참가자가 아직 안 찍은 미래 격자)도 건너뛰지 않는다 — 폴백으로 채워 30장을 완성한다.
    const resolved = resolveAgePoint(age, sessionPoints, profile)
    const point = resolved?.point ?? null
    const stageId = resolved?.key ?? `age-${age}`
    const isFuture = resolved ? resolved.isFuture : currentAge != null && age > currentAge
    const hasText = Boolean(point?.text?.trim())
    // 합성 결과가 있으면 그걸 쓴다 — 본인 글에서 나온 것(1차)이든, 본인이 안 채운 미래를
    // 과거에서 이어 만든 것(2차 외삽)이든. 둘 다 없을 때만 폴백 풀로 채운다.
    const synthesized = ageScenes[age]
    const scenes =
      synthesized ||
      fallbackScenesForAge(age, `${profile.name}|${profile.birthDate}|${age}`, SCENES_PER_AGE)
    // 장면의 출처 — manifest에 남겨 나중에 "이 장면이 어디서 왔나"를 되짚을 수 있게 한다.
    const sceneSource = synthesized ? (hasText ? 'user' : 'extrapolated') : 'fallback'
    if (!scenes || scenes.length !== SCENES_PER_AGE)
      throw new Error(
        `나이 ${age}의 장면 데이터가 없음 (합성 결과 누락 또는 폴백 실패): stageId=${stageId}`
      )

    // 마지막 나이의 마지막 한 장만 고정 장면으로 교체한다(합성/폴백 결과를 덮어씀).
    const isFinalAge = age === AGES[AGES.length - 1]

    scenes.forEach((scene, i) => {
      const sceneIndex = i + 1
      const isFinal = isFinalAge && sceneIndex === SCENES_PER_AGE
      plan.push({
        stageIndex,
        sceneIndex,
        id: `${age}-${sceneIndex}`,
        stageId,
        age,
        year: birthYear + age,
        isPast: !isFuture,
        scene: isFinal ? FINAL_SCENE : scene,
        sceneSource: isFinal ? 'final' : sceneSource,
        isFinal, // 렌더/편집 쪽에서 "마지막 한 장"을 알아볼 수 있게 표시만 남긴다
        emotion: point?.x ?? null // 1차는 프롬프트에 미반영 — 기록만(§1, 나중을 위한 자리)
      })
    })
  })
  return plan
}

/**
 * 과거~현재 점들의 사진 URL을 { 점key: url } 로 모은다(있는 것만). 미래 점은 사진을 받지 않으므로
 * 제외한다. plan 항목의 stageId가 이 맵의 키와 같아서, 그 나이 생성에 "그 순간의 실제 사진"을
 * 레퍼런스로 실을 수 있다(collectSessionPhotoURLs는 성별감지용 대표 사진 1장만 고르는 것과 달리,
 * 이건 점마다 각자 다른 사진을 다 모은다).
 *
 * 새 스키마에선 나이마다 사진이 따로 붙고 **imageURL이 null인 점이 섞여 있다** — null은 건너뛴다.
 * @param {object} sessionPoints
 * @param {object} [profile]  현재 나이 판정용(미래 점 제외)
 * @returns {Record<string, string>}
 */
export function collectStagePhotoURLs(sessionPoints, profile = {}) {
  const map = {}
  for (const age of AGES) {
    const resolved = resolveAgePoint(age, sessionPoints, profile)
    if (!resolved || resolved.isFuture) continue
    const url = resolved.point?.imageURL
    if (url) map[resolved.key] = url // 같은 key를 공유하는 나이가 여럿이면(옛 스키마) 자연히 덮어써진다
  }
  return map
}

/**
 * 얼굴 앵커로 쓸 레퍼런스 사진 URL 하나를 고른다 — life-library.js의 기존 레퍼런스 사진 자리
 * (성별 자동감지 · kontext 편집 입력)에 그대로 꽂아 넣기 위함. 미래 점은 사진을 안 받으므로
 * 후보에서 빠진다. **현재에 가장 가까운 나이**의 사진을 우선한다 — 최근 모습일수록 감지가
 * 안정적이고, 영정·aged 앵커도 거기서 출발하는 게 맞다.
 * @param {object} sessionPoints
 * @param {object} [profile]  현재 나이 판정용
 * @returns {string[]} 0장 또는 1장 — life-library.js의 downloadPhotos(profile.photoURLs)에 그대로 넣는다.
 */
export function collectSessionPhotoURLs(sessionPoints, profile = {}) {
  for (const age of [...AGES].reverse()) {
    const resolved = resolveAgePoint(age, sessionPoints, profile)
    if (!resolved || resolved.isFuture) continue
    const url = resolved.point?.imageURL
    if (url) return [url]
  }
  return []
}
