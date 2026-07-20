// 항공샷 기반 서라운드 오케스트레이터 — 배치도(top-down) → 눈높이 정면뷰 + 눈높이 리버스뷰 + 좁은 이음선 보정.
//
// 두 넓은 뷰를 독립 생성하면 공간 모델을 공유 못 해 C(주인공이 보는 것)가 틀리고 연결도 안 됐다(실측). 해법(사용자
// 아이디어): 먼저 이 순간의 '항공샷(배치도)'을 만들어 주인공 위치·시선·주변 배치를 고정하고, 그 배치도를 참조해
// 방향별 눈높이 뷰를 생성 → 모든 뷰가 같은 3D 배치를 공유해 C가 올바르고 연결된다. 정면(front, 주인공이 카메라 응시)과
// 리버스(back, 주인공이 보는 far end)를 붙이고 이음선 2곳(가운데 join + 등 뒤 wrap)만 Flux Fill로 보정.
//
// ComfyUI generate는 1번(이음선 보정 그래프). 그래프 JSON을 반환하니 `{id}.workflow.json`으로 추적 가능.
// electron 모름(순수 Node). Gemini(gclient)·ComfyUI(client)를 호출자가 넘긴다.

import sharp from 'sharp'
import { buildSurroundSeamBlendWorkflow, randomSeed } from './workflows.js'
import { SEAM_BLEND_PROMPT } from './prompt-builder.js'
import { nearestGeminiAspect } from './gemini-client.js'

/**
 * @param {object} p
 * @param {import('./gemini-client.js').GeminiClient} [p.gclient]  뷰 생성용(front·back 둘 다 주면 불필요).
 * @param {import('./client.js').ComfyUIClient} p.client            이음선 보정 워크플로우 실행.
 * @param {{ aerial:string, anchor:string, view:string }} p.prompts  composeSurroundGazePrompts().
 * @param {Buffer} [p.frontAnchor]  주어지면 정면뷰를 재생성하지 않고 사용(admin edge 재연결).
 * @param {Buffer} [p.backAnchor]   주어지면 리버스뷰를 재생성하지 않고 사용.
 * @param {number} p.tileSize       파노라마 = tileSize×4. 각 넓은 뷰 = tileSize×2 (반원).
 * @param {string} p.imageSize      Gemini imageSize
 * @param {string} p.model          Gemini 모델(항공샷·다중레퍼런스는 pro 권장 — flash는 간헐 404)
 * @param {number} p.bandWidth      이음선 밴드 폭(px)
 * @param {number} p.feather        이음선 밴드 페더(px)
 * @param {string} p.pid
 * @param {string} p.sceneId
 * @param {AbortSignal} p.signal
 * @param {(e:{step:string,done:number,total:number}) => void} p.onProgress
 * @returns {Promise<{ aerial:Buffer|null, front:Buffer, back:Buffer, panorama:Buffer, workflow:object }>}
 */
export async function generateSurroundPanoramaFlux2({
  gclient,
  client,
  prompts,
  frontAnchor = null,
  backAnchor = null,
  tileSize = 1024,
  imageSize = '2K',
  model,
  bandWidth,
  feather,
  pid = 'p',
  sceneId = 'scene',
  signal,
  onProgress = () => {}
}) {
  const width = tileSize * 4 //  최종 파노라마 폭 (4096)
  const halfW = tileSize * 2 //  각 넓은 뷰 폭 (2048 = 반원 180°)
  const height = tileSize
  const wideAspect = nearestGeminiAspect(halfW, height) // 2:1 → 지원 비율 중 가까운 값(16:9)

  // 0) 항공샷(배치도) — front·back가 없을 때만 필요(edge 재연결은 뷰 재사용이라 스킵).
  let aerial = null
  if (!frontAnchor || !backAnchor) {
    onProgress({ step: 'aerial', done: 0, total: 4 })
    aerial = await gclient.generateImage({ prompt: prompts.aerial, references: [], aspectRatio: '1:1', imageSize, model, signal })
  }

  // 1) 정면뷰(front, A+B) — 항공샷 참조, 주인공이 카메라를 정면 응시하는 눈높이 뷰.
  onProgress({ step: 'front', done: 1, total: 4 })
  const frontRaw =
    frontAnchor ||
    (await gclient.generateImage({ prompt: prompts.anchor, references: [aerial], aspectRatio: wideAspect, imageSize, model, signal }))
  const front = await sharp(frontRaw).resize(halfW, height, { fit: 'fill' }).png().toBuffer()

  // 2) 리버스뷰(back, C+D) — 항공샷(배치) + front(스타일) 참조 → C가 주인공이 보는 방향이 되고 스타일도 일치.
  onProgress({ step: 'back', done: 2, total: 4 })
  const backRaw =
    backAnchor ||
    (await gclient.generateImage({ prompt: prompts.view, references: [aerial, front], aspectRatio: wideAspect, imageSize, model, signal }))
  const back = await sharp(backRaw).resize(halfW, height, { fit: 'fill' }).png().toBuffer()

  // 두 넓은 앵커를 이어 붙인다 [front(180°) | back(180°)] = 4096. 이음선: 가운데 join(x=2048) + 등 뒤 wrap(x=0).
  const assembled = await sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([
      { input: front, left: 0, top: 0 },
      { input: back, left: halfW, top: 0 }
    ])
    .png()
    .toBuffer()

  onProgress({ step: 'seam', done: 3, total: 4 })
  const up = await client.uploadImage(assembled, `${pid}-${sceneId}-wide.png`)
  // tileCount=2: 절반 roll(=tileSize) 후 두 이음선(가운데 join + wrap)만 Flux Fill 밴드로 좁게 보정.
  const workflow = buildSurroundSeamBlendWorkflow({
    referenceImage: up.name,
    bandPrompt: SEAM_BLEND_PROMPT,
    width,
    height,
    tileCount: 2,
    bandWidth,
    feather,
    seed: randomSeed(),
    filenamePrefix: `chrono-zoetrope/${pid}/${sceneId}`
  })
  const { images } = await client.generate(workflow, {
    onProgress: (p) => onProgress({ step: 'seam', done: 3, total: 4, ...p })
  })
  const out = images.find((im) => /-pano_/.test(im.filename)) || images[0]
  return { aerial, front, back, panorama: out.data, workflow }
}
