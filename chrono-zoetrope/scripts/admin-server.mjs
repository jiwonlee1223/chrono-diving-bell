#!/usr/bin/env node
// 생애 라이브러리 검토(admin) 서버 — 의존성 제로 (node:http).
//
//   node scripts/admin-server.mjs [--port 8787] [--library <dir>] [--view-only]
//
// --view-only: 검토·모니터링 전용. 자동 생성과 고아 복구를 하지 않는다 —
//   생성은 별도 워커(npm run worker:listen)가 담당하는 운용에서 사용.
//   (view-only가 아닌 admin과 워커를 동시에 띄우면 서로의 generating을 리셋해
//   중복 생성이 날 수 있다 — 동시 운용은 반드시 view-only로.)
//
// 역할:
//   - admin/index.html 검토 UI 서빙
//   - 라이브러리 이미지·manifest 조회 API
//   - 문제 장 재생성 (현재 prompt-builder로 프롬프트를 재조립해 다시 생성)
//   - 장면 피드 제공 (/api/personas/{pid}/approved) — 노출 단(threads-prototype 등)이 소비.
//
// 검토 모델: 별도 승인 절차 없음 — 생성된 장은 전부 기본 노출이고,
// 문제가 있는 장만 어드민에서 재생성해 그 자리에서 교체한다.

import http from 'node:http'
import fs from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComfyUIClient } from '../src/main/comfyui/client.js'
import {
  GeminiClient,
  resolveGeminiApiKey,
  resolveGeminiConfig,
  nearestGeminiAspect
} from '../src/main/comfyui/gemini-client.js'
import {
  buildKontextWorkflow,
  buildSdxlWorkflow,
  buildGeminiSeamFixWorkflow,
  randomSeed
} from '../src/main/comfyui/workflows.js'
import {
  initFirebase,
  listenProfiles,
  resetOrphanGenerating,
  resetOrphanLifeGraphGenerating,
  updateProfileFields,
  uploadPersonaVideos,
  ensureLocalClipsFromFirebase,
  ensurePersonaMediaFromFirebase,
  fetchPersonaVideos,
  upsertPersonaManifest,
  fetchPersonaManifest,
  listAllPersonasFromFirebase
} from '../src/main/comfyui/firestore-source.js'
import { recoverClipsFromComfy } from '../src/main/comfyui/recover-clips.js'
import { processProfile, processLifeGraphSession } from '../src/main/comfyui/profile-worker.js'
import { composeScenePromptFor, personaId, SEAM_BAND_PROMPT } from '../src/main/comfyui/prompt-builder.js'
import { readSession, writeSession, clearSession } from '../src/main/session-pointer.js'
import { VideoRegenerator } from '../src/main/comfyui/video-cache.js'
import { ReelBuilder } from '../src/main/comfyui/reel-builder.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(
  await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8')
)
config.gemini = resolveGeminiConfig(config.gemini, root) // apiKeyPath를 절대경로로
// 몽타주/릴/영상 재생성 설정 (릴 빌드가 쓴다).
const montage = JSON.parse(
  await fs.readFile(path.join(root, 'src/main/config/montage.json'), 'utf-8')
)
// Seedance(API 노드) 키 — seedance-flf 모드에서 클립 생성에 필요. 없으면 생성 시 에러로 안내.
const COMFY_API_KEY = montage.regen?.seedance?.apiKeyPath
  ? await fs.readFile(path.resolve(root, montage.regen.seedance.apiKeyPath), 'utf-8').then((s) => s.trim()).catch(() => null)
  : null

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const PORT = parseInt(argOf('--port', '8787'), 10)
const LIBRARY = path.resolve(root, argOf('--library', config.outDir))
const VIEW_ONLY = args.includes('--view-only')

// ── manifest 입출력 ────────────────────────────────────────────────
async function readManifest(pid) {
  const p = path.join(LIBRARY, pid, 'manifest.json')
  return JSON.parse(await fs.readFile(p, 'utf-8'))
}
async function writeManifest(pid, manifest) {
  await fs.writeFile(path.join(LIBRARY, pid, 'manifest.json'), JSON.stringify(manifest, null, 2))
  // Firebase 정본 동기화 — 생성/재생성/성별수정이 전부 이 함수를 지나므로 여기 한 곳이면 커버된다.
  // 실패해도 로컬 저장은 유지(정본 동기화는 best-effort). 다른 머신에서 hydrate로 복원된다.
  if (firebaseReady) {
    try {
      await upsertPersonaManifest(manifest)
    } catch (err) {
      logAction(`manifest 정본 동기화 실패 (${pid}): ${err.message}`)
    }
  }
}

// ── Firebase 정본 ↔ 로컬 캐시: 사용자 리스트 합집합 + 하이드레이션 ──────────
// 어드민을 이식 가능하게 만드는 핵심. 로컬 library 는 캐시일 뿐이고, 정본은 Firebase에 있다.
// 다른 머신에서 처음 열면 로컬이 비어 있어도 Firebase 명단이 뜨고, 필요 시 hydrate 로 복원한다.

const localPersonaExists = (pid) => existsSync(path.join(LIBRARY, pid, 'manifest.json'))

/** Firebase 전체 명단 + 내부 personaId 보강(정본 문서에 없던 profiles-only 항목은 이름/생년월일로 계산). */
async function firebasePersonaList() {
  const list = await listAllPersonasFromFirebase()
  for (const p of list) {
    if (!p.personaId && p.name && p.birthDate) {
      p.personaId = personaId({ name: p.name, birthDate: p.birthDate })
    }
  }
  return list
}

/**
 * Firebase 정본에서 로컬 library/{pid} 를 복원한다(manifest + 미디어).
 * @param {string} docKey  '이름_생년월일6자'
 * @returns {Promise<{ pid:string, images:number, reel:boolean, missing:string[] }>}
 */
async function hydratePersona(docKey) {
  if (!firebaseReady) throw new Error('Firebase 미연결')
  const manifest = await fetchPersonaManifest(docKey)
  if (!manifest) throw new Error(`Firebase에 manifest 정본이 없다: ${docKey}`)
  const pid = manifest.personaId
  if (!pid) throw new Error(`manifest에 personaId가 없다: ${docKey}`)
  const dir = path.join(LIBRARY, pid)
  await fs.mkdir(dir, { recursive: true })
  await writeManifestLocalOnly(pid, manifest) // 정본에서 받은 걸 다시 정본에 쓰지 않게 로컬만 저장
  const media = await ensurePersonaMediaFromFirebase(manifest.profile, dir).catch((e) => {
    logAction(`hydrate 미디어 일부 실패 (${pid}): ${e.message}`)
    return { images: 0, reel: false, missing: [] }
  })
  return { pid, ...media }
}

/** writeManifest 의 로컬 전용판 — hydrate 는 이미 정본에서 받은 것이라 정본에 되쓰지 않는다. */
async function writeManifestLocalOnly(pid, manifest) {
  await fs.mkdir(path.join(LIBRARY, pid), { recursive: true })
  await fs.writeFile(path.join(LIBRARY, pid, 'manifest.json'), JSON.stringify(manifest, null, 2))
}

