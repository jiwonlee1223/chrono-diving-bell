// ComfyUI output 복구 — 생성은 끝났으나 /view 다운로드가 실패해 로컬(library/<pid>/videos)·
// Firebase에 클립이 없을 때, ComfyUI 서버의 /history에 남은 output에서 각 장면 id의 최신 mp4를
// 다시 내려받아 로컬 캐시를 복원한다. (Firebase 업로드는 호출측이 uploadPersonaVideos로 이어서 한다.)
//
// 배경: admin 클립 잡은 ComfyUI 생성·저장을 먼저 끝낸 뒤 /view로 받아 #save 한다. 생성은 성공했지만
// 다운로드가 실패하면 manifest.clips.done=0 인데 서버 output 폴더엔 파일이 남는다 — 그 파일을 회수한다.
//
// Electron 비의존 순수 Node.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const toSlash = (s) => (s || '').replace(/\\/g, '/')

/** /view 다운로드 — subfolder 백슬래시(Windows ComfyUI) 원본 우선, 실패 시 슬래시로 폴백. */
async function fetchView(host, file) {
  const variants = [file.subfolder, toSlash(file.subfolder)].filter(
    (v, i, a) => a.indexOf(v) === i
  )
  let lastErr
  for (const subfolder of variants) {
    const q = new URLSearchParams({ filename: file.filename, subfolder, type: file.type || 'output' })
    try {
      const res = await fetch(`${host}/view?${q}`)
      if (res.ok) return Buffer.from(await res.arrayBuffer())
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`/view 실패 (${file.filename}): ${lastErr?.message || '알 수 없음'}`)
}

/**
 * ComfyUI /history에서 subfolders에 속한 mp4 output을 모아 장면 id별 최신 카운터 파일을 고른다.
 * @returns {Map<string, {file: object, counter: number}>}  id → 최신 output file
 */
export async function indexComfyOutputs(host, subfolders = ['chrono-zoetrope/regen', 'chrono-zoetrope/loop']) {
  const res = await fetch(`${host}/history`)
  if (!res.ok) throw new Error(`ComfyUI /history 실패: HTTP ${res.status}`)
  const hist = await res.json()
  const wanted = new Set(subfolders.map(toSlash))
  const latest = new Map()
  for (const entry of Object.values(hist)) {
    for (const node of Object.values(entry.outputs || {})) {
      for (const key of ['videos', 'gifs', 'images']) {
        for (const f of node[key] || []) {
          if (typeof f.filename !== 'string' || !/\.(mp4|webm)$/i.test(f.filename)) continue
          if (!wanted.has(toSlash(f.subfolder))) continue
          // "<id>_<counter>_.mp4" (ComfyUI SaveVideo 명명). id에는 밑줄이 없다(예: 0-1).
          const m = /^(.*?)_(\d+)_?\.(?:mp4|webm)$/i.exec(f.filename)
          if (!m) continue
          const id = m[1]
          const counter = parseInt(m[2], 10)
          const prev = latest.get(id)
          if (!prev || counter > prev.counter) latest.set(id, { file: f, counter })
        }
      }
    }
  }
  return latest
}

/**
 * 장면 id 목록을 ComfyUI output에서 회수해 videosDir/<id>.mp4 로 저장.
 * @param {object} p
 * @param {string} p.host        ComfyUI 서버
 * @param {string[]} p.ids       기대 장면 id (manifest.images 순서)
 * @param {string} p.videosDir   library/<pid>/videos
 * @param {string[]} [p.subfolders]
 * @param {(e:object)=>void} [p.onProgress]
 * @returns {Promise<{recovered:string[], missing:string[]}>}
 */
export async function recoverClipsFromComfy({ host, ids, videosDir, subfolders, onProgress = () => {} }) {
  const latest = await indexComfyOutputs(host, subfolders)
  await mkdir(videosDir, { recursive: true })
  const recovered = []
  const missing = []
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    onProgress({ phase: 'recover', done: i, total: ids.length, id })
    const hit = latest.get(id)
    if (!hit) {
      missing.push(id)
      continue
    }
    const data = await fetchView(host, hit.file)
    await writeFile(join(videosDir, `${id}.mp4`), data)
    recovered.push(id)
  }
  onProgress({ phase: 'recover', done: ids.length, total: ids.length })
  return { recovered, missing }
}
