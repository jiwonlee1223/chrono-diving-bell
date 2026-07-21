// cdb-crafter(인생그래프 앱) 세션 → 장면 플랜.
//
// life-library.js/prompt-builder.js의 옛 파이프라인은 occupation + 고정 10단계 나이 템플릿을
// 전제로 한다. cdb-crafter는 완전히 다른 재료를 준다 — 사용자가 실제로 그린 감정곡선의
// 7개 생애주기 단계(보호기~정리기)마다 { x(감정 위치), text(직접 쓴 글), imageURL(사진, 과거~현재만) }.
//
// 2단계 파이프라인:
//   1) 합성 — 세션의 7단계 text 전체를 한 번에 LLM에 넣어, 옛 occupation 플로우의 STAGES와 같은
//      골격(나이 3·7·14·18·25·32·45·55·68·82마다 장면 후보 3개)으로 "그 사람 고유"의 장면 데이터를
//      만든다(buildSynthesisPrompt → synthesizeAgeScenes). 텍스트가 없는 단계는 합성 대상에서
//      제외하고 prompt-builder.js의 fallbackScenesForAge()가 옛 STAGES 후보 풀로 채운다.
//   2) 플랜 — buildLifeGraphPlan()이 합성 결과(또는 폴백)를 10나이 × 3장 = 30장짜리
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

// 나이별 장면 생성 기준 — 옛 occupation 플로우(prompt-builder.js STAGES)와 동일한 10개 나이를 쓴다.
// 각 나이는 정확히 하나의 LIFE_STAGE sublabel 범위 안에 들어간다(예: protect 0~7세 → 3·7세 둘 다 포함).
export const AGE_TO_STAGE = {
  3: 'protect',
  7: 'protect',
  14: 'growth',
  18: 'growth',
  25: 'independence',
  32: 'settling',
  45: 'responsibility',
  55: 'transition',
  68: 'settlement',
  82: 'settlement'
}
export const AGES = Object.keys(AGE_TO_STAGE)
  .map(Number)
  .sort((a, b) => a - b)

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
 * 나이(AGE_TO_STAGE)마다 장면 후보 3개를 요청하는 LLM 프롬프트를 조립한다. 글이 하나도 없으면
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
    const timeLabel = isFuture ? `${stage.label}(${stage.sublabel}, 상상 속 미래)` : `${stage.label}(${stage.sublabel})`
    const ageLabel = ages.length > 1 ? `나이 ${ages.join('·')}세` : `나이 ${ages[0]}세`
    return `- ${timeLabel} [${ageLabel}]: "${text}"`
  })

  const prompt =
    `아래는 한 사람이 자기 생애의 각 시기를 스스로 짧게 적은 글이다. 이 사람의 삶에 어떤 의미가 있었는지` +
    ` 해석하거나 판단하지 말 것 — 오직 그 글에 있었을 법한 장소·빛·사물·행동 같은 감각적 디테일만 다룬다.\n\n` +
    `각 항목의 나이마다, 그 글이 묘사하는 시기 안에 있었을 법한 장면을 서로 다른 순간으로 3개씩 만들어라.` +
    ` 글에 명시적으로 없는 사건이라도 같은 시기 안에서 있었을 법하면 상상해서 추가해도 좋다 — 단 감정이나` +
    ` 의미를 서술하는 문장은 절대 쓰지 말 것, 오직 눈에 보이는 재료만. 한 항목에 나이가 여러 개면(예: 3세·7세)` +
    ` 서로 다른 시점의 장면으로 구별하고, 같은 항목 안에서도 3개가 서로 겹치지 않게 하라. 사람 얼굴 생김새` +
    ` 묘사·이름·글자·자막은 넣지 마라. 각 장면은 한 문장으로.\n\n` +
    lines.join('\n') +
    `\n\n다음 JSON 형식으로만 답하라(다른 설명 없이): ` +
    `{ "<나이>": ["장면1", "장면2", "장면3"], ... } — 위에 나온 나이를 전부 키로 포함해야 한다.`

  const ages = entries.flatMap((e) => e.ages)
  return { prompt, ages }
}

/**
 * buildSynthesisPrompt가 만든 프롬프트에 대한 LLM 응답 텍스트를 파싱·검증한다.
 * @param {string} raw            gclient.generateText()가 반환한 원문
 * @param {number[]} expectedAges 응답에 반드시 있어야 하는 나이 키 목록
 * @returns {Record<number, string[]>}  { [age]: [장면1, 장면2, 장면3] }
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

  const out = {}
  for (const age of expectedAges) {
    const arr = data[String(age)]
    if (!Array.isArray(arr) || arr.length !== 3 || arr.some((s) => typeof s !== 'string' || !s.trim())) {
      throw new Error(`장면 합성 응답에 나이 ${age}의 장면 3개가 없음: ${JSON.stringify(arr)}`)
    }
    out[age] = arr.map((s) => s.trim())
  }
  return out
}

/**
 * 1차 합성 — 세션의 7단계 text를 종합해 나이별 장면 후보 3개씩을 LLM으로 만든다.
 * 글이 하나도 없는 세션이면 LLM을 호출하지 않고 빈 객체를 반환한다(전부 폴백으로 채워짐).
 * @param {import('./gemini-client.js').GeminiClient} gclient
 * @param {object} profile
 * @param {object} sessionPoints
 * @returns {Promise<Record<number, string[]>>}  글이 있던 단계의 나이만 포함 — 나머지는
 *   buildLifeGraphPlan이 fallbackScenesForAge로 채운다.
 */
export async function synthesizeAgeScenes(gclient, profile, sessionPoints) {
  const { prompt, ages } = buildSynthesisPrompt(profile, sessionPoints)
  if (!prompt) return {}
  const raw = await gclient.generateText({ prompt })
  return parseSynthesizedScenes(raw, ages)
}

/**
 * 세션 하나(과거~현재~그 세션의 미래)의 최종 장면 플랜을 만든다. 10개 나이(AGES) × 3장 = 최대 30장.
 * life-library.js의 manifest.images 항목과 같은 모양이라 admin UI가 그대로 읽는다.
 * @param {object} profile        { name, birthDate, age }
 * @param {object} sessionPoints  Firestore 문서의 first/second/third 필드 —
 *   { [stageId]: { x, text, imageURL? } }, stageId는 LIFE_STAGES의 id 또는 `future-${id}`.
 * @param {Record<number, string[]>} [ageScenes]  synthesizeAgeScenes() 결과 — 글이 있던 나이의
 *   장면 3개씩. 없는 나이는 fallbackScenesForAge()로 채운다.
 * @returns {Array<{ stageIndex, sceneIndex, id, stageId, age, year, isPast, scene, emotion }>}
 *   stageId는 사진 레퍼런스를 찾을 때 쓴다(collectStagePhotoURLs 참조) — 같은 LIFE_STAGE에
 *   배정된 나이가 여럿이면(예: 3세·7세) 둘 다 같은 stageId(그리고 같은 레퍼런스 사진)를 가진다.
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
      : fallbackScenesForAge(age, `${profile.name}|${profile.birthDate}|${age}`)
    if (!scenes || scenes.length !== 3)
      throw new Error(`나이 ${age}의 장면 데이터가 없음 (합성 결과 누락 또는 폴백 실패): stageId=${stageId}`)

    scenes.forEach((scene, i) => {
      const sceneIndex = i + 1
      plan.push({
        stageIndex,
        sceneIndex,
        id: `${age}-${sceneIndex}`,
        stageId,
        age,
        year: birthYear + age,
        isPast: !isFuture,
        scene,
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
