// 생애 라이브러리 사전 생성 오케스트레이터 (§5.1).
//
// 프로필(이름·생년월일·직업·레퍼런스 사진)을 받아 생애 전반 장면 ~30장을 생성해
// 로컬 캐시 디렉토리에 저장한다. 주마등(ZOETROPE) 모드는 이 캐시를 재생만 한다.
//
// 장면은 전부 3인칭 부감(관조) 구도로 생성한다 — 크리스마스 캐롤의 스크루지가 자기 삶을
// 위에서 내려다보듯. 주인공은 보이고 자기 얼굴도 드러나며, 나머지 인물 얼굴은 붓으로 지운 듯
// 뭉갠다 (prompt-builder.js 상단 주석 참조). 나이별 포트레이트 선행 단계는 없다.
// 레퍼런스 사진의 역할: gemini에서는 성별 자동 감지에만 쓰고 장면 생성에는 넣지 않는다
// (순수 텍스트→이미지). kontext는 편집 모델이라 입력 이미지가 구조적으로 필요해 사진을
// 그대로 입력으로 쓴다(폴백 경로 — 주인공 얼굴 정체성을 살릴 수 있으나 아동 나이 IMAGE_SAFETY 위험).
//
// 상태 기계 연결 지점 (§6 ENTRY — 아직 배선하지 않음):
//   generateLifeLibrary(profile, { onProgress })의 onProgress 이벤트를
//   main 프로세스가 IPC로 렌더러에 중계하면 된다. 이 모듈은 electron을 모른다.
//
// 실시간 재생성(§5.2 FREEZE→IMMERSION 파노라마)은 별도 모듈로 — 여기 넣지 않는다.

import fs from 'node:fs/promises'
import path from 'node:path'
import { ComfyUIClient } from './client.js'
import { GeminiClient, resolveGeminiApiKey, nearestGeminiAspect } from './gemini-client.js'
import { buildKontextWorkflow, buildSdxlWorkflow, randomSeed } from './workflows.js'
import { buildGeminiSeamFixWorkflow } from './seamfix-legacy.js' // LEGACY: seamfix 분기 전용(equirect 통일로 새 생성 미사용)
import { detectGender, detectGenderWithGemini } from './gender-detect.js'
import {
  buildScenePlan,
  composeScenePromptFor,
  personaId,
  SEAM_BAND_PROMPT
} from './prompt-builder.js'

/**
 * @param {object} profile  prompt-builder.js 상단의 스키마 참조
 * @param {object} opts
 * @param {string}  opts.host       ComfyUI 주소 (workflow가 gemini면 사용하지 않음)
 * @param {string}  opts.outDir     라이브러리 루트 (personaId 하위 디렉토리가 생긴다)
 * @param {string}  opts.workflow   'auto' | 'kontext' | 'sdxl' | 'gemini' | 'seamfix' — auto는 사진 있으면 kontext.
 *   ('hybrid'는 포트레이트 단계 제거로 kontext와 동일해져 kontext로 정규화한다.)
 *   'seamfix'(B안): Gemini로 1인칭 360° 파노라마 생성 후 ComfyUI Flux Fill로 좌우 이음매를 보정한다.
 * @param {object}  opts.panorama   seamfix 소스 크기 { width, height } — 360° 둘레라 2:1 와이드. 기본 2048×1024.
 * @param {object}  opts.gemini     { model, textModel, sceneModel?, apiKey?, apiKeyPath?, imageSize } — gemini용.
 *   apiKeyPath는 호출자가 절대경로로 넘긴다 (resolveGeminiApiKey 참조).
 * @param {number}  opts.perStage   단계당 장면 수 (기본 3 → 총 30)
 * @param {number}  opts.limit      앞에서부터 n장만 생성 (테스트용)
 * @param {object}  opts.image      { width, height }
 * @param {number}  opts.timeoutMs  장당 생성 제한 시간
 * @param {(e) => void} opts.onProgress
 *   e: { type: 'plan'|'upload'|'gender-start'|'gender-done'|'image-start'|'image-progress'|'image-done',
 *        done?, total?, item?, file?, value?, max? }
 * @returns {{ personaId, dir, manifest }}
 */
