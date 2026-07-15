# Firestore → 생성 트리거 (워커)

수집 앱(`profile-collector`)이 Firestore에 저장한 프로필을 읽어 생애 라이브러리 생성을 자동 트리거하는 워커.
ComfyUI가 있는 **생성 머신**(설치 런타임 Windows 노트북 또는 개발 맥)에서 돌린다.

```
[관람객 폰] ──제출──▶ Firestore profiles/{personaId}  (status: submitted)
                                     │
                                     ▼
                    generate-from-firestore.mjs (이 워커)
                     1. claim  → status: generating
                     2. photoURLs 다운로드
                     3. generateLifeLibrary → library/{personaId}/
                     4. 완료 → status: done  (실패 시 error)
                                     │
                                     ▼
                    admin-server.mjs 로 확인 → 전 장 기본 노출, 문제 장만 재생성으로 교체
```

## 필요한 firebase 파일: 서비스 계정 키

수집 앱과 달리 생성 측은 Firestore를 **읽어야** 한다. 규칙상 클라이언트 읽기는 막혀 있으므로
(`allow read: if false`), **Admin SDK + 서비스 계정 키**로 접근한다. 서비스 계정은 보안 규칙을 우회한다.

1. Firebase 콘솔 → **프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성** → JSON 다운로드.
2. `chrono-zoetrope/secrets/serviceAccountKey.json` 에 저장.
   (경로는 `config/comfyui.json`의 `firebase.serviceAccountPath`, 또는 환경변수
   `GOOGLE_APPLICATION_CREDENTIALS`로 지정 가능.)
3. 이 파일은 **절대 커밋 금지** — `.gitignore`에 `secrets/`, `serviceAccountKey.json` 등록돼 있음.

```bash
npm install          # firebase-admin 설치
mkdir -p secrets     # 여기에 serviceAccountKey.json 배치
```

## 실행

```bash
npm run gen:firestore                 # 대기분(submitted) 한 배치 처리 후 종료
npm run worker:listen                 # 실시간 리스너 — 제출 즉시 생성 시작 (전시 중 상시 구동, 권장)
npm run worker                        # 폴링 루프 (15초 간격, 대안)
node scripts/generate-from-firestore.mjs --once --limit 1
node scripts/generate-from-firestore.mjs --once --include-errors   # 실패분 재시도
```

**전시 중 권장 구동 방식**: 생성 머신(ComfyUI가 있는 머신)이 전시 내내 켜져 인터넷에
연결돼 있다면 `npm run worker:listen`을 띄워둔다. 관람객이 폰에서 "제출하기"를 누르는 순간
Firestore 문서가 써지고, 이 리스너가 폴링 지연 없이(수백 ms 내) 감지해 바로 생성을 시작한다.
리스너는 생성 머신 → Firestore 방향의 아웃바운드 연결만 유지하므로 별도 포트포워딩·방화벽
설정이 필요 없다. `npm run worker`(폴링)는 리스너 연결이 불안정한 환경을 위한 대안으로 남겨둔다.

## status 생명주기

`profiles/{personaId}` 문서의 `status`:

| status | 의미 | 설정 주체 |
|--------|------|-----------|
| `submitted` | 제출됨, 생성 대기 | 수집 앱 |
| `generating` | 워커가 claim해 생성 중 | 워커(원자적 트랜잭션) |
| `done` | 생성 완료 (`libraryDir`, `imageCount` 기록) | 워커 |
| `error` | 실패 (`error` 메시지 기록) | 워커 |

- **중복 방지**: claim은 트랜잭션이라 여러 워커·재시작에도 같은 프로필을 한 번만 처리한다.
- **멈춘 작업 복구**: 생성 중 프로세스가 죽으면 `generating`에 갇힌다. 콘솔에서 해당 문서의
  `status`를 `submitted`로 되돌리면 다음 배치가 다시 집는다. (자동 타임아웃 회수는 아직 없음 — 필요 시 추가.)

## 설정 (`config/comfyui.json`의 `firebase`)

```json
"firebase": {
  "serviceAccountPath": "./secrets/serviceAccountKey.json",
  "projectId": "",          // 비우면 키 파일의 project_id 사용
  "pollIntervalMs": 15000,  // --watch 폴링 주기
  "batchLimit": 5           // 한 배치 최대 건수
}
```
