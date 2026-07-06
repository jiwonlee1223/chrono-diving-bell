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
import { buildKontextWorkflow, buildSdxlWorkflow, randomSeed } from './workflows.js'
import {
  buildScenePlan,
  composeAgePortraitPrompt,
  composeKontextPrompt,
  composeSdxlPrompt,
  personaId
} from './prompt-builder.js'

/**
 * @param {object} profile  prompt-builder.js 상단의 스키마 참조
 * @param {object} opts
 * @param {string}  opts.host       ComfyUI 주소
 * @param {string}  opts.outDir     라이브러리 루트 (personaId 하위 디렉토리가 생긴다)
 * @param {string}  opts.workflow   'auto' | 'kontext' | 'sdxl' — auto는 사진 있으면 kontext
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
    onProgress = () => {}
  } = opts

  const pid = personaId(profile)
  const dir = path.join(outDir, pid)
  await fs.mkdir(dir, { recursive: true })

  const mode = workflow === 'auto' ? (profile.photos?.length ? 'kontext' : 'sdxl') : workflow
  if (mode === 'kontext' && !profile.photos?.length) {
    throw new Error('kontext 워크플로우에는 profile.photos 레퍼런스 사진이 최소 1장 필요하다')
  }

  const fullPlan = buildScenePlan(profile, { perStage })
  const plan = fullPlan.slice(0, Math.min(limit, fullPlan.length))
  onProgress({ type: 'plan', total: plan.length })

  const client = new ComfyUIClient({ host, timeoutMs })
  const manifest = {
    personaId: pid,
    createdAt: new Date().toISOString(),
    workflow: mode,
    image,
    // 사진 바이너리는 제외하고 경로만 기록
    profile: { ...profile, photos: profile.photos || [] },
    images: []
  }
  const manifestPath = path.join(dir, 'manifest.json')
  const writeManifest = () => fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))

  try {
    await client.ping()

    // 레퍼런스 사진 업로드 (첫 장을 인물 레퍼런스로 사용.
    // 나머지 사진 활용 — 나이대별 매칭, ImageStitch 다중 레퍼런스 — 은 향후 확장 지점).
    let referenceImage = null
    if (mode === 'kontext') {
      const photoPath = profile.photos[0]
      const buf = await fs.readFile(photoPath)
      const uploaded = await client.uploadImage(buf, `${pid}-ref${path.extname(photoPath) || '.png'}`)
      referenceImage = uploaded.name
      manifest.referenceImage = { local: photoPath, uploaded: uploaded.name }
      onProgress({ type: 'upload', file: uploaded.name })
    }

    // 2단계 파이프라인의 1단계: 나이별 포트레이트 (Flash Back의 Age Profiles 상당).
    // 각 생애 단계마다 원본 레퍼런스에서 나이만 옮긴 포트레이트를 만들어 캐시하고,
    // 그 단계의 장면 생성은 이 포트레이트를 레퍼런스로 쓴다.
    const stageRefs = new Map() // stageIndex → 업로드된 이미지 이름
    manifest.agePortraits = []
    async function ensureStageRef(item) {
      if (!stagePortraits) return referenceImage
      if (stageRefs.has(item.stageIndex)) return stageRefs.get(item.stageIndex)
      const seed = randomSeed()
      const prompt = composeAgePortraitPrompt(profile, item.age)
      onProgress({ type: 'portrait-start', age: item.age })
      const wf = buildKontextWorkflow({
        prompt,
        referenceImage,
        width: 832, // 포트레이트는 세로 구도
        height: 1152,
        seed,
        filenamePrefix: `chrono-zoetrope/${pid}/age-${item.age}`
      })
      const { promptId, images } = await client.generate(wf)
      const localFile = path.join(dir, `age-${item.age}.png`)
      await fs.writeFile(localFile, images[0].data)
      // 생성된 포트레이트를 입력으로 재업로드해 이 단계의 레퍼런스로 삼는다
      const uploaded = await client.uploadImage(images[0].data, `${pid}-age-${item.age}.png`)
      stageRefs.set(item.stageIndex, uploaded.name)
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
      return uploaded.name
    }

    for (let i = 0; i < plan.length; i++) {
      const item = plan[i]
      const seed = randomSeed()
      const prompt = mode === 'kontext' ? composeKontextPrompt(profile, item) : composeSdxlPrompt(profile, item)
      const wf =
        mode === 'kontext'
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
      const t0 = Date.now()
      const { promptId, images } = await client.generate(wf, {
        onProgress: (p) => onProgress({ type: 'image-progress', item, ...p })
      })
      const localFile = path.join(dir, `${item.id}.png`)
      await fs.writeFile(localFile, images[0].data)

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
    client.close()
    await writeManifest().catch(() => {})
  }

  return { personaId: pid, dir, manifest }
}
