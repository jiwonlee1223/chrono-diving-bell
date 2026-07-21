// Gemini 이미지 생성 REST 클라이언트 (Nano Banana Pro 계열).
//
// client.js(ComfyUI)와 같은 원칙: SDK 없이 plain fetch, 결정론적 파이프라인(§5.3),
// Electron main과 CLI 양쪽에서 쓰도록 순수 Node 모듈로 유지한다(electron import 금지).
//
//   POST /v1beta/models/{model}:generateContent   프롬프트(+레퍼런스 inline) → 이미지 base64
//   GET  /v1beta/models/{model}                   키·네트워크·모델 확인 (ping)
//
// 레퍼런스 이미지는 업로드 단계 없이 요청마다 base64 inline으로 전달한다.
// 시드 제어가 없으므로 재생성은 "확률을 다시 굴리는" 동작이 된다 (manifest에는 seed: null).

import fs from 'node:fs/promises'
import path from 'node:path'

const API_HOST = 'https://generativelanguage.googleapis.com'
const RETRY_DELAYS_MS = [2000, 8000, 20000] // 429/5xx 지수 백오프 — 40장 연속 생성 시 rate limit 대비

/**
 * comfyui.json의 gemini 섹션을 호출 준비 상태로 정규화 — apiKeyPath("./secrets/...")를
 * 프로젝트 루트 기준 절대경로로 바꾼다. 각 진입점(CLI·admin·firestore 워커)이 이걸 통과시킨다.
 */
export function resolveGeminiConfig(gemini = {}, rootDir = process.cwd()) {
  return {
    ...gemini,
    apiKeyPath: gemini.apiKeyPath ? path.resolve(rootDir, gemini.apiKeyPath) : undefined
  }
}

/**
 * API 키 해석: 명시 인자 → GEMINI_API_KEY 환경변수 → apiKeyPath 파일(호출자가 절대경로로 넘긴다).
 * 셋 다 없으면 throw — 생성 도중이 아니라 시작 전에 실패시키기 위함.
 */
export async function resolveGeminiApiKey({ apiKey, apiKeyPath } = {}) {
  if (apiKey) return apiKey
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY
  if (apiKeyPath) {
    try {
      const key = (await fs.readFile(apiKeyPath, 'utf-8')).trim()
      if (key) return key
    } catch {
      /* 아래 공통 에러로 */
    }
  }
  throw new Error(
    `Gemini API 키 없음 — GEMINI_API_KEY 환경변수를 설정하거나 키 파일을 만들 것${apiKeyPath ? `: ${apiKeyPath}` : ''}`
  )
}

// Gemini 이미지 생성이 허용하는 aspectRatio 목록(2026-07 실측, 그 외는 HTTP 400).
// 파노라마용 초광각 4:1·8:1 포함. 넓은 seamfix 파노라마는 여기서 비율을 고른다.
const GEMINI_ASPECTS = [
  ['1:8', 1 / 8], ['1:4', 1 / 4], ['9:16', 9 / 16], ['2:3', 2 / 3], ['3:4', 3 / 4], ['4:5', 4 / 5],
  ['1:1', 1],
  ['5:4', 5 / 4], ['4:3', 4 / 3], ['3:2', 3 / 2], ['16:9', 16 / 9], ['21:9', 21 / 9], ['4:1', 4], ['8:1', 8]
]

/**
 * 목표 크기(width×height)에 가장 가까운, Gemini가 허용하는 aspectRatio 라벨을 고른다.
 * seamfix 파노라마 폭을 바꿀 때 aspectRatio를 하드코딩하지 않고 여기서 유도한다
 * (예: 4096×1024 → '4:1', 2048×1024 → '16:9'/'21:9' 중 가까운 쪽, 1344×768 → '16:9').
 */
export function nearestGeminiAspect(width, height) {
  const target = width / height
  let best = '1:1'
  let bestDiff = Infinity
  for (const [label, val] of GEMINI_ASPECTS) {
    const diff = Math.abs(val - target)
    if (diff < bestDiff) {
      bestDiff = diff
      best = label
    }
  }
  return best
}

function sniffMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png'
  if (buffer.length >= 12 && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return 'image/png'
}

function imagePart(buffer) {
  return { inline_data: { mime_type: sniffMime(buffer), data: buffer.toString('base64') } }
}

export class GeminiClient {
  constructor({ apiKey, model = 'gemini-3-pro-image', textModel = 'gemini-2.5-flash', timeoutMs = 300000, host = API_HOST } = {}) {
    if (!apiKey) throw new Error('GeminiClient: apiKey가 필요하다 (resolveGeminiApiKey 참조)')
    this.apiKey = apiKey
    this.model = model
    this.textModel = textModel // describeImage용 텍스트 모델 (이미지 모델은 IMAGE 응답 전용)
    this.timeoutMs = timeoutMs
    this.host = host.replace(/\/+$/, '')
  }

  #headers() {
    return { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' }
  }

