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
let defaultBucket = null //   업로드용 기본 Storage 버킷 이름 (config.firebase.storageBucket)

// 생성물 링크를 기록하는 Firestore 컬렉션 이름(프로필별 문서 = 이름_생년월일6자). 여기서만 바꾸면 된다.
export const COLLECTION_IMAGES = 'generatedPanoramaImages'
export const COLLECTION_VIDEOS = 'generatedVideos'
// persona manifest 정본. 로컬 library/{pid}/manifest.json 을 Firebase에 올려 어느 머신에서든
// 리뷰·재생성·세션재생이 되게 한다(로컬은 read-through 캐시). 키는 파노라마와 같은 '이름_생년월일6자'.
export const COLLECTION_MANIFESTS = 'personaManifests'

/**
 * Admin SDK 초기화. 서비스 계정 키 출처는 세 가지(우선순위 순):
 *   1) 환경변수 FIREBASE_SERVICE_ACCOUNT — JSON 문자열 통째 (Railway 등 파일 없는 배포용)
 *   2) 인자 serviceAccountPath / GOOGLE_APPLICATION_CREDENTIALS — 로컬 파일 경로
 * storageBucket은 생성물 업로드용.
 */
export async function initFirebase({ serviceAccountPath, projectId, storageBucket } = {}) {
  if (db) {
    if (storageBucket) defaultBucket = storageBucket
    return db
  }
  let sa
  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT
  if (inlineJson && inlineJson.trim().startsWith('{')) {
    // 파일 없는 배포(Railway 등): 변수에 담긴 JSON을 직접 파싱
    try {
      sa = JSON.parse(inlineJson)
    } catch (err) {
      throw new Error(`FIREBASE_SERVICE_ACCOUNT JSON 파싱 실패: ${err.message}`)
    }
  } else {
    const saPath = serviceAccountPath || process.env.GOOGLE_APPLICATION_CREDENTIALS
    if (!saPath) {
      throw new Error(
        '서비스 계정 키가 없다. 파일 없는 배포면 환경변수 FIREBASE_SERVICE_ACCOUNT(JSON 문자열)를, ' +
          '로컬이면 config/comfyui.json의 firebase.serviceAccountPath 또는 GOOGLE_APPLICATION_CREDENTIALS 를 설정하라.'
      )
    }
    try {
      sa = JSON.parse(await fs.readFile(saPath, 'utf-8'))
    } catch (err) {
      throw new Error(`서비스 계정 키를 읽을 수 없다 (${saPath}): ${err.message}`)
    }
  }
  // 기본 버킷: config → '{projectId}.firebasestorage.app'. Admin SDK 업로드는 storage.googleapis.com 경유라
  // 캠퍼스망 firebasestorage SNI 차단과 무관하게 동작한다(실측 확인).
  defaultBucket = storageBucket || `${projectId || sa.project_id}.firebasestorage.app`
  app = initializeApp({
    credential: cert(sa),
    projectId: projectId || sa.project_id,
    storageBucket: defaultBucket
  })
  db = getFirestore(app)
  return db
}

/** 프로필 → 파노라마 컬렉션 문서 키 '이름_생년월일6자'(예: 김철수_990101). */
export function panoramaDocKey(profile) {
  if (profile.id) return profile.id // Firestore 수집 프로필은 이미 이 형식
  const digits = String(profile.birthDate || '').replace(/\D/g, '') // '1994-03-15' → '19940315'
  return `${profile.name || 'unknown'}_${digits.slice(2, 8)}` // → 김주만_940315
}

/** 로컬 파일 1개를 Storage에 올리고 공개 URL(+gs 경로)을 반환. makePublic 실패(균일 접근)면 7일 서명 URL. */
async function uploadFileToStorage(bkt, localPath, objectPath, contentType) {
  const file = bkt.file(objectPath)
  await file.save(await fs.readFile(localPath), {
    contentType,
    resumable: false,
    metadata: { cacheControl: 'public,max-age=31536000' }
  })
  let url
  try {
    await file.makePublic()
    url = `https://storage.googleapis.com/${bkt.name}/${objectPath.split('/').map(encodeURIComponent).join('/')}`
  } catch {
    ;[url] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 7 * 864e5 })
  }
  return { url, storagePath: `gs://${bkt.name}/${objectPath}` }
}

