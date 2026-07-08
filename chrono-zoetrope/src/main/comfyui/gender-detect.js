// 레퍼런스 사진에서 성별 자동 감지 — 이미지 캡션/태그의 성별 단어 파싱.
//
// 수집 앱이 gender를 안 보내므로(향후 폼 확장 전까지) 사진에서 추정한다.
// 결과는 프롬프트의 인물 명사(man/woman/boy/girl)에만 쓰이는 물리 묘사 재료다 —
// 서사 판단이 아니므로 §1(해석적 자율성)과 충돌하지 않는다.
//
// 백엔드는 순서대로 시도한다 (실서버 2026-07 검증):
//   1. DeepDanbooru 태거 — 동작 확인. "1girl, solo, ..." / "1boy, ..." 태그.
//   2. Florence-2 캡션 — 현재 서버 로더가 깨져 있으나 수리되면 자동 폴백 경로가 된다.
// workflow: 'gemini'일 때는 ComfyUI를 거치지 않고 detectGenderWithGemini를 쓴다.
//
// 감지가 틀릴 수 있다 → manifest.gender에 근거 캡션과 함께 기록하고,
// 어드민 페이지에서 수동 수정(POST /api/personas/{pid}/gender)할 수 있게 한다.

import {
  buildDeepDanbooruCaptionWorkflow,
  buildFlorenceCaptionWorkflow
} from './workflows.js'

/**
 * 캡션/태그 텍스트 → 'male' | 'female' | null. 양쪽 단어 수가 비기면 null(중립 프롬프트 유지).
 * \d* 접두는 danbooru 태그(1girl, 2boys)를 함께 잡기 위함.
 */
export function parseGenderFromCaption(caption = '') {
  const female = (caption.match(/\b\d*(woman|women|girl|girls|lady|female|she|her|hers)\b/gi) || []).length
  const male = (caption.match(/\b\d*(man|men|boy|boys|guy|male|gentleman|he|him|his)\b/gi) || []).length
  if (female > male) return 'female'
  if (male > female) return 'male'
  return null
}

/**
 * 업로드된 레퍼런스 사진 1장에서 성별 추정. 프로필당 1회.
 * 백엔드가 죽어 있으면 다음 후보로 넘어가고, 전부 실패하면 마지막 에러를 던진다.
 * @param {import('./client.js').ComfyUIClient} client
 * @param {string} referenceImage  client.uploadImage 반환값의 name
 * @returns {{ gender: 'male'|'female'|null, caption: string, backend: string|null }}
 */
export async function detectGender(client, referenceImage) {
  const attempts = [
    ['deepdanbooru', buildDeepDanbooruCaptionWorkflow({ referenceImage })],
    ['florence-caption', buildFlorenceCaptionWorkflow({ referenceImage, task: 'caption' })],
    ['florence-detailed', buildFlorenceCaptionWorkflow({ referenceImage, task: 'detailed_caption' })]
  ]
  let last = { caption: '', backend: null }
  let lastError = null
  for (const [backend, wf] of attempts) {
    try {
      const { text } = await client.generateText(wf)
      last = { caption: text, backend }
      const gender = parseGenderFromCaption(text)
      if (gender) return { gender, ...last }
    } catch (err) {
      lastError = err
    }
  }
  if (!last.backend && lastError) throw lastError
  return { gender: null, ...last }
}

/**
 * Gemini 백엔드용 성별 추정 — 로컬 사진 Buffer를 캡션시켜 같은 파서에 통과시킨다.
 * (workflow: 'gemini'일 때 ComfyUI 태거 대신 사용. 판단 성격은 동일: 물리 묘사 재료.)
 * @param {import('./gemini-client.js').GeminiClient} gclient
 * @param {Buffer} imageBuffer  레퍼런스 사진 원본
 * @returns {{ gender: 'male'|'female'|null, caption: string, backend: string }}
 */
export async function detectGenderWithGemini(gclient, imageBuffer) {
  const caption = await gclient.describeImage({
    image: imageBuffer,
    prompt:
      'Describe the person in this photo in one factual sentence, stating whether they appear to be a man, woman, boy, or girl.'
  })
  return { gender: parseGenderFromCaption(caption), caption, backend: 'gemini' }
}
