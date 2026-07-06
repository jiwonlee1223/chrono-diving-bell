#!/usr/bin/env node
// 생애 라이브러리 검토(admin) 서버 — 의존성 제로 (node:http).
//
//   node scripts/admin-server.mjs [--port 8787] [--library <dir>]
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
import { buildKontextWorkflow, buildSdxlWorkflow, randomSeed } from '../src/main/comfyui/workflows.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const PORT = parseInt(argOf('--port', '8787'), 10)
const LIBRARY = path.resolve(root, argOf('--library', config.outDir))

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
  if (kind === 'portrait') return (manifest.agePortraits || []).find((p) => String(p.age) === String(id))
  return (manifest.images || []).find((img) => img.id === id)
}

// ── 재생성: manifest에 기록된 프롬프트를 그대로 쓰고 시드만 새로 뽑는다 ──
// (장면 문구를 바꾸는 건 프롬프트 풀 수정의 영역 — 여기서는 확률만 다시 굴린다.)
async function regenerate(pid, kind, id) {
  const manifest = await readManifest(pid)
  const entry = findEntry(manifest, kind, id)
  if (!entry) throw new Error(`항목 없음: ${kind} ${id}`)

  const client = new ComfyUIClient({ host: config.host, timeoutMs: config.timeoutMs })
  try {
    const seed = randomSeed()
    let wf
    if (manifest.workflow === 'kontext') {
      // 레퍼런스: 장면이면 그 단계의 나이 포트레이트, 포트레이트면 원본 프로필 사진.
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

// ── HTTP 서버 ─────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' }

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
        if (!['approved', 'rejected', 'pending'].includes(status)) return send(res, 400, { error: 'status 값이 잘못됨' })
        const manifest = await readManifest(pid)
        const entry = findEntry(manifest, kind, id)
        if (!entry) return send(res, 404, { error: `항목 없음: ${kind} ${id}` })
        entry.status = status
        await writeManifest(pid, manifest)
        const label = kind === 'portrait' ? `포트레이트 age-${id}` : `장면 ${id}`
        logAction(`${pid}  ${ACTION_LABEL[status]}  ${label}`)
        return send(res, 200, { ok: true, entry })
      }

      // 재생성: { kind: 'scene'|'portrait', id } — 동기 처리(장당 ~15초)
      if (req.method === 'POST' && parts[3] === 'regen') {
        const { kind = 'scene', id } = await readBody(req)
        const label = kind === 'portrait' ? `포트레이트 age-${id}` : `장면 ${id}`
        logAction(`${pid}  ↻ 재생성 시작  ${label}`)
        const result = await regenerate(pid, kind, id)
        logAction(`${pid}  ↻ 재생성 완료  ${label}  (${(result.entry.elapsedMs / 1000).toFixed(1)}s, seed ${result.entry.seed})`)
        return send(res, 200, result)
      }
    }

    send(res, 404, { error: 'not found' })
  } catch (err) {
    send(res, 500, { error: String(err.message || err) })
  }
})

server.listen(PORT, () => {
  console.log(`[admin] http://localhost:${PORT}  (library: ${LIBRARY}, comfyui: ${config.host})`)
})
