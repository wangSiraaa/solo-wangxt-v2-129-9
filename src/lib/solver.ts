// 求解器：把不规则宫 + 温度计数独编码为 Z3 并检查可解性 / 唯一解。
//
// 编码：每格 x[i][d]（布尔）= 格 i 填数字 d+1。
//   - 每格至少一个数字 + 任意两个数字互斥（恰好一个）
//   - 每行/列/宫：每个数字至少出现一次 + 同数字两两互斥（恰好一次）
//   - 温度计路径 a 在 b 之前（值严格小）：
//       x[a]=d ⇒ x[b]∈{d+1..9}，即 ¬x[a][d] ∨ ∨_{e>d} x[b][e]
//     d=8（值 9）时右侧为空析取，子句退化为 ¬x[a][8]
//     —— 带后继的位置不能取 9，bulb=9 会立即与该子句矛盾。
// 全部是子句，直接走 SAT 引擎，比 Int+Distinct 的算术编码快得多。
//
// 唯一解检查（排除首解再求）：
//   check1 -> unsat：无解；unknown：超时未判定；sat：得到模型 M1
//   check2 追加"至少一格取与 M1 不同的值"（¬x[i][M1[i]] 的析取）后再次求解：
//     sat    => 存在第二个解 => 多解
//     unsat  => M1 是唯一解
//     unknown=> 已找到一个解但无法在时限内确认唯一性（未判定）
// 绝不能"只找到一次 sat 就宣称唯一"。
import type { Z3HighLevel } from 'z3-solver';
import {
  CELL_COUNT,
  N,
  rc,
  type CellIndex,
  type Puzzle,
  type StructuralIssue
} from './puzzle';

export type Verdict = 'unique' | 'multiple' | 'unsat' | 'unknown';

/** 双次 SAT 流程当前所处阶段（界面展示用） */
export type CheckStage =
  | 'structure'
  | 'encoding'
  | 'check-sat-1'
  | 'check-sat-2'
  | 'done';

export interface AnalyzeHooks {
  /** 阶段切换通知（在 Worker 中会转发给界面） */
  onStage?: (stage: CheckStage) => void;
  /**
   * 注册"外部中断"回调。Worker 收到取消消息时调用它，
   * 进而触发 Z3 context 级中断；若 check 因事件循环阻塞收不到消息，
   * 界面会直接 terminate 整个 Worker 兜底。
   */
  registerInterrupt?: (interrupt: () => void) => void;
  /** 是否已被外部取消（每次 await 边界检查） */
  isCancelled?: () => boolean;
  /**
   * 整个检查任务的总耗时预算（毫秒），两次 check 共享。
   * 每次 check 前取剩余预算作为该次 Z3 超时。
   * 与单次 timeoutMs 不同：超总预算属于"未判定（被取消/超预算）"，
   * 不保留未完成的首解作为结论。
   */
  totalBudgetMs?: number;
}

export interface ConflictItem {
  /** 作者可读的约束描述 */
  label: string;
  cells: CellIndex[];
  thermometer?: number;
  region?: number;
}

export interface SolveResult {
  verdict: Verdict;
  /** 唯一解或首个解（multiple/unknown 时为首解，可能为 null） */
  solution: number[] | null;
  /** 多解时的第二个解，用于在 UI 上对照 */
  witness: number[] | null;
  /** unsat 时导致矛盾的一组约束（unsat core） */
  conflict: ConflictItem[];
  /** unknown 时的原因（如 timeout）；结构非法时为 structure-invalid */
  reason: string | null;
  /** 实际耗时（毫秒） */
  elapsedMs: number;
}

type Z3Context = any;

interface Encoding {
  /** x[i][d]：格 i 取数字 d+1 */
  x: any[][];
  /** Z3 布尔标签名 -> 作者可读的冲突信息 */
  groups: Map<string, ConflictItem>;
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i < b; i++) out.push(i);
  return out;
}

/**
 * 把全部约束安装进 solver。每个"人类可理解的约束块"用 addAndTrack
 * 挂一个布尔标签，unsat 时这些标签构成矛盾核（一组导致矛盾的约束）。
 */
