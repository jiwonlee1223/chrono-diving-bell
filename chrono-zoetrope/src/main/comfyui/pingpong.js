// pingpong 클립 변환 — 유령 과거 회귀 대화가 재생하는 "그때의 기억" 영상용.
//
// Wan 클립(videos/<id>.mp4)은 plain loop 시 경계에서 모션이 점프한다. 과거 회귀 뷰는
// 정방향→역방향을 이어 붙인 pingpong(<id>.pp.mp4)을 loop 재생해 경계 없이 숨 쉬듯 왕복한다.
// ffmpeg reverse는 전 프레임을 메모리에 올리므로 짧은 클립(~10초·1920×480) 전제 — 릴/클립과
// 같은 규격이라 안전하다.
//
// best-effort 설계: ffmpeg가 없거나 변환이 실패해도 호출측(server pastCatalog)은 원본을
// plain loop로 폴백한다. reel-builder.js와 같은 spawn 패턴, Electron 비의존 순수 Node.

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'

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

const fileExists = (p) =>
  fs.access(p).then(
    () => true,
    () => false
  )

/** videos/<id>.mp4 → videos/<id>.pp.mp4 경로 유도(존재 여부와 무관한 순수 계산). */
export function pingpongPathFor(srcPath) {
  return srcPath.replace(/\.mp4$/i, '.pp.mp4')
}

/**
 * srcPath의 pingpong 변환본을 보장한다. 이미 있으면 그대로 반환(캐시), 없으면 ffmpeg로 생성.
 * 역방향 구간의 첫/끝 프레임이 정방향과 겹쳐 이중 정지가 생기지 않게 reverse 쪽 첫 프레임을
 * trim으로 한 장 덜어낸다(trim=start_frame=1).
 * @param {string} srcPath  원본 클립 절대경로
 * @returns {Promise<string>} pingpong 파일 절대경로 (실패 시 throw — 호출측이 원본 폴백)
 */
export async function ensurePingpongClip(srcPath) {
  const outPath = pingpongPathFor(srcPath)
  if (await fileExists(outPath)) return outPath
  if (!(await fileExists(srcPath))) throw new Error(`원본 클립 없음: ${srcPath}`)
  // 반쯤 쓰다 만 파일이 캐시로 오인되지 않게 임시 이름으로 만들고 완성 후 rename.
  const tmpPath = outPath.replace(/\.mp4$/i, '.tmp.mp4')
  try {
    await run('ffmpeg', [
      '-y',
      '-i',
      srcPath,
      '-filter_complex',
      '[0:v]split[a][b];[b]reverse,trim=start_frame=1,setpts=PTS-STARTPTS[r];[a][r]concat=n=2:v=1:a=0[out]',
      '-map',
      '[out]',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-an',
      tmpPath
    ])
    await fs.rename(tmpPath, outPath)
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {})
    throw err
  }
  return outPath
}
