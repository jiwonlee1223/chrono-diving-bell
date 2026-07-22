// ⚠ LEGACY — seamfix(B안) 이음매 보정 파이프라인. 2026-07-22 equirect 통일 후 **새 이미지 생성엔
// 쓰이지 않는다**(이미지 생성은 equirect만). 삭제하지 않고 여기 따로 빼둔다:
//   - 이미 seamfix로 생성된 기존 persona(manifest.workflow==='seamfix')의 전체 재생성 경로 보존용
//   - 나중에 Flux Fill 이음매 보정 로직을 다시 참조할 때를 위한 보관
// 활성 코드(workflows.js·admin-server.mjs·life-library.js)에서 seamfix 흔적을 걷어내고 이 한 파일로 모았다.
// edge 재연결(reseam) 기능은 2026-07-22 완전 제거됨(여기에도 없음).

import fs from 'node:fs/promises'
import path from 'node:path'
import { MODELS, PANORAMA_NEGATIVE, randomSeed } from './workflows.js'
import { ComfyUIClient } from './client.js'
import { GeminiClient, resolveGeminiApiKey, nearestGeminiAspect } from './gemini-client.js'
import { SEAM_BAND_PROMPT } from './prompt-builder.js'

/**
 * B안 — Gemini로 뽑은 파노라마의 좌우 이음매를 후처리로 보정한다 (Gemini 화질 보존).
 *
 * Gemini는 닫힌 API라 circular padding을 못 건다(A안 불가). 대신 생성된 이미지를 받아:
 *   1) 가로 절반 roll → 원래 좌우 wrap 경계가 화면 '중앙'으로 온다.
 *   2) 그 중앙 세로 띠만 inpaint(마스크 denoise)로 다시 그려 불연속을 잇는다. 띠 밖은 Gemini 원본 유지.
 *   3) roll back → 보정된 띠가 다시 양끝(=실린더 wrap 지점)으로 간다.
 * SDXL로 좁은 띠만 손대므로 이질감은 페더 블렌드로 감춘다. 넓은 영역 화질은 Gemini 그대로다.
 *
 * @param {object} p
 * @param {string} p.referenceImage  ComfyUI에 업로드된 Gemini 파노라마 이름 (client.uploadImage().name)
 * @param {string} p.prompt          (레거시/폴백) 밴드 프롬프트 기본값
 * @param {string} p.bandPrompt      이음매 띠 전용 프롬프트. 인물 언급 있는 장면 프롬프트를 쓰면 띠에
 *   유령 인물이 생겨 기괴해지므로, SEAM_BAND_PROMPT(인물 없는 배경) 권장. 미지정 시 prompt로 폴백.
 * @param {number} p.width           정규화 목표 가로 (짝수, 2:1 권장). ImageScale로 강제.
 * @param {number} p.height
 * @param {number} p.bandWidth       inpaint 세로 띠 폭(px). 좁을수록 원본 보존↑, 이음매 수정 여지↓
 * @param {number} p.feather         띠 좌우 페더(px) — 재생성과 Gemini 원본의 경계 블렌드
 * @param {'flux-fill'|'sdxl'} p.bandModel  띠 inpaint 모델. 기본 flux-fill(왜곡 적고 Gemini 근접).
 *   sdxl은 realvisxl Lightning 폴백(빠르지만 뭉갬·왜곡 큼).
 * @param {number} p.denoise         띠 재생성 강도(0~1). 미지정 시 모델별 기본(flux 1.0 / sdxl 0.7).
 *   flux-fill은 마스크를 conditioning에 굽는 fill 모델이라 denoise 1.0에서도 띠 밖은 안 건드린다.
 * @param {number} p.fluxGuidance    Flux Fill guidance (기본 30 — fill 권장값)
 * @param {boolean} p.seamCheck      [A|A] 이음매 검증 이미지 추가 (보정 전 raw / 보정 후 둘 다)
 * @param {string} p.filenamePrefix  `${prefix}-pano`(보정본) `${prefix}-raw`(원본) `${prefix}-seam`/`-rawseam`(검증)
 */