  /** 429/5xx·네트워크 오류를 백오프 재시도. 4xx(키·요청 오류)는 즉시 throw.
   *  signal: 외부 취소(중지 버튼) 신호 — 타임아웃과 합쳐 걸고, 취소되면 재시도 없이 즉시 중단. */
  async #post(path, body, what, signal) {
    let lastErr = null
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (signal?.aborted) throw new Error('취소됨')
      if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]))
      try {
        const res = await fetch(`${this.host}${path}`, {
          method: 'POST',
          headers: this.#headers(),
          body: JSON.stringify(body),
          signal: signal
            ? AbortSignal.any([AbortSignal.timeout(this.timeoutMs), signal])
            : AbortSignal.timeout(this.timeoutMs)
        })
        if (res.ok) return res.json()
        const text = await res.text().catch(() => '')
        lastErr = new Error(`Gemini ${what} 실패: HTTP ${res.status} ${text.slice(0, 500)}`)
        if (res.status !== 429 && res.status < 500) throw lastErr // 재시도 무의미
      } catch (err) {
        if (signal?.aborted) throw new Error('취소됨') // 사용자 중지 → 재시도 안 함
        if (err === lastErr) throw err
        lastErr = err // 네트워크/타임아웃 → 재시도
      }
    }
    throw lastErr
  }

  /** 키·네트워크·모델 존재 확인. 실패 시 throw — 배치 시작 전에 호출한다. */
  async ping() {
    const res = await fetch(`${this.host}/v1beta/models/${this.model}`, {
      headers: this.#headers(),
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Gemini ping 실패: HTTP ${res.status} ${text.slice(0, 300)}`)
    }
    return res.json()
  }

  /**
   * 이미지 생성/편집. 레퍼런스가 있으면 인물 일관성 편집 모드로 동작한다.
   * @param {object} p
   * @param {string}   p.prompt       지시형 프롬프트 (Kontext용 프롬프트를 그대로 재사용)
   * @param {Buffer[]} p.references   레퍼런스 이미지 (0~14장)
   * @param {string}   p.aspectRatio  '16:9' | '3:4' | ... (출력 종횡비)
   * @param {string}   p.imageSize    '1K' | '2K' | '4K'
   * @param {string}   p.model        호출별 모델 오버라이드 (예: 포트레이트는 pro, 장면은 flash)
   * @returns {Promise<Buffer>} 생성된 이미지 (PNG/JPEG 바이너리)
   */
  async generateImage({ prompt, references = [], aspectRatio = '16:9', imageSize = '2K', model = this.model, signal }) {
    const body = {
      contents: [{ parts: [{ text: prompt }, ...references.map(imagePart)] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio, imageSize }
      }
    }
    // IMAGE_SAFETY(출력 이미지 안전 필터)는 비결정적이라 같은 요청을 한 번 다시 굴리면
    // 통과하는 경우가 잦다 — 그 경우에만 1회 재시도한다. 프롬프트 차단(candidate 없음)은
    // 결정적이므로 재시도하지 않는다.
    let lastErr = null
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await this.#post(`/v1beta/models/${model}:generateContent`, body, 'generateContent', signal)

      const candidate = out.candidates?.[0]
      if (!candidate) {
        const block = out.promptFeedback?.blockReason
        throw new Error(`Gemini 응답에 candidate 없음${block ? ` (차단: ${block})` : ''}: ${JSON.stringify(out).slice(0, 500)}`)
      }
      for (const part of candidate.content?.parts || []) {
        const inline = part.inlineData || part.inline_data
        if (inline?.data) return Buffer.from(inline.data, 'base64')
      }
      lastErr = new Error(
        `Gemini 응답에 이미지 없음 (finishReason: ${candidate.finishReason || '?'}): ${JSON.stringify(candidate.content || {}).slice(0, 500)}`
      )
      if (candidate.finishReason !== 'IMAGE_SAFETY') break
    }
    throw lastErr
  }

  /**
   * 이미지에 대한 텍스트 응답 (성별 감지 캡션용). textModel로 요청한다.
   * @returns {Promise<string>}
   */
  async describeImage({ image, prompt }) {
    const body = { contents: [{ parts: [{ text: prompt }, imagePart(image)] }] }
    const out = await this.#post(`/v1beta/models/${this.textModel}:generateContent`, body, 'describeImage')
    const texts = (out.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean)
    if (texts.length === 0) throw new Error(`Gemini describeImage 응답에 텍스트 없음: ${JSON.stringify(out).slice(0, 500)}`)
    return texts.join('\n')
  }

  /**
   * 텍스트만으로 텍스트 응답 (인생그래프 장면 합성용). textModel로 요청한다.
   * @param {object} p
   * @param {string} p.prompt
   * @param {string} [p.model]  기본 this.textModel
   * @param {AbortSignal} [p.signal]
   * @returns {Promise<string>}
   */
  async generateText({ prompt, model = this.textModel, signal }) {
    const body = { contents: [{ parts: [{ text: prompt }] }] }
    const out = await this.#post(`/v1beta/models/${model}:generateContent`, body, 'generateText', signal)
    const texts = (out.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean)
    if (texts.length === 0) throw new Error(`Gemini generateText 응답에 텍스트 없음: ${JSON.stringify(out).slice(0, 500)}`)
    return texts.join('\n')
  }
}
