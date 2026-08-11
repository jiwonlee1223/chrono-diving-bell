// 장례식 파노라마 워크플로우 — Gemini 4:1 이미지 → Wan2.2 I2V 영상화.
//
// 장면 규정(사용자 확정, 2026-07-30 / 구도 개정 2026-07-31):
//   1. 한국식 장례식장 (국화 제단, 향, 검은 상복의 조문객).
//   2. 시점 = 식장 한가운데 선 고인(죽은 사람)의 1인칭. 파노라마 정면 중앙 = 제단·영정 사진,
//      뒤쪽(좌우 끝이 감기는 면) = 조문객들. 실린더에 감기면 앞엔 자신의 영정, 돌아서면 조문객.
//   3. 조문객 표정은 애도 클리셰(전원 절·눈물) 금지 — 아련한 눈빛, 슬프지만 추억에 잠긴 얼굴,
//      옅은 미소 등 결을 다양하게. 절·눈물은 한두 명까지만.
//   4. "원하는 장례식"(2026-08-04, first.funeral 스키마): 사용자가 나의 장례 단계에서 답한
//      상주(chiefMourner)는 제단 옆 상주석에 세우고, 마지막 편지 수신인·묘비명·장례 방식·안식처는
//      조문객 캐스트 합성의 근거로 넣는다(collectFuneralWishes).
//
// 장례식은 **두 벌** 만든다(2026-08-03 확정) — 같은 사람의 두 죽음:
//   variant 'present' — "지금 죽었다면"의 장례식. 나이 = 현재 나이(resolveDeceasedAge),
//                       개인화 재료 = 탄생~현 시점 본인 입력 텍스트, 영정 = 제출 사진.
//   variant 'future'  — "이대로 살아 90세에 죽었다면"의 장례식. 나이 = FUTURE_DEATH_AGE(90,
//                       life-graph-plan.js 마지막 나이와 같은 자리), 개인화 재료 = 과거~현재 +
//                       future-* 슬롯(사용자가 상상해 쓴 미래), 영정 = _aged/90.png(aged-anchor).
// 둘은 manifest의 서로 다른 키(funeral / funeralFuture)와 서로 다른 파일 접두사를 쓸 뿐,
// rev·승인 게이트·영상화·Firebase 저장 흐름은 완전히 같다.
//
// 산출물(라이브러리 <personaDir>/funeral/):
//   funeral-r<rev>.png / .mp4         present 판
//   funeral-future-r<rev>.png / .mp4  future 판
//   portrait.png / portrait-future.png  영정 포트레이트 캐시(판별)
// 생성마다 rev를 올리고 파일을 rev별로 남긴다 — manifest.funeral.history가 그대로
// "생성 히스토리"가 되고, admin에서 옛 rev의 이미지·영상도 다시 볼 수 있다.
//
// 생성은 승인 게이트로 나뉜다: 이미지 생성(status 'image'→'review') → admin 검토·승인(approved)
// → 영상화(status 'video'→'done') → admin "Firebase 저장" 버튼(firebase 필드 기록).
//
// manifest.funeral (present) / manifest.funeralFuture (future) = {
//   variant: 'present'|'future',
//   rev, status: 'image'|'review'|'video'|'done'|'error', error,
//   approved, approvedAt,                                     // 승인 게이트 (새 rev마다 리셋)
//   firebase: { uploadedAt, imageUrl, videoUrl } | null,      // 저장 버튼 결과
//   image: { file, prompt, model, elapsedMs, generatedAt },   // 최신 rev의 이미지
//   video: { file, elapsedMs, generatedAt },                  // 최신 rev의 최신 영상
//   videoRev, videoHistory: [video...],                       // 영상만 재생성(force video)한 이전 판들

//   history: [{ rev, imageFile, videoFile, prompt, startedAt, doneAt, status, error }]
// }
//
// profile-worker(자동 생성 best-effort)와 admin-server(수동 재생성 큐)가 공유한다.
// 다른 comfyui/* 모듈과 같은 원칙: Electron 비의존 순수 Node.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComfyUIClient } from './client.js'
import { buildWan22I2VWorkflow } from './workflows.js'
import { nearestGeminiAspect, cropImageTo41 } from './gemini-client.js'
import { agedPortrait } from './aged-anchor.js'
import { AGES, resolveAgePoint } from './life-graph-plan.js'
import { FULL_BODY_RULE } from './prompt-builder.js'

export const FUNERAL_DIR = 'funeral'

// ── 장례식 variant ────────────────────────────────────────────────────────────
// 'present' = 지금의 죽음 / 'future' = 이대로 살아 90세에 맞는 죽음 /
// 'branched' = 3차 플로우 — 대화로 마음가짐이 바뀌어 다른 삶을 살고 90세에 맞는 죽음.
// branched는 시점(90세)·영정(aged 90) 등 미래판과 같은 의미를 공유하고, 저장 키·파일 접두사만
// 갈린다. 자동 생성 목록(FUNERAL_VARIANTS)에는 없다 — 대화 기록이 생긴 뒤 processBranchedFuture가 만든다.
export const FUNERAL_VARIANTS = ['present', 'future']

// 미래 장례식의 사망 나이 — life-graph-plan.js AGES의 마지막(90)과 같은 자리다.
// 주마등의 마지막 장면(FINAL_SCENE, 90세 임종)이 곧 이 장례식의 직전이 되도록 맞춘 값.
export const FUTURE_DEATH_AGE = 90

/** variant 정규화 — 알 수 없는 값은 present(기존 동작)로. */
export function normalizeVariant(variant) {
  return variant === 'future' || variant === 'branched' ? variant : 'present'
}

/** manifest에서 이 variant의 상태가 사는 키. present는 기존 키를 그대로 쓴다(하위호환). */
export function funeralManifestKey(variant) {
  const v = normalizeVariant(variant)
  return v === 'branched' ? 'funeralBranched' : v !== 'present' ? 'funeralFuture' : 'funeral'
}

/** 파일 접두사 — present는 기존 이름 유지(기존 라이브러리 파일과 호환). */
function filePrefix(variant) {
  const v = normalizeVariant(variant)
  return v === 'branched' ? 'funeral-branched' : v !== 'present' ? 'funeral-future' : 'funeral'
}

/** admin·로그용 한글 라벨. */
export function funeralVariantLabel(variant) {
  const v = normalizeVariant(variant)
  return v === 'branched'
    ? '분기 장례식(90세)'
    : v !== 'present'
      ? '미래 장례식(90세)'
      : '현재 장례식'
}

// Wan 파라미터 기본값 — montage.json regen.wan.video와 같은 4:1 규격(1920×480).
const DEFAULT_VIDEO = { width: 1920, height: 480, length: 81, fps: 16, steps: 4, shift: 5.0 }

// 시네마그래프 지시(2026-08-04) — 4:1 equirect에서 인물 사지를 움직이면 상하체 분리가 난다
// (montage.json regen.wan.promptPrefix와 같은 원칙). 조문객은 제자리에 고정하고 표정·시선의
// 미세 변화까지만 허용, 큰 움직임은 향 연기·촛불·꽃잎 등 비인물 요소에만 준다.
const DEFAULT_MOTION_PROMPT =
  'A living photograph, cinemagraph style: the Korean funeral hall is almost completely still, solemn like a held breath, ' +
  'keeping the fixed first-person viewpoint at the center of the hall — the altar and memorial portrait in front, mourners behind. ' +
  'Every mourner stays exactly in place — no walking, no bowing, no gestures, no limb movement; bodies keep their exact pose and position. ' +
  'Only their faces barely change: one slowly blinks, gazing at the portrait with distant, wistful eyes; ' +
  'another’s faint sorrowful smile forms and fades; one stands perfectly still. ' +
  'All visible motion comes from the air itself: incense smoke rises and curls slowly, candle flames waver softly, ' +
  'white chrysanthemum petals tremble faintly. ' +
  'The camera is completely locked and static. Cinematic, realistic, extremely understated and solemn motion.'

// ── 개인화 캐스트 합성 — Firebase에 수집된 본인 입력 데이터 → 조문객 명단·행동 지시 ──
//
// cdb-crafter 세션(first/second/third)의 과거~현재 단계 텍스트(사용자가 직접 쓴 글)와
// occupation(있으면)을 한 번에 LLM에 넣어, 이 사람의 삶에 실제로 등장했을 법한 조문객
// 4~6명을 뽑는다. 각 조문객은 (who: 관계, appearance: 외형, imageAction: 정지 화면에서의
// 행동, videoAction: 영상에서의 미세한 움직임)으로 구체화되어 이미지·모션 프롬프트 양쪽에
// 들어간다 — "누구의 장례식이든 같은 조문객"이 아니라 그 사람의 생애 데이터가 비치는
// 개인화된 장면이 되게 한다.
//
// §1(해석적 자율성) 준수: 텍스트에 실제로 나타난 관계·장소·활동에서만 인물을 유도하고,
// 감정·의미 해석("한 많은 삶이었다" 류)은 요청하지 않는다 — 행동·외형 같은 감각 재료만.
// 데이터가 하나도 없으면 합성하지 않고 null을 반환한다(지어내지 않음 — 범용 프롬프트 폴백).

