// 生成不规则宫 + 验证样例 + 为标准题搜索唯一解提示集。
// 注意：并非任意"9 个连通 9 格宫"的分区都存在数独解，
// 需要先用 Z3 检查分区可解（sat），再从中挑一个不规则的。
// 用法：node scripts/gen-samples.mjs
import { init } from '../node_modules/z3-solver/build/node.js';
import { generateJigsawRegions } from './gen-regions.mjs';
import { writeFileSync } from 'node:fs';

const N = 9;
const rc = (r, c) => r * N + c;

function validateRegions(regions) {
  const members = Array.from({ length: 9 }, () => []);
  regions.forEach((r, i) => members[r].push(i));
  for (let k = 0; k < 9; k++) {
    if (members[k].length !== 9) throw new Error(`region ${k} size ${members[k].length}`);
    if (!connected(new Set(members[k]), members[k][0])) {
      throw new Error(`region ${k} disconnected: ${members[k]}`);
    }
  }
}
function connected(set, start) {
  const seen = new Set([start]);
  const q = [start];
  while (q.length) {
    const i = q.pop();
    const [r, c] = [Math.floor(i / 9), i % 9];
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr > 8 || nc < 0 || nc > 8) continue;
      const j = rc(nr, nc);
      if (set.has(j) && !seen.has(j)) { seen.add(j); q.push(j); }
    }
  }
  return seen.size === set.size;
}

// 布尔变量编码（x[i][d] = 格 i 填 d+1），对 SAT 求解器友好。
// 温度计路径 a 在 b 之前（值严格小）：
//   x[a]=d => 后续位置只能取 > d：¬x[a][d] ∨ ∨_{e>d} x[b][e]
function buildSolver(ctx, regions, givensMap, thermometers, timeout = 15000) {
  const { Bool, And, Or, Solver } = ctx;
  const x = Array.from({ length: 81 }, (_, i) =>
    Array.from({ length: 9 }, (_, d) => Bool.const(`x_${i}_${d}`))
  );
  const s = new Solver();
  s.set('timeout', timeout);

  for (let i = 0; i < 81; i++) {
    s.add(Or(...x[i])); // 至少一个数字
    for (let d1 = 0; d1 < 9; d1++)
      for (let d2 = d1 + 1; d2 < 9; d2++) s.add(Or(x[i][d1].not(), x[i][d2].not()));
  }
  const groups = [];
  for (let k = 0; k < 9; k++) {
    groups.push(Array.from({ length: 9 }, (_, j) => rc(k, j)));
    groups.push(Array.from({ length: 9 }, (_, j) => rc(j, k)));
  }
  const members = Array.from({ length: 9 }, () => []);
  regions.forEach((r, i) => members[r].push(i));
  groups.push(...members);
  for (const g of groups) {
    for (let d = 0; d < 9; d++) {
      s.add(Or(...g.map((i) => x[i][d])));
      for (let a = 0; a < 9; a++)
        for (let b = a + 1; b < 9; b++) s.add(Or(x[g[a]][d].not(), x[g[b]][d].not()));
    }
  }
  for (const [i, v] of givensMap) {
    s.add(Or(x[i][v - 1]));
    for (let d = 0; d < 9; d++) if (d !== v - 1) s.add(Or(x[i][d].not()));
  }
  for (const t of thermometers) {
    for (let a = 0; a < t.length; a++)
      for (let b = a + 1; b < t.length; b++)
        for (let d = 0; d <= 8; d++) {
          const tail = range(d + 1, 9).map((e) => x[t[b]][e]);
          // d=8 时右侧为空析取（=false）：子句退化为 ¬x[a][8]，
          // 即"存在后继的位置不允许取 9"，这正是 bulb=9 立即矛盾的来源。
          s.add(tail.length ? Or(x[t[a]][d].not(), ...tail) : Or(x[t[a]][d].not()));
        }
  }
  return { s, x };
}
function range(a, b) {
  const o = [];
  for (let i = a; i < b; i++) o.push(i);
  return o;
}
function readSol(model, x) {
  const sol = new Array(81).fill(0);
  for (let i = 0; i < 81; i++)
    for (let d = 0; d < 9; d++) {
      const v = model.eval(x[i][d]);
      if (v.isTrue ? v.isTrue() : String(v) === 'true') { sol[i] = d + 1; break; }
    }
  return sol;
}

// 双重 check：排除首解后再求，返回 unique/multiple/unknown/unsat
async function classify(ctx, regions, givensMap, thermometers) {
  const { s, x } = buildSolver(ctx, regions, givensMap, thermometers);
  const { Or } = ctx;
  const r1 = await s.check();
  if (r1 === 'unsat') return { verdict: 'unsat' };
  if (r1 === 'unknown') return { verdict: 'unknown' };
  const sol = readSol(s.model(), x);
  s.add(Or(...x.map((arr, i) => arr[sol[i] - 1].not())));
  const r2 = await s.check();
  if (r2 === 'unsat') return { verdict: 'unique', sol };
  if (r2 === 'sat') return { verdict: 'multiple', sol, sol2: readSol(s.model(), x) };
  return { verdict: 'unknown', sol };
}

