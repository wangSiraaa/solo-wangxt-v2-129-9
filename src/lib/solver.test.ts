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

  it('阶段回调覆盖结构/编码/两次检查/完成', async () => {
    const stages: string[] = [];
    const res = await analyzePuzzle(
      z3,
      standardSample(),
      [],
      20000,
      { onStage: (s) => stages.push(s) }
    );
    expect(res.verdict).toBe('unique');
    expect(stages).toEqual(['structure', 'encoding', 'check-sat-1', 'check-sat-2', 'done']);
  }, 60000);

  it('总预算为 1ms：判定未判定（budget-exceeded），且不保留首解', async () => {
    const res = await analyzePuzzle(z3, standardSample(), [], 20000, {
      totalBudgetMs: 1
    });
    expect(res.verdict).toBe('unknown');
    expect(res.reason).toBe('budget-exceeded');
    // 超预算绝不能把未完成的首解保留为结论
    expect(res.solution).toBeNull();
    expect(res.witness).toBeNull();
  }, 60000);

  it('启动前即取消：直接未判定（cancelled），不调用求解', async () => {
    const res = await analyzePuzzle(z3, standardSample(), [], 20000, {
      isCancelled: () => true
    });
    expect(res.verdict).toBe('unknown');
    expect(res.reason).toBe('cancelled');
    expect(res.solution).toBeNull();
  });

  it('求解中收到中断+取消：未判定（cancelled），不保留首解', async () => {
    let interrupt: (() => void) | null = null;
    let cancelled = false;
    const pending = analyzePuzzle(z3, standardSample(), [], 20000, {
      registerInterrupt: (fn) => {
        interrupt = fn;
      },
      isCancelled: () => cancelled,
      onStage: (stage) => {
        // 确定性地在第二次检查开始时取消（首解已求出，正排除首解）
        if (stage === 'check-sat-2') {
          cancelled = true;
          interrupt?.();
        }
      }
    });
    const res = await pending;
    expect(res.verdict).toBe('unknown');
    expect(res.reason).toBe('cancelled');
    // 即使首解已存在，取消也不保留它
    expect(res.solution).toBeNull();
  }, 60000);
});
