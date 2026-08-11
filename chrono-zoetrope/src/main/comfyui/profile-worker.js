// 제출된 프로필 하나를 생애 라이브러리로 생성하는 공유 워커 로직.
// generate-from-firestore.mjs(CLI 워커)와 admin-server.mjs(자동 큐)가 함께 쓴다.
//
// 흐름: claimProfile(원자적 submitted→generating) → 레퍼런스 사진 다운로드
//       → generateLifeLibrary(ComfyUI 전체 생성) → status done|error 마감.
//
// 예외를 던지지 않고 결과 객체로 반환한다 — 호출부(직렬 큐 루프)를 단순하게 유지하기 위함.

import fs from 'node:fs/promises'
import path from 'node:path'
import { generateLifeLibrary } from './life-library.js'
import { composeScenePromptFor, buildScenePlan } from './prompt-builder.js'
import { selectSceneReference } from './face-anchor.js'
import { prepareAgedAnchors } from './aged-anchor.js'
import {
  buildReelPhotoPlan,
  generateReelPhotos,
  REEL_VARIANTS,
  reelVariantLabel
} from './reel-photos.js'
import { uploadFutureLifeJourney } from './future-journey.js'
import {
  buildLifeGraphPlan,
  buildBranchedPlan,
  collectSessionPhotoURLs,
  collectStagePhotoURLs,
  synthesizeAgeScenes,
  synthesizeBranchedScenes,
  extrapolationAges,
  buildFutureNarrativePrompt,
  branchedAges,
  buildBranchedNarrativePrompt
} from './life-graph-plan.js'
import { GeminiClient, resolveGeminiApiKey } from './gemini-client.js'
import { runFuneralWorkflow, FUNERAL_VARIANTS, funeralVariantLabel } from './funeral.js'
import { runGraveWorkflow } from './grave.js'
import {
  claimProfile,
  downloadPhotos,
  toGeneratorProfile,
  setProfileStatus,
  claimLifeGraphSession,
  setLifeGraphSessionStatus,
  upsertPersonaManifest,
  upsertPersonaScenePlan,
  upsertExtrapolationRecord,
  uploadPersonaPanoramas,
  uploadPersonaReelPhotos,
  fetchGhostTranscript,
  updateProfileFields
} from './firestore-source.js'

const noop = () => {}

// 완료된 라이브러리의 파노라마 이미지를 Firebase Storage(generatedPanoramaImages)에 올린다 — 다른
// 머신에서 admin 검토 시 hydrate(ensurePersonaMediaFromFirebase)로 이미지를 받아올 수 있게 한다.
// manifest(프롬프트·장면)는 이미 onManifest로 정본화됐고 여기선 이미지 바이트만. best-effort —
// 업로드가 실패해도 생성 완료 자체는 유지한다(로컬엔 이미 다 있다).
async function uploadPanoramasBestEffort(pid, outDir, manifest, log) {
  try {
    const r = await uploadPersonaPanoramas({
      profile: manifest.profile,
      personaId: pid,
      dir: path.join(outDir, pid),
      images: manifest.images
    })
    log(`  [Firebase] 파노라마 ${r.count}장 업로드`)
  } catch (err) {
    log(`  [경고] 파노라마 Firebase 업로드 실패(무시): ${err.message}`)
  }
}

// reel 전용 3:4 사진 12장 — 파노라마보다 먼저 도는 두 번째 생성 플로우(reel-photos.js).
// 두 흐름(occupation·life-graph)이 공유한다. best-effort: 전면 실패해도 파노라마 생성은 계속하고
// (§ reel은 별도 산출물), 진행분은 manifest에 남아 재실행 시 이어진다(resume).
// 성공분은 곧바로 Firebase 정본(generatedReelImage)에 올린다 — 실패는 무시.
//
// 판(variant)마다 따로 돈다: 'past'(3~현재, 1차 주마등) / 'future'(현재 다음 해~90세, 2차 미래 주마등).
async function generateReelPhotosBestEffort({
  profile,
  personaDir,
  pid,
  config,
  gclient,
  faceRef,
  stageRefFor = null,
  ageScenes = null,
  variant = 'past',
  signal,
  log
}) {
  if (signal?.aborted) return
  const label = reelVariantLabel(variant)
  try {
    const reelPlan = buildReelPhotoPlan(profile, {
      ...(config.reelPhotos || {}),
      variant,
      ageScenes
    })
    if (reelPlan.length === 0) {
      log(`  [릴] ${label} 사진: 만들 나이가 없다 — 건너뜀`) // 이미 90세를 넘긴 참가자 등
      return
    }
    const r = await generateReelPhotos({
      plan: reelPlan,
      profile,
      personaDir,
      gclient,
      model: config.gemini.model, // pro — 일반 비율 지원
      imageSize: config.gemini.imageSize,
      aspectRatio: config.reelPhotos?.aspectRatio, // 미지정이면 기본 4:3(가로형)
      concurrency: config.reelPhotos?.concurrency, // Gemini API 병렬 호출 수(미지정이면 기본 3)
      faceRef,
      // 미래 릴엔 "그 순간의 실제 사진"이 있을 수 없다 — 얼굴 앵커로 그 나이만큼 늙힌다.
      stageRefFor: variant === 'future' ? null : stageRefFor,
      retries: config.sceneRetries,
      variant,
      signal,
      log,
      onManifest: (m) => upsertPersonaManifest(m)
    })
    log(
      `  [릴] ${label} 사진 ${r.okCount}/${reelPlan.length}장${r.failedCount ? ` (실패 ${r.failedCount})` : ''}${r.cancelled ? ' — 중지됨' : ''}`
    )
    if (r.okCount) {
      try {
        const up = await uploadPersonaReelPhotos({
          profile,
          personaId: pid,
          dir: personaDir,
          reelPhotos: r.reelPhotos,
          variant
        })
        log(`  [Firebase] ${label} 사진 ${up.count}장 업로드`)
      } catch (err) {
        log(`  [경고] ${label} 사진 Firebase 업로드 실패(무시): ${err.message}`)
      }
      // 미래 릴(2차 future=부정미래 / 3차 branched=긍정미래)은 노출용 요약 정본
      // (futureLifeJourneyGraph — 이미지 URL + 한국어 title·30자 설명)도 함께 올린다. best-effort.
      if (variant === 'future' || variant === 'branched') {
        try {
          await uploadFutureLifeJourney({
            profile,
            personaId: pid,
            dir: personaDir,
            reelPhotos: r.reelPhotos,
            gclient,
            variant,
            log
          })
        } catch (err) {
          log(`  [경고] ${label} 인생그래프 요약 업로드 실패(무시): ${err.message}`)
        }
      }
    }
  } catch (err) {
    log(`  [경고] ${label} 사진 생성 실패(파노라마는 계속): ${err.message}`)
  }
}

