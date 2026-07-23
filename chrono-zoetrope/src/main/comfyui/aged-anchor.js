// 2단계 얼굴 앵커 파이프라인의 A단계 — "그 나이의 얼굴" 포트레이트 생성·캐시.
//
// 왜 2단계인가: 파노라마 장면은 4:1 equirect(4096×1024)라 주인공 얼굴이 프레임의 1/6~1/8로
// 작고 구형 투영으로 휜다. 그 작고 왜곡된 얼굴 안에서 "정체성 보존 + 나이 변환"을 flash가 한 번에
// 하려니 미래(aging) 장면이 딴사람으로 드리프트했다. 게다가 파노라마 비율(4:1)은 pro가 거부해
// 장면은 flash로만 뽑힌다 — 정체성·aging에 가장 강한 pro를 장면엔 못 쓴다.
//
// 해법: aging을 장면에서 떼어내 pro 전용 단계로 분리한다. 얼굴 앵커 사진 한 장을 pro로 3:4 근접
// 프레임에서 "그 나이의 같은 사람" 포트레이트로 먼저 크게 뽑는다(얼굴 꽉, 장면·왜곡 없음 = pro가
// 빛나는 조건). 그 포트레이트를 파노라마 단계(flash 4:1)의 레퍼런스로 넘기고, 프롬프트는
// "이 얼굴로 aging해"가 아니라 "이게 그 나이 얼굴, 그대로 유지해"(KEEP_FACE)로 바꾼다. 그러면
// flash는 aging을 안 하고 건네받은 얼굴을 배치만 한다 — 작게 그려도 "얼굴 복사"는 "얼굴 발명"보다
// 훨씬 안정적으로 정체성이 남는다.
//
// 나이별 포트레이트는 _aged/{age}.png로 캐시한다. perStage 3장이 같은 나이 앵커를 공유하고,
// 재생성(admin)도 이 캐시를 재사용하므로 pro 호출은 나이당 딱 1번(재과금 없음).

import fs from 'node:fs/promises'
import path from 'node:path'
import { composeAgedPortraitPrompt } from './prompt-builder.js'
import { ADULT_MIN_AGE } from './face-anchor.js'

// persona 디렉토리 하위, 나이별 aged 포트레이트 캐시 폴더.
export const AGED_DIR = '_aged'

/**
 * aged 포트레이트 하나를 확보한다. 캐시(_aged/{age}.png)가 있으면 그대로 재사용(재과금 없음),
 * 없고 앵커 얼굴(faceBuf)이 있으면 pro 모델로 "그 나이 얼굴"을 생성해 저장한다.
 *
 * @param {object} p
 * @param {import('./gemini-client.js').GeminiClient} p.gclient  pro 모델 클라이언트
 * @param {Buffer|null} p.faceBuf     앵커 얼굴 사진 바이트 (캐시 미스일 때만 필요)
 * @param {object} p.profile          { gender? } — 포트레이트 명사(subjectNoun)용
 * @param {number} p.age              목표 나이
 * @param {boolean} p.isPast          과거(젊게) / 미래(늙게) 방향 — 문구만 다르고 특징은 age가 결정
 * @param {string} p.personaDir       persona 라이브러리 절대경로 (여기 밑에 _aged/ 생성)
 * @param {string} [p.model]          pro 모델 id (미지정이면 gclient 기본)
 * @param {string} [p.imageSize]      '1K'|'2K'|'4K'
 * @param {AbortSignal} [p.signal]
 * @param {(m:string)=>void} [p.log]
 * @returns {Promise<{buffer:Buffer, path:string, cached:boolean}|null>}
 *   path는 persona 디렉토리 기준 상대경로(_aged/{age}.png) — manifest.referenceFile로 그대로 기록·재사용.
 *   캐시도 없고 faceBuf도 없으면 null(생성 불가 → 호출부가 폴백).
 */
export async function agedPortrait({
  gclient,
  faceBuf,
  profile,
  age,
  isPast,
  personaDir,
  model,
  imageSize = '2K',
  signal,
  log = () => {}
}) {
  const relPath = path.posix.join(AGED_DIR, `${age}.png`)
  const absPath = path.join(personaDir, AGED_DIR, `${age}.png`)

  // 1) 캐시 히트 — pro 재호출 없이 재사용.
  try {
    const buffer = await fs.readFile(absPath)
    return { buffer, path: relPath, cached: true }
  } catch {
    /* 캐시 미스 → 생성 시도 */
  }

  // 2) 앵커 얼굴이 없으면 생성 불가(다른 머신 hydrate 등) — 호출부가 폴백 처리.
  if (!faceBuf || !gclient) return null

  const data = await gclient.generateImage({
    prompt: composeAgedPortraitPrompt(profile || {}, age, { isPast }),
    references: [faceBuf],
    aspectRatio: '3:4', // 근접 세로 포트레이트 — pro가 지원한다(pro가 거부하는 건 4:1·8:1 초광각뿐)
    imageSize,
    model, // pro (gemini-3-pro-image)
    signal
  })
  await fs.mkdir(path.dirname(absPath), { recursive: true })
  await fs.writeFile(absPath, data)
  log(`  🧑 aged 포트레이트 생성: ${age}세 ${isPast ? '(과거·젊게)' : '(미래·늙게)'}`)
  return { buffer: data, path: relPath, cached: false }
}

