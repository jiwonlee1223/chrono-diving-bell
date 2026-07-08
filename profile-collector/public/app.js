// 프로필 수집 앱 로직 (브라우저 ES 모듈).
// Firebase 익명 인증 → 이름/생년월일/직업/사진 입력 → Storage 업로드 + Firestore 저장.
//
// 저장 문서 ID = personaId (이름_YYMMDD). chrono-zoetrope 생성 파이프라인은 이 값을
// 재계산하지 않고 Firestore doc.id 를 그대로 써서 library/{personaId} 폴더로 연결한다.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js'
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js'
import { getFirestore, doc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
import { getStorage, ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js'

const $ = (s) => document.querySelector(s)
const MAX_PHOTOS = 3

// ── Firebase 초기화 ───────────────────────────────────────────────
const cfg = window.__FIREBASE_CONFIG__ || {}
let auth, db, storage
const configured = Boolean(cfg.apiKey && cfg.projectId && cfg.storageBucket)
if (configured) {
  const fb = initializeApp(cfg)
  auth = getAuth(fb)
  db = getFirestore(fb)
  storage = getStorage(fb)
} else {
  showStartError('서버에 Firebase 설정이 없습니다. 관리자에게 문의하세요. (환경변수 미설정)')
}

// ── personaId — Firestore 문서 ID이자 Storage 경로 조각이 된다.
// 사람이 알아볼 수 있게 `이름_YYMMDD` 형식. 생성 파이프라인은 이 값을 재계산하지 않고
// Firestore doc.id 를 그대로 소비하므로, 형식은 이 함수 하나가 단독으로 정한다.
// 이름의 위험 문자(공백, / . # $ [ ])는 제거한다 — Firestore ID/Storage 경로 안전용.
function personaId(name, birthDate) {
  const safeName = name.trim().replace(/[\s/.#$[\]]+/g, '')
  const ymd = birthDate.replace(/-/g, '').slice(2) // 'YYYY-MM-DD' → 'YYMMDD'
  return `${safeName}_${ymd}`
}

// ── 뷰 전환 ───────────────────────────────────────────────────────
function show(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('show', v.id === id))
  window.scrollTo(0, 0)
}
function overlay(on, text) {
  $('#overlay').hidden = !on
  if (text) $('#overlay-text').textContent = text
}
function showStartError(msg) {
  const note = $('#start-note')
  note.textContent = msg
  note.style.color = 'var(--danger)'
  $('#start-btn').disabled = true
}

// ── 시작(익명 로그인) ─────────────────────────────────────────────
let currentUid = null
if (auth) onAuthStateChanged(auth, (user) => { currentUid = user ? user.uid : null })

$('#start-btn').addEventListener('click', async () => {
  if (!auth) return
  const btn = $('#start-btn')
  btn.disabled = true
  overlay(true, '준비 중…')
  try {
    if (!currentUid) await signInAnonymously(auth)
    // 생년월일 상한을 오늘로 (미래 날짜 방지)
    $('#birthDate').max = new Date().toISOString().slice(0, 10)
    show('view-form')
  } catch (err) {
    console.error(err)
    const code = err?.code || ''
    showStartError(
      code.includes('operation-not-allowed')
        ? 'Firebase 콘솔에서 익명 로그인이 꺼져 있습니다. Authentication → 로그인 방법 → 익명을 켜세요.'
        : `시작할 수 없습니다: ${err.message || err}`
    )
  } finally {
    btn.disabled = false
    overlay(false)
  }
})

// ── 사진 선택·미리보기·리사이즈 ────────────────────────────────────
// 각 항목: { blob: Blob(리사이즈된 jpeg), url: objectURL(미리보기) }
const photos = []
const photoInput = $('#photo-input')
const photoGrid = $('#photos')
const addPhotoBtn = $('#add-photo')

addPhotoBtn.addEventListener('click', () => photoInput.click())
photoInput.addEventListener('change', async () => {
  const files = [...photoInput.files]
  photoInput.value = '' // 같은 파일 다시 고를 수 있게 초기화
  for (const file of files) {
    if (photos.length >= MAX_PHOTOS) break
    if (!file.type.startsWith('image/')) continue
    try {
      const blob = await resizeImage(file)
      photos.push({ blob, url: URL.createObjectURL(blob) })
    } catch (err) {
      console.error('이미지 처리 실패', err)
    }
  }
  renderPhotos()
})

function renderPhotos() {
  photoGrid.innerHTML = ''
  photos.forEach((p, i) => {
    const div = document.createElement('div')
    div.className = 'thumb'
    div.innerHTML = `<img src="${p.url}" alt="사진 ${i + 1}" /><button type="button" class="rm" aria-label="삭제">×</button>`
    div.querySelector('.rm').addEventListener('click', () => {
      URL.revokeObjectURL(p.url)
      photos.splice(i, 1)
      renderPhotos()
    })
    photoGrid.appendChild(div)
  })
  addPhotoBtn.disabled = photos.length >= MAX_PHOTOS
  addPhotoBtn.textContent = photos.length >= MAX_PHOTOS ? '최대 3장' : '＋ 사진 추가'
}

// 업로드·저장 비용을 줄이려 긴 변을 1536px로 축소, JPEG 0.85. 레퍼런스로는 충분한 해상도.
function resizeImage(file, maxDim = 1536, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
      const w = Math.round(img.width * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      canvas.getContext('2d').drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(img.src)
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('변환 실패'))), 'image/jpeg', quality)
    }
    img.onerror = () => reject(new Error('이미지를 열 수 없습니다'))
    img.src = URL.createObjectURL(file)
  })
}