/**
 * pid 로 로컬 manifest 를 보장한다. 로컬에 있으면 그대로, 없으면 Firebase 명단에서 docKey 를 찾아 hydrate.
 * @returns {Promise<boolean>} true=로컬에 준비됨, false=Firebase에도 없음
 */
async function ensurePersonaLocal(pid) {
  if (localPersonaExists(pid)) return true
  if (!firebaseReady) return false
  const entry = (await firebasePersonaList()).find((p) => p.personaId === pid)
  if (!entry || !entry.hasManifest) return false
  await hydratePersona(entry.docKey)
  return localPersonaExists(pid)
}

// ── 재생성: 현재 prompt-builder 기준으로 프롬프트를 재조립해 다시 굴린다 ──
// (프롬프트 풀이 개편되면 재생성부터 바로 반영된다. 장면 문구(item.scene)는
//  플랜 시드에 고정된 재료라 그대로 쓴다. 구버전 manifest — 포트레이트 2단계 시절 —
//  의 장도 같은 규칙으로 원본 레퍼런스 기준 뒷모습 프롬프트로 재생성된다.)
async function regenerate(pid, id) {
  const manifest = await readManifest(pid)
  const entry = (manifest.images || []).find((img) => img.id === id)
  if (!entry) throw new Error(`항목 없음: ${id}`)

  const wf = manifest.workflow
  entry.prompt = composeScenePromptFor(wf, manifest.profile, entry)

  if (wf === 'gemini') return regenerateGemini(pid, manifest, entry)
  if (wf === 'seamfix') return regenerateSeamfix(pid, manifest, entry)

  const client = new ComfyUIClient({ host: config.host, timeoutMs: config.timeoutMs })
  try {
    const seed = randomSeed()
    let graph
    if (wf !== 'sdxl') {
      // kontext — 레퍼런스는 원본 프로필 사진 (뒷모습 구도라 포트레이트 단계가 없다)
      const buf = await fs.readFile(manifest.referenceImage.local)
      const uploaded = await client.uploadImage(buf, `${pid}-regen-ref.png`)
      graph = buildKontextWorkflow({
        prompt: entry.prompt,
        referenceImage: uploaded.name,
        width: manifest.image.width,
        height: manifest.image.height,
        seed,
        filenamePrefix: `chrono-zoetrope/${pid}/${path.basename(entry.file, '.png')}`
      })
    } else {
      graph = buildSdxlWorkflow({
        prompt: entry.prompt,
        width: manifest.image.width,
        height: manifest.image.height,
        seed,
        filenamePrefix: `chrono-zoetrope/${pid}/${path.basename(entry.file, '.png')}`
      })
    }

    const t0 = Date.now()
    const { promptId, images } = await client.generate(graph)
    await fs.writeFile(path.join(LIBRARY, pid, entry.file), images[0].data)

    entry.seed = seed
    entry.promptId = promptId
    entry.elapsedMs = Date.now() - t0
    entry.rev = (entry.rev || 0) + 1 // 클라이언트 캐시 버스팅용
    delete entry.failed // 재생성 성공 → failed 해제
    await writeManifest(pid, manifest)
    return { entry }
  } finally {
    client.close()
  }
}

// Gemini 백엔드 재생성 — 시드 개념이 없어 확률만 다시 굴린다.
// 3인칭 부감 장면은 생성 때와 동일하게 레퍼런스 없이 순수 텍스트→이미지 (prompt-builder 주석 참조).
async function regenerateGemini(pid, manifest, entry) {
  const gclient = new GeminiClient({
    apiKey: await resolveGeminiApiKey(config.gemini),
    model: manifest.gemini?.model || config.gemini?.model,
    textModel: config.gemini?.textModel,
    timeoutMs: config.timeoutMs
  })

  const t0 = Date.now()
  const data = await gclient.generateImage({
    prompt: entry.prompt,
    references: [],
    aspectRatio: nearestGeminiAspect(manifest.image.width, manifest.image.height),
    imageSize: manifest.gemini?.imageSize || config.gemini?.imageSize || '2K',
    model: manifest.gemini?.sceneModel || config.gemini?.sceneModel || undefined
  })
  await fs.writeFile(path.join(LIBRARY, pid, entry.file), data)

  entry.seed = null
  entry.promptId = null
  entry.elapsedMs = Date.now() - t0
  entry.rev = (entry.rev || 0) + 1 // 클라이언트 캐시 버스팅용
  delete entry.failed // 재생성 성공 → failed 해제
  await writeManifest(pid, manifest)
  return { entry }
}

// seamfix 이음매 보정 단계만 — 주어진 Gemini 원본 버퍼를 업로드해 Flux Fill 워크플로우를 돌리고
// 보정본(-pano)을 장면 파일로 저장한다. regenerateSeamfix(재생성)와 reseam(재연결)이 공유한다.
async function applySeamFix(pid, manifest, entry, srcBuffer, client) {
  const uploaded = await client.uploadImage(srcBuffer, `${pid}-${entry.id}-src.png`)
  const seed = randomSeed()
  const graph = buildGeminiSeamFixWorkflow({
    referenceImage: uploaded.name,
    prompt: entry.prompt,
    bandPrompt: SEAM_BAND_PROMPT, // 이음매 띠에 인물 안 그리게(기괴함 방지)
    width: manifest.image.width,
    height: manifest.image.height,
    // 재생성은 현재 config.seamfix를 우선(운영 중 밴드폭 조정 반영), 없으면 생성 당시 manifest 값 → workflow 기본.
    bandWidth: config.seamfix?.bandWidth ?? manifest.seamfix?.bandWidth,
    feather: config.seamfix?.feather ?? manifest.seamfix?.feather,
    bandModel: manifest.seamfix?.bandModel || 'flux-fill',
    seed,
    filenamePrefix: `chrono-zoetrope/${pid}/${path.basename(entry.file, '.png')}`
  })
  const { promptId, images } = await client.generate(graph)
  const corrected = images.find((im) => /-pano_/.test(im.filename)) || images[0]
  await fs.writeFile(path.join(LIBRARY, pid, entry.file), corrected.data)
  return { promptId, seed }
}

// B안(seamfix) 재생성 — Gemini로 파노라마를 다시 뽑고(→ 원본 보관) Flux Fill로 이음매를 보정한다.
// (life-library.js seamfix 경로와 동일한 2단계. 보정본을 장면 파일로 교체한다.)
async function regenerateSeamfix(pid, manifest, entry) {
  const gclient = new GeminiClient({
    apiKey: await resolveGeminiApiKey(config.gemini),
    model: manifest.gemini?.model || config.gemini?.model,
    textModel: config.gemini?.textModel,
    timeoutMs: config.timeoutMs
  })
  const client = new ComfyUIClient({ host: config.host, timeoutMs: config.timeoutMs })
  try {
    const t0 = Date.now()
    const data = await gclient.generateImage({
      prompt: entry.prompt,
      references: [],
      // 파노라마 폭(manifest.image)에 맞는 Gemini 비율 — 4096×1024면 '4:1'. 보정 워크플로우가 그 크기로 정규화.
      aspectRatio: nearestGeminiAspect(manifest.image.width, manifest.image.height),
      imageSize: manifest.gemini?.imageSize || config.gemini?.imageSize || '2K',
      model: manifest.gemini?.sceneModel || config.gemini?.sceneModel || undefined
    })
    // 새 Gemini 원본 보관 → 이후 edge 재연결이 재생성 없이 이 원본으로 이음매만 다시 보정한다.
    const srcFile = `${path.basename(entry.file, '.png')}.src.png`
    await fs.writeFile(path.join(LIBRARY, pid, srcFile), data)
    entry.srcFile = srcFile

    const { promptId, seed } = await applySeamFix(pid, manifest, entry, data, client)
    entry.seed = seed
    entry.promptId = promptId
    entry.elapsedMs = Date.now() - t0
    entry.rev = (entry.rev || 0) + 1 // 클라이언트 캐시 버스팅용
    delete entry.failed // 재생성 성공 → failed 해제
    await writeManifest(pid, manifest)
    return { entry }
  } finally {
    client.close()
  }
}

