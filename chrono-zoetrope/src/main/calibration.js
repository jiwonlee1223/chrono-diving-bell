// 설치 캘리브레이션 — 실린더 안에서 파노라마를 물리적으로 정렬하는 전역 오프셋 하나.
//
// yaw   : 둘레 회전(0..1 = 360°, wrap). 실린더 안에서 화면을 좌우로 돌려 "정면"을 맞춘다.
// pitch : 상하 이동(타일 높이 비율, wrap 없음). 수평선·얼굴 높이 미세 조정. ±로 위·아래.
//
// 왜 파일인가: session-pointer와 같은 이유 — 런타임 페이지와 서버(같은 프로세스지만 재시작 넘어
// 지속)를 파일 하나로 잇는다. 설치(프로젝터·실린더) 고유값이라 페르소나·라이브러리와 무관하지만,
// 런타임 머신엔 라이브러리가 하나뿐이라 library root의 _calibration.json 에 둔다(_ 접두사로 스캔 제외).
//
// Electron 비의존 순수 Node 모듈.

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const CALIBRATION_FILE = '_calibration.json'
export const DEFAULT_CALIBRATION = { yaw: 0, pitch: 0 }

export function calibrationPath(libraryRoot) {
  return join(libraryRoot, CALIBRATION_FILE)
}

/** 값을 안전 범위로 정규화. yaw는 [0,1) wrap, pitch는 [-0.5,0.5] clamp. */
export function normalizeCalibration(cal = {}) {
  const wrap = (x) => ((Number(x) || 0) % 1 + 1) % 1
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, Number(x) || 0))
  return { yaw: wrap(cal.yaw), pitch: clamp(cal.pitch, -0.5, 0.5) }
}

/** 현재 캘리브레이션 읽기. 없거나 손상되면 기본값(0,0). */
export async function readCalibration(libraryRoot) {
  const p = calibrationPath(libraryRoot)
  if (!existsSync(p)) return { ...DEFAULT_CALIBRATION }
  try {
    return normalizeCalibration(JSON.parse(await readFile(p, 'utf8')))
  } catch {
    return { ...DEFAULT_CALIBRATION }
  }
}

/** 캘리브레이션 쓰기 (런타임 페이지의 실시간 조정이 POST로 호출). @returns 정규화된 값 */
export async function writeCalibration(libraryRoot, cal) {
  const norm = normalizeCalibration(cal)
  await writeFile(
    calibrationPath(libraryRoot),
    JSON.stringify({ ...norm, updatedAt: new Date().toISOString() }, null, 2)
  )
  return norm
}
