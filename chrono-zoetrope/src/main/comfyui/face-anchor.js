// 얼굴 앵커 규칙 — 생성(profile-worker)과 재생성(admin-server)이 "장면마다 어떤 실제 사진을
// 레퍼런스로 실을지, 프롬프트에 어떤 나이 변환 지시를 붙일지"를 같은 규칙으로 쓰게 한 곳에 모은다.
// 두 경로가 어긋나면(생성 땐 얼굴 앵커, 재생성 땐 레퍼런스 없음) "프롬프트는 첨부를 쓰라는데 첨부가
// 없는" 불일치가 생기므로, 규칙을 여기서 단일 정의한다.
//
// 규칙:
//  (1) 그 순간의 실제 제출 사진(stageRef)이 있으면 그걸 실어 실제 얼굴·실제 장소를 그대로 변형한다
//      (과거·아동 커버). 프롬프트엔 REFERENCE_PHOTO_PREFIX.
//  (2) 없고 성인 나이(ADULT_MIN_AGE 이상)면 현재 얼굴(faceRef)을 앵커로 실어 같은 인물을 그 나이로
//      변환한다(과거=젊게, 미래=늙게). 프롬프트엔 ageAnchorPrefix.
//  (3) 없고 아동 나이면 앵커 없이 텍스트로 — 성인 얼굴을 아동으로 de-age하다 Gemini IMAGE_SAFETY에
//      걸리는 걸 피한다(그 나이 실제 사진이 있으면 (1)에서 이미 걸린다).

// 이 나이 이상만 "현재 얼굴 앵커"로 나이 변환을 건다(미만은 아동 — de-age 세이프티 회피).
export const ADULT_MIN_AGE = 18

// 그 순간의 실제 사진 접두어 — 얼굴(정체성)과 실제 장소·사물은 살리되, 복장·표정·자세는 장면에서
// 그 인물이 하는 행동에 맞게 조정되게 한다(사진을 납작하게 복사하지 않게).
export const REFERENCE_PHOTO_PREFIX =
  'The attached photograph is a real photo of this moment. Use it as the source for this person’s facial identity and for the real place, objects and colors of the scene, keeping them recognizable. ' +
  'But their clothing, facial expression and pose should follow what the person is actively doing in this reimagined 360° scene, not be flatly copied from the photo. '

// 현재 얼굴을 앵커로 실을 때 앞에 붙이는 지시. **얼굴(정체성)만** 참조하고 복장·표정·자세·헤어·배경은
// 장면 맥락을 따르게 한다(사진의 옷·표정을 그대로 복사하지 않게). item.isPast면 그 나이로 젊게,
// 아니면 미래로 자연스럽게 늙힌다. item은 { age, isPast }만 있으면 되므로 manifest 항목에도 그대로 쓴다.
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
 * @param {{age:number, isPast:boolean}} item
 * @param {object} cands
 * @param {{buffer?:Buffer, path?:string}|null} [cands.stageRef]  그 순간의 실제 제출 사진(있으면)
 * @param {{buffer?:Buffer, path?:string}|null} [cands.faceRef]   현재 얼굴 앵커(가장 최근 제출 사진)
 * @returns {{ reference:{buffer?:Buffer, path?:string}|null, prefix:string, kind:'stage'|'anchor'|'none' }}
 */
export function selectSceneReference(item, { stageRef = null, faceRef = null } = {}) {
  if (stageRef) return { reference: stageRef, prefix: REFERENCE_PHOTO_PREFIX, kind: 'stage' }
  if (faceRef && item.age >= ADULT_MIN_AGE)
    return { reference: faceRef, prefix: ageAnchorPrefix(item), kind: 'anchor' }
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
  if (entry.referenceKind === 'anchor') return ageAnchorPrefix(entry)
  return ''
}
