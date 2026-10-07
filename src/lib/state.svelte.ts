// 全局应用状态（Svelte 5 runes）。
import {
  clonePuzzle,
  puzzleFingerprint,
  validateStructure,
  type Puzzle,
  type StructuralIssue
} from './puzzle';
import type { CheckStage, SolveResult } from './solver';
import type { CheckRequest, CheckResponse } from './check-protocol';
import SolverWorker from './solver.worker.ts?worker';

export type Tool = 'givens' | 'regions' | 'thermo-start' | 'thermo-extend' | 'erase';

export interface AnalysisState {
  status: 'idle' | 'checking' | 'done';
  result: SolveResult | null;
  /** 该结论对应的题面指纹 */
  fingerprint: string | null;
  error: string | null;
  /** 检查中：当前阶段（两次 SAT 流程的进度） */
  stage: CheckStage | null;
  /** 检查中：任务已运行毫秒数（界面定时刷新） */
  elapsedMs: number;
}

/** 检查被取消/超总预算时的统一结论：未判定，且不携带任何首解 */
function cancelledResult(elapsedMs: number, reason = 'cancelled'): SolveResult {
  return {
    verdict: 'unknown',
    solution: null,
    witness: null,
    conflict: [],
    reason,
    elapsedMs
  };
}

export class EditorState {
  puzzle = $state<Puzzle>(null as unknown as Puzzle);
  tool = $state<Tool>('givens');
  /** 当前选中的宫编号（regions 工具） */
  selectedRegion = $state<number>(0);
  /** 正在绘制/编辑的温度计序号 */
  activeThermo = $state<number | null>(null);
  /** 当前草稿 id；null 表示尚未保存的新稿 */
  draftId = $state<string | null>(null);
  draftName = $state<string>('未命名题稿');
  issues = $state<StructuralIssue[]>([]);
  analysis = $state<AnalysisState>({
    status: 'idle',
    result: null,
    fingerprint: null,
    error: null,
    stage: null,
    elapsedMs: 0
  });
  z3Loading = $state<boolean>(true);
  z3Error = $state<string | null>(null);
  timeoutMs = $state<number>(5000);
  /** 画布高亮的格子（结构错误 / 矛盾核） */
  highlightCells = $state<Set<number>>(new Set());
  showSolution = $state<boolean>(false);
  /** 当前选中格（givens 工具下由数字键/数字盘写入） */
  selectedCell = $state<number | null>(null);

  /** 复用的检查 Worker（Z3 初始化只做一次） */
  #worker: Worker | null = null;
  /** 自增任务 id；旧任务的任何回传一律丢弃 */
  #runId = 0;
  /** 当前任务启动时间（用于界面计时） */
  #runStartedAt = 0;
  /** 界面计时器句柄 */
  #ticker: ReturnType<typeof setInterval> | null = null;
  /** 当前任务是否已因取消/题面变更而失效（停止回写） */
  #runStale = false;

  init(puzzle: Puzzle, draftId: string | null, name: string) {
    // 载入题面/草稿：正在跑的检查立即作废（其 Worker 结果按 runId 丢弃）
    this.#invalidateRun(true);
    this.puzzle = puzzle;
    this.draftId = draftId;
    this.draftName = name;
    this.highlightCells = new Set();
    this.showSolution = false;
    this.issues = validateStructure(this.puzzle);
    this.analysis = {
      status: 'idle',
      result: null,
      fingerprint: null,
      error: null,
      stage: null,
      elapsedMs: 0
    };
  }

