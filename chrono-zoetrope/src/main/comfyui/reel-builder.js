// 주마등 릴 빌더 — 생애 라이브러리 전 장면을 Wan 클립으로 만들고, ffmpeg 크로스페이드로
// 이어붙여 ~targetSec 단일 영상(죽기 직전 스쳐 가는 기억)으로 합성한다.
//
//  1) ensureClips: 각 장면 이미지를 VideoRegenerator로 영상화 → videos/<id>.mp4 캐시.
//     이 캐시는 전시 런타임의 FREEZE 재생성과 공유된다(멈춤 시 캐시 적중 → Wan 대기 단축).
//  2) concat: 장면 순서(출생→죽음)대로 xfade 체인. 오디오 없음(§1 침묵).
//
// 총길이 맞추기: 장면당 표시 길이 d = (target + (N-1)·c)/N.
//   d < 클립원본 → 트림, d > 원본 → 슬로모션(maxStretch 상한, 넘으면 릴이 target보다 짧아짐).
//
// ffmpeg/ffprobe 필요. Electron 비의존 순수 Node.

import { spawn } from 'node:child_process'

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args)
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('error', (e) =>
      reject(new Error(e.code === 'ENOENT' ? `${cmd} 실행 불가 — 설치 필요` : e.message))
    )
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}: ${err.slice(-500)}`))
    )
  })
}

function ffprobeDuration(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file
    ])
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'ffprobe 설치 필요' : e.message)))
    p.on('close', (c) => (c === 0 ? resolve(parseFloat(out.trim())) : reject(new Error(err))))
  })
}

export class ReelBuilder {
  /**
   * @param {object} p
   * @param {import('./video-cache.js').VideoRegenerator} p.regenerator 클립 생성기(캐시 공유)
   * @param {object} p.reel  montage.json의 reel 섹션
   * @param {(msg:string)=>void} [p.log]
   */
  constructor({ regenerator, reel, log = () => {} }) {
    this.regenerator = regenerator
    this.reel = reel
    this.log = log
  }

  /** 전 장면 클립 보장(캐시 적중은 건너뜀). @returns {Promise<(string|null)[]>} 순서 유지, 실패는 null
   *  shouldCancel(): 중지 버튼 — 클립 사이에서 확인. true면 CancelError로 중단(만든 클립은 캐시에 남아 재개 가능). */
  async ensureClips(images, { onProgress = () => {}, shouldCancel = () => false } = {}) {
    const clips = []
    for (let i = 0; i < images.length; i++) {
      if (shouldCancel()) {
        const e = new Error('릴 빌드 중지됨')
        e.cancelled = true
        throw e
      }
      const img = images[i]
      onProgress({ phase: 'clip', done: i, total: images.length, id: img.id })
      try {
        clips.push(await this.regenerator.regenerate(img))
      } catch (err) {
        this.log(`  클립 실패 ${img.id}: ${err.message}`)
        clips.push(null)
      }
    }
    onProgress({ phase: 'clip', done: images.length, total: images.length })
    return clips
  }

  /** 클립들을 크로스페이드로 이어붙여 outPath(mp4)로 합성. @returns {Promise<{file,durationSec,clipCount}>} */
  async concat(clipPaths, outPath, { onProgress = () => {} } = {}) {
    const clips = clipPaths.filter(Boolean)
    if (clips.length === 0) throw new Error('이어붙일 클립이 없음 (전 장면 클립 생성 실패)')
    onProgress({ phase: 'concat', clipCount: clips.length })

    const target = this.reel.targetSec ?? 90
    const maxStretch = this.reel.maxStretch ?? 1.25
    const transition = this.reel.transition ?? 'fade'
    const N = clips.length
    const rawLen = await ffprobeDuration(clips[0]) // 클립 길이 균일 가정(같은 Wan 설정)

    let c = this.reel.crossfadeSec ?? 1.2
    let d = (target + (N - 1) * c) / N // 목표 총길이를 맞추는 장면당 표시 길이
    let speed = 1 // setpts 배율 (>1 = 슬로모션)
    if (d > rawLen) {
      speed = Math.min(d / rawLen, maxStretch)
      d = rawLen * speed // 상한이면 릴이 target보다 짧아짐(허용)
    }
    c = Math.min(c, d * 0.45) // 크로스페이드는 장면 길이보다 짧아야 함

    // 각 입력을 균일 규격(16fps·yuv420p·SAR1)으로 정규화 후 d초로 트림.
    const norm = (i) =>
      `[${i}:v]setpts=${speed.toFixed(4)}*PTS,fps=16,format=yuv420p,setsar=1,settb=AVTB,` +
      `trim=0:${d.toFixed(4)},setpts=PTS-STARTPTS[v${i}]`

    const parts = clips.map((_, i) => norm(i))
    let mapLabel
    if (N === 1) {
      mapLabel = 'v0'
    } else {
      let prev = 'v0'
      for (let k = 1; k < N; k++) {
        const out = k === N - 1 ? 'reel' : `x${k}`
        const offset = (k * (d - c)).toFixed(4)
        parts.push(
          `[${prev}][v${k}]xfade=transition=${transition}:duration=${c.toFixed(4)}:offset=${offset}[${out}]`
        )
        prev = out
      }
      mapLabel = 'reel'
    }

    const inputs = clips.flatMap((f) => ['-i', f])
    const args = [
      '-y',
      ...inputs,
      '-filter_complex', parts.join(';'),
      '-map', `[${mapLabel}]`,
      '-r', '16',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', // moov 앞으로 → 브라우저 점진 재생/시킹
      '-an',
      outPath
    ]
    await run('ffmpeg', args)
    const durationSec = await ffprobeDuration(outPath)
    onProgress({ phase: 'done', durationSec, clipCount: N })
    return { file: outPath, durationSec, clipCount: N }
  }

  // ── seedance 모드: 장면별 10초 루프 → 이어붙여 fast-forward 릴 ──────────────────

  /** 장면별 루프를 순서대로 이어붙이고, 총길이가 targetSec을 넘으면 균일 fast-forward(setpts)로 맞춘다.
   *  개별 트림 대신 전체 배속이라 각 루프의 seamless가 유지되고 "빠르게 스쳐가는" 주마등 느낌이 산다.
   *  (예: 30장 × 10초 = 300초 → target 90초면 ×3.33 배속) */
  async concatSimple(clipPaths, outPath, { onProgress = () => {} } = {}) {
    const clips = clipPaths.filter(Boolean)
    if (clips.length === 0) throw new Error('이어붙일 영상이 없음 (루프 생성 실패)')
    onProgress({ phase: 'concat', clipCount: clips.length })

    const target = this.reel.targetSec ?? 90
    const rawLen = await ffprobeDuration(clips[0]) // 전이 길이 균일 가정
    const total = clips.length * rawLen
    const speed = Math.max(1, total / target) // >1 = 빨라짐 (target 초과분만 배속, 부족하면 그대로)

    const inputs = clips.flatMap((f) => ['-i', f])
    const setpts = speed > 1 ? `setpts=PTS/${speed.toFixed(4)},` : ''
    const norm = clips.map((_, i) => `[${i}:v]${setpts}fps=24,format=yuv420p,setsar=1,settb=AVTB[v${i}]`)
    const chain = clips.map((_, i) => `[v${i}]`).join('') + `concat=n=${clips.length}:v=1:a=0[out]`
    await run('ffmpeg', [
      '-y', ...inputs,
      '-filter_complex', [...norm, chain].join(';'),
      '-map', '[out]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-an',
      outPath
    ])
    const durationSec = await ffprobeDuration(outPath)
    onProgress({ phase: 'done', durationSec, clipCount: clips.length })
    return { file: outPath, durationSec, clipCount: clips.length }
  }
}
