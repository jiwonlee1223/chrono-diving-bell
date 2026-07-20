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
  // BrushNet gap-fill(같은 방 두 시점 사이 메우기 실험). SDXL random-mask + 사실체 SDXL 베이스.
  sdxlInpaintBase: 'epicrealism-xl.safetensors',
  brushnet: 'brushnet_random_mask_sdxl.safetensors',
  // Flux Fill — 전용 inpainting diffusion 모델. B안 seam 보정 띠를 Gemini에 근접한 화질로 채운다
  // (SDXL Lightning 대비 왜곡·뭉갬 크게 감소). CLIP/VAE는 kontext와 공유(flux 계열).
  fluxFill: 'fluxFillFP8_v10.safetensors',
  // Flux.2 dev — surround 아웃페인팅 엔진. 앵커(Gemini) 옆을 마스크 아웃페인팅으로 '진짜' 이어 그린다
  // (Gemini 재생성과 달리 기존 픽셀에 조건화 → 원근·내용 연속). 전용 인코더(mistral)·VAE(flux2) 사용.
  flux2Unet: 'flux2_dev_fp8mixed.safetensors',
  flux2Clip: 'mistral_3_small_flux2_bf16.safetensors',
  flux2Vae: 'flux2-vae.safetensors',
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
  // 뒤쪽 추가분(2026-07-19): 说话/张嘴/念白… = 말하기·입벙긋·대사·카메라 응대. 주인공이 사진 밖 사용자에게 말 거는 것 방지.
  '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走，说话，张嘴，张嘴说话，念白，对着镜头说话，对口型，嘴巴动'

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
    100: { class_type: 'LoadImage', inputs: { image: referenceImage }, _meta: { title: 'Gemini Panorama' } },
    101: {
      class_type: 'ImageScale',
      inputs: { image: ['100', 0], upscale_method: 'lanczos', width, height, crop: 'disabled' },
      _meta: { title: 'Normalize to 2:1' }
    },
    // roll by width/2: [rightHalf | leftHalf] → 원래 wrap 경계가 중앙으로
    102: { class_type: 'ImageCrop', inputs: { image: ['101', 0], width: halfW, height, x: 0, y: 0 }, _meta: { title: 'Left Half' } },
    103: { class_type: 'ImageCrop', inputs: { image: ['101', 0], width: halfW, height, x: halfW, y: 0 }, _meta: { title: 'Right Half' } },
    104: {
      class_type: 'easy imageConcat',
      inputs: { image1: ['103', 0], image2: ['102', 0], direction: 'right', match_image_size: false },
      _meta: { title: 'Rolled [R|L]' }
    },
    // 중앙 세로 띠 마스크
    105: { class_type: 'SolidMask', inputs: { value: 0.0, width, height }, _meta: { title: 'Black Canvas' } },
    106: { class_type: 'SolidMask', inputs: { value: 1.0, width: bandWidth, height }, _meta: { title: 'White Band' } },
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
      110: { class_type: 'UNETLoader', inputs: { unet_name: MODELS.fluxFill, weight_dtype: 'default' }, _meta: { title: 'Load Flux Fill' } },
      111: {
        class_type: 'DualCLIPLoader',
        inputs: { clip_name1: MODELS.kontextClip[0], clip_name2: MODELS.kontextClip[1], type: 'flux' },
        _meta: { title: 'Load CLIP (flux)' }
      },
      112: { class_type: 'VAELoader', inputs: { vae_name: MODELS.kontextVae }, _meta: { title: 'Load VAE (ae)' } },
      113: { class_type: 'CLIPTextEncode', inputs: { text: bandPrompt, clip: ['111', 0] }, _meta: { title: 'Band Prompt' } },
      114: { class_type: 'FluxGuidance', inputs: { conditioning: ['113', 0], guidance: fluxGuidance }, _meta: { title: 'Flux Guidance' } },
      115: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['113', 0] }, _meta: { title: 'Negative (zeroed)' } },
      116: {
        class_type: 'InpaintModelConditioning',
        inputs: { positive: ['114', 0], negative: ['115', 0], vae: ['112', 0], pixels: ['104', 0], mask: ['108', 0], noise_mask: true },
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
      118: { class_type: 'VAEDecode', inputs: { samples: ['117', 0], vae: ['112', 0] }, _meta: { title: 'Decode' } }
    })
    fixedRef = ['118', 0]
  } else {
    // SDXL 폴백 — realvisxl Lightning, 마스크 노이즈 inpaint
    const dn = denoise ?? 0.7
    Object.assign(g, {
      110: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: sdxlCheckpoint }, _meta: { title: 'Load SDXL' } },
      113: { class_type: 'CLIPTextEncode', inputs: { text: bandPrompt, clip: ['110', 1] }, _meta: { title: 'Band Prompt' } },
      114: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['110', 1] }, _meta: { title: 'Negative' } },
      115: { class_type: 'VAEEncode', inputs: { pixels: ['104', 0], vae: ['110', 2] }, _meta: { title: 'Encode Rolled' } },
      116: { class_type: 'SetLatentNoiseMask', inputs: { samples: ['115', 0], mask: ['108', 0] }, _meta: { title: 'Mask Band' } },
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
      118: { class_type: 'VAEDecode', inputs: { samples: ['117', 0], vae: ['110', 2] }, _meta: { title: 'Decode' } }
    })
    fixedRef = ['118', 0]
  }

  // ── roll back by width/2 → 보정된 띠가 양끝(wrap 지점)으로 ──
  Object.assign(g, {
    120: { class_type: 'ImageCrop', inputs: { image: fixedRef, width: halfW, height, x: 0, y: 0 }, _meta: { title: 'Left Half (fixed)' } },
    121: { class_type: 'ImageCrop', inputs: { image: fixedRef, width: halfW, height, x: halfW, y: 0 }, _meta: { title: 'Right Half (fixed)' } },
    122: {
      class_type: 'easy imageConcat',
      inputs: { image1: ['121', 0], image2: ['120', 0], direction: 'right', match_image_size: false },
      _meta: { title: 'Roll Back → Final' }
    },
    123: { class_type: 'SaveImage', inputs: { images: ['122', 0], filename_prefix: `${filenamePrefix}-pano` }, _meta: { title: 'Save Corrected' } },
    124: { class_type: 'SaveImage', inputs: { images: ['101', 0], filename_prefix: `${filenamePrefix}-raw` }, _meta: { title: 'Save Gemini Raw' } }
  })
  if (seamCheck) {
    g[125] = { class_type: 'easy imageConcat', inputs: { image1: ['122', 0], image2: ['122', 0], direction: 'right', match_image_size: false }, _meta: { title: 'Seam (fixed)' } }
    g[126] = { class_type: 'SaveImage', inputs: { images: ['125', 0], filename_prefix: `${filenamePrefix}-seam` }, _meta: { title: 'Save Seam (fixed)' } }
    g[127] = { class_type: 'easy imageConcat', inputs: { image1: ['101', 0], image2: ['101', 0], direction: 'right', match_image_size: false }, _meta: { title: 'Seam (raw)' } }
    g[128] = { class_type: 'SaveImage', inputs: { images: ['127', 0], filename_prefix: `${filenamePrefix}-rawseam` }, _meta: { title: 'Save Seam (raw)' } }
  }
  return g
}