// 세션 점 읽기는 life-graph-plan에 단일 정의된 어댑터를 그대로 쓴다 — crafter 스키마가 또
// 바뀌어도 고칠 자리는 거기 한 곳이다(과거엔 여기에 단계 id 사본이 있었고, 스키마가 바뀌자
// 장례식만 조용히 빈 재료로 돌았다).

/**
 * 고인의 나이 — 조문객 나이대의 기준점이다.
 *   variant 'present': profile.age가 있으면 그것, 없으면 birthDate(YYYY-...)로 현재 나이를 센다.
 *                      둘 다 없으면 null(나이 지시 없이 생성).
 *   variant 'future':  항상 FUTURE_DEATH_AGE(90) — 프로필 데이터와 무관하게 고정된 죽음의 시점이다.
 * 두 장례식의 조문객 구성이 갈리는 지점이 바로 여기다: 23살의 장례식과 90살의 장례식은
 * 같은 삶의 기록에서 나와도 명단·나이대·분위기가 완전히 다르다.
 * @param {object} profile  { age?, birthDate? }
 * @param {'present'|'future'} [variant]
 * @returns {number|null}
 */
export function resolveDeceasedAge(profile = {}, variant = 'present') {
  if (normalizeVariant(variant) !== 'present') return FUTURE_DEATH_AGE // future·branched 둘 다 90세의 죽음
  if (Number.isFinite(profile.age) && profile.age > 0) return Math.round(profile.age)
  const birthYear = parseInt(String(profile.birthDate ?? '').slice(0, 4), 10)
  if (!Number.isFinite(birthYear)) return null
  const age = new Date().getFullYear() - birthYear
  return age > 0 && age < 130 ? age : null
}

/**
 * 영정 포트레이트 프리패스 — 파노라마(flash)가 넓은 4:1 장면 안에 작은 영정을 그리면 얼굴이
 * 뭉개져 "다른 사람처럼" 나온다(2026-07-31 실증). 그래서 aged-anchor와 같은 2단계 패턴을 쓴다:
 *   1) pro 모델로 제출 사진 → 정식 영정 포트레이트(3:4, 검은 정장·정면·무배경)를 크게 생성해
 *      funeral/portrait.png에 캐시한다(정체성 보존은 pro가 훨씬 강하다).
 *   2) 파노라마 생성엔 원본 사진 대신 이 포트레이트를 레퍼런스로 실어 "첨부 이미지가 곧
 *      액자 속 사진"이라고 지시한다 — 모델은 얼굴을 새로 그리는 게 아니라 배치만 한다.
 * 캐시가 있으면 재사용(rev가 바뀌어도 같은 사람) — 강제로 새로 뽑으려면 파일을 지운다.
 *
 * variant 'future'(90세 장례식)에서는 제출 사진을 그대로 쓰지 않는다: 영정은 죽은 그 시점의
 * 얼굴이어야 하므로, 먼저 aged-anchor의 _aged/90.png(pro로 뽑은 "90세의 같은 사람")를 확보해
 * 그것을 원본으로 삼아 영정 포트레이트를 만든다. 즉 두 단계가 겹친다:
 *   제출 사진 → (aged-anchor, pro) 90세 얼굴 → (여기, pro) 90세 영정 → 파노라마(flash) 액자 배치.
 * 캐시는 판별로 갈린다(portrait.png / portrait-future.png) — 두 장례식의 영정이 섞이면 안 된다.
 * @returns {Promise<Buffer|null>} 포트레이트 버퍼(실패 시 null — 원본 사진 폴백)
 */
export async function ensureFuneralPortrait({
  gclient,
  faceRef,
  profile = {},
  personaDir,
  model,
  imageSize = '2K',
  variant = 'present',
  signal,
  log = () => {}
}) {
  const v = normalizeVariant(variant)
  if (!faceRef || !gclient) return null
  const portraitPath = path.join(
    personaDir,
    FUNERAL_DIR,
    v !== 'present' ? 'portrait-future.png' : 'portrait.png'
  )
  try {
    return await fs.readFile(portraitPath) // 캐시 적중 — 같은 사람이므로 rev와 무관하게 재사용
  } catch {
    /* 캐시 없음 — 아래에서 생성 */
  }
  // 미래판: 영정의 원본을 "90세의 얼굴"로 먼저 바꾼다(캐시 _aged/90.png는 파노라마 파이프라인과 공유).
  let sourceFace = faceRef
  if (v !== 'present') {
    try {
      const aged = await agedPortrait({
        gclient,
        faceBuf: faceRef,
        profile,
        age: FUTURE_DEATH_AGE,
        isPast: false,
        personaDir,
        model,
        imageSize,
        signal,
        log
      })
      if (aged?.buffer) {
        sourceFace = aged.buffer
        log(
          `  [장례식] 미래 영정: ${FUTURE_DEATH_AGE}세 얼굴 앵커 사용 (${aged.path}${aged.cached ? ', 캐시' : ''})`
        )
      } else {
        log(
          `  [경고] 미래 영정: ${FUTURE_DEATH_AGE}세 앵커를 못 만들었다 — 제출 사진으로 폴백(나이 어긋남 가능)`
        )
      }
    } catch (err) {
      log(`  [경고] 미래 영정 나이 앵커 실패(제출 사진으로 폴백): ${err.message}`)
    }
  }
  try {
    const gender =
      profile.gender === 'male' ? 'man' : profile.gender === 'female' ? 'woman' : 'person'
    const prompt =
      `A formal Korean funeral memorial portrait photograph (yeongjeong) of the EXACT SAME ${gender} as in the` +
      ` attached photo. CRITICAL: this must be unmistakably the very same individual — identical facial structure,` +
      ` identical features, identical impression; do not beautify, do not change age, do not substitute or blend` +
      ` with any other face. Front-facing, looking straight at the camera, calm neutral expression, wearing formal` +
      ` dark clothing, plain light studio background, soft even lighting. Head and shoulders composition,` +
      ` photorealistic. No text anywhere.`
    const t0 = Date.now()
    const data = await gclient.generateImage({
      prompt,
      references: [sourceFace],
      aspectRatio: '3:4',
      imageSize,
      model, // pro — 정체성 보존용 (파노라마 flash와 별개)
      signal
    })
    await fs.mkdir(path.join(personaDir, FUNERAL_DIR), { recursive: true })
    await fs.writeFile(portraitPath, data)
    log(
      `  [장례식] 영정 포트레이트 생성 [${funeralVariantLabel(v)}] (pro, ${((Date.now() - t0) / 1000).toFixed(1)}s) — 캐시됨`
    )
    return data
  } catch (err) {
    log(`  [경고] 영정 포트레이트 생성 실패(원본 사진으로 폴백): ${err.message}`)
    return null
  }
}

// 패키지 루트(chrono-zoetrope/) — 이 파일이 src/main/comfyui/ 아래 있으므로 세 단계 위.
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

// config.funeral.layoutRefPath 기본값 — 실측 360 장례식장 사진(구도·깊이 레퍼런스).
// 배경음악·아이콘과 같은 resources/에 둔다(별도 폴더를 만들 만큼 성격이 다르지 않다).
// 참고: resources/는 server/index.mjs가 GET /resources/<파일>로 통째로 공개 서빙한다 —
// 이 파일은 일반 장례식장 사진이라 무방하지만, 참가자 사진 등은 여기 두면 안 된다.
export const DEFAULT_LAYOUT_REF_PATH = 'resources/funeral-layout-ref.png'

/**
 * 구도 레퍼런스 이미지 로드(best-effort). 파일이 없으면 null — 프롬프트에서 구도 레퍼런스 문단이
 * 통째로 빠지고(hasLayoutRef=false) 글로 쓴 스케일 지시만으로 생성한다. layoutRefPath는
 * 패키지 루트(chrono-zoetrope/) 기준 상대경로이거나 절대경로다(다른 config 경로와 같은 규칙).
 * @param {object} fcfg  config.funeral
 * @returns {Promise<Buffer|null>}
 */
export async function loadFuneralLayoutRef(fcfg = {}, log = () => {}) {
  if (fcfg.layoutRef === false) return null
  const rel = fcfg.layoutRefPath || DEFAULT_LAYOUT_REF_PATH
  const abs = path.isAbsolute(rel) ? rel : path.resolve(PKG_ROOT, rel)
  try {
    return await fs.readFile(abs)
  } catch {
    log(`  [경고] 장례식 구도 레퍼런스 없음(글 지시만으로 생성): ${abs}`)
    return null
  }
}

