// 생애 라이브러리 사전 생성 오케스트레이터 (§5.1).
//
// 프로필(이름·생년월일·직업·레퍼런스 사진)을 받아 생애 전반 장면 ~30장을 생성해
// 로컬 캐시 디렉토리에 저장한다. 주마등(ZOETROPE) 모드는 이 캐시를 재생만 한다.
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
  composeAgePortraitPrompt,
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
 * @param {string}  opts.workflow   'auto' | 'kontext' | 'sdxl' | 'gemini' | 'hybrid' — auto는 사진 있으면 kontext.
 *   hybrid는 나이 포트레이트(정체성·나이 변환)만 gemini로 만들고 장면은 kontext로 생성한다 —
 *   장면은 포트레이트를 레퍼런스로 쓰므로 인물 품질은 포트레이트 단계가 결정한다. 비용은 10장분만.
 * @param {object}  opts.gemini     { model, textModel, apiKey?, apiKeyPath?, imageSize } — gemini·hybrid용.
 *   apiKeyPath는 호출자가 절대경로로 넘긴다 (resolveGeminiApiKey 참조).
 * @param {number}  opts.perStage   단계당 장면 수 (기본 3 → 총 30)
 * @param {number}  opts.limit      앞에서부터 n장만 생성 (테스트용)
 * @param {object}  opts.image      { width, height }
 * @param {number}  opts.timeoutMs  장당 생성 제한 시간
 * @param {boolean} opts.stagePortraits  kontext 2단계(나이별 포트레이트 선행) 사용. 기본 true —
 *   Kontext는 장면+나이 동시 변환에서 나이를 무시하므로, 나이는 포트레이트 단계에서 옮긴다.
 * @param {(e) => void} opts.onProgress
 *   e: { type: 'plan'|'upload'|'portrait-start'|'portrait-done'|'image-start'|'image-progress'|'image-done',
 *        done?, total?, item?, age?, file?, value?, max? }
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
    stagePortraits = true,
    gemini = {},
    onProgress = () => {}
  } = opts

  profile = { ...profile } // 성별 자동 감지가 gender를 채울 수 있으므로 호출자 객체를 오염시키지 않는다

  const pid = personaId(profile)
  const dir = path.join(outDir, pid)
  await fs.mkdir(dir, { recursive: true })

  const mode = workflow === 'auto' ? (profile.photos?.length ? 'kontext' : 'sdxl') : workflow
  if (mode !== 'sdxl' && !profile.photos?.length) {
    throw new Error(`${mode} 워크플로우에는 profile.photos 레퍼런스 사진이 최소 1장 필요하다`)
  }
  const isGemini = mode === 'gemini' // 전 단계 gemini
  const geminiPortraits = isGemini || mode === 'hybrid' // 포트레이트(+성별 감지)만 gemini
  const useComfy = !isGemini // kontext·sdxl·hybrid(장면)
  // Gemini는 픽셀 크기 대신 종횡비로 지정한다 — 현재 규격(장면 1344×768, 포트레이트 832×1152)에
  // 가장 가까운 비율로 고정 매핑. imageSize 2K면 장면 약 2048×1152가 나온다.
  const geminiAspect = { scene: '16:9', portrait: '3:4' }
  const imageSize = gemini.imageSize || '2K'
  // 역할별 모델 분리: 포트레이트는 gemini.model(pro — 정체성·나이 변환 품질),
  // 장면은 gemini.sceneModel(기본 flash — 장당 비용 절감). 없으면 포트레이트 모델을 같이 쓴다.
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
  const priorPortraits = new Map((prior?.agePortraits || []).map((p) => [p.age, p]))
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
  const gclient = geminiPortraits
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
    ...(geminiPortraits
      ? { gemini: { model: gclient.model, ...(isGemini ? { sceneModel } : {}), imageSize } }
      : {}),
    // 사진 바이너리는 제외하고 경로만 기록
    profile: { ...profile, photos: profile.photos || [] },
    images: []
  }
  const writeManifest = () => fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))

  try {
    if (useComfy) await client.ping()
    if (geminiPortraits) await gclient.ping()

    // 레퍼런스 사진 준비 (첫 장을 인물 레퍼런스로 사용.
    // 나머지 사진 활용 — 나이대별 매칭, 다중 레퍼런스 — 은 향후 확장 지점).
    // ComfyUI 쪽은 업로드해서 이름으로, gemini 쪽은 요청마다 base64 inline이라 Buffer로 들고 있는다.
    let referenceImage = null // ComfyUI: 업로드된 이미지 이름
    let referenceBuffer = null // gemini: 원본 사진 Buffer
    if (mode !== 'sdxl') {
      const photoPath = profile.photos[0]
      const buf = await fs.readFile(photoPath)
      manifest.referenceImage = { local: photoPath }
      if (geminiPortraits) referenceBuffer = buf
      if (useComfy) {
        const uploaded = await client.uploadImage(buf, `${pid}-ref${path.extname(photoPath) || '.png'}`)
        referenceImage = uploaded.name
        manifest.referenceImage.uploaded = uploaded.name
        onProgress({ type: 'upload', file: uploaded.name })
      }
    }

    // 성별: 프로필에 없으면 레퍼런스 사진에서 자동 감지한다(프로필당 1회 —
    // gemini·hybrid는 Gemini 캡션, kontext는 ComfyUI 태거/캡션. gender-detect.js 참조).
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
        const det = geminiPortraits
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

    // 2단계 파이프라인의 1단계: 나이별 포트레이트 (Flash Back의 Age Profiles 상당).
    // 각 생애 단계마다 원본 레퍼런스에서 나이만 옮긴 포트레이트를 만들어 캐시하고,
    // 그 단계의 장면 생성은 이 포트레이트를 레퍼런스로 쓴다.
    // stageIndex → 장면 생성이 레퍼런스로 쓸 포트레이트.
    // 장면이 ComfyUI로 돌면 업로드된 이미지 이름, gemini로 돌면 이미지 Buffer.
    const stageRefs = new Map()
    manifest.agePortraits = []
    // 재개: 파일이 남아 있는 기존 포트레이트를 미리 승계한다 (검토 상태 보존).
    // 장면이 전부 재개돼 ensureStageRef가 안 불려도 포트레이트가 manifest에서 빠지지 않는다.
    for (const [, prev] of priorPortraits) {
      if (await fileExists(path.join(dir, prev.file))) manifest.agePortraits.push(prev)
    }
    async function ensureStageRef(item) {
      if (!stagePortraits) return isGemini ? referenceBuffer : referenceImage
      if (stageRefs.has(item.stageIndex)) return stageRefs.get(item.stageIndex)
      const localFile = path.join(dir, `age-${item.age}.png`)
      // 재개: 이전 실행의 포트레이트를 그대로 이 단계 레퍼런스로 사용 (재생성·재과금 없음)
      if (priorPortraits.has(item.age) && (await fileExists(localFile))) {
        const data = await fs.readFile(localFile)
        const stageRef = isGemini
          ? data
          : (await client.uploadImage(data, `${pid}-age-${item.age}.png`)).name
        stageRefs.set(item.stageIndex, stageRef)
        return stageRef
      }
      const seed = geminiPortraits ? null : randomSeed() // Gemini는 시드 제어가 없다
      const prompt = composeAgePortraitPrompt(profile, item.age)
      onProgress({ type: 'portrait-start', age: item.age })
      let promptId = null
      let stageRef
      if (geminiPortraits) {
        const data = await gclient.generateImage({
          prompt,
          references: [referenceBuffer],
          aspectRatio: geminiAspect.portrait,
          imageSize
        })
        await fs.writeFile(localFile, data)
        if (isGemini) {
          stageRef = data // 다음 요청에 inline으로 그대로 재사용
        } else {
          // hybrid: 장면은 ComfyUI(kontext)가 그리므로 포트레이트를 입력으로 업로드
          const uploaded = await client.uploadImage(data, `${pid}-age-${item.age}.png`)
          stageRef = uploaded.name
        }
      } else {
        const wf = buildKontextWorkflow({
          prompt,
          referenceImage,
          width: 832, // 포트레이트는 세로 구도
          height: 1152,
          seed,
          filenamePrefix: `chrono-zoetrope/${pid}/age-${item.age}`
        })
        const out = await client.generate(wf)
        promptId = out.promptId
        await fs.writeFile(localFile, out.images[0].data)
        // 생성된 포트레이트를 입력으로 재업로드해 이 단계의 레퍼런스로 삼는다
        const uploaded = await client.uploadImage(out.images[0].data, `${pid}-age-${item.age}.png`)
        stageRef = uploaded.name
      }
      stageRefs.set(item.stageIndex, stageRef)
      manifest.agePortraits.push({
        age: item.age,
        prompt,
        seed,
        promptId,
        file: `age-${item.age}.png`,
        status: 'pending' // 검토 상태: pending → approved | rejected (admin 페이지에서 판정)
      })
      await writeManifest()
      onProgress({ type: 'portrait-done', age: item.age, file: localFile })
      return stageRef
    }

    for (let i = 0; i < plan.length; i++) {
      const item = plan[i]
      const seed = isGemini ? null : randomSeed()
      // 장면 프롬프트: gemini는 헤어·복장을 장면 맥락에 맞추는 전용 프롬프트,
      // kontext(hybrid 포함)는 검증된 기존 지시형 프롬프트를 쓴다.
      const prompt =
        mode === 'sdxl'
          ? composeSdxlPrompt(profile, item)
          : isGemini
            ? composeGeminiScenePrompt(profile, item)
            : composeKontextPrompt(profile, item)
      const localFile = path.join(dir, `${item.id}.png`)

      // 재개: 이전 실행에서 이미 만든 장면은 건너뛴다 (검토 상태 포함 그대로 승계)
      const prev = priorImages.get(item.id)
      if (prev && (await fileExists(localFile))) {
        manifest.images.push(prev)
        await writeManifest()
        onProgress({ type: 'image-done', done: i + 1, total: plan.length, item, file: localFile, resumed: true })
        continue
      }

      let promptId = null
      let t0
      if (isGemini) {
        const stageRef = await ensureStageRef(item)
        onProgress({ type: 'image-start', done: i, total: plan.length, item })
        t0 = Date.now()
        const data = await gclient.generateImage({
          prompt,
          references: [stageRef],
          aspectRatio: geminiAspect.scene,
          imageSize,
          model: sceneModel
        })
        await fs.writeFile(localFile, data)
      } else {
        const wf =
          mode !== 'sdxl' // kontext·hybrid — hybrid 장면도 kontext가 그린다
            ? buildKontextWorkflow({
                prompt,
                referenceImage: await ensureStageRef(item),
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

        onProgress({ type: 'image-start', done: i, total: plan.length, item })
        t0 = Date.now()
        const out = await client.generate(wf, {
          onProgress: (p) => onProgress({ type: 'image-progress', item, ...p })
        })
        promptId = out.promptId
        await fs.writeFile(localFile, out.images[0].data)
      }

      manifest.images.push({
        ...item,
        prompt,
        seed,
        promptId,
        file: `${item.id}.png`,
        elapsedMs: Date.now() - t0,
        status: 'pending' // 검토 상태: pending → approved | rejected. 노출은 approved만.
      })
      await writeManifest() // 장마다 기록 — 중단돼도 진행분은 남는다
      onProgress({ type: 'image-done', done: i + 1, total: plan.length, item, file: localFile })
    }
  } finally {
    client?.close()
    await writeManifest().catch(() => {})
  }

  return { personaId: pid, dir, manifest }
}
