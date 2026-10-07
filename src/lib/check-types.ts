// 检查任务的公共类型：主线程状态、Worker 执行器与测试替身共用。
// 本模块不引用 Worker/DOM，可安全地在 vitest（jsdom）中导入。
import type { Puzzle, StructuralIssue } from './puzzle';
import type { CheckPhase, SolveResult } from './solver';

export interface CheckRequest {
  /** 题面快照（进入 Worker 前已克隆，之后的编辑不影响本次检查） */
  puzzle: Puzzle;
  structural: StructuralIssue[];
  /** 每次 SAT check 的 Z3 软超时 */
  timeoutMs: number;
  /** 整个任务的墙钟耗时预算；超预算即终止 Worker，只记录"未判定" */
  budgetMs: number;
}

/** 检查执行器：默认实现跑在独立 Worker 里；测试可注入同步替身 */
export interface CheckExecutor {
  /** 引擎（Worker 内的 Z3）就绪 */
  readonly ready: Promise<void>;
  run(req: CheckRequest, onPhase: (phase: CheckPhase) => void): Promise<SolveResult>;
  /** 取消当前任务：run() 的 Promise 会以 CheckCancelledError 拒绝 */
  cancel(): void;
}

export type CancelReason = 'cancelled' | 'timeout';

/** 取消/超预算导致的终止。这不是求解失败，结论只能记为"未判定"。 */
export class CheckCancelledError extends Error {
  readonly reason: CancelReason;
  constructor(reason: CancelReason) {
    super(reason === 'timeout' ? 'check-budget-exceeded' : 'check-cancelled');
    this.name = 'CheckCancelledError';
    this.reason = reason;
  }
}

export function isCheckCancelled(e: unknown): e is CheckCancelledError {
  return e instanceof CheckCancelledError;
}

// ---------------------------------------------------------------------------
// 主线程 <-> 检查 Worker 的消息协议
// ---------------------------------------------------------------------------

export interface MainToWorkerInit {
  type: 'init';
  /** vendor 目录（z3-built.js / z3-built.wasm 所在）的绝对 URL */
  vendorBase: string;
}

export interface MainToWorkerCheck {
  type: 'check';
  id: number;
  puzzle: Puzzle;
  structural: StructuralIssue[];
  timeoutMs: number;
}

export type MainToWorker = MainToWorkerInit | MainToWorkerCheck;

export type WorkerToMain =
  | { type: 'ready' }
  | { type: 'init-error'; message: string }
  | { type: 'phase'; id: number; phase: CheckPhase }
  | { type: 'result'; id: number; result: SolveResult }
  | { type: 'task-error'; id: number; message: string };
