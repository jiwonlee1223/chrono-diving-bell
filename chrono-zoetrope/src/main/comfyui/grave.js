// 장지(안식처) 파노라마 — 장례식과 별개의 생성물 (2026-08-04).
//
// 장례식(funeral.js)이 "식장에 선 고인의 시선"이라면, 장지는 그 다음 — 실제로 묻힌(안치된)
// 곳의 풍경이다. 사용자가 답한 안식처(burialSite)·장례 방식(funeralMethod)에 맞는 공간에
// **묘비석(또는 수목장 표석·납골당 안치단 등 그 방식에 맞는 표지)을 파노라마 정중앙**에 두고,
// 묘비명(epitaph)·이름을 새긴다. 사람이 없는 고요한 풍경이다.
//
// 적용 범위: 1차 플로우 전용(variant 개념 없음 — 지금의 죽음 하나뿐).
// 체험 순서: 장례식 영상 → 장지 파노라마 영상 → 암전 → reel (server/index.mjs grave phase).
//
// 구조는 funeral.js의 워크플로우를 그대로 따른다:
//   stage 'image': 배경 합성(synthesizeGraveSetting) → Gemini 4:1 파노라마 → status 'review'
//   stage 'video': admin 승인 후 Wan2.2 I2V 시네마그래프 → status 'done'
// manifest.grave = { rev, status, approved, image, video, setting, firebase, history[...] }
// 파일: library/<pid>/grave/grave-r<rev>.png|.mp4

import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { ComfyUIClient } from './client.js'
import { buildWan22I2VWorkflow } from './workflows.js'
import { nearestGeminiAspect } from './gemini-client.js'
import { collectFuneralWishes, resolveDeceasedAge } from './funeral.js'

export const GRAVE_DIR = 'grave'
export const GRAVE_MANIFEST_KEY = 'grave'

// Wan 파라미터 — 장례식과 동일한 4:1 규격.
const DEFAULT_VIDEO = { width: 1920, height: 480, length: 81, fps: 16, steps: 4, shift: 5.0 }

// 시네마그래프 모션 — 무인 풍경이라 인물 보호 지시는 불필요. 움직임은 자연 요소에만.
const DEFAULT_MOTION_PROMPT =
  'A living photograph, cinemagraph style: a quiet resting place, completely still and solemn, ' +
  'the fixed viewpoint locked at the center facing the grave marker. ' +
  'All visible motion comes from nature itself: grass and leaves sway gently in a soft breeze, ' +
  'clouds drift almost imperceptibly across the sky, light shifts subtly, ' +
  'a few petals or leaves tremble on the ground. ' +
  'The camera is completely locked and static. Cinematic, realistic, extremely understated and peaceful motion.'

/**
 * 장지 배경 합성 — burialSite·funeralMethod(한국어 자유 텍스트)를 읽어 안식처의 풍경과
 * 표지(묘비/수목장 표석/납골당 안치단/바닷가 추모 지점…)를 영어로 묘사한다.
 * 희망사항이 없으면 null → 한국의 야산 묘역(봉분+화강암 묘비) 디폴트.
 * @returns {Promise<{setting:string, marker:string}|null>}
 */
export async function synthesizeGraveSetting(gclient, wishes, { signal, log = () => {} } = {}) {
  const method = wishes?.funeralMethod
  const site = wishes?.burialSite
  if (!method && !site) return null
  const prompt =
    `A Korean person answered questions about how and where they want to be laid to rest` +
    ` (treat Korean text as-is):\n` +
    (method ? `- The funeral method they wished for: "${method}"\n` : '') +
    (site ? `- Where they wished to be laid to rest: "${site}"\n` : '') +
    `\nWe are composing a photograph of their actual RESTING PLACE — the grave site itself, after the` +
    ` funeral, honoring their wishes faithfully. Decide:\n` +
    `- "setting": the landscape or space around the resting place, in concrete visual terms — terrain,` +
    ` vegetation or architecture, materials, weather and light, season. In Korea unless the wish names` +
    ` another country. (A tree burial / 수목장 → a memorial tree in a quiet forest garden; scattering at` +
    ` sea → a coastal memorial spot overlooking the water; a columbarium → its serene interior or garden;` +
    ` a traditional burial → a grassy hillside grave with a burial mound...)\n` +
    `- "marker": the physical marker of THIS person's resting place that stands at the center of the scene` +
    ` — a granite headstone, a small memorial stone at the foot of a tree, a columbarium niche, a memorial` +
    ` plaque... whatever fits the wish. Describe its shape and material.\n` +
    `Everything in ENGLISH, physical and visible details only, no emotions or narration. 1-3 sentences per field.\n` +
    `Return ONLY JSON: {"setting":"...","marker":"..."}`
  try {
    const out = await gclient.generateText({ prompt, responseJson: true, signal })
    // 관용 파싱 — funeral.js와 동일 사유(코드펜스·후행 쉼표 오염)
    let parsed
    try {
      parsed = JSON.parse(out)
    } catch {
      const cleaned = out
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .replace(/,\s*([}\]])/g, '$1')
      parsed = JSON.parse(cleaned)
    }
    if (!parsed.setting || !parsed.marker) return null
    const setting = {
      setting: String(parsed.setting).trim(),
      marker: String(parsed.marker).trim()
    }
    log(`  [장지] 배경 합성: ${setting.setting.slice(0, 100)}`)
    return setting
  } catch (err) {
    log(`  [경고] 장지 배경 합성 실패(디폴트 묘역으로 폴백): ${err.message}`)
    return null
  }
}

