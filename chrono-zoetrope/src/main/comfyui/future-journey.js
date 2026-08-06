// 미래 인생그래프 요약 업로드 — 부정미래(2차 'future' 릴)/긍정미래(3차 'branched' 릴)의
// 릴 이미지 URL + 한국어 title·30자 상황 설명을 futureLifeJourneyGraph 정본에 올린다.
//
// 흐름:
//   1) manifest의 릴 배열(reelPhotosFuture / reelPhotosBranched)에서 성공 장만 추린다.
//   2) 이미지 URL은 generatedReelImage 정본에서 가져온다(릴 생성 직후 uploadPersonaReelPhotos가
//      올려둔 것). 아직 안 올라간 장이 있으면 여기서 한 번 올리고 다시 읽는다 — 바이트를
//      중복 업로드하지 않는다.
//   3) title·30자 설명은 Gemini 텍스트 모델이 장면(scene, 영어)에서 한국어로 뽑는다.
//      §미래 방향성 대비(2026-08-05): 부정/긍정 어느 쪽이든 잘됨/못됨 판정 어휘 없이
//      장면에 담긴 사실만 담백하게 쓴다. 실패 시 나이·연도 기반 폴백으로 계속 간다(best-effort).
//   4) upsertFutureLifeJourney가 사용자별 1문서의 negative/positive 필드에 merge 기록한다.

import { reelVariantLabel } from './reel-photos.js'
import {
  fetchPersonaReelPhotos,
  uploadPersonaReelPhotos,
  upsertFutureLifeJourney,
  futureJourneyBranchKey
} from './firestore-source.js'

const DESCRIPTION_MAX = 30

/** Gemini에 12장 장면을 한 번에 넘겨 한국어 title·설명(30자 이내)을 JSON으로 받는 프롬프트. */
function buildCaptionPrompt(profile, entries) {
  const list = entries
    .map((e) => `- id "${e.id}" (${e.age}세, ${e.year}년): ${e.scene || '(장면 설명 없음)'}`)
    .join('\n')
  return [
    `아래는 ${profile.name}의 미래 인생 장면 이미지 목록이다. 각 장면은 영어로 적혀 있다.`,
    `각 장면마다 한국어로 다음 둘을 만들어라:`,
    `1) title — 그 장면을 한눈에 알아볼 짧은 제목(12자 이내).`,
    `2) description — 이미지가 담고 있는 상황 설명. 반드시 공백 포함 ${DESCRIPTION_MAX}자 이내의 한국어 한 문장.`,
    `규칙: 잘됐다/못됐다 같은 평가·판정 어휘 없이, 장면에 담긴 사실만 담백하게 현재형으로 쓴다.`,
    `이름은 넣지 않는다. 나이·장소·행동 같은 구체 사실을 우선한다.`,
    ``,
    `장면 목록:`,
    list,
    ``,
    `JSON 배열로만 답하라. 각 원소는 {"id": "...", "title": "...", "description": "..."} 형식.`
  ].join('\n')
}

/** generateText 원문에서 JSON 배열을 꺼낸다 — 코드펜스·잡설이 섞여도 첫 배열만 취한다. */
function parseCaptionJson(raw) {
  const text = String(raw).trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) throw new Error('JSON 배열을 찾지 못함')
  const arr = JSON.parse(text.slice(start, end + 1))
  if (!Array.isArray(arr)) throw new Error('배열이 아님')
  return arr
}

/** 캡션 생성 — id → {title, description}. 실패하면 빈 Map(호출부가 폴백으로 채운다). */
async function generateCaptions({ profile, entries, gclient, log }) {
  try {
    const raw = await gclient.generateText({
      prompt: buildCaptionPrompt(profile, entries),
      responseJson: true
    })
    const byId = new Map()
    for (const c of parseCaptionJson(raw)) {
      if (!c?.id) continue
      byId.set(String(c.id), {
        title: String(c.title || '').trim(),
        description: String(c.description || '')
          .trim()
          .slice(0, DESCRIPTION_MAX)
      })
    }
    return byId
  } catch (err) {
    log(`  [경고] 요약 캡션 생성 실패 — 폴백 문구로 진행: ${err.message}`)
    return new Map()
  }
}

/**
 * 한 분기(부정/긍정)의 미래 릴을 futureLifeJourneyGraph에 올린다.
 * @param {object} p
 * @param {object} p.profile     { name, birthDate, age? }
 * @param {string} p.personaId
 * @param {string} p.dir         library/<pid> 절대경로 — 미업로드 장을 올릴 때만 쓴다
 * @param {Array}  p.reelPhotos  manifest의 릴 배열(reelPhotosFuture | reelPhotosBranched)
 * @param {import('./gemini-client.js').GeminiClient} p.gclient
 * @param {'future'|'branched'} [p.variant='future']  future=부정미래(2차) / branched=긍정미래(3차)
 * @param {(m:string)=>void} [p.log]
 * @returns {Promise<{skipped?:boolean, key?:string, branch:string, count:number}>}
 */
export async function uploadFutureLifeJourney({
  profile,
  personaId,
  dir,
  reelPhotos,
  gclient,
  variant = 'future',
  log = () => {}
}) {
  const branch = futureJourneyBranchKey(variant)
  const label = reelVariantLabel(variant)
  const entries = (reelPhotos || []).filter((e) => !e.failed && e.file)
  if (!entries.length) {
    log(`  [요약] ${label}: 성공한 릴 이미지가 없다 — 건너뜀`)
    return { skipped: true, branch, count: 0 }
  }

  // 이미지 URL 확보 — generatedReelImage 정본(variant 하위 맵)의 최신 목록에서 id로 찾는다.
  const readUrls = async () => {
    const docData = await fetchPersonaReelPhotos(profile)
    const list = docData?.[variant]?.reelPhotos || []
    return new Map(list.map((e) => [e.id, e]))
  }
  let urlById = await readUrls()
  if (entries.some((e) => !urlById.get(e.id)?.url)) {
    log(`  [요약] ${label}: Storage에 없는 장이 있다 — 릴 이미지 업로드 후 진행`)
    await uploadPersonaReelPhotos({ profile, personaId, dir, reelPhotos: entries, variant })
    urlById = await readUrls()
  }

  const captions = await generateCaptions({ profile, entries, gclient, log })

  const items = []
  for (const e of entries) {
    const up = urlById.get(e.id)
    if (!up?.url) {
      log(`  [경고] ${label} ${e.id}: 이미지 URL 확보 실패 — 이 장은 제외`)
      continue
    }
    const cap = captions.get(e.id)
    items.push({
      id: e.id,
      idx: e.idx ?? null,
      age: e.age,
      year: e.year,
      title: cap?.title || `${e.age}세의 미래`,
      description:
        cap?.description || `${e.year}년, ${e.age}세의 한 장면`.slice(0, DESCRIPTION_MAX),
      imageURL: up.url,
      storagePath: up.storagePath ?? null,
      scene: e.scene ?? null // 캡션의 근거(영어 원문) — 재생성·검수용 기록
    })
  }
  if (!items.length) throw new Error(`${label}: 올릴 항목이 없다(이미지 URL 전부 실패)`)

  const r = await upsertFutureLifeJourney({ profile, personaId, variant, items })
  log(
    `  [Firebase] ${label} 인생그래프 요약 ${r.count}장 기록 ('futureLifeJourneyGraph'/${r.key}.${r.branch})`
  )
  return r
}
