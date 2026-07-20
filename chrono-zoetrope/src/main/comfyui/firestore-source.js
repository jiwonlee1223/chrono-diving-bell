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
import { getStorage } from 'firebase-admin/storage'

let app = null
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
  app = initializeApp({ credential: cert(sa), projectId: projectId || sa.project_id })
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
 * 실시간 리스너 — 폴링 없이 제출을 즉시 감지한다.
 * 생성 머신이 전시 내내 켜져 인터넷에 연결돼 있다는 전제(항상 아웃바운드 연결만 유지하므로
 * 방화벽·포트포워딩 불필요). 신규로 매칭되는 문서마다 onProfile을 한 번씩 호출한다.
 * (연결 시작 시 이미 대기 중이던 문서들도 'added'로 한 번에 들어온다.)
 * @returns 리스너 해제 함수
 */
export function listenForSubmissions(onProfile, { includeErrors = false } = {}) {
  const statuses = includeErrors ? ['submitted', 'error'] : ['submitted']
  return db
    .collection('profiles')
    .where('status', 'in', statuses)
    .onSnapshot(
      (snap) => {
        for (const change of snap.docChanges()) {
          if (change.type === 'added') onProfile({ id: change.doc.id, ...change.doc.data() })
        }
      },
      (err) => console.error(`[firestore-source] 리스너 오류: ${err.message}`)
    )
}

/**
 * 전체 프로필 컬렉션을 createdAt 순으로 구독한다(어드민 큐 표시용).
 * submitted/generating/done/error 모든 상태 변화를 스냅샷마다 '전체 목록'으로 흘려보낸다.
 * (listenForSubmissions는 submitted/error만 보지만, 큐 UI는 진행 중·완료도 봐야 한다.)
 * @param {(profiles: object[]) => void} onChange  매 스냅샷마다 정렬된 전체 목록으로 호출
 * @param {object} [opts]
 * @param {number} [opts.limit=200]  전시 규모상 넉넉한 상한
 * @returns 리스너 해제 함수
 */
export function listenProfiles(onChange, { limit = 200 } = {}) {
  return db
    .collection('profiles')
    .orderBy('createdAt', 'asc')
    .limit(limit)
    .onSnapshot(
      (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (err) => console.error(`[firestore-source] listenProfiles 오류: ${err.message}`)
    )
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

/**
 * 고아 'generating' 복구 — 워커/admin이 생성 도중 죽으면 프로필이 generating에 갇혀
 * 다시는 큐에 잡히지 않는다. 프로세스 시작 시 1회 호출해 submitted로 되돌린다.
 * 전제: 생성 프로세스는 한 번에 하나만 돈다(admin 자동 큐 또는 CLI 워커 중 하나).
 * 둘을 동시에 띄우면 상대가 진행 중인 건을 리셋해 중복 생성이 날 수 있다.
 * @returns {string[]} 복구된 프로필 id 목록
 */
export async function resetOrphanGenerating() {
  const snap = await db.collection('profiles').where('status', '==', 'generating').get()
  const ids = []
  for (const d of snap.docs) {
    await d.ref.update({ status: 'submitted', updatedAt: FieldValue.serverTimestamp() })
    ids.push(d.id)
  }
  return ids
}

/** status 갱신 (extra로 libraryDir·imageCount·error 등 부가 필드 기록). */
export async function setProfileStatus(personaId, status, extra = {}) {
  await db
    .collection('profiles')
    .doc(personaId)
    .update({ status, ...extra, updatedAt: FieldValue.serverTimestamp() })
}

// ── cdb-crafter(인생그래프 앱) 세션별 claim ──────────────────────────────
//
// occupation 플로우는 문서 하나에 status 필드 하나뿐이라 위 claimProfile 등이 그걸 전제한다.
// 인생그래프 문서는 세션이 최대 3개(first/second/third)라 세션마다 독립된 상태 필드
// `${key}Status`를 쓴다(생명주기는 같다: submitted → generating → done | error).
// `${key}SubmittedAt`(saveLifeGraph.js가 세션 제출 시 찍음)과는 별개 — 그건 "제출됨" 마커,
// 이건 실제 생성 진행 상태.

/** 세션 하나를 원자적으로 claim한다. @returns true=이 워커가 획득, false=이미 다른 곳이 처리 중/완료 */
export async function claimLifeGraphSession(personaId, sessionKey) {
  const refDoc = db.collection('profiles').doc(personaId)
  const statusField = `${sessionKey}Status`
  const submittedAtField = `${sessionKey}SubmittedAt`
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(refDoc)
    if (!snap.exists) throw new Error(`프로필 문서 없음: ${personaId}`)
    const data = snap.data()
    // {key}Status가 없어도 {key}SubmittedAt만 있으면 submitted로 본다 — 이 claim 배선 이전에
    // 이미 제출된 문서(Status 필드 자체가 없음) 구제. 명시적으로 다른 상태면(generating/done/error) 거절.
    const effective = data[statusField] || (data[submittedAtField] ? 'submitted' : null)
    if (effective !== 'submitted') return false
    tx.update(refDoc, {
      [statusField]: 'generating',
      [`${sessionKey}GenerationStartedAt`]: FieldValue.serverTimestamp()
    })
    return true
  })
}