export async function generateLifeLibrary(profile, opts = {}) {
  const {
    host,
    outDir = 'library',
    workflow = 'auto',
    perStage = 3,
    limit = Infinity,
    image = { width: 1344, height: 768 },
    timeoutMs = 300000,
    sceneRetries = 1, // 장면 생성 실패 시 추가 재시도 횟수 (총 시도 = 1 + sceneRetries)
    signal, //          외부 취소(중지 버튼) — 장면 사이·생성 요청에서 확인해 중단한다
    gemini = {},
    seamfix = {}, //     이음매 밴드 { bandWidth, feather } — 미지정 키는 workflow 기본(256/96)
    pid: pidOverride, //     라이브러리 디렉토리 이름을 personaId() 해시 대신 이걸로 쓴다(있으면).
    plan: planOverride, //   있으면 buildScenePlan(occupation·고정 10단계 템플릿) 대신 이걸 쓴다 —
    //                       cdb-crafter처럼 프로필 스키마가 다른 호출자를 위한 확장 지점.
    promptFor, //            있으면 (profile, item) => string 으로 프롬프트를 직접 조립한다 —
    //                       composeScenePromptFor(occupation 스키마 전제) 대신 쓴다.
    skipSeamfix = false, //  seamfix 모드 전용: true면 ComfyUI 이음매 보정을 건너뛰고 Gemini
    //                       원본을 그대로 장면 파일로 쓴다(Gemini 프롬프트만 먼저 확인할 때).
    referencesFor, //        있으면 (item) => Buffer[] 로 장면별 레퍼런스 이미지를 Gemini 장면
    //                       생성(gemini·seamfix)에 실어 보낸다 — 기본은 항상 빈 배열(장면 생성엔
    //                       레퍼런스를 안 씀, 레퍼런스는 성별감지·kontext 편집 입력 전용이었다).
    //                       cdb-crafter처럼 과거~현재 단계마다 그 순간의 실제 사진이 있을 때 씀.
    referenceMetaFor, //     있으면 (item) => { file, kind } | null 로 그 장면에 실은 레퍼런스의
    //                       상대경로·종류를 돌려준다. manifest 항목에 기록해두면 admin 재생성이
    //                       같은 사진을 다시 실을 수 있다(referencesFor는 버퍼만 줘서 경로가 없다).
    onProgress = () => {},
    onManifest //            있으면 장면이 기록될 때마다 (manifest) => Promise 로 호출한다 —
    //                       이 모듈은 Firebase를 모른 채, 호출자(profile-worker)가 여기에 정본
    //                       업로드(upsertPersonaManifest)를 물려 "생성되는 족족" 원격 실시간 보기가
    //                       되게 한다. best-effort — 실패해도 생성 진행은 막지 않는다.
  } = opts

  profile = { ...profile } // 성별 자동 감지가 gender를 채울 수 있으므로 호출자 객체를 오염시키지 않는다

  const pid = pidOverride || personaId(profile)
  const dir = path.join(outDir, pid)
  await fs.mkdir(dir, { recursive: true })

  let mode = workflow === 'auto' ? (profile.photos?.length ? 'kontext' : 'sdxl') : workflow
  if (mode === 'hybrid') mode = 'kontext' // 구 설정 호환 — 포트레이트 단계가 사라져 동일하다
  if (mode !== 'sdxl' && !profile.photos?.length) {
    throw new Error(`${mode} 워크플로우에는 profile.photos 레퍼런스 사진이 최소 1장 필요하다`)
  }
  const isGemini = mode === 'gemini'
  const isSeamfix = mode === 'seamfix' // B안: Gemini 파노라마 생성 + ComfyUI Flux Fill 이음매 보정
  const isEquirect = mode === 'equirect' // 1인칭 360° Gemini 파노라마 — 순수 텍스트→이미지(Flux 이음매 없음)
  const useGeminiScene = isGemini || isSeamfix || isEquirect // 장면 픽셀을 Gemini가 만든다
  // kontext·sdxl·seamfix가 ComfyUI를 쓴다 — 단 seamfix+skipSeamfix는 이음매 보정 자체를 안 하고,
  // equirect는 아예 보정 단계가 없어 ComfyUI가 필요 없다(연결 확인도 생략).
  const useComfy = !isGemini && !isEquirect && !(isSeamfix && skipSeamfix)
  // seamfix·equirect 소스는 360° 둘레라 2:1 와이드가 필요하다 → 라이브러리 기본 16:9 대신 파노라마 크기 사용.
  const effImage = isSeamfix || isEquirect ? opts.panorama || { width: 2048, height: 1024 } : image
  // Gemini는 픽셀 크기 대신 종횡비로 지정한다 — 실제 출력 크기(effImage)에 가장 가까운
  // 지원 비율을 고른다. gemini(1344×768)→'16:9', seamfix 파노라마(4096×1024)→'4:1'.
  const geminiAspect = nearestGeminiAspect(effImage.width, effImage.height)
  const imageSize = gemini.imageSize || '2K'
  // 장면 모델: gemini.sceneModel(기본 flash). 참고로 pro(gemini.model)는 4:1 종횡비를 지원하지 않아
  // (HTTP 400 "Aspect ratio 4:1 is not supported") 파노라마 장면엔 못 쓴다 — 4:1을 받는 건 flash뿐이다.
  // (레퍼런스 장면 얼굴·손 잔상 문제는 모델 교체로는 못 풀고 별도 접근이 필요하다 — 아래 별건.)
  const sceneModel = gemini.sceneModel || gemini.model

  // 재개(resume): 같은 프로필을 다시 돌리면 기존 manifest를 읽어 이미 생성된 장을 건너뛴다 —
  // 서버 재시작·중단 복구 시 재과금(gemini)·재생성 없이 남은 장부터 잇는다.
  // 플랜은 프로필 시드로 결정론적이라 id 매칭이 안전하다. 백엔드가 바뀌었으면 처음부터.
  const manifestPath = path.join(dir, 'manifest.json')
  let prior = null
  try {
    prior = JSON.parse(await fs.readFile(manifestPath, 'utf-8'))
  } catch {
    /* 첫 생성 */
  }
  if (prior?.workflow !== mode) prior = null
  const priorImages = new Map((prior?.images || []).map((i) => [i.id, i]))
  const fileExists = (f) =>
    fs.access(f).then(
      () => true,
      () => false
    )

  const fullPlan = planOverride || buildScenePlan(profile, { perStage })
  const plan = fullPlan.slice(0, Math.min(limit, fullPlan.length))
  onProgress({ type: 'plan', total: plan.length })

  const client = useComfy ? new ComfyUIClient({ host, timeoutMs }) : null
  const gclient = useGeminiScene
    ? new GeminiClient({
        apiKey: await resolveGeminiApiKey(gemini),
        model: gemini.model,
        textModel: gemini.textModel,
        timeoutMs
      })
    : null
  const manifest = {
    personaId: pid,
    createdAt: new Date().toISOString(),
    workflow: mode,
    image: effImage,
    ...(useGeminiScene ? { gemini: { model: gclient.model, sceneModel, imageSize } } : {}),
    ...(isSeamfix
      ? {
          seamfix: {
            bandModel: 'flux-fill',
            bandWidth: seamfix.bandWidth,
            feather: seamfix.feather
          }
        }
      : {}),
    // 사진 바이너리는 제외하고 경로만 기록
    profile: { ...profile, photos: profile.photos || [] },
    images: []
  }
  const writeManifest = async () => {
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    // 로컬 기록 후 정본(Firebase) 동기화를 호출자에 위임 — best-effort(생성 흐름을 막지 않는다).
    if (onManifest) {
      try {
        await onManifest(manifest)
      } catch {
        /* 정본 동기화 실패는 무시 — 로컬 진행분은 이미 저장됐고 다음 장에서 다시 시도된다 */
      }
    }
  }

  try {
    if (useComfy) await client.ping()
    if (useGeminiScene) await gclient.ping()

    // 레퍼런스 사진 준비 (첫 장 사용). 3인칭 부감 구도에서의 역할:
    // gemini → 성별 자동 감지 전용(장면 생성에는 넣지 않음), kontext → 편집 입력.
    let referenceImage = null // ComfyUI: 업로드된 이미지 이름
    let referenceBuffer = null // gemini: 원본 사진 Buffer (성별 감지용)
    if (mode !== 'sdxl') {
      const photoPath = profile.photos[0]
      const buf = await fs.readFile(photoPath)
      manifest.referenceImage = { local: photoPath }
      // gemini·seamfix: 사진은 성별 자동 감지에만(장면 생성엔 넣지 않음). kontext: 편집 입력으로 업로드.
      if (useGeminiScene) referenceBuffer = buf
      if (mode === 'kontext') {
        const uploaded = await client.uploadImage(
          buf,
          `${pid}-ref${path.extname(photoPath) || '.png'}`
        )
        referenceImage = uploaded.name
        manifest.referenceImage.uploaded = uploaded.name
        onProgress({ type: 'upload', file: uploaded.name })
      }
    }

    // 성별: 프로필에 없으면 레퍼런스 사진에서 자동 감지한다(프로필당 1회 —
    // gemini는 Gemini 캡션, kontext는 ComfyUI 태거/캡션. gender-detect.js 참조).
    // 감지 근거(캡션)를 manifest.gender에 남긴다 — 어드민에서 수동 수정 가능(source: 'manual').
    // 감지 실패는 치명적이지 않다: 중립 프롬프트로 생성을 계속한다.
    if (profile.gender) {
      manifest.gender = { value: profile.gender, source: 'profile' }
    } else if (prior?.profile?.gender) {
      // 재개: 이전 실행에서 감지/수정된 성별 재사용 (재감지 생략 — 프롬프트 일관성 유지)
      profile.gender = prior.profile.gender
      manifest.gender = prior.gender || { value: profile.gender, source: 'resume' }
      manifest.profile.gender = profile.gender
    } else if (mode !== 'sdxl') {
      onProgress({ type: 'gender-start' })
      try {
        const det = useGeminiScene
          ? await detectGenderWithGemini(gclient, referenceBuffer)
          : await detectGender(client, referenceImage)
        profile.gender = det.gender || undefined
        manifest.gender = {
          value: det.gender,
          source: 'auto',
          caption: det.caption,
          backend: det.backend
        }
        onProgress({ type: 'gender-done', gender: det.gender, caption: det.caption })
      } catch (err) {
        manifest.gender = { value: null, source: 'auto', error: String(err.message || err) }
        onProgress({ type: 'gender-done', gender: null, error: String(err.message || err) })
      }
      manifest.profile.gender = profile.gender ?? null
      await writeManifest()
    }

    for (let i = 0; i < plan.length; i++) {
      if (signal?.aborted) break // 중지 요청 — 진행분은 finally가 저장, 남은 장은 나중에 재개
      const item = plan[i]
      // gemini·equirect는 시드 개념이 없다. seamfix는 보정 단계(ComfyUI)에 시드가 필요하므로 발급한다.
      const seed = isGemini || isEquirect ? null : randomSeed()
      const prompt = promptFor
        ? promptFor(profile, item)
        : composeScenePromptFor(mode, profile, item)
      const references = referencesFor ? referencesFor(item) : []
      const refMeta = referenceMetaFor ? referenceMetaFor(item) : null // { file, kind } — 재생성이 같은 레퍼런스 재사용
      const localFile = path.join(dir, `${item.id}.png`)

      // 재개: 이전 실행에서 성공한 장면은 건너뛴다. failed 표시된 장은 다시 시도한다.
      const prev = priorImages.get(item.id)
      if (prev && !prev.failed && (await fileExists(localFile))) {
        manifest.images.push(prev)
        await writeManifest()
        onProgress({
          type: 'image-done',
          done: i + 1,
          total: plan.length,
          item,
          file: localFile,
          resumed: true
        })
        continue
      }

      onProgress({ type: 'image-start', done: i, total: plan.length, item })
      const t0 = Date.now()

      // 장면별 회복력: 타임아웃 등 실패 시 재시도, 그래도 안 되면 그 장만 건너뛰고 계속한다.
      // (한 장 때문에 30장 전체가 무너지지 않게. 건너뛴 장은 manifest에 failed로 남겨
      //  admin에서 그 장만 재생성할 수 있다.) IMAGE_SAFETY는 gclient 내부에서 이미 1회 재시도.
      let promptId = null
      let srcFile = null // seamfix: 보관한 Gemini 원본 파일명(edge 재연결용)
      let ok = false
      let lastErr = null
      let cancelled = false
      for (let attempt = 0; attempt <= sceneRetries; attempt++) {
        if (signal?.aborted) {
          cancelled = true
          break
        }
        try {
          if (isGemini || isEquirect) {
            // 순수 텍스트→이미지. gemini=3인칭 부감(16:9), equirect=1인칭 360°(4:1). 둘 다 Flux 단계 없음.
            // referencesFor가 주어졌을 때만(cdb-crafter 과거~현재 단계) 그 순간의 실제 사진을 함께 보낸다.
            const data = await gclient.generateImage({
              prompt,
              references,
              aspectRatio: geminiAspect,
              imageSize,
              model: sceneModel,
              signal
            })
            await fs.writeFile(localFile, data)
          } else if (isSeamfix) {
            // ⚠ LEGACY 분기 — mode==='seamfix'일 때만. 2026-07-22 equirect 통일로 새 생성은 여기 안 온다
            // (config.workflow='equirect'). buildGeminiSeamFixWorkflow는 seamfix-legacy.js에서 가져온다.
            // B안: Gemini로 1인칭 360° 파노라마 생성 → ComfyUI Flux Fill로 좌우 이음매 보정.
            const data = await gclient.generateImage({
              prompt,
              references,
              aspectRatio: geminiAspect, // 파노라마 비율로 자동 선택(4096×1024→'4:1')
              imageSize,
              model: sceneModel,
              signal
            })
            // Gemini 원본 보관 — admin "edge 재연결"이 재생성 없이 이 원본으로 이음매만 다시 보정한다.
            srcFile = `${item.id}.src.png`
            await fs.writeFile(path.join(dir, srcFile), data)
            if (skipSeamfix) {
              // 이음매 안 붙은 원본을 그대로 장면 파일로 — srcFile이 남아 있으니 나중에 admin의
              // "edge 재연결" 버튼 한 번으로 ComfyUI 보정만 마저 돌릴 수 있다(Gemini 재과금 없음).
              await fs.writeFile(localFile, data)
            } else {
              const uploaded = await client.uploadImage(data, `${pid}-${item.id}-src.png`)
              const wf = buildGeminiSeamFixWorkflow({
                referenceImage: uploaded.name,
                prompt,
                bandPrompt: SEAM_BAND_PROMPT, // 이음매 띠에 인물 안 그리게(기괴함 방지)
                width: effImage.width,
                height: effImage.height,
                bandWidth: seamfix.bandWidth, // config 미지정이면 workflow 기본(256)
                feather: seamfix.feather, //   config 미지정이면 workflow 기본(96)
                bandModel: 'flux-fill',
                seed,
                filenamePrefix: `chrono-zoetrope/${pid}/${item.id}`
              })
              const out = await client.generate(wf, {
                onProgress: (p) => onProgress({ type: 'image-progress', item, ...p })
              })
              promptId = out.promptId
              // 워크플로우는 보정본(-pano)과 원본(-raw)을 저장한다 — 보정본을 장면 파일로 쓴다.
              const corrected = out.images.find((im) => /-pano_/.test(im.filename)) || out.images[0]
              await fs.writeFile(localFile, corrected.data)
            }
          } else {
            const wf =
              mode === 'kontext'
                ? buildKontextWorkflow({
                    prompt,
                    referenceImage,
                    width: effImage.width,
                    height: effImage.height,
                    seed,
                    filenamePrefix: `chrono-zoetrope/${pid}/${item.id}`
                  })
                : buildSdxlWorkflow({
                    prompt,
                    width: effImage.width,
                    height: effImage.height,
                    seed,
                    filenamePrefix: `chrono-zoetrope/${pid}/${item.id}`
                  })
            const out = await client.generate(wf, {
              onProgress: (p) => onProgress({ type: 'image-progress', item, ...p })
            })
            promptId = out.promptId
            await fs.writeFile(localFile, out.images[0].data)
          }
          ok = true
          break
        } catch (err) {
          if (signal?.aborted) {
            cancelled = true
            break
          }
          lastErr = err
          const more = attempt < sceneRetries
          onProgress({
            type: 'image-retry',
            item,
            attempt: attempt + 1,
            error: err.message,
            willRetry: more
          })
          if (more) continue
        }
      }

      if (cancelled) {
        await fs.rm(localFile, { force: true }).catch(() => {}) // 반쯤 써진 파일 정리
        break // 중지 — 이 장은 failed로 남기지 않는다(사용자가 나중에 재개)
      }
      if (ok) {
        manifest.images.push({
          ...item,
          prompt,
          seed,
          promptId,
          file: `${item.id}.png`,
          ...(srcFile ? { srcFile } : {}), // seamfix 원본 — edge 재연결이 재사용
          ...(refMeta ? { referenceFile: refMeta.file, referenceKind: refMeta.kind } : {}), // 재생성용 레퍼런스
          elapsedMs: Date.now() - t0
        })
        await writeManifest() // 장마다 기록 — 중단돼도 진행분은 남는다
        onProgress({ type: 'image-done', done: i + 1, total: plan.length, item, file: localFile })
      } else {
        // 재시도까지 실패 — 그 장은 failed로 표시하고(파일 없음) 계속. admin에서 개별 재생성 가능.
        await fs.rm(localFile, { force: true }).catch(() => {}) // 반쯤 써진 파일 정리
        manifest.images.push({
          ...item,
          prompt,
          seed,
          promptId: null,
          file: `${item.id}.png`,
          ...(refMeta ? { referenceFile: refMeta.file, referenceKind: refMeta.kind } : {}),
          failed: true
        })
        await writeManifest()
        onProgress({
          type: 'image-failed',
          done: i + 1,
          total: plan.length,
          item,
          error: lastErr?.message
        })
      }
    }
  } finally {
    client?.close()
    await writeManifest().catch(() => {})
  }

  return { personaId: pid, dir, manifest }
}
