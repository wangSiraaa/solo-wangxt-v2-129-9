// 核心领域模型：9x9 不规则宫温度计数独
// 纯数据 + 纯函数，不依赖 DOM/Svelte，便于单测与在 Web Worker 之外复用。

export const N = 9;
export const CELL_COUNT = N * N;
export const MIN_DIGIT = 1;
export const MAX_DIGIT = 9;

export type CellIndex = number; // 0..80，行优先：idx = r * N + c

export interface Thermometer {
  /** 从 bulb（水银泡）到顶端的格子序列；严格递增沿该方向 */
  path: CellIndex[];
}

export interface Puzzle {
  /** schema 版本，便于以后兼容导入 */
  version: 1;
  /** regions[r*N+c] = 宫编号 0..8；每宫必须恰好 9 格 */
  regions: number[];
  /** givens[r*N+c] = 0 表示空，1..9 表示提示数字 */
  givens: number[];
  thermometers: Thermometer[];
}

// ---------------------------------------------------------------------------
// 结构校验（宫区覆盖、格子范围、温度计自交/越界/邻接规则）
// ---------------------------------------------------------------------------

export type StructuralIssueCode =
  | 'GIVEN_OUT_OF_RANGE'
  | 'REGION_ID_OUT_OF_RANGE'
  | 'REGION_SIZE'
  | 'REGION_DISCONNECTED'
  | 'REGION_UNUSED'
  | 'THERMO_TOO_SHORT'
  | 'THERMO_CELL_OUT_OF_RANGE'
  | 'THERMO_REPEATED_CELL'
  | 'THERMO_NON_ADJACENT';

export interface StructuralIssue {
  code: StructuralIssueCode;
  message: string;
  /** 相关格子（用于在画布上高亮） */
  cells: CellIndex[];
  /** 相关宫编号（若有） */
  region?: number;
  /** 相关温度计序号（若有） */
  thermometer?: number;
}

export function rowOf(idx: CellIndex): number {
  return Math.floor(idx / N);
}
export function colOf(idx: CellIndex): number {
  return idx % N;
}
export function rc(r: number, c: number): CellIndex {
  return r * N + c;
}

export function areOrthogonallyAdjacent(a: CellIndex, b: CellIndex): boolean {
  const dr = Math.abs(rowOf(a) - rowOf(b));
  const dc = Math.abs(colOf(a) - colOf(b));
  return dr + dc === 1;
}

/**
 * 结构校验。这些是"语法层"检查，与可解性无关：
 *  - 格子范围：givens/regions/thermometer 引用的下标与数值合法
 *  - 宫区覆盖：0..80 每格归属一个 0..8 的宫，且每宫恰 9 格、边连通
 *  - 温度计：长度 ≥2、无越界、无自交（路径中格子不重复）、步间正交相邻
 */
export function validateStructure(puzzle: Puzzle): StructuralIssue[] {
  const issues: StructuralIssue[] = [];

  // ---- givens 范围 ----
  const badGiven: CellIndex[] = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    const g = puzzle.givens[i] ?? 0;
    if (!Number.isInteger(g) || g < 0 || g > MAX_DIGIT) badGiven.push(i);
  }
  if (badGiven.length) {
    issues.push({
      code: 'GIVEN_OUT_OF_RANGE',
      message: `存在非法提示值（必须为 0..${MAX_DIGIT} 的整数）`,
      cells: badGiven
    });
  }

  // ---- 宫编号范围 / 覆盖 ----
  const members: CellIndex[][] = Array.from({ length: N }, () => []);
  const badRegion: CellIndex[] = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    const region = puzzle.regions[i];
    if (!Number.isInteger(region) || region < 0 || region >= N) {
      badRegion.push(i);
      continue;
    }
    members[region].push(i);
  }
  if (badRegion.length) {
    issues.push({
      code: 'REGION_ID_OUT_OF_RANGE',
      message: '存在不属于任何宫（宫编号越界）的格子',
      cells: badRegion
    });
  }
  for (let k = 0; k < N; k++) {
    if (members[k].length === 0) {
      issues.push({
        code: 'REGION_UNUSED',
        message: `宫 ${k + 1} 没有任何格子`,
        cells: [],
        region: k
      });
    } else if (members[k].length !== N) {
      issues.push({
        code: 'REGION_SIZE',
        message: `宫 ${k + 1} 有 ${members[k].length} 格，应为 ${N} 格（宫区未均匀覆盖棋盘）`,
        cells: members[k],
        region: k
      });
    } else if (!isConnected(members[k])) {
      issues.push({
        code: 'REGION_DISCONNECTED',
        message: `宫 ${k + 1} 不连通（不规则宫必须边连通）`,
        cells: members[k],
        region: k
      });
    }
  }

  // ---- 温度计 ----
  puzzle.thermometers.forEach((t, ti) => {
    if (t.path.length < 2) {
      issues.push({
        code: 'THERMO_TOO_SHORT',
        message: `温度计 ${ti + 1} 至少需要 2 格`,
        cells: [...t.path],
        thermometer: ti
      });
      return;
    }
    const outOfRange = t.path.filter((p) => !Number.isInteger(p) || p < 0 || p >= CELL_COUNT);
    if (outOfRange.length) {
      issues.push({
        code: 'THERMO_CELL_OUT_OF_RANGE',
        message: `温度计 ${ti + 1} 引用了棋盘外的格子`,
        cells: outOfRange.filter((p) => Number.isInteger(p) && p >= 0 && p < CELL_COUNT),
        thermometer: ti
      });
      return; // 后续检查依赖合法下标
    }
    const seen = new Set<CellIndex>();
    const repeated = new Set<CellIndex>();
    for (const p of t.path) {
      if (seen.has(p)) repeated.add(p);
      seen.add(p);
    }
    if (repeated.size) {
      // 温度计自交：同一温度计的路径不允许访问同一个格子两次
      issues.push({
        code: 'THERMO_REPEATED_CELL',
        message: `温度计 ${ti + 1} 自交（路径中格子 ${[...repeated].map((p) => coordLabel(p)).join('、')} 重复）`,
        cells: [...repeated],
        thermometer: ti
      });
    }
    for (let s = 1; s < t.path.length; s++) {
      if (!areOrthogonallyAdjacent(t.path[s - 1], t.path[s])) {
        issues.push({
          code: 'THERMO_NON_ADJACENT',
          message: `温度计 ${ti + 1} 的第 ${s} 步不是正交相邻（只能上下左右延伸）`,
          cells: [t.path[s - 1], t.path[s]],
          thermometer: ti
        });
      }
    }
  });

  return issues;
}

