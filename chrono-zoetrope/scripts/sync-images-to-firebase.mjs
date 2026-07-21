// 로컬 library/*/ 의 파노라마 이미지({id}.png)를 Firebase Storage(generatedPanoramaImages)로 일괄 업로드한다.
//
// 왜: 이미지 바이트는 생성 시 로컬에만 저장돼, 다른 머신에서 admin을 열면 manifest(프롬프트)만 뜨고
// 이미지는 깨진다(로컬에도 Firebase에도 없음). 이 스크립트를 '이미지가 있는 머신'에서 한 번 돌리면
// generatedPanoramaImages 가 채워져, 이후 어느 머신에서든 hydrate(받기)로 이미지가 복원된다.
// 상시 업로드는 profile-worker 가 생성 완료 시 담당하므로(uploadPanoramasBestEffort), 이 스크립트는
// 그 배선 이전에 만들어진 기존 persona 를 채우는 일회 마이그레이션용이다.
//
// 실행:
//   node scripts/sync-images-to-firebase.mjs             # 전체 업로드
//   node scripts/sync-images-to-firebase.mjs 김혜수_700101 # 특정 pid(폴더명)만
//   node scripts/sync-images-to-firebase.mjs --dry-run    # 대상만 나열(업로드 안 함)

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initFirebase, uploadPersonaPanoramas } from '../src/main/comfyui/firestore-source.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const onlyPids = args.filter((a) => !a.startsWith('--'))

const config = JSON.parse(
  await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8')
)
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
    if (onlyPids.length && !onlyPids.includes(dirent.name)) continue
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
    const okImages = (m.images || []).filter((im) => !im.failed && im.file)
    if (okImages.length === 0) {
      console.warn(`  건너뜀(성공 이미지 0장): ${dirent.name}`)
      skip++
      continue
    }
    if (dryRun) {
      console.log(`  [dry] ${dirent.name}  ${m.profile.name}  (이미지 ${okImages.length}장)`)
      ok++
      continue
    }
    try {
      const r = await uploadPersonaPanoramas({
        profile: m.profile,
        personaId: m.personaId,
        dir: path.join(LIBRARY, dirent.name),
        images: m.images
      })
      console.log(`  ✔ ${dirent.name} → generatedPanoramaImages/${r.key}  (${r.count}장 업로드)`)
      ok++
    } catch (err) {
      console.error(`  ✗ 실패 ${dirent.name}: ${err.message}`)
      fail++
    }
  }
  console.log(
    `\n완료 — 업로드 ${ok}, 건너뜀 ${skip}, 실패 ${fail}${dryRun ? '  (dry-run: 실제 업로드 안 함)' : ''}`
  )
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
