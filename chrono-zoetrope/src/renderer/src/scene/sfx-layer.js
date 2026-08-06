// 앰비언스 효과음 레이어 — 파노라마 대화 영상이 떠오를 때, 장면 설명 텍스트의 맥락에 맞는
// 환경음(아이들 웃음·파도·독서실 백색소음 등)을 배경음악 위에 한 겹 더 깐다.
//
// 동작: playForScene(장면 텍스트) → 키워드 매칭으로 /resources/sfx/<slug>.mp3 선택 →
//   페이드 인으로 loop 재생. 매칭이 없으면 아무것도 틀지 않는다(§1 침묵 폴백 — 억지로 깔지 않는다).
//   새 장면이 오면 이전 앰비언스는 페이드 아웃으로 교체, stop()은 페이드 아웃 후 정지.
//   play(slug, {gain}) → 키워드 매칭을 거치지 않고 특정 음원을 직접 지정(장례식 국면의 조문객
//   웅성거림처럼, 장면 텍스트가 아니라 국면 자체가 음원을 정하는 경우).
//
// 볼륨: BGM(MASTER 1.0)을 덮지 않게 한 겹 낮은 게인(SFX_GAIN)으로 깐다 — 배경의 배경.
// 실패는 조용히 삼킨다 — 파일 없음·디코드 실패·컨텍스트 불가면 앰비언스 없이 진행한다.

const SFX_GAIN = 0.5 //      level: BGM보다 한 겹 아래(배경의 배경)
const FADE_IN_SEC = 2.0
const FADE_OUT_SEC = 1.2
const LOOP_CROSSFADE_SEC = 2 // 루프 이음매 crossfade(bg-music과 같은 방식)

// 키워드 → 음원 슬러그. 위에서부터 검사해 먼저 맞은 것을 튼다 — 구체적인 것을 앞에 둔다.
// 파일: resources/sfx/<slug>.mp3 (없으면 조용히 스킵)
const SFX_TABLE = [
  // 인물·정서
  { slug: 'playground', kw: ['놀이터', '그네', '미끄럼틀', 'playground'] },
  {
    slug: 'children-laughter',
    kw: ['아이들', '어린이', '아기', '유치원', '어린 시절', '동생', 'children', 'kids']
  },
  {
    slug: 'celebration',
    kw: ['졸업', '결혼', '수상', '축하', '파티', '생일', 'wedding', 'graduation', 'party']
  },
  {
    slug: 'family-chatter',
    kw: ['가족', '식탁', '명절', '저녁 식사', '식사', '거실', 'family', 'dinner']
  },
  // 공간·일상
  { slug: 'study-room', kw: ['독서실', '자습', '공부', '수험', '고시', 'study'] },
  { slug: 'page-turning', kw: ['책', '독서', '도서관', '서재', 'book', 'library'] },
  { slug: 'classroom', kw: ['교실', '학교', '수업', '학창', '칠판', 'classroom', 'school'] },
  {
    slug: 'office-keyboard',
    kw: ['사무실', '회사', '직장', '출근', '컴퓨터', '업무', 'office', 'work']
  },
  { slug: 'cafe', kw: ['카페', '커피', 'cafe', 'coffee'] },
  { slug: 'cooking', kw: ['요리', '부엌', '주방', '밥상', '음식', 'cooking', 'kitchen'] },
  // 자연
  { slug: 'ocean-waves', kw: ['바다', '해변', '파도', '모래사장', 'beach', 'ocean', 'sea'] },
  { slug: 'stream', kw: ['계곡', '시냇물', '캠핑', 'stream', 'camping'] },
  {
    slug: 'forest-birds',
    kw: ['숲', '산', '공원', '소풍', '나무', '등산', 'forest', 'park', 'mountain']
  },
  { slug: 'rain', kw: ['비', '빗소리', '장마', '우산', 'rain'] },
  { slug: 'snow-wind', kw: ['눈', '겨울', '스키', '눈사람', 'snow', 'winter'] },
  // 장소·이동
  { slug: 'train', kw: ['기차', '지하철', '역', '여행', 'train', 'travel'] },
  { slug: 'market', kw: ['시장', '장보기', 'market'] },
  { slug: 'temple-bell', kw: ['절', '사찰', '성당', '교회', '종소리', 'temple', 'church'] },
  {
    slug: 'night-crickets',
    kw: ['밤', '여름밤', '시골', '고향', '귀뚜라미', '별', 'night', 'crickets']
  },
  { slug: 'city-traffic', kw: ['도시', '거리', '도심', '길거리', '버스', 'city', 'street'] }
]

// 장면 텍스트에 맞는 슬러그를 고른다. 없으면 null — 트지 않는다.
export function matchSfx(sceneText) {
  if (!sceneText) return null
  const t = String(sceneText).toLowerCase()
  for (const { slug, kw } of SFX_TABLE) {
    if (kw.some((k) => t.includes(k.toLowerCase()))) return slug
  }
  return null
}

const TRIM_MIN = 0.05
const TRIM_MAX = 3.0

