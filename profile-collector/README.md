# 주마등 — 프로필 수집 앱 (profile-collector)

관람객이 **자기 스마트폰**으로 이름·생년월일·직업과 얼굴 사진 1~3장을 등록하는 모바일 웹 앱.
제출하면 **Firebase**(Firestore + Storage)에 저장되고, chrono-zoetrope 생성 파이프라인이 이를 입력으로 쓴다.

- 로그인: **Firebase 익명 인증** (원탭 "시작하기", 계정 가입 없음)
- 저장: `profiles/{personaId}` 문서 + `profile-photos/{personaId}/` 사진
- 서버: 의존성 제로 Node http (정적 파일 서빙 + Firebase 설정 주입)
- 배포: **Railway** (이 디렉토리만)

이 폴더는 chrono-zoetrope(Electron 전시 본체)와 **완전히 독립**이다. 같은 git 저장소에 있어도
Railway는 이 디렉토리만 빌드한다(아래 배포 참조).

---

## 데이터 모델

```
Firestore  profiles/{personaId}
  personaId  : "p-xxxxxxxx"   (이름+생년월일 해시 — 생성 파이프라인의 라이브러리 폴더명과 동일)
  uid        : 익명 인증 uid
  name, birthDate("YYYY-MM-DD"), occupation
  photoURLs  : [다운로드 URL, ...]   (토큰 포함 — 이 URL로만 사진 접근 가능)
  photoCount, status:"submitted", createdAt

Storage    profile-photos/{personaId}/{0,1,2}.jpg   (긴 변 1536px, JPEG)
```

**생성 파이프라인과의 연결**: `personaId`는 chrono-zoetrope
[`prompt-builder.js`](../chrono-zoetrope/src/main/comfyui/prompt-builder.js)의 `personaId()`와 **같은 해시**다.
즉 `profiles/{personaId}` ↔ `library/{personaId}` 가 1:1로 맞물린다. 생성 측은 Firestore 문서를
Admin SDK로 읽어 `{ name, birthDate, occupation, photos }` 프로필로 변환하면 된다
(사진은 `photoURLs`를 내려받아 로컬 경로로).

---

## Firebase 준비 (한 번만)

1. [Firebase 콘솔](https://console.firebase.google.com)에서 프로젝트 생성.
2. **Authentication → 로그인 방법 → 익명** 사용 설정.
3. **Firestore Database** 생성(프로덕션 모드).
4. **Storage** 생성.
5. `firebase.rules.txt`의 Firestore·Storage 규칙을 각각 콘솔에 붙여넣기.
6. **프로젝트 설정 → 일반 → 내 앱 → 웹 앱 추가** 후 SDK 설정값을 `.env`(또는 Railway 변수)에 채운다.

---

## 로컬 실행

```bash
cd profile-collector
cp .env.example .env      # 값 채우기
node --env-file=.env server.js
# → http://localhost:3000
```

같은 Wi-Fi의 휴대폰에서 테스트하려면 `http://<맥의_LAN_IP>:3000` 으로 접속.
(카메라·익명 인증은 http localhost / https 에서 동작한다. LAN IP는 http라도 대부분 동작하지만,
일부 브라우저는 카메라에 https를 요구하므로 실기기 테스트는 배포본(https)에서 하는 게 확실하다.)

---

## Railway 배포 — 같은 git, 이 앱만 publish

하나의 저장소(cdb)에 chrono-zoetrope·admin·profile-collector가 다 있어도, Railway 서비스에서
**Root Directory**만 지정하면 이 폴더만 빌드·배포된다.

1. Railway → New Project → **Deploy from GitHub repo** (cdb 저장소 선택).
2. 서비스 **Settings → Root Directory** = `profile-collector`.
   → Railway가 이 폴더의 `package.json`만 보고 `npm start`(= `node server.js`) 실행. 나머지 폴더는 무시.
3. 서비스 **Variables**에 `.env.example`의 `FIREBASE_*` 값들을 등록. (`PORT`는 Railway가 자동 주입.)
4. 배포 후 발급된 도메인으로 접속. Firebase 콘솔 **Authentication → 설정 → 승인된 도메인**에
   그 Railway 도메인을 추가한다(익명 인증 허용 도메인).

빌드 설정이 따로 필요 없다 — 런타임 의존성이 없어 `npm install`이 사실상 no-op이고, `npm start`로 바로 뜬다.

---

## 파일

| 파일 | 역할 |
|------|------|
| `server.js` | 정적 서빙 + `/env.js`로 Firebase 설정 런타임 주입 (의존성 제로) |
| `public/index.html` | 시작 / 입력 / 완료 3개 뷰 |
| `public/app.js` | 익명 인증, 사진 리사이즈, Storage 업로드, Firestore 저장, personaId 해시 |
| `public/styles.css` | 모바일 우선 다크 웜톤 |
| `firebase.rules.txt` | Firestore·Storage 보안 규칙 + 콘솔 설정 체크리스트 |
| `.env.example` | Firebase 설정 변수 템플릿 |