/**
 * Flux Fill 단측 아웃페인팅 — Path B(rotate-and-outpaint / 생성형 Street View)용.
 *
 * 앵커 이미지를 한쪽(left|right)으로 pad하고 그 pad 영역만 이웃 픽셀에 조건화해 채운다.
 * gap-fill(양쪽 고정, 블러)이 아니라 continuation(한쪽만 고정)이라 선명하다 — 방위각 연속을 만드는 핵심.
 * SaveImage가 (srcWidth + pad) × height 전체를 저장하니, 호출자가 새 pad 영역만 crop해서 슬라이딩한다.
 * 프롬프트는 composeSurroundFlux2Continuation 권장('빈칸 채워라' 금지, '옆으로 이어 그려라' 내용 지시).
 *
 * @param {object} p
 * @param {string} p.referenceImage  업로드된 앵커 이름 (client.uploadImage().name)
 * @param {string} p.prompt          연속 프롬프트
 * @param {number} p.srcWidth        앵커 폭(px) — ImageScale로 강제 정규화
 * @param {number} p.height
 * @param {'right'|'left'} p.side     확장 방향
 * @param {number} p.pad             이번 스텝에 이어 그릴 폭(px)
 * @param {number} p.feather         pad 경계 페더(px)
 * @param {number} p.denoise         기본 1.0 (Flux Fill)
 * @param {number} p.fluxGuidance    기본 30
 * @param {number} p.steps           기본 20
 * @param {number} p.seed
 * @param {string} p.filenamePrefix  `${prefix}-ext` 로 저장
 */
