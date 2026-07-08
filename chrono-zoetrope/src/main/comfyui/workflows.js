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
  sdxl: 'realvisxlV40_v40LightningBakedvae.safetensors'
}

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