/** 세션 상태 갱신 (extra로 imageCount·error 등 부가 필드를 `${key}...` 없이 그대로 기록). */
export async function setLifeGraphSessionStatus(personaId, sessionKey, status, extra = {}) {
  await db
    .collection('profiles')
    .doc(personaId)
    .update({ [`${sessionKey}Status`]: status, ...extra, updatedAt: FieldValue.serverTimestamp() })
}

/** 고아 'generating' 세션 복구 — resetOrphanGenerating과 동일한 이유, 세션별로. */
export async function resetOrphanLifeGraphGenerating() {
  const keys = ['first', 'second', 'third']
  const ids = []
  for (const key of keys) {
    const snap = await db.collection('profiles').where(`${key}Status`, '==', 'generating').get()
    for (const d of snap.docs) {
      await d.ref.update({ [`${key}Status`]: 'submitted', updatedAt: FieldValue.serverTimestamp() })
      ids.push(`${d.id}#${key}`)
    }
  }
  return ids
}

/**
 * photoURLs(토큰 포함 다운로드 URL)를 로컬로 내려받는다.
 *
 * 공개 다운로드 URL(firebasestorage.googleapis.com)로 직접 fetch하지 않는다 —
 * 개발망의 "인터넷 접속 관리 시스템"이 이 도메인을 SNI 기반으로 차단해 fetch failed가 난다
 * (2026-07 확인: 같은 IP라도 SNI가 이 도메인이면 차단 페이지가 주입됨).
 * 대신 URL에서 버킷·객체 경로를 파싱해 Admin SDK(storage.googleapis.com 경유)로 받는다.
 * 서비스 계정이 이미 있으므로 토큰 URL 의존도 사라진다.
 * @returns 로컬 파일 경로 배열 (generateLifeLibrary의 profile.photos로 사용)
 */
export async function downloadPhotos(profile, destDir) {
  await fs.mkdir(destDir, { recursive: true })
  const urls = profile.photoURLs || []
  if (urls.length === 0) throw new Error(`프로필에 사진이 없다: ${profile.id}`)
  const paths = []
  for (let i = 0; i < urls.length; i++) {
    const file = path.join(destDir, `photo-${i}.jpg`)
    const ref = parseStorageURL(urls[i])
    try {
      if (ref) {
        await getStorage(app).bucket(ref.bucket).file(ref.objectPath).download({ destination: file })
      } else {
        // firebasestorage 형식이 아닌 URL(테스트 데이터 등)만 일반 HTTP로
        const res = await fetch(urls[i])
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await fs.writeFile(file, Buffer.from(await res.arrayBuffer()))
      }
    } catch (err) {
      throw new Error(`사진 다운로드 실패 [${i}] ${err.message}: ${urls[i]}`)
    }
    paths.push(file)
  }
  return paths
}

/** Firebase Storage 공개 다운로드 URL → { bucket, objectPath }. 형식이 다르면 null. */
function parseStorageURL(url) {
  const m = /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/([^/]+)\/o\/([^?]+)/.exec(url)
  return m ? { bucket: m[1], objectPath: decodeURIComponent(m[2]) } : null
}

/** Firestore 문서 → generateLifeLibrary가 받는 프로필 스키마로 변환. */
export function toGeneratorProfile(profile, photoPaths) {
  return {
    id: profile.id, // manifest에 남아 어드민 수정을 Firestore로 역동기화할 때 쓴다
    name: profile.name,
    birthDate: profile.birthDate,
    occupation: profile.occupation,
    photos: photoPaths,
    // 수집 앱이 아직 안 보냄 — 없으면 생성 시 사진에서 자동 감지(gender-detect.js),
    // 감지·수동수정 결과는 완료 시 이 문서에 역기록되어 재생성 때 재감지를 건너뛴다.
    gender: profile.gender,
    descriptors: profile.descriptors || []
  }
}

/** 프로필 문서 부분 갱신 (status 외 필드 — 어드민 성별 수정의 역동기화 등). */
export async function updateProfileFields(personaId, fields) {
  await db
    .collection('profiles')
    .doc(personaId)
    .update({ ...fields, updatedAt: FieldValue.serverTimestamp() })
}