export function encodePuzzle(
  ctx: Z3Context,
  solver: any,
  puzzle: Puzzle
): Encoding {
  const { Bool, Or } = ctx;
  const x = Array.from({ length: CELL_COUNT }, (_, i) =>
    Array.from({ length: N }, (_, d) => Bool.const(`x_${i}_${d}`))
  );
  const groups = new Map<string, ConflictItem>();
  let seq = 0;

  const track = (expr: any, item: ConflictItem) => {
    const name = `g#${seq++}`;
    groups.set(name, item);
    solver.addAndTrack(expr, name);
  };
  const cellName = (i: CellIndex) => `R${Math.floor(i / N) + 1}C${(i % N) + 1}`;

  // 每格：至少一个数字 + 两两互斥
  for (let i = 0; i < CELL_COUNT; i++) {
    track(Or(...x[i]), { label: `${cellName(i)} 必须填入一个数字`, cells: [i] });
    for (let d1 = 0; d1 < N; d1++) {
      for (let d2 = d1 + 1; d2 < N; d2++) {
        solver.add(Or(x[i][d1].not(), x[i][d2].not())); // 基础子句无需进 core
      }
    }
  }

  // 行、列、宫：每个数字恰好一次
  const units: { cells: CellIndex[]; label: (k: number) => string; key: number }[] = [];
  for (let k = 0; k < N; k++) {
    const rowCells = range(0, N).map((j) => rc(k, j));
    const colCells = range(0, N).map((j) => rc(j, k));
    units.push({ cells: rowCells, label: (d) => `第 ${k + 1} 行必须含数字 ${d}`, key: k });
    units.push({ cells: colCells, label: (d) => `第 ${k + 1} 列必须含数字 ${d}`, key: k });
  }
  const members: CellIndex[][] = Array.from({ length: N }, () => []);
  puzzle.regions.forEach((r, i) => {
    if (Number.isInteger(r) && r >= 0 && r < N) members[r].push(i);
  });
  members.forEach((cells, k) => {
    units.push({ cells, label: (d) => `宫 ${k + 1} 必须含数字 ${d}`, key: k });
  });

  for (const unit of units) {
    for (let d = 0; d < N; d++) {
      // 至少出现一次（进入 core：能定位到具体行/列/宫与数字）
      track(Or(...unit.cells.map((i) => x[i][d])), {
        label: unit.label(d + 1),
        cells: unit.cells
      });
      // 两两互斥（基础子句，量很大，不进 core）
      for (let a = 0; a < N; a++) {
        for (let b = a + 1; b < N; b++) {
          solver.add(Or(x[unit.cells[a]][d].not(), x[unit.cells[b]][d].not()));
        }
      }
    }
  }

  // 提示数字：把完整赋值（正向 + 全部反向）作为一个约束组标注。
  // 若只标注单位子句 x[i]=g，最小矛盾核可能绕过它、借用未标注的
  // 背景子句（取值域/互斥）推出矛盾；合取标注后该提示必然出现在核中。
  const { And: And2 } = ctx;
  puzzle.givens.forEach((g, i) => {
    if (g >= 1 && g <= 9) {
      const parts = [Or(x[i][g - 1])];
      for (let d = 0; d < N; d++) {
        if (d !== g - 1) parts.push(Or(x[i][d].not()));
      }
      track(And2(...parts), { label: `提示 ${cellName(i)} = ${g}`, cells: [i] });
    }
  });

  // 温度计：相邻位置 s-1 < s（严格递增沿路径可传递，无需全部位置对）。
  // 每个相邻段把全部 d 的子句合并为一个合取式并挂一个标签，
  // 这样 d=8 的单元子句 ¬x[ca][8]（"有后继的位置不能取 9"）也在同一约束组内，
  // bulb=9 这类矛盾能在 unsat core 里精确点名该温度计段。
  const { And } = ctx;
  puzzle.thermometers.forEach((t, ti) => {
    for (let s = 1; s < t.path.length; s++) {
      const ca = t.path[s - 1];
      const cb = t.path[s];
      const clauses: any[] = [];
      for (let d = 0; d <= 8; d++) {
        const tail = range(d + 1, N).map((e) => x[cb][e]);
        clauses.push(tail.length ? Or(x[ca][d].not(), ...tail) : Or(x[ca][d].not()));
      }
      track(And(...clauses), {
        label: `温度计 ${ti + 1}：${cellName(ca)} < ${cellName(cb)}（水银柱自泡端严格递增）`,
        cells: [ca, cb],
        thermometer: ti
      });
    }
  });

  return { x, groups };
}

function readGrid(model: any, x: any[][]): number[] {
  const grid = new Array<number>(CELL_COUNT).fill(0);
  for (let i = 0; i < CELL_COUNT; i++) {
    for (let d = 0; d < N; d++) {
      const v = model.eval(x[i][d]);
      const isTrue = v.isTrue ? v.isTrue() : String(v) === 'true';
      if (isTrue) {
        grid[i] = d + 1;
        break;
      }
    }
  }
  return grid;
}

function extractConflict(solver: any, groups: Map<string, ConflictItem>): ConflictItem[] {
  const core = solver.unsatCore();
  const items: ConflictItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < core.length(); i++) {
    const name = core.get(i).name().toString();
    const item = groups.get(name);
    if (item && !seen.has(name)) {
      seen.add(name);
      items.push(item);
    }
  }
  return items;
}

/**
 * 完整检查：可解性 + 唯一解（排除首解再求）。
 * @param timeoutMs 每次 check 的 Z3 超时（毫秒）；两次 check 各自独立计时
 * @param hooks     阶段上报 / 中断注册 / 取消信号 / 总预算（Worker 使用）
 */
