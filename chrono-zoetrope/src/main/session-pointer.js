// 현재 세션 참가자 포인터 — 연구자가 admin에서 고른 "이번 참가자"를 파일 하나로 공유한다.
//
// 왜 파일인가: 4창 Electron 런타임과 admin 서버는 서로 다른 프로세스다. 네트워크로 묶는 대신
// 라이브러리 안의 _session.json 하나로 느슨하게 잇는다. admin이 쓰고, 런타임이 읽어 따라간다.
// (§1) 선택 UI는 오직 연구자용 admin에만 있다 — 4창에는 로그인/선택 화면이 절대 뜨지 않는다.
//
// _ 접두사라 library-loader와 admin의 persona 스캔에서 자연히 제외된다(둘 다 '_'로 시작하는
// 항목을 건너뛴다). personaId 는 라이브러리 디렉토리 이름과 같다(=manifest.personaId).
//
// Electron 비의존 순수 Node 모듈 — main·admin 양쪽에서 import 한다.

import { readFile, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const SESSION_FILE = '_session.json'

export function sessionPath(libraryRoot) {
  return join(libraryRoot, SESSION_FILE)
}

/**
 * 현재 세션 선택 읽기.
 * @returns {Promise<{ personaId: string, name: string|null, selectedAt: string }|null>} 없으면 null
 */
export async function readSession(libraryRoot) {
  const p = sessionPath(libraryRoot)
  if (!existsSync(p)) return null
  try {
    const sel = JSON.parse(await readFile(p, 'utf8'))
    return sel && sel.personaId ? sel : null
  } catch {
    return null // 손상된 파일은 미설정으로 취급 (자동 선택 폴백)
  }
}

/**
 * 세션 선택 쓰기 (연구자 admin이 호출).
 * @param {{ personaId: string, name?: string|null }} sel
 */
export async function writeSession(libraryRoot, { personaId, name = null }) {
  const selection = { personaId, name, selectedAt: new Date().toISOString() }
  await writeFile(sessionPath(libraryRoot), JSON.stringify(selection, null, 2))
  return selection
}

/**
 * 세션 나가기 — 현재 선택을 지운다(_session.json 삭제). 런타임은 이 변화를 감지해 대기(IDLE)로 돌아간다.
 * 파일이 없으면 조용히 넘어간다.
 */
export async function clearSession(libraryRoot) {
  try {
    await unlink(sessionPath(libraryRoot))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}
