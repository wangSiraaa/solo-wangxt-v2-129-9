import { describe, expect, it } from 'vitest';
import { EditorState } from './state.svelte';
import { standardSample } from './samples';
import { puzzleFingerprint } from './puzzle';
import {
  CheckCancelledError,
  type CheckExecutor,
  type CheckRequest
} from './check-types';
import type { CheckPhase, SolveResult } from './solver';

const uniqueResult: SolveResult = {
  verdict: 'unique',
  solution: new Array(81).fill(1),
  witness: null,
  conflict: [],
  reason: null,
  elapsedMs: 1
};

/** 测试替身：模拟 Worker 执行器。run 挂起，由测试手动 settle；cancel 行为可配。 */
class FakeExecutor implements CheckExecutor {
  ready = Promise.resolve();
  requests: CheckRequest[] = [];
  phases: CheckPhase[] = [];
  cancelCount = 0;
  /** true 时 cancel() 立即以 CheckCancelledError 拒绝挂起的 run（模拟 terminate Worker） */
  autoRejectOnCancel = true;
  onRun: ((req: CheckRequest, onPhase: (p: CheckPhase) => void) => void) | null = null;
  pending: { resolve: (r: SolveResult) => void; reject: (e: Error) => void } | null = null;

  run(req: CheckRequest, onPhase: (p: CheckPhase) => void): Promise<SolveResult> {
    this.requests.push(req);
    return new Promise<SolveResult>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.onRun?.(req, (phase) => {
        this.phases.push(phase);
        onPhase(phase);
      });
    });
  }

  cancel() {
    this.cancelCount++;
    if (this.autoRejectOnCancel && this.pending) {
      const p = this.pending;
      this.pending = null;
      p.reject(new CheckCancelledError('cancelled'));
    }
  }
}

function newEditor() {
  const ed = new EditorState();
  ed.init(standardSample(), null, 't');
  const exec = new FakeExecutor();
  ed.setExecutor(exec);
  return { ed, exec };
}

/** 改动一个现有提示数字 */
function mutateOneGiven(ed: EditorState) {
  const cell = ed.puzzle.givens.findIndex((g) => g !== 0);
  expect(cell).toBeGreaterThanOrEqual(0);
  const old = ed.puzzle.givens[cell];
  ed.setGiven(cell, old === 9 ? 8 : old + 1);
}