export async function analyzePuzzle(
  z3: Z3HighLevel,
  puzzle: Puzzle,
  structural: StructuralIssue[],
  timeoutMs = 5000,
  hooks: AnalyzeHooks = {}
): Promise<SolveResult> {
  const started = performance.now();
  const { onStage, registerInterrupt, isCancelled, totalBudgetMs } = hooks;
  const cancelled = () => isCancelled?.() === true;
  /** 剩余总预算（毫秒）；未配置总预算时退回单次 timeoutMs */
  const remainingBudget = () => {
    if (!totalBudgetMs || !Number.isFinite(totalBudgetMs)) return timeoutMs;
    return Math.max(1, Math.floor(totalBudgetMs - (performance.now() - started)));
  };
  /**
   * 取消或超总预算 => 未判定。绝不携带首解：
   * 即使 check1 已得到 M1，被取消/超预算意味着没能完成完整流程，
   * 不允许把"未完成的首解"保留成唯一结论。
   */
  const aborted = (reason: string): SolveResult =>
    finish('unknown', { reason, elapsedMs: performance.now() - started });
  const finish = (
    verdict: Verdict,
    rest: Partial<SolveResult> = {}
  ): SolveResult => ({
    verdict,
    solution: null,
    witness: null,
    conflict: [],
    reason: null,
    elapsedMs: performance.now() - started,
    ...rest
  });

  // 结构非法属于"编辑期"错误，直接作为矛盾信息返回，不调用 Z3。
  onStage?.('structure');
  if (structural.length) {
    onStage?.('done');
    return finish('unsat', {
      reason: 'structure-invalid',
      conflict: structural.map((i) => ({ label: i.message, cells: i.cells }))
    });
  }
  if (cancelled()) {
    onStage?.('done');
    return aborted('cancelled');
  }

  const ctx = new z3.Context('solver');
  try {
    registerInterrupt?.(() => ctx.interrupt());
    const { Or } = ctx;
    const solver = new ctx.Solver();

    onStage?.('encoding');
    const encoding = encodePuzzle(ctx, solver, puzzle);
    if (cancelled()) {
      onStage?.('done');
      return aborted('cancelled');
    }

    // ---- 第一次求解 ----
    onStage?.('check-sat-1');
    const budget1 = remainingBudget();
    if (budget1 <= 1 && totalBudgetMs) {
      onStage?.('done');
      return aborted('budget-exceeded');
    }
    solver.set('timeout', Math.max(1, Math.floor(Math.min(timeoutMs, budget1))));
    const r1 = await solver.check();
    if (cancelled()) {
      onStage?.('done');
      return aborted('cancelled');
    }
    if (r1 === 'unknown') {
      onStage?.('done');
      // check1 自身超时：可能连一个解都没拿到，也无法证明无解 => 未判定
      const overBudget = totalBudgetMs != null && remainingBudget() <= 1;
      return finish('unknown', {
        reason: overBudget ? 'budget-exceeded' : solver.reasonUnknown() || 'timeout'
      });
    }
    if (r1 === 'unsat') {
      onStage?.('done');
      return finish('unsat', { conflict: extractConflict(solver, encoding.groups) });
    }
    const solution = readGrid(solver.model(), encoding.x);

    // ---- 排除首解：至少一格与 M1 不同，然后再次求解 ----
    onStage?.('check-sat-2');
    const budget2 = remainingBudget();
    if (totalBudgetMs && budget2 <= 1) {
      onStage?.('done');
      // 首解之外没能完成第二次检查 => 未判定，不保留首解
      return aborted('budget-exceeded');
    }
    solver.set('timeout', Math.max(1, Math.floor(Math.min(timeoutMs, budget2))));
    solver.add(Or(...encoding.x.map((arr, i) => arr[solution[i] - 1].not())));

    const r2 = await solver.check();
    if (cancelled()) {
      onStage?.('done');
      return aborted('cancelled');
    }
    if (r2 === 'unknown') {
      onStage?.('done');
      // 找到至少一个解，但无法在时限内排除第二个解。
      // 总预算耗尽 => 未判定且不保留首解；
      // 仅是第二次 check 的 Z3 自身超时 => 保留首解供界面参考，但仍不宣称唯一。
      const overBudget = totalBudgetMs != null && remainingBudget() <= 1;
      return finish('unknown', {
        reason: overBudget ? 'budget-exceeded' : solver.reasonUnknown() || 'timeout',
        ...(overBudget ? {} : { solution })
      });
    }
    if (r2 === 'unsat') {
      onStage?.('done');
      return finish('unique', { solution });
    }
    const witness = readGrid(solver.model(), encoding.x);
    onStage?.('done');
    return finish('multiple', { solution, witness });
  } finally {
    (ctx as { __release?: () => void }).__release?.();
  }
}