/**
 * Firestore 문서에서 개인화 재료(본인 입력 텍스트)를 모은다. 없으면 [].
 *
 * variant로 시간 범위가 갈린다 — 두 장례식의 조문객이 달라지는 두 번째 지점이다:
 *   'present': 탄생~현 시점만. 미래 점(상상된 미래)은 아직 일어나지 않았으므로 제외한다.
 *   'future':  거기에 미래 점을 더한다. 90세 장례식의 조문객은 사용자가 직접 쓴 "앞으로 이렇게
 *              살 것이다"에서 나와야 한다(2차 미래 큐레이션 세션의 결과). 미래 텍스트는
 *              [future] 태그를 붙여 LLM이 시간 순서를 구분할 수 있게 한다.
 *
 * 점을 찾는 일은 life-graph-plan의 resolveAgePoint에 맡긴다 — crafter의 두 스키마(나이 키 /
 * 옛 단계 키)를 거기서 한 번에 흡수하고, 과거/미래 판정도 같은 규칙을 쓴다(스키마마다 판정이
 * 갈리면 두 장례식의 재료가 어긋난다).
 * @param {object} doc
 * @param {'present'|'future'} [variant]
 */
export function collectFuneralSourceTexts(doc = {}, variant = 'present') {
  const withFuture = normalizeVariant(variant) !== 'present'
  const past = []
  const future = []
  // 직업: 새 스키마는 job, 옛 occupation 플로우는 occupation.
  const job = doc.job || doc.occupation
  if (job) past.push(`Occupation: ${job}`)
  for (const sessionKey of ['first', 'second', 'third']) {
    const points = doc[sessionKey]
    if (!points) continue
    // 점 단위로 한 번씩만 — 옛 스키마는 한 점(단계)에 나이가 여럿 매달려 있어 나이로만 돌면
    // 같은 글이 5번씩 들어가고, 그러면 LLM이 그 대목을 그 삶의 중심으로 오해한다.
    const seen = new Set()
    for (const age of AGES) {
      const resolved = resolveAgePoint(age, points, doc)
      if (!resolved || seen.has(resolved.key)) continue
      seen.add(resolved.key)
      const t = resolved.point?.text?.trim()
      if (!t) continue
      if (resolved.isFuture) future.push(`[future] ${t}`)
      else past.push(t)
    }
  }
  return withFuture ? [...past, ...future] : past
}

/**
 * "원하는 장례식" — crafter의 나의 장례 단계에서 사용자가 직접 답한 장례 희망사항(2026-08-04 스키마).
 * doc.first.funeral = { messages:[{to,text}], funeralMethod, burialSite, chiefMourner, epitaph }.
 * 전부 본인 입력이므로 §1의 "본인 재료" 범주 — 캐스트 합성(상주·마지막 편지의 수신인)과
 * 장면 프롬프트(상주의 자리)에 그대로 반영해, 범용 장례식이 아니라 그 사람이 바란 장례식이 되게 한다.
 * 쓸 만한 값이 하나도 없으면 null.
 * @param {object} doc  Firestore 문서
 * @returns {{funeralMethod,burialSite,chiefMourner,epitaph,messages:Array<{to,text}>}|null}
 */
export function collectFuneralWishes(doc = {}) {
  const f = doc.first?.funeral
  if (!f) return null
  const wishes = {
    funeralMethod: f.funeralMethod?.trim() || null,
    burialSite: f.burialSite?.trim() || null,
    chiefMourner: f.chiefMourner?.trim() || null,
    epitaph: f.epitaph?.trim() || null,
    messages: (f.messages || [])
      .map((m) => ({ to: m?.to?.trim() || '', text: m?.text?.trim() || '' }))
      .filter((m) => m.to || m.text)
  }
  const hasAny = Object.values(wishes).some((v) => (Array.isArray(v) ? v.length > 0 : Boolean(v)))
  return hasAny ? wishes : null
}

/**
 * 조문객 캐스트 합성(best-effort). 재료가 없거나 LLM이 실패하면 null — 호출자는 범용 프롬프트로 폴백.
 * @param {object} gclient  GeminiClient (generateText 사용 — textModel)
 * @param {object} doc      Firestore 문서 (occupation·first/second/third 세션 텍스트)
 * @param {object} [opts]
 * @param {number|null} [opts.age]  고인의 나이 — 조문객 나이대를 여기에 맞춘다(resolveDeceasedAge).
 * @returns {Promise<Array<{who,appearance,imageAction,videoAction}>|null>}
 */
export async function synthesizeFuneralCast(
  gclient,
  doc,
  { age = null, variant = 'present', branchNarrative = null, signal, log = () => {} } = {}
) {
  const v = normalizeVariant(variant)
  // 분기(3차) 장례식 + 연대기: 노년의 근거는 [future] 점(운명 미래)이 아니라 **분기 연대기**다 —
  // 운명 미래 텍스트로 조문객을 뽑으면 미래 장례식과 같은 그림이 된다. 과거 점만 남기고
  // 연대기를 1순위 재료로 얹는다. 연대기가 없으면(구세대 데이터) 종전 동작(미래판과 동일).
  const useNarrative = v === 'branched' && String(branchNarrative || '').trim()
  const texts = collectFuneralSourceTexts(doc, useNarrative ? 'present' : v)
  const wishes = collectFuneralWishes(doc)
  if (texts.length === 0 && !wishes && !useNarrative) return null
  // 나이 지시를 명단 단계에 넣는다 — "노모"·"은퇴한 동료"처럼 나이가 관계에 박혀 있어서,
  // 이미지 프롬프트에서 나중에 나이만 보정하려 해도 관계 자체가 이미 어긋나 있다.
  const ageLine = !age
    ? ''
    : v !== 'present'
      ? `\n\nThe deceased died at ${age} years old. Choose relationships that make sense at that age and give each` +
        ` mourner an age range consistent with it: surviving contemporaries are themselves around ${age} and frail;` +
        ` a child generation is roughly ${age - 35} to ${age - 28}; grandchildren are young adults; the deceased's` +
        ` own parents are long gone and must NOT appear. It is fine — expected, even — for many mourners here to be` +
        ` old, but do not make the hall uniformly elderly: include the younger generations too.`
      : `\n\nThe deceased is ${age} years old. Choose relationships that make sense at that age and give each` +
        ` mourner an age range consistent with it: contemporaries are around ${age}, a parent generation is roughly` +
        ` ${age + 28}-${age + 35}, grandparents older still, children (if any) correspondingly young.` +
        ` A ${age}-year-old's funeral is not attended mainly by the elderly — do not default to middle-aged or` +
        ` old mourners, and do not invent adult children or grandchildren the age makes impossible.`
  // 미래판 전용 지시 — 같은 삶의 기록이라도 "지금 죽는 장례식"과 "90세까지 살고 죽는 장례식"은
  // 조문객 명단 자체가 다르다: 동시대인은 함께 늙고, 부모 세대는 대개 이미 없고, 노년에야
  // 생기는 관계(자녀·손주·오래된 이웃)가 [future] 텍스트를 근거로 등장할 수 있다.
  const intro =
    v !== 'present'
      ? `Below are autobiographical notes a person wrote about their own life. Entries marked [future] are what` +
        ` they imagined and wrote about their life still to come; the rest is from birth up to the present` +
        ` (translated or in Korean; treat Korean text as-is):`
      : `Below are autobiographical notes a person wrote about their own life, from birth up to the present` +
        ` (translated or in Korean; treat Korean text as-is):`
  const timeFrame =
    v !== 'present'
      ? `\n\nThis person did NOT die now — they went on living${
          useNarrative
            ? ` a DIVERGED later life, described in the chronicle below (an immersive experience shifted their outlook and they made different choices)`
            : ` the life described above, including the [future] entries`
        }, and died of old age at ${FUTURE_DEATH_AGE}. We are composing the scene of their Korean funeral` +
        ` (장례식장) many decades from now, seen from the deceased's own viewpoint standing at the center of the` +
        ` hall — their memorial portrait and altar in front of them, the mourners behind them.` +
        ` Everyone who is still there has aged along with them: friends and colleagues from the notes are now` +
        ` elderly themselves, most of the parent generation is gone, and relationships that only form later in` +
        ` life (children, grandchildren, long-time neighbours, people met through the [future] entries) may attend` +
        ` — but ONLY where the notes give a basis for them.`
      : `\n\nThis person has died, and we are composing the scene of their Korean funeral (장례식장) seen from the` +
        ` deceased's own viewpoint standing at the center of the hall — their memorial portrait and altar in front` +
        ` of them, the mourners behind them.`
  // 원하는 장례식 — 본인이 답한 장례 희망사항. 상주는 명단에 반드시 들어가고, 마지막 편지의
  // 수신인은 조문객의 1순위 후보다(편지를 남길 만큼 가까운 사람이 조문을 안 올 리 없다).
  const wishLines = []
  if (wishes?.chiefMourner)
    wishLines.push(
      `- They wanted their chief mourner (상주) to be: "${wishes.chiefMourner}". This person MUST be one of the` +
        ` mourners — make them the FIRST entry, and state in "who" that they are the chief mourner (sangju).`
    )
  for (const msg of wishes?.messages || []) {
    if (!msg.to) continue
    wishLines.push(
      `- They left a farewell letter to "${msg.to}"${msg.text ? ` saying (Korean): "${msg.text}"` : ''}.` +
        ` Someone this close would attend — strongly prefer including them among the mourners.`
    )
  }
  if (wishes?.epitaph)
    wishLines.push(`- The epitaph they chose for themselves (Korean): "${wishes.epitaph}"`)
  if (wishes?.funeralMethod)
    wishLines.push(`- The funeral method they wished for (Korean): "${wishes.funeralMethod}"`)
  if (wishes?.burialSite)
    wishLines.push(`- Where they wished to be laid to rest (Korean): "${wishes.burialSite}"`)
  const wishBlock = wishLines.length
    ? `\n\nThey also answered questions about the funeral they themselves wanted — honor these wishes when` +
      ` composing the mourners (use them as grounding material, not as emotions to narrate):\n` +
      wishLines.join('\n')
    : ''
  // 분기 연대기 블록 — 노년 관계(자녀·이웃·새 일로 만난 사람들)의 1순위 근거.
  const narrativeBlock = useNarrative
    ? `\n\nTHE DIVERGED LIFE CHRONICLE (what actually happened after the present day — your PRIMARY source` +
      ` for later-life relationships and circumstances):\n${String(branchNarrative).trim()}`
    : ''
  const prompt =
    intro +
    (texts.length ? `\n\n` + texts.map((t, i) => `[${i + 1}] ${t}`).join('\n') : `\n\n(no notes)`) +
    narrativeBlock +
    wishBlock +
    timeFrame +
    ` From the ${useNarrative ? 'notes and the diverged chronicle' : 'notes'} above, infer 4 to 6 mourners who would realistically attend — ONLY people or kinds of people` +
    ` actually implied by ${useNarrative ? 'them' : 'the notes'} (family members, old friends, colleagues, students, teammates, neighbors...).` +
    ` Do not invent relationships the notes give no basis for. Do not use real personal names; describe each` +
    ` mourner by relationship and appearance.` +
    ageLine +
    `\n\nFor each mourner give concrete, visible, funeral-appropriate details in ENGLISH — physical appearance and` +
    ` actions only, no emotional interpretation or narration of what the life "meant":` +
    `\n- "who": their relationship to the deceased (grounded in the notes)` +
    `\n- "appearance": age range (an explicit number or range, consistent with the guidance above),` +
    ` clothing (black funeral suit / black hanbok / mourning armband...), one physical detail` +
    `\n- "imageAction": what they are doing in a still photograph of this moment. AVOID the cliché of everyone` +
    ` bowing or weeping — vary the texture of mourning: gazing at the portrait with distant, wistful eyes;` +
    ` sorrowful yet lost in a fond memory; the faint trace of a smile while recalling something; quietly holding` +
    ` an object tied to the deceased's life; speaking to another mourner in a hushed voice; standing still,` +
    ` looking down. At most ONE of them may be bowing or in tears.` +
    `\n- "videoAction": one subtle continuous motion for a short video, matching that same varied texture` +
    ` (a slow blink with distant eyes, a faint smile forming and fading, lips moving in a quiet exchange,` +
    ` fingers slowly turning a kept object, incense smoke drifting past them...)` +
    `\nReturn ONLY JSON: {"mourners":[{"who":"...","appearance":"...","imageAction":"...","videoAction":"..."}]}`
  try {
    const out = await gclient.generateText({
      prompt,
      responseJson: true,
      signal
    })
    // 관용 파싱(2026-08-04): responseJson에도 모델이 가끔 코드펜스·후행 쉼표를 섞는다
    // (실측: "Expected double-quoted property name" — 후행 쉼표). 한 번의 오류로 캐스트
    // 전체를 버리고 범용 폴백으로 가면 개인화가 통째로 사라지므로, 흔한 두 오염만 걷어내고 다시 판다.
    let parsed
    try {
      parsed = JSON.parse(out)
    } catch {
      const cleaned = out
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .replace(/,\s*([}\]])/g, '$1')
      parsed = JSON.parse(cleaned)
    }
    const cast = (parsed.mourners || []).filter((m) => m && m.who)
    if (cast.length === 0) return null
    log(
      `  [장례식] 조문객 캐스트 합성 [${funeralVariantLabel(v)}]: ${cast.length}명 (${cast.map((m) => m.who).join(', ')})`
    )
    return cast.slice(0, 6)
  } catch (err) {
    log(`  [경고] 장례식 캐스트 합성 실패(범용 프롬프트로 폴백): ${err.message}`)
    return null
  }
}