/**
 * 생성 프리패스 — 플랜에서 aging이 필요한 고유 성인 나이마다 aged 포트레이트를 미리 확보해
 * Map<age,{buffer,path}>로 돌려준다. 생성 루프의 referencesFor(동기)가 이 맵을 나이로 조회한다.
 * 한 나이당 pro 1콜(캐시 히트면 0), perStage 장면들이 공유한다.
 *
 * @param {object} p
 * @param {import('./gemini-client.js').GeminiClient|null} p.gclient
 * @param {{buffer:Buffer, path:string}|null} p.faceRef  앵커 얼굴(가장 최근 제출 사진)
 * @param {object} p.profile        { gender? }
 * @param {Array<{age:number, isPast:boolean}>} p.plan   장면 플랜
 * @param {string} p.personaDir
 * @param {string} [p.model] @param {string} [p.imageSize] @param {AbortSignal} [p.signal]
 * @param {(m:string)=>void} [p.log]
 * @param {(item:object)=>boolean} [p.needsAged]  이 장면이 aged 앵커가 필요한가
 *   (스테이지 실제 사진이 있는 나이는 제외 — 그 나이는 실제 사진을 앵커로 쓰므로 aging 불필요).
 * @returns {Promise<Map<number,{buffer:Buffer, path:string}>>}
 */
export async function prepareAgedAnchors({
  gclient,
  faceRef,
  profile,
  plan,
  personaDir,
  model,
  imageSize,
  signal,
  log = () => {},
  needsAged
}) {
  const byAge = new Map()
  if (!faceRef || !gclient) return byAge

  // aging이 필요한 고유 성인 나이 집합(나이→isPast는 결정론적이라 첫 등장 값으로 충분).
  const ages = []
  const seen = new Set()
  for (const item of plan || []) {
    if (item.age < ADULT_MIN_AGE) continue
    if (needsAged && !needsAged(item)) continue
    if (seen.has(item.age)) continue
    seen.add(item.age)
    ages.push({ age: item.age, isPast: !!item.isPast })
  }

  for (const { age, isPast } of ages) {
    if (signal?.aborted) break
    try {
      const r = await agedPortrait({
        gclient,
        faceBuf: faceRef.buffer,
        profile,
        age,
        isPast,
        personaDir,
        model,
        imageSize,
        signal,
        log
      })
      if (r) byAge.set(age, { buffer: r.buffer, path: r.path })
    } catch (e) {
      // 한 나이 실패가 전체를 막지 않게 — 그 나이는 맵에 없어 selectSceneReference가 구 aging 폴백('anchor')으로 처리.
      log(`  ⚠ aged 포트레이트 실패(${age}세, aging 폴백으로): ${e.message}`)
    }
  }
  return byAge
}

/**
 * 재생성 경로(admin) — aging 성인 장면(referenceKind 'anchor' 또는 'aged')이면 그 나이의 aged
 * 포트레이트를 확보(없으면 pro로 1회 생성·캐시)하고 entry.referenceFile/referenceKind를 'aged'로
 * 업그레이드한다. 그러면 호출부의 prefixForEntry가 KEEP_FACE를, loadEntryReference가 포트레이트를
 * 싣게 된다. **기존 persona(구 'anchor' entry)를 전체 재생성 한 번으로 2단계 방식으로 옮기는 지점.**
 *
 * @param {object} p
 * @param {import('./gemini-client.js').GeminiClient} p.gclient  pro 모델 클라이언트
 * @param {string} p.personaDir
 * @param {object} p.entry     manifest.images 항목(제자리 변형됨)
 * @param {object} p.profile   manifest.profile ({ gender? })
 * @param {string} [p.model] @param {string} [p.imageSize] @param {AbortSignal} [p.signal]
 * @param {(m:string)=>void} [p.log]
 * @returns {Promise<boolean>}  entry를 'aged'로 업그레이드했으면 true
 */
export async function ensureEntryAgedAnchor({
  gclient,
  personaDir,
  entry,
  profile,
  model,
  imageSize,
  signal,
  log = () => {}
}) {
  if (!entry || entry.age < ADULT_MIN_AGE) return false
  if (entry.referenceKind === 'stage') return false // 실제 사진 장면 — aging 안 함
  if (entry.referenceKind !== 'anchor' && entry.referenceKind !== 'aged') return false

  // 앵커 얼굴 바이트: 구 'anchor' entry는 referenceFile이 원본 얼굴을 가리킨다(덮어쓰기 전에 읽는다).
  // 'aged' entry는 이미 포트레이트를 가리키므로 캐시 히트를 노린다(원본 얼굴 불필요).
  let faceBuf = null
  if (entry.referenceKind === 'anchor' && entry.referenceFile) {
    try {
      faceBuf = await fs.readFile(path.join(personaDir, entry.referenceFile))
    } catch {
      /* 원본 얼굴 없음(다른 머신 hydrate) → 캐시만 시도, 없으면 폴백 유지 */
    }
  }

  const r = await agedPortrait({
    gclient,
    faceBuf,
    profile,
    age: entry.age,
    isPast: !!entry.isPast,
    personaDir,
    model,
    imageSize,
    signal,
    log
  })
  if (!r) return false // 캐시도 없고 앵커 얼굴도 없음 → 업그레이드 불가(기존 참조·폴백 유지)

  entry.referenceFile = r.path
  entry.referenceKind = 'aged'
  return true
}
