// ─────────────────────────────────────────────────────────────────────────────
// gaze-panorama.js — 주마등 1인칭 360° 파노라마 생성기 (Path C, 완성본).
//
// 한 파일에 전체 워크플로우를 담는다: 프롬프트 · ComfyUI 아웃페인팅 그래프 · 오케스트레이션 · 크로스페이드.
// 공유 인프라(clients)와 스타일 상수(STYLE/NO_TEXT/subjectNoun/MODELS)만 import한다. sharp 불필요(조립은 그래프 내부).
//
// 설계 근거 (여러 방식 실측 끝 채택):
//   - 넓은 앵커 2장 맞대기 = 투영 중심 2개라 방위각 불연속("대칭 두 사진"). ✗
//   - front 한 장에서 좌우로만 이어그리기(Path B) = 연속이나 등 뒤(주인공 응시 대상)가 흐림/소실. ✗
//   - Path C = aerial(배치도)로 front·back이 같은 3D 공간을 공유 → front(주인공 중앙)와
//     back(**의도된 응시 대상**)을 뽑아 back을 wrap 가로질러 배치하고, front 가장자리를
//     continuation-outpaint해 back 위에 알파 램프로 크로스페이드. 응시 대상 선명 + 좌우 소프트 연속. ✓
//
// 레이아웃 (W = tileSize*4):
//   front[leftX,rightX] 중앙(주인공) · back은 wrap 가로질러 [rightX,W]+[0,leftX](응시 대상)
//   frontW가 넓을수록(2:1→3:1) coherent 단일이미지↑, 조인이 등 뒤(±frontW/2°)로 밀림. 단 광각 왜곡↑.
//   → 기본 frontW=2.5·tileSize(225°) + '평면 원근' 프롬프트로 광각 완화(절충).
//
// electron 모름(순수 Node). gclient(Gemini)·client(ComfyUI)는 호출자가 주입한다.
// ─────────────────────────────────────────────────────────────────────────────

import { MODELS } from './workflows.js'
import { STYLE, NO_TEXT_DIRECTIVE, subjectNoun } from './prompt-builder.js'
import { nearestGeminiAspect } from './gemini-client.js'

// ── 프롬프트 ────────────────────────────────────────────────────────────────

// 눈높이·평면 원근 강제. 항공샷은 배치 참조용일 뿐(탑다운 각도·일러스트 화풍 복사 금지),
// 그리고 광각/파노라마 렌즈 느낌을 억제해 실린더 재투영 시 원근 왜곡을 줄인다.
const FLAT_VIEW_DIRECTIVE =
  ` The first reference image is only a top-down schematic MAP for spatial layout — use it ONLY for placement,` +
  ` and do NOT copy its overhead angle or flat drawn/illustrated look.` +
  ` Render a completely normal ground-level EYE-LEVEL photograph, camera held horizontally at head height, looking straight ahead across the space` +
  ` (level horizon, NOT looking down, NOT a high-angle or top-down view).` +
  ` Use a NATURAL standard-lens perspective, as if a normal 35–50mm photograph: NOT wide-angle, NOT fisheye, NOT a panoramic or 360 shot,` +
  ` minimal lens distortion, keep vertical lines straight and the framing flat and even, avoid an exaggerated large foreground or strong converging lines.` +
  ` A realistic photorealistic photograph, absolutely NOT an illustration, drawing, cartoon or anime.`

/** 항공샷(배치도) — 주인공 위치·시선 + 주변 배치. 방향별 뷰의 공간 기준. */
export function composeGazeAerialPrompt(profile, item) {
  const who = `a ${item.age}-year-old ${subjectNoun(item.age, profile.gender)}`
  return (
    `A top-down bird's-eye overhead view looking straight down from directly above at this place: ${item.scene}.` +
    ` Show the full floor layout like an architectural plan: place ${who} standing near the middle and clearly indicate which direction they are facing` +
    ` (body orientation from above, facing toward one wall). Arrange everything around them — furniture, seating, walls, windows, doors — in correct positions across the whole space.` +
    ` A clear schematic top-down layout, evenly lit.` +
    NO_TEXT_DIRECTIVE
  )
}