export function buildFluxFillOutpaintWorkflow({
  referenceImage,
  prompt,
  srcWidth,
  height = 1024,
  side = 'right',
  pad = 512,
  feather = 64,
  denoise = 1.0,
  fluxGuidance = 30,
  steps = 20,
  seed = randomSeed(),
  filenamePrefix
}) {
  const padL = side === 'left' ? pad : 0
  const padR = side === 'right' ? pad : 0
  return {
    100: { class_type: 'LoadImage', inputs: { image: referenceImage }, _meta: { title: 'Anchor' } },
    101: {
      class_type: 'ImageScale',
      inputs: { image: ['100', 0], upscale_method: 'lanczos', width: srcWidth, height, crop: 'disabled' },
      _meta: { title: 'Normalize Anchor' }
    },
    102: {
      class_type: 'ImagePadForOutpaint',
      inputs: { image: ['101', 0], left: padL, top: 0, right: padR, bottom: 0, feathering: feather },
      _meta: { title: `Pad ${side} ${pad}` }
    },
    110: { class_type: 'UNETLoader', inputs: { unet_name: MODELS.fluxFill, weight_dtype: 'default' }, _meta: { title: 'Load Flux Fill' } },
    111: {
      class_type: 'DualCLIPLoader',
      inputs: { clip_name1: MODELS.kontextClip[0], clip_name2: MODELS.kontextClip[1], type: 'flux' },
      _meta: { title: 'Load CLIP (flux)' }
    },
    112: { class_type: 'VAELoader', inputs: { vae_name: MODELS.kontextVae }, _meta: { title: 'Load VAE (ae)' } },
    113: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['111', 0] }, _meta: { title: 'Continuation Prompt' } },
    114: { class_type: 'FluxGuidance', inputs: { conditioning: ['113', 0], guidance: fluxGuidance }, _meta: { title: 'Flux Guidance' } },
    115: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['113', 0] }, _meta: { title: 'Negative (zeroed)' } },
    116: {
      class_type: 'InpaintModelConditioning',
      inputs: { positive: ['114', 0], negative: ['115', 0], vae: ['112', 0], pixels: ['102', 0], mask: ['102', 1], noise_mask: true },
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
        steps,
        cfg: 1,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise
      },
      _meta: { title: `Outpaint ${side}` }
    },
    118: { class_type: 'VAEDecode', inputs: { samples: ['117', 0], vae: ['112', 0] }, _meta: { title: 'Decode' } },
    119: { class_type: 'SaveImage', inputs: { images: ['118', 0], filename_prefix: `${filenamePrefix}-ext` }, _meta: { title: 'Save Extended' } }
  }
}

