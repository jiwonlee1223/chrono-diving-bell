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
import { GeminiClient, resolveGeminiApiKey } from './gemini-client.js'
import { buildKontextWorkflow, buildSdxlWorkflow, randomSeed } from './workflows.js'
import { detectGender, detectGenderWithGemini } from './gender-detect.js'
import {
  buildScenePlan,
  composeGeminiScenePrompt,
  composeKontextPrompt,
  composeSdxlPrompt,
  personaId
} from './prompt-builder.js'

/**
 * @param {object} profile  prompt-builder.js 상단의 스키마 참조
 * @param {object} opts
 * @param {string}  opts.host       ComfyUI 주소 (workflow가 gemini면 사용하지 않음)
 * @param {string}  opts.outDir     라이브러리 루트 (personaId 하위 디렉토리가 생긴다)
 * @param {string}  opts.workflow   'auto' | 'kontext' | 'sdxl' | 'gemini' — auto는 사진 있으면 kontext.
 *   ('hybrid'는 포트레이트 단계 제거로 kontext와 동일해져 kontext로 정규화한다.)
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
    onProgress = () => {}
  } = opts

  profile = { ...profile } // 성별 자동 감지가 gender를 채울 수 있으므로 호출자 객체를 오염시키지 않는다

  const pid = personaId(profile)
  const dir = path.join(outDir, pid)
  await fs.mkdir(dir, { recursive: true })

  let mode = workflow === 'auto' ? (profile.photos?.length ? 'kontext' : 'sdxl') : workflow
  if (mode === 'hybrid') mode = 'kontext' // 구 설정 호환 — 포트레이트 단계가 사라져 동일하다
  if (mode !== 'sdxl' && !profile.photos?.length) {
    throw new Error(`${mode} 워크플로우에는 profile.photos 레퍼런스 사진이 최소 1장 필요하다`)
  }
  const isGemini = mode === 'gemini'
  const useComfy = !isGemini // kontext·sdxl
  // Gemini는 픽셀 크기 대신 종횡비로 지정한다 — 현재 규격(장면 1344×768)에
  // 가장 가까운 비율로 고정 매핑. imageSize 2K면 약 2048×1152가 나온다.
  const geminiAspect = '16:9'
  const imageSize = gemini.imageSize || '2K'
  // 장면 모델: gemini.sceneModel(기본 flash — 장당 비용 절감), 없으면 gemini.model.
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

  const fullPlan = buildScenePlan(profile, { perStage })
  const plan = fullPlan.slice(0, Math.min(limit, fullPlan.length))
  onProgress({ type: 'plan', total: plan.length })

  const client = useComfy ? new ComfyUIClient({ host, timeoutMs }) : null
  const gclient = isGemini
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
    image,
    ...(isGemini ? { gemini: { model: gclient.model, sceneModel, imageSize } } : {}),
    // 사진 바이너리는 제외하고 경로만 기록
    profile: { ...profile, photos: profile.photos || [] },
    images: []
  }
  const writeManifest = () => fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))

  try {
    if (useComfy) await client.ping()
    if (isGemini) await gclient.ping()

    // 레퍼런스 사진 준비 (첫 장 사용). 3인칭 부감 구도에서의 역할:
    // gemini → 성별 자동 감지 전용(장면 생성에는 넣지 않음), kontext → 편집 입력.
    let referenceImage = null // ComfyUI: 업로드된 이미지 이름
    let referenceBuffer = null // gemini: 원본 사진 Buffer (성별 감지용)
    if (mode !== 'sdxl') {
      const photoPath = profile.photos[0]
      const buf = await fs.readFile(photoPath)
      manifest.referenceImage = { local: photoPath }
      if (isGemini) referenceBuffer = buf
      if (useComfy) {
        const uploaded = await client.uploadImage(buf, `${pid}-ref${path.extname(photoPath) || '.png'}`)
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
        const det = isGemini
          ? await detectGenderWithGemini(gclient, referenceBuffer)
          : await detectGender(client, referenceImage)
        profile.gender = det.gender || undefined
        manifest.gender = { value: det.gender, source: 'auto', caption: det.caption, backend: det.backend }
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
      const seed = isGemini ? null : randomSeed()
      const prompt =
        mode === 'sdxl'
          ? composeSdxlPrompt(profile, item)
          : isGemini
            ? composeGeminiScenePrompt(profile, item)
            : composeKontextPrompt(profile, item)
      const localFile = path.join(dir, `${item.id}.png`)

      // 재개: 이전 실행에서 성공한 장면은 건너뛴다. failed 표시된 장은 다시 시도한다.
      const prev = priorImages.get(item.id)
      if (prev && !prev.failed && (await fileExists(localFile))) {
        manifest.images.push(prev)
        await writeManifest()
        onProgress({ type: 'image-done', done: i + 1, total: plan.length, item, file: localFile, resumed: true })
        continue
      }

      onProgress({ type: 'image-start', done: i, total: plan.length, item })
      const t0 = Date.now()

      // 장면별 회복력: 타임아웃 등 실패 시 재시도, 그래도 안 되면 그 장만 건너뛰고 계속한다.
      // (한 장 때문에 30장 전체가 무너지지 않게. 건너뛴 장은 manifest에 failed로 남겨
      //  admin에서 그 장만 재생성할 수 있다.) IMAGE_SAFETY는 gclient 내부에서 이미 1회 재시도.
      let promptId = null
      let ok = false
      let lastErr = null
      let cancelled = false
      for (let attempt = 0; attempt <= sceneRetries; attempt++) {
        if (signal?.aborted) {
          cancelled = true
          break
        }
        try {
          if (isGemini) {
            // 3인칭 부감 장면은 레퍼런스 없이 순수 텍스트→이미지 (prompt-builder 주석 참조)
            const data = await gclient.generateImage({
              prompt,
              references: [],
              aspectRatio: geminiAspect,
              imageSize,
              model: sceneModel,
              signal
            })
            await fs.writeFile(localFile, data)
          } else {
            const wf =
              mode === 'kontext'
                ? buildKontextWorkflow({
                    prompt,
                    referenceImage,
                    width: image.width,
                    height: image.height,
                    seed,
                    filenamePrefix: `chrono-zoetrope/${pid}/${item.id}`
                  })
                : buildSdxlWorkflow({
                    prompt,
                    width: image.width,
                    height: image.height,
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
          onProgress({ type: 'image-retry', item, attempt: attempt + 1, error: err.message, willRetry: more })
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
          elapsedMs: Date.now() - t0
        })
        await writeManifest() // 장마다 기록 — 중단돼도 진행분은 남는다
        onProgress({ type: 'image-done', done: i + 1, total: plan.length, item, file: localFile })
      } else {
        // 재시도까지 실패 — 그 장은 failed로 표시하고(파일 없음) 계속. admin에서 개별 재생성 가능.
        await fs.rm(localFile, { force: true }).catch(() => {}) // 반쯤 써진 파일 정리
        manifest.images.push({ ...item, prompt, seed, promptId: null, file: `${item.id}.png`, failed: true })
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