/** front — 눈높이. 주인공이 정면 중앙에서 카메라를 응시, 좌우 양쪽으로 주변. refs:[aerial]. 평면 원근. */
export function composeGazeAnchorPrompt(profile, item) {
  const who = `a ${item.age}-year-old ${subjectNoun(item.age, profile.gender)}`
  const extra = (profile.descriptors || []).join(', ')
  const future = item.isPast ? '' : ` An imagined moment further along in this life.`
  return (
    `An eye-level photograph taken from inside this place. Using the top-down map for the spatial layout,` +
    ` in the CENTER of the frame ${who} stands facing the camera and looking straight out of the picture directly at the viewer, their own face shown and in focus.` +
    ` This is the moment: ${item.scene}. The same place extends to the left AND to the right around them — the surroundings as arranged in the map spread out both ways and flow off past both edges.` +
    ` Every other person's face is wiped away like a smear of paint, smooth, soft, featureless and blurred, painterly, not distorted, not grotesque.` +
    FLAT_VIEW_DIRECTIVE +
    future +
    (extra ? ` ${extra}.` : '') +
    ` ${STYLE}` +
    NO_TEXT_DIRECTIVE
  )
}

/** back — 눈높이 리버스(관람객 중심 단일시점에서 180° 뒤돈 뷰 = 주인공이 바라보는 far end). refs:[aerial, front]. */
export function composeGazeViewPrompt(profile, item) {
  const extra = (profile.descriptors || []).join(', ')
  return (
    `An eye-level photograph of the SAME place, the REVERSE view. The camera stays at the exact same single standpoint as in the second reference photo (the front view) —` +
    ` the viewer stands still at one spot and simply turns 180 degrees to look the opposite way. Show the far side of the same room that lies behind, the space the central person is gazing toward` +
    ` (the far wall / far end, per the top-down map). This is distinctly the opposite side from the front reference.` +
    ` The central person does NOT appear. Do NOT show any hands, arms, shoulders, body or a foreground desk in the immediate foreground; a clean straight-ahead view across the room, not a first-person over-the-shoulder shot.` +
    ` Any other people are seen more from the front, faces wiped to a soft featureless smear.` +
    ` The same location: ${item.scene}.` +
    FLAT_VIEW_DIRECTIVE +
    ` Match the exact realistic photographic style, lighting and colors of the SECOND reference image (a photo of the same place).` +
    (extra ? ` ${extra}.` : '') +
    ` ${STYLE}` +
    NO_TEXT_DIRECTIVE
  )
}

/**
 * front 가장자리 continuation-outpaint용 프롬프트 — 마스크 인페인트라 '그릴 내용'을 서술해야 한다
 * ("빈칸 채워라" 금지). 픽셀 연속성은 마스크 밖 이웃이 담당. 평면 원근 유지.
 */
export function composeGazeContinuationPrompt(profile, item) {
  const extra = (profile.descriptors || []).join(', ')
  return (
    `A single continuous eye-level photograph of one place, seen from inside it: ${item.scene}.` +
    ` Extend and continue this same scene seamlessly to the side, matching the exact same perspective, horizon line, lighting, floor, walls, surfaces and photographic style already present.` +
    ` One unbroken continuous environment with no seam, no border and no repetition. Do not add another main subject or repeat the central person — only the surrounding environment continues.` +
    ` Any people present have faces wiped away like a smear of paint, soft, featureless, painterly, not distorted.` +
    ` A natural standard lens, not a wide-angle, fisheye or panoramic shot, no lens distortion.` +
    (extra ? ` ${extra}.` : '') +
    ` ${STYLE}` +
    NO_TEXT_DIRECTIVE
  )
}

/** 4문구 묶음. 오케스트레이터가 aerial→front(ref aerial)→back(ref aerial,front)→continuation 순으로 쓴다. */
export function composeGazePanoramaPrompts(profile, item) {
  return {
    aerial: composeGazeAerialPrompt(profile, item),
    anchor: composeGazeAnchorPrompt(profile, item),
    view: composeGazeViewPrompt(profile, item),
    continuation: composeGazeContinuationPrompt(profile, item)
  }
}