/**
 * 장지 파노라마 프롬프트 — 표지(묘비 등)를 정중앙에 둔 무인 360 equirect 풍경.
 *
 * 새김글은 모델에게 맡기지 않는다(2026-08-04): 이미지 모델의 한글은 몇 글자만 넘어가도 뭉개진다.
 * 대신 표지 정면에 **글자 없는 매끈한 명판**을 요구하고, 생성 직후 inscribeMarker()가 실제 한글
 * 폰트로 이름·묘비명을 그 자리에 합성한다 — 글자가 100% 정확하다.
 */
export function buildGravePrompt(profile = {}, wishes = null, setting = null) {
  const age = resolveDeceasedAge(profile, 'present')
  const scene = setting
    ? `${setting.setting} `
    : `A quiet Korean hillside burial ground (산소): a grassy slope with a traditional rounded burial mound ` +
      `(봉분), low hills and trees in the distance, distinctly Korean landscape. `
  const marker = setting?.marker
    ? `${setting.marker} `
    : `An upright granite headstone stands before the mound. `
  // 명판은 반드시 비워 둔다 — 글자는 후처리(inscribeMarker)가 실제 폰트로 얹는다.
  const inscription =
    `The front face of the marker is a smooth, flat, polished, completely BLANK surface — ` +
    `NO letters, NO characters, NO engraving, NO symbols on it; an empty plaque facing the viewer squarely. `
  return (
    `A 360-degree equirectangular panoramic photograph, seamless horizontal wrap, captured with a 360 camera ` +
    `from a single fixed point: standing at the resting place of a person who died at ${age}, facing their grave. ` +
    `This is the place they wished to be laid to rest, honor it faithfully. ` +
    scene +
    `At the exact HORIZONTAL CENTER of the panorama, directly facing the viewer, stands the marker of this ` +
    `person's resting place: ` +
    marker +
    inscription +
    `Fresh flowers rest at its base. ` +
    // 스케일 — 표지를 화면 가득 채우지 않게. 바닥이 하단 끝까지, 하늘이 상단 끝까지.
    `IMPORTANT SCALE: shot from about 3 to 4 meters back, at eye height on a tripod — the marker occupies only ` +
    `a modest part of the frame, well under half of the image height, and the landscape around it reads as a ` +
    `subject in its own right. The open ground stretches across the ENTIRE bottom of the panorama down to the ` +
    `nadir beneath the camera, and the sky (or ceiling, if indoors) spreads across the ENTIRE top toward the ` +
    `zenith — nothing at the top or bottom is cropped. ` +
    `TRUE equirectangular projection: the horizon runs straight across the vertical middle; straight lines bow ` +
    `and curve away from the center as in a real 360 camera capture; the far LEFT and far RIGHT edges are the ` +
    `same direction behind the camera and meet seamlessly on a plain, uncluttered stretch of the landscape ` +
    `(open ground or sky, no complex detail crossing that joining line). ` +
    // 무인 — 장례가 끝난 뒤의 고요. 사람·유령 금지.
    `The place is completely EMPTY of people — no person, no mourner, no figure anywhere; no ghosts, no ` +
    `translucent figures. Only the resting place itself, quiet after the funeral. ` +
    `Soft natural light true to the place and season, gentle shadows, a peaceful and solemn stillness. ` +
    `Photorealistic, cinematic. Absolutely NO text, letters, signs, banners or captions anywhere in the image — ` +
    `including on the marker itself, whose front plaque stays completely blank.`
  )
}

