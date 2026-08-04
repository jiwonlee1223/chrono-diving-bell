# 앰비언스 효과음 (sfx-layer)

대화 영상(파노라마)이 떠오를 때, 장면 설명 텍스트의 맥락에 맞는 환경음을 배경음악 위에
한 겹 더 까는 레이어(`src/renderer/src/scene/sfx-layer.js`)가 이 폴더의 파일을 쓴다.

- 파일명은 아래 슬러그 그대로 `<slug>.mp3` — 파일이 없으면 그 앰비언스는 조용히 스킵된다.
- **루프 가능한 앰비언스**로 준비할 것(10~30초, 이음매는 코드가 crossfade 처리하므로 대략 균질하면 됨).
- 원샷 효과음(예: 박수 한 번)보다 지속되는 배경음 형태가 좋다.
- 무료 소스: Pixabay Sound Effects, Freesound(CC0 필터).

## 파일 목록 (20)

인물·정서
- `children-laughter.mp3` — 아이들 웃음소리
- `playground.mp3` — 놀이터 (뛰노는 소리 + 웃음)
- `family-chatter.mp3` — 식탁/거실 웅성거림, 식기 소리
- `celebration.mp3` — 박수·환호 (졸업·결혼·파티)

공간·일상
- `study-room.mp3` — 독서실 백색소음 (연필 사각거림)
- `page-turning.mp3` — 간간이 책장 넘어가는 조용한 방
- `classroom.mp3` — 교실 웅성거림·분필 소리
- `office-keyboard.mp3` — 키보드 타이핑·사무실 소음
- `cafe.mp3` — 카페 (커피머신, 잔잔한 대화)
- `cooking.mp3` — 도마질·지글거림

자연
- `ocean-waves.mp3` — 파도
- `forest-birds.mp3` — 새소리·나뭇잎 바람
- `rain.mp3` — 빗소리
- `stream.mp3` — 시냇물
- `snow-wind.mp3` — 겨울 바람·눈 밟는 소리

장소·이동
- `city-traffic.mp3` — 도시 거리 소음
- `train.mp3` — 기차
- `market.mp3` — 시장 활기
- `temple-bell.mp3` — 종소리 (사찰/성당)
- `night-crickets.mp3` — 귀뚜라미·여름밤

키워드 매칭 규칙은 `sfx-layer.js`의 `SFX_TABLE`에 있다 — 장면 텍스트에 새 표현이 자주 보이면
그쪽 키워드를 늘리면 된다.