// ── ComfyUI: 단일 통합 그래프 (front/back → 최종 파노라마, generate 1번) ──────────
//
// front/back(업로드)만 받아 그래프 내부에서 전부 처리한다: 로더 1벌 → front 좌우 continuation-outpaint
// 2스테이지 → back을 반으로 잘라 [backRight | front | backLeft] 가로 조립 → 두 조인을 FeatherMask 램프로
// ImageCompositeMasked 크로스페이드 → SaveImage 1장. sharp 후처리 없음. workflow JSON 반환해 추적 가능.

const randomSeed = () => Math.floor(Math.random() * 2 ** 32)

/**
 * front/back(업로드) → 최종 파노라마를 만드는 단일 ComfyUI 그래프.
 * @param {object} p
 * @param {string} p.frontImage  업로드된 front 이름(Gemini 원본; 그래프가 frontW×H로 스케일)
 * @param {string} p.backImage   업로드된 back 이름(backW×H로 스케일)
 * @param {string} p.prompt      continuation 프롬프트
 * @param {number} p.W @param {number} p.H @param {number} p.frontW @param {number} p.backW
 * @param {number} p.ov          조인 크로스페이드/continuation 폭
 * @param {number} p.context     outpaint 앵커 문맥 폭
 * @param {number} p.steps @param {number} p.feather @param {number} p.fluxGuidance @param {number} p.seed
 * @param {string} p.filenamePrefix  `${prefix}-pano`로 저장
 */
