// Z3 初始化封装。
// 浏览器：index.html 以独立 <script> 加载 /vendor/z3-built.js，注册全局 initZ3，
// z3-solver 的 browser 入口据此完成初始化。
// Node / vitest：没有全局 initZ3，使用 z3-solver 的 node 入口（wasm 经 fs 加载）。
import type { Z3HighLevel } from 'z3-solver';

let cached: Promise<Z3HighLevel> | null = null;

declare global {
  // z3-built.js 注册到 window/self 上的工厂
  // eslint-disable-next-line no-var
  var initZ3: unknown;
}

export function initZ3Api(): Promise<Z3HighLevel> {
  if (!cached) {
    cached = (async () => {
      const browserFactory = (globalThis as { initZ3?: unknown }).initZ3;
      if (typeof browserFactory === 'function') {
        const mod = (await import('z3-solver/build/browser')) as {
          init: () => Promise<Z3HighLevel>;
        };
        return mod.init();
      }
      // 仅 Node/vitest 使用。用变量拼接模块路径，避免浏览器构建器静态分析
      // 把 node 入口（及其 fs/path/worker_threads 依赖）打进浏览器包。
      const pkg = 'z3-solver';
      const mod = (await import(/* @vite-ignore */ `${pkg}/build/node`)) as {
        init: () => Promise<Z3HighLevel>;
      };
      return mod.init();
    })();
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}
