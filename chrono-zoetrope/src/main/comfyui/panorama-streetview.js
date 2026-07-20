// Path B — rotate-and-outpaint (생성형 Street View) 오케스트레이터.
//
// 넓은 앵커 2장을 맞대면 투영 중심이 2개라 방위각이 연속하지 않는다(= "대칭 두 사진", Street View 아님).
// 여기서는 front(Gemini, 주인공 중앙) 한 장에서 **좌우로 이어 그리며(continuation-outpaint)** 실린더 둘레를
// 채운다. 각 스텝이 직전 픽셀을 이어받으니 front → ±90° → 뒤쪽까지 방위각이 연속으로 흐른다(gap-fill이 아니라
// continuation이라 선명). 마지막에 등 뒤(±180°가 만나는 wrap 1곳)만 Flux Fill 밴드로 닫는다.
//
// 조립: [leftExt(tileSize) | front(2·tileSize) | rightExt(tileSize)] = 4·tileSize. front 중앙 = 주인공.
// ComfyUI generate = 좌우 아웃페인팅 패스들 + wrap 1. electron 모름(순수 Node).

import sharp from 'sharp'
import { buildFluxFillOutpaintWorkflow, buildGeminiSeamFixWorkflow, randomSeed } from './workflows.js'
import { SEAM_BLEND_PROMPT } from './prompt-builder.js'
import { nearestGeminiAspect } from './gemini-client.js'

const png = (buf) => sharp(buf).png().toBuffer()
const cropX = (buf, left, width, height) => sharp(buf).extract({ left, top: 0, width, height }).png().toBuffer()

/**
 * 한 방향으로 슬라이딩 아웃페인팅해 `fill`px 폭의 확장 스트립을 만든다.
 * 매 스텝: 현재 frontier의 context px를 앵커로 pad만큼 이어 그리고, 새 pad 영역을 누적.
 * @returns {Promise<Buffer>} fill×height 스트립. right면 왼쪽 끝이 front에, left면 오른쪽 끝이 front에 붙는다.
 */
async function slideOutpaint({ client, seed, side, fill, step, context, height, prompt, feather, denoise, steps, pid, sceneId, onProgress }) {
  let ctxImg = seed // context×height (front의 해당 끝)
  const regions = [] // { buf, left }  (최종 fill 캔버스 내 위치)
  let done = 0
  let idx = 0
  while (done < fill) {
    const pad = Math.min(step, fill - done)
    const up = await client.uploadImage(ctxImg, `${pid}-${sceneId}-${side}${idx}.png`)
    const wf = buildFluxFillOutpaintWorkflow({
      referenceImage: up.name,
      prompt,
      srcWidth: context,
      height,
      side,
      pad,
      feather,
      denoise,
      steps,
      seed: randomSeed(),
      filenamePrefix: `chrono-zoetrope/${pid}/${sceneId}-${side}${idx}`
    })
    const { images } = await client.generate(wf, { onProgress: (p) => onProgress({ step: `${side}${idx}`, ...p }) })
    const outImg = (images.find((im) => /-ext_/.test(im.filename)) || images[0]).data
    // outImg = (context + pad) 폭. 새로 그린 pad 영역과, 다음 앵커가 될 frontier context를 뽑는다.
    if (side === 'right') {
      const newRegion = await cropX(outImg, context, pad, height) // 오른쪽 새 영역
      regions.push({ buf: newRegion, left: done })
      ctxImg = await cropX(outImg, context + pad - context, context, height) // = 오른쪽 끝 context
    } else {
      const newRegion = await cropX(outImg, 0, pad, height) // 왼쪽 새 영역
      regions.push({ buf: newRegion, left: fill - done - pad })
      ctxImg = await cropX(outImg, 0, context, height) // 왼쪽 끝 context
    }
    done += pad
    idx++
  }
  const strip = sharp({ create: { width: fill, height, channels: 3, background: { r: 0, g: 0, b: 0 } } }).composite(
    regions.map((r) => ({ input: r.buf, left: r.left, top: 0 }))
  )
  return strip.png().toBuffer()
}

