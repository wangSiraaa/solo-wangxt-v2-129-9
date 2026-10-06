// 全局应用状态（Svelte 5 runes）。
import {
  clonePuzzle,
  puzzleFingerprint,
  validateStructure,
  type Puzzle,
  type StructuralIssue
} from './puzzle';
import type { SolveResult } from './solver';
import { initZ3Api } from './z3-init';
import type { Z3HighLevel } from 'z3-solver';

export type Tool = 'givens' | 'regions' | 'thermo-start' | 'thermo-extend' | 'erase';

export interface AnalysisState {
  status: 'idle' | 'checking' | 'done';
  result: SolveResult | null;
  /** 该结论对应的题面指纹 */
  fingerprint: string | null;
  error: string | null;
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
  analysis = $state<AnalysisState>({ status: 'idle', result: null, fingerprint: null, error: null });
  z3 = $state<Z3HighLevel | null>(null);
  z3Loading = $state<boolean>(true);
  z3Error = $state<string | null>(null);
  timeoutMs = $state<number>(5000);
  /** 画布高亮的格子（结构错误 / 矛盾核） */
  highlightCells = $state<Set<number>>(new Set());
  showSolution = $state<boolean>(false);
  /** 当前选中格（givens 工具下由数字键/数字盘写入） */
  selectedCell = $state<number | null>(null);

  #analyzePuzzle: typeof import('./solver').analyzePuzzle | null = null;

  init(puzzle: Puzzle, draftId: string | null, name: string) {
    this.puzzle = puzzle;
    this.draftId = draftId;
    this.draftName = name;
    this.revalidate();
    this.analysis = { status: 'idle', result: null, fingerprint: null, error: null };
  }

  async loadZ3() {
    try {
      this.z3 = await initZ3Api();
      const mod = await import('./solver');
      this.#analyzePuzzle = mod.analyzePuzzle;
      this.z3Loading = false;
    } catch (e) {
      this.z3Error = e instanceof Error ? e.message : String(e);
      this.z3Loading = false;
    }
  }

  /** 题面每次改动后：重新结构校验，并判定旧检查结论是否过期 */
  revalidate() {
    this.issues = validateStructure(this.puzzle);
    const fp = puzzleFingerprint(this.puzzle);
    if (this.analysis.result && this.analysis.fingerprint !== fp) {
      // 改了一个提示（或任何题面要素）后，旧结论立即失效
      this.analysis = { status: 'idle', result: null, fingerprint: null, error: null };
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
    if (!this.z3 || !this.#analyzePuzzle || this.analysis.status === 'checking') return;
    this.analysis.status = 'checking';
    this.analysis.error = null;
    try {
      const result = await this.#analyzePuzzle(
        this.z3,
        this.puzzle as Puzzle,
        this.issues,
        this.timeoutMs
      );
      this.analysis = {
        status: 'done',
        result,
        fingerprint: puzzleFingerprint(this.puzzle as Puzzle),
        error: null
      };
      // 矛盾时高亮冲突约束涉及的格子
      const cells = new Set<number>();
      result.conflict?.forEach((c) => c.cells.forEach((i) => cells.add(i)));
      this.issues.forEach((i) => i.cells.forEach((c) => cells.add(c)));
      this.highlightCells = cells;
    } catch (e) {
      this.analysis.error = e instanceof Error ? e.message : String(e);
      this.analysis.status = 'idle';
    }
  }
}

export const editor = new EditorState();