/**
 * BrushNet gap-fill — 조인 주변 crop(width×height)의 중앙 세로 밴드를 BrushNet(SDXL)로 채운다.
 * "서로 다른 두 시점 사이(gap)를 메우기"의 BrushNet 버전. Flux Fill(gap=블러) 대비 문맥 이중분기라
 * 큰 마스크에 더 일관적일 것으로 기대. easy-nodes 파이프라인 사용(fullLoader→applyInpaint→preSampling→kSampler).
 *
 * SDXL은 4096폭에서 반복 아티팩트가 나므로 호출자가 조인 주변만 crop(≤2048)해 넘긴다. mask 밖은 보존.
 *
 * @param {object} p
 * @param {string} p.referenceImage  업로드된 crop 이름
 * @param {string} p.prompt          밴드 프롬프트(SEAM_BLEND_PROMPT 권장 — 새 인물·사물 금지, 표면 연장)
 * @param {number} p.width           crop 폭(≤2048 권장)
 * @param {number} p.height
 * @param {number} p.bandWidth       중앙 마스크 밴드 폭
 * @param {number} p.feather         밴드 좌우 페더
 * @param {string} p.ckpt            SDXL 체크포인트
 * @param {string} p.vae             VAE(SDXL)
 * @param {string} p.brushnet        BrushNet 모델
 * @param {number} p.steps @param {number} p.cfg @param {number} p.denoise @param {number} p.scale
 * @param {number} p.seed @param {string} p.filenamePrefix
 */
export function buildBrushNetGapFillWorkflow({
  referenceImage,
  prompt,
  negative = PANORAMA_NEGATIVE,
  width = 1536,
  height = 1024,
  bandWidth = 768,
  feather = 96,
  ckpt = 'sd_xl_base_1.0.safetensors',
  vae = 'sdxl.vae.safetensors',
  inpaintMode = 'brushnet_random', // 'brushnet_random'|'fooocus_inpaint'|'powerpaint'|'normal'
  fn = 'text guided', // powerpaint용 function(brushnet/fooocus는 무시)
  encode = 'vae_encode_inpaint',
  steps = 25,
  cfg = 7,
  denoise = 1.0,
  scale = 1.0,
  seed = randomSeed(),
  filenamePrefix
}) {
  const bandX = Math.floor((width - bandWidth) / 2)
  return {
    100: { class_type: 'LoadImage', inputs: { image: referenceImage }, _meta: { title: 'Join Crop' } },
    101: {
      class_type: 'ImageScale',
      inputs: { image: ['100', 0], upscale_method: 'lanczos', width, height, crop: 'disabled' },
      _meta: { title: 'Normalize' }
    },
    105: { class_type: 'SolidMask', inputs: { value: 0.0, width, height }, _meta: { title: 'Black' } },
    106: { class_type: 'SolidMask', inputs: { value: 1.0, width: bandWidth, height }, _meta: { title: 'Band' } },
    107: {
      class_type: 'MaskComposite',
      inputs: { destination: ['105', 0], source: ['106', 0], x: bandX, y: 0, operation: 'add' },
      _meta: { title: 'Center Band Mask' }
    },
    108: { class_type: 'FeatherMask', inputs: { mask: ['107', 0], left: feather, top: 0, right: feather, bottom: 0 }, _meta: { title: 'Feather' } },
    110: {
      class_type: 'easy fullLoader',
      inputs: {
        ckpt_name: ckpt,
        config_name: 'Default',
        vae_name: vae,
        clip_skip: -2,
        lora_name: 'None',
        lora_model_strength: 1,
        lora_clip_strength: 1,
        resolution: 'width x height (custom)',
        empty_latent_width: width,
        empty_latent_height: height,
        positive: prompt,
        positive_token_normalization: 'none',
        positive_weight_interpretation: 'comfy',
        negative,
        negative_token_normalization: 'none',
        negative_weight_interpretation: 'comfy',
        batch_size: 1,
        a1111_prompt_style: false
      },
      _meta: { title: 'Load SDXL (easy)' }
    },
    111: {
      class_type: 'easy applyInpaint',
      inputs: {
        pipe: ['110', 0],
        image: ['101', 0],
        mask: ['108', 0],
        inpaint_mode: inpaintMode,
        encode,
        grow_mask_by: 6,
        dtype: 'float16',
        fitting: 1.0,
        function: fn,
        scale,
        start_at: 0,
        end_at: 10000,
        noise_mask: true
      },
      _meta: { title: `Apply Inpaint (${inpaintMode})` }
    },
    112: {
      class_type: 'easy preSampling',
      // easy preSampling seed 최대 = 2^50. randomSeed()가 더 클 수 있어 클램프.
      inputs: { pipe: ['111', 0], steps, cfg, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise, seed: seed % 1125899906842624 },
      _meta: { title: 'PreSampling' }
    },
    113: {
      class_type: 'easy kSampler',
      inputs: { pipe: ['112', 0], image_output: 'Save', link_id: 0, save_prefix: `${filenamePrefix}-brush` },
      _meta: { title: 'Sample (BrushNet)' }
    }
  }
}

