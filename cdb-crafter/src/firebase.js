import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getAuth, signInAnonymously } from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const storage = getStorage(app);

// 기본값(업로드 10분)은 Storage가 막힌 환경에서 제출이 몇 분씩 멎은 것처럼 보이게 하므로
// 줄이되, 느린 회선을 끊어버리지 않을 만큼은 남긴다 — 핫스팟/LTE에서 실측 20KB/s 수준이면
// 400KB 사진 한 장에 20초 넘게 걸린다. 여기를 더 줄이면 정상 업로드가 retry-limit-exceeded로
// 실패한다.
storage.maxUploadRetryTime = 120000;
storage.maxOperationRetryTime = 30000;

// 보안 규칙이 익명 인증(request.auth != null)을 요구한다. profile-collector와 동일.
// 모든 Firestore/Storage 접근 전에 이 프로미스를 await해 로그인이 끝났음을 보장한다.
// (Firebase는 브라우저에 익명 세션을 유지하므로 재방문 시엔 즉시 resolve된다.)
const auth = getAuth(app);
export const authReady = signInAnonymously(auth).then(
  (cred) => cred.user,
  (err) => {
    console.error("익명 로그인 실패:", err);
    throw err;
  },
);
