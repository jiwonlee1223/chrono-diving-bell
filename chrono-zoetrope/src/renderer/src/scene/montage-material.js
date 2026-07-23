// 몽타주 재료 — 생성 이미지(평면 사진)를 실린더 UV에 매핑하고,
// 멈춤의 블러(REGEN_WAIT 의례)와 정지 이미지→영상 크로스페이드(IMMERSION)를 셰이더 한 장에서 처리한다.
//
// 매핑(미결 — 실린더에서 결정, montage.json mapping):
//   repeat4 = 같은 이미지를 4사분면(프로젝터 담당 호와 일치)에 반복. 어느 방향을 봐도 그 순간.
//   front   = 정면(az 0) 사분면만 이미지, 나머지 검정. (thread 앰비언트와의 합성은 추후 옵션.)
// fit(montage.json fitMode):
//   width  = 사분면 폭에 맞춤 → 상하 레터박스(원본 구도 보존, §2 위아래 어둠과 어울림)
//   height = 높이에 맞춤 → 좌우 크롭
//
// 블러는 이미지 샘플에만 건다: 영상은 블러가 걷히며 나타나므로("점점 또렷해지면서 영상 재생")
// 이미지 블러 아웃 + 영상 크로스페이드 인이 겹치면 그 인상이 된다. mip 바이어스 + 포아송 8탭.
//
// 시간·상태는 renderer.js가 uniform으로 밀어넣는다. 이 재료는 실린더 메시와 파노라마 프리뷰
// 쿼드가 공유한다(thread material과 같은 방식) — 두 뷰의 애니메이션이 자동 일치.

