// IPC 채널명 상수. main·preload·renderer 공유해 오타로 인한 배선 오류를 막는다.

export const Channels = Object.freeze({
  // renderer → main (invoke/handle): 창 부트스트랩 config 요청.
  BOOTSTRAP: 'zoetrope:bootstrap',

  // main → renderer (send): 상태 전이 브로드캐스트. payload: { state, prev }
  STATE: 'zoetrope:state',

  // main → renderer (send): 콘텐츠 포인터. payload: { panoramaId, montageFrameIndex, playing }
  CONTENT: 'zoetrope:content',

  // main → renderer (send): 리프트 신호. payload: { position, horizonLock } — Phase 1 미사용, §9 미결.
  LIFT: 'zoetrope:lift',

  // FREEZE 배리어 (§7).
  FREEZE_PREPARE: 'zoetrope:freeze-prepare', // main → renderer: { panoramaId, frame }
  FREEZE_READY: 'zoetrope:freeze-ready', //     renderer → main: { projectorIndex }
  FREEZE_COMMIT: 'zoetrope:freeze-commit', //   main → renderer: 동시 스왑

  // renderer(창0) → main: gamepad 버튼 이벤트. payload: { action } — 'stopEnter' | 'resumeExit'
  INPUT: 'zoetrope:input',

  // 개발용 뷰 토글 (설치 런타임 동작과 무관). §4.1 프로젝터 예왜곡 렌더 ↔ 펼친 파노라마 프리뷰.
  VIEW_TOGGLE: 'zoetrope:view-toggle', // renderer → main: 아무 창에서 V 누름
  VIEW_MODE: 'zoetrope:view-mode', //    main → renderer(전 창 동시): { preview: boolean }

  // 재생/정지(Space). main이 유효 시간 모델을 소유·브로드캐스트해 4창 동기(§7). Phase 3 FREEZE 선행.
  PLAY_STATE: 'zoetrope:play-state', //   main → renderer(전 창 동시): { playing, offset, frozenEff }

  // IMMERSION 영상 배리어 (§7 FREEZE 배리어와 같은 패턴 — 4창이 같은 순간에 재생을 시작해야 한다).
  VIDEO_PREPARE: 'zoetrope:video-prepare', // main → renderer: { url, imageId } — 프리로드 지시
  VIDEO_READY: 'zoetrope:video-ready', //     renderer → main: { projectorIndex } — 재생 가능 보고
  VIDEO_COMMIT: 'zoetrope:video-commit', //   main → renderer: { startAtMs } — 벽시계 기준 동시 시작

  // 서버 → 페이지: 참가자(페르소나) 교체 등으로 재생목록이 바뀌었으니 페이지를 새로 부트스트랩하라.
  // Electron에서는 webContents.reload()였다. 웹앱에선 SSE로 알려 페이지가 location.reload().
  RELOAD: 'zoetrope:reload',

  // 서버 → 페이지: reel 데모 시퀀스(테스트 경험). payload: { phase: 'spinup'|'reel', url?, spinupMs? }
  // spinup=주황 실타래 회전 가속, reel=사전 빌드 reel.mp4 1회 재생 후 멈춤. (§1 긴장 有 — 되돌릴 수 있는 테스트 경로)
  REEL_DEMO: 'zoetrope:reel-demo'
})

export const InputAction = Object.freeze({
  STOP_ENTER: 'stopEnter', //   ZOETROPE → FREEZE
  RESUME_EXIT: 'resumeExit' //  IMMERSION → ZOETROPE 또는 EXIT
})
