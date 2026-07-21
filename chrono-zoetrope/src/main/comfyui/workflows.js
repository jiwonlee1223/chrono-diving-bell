// ComfyUI 워크플로우 그래프 빌더.
// JSON 템플릿 파일을 복사·변조하는 대신(RoF 가이드 §6 방식) 그래프를 코드로 조립한다 —
// 주입 지점이 함수 인자로 명시되어 노드 ID 하드코딩 실수를 줄인다.
//
// 두 경로:
//   buildKontextWorkflow  FLUX.1 Kontext — 레퍼런스 사진의 인물을 장면에 유지 (기본 경로)
//   buildSdxlWorkflow     SDXL Lightning txt2img — 레퍼런스 없이 텍스트만 (폴백/테스트)

export const MODELS = {
  // kontext fp8_scaled 파일은 diffusion 모델만 담고 있다(CLIP/VAE 없음) —
  // CheckpointLoaderSimple에서 MODEL만 뽑고 CLIP/VAE는 아래 별도 파일로 로드한다.
  kontext: 'flux1-dev-kontext_fp8_scaled.safetensors',
  kontextClip: ['clip_l.safetensors', 't5xxl_fp8_e4m3fn.safetensors'],
  kontextVae: 'ae.safetensors',
  sdxl: 'realvisxlV40_v40LightningBakedvae.safetensors',
  // Flux Fill — 전용 inpainting diffusion 모델. B안 seam 보정 띠를 Gemini에 근접한 화질로 채운다
  // (SDXL Lightning 대비 왜곡·뭉갬 크게 감소). CLIP/VAE는 kontext와 공유(flux 계열).
  fluxFill: 'fluxFillFP8_v10.safetensors',
  // Wan2.2 I2V 14B: high/low noise 2-패스 + lightx2v 4-step 증류 LoRA (실서버 확인, 2026-07).
  wanHigh: 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors',
  wanLow: 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors',
  wanLoraHigh: 'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors',
  wanLoraLow: 'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors',
  wanClip: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
  wanVae: 'wan_2.1_vae.safetensors'
}

// Seamless 파노라마(A안) 네거티브 — 자막·왜곡 억제에 더해 '경계선/이음매/타일 반복'을 명시적으로 눌러
// 좌우 wrap 지점에 하드 엣지가 생기는 걸 줄인다. (진짜 seamless는 SeamlessTile conv 패딩이 만든다.)
export const PANORAMA_NEGATIVE =
  'text, watermark, caption, subtitles, logo, cartoon, illustration, 3d render, deformed, extra fingers, lowres, visible seam, hard edge, vertical border, frame, split image, duplicated subject, mirrored'

// Wan2.2 공식 템플릿 계열의 표준 네거티브(중국어). 정적 화면·저품질·자막 억제.
export const WAN_NEGATIVE =
  '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走'

export function randomSeed() {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
}

/**
 * FLUX.1 Kontext: 레퍼런스 이미지 1장 + 지시형 프롬프트 → 동일 인물의 새 장면.
 * 출력 크기는 EmptySD3LatentImage로 강제한다(레퍼런스 종횡비와 무관하게 16:9 유지).
 *
 * @param {object} p
 * @param {string} p.prompt          지시형 프롬프트 (예: "Show this person as a ...")
 * @param {string} p.referenceImage  업로드된 입력 이미지 이름 (client.uploadImage 반환값의 name)
 * @param {number} p.width
 * @param {number} p.height
 * @param {number} p.seed
 * @param {string} p.filenamePrefix  SaveImage prefix (예: "chrono-zoetrope/p-1a2b/03-1")
 */
