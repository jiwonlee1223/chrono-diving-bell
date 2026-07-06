// 프로필 수집 앱 서버 — 의존성 제로 (node:http).
//
// 역할은 두 가지뿐이다:
//   1. public/ 정적 파일(모바일 웹 앱) 서빙
//   2. /env.js 로 Firebase 웹 설정을 런타임 주입 — 값은 환경변수에서 읽으므로
//      git에 아무 자격도 하드코딩되지 않는다. Railway에서는 서비스 환경변수로 채운다.
//
// 데이터 쓰기(인증·Firestore·Storage)는 전부 브라우저의 Firebase SDK가 직접 한다.
// 따라서 이 서버는 상태가 없고, Railway가 요구하는 것은 process.env.PORT 바인딩뿐이다.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(__dirname, 'public')
const PORT = process.env.PORT || 3000

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon'
}

// Firebase 웹 설정(공개해도 안전한 값들)을 환경변수에서 조립해 클라이언트에 내려준다.
function firebaseConfigJS() {
  const cfg = {
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.FIREBASE_APP_ID || ''
  }
  return `window.__FIREBASE_CONFIG__ = ${JSON.stringify(cfg)};`
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  let pathname = decodeURIComponent(url.pathname)

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    return res.end('ok')
  }
  if (pathname === '/env.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' })
    return res.end(firebaseConfigJS())
  }

  if (pathname === '/') pathname = '/index.html'
  // 경로 탈출 방지: PUBLIC 밖으로 못 나가게 정규화 후 검사
  const filePath = path.join(PUBLIC, path.normalize(pathname))
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    return res.end('forbidden')
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': MIME['.html'] })
      return res.end('<h1>404</h1>')
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' })
    res.end(data)
  })
})

server.listen(PORT, () => {
  console.log(`[profile-collector] listening on :${PORT}`)
  const configured = Boolean(process.env.FIREBASE_PROJECT_ID)
  if (!configured) console.warn('[profile-collector] ⚠ Firebase 환경변수가 비어 있습니다. .env 또는 Railway 변수에서 설정하세요.')
})
