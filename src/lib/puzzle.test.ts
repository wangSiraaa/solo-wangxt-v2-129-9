import { describe, expect, it } from 'vitest';
import {
  areOrthogonallyAdjacent,
  blankPuzzle,
  clonePuzzle,
  exportPuzzle,
  importPuzzle,
  rc,
  validateStructure,
  type Puzzle
} from './puzzle';

function p(mut?: (p: Puzzle) => void): Puzzle {
  const x = blankPuzzle();
  mut?.(x);
  return x;
}

describe('validateStructure — 宫区覆盖', () => {
  it('标准 3x3 宫无结构问题', () => {
    expect(validateStructure(blankPuzzle())).toEqual([]);
  });

  it('宫编号越界被检出', () => {
    const issues = validateStructure(p((x) => void (x.regions[0] = 9)));
    expect(issues.some((i) => i.code === 'REGION_ID_OUT_OF_RANGE')).toBe(true);
    expect(issues.some((i) => i.code === 'REGION_UNUSED' || i.code === 'REGION_SIZE')).toBe(true);
  });

  it('宫大小不为 9 被检出（宫区未均匀覆盖）', () => {
    // 把一个格子从宫 0 改划到宫 1
    const issues = validateStructure(
      p((x) => {
        x.regions[0] = 1;
      })
    );
    expect(issues.some((i) => i.code === 'REGION_SIZE')).toBe(true);
  });

  it('不连通的宫被检出', () => {
    // 构造：宫 0 取 (0,0) 和 (0,2) 等不相邻格。交换标准分区中的两格，
    // 使宫 0 被撕开（与对角位置的宫交换，保证断开）。
    const x = blankPuzzle();
    // 宫0: 0..2,9..11,18..20。把 0 与 30（宫4内部）交换
    x.regions[0] = 4;
    x.regions[30] = 0;
    const issues = validateStructure(x);
    expect(issues.some((i) => i.code === 'REGION_DISCONNECTED')).toBe(true);
  });
});

describe('validateStructure — 格子范围', () => {
  it('非法提示值被检出', () => {
    const issues = validateStructure(p((x) => void (x.givens[10] = 10)));
    expect(issues.some((i) => i.code === 'GIVEN_OUT_OF_RANGE')).toBe(true);
  });
  it('负数提示被检出', () => {
    const issues = validateStructure(p((x) => void (x.givens[10] = -1)));
    expect(issues.some((i) => i.code === 'GIVEN_OUT_OF_RANGE')).toBe(true);
  });
});

describe('validateStructure — 温度计自交/邻接/越界', () => {
  it('路径重复格（自交）被检出', () => {
    const issues = validateStructure(
      p((x) => {
        x.thermometers = [{ path: [rc(0, 0), rc(0, 1), rc(0, 0)] }];
      })
    );
    expect(issues.some((i) => i.code === 'THERMO_REPEATED_CELL')).toBe(true);
  });

  it('非正交相邻（跨步）被检出', () => {
    const issues = validateStructure(
      p((x) => {
        x.thermometers = [{ path: [rc(0, 0), rc(0, 2)] }];
      })
    );
    expect(issues.some((i) => i.code === 'THERMO_NON_ADJACENT')).toBe(true);
  });

  it('对角线一步被检出', () => {
    expect(areOrthogonallyAdjacent(rc(0, 0), rc(1, 1))).toBe(false);
    const issues = validateStructure(
      p((x) => {
        x.thermometers = [{ path: [rc(0, 0), rc(1, 1)] }];
      })
    );
    expect(issues.some((i) => i.code === 'THERMO_NON_ADJACENT')).toBe(true);
  });

  it('越界下标被检出', () => {
    const issues = validateStructure(
      p((x) => {
        x.thermometers = [{ path: [rc(0, 0), 99] }];
      })
    );
    expect(issues.some((i) => i.code === 'THERMO_CELL_OUT_OF_RANGE')).toBe(true);
  });

  it('长度不足 2 被检出', () => {
    const issues = validateStructure(
      p((x) => {
        x.thermometers = [{ path: [rc(0, 0)] }];
      })
    );
    expect(issues.some((i) => i.code === 'THERMO_TOO_SHORT')).toBe(true);
  });

  it('合法的弯折温度计通过', () => {
    const issues = validateStructure(
      p((x) => {
        x.thermometers = [{ path: [rc(0, 0), rc(1, 0), rc(1, 1), rc(2, 1)] }];
      })
    );
    expect(issues).toEqual([]);
  });
});

describe('导出不泄露答案层', () => {
  it('exportPuzzle 只含题面字段', () => {
    const x = blankPuzzle();
    x.givens[0] = 5;
    const exported = exportPuzzle(x) as unknown as Record<string, unknown>;
    expect(exported.format).toBe('thermo-jigsaw-sudoku');
    expect(exported.kind).toBe('puzzle');
    expect(exported).not.toHaveProperty('solution');
    expect(exported).not.toHaveProperty('lastCheck');
    expect(exported).not.toHaveProperty('answer');
    expect(Object.keys(exported).sort()).toEqual(
      ['exportedAt', 'format', 'givens', 'kind', 'regions', 'thermometers', 'version'].sort()
    );
  });

  it('导入导出往返一致', () => {
    const x = blankPuzzle();
    x.givens[0] = 5;
    x.thermometers = [{ path: [rc(0, 0), rc(0, 1)] }];
    const back = importPuzzle(exportPuzzle(clonePuzzle(x)));
    expect(back.givens).toEqual(x.givens);
    expect(back.thermometers).toEqual(x.thermometers);
    expect(back.regions).toEqual(x.regions);
  });
});
