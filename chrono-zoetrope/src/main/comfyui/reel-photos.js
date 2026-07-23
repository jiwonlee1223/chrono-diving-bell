// reel 전용 사진 생성 — 파노라마(영상 생성용)와 분리된 두 번째 백그라운드 생성 플로우.
//
// reel(주마등 회전 국면)은 이제 가로형(4:3) 일반 사진 12장을 필름스트립처럼 이어 돌린다.
// 나이는 기억이 시작되는 3살부터 현재 나이까지 균등 12개(사용자마다 다름 — 어린 사용자는
// 나이 중복 허용, 장면은 다르게). 모든 나이가 과거(≤현재)라 미래를 단정하지 않는다(§1).
//
// 얼굴 앵커: 파노라마의 2단계 aged 앵커(aged-anchor.js)가 필요 없다 — 일반 비율 근접 프레임은
// pro가 "정체성 보존 + 나이 변환"을 한 번에 해내는 조건(그 모듈 상단 주석의 전제)이라
// 단일 패스로 간다. 규칙은 face-anchor.js 접두어를 재사용한다:
//   (1) 그 나이의 실제 제출 사진(stageRef, life-graph) → REFERENCE_PHOTO_PREFIX ('stage')
//   (2) 현재 얼굴(faceRef) → ageAnchorPrefix(isPast=true, "그 나이 모습으로") ('anchor')
//   (3) 아동 de-age가 IMAGE_SAFETY로 거부되면 레퍼런스 없이 텍스트-only 1회 폴백 ('none')
//
// manifest 기록: manifest.json의 reelPhotos 배열만 병합 기록한다(파노라마 패스와 같은 파일 공유
// — life-library.js가 manifest를 새로 구성할 때 reelPhotos를 carry-over 한다). 장마다 저장 +
// onManifest(정본 upsert)로 원격 실시간 보기를 지원하고, 재실행 시 성공 장은 건너뛴다(resume).

import fs from 'node:fs/promises'
import path from 'node:path'
import {
  reelAges,
  reelSceneForAge,
  composeReelPhotoPrompt,
  personaId as derivePersonaId
} from './prompt-builder.js'
import { REFERENCE_PHOTO_PREFIX, ageAnchorPrefix } from './face-anchor.js'
import { AGES as STAGE_AGES, AGE_TO_STAGE } from './life-graph-plan.js'

// persona 디렉토리 하위, reel 사진 폴더. '_' 접두라 library-loader(몽타주 재생목록) 스캔에 안 잡힌다.
export const REEL_DIR = '_reel'

// reel 나이에 가장 가까운 STAGES 기준 나이(3·7·…·82) — ageScenes(life-graph 합성 결과) 키 조회
// 및 그 나이 실제 사진(stageId) 앵커 조회에 쓴다.
function nearestStageAge(age) {
  let best = STAGE_AGES[0]
  for (const a of STAGE_AGES) if (Math.abs(a - age) < Math.abs(best - age)) best = a
  return best
}

/**
 * reel 사진 플랜 — 나이 배열(3~현재, 균등 count개)마다 장면 1개.
 * 장면 소스: ageScenes(life-graph 합성, STAGES 나이 키)가 있으면 가장 가까운 나이 키의 문구를
 * 결정론적으로 고르고, 없으면 STAGES 감각 재료 풀 폴백(reelSceneForAge). 같은 나이가 중복돼도
 * idx가 시드에 들어가 다른 장면이 나온다. 시대(연대)는 프롬프트 단(composeReelPhotoPrompt)에서 입힌다.
 *
 * @param {object} profile  { name, birthDate, occupation? }
 * @param {object} [opts]
 * @param {number} [opts.count=12] @param {number} [opts.startAge=3]
 * @param {Record<number,string[]>|null} [opts.ageScenes]  synthesizeAgeScenes() 결과(life-graph)
 * @param {Date}   [opts.now]
 * @returns {Array<{idx:number, id:string, age:number, year:number, isPast:true, scene:string, stageAge:number, stageId:string}>}
 */