import * as THREE from 'three'

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D uTexImage;  // 현재 몽타주 프레임 (또는 FREEZE로 고정된 순간)
  uniform sampler2D uTexVideo;  // Wan2.2 재생성 영상 (IMMERSION)
  uniform float uHasImage;      // 0/1
  uniform float uHasVideo;      // 0/1
  uniform float uVideoMix;      // 0..1 정지 이미지 → 영상 크로스페이드
  uniform float uBlur;          // 0..1 멈춤의 블러 (REGEN_WAIT 의례)
  uniform float uImageAspect;   // 이미지 w/h
  uniform float uVideoAspect;   // 영상 w/h
  uniform float uQuadAspect;    // 사분면 벽 가로/세로 = (2πR/4)/H
  uniform float uMapping;       // 0 = repeat4, 1 = front, 2 = panorama(360°에 한 번 감김), 3 = filmstrip(스트립이 종횡비 유지한 채 감겨 스크롤)
  uniform float uStripScale;    // filmstrip: 실린더 둘레 종횡비(2πR/H) / 스트립 텍스처 종횡비 — 1보다 작으면 스트립이 둘레보다 길다
  uniform float uFit;           // 0 = width(레터박스), 1 = height(크롭)
  uniform float uEdgeFeather;   // 이미지 가장자리 페더 (어둠 속에 떠 있는 사진)
  uniform float uYaw;           // 설치 캘리브레이션: 둘레 회전(0..1=360°, wrap). 실린더 안 좌우 정렬.
  uniform float uPitch;         // 설치 캘리브레이션: 상하 이동(타일 높이 비율, wrap 없음).

  // 실린더 UV → 사분면 로컬 x(0..1). 사분면 밖(front 모드)은 -1.
  float quadLocalX(float u) {
    if (uMapping < 0.5) return fract((u + 0.125) * 4.0);
    float t = fract(u + 0.125); // 정면 사분면: t ∈ [0, 0.25)
    return t < 0.25 ? t * 4.0 : -1.0;
  }

  // 사분면 로컬 좌표 → 콘텐츠 UV. 화면 밖이면 alpha 0.
  // aspect별로 이미지/영상이 각자 호출한다 (832×480 영상과 1344×768 이미지의 미세한 비율 차 흡수).
  vec3 contentUV(float localX, float v, float aspect) {
    float x = (localX - 0.5) * uQuadAspect; // 높이=1 단위의 벽 좌표
    float y = v - 0.5;
    vec2 cuv;
    if (uFit < 0.5) {
      float h = uQuadAspect / aspect;       // 폭 맞춤 → 콘텐츠 세로 크기
      cuv = vec2(localX, y / h + 0.5);
    } else {
      cuv = vec2(x / aspect + 0.5, v);      // 높이 맞춤 → 좌우 크롭
    }
    float f = uEdgeFeather + uBlur * 0.2;   // 블러 중엔 가장자리도 함께 풀린다
    float a = smoothstep(0.0, f, cuv.x) * smoothstep(0.0, f, 1.0 - cuv.x)
            * smoothstep(0.0, f, cuv.y) * smoothstep(0.0, f, 1.0 - cuv.y);
    return vec3(cuv, a);
  }

  // 포아송 8탭 + mip 바이어스 블러. blur 0이면 단일 탭.
  vec3 sampleBlurred(sampler2D tex, vec2 uv, float blur) {
    vec3 c = texture2D(tex, uv, blur * 5.0).rgb;
    if (blur < 0.003) return c;
    float r = blur * 0.05;
    float b = blur * 5.0;
    c += texture2D(tex, uv + vec2( 0.527,  0.085) * r, b).rgb;
    c += texture2D(tex, uv + vec2(-0.040,  0.536) * r, b).rgb;
    c += texture2D(tex, uv + vec2(-0.670, -0.179) * r, b).rgb;
    c += texture2D(tex, uv + vec2( 0.324, -0.585) * r, b).rgb;
    c += texture2D(tex, uv + vec2( 0.876, -0.481) * r, b).rgb;
    c += texture2D(tex, uv + vec2(-0.591,  0.784) * r, b).rgb;
    c += texture2D(tex, uv + vec2(-0.940, -0.320) * r, b).rgb;
    c += texture2D(tex, uv + vec2( 0.086,  0.985) * r, b).rgb;
    return c / 9.0;
  }

  void main() {
    bool hasContent = uHasImage > 0.5 || (uHasVideo > 0.5 && uVideoMix > 0.001);

    // filmstrip(uMapping=3): reel 전용 3:4 사진들을 이어 붙인 스트립 텍스처가 종횡비를 유지한 채
    // 둘레에 감기고, uYaw 증가로 필름처럼 연속 스크롤한다. 스트립이 둘레보다 길면(uStripScale<1)
    // 한 시점에 일부 구간만 보이고 나머지는 돌아오면서 나타난다. 캘리브레이션 pitch는 panorama와 동일.
    if (uMapping > 2.5) {
      if (!hasContent) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      float py = vUv.y - uPitch;
      if (py < 0.0 || py > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      vec2 cuv = vec2(fract((vUv.x + uYaw) * uStripScale), py);
      gl_FragColor = vec4(sampleBlurred(uTexImage, cuv, uBlur), 1.0);
      return;
    }

    // panorama(uMapping=2): 하나의 파노라마/reel이 360°(전 타일)에 한 번 감긴다.
    // 방위 u를 텍스처 x에 1:1 대응 → 4타일이 4:1 한 장을 90°씩 나눠 갖는다(반복 없음).
    // 텍스처 비율 = 타일 레이아웃 비율(둘 다 파노라마 비율)이라 세로는 그대로 채운다(레터박스 없음).
    if (uMapping > 1.5) {
      if (!hasContent) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      // 캘리브레이션: 둘레 회전(yaw, wrap)과 상하 이동(pitch). pitch로 밀려 콘텐츠 밖은 검정.
      float py = vUv.y - uPitch;
      if (py < 0.0 || py > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      vec2 cuv = vec2(fract(vUv.x + uYaw), py);
      vec3 pcol = vec3(0.0);
      if (uHasImage > 0.5) pcol = sampleBlurred(uTexImage, cuv, uBlur);
      if (uHasVideo > 0.5 && uVideoMix > 0.001) {
        vec3 pvid = texture2D(uTexVideo, cuv).rgb;
        pcol = mix(pcol, pvid, uVideoMix);
      }
      gl_FragColor = vec4(pcol, 1.0);
      return;
    }

    float lx = quadLocalX(vUv.x + uYaw);
    float qy = vUv.y - uPitch; // 캘리브레이션 상하 이동 (contentUV alpha가 범위 밖을 페이드)
    // 이미지도 영상도 없으면(또는 사분면 밖이면) 검정. 영상만 있어도(reel 데모) 렌더한다.
    if (lx < 0.0 || !hasContent) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    // 이미지가 있으면 그 위에서 시작, 없으면 검정에서 영상으로.
    vec3 col = vec3(0.0);
    if (uHasImage > 0.5) {
      vec3 iu = contentUV(lx, qy, uImageAspect);
      col = sampleBlurred(uTexImage, iu.xy, uBlur) * iu.z;
    }

    if (uHasVideo > 0.5 && uVideoMix > 0.001) {
      vec3 vu = contentUV(lx, qy, uVideoAspect);
      vec3 vid = texture2D(uTexVideo, vu.xy).rgb * vu.z;
      col = mix(col, vid, uVideoMix);
    }

    gl_FragColor = vec4(col, 1.0);
  }
`

export function createMontageMaterial(install, montageConfig) {
  const { radius, height } = install.cylinder
  const quadAspect = (2 * Math.PI * radius) / 4 / height // ≈ 0.785 (110cm / 140cm)
  return new THREE.ShaderMaterial({
    uniforms: {
      uTexImage: { value: null },
      uTexVideo: { value: null },
      uHasImage: { value: 0 },
      uHasVideo: { value: 0 },
      uVideoMix: { value: 0 },
      uBlur: { value: 0 },
      uImageAspect: { value: 16 / 9 },
      uVideoAspect: { value: 16 / 9 },
      uQuadAspect: { value: quadAspect },
      uMapping: {
        value:
          montageConfig?.mapping === 'panorama' ? 2 : montageConfig?.mapping === 'front' ? 1 : 0
      },
      uStripScale: { value: 1 }, // filmstrip(uMapping=3) 진입 시 renderer가 실측으로 설정
      uFit: { value: montageConfig?.fitMode === 'height' ? 1 : 0 },
      uEdgeFeather: { value: montageConfig?.edgeFeather ?? 0.05 },
      uYaw: { value: montageConfig?.calibration?.yaw ?? 0 },
      uPitch: { value: montageConfig?.calibration?.pitch ?? 0 }
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.FrontSide,
    depthWrite: true
  })
}

export function setMontageImage(material, texture) {
  const u = material.uniforms
  u.uTexImage.value = texture
  u.uHasImage.value = texture ? 1 : 0
  const img = texture?.image
  if (img?.width && img?.height) u.uImageAspect.value = img.width / img.height
}

// 설치 캘리브레이션 실시간 적용 (런타임 페이지 키 입력이 호출). yaw wrap, pitch clamp.
export function setMontageCalibration(material, { yaw, pitch } = {}) {
  const u = material.uniforms
  if (yaw != null) u.uYaw.value = ((yaw % 1) + 1) % 1
  if (pitch != null) u.uPitch.value = Math.min(0.5, Math.max(-0.5, pitch))
  return { yaw: u.uYaw.value, pitch: u.uPitch.value }
}

export function setMontageVideo(material, videoTexture) {
  const u = material.uniforms
  u.uTexVideo.value = videoTexture
  u.uHasVideo.value = videoTexture ? 1 : 0
  const el = videoTexture?.image
  if (el?.videoWidth) u.uVideoAspect.value = el.videoWidth / el.videoHeight
}
