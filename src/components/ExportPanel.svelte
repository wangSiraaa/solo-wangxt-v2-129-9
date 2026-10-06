<script lang="ts">
  import { editor } from '../lib/state.svelte';
  import {
    exportPuzzle,
    importPuzzle
  } from '../lib/puzzle';

  let message = $state('');
  let importOpen = $state(false);
  let importText = $state('');

  function exportJson(): string {
    // 导出题面：exportPuzzle 只含 regions/givens/thermometers，
    // 不含 solution / lastCheck 等作者私有答案层。
    return JSON.stringify(exportPuzzle(editor.puzzle), null, 2);
  }

  function download() {
    const blob = new Blob([exportJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${editor.draftName || 'puzzle'}.puzzle.json`;
    a.click();
    URL.revokeObjectURL(url);
    message = '已导出题面文件（不含答案层）';
  }

  async function copy() {
    await navigator.clipboard.writeText(exportJson());
    message = '题面 JSON 已复制到剪贴板（不含答案层）';
  }

  function doImport() {
    try {
      const data = JSON.parse(importText);
      const puzzle = importPuzzle(data);
      editor.init(puzzle, null, '导入的题面');
      message = '导入成功：结构校验通过，可直接检查可解性';
      importOpen = false;
      importText = '';
    } catch (e) {
      message = '导入失败：' + (e instanceof Error ? e.message : String(e));
    }
  }

  function onFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      importText = String(reader.result ?? '');
      doImport();
    };
    reader.readAsText(file);
    input.value = '';
  }
</script>

<div class="panel">
  <h4>题面导入 / 导出</h4>
  <div class="row">
    <button onclick={download}>下载题面 JSON</button>
    <button onclick={copy}>复制题面</button>
    <button class="secondary" onclick={() => (importOpen = !importOpen)}>
      {importOpen ? '收起导入' : '导入题面'}
    </button>
    <label class="file">
      <input type="file" accept="application/json,.json" onchange={onFile} />
      选择文件导入
    </label>
  </div>
  {#if importOpen}
    <textarea bind:value={importText} rows="8" placeholder="粘贴题面 JSON：format 为 thermo-jigsaw-sudoku"></textarea>
    <div><button class="primary" onclick={doImport}>解析并载入</button></div>
  {/if}
  {#if message}<p class="msg">{message}</p>{/if}
  <p class="note">
    导出数据仅包含宫区、提示、温度计（kind:"puzzle"），
    <strong>不包含</strong>作者本地保存的答案、首解与检查结论。
  </p>
</div>

<style>
  .panel { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; }
  h4 { margin: 0 0 8px; font-size: 13px; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; }
  button { border: 1px solid #d1d5db; background: #fff; border-radius: 6px; padding: 6px 10px; cursor: pointer; font-size: 13px; }
  .primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  .secondary { background: #f3f4f6; }
  .file { position: relative; overflow: hidden; border: 1px solid #d1d5db; border-radius: 6px; padding: 6px 10px; font-size: 13px; cursor: pointer; background: #fff; }
  .file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  textarea { width: 100%; box-sizing: border-box; margin-top: 8px; font-family: ui-monospace, monospace; font-size: 12px; border: 1px solid #d1d5db; border-radius: 6px; padding: 8px; }
  .msg { font-size: 12px; color: #2563eb; margin: 8px 0 0; }
  .note { font-size: 11px; color: #6b7280; margin: 8px 0 0; line-height: 1.5; }
</style>
