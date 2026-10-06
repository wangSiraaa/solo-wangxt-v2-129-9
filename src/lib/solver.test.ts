import { describe, expect, it } from 'vitest';
import { initZ3Api } from './z3-init';
import { analyzePuzzle } from './solver';
import { validateStructure } from './puzzle';
import { multipleSample, standardSample, unsatSample } from './samples';

const z3 = await initZ3Api();

async function check(puzzle: ReturnType<typeof standardSample>, timeout = 20000) {
  return analyzePuzzle(z3, puzzle, validateStructure(puzzle), timeout);
}

describe('Z3 样例判定（双重 check：排除首解再求）', () => {
  it('标准题：唯一解', async () => {
    const res = await check(standardSample());
    expect(res.verdict).toBe('unique');
    expect(res.solution).not.toBeNull();
    expect(res.witness).toBeNull();
    // 解确实满足所有提示
    const p = standardSample();
    p.givens.forEach((g, i) => {
      if (g) expect(res.solution![i]).toBe(g);
    });
  }, 60000);

  it('无解题：unsat 且给出导致矛盾的约束核', async () => {
    const res = await check(unsatSample());
    expect(res.verdict).toBe('unsat');
    expect(res.solution).toBeNull();
    expect(res.conflict.length).toBeGreaterThan(0);
    // 矛盾核必须同时点名冲突提示与温度计
    const labels = res.conflict.map((c) => c.label).join(' | ');
    expect(labels).toContain('温度计');
    expect(labels).toContain('R1C1 = 9');
  }, 60000);

  it('多解题：multiple 且首解、二解不同', async () => {
    const res = await check(multipleSample());
    expect(res.verdict).toBe('multiple');
    expect(res.solution).not.toBeNull();
    expect(res.witness).not.toBeNull();
    expect(res.witness).not.toEqual(res.solution);
  }, 60000);

  it('结构非法不调用求解，直接作为矛盾返回', async () => {
    const p = standardSample();
    p.thermometers = [{ path: [0, 2] }]; // 非相邻
    const res = await check(p);
    expect(res.verdict).toBe('unsat');
    expect(res.reason).toBe('structure-invalid');
    expect(res.conflict.length).toBeGreaterThan(0);
  });
});