// 장례식 파노라마 — 파노라마 라이브러리 완료 뒤 도는 best-effort 단계(funeral.js).
// 워커는 **이미지 단계까지만** 자동 생성한다: Gemini 4:1(고인 시선의 한국식 장례식장) → admin
// 검토 대기(review). 영상화(Wan2.2)는 admin에서 이미지를 승인한 뒤 버튼으로만 시작된다.
// 두 벌(present=지금의 죽음 / future=90세의 죽음)을 차례로 만든다 — 하나가 실패해도 다른 하나는
// 시도한다(둘은 독립된 산출물이고, 재생성도 admin에서 판별로 따로 누른다).
// 실패해도 생성 완료 자체는 유지 — admin의 장례식 패널에서 재생성한다.
async function generateFuneralBestEffort({
  personaDir,
  config,
  gclient,
  doc,
  faceRef,
  signal,
  log
}) {
  if (config.funeral?.enabled === false) return
  for (const variant of FUNERAL_VARIANTS) {
    if (signal?.aborted) return
    const label = funeralVariantLabel(variant)
    try {
      const r = await runFuneralWorkflow({
        personaDir,
        gclient,
        config,
        stage: 'image',
        variant,
        doc, // Firestore 문서(본인 입력 데이터) — 조문객 캐스트 개인화 재료
        faceRef: faceRef?.buffer || null,
        signal,
        log,
        onManifest: (m) => upsertPersonaManifest(m)
      })
      if (r.ok) log(`  [장례식] ${label} 이미지 완료 (rev ${r.rev}) — admin 승인 후 영상화`)
      else if (!r.cancelled)
        log(`  [경고] ${label} 이미지 실패(무시 — admin에서 재생성): ${r.error}`)
    } catch (err) {
      log(`  [경고] ${label} 이미지 실패(무시 — admin에서 재생성): ${err.message}`)
    }
  }
}

// 장면별 레퍼런스·프롬프트 접두어 규칙은 face-anchor.js(selectSceneReference)에 단일 정의한다 —
// 재생성(admin-server)이 같은 규칙을 재사용해 "프롬프트는 첨부를 쓰라는데 첨부가 없는" 불일치를
// 막는다. 장면 프롬프트 함수(§12로 튜닝됨)는 건드리지 않고 접두어만 앞에 얹는다.

/**
 * 프로필 한 건 처리.
 * @param {object} profile  Firestore 문서 ({ id, name, photoURLs, ... })
 * @param {object} opts
 * @param {object} opts.config              comfyui.json 설정
 * @param {string} opts.outDir              라이브러리 출력 루트 (절대경로)
 * @param {boolean} [opts.includeErrors]    error 상태도 재시도 대상에 포함
 * @param {(msg:string)=>void} [opts.log]
 * @param {(e:object)=>void} [opts.onProgress]  generateLifeLibrary 진행 이벤트 패스스루
 * @returns {Promise<{claimed:boolean, ok:boolean, imageCount?:number, elapsedMs?:number, error?:string}>}
 */