// edge 재연결(seamfix 전용) — Gemini는 다시 만들지 않고, 보관된 원본으로 이음매 보정만 재실행한다.
// "Gemini는 만족스러운데 seamless 연결만 문제"일 때 값싸게(재과금 없이) 다시 붙인다.
async function reseam(pid, id) {
  const manifest = await readManifest(pid)
  const entry = (manifest.images || []).find((img) => img.id === id)
  if (!entry) throw new Error(`항목 없음: ${id}`)
  if (manifest.workflow !== 'seamfix')
    throw new Error('edge 재연결은 seamfix 워크플로우에서만 가능합니다')
  if (!entry.srcFile)
    throw new Error('보관된 Gemini 원본이 없습니다 (이 장 이전 버전) — 전체 재생성이 필요합니다')
  let srcBuffer
  try {
    srcBuffer = await fs.readFile(path.join(LIBRARY, pid, entry.srcFile))
  } catch {
    throw new Error('Gemini 원본 파일을 찾을 수 없습니다 — 전체 재생성이 필요합니다')
  }
  const client = new ComfyUIClient({ host: config.host, timeoutMs: config.timeoutMs })
  try {
    const t0 = Date.now()
    const { promptId, seed } = await applySeamFix(pid, manifest, entry, srcBuffer, client)
    entry.seed = seed
    entry.promptId = promptId
    entry.elapsedMs = Date.now() - t0
    entry.rev = (entry.rev || 0) + 1 // 클라이언트 캐시 버스팅용
    delete entry.failed
    await writeManifest(pid, manifest)
    return { entry }
  } finally {
    client.close()
  }
}

// ── HTTP 서버 ─────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.mp4': 'video/mp4'
}

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' })
  res.end(data)
}

// 영상 스트리밍 (Range 지원 — <video> 시킹). reel.mp4·videos/<id>.mp4 서빙에 쓴다.
async function serveFile(req, res, absPath, mime) {
  let stat
  try {
    stat = await fs.stat(absPath)
  } catch {
    return send(res, 404, { error: 'not found' })
  }
  const range = req.headers.range
  const base = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' }
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    const start = m && m[1] ? parseInt(m[1], 10) : 0
    const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
      return res.end()
    }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 })
    return createReadStream(absPath, { start, end }).pipe(res)
  }
  res.writeHead(200, { ...base, 'Content-Length': stat.size })
  createReadStream(absPath).pipe(res)
}
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
}

// 액션 로그 — 어떤 장을 언제 재생성했는지 터미널에 남긴다.
const HHMMSS = () => new Date().toTimeString().slice(0, 8)
function logAction(text) {
  console.log(`[${HHMMSS()}] ${text}`)
}

// ── 자동 생성 컨트롤러 (Firestore 큐 → 직렬 생성, 동시 1개) ─────────────
// collector 제출 큐를 구독하고, 유휴 상태면 가장 오래된 submitted를 자동 생성한다.
// 프로세스가 하나뿐이라 '동시 1개'는 current 플래그로 자연히 보장된다.
// generate-from-firestore.mjs 워커와 동일한 processProfile을 공유한다.
const saPath = config.firebase?.serviceAccountPath
  ? path.resolve(root, config.firebase.serviceAccountPath)
  : undefined

let firebaseReady = false
let profiles = [] // 최신 Firestore 스냅샷 (createdAt asc)
let autoOn = !VIEW_ONLY // 일시정지 토글 (view-only면 영구 OFF — /api/autogen에서도 켤 수 없다)
let current = null // 생성 중인 pid — 동시 1개 보장
let currentInfo = null // { pid, name, done, total, startedAt }
let lastResult = null // { pid, ok, error, at }
let currentAbort = null // 진행 중 이미지 생성 취소용 AbortController (중지 버튼)

const toMillis = (ts) => (ts && typeof ts.toMillis === 'function' ? ts.toMillis() : null)

// ── 주마등 영상 큐 (2단계: 클립 생성 → 릴 합성) — 이미지 큐(Gemini)와 독립·병렬 ──────
// 자동 트리거 없음. 연구자가 admin에서 버튼으로 단계별 실행한다:
//   kind='clips': 전 장면을 Wan 클립(videos/<id>.mp4)으로 생성 (오래 걸림, 일시정지/중단 가능).
//   kind='reel' : 사전 생성된 클립들을 크로스페이드로 90초 릴(reel.mp4)로 합성 (ffmpeg, 빠름).
// 클립은 4창 런타임 FREEZE가 그대로 재생하는 사전 생성물이다(전시 중 생성 없음).
let videoQueue = [] //      [{ pid, kind }]
let videoBuilding = null // 현재 빌드 중 { pid, kind } | null
let videoJob = null //      { pid, kind, phase, done, total, durationSec } 진행 상태
let videoLast = null //     { pid, kind, ok, cancelled, pauseKind, error, at }
let videoCancel = false //  현재 작업 중단 요청 (클립 사이에서 확인)
let videoCancelKind = 'stop' // 'pause' | 'stop' — 사용자에게 보여줄 라벨용

function enqueueVideo(pid, kind) {
  if (!pid) return
  const dup =
    videoQueue.some((v) => v.pid === pid && v.kind === kind) ||
    (videoBuilding?.pid === pid && videoBuilding?.kind === kind)
  if (dup) return
  videoQueue.push({ pid, kind })
  logAction(`영상 대기열 추가: ${kind} ${pid} (대기 ${videoQueue.length})`)
  pumpVideo()
}