export function buildKontextWorkflow({
  prompt,
  referenceImage,
  width = 1344,
  height = 768,
  seed = randomSeed(),
  steps = 20,
  guidance = 2.5,
  checkpoint = MODELS.kontext,
  filenamePrefix
}) {
  return {
    1: {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: checkpoint },
      _meta: { title: 'Load Kontext Checkpoint (MODEL only)' }
    },
    13: {
      class_type: 'DualCLIPLoader',
      inputs: {
        clip_name1: MODELS.kontextClip[0],
        clip_name2: MODELS.kontextClip[1],
        type: 'flux'
      },
      _meta: { title: 'Load CLIP (flux)' }
    },
    14: {
      class_type: 'VAELoader',
      inputs: { vae_name: MODELS.kontextVae },
      _meta: { title: 'Load VAE' }
    },
    2: {
      class_type: 'LoadImage',
      inputs: { image: referenceImage },
      _meta: { title: 'Reference Photo' }
    },
    3: {
      class_type: 'FluxKontextImageScale',
      inputs: { image: ['2', 0] },
      _meta: { title: 'Scale Reference' }
    },
    4: {
      class_type: 'VAEEncode',
      inputs: { pixels: ['3', 0], vae: ['14', 0] },
      _meta: { title: 'Encode Reference' }
    },
    5: {
      class_type: 'CLIPTextEncode',
      inputs: { text: prompt, clip: ['13', 0] },
      _meta: { title: 'Scene Prompt' }
    },
    6: {
      class_type: 'ReferenceLatent',
      inputs: { conditioning: ['5', 0], latent: ['4', 0] },
      _meta: { title: 'Attach Reference' }
    },
    7: {
      class_type: 'FluxGuidance',
      inputs: { conditioning: ['6', 0], guidance },
      _meta: { title: 'Flux Guidance' }
    },
    8: {
      class_type: 'ConditioningZeroOut',
      inputs: { conditioning: ['5', 0] },
      _meta: { title: 'Negative (zeroed)' }
    },
    9: {
      class_type: 'EmptySD3LatentImage',
      inputs: { width, height, batch_size: 1 },
      _meta: { title: 'Output Size' }
    },
    10: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['7', 0],
        negative: ['8', 0],
        latent_image: ['9', 0],
        seed,
        steps,
        cfg: 1,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1
      },
      _meta: { title: 'KSampler' }
    },
    11: {
      class_type: 'VAEDecode',
      inputs: { samples: ['10', 0], vae: ['14', 0] },
      _meta: { title: 'Decode' }
    },
    12: {
      class_type: 'SaveImage',
      inputs: { images: ['11', 0], filename_prefix: filenamePrefix },
      _meta: { title: 'Save Scene' }
    }
  }
}

/**
 * Wan2.2 I2V 14B (high/low noise 2-패스) + lightx2v 4-step LoRA: 정지 이미지 → 짧은 영상.
 * FREEZE 순간의 이미지를 IMMERSION 영상으로 만드는 경로 (§5.2 실시간 재생성의 영상판).
 *
 * 구조는 ComfyUI 공식 Wan2.2 I2V 템플릿과 동일:
 *   high noise 모델이 steps 0→boundaryStep, low noise 모델이 boundaryStep→끝을 이어서 샘플링.
 *   4-step 증류 LoRA를 양쪽에 걸어 cfg 1·4스텝으로 줄인다 (풀스텝 대비 수 분 → 수십 초).
 *
 * @param {object} p
 * @param {string} p.prompt         모션 프롬프트 (장면 서술 + 움직임)
 * @param {string} p.startImage     업로드된 시작 이미지 이름 (client.uploadImage 반환값의 name)
 * @param {number} p.width          16의 배수
 * @param {number} p.height         16의 배수
 * @param {number} p.length         프레임 수 (4k+1; 81 = 16fps 약 5초)
 * @param {number} p.fps            Wan2.2 14B 네이티브 16
 * @param {number} p.steps          총 스텝 (LoRA 증류 기준 4)
 * @param {number} p.boundaryStep   high→low 전환 스텝 (steps의 절반)
 * @param {number} p.shift          ModelSamplingSD3 shift
 * @param {string} p.filenamePrefix SaveVideo prefix (예: "chrono-zoetrope/p-1a2b/vid-5-1")
 */