export async function processProfile(
  profile,
  { config, outDir, includeErrors = false, signal, log = noop, onProgress = noop } = {}
) {
  const pid = profile.id
  const label = `${profile.name || '?'} (${pid})`

  const claimed = await claimProfile(pid, { includeErrors })
  if (!claimed) {
    log(`건너뜀 (이미 처리 중/완료): ${label}`)
    return { claimed: false, ok: false }
  }
  log(`[시작] 생성: ${label}`)

  try {
    // 1) 레퍼런스 사진을 로컬로 내려받기
    const inputDir = path.join(outDir, pid, '_input')
    const photoPaths = await downloadPhotos(profile, inputDir)
    log(`  사진 ${photoPaths.length}장 다운로드`)

    // 2) 생애 라이브러리 생성 (10단계 × perStage)
    const genProfile = toGeneratorProfile(profile, photoPaths)
    // 모든 장면을 실제 얼굴에 앵커링한다: 성인 나이는 현재 얼굴 사진을 레퍼런스로 실어 같은 인물로
    // 렌더하고 그 나이로 변환(과거=젊게, 미래=늙게). 아동 나이는 성인 얼굴을 de-age하면 IMAGE_SAFETY에
    // 걸리는데 occupation 스키마엔 그 시절 실제 사진이 없으므로 앵커 없이 텍스트로 둔다(face-anchor.js 규칙).
    // 재생성이 같은 사진을 다시 실을 수 있게 얼굴 앵커의 상대경로(라이브러리/pid 기준)를 manifest에 기록한다.
    const personaDir = path.join(outDir, pid)
    const faceAnchor = photoPaths.length ? await fs.readFile(photoPaths[0]) : null
    const faceRef = faceAnchor
      ? { buffer: faceAnchor, path: path.relative(personaDir, photoPaths[0]) }
      : null
    // pro 모델 클라이언트 — reel 사진(3:4)과 aged 앵커 포트레이트(3:4)가 공유한다.
    const proGclient = new GeminiClient({
      apiKey: await resolveGeminiApiKey(config.gemini),
      model: config.gemini.model, // pro — 3:4 포트레이트라 파노라마 4:1 제약을 받지 않는다
      textModel: config.gemini.textModel,
      timeoutMs: config.timeoutMs
    })

    // 2.4) reel 전용 3:4 사진 — 파노라마보다 먼저(관람 순서상 reel이 먼저 보인다). best-effort.
    await generateReelPhotosBestEffort({
      profile: genProfile,
      personaDir,
      pid,
      config,
      gclient: proGclient,
      faceRef,
      signal,
      log
    })

    // 2단계 aged 앵커 프리패스 — 파노라마(flash)가 얼굴을 aging하지 않도록, 성인 나이의 '그 나이 얼굴'을
    // pro로 미리 크게 뽑아 캐시한다(_aged/{age}.png). 아래 selectFor(referencesFor·promptFor)가 이 맵을
    // 조회해, 준비된 나이는 KEEP_FACE로 얼굴을 유지만 시킨다. occupation은 스테이지 사진이 없어 모든 성인
    // 나이가 aging 대상(needsAged: 항상 true). 플랜을 여기서 결정론적으로 확정해 그대로 넘긴다(내부 재빌드와 동일).
    const plan = buildScenePlan(genProfile, { perStage: config.perStage })
    const agedByAge = await prepareAgedAnchors({
      gclient: faceRef ? proGclient : null,
      faceRef,
      profile: genProfile, // gender 알면 포트레이트 명사에 반영(없으면 중립 — 얼굴 참조가 실제 성별을 이끈다)
      plan,
      personaDir,
      model: config.gemini.model,
      imageSize: config.gemini.imageSize,
      signal,
      log,
      needsAged: () => true
    })
    const agedRefFor = (age) => agedByAge.get(age) || null
    const selectFor = (item) => selectSceneReference(item, { faceRef, agedRefFor })
    const t0 = Date.now()
    const result = await generateLifeLibrary(genProfile, {
      host: config.host,
      outDir,
      workflow: config.workflow,
      perStage: config.perStage,
      plan, // 위에서 확정한 플랜(aged 프리패스와 동일 플랜을 생성 루프도 쓰게)
      image: config.image,
      panorama: config.panorama, // seamfix(B안) 파노라마 크기 override (없으면 2048×1024 기본)
      seamfix: config.seamfix, // 이음매 밴드 폭/페더 (없으면 workflow 기본 256/96)
      timeoutMs: config.timeoutMs,
      sceneRetries: config.sceneRetries, // 장면 실패 시 재시도 횟수 (undefined면 기본 1)
      sceneConcurrency: config.sceneConcurrency, // Gemini 장면 동시 생성 수 (undefined면 기본 3)
      signal, // 중지 버튼 신호
      gemini: config.gemini, // 호출자가 resolveGeminiConfig로 apiKeyPath를 절대경로화해서 넘긴다
      // 얼굴 앵커: 레퍼런스 이미지·나이 변환 접두어·기록용 메타를 한 규칙(selectFor)에서 뽑는다.
      referencesFor: (item) => {
        const r = selectFor(item).reference
        return r ? [r.buffer] : []
      },
      promptFor: (p, item) =>
        selectFor(item).prefix + composeScenePromptFor(config.workflow, p, item),
      referenceMetaFor: (item) => {
        const s = selectFor(item)
        return s.reference ? { file: s.reference.path, kind: s.kind } : null
      },
      // 장면이 기록될 때마다 Firebase 정본(personaManifests)에 upsert → 원격 뷰어가 생성 중인
      // 장면 목록을 실시간으로 받아본다(이미지 바이트는 올리지 않음 — manifest만).
      onManifest: (m) => upsertPersonaManifest(m),
      onProgress
    })
    const elapsedMs = Date.now() - t0
    const all = result.manifest.images
    const imageCount = all.filter((im) => !im.failed).length // 성공 장면만 카운트
    const failedCount = all.length - imageCount

    // 사용자 중지 → 실패가 아니라 재개 가능하도록 submitted로 되돌린다(진행분은 남아 resume).
    if (signal?.aborted) {
      await setProfileStatus(pid, 'submitted', { error: null }).catch(() => {})
      log(`[일시정지] 중지됨: ${label} — ${imageCount}장까지 생성(재개 가능)`)
      return { claimed: true, ok: false, cancelled: true, imageCount }
    }

    // 한 장도 못 만들었으면(전면 장애) 완료가 아니라 실패로 — 재시도 대상이 되게 한다.
    if (imageCount === 0) throw new Error(`전 장면 생성 실패 (${failedCount}장 모두 실패)`)

    // 3) 완료 기록. 검토(admin)는 별개 — 여기서는 생성 완료까지만 책임진다.
    // 자동 감지된 성별도 역기록해, 이후 재생성 시 재감지 없이 프로필 값을 쓰게 한다.
    const detectedGender = result.manifest?.profile?.gender
    await setProfileStatus(pid, 'done', {
      libraryDir: `library/${pid}`,
      imageCount,
      failedCount, // 건너뛴 장면 수 — admin에서 개별 재생성 대상
      generatedAt: new Date().toISOString(),
      ...(detectedGender ? { gender: detectedGender } : {})
    })
    log(
      `[완료] ${label} — ${imageCount}장${failedCount ? ` (실패 ${failedCount}장 건너뜀 — admin 재생성)` : ''} (${(elapsedMs / 1000).toFixed(1)}s)`
    )
    await uploadPanoramasBestEffort(pid, outDir, result.manifest, log)
    // 장례식 파노라마+영상 — 라이브러리 완료 후 best-effort (실패해도 완료 유지, admin 재생성).
    await generateFuneralBestEffort({
      personaDir,
      config,
      gclient: proGclient,
      doc: profile, // Firestore 문서 — 세션 텍스트·occupation이 캐스트 개인화 재료
      faceRef,
      signal,
      log
    })
    return { claimed: true, ok: true, imageCount, failedCount, elapsedMs }
  } catch (err) {
    log(`[실패] ${label} — ${err.message}`)
    await setProfileStatus(pid, 'error', { error: String(err.message || err) }).catch(() => {})
    return { claimed: true, ok: false, error: String(err.message || err) }
  }
}