export function buildGeminiSeamFixWorkflow({
  referenceImage,
  prompt,
  bandPrompt = prompt, // 이음매 띠 전용 프롬프트(미지정 시 prompt) — SEAM_BAND_PROMPT 권장
  negative = PANORAMA_NEGATIVE,
  width = 2048,
  height = 1024,
  bandWidth = 256,
  feather = 96,
  seed = randomSeed(),
  bandModel = 'flux-fill',
  denoise,
  fluxGuidance = 30,
  steps, // sdxl 폴백 스텝(미지정 시 10)
  cfg = 1.5,
  sdxlCheckpoint = MODELS.sdxl,
  filenamePrefix,
  seamCheck = false
}) {
  const halfW = Math.floor(width / 2)
  const bandX = Math.floor((width - bandWidth) / 2)

  // ── 모델 무관 스캐폴드(100번대): 로드·정규화·roll·마스크 ──
  const g = {
    100: {
      class_type: 'LoadImage',
      inputs: { image: referenceImage },
      _meta: { title: 'Gemini Panorama' }
    },
    101: {
      class_type: 'ImageScale',
      inputs: { image: ['100', 0], upscale_method: 'lanczos', width, height, crop: 'disabled' },
      _meta: { title: 'Normalize to 2:1' }
    },
    // roll by width/2: [rightHalf | leftHalf] → 원래 wrap 경계가 중앙으로
    102: {
      class_type: 'ImageCrop',
      inputs: { image: ['101', 0], width: halfW, height, x: 0, y: 0 },
      _meta: { title: 'Left Half' }
    },
    103: {
      class_type: 'ImageCrop',
      inputs: { image: ['101', 0], width: halfW, height, x: halfW, y: 0 },
      _meta: { title: 'Right Half' }
    },
    104: {
      class_type: 'easy imageConcat',
      inputs: {
        image1: ['103', 0],
        image2: ['102', 0],
        direction: 'right',
        match_image_size: false
      },
      _meta: { title: 'Rolled [R|L]' }
    },
    // 중앙 세로 띠 마스크
    105: {
      class_type: 'SolidMask',
      inputs: { value: 0.0, width, height },
      _meta: { title: 'Black Canvas' }
    },
    106: {
      class_type: 'SolidMask',
      inputs: { value: 1.0, width: bandWidth, height },
      _meta: { title: 'White Band' }
    },
    107: {
      class_type: 'MaskComposite',
      inputs: { destination: ['105', 0], source: ['106', 0], x: bandX, y: 0, operation: 'add' },
      _meta: { title: 'Center Band Mask' }
    },
    108: {
      class_type: 'FeatherMask',
      inputs: { mask: ['107', 0], left: feather, top: 0, right: feather, bottom: 0 },
      _meta: { title: 'Feather Band' }
    }
  }

  // ── inpaint 코어(모델별) → 디코드된 보정 rolled 이미지 ref ──
  let fixedRef
  if (bandModel === 'flux-fill') {
    const dn = denoise ?? 1.0
    Object.assign(g, {
      110: {
        class_type: 'UNETLoader',
        inputs: { unet_name: MODELS.fluxFill, weight_dtype: 'default' },
        _meta: { title: 'Load Flux Fill' }
      },
      111: {
        class_type: 'DualCLIPLoader',
        inputs: {
          clip_name1: MODELS.kontextClip[0],
          clip_name2: MODELS.kontextClip[1],
          type: 'flux'
        },
        _meta: { title: 'Load CLIP (flux)' }
      },
      112: {
        class_type: 'VAELoader',
        inputs: { vae_name: MODELS.kontextVae },
        _meta: { title: 'Load VAE (ae)' }
      },
      113: {
        class_type: 'CLIPTextEncode',
        inputs: { text: bandPrompt, clip: ['111', 0] },
        _meta: { title: 'Band Prompt' }
      },
      114: {
        class_type: 'FluxGuidance',
        inputs: { conditioning: ['113', 0], guidance: fluxGuidance },
        _meta: { title: 'Flux Guidance' }
      },
      115: {
        class_type: 'ConditioningZeroOut',
        inputs: { conditioning: ['113', 0] },
        _meta: { title: 'Negative (zeroed)' }
      },
      116: {
        class_type: 'InpaintModelConditioning',
        inputs: {
          positive: ['114', 0],
          negative: ['115', 0],
          vae: ['112', 0],
          pixels: ['104', 0],
          mask: ['108', 0],
          noise_mask: true
        },
        _meta: { title: 'Flux Fill Conditioning' }
      },
      117: {
        class_type: 'KSampler',
        inputs: {
          model: ['110', 0],
          positive: ['116', 0],
          negative: ['116', 1],
          latent_image: ['116', 2],
          seed,
          steps: steps ?? 20,
          cfg: 1,
          sampler_name: 'euler',
          scheduler: 'simple',
          denoise: dn
        },
        _meta: { title: 'Inpaint Band (Flux Fill)' }
      },
      118: {
        class_type: 'VAEDecode',
        inputs: { samples: ['117', 0], vae: ['112', 0] },
        _meta: { title: 'Decode' }
      }
    })
    fixedRef = ['118', 0]
  } else {
    // SDXL 폴백 — realvisxl Lightning, 마스크 노이즈 inpaint
    const dn = denoise ?? 0.7
    Object.assign(g, {
      110: {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: sdxlCheckpoint },
        _meta: { title: 'Load SDXL' }
      },
      113: {
        class_type: 'CLIPTextEncode',
        inputs: { text: bandPrompt, clip: ['110', 1] },
        _meta: { title: 'Band Prompt' }
      },
      114: {
        class_type: 'CLIPTextEncode',
        inputs: { text: negative, clip: ['110', 1] },
        _meta: { title: 'Negative' }
      },
      115: {
        class_type: 'VAEEncode',
        inputs: { pixels: ['104', 0], vae: ['110', 2] },
        _meta: { title: 'Encode Rolled' }
      },
      116: {
        class_type: 'SetLatentNoiseMask',
        inputs: { samples: ['115', 0], mask: ['108', 0] },
        _meta: { title: 'Mask Band' }
      },
      117: {
        class_type: 'KSampler',
        inputs: {
          model: ['110', 0],
          positive: ['113', 0],
          negative: ['114', 0],
          latent_image: ['116', 0],
          seed,
          steps: steps ?? 10,
          cfg,
          sampler_name: 'dpmpp_sde',
          scheduler: 'karras',
          denoise: dn
        },
        _meta: { title: 'Inpaint Band (SDXL)' }
      },
      118: {
        class_type: 'VAEDecode',
        inputs: { samples: ['117', 0], vae: ['110', 2] },
        _meta: { title: 'Decode' }
      }
    })
    fixedRef = ['118', 0]
  }

  // ── roll back by width/2 → 보정된 띠가 양끝(wrap 지점)으로 ──
  Object.assign(g, {
    120: {
      class_type: 'ImageCrop',
      inputs: { image: fixedRef, width: halfW, height, x: 0, y: 0 },
      _meta: { title: 'Left Half (fixed)' }
    },
    121: {
      class_type: 'ImageCrop',
      inputs: { image: fixedRef, width: halfW, height, x: halfW, y: 0 },
      _meta: { title: 'Right Half (fixed)' }
    },
    122: {
      class_type: 'easy imageConcat',
      inputs: {
        image1: ['121', 0],
        image2: ['120', 0],
        direction: 'right',
        match_image_size: false
      },
      _meta: { title: 'Roll Back → Final' }
    },
    123: {
      class_type: 'SaveImage',
      inputs: { images: ['122', 0], filename_prefix: `${filenamePrefix}-pano` },
      _meta: { title: 'Save Corrected' }
    },
    124: {
      class_type: 'SaveImage',
      inputs: { images: ['101', 0], filename_prefix: `${filenamePrefix}-raw` },
      _meta: { title: 'Save Gemini Raw' }
    }
  })
  if (seamCheck) {
    g[125] = {
      class_type: 'easy imageConcat',
      inputs: {
        image1: ['122', 0],
        image2: ['122', 0],
        direction: 'right',
        match_image_size: false
      },
      _meta: { title: 'Seam (fixed)' }
    }
    g[126] = {
      class_type: 'SaveImage',
      inputs: { images: ['125', 0], filename_prefix: `${filenamePrefix}-seam` },
      _meta: { title: 'Save Seam (fixed)' }
    }
    g[127] = {
      class_type: 'easy imageConcat',
      inputs: {
        image1: ['101', 0],
        image2: ['101', 0],
        direction: 'right',
        match_image_size: false
      },
      _meta: { title: 'Seam (raw)' }
    }
    g[128] = {
      class_type: 'SaveImage',
      inputs: { images: ['127', 0], filename_prefix: `${filenamePrefix}-rawseam` },
      _meta: { title: 'Save Seam (raw)' }
    }
  }
  return g
}

