// 独立复核已固化到 src/lib/sample-data.ts 的样例：
//   标准题 unique、无解题 unsat、多解题 multiple；
//   改动标准题任意一个提示后，结论不再是 unique（旧结论失效）。
// 用法：node scripts/verify-samples.mjs
import { init } from '../node_modules/z3-solver/build/node.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const N = 9;
const rc = (r, c) => r * N + c;

// 极简读取：从生成的 TS 中抽出三个数字数组
const src = readFileSync(
  fileURLToPath(new URL('../src/lib/sample-data.ts', import.meta.url)),
  'utf8'
);
function readArray(name) {
  const m = src.match(new RegExp(`export const ${name}\\s*:\\s*number\\[\\]\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!m) throw new Error(`missing ${name}`);
  return m[1].split(',').map((s) => s.trim()).filter(Boolean).map(Number);
}
const REGIONS = readArray('SAMPLE_REGIONS');
const GIVENS = readArray('SAMPLE_GIVENS');
const UNSAT_G = readArray('UNSAT_GIVENS');
const MULTI_G = readArray('MULTIPLE_GIVENS');
const THERMOS = [
  [rc(0, 0), rc(1, 0), rc(2, 0), rc(3, 0), rc(4, 0)],
  [rc(8, 8), rc(7, 8), rc(6, 8), rc(5, 8)]
];
if (REGIONS.length !== 81 || GIVENS.length !== 81) throw new Error('bad data length');

function range(a, b) { const o = []; for (let i = a; i < b; i++) o.push(i); return o; }

function build(ctx, givens, thermometers, timeout = 20000) {
  const { Bool, Or, Solver } = ctx;
  const x = Array.from({ length: 81 }, (_, i) =>
    Array.from({ length: 9 }, (_, d) => Bool.const(`x_${i}_${d}`))
  );
  const s = new Solver();
  s.set('timeout', timeout);
  for (let i = 0; i < 81; i++) {
    s.add(Or(...x[i]));
    for (let a = 0; a < 9; a++) for (let b = a + 1; b < 9; b++) s.add(Or(x[i][a].not(), x[i][b].not()));
  }
  const groups = [];
  for (let k = 0; k < 9; k++) {
    groups.push(range(0, 9).map((j) => rc(k, j)));
    groups.push(range(0, 9).map((j) => rc(j, k)));
  }
  const mem = Array.from({ length: 9 }, () => []);
  REGIONS.forEach((r, i) => mem[r].push(i));
  groups.push(...mem);
  for (const g of groups) for (let d = 0; d < 9; d++) {
    s.add(Or(...g.map((i) => x[i][d])));
    for (let a = 0; a < 9; a++) for (let b = a + 1; b < 9; b++)
      s.add(Or(x[g[a]][d].not(), x[g[b]][d].not()));
  }
  givens.forEach((v, i) => {
    if (!v) return;
    s.add(Or(x[i][v - 1]));
    for (let d = 0; d < 9; d++) if (d !== v - 1) s.add(Or(x[i][d].not()));
  });
  for (const t of thermometers) {
    for (let a = 0; a < t.length; a++) for (let b = a + 1; b < t.length; b++)
      for (let d = 0; d <= 8; d++) {
        const tail = range(d + 1, 9).map((e) => x[t[b]][e]);
        s.add(tail.length ? Or(x[t[a]][d].not(), ...tail) : Or(x[t[a]][d].not()));
      }
  }
  return { s, x };
}

async function classify(ctx, givens, thermometers) {
  const { Or } = ctx;
  const { s, x } = build(ctx, givens, thermometers);
  const r1 = await s.check();
  if (r1 !== 'sat') return r1;
  const sol = [];
  for (let i = 0; i < 81; i++) for (let d = 0; d < 9; d++) {
    const v = s.model().eval(x[i][d]);
    if (v.isTrue ? v.isTrue() : String(v) === 'true') { sol[i] = d + 1; break; }
  }
  s.add(Or(...x.map((arr, i) => arr[sol[i] - 1].not())));
  const r2 = await s.check();
  return r2 === 'unsat' ? 'unique' : r2 === 'sat' ? 'multiple' : 'unknown';
}

let failures = 0;
async function expect(name, actual, wanted) {
  const ok = actual === wanted;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${actual}${ok ? '' : ` (期望 ${wanted})`}`);
  if (!ok) failures++;
}

const { Context } = await init();
const ctx = new Context('verify');

await expect('标准题', await classify(ctx, GIVENS, THERMOS), 'unique');
await expect('无解题', await classify(ctx, UNSAT_G, [THERMOS[0]]), 'unsat');
await expect('多解题', await classify(ctx, MULTI_G, []), 'multiple');

// 改一个提示：任选第一个非零提示改成不同值，结论不应再是 unique
let changedVerdict = null;
for (let i = 0; i < 81; i++) {
  if (GIVENS[i]) {
    const g2 = [...GIVENS];
    g2[i] = GIVENS[i] === 9 ? 8 : GIVENS[i] + 1;
    changedVerdict = await classify(ctx, g2, THERMOS);
    console.log(`改提示 R${Math.floor(i / 9) + 1}C${(i % 9) + 1} ${GIVENS[i]}->${g2[i]}: ${changedVerdict}`);
    break;
  }
}
if (changedVerdict === 'unique') { console.log('FAIL  改提示后仍是 unique，旧结论未失效'); failures++; }
else console.log('PASS  改提示后旧 unique 结论失效');

process.exit(failures ? 1 : 0);
