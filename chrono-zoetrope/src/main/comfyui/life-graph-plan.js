// cdb-crafter(인생그래프 앱) 세션 → 장면 플랜.
//
// life-library.js/prompt-builder.js의 옛 파이프라인은 occupation + 고정 10단계 나이 템플릿을
// 전제로 한다. cdb-crafter는 완전히 다른 재료를 준다 — 사용자가 실제로 그린 감정곡선의
// 7개 생애주기 단계(보호기~정리기)마다 { x(감정 위치), text(직접 쓴 글), imageURL(사진, 과거~현재만) }.
//
// 2단계 파이프라인:
//   1) 합성 — 세션의 7단계 text 전체를 한 번에 LLM에 넣어, 3~90세를 15등분한 나이 격자
//      (AGE_TO_STAGE, 15개 나이)마다 장면 후보 SCENES_PER_AGE(2)개로 "그 사람 고유"의 장면 데이터를
//      만든다(buildSynthesisPrompt → synthesizeAgeScenes). 텍스트가 없는 단계는 합성 대상에서
//      제외하고 prompt-builder.js의 fallbackScenesForAge()가 옛 STAGES 후보 풀로 채운다.
//   2) 플랜 — buildLifeGraphPlan()이 합성 결과(또는 폴백)를 15나이 × 2장 = 30장짜리
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
import { fallbackScenesForAge } from './prompt-builder.js'

export const LIFE_STAGES = [
  { id: 'protect', label: '보호기', sublabel: '0~7세' },
  { id: 'growth', label: '성장기', sublabel: '8~19세' },
  { id: 'independence', label: '독립기', sublabel: '20대 초중반' },
  { id: 'settling', label: '정착기', sublabel: '20대 후반~30대' },
  { id: 'responsibility', label: '책임기', sublabel: '30대~50대' },
  { id: 'transition', label: '전환기', sublabel: '50대~60대' },
  { id: 'settlement', label: '정리기', sublabel: '60대 이후' }
]

// 합성 프롬프트(영어)에서 쓰는 단계 라벨 — LIFE_STAGES의 label/sublabel은 cdb-crafter UI와 짝이 맞아야
// 해서 한국어로 둔다. 프롬프트에는 이쪽 영어 라벨만 쓴다.
const STAGE_LABELS_EN = {
  protect: 'early childhood (ages 0-7)',
  growth: 'school years (ages 8-19)',
  independence: 'becoming independent (early-to-mid twenties)',
  settling: 'settling down (late twenties through thirties)',
  responsibility: 'years of responsibility (thirties to fifties)',
  transition: 'a time of transition (fifties to sixties)',
  settlement: 'later life (sixties onward)'
}

// 한 나이당 만드는 장면(=이미지) 수. 나이 격자를 촘촘하게 가져가는 대신 나이마다 2장만 만든다
// — 같은 나이에서 3장 이상은 서로 비슷해져서 얻는 게 없다.
export const SCENES_PER_AGE = 2

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

// 세션의 sessionPoints에서 이 stage 슬롯이 과거/현재로 채워졌는지 미래로 채워졌는지 판정하고
// 그 점을 반환한다. 점이 아예 없으면(방어적 상황 — 정상 흐름이면 항상 있어야 함) null.
function resolveStagePoint(stage, sessionPoints) {
  const futureId = `future-${stage.id}`
  const isFuture = sessionPoints[futureId] !== undefined
  const stageId = isFuture ? futureId : stage.id
  const point = sessionPoints[stageId]
  if (!point) return null
  return { stageId, isFuture, point }
}

/**
 * 1차 합성 프롬프트 — 세션의 7단계 중 사용자가 실제로 글을 남긴 단계만 모아, 각 단계에 배정된
 * 나이(AGE_TO_STAGE)마다 장면 후보 SCENES_PER_AGE개를 요청하는 LLM 프롬프트를 조립한다. 글이 하나도 없으면
 * prompt: null (호출자는 합성을 건너뛰고 전부 폴백으로 채운다).
 * @param {object} profile        { name, birthDate }
 * @param {object} sessionPoints  Firestore 문서의 first/second/third 필드
 * @returns {{ prompt: string|null, ages: number[] }}  ages는 프롬프트가 요청한 나이 목록(중복 없음)
 */
