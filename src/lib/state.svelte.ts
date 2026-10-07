// 全局应用状态（Svelte 5 runes）。
import {
  clonePuzzle,
  puzzleFingerprint,
  validateStructure,
  type Puzzle,
  type StructuralIssue
} from './puzzle';
import type { CheckPhase, SolveResult } from './solver';
import {
  isCheckCancelled,
  type CheckExecutor
} from './check-types';

export type Tool = 'givens' | 'regions' | 'thermo-start' | 'thermo-extend' | 'erase';

export interface AnalysisState {
  status: 'idle' | 'checking' | 'done';
  result: SolveResult | null;
  /** 该结论（或进行中的检查）对应的题面指纹 */
  fingerprint: string | null;
  error: string | null;
  /** 进行中的阶段（encode/check1/check2） */
  phase: CheckPhase | null;
  /** 检查开始的墙钟时间（用于界面显示用时） */
  startedAt: number | null;
  /** 本次任务的耗时预算（毫秒），超时即取消并记"未判定" */
  budgetMs: number | null;
}

const IDLE_ANALYSIS: AnalysisState = {
  status: 'idle',
  result: null,
  fingerprint: null,
  error: null,
  phase: null,
  startedAt: null,
  budgetMs: null
};

/**
 * 整个检查任务的墙钟耗时预算：两次 check 各自的软超时之和 + 编码/通信余量。
 * Z3 软超时通常先生效并返回 unknown；预算只是兜底，超预算会终止 Worker。
 */
export function checkBudgetMs(timeoutMs: number): number {
  return timeoutMs * 2 + 5000;
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
  analysis = $state<AnalysisState>({ ...IDLE_ANALYSIS });
  /** 检查引擎（Worker + Z3）是否就绪 */
  z3Loading = $state<boolean>(true);
  z3Error = $state<string | null>(null);
  timeoutMs = $state<number>(5000);
  /** 画布高亮的格子（结构错误 / 矛盾核） */
  highlightCells = $state<Set<number>>(new Set());
  showSolution = $state<boolean>(false);
  /** 当前选中格（givens 工具下由数字键/数字盘写入） */
  selectedCell = $state<number | null>(null);

  #executor: CheckExecutor | null = null;
  /** 当前在途检查任务 id；作废（题面变化/被取代）时置 null，旧结果一律丢弃 */
  #activeCheckId: number | null = null;
  #checkSeq = 0;

  init(puzzle: Puzzle, draftId: string | null, name: string) {
    // 换题/载入草稿：作废旧任务，旧 Worker 结果不得回写到新题面
    this.#activeCheckId = null;
    this.#executor?.cancel();
    this.puzzle = puzzle;
    this.draftId = draftId;
    this.draftName = name;
    this.analysis = { ...IDLE_ANALYSIS };
    this.revalidate();
  }

  /** 启动检查引擎（Worker 内加载 Z3）。页面加载时调用一次。 */
  async startEngine() {
    try {
      // 动态导入：让 vitest 等无 Worker 的环境永远不会加载 runner
      const { WorkerCheckExecutor } = await import('./check-runner');
      const vendorBase = new URL('vendor/', document.baseURI).href;
      const exec: CheckExecutor = new WorkerCheckExecutor(vendorBase);
      this.#executor = exec;
      await exec.ready;
      this.z3Loading = false;
    } catch (e) {
      this.z3Error = e instanceof Error ? e.message : String(e);
      this.z3Loading = false;
    }
  }

  /** 测试/自定义场景注入执行器 */
  setExecutor(exec: CheckExecutor | null) {
    this.#executor = exec;
    if (exec) {
      this.z3Loading = false;
      this.z3Error = null;
    }
  }

  /** 题面每次改动后：重新结构校验，并判定旧检查结论/在途检查是否过期 */
  revalidate() {
    this.issues = validateStructure(this.puzzle);
    const fp = puzzleFingerprint(this.puzzle);
    if (this.analysis.status === 'checking' && this.analysis.fingerprint !== fp) {
      // 检查期间题面变化：作废旧任务（terminate Worker），旧结果不得覆盖新题面状态
      this.#activeCheckId = null;
      this.#executor?.cancel();
      this.analysis = { ...IDLE_ANALYSIS };
      return;
    }
    if (this.analysis.result && this.analysis.fingerprint !== fp) {
      // 改了一个提示（或任何题面要素）后，旧结论立即失效
      this.analysis = { ...IDLE_ANALYSIS };
    }
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
    if (this.analysis.status === 'checking') return;
    const executor = this.#executor;
    if (!executor) return;
    // 快照当前题面：检查针对的是这一刻的指纹；之后的编辑会使本任务作废
    const puzzle = clonePuzzle(this.puzzle as Puzzle);
    const structural = this.issues.map((i) => ({ ...i, cells: [...i.cells] }));
    const fingerprint = puzzleFingerprint(puzzle);
    const timeoutMs = this.timeoutMs;
    const budgetMs = checkBudgetMs(timeoutMs);
    const id = ++this.#checkSeq;
    this.#activeCheckId = id;
    const startedAt = Date.now();
    this.analysis = {
      status: 'checking',
      result: null,
      fingerprint,
      error: null,
      phase: 'encode',
      startedAt,
      budgetMs
    };
    try {
      const result = await executor.run({ puzzle, structural, timeoutMs, budgetMs }, (phase) => {
        if (this.#activeCheckId === id && this.analysis.status === 'checking') {
          this.analysis.phase = phase;
        }
      });
      if (this.#activeCheckId !== id) return; // 已被取消/取代：丢弃
      this.#activeCheckId = null;
      if (puzzleFingerprint(this.puzzle as Puzzle) !== fingerprint) return; // 题面已变：丢弃
      this.analysis = {
        status: 'done',
        result,
        fingerprint,
        error: null,
        phase: null,
        startedAt: null,
        budgetMs: null
      };
      // 矛盾时高亮冲突约束涉及的格子
      const cells = new Set<number>();
      result.conflict?.forEach((c) => c.cells.forEach((i) => cells.add(i)));
      this.issues.forEach((i) => i.cells.forEach((c) => cells.add(c)));
      this.highlightCells = cells;
    } catch (e) {
      if (this.#activeCheckId !== id) return; // 已作废：静默丢弃
      this.#activeCheckId = null;
      if (isCheckCancelled(e)) {
        // 取消/超时：只记录"未判定"。绝不把未完成的首解当成唯一解结论。
        const result: SolveResult = {
          verdict: 'unknown',
          solution: null,
          witness: null,
          conflict: [],
          reason: e.reason,
          elapsedMs: Date.now() - startedAt
        };
        this.analysis = {
          status: 'done',
          result,
          fingerprint,
          error: null,
          phase: null,
          startedAt: null,
          budgetMs: null
        };
      } else {
        this.analysis = {
          ...IDLE_ANALYSIS,
          error: e instanceof Error ? e.message : String(e)
        };
      }
    }
  }

  /** 用户主动取消：当前任务记为"未判定"（由 runCheck 的 catch 落盘该结论） */
  cancelCheck() {
    if (this.analysis.status !== 'checking') return;
    this.#executor?.cancel();
  }
}

export const editor = new EditorState();
