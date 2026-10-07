// 检查 Worker：在独立线程中加载 Z3 并执行"双次 SAT"检查，避免长时间占用页面。
// 主线程通过 postMessage 下发任务；本 Worker 依次回报 阶段 -> 结果。
// 取消/超时由主线程直接 terminate() 本 Worker 实现（Z3 的同步 WASM 执行
// 会占满本线程事件循环，无法在 check() 中途响应取消消息）。
import { analyzePuzzle } from './solver';
import { initWorkerZ3 } from './z3-worker-init';
import type { MainToWorker, WorkerToMain } from './check-types';
import type { Z3HighLevel } from 'z3-solver';

const post = (msg: WorkerToMain) =>
  (self as unknown as { postMessage(m: WorkerToMain): void }).postMessage(msg);

let z3Promise: Promise<Z3HighLevel> | null = null;

self.onmessage = (ev: MessageEvent<MainToWorker>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    z3Promise ??= initWorkerZ3(msg.vendorBase);
    z3Promise.then(
      () => post({ type: 'ready' }),
      (e) => post({ type: 'init-error', message: e instanceof Error ? e.message : String(e) })
    );
    return;
  }
  if (msg.type === 'check') {
    void (async () => {
      try {
        if (!z3Promise) throw new Error('Worker 尚未初始化 Z3');
        const z3 = await z3Promise;
        const result = await analyzePuzzle(z3, msg.puzzle, msg.structural, msg.timeoutMs, (phase) =>
          post({ type: 'phase', id: msg.id, phase })
        );
        post({ type: 'result', id: msg.id, result });
      } catch (e) {
        post({ type: 'task-error', id: msg.id, message: e instanceof Error ? e.message : String(e) });
      }
    })();
  }
};