// 不依赖 Z3：直接验证"题面指纹变化 => 旧结论必须失效"这一状态规则。
describe('改变提示后旧结论失效', () => {
  it('已有结论时修改一个提示，结论立即回到未检查状态', () => {
    const ed = new EditorState();
    ed.init(standardSample(), null, 't');
    const fpBefore = puzzleFingerprint(ed.puzzle);
    // 模拟一次已完成的检查（含首解），并登记其指纹
    ed.analysis = {
      status: 'done',
      result: { ...uniqueResult },
      fingerprint: fpBefore,
      error: null,
      phase: null,
      startedAt: null,
      budgetMs: null
    };
    expect(ed.analysis.status).toBe('done');

    mutateOneGiven(ed);

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

describe('可取消的检查任务（Worker 执行器）', () => {
  it('取消第二次检查：只记录"未判定"，不保留首解为结论', async () => {
    const { ed, exec } = newEditor();
    exec.onRun = (_req, onPhase) => {
      onPhase('encode');
      onPhase('check1');
      onPhase('check2'); // 已进入第二次检查
    };
    const p = ed.runCheck();
    // 阶段与用时应已展示
    expect(ed.analysis.status).toBe('checking');
    expect(ed.analysis.phase).toBe('check2');
    expect(ed.analysis.startedAt).not.toBeNull();

    ed.cancelCheck();
    await p;

    expect(exec.cancelCount).toBe(1);
    expect(ed.analysis.status).toBe('done');
    expect(ed.analysis.result?.verdict).toBe('unknown');
    expect(ed.analysis.result?.reason).toBe('cancelled');
    // 未完成的首解不得作为结论保留
    expect(ed.analysis.result?.solution).toBeNull();
    expect(ed.analysis.phase).toBeNull();
  });

  it('超预算（耗时预算耗尽）：同样只记录"未判定"', async () => {
    const { ed, exec } = newEditor();
    exec.autoRejectOnCancel = false;
    exec.onRun = () => {
      // 模拟预算耗尽：执行器以 timeout 取消失败拒绝
      exec.pending?.reject(new CheckCancelledError('timeout'));
      exec.pending = null;
    };
    await ed.runCheck();
    expect(ed.analysis.status).toBe('done');
    expect(ed.analysis.result?.verdict).toBe('unknown');
    expect(ed.analysis.result?.reason).toBe('timeout');
    expect(ed.analysis.result?.solution).toBeNull();
  });

  it('启动后立即修改题面：旧任务被作废，迟到的旧结果不能回写', async () => {
    const { ed, exec } = newEditor();
    exec.autoRejectOnCancel = false; // 旧 Worker 不拒绝，稍后"迟到地"返回结果
    const p = ed.runCheck();
    expect(ed.analysis.status).toBe('checking');

    mutateOneGiven(ed);

    // 题面变化 => 旧任务取消、状态回到 idle
    expect(exec.cancelCount).toBe(1);
    expect(ed.analysis.status).toBe('idle');
    expect(ed.analysis.result).toBeNull();

    // 旧 Worker 的结果迟到到达：不得覆盖新题面状态
    exec.pending?.resolve({ ...uniqueResult });
    exec.pending = null;
    await p;
    expect(ed.analysis.status).toBe('idle');
    expect(ed.analysis.result).toBeNull();
  });

  it('题面变化后重试：仍使用当前题面指纹', async () => {
    const { ed, exec } = newEditor();
    exec.autoRejectOnCancel = false;
    const first = ed.runCheck();
    mutateOneGiven(ed);
    exec.pending?.reject(new CheckCancelledError('cancelled'));
    exec.pending = null;
    await first;
    expect(ed.analysis.status).toBe('idle');

    // 重试
    exec.onRun = (_req, onPhase) => {
      onPhase('check1');
      onPhase('check2');
      exec.pending?.resolve({ ...uniqueResult });
      exec.pending = null;
    };
    await ed.runCheck();

    expect(exec.requests).toHaveLength(2);
    const fpNow = puzzleFingerprint(ed.puzzle);
    // 第二次请求携带的题面快照，其指纹必须等于当前题面指纹
    expect(puzzleFingerprint(exec.requests[1].puzzle)).toBe(fpNow);
    expect(puzzleFingerprint(exec.requests[0].puzzle)).not.toBe(fpNow);
    expect(ed.analysis.status).toBe('done');
    expect(ed.analysis.fingerprint).toBe(fpNow);
  });

  it('正常唯一解：两次检查都完成后结论与指纹落库', async () => {
    const { ed, exec } = newEditor();
    exec.onRun = (_req, onPhase) => {
      onPhase('encode');
      onPhase('check1');
      onPhase('check2');
      exec.pending?.resolve({ ...uniqueResult });
      exec.pending = null;
    };
    await ed.runCheck();
    expect(exec.phases).toEqual(['encode', 'check1', 'check2']);
    expect(ed.analysis.status).toBe('done');
    expect(ed.analysis.result?.verdict).toBe('unique');
    // 结论指纹与当前题面一致：保存/刷新后只会保留指纹相符的结论
    expect(ed.analysis.fingerprint).toBe(puzzleFingerprint(ed.puzzle));
  });

  it('检查进行中再次点击检查被忽略', async () => {
    const { ed, exec } = newEditor();
    exec.autoRejectOnCancel = false;
    const p = ed.runCheck();
    await ed.runCheck(); // 第二次调用应直接返回
    expect(exec.requests).toHaveLength(1);
    exec.pending?.resolve({ ...uniqueResult });
    await p;
    expect(ed.analysis.status).toBe('done');
  });
});
