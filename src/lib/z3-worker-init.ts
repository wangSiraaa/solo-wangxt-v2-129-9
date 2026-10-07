// Worker 内的 Z3 加载。
// module worker 没有 importScripts，这里用 fetch 取回 UMD 工厂脚本（z3-built.js），
// 以 Function 求值拿到 initZ3 工厂，再包一层注入 locateFile / mainScriptUrlOrBlob：
//   - locateFile           让 wasm 回到 vendor 目录加载（默认会错用 worker 自身路径）
//   - mainScriptUrlOrBlob  让 Z3 的 pthread 也从 vendor/z3-built.js 派生
import type { Z3HighLevel } from 'z3-solver';

type EmscriptenFactory = (moduleArg?: Record<string, unknown>) => Promise<unknown>;

export async function initWorkerZ3(vendorBase: string): Promise<Z3HighLevel> {
  const base = vendorBase.endsWith('/') ? vendorBase : `${vendorBase}/`;
  const resp = await fetch(`${base}z3-built.js`);
  if (!resp.ok) throw new Error(`无法加载 z3-built.js（HTTP ${resp.status}）`);
  const src = await resp.text();
  // z3-built.js 是 UMD：脚本顶层 `var initZ3 = ...`，求值后从函数作用域取回工厂
  const factory = new Function(`${src}\n;return initZ3;`)() as EmscriptenFactory;
  (globalThis as { initZ3?: unknown }).initZ3 = (moduleArg: Record<string, unknown> = {}) =>
    factory({
      locateFile: (path: string) => `${base}${path}`,
      mainScriptUrlOrBlob: `${base}z3-built.js`,
      ...moduleArg
    });
  const mod = (await import('z3-solver/build/browser')) as {
    init: () => Promise<Z3HighLevel>;
  };
  return mod.init();
}
