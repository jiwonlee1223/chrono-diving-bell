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
//   - 장별 승인/반려 판정 저장 (manifest.json의 status 필드)
//   - 반려 장 재생성 (manifest에 기록된 프롬프트 + 새 시드로 ComfyUI 재호출)
//   - 승인된 장면 피드 제공 (/api/personas/{pid}/approved) —
//     threads-prototype 등 노출 단이 이 피드만 소비하면 미검토 이미지가 새어나가지 않는다.
//
// 검토 상태 모델: pending(기본) → approved | rejected. 재생성하면 pending으로 복귀.

import http from 'node:http'
import fs from 'node:fs/promises'
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
  composeAgePortraitPrompt,
  composeGeminiScenePrompt,
  composeKontextPrompt,
  composeSdxlPrompt,
  personaId
} from '../src/main/comfyui/prompt-builder.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(
  await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8')
)
config.gemini = resolveGeminiConfig(config.gemini, root) // apiKeyPath를 절대경로로

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
  const m = JSON.parse(await fs.readFile(p, 'utf-8'))
  // 구버전 manifest(status 없음) 정규화
  for (const img of m.images || []) if (!img.status) img.status = 'pending'
  for (const pt of m.agePortraits || []) if (!pt.status) pt.status = 'pending'
  return m
}
async function writeManifest(pid, manifest) {
  await fs.writeFile(path.join(LIBRARY, pid, 'manifest.json'), JSON.stringify(manifest, null, 2))
}
function findEntry(manifest, kind, id) {
  if (kind === 'portrait')
    return (manifest.agePortraits || []).find((p) => String(p.age) === String(id))
  return (manifest.images || []).find((img) => img.id === id)
}

// ── 재생성: manifest에 기록된 프롬프트를 그대로 쓰고 시드만 새로 뽑는다 ──
// (장면 문구를 바꾸는 건 프롬프트 풀 수정의 영역 — 여기서는 확률만 다시 굴린다.)
async function regenerate(pid, kind, id) {
  const manifest = await readManifest(pid)
  const entry = findEntry(manifest, kind, id)
  if (!entry) throw new Error(`항목 없음: ${kind} ${id}`)

  // gemini는 전 항목, hybrid는 포트레이트만 Gemini로 재생성 (장면은 kontext — 생성 때와 동일 분담)
  if (manifest.workflow === 'gemini' || (manifest.workflow === 'hybrid' && kind === 'portrait'))
    return regenerateGemini(pid, kind, manifest, entry)

  const client = new ComfyUIClient({ host: config.host, timeoutMs: config.timeoutMs })
  try {
    const seed = randomSeed()
    let wf
    if (manifest.workflow !== 'sdxl') {
      // kontext·hybrid(장면). 레퍼런스: 장면이면 그 단계의 나이 포트레이트, 포트레이트면 원본 프로필 사진.
      const refLocal =
        kind === 'portrait'
          ? manifest.referenceImage.local
          : path.join(LIBRARY, pid, `age-${entry.age}.png`)
      const buf = await fs.readFile(refLocal)
      const uploaded = await client.uploadImage(buf, `${pid}-regen-ref.png`)
      wf = buildKontextWorkflow({
        prompt: entry.prompt,
        referenceImage: uploaded.name,
        width: kind === 'portrait' ? 832 : manifest.image.width,
        height: kind === 'portrait' ? 1152 : manifest.image.height,
        seed,
        filenamePrefix: `chrono-zoetrope/${pid}/${path.basename(entry.file, '.png')}`
      })
    } else {
      wf = buildSdxlWorkflow({
        prompt: entry.prompt,
        width: manifest.image.width,
        height: manifest.image.height,
        seed,
        filenamePrefix: `chrono-zoetrope/${pid}/${path.basename(entry.file, '.png')}`
      })
    }

    const t0 = Date.now()
    const { promptId, images } = await client.generate(wf)
    await fs.writeFile(path.join(LIBRARY, pid, entry.file), images[0].data)

    entry.seed = seed
    entry.promptId = promptId
    entry.elapsedMs = Date.now() - t0
    entry.status = 'pending'
    entry.rev = (entry.rev || 0) + 1 // 클라이언트 캐시 버스팅용
    await writeManifest(pid, manifest)
    return {
      entry,
      note:
        kind === 'portrait'
          ? '포트레이트가 바뀌었습니다. 이 단계의 장면들은 옛 포트레이트 기준이므로 필요하면 장면도 재생성하세요.'
          : null
    }
  } finally {
    client.close()
  }
}

