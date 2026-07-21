// 로컬 library/*/manifest.json 을 Firebase 정본(personaManifests 컬렉션)으로 일괄 업로드한다.
//
// 왜: 정본화 이전에 이 머신에서 생성된 persona 들은 personaManifests 문서가 없어 다른 머신에서
// 안 보인다. 이 스크립트를 '기존 생성물이 있는 머신'에서 한 번 돌리면, 이후엔 어느 머신에서든
// 어드민 리스트에 뜨고 hydrate(받기)로 복원된다. 상시 동기화는 admin-server 의 writeManifest 가
// 담당하므로, 이 스크립트는 최초 1회 마이그레이션용이다.
//
// 실행:
//   node scripts/sync-manifests-to-firebase.mjs            # 전체 업로드
//   node scripts/sync-manifests-to-firebase.mjs --dry-run  # 대상만 나열(업로드 안 함)

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initFirebase, upsertPersonaManifest } from '../src/main/comfyui/firestore-source.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))
const LIBRARY = path.resolve(root, config.outDir)
const saPath = config.firebase?.serviceAccountPath
  ? path.resolve(root, config.firebase.serviceAccountPath)
  : undefined

async function readManifest(pid) {
  return JSON.parse(await fs.readFile(path.join(LIBRARY, pid, 'manifest.json'), 'utf-8'))
}

async function main() {
  if (!dryRun) {
    await initFirebase({ serviceAccountPath: saPath, projectId: config.firebase?.projectId })
  }

  const entries = await fs.readdir(LIBRARY, { withFileTypes: true }).catch(() => [])
  let ok = 0
  let skip = 0
  let fail = 0
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue
    let m
    try {
      m = await readManifest(dirent.name)
    } catch {
      skip++ // manifest 없는 디렉터리(_probe, _input 등)
      continue
    }
    if (!m.personaId || !m.profile?.name || !m.profile?.birthDate) {
      console.warn(`  건너뜀(필수 필드 없음): ${dirent.name}`)
      skip++
      continue
    }
    if (dryRun) {
      console.log(`  [dry] ${dirent.name}  ${m.profile.name}  (이미지 ${(m.images || []).length})`)
      ok++
      continue
    }
    try {
      const key = await upsertPersonaManifest(m)
      console.log(`  ✔ ${dirent.name} → personaManifests/${key}  (이미지 ${(m.images || []).length})`)
      ok++
    } catch (err) {
      console.error(`  ✗ 실패 ${dirent.name}: ${err.message}`)
      fail++
    }
  }
  console.log(`\n완료 — 업로드 ${ok}, 건너뜀 ${skip}, 실패 ${fail}${dryRun ? '  (dry-run: 실제 업로드 안 함)' : ''}`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
