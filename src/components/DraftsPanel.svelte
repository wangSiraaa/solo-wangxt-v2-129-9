<script lang="ts">
  import { editor } from '../lib/state.svelte';
  import {
    deleteDraft,
    draftFromPuzzle,
    listDrafts,
    loadDraft,
    saveDraft,
    type DraftSummary
  } from '../lib/storage';
  import { puzzleFingerprint } from '../lib/puzzle';

  let drafts = $state<DraftSummary[]>([]);
  let message = $state('');
  let busy = $state(false);

  async function refresh() {
    drafts = await listDrafts();
  }
  refresh();

  async function save() {
    busy = true;
    try {
      let id = editor.draftId;
      const fp = puzzleFingerprint(editor.puzzle);
      if (!id) {
        const rec = draftFromPuzzle(editor.draftName, editor.puzzle);
        rec.lastCheck = editor.analysis.result;
        rec.checkFingerprint = editor.analysis.status === 'done' ? fp : null;
        await saveDraft(rec);
        id = rec.id;
        editor.draftId = id;
      } else {
        const existing = (await loadDraft(id)) ?? draftFromPuzzle(editor.draftName, editor.puzzle);
        existing.name = editor.draftName;
        existing.updatedAt = Date.now();
        existing.puzzle = structuredClone(editor.puzzle);
        existing.lastCheck = editor.analysis.result;
        existing.checkFingerprint = editor.analysis.status === 'done' ? fp : null;
        await saveDraft(existing);
      }
      message = `已保存 ${new Date().toLocaleTimeString()}`;
      await refresh();
    } catch (e) {
      message = '保存失败：' + (e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
    }
  }

  async function open(id: string) {
    const rec = await loadDraft(id);
    if (!rec) return;
    editor.init(structuredClone(rec.puzzle), rec.id, rec.name);
    if (rec.lastCheck && rec.checkFingerprint === puzzleFingerprint(rec.puzzle)) {
      editor.analysis = { status: 'done', result: rec.lastCheck, fingerprint: rec.checkFingerprint, error: null };
    }
    message = `已打开草稿「${rec.name}」`;
  }

  async function remove(id: string) {
    if (!confirm('删除这份本地题稿？')) return;
    await deleteDraft(id);
    if (editor.draftId === id) message = '已删除当前草稿（画布仍保留）';
    await refresh();
  }

  function formatTime(t: number) {
    return new Date(t).toLocaleString();
  }
</script>

<div class="panel">
  <h4>本地题稿（IndexedDB，无后台）</h4>
  <div class="row">
    <input bind:value={editor.draftName} placeholder="题稿名称" aria-label="题稿名称" />
    <button class="primary" onclick={save} disabled={busy}>保存</button>
  </div>
  {#if message}<p class="msg">{message}</p>{/if}
  <ul class="drafts">
    {#each drafts as d (d.id)}
      <li>
        <button class="open" onclick={() => open(d.id)} title="打开">
          <strong>{d.name}</strong>
          <span>{formatTime(d.updatedAt)}</span>
        </button>
        <button class="del" onclick={() => remove(d.id)} title="删除">✕</button>
      </li>
    {/each}
  </ul>
  {#if drafts.length === 0}<p class="msg">还没有保存过题稿。</p>{/if}
</div>

<style>
  .panel { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; }
  h4 { margin: 0 0 8px; font-size: 13px; }
  .row { display: flex; gap: 6px; }
  input { flex: 1; padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; }
  .primary { background: #2563eb; color: #fff; border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
  .msg { font-size: 12px; color: #6b7280; margin: 6px 0 0; }
  .drafts { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .drafts li { display: flex; gap: 4px; align-items: stretch; }
  .open { flex: 1; display: flex; justify-content: space-between; gap: 8px; text-align: left;
    background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; padding: 5px 8px; cursor: pointer; }
  .open span { font-size: 11px; color: #9ca3af; }
  .del { border: 1px solid #fecaca; background: #fff; color: #dc2626; border-radius: 6px; padding: 0 8px; cursor: pointer; }
</style>