/**
 * cdb-crafter(인생그래프 앱) 세션 하나 처리. processProfile과 같은 generateLifeLibrary를
 * 그대로 쓴다(레퍼런스 사진 다운로드·성별 자동감지·재시도·재개까지 전부 동일 코드 경로) —
 * 다른 건 (1) occupation 대신 실제 인생그래프에서 뽑은 plan/prompt를 넘기는 것,
 * (2) 라이브러리 폴더명을 personaId() 해시 대신 crafter가 준 id로 고정하는 것뿐.
 * @param {object} profile     Firestore 문서 ({ id, name, birthDate, age, first/second/third, ... })
 * @param {string} sessionKey  'first' | 'second' | 'third'
 * @param {object} opts        { config, outDir, signal, log, onProgress } — config는 comfyui.json
 */
export async function processLifeGraphSession(
  profile,
  sessionKey,
  { config, outDir, signal, log = noop, onProgress = noop } = {}
) {
  const pid = profile.id
  const label = `${profile.name || '?'} (${pid}) · ${sessionKey}`

  const claimed = await claimLifeGraphSession(pid, sessionKey)
  if (!claimed) {
    log(`건너뜀 (이미 처리 중/완료): ${label}`)
    return { claimed: false, ok: false }
  }
  log(`[시작] 생성: ${label}`)

  try {
    const sessionPoints = profile[sessionKey] || {}

    // 1) 레퍼런스 사진 — occupation 플로우와 완전히 같은 downloadPhotos를 쓴다. crafter 문서엔
    // occupation 플로우의 top-level photoURLs가 없으니, 이 세션의 과거~현재 점 중 사진이
    // 붙은 걸 하나 골라 downloadPhotos가 기대하는 { id, photoURLs } 모양으로 맞춰 넘긴다.
    // 사진이 하나도 없으면(아직 아무 점에도 사진을 안 올렸으면) downloadPhotos가 바로
    // 에러를 던진다 — seamfix는 레퍼런스 사진이 필수라 여기서 감싸지 않고 그대로 실패시킨다.
    const photoURLs = collectSessionPhotoURLs(sessionPoints, profile)
    const inputDir = path.join(outDir, pid, '_input')
    const photoPaths = await downloadPhotos({ id: pid, photoURLs }, inputDir)
    log(`  사진 ${photoPaths.length}장 다운로드`)

    // 1.5) 단계별 사진 — 위 1)은 성별감지용 대표 사진 1장뿐이지만, 과거~현재는 각 단계마다
    // 다른 사진이 붙어있을 수 있다. 그 단계 생성에 "그 순간의 실제 사진"을 레퍼런스로 실어
    // 보내려고 전부 따로 내려받는다(없는 단계는 자연히 빠짐 — 미래는 애초에 사진이 없음).
    const stagePhotoURLs = collectStagePhotoURLs(sessionPoints, profile)
    const stageIds = Object.keys(stagePhotoURLs)
    const stagePhotoLocalPaths =
      stageIds.length > 0
        ? await downloadPhotos(
            { id: pid, photoURLs: stageIds.map((id) => stagePhotoURLs[id]) },
            path.join(outDir, pid, '_stage-photos')
          )
        : []
    const stagePhotoBuffers = {}
    for (let i = 0; i < stageIds.length; i++) {
      stagePhotoBuffers[stageIds[i]] = await fs.readFile(stagePhotoLocalPaths[i])
    }
    if (stageIds.length > 0)
      log(`  단계별 사진 ${stageIds.length}장 다운로드 (${stageIds.join(', ')})`)

    // 얼굴 앵커 = 가장 최근(현재)에 가까운 제출 사진(collectSessionPhotoURLs가 최신 과거부터 고른다).
    // 그 순간 실제 사진이 없는 장면에서 이 얼굴로 정체성을 이어 그 나이로 변환한다(face-anchor.js 규칙).
    // 재생성이 같은 사진을 다시 실을 수 있게 상대경로(라이브러리/pid 기준)를 함께 들고 다닌다.
    const personaDir = path.join(outDir, pid)
    const faceAnchor = photoPaths.length ? await fs.readFile(photoPaths[0]) : null
    const faceRef = faceAnchor
      ? { buffer: faceAnchor, path: path.relative(personaDir, photoPaths[0]) }
      : null
    const stageRelPathById = {}
    stageIds.forEach((sid, idx) => {
      stageRelPathById[sid] = path.relative(personaDir, stagePhotoLocalPaths[idx])
    })
    // 그 순간의 실제 스테이지 사진(있으면). selectFor(아래)와 aged 프리패스의 needsAged가 공유한다 —
    // 스테이지 사진이 있는 나이는 그 실제 얼굴·장소를 앵커로 쓰므로 aging(aged 포트레이트)이 불필요하다.
    const stageRefFor = (item) =>
      item.stageId && stagePhotoBuffers[item.stageId]
        ? { buffer: stagePhotoBuffers[item.stageId], path: stageRelPathById[item.stageId] }
        : null

    // 1.8) 1차 합성 — 세션의 7단계 text 전체를 한 번에 LLM에 넣어, 옛 occupation 플로우의
    // crafter STAGE_MAX_AGES 격자 + 2세(life-graph-plan.js AGE_TO_STAGE, 16개 나이마다 장면 후보 2개)로 이 사람 고유의
    // 장면 데이터를 만든다. 텍스트가 없는 단계는 life-graph-plan.js가 옛 STAGES 후보 풀로 폴백한다.
    const synthClient = new GeminiClient({
      apiKey: await resolveGeminiApiKey(config.gemini),
      textModel: config.gemini?.textModel,
      timeoutMs: config.timeoutMs
    })
    const synthTrace = {} // 합성 과정 기록(연대기·실제 장면 프롬프트) — 외삽 기록에 담는다
    const ageScenes = await synthesizeAgeScenes(synthClient, profile, sessionPoints, {
      trace: synthTrace
    })
    log(`  나이별 장면 합성 완료: ${Object.keys(ageScenes).length}개 나이 (LLM), 나머지는 폴백`)

    // 2차(운명) 외삽 기록 — 연대기·프롬프트·결과 장면을 Firebase에 남긴다(3차 분기와 비교용).
    {
      const futureAges = extrapolationAges(profile, sessionPoints)
      if (synthTrace.futureScenePrompt)
        await saveExtrapolationRecord(
          profile,
          pid,
          'future',
          {
            ages: futureAges,
            narrative: synthTrace.futureNarrative || null,
            narrativePrompt: buildFutureNarrativePrompt(profile, sessionPoints, futureAges),
            scenePrompt: synthTrace.futureScenePrompt,
            scenes: Object.fromEntries(
              futureAges.filter((a) => ageScenes[a]).map((a) => [a, ageScenes[a]])
            )
          },
          log
        )
    }

    // pro 모델 클라이언트 — reel 사진(3:4)과 aged 앵커 포트레이트(3:4)가 공유한다.
    const proGclient = new GeminiClient({
      apiKey: await resolveGeminiApiKey(config.gemini),
      model: config.gemini.model, // pro — 3:4 포트레이트라 파노라마 4:1 제약을 받지 않는다
      textModel: config.gemini.textModel,
      timeoutMs: config.timeoutMs
    })

    // 1.85) reel 전용 3:4 사진 — 파노라마보다 먼저(관람 순서상 reel이 먼저 보인다). best-effort.
    // 그 단계의 실제 제출 사진(stageRefFor)이 있으면 그걸 최우선 앵커로 쓴다(아동 나이 커버).
    // 두 벌을 차례로 — 과거 릴(1차 주마등)과 미래 릴(2차 미래 주마등). 하나가 실패해도 다른 하나는 시도한다.
    for (const reelVariant of REEL_VARIANTS) {
      await generateReelPhotosBestEffort({
        profile,
        personaDir,
        pid,
        config,
        gclient: proGclient,
        faceRef,
        stageRefFor,
        ageScenes,
        variant: reelVariant,
        signal,
        log
      })
    }

    // 1.9) 2단계 aged 앵커 프리패스 — 스테이지 실제 사진이 없는 성인 나이만 aging 대상(있는 나이는 그
    // 사진을 앵커로 씀). 그 나이의 '그 나이 얼굴'을 pro로 미리 뽑아 _aged/{age}.png에 캐시하고, 아래
    // selectFor가 조회한다. 플랜을 여기서 확정해(ageScenes 필요) 프리패스와 생성 루프가 같은 플랜을 쓴다.
    const lifePlan = buildLifeGraphPlan(profile, sessionPoints, ageScenes) // 16개 나이 × 2장 = 32장

    // 확정된 32장면의 묘사를 Firebase('panoramaPrompts')에 먼저 남긴다 — 이미지가 나오기 전에
    // 무엇이 그려질 예정인지 확인·검토할 수 있게. best-effort(실패해도 생성은 계속).
    try {
      const sp = await upsertPersonaScenePlan({
        profile,
        personaId: pid,
        plan: lifePlan,
        sessionKey
      })
      log(`  [Firebase] 장면 플랜 ${sp.count}개 Firebase 기록 ('panoramaPrompts'/${sp.key})`)
    } catch (err) {
      log(`  [경고] 장면 플랜 Firebase 기록 실패(무시): ${err.message}`)
    }

    const agedByAge = await prepareAgedAnchors({
      gclient: faceRef ? proGclient : null,
      faceRef,
      profile, // Firestore 문서 — gender 있으면 포트레이트 명사에 반영(없으면 중립, 얼굴 참조가 실제 성별을 이끈다)
      plan: lifePlan,
      personaDir,
      model: config.gemini.model,
      imageSize: config.gemini.imageSize,
      signal,
      log,
      needsAged: (item) => !stageRefFor(item)
    })
    const agedRefFor = (age) => agedByAge.get(age) || null
    const selectFor = (item) =>
      selectSceneReference(item, { stageRef: stageRefFor(item), faceRef, agedRefFor })

    // 2) 생애 라이브러리 생성 — occupation 템플릿(buildScenePlan) 대신 이 세션의 실제 장면 plan을
    // 넘긴다. 프롬프트는 occupation과 동일하게 config.workflow(현재 equirect=김주만 gaze 구조)를
    // 따르는 composeScenePromptFor를 쓴다 — 두 흐름을 같은 구조로 통일(2026-07-22). Gemini/ComfyUI
    // 호출부(retry·resume·manifest 기록)는 generateLifeLibrary 내부 코드 그대로 — 안 건드림.
    const t0 = Date.now()
    const result = await generateLifeLibrary(
      { name: profile.name, birthDate: profile.birthDate, photos: photoPaths },
      {
        host: config.host,
        outDir,
        workflow: config.workflow, // occupation과 동일 — equirect(gaze)로 통일. config가 유일 소스.
        panorama: config.panorama,
        seamfix: config.seamfix,
        timeoutMs: config.timeoutMs,
        sceneRetries: config.sceneRetries,
        sceneConcurrency: config.sceneConcurrency, // Gemini 장면 동시 생성 수 (undefined면 기본 3)
        signal,
        gemini: config.gemini,
        pid,
        plan: lifePlan, // 위 1.9)에서 확정(aged 프리패스와 동일 플랜)
        // 장면별 레퍼런스·프롬프트·기록 메타를 한 규칙(selectFor=face-anchor.js)에서 뽑는다:
        //  (1) 그 순간의 실제 제출 사진이 있으면 그걸(실제 얼굴·장소 보존, 과거·아동 커버),
        //  (2) 없고 성인 나이면 현재 얼굴 앵커로 그 나이 변환(과거=젊게, 미래=늙게),
        //  (3) 없고 아동 나이면 앵커 없이 텍스트로(성인→아동 de-age 세이프티 회피).
        promptFor: (p, item) =>
          selectFor(item).prefix + composeScenePromptFor(config.workflow, p, item),
        referencesFor: (item) => {
          const r = selectFor(item).reference
          return r ? [r.buffer] : []
        },
        referenceMetaFor: (item) => {
          const s = selectFor(item)
          return s.reference ? { file: s.reference.path, kind: s.kind } : null
        },
        skipSeamfix: config.lifeGraphSkipSeamfix, // 테스트 단계: true면 ComfyUI 이음매 보정은 나중으로 미룸
        // occupation 경로와 동일 — 장면마다 Firebase 정본 manifest upsert(실시간 원격 보기).
        onManifest: (m) => upsertPersonaManifest(m),
        onProgress
      }
    )
    const elapsedMs = Date.now() - t0
    const all = result.manifest.images
    const imageCount = all.filter((im) => !im.failed).length
    const failedCount = all.length - imageCount

    if (signal?.aborted) {
      await setLifeGraphSessionStatus(pid, sessionKey, 'submitted', {
        [`${sessionKey}Error`]: null
      }).catch(() => {})
      log(`[일시정지] 중지됨: ${label} — ${imageCount}장까지 생성(재개 가능)`)
      return { claimed: true, ok: false, cancelled: true, imageCount }
    }

    if (imageCount === 0) throw new Error(`전 장면 생성 실패 (${failedCount}장 모두 실패)`)

    // 부가 필드는 세션별로 namespace한다 — 문서 하나에 세션이 최대 3개라 firstImageCount처럼
    // 접두어 없이 두면 second/third 결과가 서로 덮어쓴다.
    await setLifeGraphSessionStatus(pid, sessionKey, 'done', {
      [`${sessionKey}LibraryDir`]: `library/${pid}`,
      [`${sessionKey}ImageCount`]: imageCount,
      [`${sessionKey}FailedCount`]: failedCount,
      [`${sessionKey}GeneratedAt`]: new Date().toISOString()
    })
    log(
      `[완료] ${label} — ${imageCount}장${failedCount ? ` (실패 ${failedCount}장 건너뜀 — admin 재생성)` : ''} (${(elapsedMs / 1000).toFixed(1)}s)`
    )
    await uploadPanoramasBestEffort(pid, outDir, result.manifest, log)
    // 장례식 파노라마+영상 — 라이브러리 완료 후 best-effort (실패해도 완료 유지, admin 재생성).
    await generateFuneralBestEffort({
      personaDir,
      config,
      gclient: proGclient,
      doc: profile, // Firestore 문서 — 세션 텍스트·occupation이 캐스트 개인화 재료
      faceRef,
      signal,
      log
    })
    return { claimed: true, ok: true, imageCount, failedCount, elapsedMs }
  } catch (err) {
    log(`[실패] ${label} — ${err.message}`)
    await setLifeGraphSessionStatus(pid, sessionKey, 'error', {
      [`${sessionKey}Error`]: String(err.message || err)
    }).catch(() => {})
    return { claimed: true, ok: false, error: String(err.message || err) }
  }
}

