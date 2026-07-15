// 주마등 상태 기계 (§6) — main 프로세스 단일 소유, 전이는 4창에 IPC 브로드캐스트(§7).
//
// 이 모듈이 소유하는 것:
//  - 상태(State)와 허용 전이(Transitions) 검증
//  - 유효 시간 모델 (재생/정지): 몽타주 프레임 = floor(유효시간 / frameDuration) % N.
//    4창이 같은 벽시계로 같은 프레임을 계산하므로 프레임 인덱스 브로드캐스트가 필요 없다.
//    FREEZE는 frozenEff를 고정 브로드캐스트 → 모든 창이 결정론적으로 같은 프레임에 멈춘다(§7 배리어 취지).
//  - FREEZE → REGEN_WAIT → IMMERSION 시퀀스: 사전 생성 클립 캐시 조회, 최소 대기(블러 의례), VIDEO 배리어, 폴백.
//    (전시 중 실시간 생성은 없다 — 모든 영상은 admin에서 미리 만든다. regenerate=캐시 경로 조회.)
//
// Electron 비의존: broadcast(channel, payload) 콜백으로만 바깥과 통신한다.
//
// 미결(§9): ENTRY·EXIT의 리프트 연출은 스텁 — 즉시 통과. 리프트 확정 시 여기서 대기를 넣는다.

import { State, Transitions } from '../shared/states.js'
import { Channels } from '../shared/channels.js'

export class ZoetropeStateMachine {
  /**
   * @param {object} p
   * @param {(channel: string, payload: object) => void} p.broadcast 렌더 클라이언트 송신
   * @param {Array<{id, absPath, scene}>} p.playlist  몽타주 재생 목록 (시간순)
   * @param {object} p.montage    montage.json (frameDurationMs, regen.minWaitMs 등)
   * @param {(image) => string|null} p.regenerate 사전 생성된 클립 경로 조회 (null = 캐시 없음 → 정지 이미지 폴백). 전시 중 생성은 없다.
   * @param {(absPath: string) => string} p.toMediaUrl 절대 경로 → renderer가 로드할 미디어 URL
   * @param {number} [p.projectorCount] VIDEO 배리어가 기다리는 준비 보고 수. Electron(4창)=4, 웹앱(1페이지 4타일)=1.
   */
  constructor({ broadcast, playlist, montage, regenerate, toMediaUrl, projectorCount = 4 }) {
    this.broadcast = broadcast
    this.playlist = playlist
    this.montage = montage
    this.regenerate = regenerate
    this.toMediaUrl = toMediaUrl
    this.projectorCount = projectorCount

    this.state = State.IDLE
    // 유효 시간 모델 (기존 index.js의 play 모델을 이관).
    this.playing = true
    this.playOffset = 0
    this.frozenEff = 0

    this.frozenImage = null //  FREEZE로 잡힌 재생 목록 항목
    this.regenSeq = 0 //        재생성 세대 — 늦게 도착한 결과가 다음 세션을 오염시키지 않게
    this.videoReadySet = new Set()
    this.videoBarrier = null // { resolve } — VIDEO_READY 4창 수집 중일 때
  }

  // ---- 조회 (bootstrap용: 늦게 뜬/리로드된 창이 현재 국면을 이어받는다) ----

  effSeconds(nowSec = Date.now() / 1000) {
    return this.playing ? nowSec - this.playOffset : this.frozenEff
  }

  frameIndexAt(effSec) {
    const n = this.playlist.length
    const dur = this.montage.frameDurationMs / 1000
    return ((Math.floor(effSec / dur) % n) + n) % n
  }

  snapshot() {
    return {
      state: this.state,
      play: { playing: this.playing, offset: this.playOffset, frozenEff: this.frozenEff },
      frozenImageId: this.frozenImage?.id ?? null
    }
  }

  // ---- 전이 ----

  transition(to, meta = {}) {
    const allowed = Transitions[this.state] ?? []
    if (!allowed.includes(to)) {
      console.warn(`[sm] 전이 거부: ${this.state} → ${to}`)
      return false
    }
    const prev = this.state
    this.state = to
    console.log(`[sm] ${prev} → ${to}`, Object.keys(meta).length ? meta : '')
    this.broadcast(Channels.STATE, { state: to, prev, ...meta })
    return true
  }

  broadcastPlay() {
    this.broadcast(Channels.PLAY_STATE, {
      playing: this.playing,
      offset: this.playOffset,
      frozenEff: this.frozenEff
    })
  }

  // ---- 입력 (Enter 하나가 상태별로 다른 의미 — §8의 멈춤/진입·재개 버튼) ----

