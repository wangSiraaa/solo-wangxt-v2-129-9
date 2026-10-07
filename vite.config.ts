import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Z3 WASM 说明：求解在独立检查 Worker 中进行（src/lib/check.worker.ts）。
// Worker 运行时从 public/vendor/ fetch z3-built.js / z3-built.wasm
// （pthreads 构建不允许被 bundler 打包）。SharedArrayBuffer 需要 COOP/COEP 响应头。
export default defineConfig({
  plugins: [svelte()],
  base: './',
  optimizeDeps: {
    // Worker 内动态 import z3-solver 浏览器入口，提前预打包避免 dev 下二次刷新
    include: ['z3-solver/build/browser']
  },
  worker: {
    // 检查 Worker 以 module worker 运行（内部有动态 import，iife 无法代码分割）
    format: 'es'
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  },
  build: {
    target: 'es2022'
  }
});