/**
 * 장례식 배경(장소) 합성 — 본인이 답한 장례 방식(funeralMethod)·안식처(burialSite)를 읽어
 * 표준 실내 장례식장이 맞는지, 아니면 다른 공간(수목장 숲·바닷가·성당·자택…)이 맞는지 판정하고
 * 그 공간을 영어로 묘사한다. 사람마다 원하는 장례식의 결이 다르므로(2026-08-04) 배경도 희망사항을
 * 따라간다. 결과는 캐스트처럼 rev별 manifest(f.venue)에 캐시된다.
 * null = 희망사항 없음/판정 실패 → 기존 표준 식장 그대로(안전 폴백).
 * @returns {Promise<{indoorHall:boolean, setting:string, altar:string|null}|null>}
 */
export async function synthesizeFuneralVenue(gclient, wishes, { signal, log = () => {} } = {}) {
  const method = wishes?.funeralMethod
  const site = wishes?.burialSite
  if (!method && !site) return null
  const prompt =
    `A Korean person answered questions about the funeral they want for themselves` +
    ` (treat Korean text as-is):\n` +
    (method ? `- The funeral method they wished for: "${method}"\n` : '') +
    (site ? `- Where they wished to be laid to rest: "${site}"\n` : '') +
    `\nWe are composing a photograph of that funeral ceremony. Decide the VENUE that best honors these wishes:\n` +
    `- If the wishes fit an ordinary modern Korean funeral hall (장례식장) — e.g. cremation followed by a` +
    ` columbarium, a standard 3-day funeral, or no clear venue implication — answer indoorHall=true, and in` +
    ` "setting" describe only small visible touches INSIDE the hall that hint at their wish (a framed landscape` +
    ` photo of the resting place near the altar, particular flowers or plants, a kept object...).\n` +
    `- If the wishes clearly imply a DIFFERENT kind of place (a tree burial in a forest / 수목장, ashes scattered` +
    ` at sea, a natural burial meadow, a church or cathedral, a quiet home funeral...), answer indoorHall=false` +
    ` and in "setting" describe that ceremony space itself in concrete visual terms: the landscape or` +
    ` architecture, materials, weather and light, in Korea unless the wish names another country.\n` +
    `- In "altar": describe the memorial altar arrangement fitting that venue and wish — still recognizably a` +
    ` Korean memorial altar with a framed portrait, flowers and offerings.\n` +
    `Everything in ENGLISH, physical and visible details only, no emotions or narration. 1-3 sentences per field.\n` +
    `Return ONLY JSON: {"indoorHall":true|false,"setting":"...","altar":"..."}`
  try {
    const out = await gclient.generateText({ prompt, responseJson: true, signal })
    // 관용 파싱 — synthesizeFuneralCast와 동일 사유(코드펜스·후행 쉼표 오염)
    let parsed
    try {
      parsed = JSON.parse(out)
    } catch {
      const cleaned = out
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .replace(/,\s*([}\]])/g, '$1')
      parsed = JSON.parse(cleaned)
    }
    if (typeof parsed.indoorHall !== 'boolean' || !parsed.setting) return null
    const venue = {
      indoorHall: parsed.indoorHall,
      setting: String(parsed.setting).trim(),
      altar: parsed.altar ? String(parsed.altar).trim() : null
    }
    log(
      `  [장례식] 배경 합성: ${venue.indoorHall ? '표준 식장 + 희망 힌트' : '맞춤 장소'} — ${venue.setting.slice(0, 100)}`
    )
    return venue
  } catch (err) {
    log(`  [경고] 장례식 배경 합성 실패(표준 식장으로 폴백): ${err.message}`)
    return null
  }
}

/**
 * Wan2.2 모션 프롬프트 — 캐스트가 있으면 조문객별 움직임 지시(videoAction)를 덧붙여
 * 영상도 개인화한다. base는 config.funeral.motionPrompt(없으면 기본 문구).
 * @param {Array}  [cast]  synthesizeFuneralCast 결과
 * @param {string} [base]
 */
export function buildFuneralMotionPrompt(
  cast = null,
  base = DEFAULT_MOTION_PROMPT,
  variant = 'present'
) {
  // 미래판은 조문객 다수가 노인이다 — 모션도 그에 맞춰 느려야 한다(Wan이 기본적으로 젊은
  // 몸짓을 넣으면 이미지의 노년 조문객과 어긋나 보인다).
  const aged =
    normalizeVariant(variant) !== 'present'
      ? ' Many of the mourners are elderly: their movements are slower and frailer still, hands trembling faintly, ' +
        'some seated and shifting only slightly.'
      : ''
  const prompt = (base || DEFAULT_MOTION_PROMPT) + aged
  if (!cast || !cast.length) return prompt
  return (
    prompt +
    ' Each specific mourner moves according to who they are: ' +
    cast
      .map(
        (m) => `the ${m.who} ${m.videoAction || 'gazes at the portrait with distant, wistful eyes'}`
      )
      .join('; ') +
    '. All motion stays slow, subtle and solemn.'
  )
}

