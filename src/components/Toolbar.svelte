<script lang="ts">
  import { editor, type Tool } from '../lib/state.svelte';

  const tools: { id: Tool; label: string; hint: string }[] = [
    { id: 'givens', label: '提示', hint: '选中格后输入 1-9；再按同数字清除' },
    { id: 'regions', label: '宫区刷色', hint: '先选宫色，再在格上拖动刷出不规则宫' },
    { id: 'thermo-start', label: '新温度计', hint: '点击水银泡所在格，再逐格延伸（须上下左右相邻）' },
    { id: 'thermo-extend', label: '延伸温度计', hint: '点击相邻格延伸；点上一格回退；双击末端完成' },
    { id: 'erase', label: '清除提示', hint: '点击格子删除提示数字' }
  ];

  const REGION_COLORS = [
    '#cfe3ff', '#d9f2d1', '#ffe2c2', '#f6d6d6', '#e6d8f5',
    '#c9f0ee', '#f2efcf', '#d6e4f5', '#f5d9ea'
  ];
</script>

<div class="toolbar">
  <div class="group">
    {#each tools as t (t.id)}
      <button
        class="tool"
        class:active={editor.tool === t.id}
        disabled={t.id === 'thermo-extend' && editor.activeThermo === null}
        title={t.hint}
        onclick={() => {
          if (t.id !== 'thermo-extend') editor.finishThermo();
          editor.tool = t.id;
        }}
      >
        {t.label}
      </button>
    {/each}
    {#if editor.tool === 'thermo-extend' && editor.activeThermo !== null}
      <button class="tool warn" onclick={() => editor.finishThermo()}>完成温度计</button>
      <button class="tool danger" onclick={() => editor.cancelThermo()}>取消本支</button>
    {/if}
  </div>

  {#if editor.tool === 'regions'}
    <div class="group regions">
      <span class="caption">选宫（每宫须 9 格且连通）：</span>
      {#each Array(9) as _, k (k)}
        <button
          class="swatch"
          class:on={editor.selectedRegion === k}
          style={`--sw:${REGION_COLORS[k]}`}
          title={`宫 ${k + 1}`}
          onclick={() => (editor.selectedRegion = k)}
        >{k + 1}</button>
      {/each}
    </div>
  {/if}

  {#if editor.tool === 'givens'}
    <div class="group pad">
      {#each [1, 2, 3, 4, 5, 6, 7, 8, 9] as d (d)}
        <button class="digit" onclick={() => editor.pressDigit(d)}>{d}</button>
      {/each}
      <button class="digit zero" onclick={() => editor.pressDigit(0)}>清空</button>
    </div>
  {/if}

  {#if editor.puzzle}
    <div class="group thermometer-list">
      <span class="caption">温度计 {editor.puzzle.thermometers.length} 支：</span>
      {#each editor.puzzle.thermometers as t, ti (ti)}
        <button
          class="chip"
          class:on={editor.activeThermo === ti}
          onclick={() => editor.selectThermo(editor.activeThermo === ti ? null : ti)}
          ondblclick={() => editor.deleteThermo(ti)}
          title="单击高亮；双击删除"
        >#{ti + 1}（{t.path.length}格）</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .toolbar { display: flex; flex-direction: column; gap: 10px; }
  .group { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .caption { font-size: 12px; color: #4b5563; margin-right: 2px; }
  .tool, .digit, .chip, .swatch {
    border: 1px solid #d1d5db; background: #fff; border-radius: 6px;
    padding: 6px 10px; font-size: 13px; cursor: pointer;
  }
  .tool:hover, .digit:hover, .chip:hover, .swatch:hover { border-color: #2563eb; }
  .tool.active, .chip.on { background: #2563eb; color: #fff; border-color: #2563eb; }
  .tool:disabled { opacity: 0.4; cursor: not-allowed; }
  .warn { border-color: #d97706; color: #b45309; }
  .danger { border-color: #dc2626; color: #dc2626; }
  .digit { width: 42px; font-weight: 600; }
  .digit.zero { width: auto; }
  .swatch {
    width: 30px; height: 30px; background: var(--sw); font-weight: 700;
  }
  .swatch.on { outline: 3px solid #111827; outline-offset: 1px; }
</style>