function shuffle(arr, seed) {
  let s = seed;
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  const { Context } = await init();
  const ctx = new Context('main');

  const thermos = [
    [rc(0, 0), rc(1, 0), rc(2, 0), rc(3, 0), rc(4, 0)],
    [rc(8, 8), rc(7, 8), rc(6, 8), rc(5, 8)]
  ];

  // 1) 搜索一个：宫区合法 + 不规则 + 无约束可解 + 带温度计可解 的分区
  //    不规则度：任一宫与标准 3x3 块的最大重叠格数；越小越不规则。
  const stdRegion = (i) => Math.floor(i / 27) * 3 + Math.floor((i % 9) / 3);
  const irregularity = (regions) => {
    let worst = 0;
    for (let k = 0; k < 9; k++) {
      const overlap = new Array(9).fill(0);
      regions.forEach((r, i) => { if (r === k) overlap[stdRegion(i)]++; });
      worst = Math.max(worst, ...overlap);
    }
    return worst;
  };

  let regions = null;
  for (let seed = 1; seed <= 400; seed++) {
    const cand = generateJigsawRegions(seed);
    validateRegions(cand);
    if (irregularity(cand) > 6) continue; // 拒绝条状/近标准分区
    const plain = await classify(ctx, cand, new Map(), []);
    if (plain.verdict !== 'multiple') continue;
    const withT = await classify(ctx, cand, new Map(), thermos);
    if (withT.verdict === 'multiple') {
      regions = cand;
      console.log('picked region seed', seed, 'irregularity', irregularity(cand));
      break;
    }
  }
  if (!regions) throw new Error('no solvable irregular partition found');
  console.log('regions OK (solvable + irregular)');
  for (let r = 0; r < 9; r++) console.log(regions.slice(r * 9, r * 9 + 9).join(' '));

  // 2) 从完整解的 81 格提示出发，逐个删除仍能保持唯一解的提示（最小化）
  const base = await classify(ctx, regions, new Map(), thermos);
  const sol = base.sol;

  const givens = new Map(sol.map((v, i) => [i, v]));
  const order = shuffle([...Array(81).keys()], 999);
  for (const i of order) {
    const trial = new Map(givens);
    trial.delete(i);
    const res = await classify(ctx, regions, trial, thermos);
    if (res.verdict === 'unique') givens.delete(i);
  }
  const finalCheck = await classify(ctx, regions, givens, thermos);
  if (finalCheck.verdict !== 'unique') throw new Error('internal: minimized set not unique');
  console.log('\nstandard: unique with', givens.size, 'givens');
  const givensLiteral = [...givens.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, v]) => `  '${Math.floor(i / 9) + 1},${(i % 9) + 1}': ${v}`)
    .join(',\n');
  console.log('{\n' + givensLiteral + '\n}');
  console.log('solution:', sol.join(' '));

  // 3) 无解样例：bulb 处给 9，却要求其后严格增大
  const unsat = await classify(ctx, regions, new Map([[rc(0, 0), 9]]), [thermos[0]]);
  console.log('unsat sample:', unsat.verdict, '(expect unsat)');

  // 4) 多解样例：仅两个提示、无温度计
  const multi = await classify(
    ctx, regions, new Map([[rc(0, 0), 1], [rc(8, 8), 9]]), []
  );
  console.log('multiple sample:', multi.verdict, '(expect multiple)');

  // 5) 改一个提示后旧结论失效
  const entries = [...givens.entries()];
  const [firstCell, firstVal] = entries[0];
  const changed = new Map(givens).set(firstCell, firstVal === 1 ? 2 : 1);
  const changedRes = await classify(ctx, regions, changed, thermos);
  console.log(
    `change R${Math.floor(firstCell / 9) + 1}C${(firstCell % 9) + 1} ${firstVal}->${changed.get(firstCell)}:`,
    changedRes.verdict,
    `(unique 旧结论失效)`
  );

  if (unsat.verdict !== 'unsat' || multi.verdict !== 'multiple' || changedRes.verdict === 'unique') {
    process.exitCode = 1;
  }

  // 6) 固化到 src/lib/sample-data.ts
  const rows = (arr, perLine) => {
    const lines = [];
    for (let i = 0; i < arr.length; i += perLine) {
      lines.push('  ' + arr.slice(i, i + perLine).join(', ') + ',');
    }
    return lines.join('\n');
  };
  const givensArr = new Array(81).fill(0);
  for (const [i, v] of givens) givensArr[i] = v;
  const out = `// 本文件由 scripts/gen-samples.mjs 自动生成（结论均经 Z3 双重 check 验证）。
// 不含任何答案层；solution 仅用于测试对照，发布构建可通过 tree-shaking/按需导入处理。

export const SAMPLE_REGIONS: number[] = [
${rows(regions, 9)}
];

export const SAMPLE_THERMOS: number[][][] = [
${thermos.map((t) => '  [' + t.map((i) => `[${Math.floor(i / 9) + 1}, ${(i % 9) + 1}]`).join(', ') + '],').join('\n')}
];

/** 标准题 givens（唯一解） */
export const SAMPLE_GIVENS: number[] = [
${rows(givensArr, 9)}
];

/** 无解题 givens：bulb R1C1=9 与其后必须严格增大的温度计矛盾 */
export const UNSAT_GIVENS: number[] = [
${rows((() => { const a = new Array(81).fill(0); a[rc(0, 0)] = 9; return a; })(), 9)}
];

/** 多解题 givens：仅 R1C1=1、R9C9=9，无温度计 */
export const MULTIPLE_GIVENS: number[] = [
${rows((() => { const a = new Array(81).fill(0); a[rc(0, 0)] = 1; a[rc(8, 8)] = 9; return a; })(), 9)}
];
`;
  writeFileSync(new URL('../src/lib/sample-data.ts', import.meta.url), out, 'utf8');
  console.log('\nwrote src/lib/sample-data.ts');
}

main().catch((e) => { console.error(e); process.exit(1); });
