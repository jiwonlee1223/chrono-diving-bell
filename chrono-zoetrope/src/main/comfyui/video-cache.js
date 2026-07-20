// 영상 생성 + 로컬 캐시. 두 백엔드를 지원한다 (montage.json regen.mode):
//   seedance-flf : Seedance FLF 전이 — 장면[i]→장면[i+1] "기억이 기억으로 녹아드는" 영상.
//                  캐시 videos/<장면[i].id>.mp4 (시작 장면 id로). 릴이 이걸 이어붙인다.
//   wan          : Wan2.2 I2V — 한 장면이 미세하게 숨쉬는 영상. 캐시 videos/<id>.mp4.
//   mock         : 서버 없이 개발. 딜레이 후 null(폴백 경로).
//
// 캐시 규칙(공통): <personaDir>/videos/<id>.mp4. 있으면 즉시 반환.
//   → 전시 런타임 FREEZE는 cachedPath(장면id)만 쓴다: seedance-flf에선 그 장면에서 "다음으로
//     흐르는 전이"가 재생된다(마지막 장면은 전이 없음 → 정지 이미지 폴백). 코드 변경 없이 동작.
//
// Electron 비의존 순수 Node 모듈.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ComfyUIClient } from './client.js'
import {
  buildWan22I2VWorkflow,
  buildSeedanceFLFWorkflow,
  composeSeedanceLoopPrompt,
  composeWanMotionPrompt
} from './workflows.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class VideoRegenerator {
  /**
   * @param {object} p
   * @param {string} p.host        ComfyUI 서버
   * @param {object} p.regen       montage.json의 regen 섹션
   * @param {string} p.personaDir  현재 페르소나 라이브러리 절대 경로
   * @param {string} [p.apiKey]    comfy.org 키 — seedance-flf 생성에 필요(런타임 cachedPath 전용이면 불필요)
   */
  constructor({ host, regen, personaDir, apiKey = null }) {
    this.regen = regen
    this.mode = regen.mode
    this.personaDir = personaDir
    this.videosDir = join(personaDir, 'videos')
    // wan·seedance-flf 둘 다 ComfyUI 클라이언트를 쓴다(seedance는 API 노드라 apiKey 필요). mock은 없음.
    this.client =
      this.mode === 'mock'
        ? null
        : new ComfyUIClient({ host, timeoutMs: regen.timeoutMs, apiKey })
  }

  /** 캐시 조회만 (생성 없이). 있으면 절대 경로. */
  cachedPath(id) {
    const p = join(this.videosDir, `${id}.mp4`)
    return existsSync(p) ? p : null
  }

  async #save(id, data) {
    await mkdir(this.videosDir, { recursive: true })
    const outPath = join(this.videosDir, `${id}.mp4`)
    await writeFile(outPath, data)
    return outPath
  }

  /**
   * 한 장면을 영상화. seedance = 10초 seamless 루프(FLF 동일프레임), wan = Wan2.2 I2V.
   * 실패·mock이면 null. 캐시 videos/<id>.mp4 (전시 FREEZE·릴이 공유).
   * @param {{ id, absPath, scene, age? }} image
   */
  async regenerate(image, { onProgress } = {}) {
    const cached = this.cachedPath(image.id)
    if (cached) {
      console.log(`[regen] 캐시 적중: ${image.id}`)
      return cached
    }
    if (this.mode === 'mock') {
      await sleep(this.regen.mockDelayMs)
      return null
    }
    if (this.mode === 'seedance') return this.#seedanceLoop(image, { onProgress })

    const v = this.regen.wan.video
    const t0 = Date.now()
    console.log(`[regen] Wan2.2 I2V: ${image.id} (${v.width}x${v.height}, ${v.length}f)`)
    const uploaded = await this.client.uploadImage(await readFile(image.absPath), `freeze-${basename(image.absPath)}`)
    // 고정 불변부(promptPrefix) + ' Scene: {scene}.' + 씬 컨텍스트에 맞는 주변 모션 구절.
    const prompt = composeWanMotionPrompt(image, { promptPrefix: this.regen.wan.promptPrefix })
    const workflow = buildWan22I2VWorkflow({
      prompt,
      startImage: uploaded.name,
      width: v.width,
      height: v.height,
      length: v.length,
      fps: v.fps,
      steps: v.steps,
      boundaryStep: Math.floor(v.steps / 2),
      shift: v.shift,
      filenamePrefix: `chrono-zoetrope/regen/${image.id}`
    })
    const { videos } = await this.client.generateVideo(workflow, { onProgress })
    const outPath = await this.#save(image.id, videos[0].data)
    console.log(`[regen] 완료: ${outPath} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    return outPath
  }

  /** [seedance] 장면 하나 → 10초 seamless 루프. FLF의 first=last=같은 이미지로 끝이 시작과 이어진다. */
  async #seedanceLoop(image, { onProgress } = {}) {
    const sd = this.regen.seedance
    const t0 = Date.now()
    console.log(`[regen] Seedance 루프: ${image.id} (${sd.resolution}, ${sd.durationSec ?? 10}s)`)
    const up = await this.client.uploadImage(await readFile(image.absPath), `loop-${image.id}.png`)
    const workflow = buildSeedanceFLFWorkflow({
      prompt: composeSeedanceLoopPrompt(image),
      firstImage: up.name,
      lastImage: up.name, // 동일 프레임 → seamless 루프
      durationSec: sd.durationSec ?? 10,
      model: sd.model,
      resolution: sd.resolution,
      filenamePrefix: `chrono-zoetrope/loop/${image.id}`
    })
    const { videos } = await this.client.generateVideo(workflow, { onProgress })
    const outPath = await this.#save(image.id, videos[0].data)
    console.log(`[regen] 루프 완료: ${outPath} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    return outPath
  }

  close() {
    this.client?.close()
  }
}