/**
 * 생성된 파노라마들을 Firebase Storage에 업로드하고, 링크를 'generatedPanoramaImages' 컬렉션에
 * 프로필(이름_생년월일6자)별로 기록한다. 로컬 파일은 그대로 두되 Firebase가 정본 링크를 갖는다.
 *
 * @param {object} p
 * @param {object} p.profile   { name, birthDate, id? }
 * @param {string} p.personaId 내부 pid(p-해시)
 * @param {string} p.dir       로컬 라이브러리 디렉터리(파일 읽기용)
 * @param {Array}  p.images    manifest.images (각 { id, age, year, scene, isPast, file, failed? })
 * @param {string} [p.bucket]  버킷 override(기본 defaultBucket)
 * @param {(e:object)=>void} [p.onProgress]
 * @returns {Promise<{ key:string, count:number, images:Array }>}
 */
export async function uploadPersonaPanoramas({
  profile,
  personaId,
  dir,
  images,
  bucket,
  onProgress = () => {}
}) {
  if (!db) throw new Error('initFirebase 먼저 호출해야 한다')
  const bkt = getStorage(app).bucket(bucket || defaultBucket)
  const key = panoramaDocKey(profile)
  const ok = (images || []).filter((im) => !im.failed && im.file)
  const uploaded = []
  for (let i = 0; i < ok.length; i++) {
    const im = ok[i]
    const local = path.join(dir, im.file)
    const objectPath = `generated-panoramas/${key}/${im.file}`
    const { url, storagePath } = await uploadFileToStorage(bkt, local, objectPath, 'image/png')
    uploaded.push({
      id: im.id,
      age: im.age,
      year: im.year,
      scene: im.scene,
      isPast: im.isPast ?? null,
      url,
      storagePath
    })
    onProgress({ type: 'upload', done: i + 1, total: ok.length, id: im.id })
  }
  await db
    .collection(COLLECTION_IMAGES)
    .doc(key)
    .set(
      {
        name: profile.name || null,
        birthDate: profile.birthDate || null,
        personaId,
        bucket: bkt.name,
        count: uploaded.length,
        images: uploaded,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    )
  return { key, count: uploaded.length, images: uploaded }
}

/**
 * 파노라마 이미지 한 장만 Storage에 올리고 generatedPanoramaImages 문서의 images 배열에서 그 id를
 * 교체(없으면 추가)한다 — admin 재생성이 그 장면만 정본에 최신본으로 반영할 때 쓴다(전체 재업로드 회피).
 * Storage objectPath가 결정론적(파일명 동일)이라 덮어쓰기로 최신 바이트가 반영된다.
 * @param {object} p { profile:{name,birthDate,id?}, personaId, dir, image:{id,age,year,scene,isPast,file,failed?}, bucket? }
 * @returns {Promise<{key,id,url,storagePath}|null>} 실패 장면(failed)·파일 없음이면 null
 */
export async function uploadPersonaPanoramaImage({ profile, personaId, dir, image, bucket }) {
  if (!db) throw new Error('initFirebase 먼저 호출해야 한다')
  if (!image?.file || image.failed) return null
  const bkt = getStorage(app).bucket(bucket || defaultBucket)
  const key = panoramaDocKey(profile)
  const local = path.join(dir, image.file)
  const objectPath = `generated-panoramas/${key}/${image.file}`
  const { url, storagePath } = await uploadFileToStorage(bkt, local, objectPath, 'image/png')
  const entry = {
    id: image.id,
    age: image.age,
    year: image.year,
    scene: image.scene,
    isPast: image.isPast ?? null,
    url,
    storagePath
  }
  // 기존 doc의 images 배열에서 같은 id를 교체(없으면 추가) — read-modify-write. 재생성은 순차라 경합 없음.
  const ref = db.collection(COLLECTION_IMAGES).doc(key)
  const snap = await ref.get()
  const prev = snap.exists ? snap.data().images || [] : []
  const images = prev.filter((im) => im.id !== image.id)
  images.push(entry)
  await ref.set(
    {
      name: profile.name || null,
      birthDate: profile.birthDate || null,
      personaId,
      bucket: bkt.name,
      count: images.length,
      images,
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  )
  return { key, id: image.id, url, storagePath }
}

/**
 * 생성된 영상을 Storage에 업로드하고 'generatedVideos' 컬렉션에 프로필별로 기록한다(이미지와 동일 형식).
 * kind='clips': videos/<id>.mp4 전부 업로드 → videos 배열. kind='reel': reel.mp4 업로드 → reel 필드. 둘 다 merge.
 *
 * @param {object} p
 * @param {object} p.profile   { name, birthDate, id? }
 * @param {string} p.personaId
 * @param {string} p.dir       로컬 라이브러리 디렉터리(<dir>/videos/*.mp4, <dir>/reel.mp4)
 * @param {Array}  [p.images]  manifest.images (장면 메타 age/year/scene 부여용)
 * @param {'clips'|'reel'} [p.kind]
 * @param {object} [p.reelMeta] { durationSec, clipCount }
 * @param {string} [p.bucket] @param {(e:object)=>void} [p.onProgress]
 * @returns {Promise<object>}
 */
export async function uploadPersonaVideos({
  profile,
  personaId,
  dir,
  images,
  kind = 'clips',
  reelMeta = null,
  bucket,
  onProgress = () => {}
}) {
  if (!db) throw new Error('initFirebase 먼저 호출해야 한다')
  const bkt = getStorage(app).bucket(bucket || defaultBucket)
  const key = panoramaDocKey(profile)
  const doc = db.collection(COLLECTION_VIDEOS).doc(key)
  const base = {
    name: profile.name || null,
    birthDate: profile.birthDate || null,
    personaId,
    bucket: bkt.name,
    updatedAt: FieldValue.serverTimestamp()
  }

  if (kind === 'reel') {
    const objectPath = `generated-videos/${key}/reel.mp4`
    const { url, storagePath } = await uploadFileToStorage(
      bkt,
      path.join(dir, 'reel.mp4'),
      objectPath,
      'video/mp4'
    )
    await doc.set(
      {
        ...base,
        reel: {
          url,
          storagePath,
          ...(reelMeta ? { durationSec: reelMeta.durationSec, clipCount: reelMeta.clipCount } : {})
        }
      },
      { merge: true }
    )
    onProgress({ type: 'upload-reel', url })
    return { key, reel: url }
  }

  // clips — 실제 존재하는 videos/*.mp4만 스캔
  const metaById = new Map((images || []).map((im) => [im.id, im]))
  let files = []
  try {
    files = (await fs.readdir(path.join(dir, 'videos'))).filter((f) => f.endsWith('.mp4'))
  } catch {
    /* videos 디렉터리 없음 */
  }
  const uploaded = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const id = f.replace(/\.mp4$/, '')
    const im = metaById.get(id) || {}
    const objectPath = `generated-videos/${key}/${f}`
    const { url, storagePath } = await uploadFileToStorage(
      bkt,
      path.join(dir, 'videos', f),
      objectPath,
      'video/mp4'
    )
    uploaded.push({
      id,
      age: im.age ?? null,
      year: im.year ?? null,
      scene: im.scene ?? null,
      isPast: im.isPast ?? null,
      url,
      storagePath
    })
    onProgress({ type: 'upload', done: i + 1, total: files.length, id })
  }
  await doc.set({ ...base, count: uploaded.length, videos: uploaded }, { merge: true })
  return { key, count: uploaded.length, videos: uploaded }
}

// ── Firebase 정본 읽기(정본화: 로컬 library는 캐시) ──────────────────────────────
// gs://bucket/object → { bucket, objectPath }. 형식이 다르면 null.
function parseGsPath(gs) {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(gs || '')
  return m ? { bucket: m[1], objectPath: m[2] } : null
}

/** 'generatedVideos' 문서(프로필별) 조회. { videos:[{id,storagePath,url,...}], reel, count, ... } 또는 null. */
export async function fetchPersonaVideos(profile) {
  if (!db) throw new Error('initFirebase 먼저 호출해야 한다')
  const snap = await db.collection(COLLECTION_VIDEOS).doc(panoramaDocKey(profile)).get()
  return snap.exists ? snap.data() : null
}

/**
 * Storage 객체 1개를 로컬로 내려받는다. storagePath(gs://…) 우선, 없으면 url(firebasestorage 형식) 파싱.
 * Admin SDK(storage.googleapis.com 경유)라 캠퍼스망 firebasestorage SNI 차단과 무관하다.
 */
export async function downloadStorageObject({ storagePath, url }, destPath) {
  if (!app) throw new Error('initFirebase 먼저 호출해야 한다')
  const ref = parseGsPath(storagePath) || parseStorageURL(url)
  if (!ref) throw new Error(`Storage 경로를 해석할 수 없다: ${storagePath || url}`)
  await fs.mkdir(path.dirname(destPath), { recursive: true })
  await getStorage(app).bucket(ref.bucket).file(ref.objectPath).download({ destination: destPath })
  return destPath
}

/**
 * Firebase 'generatedVideos' 문서의 클립들을 로컬 캐시(<dir>/videos/<id>.mp4)로 보장한다.
 * 이미 있으면 건너뛰고, 없으면 Storage에서 받아 채운다 — 로컬을 Firebase의 read-through 캐시로 만드는 핵심.
 * @param {object} p  { profile, dir, ids?, onProgress? }  ids 미지정 시 문서의 전 클립.
 * @returns {Promise<{ paths: Map<string,string>, missing: string[] }>}  id→localPath, 문서에 없던 id
 */
export async function ensureLocalClipsFromFirebase(
  profile,
  dir,
  { ids, onProgress = () => {} } = {}
) {
  const data = await fetchPersonaVideos(profile)
  if (!data) throw new Error(`Firebase에 영상 문서가 없다: ${panoramaDocKey(profile)}`)
  const byId = new Map((data.videos || []).map((v) => [v.id, v]))
  const wanted = ids && ids.length ? ids : [...byId.keys()]
  const videosDir = path.join(dir, 'videos')
  await fs.mkdir(videosDir, { recursive: true })
  const paths = new Map()
  const missing = []
  for (let i = 0; i < wanted.length; i++) {
    const id = wanted[i]
    onProgress({ phase: 'fetch', done: i, total: wanted.length, id })
    const local = path.join(videosDir, `${id}.mp4`)
    if (
      await fs.access(local).then(
        () => true,
        () => false
      )
    ) {
      paths.set(id, local)
      continue
    }
    const v = byId.get(id)
    if (!v) {
      missing.push(id)
      continue
    }
    await downloadStorageObject(v, local)
    paths.set(id, local)
  }
  onProgress({ phase: 'fetch', done: wanted.length, total: wanted.length })
  return { paths, missing }
}

/** 'generatedPanoramaImages' 문서(프로필별) 조회. { images:[{id,storagePath,url,...}], count, ... } 또는 null. */
export async function fetchPersonaImages(profile) {
  if (!db) throw new Error('initFirebase 먼저 호출해야 한다')
  const snap = await db.collection(COLLECTION_IMAGES).doc(panoramaDocKey(profile)).get()
  return snap.exists ? snap.data() : null
}

// ── persona manifest 정본(Firebase) ───────────────────────────────────────────
// 로컬 manifest.json 을 그대로 'personaManifests/{docKey}' 에 올려 정본으로 둔다.
// 어느 머신에서든 fetchPersonaManifest → 로컬 복원(hydrate)하면 리뷰·재생성이 동등하게 된다.

/** 로컬 manifest 를 Firebase 정본으로 upsert. docKey 는 manifest.profile 로부터 계산('이름_생년월일6자'). */
export async function upsertPersonaManifest(manifest) {
  if (!db) throw new Error('initFirebase 먼저 호출해야 한다')
  const profile = manifest?.profile || {}
  const key = panoramaDocKey(profile)
  await db
    .collection(COLLECTION_MANIFESTS)
    .doc(key)
    .set(
      {
        // 조회·조인용 상단 필드(리스트에서 매핑에 쓴다). manifest 전문은 data 에 통째로.
        personaId: manifest.personaId || null,
        name: profile.name || null,
        birthDate: profile.birthDate || null,
        profileDocId: profile.id || null, // Firestore profiles 문서 id(있으면)
        workflow: manifest.workflow || null,
        imageCount: (manifest.images || []).length,
        manifest,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    )
  return key
}

/** Firebase 정본 manifest 조회. profile({name,birthDate,id?}) 또는 docKey 문자열을 받는다. 없으면 null. */
export async function fetchPersonaManifest(profileOrKey) {
  if (!db) throw new Error('initFirebase 먼저 호출해야 한다')
  const key = typeof profileOrKey === 'string' ? profileOrKey : panoramaDocKey(profileOrKey)
  const snap = await db.collection(COLLECTION_MANIFESTS).doc(key).get()
  return snap.exists ? snap.data().manifest || null : null
}

/**
 * personaId(p-해시)로 Firebase 정본 manifest를 찾는다. personaManifests는 docKey(이름_YYMMDD)로
 * 키잉되므로 문서 키를 personaId로 직접 조회할 수 없다 — 전체 명단(listAll)에서 내부 personaId가
 * 일치하는 항목의 docKey를 거쳐 조회한다. manifest를 가진 persona는 그 문서에 personaId가 baked돼
 * listAll이 채워주므로 매칭이 성립한다(manifest 없는 profiles-only 항목은 애초에 복원 대상이 아니다).
 * 런타임·admin이 "로컬 manifest가 없을 때 정본에서 복원"에 공유한다(admin ensureLocalManifest와 동형). 없으면 null.
 * @param {string} pid
 * @returns {Promise<object|null>} manifest 또는 null
 */
export async function fetchManifestByPersonaId(pid) {
  if (!db) throw new Error('initFirebase 먼저 호출해야 한다')
  if (!pid) return null
  const list = await listAllPersonasFromFirebase()
  const entry = list.find((p) => p.personaId === pid)
  if (!entry) return null
  return await fetchPersonaManifest(entry.docKey)
}

/**
 * 어드민 사용자 리스트용 — Firebase 전체 명단을 한 번에 모은다.
 * profiles(제출 전부) 를 기준으로, personaManifests / generatedPanoramaImages / generatedVideos 를
 * docKey 로 조인해 각 사람의 { docKey, name, birthDate, personaId, 상태, 생성물 카운트 } 를 만든다.
 * 내부 personaId(p-해시)는 manifest·생성물 문서에 있으면 그대로 쓰고, 없으면 null(호출측이 계산).
 * @returns {Promise<Array>} docKey 기준 사람 목록
 */
export async function listAllPersonasFromFirebase({ limit = 500 } = {}) {
  if (!db) throw new Error('initFirebase 먼저 호출해야 한다')
  const [profSnap, manSnap, imgSnap, vidSnap] = await Promise.all([
    db.collection('profiles').limit(limit).get(),
    db.collection(COLLECTION_MANIFESTS).limit(limit).get(),
    db.collection(COLLECTION_IMAGES).limit(limit).get(),
    db.collection(COLLECTION_VIDEOS).limit(limit).get()
  ])

  const byKey = new Map()
  const ensure = (key) => {
    if (!byKey.has(key)) {
      byKey.set(key, {
        docKey: key,
        name: null,
        birthDate: null,
        personaId: null,
        profileDocId: null,
        // profiles 상태
        status: null, // 직업 수집 flow status
        sessions: null, // 인생그래프 flow { first, second, third } 상태 요약
        submittedAt: null,
        // 생성물
        hasManifest: false,
        imageCount: 0,
        videoCount: 0,
        reel: false,
        createdAt: null,
        updatedAt: null
      })
    }
    return byKey.get(key)
  }

  // profiles — 제출 전부(생성 전 submitted 포함)
  for (const d of profSnap.docs) {
    const data = d.data()
    const key = d.id // profiles 문서 id = '이름_생년월일6자'
    const p = ensure(key)
    p.name = data.name ?? p.name
    p.birthDate = data.birthDate ?? p.birthDate
    p.profileDocId = d.id
    p.status = data.status ?? p.status
    // 인생그래프 세션 상태 요약(존재하는 세션만)
    const sessions = {}
    for (const s of ['first', 'second', 'third']) {
      if (data[s] || data[`${s}SubmittedAt`] || data[`${s}Status`]) {
        sessions[s] = data[`${s}Status`] || (data[`${s}SubmittedAt`] ? 'submitted' : null)
      }
    }
    if (Object.keys(sessions).length) p.sessions = sessions
    p.submittedAt = toMillisSafe(data.createdAt) ?? p.submittedAt
    p.createdAt = toMillisSafe(data.createdAt) ?? p.createdAt
    p.updatedAt = toMillisSafe(data.updatedAt) ?? p.updatedAt
  }

  // personaManifests — 정본 manifest 존재 + 내부 personaId
  for (const d of manSnap.docs) {
    const data = d.data()
    const p = ensure(d.id)
    p.hasManifest = true
    p.personaId = data.personaId ?? p.personaId
    p.name = p.name ?? data.name ?? null
    p.birthDate = p.birthDate ?? data.birthDate ?? null
    p.imageCount = data.imageCount ?? p.imageCount
    p.updatedAt = toMillisSafe(data.updatedAt) ?? p.updatedAt
  }

  // generatedPanoramaImages — 이미지 카운트 + 내부 personaId 보강
  for (const d of imgSnap.docs) {
    const data = d.data()
    const p = ensure(d.id)
    p.personaId = p.personaId ?? data.personaId ?? null
    p.name = p.name ?? data.name ?? null
    p.birthDate = p.birthDate ?? data.birthDate ?? null
    p.imageCount = Math.max(p.imageCount, data.count ?? (data.images || []).length)
  }

  // generatedVideos — 클립 수 + reel 여부
  for (const d of vidSnap.docs) {
    const data = d.data()
    const p = ensure(d.id)
    p.personaId = p.personaId ?? data.personaId ?? null
    p.videoCount = (data.videos || []).length
    p.reel = Boolean(data.reel)
  }

  return [...byKey.values()]
}

/** Firestore Timestamp | number | null → ms 또는 null (여러 컬렉션의 서로 다른 시간 필드 정규화). */
function toMillisSafe(v) {
  if (!v) return null
  if (typeof v === 'number') return v
  if (typeof v.toMillis === 'function') return v.toMillis()
  if (typeof v._seconds === 'number') return v._seconds * 1000
  return null
}

const fileExists = (p) =>
  fs.access(p).then(
    () => true,
    () => false
  )

/**
 * 런타임 재생용 미디어를 Firebase 정본에서 로컬 캐시로 확보한다(read-through).
 * 파노라마 이미지(<dir>/<file>)와 reel(<dir>/reel.mp4)을 없을 때만 내려받는다 — 있으면 로컬 재사용.
 * 파일명은 storagePath의 basename(업로드 시 objectPath 말단 = manifest의 im.file과 동일)에서 얻는다.
 * @returns {Promise<{ images:number, reel:boolean, missing:string[] }>}
 */
export async function ensurePersonaMediaFromFirebase(profile, dir, { onProgress = () => {} } = {}) {
  await fs.mkdir(dir, { recursive: true })
  const result = { images: 0, reel: false, missing: [] }

  // 파노라마 이미지
  let imgDoc = null
  try {
    imgDoc = await fetchPersonaImages(profile)
  } catch {
    /* 문서 없음/조회 실패 → 로컬만으로 진행 */
  }
  const imgs = imgDoc?.images || []
  for (let i = 0; i < imgs.length; i++) {
    const im = imgs[i]
    const file = im.file || (im.storagePath || im.url || '').split('/').pop()?.split('?')[0]
    if (!file) continue
    const local = path.join(dir, file)
    if (await fileExists(local)) continue
    try {
      await downloadStorageObject(im, local)
      result.images++
      onProgress({ phase: 'image', done: result.images, total: imgs.length, file })
    } catch {
      result.missing.push(file)
    }
  }

  // reel
  let vidDoc = null
  try {
    vidDoc = await fetchPersonaVideos(profile)
  } catch {
    /* 문서 없음 */
  }
  const reelRef = vidDoc?.reel
  if (reelRef?.storagePath || reelRef?.url) {
    const reelLocal = path.join(dir, 'reel.mp4')
    if (!(await fileExists(reelLocal))) {
      try {
        await downloadStorageObject(reelRef, reelLocal)
        result.reel = true
        onProgress({ phase: 'reel', done: 1, total: 1 })
      } catch {
        result.missing.push('reel.mp4')
      }
    }
  }
  return result
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
        await getStorage(app)
          .bucket(ref.bucket)
          .file(ref.objectPath)
          .download({ destination: file })
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
