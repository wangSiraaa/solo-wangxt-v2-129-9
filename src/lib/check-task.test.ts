import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from './state.svelte';
import { standardSample } from './samples';
import { puzzleFingerprint } from './puzzle';
import type { CheckResponse, CheckRequest } from './check-protocol';
import type { SolveResult } from './solver';

/**
 * 捕获 EditorState 内部创建的 Worker：以桩件代替真实 Worker
 * （jsdom 没有 Worker 构造器，也不加载 Z3 WASM）。
 */
interface FakeWorker {
  posted: CheckRequest[];
  terminated: boolean;
  listeners: {
    message: ((ev: MessageEvent<CheckResponse>) => void)[];
    error: ((ev: ErrorEvent) => void)[];
  };
  postMessage: (m: CheckRequest) => void;
  terminate: () => void;
  addEventListener: (t: 'message' | 'error', fn: (ev: never) => void) => void;
  emit: (m: CheckResponse) => void;
}

let current: FakeWorker | null = null;

function uniqueResult(): SolveResult {
  return {
    verdict: 'unique',
    solution: new Array(81).fill(1),
    witness: null,
    conflict: [],
    reason: null,
    elapsedMs: 1234
  };
}

describe('可取消检查任务与指纹防回写', () => {
  beforeEach(() => {
    current = null;
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          const w: FakeWorker = {
            posted: [],
            terminated: false,
            listeners: { message: [], error: [] },
            postMessage(m: CheckRequest) {
              w.posted.push(m);
            },
            terminate() {
              w.terminated = true;
            },
            addEventListener(type, fn) {
              w.listeners[type].push(fn as never);
            },
            emit(m) {
              w.listeners.message.forEach((fn) => fn({ data: m } as MessageEvent<CheckResponse>));
            }
          };
          current = w;
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          Object.assign(this, w);
        }
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function readyEditor(): EditorState {
    const ed = new EditorState();
    ed.init(standardSample(), null, 't');
    ed.loadZ3();
    current!.emit({ type: 'ready' });
    return ed;
  }

  it('启动检查后立即修改题面：旧 Worker 被终止，旧结果不能回写', () => {
    const ed = readyEditor();
    const worker = current!;
    void ed.runCheck();
    expect(ed.analysis.status).toBe('checking');
    const startMsg = worker.posted.find(
      (m): m is CheckRequest & { type: 'start' } => m.type === 'start'
    );
    expect(startMsg).toBeDefined();
    const runId = startMsg!.runId;

    // 立即改动一个提示
    const givenCell = ed.puzzle.givens.findIndex((g) => g !== 0);
    ed.setGiven(givenCell, ed.puzzle.givens[givenCell] === 9 ? 8 : ed.puzzle.givens[givenCell] + 1);

    // 旧 Worker 已被终止；界面回到未检查
    expect(worker.terminated).toBe(true);
    expect(ed.analysis.status).toBe('idle');
    expect(ed.analysis.result).toBeNull();

    // 旧 Worker 的迟到结果（哪怕带旧指纹）不得覆盖新题面状态
    worker.emit({ type: 'finished', runId, fingerprint: startMsg!.fingerprint, result: uniqueResult() });
    expect(ed.analysis.status).toBe('idle');
    expect(ed.analysis.result).toBeNull();
  });

  it('取消第二次检查后显示未判定，且不保留首解', async () => {
    const ed = readyEditor();
    const worker = current!;
    void ed.runCheck();
    const startMsg = worker.posted.find((m) => m.type === 'start')!;
    expect(startMsg.type).toBe('start');

    // 进入第二次检查阶段后取消
    worker.emit({ type: 'stage', runId: startMsg.runId, stage: 'check-sat-2' });
    expect(ed.analysis.stage).toBe('check-sat-2');
    ed.cancelCheck();

    // 向 Worker 发出了取消消息；界面结论为未判定
    const cancel = worker.posted.find((m) => m.type === 'cancel');
    expect(cancel).toBeDefined();
    expect(ed.analysis.status).toBe('done');
    expect(ed.analysis.result?.verdict).toBe('unknown');
    expect(ed.analysis.result?.reason).toBe('cancelled');
    expect(ed.analysis.result?.solution).toBeNull();

    // Worker 中断后迟到的旧任务结果必须被丢弃（runId 已失效）
    worker.emit({
      type: 'finished',
      runId: startMsg.runId,
      fingerprint: startMsg.fingerprint,
      result: uniqueResult()
    });
    expect(ed.analysis.result?.verdict).toBe('unknown');
  });

  it('Worker 返回与当前题面不符的指纹时，结果被丢弃', () => {
    const ed = readyEditor();
    const worker = current!;
    void ed.runCheck();
    const startMsg = worker.posted.find((m) => m.type === 'start')!;
    expect(startMsg.type).toBe('start');

    worker.emit({
      type: 'finished',
      runId: startMsg.runId,
      fingerprint: 'stale-fingerprint',
      result: uniqueResult()
    });
    expect(ed.analysis.status).toBe('idle');
    expect(ed.analysis.result).toBeNull();
  });

  it('刷新（重新载入草稿数据）只保留与当前指纹相符的结论', () => {
    // 复刻 DraftsPanel.open 的恢复判定：
    //   rec.lastCheck && rec.checkFingerprint === puzzleFingerprint(rec.puzzle)
    const puzzle = standardSample();
    const fp = puzzleFingerprint(puzzle);
    const matching = { lastCheck: uniqueResult(), checkFingerprint: fp };
    expect(
      matching.lastCheck && matching.checkFingerprint === puzzleFingerprint(puzzle)
    ).toBeTruthy();

    // 旧结论对应的题面指纹与当前题面不符 => 不恢复
    const changed = standardSample();
    const cell = changed.givens.findIndex((g) => g !== 0);
    changed.givens[cell] = changed.givens[cell] === 9 ? 8 : changed.givens[cell] + 1;
    const staleRec = { lastCheck: uniqueResult(), checkFingerprint: fp };
    expect(staleRec.checkFingerprint === puzzleFingerprint(changed)).toBe(false);

    // EditorState 侧：以错误指纹恢复后，任何题面变更都会立即清退旧结论
    const ed = new EditorState();
    ed.init(changed, null, 't');
    ed.analysis = {
      status: 'done',
      result: staleRec.lastCheck,
      fingerprint: fp, // 故意与当前题面不符
      error: null,
      stage: null,
      elapsedMs: 1
    };
    ed.revalidate();
    expect(ed.analysis.status).toBe('idle');
    expect(ed.analysis.result).toBeNull();
  });

  it('检查中实时展示阶段与用时（ticker 刷新 elapsedMs）', () => {
    vi.useFakeTimers();
    const base = performance.now();
    vi.spyOn(performance, 'now').mockImplementation(() => base);
    const ed = readyEditor();
    void ed.runCheck();
    expect(ed.analysis.status).toBe('checking');
    expect(ed.analysis.elapsedMs).toBe(0);

    vi.spyOn(performance, 'now').mockImplementation(() => base + 350);
    vi.advanceTimersByTime(350);
    expect(ed.analysis.elapsedMs).toBeGreaterThanOrEqual(300);

    const startMsg = current!.posted.find((m) => m.type === 'start')!;
    current!.emit({
      type: 'stage',
      runId: (startMsg as { runId: number }).runId,
      stage: 'check-sat-1'
    });
    expect(ed.analysis.stage).toBe('check-sat-1');
  });

  it('正常完成时记录结论与当前指纹', () => {
    const ed = readyEditor();
    void ed.runCheck();
    const startMsg = current!.posted.find((m) => m.type === 'start')!;
    expect(startMsg.type).toBe('start');
    current!.emit({
      type: 'finished',
      runId: startMsg.runId,
      fingerprint: puzzleFingerprint(ed.puzzle),
      result: uniqueResult()
    });
    expect(ed.analysis.status).toBe('done');
    expect(ed.analysis.result?.verdict).toBe('unique');
    expect(ed.analysis.fingerprint).toBe(puzzleFingerprint(ed.puzzle));
  });
});