/**
 * 장례식 파노라마 프롬프트 — 장례식장 한가운데 선 1인칭 시점.
 *
 * 구도(사용자 확정, 2026-07-31): 파노라마 **정면 중앙 = 제단과 영정 사진**, 시점 **뒤쪽(파노라마
 * 좌우 끝이 감기는 면) = 조문객들**. 관람자는 제단과 조문객 사이, 식장 한가운데 서 있다 —
 * 실린더에 감기면 앞을 보면 자신의 영정이, 돌아서면 자신을 조문하러 온 사람들이 있다.
 * 이음매(파노라마 좌우 끝)는 뒤쪽 정중앙의 식장 입구(민무늬 문·벽)에 떨어뜨리고, 조문객들은
 * 그 좌우(뒤-왼쪽·뒤-오른쪽)에 나눠 세운다.
 *
 * 조문객 표정(사용자 확정, 2026-07-31): "무조건 절하고 슬퍼하는" 클리셰를 금지한다. 아련한 눈빛,
 * 슬프지만 추억에 잠긴 눈빛, 옅은 미소로 무언가를 떠올리는 얼굴 등 애도의 결을 다양하게.
 *
 * 영정 사진 속 얼굴 = 사용자가 제출한 사진(포트레이트 프리패스 산출물)이다. 첨부 레퍼런스를
 * 액자 속 사진으로 그대로 쓰라고 명시한다 — 지시가 없으면 모델이 아무 얼굴이나 넣는다(rev4 증상).
 *
 * @param {object} profile  { name, gender, ... }
 * @param {Array}  [cast]   synthesizeFuneralCast 결과 — 있으면 조문객을 개인화 명단으로 대체
 * @param {boolean} [hasFaceRef]  영정 포트레이트 레퍼런스 첨부 여부 — 없으면 "레퍼런스대로" 지시를 빼고
 *   일반적인 영정 묘사만 쓴다(없는 첨부를 가리키는 모순 프롬프트를 만들지 않기 위함).
 * @param {boolean} [hasLayoutRef]  구도 레퍼런스(실측 360 장례식장 사진) 첨부 여부.
 *
 * 레퍼런스가 둘이 되면서 각 첨부에 **역할 라벨**을 붙인다(2026-08-03). gemini-client는 references를
 * 프롬프트 뒤에 배열 순서 그대로 붙이므로(generateImage), 프롬프트 맨 앞에서 "REFERENCE IMAGE 1 = ...,
 * REFERENCE IMAGE 2 = ..."로 번호를 선언하고 본문은 그 번호로만 가리킨다 — 라벨이 없으면 모델이
 * 구도 사진 속 얼굴/장소를 영정에 넣거나, 영정 인물을 식장 바닥에 세우는 식으로 역할을 섞는다.
 * 첨부 순서 = runFuneralWorkflow가 references 배열에 넣는 순서(포트레이트 → 구도)와 반드시 일치해야 한다.
 */