// 외삽 기록 — 어떤 연대기·프롬프트로 어떤 미래 장면이 나왔는지 Firebase('extrapolationRecords')에
// 남긴다(kind: 'future'=2차 운명 외삽, 'branched'=3차 분기 외삽). 콘솔에서 같은 사람의 두 문서를
// 나란히 열면 두 미래가 무엇이 어떻게 다른지 비교된다. best-effort — 실패해도 생성은 계속된다.
async function saveExtrapolationRecord(profile, personaId, kind, record, log = noop) {
  try {
    const { key } = await upsertExtrapolationRecord({ profile, personaId, kind, record })
    log(`  [Firebase] 외삽 기록 저장: extrapolationRecords/${key}`)
  } catch (err) {
    log(`  [경고] 외삽 기록 저장 실패(무시): ${err.message}`)
  }
}

/**
 * 3차 플로우(분기 미래) 생성 — 1·2차 라이브러리가 이미 있는 참가자에 대해, 유령 대화 기록
 * (ghostTranscripts)을 재료로 "체험으로 마음가짐이 바뀌어 다른 삶을 살았을 때"의 미래를
 * 현 시점→90세로 외삽해 덧생성한다. 산출물:
 *   - manifest.images에 alt-<나이>-<n> 파노라마(branch:true) 합류 — 기존 영상화(clips)·업로드·
 *     재생성 기계가 그대로 먹는다(1·2차 재생목록·카탈로그는 branch 플래그로 거른다).
 *   - manifest.reelPhotosBranched (_reel-branched/) — 3차 릴 필름스트립.
 *   - manifest.funeralBranched — 분기 장례식(90세) 이미지(승인 후 admin에서 영상화).
 * 전제: library/<pid>/manifest.json과 _input 레퍼런스 사진이 로컬에 있어야 한다(1·2차 생성 완료
 * 또는 hydrate). 대화 기록이 없으면 시작하지 않는다 — 3차의 재료가 없다.
 * @param {object} profile  Firestore 문서 ({ id, name, birthDate, age, first/second/third, ... })
 * @param {object} opts     { config, outDir, signal, log, onProgress }
 */