export function buildWan22I2VWorkflow({
  prompt,
  startImage,
  negative = WAN_NEGATIVE,
  width = 832,
  height = 480,
  length = 81,
  fps = 16,
  seed = randomSeed(),
  steps = 4,
  boundaryStep = 2,
  shift = 5.0,
  loraStrength = 1.0,
  filenamePrefix
}) {
  return {
    1: {
      class_type: 'UNETLoader',
      inputs: { unet_name: MODELS.wanHigh, weight_dtype: 'default' },
      _meta: { title: 'Load Wan2.2 High Noise' }
    },
    2: {
      class_type: 'UNETLoader',
      inputs: { unet_name: MODELS.wanLow, weight_dtype: 'default' },
      _meta: { title: 'Load Wan2.2 Low Noise' }
    },
    3: {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['1', 0], lora_name: MODELS.wanLoraHigh, strength_model: loraStrength },
      _meta: { title: '4-step LoRA (high)' }
    },
    4: {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['2', 0], lora_name: MODELS.wanLoraLow, strength_model: loraStrength },
      _meta: { title: '4-step LoRA (low)' }
    },
    5: {
      class_type: 'ModelSamplingSD3',
      inputs: { model: ['3', 0], shift },
      _meta: { title: 'Shift (high)' }
    },
    6: {
      class_type: 'ModelSamplingSD3',
      inputs: { model: ['4', 0], shift },
      _meta: { title: 'Shift (low)' }
    },
    7: {
      class_type: 'CLIPLoader',
      inputs: { clip_name: MODELS.wanClip, type: 'wan', device: 'default' },
      _meta: { title: 'Load UMT5' }
    },
    8: {
      class_type: 'CLIPTextEncode',
      inputs: { text: prompt, clip: ['7', 0] },
      _meta: { title: 'Motion Prompt' }
    },
    9: {
      class_type: 'CLIPTextEncode',
      inputs: { text: negative, clip: ['7', 0] },
      _meta: { title: 'Negative' }
    },
    10: {
      class_type: 'VAELoader',
      inputs: { vae_name: MODELS.wanVae },
      _meta: { title: 'Load Wan VAE' }
    },
    11: {
      class_type: 'LoadImage',
      inputs: { image: startImage },
      _meta: { title: 'Frozen Moment' }
    },
    12: {
      class_type: 'WanImageToVideo',
      inputs: {
        positive: ['8', 0],
        negative: ['9', 0],
        vae: ['10', 0],
        width,
        height,
        length,
        batch_size: 1,
        start_image: ['11', 0]
      },
      _meta: { title: 'Wan I2V Latent' }
    },
    13: {
      class_type: 'KSamplerAdvanced',
      inputs: {
        model: ['5', 0],
        add_noise: 'enable',
        noise_seed: seed,
        steps,
        cfg: 1,
        sampler_name: 'euler',
        scheduler: 'simple',
        positive: ['12', 0],
        negative: ['12', 1],
        latent_image: ['12', 2],
        start_at_step: 0,
        end_at_step: boundaryStep,
        return_with_leftover_noise: 'enable'
      },
      _meta: { title: 'Sample (high noise)' }
    },
    14: {
      class_type: 'KSamplerAdvanced',
      inputs: {
        model: ['6', 0],
        add_noise: 'disable',
        noise_seed: seed,
        steps,
        cfg: 1,
        sampler_name: 'euler',
        scheduler: 'simple',
        positive: ['12', 0],
        negative: ['12', 1],
        latent_image: ['13', 0],
        start_at_step: boundaryStep,
        end_at_step: 10000,
        return_with_leftover_noise: 'disable'
      },
      _meta: { title: 'Sample (low noise)' }
    },
    15: {
      class_type: 'VAEDecode',
      inputs: { samples: ['14', 0], vae: ['10', 0] },
      _meta: { title: 'Decode' }
    },
    16: {
      class_type: 'CreateVideo',
      inputs: { images: ['15', 0], fps },
      _meta: { title: 'Create Video' }
    },
    17: {
      class_type: 'SaveVideo',
      inputs: { video: ['16', 0], filename_prefix: filenamePrefix, format: 'mp4', codec: 'h264' },
      _meta: { title: 'Save Video' }
    }
  }
}

/**
 * DeepDanbooru 태거: 업로드된 사진 → 태그 문자열 ("1girl, solo, ..." / "1boy, ...").
 * 성별 자동 감지(gender-detect.js)의 기본 백엔드 — 실서버 검증 결과 유일하게 동작
 * (Florence-2·BLIP·QWen 노드는 transformers 버전 문제로 깨져 있음, 2026-07 기준).
 * ShowText|pysssss가 output 노드라 태그가 /history의 outputs.text로 나온다.
 */
export function buildDeepDanbooruCaptionWorkflow({ referenceImage, threshold = 0.5 }) {
  return {
    1: {
      class_type: 'LoadImage',
      inputs: { image: referenceImage },
      _meta: { title: 'Reference Photo' }
    },
    2: {
      class_type: 'DeepDanbooruCaption',
      inputs: {
        image: ['1', 0],
        threshold,
        sort_alpha: true,
        use_spaces: true,
        escape: true,
        filter_tags: 'blacklist'
      },
      _meta: { title: 'Tagger' }
    },
    3: {
      class_type: 'ShowText|pysssss',
      inputs: { text: ['2', 0] },
      _meta: { title: 'Tags Output' }
    }
  }
}

