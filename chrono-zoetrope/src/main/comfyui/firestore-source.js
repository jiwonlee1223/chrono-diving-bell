// Firestore 프로필 소스 — 생성 파이프라인의 입력단.
//
// 수집 앱(profile-collector)은 브라우저 클라이언트 SDK로 profiles/{personaId}에 '쓰기'만 한다.
// 규칙상 클라이언트 '읽기'는 막혀 있으므로(allow read: if false), 생성 측은 반드시
// Firebase Admin SDK(서비스 계정)로 읽는다. 서비스 계정은 보안 규칙을 우회한다.
//
// 필요한 firebase 파일: 서비스 계정 키(JSON).
//   Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성 → 다운로드.
//   chrono-zoetrope/secrets/serviceAccountKey.json 에 두거나 GOOGLE_APPLICATION_CREDENTIALS로 지정.
//   이 파일은 절대 커밋하지 않는다(.gitignore).
//
// status 생명주기 (profiles 문서):
//   submitted → generating → done | error
//   'submitted'는 수집 앱이 기록. 워커가 원자적으로 'generating'으로 claim 후 생성,
//   완료 시 'done', 실패 시 'error'로 마감한다.

import fs from 'node:fs/promises'
import path from 'node:path'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

let db = null

/** Admin SDK 초기화. serviceAccountPath 또는 GOOGLE_APPLICATION_CREDENTIALS 필요. */
export async function initFirebase({ serviceAccountPath, projectId } = {}) {
  if (db) return db
  const saPath = serviceAccountPath || process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (!saPath) {
    throw new Error(
      '서비스 계정 키 경로가 없다. config/comfyui.json의 firebase.serviceAccountPath 를 채우거나 ' +
        '환경변수 GOOGLE_APPLICATION_CREDENTIALS 를 설정하라.'
    )
  }
  let sa
  try {
    sa = JSON.parse(await fs.readFile(saPath, 'utf-8'))
  } catch (err) {
    throw new Error(`서비스 계정 키를 읽을 수 없다 (${saPath}): ${err.message}`)
  }
  const app = initializeApp({ credential: cert(sa), projectId: projectId || sa.project_id })
  db = getFirestore(app)
  return db
}

/** 생성 대기 프로필 조회. 기본은 status=='submitted'. includeErrors면 'error'도 재시도 대상에 포함. */
export async function fetchPendingProfiles({ limit = 5, includeErrors = false } = {}) {
  const statuses = includeErrors ? ['submitted', 'error'] : ['submitted']
  const snap = await db.collection('profiles').where('status', 'in', statuses).limit(limit).get()
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

/**
 * 원자적 claim: 지금 처리 가능한 상태일 때만 'generating'으로 전이한다.
 * 여러 워커·재시작 상황에서 같은 프로필을 중복 생성하지 않게 한다.
 * @returns true=이 워커가 획득, false=다른 곳이 이미 가져감
 */
export async function claimProfile(personaId, { includeErrors = false } = {}) {
  const refDoc = db.collection('profiles').doc(personaId)
  const claimable = includeErrors ? ['submitted', 'error'] : ['submitted']
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(refDoc)
    if (!snap.exists) throw new Error(`프로필 문서 없음: ${personaId}`)
    if (!claimable.includes(snap.data().status)) return false
    tx.update(refDoc, { status: 'generating', generationStartedAt: FieldValue.serverTimestamp() })
    return true
  })
}

/** status 갱신 (extra로 libraryDir·imageCount·error 등 부가 필드 기록). */
export async function setProfileStatus(personaId, status, extra = {}) {
  await db
    .collection('profiles')
    .doc(personaId)
    .update({ status, ...extra, updatedAt: FieldValue.serverTimestamp() })
}

/**
 * photoURLs(토큰 포함 다운로드 URL)를 로컬로 내려받는다.
 * 토큰 URL은 Storage 규칙을 우회하므로 별도 Storage 권한 없이 HTTP로 가져올 수 있다.
 * @returns 로컬 파일 경로 배열 (generateLifeLibrary의 profile.photos로 사용)
 */
export async function downloadPhotos(profile, destDir) {
  await fs.mkdir(destDir, { recursive: true })
  const urls = profile.photoURLs || []
  if (urls.length === 0) throw new Error(`프로필에 사진이 없다: ${profile.id}`)
  const paths = []
  for (let i = 0; i < urls.length; i++) {
    const res = await fetch(urls[i])
    if (!res.ok) throw new Error(`사진 다운로드 실패 [${i}] HTTP ${res.status}: ${urls[i]}`)
    const file = path.join(destDir, `photo-${i}.jpg`)
    await fs.writeFile(file, Buffer.from(await res.arrayBuffer()))
    paths.push(file)
  }
  return paths
}

/** Firestore 문서 → generateLifeLibrary가 받는 프로필 스키마로 변환. */
export function toGeneratorProfile(profile, photoPaths) {
  return {
    name: profile.name,
    birthDate: profile.birthDate,
    occupation: profile.occupation,
    photos: photoPaths,
    gender: profile.gender, // 수집 앱이 아직 안 보내지만 향후 확장
    descriptors: profile.descriptors || []
  }
}
