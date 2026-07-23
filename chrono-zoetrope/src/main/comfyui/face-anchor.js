// 얼굴 앵커 규칙 — 생성(profile-worker)과 재생성(admin-server)이 "장면마다 어떤 실제 사진을
// 레퍼런스로 실을지, 프롬프트에 어떤 나이 변환 지시를 붙일지"를 같은 규칙으로 쓰게 한 곳에 모은다.
// 두 경로가 어긋나면(생성 땐 얼굴 앵커, 재생성 땐 레퍼런스 없음) "프롬프트는 첨부를 쓰라는데 첨부가
// 없는" 불일치가 생기므로, 규칙을 여기서 단일 정의한다.
//
// 규칙:
//  (1) 그 순간의 실제 제출 사진(stageRef)이 있으면 그걸 실어 실제 얼굴·실제 장소를 그대로 변형한다
//      (과거·아동 커버). 프롬프트엔 REFERENCE_PHOTO_PREFIX.
//  (2) 없고 성인 나이(ADULT_MIN_AGE 이상)면 — 2단계 앵커. 그 나이의 aged 포트레이트(aged-anchor.js가
//      pro로 미리 뽑아 캐시한 "그 나이 얼굴")가 있으면 그걸 앵커로 실어 얼굴을 '유지'만 시킨다
//      (aging은 포트레이트 단계에서 끝남). 프롬프트엔 KEEP_FACE_PREFIX. 포트레이트가 없으면(구경로·
//      실패) 현재 얼굴(faceRef) + 나이 변환 단일패스로 폴백. 프롬프트엔 ageAnchorPrefix.
//  (3) 없고 아동 나이면 앵커 없이 텍스트로 — 성인 얼굴을 아동으로 de-age하다 Gemini IMAGE_SAFETY에
//      걸리는 걸 피한다(그 나이 실제 사진이 있으면 (1)에서 이미 걸린다).

// 이 나이 이상만 "현재 얼굴 앵커"로 나이 변환을 건다(미만은 아동 — de-age 세이프티 회피).
export const ADULT_MIN_AGE = 18

// 그 순간의 실제 사진 접두어 — 얼굴(정체성)과 실제 장소·사물은 살리되, 복장·표정·자세는 장면에서
// 그 인물이 하는 행동에 맞게 조정되게 한다(사진을 납작하게 복사하지 않게).
export const REFERENCE_PHOTO_PREFIX =
  'The attached photograph is a real photo of this moment. Use it as the source for this person’s facial identity and for the real place, objects and colors of the scene, keeping them recognizable. ' +
  'But their clothing, facial expression and pose should follow what the person is actively doing in this reimagined 360° scene, not be flatly copied from the photo. '

// aged 포트레이트(2단계 A단계 결과)를 레퍼런스로 실을 때 앞에 붙이는 지시. 포트레이트는 '이미 그
// 나이의 그 사람'이므로 여기서는 aging을 시키지 않는다 — 그 얼굴·그 나이를 그대로 유지시키기만
// 한다. 파노라마(flash)는 좁은 프레임 안에서 얼굴을 '복사'만 하면 되어, '정체성 보존+aging'을
// 동시에 하는 단일패스(ageAnchorPrefix)보다 훨씬 안정적으로 같은 사람이 유지된다. 배경/프레이밍은
// 포트레이트의 중립 스튜디오라 장면으로 밀어내야 한다.
export const KEEP_FACE_PREFIX =
  'The attached portrait already shows this scene’s main subject at exactly the right age. ' +
  'Give the central person of this scene that SAME face, likeness and apparent age — identical facial identity, ' +
  'unmistakably the same individual; do NOT re-age them, do not make them look any younger or older than the portrait. ' +
  'Do NOT copy the portrait’s plain studio background, its framing, its clothing, expression or pose — those must all ' +
  'follow THIS scene and what the person is actively doing here; only their face and apparent age carry over from the portrait. '