export function buildSynthesisPrompt(profile, sessionPoints) {
  const entries = []
  for (const stage of LIFE_STAGES) {
    const resolved = resolveStagePoint(stage, sessionPoints)
    if (!resolved) continue
    const text = resolved.point.text?.trim()
    if (!text) continue // 빈 단계는 합성 대상에서 제외 — buildLifeGraphPlan이 폴백으로 채운다
    const ages = AGES.filter((age) => AGE_TO_STAGE[age] === stage.id)
    entries.push({ stage, ages, isFuture: resolved.isFuture, text })
  }
  if (entries.length === 0) return { prompt: null, ages: [] }

  const lines = entries.map(({ stage, ages, isFuture, text }) => {
    const en = STAGE_LABELS_EN[stage.id]
    const timeLabel = isFuture ? `${en} (an imagined future)` : en
    const ageLabel = ages.length > 1 ? `ages ${ages.join(', ')}` : `age ${ages[0]}`
    return `- ${timeLabel} [${ageLabel}]: "${text}"`
  })

  // 필요한 키를 문장으로 설명만 하면(예: "ages 9, 15") 모델이 "9·15"처럼 묶은 키를 쓰거나
  // 하나를 빠뜨린다. 요구 키를 그대로 나열해 오해의 여지를 없앤다.
  const requiredKeys = [...new Set(entries.flatMap((e) => e.ages))].sort((a, b) => a - b)

  const sampleAges = requiredKeys.slice(0, 2)
  const sampleLabel = sampleAges.length > 1 ? `age ${sampleAges[0]} and age ${sampleAges[1]}` : `age ${sampleAges[0]}`
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
    ` distinct moment appropriate to that age, and keep the ${SCENES_PER_AGE} scenes of a single age` +
    ` from overlapping with each other. Do not describe facial features, and do not include names,` +
    ` text, letters or captions.\n\n` +
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

/**
 * buildSynthesisPrompt가 만든 프롬프트에 대한 LLM 응답 텍스트를 파싱·검증한다.
 * @param {string} raw            gclient.generateText()가 반환한 원문
 * @param {number[]} expectedAges 응답에 반드시 있어야 하는 나이 키 목록
 * @returns {Record<number, string[]>}  { [age]: [장면1, 장면2] } — 길이는 SCENES_PER_AGE
 */
export function parseSynthesizedScenes(raw, expectedAges) {
  let text = String(raw ?? '').trim()
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()

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
      arr.length !== SCENES_PER_AGE ||
      arr.some((s) => typeof s !== 'string' || !s.trim())
    ) {
      // 키가 통째로 없을 때 JSON.stringify(undefined)는 "undefined"라 원인 파악이 안 된다 —
      // 모델이 실제로 무슨 키를 줬는지 함께 보여준다.
      throw new Error(
        `장면 합성 응답에 나이 ${age}의 장면 ${SCENES_PER_AGE}개가 없음 (받은 값: ${JSON.stringify(arr) ?? 'undefined'}` +
          `, 응답 키: ${JSON.stringify(Object.keys(data))}, 요구 키: ${JSON.stringify(expectedAges.map(String))})`
      )
    }
    out[age] = arr.map((s) => s.trim())
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
export async function synthesizeAgeScenes(gclient, profile, sessionPoints, { attempts = 3 } = {}) {
  const { prompt, ages } = buildSynthesisPrompt(profile, sessionPoints)
  if (!prompt) return {}

  // 글이 있는 단계는 폴백으로 대체하지 않는 게 설계 의도라(§1), 형식 이탈은 폴백이 아니라
  // 재요청으로 푼다. 실패한 이유를 다음 시도의 프롬프트에 붙여 같은 실수를 반복하지 않게 한다.
  let lastErr
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const repair = lastErr
      ? `\n\n이전 응답이 형식을 어겼다: ${lastErr.message}\n요구한 키를 하나도 빠뜨리지 말고 다시 답하라.`
      : ''
    try {
      const raw = await gclient.generateText({ prompt: prompt + repair, responseJson: true })
      return parseSynthesizedScenes(raw, ages)
    } catch (err) {
      lastErr = err
      console.warn(`[life-graph-plan] 장면 합성 ${attempt}/${attempts} 실패: ${err.message}`)
    }
  }
  throw lastErr
}