export function buildFuneralPrompt(
  profile = {},
  cast = null,
  hasFaceRef = false,
  hasLayoutRef = false,
  variant = 'present',
  wishes = null, // collectFuneralWishes 결과 — 상주(chiefMourner)의 자리를 장면에 박는다
  venue = null // synthesizeFuneralVenue 결과 — 희망 장례 방식·안식처에 맞는 배경(null=표준 식장)
) {
  const v = normalizeVariant(variant)
  // 맞춤 장소(수목장 숲·바닷가·성당…) — 표준 실내 식장 묘사를 venue.setting으로 대체한다.
  // 구도 불변식(정면 중앙 제단+영정, 뒤쪽 조문객, 이음매는 뒤 정중앙)은 그대로 유지.
  const customVenue = Boolean(venue && !venue.indoorHall)
  const whose = profile.name ? `This is the funeral of ${profile.name}. ` : ''
  // 첨부 번호는 실제 배열 순서를 따라 매긴다(포트레이트가 없으면 구도 사진이 1번이 된다).
  const portraitNo = hasFaceRef ? 1 : 0
  const layoutNo = hasLayoutRef ? (hasFaceRef ? 2 : 1) : 0
  const refLegend =
    hasFaceRef || hasLayoutRef
      ? `The attached reference images have DIFFERENT, STRICTLY SEPARATE roles — use each only for its stated role` +
        ` and never mix them: ` +
        [
          hasFaceRef &&
            `REFERENCE IMAGE ${portraitNo} = THE PORTRAIT PHOTO. It is the photograph that goes inside the memorial` +
              ` picture frame on the altar, and nothing else. Take ONLY the person's face and likeness from it;` +
              ` take nothing about the room, background, framing or lighting from it, and do not place this person` +
              ` anywhere else in the scene. This person is the DECEASED — they are dead and cannot stand in the` +
              ` room. Their face appears in exactly ONE place: inside the memorial picture frame. No mourner, no` +
              ` chief mourner, no bystander may share or even resemble that face.`,
          hasLayoutRef &&
            `REFERENCE IMAGE ${layoutNo} = THE LAYOUT REFERENCE. It is a real 360 equirectangular photograph of an` +
              ` actual Korean funeral hall, provided ONLY as a guide to composition, spatial depth, scale, room` +
              ` architecture, materials and lighting: how far away and how small the altar is, how much empty floor` +
              ` and ceiling fill the frame, how the walls, wooden doors, corridor, cabinetry and waiting chairs are` +
              ` arranged, and how the equirectangular projection curves the ceiling and floor. Match that sense of` +
              ` space and that camera distance. Do NOT copy any face, any person, any text or any signage from it,` +
              ` and do not treat it as the portrait.`
        ]
          .filter(Boolean)
          .join(' ') +
        ` `
      : ''
  // 영정 액자 — 파노라마 정면 정중앙. 이 장면에서 고인의 얼굴이 보이는 유일한 자리.
  const portrait = hasFaceRef
    ? `At the exact HORIZONTAL CENTER of the panorama, directly facing the viewer, the framed memorial portrait` +
      ` (yeongjeong) stands at the top of the altar: a black wooden frame draped with a black mourning ribbon,` +
      ` surrounded by white chrysanthemums.` +
      ` CRITICAL: REFERENCE IMAGE ${portraitNo} IS the photograph inside that frame — place that portrait` +
      ` photograph into the frame exactly as it is, reproducing it faithfully (same face, same facial structure,` +
      ` same features, same clothing), only adjusted for perspective and the scene's lighting.` +
      ` Do not redraw, substitute, blend or invent a different face. ` +
      // 미래판의 레퍼런스는 일부러 90세로 늙힌 얼굴(aged-anchor)이다 — flash가 "영정은 보통 젊게"
      // 라는 경향으로 되돌려 젊은 얼굴을 그리면 두 장례식의 영정이 구분되지 않는다.
      (v !== 'present'
        ? `The face in REFERENCE IMAGE ${portraitNo} is deliberately that of a very old person — keep it exactly` +
          ` that old. Do not rejuvenate, smooth or beautify it; the white hair, deep wrinkles and aged features` +
          ` must remain. `
        : '')
    : `At the exact HORIZONTAL CENTER of the panorama, directly facing the viewer, the framed memorial portrait` +
      ` (yeongjeong) stands at the top of the altar: a formal portrait photograph in a black wooden frame draped` +
      ` with a black mourning ribbon, surrounded by white chrysanthemums. `
  // 조문객 — 시점 뒤쪽(파노라마 좌우 끝 쪽). 표정·자세의 결을 다양하게 — 애도 클리셰 금지.
  const moodGuide =
    `Their expressions and postures vary — do NOT make everyone bow or weep. Some gaze at the portrait with` +
    ` distant, wistful eyes; some look sorrowful yet lost in fond memories; one has the faint trace of a smile` +
    ` while recalling something; some speak to each other in hushed voices; a few simply stand still, looking down.` +
    ` Only one or two actually bow or wipe tears.` +
    ` None of the people in the hall is the deceased — the deceased's face exists ONLY inside the framed` +
    ` memorial portrait on the altar, never on a living body. `
  // 상주가 제단 옆에 따로 서므로, 뒤쪽 조문객 명단에서는 상주를 뺀다(같은 사람이 두 번 나오면 안 된다).
  const rearCast =
    wishes?.chiefMourner && cast
      ? cast.filter((m) => !/chief\s*mourner|sangju|상주/i.test(String(m.who)))
      : cast
  const mourners =
    rearCast && rearCast.length
      ? `BEHIND the viewer — spread across the rear half of the panorama, to the far left and far right of the` +
        ` image — stand the specific mourners of this person's life, several meters away and small in the frame,` +
        ` full-figure with the floor and wall clearly visible around and between them, their faces visible as they` +
        ` look toward the altar (and thus toward the camera): ` +
        rearCast
          .map(
            (m) =>
              `${m.who} (${m.appearance || 'in black funeral attire'}), ${m.imageAction || 'gazing quietly toward the portrait'}`
          )
          .join('; ') +
        `. A few other anonymous mourners in black wait further back. ` +
        moodGuide
      : `BEHIND the viewer — spread across the rear half of the panorama, to the far left and far right of the` +
        ` image — a small number of mourners in black funeral suits and black hanbok stand and kneel several meters` +
        ` away on the wide floor of the hall, small in the frame and full-figure with plenty of empty floor and` +
        ` visible wall around them, their faces visible as they look toward the altar (and thus toward the camera). ` +
        moodGuide
  // 상주(사용자가 답한 "상주는 누가 되었으면 하나요?") — 한국 장례식장의 실제 관습대로 제단 옆
  // 상주석에 세운다. 조문객 무리(뒤쪽)와 달리 상주만은 제단 곁, 즉 파노라마 정면 근처에 있어
  // "영정을 보면 그 옆에 내가 바란 상주가 서 있는" 장면이 된다. 캐스트 명단에도 같은 인물이
  // 1번으로 들어가므로(synthesizeFuneralCast의 지시) 여기서 무리 속에 중복 배치하지 말라고 못 박는다.
  const chiefMourner = wishes?.chiefMourner
    ? `Standing beside the altar — just to one side of it, near the front-center of the panorama, clearly apart` +
      ` from the other mourners behind the viewer — is the chief mourner (sangju), the person the deceased wished` +
      // 주의: 완장을 한글 단어로 쓰면 모델이 그 글자를 완장 위에 그대로 그린다(r3 실증) — 영어 묘사만 쓴다.
      ` for: "${wishes.chiefMourner}" (Korean description of who they are). They wear black funeral attire with` +
      ` the chief mourner's traditional plain armband — a black band with two thin white stripes and absolutely` +
      ` no text or letters on it — on their left upper arm, standing quietly at the mourner's` +
      ` position where condolences are received, their face turned slightly toward the portrait. This person` +
      ` appears ONLY here, beside the altar — not again among the mourners behind the viewer.` +
      // 상주는 영정 바로 옆이라 flash가 액자 속 얼굴을 상주에게 흘리기 쉽다(2026-08-06 실증) — 명시 차단.
      (hasFaceRef
        ? ` The chief mourner is a DIFFERENT, LIVING person — absolutely NOT the deceased: their face must not` +
          ` match or resemble the face in REFERENCE IMAGE ${portraitNo} (the portrait in the frame beside them). `
        : ` The chief mourner is a different, living person — not the deceased whose portrait stands beside them. `)
    : ''
  // 스케일·깊이(실측 360 장례식장 사진 레퍼런스, 2026-08-03): 기존 프롬프트엔 거리 지시가 없어
  // 모델이 제단을 화면 가득 채워 그렸다. 실제 equirectangular 사진에서는 카메라가 제단에서
  // 4~5m 떨어져 있고 제단·영정은 프레임 세로의 절반도 차지하지 않는다 — 나머지는 텅 빈 바닥,
  // 천장(휘어진 우유빛 천장·매입 다운라이트·환기구), 벽면과 나무문, 복도, 대기 의자·낮은 탁자다.
  // 이 "작은 피사체 + 넓은 배경"이 실내 파노라마의 공간감을 만든다.
  const scaleAndDepth = customVenue
    ? `Shot with a true 360 panoramic camera on a tripod at about 1.6 m eye height, in a LARGE, OPEN ceremony space. ` +
      `THE VENUE — the funeral this person wished for themselves, honor it faithfully: ${venue.setting} ` +
      `IMPORTANT SCALE: everything is seen from a distance — the camera stands about 4 to 5 meters back from the altar, ` +
      `so the altar and its portrait occupy only a modest part of the frame, well under half of the image height, ` +
      `and every person appears SMALL within the wide space. Do not fill the frame with the altar or with people. ` +
      `The open ground of this place stretches across the entire bottom of the panorama between the camera and everything else, ` +
      `and its sky or ceiling curves across the entire top of the panorama. ` +
      `Strong equirectangular geometry: straight edges bow and stretch toward the top and bottom of the frame. `
    : `Shot with a true 360 panoramic camera on a tripod at about 1.6 m eye height, in a LARGE, SPACIOUS hall. ` +
    `IMPORTANT SCALE: everything is seen from a distance — the camera stands about 4 to 5 meters back from the altar, ` +
    `so the altar and its portrait occupy only a modest part of the frame, well under half of the image height, ` +
    `and every person appears SMALL within the wide space. Do not fill the frame with the altar or with people. ` +
    `A wide expanse of empty patterned floor stretches across the bottom of the panorama between the camera and everything else, ` +
    `and the smooth off-white ceiling with recessed downlights and ventilation grilles curves across the entire top of the panorama. ` +
    `The architecture of the room itself is clearly visible and reads as a subject in its own right: plain walls, wooden doors, ` +
    `a corridor leading away, built-in wooden cabinetry, rows of simple wooden waiting chairs and low tables along the side walls. ` +
    `Strong equirectangular geometry: straight ceiling and floor edges bow and stretch toward the top and bottom of the frame. `
  const age = resolveDeceasedAge(profile, v)
  // 조문객 나이대는 고인의 나이에 매달려 있다 — 23살의 장례식과 90살의 장례식은 조문객 구성이
  // 완전히 다르다. 캐스트 합성(synthesizeFuneralCast)에도 같은 나이를 넘겨 명단 단계에서부터 맞춘다.
  const ageContext = !age
    ? ''
    : v !== 'present'
      ? `The deceased died at ${age} years old, of old age. Every mourner's apparent age must be consistent with ` +
        `that: surviving contemporaries look about ${age} themselves — visibly old, white-haired, some seated on ` +
        `the waiting chairs or leaning on canes; a child generation looks roughly ${age - 35} to ${age - 28}; ` +
        `grandchildren look like young adults. No one of the deceased's own parents' generation is present. ` +
        `Many mourners are old here, but the hall is not uniformly elderly — the younger generations are clearly ` +
        `present among them. `
      : `The deceased is ${age} years old. Every mourner's apparent age must be consistent with that: ` +
        `contemporaries (friends, classmates, colleagues) look about ${age} themselves, ` +
        `a parent generation looks roughly ${age + 28} to ${age + 35}, ` +
        `and any children or younger relatives look correspondingly younger. ` +
        `Do not fill the hall with middle-aged or elderly mourners by default. `
  return (
    refLegend +
    `A 360-degree equirectangular panoramic photograph, seamless horizontal wrap, captured from a single fixed point: ` +
    (customVenue
      ? `standing at the very center of the funeral ceremony this person wished for themselves, between the altar and the mourners — `
      : `standing at the very center of a Korean funeral hall (jangnyesikjang), between the altar and the mourners — `) +
    `the first-person point of view of the deceased person themself, standing at their own funeral. ` +
    whose +
    (age
      ? v !== 'present'
        ? `They lived a full life and died of old age at ${age}. `
        : `They died at the age of ${age}. `
      : '') +
    scaleAndDepth +
    (customVenue
      ? `IN FRONT of the viewer — the center of the panorama — stands the memorial altar of this ceremony: ` +
        (venue.altar
          ? `${venue.altar} ` +
            `Burning incense with thin smoke rising, and the framed portrait at its top. `
          : `tiers banked with white chrysanthemum flowers, burning incense with thin smoke rising, white candles ` +
            `and offerings, arranged to suit this place. `) +
        `The altar stands modestly within the open space, with the venue clearly visible above and around it — ` +
        `it does not reach the top of the frame. `
      : `IN FRONT of the viewer — the center of the panorama — spreads the traditional Korean funeral altar: ` +
        `tiers densely banked with white chrysanthemum flowers, burning incense sticks in a brass censer with thin smoke rising, ` +
        `white candles, offerings of fruit and food, and funeral wreaths (geunjo hwahwan) with black-and-white ribbon banners standing at both sides. ` +
        `The altar sits in a shallow recessed alcove in the far wall, framed by wooden wall panels, with wall and ceiling ` +
        `clearly visible above and around it — it does not reach the top of the frame. ` +
        // 실내 식장 유지 + 희망 힌트(2026-08-04): 배경 합성이 "표준 식장"으로 판정하면 setting은
        // 희망사항을 암시하는 소품 묘사다 — 제단 주변에 얹는다.
        (venue?.setting ? `Honoring the funeral they wished for themselves: ${venue.setting} ` : '')) +
    portrait +
    chiefMourner +
    mourners +
    ageContext +
    // 전신 불변식(2026-08-04) — 장면 파노라마와 동일: 상주·조문객 전원의 전신이 잘리지 않게.
    FULL_BODY_RULE +
    (customVenue
      ? `The far left and far right ends of the panorama — the point directly behind the viewer — meet exactly on a plain, ` +
        `uncluttered stretch of the venue (open ground, a bare wall or empty landscape, with no people and no complex detail ` +
        `crossing that joining line), with the mourners arranged to its left and right, so the wrap is seamless. `
      : `The far left and far right ends of the panorama — the point directly behind the viewer — meet exactly on the plain ` +
        `entrance doorway of the hall (a simple flat wall and door with no people and no complex detail crossing that joining line), ` +
        `with the mourners arranged to its left and right, so the wrap is seamless. `) +
    // 조명(2026-08-03): 레퍼런스대로 밝은 주광의 현대식 식장이되, 마냥 평평하게 밝지 않도록
    // 음영을 남긴다 — 조명 사이 그늘, 구석·복도의 어둠, 인물 발밑 그림자, 은은한 비네트.
    (customVenue
      ? `Natural light true to this place and its weather — soft and subdued, NOT flat or evenly lit: shadow gathers in ` +
        `the recesses of the space, the mourners cast quiet shadows on the ground, and the light falls off gently toward ` +
        `the edges of the frame. Thin incense haze in the air, a subdued and solemn mood. `
      : `Bright, clean daylight-balanced interior lighting of a modern Korean funeral hall — but NOT flat or evenly lit: ` +
        `the recessed ceiling lights pool light unevenly so shadow gathers between them, the corners of the hall, the far ` +
        `corridor and the areas under the cabinetry and chairs fall into soft shade, the mourners cast quiet shadows on the floor, ` +
        `and the light falls off gently toward the edges of the frame. Warm wood tones against muted whites, thin incense haze in the air, ` +
        `a subdued and solemn mood despite the brightness. `) +
    // 고인 부재 지시 보강(2026-08-04): 이전 문구("living body is NOT anywhere")를 모델이
    // "고인을 유령처럼 반투명하게 그리라"로 해석해, 흐릿한 반투명 인물·벗어놓은 신발이 생겼다.
    // 유령·반투명·잔상류를 명시적으로 금지하고, 모든 인물은 불투명한 산 사람뿐이라고 못 박는다.
    `The deceased themself does NOT appear anywhere in the hall — this is their own gaze; their face appears only inside the memorial portrait frame. ` +
    `There are absolutely NO ghosts, NO translucent or semi-transparent figures, NO blurred spectral silhouettes, NO fading apparitions, ` +
    `and no empty shoes or garments standing on the floor by themselves. Every person in the scene is a fully solid, opaque, living mourner. ` +
    `Photorealistic, cinematic, quiet and solemn. No text, no letters, no captions anywhere in the image.`
  )
}

