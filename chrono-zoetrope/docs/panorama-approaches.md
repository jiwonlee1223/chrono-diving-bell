# 파노라마 생성 접근 이력 (순차)

주마등 1인칭 360° 파노라마를 어떻게 생성할지 — 여러 방식을 순차로 실측하며 도달한 기록.
각 단계: **방식 / 이유 / 결과 / 왜 넘어갔나**. 프로브 스크립트는 `scripts/probe-*.mjs`.

> **현재 채택(2026-07-19): equirect-native (Gemini 360 equirectangular 직접 생성).** 아래 12번.
> 1~11번은 전부 **평면 원근 이미지를 스티칭**하는 계보였고, 근본적으로 진짜 360 카메라 기하가 안 나와 폐기/보류.

---

## 1. A안 — SDXL SeamlessTile (로컬 seamless) · 2026-07-15
- **방식**: SDXL(realvisxl Lightning) + `SeamlessTile`(x_only) + `CircularVAEDecode`. UNet conv 패딩을 circular로 바꿔 좌우를 구조적으로 잇는다.
- **이유**: Gemini 없이 로컬로, 좌우 wrap이 100% 이어지는 파노라마.
- **결과**: 좌우 seamless 완벽(★). 5~7s/장. 단 SDXL 화질·타인 얼굴 smear 약함, equirect 세로곡률 이슈.
- **넘어간 이유**: 화질·제어가 Gemini보다 약해 몽타주 품질 부족. (단 "진짜 주기성"은 이 방식만이 보장 — 12번 wrap 보완 후보로 부활 가능.)
- 코드: `workflows.js buildSeamlessPanoramaWorkflow`, `probe-seamless-panorama.mjs`.

## 2. B안 — Gemini 파노라마 + seam 보정(seamfix) · 2026-07-15
- **방식**: Gemini 초광각 1장 → 절반 roll(wrap을 중앙으로) → 중앙 세로 밴드만 Flux Fill inpaint → roll back.
- **이유**: Gemini 화질 유지하면서 좌우 wrap 이음매만 보정.
- **결과**: Gemini 화질·얼굴 smear 상. Flux Fill 밴드로 이음매 선명 보정. ~37~82s/장.
- **넘어간 이유**: 초광각 1장의 fisheye 곡률을 *결함으로 오해*해 제거하려 함(→ 나중에 이게 올바른 360 곡률임을 뒤늦게 깨달음, 12번). 좌우 시야 연속성 욕심에 surround로 이동.
- 코드: `workflows.js buildGeminiSeamFixWorkflow`, `probe-gemini-seamfix.mjs`.

## 3. surround (C안) — 90° 타일 4장 캔버스 아웃페인팅 · 2026-07-16
- **방식**: 광각 없이 90° 자연 타일 4장 생성, `[빈칸|이웃]` 캔버스 아웃페인팅으로 이어 4:1 조립. 등 뒤=키스톤(양쪽 조건화).
- **이유**: 좌우 시야를 최대한 연속·선명하게. 초광각 왜곡 회피.
- **결과**: 방 하나가 360° 감김. 단 타일 접합이 딱딱, 키스톤(등 뒤)이 가장 덜 타이트.
- **넘어간 이유**: discrete 90° 갭이 스티칭돼 접합이 어색. Flux Fill 블렌드 추가로 완화 시도(4번).
- 코드: `panorama-tiles.js`, `probe-surround.mjs`.

## 4. surround + Flux Fill 접합선 블렌드 · 2026-07-18
- **방식**: surround 조립본을 tileSize/2 roll → 4개 접합선을 한 번의 Flux Fill 패스로 블렌드.
- **결과**: 접합선 부드러워짐. 단 여전히 "새로 생성한 옆칸"이라 전역 원근 불일치.
- **넘어간 이유**: 좁은 seam 블렌드로 전역 불일치를 못 메움 → 진짜 아웃페인팅(5번).
- 코드: `workflows.js buildSurroundSeamBlendWorkflow`.

## 5. D안 — Flux.2 마스크 아웃페인팅 · 2026-07-18
- **방식**: Gemini 앵커 + Flux.2 dev 마스크 아웃페인팅으로 슬라이딩 이어그림. 기존 픽셀 고정 + 빈 영역만 이웃 조건화.
- **이유**: Gemini "새로 생성" 원근 어긋남을 마스크 인페인트로 진짜 연결.
- **결과**: 한 장처럼 연속. 단 아웃페인팅은 '비슷한 것 반복' 경향. **Flux.2 폭 ~5120px에서 RuntimeError(폭 한계).**
- **핵심 실측**: **서로 다른 두 사진 사이 큰 갭(90°)은 어떤 모델로도 블러**(내용이 없어서). → discrete 타일/앵커는 구조적으로 선명 연결 불가.
- 코드: `panorama-flux2.js`(초기), `probe-flux2-surround.mjs`.

## 6. 결정판(당시) — 넓은 앵커 2장 + 좁은 이음선 · 2026-07-18
- **방식**: 갭을 채우지 말고 애초에 넓은 2:1 정면·맞은편 2장(각 180°)을 만들어 붙이고, 좁은 이음선 2곳만 Flux Fill.
- **이유**: 큰 갭 블러 회피 — 선명은 넓은 앵커 안에서 확보.
- **결과**: 이전보다 확연히 파노라마다움. 단 두 앵커가 독립생성이라 가운데 이음선 양쪽이 서로 다른 장면.
- **넘어간 이유**: 응시 구도 + 조건화로 개선(7번).

