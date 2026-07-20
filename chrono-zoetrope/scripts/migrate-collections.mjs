#!/usr/bin/env node
// Firestore 컬렉션 이름 이전 — 옛 이름 문서를 새 이름 컬렉션으로 복사(같은 문서 id·데이터).
// Firestore는 컬렉션 rename API가 없어 복사 후 옛 것 삭제로 이전한다. Storage 파일·URL은 그대로(문서 링크 유효).
//
//   node scripts/migrate-collections.mjs              # 복사만(안전, 옛 것 유지) — 먼저 이걸로 확인
//   node scripts/migrate-collections.mjs --delete-old # 복사 + 옛 컬렉션 문서 삭제(되돌릴 수 없음)

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initFirebase, COLLECTION_IMAGES, COLLECTION_VIDEOS } from '../src/main/comfyui/firestore-source.js'
import { getFirestore } from 'firebase-admin/firestore'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await fs.readFile(path.join(root, 'src/main/config/comfyui.json'), 'utf-8'))
const deleteOld = process.argv.includes('--delete-old')

// (옛 이름 → 새 이름). 새 이름은 firestore-source 상수와 일치.
const MIGRATIONS = [
  { from: 'Generated Panorama images', to: COLLECTION_IMAGES },
  { from: 'generated videos', to: COLLECTION_VIDEOS }
]

const saPath = config.firebase?.serviceAccountPath ? path.resolve(root, config.firebase.serviceAccountPath) : undefined
await initFirebase({ serviceAccountPath: saPath, projectId: config.firebase?.projectId, storageBucket: config.firebase?.storageBucket })
const db = getFirestore()

for (const { from, to } of MIGRATIONS) {
  if (from === to) {
    console.log(`[${from}] 이름 동일 — 스킵`)
    continue
  }
  const snap = await db.collection(from).get()
  console.log(`\n[${from}] → [${to}] · 문서 ${snap.size}개`)
  if (snap.empty) {
    console.log('  (옛 컬렉션 비어있음 — 스킵)')
    continue
  }
  // 1) 복사 (배치)
  let batch = db.batch()
  let n = 0
  for (const d of snap.docs) {
    batch.set(db.collection(to).doc(d.id), d.data(), { merge: true })
    if (++n % 400 === 0) {
      await batch.commit()
      batch = db.batch()
    }
  }
  await batch.commit()
  // 2) 검증 — 새 컬렉션 문서 수 확인
  const newSnap = await db.collection(to).get()
  console.log(`  ✓ 복사 완료 → [${to}] 총 ${newSnap.size}개 (문서 id: ${snap.docs.map((d) => d.id).join(', ')})`)
  // 3) 옛 것 삭제(옵션)
  if (deleteOld) {
    let db2 = db.batch()
    let m = 0
    for (const d of snap.docs) {
      db2.delete(d.ref)
      if (++m % 400 === 0) {
        await db2.commit()
        db2 = db.batch()
      }
    }
    await db2.commit()
    console.log(`  🗑 옛 컬렉션 [${from}] 문서 ${snap.size}개 삭제됨`)
  }
}

console.log(deleteOld ? '\n이전 완료(옛 컬렉션 삭제됨).' : '\n복사 완료(옛 컬렉션 유지). 확인 후 --delete-old로 옛 것 삭제.')