export function createSfxLayer() {
  let ctx = null
  let trim = 1 // 런타임 배율(Z/X 키) — 각 음원의 기본 gain에 곱해진다.
  const buffers = new Map() // slug → AudioBuffer | null(로드 실패 기록 — 재시도 안 함)
  let current = null //        { slug, gain, sources[], loopTimer } — 재생 중인 앰비언스

  async function loadBuffer(slug) {
    if (buffers.has(slug)) return buffers.get(slug)
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)()
      // 슬러그에 공백 등이 들어갈 수 있다(파일명 그대로 지정하는 play()) — URL 인코딩해서 요청한다.
      const res = await fetch(`/resources/sfx/${encodeURIComponent(slug)}.mp3`)
      if (!res.ok) throw new Error(`fetch ${res.status}`)
      const buf = await ctx.decodeAudioData(await res.arrayBuffer())
      buffers.set(slug, buf)
      return buf
    } catch (e) {
      console.warn(`[sfx] '${slug}' 로드 실패 — 앰비언스 없이 진행:`, e?.message || e)
      buffers.set(slug, null)
      return null
    }
  }

  // 한 바퀴 소스를 예약하고 이음매 crossfade로 계속 돌린다(bg-music.scheduleLoop와 같은 방식).
  function scheduleLoop(layer, buffer, when) {
    if (current !== layer || !ctx) return
    const dur = buffer.duration
    const xf = Math.min(LOOP_CROSSFADE_SEC, dur / 2)
    const srcGain = ctx.createGain()
    srcGain.connect(layer.gain)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(srcGain)
    const g = srcGain.gain
    g.setValueAtTime(0, when)
    g.linearRampToValueAtTime(1, when + xf)
    g.setValueAtTime(1, when + dur - xf)
    g.linearRampToValueAtTime(0, when + dur)
    src.start(when)
    src.stop(when + dur + 0.05)
    layer.sources.push(src)
    src.onended = () => {
      layer.sources = layer.sources.filter((s) => s !== src)
      try {
        srcGain.disconnect()
      } catch {
        /* 무시 */
      }
    }
    const nextWhen = when + dur - xf
    layer.loopTimer = setTimeout(
      () => scheduleLoop(layer, buffer, nextWhen),
      Math.max(0, (nextWhen - ctx.currentTime) * 1000)
    )
  }

  function fadeOutAndKill(layer) {
    if (!layer || !ctx) return
    clearTimeout(layer.loopTimer)
    const now = ctx.currentTime
    const g = layer.gain.gain
    g.cancelScheduledValues(now)
    g.setValueAtTime(g.value, now)
    g.linearRampToValueAtTime(0, now + FADE_OUT_SEC)
    setTimeout(
      () => {
        for (const s of layer.sources) {
          try {
            s.stop()
          } catch {
            /* 무시 */
          }
        }
        try {
          layer.gain.disconnect()
        } catch {
          /* 무시 */
        }
      },
      FADE_OUT_SEC * 1000 + 100
    )
  }

  // 음원을 직접 지정해 페이드 인으로 깐다. 이미 같은 걸 틀고 있으면 유지, 다른 게 오면 교체
  // (이전은 페이드 아웃), slug가 null이면 이전 것만 걷는다.
  //  gain: 이 음원의 레벨(기본 SFX_GAIN). 음원마다 원본 크기가 달라 호출부가 조절한다.
  async function play(slug, { gain = SFX_GAIN } = {}) {
    if (current?.slug === slug) return // 같은 앰비언스 유지
    const prev = current
    current = null
    fadeOutAndKill(prev)
    if (!slug) return
    const buffer = await loadBuffer(slug)
    if (!buffer) return
    try {
      await ctx.resume()
    } catch {
      /* 무시 */
    }
    if (current) return // 로드 중 다른 장면이 끼어듦 — 그쪽이 이긴다
    const layer = { slug, baseGain: gain, gain: ctx.createGain(), sources: [], loopTimer: null }
    layer.gain.gain.setValueAtTime(0, ctx.currentTime)
    layer.gain.gain.linearRampToValueAtTime(gain * trim, ctx.currentTime + FADE_IN_SEC)
    layer.gain.connect(ctx.destination)
    current = layer
    scheduleLoop(layer, buffer, ctx.currentTime + 0.05)
    console.log(`[sfx] 앰비언스 재생: ${slug} (gain ${gain})`)
  }

  // 장면 텍스트에 맞는 앰비언스를 페이드 인으로 깐다(키워드 매칭 → play).
  function playForScene(sceneText) {
    return play(matchSfx(sceneText))
  }

  // Z/X 키 — 재생 중 앰비언스 음량 배율을 곱해 조절한다. 다음에 트는 음원에도 유지된다.
  // 반환: { trim, gain, playing, slug } — 호출부(HUD)가 현재 값을 표시한다.
  function nudgeVolume(factor) {
    trim = Math.max(TRIM_MIN, Math.min(TRIM_MAX, trim * factor))
    if (current && ctx) {
      const g = current.gain.gain
      const now = ctx.currentTime
      g.cancelScheduledValues(now)
      g.setValueAtTime(g.value, now)
      g.linearRampToValueAtTime(current.baseGain * trim, now + 0.1)
    }
    console.log(
      `[sfx] trim ×${trim.toFixed(2)}` +
        (current ? ` → '${current.slug}' 실효 gain ${(current.baseGain * trim).toFixed(3)}` : ' (재생 중인 앰비언스 없음)')
    )
    return {
      trim,
      gain: current ? current.baseGain * trim : null,
      playing: !!current,
      slug: current?.slug ?? null
    }
  }

  // 앰비언스를 페이드 아웃으로 걷는다 — 영상이 걷히거나 국면이 바뀔 때.
  function stop() {
    const prev = current
    current = null
    fadeOutAndKill(prev)
  }

  return { play, playForScene, stop, nudgeVolume, dispose: stop }
}
