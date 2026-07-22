// ComfyUI 직접 HTTP/WS 클라이언트 (§5.3 — MCP 아님, 결정론적 파이프라인).
//
//   /prompt (POST)        워크플로우 큐잉 → prompt_id
//   /ws?clientId=         실행 진행률·완료 이벤트 (없으면 폴링만으로 동작)
//   /history/{prompt_id}  출력 노드 결과 조회
//   /view                 이미지 파일 로드
//   /upload/image         레퍼런스 이미지 업로드 (multipart)
//
// Electron main과 CLI 양쪽에서 쓰도록 순수 Node 모듈로 유지한다(electron import 금지).

import { randomUUID } from 'node:crypto'

const POLL_INTERVAL_MS = 2500

export class ComfyUIClient {
  /** apiKey: comfy.org API 키 — Seedance 등 API 노드(외부 클라우드 브로커링·과금) 실행에 필요. 로컬 노드만 쓰면 불필요. */
  constructor({ host, timeoutMs = 300000, maxWaitMs = 1800000, apiKey = null } = {}) {
    if (!host) throw new Error('ComfyUIClient: host가 필요하다 (예: http://143.248.107.38:8188)')
    this.host = host.replace(/\/+$/, '')
    this.clientId = randomUUID()
    this.apiKey = apiKey
    // timeoutMs: 진행 신호(WS progress / 큐 잔존)가 이만큼 없으면 실패 = "무진행(idle) 타임아웃".
    //   제출~완료 총시간이 아니라 '멈춤'을 재는 값이라, 공용 ComfyUI 큐에서 오래 대기해도 실패하지 않는다.
    // maxWaitMs: 큐가 얼어붙어 영원히 pending인 경우를 막는 절대 상한(안전판). idle보다 작을 순 없다.
    this.timeoutMs = timeoutMs
    this.maxWaitMs = Math.max(maxWaitMs, timeoutMs)
    this.ws = null
    this.wsListeners = new Set() // (msg) => void — 파싱된 JSON 메시지 구독자
  }