export function buildGazePanoramaGraph({ frontImage, backImage, prompt, W, H, frontW, backW, ov, context = 768, steps = 20, feather = 64, fluxGuidance = 30, seed = randomSeed(), filenamePrefix }) {
  const bh = backW / 2
  const leftX = (W - frontW) / 2
  const rightX = (W + frontW) / 2
  return {
    // 로더 + 조건(공유)
    1: { class_type: 'UNETLoader', inputs: { unet_name: MODELS.fluxFill, weight_dtype: 'default' }, _meta: { title: 'Load Flux Fill' } },
    2: { class_type: 'DualCLIPLoader', inputs: { clip_name1: MODELS.kontextClip[0], clip_name2: MODELS.kontextClip[1], type: 'flux' }, _meta: { title: 'CLIP (flux)' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: MODELS.kontextVae }, _meta: { title: 'VAE (ae)' } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] }, _meta: { title: 'Continuation' } },
    5: { class_type: 'FluxGuidance', inputs: { conditioning: ['4', 0], guidance: fluxGuidance }, _meta: { title: 'Flux Guidance' } },
    6: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] }, _meta: { title: 'Neg zero' } },

    // 입력 이미지 (Gemini 원본 → 목표 크기로 스케일; sharp 불필요)
    10: { class_type: 'LoadImage', inputs: { image: frontImage }, _meta: { title: 'Front' } },
    11: { class_type: 'ImageScale', inputs: { image: ['10', 0], upscale_method: 'lanczos', width: frontW, height: H, crop: 'disabled' }, _meta: { title: 'Front→frontW×H' } },
    12: { class_type: 'LoadImage', inputs: { image: backImage }, _meta: { title: 'Back' } },
    13: { class_type: 'ImageScale', inputs: { image: ['12', 0], upscale_method: 'lanczos', width: backW, height: H, crop: 'disabled' }, _meta: { title: 'Back→backW×H' } },

    // 오른쪽 continuation-outpaint (front 우측끝 context → +ov)
    20: { class_type: 'ImageCrop', inputs: { image: ['11', 0], width: context, height: H, x: frontW - context, y: 0 }, _meta: { title: 'Front R ctx' } },
    21: { class_type: 'ImagePadForOutpaint', inputs: { image: ['20', 0], left: 0, top: 0, right: ov, bottom: 0, feathering: feather }, _meta: { title: 'Pad R' } },
    22: { class_type: 'InpaintModelConditioning', inputs: { positive: ['5', 0], negative: ['6', 0], vae: ['3', 0], pixels: ['21', 0], mask: ['21', 1], noise_mask: true }, _meta: { title: 'Cond R' } },
    23: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['22', 0], negative: ['22', 1], latent_image: ['22', 2], seed, steps, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0 }, _meta: { title: 'Outpaint R' } },
    24: { class_type: 'VAEDecode', inputs: { samples: ['23', 0], vae: ['3', 0] }, _meta: { title: 'Decode R' } },
    25: { class_type: 'ImageCrop', inputs: { image: ['24', 0], width: ov, height: H, x: context, y: 0 }, _meta: { title: 'rightExt' } },

    // 왼쪽 continuation-outpaint (front 좌측끝 context → +ov)
    30: { class_type: 'ImageCrop', inputs: { image: ['11', 0], width: context, height: H, x: 0, y: 0 }, _meta: { title: 'Front L ctx' } },
    31: { class_type: 'ImagePadForOutpaint', inputs: { image: ['30', 0], left: ov, top: 0, right: 0, bottom: 0, feathering: feather }, _meta: { title: 'Pad L' } },
    32: { class_type: 'InpaintModelConditioning', inputs: { positive: ['5', 0], negative: ['6', 0], vae: ['3', 0], pixels: ['31', 0], mask: ['31', 1], noise_mask: true }, _meta: { title: 'Cond L' } },
    33: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['32', 0], negative: ['32', 1], latent_image: ['32', 2], seed: seed + 1, steps, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0 }, _meta: { title: 'Outpaint L' } },
    34: { class_type: 'VAEDecode', inputs: { samples: ['33', 0], vae: ['3', 0] }, _meta: { title: 'Decode L' } },
    35: { class_type: 'ImageCrop', inputs: { image: ['34', 0], width: ov, height: H, x: 0, y: 0 }, _meta: { title: 'leftExt' } },

    // back 반 분할 + 가로 조립 [backRight | front | backLeft] = W
    40: { class_type: 'ImageCrop', inputs: { image: ['13', 0], width: bh, height: H, x: bh, y: 0 }, _meta: { title: 'back R half→좌' } },
    41: { class_type: 'ImageCrop', inputs: { image: ['13', 0], width: bh, height: H, x: 0, y: 0 }, _meta: { title: 'back L half→우' } },
    42: { class_type: 'easy imageConcat', inputs: { image1: ['40', 0], image2: ['11', 0], direction: 'right', match_image_size: false }, _meta: { title: '[backR|front]' } },
    43: { class_type: 'easy imageConcat', inputs: { image1: ['42', 0], image2: ['41', 0], direction: 'right', match_image_size: false }, _meta: { title: 'base [backR|front|backL]' } },

    // 크로스페이드 마스크(FeatherMask 램프: 51=1→0, 52=0→1)
    50: { class_type: 'SolidMask', inputs: { value: 1.0, width: ov, height: H }, _meta: { title: 'ov solid' } },
    51: { class_type: 'FeatherMask', inputs: { mask: ['50', 0], left: 0, top: 0, right: ov, bottom: 0 }, _meta: { title: 'ramp R (1→0)' } },
    52: { class_type: 'FeatherMask', inputs: { mask: ['50', 0], left: ov, top: 0, right: 0, bottom: 0 }, _meta: { title: 'ramp L (0→1)' } },

    // 조인 크로스페이드: front continuation을 base(back) 위에 얹음
    60: { class_type: 'ImageCompositeMasked', inputs: { destination: ['43', 0], source: ['25', 0], x: rightX, y: 0, resize_source: false, mask: ['51', 0] }, _meta: { title: 'blend R join' } },
    61: { class_type: 'ImageCompositeMasked', inputs: { destination: ['60', 0], source: ['35', 0], x: leftX - ov, y: 0, resize_source: false, mask: ['52', 0] }, _meta: { title: 'blend L join' } },

    70: { class_type: 'SaveImage', inputs: { images: ['61', 0], filename_prefix: `${filenamePrefix}-pano` }, _meta: { title: 'Save Panorama' } }
  }
}

// ── 오케스트레이터 ──────────────────────────────────────────────────────────

