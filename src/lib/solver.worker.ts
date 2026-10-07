// 检查 Worker：Z3 WASM 与双次 SAT 流程全部在这里运行，不阻塞界面线程。
//
// 为什么不直接 import vendor/z3-built.js：
//   - 它是普通脚本（非 ES 模块），顶层 `var initZ3` 经模块 import 不会挂到
//     globalThis；而 z3-solver 的 browser 入口要求 globalThis.initZ3 存在。
//   - 它的 pthread 构建会以"脚本自身 URL"再派生 em-pthread worker，并按脚本
//     同目录 fetch z3-built.wasm；模块 worker 环境下这些路径都推断不出来。
// 做法：fetch 脚本文本后以间接 eval 运行（var 进入全局），并把工厂包一层，
// 注入 locateFile（wasm）与 mainScriptUrlOrBlob（pthread 自举脚本）。
import { analyzePuzzle } from './solver';
import { validateStructure } from './puzzle';
import type { CheckRequest, CheckResponse } from './check-protocol';
import type { Z3HighLevel } from 'z3-solver';
// 静态 import：Vite 会把 z3-solver 的 CJS browser 入口一并打进 worker
// （动态 import 会触发代码分割，而 base:'./' 下 worker 默认 iife 不支持分割）
import { init as initZ3Browser } from 'z3-solver/build/browser';

function post(msg: CheckResponse) {
  (self as unknown as Worker).postMessage(msg);
}

/**
 * 定位 public/vendor 目录（z3-built.js / .wasm 原样拷贝、不参与打包）。
 * worker 自身 URL：
 *   - dev：  /src/lib/solver.worker.ts        （或根下临时脚本）
 *   - build：/assets/solver.worker-[hash].js
 * 二者都在"根往下一层/两层"目录里，按所在段数回退到站点根即可。
 */
function resolveVendorBase(): string {
  const loc = self.location.href.replace(/[?#].*$/, '');
  const dir = loc.slice(0, loc.lastIndexOf('/') + 1);
  const segs = new URL(dir).pathname.split('/').filter(Boolean);
  // 去掉末尾代表目录的空段后，segs.length 即目录深度：assets/src+lib=1/2
  const levels = Math.min(2, Math.max(1, segs.length));
  return new URL('../'.repeat(levels) + 'vendor/', dir).href.replace(/\/$/, '');
}

const VENDOR_BASE = resolveVendorBase();

async function initZ3InWorker(): Promise<Z3HighLevel> {
  const scriptUrl = `${VENDOR_BASE}/z3-built.js`;
  // 间接 eval：在全局作用域执行脚本，顶层 var initZ3 挂到 globalThis
  const code = await (await fetch(scriptUrl)).text();
  (0, eval)(code);
  const factory = (globalThis as { initZ3?: (mod?: unknown) => Promise<unknown> }).initZ3;
  if (typeof factory !== 'function') {
    throw new Error('vendor/z3-built.js 未注册 initZ3 工厂');
  }
  (globalThis as { initZ3?: unknown }).initZ3 = (moduleArg: Record<string, unknown> = {}) =>
    factory({
      ...moduleArg,
      locateFile: (path: string) => `${VENDOR_BASE}/${path}`,
      // pthread worker 自举时按此 URL 重新加载脚本（不能是模块 worker 的 blob URL）
      mainScriptUrlOrBlob: scriptUrl
    });
  return initZ3Browser();
}

let z3Promise: Promise<Z3HighLevel> | null = null;
let z3: Z3HighLevel | null = null;

z3Promise = initZ3InWorker()
  .then((api) => {
    z3 = api;
    post({ type: 'ready' });
    return api;
  })
  .catch((e: unknown) => {
    post({ type: 'init-error', message: e instanceof Error ? e.message : String(e) });
    throw e;
  });

interface ActiveRun {
  runId: number;
  cancelled: boolean;
  interrupt: (() => void) | null;
}
let active: ActiveRun | null = null;
/** Z3 未就绪或上一个任务仍在中断收尾时，排队一个 start（只保留最新） */
let pendingStart: (CheckRequest & { type: 'start' }) | null = null;

function beginRun(msg: CheckRequest & { type: 'start' }) {
  const run: ActiveRun = { runId: msg.runId, cancelled: false, interrupt: null };
  active = run;
  void (async () => {
    try {
      const result = await analyzePuzzle(
        z3!,
        msg.puzzle,
        validateStructure(msg.puzzle),
        msg.timeoutMs,
        {
          totalBudgetMs: msg.totalBudgetMs,
          isCancelled: () => run.cancelled,
          registerInterrupt: (interrupt) => {
            run.interrupt = interrupt;
          },
          onStage: (stage) => {
            if (active === run) post({ type: 'stage', runId: run.runId, stage });
          }
        }
      );
      if (active === run) {
        post({ type: 'finished', runId: run.runId, fingerprint: msg.fingerprint, result });
      }
    } catch (e) {
      if (active === run) {
        post({
          type: 'finished',
          runId: run.runId,
          fingerprint: msg.fingerprint,
          result: {
            verdict: 'unknown',
            solution: null,
            witness: null,
            conflict: [],
            reason: `error: ${e instanceof Error ? e.message : String(e)}`,
            elapsedMs: 0
          }
        });
      }
    } finally {
      if (active === run) active = null;
      // 收尾后若有更新的 start 在排队（取消后立即重试的场景），立刻启动
      const queued = pendingStart;
      pendingStart = null;
      if (queued && z3) beginRun(queued);
    }
  })();
}

self.onmessage = (ev: MessageEvent<CheckRequest>) => {
  const msg = ev.data;
  if (msg.type === 'cancel') {
    if (active && active.runId === msg.runId) {
      active.cancelled = true;
      try {
        active.interrupt?.();
      } catch {
        // 中断失败无妨：主线程在题面变更等场景会 terminate 兜底
      }
    }
    return;
  }

  if (msg.type === 'start') {
    if (!z3) return; // 就绪前的 start 忽略（界面按钮在 ready 前禁用）
    if (active) {
      // 上一个任务仍在（如中断收尾中）：只保留最新的启动请求
      pendingStart = msg;
      return;
    }
    beginRun(msg);
  }
};

// 避免顶层 await 初始化失败导致 worker 整体崩溃后无消息
void z3Promise?.catch(() => {});