/**
 * 서라운드(surround) 조립본의 타일 접합선을 Flux Fill로 한 번에 블렌딩한다.
 *
 * surround는 90° 타일 4장을 Gemini 캔버스 아웃페인팅으로 이어 4:1로 조립한다(panorama-tiles.js).
 * 조립본에는 접합선이 4곳 — 내부 3곳(x=tileSize,2·tileSize,3·tileSize)과 등 뒤 wrap 1곳(x=0/width 경계)이다.
 * 이 워크플로우는 조립본을 **tileSize/2 만큼 roll**해서 4곳 접합선을 전부 '내부'로 옮긴다
 * (wrap 경계가 (0+½)·tileSize로 오고, 나머지도 (k+½)·tileSize로 균등 배치. 새로 생긴 양끝은
 *  tile3 한가운데라 연속이라 새 이음매가 안 생긴다). 그 4개 세로 띠만 Flux Fill로 다시 그려 잇고 roll back.
 *
 * 밴드 프롬프트는 SEAM_BLEND_PROMPT 권장 — seamfix의 '민무늬 벽'(SEAM_BAND_PROMPT)과 달리, 접합선이
 * 방 한가운데를 지나므로 '양쪽에 이미 있는 표면·사물을 이어 섞으라'고만 지시한다(새 인물·사물 금지).
 *
 * @param {object} p
 * @param {string} p.referenceImage  업로드된 조립 파노라마 이름 (client.uploadImage().name)
 * @param {string} p.bandPrompt      접합선 띠 프롬프트 (SEAM_BLEND_PROMPT 권장)
 * @param {number} p.width           조립본 가로(4:1 → 4·tileSize). ImageScale로 강제 정규화.
 * @param {number} p.height
 * @param {number} p.tileCount       타일 수(기본 4). 접합선 = tileCount곳.
 * @param {number} p.bandWidth       접합선 띠 폭(px). 좁을수록 원본 보존↑. 기본 200.
 * @param {number} p.feather         띠 좌우 페더(px). 기본 100.
 * @param {number} p.seed
 * @param {'flux-fill'|'sdxl'} p.bandModel  기본 flux-fill.
 * @param {number} p.denoise         미지정 시 모델별 기본(flux 1.0 / sdxl 0.7).
 * @param {number} p.fluxGuidance
 * @param {string} p.filenamePrefix  `${prefix}-pano`(보정본) `${prefix}-raw`(입력 조립본)
 * @param {boolean} p.seamCheck      [A|A] 검증 이미지 추가
 */
