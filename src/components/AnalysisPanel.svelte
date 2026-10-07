<script lang="ts">
  import { editor } from '../lib/state.svelte';
  import { rowOf, colOf } from '../lib/puzzle';
  import type { CheckPhase } from '../lib/solver';

  const a = $derived(editor.analysis);

  const verdictText: Record<string, string> = {
    unique: '唯一解 ✓',
    multiple: '多解 ✗（至少两个解）',
    unsat: '无解 ✗（约束矛盾）',
    unknown: '未判定'
  };

  const phaseText: Record<CheckPhase, string> = {
    encode: '阶段 0/2：编码约束',
    check1: '阶段 1/2：求首解',
    check2: '阶段 2/2：排除首解，验证唯一性'
  };

  // 检查中的实时用时（每 100ms 刷新一次）
  let now = $state(Date.now());
  $effect(() => {
    if (a.status !== 'checking') return;
    const t = setInterval(() => (now = Date.now()), 100);
    return () => clearInterval(t);
  });
  const elapsedMs = $derived(a.status === 'checking' && a.startedAt ? now - a.startedAt : 0);
</script>

<div class="panel">
  <div class="row">
    <button
      class="check"
      disabled={editor.z3Loading || a.status === 'checking'}
      onclick={() => editor.runCheck()}
    >
      {#if editor.z3Loading}
        正在加载 Z3 WASM…
      {:else if a.status === 'checking'}
        检查中…
      {:else}
        检查可解性与唯一解
      {/if}
    </button>
    {#if a.status === 'checking'}
      <button class="cancel" onclick={() => editor.cancelCheck()}>取消</button>
    {/if}
    <label class="timeout">
      每次判定超时
      <select bind:value={editor.timeoutMs}>
        <option value={2000}>2 秒</option>
        <option value={5000}>5 秒</option>
        <option value={15000}>15 秒</option>
        <option value={30000}>30 秒</option>
      </select>
    </label>
  </div>

  {#if editor.z3Error}
    <p class="error">Z3 加载失败：{editor.z3Error}（需通过带 COOP/COEP 头的服务访问）</p>
  {/if}

  {#if a.status === 'checking'}
    <div class="progress">
      <div class="phase-row">
        <span class="phase">{phaseText[a.phase ?? 'encode']}</span>
        <span class="elapsed">已用时 {(elapsedMs / 1000).toFixed(1)} s</span>
      </div>
      {#if a.budgetMs}
        <p class="hint">
          在独立 Worker 中运行，页面不卡顿；超过预算约 {Math.round(a.budgetMs / 1000)} s
          将自动取消。取消或超时只记录「未判定」。
        </p>
      {/if}
    </div>
  {/if}

  {#if editor.issues.length > 0}
    <div class="issues">
      <h4>结构校验（求解前必须先修复）</h4>
      <ul>
        {#each editor.issues as issue (issue.code + issue.cells.join(','))}
          <li>{issue.message}</li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if a.status === 'idle' && !a.result && editor.issues.length === 0}
    <p class="hint">结构合法。点击上方按钮：Z3 先求首解；若可解，会<b>排除首解再求一次</b>，才能判定唯一。</p>
  {/if}

  {#if a.status === 'done' && a.result}
    {@const r = a.result}
    <div class="verdict {r.verdict}">
      <span class="badge {r.verdict}">{verdictText[r.verdict]}</span>
      <span class="ms">{Math.round(r.elapsedMs)} ms</span>
      {#if r.verdict === 'unique'}
        <label class="sol-toggle">
          <input type="checkbox" bind:checked={editor.showSolution} />
          显示答案层（仅本地作者可见）
        </label>
      {/if}
    </div>

    {#if r.verdict === 'unknown'}
      {#if r.reason === 'cancelled'}
        <p class="warn-text">
          检查已取消。本次仅记录<b>未判定</b>：未完成的求解（包括已找到的首解）不会作为结论保留。
        </p>
      {:else}
        <p class="warn-text">
          求解器在时限内未能判定（{r.reason ?? 'timeout'}）。
          {#if r.solution}已找到一个解，但<b>无法确认它是否唯一</b>。请加长超时或增删提示后重试。{:else}本次未能找到解，也未能证明无解，结论为<b>未判定</b>。{/if}
        </p>
      {/if}
    {/if}

    {#if r.verdict === 'unsat'}
      <div class="conflict">
        <h4>导致矛盾的一组约束（unsat core）</h4>
        <ul>
          {#each r.conflict as c, i (i)}
            <li>
              {c.label}
              {#if c.cells.length}
                <button
                  class="locate"
                  onclick={() => (editor.selectedCell = c.cells[0])}
                >定位 {c.cells.map((x) => `R${rowOf(x) + 1}C${colOf(x) + 1}`).join(' ')}</button>
              {/if}
            </li>
          {/each}
        </ul>
        {#if r.reason === 'structure-invalid'}
          <p class="hint">以上为编辑期结构校验结果，未调用求解器。</p>
        {/if}
      </div>
    {/if}

    {#if r.verdict === 'multiple'}
      <p class="warn-text">
        已找到至少两个不同的合法填法（排除首解后仍能再求出一个解），
        因此题目不唯一。增加提示或温度计约束后再检查。
      </p>
    {/if}
  {/if}

  {#if a.error}
    <p class="error">检查出错：{a.error}</p>
  {/if}
</div>

<style>
  .panel { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; background: #fafafa; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .check {
    background: #111827; color: #fff; border: none; border-radius: 6px;
    padding: 9px 14px; font-size: 14px; cursor: pointer;
  }
  .check:disabled { opacity: 0.6; cursor: default; }
  .cancel {
    background: #fff; color: #b91c1c; border: 1px solid #fca5a5; border-radius: 6px;
    padding: 8px 14px; font-size: 13px; cursor: pointer;
  }
  .cancel:hover { background: #fef2f2; }
  .timeout { font-size: 12px; color: #4b5563; display: flex; gap: 6px; align-items: center; }
  select { padding: 4px; }
  h4 { margin: 10px 0 6px; font-size: 13px; }
  ul { margin: 0; padding-left: 18px; font-size: 13px; }
  li { margin: 3px 0; }
  .issues { margin-top: 10px; }
  .hint { font-size: 12px; color: #6b7280; }
  .error { color: #dc2626; font-size: 13px; }
  .progress { margin-top: 10px; }
  .phase-row { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .phase { font-size: 13px; font-weight: 600; color: #1f2937; }
  .elapsed { font-size: 12px; color: #6b7280; font-variant-numeric: tabular-nums; }
  .verdict { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
  .badge { padding: 3px 10px; border-radius: 999px; font-size: 13px; font-weight: 600; }
  .badge.unique { background: #dcfce7; color: #166534; }
  .badge.multiple, .badge.unsat { background: #fee2e2; color: #991b1b; }
  .badge.unknown { background: #fef9c3; color: #854d0e; }
  .ms { font-size: 12px; color: #6b7280; }
  .sol-toggle { font-size: 12px; display: flex; gap: 4px; align-items: center; }
  .warn-text { font-size: 13px; color: #92400e; }
  .locate {
    margin-left: 6px; font-size: 11px; border: 1px solid #d1d5db;
    background: #fff; border-radius: 4px; padding: 1px 6px; cursor: pointer;
  }
</style>