// ── 새김글 후처리 합성 ────────────────────────────────────────────────────────
// 이미지 모델의 한글은 뭉개지므로, 생성된 파노라마의 정중앙 명판 위에 실제 한글 폰트로
// 이름·묘비명을 그려 얹는다. 표지는 프롬프트상 항상 파노라마 정중앙 + 카메라 3~4m 거리라
// 위치·크기를 비율로 잡을 수 있다(config.grave.inscription으로 미세 조정 가능):
//   widthFrac: 텍스트 블록 폭(이미지 폭 대비, 기본 0.10 — 4096px에서 ~410px)
//   yFrac:     텍스트 블록 세로 중심(이미지 높이 대비, 기본 0.58 — 지평선 살짝 아래 명판 높이)
// 새김 느낌: 어두운 각인 본체 + 1px 아래 밝은 하이라이트(음각의 빛), multiply 계열 대신
// 반투명 합성으로 돌 질감이 비치게 한다. XML 이스케이프 필수(이름·묘비명은 자유 텍스트).
const esc = (s) =>
  String(s).replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]
  )

// 묘비명 줄바꿈 — 공백 우선, 없으면 글자 수로 자른다(한글은 공백이 드물 수 있다).
function wrapText(text, maxChars) {
  const words = String(text).trim().split(/\s+/)
  const lines = []
  let cur = ''
  for (const w of words) {
    const cand = cur ? `${cur} ${w}` : w
    if (cand.length <= maxChars) cur = cand
    else {
      if (cur) lines.push(cur)
      // 단어 자체가 너무 길면 강제 분절
      let rest = w
      while (rest.length > maxChars) {
        lines.push(rest.slice(0, maxChars))
        rest = rest.slice(maxChars)
      }
      cur = rest
    }
  }
  if (cur) lines.push(cur)
  return lines
}

/**
 * 파노라마 정중앙 명판에 이름·묘비명을 합성한다(제자리 덮어쓰기).
 * 실패해도 던지지 않는다 — 글자 없는 명판이 그대로 남는 게 안전한 폴백이다.
 * @returns {Promise<boolean>} 합성 적용 여부
 */
export async function inscribeMarker(imagePath, { name, epitaph }, icfg = {}, log = () => {}) {
  if (!name && !epitaph) return false
  try {
    const img = sharp(imagePath)
    const { width: W, height: H } = await img.metadata()
    if (!W || !H) return false
    const widthFrac = icfg.widthFrac ?? 0.1
    const yFrac = icfg.yFrac ?? 0.58
    const boxW = Math.round(W * widthFrac)
    // 폰트 크기 — 블록 폭 기준. 이름은 크게, 묘비명은 작게(여러 줄).
    const nameSize = Math.round(boxW / Math.max(3, Math.min(6, String(name || '').length)))
    const epiSize = Math.round(boxW / 11)
    const epiLines = epitaph ? wrapText(epitaph, 10) : []
    const lineGap = Math.round(epiSize * 1.5)
    const blockH =
      (name ? nameSize + Math.round(epiSize * 0.8) : 0) + epiLines.length * lineGap + epiSize
    // 명조 계열 폴백 체인 — 생성 머신이 mac(AppleMyungjo)이든 Windows(Batang)든 잡히게.
    const family = icfg.fontFamily || "'Nanum Myeongjo', 'Batang', 'AppleMyungjo', serif"
    const ink = icfg.color || '#2a2a2e'
    const inkOp = icfg.opacity ?? 0.82
    const hiOp = Math.min(0.4, inkOp * 0.45)
    let y = name ? nameSize : epiSize
    const nameY = y
    const epiStartY = name ? y + Math.round(epiSize * 0.8) + lineGap : lineGap
    const textEls = (dx, dy, fill, op) =>
      (name
        ? `<text x="${boxW / 2 + dx}" y="${nameY + dy}" font-size="${nameSize}" font-weight="600" fill="${fill}" fill-opacity="${op}" text-anchor="middle" font-family="${esc(family)}">${esc(name)}</text>`
        : '') +
      epiLines
        .map(
          (ln, i) =>
            `<text x="${boxW / 2 + dx}" y="${epiStartY + i * lineGap + dy}" font-size="${epiSize}" fill="${fill}" fill-opacity="${op}" text-anchor="middle" font-family="${esc(family)}">${esc(ln)}</text>`
        )
        .join('')
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${boxW}" height="${blockH + epiSize}">` +
      // 음각의 빛 — 아래로 1px 밝은 사본이 먼저, 그 위에 어두운 각인 본체
      textEls(0, Math.max(1, Math.round(nameSize / 28)), '#ffffff', hiOp) +
      textEls(0, 0, ink, inkOp) +
      `</svg>`
    const overlay = Buffer.from(svg)
    const top = Math.round(H * yFrac - (blockH + epiSize) / 2)
    const left = Math.round(W / 2 - boxW / 2)
    const out = await img
      .composite([{ input: overlay, top: Math.max(0, top), left: Math.max(0, left) }])
      .png()
      .toBuffer()
    await fs.writeFile(imagePath, out)
    log(
      `  [장지] 새김글 합성: ${[name, epitaph && `"${String(epitaph).slice(0, 20)}…"`].filter(Boolean).join(' · ')}`
    )
    return true
  } catch (err) {
    log(`  [경고] 장지 새김글 합성 실패(빈 명판 유지): ${err.message}`)
    return false
  }
}