  async #json(res, what) {
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`ComfyUI ${what} 실패: HTTP ${res.status} ${body.slice(0, 500)}`)
    }
    return res.json()
  }

  /** 서버 생존 확인. 실패 시 throw. */
  async ping() {
    const res = await fetch(`${this.host}/system_stats`)
    return this.#json(res, 'system_stats')
  }

  /**
   * 레퍼런스 이미지 업로드. ComfyUI 표준 /upload/image 사용
   * (RoF 가이드의 :8185 커스텀 업로드 서버는 그 프로젝트 고유 구성이라 쓰지 않는다).
   * @returns {{ name: string, subfolder: string, type: string }} LoadImage에 넣을 경로 정보
   */
  async uploadImage(buffer, filename, { subfolder = '', overwrite = true } = {}) {
    const form = new FormData()
    form.append('image', new Blob([buffer]), filename)
    form.append('overwrite', overwrite ? 'true' : 'false')
    if (subfolder) form.append('subfolder', subfolder)
    const res = await fetch(`${this.host}/upload/image`, { method: 'POST', body: form })
    const out = await this.#json(res, 'upload/image')
    return { name: out.name, subfolder: out.subfolder || '', type: out.type || 'input' }
  }

  /** 워크플로우 큐잉 → prompt_id. 노드 검증 실패 시 서버 에러 본문을 그대로 노출한다. */
  async queuePrompt(workflow) {
    const res = await fetch(`${this.host}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: workflow,
        client_id: this.clientId,
        // API 노드(ByteDance Seedance 등)는 comfy.org 계정으로 브로커링·과금된다.
        ...(this.apiKey ? { extra_data: { api_key_comfy_org: this.apiKey } } : {})
      })
    })
    const out = await this.#json(res, 'prompt')
    if (!out.prompt_id)
      throw new Error(`ComfyUI /prompt 응답에 prompt_id 없음: ${JSON.stringify(out).slice(0, 500)}`)
    return out.prompt_id
  }

  async getHistory(promptId) {
    const res = await fetch(`${this.host}/history/${promptId}`)
    const out = await this.#json(res, `history/${promptId}`)
    return out[promptId] || null
  }

  /**
   * 현재 큐 상태 → { running: [promptId…], pending: [promptId…] }.
   * ComfyUI /queue 응답의 각 항목은 [번호, prompt_id, prompt, extra, outputs] 배열이라 index 1이 prompt_id.
   * waitForPrompt가 "내 prompt가 아직 큐에 살아있는가"로 유휴 타임아웃을 리셋하는 데 쓴다(큐 대기≠실패).
   */
  async getQueue() {
    const res = await fetch(`${this.host}/queue`)
    const out = await this.#json(res, 'queue')
    const ids = (arr) => (Array.isArray(arr) ? arr.map((e) => e?.[1]).filter(Boolean) : [])
    return { running: ids(out.queue_running), pending: ids(out.queue_pending) }
  }

  /** /view에서 출력 이미지 바이너리 로드. */
  async fetchImage({ filename, subfolder = '', type = 'output' }) {
    const q = new URLSearchParams({ filename, subfolder, type })
    const res = await fetch(`${this.host}/view?${q}`)
    if (!res.ok) throw new Error(`ComfyUI /view 실패: HTTP ${res.status} (${filename})`)
    return Buffer.from(await res.arrayBuffer())
  }

  /** WS 연결(지연 생성). 실패해도 폴링 경로가 있으므로 조용히 넘어간다. */
  #ensureWS() {
    if (this.ws || typeof WebSocket === 'undefined') return
    try {
      const wsUrl = this.host.replace(/^http/, 'ws') + `/ws?clientId=${this.clientId}`
      this.ws = new WebSocket(wsUrl)
      this.ws.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string') return // 바이너리 프레임(미리보기)은 무시
        let msg
        try {
          msg = JSON.parse(ev.data)
        } catch {
          return
        }
        for (const fn of this.wsListeners) fn(msg)
      })
      this.ws.addEventListener('error', () => {}) // 폴링 폴백이 있으므로 무시
    } catch {
      this.ws = null
    }
  }

  /**
   * prompt 완료 대기. WS 이벤트로 조기 감지하고, /history 폴링을 안전판으로 병행한다
   * (RoF 가이드 §8의 이중 경로와 같은 취지 — 단 파일 감시 대신 폴링).
   * @param {string} promptId
   * @param {{ onProgress?: (p: {phase:string, node?:string, value?:number, max?:number}) => void }} opts
   * @returns history 항목 (outputs 포함)
   */
  async waitForPrompt(promptId, { onProgress } = {}) {
    this.#ensureWS()
    // 유휴(idle) 타임아웃 모델: "제출 후 총시간"이 아니라 "진행 신호가 없는 시간"을 잰다.
    //  - WS progress/executing 이벤트(실행 중) 또는 /queue에 내 prompt가 살아있으면(대기/실행) → 활동으로 보고 리셋.
    //  - 따라서 공용 ComfyUI 큐에서 다른 작업 뒤에 오래 줄 서 있어도 실패하지 않는다(큐 대기 ≠ 실패).
    //  - hardDeadline: 큐가 얼어붙어 영원히 pending인 경우를 막는 절대 상한(안전판).
    const idleMs = this.timeoutMs
    const hardDeadline = Date.now() + this.maxWaitMs
    let lastActivity = Date.now()
    const bump = () => {
      lastActivity = Date.now()
    }

    return new Promise((resolve, reject) => {
      let settled = false
      let pollTimer = null

      const cleanup = () => {
        settled = true
        this.wsListeners.delete(onWsMessage)
        if (pollTimer) clearTimeout(pollTimer)
      }
      const succeed = (hist) => {
        if (!settled) {
          cleanup()
          resolve(hist)
        }
      }
      const fail = (err) => {
        if (!settled) {
          cleanup()
          reject(err)
        }
      }

      const checkHistory = async () => {
        try {
          const hist = await this.getHistory(promptId)
          if (hist && hist.outputs && Object.keys(hist.outputs).length > 0) return succeed(hist)
          if (hist?.status?.status_str === 'error') {
            return fail(
              new Error(`ComfyUI 실행 에러: ${JSON.stringify(hist.status).slice(0, 500)}`)
            )
          }
        } catch {
          // 일시적 네트워크 오류는 다음 폴링에서 재시도
        }
        // 아직 완료 전 — 내 prompt가 큐에 살아있으면(대기/실행) 진행 중으로 보고 유휴 타이머를 리셋한다.
        try {
          const q = await this.getQueue()
          if (q.running.includes(promptId) || q.pending.includes(promptId)) bump()
        } catch {
          // /queue 조회 실패 → 이번 리셋은 생략(WS 이벤트·다음 폴링이 커버)
        }
        const now = Date.now()
        if (now > hardDeadline)
          return fail(new Error(`ComfyUI 절대 대기 상한 초과 (${this.maxWaitMs}ms): ${promptId}`))
        if (now - lastActivity > idleMs)
          return fail(
            new Error(`ComfyUI 무진행 시간 초과 (${idleMs}ms — 큐·실행 신호 없음): ${promptId}`)
          )
        if (!settled) pollTimer = setTimeout(checkHistory, POLL_INTERVAL_MS)
      }

      const onWsMessage = (msg) => {
        const pid = msg.prompt_id || msg.data?.prompt_id
        if (pid && pid !== promptId) return
        if (msg.type === 'progress') {
          bump() // 실행 진행 중 — 유휴 타이머 리셋
          if (onProgress)
            onProgress({ phase: 'sampling', value: msg.data?.value, max: msg.data?.max })
        } else if (msg.type === 'executing' && msg.data?.node) {
          bump()
          if (onProgress) onProgress({ phase: 'node', node: msg.data.node })
        } else if (msg.type === 'execution_error') {
          fail(new Error(`ComfyUI 실행 에러: ${JSON.stringify(msg.data).slice(0, 800)}`))
        } else if (
          msg.type === 'execution_success' ||
          (msg.type === 'executing' && msg.data?.node === null)
        ) {
          checkHistory() // 완료 신호 → 즉시 history 조회 (폴링 주기를 기다리지 않음)
        }
      }

      this.wsListeners.add(onWsMessage)
      checkHistory()
    })
  }

  /**
   * 원샷 헬퍼: 큐잉 → 완료 대기 → 출력 이미지 다운로드.
   * @returns {{ promptId: string, images: Array<{filename, subfolder, type, data: Buffer}> }}
   */
  async generate(workflow, { onProgress } = {}) {
    const promptId = await this.queuePrompt(workflow)
    const hist = await this.waitForPrompt(promptId, { onProgress })
    const images = []
    for (const nodeOutput of Object.values(hist.outputs)) {
      for (const file of nodeOutput.images || []) {
        if (file.type !== 'output') continue // 중간 미리보기(temp) 제외
        const data = await this.fetchImage(file)
        images.push({ ...file, data })
      }
    }
    if (images.length === 0) {
      throw new Error(
        `ComfyUI 출력에 이미지가 없음: ${promptId} outputs=${JSON.stringify(Object.keys(hist.outputs))}`
      )
    }
    return { promptId, images }
  }

  /**
   * 원샷 헬퍼: 큐잉 → 완료 대기 → 출력 영상 다운로드 (Wan I2V 등).
   * SaveVideo·VHS 계열이 history outputs에 쓰는 키가 제각각(images/gifs/videos)이라,
   * 모든 출력 배열을 훑어 영상 확장자 파일을 회수한다.
   * @returns {{ promptId: string, videos: Array<{filename, subfolder, type, data: Buffer}> }}
   */
  async generateVideo(workflow, { onProgress } = {}) {
    const promptId = await this.queuePrompt(workflow)
    const hist = await this.waitForPrompt(promptId, { onProgress })
    const videos = []
    for (const nodeOutput of Object.values(hist.outputs)) {
      for (const arr of Object.values(nodeOutput)) {
        if (!Array.isArray(arr)) continue
        for (const file of arr) {
          if (!file || typeof file.filename !== 'string') continue
          if (!/\.(mp4|webm|mov|mkv)$/i.test(file.filename)) continue
          if (file.type && file.type !== 'output') continue
          const data = await this.fetchImage(file) // /view는 파일 종류 무관
          videos.push({ ...file, data })
        }
      }
    }
    if (videos.length === 0) {
      throw new Error(
        `ComfyUI 출력에 영상이 없음: ${promptId} outputs=${JSON.stringify(hist.outputs).slice(0, 800)}`
      )
    }
    return { promptId, videos }
  }

  /**
   * 원샷 헬퍼: 큐잉 → 완료 대기 → 텍스트 출력 수집 (ShowText 등 output 노드의 text).
   * @returns {{ promptId: string, text: string }}
   */
  async generateText(workflow, { onProgress } = {}) {
    const promptId = await this.queuePrompt(workflow)
    const hist = await this.waitForPrompt(promptId, { onProgress })
    const texts = []
    for (const nodeOutput of Object.values(hist.outputs)) {
      for (const t of nodeOutput.text || []) if (t) texts.push(String(t))
    }
    if (texts.length === 0) {
      throw new Error(
        `ComfyUI 출력에 텍스트가 없음: ${promptId} outputs=${JSON.stringify(Object.keys(hist.outputs))}`
      )
    }
    return { promptId, text: texts.join('\n') }
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* noop */
      }
      this.ws = null
    }
  }
}
