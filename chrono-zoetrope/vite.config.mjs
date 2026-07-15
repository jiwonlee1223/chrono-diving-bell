import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const projectRoot = dirname(fileURLToPath(import.meta.url))

// 순수 vite (electron-vite 대체). renderer(three.js)를 dist/로 번들, Node 서버(server/index.mjs)가
// 정적 서빙한다. dev는 vite dev 서버가 HMR을 제공하고 /api·/media 를 Node 서버(:8788)로 프록시한다.
export default defineConfig({
  root: 'src/renderer',
  base: './', // dist를 어느 경로에서 서빙해도 자산 상대경로가 깨지지 않게.
  build: {
    outDir: resolve(projectRoot, 'dist'),
    emptyOutDir: true
  },
  server: {
    port: 5173,
    // renderer가 src/shared/* (vite root 밖)를 import 하므로 프로젝트 루트 접근 허용.
    fs: { allow: [projectRoot] },
    proxy: {
      // 상태·미디어는 Node 런타임 서버가 소유 → dev에선 프록시로 같은 오리진처럼 붙인다.
      '/api': { target: 'http://localhost:8788', changeOrigin: true },
      '/media': { target: 'http://localhost:8788', changeOrigin: true }
    }
  }
})