function isConnected(cells: CellIndex[]): boolean {
  if (cells.length <= 1) return true;
  const set = new Set(cells);
  const start = cells[0];
  const queue = [start];
  const reached = new Set<CellIndex>([start]);
  while (queue.length) {
    const cur = queue.pop()!;
    for (const nb of neighborsOf(cur)) {
      if (set.has(nb) && !reached.has(nb)) {
        reached.add(nb);
        queue.push(nb);
      }
    }
  }
  return reached.size === cells.length;
}

export function neighborsOf(idx: CellIndex): CellIndex[] {
  const r = rowOf(idx);
  const c = colOf(idx);
  const out: CellIndex[] = [];
  if (r > 0) out.push(rc(r - 1, c));
  if (r < N - 1) out.push(rc(r + 1, c));
  if (c > 0) out.push(rc(r, c - 1));
  if (c < N - 1) out.push(rc(r, c + 1));
  return out;
}

export function coordLabel(idx: CellIndex): string {
  return `R${rowOf(idx) + 1}C${colOf(idx) + 1}`;
}

// ---------------------------------------------------------------------------
// 工厂 / 序列化
// ---------------------------------------------------------------------------

export function blankPuzzle(): Puzzle {
  // 默认标准 3x3 宫，方便从零开始
  const regions: number[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      regions.push(Math.floor(r / 3) * 3 + Math.floor(c / 3));
    }
  }
  return {
    version: 1,
    regions,
    givens: new Array(CELL_COUNT).fill(0),
    thermometers: []
  };
}

export function clonePuzzle(p: Puzzle): Puzzle {
  return {
    version: 1,
    regions: [...p.regions],
    givens: [...p.givens],
    thermometers: p.thermometers.map((t) => ({ path: [...t.path] }))
  };
}

/** 用于缓存失效：结构内容的稳定指纹；不含作者答案层 */
export function puzzleFingerprint(p: Puzzle): string {
  return JSON.stringify({
    r: p.regions,
    g: p.givens,
    t: p.thermometers.map((t) => t.path)
  });
}

/** 导出题面（公开数据）。明确剥离任何作者私有数据。 */
export interface PuzzleExport {
  format: 'thermo-jigsaw-sudoku';
  version: 1;
  kind: 'puzzle';
  regions: number[];
  givens: number[];
  thermometers: { path: number[] }[];
  exportedAt: string;
}

export function exportPuzzle(p: Puzzle): PuzzleExport {
  return {
    format: 'thermo-jigsaw-sudoku',
    version: 1,
    kind: 'puzzle',
    regions: [...p.regions],
    givens: [...p.givens],
    thermometers: p.thermometers.map((t) => ({ path: [...t.path] })),
    exportedAt: new Date().toISOString()
  };
}

export function importPuzzle(data: unknown): Puzzle {
  if (typeof data !== 'object' || data === null) throw new Error('导入数据不是对象');
  const obj = data as Record<string, unknown>;
  const regions = asNumberArray(obj.regions, CELL_COUNT);
  const givens = asNumberArray(obj.givens, CELL_COUNT);
  const thermos = obj.thermometers;
  if (!Array.isArray(thermos)) throw new Error('thermometers 不是数组');
  const thermometers: Thermometer[] = thermos.map((t) => {
    if (typeof t !== 'object' || t === null || !Array.isArray((t as { path?: unknown }).path)) {
      throw new Error('温度计格式错误');
    }
    return { path: ((t as { path: unknown[] }).path as unknown[]).map(asInt) };
  });
  const puzzle: Puzzle = { version: 1, regions, givens, thermometers };
  const issues = validateStructure(puzzle);
  if (issues.length) {
    throw new Error(`导入题面结构不合法：${issues.map((i) => i.message).join('；')}`);
  }
  return puzzle;
}

function asNumberArray(v: unknown, len: number): number[] {
  if (!Array.isArray(v) || v.length !== len) throw new Error(`数组长度必须为 ${len}`);
  return v.map(asInt);
}
function asInt(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error('元素不是整数');
  return v;
}