export function buildReelPhotoPlan(
  profile,
  { count = 12, startAge = 3, ageScenes = null, now = new Date() } = {}
) {
  const birthYear = parseInt(String(profile.birthDate).slice(0, 4), 10)
  if (!Number.isFinite(birthYear))
    throw new Error(`birthDate 형식이 잘못됨: ${profile.birthDate} (YYYY-MM-DD)`)
  const currentAge = Math.max(0, now.getFullYear() - birthYear)
  const ages = reelAges(currentAge, { count, startAge })

  // 어린 사용자는 같은 단계(stageAge)에 여러 장이 몰린다 — 단계 풀 안에서 이미 쓴 장면을 피해
  // 다양성을 유지한다(풀이 바닥나면 중복 허용). 결정론(시드 변형도 결정론적)은 그대로다.
  const usedByStage = new Map()
  return ages.map((age, i) => {
    const idx = i + 1
    const stageAge = nearestStageAge(age)
    const seed = `${profile.name}|${profile.birthDate}|reel|${idx}`
    // life-graph 합성 장면이 그 단계에 있으면 그중 하나를 idx 시드로 결정론 선택, 없으면 STAGES 폴백.
    let scene
    const synth = ageScenes?.[stageAge]
    if (synth?.length) {
      scene = synth[idx % synth.length]
    } else {
      const used = usedByStage.get(stageAge) || usedByStage.set(stageAge, new Set()).get(stageAge)
      for (let t = 0; t < 6; t++) {
        scene = reelSceneForAge(age, `${seed}|${t}`)
        if (!used.has(scene)) break
      }
      used.add(scene)
      scene = scene.replaceAll('{occ}', profile.occupation || 'worker')
    }
    return {
      idx,
      id: `r-${idx}`,
      age,
      year: birthYear + age,
      isPast: true,
      scene,
      stageAge,
      stageId: AGE_TO_STAGE[stageAge]
    }
  })
}

/**
 * reel 사진 12장 생성 — concurrency장씩 동시(Gemini API 병렬 호출), 장별 재시도·resume·중지(signal)
 * 지원. 실패 장은 failed로 남기고 계속한다(호출부는 best-effort — 전체 실패해도 파노라마 생성을
 * 막지 않는다). manifest 기록은 내부 뮤텍스로 직렬화해 병렬 생성 중에도 안전하다.
 *
 * @param {object} p
 * @param {Array}  p.plan        buildReelPhotoPlan() 결과
 * @param {object} p.profile     { name, birthDate, gender?, descriptors? }
 * @param {string} p.personaDir  library/<pid> 절대경로
 * @param {import('./gemini-client.js').GeminiClient} p.gclient  pro 모델 클라이언트
 * @param {string} [p.model]     pro 모델 id (미지정이면 gclient 기본)
 * @param {string} [p.imageSize] '1K'|'2K'|'4K'
 * @param {number} [p.concurrency=3]  동시 생성 장 수(Gemini 쿼터 고려 — config.reelPhotos.concurrency)
 * @param {{buffer:Buffer, path:string}|null} [p.faceRef]  현재 얼굴 앵커
 * @param {((item:object)=>({buffer:Buffer, path:string}|null))|null} [p.stageRefFor]
 *        그 장면 단계의 실제 제출 사진(life-graph) — 있으면 최우선 앵커.
 * @param {number} [p.retries=1]  장별 추가 재시도 횟수
 * @param {AbortSignal} [p.signal]
 * @param {(m:string)=>void} [p.log]
 * @param {(manifest:object)=>Promise} [p.onManifest]  장마다 정본(Firebase) upsert — best-effort
 * @returns {Promise<{reelPhotos:Array, okCount:number, failedCount:number, cancelled:boolean}>}
 */