async function pumpVideo() {
  if (videoBuilding || videoQueue.length === 0) return
  const job = (videoBuilding = videoQueue.shift())
  const { pid, kind } = job
  videoCancel = false
  videoJob = { pid, kind, phase: 'start', done: 0, total: 0 }
  let regenerator = null
  try {
    const mode = montage.regen.mode // 'seedance' | 'wan' | 'mock'
    const sd = mode === 'seedance'
    // recover는 ComfyUI history에서 회수만 하므로 Seedance 키가 필요 없다.
    if (sd && kind !== 'recover' && !COMFY_API_KEY)
      throw new Error('Seedance API 키 없음 — secrets/comfy-api-key.txt 필요 (또는 regen.mode를 wan으로)')

    const manifest = await readManifest(pid)
    const personaDir = path.join(LIBRARY, pid)
    // scene 순서(출생→죽음). 루프 프롬프트에 age가 필요하므로 함께 싣는다.
    const scenes = (manifest.images || [])
      .filter((im) => !im.failed)
      .map((im) => ({ id: im.id, absPath: path.join(personaDir, im.file), scene: im.scene, age: im.age }))
    regenerator = new VideoRegenerator({
      host: config.host,
      regen: montage.regen,
      personaDir,
      apiKey: COMFY_API_KEY
    })
    const builder = new ReelBuilder({ regenerator, reel: montage.reel, log: logAction })

    if (kind === 'clips') {
      // 영상 생성(둘 다 장면당 1개): seedance → 10초 루프 | wan → Wan I2V
      const total = scenes.length
      videoJob = { pid, kind, phase: 'clip', done: 0, total }
      logAction(`▶ 영상 생성 시작 [${mode}]: ${manifest.profile?.name || pid} (${total}장)`)
      const clips = await builder.ensureClips(scenes, {
        onProgress: (e) => (videoJob = { pid, kind, ...e }),
        shouldCancel: () => videoCancel
      })
      const done = clips.filter(Boolean).length
      manifest.clips = { mode, done, total, builtAt: new Date().toISOString() }
      await writeManifest(pid, manifest)
      videoLast = { pid, kind, ok: true, at: Date.now() }
      logAction(`✓ 영상 생성 완료: ${pid} — ${done}/${total}`)
      // Firebase 'generatedVideos' 컬렉션에 클립 업로드 (이미지와 동일 형식). 실패해도 잡은 성공 유지.
      if (firebaseReady && config.firebase?.uploadGenerated !== false) {
        try {
          const up = await uploadPersonaVideos({ profile: manifest.profile, personaId: pid, dir: personaDir, images: manifest.images, kind: 'clips' })
          logAction(`  ↑ Firebase 영상 업로드: ${up.count}개 → 'generatedVideos'/${up.key}`)
        } catch (e) {
          logAction(`  ⚠ Firebase 영상 업로드 실패(로컬 보존됨): ${e.message}`)
          videoLast = { ...(videoLast || {}), firebaseWarn: `클립 업로드 실패: ${e.message}` }
        }
      }
    } else if (kind === 'recover') {
      // ComfyUI output 복구: 생성은 됐으나 /view 다운로드 실패로 로컬/Firebase가 빈 경우, 서버 output에서 회수.
      const ids = scenes.map((s) => s.id)
      videoJob = { pid, kind, phase: 'recover', done: 0, total: ids.length }
      logAction(`▶ ComfyUI 복구 시작: ${manifest.profile?.name || pid} (${ids.length}장)`)
      const { recovered, missing } = await recoverClipsFromComfy({
        host: config.host,
        ids,
        videosDir: path.join(personaDir, 'videos'),
        onProgress: (e) => (videoJob = { pid, kind, ...e })
      })
      manifest.clips = {
        mode,
        done: recovered.length,
        total: ids.length,
        builtAt: new Date().toISOString(),
        recoveredAt: new Date().toISOString()
      }
      await writeManifest(pid, manifest)
      videoLast = { pid, kind, ok: true, at: Date.now() }
      logAction(
        `✓ 복구 완료: ${pid} — ${recovered.length}/${ids.length}` +
          (missing.length ? ` (누락 ${missing.join(', ')})` : '')
      )
      if (firebaseReady && config.firebase?.uploadGenerated !== false && recovered.length > 0) {
        try {
          const up = await uploadPersonaVideos({ profile: manifest.profile, personaId: pid, dir: personaDir, images: manifest.images, kind: 'clips' })
          logAction(`  ↑ Firebase 영상 업로드: ${up.count}개 → 'generatedVideos'/${up.key}`)
        } catch (e) {
          logAction(`  ⚠ Firebase 영상 업로드 실패(로컬 보존됨): ${e.message}`)
          videoLast = { ...(videoLast || {}), firebaseWarn: `클립 업로드 실패: ${e.message}` }
        }
      }
    } else {
      // 릴 합성: seedance → 루프 이어붙여 fast-forward | wan → 크로스페이드
      videoJob = { pid, kind, phase: 'concat', done: 0, total: scenes.length }
      logAction(`▶ 릴 합성 시작 [${mode}]: ${manifest.profile?.name || pid}`)
      const outPath = path.join(personaDir, 'reel.mp4')
      // 클립 소스 = Firebase 정본(로컬 캐시 우선, 없으면 Storage에서 받아 채움). Firebase 미연결·문서없음이면 로컬 폴백.
      let clipPaths = scenes.map((s) => regenerator.cachedPath(s.id))
      if (firebaseReady) {
        try {
          const { paths, missing } = await ensureLocalClipsFromFirebase(manifest.profile, personaDir, {
            ids: scenes.map((s) => s.id),
            onProgress: (e) => (videoJob = { pid, kind, ...e })
          })
          if (missing.length) logAction(`  ⚠ Firebase 문서에 없는 클립 ${missing.length}개: ${missing.join(', ')}`)
          clipPaths = scenes.map((s) => paths.get(s.id) || regenerator.cachedPath(s.id))
        } catch (e) {
          logAction(`  ⚠ Firebase 클립 조회 실패 — 로컬 캐시로 합성: ${e.message}`)
        }
      }
      const meta = sd
        ? await builder.concatSimple(clipPaths, outPath, { onProgress: (e) => (videoJob = { pid, kind, ...e }) })
        : await builder.concat(clipPaths, outPath, { onProgress: (e) => (videoJob = { pid, kind, ...e }) })
      manifest.reel = {
        file: 'reel.mp4',
        mode,
        durationSec: meta.durationSec,
        clipCount: meta.clipCount,
        builtAt: new Date().toISOString(),
        rev: (manifest.reel?.rev || 0) + 1 // 캐시 버스팅
      }
      await writeManifest(pid, manifest)
      videoLast = { pid, kind, ok: true, durationSec: meta.durationSec, at: Date.now() }
      logAction(`✓ 릴 완료: ${pid} — ${meta.durationSec.toFixed(1)}s (${meta.clipCount}개)`)
      if (firebaseReady && config.firebase?.uploadGenerated !== false) {
        try {
          const up = await uploadPersonaVideos({ profile: manifest.profile, personaId: pid, dir: personaDir, images: manifest.images, kind: 'reel', reelMeta: meta })
          logAction(`  ↑ Firebase 릴 업로드 → 'generatedVideos'/${up.key}`)
        } catch (e) {
          logAction(`  ⚠ Firebase 릴 업로드 실패(로컬 보존됨): ${e.message}`)
          videoLast = { ...(videoLast || {}), firebaseWarn: `릴 업로드 실패: ${e.message}` }
        }
      }
    }
  } catch (err) {
    const cancelled = Boolean(err.cancelled) || videoCancel
    videoLast = {
      pid,
      kind,
      ok: false,
      cancelled,
      pauseKind: cancelled ? videoCancelKind : null,
      error: cancelled ? null : String(err.message || err),
      at: Date.now()
    }
    logAction(
      cancelled
        ? `⏸ 영상 ${videoCancelKind === 'pause' ? '일시정지' : '중단'}됨: ${kind} ${pid} (만든 클립은 캐시에 남아 재개 가능)`
        : `✗ 영상 실패: ${kind} ${pid} — ${err.message}`
    )
  } finally {
    regenerator?.close?.()
    videoBuilding = null
    videoJob = null
    videoCancel = false
    pumpVideo() // 대기열에 남은 게 있으면 이어서
  }
}

