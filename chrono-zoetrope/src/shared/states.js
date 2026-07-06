// 주마등 상태 기계 상태 정의 (CLAUDE.md §6). main·renderer 공유.

export const State = Object.freeze({
  IDLE: 'IDLE', //        대기. 다음 사용자를 기다린다.
  ENTRY: 'ENTRY', //      사용자 진입, 리프트 상승. 라이브러리 사전생성 시작.
  ZOETROPE: 'ZOETROPE', // 주마등 몽타주 재생. 멈춤 입력 대기.
  FREEZE: 'FREEZE', //    멈춤 수신. 현재 순간 포착, 재생성 요청.
  REGEN_WAIT: 'REGEN_WAIT', // AI 재생성 대기. 해석적 기다림의 의례.
  IMMERSION: 'IMMERSION', //   1인칭 view 표시. 자막·해설 없음.
  EXIT: 'EXIT' //         퇴장, 리프트 하강. 종료 후 IDLE 복귀.
})

// 허용 전이 그래프. 여기 없는 전이는 상태 기계가 거부한다.
export const Transitions = Object.freeze({
  [State.IDLE]: [State.ENTRY],
  [State.ENTRY]: [State.ZOETROPE, State.EXIT],
  [State.ZOETROPE]: [State.FREEZE, State.EXIT],
  [State.FREEZE]: [State.REGEN_WAIT],
  [State.REGEN_WAIT]: [State.IMMERSION, State.EXIT],
  [State.IMMERSION]: [State.ZOETROPE, State.EXIT],
  [State.EXIT]: [State.IDLE]
})
