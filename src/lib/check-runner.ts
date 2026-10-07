// 主线程侧的检查执行器：把双次 SAT 检查放进独立 Worker。
// 取消与耗时预算：Z3 的 check() 是同步 WASM 执行，无法在 Worker 内响应取消消息，
// 因此取消/超预算一律 terminate() 整个 Worker，下次检查时重建（Z3 会重新初始化）。
// 正常结束后 Worker 保留复用，避免重复加载 WASM。
import type { CheckPhase, SolveResult } from './solver';
import {
  CheckCancelledError,
  type CheckExecutor,
  type CheckRequest,
  type MainToWorker,
  type WorkerToMain
} from './check-types';

interface PendingTask {
  id: number;
  resolve: (r: SolveResult) => void;
  reject: (e: Error) => void;
  onPhase: (p: CheckPhase) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WorkerCheckExecutor implements CheckExecutor {
  #vendorBase: string;
  #worker: Worker | null = null;
  #readyPromise: Promise<void> | null = null;
  #resolveReady: (() => void) | null = null;
  #rejectReady: ((e: Error) => void) | null = null;
  #pending: PendingTask | null = null;
  #seq = 0;

  constructor(vendorBase: string) {
    this.#vendorBase = vendorBase;
  }

  get ready(): Promise<void> {
    this.#spawnIfNeeded();
    return this.#readyPromise!;
  }

  #spawnIfNeeded() {
    if (this.#worker) return;
    const worker = new Worker(new URL('./check.worker.ts', import.meta.url), { type: 'module' });
    this.#worker = worker;
    this.#readyPromise = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    worker.onmessage = (ev: MessageEvent<WorkerToMain>) => this.#onMessage(ev.data);
    worker.onerror = (ev) => {
      const err = new Error(ev.message || '检查 Worker 异常终止');
      this.#rejectReady?.(err);
      this.#failPending(err);
      this.#teardown();
    };
    const init: MainToWorker = { type: 'init', vendorBase: this.#vendorBase };
    worker.postMessage(init);
  }

  run(req: CheckRequest, onPhase: (phase: CheckPhase) => void): Promise<SolveResult> {
    if (this.#pending) return Promise.reject(new Error('已有检查任务在进行中'));
    const id = ++this.#seq;
    return new Promise<SolveResult>((resolve, reject) => {
      // 耗时预算：从提交任务起算的墙钟时间，超预算即终止 Worker。
      // Z3 自身的软超时通常会先返回 unknown，这里是兜底（例如化简阶段不响应软超时）。
      const timer = setTimeout(() => {
        this.#failPending(new CheckCancelledError('timeout'));
        this.#teardown();
      }, Math.max(1000, req.budgetMs));
      this.#pending = { id, resolve, reject, onPhase, timer };
      this.ready.then(
        () => {
          const p = this.#pending;
          if (!p || p.id !== id || !this.#worker) return; // 等待就绪期间已被取消
          const msg: MainToWorker = {
            type: 'check',
            id,
            puzzle: req.puzzle,
            structural: req.structural,
            timeoutMs: req.timeoutMs
          };
          this.#worker.postMessage(msg);
        },
        () => {
          // 初始化失败：init-error 分支已经 failPending
        }
      );
    });
  }

  cancel() {
    if (!this.#pending) return;
    this.#failPending(new CheckCancelledError('cancelled'));
    this.#teardown();
  }

  #failPending(err: Error) {
    const p = this.#pending;
    if (!p) return;
    this.#pending = null;
    clearTimeout(p.timer);
    p.reject(err);
  }

  /** 杀掉 Worker（可能仍在跑 WASM），下次检查时重建 */
  #teardown() {
    this.#worker?.terminate();
    this.#worker = null;
    // 旧 ready Promise 可能永远不再 settle（Worker 已死），吞掉避免未处理拒绝
    this.#readyPromise?.catch(() => {});
    this.#readyPromise = null;
    this.#resolveReady = null;
    this.#rejectReady = null;
  }

  #onMessage(msg: WorkerToMain) {
    switch (msg.type) {
      case 'ready':
        this.#resolveReady?.();
        break;
      case 'init-error': {
        const err = new Error(msg.message);
        this.#rejectReady?.(err);
        this.#failPending(err);
        this.#teardown();
        break;
      }
      case 'phase':
        if (this.#pending?.id === msg.id) this.#pending.onPhase(msg.phase);
        break;
      case 'result': {
        const p = this.#pending;
        if (p && p.id === msg.id) {
          this.#pending = null;
          clearTimeout(p.timer);
          p.resolve(msg.result);
        }
        break;
      }
      case 'task-error': {
        const p = this.#pending;
        if (p && p.id === msg.id) {
          this.#pending = null;
          clearTimeout(p.timer);
          p.reject(new Error(msg.message));
        }
        break;
      }
    }
  }
}