/**
 * Florence-2 이미지 캡션: 업로드된 사진 → 서술 텍스트.
 * 성별 감지의 폴백 백엔드 — 현재 서버에선 로더가 깨져 있지만, 노드가 수리되면
 * DeepDanbooru 실패 시 자동으로 이 경로를 탄다.
 *
 * @param {object} p
 * @param {string} p.referenceImage  업로드된 입력 이미지 이름
 * @param {string} p.task            'caption' | 'detailed_caption' | ...
 */
export function buildFlorenceCaptionWorkflow({
  referenceImage,
  task = 'caption',
  model = 'microsoft/Florence-2-base'
}) {
  return {
    1: {
      class_type: 'LoadImage',
      inputs: { image: referenceImage },
      _meta: { title: 'Reference Photo' }
    },
    2: {
      class_type: 'DownloadAndLoadFlorence2Model',
      inputs: { model, precision: 'fp16', attention: 'sdpa' },
      _meta: { title: 'Load Florence-2' }
    },
    3: {
      class_type: 'Florence2Run',
      inputs: {
        image: ['1', 0],
        florence2_model: ['2', 0],
        text_input: '',
        task,
        fill_mask: true
      },
      _meta: { title: 'Caption' }
    },
    4: {
      class_type: 'ShowText|pysssss',
      inputs: { text: ['3', 2] },
      _meta: { title: 'Caption Output' }
    }
  }
}

/**
 * SDXL Lightning txt2img. 레퍼런스 사진이 없을 때의 폴백 — 인물 일관성은 없다.
 * realvisxl Lightning 권장값: steps 5~6, cfg 1.5, dpmpp_sde/karras.
 */
export function buildSdxlWorkflow({
  prompt,
  negative = 'text, watermark, caption, subtitles, logo, cartoon, illustration, 3d render, deformed, extra fingers, lowres',
  width = 1344,
  height = 768,
  seed = randomSeed(),
  steps = 6,
  cfg = 1.5,
  checkpoint = MODELS.sdxl,
  filenamePrefix
}) {
  return {
    1: {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: checkpoint },
      _meta: { title: 'Load SDXL Checkpoint' }
    },
    2: {
      class_type: 'CLIPTextEncode',
      inputs: { text: prompt, clip: ['1', 1] },
      _meta: { title: 'Scene Prompt' }
    },
    3: {
      class_type: 'CLIPTextEncode',
      inputs: { text: negative, clip: ['1', 1] },
      _meta: { title: 'Negative Prompt' }
    },
    4: {
      class_type: 'EmptyLatentImage',
      inputs: { width, height, batch_size: 1 },
      _meta: { title: 'Output Size' }
    },
    5: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
        seed,
        steps,
        cfg,
        sampler_name: 'dpmpp_sde',
        scheduler: 'karras',
        denoise: 1
      },
      _meta: { title: 'KSampler' }
    },
    6: {
      class_type: 'VAEDecode',
      inputs: { samples: ['5', 0], vae: ['1', 2] },
      _meta: { title: 'Decode' }
    },
    7: {
      class_type: 'SaveImage',
      inputs: { images: ['6', 0], filename_prefix: filenamePrefix },
      _meta: { title: 'Save Scene' }
    }
  }
}

/**
 * A안 — SDXL Lightning + circular padding으로 만드는 seamless 파노라마 (텍스트→이미지, 레퍼런스 없음).
 *
 * §4.1 실린더는 가로축=방위각(360° 한 바퀴)만 이어지면 되고 세로 왜곡은 필요 없다. 그래서
 * tiling='x_only'(가로만 circular)로 건다. SeamlessTile이 UNet의 Conv2d 패딩을 circular로
 * 바꿔 latent 생성 단계부터 좌우를 잇고, CircularVAEDecode가 디코드 경계까지 이어 붙인다.
 *   ※ 이 기법은 UNet 기반(SDXL)에서 동작한다. Flux/DiT는 backbone에 공간 conv가 거의 없어
 *     SeamlessTile 효과가 약하다 — A안이 SDXL을 쓰는 이유다.
 *
 * seamCheck=true면 파노라마를 좌우로 이어붙인 [A|A] 검증 이미지를 함께 저장한다. 중앙 접합부가
 * 곧 실린더 wrap 지점이라, x_only가 먹었으면 중앙이 매끈하고 아니면 뚜렷한 세로선이 보인다.
 *
 * realvisxl Lightning 권장값: steps 5~6, cfg 1.5, dpmpp_sde/karras.
 *
 * @param {object} p
 * @param {string} p.prompt          composePanoramaScenePrompt 결과
 * @param {number} p.width           파노라마 가로 (실린더 둘레). 2:1 권장 (예: 1536×768)
 * @param {number} p.height
 * @param {'enable'|'x_only'|'y_only'|'disable'} p.tiling  기본 x_only (가로만)
 * @param {boolean} p.seamCheck      [A|A] 이음매 검증 이미지 추가 출력
 * @param {string} p.filenamePrefix  SaveImage prefix — 본체는 `${prefix}-pano`, 검증은 `${prefix}-seam`
 */
