// 内置样例：标准题（唯一解）、无解题、多解题。
// 数据由 scripts/gen-samples.mjs 用 Z3 双重 check 验证后固化到 sample-data.ts。
import { blankPuzzle, rc, type Puzzle } from './puzzle';
import {
  MULTIPLE_GIVENS,
  SAMPLE_GIVENS,
  SAMPLE_REGIONS,
  SAMPLE_THERMOS,
  UNSAT_GIVENS
} from './sample-data';

function makePuzzle(givens: number[], thermosRC: number[][][]): Puzzle {
  const p = blankPuzzle();
  p.regions = [...SAMPLE_REGIONS];
  p.givens = [...givens];
  p.thermometers = thermosRC.map((cells) => ({
    path: cells.map(([r, c]) => rc(r - 1, c - 1))
  }));
  return p;
}

/** 标准题：不规则宫 + 两支温度计，Z3 验证为唯一解 */
export function standardSample(): Puzzle {
  return makePuzzle(SAMPLE_GIVENS, SAMPLE_THERMOS);
}

/**
 * 无解题：bulb R1C1=9，而温度计要求从 bulb 起严格增大，
 * 9 之后不存在更大数字 => 直接矛盾（unsat core 会同时指出该提示与温度计首段）。
 */
export function unsatSample(): Puzzle {
  return makePuzzle(UNSAT_GIVENS, [SAMPLE_THERMOS[0]]);
}

/** 多解题：仅两个提示且无温度计，Z3 排除首解后仍可找到第二个解 */
export function multipleSample(): Puzzle {
  return makePuzzle(MULTIPLE_GIVENS, []);
}
