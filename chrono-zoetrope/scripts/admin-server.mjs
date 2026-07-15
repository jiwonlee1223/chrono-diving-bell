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
  resolveGeminiConfig
} from '../src/main/comfyui/gemini-client.js'
import {
  buildKontextWorkflow,
  buildSdxlWorkflow,
  randomSeed
} from '../src/main/comfyui/workflows.js'
import {
  initFirebase,
  listenProfiles,
  resetOrphanGenerating,
  updateProfileFields
} from '../src/main/comfyui/firestore-source.js'
import { processProfile } from '../src/main/comfyui/profile-worker.js'
import {
  composeGeminiScenePrompt,
  composeKontextPrompt,
  composeSdxlPrompt,
  personaId
} from '../src/main/comfyui/prompt-builder.js'
import { readSession, writeSession } from '../src/main/session-pointer.js'
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
  entry.prompt =
    wf === 'sdxl'
      ? composeSdxlPrompt(manifest.profile, entry)
      : wf === 'gemini'
        ? composeGeminiScenePrompt(manifest.profile, entry)
        : composeKontextPrompt(manifest.profile, entry) // kontext (구 hybrid 포함)

  if (wf === 'gemini') return regenerateGemini(pid, manifest, entry)

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
    aspectRatio: '16:9', // life-library.js의 geminiAspect와 동일 매핑
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
    if (sd && !COMFY_API_KEY)
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
    } else {
      // 릴 합성: seedance → 루프 이어붙여 fast-forward | wan → 크로스페이드
      videoJob = { pid, kind, phase: 'concat', done: 0, total: scenes.length }
      logAction(`▶ 릴 합성 시작 [${mode}]: ${manifest.profile?.name || pid}`)
      const outPath = path.join(personaDir, 'reel.mp4')
      const clipPaths = scenes.map((s) => regenerator.cachedPath(s.id))
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
  return profiles
    .filter((p) => p.id === current || ['submitted', 'generating', 'error'].includes(p.status))
    .map((p) => ({
      id: p.id,
      name: p.name || null,
      status: p.id === current ? 'generating' : p.status,
      createdAt: toMillis(p.createdAt),
      error: p.error || null
    }))
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
  }
  listenProfiles((list) => {
    profiles = list
    maybeStartNext()
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
  const parts = url.pathname.split('/').filter(Boolean)
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

    // GET /api/personas → persona 목록
    if (req.method === 'GET' && url.pathname === '/api/personas') {
      const out = []
      for (const dirent of await fs.readdir(LIBRARY, { withFileTypes: true }).catch(() => [])) {
        if (!dirent.isDirectory()) continue
        try {
          const m = await readManifest(dirent.name)
          out.push({
            personaId: m.personaId,
            name: m.profile?.name,
            createdAt: m.createdAt,
            workflow: m.workflow,
            total: m.images.length
          })
        } catch {
          /* manifest 없는 디렉토리는 건너뜀 */
        }
      }
      return send(res, 200, out)
    }

    // /api/personas/{pid}...
    if (parts[0] === 'api' && parts[1] === 'personas' && parts[2]) {
      const pid = parts[2]

      if (req.method === 'GET' && parts.length === 3) {
        const m = await readManifest(pid)
        m._clipStatus = clipStatus(pid, m) // 사전 생성 클립 진행도 (영상 패널 표시용)
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
          img.prompt =
            manifest.workflow === 'sdxl'
              ? composeSdxlPrompt(manifest.profile, img)
              : manifest.workflow === 'gemini'
                ? composeGeminiScenePrompt(manifest.profile, img)
                : composeKontextPrompt(manifest.profile, img) // kontext (구 hybrid 포함)
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

      // 영상(클립) 생성 — 전 장면을 Wan 클립으로. 비동기 큐 등록(오래 걸림). 진행은 /api/queue의 video로 폴링.
      if (req.method === 'POST' && parts[3] === 'clips') {
        await readManifest(pid) // 존재 확인 (없으면 throw → 404/500)
        enqueueVideo(pid, 'clips')
        return send(res, 200, { queued: true, pid, kind: 'clips' })
      }

      // 주마등 릴 합성 — 사전 생성된 클립들을 90초 릴로. 클립이 있어야 함.
      if (req.method === 'POST' && parts[3] === 'reel') {
        await readManifest(pid) // 존재 확인
        enqueueVideo(pid, 'reel')
        return send(res, 200, { queued: true, pid, kind: 'reel' })
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
      `${['gemini', 'hybrid'].includes(config.workflow) ? `, gemini: ${config.gemini?.model}` : ''}` +
      `${config.workflow === 'gemini' ? '' : `, comfyui: ${config.host}`})`
  )
})
