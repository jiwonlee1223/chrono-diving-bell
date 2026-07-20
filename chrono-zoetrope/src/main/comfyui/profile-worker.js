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
import { composePanoramaScenePrompt } from './prompt-builder.js'
import { buildLifeGraphPlan, collectSessionPhotoURLs, collectStagePhotoURLs } from './life-graph-plan.js'
import {
  claimProfile,
  downloadPhotos,
  toGeneratorProfile,
  setProfileStatus,
  claimLifeGraphSession,
  setLifeGraphSessionStatus
} from './firestore-source.js'

const noop = () => {}

// composePanoramaScenePrompt는 "레퍼런스 이미지는 쓰지 않는다(순수 텍스트→이미지)"는 전제로
// 튜닝된 프롬프트라 그 함수 자체는 건드리지 않는다(§12 — 다른 사람이 튜닝해둔 걸 임의로 바꾸지
// 않기). 대신 실제 사진을 레퍼런스로 함께 보낼 때만, 그 사진을 실제로 써서 변형하라는 지시문을
// 앞에 붙인 별도 래퍼를 쓴다. 이게 없으면 Gemini가 참조 이미지를 무시하고(텍스트 지시가 사진
// 얘기를 전혀 안 하므로) 전혀 무관한 장면을 만들어버린다(실측: "자전거 타고 놀기" + protect 사진
// → 엉뚱한 외국 아기 사진이 나옴).
const REFERENCE_PHOTO_PREFIX =
  'The attached photograph is a real photo of this exact moment — use it as the actual source for this scene, ' +
  'keeping its real place, objects, colors and composition recognizable, not as loose inspiration for a different scene. '
