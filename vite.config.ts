import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Z3 WASM 说明：z3-solver 的 browser 入口期望全局存在 initZ3。
// 我们把 node_modules/z3-solver/build/{z3-built.js,z3-built.wasm}
// 复制到 public/vendor/，由 index.html 以普通 <script> 加载并注册全局函数
// （pthreads 构建不允许被 bundler 打包）。SharedArrayBuffer 需要 COOP/COEP 响应头。
export default defineConfig({
  plugins: [svelte()],
  base: './',
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