/**
 * Gemini로 aerial/front/back 3장 생성 → 업로드 → 단일 그래프 1번으로 최종 파노라마.
 * @param {object} p
 * @param {import('./gemini-client.js').GeminiClient} p.gclient
 * @param {import('./client.js').ComfyUIClient} p.client
 * @param {object} [p.profile] @param {object} [p.item]  프롬프트 조립용(prompts 직접 주면 무시)
 * @param {object} [p.prompts] {aerial,anchor,view,continuation}
 * @param {Buffer} [p.frontAnchor] @param {Buffer} [p.backAnchor] @param {Buffer} [p.aerialImg]  재사용
 * @param {number} [p.tileSize=1024] @param {number} [p.frontW]  기본 2.5*tileSize(225°)
 * @param {number} [p.ov=160] @param {number} [p.context=768] @param {number} [p.feather=64] @param {number} [p.outpaintSteps=20]
 * @param {string} [p.imageSize='2K'] @param {string} [p.model] @param {string} [p.pid='p'] @param {string} [p.sceneId='scene']
 * @param {AbortSignal} [p.signal] @param {(e:{step:string})=>void} [p.onProgress]
 * @returns {Promise<{ aerial:Buffer|null, front:Buffer, back:Buffer, panorama:Buffer, workflow:object, meta:object }>}
 */
export async function generateGazePanorama({
  gclient,
  client,
  profile,
  item,
  prompts,
  frontAnchor = null,
  backAnchor = null,
  aerialImg = null,
  tileSize = 1024,
  frontW = Math.round(tileSize * 2.5),
  ov = 160,
  context = 768,
  feather = 64,
  outpaintSteps = 20,
  imageSize = '2K',
  model,
  pid = 'p',
  sceneId = 'scene',
  signal,
  onProgress = () => {}
}) {
  const W = tileSize * 4
  const H = tileSize
  frontW = Math.round(frontW / 2) * 2 // 짝수 정렬
  const backW = W - frontW
  const P = prompts || composeGazePanoramaPrompts(profile, item)

  // 0) aerial — front·back 공유 공간
  let aerial = aerialImg
  if (!aerial && (!frontAnchor || !backAnchor)) {
    onProgress({ step: 'aerial' })
    aerial = await gclient.generateImage({ prompt: P.aerial, references: [], aspectRatio: '1:1', imageSize, model, signal })
  }
  // 1) front (주인공 중앙, refs:[aerial])
  onProgress({ step: 'front' })
  const front = frontAnchor || (await gclient.generateImage({ prompt: P.anchor, references: [aerial], aspectRatio: nearestGeminiAspect(frontW, H), imageSize, model, signal }))
  // 2) back (응시 대상, refs:[aerial, front])
  onProgress({ step: 'back' })
  const back = backAnchor || (await gclient.generateImage({ prompt: P.view, references: [aerial, front], aspectRatio: nearestGeminiAspect(backW, H), imageSize, model, signal }))

  // 3) 업로드 → 단일 그래프 → 최종 파노라마 (ComfyUI generate 1번, sharp 없음)
  onProgress({ step: 'assemble' })
  const [fUp, bUp] = await Promise.all([
    client.uploadImage(front, `${pid}-${sceneId}-front.png`),
    client.uploadImage(back, `${pid}-${sceneId}-back.png`)
  ])
  const workflow = buildGazePanoramaGraph({
    frontImage: fUp.name,
    backImage: bUp.name,
    prompt: P.continuation,
    W,
    H,
    frontW,
    backW,
    ov,
    context,
    steps: outpaintSteps,
    feather,
    seed: randomSeed(),
    filenamePrefix: `chrono-zoetrope/${pid}/${sceneId}`
  })
  const { images } = await client.generate(workflow, { onProgress: (p) => onProgress({ step: 'assemble', ...p }) })
  const out = images.find((im) => /-pano_/.test(im.filename)) || images[0]

  return {
    aerial: aerial || null,
    front,
    back,
    panorama: out.data,
    workflow,
    meta: { W, H, frontW, backW, ov, joinsAtDeg: [+(frontW / 2 / (W / 360)).toFixed(1), -(frontW / 2 / (W / 360)).toFixed(1)] }
  }
}
