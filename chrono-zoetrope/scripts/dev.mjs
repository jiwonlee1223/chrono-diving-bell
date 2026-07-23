// 개발 실행기 — 런타임 서버(server/index.mjs)와 vite dev 서버를 병렬로 띄운다.
//
// 기존 스크립트 "node server/index.mjs & vite"는 POSIX 전용이었다: Windows cmd.exe에서 `&`는
// '순차 실행'이라 서버가 종료될 때까지 vite가 영영 시작되지 않는다(→ :8788이 옛 dist를 서빙).
// 여기서는 둘 다 child process로 스폰해 macOS·Windows 공통으로 동작하게 한다.
// 접속: http://localhost:5173 (vite, HMR — /api·/media는 :8788로 프록시).
// 한쪽이 죽으면 나머지도 내려 좀비 프로세스를 남기지 않는다.

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const procs = []
let closing = false

function run(label, args) {
  const p = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' })
  p.on('exit', (code) => {
    if (closing) return
    closing = true
    console.log(`[dev] ${label} 종료(code ${code ?? 0}) — 나머지 프로세스도 내린다`)
    for (const q of procs) if (q !== p && q.exitCode === null) q.kill()
    process.exitCode = code ?? 0
  })
  procs.push(p)
}

run('server', ['server/index.mjs'])
// vite CLI를 node로 직접 실행 — .cmd 셔플 없이 플랫폼 무관.
run('vite', [path.join('node_modules', 'vite', 'bin', 'vite.js')])

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    closing = true
    for (const q of procs) if (q.exitCode === null) q.kill()
  })
}