// 사전 생성된 영상 개수(파일 기준) — UI가 "영상 N/총" 표시에 쓴다. 장면당 1개(루프 또는 Wan 클립).
function clipStatus(pid, manifest) {
  const dir = path.join(LIBRARY, pid, 'videos')
  const imgs = (manifest.images || []).filter((im) => !im.failed)
  let done = 0
  for (const im of imgs) if (existsSync(path.join(dir, `${im.id}.mp4`))) done++
  return { clipsDone: done, clipsTotal: imgs.length, mode: montage.regen.mode }
}

// 큐 뷰: 아직 안 끝난 것(submitted/generating/error) + 지금 생성 중인 것.
function queueView() {
  const legacy = profiles
    .filter((p) => p.id === current || ['submitted', 'generating', 'error'].includes(p.status))
    .map((p) => ({
      id: p.id,
      name: p.name || null,
      status: p.id === current ? 'generating' : p.status,
      createdAt: toMillis(p.createdAt),
      error: p.error || null
    }))
  return [...legacy, ...lifeGraphQueueRows()]
}

// cdb-crafter(인생그래프 앱) 제출 — occupation 기반 옛 스키마와 달리 문서 하나에 세션
// 최대 3개(first/second/third)가 순차로 채워진다. 세션마다 독립된 `${key}Status` 필드로
// submitted → generating → done | error 생명주기를 가진다(firestore-source.js 참조) —
// 1번 제출되면 1번 줄이, 2번 제출되면 2번 줄이 큐에 따로 뜬다. done이 되면 목록에서 빠진다
// (occupation 큐와 동일한 "아직 안 끝난 것만" 규칙).
const LIFE_GRAPH_SESSION_KEYS = ['first', 'second', 'third']
const LIFE_GRAPH_SESSION_ORDINALS = ['첫번째', '두번째', '세번째']

// 세션의 "실효 상태" — {key}Status가 없어도 {key}SubmittedAt만 있으면 submitted로 본다.
// (이 admin-server.mjs 배선 이전에 이미 제출된 문서는 SubmittedAt만 있고 Status가 없어서,
// 여기서 둘을 따로 판정하면 큐에는 "대기"로 보이는데 자동생성은 절대 못 집는 모순이 생긴다.)
function lifeGraphSessionStatus(p, key) {
  return p[`${key}Status`] || (p[`${key}SubmittedAt`] ? 'submitted' : null)
}

function lifeGraphQueueRows() {
  const rows = []
  for (const p of profiles) {
    LIFE_GRAPH_SESSION_KEYS.forEach((key, i) => {
      const rowId = `${p.id}#${key}`
      const status = rowId === current ? 'generating' : lifeGraphSessionStatus(p, key)
      if (!['submitted', 'generating', 'error'].includes(status)) return
      rows.push({
        id: rowId,
        kind: 'lifegraph', // admin/index.html이 이 값으로 "생성" 버튼을 붙일지 판단한다
        name: `${p.name || p.id} · ${LIFE_GRAPH_SESSION_ORDINALS[i]}`,
        status,
        createdAt: toMillis(p[`${key}SubmittedAt`]),
        error: p[`${key}Error`] || null
      })
    })
  }
  return rows
}

// error 프로필 자동 재시도: 세션당 pid별 시도 횟수를 세어 상한까지만 다시 굴린다(무한루프 방지).
const genAttempts = new Map()
const MAX_GEN_RETRIES = 2

async function maybeStartNext() {
  if (!firebaseReady || !autoOn || current) return
  // submitted 우선, 없으면 상한 안 넘은 error를 재시도 대상으로.
  let next = profiles.find((p) => p.status === 'submitted')
  let isRetry = false
  if (!next) {
    next = profiles.find(
      (p) => p.status === 'error' && (genAttempts.get(p.id) || 0) < MAX_GEN_RETRIES
    )
    isRetry = Boolean(next)
  }
  if (!next) return

  // current를 첫 await 이전에 동기적으로 세팅 → 재진입(스냅샷/토글) 시 중복 시작 차단.
  current = next.id
  currentInfo = {
    pid: next.id,
    // 라이브러리 디렉토리 키 — UI가 생성 중인 persona의 manifest를 실시간 폴링할 때 쓴다
    personaId: personaId(next),
    name: next.name || null,
    done: 0,
    total: 0,
    startedAt: Date.now()
  }
  next.status = 'generating' // 로컬 낙관적 갱신 — 다음 스냅샷 전까지 같은 건 재선택 방지
  if (isRetry) {
    const n = (genAttempts.get(current) || 0) + 1
    genAttempts.set(current, n)
    logAction(`↻ 실패분 자동 재시도 (${n}/${MAX_GEN_RETRIES}): ${currentInfo.name || '?'} (${current})`)
  } else {
    logAction(`▶ 자동 생성 시작: ${currentInfo.name || '?'} (${current})`)
  }

  currentAbort = new AbortController() // 중지 버튼이 이걸 abort 한다
  const res = await processProfile(next, {
    config,
    outDir: LIBRARY,
    includeErrors: isRetry, // error 프로필을 claim하려면 필요
    signal: currentAbort.signal,
    log: logAction,
    onProgress: (e) => {
      if (e.type === 'image-done') {
        currentInfo.done = e.done
        currentInfo.total = e.total
      }
    }
  })
  currentAbort = null

  lastResult = {
    pid: current,
    ok: res.ok,
    cancelled: res.cancelled || false,
    error: res.error || null,
    at: Date.now()
  }
  logAction(
    res.cancelled
      ? `⏸ 생성 중지됨: ${current}`
      : res.ok
        ? `✓ 자동 생성 완료: ${current}`
        : `✗ 자동 생성 실패: ${current} — ${res.error || '(claim 실패)'}`
  )
  if (res.ok) genAttempts.delete(current) // 성공하면 재시도 카운트 리셋
  // 영상 생성은 자동 트리거하지 않는다 — 이미지 완료 후 연구자가 admin에서 "영상 생성" 버튼으로 시작한다.
  current = null
  currentInfo = null
  // 중지 요청이면 자동으로 다음 걸 시작하지 않는다(사용자가 멈춘 것). autoOn도 함께 끈다.
  if (res.cancelled) autoOn = false
  else maybeStartNext() // 큐에 남은 게 있으면 이어서
}