export function buildSeamlessPanoramaWorkflow({
  prompt,
  negative = PANORAMA_NEGATIVE,
  width = 1536,
  height = 768,
  seed = randomSeed(),
  steps = 6,
  cfg = 1.5,
  tiling = 'x_only',
  checkpoint = MODELS.sdxl,
  filenamePrefix,
  seamCheck = false
}) {
  const g = {
    1: {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: checkpoint },
      _meta: { title: 'Load SDXL Checkpoint' }
    },
    2: {
      // copy_model: 'Make a copy'는 실서버(2026-07)에서 deepcopy 경로가 깨져
      // "'NoneType' object is not callable"로 죽는다 — 'Modify in place'만 동작한다.
      // 부작용: 캐시된 체크포인트 모델을 그 자리에서 patch하므로, 같은 세션에서 이후
      // 비-seamless SDXL 작업이 이 캐시를 재사용하면 의도치 않게 seamless가 될 수 있다.
      // seamless 전용 파노라마 경로에서만 쓰는 한 문제 없다.
      class_type: 'SeamlessTile',
      inputs: { model: ['1', 0], tiling, copy_model: 'Modify in place' },
      _meta: { title: `Seamless Tile (${tiling})` }
    },
    3: {
      class_type: 'CLIPTextEncode',
      inputs: { text: prompt, clip: ['1', 1] },
      _meta: { title: 'Panorama Prompt' }
    },
    4: {
      class_type: 'CLIPTextEncode',
      inputs: { text: negative, clip: ['1', 1] },
      _meta: { title: 'Negative Prompt' }
    },
    5: {
      class_type: 'EmptyLatentImage',
      inputs: { width, height, batch_size: 1 },
      _meta: { title: 'Panorama Size' }
    },
    6: {
      class_type: 'KSampler',
      inputs: {
        model: ['2', 0], // ← seamless로 패치된 모델
        positive: ['3', 0],
        negative: ['4', 0],
        latent_image: ['5', 0],
        seed,
        steps,
        cfg,
        sampler_name: 'dpmpp_sde',
        scheduler: 'karras',
        denoise: 1
      },
      _meta: { title: 'KSampler' }
    },
    7: {
      class_type: 'CircularVAEDecode',
      inputs: { samples: ['6', 0], vae: ['1', 2], tiling },
      _meta: { title: `Circular VAE Decode (${tiling})` }
    },
    8: {
      class_type: 'SaveImage',
      inputs: { images: ['7', 0], filename_prefix: `${filenamePrefix}-pano` },
      _meta: { title: 'Save Panorama' }
    }
  }
  if (seamCheck) {
    g[9] = {
      class_type: 'easy imageConcat',
      inputs: { image1: ['7', 0], image2: ['7', 0], direction: 'right', match_image_size: false },
      _meta: { title: 'Seam Check [A|A]' }
    }
    g[10] = {
      class_type: 'SaveImage',
      inputs: { images: ['9', 0], filename_prefix: `${filenamePrefix}-seam` },
      _meta: { title: 'Save Seam Check' }
    }
  }
  return g
}

// buildGeminiSeamFixWorkflow(seamfix B안 이음매 보정)는 seamfix-legacy.js로 이동함(2026-07-22 equirect 통일, 미사용 격리).

// ── Seedance (ByteDance API 노드 — comfy.org 브로커링, client의 apiKey 필요) ──────────
// 릴의 "기억→기억" 전이 생성. first/last 프레임으로 두 장면 사이를 모델이 이어준다.