async function readManifest(personaDir) {
  return JSON.parse(await fs.readFile(path.join(personaDir, 'manifest.json'), 'utf-8'))
}
async function writeManifest(personaDir, manifest, onManifest) {
  await fs.writeFile(path.join(personaDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  if (onManifest) await onManifest(manifest)
}

/**
 * 장지 워크플로우 — funeral.js runFuneralWorkflow와 같은 2단계+승인 게이트 구조.
 *   stage 'image': 배경 합성 → Gemini 4:1 파노라마 → status 'review'
 *   stage 'video': 승인된 이미지를 Wan2.2 I2V로 영상화 → status 'done'
 * @param {object} p  runFuneralWorkflow와 동일 형태(variant·faceRef 없음)
 */
export async function runGraveWorkflow({
  personaDir,
  gclient,
  config,
  stage = 'image',
  doc = null,
  force = false,
  signal,
  log = () => {},
  onManifest,
  onProgress = () => {}
} = {}) {
  const gcfg = config.grave || config.funeral || {} // 전용 설정이 없으면 장례식 설정을 따른다
  const manifest = await readManifest(personaDir)
  const profile = manifest.profile || {}
  await fs.mkdir(path.join(personaDir, GRAVE_DIR), { recursive: true })

  let g = manifest[GRAVE_MANIFEST_KEY]
  if (stage === 'image' && (!g || force || g.status === 'done')) {
    const rev = (g?.rev || 0) + 1
    g = manifest[GRAVE_MANIFEST_KEY] = {
      rev,
      status: 'image',
      error: null,
      approved: false,
      approvedAt: null,
      image: null,
      video: null,
      firebase: null,
      history: [
        ...(g?.history || []),
        {
          rev,
          imageFile: null,
          videoFile: null,
          prompt: null,
          startedAt: new Date().toISOString(),
          doneAt: null,
          status: 'image',
          error: null
        }
      ]
    }
    await writeManifest(personaDir, manifest, onManifest)
  }
  if (!g) return { ok: false, error: '장지 이미지가 아직 없다 — 먼저 이미지 생성 단계를 실행하라' }
  const rev = g.rev
  const hist = g.history[g.history.length - 1]
  const imageFile = `${GRAVE_DIR}/grave-r${rev}.png`
  // [video 단계 force] 같은 rev·같은 승인 이미지로 영상만 재생성(funeral.js와 동일한 튜닝 루프)
  if (stage === 'video' && force && g.video) {
    g.videoHistory = [...(g.videoHistory || []), g.video]
    g.videoRev = (g.videoRev || 1) + 1
    g.video = null
    g.firebase = null
    g.status = 'video'
    await writeManifest(personaDir, manifest, onManifest)
  }
  const vk = g.videoRev || 1
  const videoFile =
    vk === 1 ? `${GRAVE_DIR}/grave-r${rev}.mp4` : `${GRAVE_DIR}/grave-r${rev}-v${vk}.mp4`
  const setState = async (status, patch = {}) => {
    g.status = status
    Object.assign(g, patch)
    hist.status = status
    if (patch.error !== undefined) hist.error = patch.error
    if (status === 'done') hist.doneAt = new Date().toISOString()
    await writeManifest(personaDir, manifest, onManifest)
  }

  try {
    if (stage === 'image') {
      if (!g.image || g.image.file !== imageFile) {
        if (signal?.aborted) return { ok: false, cancelled: true, rev }
        const wishes = doc ? collectFuneralWishes(doc) : null
        // 배경 합성 — rev별 캐시(재시도 재사용). 희망 없음/실패 = null → 디폴트 한국 묘역.
        if (g.setting === undefined) {
          g.setting = wishes ? await synthesizeGraveSetting(gclient, wishes, { signal, log }) : null
          hist.setting = g.setting
          await writeManifest(personaDir, manifest, onManifest)
        }
        const prompt = buildGravePrompt(profile, wishes, g.setting)
        const pano = config.panorama || { width: 4096, height: 1024 }
        const model = gcfg.model || config.gemini?.sceneModel // flash — pro는 4:1 거부
        onProgress({ phase: 'image' })
        log(`  [장지] 파노라마 생성 (rev ${rev}, ${pano.width}×${pano.height})`)
        const t0 = Date.now()
        const data = await gclient.generateImage({
          prompt,
          references: [], // 장지는 레퍼런스 없음 — 텍스트만으로 생성(얼굴·구도 참조 불필요)
          aspectRatio: nearestGeminiAspect(pano.width, pano.height),
          imageSize: gcfg.imageSize || config.gemini?.imageSize || '2K',
          model,
          signal
        })
        await fs.writeFile(path.join(personaDir, imageFile), data)
        // 새김글 후처리 — 빈 명판 위에 실제 한글 폰트로 이름·묘비명 합성(실패해도 계속).
        const inscribed = await inscribeMarker(
          path.join(personaDir, imageFile),
          { name: profile.name || null, epitaph: wishes?.epitaph || null },
          gcfg.inscription || {},
          log
        )
        g.inscription = inscribed
          ? { name: profile.name || null, epitaph: wishes?.epitaph || null, applied: true }
          : null
        hist.imageFile = imageFile
        hist.prompt = prompt
        await setState('review', {
          error: null,
          image: {
            file: imageFile,
            prompt,
            elapsedMs: Date.now() - t0,
            generatedAt: new Date().toISOString()
          }
        })
        log(`  [장지] 파노라마 완료 (${((Date.now() - t0) / 1000).toFixed(1)}s) — 검토 대기`)
      } else if (g.status === 'image') {
        await setState('review')
      }
      return { ok: true, rev, stage: 'image' }
    }

    // ── stage 'video': 승인 게이트 ──
    if (!g.image) throw new Error('장지 이미지가 없다 — 먼저 이미지 생성 단계를 실행하라')
    if (!g.approved) throw new Error('승인되지 않았다 — admin에서 이미지를 승인한 뒤 영상화하라')
    if (!g.video || g.video.file !== videoFile) {
      if (signal?.aborted) return { ok: false, cancelled: true, rev }
      const v = { ...DEFAULT_VIDEO, ...(gcfg.video || {}) }
      onProgress({ phase: 'video' })
      log(`  [장지] Wan2.2 영상화 (${v.width}×${v.height}, ${v.length}f)`)
      const client = new ComfyUIClient({
        host: config.host,
        timeoutMs: gcfg.timeoutMs ?? 240000,
        maxWaitMs: gcfg.maxWaitMs ?? 3600000
      })
      try {
        await setState('video')
        const t0 = Date.now()
        const buf = await fs.readFile(path.join(personaDir, g.image.file))
        const uploaded = await client.uploadImage(
          buf,
          `grave-${path.basename(personaDir)}-r${rev}.png`
        )
        const workflow = buildWan22I2VWorkflow({
          prompt: gcfg.motionPrompt || DEFAULT_MOTION_PROMPT,
          startImage: uploaded.name,
          width: v.width,
          height: v.height,
          length: v.length,
          fps: v.fps,
          steps: v.steps,
          boundaryStep: Math.floor(v.steps / 2),
          shift: v.shift,
          filenamePrefix: `chrono-zoetrope/grave/grave-${path.basename(personaDir)}-r${rev}-v${vk}`
        })
        const { videos } = await client.generateVideo(workflow, {
          onProgress: (e) => onProgress({ phase: 'video', ...e })
        })
        await fs.writeFile(path.join(personaDir, videoFile), videos[0].data)
        hist.videoFile = videoFile
        await setState('done', {
          error: null,
          video: {
            file: videoFile,
            elapsedMs: Date.now() - t0,
            generatedAt: new Date().toISOString()
          }
        })
        log(`  [장지] 영상 완료 (${((Date.now() - t0) / 1000).toFixed(1)}s) — Firebase 저장 가능`)
      } finally {
        client.close()
      }
    }
    return { ok: true, rev, stage: 'video' }
  } catch (err) {
    if (signal?.aborted) return { ok: false, cancelled: true, rev }
    await setState('error', { error: String(err.message || err) }).catch(() => {})
    return { ok: false, rev, error: String(err.message || err) }
  }
}
