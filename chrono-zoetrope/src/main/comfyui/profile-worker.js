// 제출된 프로필 하나를 생애 라이브러리로 생성하는 공유 워커 로직.
// generate-from-firestore.mjs(CLI 워커)와 admin-server.mjs(자동 큐)가 함께 쓴다.
//
// 흐름: claimProfile(원자적 submitted→generating) → 레퍼런스 사진 다운로드
//       → generateLifeLibrary(ComfyUI 전체 생성) → status done|error 마감.
//
// 예외를 던지지 않고 결과 객체로 반환한다 — 호출부(직렬 큐 루프)를 단순하게 유지하기 위함.

import path from 'node:path'
import { generateLifeLibrary } from './life-library.js'
import {
  claimProfile,
  downloadPhotos,
  toGeneratorProfile,
  setProfileStatus
} from './firestore-source.js'

const noop = () => {}

/**
 * 프로필 한 건 처리.
 * @param {object} profile  Firestore 문서 ({ id, name, photoURLs, ... })
 * @param {object} opts
 * @param {object} opts.config              comfyui.json 설정
 * @param {string} opts.outDir              라이브러리 출력 루트 (절대경로)
 * @param {boolean} [opts.includeErrors]    error 상태도 재시도 대상에 포함
 * @param {(msg:string)=>void} [opts.log]
 * @param {(e:object)=>void} [opts.onProgress]  generateLifeLibrary 진행 이벤트 패스스루
 * @returns {Promise<{claimed:boolean, ok:boolean, imageCount?:number, elapsedMs?:number, error?:string}>}
 */
export async function processProfile(
  profile,
  { config, outDir, includeErrors = false, log = noop, onProgress = noop } = {}
) {
  const pid = profile.id
  const label = `${profile.name || '?'} (${pid})`

  const claimed = await claimProfile(pid, { includeErrors })
  if (!claimed) {
    log(`건너뜀 (이미 처리 중/완료): ${label}`)
    return { claimed: false, ok: false }
  }
  log(`▶ 생성 시작: ${label}`)

  try {
    // 1) 레퍼런스 사진을 로컬로 내려받기
    const inputDir = path.join(outDir, pid, '_input')
    const photoPaths = await downloadPhotos(profile, inputDir)
    log(`  사진 ${photoPaths.length}장 다운로드`)

    // 2) 생애 라이브러리 생성 (10단계 × perStage)
    const genProfile = toGeneratorProfile(profile, photoPaths)
    const t0 = Date.now()
    const result = await generateLifeLibrary(genProfile, {
      host: config.host,
      outDir,
      workflow: config.workflow,
      perStage: config.perStage,
      image: config.image,
      timeoutMs: config.timeoutMs,
      gemini: config.gemini, // 호출자가 resolveGeminiConfig로 apiKeyPath를 절대경로화해서 넘긴다
      onProgress
    })
    const elapsedMs = Date.now() - t0
    const imageCount = result.manifest.images.length

    // 3) 완료 기록. 검토(admin)는 별개 — 여기서는 생성 완료까지만 책임진다.
    // 자동 감지된 성별도 역기록해, 이후 재생성 시 재감지 없이 프로필 값을 쓰게 한다.
    const detectedGender = result.manifest?.profile?.gender
    await setProfileStatus(pid, 'done', {
      libraryDir: `library/${pid}`,
      imageCount,
      generatedAt: new Date().toISOString(),
      ...(detectedGender ? { gender: detectedGender } : {})
    })
    log(`✓ 완료: ${label} — ${imageCount}장 (${(elapsedMs / 1000).toFixed(1)}s)`)
    return { claimed: true, ok: true, imageCount, elapsedMs }
  } catch (err) {
    log(`✗ 실패: ${label} — ${err.message}`)
    await setProfileStatus(pid, 'error', { error: String(err.message || err) }).catch(() => {})
    return { claimed: true, ok: false, error: String(err.message || err) }
  }
}