// ── admin 재생성 경로(기존 seamfix persona 전용) — admin-server.mjs에서 옮겨옴 ──────────────
// deps로 admin-server 내부 상태를 주입받는다: { config, LIBRARY, writeManifest, loadEntryReference }.

// seamfix 이음매 보정 단계만 — 주어진 Gemini 원본 버퍼를 업로드해 Flux Fill 워크플로우를 돌리고
// 보정본(-pano)을 장면 파일로 저장한다. regenerateSeamfix가 쓴다.
async function applySeamFix(pid, manifest, entry, srcBuffer, client, { config, LIBRARY }) {
  const uploaded = await client.uploadImage(srcBuffer, `${pid}-${entry.id}-src.png`)
  const seed = randomSeed()
  const graph = buildGeminiSeamFixWorkflow({
    referenceImage: uploaded.name,
    prompt: entry.prompt,
    bandPrompt: SEAM_BAND_PROMPT, // 이음매 띠에 인물 안 그리게(기괴함 방지)
    width: manifest.image.width,
    height: manifest.image.height,
    // 재생성은 현재 config.seamfix를 우선(운영 중 밴드폭 조정 반영), 없으면 생성 당시 manifest 값 → workflow 기본.
    bandWidth: config.seamfix?.bandWidth ?? manifest.seamfix?.bandWidth,
    feather: config.seamfix?.feather ?? manifest.seamfix?.feather,
    bandModel: manifest.seamfix?.bandModel || 'flux-fill',
    seed,
    filenamePrefix: `chrono-zoetrope/${pid}/${path.basename(entry.file, '.png')}`
  })
  const { promptId, images } = await client.generate(graph)
  const corrected = images.find((im) => /-pano_/.test(im.filename)) || images[0]
  await fs.writeFile(path.join(LIBRARY, pid, entry.file), corrected.data)
  return { promptId, seed }
}