// ── 제출 ──────────────────────────────────────────────────────────
$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const errEl = $('#form-error')
  errEl.hidden = true

  const name = $('#name').value.trim()
  const birthDate = $('#birthDate').value // YYYY-MM-DD
  const occupation = $('#occupation').value.trim()

  const problem = validate(name, birthDate, occupation, photos.length)
  if (problem) {
    errEl.textContent = problem
    errEl.hidden = false
    return
  }

  if (!currentUid) {
    // 세션이 끊겼으면 조용히 재인증
    try { await signInAnonymously(auth) } catch { /* 아래 catch로 */ }
  }

  const pid = personaId(name, birthDate)
  $('#submit-btn').disabled = true
  overlay(true, '사진 올리는 중…')

  try {
    // 1) 사진 업로드 → 다운로드 URL 수집
    const photoURLs = []
    for (let i = 0; i < photos.length; i++) {
      overlay(true, `사진 올리는 중… (${i + 1}/${photos.length})`)
      const storageRef = ref(storage, `profile-photos/${pid}/${i}.jpg`)
      await uploadBytes(storageRef, photos[i].blob, { contentType: 'image/jpeg' })
      photoURLs.push(await getDownloadURL(storageRef))
    }

    // 2) Firestore 문서 저장 (문서 ID = personaId)
    overlay(true, '저장 중…')
    await setDoc(doc(db, 'profiles', pid), {
      personaId: pid,
      uid: currentUid,
      name,
      birthDate,
      occupation,
      photoURLs,
      photoCount: photoURLs.length,
      status: 'submitted',
      createdAt: serverTimestamp()
    })

    $('#done-note').textContent = `${name} 님의 생애가 곧 흘러갑니다.`
    show('view-done')
  } catch (err) {
    console.error(err)
    errEl.textContent = `제출에 실패했습니다: ${err.message || err}`
    errEl.hidden = false
  } finally {
    $('#submit-btn').disabled = false
    overlay(false)
  }
})

function validate(name, birthDate, occupation, photoCount) {
  if (!name) return '이름을 입력하세요.'
  if (!birthDate) return '생년월일을 선택하세요.'
  const d = new Date(birthDate)
  if (Number.isNaN(d.getTime())) return '생년월일이 올바르지 않습니다.'
  if (d > new Date()) return '생년월일이 미래일 수 없습니다.'
  if (d.getFullYear() < 1900) return '생년월일을 다시 확인하세요.'
  if (!occupation) return '직업을 입력하세요.'
  if (photoCount < 1) return '얼굴 사진을 최소 1장 올려주세요.'
  return null
}

// ── 다른 사람 등록 (개인 폰이지만 가족 등 이어서 등록 가능) ──────────
$('#again-btn').addEventListener('click', () => {
  $('#profile-form').reset()
  photos.splice(0).forEach((p) => URL.revokeObjectURL(p.url))
  renderPhotos()
  $('#form-error').hidden = true
  show('view-form')
})