export async function generateReelPhotos({
  plan,
  profile,
  personaDir,
  gclient,
  model,
  imageSize = '2K',
  aspectRatio = '4:3', // 가로형(가로가 더 긴) 스냅사진 — config.reelPhotos.aspectRatio로 override
  concurrency = 3,
  faceRef = null,
  stageRefFor = null,
  retries = 1,
  signal,
  log = () => {},
  onManifest
}) {
  const manifestPath = path.join(personaDir, 'manifest.json')
  await fs.mkdir(path.join(personaDir, REEL_DIR), { recursive: true })

  // manifest 병합 기록 — reelPhotos 배열만 소유한다. 파일이 없으면(reel 우선 생성) 최소 골격 생성.
  const readManifest = async () => {
    try {
      return JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    } catch {
      return {
        personaId: derivePersonaId(profile),
        createdAt: new Date().toISOString(),
        profile: { ...profile, photos: profile.photos || [] },
        images: []
      }
    }
  }
  const prior = new Map(((await readManifest()).reelPhotos || []).map((e) => [e.id, e]))
  const results = new Map() // id → entry (병렬 완료 순서와 무관하게 plan 순서로 기록·반환)
  // 병렬 워커들이 장마다 호출한다 — read-modify-write 경합이 없도록 뮤텍스 체인으로 직렬화.
  let writing = Promise.resolve()
  const writeManifest = () => {
    const run = writing.then(async () => {
      const manifest = await readManifest() // 파노라마 패스와 파일을 공유하므로 매번 다시 읽어 병합한다
      // 이번 실행 entry가 같은 id의 이전 entry를 대체하고, 아직 도달 못 한 이전 entry는 보존(plan 순서 유지).
      const byId = new Map((manifest.reelPhotos || []).map((e) => [e.id, e]))
      for (const [id, e] of results) byId.set(id, e)
      manifest.reelPhotos = plan.map((p) => byId.get(p.id)).filter(Boolean)
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
      if (onManifest) {
        try {
          await onManifest(manifest)
        } catch {
          /* 정본 동기화 실패는 무시 — 다음 장에서 재시도된다 */
        }
      }
    })
    writing = run.catch(() => {})
    return run
  }

  const fileExists = (f) =>
    fs.access(f).then(
      () => true,
      () => false
    )

  let okCount = 0
  let failedCount = 0
  let cancelled = false

  // 장 하나 처리 — 기존 직렬 루프의 본문. 아래 병렬 워커 풀이 plan 인덱스를 나눠 호출한다.
  async function processItem(item) {
    const fileRel = path.posix.join(REEL_DIR, `${item.id}-age${item.age}.png`)
    const fileAbs = path.join(personaDir, fileRel)

    // resume: 이전 실행에서 성공한 장은 건너뛴다.
    const prev = prior.get(item.id)
    if (prev && !prev.failed && (await fileExists(path.join(personaDir, prev.file)))) {
      results.set(item.id, prev)
      okCount++
      return
    }

    // 레퍼런스 규칙 (face-anchor.js 접두어 재사용, 단일 패스)
    const stageRef = stageRefFor ? stageRefFor(item) : null
    let reference = null
    let prefix = ''
    let kind = 'none'
    if (stageRef) {
      reference = stageRef
      prefix = REFERENCE_PHOTO_PREFIX
      kind = 'stage'
    } else if (faceRef) {
      reference = faceRef
      prefix = ageAnchorPrefix(item)
      kind = 'anchor'
    }
    const basePrompt = composeReelPhotoPrompt(profile, item)

    const t0 = Date.now()
    let ok = false
    let lastErr = null
    let usedKind = kind
    let usedPrompt = prefix + basePrompt
    for (let attempt = 0; attempt <= retries && !ok; attempt++) {
      if (signal?.aborted) {
        cancelled = true
        break
      }
      try {
        const data = await gclient.generateImage({
          prompt: usedPrompt,
          references: reference ? [reference.buffer] : [],
          aspectRatio,
          imageSize,
          model, // pro — 일반 비율(4:3 등)은 pro가 지원한다(거부되는 건 4:1·8:1 초광각뿐)
          signal
        })
        await fs.writeFile(fileAbs, data)
        ok = true
      } catch (err) {
        if (signal?.aborted) {
          cancelled = true
          break
        }
        lastErr = err
        // 아동 de-age 등 안전 필터 거부 → 레퍼런스를 떼고 텍스트-only로 한 번 더(추가 시도 소모 없이 전환).
        if (reference && /IMAGE_SAFETY|safety/i.test(String(err.message))) {
          log(`  ⚠ reel ${item.id}(${item.age}세) 안전 필터 — 레퍼런스 없이 재시도`)
          reference = null
          usedKind = 'none'
          usedPrompt = basePrompt
          attempt-- // 폴백 전환은 재시도 횟수에서 빼준다
        }
      }
    }
    if (cancelled) {
      await fs.rm(fileAbs, { force: true }).catch(() => {}) // 반쯤 써진 파일 정리 — 진행분은 manifest에 남는다
      return
    }

    const entry = {
      idx: item.idx,
      id: item.id,
      age: item.age,
      year: item.year,
      isPast: true,
      scene: item.scene,
      prompt: usedPrompt,
      file: fileRel,
      referenceKind: usedKind,
      ...(reference?.path ? { referenceFile: reference.path } : {}),
      elapsedMs: Date.now() - t0
    }
    if (ok) {
      okCount++
    } else {
      failedCount++
      entry.failed = true
      await fs.rm(fileAbs, { force: true }).catch(() => {})
      log(`  ✗ reel ${item.id}(${item.age}세) 실패: ${lastErr?.message}`)
    }
    results.set(item.id, entry)
    await writeManifest() // 장마다 기록 — 중단돼도 진행분은 남는다
    if (ok)
      log(
        `  📷 reel ${item.idx}/${plan.length} — ${item.age}세 (${((Date.now() - t0) / 1000).toFixed(1)}s)`
      )
  }

  // 워커 풀 — concurrency명이 plan 인덱스를 순서대로 집어 간다(Gemini API 병렬 호출, 중지 시 즉시 이탈).
  let nextIdx = 0
  const poolSize = Math.max(1, Math.min(concurrency, plan.length))
  await Promise.all(
    Array.from({ length: poolSize }, async () => {
      while (nextIdx < plan.length) {
        if (signal?.aborted) {
          cancelled = true
          return
        }
        const item = plan[nextIdx++]
        await processItem(item)
      }
    })
  )

  const reelPhotos = plan.map((p) => results.get(p.id)).filter(Boolean)
  if (reelPhotos.length) await writeManifest().catch(() => {})
  return { reelPhotos, okCount, failedCount, cancelled }
}