## 7. 응시 구도 + image2를 image1에 조건화 · 2026-07-18
- **방식**: image1(주인공 far-left 응시) → image2를 image1 레퍼런스로 조건화해 같은 장면 연속. aerial(배치도) 공유로 발전.
- **결과**: 가운데 이음선 거의 사라짐. 이전 모든 버전 압도.
- 코드: `prompt-builder.js composeSurroundGazePrompts`, `panorama-flux2.js generateSurroundPanoramaFlux2`.

## 8. 단일 통합 그래프(surround) · 2026-07-18
- **방식**: 아웃페인팅·조립·wrap을 한 ComfyUI 그래프로(generate 1번), workflow.json 추적.
- 코드: `workflows.js buildFlux2SurroundWorkflow`(이후 폐기).

## 9. center-front + 단일-관찰자-시점 back · 2026-07-19
- **방식**: 주인공 far-left→정면 중앙. back 프롬프트의 "camera at their eyes"(1인칭 손 나옴) 제거 → 관람객 중심 단일시점.
- **결과**: 주인공 정면 응시, back 1인칭 손 제거. 단 ±90° 조인은 여전히 불연속(대칭).

## 10. Path B — rotate-and-outpaint · 2026-07-19
- **방식**: front 한 장에서 좌우로 continuation-outpaint(Flux Fill)해 실린더 둘레를 채움. 등 뒤 wrap 1곳만 닫음.
- **이유**: 넓은 앵커 2장 맞대기가 "대칭 두 사진"이라 방위각 불연속 → continuation으로 진짜 연속.
- **결과**: 좌우 연속 성공(step=512). 단 **등 뒤(주인공 응시 대상)가 흐림/기둥으로 소실**. gap-fill 모델 탐색(11) 결과 Flux Fill·Fooocus·BrushNet 전부 큰 갭 블러 재확인.
- 코드: `panorama-streetview.js generateStreetViewPanorama`, `buildFluxFillOutpaintWorkflow`, `probe-streetview.mjs`, `probe-brushnet.mjs`.

## 11. Path C — aerial 공유 + 응시 back + 조인 크로스페이드 · 2026-07-19
- **방식**: aerial 배치도로 front·back 공간 공유 → back(의도된 응시 대상)을 wrap 가로질러 배치, front 가장자리를 continuation-outpaint해 크로스페이드. 원근 완화(front 2.5:1 + flat 프롬프트) + 단일 그래프 통합.
- **결과**: 세 방식 중 최선의 균형(응시 back 선명 + 조인 소프트). 단일 그래프로 generate 1번.
- **넘어간 이유**: **근본 한계 — 이 모든 게 "평면 원근 사진을 이어붙인 것"이지 360 카메라 사진의 투영 기하(곡선 지평선·바닥 nadir·천장 zenith·직선 휨)가 아님.** 사용자 지적으로 방향 전환.
- 코드: `gaze-panorama.js`(완성 단일 파일, `generateGazePanorama`/`buildGazePanoramaGraph`), `probe-gaze.mjs`.

---

## 12. ★ equirect-native (현재 채택) · 2026-07-19
- **방식**: Gemini에 "360 equirectangular panorama, 360 camera" 직접 요청 → **한 번의 호출로 진짜 360 기하**. gaze 구도(주인공 정면 0° + 응시 대상 반대편)도 한 프롬프트에 구성. 21:9 → **세로 중앙 crop으로 4:1**(눈높이 띠, nadir/zenith 제거).
- **이유**: 1~11번은 전부 원근 스티칭이라 진짜 360이 구조적으로 불가. equirect는 투영 자체가 하나의 연속 구.
- **결과**:
  - ✅ 진짜 360 기하(곡선 천장/바닥·방 wrap·immersive)
  - ✅ 리버스 뷰/응시 구도 한 장에서 성립(교사↔학생 양극)
  - ✅ 스티칭·조인·크로스페이드 전부 불필요, Gemini 1콜(~24s)
  - ✅ 전 생애 10나이대 generality 통과(놀이터·학교·자취방·야근·교단·공원·한옥 등)
  - 🟡 **wrap seam 미해결** — Gemini equirect의 좌우 끝이 진짜 주기적이지 않음(등 뒤 불연속). seamfix Flux Fill이 기둥 생성. → 후속: 엣지 구도(밋밋한 벽에 wrap 걸기) 또는 1번 SDXL SeamlessTile 봉합 패스.
  - 🟡 장면 내 간판 텍스트가 가끔 남음(NO_TEXT 강화 필요)
- **변환 규칙**: equirect(full sphere)는 세로 crop으로 4:1 만들기(가로 stretch 금지 — 왜곡). 실린더는 눈높이 띠만 보이므로(§4.1) crop이 정합.
- 코드: `probe-equirect.mjs`(--gaze/--ratio), `probe-equirect-seamfix.mjs`, `probe-equirect-ages.mjs`.
- **본선 배선**: life-library/admin에 equirect 모드 추가(진행 중).

---

### 관통하는 교훈
1. **평면 원근 스티칭 ≠ 360 파노라마.** 이음매를 아무리 다듬어도 투영 기하가 안 됨. (1~11번의 공통 한계.)
2. **서로 다른 두 이미지 사이 큰 갭은 어떤 모델로도 블러.** continuation(한쪽 고정)은 선명, gap-fill(양쪽 고정)은 블러.
3. **equirect 곡률은 결함이 아니라 올바른 360 기하.** 초기에 이걸 제거하려 한 게 우회의 시작이었다.
4. **wrap 주기성**은 Gemini가 보장 못 함 → SDXL circular padding(1번)이 유일한 구조적 보장.
