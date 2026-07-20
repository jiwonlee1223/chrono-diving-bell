// 4타일 캔버스 아웃페인팅 서라운드 — 1인칭 360° 파노라마를 '연결'로 짓는다.
//
// 기존 seamfix(B안)는 초광각 4:1 파노라마 한 장을 Gemini로 뽑고 좌우 wrap 이음매 1곳만
// ComfyUI Flux Fill로 후보정했다. 이 모듈은 그걸 대체한다: 광각 없이 90°짜리 자연스러운
// 타일 4장을 만들고, 각 타일을 이웃 타일의 가장자리에 '캔버스 아웃페인팅'으로 이어 붙인다.
// 연결(edge)은 전적으로 Gemini가 만든다 — ComfyUI 의존 없음(순수 Node + sharp).
//
// 캔버스 아웃페인팅: [이웃타일 | 빈칸] 을 한 장의 레퍼런스 이미지로 합성해 Gemini에 넣고
// "빈칸을 이어서 채우라"고 지시한 뒤, 새로 채워진 부분만 crop한다. 배치한 이웃 타일 원본은
// 손대지 않고 pristine 유지되므로(우린 새 부분만 crop) 스케일·색이 이웃과 일관되게 이어진다.
//
// 원형 배치(관람객 1인칭, azimuth 0=정면):
//   타일1 front(0°)  — 사용자 정면, 주인공이 나타나는 유일한 타일. 레퍼런스 없이 먼저 생성.
//   타일2 right(+90°) — 주인공의 좌측. 타일1 오른쪽에 아웃페인팅.
//   타일4 left(−90°)  — 주인공의 우측. 타일1 왼쪽에 아웃페인팅.
//   타일3 back(180°)  — 주인공이 바라보는 정면(등 뒤). 키스톤: 타일2·타일4 양쪽에 조건화해 폐곡선을 닫는다.
// 스트립(좌→우, 실린더에 감김): [타일4 | 타일1 | 타일2 | 타일3].
//
// 종횡비 메모: Gemini 지원 종횡비에 2:1·3:1이 없다(gemini-client.js GEMINI_ASPECTS 참조).
// 그래서 캔버스(2:1 또는 3:1)를 레퍼런스로 보내고 출력은 가장 가까운 지원 비율(16:9/21:9)로 받은 뒤,
// fit:'fill' 로 다시 캔버스 그리드에 정확히 맞춰(균일 스케일 복원) crop한다. 균일 압축→복원이라
// 스케일은 이웃과 맞고, 손실은 가로 디테일 약간뿐이다(키스톤 3:1은 손실↑ — 등 뒤라 허용, 필요 시 imageSize↑).

import sharp from 'sharp'
import { nearestGeminiAspect } from './gemini-client.js'

// 아웃페인팅 빈칸 색 — '여기를 이어 채우라'는 신호로 중립 회색. 하드한 색이면 Gemini가 보존해버릴 수 있다.
const BLANK_RGB = { r: 127, g: 127, b: 127 }

/** 임의 해상도의 Gemini 출력을 캔버스 그리드(width×height)에 정확히 되돌린다(균일 스케일 복원). */
function toCanvasGrid(buf, width, height) {
  return sharp(buf).resize(width, height, { fit: 'fill' }).png().toBuffer()
}

/** 버퍼를 정확한 정사각 타일로 정규화(입력이 딱 정사각이 아닐 수 있으므로). */
function normalizeTile(buf, tileSize) {
  return sharp(buf).resize(tileSize, tileSize, { fit: 'fill' }).png().toBuffer()
}

/**
 * 타일 4장을 가로로 이어붙여 파노라마 스트립(4:1)을 만든다.
 * @param {Buffer[]} tileBuffers  스트립 순서대로 [타일4, 타일1, 타일2, 타일3]
 * @param {number} tileSize       타일 한 변(px). 결과 폭 = tileSize × 4, 높이 = tileSize.
 */
export async function assembleStrip(tileBuffers, tileSize = 1024) {
  const norm = await Promise.all(tileBuffers.map((b) => normalizeTile(b, tileSize)))
  const composites = norm.map((input, i) => ({ input, left: i * tileSize, top: 0 }))
  return sharp({
    create: { width: tileSize * norm.length, height: tileSize, channels: 3, background: { r: 0, g: 0, b: 0 } }
  })
    .composite(composites)
    .png()
    .toBuffer()
}

/**
 * 한 타일을 이웃 타일 가장자리에 캔버스 아웃페인팅으로 이어 생성한다.
 * @param {object} p
 * @param {import('./gemini-client.js').GeminiClient} p.gclient
 * @param {string} p.prompt      아웃페인팅 fill 지시(prompt-builder composeSurroundContinuationPrompt).
 * @param {'right'|'left'|'keystone'} p.side
 *   'right'    : [anchor | 빈칸]        → 오른쪽 빈칸을 채워 crop (타일1 → 타일2).
 *   'left'     : [빈칸 | anchor]        → 왼쪽 빈칸을 채워 crop  (타일1 → 타일4).
 *   'keystone' : [leftTile | 빈칸 | rightTile] → 가운데 빈칸을 채워 crop (타일2·타일4 사이 타일3).
 * @param {object} p.neighbors   side에 따라 { anchor } 또는 { left, right }(캔버스에 놓일 좌/우 이웃 타일 버퍼).
 * @param {number} p.tileSize
 * @param {string} p.imageSize   '1K'|'2K'|'4K'
 * @param {string} p.model       장면 모델(sceneModel)
 * @param {AbortSignal} p.signal
 * @returns {Promise<Buffer>} crop된 새 타일(tileSize²) PNG.
 */