/**
 * 세션 하나(과거~현재~그 세션의 미래)의 최종 장면 플랜을 만든다. 15개 나이(AGES) × 2장 = 최대 30장.
 * 맨 마지막 한 장은 FINAL_SCENE으로 고정된다(아래 상수 주석 참조).
 * life-library.js의 manifest.images 항목과 같은 모양이라 admin UI가 그대로 읽는다.
 * @param {object} profile        { name, birthDate, age }
 * @param {object} sessionPoints  Firestore 문서의 first/second/third 필드 —
 *   { [stageId]: { x, text, imageURL? } }, stageId는 LIFE_STAGES의 id 또는 `future-${id}`.
 * @param {Record<number, string[]>} [ageScenes]  synthesizeAgeScenes() 결과 — 글이 있던 나이의
 *   장면 SCENES_PER_AGE개씩. 없는 나이는 fallbackScenesForAge()로 채운다.
 * @returns {Array<{ stageIndex, sceneIndex, id, stageId, age, year, isPast, scene, emotion }>}
 *   stageId는 사진 레퍼런스를 찾을 때 쓴다(collectStagePhotoURLs 참조) — 같은 LIFE_STAGE에
 *   배정된 나이가 여럿이면(예: 9세·15세) 모두 같은 stageId(그리고 같은 레퍼런스 사진)를 가진다.
 */
export function buildLifeGraphPlan(profile, sessionPoints, ageScenes = {}) {
  const birthYear = parseInt(String(profile.birthDate).slice(0, 4), 10)
  if (!Number.isFinite(birthYear))
    throw new Error(`birthDate 형식이 잘못됨: ${profile.birthDate} (YYYY-MM-DD)`)

  const plan = []
  AGES.forEach((age, stageIndex) => {
    const stage = LIFE_STAGES.find((s) => s.id === AGE_TO_STAGE[age])
    const resolved = resolveStagePoint(stage, sessionPoints)
    if (!resolved) return // 이 단계에 점이 없음 — 방어적으로 건너뜀(정상 흐름이면 항상 있어야 함)

    const { stageId, isFuture, point } = resolved
    const hasText = Boolean(point.text?.trim())
    const scenes = hasText
      ? ageScenes[age]
      : fallbackScenesForAge(age, `${profile.name}|${profile.birthDate}|${age}`, SCENES_PER_AGE)
    if (!scenes || scenes.length !== SCENES_PER_AGE)
      throw new Error(`나이 ${age}의 장면 데이터가 없음 (합성 결과 누락 또는 폴백 실패): stageId=${stageId}`)

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
        isFinal, // 렌더/편집 쪽에서 "마지막 한 장"을 알아볼 수 있게 표시만 남긴다
        emotion: point.x // 1차는 프롬프트에 미반영 — 기록만(§1, 나중을 위한 자리)
      })
    })
  })
  return plan
}

/**
 * 과거~현재 각 단계의 사진 URL을 { stageId: url } 로 모은다(있는 것만) — 미래 단계는 애초에
 * imageURL을 안 받으므로 자연히 빠진다. life-graph-plan의 stageId별로 그 단계 생성에 쓸
 * 레퍼런스 사진을 찾을 때 쓴다(collectSessionPhotoURLs는 성별감지용 대표 사진 1장만 고르는
 * 것과 달리, 이건 단계별로 각자 다른 사진을 다 모은다).
 * @param {object} sessionPoints
 * @returns {Record<string, string>}
 */
export function collectStagePhotoURLs(sessionPoints) {
  const map = {}
  for (const stage of LIFE_STAGES) {
    const url = sessionPoints?.[stage.id]?.imageURL
    if (url) map[stage.id] = url
  }
  return map
}

/**
 * 레퍼런스 사진 URL 하나를 고른다 — life-library.js의 기존 레퍼런스 사진 자리(성별 자동감지 ·
 * kontext 편집 입력)에 그대로 꽂아 넣기 위함. 미래 단계는 사진을 안 받으므로 후보에서 자연히
 * 빠진다. "현재"(과거 단계 중 마지막)에 가까운 사진을 우선한다 — 최근 모습일수록 감지가
 * 안정적이라고 보고, 없으면 다른 과거 단계 사진 아무거나 쓴다.
 * @param {object} sessionPoints
 * @returns {string[]} 0장 또는 1장 — life-library.js의 downloadPhotos(profile.photoURLs)에 그대로 넣는다.
 */
export function collectSessionPhotoURLs(sessionPoints) {
  const pastIdsNewestFirst = [...LIFE_STAGES].reverse().map((s) => s.id)
  for (const id of pastIdsNewestFirst) {
    const url = sessionPoints?.[id]?.imageURL
    if (url) return [url]
  }
  return []
}