function composePanoramaScenePromptFromPhoto(profile, item) {
  return REFERENCE_PHOTO_PREFIX + composePanoramaScenePrompt(profile, item)
}

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
  log(`▶ 생성 시작: ${label}`)

  try {
    // 1) 레퍼런스 사진을 로컬로 내려받기
    const inputDir = path.join(outDir, pid, '_input')
    const photoPaths = await downloadPhotos(profile, inputDir)
    log(`  사진 ${photoPaths.length}장 다운로드`)

    // 2) 생애 라이브러리 생성 (10단계 × perStage)
    const genProfile = toGeneratorProfile(profile, photoPaths)
    const t0 = Date.now()
    const result = await generateLifeLibrary(genProfile, {
      host: config.host,
      outDir,
      workflow: config.workflow,
      perStage: config.perStage,
      image: config.image,
      panorama: config.panorama, // seamfix(B안) 파노라마 크기 override (없으면 2048×1024 기본)
      seamfix: config.seamfix, // 이음매 밴드 폭/페더 (없으면 workflow 기본 256/96)
      timeoutMs: config.timeoutMs,
      sceneRetries: config.sceneRetries, // 장면 실패 시 재시도 횟수 (undefined면 기본 1)
      signal, // 중지 버튼 신호
      gemini: config.gemini, // 호출자가 resolveGeminiConfig로 apiKeyPath를 절대경로화해서 넘긴다
      onProgress
    })
    const elapsedMs = Date.now() - t0
    const all = result.manifest.images
    const imageCount = all.filter((im) => !im.failed).length // 성공 장면만 카운트
    const failedCount = all.length - imageCount

    // 사용자 중지 → 실패가 아니라 재개 가능하도록 submitted로 되돌린다(진행분은 남아 resume).
    if (signal?.aborted) {
      await setProfileStatus(pid, 'submitted', { error: null }).catch(() => {})
      log(`⏸ 중지됨: ${label} — ${imageCount}장까지 생성(재개 가능)`)
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
      `✓ 완료: ${label} — ${imageCount}장${failedCount ? ` (실패 ${failedCount}장 건너뜀 — admin 재생성)` : ''} (${(elapsedMs / 1000).toFixed(1)}s)`
    )
    return { claimed: true, ok: true, imageCount, failedCount, elapsedMs }
  } catch (err) {
    log(`✗ 실패: ${label} — ${err.message}`)
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
  log(`▶ 생성 시작: ${label}`)

  try {
    const sessionPoints = profile[sessionKey] || {}

    // 1) 레퍼런스 사진 — occupation 플로우와 완전히 같은 downloadPhotos를 쓴다. crafter 문서엔
    // occupation 플로우의 top-level photoURLs가 없으니, 이 세션의 과거~현재 점 중 사진이
    // 붙은 걸 하나 골라 downloadPhotos가 기대하는 { id, photoURLs } 모양으로 맞춰 넘긴다.
    // 사진이 하나도 없으면(아직 아무 점에도 사진을 안 올렸으면) downloadPhotos가 바로
    // 에러를 던진다 — seamfix는 레퍼런스 사진이 필수라 여기서 감싸지 않고 그대로 실패시킨다.
    const photoURLs = collectSessionPhotoURLs(sessionPoints)
    const inputDir = path.join(outDir, pid, '_input')
    const photoPaths = await downloadPhotos({ id: pid, photoURLs }, inputDir)
    log(`  사진 ${photoPaths.length}장 다운로드`)

    // 1.5) 단계별 사진 — 위 1)은 성별감지용 대표 사진 1장뿐이지만, 과거~현재는 각 단계마다
    // 다른 사진이 붙어있을 수 있다. 그 단계 생성에 "그 순간의 실제 사진"을 레퍼런스로 실어
    // 보내려고 전부 따로 내려받는다(없는 단계는 자연히 빠짐 — 미래는 애초에 사진이 없음).
    const stagePhotoURLs = collectStagePhotoURLs(sessionPoints)
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
    if (stageIds.length > 0) log(`  단계별 사진 ${stageIds.length}장 다운로드 (${stageIds.join(', ')})`)

    // 2) 생애 라이브러리 생성 — occupation 템플릿(buildScenePlan) 대신 이 세션의 실제 장면
    // plan을, composeScenePromptFor 대신 파노라마 프롬프트 함수를 그대로 넘긴다. Gemini/ComfyUI
    // 호출부(retry·resume·manifest 기록)는 generateLifeLibrary 내부 코드 그대로 — 안 건드림.
    const t0 = Date.now()
    const result = await generateLifeLibrary(
      { name: profile.name, birthDate: profile.birthDate, photos: photoPaths },
      {
        host: config.host,
        outDir,
        workflow: 'seamfix',
        panorama: config.panorama,
        seamfix: config.seamfix,
        timeoutMs: config.timeoutMs,
        sceneRetries: config.sceneRetries,
        signal,
        gemini: config.gemini,
        pid,
        plan: buildLifeGraphPlan(profile, sessionPoints, { perStage: 1 }), // 단계당 1장으로 복귀
        // 그 단계에 실제 사진이 있으면(과거~현재만 해당) "이 사진을 실제로 써서 변형하라"는
        // 지시문이 붙은 프롬프트를, 없으면(미래 등) 원래의 순수 텍스트 프롬프트를 그대로 쓴다.
        promptFor: (profile, item) =>
          item.stageId && stagePhotoBuffers[item.stageId]
            ? composePanoramaScenePromptFromPhoto(profile, item)
            : composePanoramaScenePrompt(profile, item),
        // 과거~현재 장면(item.stageId가 있고 그 단계에 사진이 있을 때)만 그 사진을 레퍼런스로
        // 함께 보낸다. 미래 장면은 stagePhotoBuffers에 항목이 없어 자연히 빈 배열이 된다.
        referencesFor: (item) => (item.stageId && stagePhotoBuffers[item.stageId] ? [stagePhotoBuffers[item.stageId]] : []),
        skipSeamfix: config.lifeGraphSkipSeamfix, // 테스트 단계: true면 ComfyUI 이음매 보정은 나중으로 미룸
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
      log(`⏸ 중지됨: ${label} — ${imageCount}장까지 생성(재개 가능)`)
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
      `✓ 완료: ${label} — ${imageCount}장${failedCount ? ` (실패 ${failedCount}장 건너뜀 — admin 재생성)` : ''} (${(elapsedMs / 1000).toFixed(1)}s)`
    )
    return { claimed: true, ok: true, imageCount, failedCount, elapsedMs }
  } catch (err) {
    log(`✗ 실패: ${label} — ${err.message}`)
    await setLifeGraphSessionStatus(pid, sessionKey, 'error', {
      [`${sessionKey}Error`]: String(err.message || err)
    }).catch(() => {})
    return { claimed: true, ok: false, error: String(err.message || err) }
  }
}