// 현재 얼굴을 앵커로 실을 때 앞에 붙이는 지시. **얼굴(정체성)만** 참조하고 복장·표정·자세·헤어·배경은
// 장면 맥락을 따르게 한다(사진의 옷·표정을 그대로 복사하지 않게). item.isPast면 그 나이로 젊게,
// 아니면 미래로 자연스럽게 늙힌다. item은 { age, isPast }만 있으면 되므로 manifest 항목에도 그대로 쓴다.
// (aged 포트레이트가 준비되면 selectSceneReference가 KEEP_FACE_PREFIX/'aged'를 먼저 쓰고, 이건
//  포트레이트가 없을 때의 단일패스 폴백이다.)
export function ageAnchorPrefix(item) {
  const dir = item.isPast
    ? `as they looked at ${item.age} years old`
    : `naturally aged to ${item.age} years old as they would realistically look in the future`
  return (
    "The attached photograph is a reference ONLY for this person's facial identity — their face, distinctive features and likeness. " +
    `Give the main subject of this scene that SAME face and identity, ${dir}, unmistakably the same individual. ` +
    "Do NOT copy the photograph's clothing, facial expression, pose, hairstyle or background — those must all follow THIS scene and what the person is actively doing here, not the reference photo. "
  )
}

/**
 * 장면 하나의 레퍼런스·프롬프트 접두어를 규칙대로 고른다.
 *  (1) 그 순간의 실제 제출 사진(stageRef) → 그걸 그대로 변형(REFERENCE_PHOTO_PREFIX, 'stage').
 *  (2) 성인 나이 + 그 나이 aged 포트레이트가 준비됨(agedRefFor) → 포트레이트를 앵커로, aging은
 *      이미 끝났으니 '얼굴 유지'만(KEEP_FACE_PREFIX, 'aged'). ← 2단계 파이프라인의 기본 경로.
 *  (3) 성인 나이 + 포트레이트 없음(구경로/실패) → 현재 얼굴 + 나이 변환 단일패스 폴백
 *      (ageAnchorPrefix, 'anchor').
 *  (4) 그 외(아동 등) → 앵커 없이 텍스트('none').
 * @param {{age:number, isPast:boolean}} item
 * @param {object} cands
 * @param {{buffer?:Buffer, path?:string}|null} [cands.stageRef]  그 순간의 실제 제출 사진(있으면)
 * @param {{buffer?:Buffer, path?:string}|null} [cands.faceRef]   현재 얼굴 앵커(가장 최근 제출 사진)
 * @param {((age:number)=>({buffer?:Buffer, path?:string}|null))|null} [cands.agedRefFor]
 *        그 나이의 미리 만든 aged 포트레이트를 돌려주는 조회 함수(없으면 null → 폴백).
 * @returns {{ reference:{buffer?:Buffer, path?:string}|null, prefix:string, kind:'stage'|'aged'|'anchor'|'none' }}
 */
export function selectSceneReference(item, { stageRef = null, faceRef = null, agedRefFor = null } = {}) {
  if (stageRef) return { reference: stageRef, prefix: REFERENCE_PHOTO_PREFIX, kind: 'stage' }
  if (item.age >= ADULT_MIN_AGE) {
    const aged = agedRefFor ? agedRefFor(item.age) : null
    if (aged) return { reference: aged, prefix: KEEP_FACE_PREFIX, kind: 'aged' }
    if (faceRef) return { reference: faceRef, prefix: ageAnchorPrefix(item), kind: 'anchor' }
  }
  return { reference: null, prefix: '', kind: 'none' }
}

/**
 * 저장된 manifest 항목(버퍼가 손에 없는 재생성·성별수정)에서 프롬프트 접두어를 되살린다.
 * 생성 때 기록해둔 entry.referenceKind로 어떤 규칙이 적용됐는지 안다.
 * @param {{referenceKind?:string, age:number, isPast:boolean}} entry
 * @returns {string}
 */
export function prefixForEntry(entry) {
  if (entry.referenceKind === 'stage') return REFERENCE_PHOTO_PREFIX
  if (entry.referenceKind === 'aged') return KEEP_FACE_PREFIX
  if (entry.referenceKind === 'anchor') return ageAnchorPrefix(entry)
  return ''
}