/**
 * @param {object} p
 * @param {import('./gemini-client.js').GeminiClient} [p.gclient]  front 생성용(frontAnchor 주면 불필요)
 * @param {import('./client.js').ComfyUIClient} p.client
 * @param {{ anchor:string, continuation:string }} p.prompts  front 프롬프트 + 연속 프롬프트
 * @param {Buffer} [p.frontAnchor]  주어지면 front 재생성 안 함(승인된 앵커 재사용)
 * @param {number} p.tileSize       파노라마 = tileSize×4, front = tileSize×2, 좌우 확장 각 tileSize
 * @param {string} p.imageSize
 * @param {string} p.model
 * @param {number} p.step           아웃페인팅 스텝 폭(px). 작을수록 안전·느림
 * @param {number} p.context        앵커 context 폭(px)
 * @param {number} p.feather        아웃페인팅 pad 페더
 * @param {number} p.outpaintSteps  Flux Fill KSampler steps
 * @param {number} p.bandWidth      wrap 닫기 밴드 폭
 * @param {number} p.bandFeather    wrap 밴드 페더
 * @param {string} p.pid
 * @param {string} p.sceneId
 * @param {(e:object)=>void} p.onProgress
 * @returns {Promise<{ front:Buffer, rightExt:Buffer, leftExt:Buffer, assembled:Buffer, panorama:Buffer, workflow:object }>}
 */
export async function generateStreetViewPanorama({
  gclient,
  client,
  prompts,
  frontAnchor = null,
  tileSize = 1024,
  imageSize = '2K',
  model,
  step = 1024,
  context = 1024,
  feather = 64,
  outpaintSteps = 20,
  bandWidth = 256,
  bandFeather = 96,
  pid = 'p',
  sceneId = 'scene',
  signal,
  onProgress = () => {}
}) {
  const W = tileSize * 4
  const H = tileSize
  const frontW = tileSize * 2 // 2048 (front, 주인공 중앙)
  const sideFill = tileSize // 1024 (좌·우 각 확장 = 90°)

  // 1) front (Gemini, 주인공 중앙) — 재사용 또는 생성
  onProgress({ step: 'front' })
  const frontRaw =
    frontAnchor ||
    (await gclient.generateImage({
      prompt: prompts.anchor,
      references: [],
      aspectRatio: nearestGeminiAspect(frontW, H),
      imageSize,
      model,
      signal
    }))
  const front = await sharp(frontRaw).resize(frontW, H, { fit: 'fill' }).png().toBuffer()

  // 2) 오른쪽으로 이어 그리기 (front 오른쪽 끝 → +90°…)
  onProgress({ step: 'right' })
  const rightSeed = await cropX(front, frontW - context, context, H)
  const rightExt = await slideOutpaint({
    client, seed: rightSeed, side: 'right', fill: sideFill, step, context, height: H,
    prompt: prompts.continuation, feather, denoise: 1.0, steps: outpaintSteps, pid, sceneId, onProgress
  })

  // 3) 왼쪽으로 이어 그리기 (front 왼쪽 끝 → −90°…)
  onProgress({ step: 'left' })
  const leftSeed = await cropX(front, 0, context, H)
  const leftExt = await slideOutpaint({
    client, seed: leftSeed, side: 'left', fill: sideFill, step, context, height: H,
    prompt: prompts.continuation, feather, denoise: 1.0, steps: outpaintSteps, pid, sceneId, onProgress
  })

  // 4) 조립 [leftExt | front | rightExt]
  const assembled = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([
      { input: leftExt, left: 0, top: 0 },
      { input: front, left: sideFill, top: 0 },
      { input: rightExt, left: sideFill + frontW, top: 0 }
    ])
    .png()
    .toBuffer()

  // 5) 등 뒤 wrap 닫기 — leftExt 왼끝(−180°)과 rightExt 오른끝(+180°)이 만나는 1곳만 Flux Fill 밴드.
  //    buildGeminiSeamFixWorkflow가 width/2 roll로 wrap을 중앙에 놓고 밴드 inpaint 후 roll back.
  onProgress({ step: 'wrap' })
  const up = await client.uploadImage(assembled, `${pid}-${sceneId}-sv.png`)
  const workflow = buildGeminiSeamFixWorkflow({
    referenceImage: up.name,
    prompt: SEAM_BLEND_PROMPT,
    bandPrompt: SEAM_BLEND_PROMPT,
    width: W,
    height: H,
    bandWidth,
    feather: bandFeather,
    seed: randomSeed(),
    filenamePrefix: `chrono-zoetrope/${pid}/${sceneId}`
  })
  const { images } = await client.generate(workflow, { onProgress: (p) => onProgress({ step: 'wrap', ...p }) })
  const out = images.find((im) => /-pano_/.test(im.filename)) || images[0]

  return { front, rightExt: await png(rightExt), leftExt: await png(leftExt), assembled, panorama: out.data, workflow }
}