export const SEEDANCE_DEFAULTS = Object.freeze({
  model: 'seedance-1-5-pro-251215', // 서버 노드 옵션 중 최신 (2026-07 확인)
  resolution: '1080p',
  aspectRatio: '16:9'
})

/**
 * 루프 컨텍스트 프롬프트 — 한 장면(기억)이 살아 움직이되 처음으로 되돌아오는 seamless 루프.
 * FLF의 first=last=같은 이미지로 만들면 끝이 시작과 이어져 무한 루프가 된다.
 * 3인칭 부감·타인 얼굴 지움(붓자국) 유지. 감정·의미 서술 없음(§1).
 * @param {{ scene: string, age?: number }} s
 */
export function composeSeedanceLoopPrompt(s) {
  const at = s.age != null ? ` — around age ${s.age}` : ''
  return (
    `A living memory that breathes and gently loops. This moment${at}: ${s.scene}. ` +
    `Seen from a slightly elevated high angle looking gently down, quietly observing this life from just above. ` +
    `The central person breathes and moves softly, hair and clothing stir in a faint breeze, ambient life drifts — ` +
    `and everything eases back to exactly where it began so the motion loops seamlessly. ` +
    `Every other person's face stays soft, blurred and indistinct, wiped away like a brushstroke, never sharp. ` +
    `Warm faded film grain, gentle unhurried motion, cinematic, no text, no captions.`
  )
}

/**
 * (미사용 예정) 전이 프롬프트 — 두 장면을 잇는 morph. 루프 방식으로 전환하며 남겨둠.
 * @param {{ scene: string, age?: number }} a
 * @param {{ scene: string, age?: number }} b
 */
export function composeSeedanceTransitionPrompt(a, b) {
  const at = a.age != null ? ` — around age ${a.age}` : ''
  const bt = b.age != null ? ` — around age ${b.age}` : ''
  return (
    `A single life flashing by, one memory dissolving into the next. ` +
    `The scene begins in this moment — ${a.scene}${at}, held softly for a breath, ` +
    `then dreamlike melts and transforms into the next memory — ${b.scene}${bt}. ` +
    `Seen from a slightly elevated high angle looking gently down, quietly observing this life from just above. ` +
    `The central person is the subject and stays visible; every other person's face remains soft, blurred and indistinct, ` +
    `wiped away like a brushstroke, never sharp. Warm faded film grain, gentle drifting motion, cinematic, no text, no captions.`
  )
}

/**
 * Seedance first→last 프레임 전이 워크플로우.
 * @param {object} p
 * @param {string} p.prompt          composeSeedanceTransitionPrompt 결과
 * @param {string} p.firstImage      업로드된 시작 장면 이미지 이름
 * @param {string} p.lastImage       업로드된 도착 장면 이미지 이름
 * @param {number} p.durationSec     3~12초 (노드 제약)
 * @param {string} [p.model]
 * @param {string} [p.resolution]    '480p'|'720p'|'1080p'
 * @param {number} [p.seed]          0~2147483647 (INT32 — 노드 제약)
 * @param {string} p.filenamePrefix
 */
export function buildSeedanceFLFWorkflow({
  prompt,
  firstImage,
  lastImage,
  durationSec,
  model = SEEDANCE_DEFAULTS.model,
  resolution = SEEDANCE_DEFAULTS.resolution,
  seed = Math.floor(Math.random() * 2147483647),
  filenamePrefix = 'chrono-zoetrope/flf'
}) {
  return {
    1: { class_type: 'LoadImage', inputs: { image: firstImage }, _meta: { title: 'First Frame' } },
    2: { class_type: 'LoadImage', inputs: { image: lastImage }, _meta: { title: 'Last Frame' } },
    3: {
      class_type: 'ByteDanceFirstLastFrameNode',
      inputs: {
        model,
        prompt,
        first_frame: ['1', 0],
        last_frame: ['2', 0],
        resolution,
        aspect_ratio: SEEDANCE_DEFAULTS.aspectRatio,
        duration: Math.min(12, Math.max(4, Math.round(durationSec))), // Seedance 1.5 Pro 최소 4초
        seed,
        camera_fixed: false,
        watermark: false
      },
      _meta: { title: 'Seedance FLF' }
    },
    4: {
      class_type: 'SaveVideo',
      inputs: { video: ['3', 0], filename_prefix: filenamePrefix, format: 'mp4', codec: 'h264' },
      _meta: { title: 'Save Transition' }
    }
  }
}
