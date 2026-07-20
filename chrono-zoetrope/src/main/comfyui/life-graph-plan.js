// cdb-crafter(인생그래프 앱) 세션 → 장면 플랜.
//
// life-library.js/prompt-builder.js의 옛 파이프라인은 occupation + 고정 10단계 나이 템플릿을
// 전제로 한다. cdb-crafter는 완전히 다른 재료를 준다 — 사용자가 실제로 그린 감정곡선의
// 7개 생애주기 단계(보호기~정리기)마다 { x(감정 위치), text(직접 쓴 글), imageURL(사진, 과거~현재만) }.
//
// §1(해석적 자율성) 준수: 감정 위치(x)는 이 플랜에 기록만 하고 장면 문구(scene)에는 섞지 않는다.
// scene은 사용자가 직접 쓴 text를 그대로 재료로 쓴다(AI가 서사를 판단해 덧붙이지 않음) — text가
// 비어 있을 때만 아래 감정 서술 없는 밋밋한 기본 문구로 대신한다.
//
// LIFE_STAGES는 cdb-crafter/src/stageUtils.js의 LIFE_STAGES와 반드시 짝을 맞춰야 한다(별도
// 리포지토리라 import 공유 불가) — 그쪽이 바뀌면 여기도 같이 고칠 것.
export const LIFE_STAGES = [
  { id: 'protect', label: '보호기', sublabel: '0~7세' },
  { id: 'growth', label: '성장기', sublabel: '8~19세' },
  { id: 'independence', label: '독립기', sublabel: '20대 초중반' },
  { id: 'settling', label: '정착기', sublabel: '20대 후반~30대' },
  { id: 'responsibility', label: '책임기', sublabel: '30대~50대' },
  { id: 'transition', label: '전환기', sublabel: '50대~60대' },
  { id: 'settlement', label: '정리기', sublabel: '60대 이후' }
]

// subjectNoun(아동/성인 판정)과 admin 카드 표시(나이·연도)용 대표 나이 — 프롬프트 텍스트에
// 나이 숫자를 노출하진 않는다(scene 문구에는 안 들어감).
export const REPRESENTATIVE_AGE = {
  protect: 5,
  growth: 13,
  independence: 22,
  settling: 30,
  responsibility: 42,
  transition: 57,
  settlement: 70
}

// 사용자가 글을 안 남긴 단계용 폴백 — 장소·사물 수준의 밋밋한 문구만, 감정·의미 서술 없음(§1).
const FALLBACK_SCENE = {
  protect: 'a quiet room with soft daylight, ordinary objects resting nearby',
  growth: 'a schoolyard or classroom corner, everyday objects scattered nearby',
  independence: 'a small apartment room, ordinary daily items in view',
  settling: 'an ordinary workplace or home interior, everyday objects nearby',
  responsibility: 'a household room with everyday items, ordinary furnishings',
  transition: 'a familiar neighborhood street, ordinary objects nearby',
  settlement: 'a quiet room by a window, ordinary objects resting nearby'
}

/**
 * 세션 하나(과거~현재~그 세션의 미래)의 장면 플랜을 만든다. 단계당 perStage장(기본 3, occupation
 * 플로우의 config.perStage와 같은 값) — 같은 장면 재료로 여러 장 뽑는다(사용자 입력이 더 디테일해질
 * 예정이라 후보를 여러 장 만들어두고 고를 여지를 준다). Gemini는 시드가 없어 같은 프롬프트를 여러 번
 * 불러도 자연히 결과가 달라진다.
 * @param {object} profile        { name, birthDate, age }
 * @param {object} sessionPoints  Firestore 문서의 first/second/third 필드 —
 *   { [stageId]: { x, text, imageURL? } }, stageId는 LIFE_STAGES의 id 또는 `future-${id}`.
 * @param {object} [opts]
 * @param {number} [opts.perStage=3]  단계당 생성할 장 수.
 * @returns {Array<{ stageIndex, sceneIndex, id, stageId, age, year, isPast, scene, emotion }>}
 *   life-library.js의 manifest.images 항목과 같은 모양이라 admin UI가 그대로 읽는다.
 *   stageId는 사진 레퍼런스를 찾을 때 쓴다(collectStagePhotoURLs 참조) — id는 stageId에
 *   sceneIndex가 붙어 장마다 고유해진 값(예: "protect-1", "protect-2", "protect-3").
 */
export function buildLifeGraphPlan(profile, sessionPoints, { perStage = 3 } = {}) {
  const birthYear = parseInt(String(profile.birthDate).slice(0, 4), 10)
  if (!Number.isFinite(birthYear))
    throw new Error(`birthDate 형식이 잘못됨: ${profile.birthDate} (YYYY-MM-DD)`)

  const plan = []
  LIFE_STAGES.forEach((stage, i) => {
    const futureId = `future-${stage.id}`
    const isFuture = sessionPoints[futureId] !== undefined
    const stageId = isFuture ? futureId : stage.id
    const point = sessionPoints[stageId]
    if (!point) return // 이 단계에 점이 없음 — 방어적으로 건너뜀(정상 흐름이면 항상 있어야 함)

    const age = REPRESENTATIVE_AGE[stage.id]
    const scene = point.text?.trim() || FALLBACK_SCENE[stage.id]
    for (let sceneIndex = 1; sceneIndex <= perStage; sceneIndex++) {
      plan.push({
        stageIndex: i,
        sceneIndex,
        id: `${stageId}-${sceneIndex}`,
        stageId,
        age,
        year: birthYear + age,
        isPast: !isFuture,
        scene,
        emotion: point.x // 1차는 프롬프트에 미반영 — 기록만(§1, 나중을 위한 자리)
      })
    }
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