  handleEnter() {
    if (this.state === State.IDLE) this.#enter()
    else if (this.state === State.ZOETROPE) this.#freeze()
    else if (this.state === State.IMMERSION) this.#resume()
    // FREEZE·REGEN_WAIT 중에는 무시 — 기다림이 의례다(§5.2).
  }

  // 개발용 Space: ZOETROPE 시간 정지/재개 (상태 전이 없음).
  togglePlay() {
    const nowSec = Date.now() / 1000
    if (this.playing) {
      this.frozenEff = nowSec - this.playOffset
      this.playing = false
    } else {
      this.playOffset = nowSec - this.frozenEff
      this.playing = true
    }
    console.log('[sm] playing =', this.playing)
    this.broadcastPlay()
  }

  // ---- 시퀀스 ----

  #enter() {
    // §9 미결: 리프트 상승 연출은 스텁. ENTRY를 거쳐 즉시 ZOETROPE.
    this.transition(State.ENTRY)
    this.playing = true
    this.playOffset = Date.now() / 1000 // 몽타주를 처음부터 (frame 0).
    this.broadcastPlay()
    this.transition(State.ZOETROPE)
  }

  #freeze() {
    // 시계를 지금 순간에 고정 → 4창 모두 같은 유효시간, 같은 프레임 (§7 FREEZE 동기).
    const nowSec = Date.now() / 1000
    this.frozenEff = nowSec - this.playOffset
    this.playing = false
    this.broadcastPlay()

    const frameIndex = this.frameIndexAt(this.frozenEff)
    this.frozenImage = this.playlist[frameIndex]
    this.transition(State.FREEZE, { imageId: this.frozenImage.id, frameIndex })

    // FREEZE는 포착의 순간 — 즉시 재생성 대기로.
    this.transition(State.REGEN_WAIT, { imageId: this.frozenImage.id })
    this.#runRegen(this.frozenImage)
  }

  async #runRegen(image) {
    const seq = ++this.regenSeq
    const t0 = Date.now()
    let videoPath = null
    try {
      videoPath = await this.regenerate(image)
    } catch (err) {
      console.error('[sm] 영상화 실패 (폴백으로 진행):', err.message)
    }
    if (seq !== this.regenSeq || this.state !== State.REGEN_WAIT) return // 세션이 지나갔다.

    // 의례의 최소 대기: 캐시 적중으로 즉시 끝나도 흐림의 시간은 유지한다.
    const minWait = this.montage.regen.minWaitMs ?? 0
    const elapsed = Date.now() - t0
    if (elapsed < minWait) await new Promise((r) => setTimeout(r, minWait - elapsed))
    if (seq !== this.regenSeq || this.state !== State.REGEN_WAIT) return

    if (!videoPath) {
      // 폴백: 영상 없이 정지 이미지 그대로 선명화. 실패는 사용자에게 보이지 않는다.
      this.transition(State.IMMERSION, { video: false, imageId: image.id })
      return
    }

    const committed = await this.#videoBarrier(videoPath, image.id)
    if (seq !== this.regenSeq || this.state !== State.REGEN_WAIT) return
    this.transition(State.IMMERSION, { video: committed, imageId: image.id })
  }

  /**
   * VIDEO 배리어(§7): 4창 프리로드 완료를 기다려 벽시계 기준으로 동시 재생 시작.
   * @returns {Promise<boolean>} true = 커밋됨, false = 타임아웃(폴백)
   */
  #videoBarrier(videoPath, imageId) {
    this.videoReadySet.clear()
    this.broadcast(Channels.VIDEO_PREPARE, { url: this.toMediaUrl(videoPath), imageId })

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn(
          `[sm] VIDEO_READY 타임아웃 (${this.videoReadySet.size}/${this.projectorCount}) — 폴백`
        )
        this.videoBarrier = null
        resolve(false)
      }, this.montage.regen.readyTimeoutMs ?? 15000)

      this.videoBarrier = {
        onReady: () => {
          if (this.videoReadySet.size < this.projectorCount) return
          clearTimeout(timeout)
          this.videoBarrier = null
          // 250ms 뒤 벽시계 시각에 동시 시작 — IPC 전파 지연을 흡수한다.
          this.broadcast(Channels.VIDEO_COMMIT, { startAtMs: Date.now() + 250 })
          resolve(true)
        }
      }
    })
  }

  onVideoReady(projectorIndex) {
    this.videoReadySet.add(projectorIndex)
    this.videoBarrier?.onReady()
  }

  #resume() {
    // 멈췄던 지점부터 몽타주 재개 (유효 시간 이어감).
    this.frozenImage = null
    this.regenSeq++ // 혹시 남은 재생성 콜백 무효화
    this.playOffset = Date.now() / 1000 - this.frozenEff
    this.playing = true
    this.broadcastPlay()
    this.transition(State.ZOETROPE)
  }
}