  /** 创建（或复用）检查 Worker 并挂接消息 */
  #ensureWorker(): Worker {
    if (this.#worker) return this.#worker;
    this.z3Loading = true;
    const worker = new SolverWorker();
    this.#worker = worker;
    const onMessage = (ev: MessageEvent<CheckResponse>) => this.#onWorkerMessage(ev.data);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', (ev) => {
      // Worker 自身崩溃（初始化 OOM 等）：当前任务记为未判定，并允许下次检查重建
      this.z3Error = ev.message || '检查 Worker 发生错误';
      this.z3Loading = false;
      if (this.#worker === worker) this.#worker = null;
      if (this.analysis.status === 'checking') {
        this.#finishRun(cancelledResult(this.analysis.elapsedMs, 'worker-error'));
      }
    });
    return worker;
  }

  loadZ3() {
    // Worker 在后台初始化 Z3 WASM；界面只等 ready/init-error 消息
    this.z3Loading = true;
    this.z3Error = null;
    this.#ensureWorker();
  }

  #onWorkerMessage(msg: CheckResponse) {
    switch (msg.type) {
      case 'ready':
        this.z3Loading = false;
        this.z3Error = null;
        break;
      case 'init-error':
        this.z3Loading = false;
        this.z3Error = msg.message;
        if (this.analysis.status === 'checking') {
          this.#finishRun(cancelledResult(this.analysis.elapsedMs, 'init-error'));
        }
        break;
      case 'stage':
        if (this.#runStale || msg.runId !== this.#runId) return;
        this.analysis.stage = msg.stage;
        break;
      case 'finished':
        if (this.#runStale || msg.runId !== this.#runId) return;
        this.#acceptResult(msg.fingerprint, msg.result);
        break;
    }
  }

  /** 结果回写：必须同时通过 runId（已在消息处校验）与当前题面指纹双重核对 */
  #acceptResult(fingerprint: string, result: SolveResult) {
    const currentFp = puzzleFingerprint(this.puzzle as Puzzle);
    if (fingerprint !== currentFp) {
      // 检查期间题面被改过：旧 Worker 结果绝不能覆盖新题面状态
      this.#finishRun(null);
      return;
    }
    this.#finishRun(result, fingerprint);
    if (result.verdict === 'unsat') {
      const cells = new Set<number>();
      result.conflict?.forEach((c) => c.cells.forEach((i) => cells.add(i)));
      this.issues.forEach((i) => i.cells.forEach((c) => cells.add(c)));
      this.highlightCells = cells;
    }
  }

  /**
   * 结束一次任务在界面上的状态。result 为 null 表示结果被丢弃（题面已变），
   * 界面保持"未检查"；否则记录结论与其指纹。
   */
  #finishRun(result: SolveResult | null, fingerprint?: string) {
    this.#stopTicker();
    this.#runStale = false;
    if (result === null) {
      this.analysis = {
        status: 'idle',
        result: null,
        fingerprint: null,
        error: null,
        stage: null,
        elapsedMs: 0
      };
    } else {
      this.analysis = {
        status: 'done',
        result,
        fingerprint: fingerprint ?? puzzleFingerprint(this.puzzle as Puzzle),
        error: null,
        stage: null,
        elapsedMs: result.elapsedMs
      };
    }
  }

  #startTicker() {
    this.#stopTicker();
    this.#runStartedAt = performance.now();
    this.analysis.elapsedMs = 0;
    this.#ticker = setInterval(() => {
      if (this.analysis.status !== 'checking' || this.#runStale) return;
      this.analysis.elapsedMs = performance.now() - this.#runStartedAt;
    }, 100);
  }

  #stopTicker() {
    if (this.#ticker !== null) {
      clearInterval(this.#ticker);
      this.#ticker = null;
    }
  }

  /**
   * 让当前任务失效。
   * @param terminate 是否立即终止 Worker（题面变化/载入新稿时为 true，
   *                  普通取消为 false——先发取消消息，让 Worker 走 Z3 中断路径）
   */
  #invalidateRun(terminate: boolean) {
    if (this.analysis.status !== 'checking') {
      this.#stopTicker();
      return;
    }
    const runId = this.#runId;
    this.#runStale = true;
    // 推进 runId：即使旧任务的 finished 消息在此之后到达，也会被丢弃
    this.#runId++;
    this.#stopTicker();
    if (!this.#worker) return;
    if (terminate) {
      // 题面已变：直接终止，旧任务连结果消息都发不出来；
      // 下次检查时 #ensureWorker() 重建一个新的 Z3 Worker
      this.#worker.terminate();
      this.#worker = null;
    } else {
      const req: CheckRequest = { type: 'cancel', runId };
      try {
        this.#worker.postMessage(req);
      } catch {
        // worker 可能已结束，无妨
      }
    }
  }

  /** 题面每次改动后：重新结构校验，并判定旧检查结论是否过期 */
  revalidate() {
    this.issues = validateStructure(this.puzzle);
    const fp = puzzleFingerprint(this.puzzle);
    if (this.analysis.status === 'checking') {
      // 检查进行中题面被改动：旧 Worker 立即终止，其结果（哪怕刚发出）
      // 也会被新的 runId 丢弃，绝不回写到新题面的状态
      this.#invalidateRun(true);
      this.analysis = {
        status: 'idle',
        result: null,
        fingerprint: null,
        error: null,
        stage: null,
        elapsedMs: 0
      };
    } else if (this.analysis.result && this.analysis.fingerprint !== fp) {
      // 改了一个提示（或任何题面要素）后，旧结论立即失效
      this.analysis = {
        status: 'idle',
        result: null,
        fingerprint: null,
        error: null,
        stage: null,
        elapsedMs: 0
      };
    }
  }

  /** 取消正在运行的检查：记为"未判定"，不保留未完成的首解 */
  cancelCheck() {
    if (this.analysis.status !== 'checking') return;
    // 取实时用时（ticker 每 100ms 才刷新一帧）
    const elapsed = performance.now() - this.#runStartedAt;
    this.#invalidateRun(false);
    this.#finishRun(cancelledResult(elapsed));
  }

  #mutate(fn: (p: Puzzle) => void) {
    const draft = clonePuzzle(this.puzzle as Puzzle);
    fn(draft);
    this.puzzle = draft;
    this.revalidate();
  }

  setGiven(cell: number, digit: number) {
    this.#mutate((p) => {
      p.givens[cell] = p.givens[cell] === digit ? 0 : digit;
    });
  }

  clearCell(cell: number) {
    this.#mutate((p) => {
      p.givens[cell] = 0;
    });
  }

  paintRegion(cell: number) {
    this.#mutate((p) => {
      p.regions[cell] = this.selectedRegion;
    });
  }

  startThermo(cell: number) {
    this.#mutate((p) => {
      p.thermometers.push({ path: [cell] });
      this.activeThermo = p.thermometers.length - 1;
    });
  }

  extendThermo(cell: number) {
    if (this.activeThermo === null) return;
    const t = (this.puzzle as Puzzle).thermometers[this.activeThermo];
    if (!t) return;
    // 合法性由结构校验统一报告；这里只做最小的编辑约束
    const last = t.path[t.path.length - 1];
    if (cell === last) {
      // 再次点击末端：完成绘制
      this.finishThermo();
      return;
    }
    this.#mutate((p) => {
      const cur = p.thermometers[this.activeThermo!];
      // 撤销一步
      if (t.path.length >= 2 && cell === t.path[t.path.length - 2]) {
        cur.path.pop();
        return;
      }
      cur.path.push(cell);
    });
  }

  finishThermo() {
    // 丢弃长度不足 2 的温度计
    this.#mutate((p) => {
      p.thermometers = p.thermometers.filter((t) => t.path.length >= 2);
    });
    this.activeThermo = null;
  }

  cancelThermo() {
    this.#mutate((p) => {
      if (this.activeThermo !== null) p.thermometers.splice(this.activeThermo, 1);
    });
    this.activeThermo = null;
  }

  selectThermo(index: number | null) {
    this.activeThermo = index;
  }

  deleteThermo(index: number) {
    this.#mutate((p) => {
      p.thermometers.splice(index, 1);
    });
    if (this.activeThermo === index) this.activeThermo = null;
  }

  /** 画布点击入口，由当前工具决定行为 */
  onCellClick(cell: number) {
    switch (this.tool) {
      case 'regions':
        this.paintRegion(cell);
        break;
      case 'erase':
        this.clearCell(cell);
        this.selectedCell = cell;
        break;
      case 'thermo-start':
        this.startThermo(cell);
        this.tool = 'thermo-extend';
        break;
      case 'thermo-extend':
        this.extendThermo(cell);
        break;
      case 'givens':
      default:
        this.selectedCell = cell;
        break;
    }
  }

  pressDigit(d: number) {
    if (this.tool !== 'givens') return;
    if (this.selectedCell === null) return;
    if (d === 0) this.clearCell(this.selectedCell);
    else this.setGiven(this.selectedCell, d);
  }

  async runCheck() {
    if (this.z3Error && !this.z3Loading) {
      // 初始化失败后点击重试：重建 Worker（重试仍使用当前题面指纹）
      this.#worker?.terminate();
      this.#worker = null;
      this.loadZ3();
      return;
    }
    if (this.analysis.status === 'checking' || this.z3Loading) return;
    const worker = this.#ensureWorker();

    const runId = ++this.#runId;
    this.#runStale = false;
    this.analysis = {
      status: 'checking',
      result: null,
      fingerprint: null,
      error: null,
      stage: 'structure',
      elapsedMs: 0
    };
    this.#startTicker();

    const puzzle = clonePuzzle(this.puzzle as Puzzle);
    const fingerprint = puzzleFingerprint(this.puzzle as Puzzle);
    // 总耗时预算 = 两次 check 的超时之和（每次取剩余预算，两次都有公平额度）
    const totalBudgetMs = Math.max(1, Math.floor(this.timeoutMs)) * 2;
    const req: CheckRequest = {
      type: 'start',
      runId,
      puzzle,
      fingerprint,
      timeoutMs: this.timeoutMs,
      totalBudgetMs
    };
    try {
      worker.postMessage(req);
    } catch (e) {
      this.#finishRun(cancelledResult(0, `error: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
}

export const editor = new EditorState();