export function buildSurroundSeamBlendWorkflow({
  referenceImage,
  bandPrompt,
  negative = PANORAMA_NEGATIVE,
  width = 4096,
  height = 1024,
  tileCount = 4,
  bandWidth = 200,
  feather = 100,
  seed = randomSeed(),
  bandModel = 'flux-fill',
  denoise,
  fluxGuidance = 30,
  steps,
  cfg = 1.5,
  sdxlCheckpoint = MODELS.sdxl,
  filenamePrefix,
  seamCheck = false
}) {
  const tileSize = Math.round(width / tileCount)
  const roll = Math.round(tileSize / 2) // 접합선을 전부 내부로 옮기는 roll 량
  const restW = width - roll
  // roll 후 접합선 중심: (k+½)·tileSize (k=0..tileCount-1). k=0이 원래 wrap 경계.
  const bandCenters = Array.from({ length: tileCount }, (_, k) => Math.round((k + 0.5) * tileSize))

  const g = {
    100: { class_type: 'LoadImage', inputs: { image: referenceImage }, _meta: { title: 'Surround Panorama' } },
    101: {
      class_type: 'ImageScale',
      inputs: { image: ['100', 0], upscale_method: 'lanczos', width, height, crop: 'disabled' },
      _meta: { title: 'Normalize' }
    },
    // roll right by `roll`: [old[width-roll..width] | old[0..width-roll]] → 4접합선이 전부 내부로
    102: { class_type: 'ImageCrop', inputs: { image: ['101', 0], width: restW, height, x: 0, y: 0 }, _meta: { title: 'Left Part' } },
    103: { class_type: 'ImageCrop', inputs: { image: ['101', 0], width: roll, height, x: restW, y: 0 }, _meta: { title: 'Right Part' } },
    104: {
      class_type: 'easy imageConcat',
      inputs: { image1: ['103', 0], image2: ['102', 0], direction: 'right', match_image_size: false },
      _meta: { title: 'Rolled' }
    },
    // 4개 세로 띠 마스크: 검정 캔버스 + 각 접합선 위치에 흰 띠 add → 페더
    130: { class_type: 'SolidMask', inputs: { value: 0.0, width, height }, _meta: { title: 'Black Canvas' } },
    131: { class_type: 'SolidMask', inputs: { value: 1.0, width: bandWidth, height }, _meta: { title: 'White Band' } }
  }
  // MaskComposite 체인으로 4개 띠를 누적한다(132..).
  let maskRef = ['130', 0]
  bandCenters.forEach((center, i) => {
    const node = 132 + i
    g[node] = {
      class_type: 'MaskComposite',
      inputs: { destination: maskRef, source: ['131', 0], x: Math.max(0, center - Math.round(bandWidth / 2)), y: 0, operation: 'add' },
      _meta: { title: `Band @${center}` }
    }
    maskRef = [String(node), 0]
  })
  const featherNode = 132 + bandCenters.length
  g[featherNode] = {
    class_type: 'FeatherMask',
    inputs: { mask: maskRef, left: feather, top: 0, right: feather, bottom: 0 },
    _meta: { title: 'Feather Bands' }
  }
  const maskOut = [String(featherNode), 0]

  // ── inpaint 코어(모델별) → 보정된 rolled 이미지 ref ──
  let fixedRef
  if (bandModel === 'flux-fill') {
    const dn = denoise ?? 1.0
    Object.assign(g, {
      110: { class_type: 'UNETLoader', inputs: { unet_name: MODELS.fluxFill, weight_dtype: 'default' }, _meta: { title: 'Load Flux Fill' } },
      111: {
        class_type: 'DualCLIPLoader',
        inputs: { clip_name1: MODELS.kontextClip[0], clip_name2: MODELS.kontextClip[1], type: 'flux' },
        _meta: { title: 'Load CLIP (flux)' }
      },
      112: { class_type: 'VAELoader', inputs: { vae_name: MODELS.kontextVae }, _meta: { title: 'Load VAE (ae)' } },
      113: { class_type: 'CLIPTextEncode', inputs: { text: bandPrompt, clip: ['111', 0] }, _meta: { title: 'Band Prompt' } },
      114: { class_type: 'FluxGuidance', inputs: { conditioning: ['113', 0], guidance: fluxGuidance }, _meta: { title: 'Flux Guidance' } },
      115: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['113', 0] }, _meta: { title: 'Negative (zeroed)' } },
      116: {
        class_type: 'InpaintModelConditioning',
        inputs: { positive: ['114', 0], negative: ['115', 0], vae: ['112', 0], pixels: ['104', 0], mask: maskOut, noise_mask: true },
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
        _meta: { title: 'Blend Bands (Flux Fill)' }
      },
      118: { class_type: 'VAEDecode', inputs: { samples: ['117', 0], vae: ['112', 0] }, _meta: { title: 'Decode' } }
    })
    fixedRef = ['118', 0]
  } else {
    const dn = denoise ?? 0.7
    Object.assign(g, {
      110: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: sdxlCheckpoint }, _meta: { title: 'Load SDXL' } },
      113: { class_type: 'CLIPTextEncode', inputs: { text: bandPrompt, clip: ['110', 1] }, _meta: { title: 'Band Prompt' } },
      114: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['110', 1] }, _meta: { title: 'Negative' } },
      115: { class_type: 'VAEEncode', inputs: { pixels: ['104', 0], vae: ['110', 2] }, _meta: { title: 'Encode Rolled' } },
      116: { class_type: 'SetLatentNoiseMask', inputs: { samples: ['115', 0], mask: maskOut }, _meta: { title: 'Mask Bands' } },
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
        _meta: { title: 'Blend Bands (SDXL)' }
      },
      118: { class_type: 'VAEDecode', inputs: { samples: ['117', 0], vae: ['110', 2] }, _meta: { title: 'Decode' } }
    })
    fixedRef = ['118', 0]
  }

  // ── roll back by `roll` (inverse) → 접합선이 원위치로 ──
  Object.assign(g, {
    120: { class_type: 'ImageCrop', inputs: { image: fixedRef, width: restW, height, x: roll, y: 0 }, _meta: { title: 'Left Part (fixed)' } },
    121: { class_type: 'ImageCrop', inputs: { image: fixedRef, width: roll, height, x: 0, y: 0 }, _meta: { title: 'Right Part (fixed)' } },
    122: {
      class_type: 'easy imageConcat',
      inputs: { image1: ['120', 0], image2: ['121', 0], direction: 'right', match_image_size: false },
      _meta: { title: 'Roll Back → Final' }
    },
    123: { class_type: 'SaveImage', inputs: { images: ['122', 0], filename_prefix: `${filenamePrefix}-pano` }, _meta: { title: 'Save Blended' } },
    124: { class_type: 'SaveImage', inputs: { images: ['101', 0], filename_prefix: `${filenamePrefix}-raw` }, _meta: { title: 'Save Raw Assembled' } }
  })
  if (seamCheck) {
    g[125] = { class_type: 'easy imageConcat', inputs: { image1: ['122', 0], image2: ['122', 0], direction: 'right', match_image_size: false }, _meta: { title: 'Seam (blended)' } }
    g[126] = { class_type: 'SaveImage', inputs: { images: ['125', 0], filename_prefix: `${filenamePrefix}-seam` }, _meta: { title: 'Save Seam (blended)' } }
    g[127] = { class_type: 'easy imageConcat', inputs: { image1: ['101', 0], image2: ['101', 0], direction: 'right', match_image_size: false }, _meta: { title: 'Seam (raw)' } }
    g[128] = { class_type: 'SaveImage', inputs: { images: ['127', 0], filename_prefix: `${filenamePrefix}-rawseam` }, _meta: { title: 'Save Seam (raw)' } }
  }
  return g
}

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
 * 1인칭 몰입·타인 얼굴 지움(붓자국) 유지. 감정·의미 서술 없음(§1). (seedance는 4:1 미지원이라 파노라마엔 비활성 — wan 사용.)
 * @param {{ scene: string, age?: number }} s
 */