// cdb-crafter(인생그래프 앱) 세션 생성 — occupation 큐와 달리 자동으로 안 돈다. 큐에 "대기"로
// 뜬 항목을 admin에서 "생성" 버튼으로 직접 눌러야 시작한다(/api/lifegraph/generate). 그 외엔
// maybeStartNext와 같은 current 잠금을 공유해 ComfyUI/Gemini를 두 큐가 동시에 때리지 않는다.
// 동기 부분(검증)에서 바로 던지고, 실제 생성은 기다리지 않고 백그라운드로 돌린다 — HTTP 요청이
// 수 분짜리 생성이 끝날 때까지 매달려 있지 않게(admin UI는 /api/queue 폴링으로 진행을 본다).
function startLifeGraphSession(pid, sessionKey) {
  if (!firebaseReady) throw new Error('Firebase 미연결')
  if (current) throw new Error('다른 생성이 진행 중입니다 — 끝난 뒤 다시 시도하세요')
  const p = profiles.find((x) => x.id === pid)
  if (!p) throw new Error(`프로필 없음: ${pid}`)
  if (lifeGraphSessionStatus(p, sessionKey) !== 'submitted')
    throw new Error(`이미 처리 중이거나 완료된 세션입니다: ${pid}#${sessionKey}`)

  current = `${pid}#${sessionKey}` // 첫 await 전에 동기적으로 잠가 중복 클릭을 막는다
  currentInfo = {
    pid,
    personaId: pid, // life-graph는 personaId() 해시가 아니라 크래프터가 준 id를 그대로 라이브러리 폴더명으로 쓴다
    name: p.name || null,
    done: 0,
    total: 0,
    startedAt: Date.now()
  }
  p[`${sessionKey}Status`] = 'generating' // 로컬 낙관적 갱신 — 다음 스냅샷 전까지 재클릭 방지
  logAction(`▶ 인생그래프 생성 시작(수동): ${currentInfo.name || '?'} (${pid} · ${sessionKey})`)

  currentAbort = new AbortController()
  ;(async () => {
    const res = await processLifeGraphSession(p, sessionKey, {
      config,
      outDir: LIBRARY,
      signal: currentAbort.signal,
      log: logAction,
      onProgress: (e) => {
        if (e.type === 'image-done') {
          currentInfo.done = e.done
          currentInfo.total = e.total
        }
      }
    })
    currentAbort = null
    lastResult = { pid, ok: res.ok, cancelled: res.cancelled || false, error: res.error || null, at: Date.now() }
    logAction(
      res.cancelled
        ? `⏸ 인생그래프 생성 중지됨: ${pid}`
        : res.ok
          ? `✓ 인생그래프 생성 완료: ${pid}`
          : `✗ 인생그래프 생성 실패: ${pid} — ${res.error || '(claim 실패)'}`
    )
    current = null
    currentInfo = null
  })()
}

