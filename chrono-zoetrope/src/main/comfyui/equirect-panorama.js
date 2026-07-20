// equirect-panorama.js — 주마등 1인칭 360° 파노라마 (equirect-native, 현재 채택).
//
// 1~11번 접근(평면 원근 스티칭; docs/panorama-approaches.md)은 진짜 360 카메라 기하가 안 나와 폐기.
// equirect는 Gemini에 "360 equirectangular panorama"를 직접 요청해 **한 번의 호출로 진짜 360 기하**를 얻는다
// (곡선 지평선·바닥 nadir·천장 zenith·직선 휨·방 wrap). 스티칭·조립·크로스페이드가 전부 불필요하다.
//
// 파이프라인:
//   Gemini gaze-equirect(21:9)  →  세로 중앙 crop으로 4:1 눈높이 띠(nadir/zenith 제거)  →  [옵션] wrap seamfix
//
// 변환 규칙: equirect(full sphere)를 4:1로 만들 땐 **세로 crop**(가로 stretch 금지 — 왜곡). 실린더는
// 눈높이 띠만 보이므로(§4.1) crop이 정합. Gemini 현재 모델이 4:1 aspect 미지원이라 sourceAspect는 21:9.
//
// wrap 주의: Gemini equirect의 좌우 끝은 진짜 주기적이지 않아 등 뒤에 이음매가 남는다. seamfix(Flux Fill)는
// 서로 다른 두 벽을 이으며 '기둥'을 만들 수 있어 기본 OFF. 근본 해결은 엣지 구도 or SDXL SeamlessTile 봉합(후속).
//
// electron 모름(순수 Node). gclient(Gemini)·client(ComfyUI, seamfix 시)는 호출자가 주입한다.

import sharp from 'sharp'
import { buildGeminiSeamFixWorkflow, randomSeed } from './workflows.js'
import { SEAM_BLEND_PROMPT } from './prompt-builder.js'

/**
 * @param {object} p
 * @param {import('./gemini-client.js').GeminiClient} p.gclient
 * @param {import('./client.js').ComfyUIClient} [p.client]   seamfix 켤 때만 필요
 * @param {string} p.prompt                                  composeEquirectGazePrompt(profile,item)
 * @param {{width:number,height:number}} [p.panorama]        최종 파노라마 크기(4:1). 기본 4096×1024.
 * @param {string} [p.sourceAspect]                          Gemini 요청 비율. 기본 '21:9'(모델 최대 와이드).
 * @param {string} [p.imageSize] @param {string} [p.model]
 * @param {false|{bandWidth?:number,feather?:number}} [p.seamfix]  wrap 이음매 보정(기본 false)
 * @param {string} [p.pid] @param {string} [p.sceneId] @param {AbortSignal} [p.signal]
 * @param {(e:{step:string})=>void} [p.onProgress]
 * @returns {Promise<{ src:Buffer, panorama:Buffer, workflow:object|null }>}
 *   src = Gemini 원본(21:9, edge 재보정용 보관), panorama = 최종 4:1
 */
export async function generateEquirectPanorama({
  gclient,
  client,
  prompt,
  panorama = { width: 4096, height: 1024 },
  sourceAspect = '21:9',
  imageSize = '2K',
  model,
  seamfix = false,
  pid = 'p',
  sceneId = 'scene',
  signal,
  onProgress = () => {}
}) {
  const { width: W, height: H } = panorama

  // 1) Gemini 360 equirect (gaze 구도 포함) — 한 콜
  onProgress({ step: 'equirect' })
  const src = await gclient.generateImage({ prompt, references: [], aspectRatio: sourceAspect, imageSize, model, signal })

  // 2) 세로 중앙 crop → 목표 비율(4:1) 눈높이 띠 → 목표 해상도
  const panoBuf = await cropToPanorama(src, W, H)

  // 3) (옵션) wrap seam 보정
  let out = panoBuf
  let workflow = null
  if (seamfix && client) {
    onProgress({ step: 'seam' })
    const up = await client.uploadImage(panoBuf, `${pid}-${sceneId}-eq.png`)
    workflow = buildGeminiSeamFixWorkflow({
      referenceImage: up.name,
      prompt: SEAM_BLEND_PROMPT,
      bandPrompt: SEAM_BLEND_PROMPT, // 등 뒤 벽에 내용 있으니 '이어 섞기'(민무늬 벽 강제 아님)
      width: W,
      height: H,
      bandWidth: seamfix.bandWidth,
      feather: seamfix.feather,
      bandModel: 'flux-fill',
      seed: randomSeed(),
      filenamePrefix: `chrono-zoetrope/${pid}/${sceneId}`
    })
    const res = await client.generate(workflow, { onProgress: (p) => onProgress({ step: 'seam', ...p }) })
    out = (res.images.find((im) => /-pano_/.test(im.filename)) || res.images[0]).data
  }

  return { src, panorama: out, workflow }
}

/** equirect 원본(21:9 등)을 세로 중앙 crop해 목표 비율(W:H)로 만들고 목표 해상도로 리사이즈. */
export async function cropToPanorama(buf, W, H) {
  const m = await sharp(buf).metadata()
  const cropH = Math.min(m.height, Math.round((m.width * H) / W)) // 목표 비율 만족하는 세로 높이
  const top = Math.max(0, Math.round((m.height - cropH) / 2))
  return sharp(buf).extract({ left: 0, top, width: m.width, height: cropH }).resize(W, H, { fit: 'fill' }).png().toBuffer()
}