export function composeSeedanceLoopPrompt(s) {
  const at = s.age != null ? ` — around age ${s.age}` : ''
  return (
    `A living memory that breathes and gently loops. This moment${at}: ${s.scene}. ` +
    `Seen from within the moment at eye level, standing inside the scene as it surrounds the viewer on every side (first-person immersion, not a high angle). ` +
    `The central person facing the viewer stays in place and only breathes and shifts softly; ` +
    `every other person moves naturally — walking, stepping and going about the moment around them — ` +
    `while their faces stay soft, blurred and indistinct, wiped away like a brushstroke, never sharp. ` +
    `Hair and clothing stir in a faint breeze, ambient life drifts, and the motion loops gently and seamlessly. ` +
    `Warm faded film grain, gentle unhurried motion, cinematic, no text, no captions.`
  )
}

// ── Wan I2V 모션 프롬프트 (씬 컨텍스트 반영) ─────────────────────────────────────
// 기존엔 video-cache가 config의 고정 promptPrefix 뒤에 ' Scene: {scene}.'만 붙였다. 여기서는
// 그 고정 불변부(promptPrefix: 투영 유지·시점 고정·주인공 정지/미세모션·타인은 자연스럽게 걸음·
// 타인 얼굴 smear)를 base로 그대로 두고, 뒤에 '이 씬에서 무엇이 어떻게 움직이는가'라는 주변 모션
// 구절만 씬 텍스트에 맞춰 결정론적으로 덧붙인다.
//
// §1(해석적 자율성) 준수: 이 로직은 서사·의미·감정을 저작하지 않는다. scene 문자열의 감각적 단서
// (날씨·물·장소·사물)에서 물리적 움직임만 유도할 뿐이다. 같은 scene이면 항상 같은 구절이 나오고,
// 의미 부여는 넣지 않는다 — 움직임의 '재료'만 흩어 놓는다. 새 단서를 넣고 싶으면 이 배열만 고친다.
const WAN_MOTION_CUES = [
  { re: /\brain\b|umbrella|puddle/i, cue: 'fine rain keeps falling and dimples the puddles' },
  { re: /\bsnow\b/i, cue: 'snow drifts down slowly through the air' },
  { re: /steam|\bbath\b|basin|noodle|cooking|\btea\b|coffee|grilled|\brice\b|kitchen/i, cue: 'steam and warm air rise and curl' },
  { re: /field|ridge|\bhik|garden|\btree|ginkgo|veranda|highway|cosmos|\bpark\b|market|street|alley|breeze|window/i, cue: 'grass, leaves, curtains and clothing stir in a light breeze' },
  { re: /playground|court|relay|bicycle|swing|\brun\b|running|\bwalk|\bdance|sports/i, cue: 'easy continuous movement carries through the moment' },
  { re: /cafeteria|reunion|friends|classroom|office|library|\bhall\b|\btable\b|market|street|station|\bshop/i, cue: 'the people around move about naturally, coming and going' }
]

/**
 * Wan2.2 I2V 모션 프롬프트를 씬 컨텍스트에 맞춰 조립한다.
 * 고정 불변부(promptPrefix) + ' Scene: {scene}.' + 씬에 걸리는 주변 모션 구절.
 * @param {{ scene?: string }} image  라이브러리 이미지(장면 텍스트 포함)
 * @param {{ promptPrefix?: string }} opts  config montage.regen.wan.promptPrefix
 */
export function composeWanMotionPrompt(image, { promptPrefix = '' } = {}) {
  const scene = image && image.scene ? String(image.scene) : ''
  const sceneClause = scene ? ` Scene: ${scene}.` : ''
  const cues = WAN_MOTION_CUES.filter((c) => c.re.test(scene)).map((c) => c.cue)
  const ambient = cues.length ? ` In this scene, ${cues.join('; ')}.` : ''
  return `${promptPrefix}${sceneClause}${ambient}`.trim()
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
    `Seen from within the moment at eye level, standing inside the scene as it surrounds the viewer on every side (first-person immersion, not a high angle). ` +
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