// Gemini 백엔드 재생성 — 시드 개념이 없어 같은 프롬프트로 확률만 다시 굴린다.
// 레퍼런스는 ComfyUI 경로와 동일한 규칙: 장면 → 그 단계의 나이 포트레이트, 포트레이트 → 원본 프로필 사진.
async function regenerateGemini(pid, kind, manifest, entry) {
  const gclient = new GeminiClient({
    apiKey: await resolveGeminiApiKey(config.gemini),
    model: manifest.gemini?.model || config.gemini?.model,
    textModel: config.gemini?.textModel,
    timeoutMs: config.timeoutMs
  })
  const refLocal =
    kind === 'portrait'
      ? manifest.referenceImage.local
      : path.join(LIBRARY, pid, `age-${entry.age}.png`)
  const reference = await fs.readFile(refLocal)

  const t0 = Date.now()
  const data = await gclient.generateImage({
    prompt: entry.prompt,
    references: [reference],
    aspectRatio: kind === 'portrait' ? '3:4' : '16:9', // life-library.js의 geminiAspect와 동일 매핑
    imageSize: manifest.gemini?.imageSize || config.gemini?.imageSize || '2K',
    // 생성 때와 같은 역할별 모델: 포트레이트 pro, 장면 sceneModel(flash)
    model:
      kind === 'portrait'
        ? undefined // gclient 기본값(manifest.gemini.model)
        : manifest.gemini?.sceneModel || config.gemini?.sceneModel || undefined
  })
  await fs.writeFile(path.join(LIBRARY, pid, entry.file), data)

  entry.seed = null
  entry.promptId = null
  entry.elapsedMs = Date.now() - t0
  entry.status = 'pending'
  entry.rev = (entry.rev || 0) + 1 // 클라이언트 캐시 버스팅용
  await writeManifest(pid, manifest)
  return {
    entry,
    note:
      kind === 'portrait'
        ? '포트레이트가 바뀌었습니다. 이 단계의 장면들은 옛 포트레이트 기준이므로 필요하면 장면도 재생성하세요.'
        : null
  }
}

// ── HTTP 서버 ─────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json'
}

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' })
  res.end(data)
}
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
}

// 검토 액션 로그 — 어떤 장을 언제 승인/반려/재생성했는지 터미널에 남긴다.
const HHMMSS = () => new Date().toTimeString().slice(0, 8)
const ACTION_LABEL = { approved: '✓ 승인', rejected: '✗ 반려', pending: '· 대기' }
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

const toMillis = (ts) => (ts && typeof ts.toMillis === 'function' ? ts.toMillis() : null)

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