// B안(seamfix) 재생성 — Gemini로 파노라마를 다시 뽑고(→ 원본 보관) Flux Fill로 이음매를 보정한다.
// equirect 통일 후 새 생성엔 안 쓰이고, manifest.workflow==='seamfix'인 기존 persona 재생성에서만 호출된다.
export async function regenerateSeamfix(
  pid,
  manifest,
  entry,
  { config, LIBRARY, writeManifest, loadEntryReference }
) {
  const gclient = new GeminiClient({
    apiKey: await resolveGeminiApiKey(config.gemini),
    model: manifest.gemini?.model || config.gemini?.model,
    textModel: config.gemini?.textModel,
    timeoutMs: config.timeoutMs
  })
  const client = new ComfyUIClient({ host: config.host, timeoutMs: config.timeoutMs })
  try {
    const refBuf = await loadEntryReference(pid, entry)
    const t0 = Date.now()
    const data = await gclient.generateImage({
      prompt: entry.prompt,
      references: refBuf ? [refBuf] : [],
      // 파노라마 폭(manifest.image)에 맞는 Gemini 비율 — 4096×1024면 '4:1'. 보정 워크플로우가 그 크기로 정규화.
      aspectRatio: nearestGeminiAspect(manifest.image.width, manifest.image.height),
      imageSize: manifest.gemini?.imageSize || config.gemini?.imageSize || '2K',
      // flash(sceneModel) 고정 — pro는 4:1 파노라마를 거부한다.
      model: manifest.gemini?.sceneModel || config.gemini?.sceneModel || undefined
    })
    const srcFile = `${path.basename(entry.file, '.png')}.src.png`
    await fs.writeFile(path.join(LIBRARY, pid, srcFile), data)
    entry.srcFile = srcFile

    const { promptId, seed } = await applySeamFix(pid, manifest, entry, data, client, {
      config,
      LIBRARY
    })
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
