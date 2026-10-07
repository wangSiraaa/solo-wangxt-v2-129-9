<script lang="ts">
  import { onMount } from 'svelte';
  import SudokuCanvas from './components/SudokuCanvas.svelte';
  import Toolbar from './components/Toolbar.svelte';
  import AnalysisPanel from './components/AnalysisPanel.svelte';
  import DraftsPanel from './components/DraftsPanel.svelte';
  import ExportPanel from './components/ExportPanel.svelte';
  import { editor } from './lib/state.svelte';
  import { blankPuzzle } from './lib/puzzle';
  import { multipleSample, standardSample, unsatSample } from './lib/samples';

  onMount(() => {
    editor.init(standardSample(), null, '标准样例-唯一解');
    editor.startEngine();

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function onKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key >= '1' && e.key <= '9') editor.pressDigit(Number(e.key));
    if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') editor.pressDigit(0);
    if (e.key === 'Enter' && (editor.tool === 'thermo-extend')) editor.finishThermo();
  }

  function loadSample(kind: 'standard' | 'unsat' | 'multiple' | 'blank') {
    if (kind === 'standard') editor.init(standardSample(), null, '标准样例-唯一解');
    else if (kind === 'unsat') editor.init(unsatSample(), null, '样例-无解题');
    else if (kind === 'multiple') editor.init(multipleSample(), null, '样例-多解题');
    else editor.init(blankPuzzle(), null, '新空白题');
    editor.highlightCells = new Set();
  }
</script>

<main>
  <header>
    <h1>不规则宫温度计 数独作者工作室</h1>
    <div class="samples">
      <button onclick={() => loadSample('standard')}>载入标准题（唯一解）</button>
      <button onclick={() => loadSample('unsat')}>载入无解题</button>
      <button onclick={() => loadSample('multiple')}>载入多解题</button>
      <button onclick={() => loadSample('blank')}>空白题</button>
    </div>
  </header>

  <div class="layout">
    <section class="board">
      <SudokuCanvas />
    </section>
    <aside class="side">
      <Toolbar />
      <AnalysisPanel />
      <DraftsPanel />
      <ExportPanel />
    </aside>
  </div>

  <footer>
    求解由 Z3 WASM 在本地浏览器的独立 Worker 中完成（可取消、带耗时预算），无后台服务；
    唯一解判定采用 <em>先求首解、再排除首解重求</em> 的两次检查。
  </footer>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #111827;
    background: #f9fafb;
  }
  main { max-width: 1280px; margin: 0 auto; padding: 16px 20px 40px; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  h1 { font-size: 18px; margin: 0; }
  .samples { display: flex; gap: 6px; flex-wrap: wrap; }
  .samples button {
    border: 1px solid #d1d5db; background: #fff; border-radius: 6px;
    padding: 5px 9px; font-size: 12px; cursor: pointer;
  }
  .layout { display: grid; grid-template-columns: auto 380px; gap: 18px; align-items: start; }
  .board { position: sticky; top: 12px; }
  .side { display: flex; flex-direction: column; gap: 14px; }
  footer { margin-top: 24px; font-size: 12px; color: #6b7280; }
  @media (max-width: 980px) {
    .layout { grid-template-columns: 1fr; }
    .board { position: static; }
  }
</style>
