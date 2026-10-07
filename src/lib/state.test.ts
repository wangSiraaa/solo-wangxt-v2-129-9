import { describe, expect, it } from 'vitest';
import { EditorState } from './state.svelte';
import { standardSample } from './samples';

// 不依赖 Z3：直接验证"题面指纹变化 => 旧结论必须失效"这一状态规则。
describe('改变提示后旧结论失效', () => {
  it('已有结论时修改一个提示，结论立即回到未检查状态', () => {
    const ed = new EditorState();
    ed.init(standardSample(), null, 't');
    const fpBefore = JSON.stringify({
      r: ed.puzzle.regions,
      g: ed.puzzle.givens,
      t: ed.puzzle.thermometers.map((x) => x.path)
    });
    // 模拟一次已完成的检查（含首解），并登记其指纹
    ed.analysis = {
      status: 'done',
      result: {
        verdict: 'unique',
        solution: new Array(81).fill(1),
        witness: null,
        conflict: [],
        reason: null,
        elapsedMs: 1
      },
      fingerprint: fpBefore,
      error: null,
      stage: null,
      elapsedMs: 1
    };
    expect(ed.analysis.status).toBe('done');

    // 找到一个现有提示并改动它
    const givenCell = ed.puzzle.givens.findIndex((g) => g !== 0);
    expect(givenCell).toBeGreaterThanOrEqual(0);
    const oldVal = ed.puzzle.givens[givenCell];
    ed.setGiven(givenCell, oldVal === 9 ? 8 : oldVal + 1);

    // 旧结论必须失效：不再宣称唯一
    expect(ed.analysis.status).toBe('idle');
    expect(ed.analysis.result).toBeNull();
    expect(ed.analysis.fingerprint).toBeNull();
  });

  it('未产生过结论时修改题面保持空闲，不报错', () => {
    const ed = new EditorState();
    ed.init(standardSample(), null, 't');
    ed.setGiven(0, ed.puzzle.givens[0] ? 1 : 7);
    expect(ed.analysis.status).toBe('idle');
  });

  it('结构问题出现时 issues 被填充', () => {
    const ed = new EditorState();
    ed.init(standardSample(), null, 't');
    // 把温度计最后一格替换成与前一格不相邻的远格，制造结构错误
    const t = ed.puzzle.thermometers[0];
    if (t) {
      const p = standardSample();
      p.thermometers[0].path[t.path.length - 1] = 80;
      ed.init(p, null, 't2');
      expect(ed.issues.length).toBeGreaterThan(0);
    }
  });
});