async function maybeStartNext() {
  if (!firebaseReady || !autoOn || current) return
  const next = profiles.find((p) => p.status === 'submitted')
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
    portraits: 0,
    startedAt: Date.now()
  }
  next.status = 'generating' // 로컬 낙관적 갱신 — 다음 스냅샷 전까지 같은 건 재선택 방지
  logAction(`▶ 자동 생성 시작: ${currentInfo.name || '?'} (${current})`)

  const res = await processProfile(next, {
    config,
    outDir: LIBRARY,
    log: logAction,
    onProgress: (e) => {
      if (e.type === 'image-done') {
        currentInfo.done = e.done
        currentInfo.total = e.total
      } else if (e.type === 'portrait-done') {
        currentInfo.portraits += 1
      }
    }
  })

  lastResult = { pid: current, ok: res.ok, error: res.error || null, at: Date.now() }
  logAction(
    res.ok
      ? `✓ 자동 생성 완료: ${current}`
      : `✗ 자동 생성 실패: ${current} — ${res.error || '(claim 실패)'}`
  )
  current = null
  currentInfo = null
  maybeStartNext() // 큐에 남은 게 있으면 이어서
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
            portraits: 0,
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
        queue: queueView()
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

    // GET /api/personas → persona 목록 + 검토 요약
    if (req.method === 'GET' && url.pathname === '/api/personas') {
      const out = []
      for (const dirent of await fs.readdir(LIBRARY, { withFileTypes: true }).catch(() => [])) {
        if (!dirent.isDirectory()) continue
        try {
          const m = await readManifest(dirent.name)
          const count = (status) => m.images.filter((i) => i.status === status).length
          out.push({
            personaId: m.personaId,
            name: m.profile?.name,
            createdAt: m.createdAt,
            workflow: m.workflow,
            total: m.images.length,
            pending: count('pending'),
            approved: count('approved'),
            rejected: count('rejected')
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

      if (req.method === 'GET' && parts.length === 3) return send(res, 200, await readManifest(pid))

      // 승인된 장면 피드 — 노출 단(threads-prototype 등)이 소비하는 유일한 목록
      if (req.method === 'GET' && parts[3] === 'approved') {
        const m = await readManifest(pid)
        return send(
          res,
          200,
          m.images
            .filter((i) => i.status === 'approved')
            .map((i) => ({ id: i.id, age: i.age, file: i.file, url: `/img/${pid}/${i.file}` }))
        )
      }

      // 판정 저장: { kind: 'scene'|'portrait', id, status: 'approved'|'rejected'|'pending' }
      if (req.method === 'POST' && parts[3] === 'review') {
        const { kind = 'scene', id, status } = await readBody(req)
        if (!['approved', 'rejected', 'pending'].includes(status))
          return send(res, 400, { error: 'status 값이 잘못됨' })
        const manifest = await readManifest(pid)
        const entry = findEntry(manifest, kind, id)
        if (!entry) return send(res, 404, { error: `항목 없음: ${kind} ${id}` })
        entry.status = status
        await writeManifest(pid, manifest)
        const label = kind === 'portrait' ? `포트레이트 age-${id}` : `장면 ${id}`
        logAction(`${pid}  ${ACTION_LABEL[status]}  ${label}`)
        return send(res, 200, { ok: true, entry })
      }

      // 성별 수정: { gender: 'male'|'female'|null } — 자동 감지가 틀렸을 때 어드민이 바로잡는다.
      // manifest의 성별과 모든 프롬프트(포트레이트·장면)를 새 성별로 재구성한다.
      // 이미 생성된 이미지는 그대로 두므로, 틀리게 나온 장은 재생성해야 반영된다
      // (포트레이트 먼저 → 그 단계 장면 순서). Firestore 프로필에도 역동기화한다.
      if (req.method === 'POST' && parts[3] === 'gender') {
        const { gender = null } = await readBody(req)
        if (![null, 'male', 'female'].includes(gender))
          return send(res, 400, { error: "gender는 'male'|'female'|null 이어야 함" })
        const manifest = await readManifest(pid)
        manifest.profile = { ...(manifest.profile || {}), gender }
        manifest.gender = { ...(manifest.gender || {}), value: gender, source: 'manual' }
        for (const pt of manifest.agePortraits || [])
          pt.prompt = composeAgePortraitPrompt(manifest.profile, pt.age)
        for (const img of manifest.images || [])
          img.prompt =
            manifest.workflow === 'sdxl'
              ? composeSdxlPrompt(manifest.profile, img)
              : manifest.workflow === 'gemini'
                ? composeGeminiScenePrompt(manifest.profile, img)
                : composeKontextPrompt(manifest.profile, img) // kontext·hybrid
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
          note: '성별이 수정되고 프롬프트가 갱신되었습니다. 잘못 생성된 장은 재생성하세요 (포트레이트 먼저, 그다음 그 단계 장면).'
        })
      }

      // 재생성: { kind: 'scene'|'portrait', id } — 동기 처리(장당 ~15초)
      if (req.method === 'POST' && parts[3] === 'regen') {
        const { kind = 'scene', id } = await readBody(req)
        const label = kind === 'portrait' ? `포트레이트 age-${id}` : `장면 ${id}`
        logAction(`${pid}  ↻ 재생성 시작  ${label}`)
        const result = await regenerate(pid, kind, id)
        logAction(
          `${pid}  ↻ 재생성 완료  ${label}  (${(result.entry.elapsedMs / 1000).toFixed(1)}s${result.entry.seed != null ? `, seed ${result.entry.seed}` : ''})`
        )
        return send(res, 200, result)
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