async function readManifest(personaDir) {
  return JSON.parse(await fs.readFile(path.join(personaDir, 'manifest.json'), 'utf-8'))
}
async function writeManifest(personaDir, manifest, onManifest) {
  // read-merge-write(2026-08-05): 이 잡이 도는 동안 다른 잡이 디스크에 더한 키(grave 등)를
  // 지우지 않게, 디스크에만 있는 키를 흡수한 뒤 쓴다(이 잡이 쥔 키는 in-memory가 이긴다).
  try {
    const disk = JSON.parse(await fs.readFile(path.join(personaDir, 'manifest.json'), 'utf-8'))
    for (const k of Object.keys(disk)) if (!(k in manifest)) manifest[k] = disk[k]
  } catch {
    /* 디스크 판 없음/깨짐 — in-memory 그대로 */
  }
  await fs.writeFile(path.join(personaDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  if (onManifest) await onManifest(manifest)
}

/**
 * 장례식 워크플로우 실행 — 2단계, 사이에 연구자 승인이 있다:
 *   stage 'image': Gemini 4:1 파노라마 생성 → status 'review' (admin에 떠서 검토·승인 대기).
 *   stage 'video': 승인(f.approved)된 이미지를 Wan2.2 I2V로 영상화 → status 'done'.
 * 각 단계 완료마다 manifest에 기록·저장하므로 중간에 죽어도 같은 rev를 이어서(resume) 한다.
 *
 * @param {object} p
 * @param {string}   p.personaDir   library/<pid> 절대경로
 * @param {object}   p.gclient      GeminiClient (stage 'image'에서만 필요)
 * @param {object}   p.config       comfyui.json (host·panorama·gemini·funeral 섹션 사용)
 * @param {'image'|'video'} [p.stage]  실행 단계 (기본 'image')
 * @param {'present'|'future'} [p.variant]  어느 장례식인가 (기본 'present' — 지금의 죽음).
 *   'future'는 90세 죽음판으로, manifest.funeralFuture / funeral-future-r<rev>.* 에 따로 쌓인다.
 * @param {object}   [p.doc]        Firestore 문서(본인 입력 데이터) — 있으면 조문객 캐스트를 개인화 합성
 * @param {Buffer}   [p.faceRef]    얼굴 레퍼런스(영정의 주인 — 문맥용, 화면엔 등장 안 함이 원칙)
 * @param {boolean}  [p.force]      [image 단계] 새 rev로 처음부터(재생성, 승인 리셋).
 *                                  [video 단계] 같은 rev의 영상만 재생성(승인 유지, 이전 영상은 videoHistory로)
 * @param {boolean}  [p.pro]        [image 단계] pro 모델로 21:9 생성 후 4:1 중앙 크롭(pro는 4:1 거부)
 * @param {AbortSignal} [p.signal]
 * @param {(msg:string)=>void} [p.log]
 * @param {(m:object)=>void|Promise} [p.onManifest]  manifest 저장마다 호출(Firebase 정본 upsert용)
 * @param {(e:object)=>void} [p.onProgress]  { phase:'image'|'video', ... }
 * @returns {Promise<{ ok:boolean, rev?:number, cancelled?:boolean, error?:string }>}
 */
export async function runFuneralWorkflow({
  personaDir,
  gclient,
  config,
  stage = 'image',
  variant = 'present',
  doc = null,
  branchNarrative = null, // 분기(3차) 장례식: 대화 기반 분기 연대기 — 조문객 캐스트의 노년 근거
  faceRef = null,
  force = false,
  pro = false,
  signal,
  log = () => {},
  onManifest,
  onProgress = () => {}
} = {}) {
  const fcfg = config.funeral || {}
  const vkind = normalizeVariant(variant)
  const mkey = funeralManifestKey(vkind) // 'funeral' | 'funeralFuture'
  const prefix = filePrefix(vkind) // 'funeral' | 'funeral-future'
  const vlabel = funeralVariantLabel(vkind)
  const manifest = await readManifest(personaDir)
  const profile = manifest.profile || {}
  await fs.mkdir(path.join(personaDir, FUNERAL_DIR), { recursive: true })

  let f = manifest[mkey]
  // [image 단계] 새 rev 시작 조건: 없음 | force 재생성 | 완료본에 다시 요청. 그 외(중단·에러·검토 중)는
  // 같은 rev를 이어서 한다. 새 rev는 승인도 리셋된다 — 새 이미지는 다시 검토해야 영상화된다.
  if (stage === 'image' && (!f || force || f.status === 'done')) {
    const rev = (f?.rev || 0) + 1
    f = manifest[mkey] = {
      variant: vkind,
      rev,
      status: 'image',
      error: null,
      approved: false,
      approvedAt: null,
      image: null,
      video: null,
      firebase: null,
      history: [
        ...(f?.history || []),
        {
          rev,
          imageFile: null,
          videoFile: null,
          prompt: null,
          startedAt: new Date().toISOString(),
          doneAt: null,
          status: 'image',
          error: null
        }
      ]
    }
    await writeManifest(personaDir, manifest, onManifest)
  }
  if (!f)
    return {
      ok: false,
      error: `${vlabel} 이미지가 아직 없다 — 먼저 이미지 생성 단계를 실행하라`
    }
  if (!f.variant) f.variant = vkind // 구버전 manifest 정규화(변형 개념 도입 전 = present)
  const rev = f.rev
  const hist = f.history[f.history.length - 1]
  const imageFile = `${FUNERAL_DIR}/${prefix}-r${rev}.png`
  // [video 단계 force] 같은 rev·같은 승인된 이미지로 **영상만** 다시 뽑는다 — 모션 프롬프트나
  // Wan 파라미터를 고쳐가며 반복 튜닝하기 위함(2026-08-03). 이미지 재생성(새 rev·승인 리셋)과
  // 달리 승인은 유지된다(승인 대상은 이미지고, 이미지는 그대로다). 이전 영상은 videoHistory에
  // 남겨 admin에서 다시 볼 수 있고, firebase 기록은 비운다(새 영상은 다시 저장해야 반영).
  if (stage === 'video' && force && f.video) {
    f.videoHistory = [...(f.videoHistory || []), f.video]
    f.videoRev = (f.videoRev || 1) + 1
    f.video = null
    f.firebase = null
    f.status = 'video'
    await writeManifest(personaDir, manifest, onManifest)
  }
  const vk = f.videoRev || 1 // 1 = 구명명(<prefix>-r<rev>.mp4) 유지 — 기존 파일과 호환
  const videoFile =
    vk === 1
      ? `${FUNERAL_DIR}/${prefix}-r${rev}.mp4`
      : `${FUNERAL_DIR}/${prefix}-r${rev}-v${vk}.mp4`
  const setState = async (status, patch = {}) => {
    f.status = status
    Object.assign(f, patch)
    hist.status = status
    if (patch.error !== undefined) hist.error = patch.error
    if (status === 'done') hist.doneAt = new Date().toISOString()
    await writeManifest(personaDir, manifest, onManifest)
  }

  try {
    if (stage === 'image') {
      // ── Gemini 4:1 파노라마 (resume: 같은 rev 이미지가 이미 있으면 검토 대기로만 정규화) ──
      if (!f.image || f.image.file !== imageFile) {
        if (signal?.aborted) return { ok: false, cancelled: true, rev }
        // 개인화 캐스트 — Firebase 본인 입력 데이터(탄생~현 시점)로 조문객 명단·행동을 합성한다.
        // 같은 rev의 재시도(resume)에서 이미 합성돼 있으면 재사용, 실패·데이터 없음이면 null(범용 폴백).
        // rev별 캐스트는 manifest에 남아 영상화(별도 잡)와 admin 표시가 같은 명단을 쓴다.
        const age = resolveDeceasedAge(profile, vkind)
        if (f.cast === undefined || f.cast === null) {
          f.cast = doc
            ? await synthesizeFuneralCast(gclient, doc, {
                age,
                variant: vkind,
                branchNarrative,
                signal,
                log
              })
            : null
          hist.cast = f.cast
          await writeManifest(personaDir, manifest, onManifest)
        }
        // 원하는 장례식(상주·장례 방식·안식처 등) — doc에서 매번 다시 읽는다(결정적이라 캐시 불필요).
        const wishes = doc ? collectFuneralWishes(doc) : null
        // 개인화 배경 — 희망 장례 방식·안식처(funeralMethod/burialSite)에 맞는 장소를 합성한다.
        // 캐스트처럼 rev별 캐시(재시도 시 재사용). 희망 없음/실패 = null → 표준 식장.
        if (f.venue === undefined) {
          f.venue = wishes ? await synthesizeFuneralVenue(gclient, wishes, { signal, log }) : null
          hist.venue = f.venue
          await writeManifest(personaDir, manifest, onManifest)
        }
        // 영정 포트레이트 프리패스(pro) — 원본 사진 대신 정식 영정 포트레이트를 레퍼런스로 실어
        // 파노라마(flash)는 얼굴을 새로 그리지 않고 액자에 배치만 하게 한다(ensureFuneralPortrait 주석).
        const portrait = await ensureFuneralPortrait({
          gclient,
          faceRef,
          profile,
          personaDir,
          model: config.gemini?.model, // pro
          imageSize: fcfg.imageSize || config.gemini?.imageSize || '2K',
          variant: vkind,
          signal,
          log
        })
        if (portrait)
          f.portrait = {
            file: `${FUNERAL_DIR}/${vkind !== 'present' ? 'portrait-future.png' : 'portrait.png'}`
          }
        const sceneRef = portrait || faceRef
        // 레퍼런스는 [영정 포트레이트, 구도 사진] 순서로 싣고, 프롬프트가 그 순서대로 번호를 매겨
        // 역할을 라벨링한다(buildFuneralPrompt 주석) — 순서를 바꾸면 라벨과 어긋난다.
        // 맞춤 장소(실내 식장이 아님)면 실측 실내 식장 360 구도 사진은 싣지 않는다 — 프롬프트의
        // 야외/맞춤 공간 묘사와 정면으로 충돌해 모델이 실내 식장으로 되돌리기 때문.
        const layoutRef =
          f.venue && !f.venue.indoorHall ? null : await loadFuneralLayoutRef(fcfg, log)
        const references = [sceneRef, layoutRef].filter(Boolean)
        const prompt = buildFuneralPrompt(
          profile,
          f.cast,
          Boolean(sceneRef),
          Boolean(layoutRef),
          vkind,
          wishes,
          f.venue
        )
        if (!sceneRef) log(`  [경고] 장례식: 레퍼런스 사진 없음 — 영정 얼굴이 임의로 생성된다`)
        const pano = config.panorama || { width: 4096, height: 1024 }
        // flash — pro는 4:1 거부(기존 파노라마와 동일). 단 pro 요청(admin 'Pro 생성' 버튼)이면
        // pro 모델로 지원 최대폭 21:9를 생성한 뒤 아래에서 4:1 중앙 크롭해 규격을 맞춘다.
        const model = pro ? config.gemini?.model : fcfg.model || config.gemini?.sceneModel
        onProgress({ phase: 'image', variant: vkind })
        log(
          `  [장례식] ${vlabel} 파노라마 생성 (rev ${rev}, ${pano.width}×${pano.height}${pro ? ', pro 21:9→4:1 크롭' : ''})`
        )
        const t0 = Date.now()
        let data = await gclient.generateImage({
          prompt,
          references,
          aspectRatio: pro ? '21:9' : nearestGeminiAspect(pano.width, pano.height), // 4096×1024 → '4:1'
          imageSize: fcfg.imageSize || config.gemini?.imageSize || '2K',
          model,
          signal
        })
        if (pro) data = await cropImageTo41(data)
        await fs.writeFile(path.join(personaDir, imageFile), data)
        hist.imageFile = imageFile
        hist.prompt = prompt
        await setState('review', {
          error: null,
          image: {
            file: imageFile,
            prompt,
            model,
            elapsedMs: Date.now() - t0,
            generatedAt: new Date().toISOString()
          }
        })
        log(
          `  [장례식] ${vlabel} 파노라마 완료 (${((Date.now() - t0) / 1000).toFixed(1)}s) — admin 승인 대기`
        )
      } else if (f.status !== 'review' && !f.video) {
        // 구버전(승인 게이트 이전) manifest 정규화 — 이미지는 있는데 영상 전 단계면 검토 대기로.
        await setState('review', { error: null })
      }
      return { ok: true, rev, stage: 'image', variant: vkind }
    }

    // ── stage 'video': 승인 게이트 — admin 승인(approve) 없이는 영상화하지 않는다 ──
    if (!f.image) throw new Error(`${vlabel} 이미지가 없다 — 먼저 이미지 생성 단계를 실행하라`)
    if (!f.approved) throw new Error('승인되지 않았다 — admin에서 이미지를 승인한 뒤 영상화하라')
    if (!f.video || f.video.file !== videoFile) {
      if (signal?.aborted) return { ok: false, cancelled: true, rev }
      const v = { ...DEFAULT_VIDEO, ...(fcfg.video || {}) }
      onProgress({ phase: 'video', variant: vkind })
      log(`  [장례식] ${vlabel} Wan2.2 영상화 (${v.width}×${v.height}, ${v.length}f)`)
      const client = new ComfyUIClient({
        host: config.host,
        timeoutMs: fcfg.timeoutMs ?? 240000,
        maxWaitMs: fcfg.maxWaitMs ?? 3600000
      })
      try {
        await setState('video')
        const t0 = Date.now()
        const buf = await fs.readFile(path.join(personaDir, f.image.file))
        const uploaded = await client.uploadImage(
          buf,
          `${prefix}-${path.basename(personaDir)}-r${rev}.png`
        )
        const workflow = buildWan22I2VWorkflow({
          // 이미지 생성 때 합성해 둔 캐스트(f.cast)로 조문객별 움직임까지 개인화한다.
          prompt: buildFuneralMotionPrompt(f.cast, fcfg.motionPrompt, vkind),
          startImage: uploaded.name,
          width: v.width,
          height: v.height,
          length: v.length,
          fps: v.fps,
          steps: v.steps,
          boundaryStep: Math.floor(v.steps / 2),
          shift: v.shift,
          filenamePrefix: `chrono-zoetrope/funeral/${prefix}-${path.basename(personaDir)}-r${rev}-v${vk}`
        })
        const { videos } = await client.generateVideo(workflow, {
          onProgress: (e) => onProgress({ phase: 'video', variant: vkind, ...e })
        })
        await fs.writeFile(path.join(personaDir, videoFile), videos[0].data)
        hist.videoFile = videoFile
        await setState('done', {
          error: null,
          video: {
            file: videoFile,
            elapsedMs: Date.now() - t0,
            generatedAt: new Date().toISOString()
          }
        })
        log(
          `  [장례식] ${vlabel} 영상 완료 (${((Date.now() - t0) / 1000).toFixed(1)}s) — Firebase 저장 가능`
        )
      } finally {
        client.close()
      }
    }
    return { ok: true, rev, stage: 'video', variant: vkind }
  } catch (err) {
    if (signal?.aborted) return { ok: false, cancelled: true, rev, variant: vkind }
    await setState('error', { error: String(err.message || err) }).catch(() => {})
    return { ok: false, rev, variant: vkind, error: String(err.message || err) }
  }
}