export async function outpaintNext({ gclient, prompt, side, neighbors, tileSize = 1024, imageSize = '2K', model, signal }) {
  let canvasW
  let layout // sharp composite 배치
  let cropLeft
  if (side === 'keystone') {
    canvasW = tileSize * 3
    layout = [
      { input: neighbors.left, left: 0, top: 0 },
      { input: neighbors.right, left: tileSize * 2, top: 0 }
    ]
    cropLeft = tileSize // 가운데
  } else if (side === 'right') {
    canvasW = tileSize * 2
    layout = [{ input: neighbors.anchor, left: 0, top: 0 }]
    cropLeft = tileSize // 오른쪽
  } else {
    // left
    canvasW = tileSize * 2
    layout = [{ input: neighbors.anchor, left: tileSize, top: 0 }]
    cropLeft = 0 // 왼쪽
  }

  // 이웃 타일을 정사각으로 정규화해 캔버스에 합성(나머지는 BLANK_RGB 빈칸).
  const placed = await Promise.all(
    layout.map(async (l) => ({ ...l, input: await normalizeTile(l.input, tileSize) }))
  )
  const canvas = await sharp({
    create: { width: canvasW, height: tileSize, channels: 3, background: BLANK_RGB }
  })
    .composite(placed)
    .png()
    .toBuffer()

  // 캔버스를 레퍼런스로 넣고 지원 비율에 가장 가까운 출력을 받아 캔버스 그리드로 복원 후 crop.
  const aspectRatio = nearestGeminiAspect(canvasW, tileSize)
  const out = await gclient.generateImage({ prompt, references: [canvas], aspectRatio, imageSize, model, signal })
  const grid = await toCanvasGrid(out, canvasW, tileSize)
  return sharp(grid).extract({ left: cropLeft, top: 0, width: tileSize, height: tileSize }).png().toBuffer()
}

/**
 * 1인칭 360° 서라운드 파노라마 생성 — 4타일 캔버스 아웃페인팅 체인.
 * @param {object} p
 * @param {import('./gemini-client.js').GeminiClient} p.gclient
 * @param {{ anchor: string, right: string, left: string, back: string }} p.prompts
 *   prompt-builder composeSurroundPrompts()의 4문구.
 * @param {Buffer} [p.anchor]   주어지면 앵커(타일1)를 재생성하지 않고 이 버퍼를 그대로 쓴다 —
 *   admin "edge 재연결"이 주인공 정면은 유지한 채 좌·우·등 뒤 이음만 다시 지을 때 사용(prompts.anchor 무시).
 * @param {number} p.tileSize   타일 한 변(px). 파노라마 폭 = tileSize × 4.
 * @param {string} p.imageSize  '1K'|'2K'|'4K'
 * @param {string} p.model      sceneModel
 * @param {AbortSignal} p.signal
 * @param {(e:{ step:string, done:number, total:number }) => void} p.onProgress
 * @returns {Promise<{ tiles:{front:Buffer,right:Buffer,back:Buffer,left:Buffer}, panorama:Buffer }>}
 */
export async function generateSurroundPanorama({
  gclient,
  prompts,
  anchor = null,
  tileSize = 1024,
  imageSize = '2K',
  model,
  signal,
  onProgress = () => {}
}) {
  const total = 5 // front, right, left, back(keystone), assemble

  onProgress({ step: 'front', done: 0, total })
  const front =
    anchor ||
    (await gclient.generateImage({
      prompt: prompts.anchor,
      references: [],
      aspectRatio: '1:1',
      imageSize,
      model,
      signal
    }))

  onProgress({ step: 'right', done: 1, total })
  const right = await outpaintNext({
    gclient, prompt: prompts.right, side: 'right', neighbors: { anchor: front }, tileSize, imageSize, model, signal
  })

  onProgress({ step: 'left', done: 2, total })
  const left = await outpaintNext({
    gclient, prompt: prompts.left, side: 'left', neighbors: { anchor: front }, tileSize, imageSize, model, signal
  })

  // 키스톤: 등 뒤 타일3. 원형 이웃은 왼쪽=타일2(right), 오른쪽=타일4(left) → 캔버스 [right | 빈칸 | left].
  onProgress({ step: 'back', done: 3, total })
  const back = await outpaintNext({
    gclient, prompt: prompts.back, side: 'keystone', neighbors: { left: right, right: left }, tileSize, imageSize, model, signal
  })

  onProgress({ step: 'assemble', done: 4, total })
  const panorama = await assembleStrip([left, front, right, back], tileSize) // [타일4 | 타일1 | 타일2 | 타일3]
  onProgress({ step: 'done', done: 5, total })

  return { tiles: { front, right, back, left }, panorama }
}