export async function processBranchedFuture(
  profile,
  { config, outDir, signal, log = noop, onProgress = noop } = {}
) {
  const pid = profile.id
  const label = `${profile.name || '?'} (${pid}) · 분기 미래(3차)`
  const personaDir = path.join(outDir, pid)
  await updateProfileFields(pid, { branchedStatus: 'generating', branchedError: null }).catch(
    () => {}
  )
  try {
    // 0) 재료 — 유령 대화 기록. 없으면 3차를 만들 근거가 없다.
    const transcript = await fetchGhostTranscript(profile)
    if (!transcript?.turns?.length)
      throw new Error('유령 대화 기록(ghostTranscripts)이 없다 — 1·2차 체험 후에 생성할 수 있다')
    log(`[시작] ${label} — 대화 ${transcript.turns.length}턴 기반 외삽`)

    // 기존 라이브러리 — 1·2차 32장이 이미 있어야 한다(그 위에 alt 장면을 덧생성·resume).
    const manifestPath = path.join(personaDir, 'manifest.json')
    let manifest
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    } catch {
      throw new Error(`라이브러리가 없다: ${manifestPath} — 1·2차 생성(또는 hydrate)이 먼저다`)
    }

    // 1) 합성 — 최신 세션 점들(과거 사실의 연속성)+대화 기록 → 분기 미래 장면.
    const sessionKey =
      ['third', 'second', 'first'].find((k) => profile[k] && Object.keys(profile[k]).length) || null
    const sessionPoints = sessionKey ? profile[sessionKey] : {}
    const synthClient = new GeminiClient({
      apiKey: await resolveGeminiApiKey(config.gemini),
      textModel: config.gemini?.textModel,
      timeoutMs: config.timeoutMs
    })
    const synthTrace = {} // 합성 과정 기록(연대기·실제 장면 프롬프트) — 외삽 기록에 담는다
    const branchedScenes = await synthesizeBranchedScenes(
      synthClient,
      profile,
      sessionPoints,
      transcript.turns,
      { trace: synthTrace }
    )
    if (!Object.keys(branchedScenes).length)
      throw new Error('분기 장면 합성 결과가 비었다 — 현재 나이를 구할 수 없거나 대화가 빈약함')
    const branchedPlan = buildBranchedPlan(profile, branchedScenes)
    log(
      `  분기 장면 합성 완료: ${Object.keys(branchedScenes).length}개 나이, ${branchedPlan.length}장 플랜`
    )

    // 3차(분기) 외삽 기록 — 연대기·프롬프트·결과를 Firebase에 남긴다(2차 운명 외삽과 비교용).
    await saveExtrapolationRecord(
      profile,
      pid,
      'branched',
      {
        transcriptTurnCount: transcript.turns.length,
        ages: branchedAges(profile),
        narrative: synthTrace.branchedNarrative || null,
        narrativePrompt: buildBranchedNarrativePrompt(
          profile,
          sessionPoints,
          transcript.turns,
          branchedAges(profile)
        ),
        scenePrompt: synthTrace.branchedScenePrompt || null,
        scenes: branchedScenes
      },
      log
    )

    // 플랜을 별도 문서(__branched)로 Firebase에 남긴다 — 32장 플랜 기록을 덮지 않는다. best-effort.
    try {
      const sp = await upsertPersonaScenePlan({
        profile,
        personaId: pid,
        plan: branchedPlan,
        sessionKey: 'branched',
        docSuffix: '__branched'
      })
      log(`  [Firebase] 분기 플랜 ${sp.count}개 기록 ('panoramaPrompts'/${sp.key})`)
    } catch (err) {
      log(`  [경고] 분기 플랜 Firebase 기록 실패(무시): ${err.message}`)
    }

    // 2) 얼굴 앵커 — 1·2차 때 받아둔 로컬 레퍼런스 사진 재사용(manifest.profile.photos).
    const photoPaths = []
    for (const p of manifest.profile?.photos || []) {
      const ok = await fs.access(p).then(
        () => true,
        () => false
      )
      if (ok) photoPaths.push(p)
    }
    if (!photoPaths.length)
      throw new Error(
        '레퍼런스 사진이 로컬에 없다(_input) — 1·2차를 만든 머신에서 실행하거나 hydrate 먼저'
      )
    const faceRef = {
      buffer: await fs.readFile(photoPaths[0]),
      path: path.relative(personaDir, photoPaths[0])
    }

    const proGclient = new GeminiClient({
      apiKey: await resolveGeminiApiKey(config.gemini),
      model: config.gemini.model,
      textModel: config.gemini.textModel,
      timeoutMs: config.timeoutMs
    })

    // 3) 분기 릴(_reel-branched) — 미래 나이라 스테이지 사진은 없다(얼굴 앵커로 aging). best-effort.
    await generateReelPhotosBestEffort({
      profile,
      personaDir,
      pid,
      config,
      gclient: proGclient,
      faceRef,
      stageRefFor: null,
      ageScenes: branchedScenes,
      variant: 'branched',
      signal,
      log
    })
    if (signal?.aborted) return { ok: false, cancelled: true }

    // 4) aged 앵커 — 미래 나이의 '그 나이 얼굴'. 1·2차 프리패스가 이미 _aged/에 캐시해뒀으면 재사용.
    const agedByAge = await prepareAgedAnchors({
      gclient: proGclient,
      faceRef,
      profile,
      plan: branchedPlan,
      personaDir,
      model: config.gemini.model,
      imageSize: config.gemini.imageSize,
      signal,
      log,
      needsAged: () => true // 분기 장면은 전부 미래 — 스테이지 실제 사진이 있을 수 없다
    })
    const agedRefFor = (age) => agedByAge.get(age) || null
    const selectFor = (item) => selectSceneReference(item, { stageRef: null, faceRef, agedRefFor })

    // 5) 파노라마 생성 — 기존 32장 플랜(manifest.images 그대로) + 분기 플랜을 합쳐 넘긴다.
    // generateLifeLibrary의 resume이 기존 장은 건너뛰고(성공분) 분기 장만 새로 만든다.
    const mergedPlan = [...manifest.images.map((im) => ({ ...im })), ...branchedPlan]
    const t0 = Date.now()
    const result = await generateLifeLibrary(
      { name: profile.name, birthDate: profile.birthDate, photos: photoPaths },
      {
        host: config.host,
        outDir,
        workflow: config.workflow,
        panorama: config.panorama,
        seamfix: config.seamfix,
        timeoutMs: config.timeoutMs,
        sceneRetries: config.sceneRetries,
        sceneConcurrency: config.sceneConcurrency, // Gemini 장면 동시 생성 수 (undefined면 기본 3)
        signal,
        gemini: config.gemini,
        pid,
        plan: mergedPlan,
        // 분기 장면만 새 프롬프트·레퍼런스를 조립한다. 기존 장은 resume으로 건너뛰지만,
        // 혹시 failed였던 옛 장이 재시도되면 기록된 원래 프롬프트를 그대로 쓴다(레퍼런스 없이).
        promptFor: (p, item) =>
          item.branch
            ? selectFor(item).prefix + composeScenePromptFor(config.workflow, p, item)
            : item.prompt || composeScenePromptFor(config.workflow, p, item),
        referencesFor: (item) => {
          if (!item.branch) return []
          const r = selectFor(item).reference
          return r ? [r.buffer] : []
        },
        referenceMetaFor: (item) => {
          if (!item.branch) return null
          const s = selectFor(item)
          return s.reference ? { file: s.reference.path, kind: s.kind } : null
        },
        skipSeamfix: config.lifeGraphSkipSeamfix,
        onManifest: (m) => upsertPersonaManifest(m),
        onProgress
      }
    )
    const altAll = result.manifest.images.filter((im) => im.branch)
    const imageCount = altAll.filter((im) => !im.failed).length
    const failedCount = altAll.length - imageCount

    if (signal?.aborted) {
      await updateProfileFields(pid, { branchedStatus: 'submitted' }).catch(() => {})
      log(`[일시정지] 중지됨: ${label} — 분기 ${imageCount}장까지 생성(재개 가능)`)
      return { ok: false, cancelled: true, imageCount }
    }
    if (imageCount === 0) throw new Error(`분기 장면 전부 실패 (${failedCount}장)`)

    await uploadPanoramasBestEffort(pid, outDir, result.manifest, log)

    // 6) 분기 장례식(90세) — 이미지 단계까지. 승인·영상화는 admin에서(기존 게이트 그대로).
    try {
      const r = await runFuneralWorkflow({
        personaDir,
        gclient: proGclient,
        config,
        stage: 'image',
        variant: 'branched',
        doc: profile,
        branchNarrative: synthTrace.branchedNarrative || null, // 조문객 캐스트가 분기된 삶을 근거로

        faceRef: faceRef.buffer,
        signal,
        log,
        onManifest: (m) => upsertPersonaManifest(m)
      })
      if (r.ok) log(`  [장례식] 분기 장례식 이미지 완료 (rev ${r.rev}) — admin 승인 후 영상화`)
      else if (!r.cancelled) log(`  [경고] 분기 장례식 이미지 실패(무시): ${r.error}`)
    } catch (err) {
      log(`  [경고] 분기 장례식 이미지 실패(무시): ${err.message}`)
    }

    // 7) 분기 장지(안식처) — 분기 연대기를 근거로 1차 장지와 다른 안식처. 이미지 단계까지,
    // 승인·영상화는 admin에서(장례식과 같은 게이트). best-effort.
    try {
      const r = await runGraveWorkflow({
        personaDir,
        gclient: proGclient,
        config,
        stage: 'image',
        variant: 'branched',
        branchNarrative: synthTrace.branchedNarrative || null,
        doc: profile,
        signal,
        log,
        onManifest: (m) => upsertPersonaManifest(m)
      })
      if (r.ok) log(`  [장지] 분기 장지 이미지 완료 (rev ${r.rev}) — admin 승인 후 영상화`)
      else if (!r.cancelled) log(`  [경고] 분기 장지 이미지 실패(무시): ${r.error}`)
    } catch (err) {
      log(`  [경고] 분기 장지 이미지 실패(무시): ${err.message}`)
    }

    await updateProfileFields(pid, {
      branchedStatus: 'done',
      branchedImageCount: imageCount,
      branchedFailedCount: failedCount,
      branchedGeneratedAt: new Date().toISOString()
    }).catch(() => {})
    log(
      `[완료] ${label} — 분기 ${imageCount}장${failedCount ? ` (실패 ${failedCount}장)` : ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`
    )
    return { ok: true, imageCount, failedCount }
  } catch (err) {
    log(`[실패] ${label} — ${err.message}`)
    await updateProfileFields(pid, {
      branchedStatus: 'error',
      branchedError: String(err.message || err)
    }).catch(() => {})
    return { ok: false, error: String(err.message || err) }
  }
}
