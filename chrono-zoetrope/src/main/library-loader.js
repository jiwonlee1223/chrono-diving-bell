// 사전 생성 라이브러리(§5.1) 로더 — 몽타주 재생 목록을 만든다.
//
// library/<personaId>/manifest.json 을 읽어 시간순(stageIndex, sceneIndex) 재생 목록을 구성한다.
// personaId 미지정이면 가장 최근 createdAt의 완성도 있는(이미지 10장 이상) 페르소나를 고른다.
// admin이 기본 승인 정책이므로 status가 명시적으로 'rejected'인 항목만 제외한다.
//
// Electron 비의존 순수 Node 모듈 (CLI·테스트에서 재사용 가능).

import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const MIN_IMAGES = 10 // 자동 선택 시 이만큼도 없으면 미완성 세션으로 보고 건너뛴다.

async function readManifest(dir) {
  try {
    return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * 몽타주 재생 목록 로드.
 * @param {object} p
 * @param {string} p.rootDir     library 절대 경로
 * @param {string} [p.personaId] 고정 페르소나. 없으면 최근 것 자동 선택.
 * @returns {{ personaId: string, dir: string, images: Array<{id, file, absPath, age, year, scene}> }}
 */
export async function loadMontageLibrary({ rootDir, personaId = null }) {
  const candidates = []

  if (personaId) {
    const dir = join(rootDir, personaId)
    const manifest = await readManifest(dir)
    if (!manifest) throw new Error(`라이브러리 manifest 없음: ${dir}`)
    candidates.push({ dir, manifest })
  } else {
    for (const name of await readdir(rootDir)) {
      if (name.startsWith('_') || name.startsWith('.')) continue
      const dir = join(rootDir, name)
      if (!(await stat(dir).catch(() => null))?.isDirectory()) continue
      const manifest = await readManifest(dir)
      if (manifest?.images?.length >= MIN_IMAGES) candidates.push({ dir, manifest })
    }
    candidates.sort(
      (a, b) => new Date(b.manifest.createdAt ?? 0) - new Date(a.manifest.createdAt ?? 0)
    )
    if (candidates.length === 0) throw new Error(`재생 가능한 라이브러리가 없다: ${rootDir}`)
  }

  const { dir, manifest } = candidates[0]
  const images = (manifest.images ?? [])
    .filter((im) => im.status !== 'rejected' && im.file && !im.failed)
    .map((im) => ({
      id: im.id,
      file: im.file,
      absPath: join(dir, im.file),
      age: im.age,
      year: im.year,
      scene: im.scene ?? ''
    }))
    .filter((im) => existsSync(im.absPath))
    .sort((a, b) => {
      const [as, ac] = a.id.split('-').map(Number)
      const [bs, bc] = b.id.split('-').map(Number)
      return as - bs || ac - bc
    })

  if (images.length === 0) throw new Error(`재생할 이미지가 없다: ${dir}`)
  return { personaId: manifest.personaId ?? candidates[0].dir, dir, images }
}