// Firebase 연결 실패해도 서버는 뜬다(검토 기능만). 큐/자동생성만 비활성화.
try {
  await initFirebase({ serviceAccountPath: saPath, projectId: config.firebase?.projectId })
  firebaseReady = true
  if (!VIEW_ONLY) {
    // 이전 실행이 생성 도중 죽어 generating에 갇힌 프로필 복구 → 큐가 다시 잡고,
    // life-library의 resume이 이미 생성된 장을 건너뛰고 이어서 만든다.
    // (view-only에서는 하지 않는다 — 워커가 진행 중인 생성을 리셋해 버린다.)
    const orphans = await resetOrphanGenerating()
    if (orphans.length > 0)
      console.log(`[admin] 중단됐던 생성 ${orphans.length}건을 큐로 복구 (이어서 생성): ${orphans.join(', ')}`)
    const lgOrphans = await resetOrphanLifeGraphGenerating()
    if (lgOrphans.length > 0)
      console.log(`[admin] 중단됐던 인생그래프 생성 ${lgOrphans.length}건을 큐로 복구: ${lgOrphans.join(', ')}`)
  }
  listenProfiles((list) => {
    profiles = list
    maybeStartNext() // 인생그래프 세션은 자동 시작 없음 — admin "생성" 버튼(/api/lifegraph/generate)으로만
  })
  console.log(
    VIEW_ONLY
      ? '[admin] Firestore 큐 구독 시작 — 뷰어 모드 (생성은 워커 담당: npm run worker:listen)'
      : '[admin] Firestore 큐 구독 시작 — 자동 생성 ON (동시 1개)'
  )
} catch (err) {
  console.error(`[admin] Firebase 미연결 — 큐/자동생성 비활성화 (검토 기능만 동작): ${err.message}`)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  // url.pathname은 비ASCII 문자를 퍼센트 인코딩된 채로 준다(WHATWG URL이 자동 디코딩 안 함) —
  // 옛 personaId()는 해시라 늘 ASCII였지만, cdb-crafter의 personaId는 이름을 그대로 쓰므로
  // 한글이 그대로 들어간다. 디코딩 안 하면 /img, /media, /api/personas/{pid}가 실제 파일
  // 경로(한글 폴더명)와 안 맞아 ENOENT가 난다 — 여기 한 곳에서 전부 디코딩해 해결한다.
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  try {
    // GET / → 검토 UI
    if (req.method === 'GET' && parts.length === 0) {
      const html = await fs.readFile(path.join(root, 'admin/index.html'))
      return send(res, 200, html, MIME['.html'])
    }

    // GET /img/{pid}/{file} → 라이브러리 이미지
    if (req.method === 'GET' && parts[0] === 'img' && parts.length === 3) {
      const file = path.join(LIBRARY, parts[1], path.basename(parts[2])) // 경로 탈출 방지
      const data = await fs.readFile(file)
      return send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream')
    }

    // GET /media/{pid}/{...경로} → 영상(Range 지원). 릴=reel.mp4, 클립=videos/<id>.mp4
    if (req.method === 'GET' && parts[0] === 'media' && parts.length >= 3) {
      const personaRoot = path.normalize(path.join(LIBRARY, parts[1]))
      const rel = parts.slice(2).map(decodeURIComponent).join('/')
      const abs = path.normalize(path.join(personaRoot, rel))
      if (!abs.startsWith(personaRoot)) return send(res, 403, { error: 'forbidden' }) // 경로 탈출 차단
      return serveFile(req, res, abs, MIME[path.extname(abs)] || 'application/octet-stream')
    }

    // GET /api/queue → 제출 큐 + 자동생성 상태 + 현재 진행 (어드민 상단 패널이 폴링)
    if (req.method === 'GET' && url.pathname === '/api/queue') {
      // view-only: 생성 주체가 워커라 이 프로세스의 currentInfo가 비어 있다 —
      // Firestore의 generating 문서에서 합성해 "생성 중" 표시와 실시간 보기를 살린다.
      // (진행률 done/total은 워커 프로세스 안에만 있어 0으로 남는다.)
      let info = currentInfo
      let last = lastResult
      if (!info && VIEW_ONLY) {
        const gen = profiles.find((p) => p.status === 'generating')
        if (gen) {
          info = {
            pid: gen.id,
            personaId: personaId(gen),
            name: gen.name || null,
            done: 0,
            total: 0,
            startedAt: toMillis(gen.generationStartedAt)
          }
        }
      }
      if (VIEW_ONLY) {
        // 완료 감지도 Firestore에서 합성 — 워커가 끝낸 프로필이 검토 목록에 자동 등장하게.
        for (const p of profiles) {
          const at = toMillis(p.updatedAt)
          if (p.status === 'done' && at && (!last || at > last.at))
            last = { pid: p.id, ok: true, error: null, at }
        }
      }
      return send(res, 200, {
        firebaseReady,
        viewOnly: VIEW_ONLY,
        autoOn,
        current,
        currentInfo: info,
        lastResult: last,
        queue: queueView(),
        video: { building: videoBuilding, queue: videoQueue, job: videoJob, last: videoLast }
      })
    }

    // POST /api/autogen { on: boolean } → 자동생성 ON/OFF 토글
    if (req.method === 'POST' && url.pathname === '/api/autogen') {
      if (VIEW_ONLY)
        return send(res, 400, { error: '뷰어 모드에서는 자동 생성을 켤 수 없다 (생성은 워커 담당)' })
      const { on } = await readBody(req)
      autoOn = Boolean(on)
      logAction(`자동 생성 ${autoOn ? 'ON' : 'OFF (일시정지)'}`)
      if (autoOn) maybeStartNext()
      return send(res, 200, { autoOn })
    }

    // POST /api/stop → 진행 중인 이미지 생성 중지(일시정지). 진행분은 저장되고 status는 submitted로.
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      if (!current || !currentAbort) return send(res, 200, { stopped: false, note: '진행 중인 생성 없음' })
      logAction(`⏸ 중지 요청 → ${currentInfo?.name || current}`)
      currentAbort.abort()
      return send(res, 200, { stopped: true, pid: current })
    }

    // POST /api/video/stop { kind: 'pause'|'stop' } → 진행 중인 영상(클립) 생성 중지.
    // 만든 클립은 캐시에 남아 "이어서 생성"으로 재개 가능. pause·stop은 라벨만 다르다(둘 다 클립 보존).
    if (req.method === 'POST' && url.pathname === '/api/video/stop') {
      if (!videoBuilding) return send(res, 200, { stopped: false, note: '진행 중인 영상 작업 없음' })
      const { kind = 'stop' } = await readBody(req)
      videoCancelKind = kind === 'pause' ? 'pause' : 'stop'
      videoCancel = true
      logAction(`⏸ 영상 ${videoCancelKind === 'pause' ? '일시정지' : '중단'} 요청 → ${videoBuilding.pid}`)
      return send(res, 200, { stopped: true, pid: videoBuilding.pid })
    }

    // POST /api/retry { id } → 실패(error) 프로필을 다시 생성 대기(submitted)로. 재시도 카운트도 리셋.
    if (req.method === 'POST' && url.pathname === '/api/retry') {
      if (VIEW_ONLY) return send(res, 400, { error: '뷰어 모드에서는 재실행 불가 (생성은 워커 담당)' })
      if (!firebaseReady) return send(res, 400, { error: 'Firebase 미연결' })
      const { id } = await readBody(req)
      if (!id) return send(res, 400, { error: 'id 필요' })
      await updateProfileFields(id, { status: 'submitted', error: null })
      genAttempts.delete(id)
      if (!autoOn) autoOn = true // 재실행하려면 자동생성이 켜져 있어야 한다
      logAction(`↻ 수동 재실행 요청: ${id} (submitted로 되돌림)`)
      maybeStartNext()
      return send(res, 200, { queued: true, id })
    }

    // POST /api/lifegraph/generate { id } → id는 "personaId#sessionKey"(큐 목록의 id와 동일).
    // 인생그래프 세션은 자동 생성이 없으므로 이 버튼이 유일한 시작 지점이다.
    if (req.method === 'POST' && url.pathname === '/api/lifegraph/generate') {
      if (VIEW_ONLY) return send(res, 400, { error: '뷰어 모드에서는 생성 불가' })
      if (!firebaseReady) return send(res, 400, { error: 'Firebase 미연결' })
      const { id } = await readBody(req)
      const [pid, sessionKey] = String(id || '').split('#')
      if (!pid || !sessionKey) return send(res, 400, { error: 'id 필요 (형식: personaId#sessionKey)' })
      try {
        startLifeGraphSession(pid, sessionKey)
      } catch (err) {
        return send(res, 400, { error: err.message })
      }
      return send(res, 200, { started: true, id })
    }

    // ── 세션 참가자(연구자용 "로그인") ────────────────────────────────
    // 4창 런타임은 이 선택(_session.json)을 읽어 해당 참가자의 생애를 재생한다.
    // 선택은 오직 여기(연구자 admin)에서만 이뤄진다 — 4창에는 선택 화면이 뜨지 않는다.

    // GET /api/session → 현재 세션 참가자
    if (req.method === 'GET' && url.pathname === '/api/session') {
      return send(res, 200, (await readSession(LIBRARY)) || { personaId: null })
    }

    // POST /api/session { personaId } → 세션 참가자 설정. 런타임이 IDLE이면 즉시 반영된다.
    if (req.method === 'POST' && url.pathname === '/api/session') {
      const { personaId: pid } = await readBody(req)
      if (!pid) return send(res, 400, { error: 'personaId 필요' })
      // 다른 머신에서 로컬이 비어 있으면 정본에서 자동 복원 — 4창 런타임이 재생할 미디어까지 채운다.
      await ensurePersonaLocal(pid).catch(() => {})
      let manifest
      try {
        manifest = await readManifest(pid)
      } catch {
        return send(res, 404, { error: `persona 없음: ${pid}` })
      }
      const sel = await writeSession(LIBRARY, { personaId: pid, name: manifest.profile?.name || null })
      logAction(`◆ 세션 참가자 설정 → ${sel.name || pid}`)
      return send(res, 200, sel)
    }

    // DELETE /api/session → 세션 나가기(선택 해제). 런타임은 IDLE 대기로 복귀.
    if (req.method === 'DELETE' && url.pathname === '/api/session') {
      await clearSession(LIBRARY)
      logAction('◇ 세션 나가기 — 선택 해제')
      return send(res, 200, { personaId: null })
    }

    // GET /api/personas → persona 목록
    if (req.method === 'GET' && url.pathname === '/api/personas') {
      // 합집합: 로컬 library(캐시) ∪ Firebase 정본(제출 전부 포함). personaId 로 병합.
      const byPid = new Map()

      // 1) 로컬 — 디스크에 있는 것(리뷰/재생성 즉시 가능)
      for (const dirent of await fs.readdir(LIBRARY, { withFileTypes: true }).catch(() => [])) {
        if (!dirent.isDirectory()) continue
        try {
          const m = await readManifest(dirent.name)
          byPid.set(m.personaId, {
            personaId: m.personaId,
            name: m.profile?.name || null,
            createdAt: m.createdAt || null,
            workflow: m.workflow || null,
            total: (m.images || []).length,
            local: true,
            cloud: false,
            imageCount: (m.images || []).length,
            videoCount: 0,
            reel: false,
            status: null,
            sessions: null,
            docKey: null
          })
        } catch {
          /* manifest 없는 디렉토리는 건너뜀 */
        }
      }

      // 2) Firebase 정본 — 병합/추가(다른 머신에서도 전체 명단이 뜨게)
      if (firebaseReady) {
        try {
          for (const fp of await firebasePersonaList()) {
            if (!fp.personaId) continue
            const cur = byPid.get(fp.personaId)
            if (cur) {
              cur.cloud = true
              cur.docKey = fp.docKey
              cur.videoCount = fp.videoCount
              cur.reel = fp.reel
              cur.status = fp.status
              cur.sessions = fp.sessions
              if (fp.imageCount > cur.imageCount) cur.imageCount = fp.imageCount
            } else {
              byPid.set(fp.personaId, {
                personaId: fp.personaId,
                name: fp.name,
                createdAt: fp.createdAt,
                workflow: null,
                total: fp.imageCount,
                local: false,
                cloud: true,
                imageCount: fp.imageCount,
                videoCount: fp.videoCount,
                reel: fp.reel,
                status: fp.status,
                sessions: fp.sessions,
                hasManifest: fp.hasManifest,
                docKey: fp.docKey
              })
            }
          }
        } catch (err) {
          logAction(`Firebase 명단 조회 실패: ${err.message}`)
        }
      }

      return send(res, 200, [...byPid.values()])
    }

    // /api/personas/{pid}...
    if (parts[0] === 'api' && parts[1] === 'personas' && parts[2]) {
      const pid = parts[2]

      // POST /api/personas/{pid}/hydrate → Firebase 정본에서 로컬 library/{pid} 복원(수동 "받기").
      if (req.method === 'POST' && parts[3] === 'hydrate') {
        if (!firebaseReady) return send(res, 400, { error: 'Firebase 미연결' })
        const entry = (await firebasePersonaList()).find((p) => p.personaId === pid)
        if (!entry || !entry.hasManifest)
          return send(res, 404, { error: `Firebase에 정본 manifest가 없다: ${pid}` })
        const result = await hydratePersona(entry.docKey)
        logAction(`⬇ hydrate 완료: ${entry.name || pid} (이미지 ${result.images}, reel ${result.reel ? '○' : '×'})`)
        return send(res, 200, { ok: true, ...result })
      }

      if (req.method === 'GET' && parts.length === 3) {
        // 다른 머신에서 로컬이 비어 있어도 정본에서 자동 복원해 리뷰가 되게 한다.
        await ensurePersonaLocal(pid).catch(() => {})
        const m = await readManifest(pid)
        m._clipStatus = clipStatus(pid, m) // 로컬 캐시 기준 진행도 (영상 패널 표시용)
        // Firebase 정본 상태(☁) — 로컬 캐시와 별개로 "Firebase에 실제로 올라간 수"를 보여준다.
        if (firebaseReady) {
          try {
            const fb = await fetchPersonaVideos(m.profile)
            m._firebase = {
              clips: fb?.videos?.length || 0,
              reel: Boolean(fb?.reel),
              total: (m.images || []).filter((i) => !i.failed).length
            }
          } catch {
            m._firebase = null
          }
        }
        return send(res, 200, m)
      }

      // 장면 피드 — 노출 단(threads-prototype 등)이 소비하는 목록.
      // 별도 승인 절차 없이 전 장이 기본 노출된다. 문제 장은 재생성으로 그 자리에서 교체.
      if (req.method === 'GET' && parts[3] === 'approved') {
        const m = await readManifest(pid)
        return send(
          res,
          200,
          m.images.map((i) => ({ id: i.id, age: i.age, file: i.file, url: `/img/${pid}/${i.file}` }))
        )
      }

      // 성별 수정: { gender: 'male'|'female'|null } — 자동 감지가 틀렸을 때 어드민이 바로잡는다.
      // manifest의 성별과 장면 프롬프트를 새 성별로 재구성한다.
      // 이미 생성된 이미지는 그대로 두므로, 틀리게 나온 장은 재생성해야 반영된다.
      // Firestore 프로필에도 역동기화한다.
      if (req.method === 'POST' && parts[3] === 'gender') {
        const { gender = null } = await readBody(req)
        if (![null, 'male', 'female'].includes(gender))
          return send(res, 400, { error: "gender는 'male'|'female'|null 이어야 함" })
        const manifest = await readManifest(pid)
        manifest.profile = { ...(manifest.profile || {}), gender }
        manifest.gender = { ...(manifest.gender || {}), value: gender, source: 'manual' }
        for (const img of manifest.images || [])
          img.prompt = composeScenePromptFor(manifest.workflow, manifest.profile, img)
        await writeManifest(pid, manifest)
        if (firebaseReady && manifest.profile.id) {
          await updateProfileFields(manifest.profile.id, { gender }).catch((err) =>
            logAction(`Firestore 성별 역동기화 실패 (${manifest.profile.id}): ${err.message}`)
          )
        }
        const LABEL = { male: '남성', female: '여성', null: '미지정' }
        logAction(`${pid}  성별 수정 → ${LABEL[gender ?? 'null']}`)
        return send(res, 200, {
          ok: true,
          gender,
          note: '성별이 수정되고 프롬프트가 갱신되었습니다. 잘못 생성된 장은 재생성하세요.'
        })
      }

      // 재생성: { id } — 동기 처리(장당 ~15초)
      if (req.method === 'POST' && parts[3] === 'regen') {
        const { id } = await readBody(req)
        logAction(`${pid}  ↻ 재생성 시작  장면 ${id}`)
        const result = await regenerate(pid, id)
        logAction(
          `${pid}  ↻ 재생성 완료  장면 ${id}  (${(result.entry.elapsedMs / 1000).toFixed(1)}s${result.entry.seed != null ? `, seed ${result.entry.seed}` : ''})`
        )
        return send(res, 200, result)
      }

      // edge 재연결: { id } — Gemini 원본 재사용, 이음매 보정만 다시 (seamfix 전용, 재과금 없음)
      if (req.method === 'POST' && parts[3] === 'reseam') {
        const { id } = await readBody(req)
        logAction(`${pid}  ⟚ edge 재연결 시작  장면 ${id}`)
        const result = await reseam(pid, id)
        logAction(
          `${pid}  ⟚ edge 재연결 완료  장면 ${id}  (${(result.entry.elapsedMs / 1000).toFixed(1)}s)`
        )
        return send(res, 200, result)
      }

      // 영상(클립) 생성 — 전 장면을 Wan 클립으로. 비동기 큐 등록(오래 걸림). 진행은 /api/queue의 video로 폴링.
      if (req.method === 'POST' && parts[3] === 'clips') {
        await readManifest(pid) // 존재 확인 (없으면 throw → 404/500)
        enqueueVideo(pid, 'clips')
        return send(res, 200, { queued: true, pid, kind: 'clips' })
      }

      // 주마등 릴 합성 — Firebase 정본 클립(없으면 로컬)으로 90초 릴 합성.
      if (req.method === 'POST' && parts[3] === 'reel') {
        await readManifest(pid) // 존재 확인
        enqueueVideo(pid, 'reel')
        return send(res, 200, { queued: true, pid, kind: 'reel' })
      }

      // ComfyUI 복구 — 생성됐으나 다운로드 실패한 클립을 서버 output에서 회수 → 로컬 + Firebase.
      if (req.method === 'POST' && parts[3] === 'recover-clips') {
        await readManifest(pid) // 존재 확인
        enqueueVideo(pid, 'recover')
        return send(res, 200, { queued: true, pid, kind: 'recover' })
      }
    }

    send(res, 404, { error: 'not found' })
  } catch (err) {
    send(res, 500, { error: String(err.message || err) })
  }
})

server.listen(PORT, () => {
  console.log(
    `[admin] http://localhost:${PORT}  (library: ${LIBRARY}, workflow: ${config.workflow}` +
      `${['gemini', 'hybrid', 'seamfix'].includes(config.workflow) ? `, gemini: ${config.gemini?.model}` : ''}` +
      `${config.workflow === 'gemini' ? '' : `, comfyui: ${config.host}`})`
  )
})
