// 检查任务主线程 <-> Worker 消息协议（结构化克隆，不可传函数）。
import type { Puzzle } from './puzzle';
import type { CheckStage, SolveResult } from './solver';

/** 主线程 -> Worker */
export type CheckRequest =
  | {
      type: 'start';
      /** 任务 id：Worker 原样回传，主线程据此丢弃过期结果 */
      runId: number;
      /** 启动时的题面快照与指纹（Worker 不持主线程状态） */
      puzzle: Puzzle;
      fingerprint: string;
      /** 每次 check 的 Z3 超时（毫秒） */
      timeoutMs: number;
      /** 整个任务的总耗时预算（两次 check 共享，毫秒） */
      totalBudgetMs: number;
    }
  | { type: 'cancel'; runId: number };

/** Worker -> 主线程 */
export type CheckResponse =
  | { type: 'ready' }
  | { type: 'init-error'; message: string }
  | { type: 'stage'; runId: number; stage: CheckStage }
  | { type: 'finished'; runId: number; fingerprint: string; result: SolveResult };
