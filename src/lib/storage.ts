// IndexedDB 题稿存储（纯前端，无后台）。
// 存的是作者工作区：题面 + 最近一次检查结论（含首解，属于作者私有数据）。
// 导出题面走 exportPuzzle()，只含题面，绝不带这里的检查结论/答案。
import {
  clonePuzzle,
  type Puzzle,
  validateStructure
} from './puzzle';
import type { SolveResult } from './solver';

const DB_NAME = 'thermo-jigsaw-studio';
const DB_VERSION = 1;
const STORE = 'drafts';

export interface DraftRecord {
  id: string;
  name: string;
  updatedAt: number;
  puzzle: Puzzle;
  /** 最近一次检查结果（可能含首解），仅保存在本地作者库中 */
  lastCheck: SolveResult | null;
  /** 上次检查时题面的指纹；题面一变即判定结论过期 */
  checkFingerprint: string | null;
}

export interface DraftSummary {
  id: string;
  name: string;
  updatedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | IDBRequest<T>[]
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        const reqs = fn(store);
        t.oncomplete = () => {
          const r = Array.isArray(reqs) ? reqs[0] : reqs;
          resolve(r.result);
        };
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export async function saveDraft(rec: DraftRecord): Promise<void> {
  // 保存前做一次结构完整性校验，避免把坏数据写进库
  validateStructure(rec.puzzle);
  await tx('readwrite', (store) => store.put(structuredClone(rec)) as IDBRequest);
}

export async function loadDraft(id: string): Promise<DraftRecord | null> {
  const rec = await tx<DraftRecord | undefined>('readonly', (store) =>
    store.get(id) as IDBRequest<DraftRecord | undefined>
  );
  return rec ? (rec as DraftRecord) : null;
}

export async function listDrafts(): Promise<DraftSummary[]> {
  const all = await tx<DraftRecord[]>('readonly', (store) =>
    store.getAll() as IDBRequest<DraftRecord[]>
  );
  return (all ?? [])
    .map(({ id, name, updatedAt }) => ({ id, name, updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteDraft(id: string): Promise<void> {
  await tx('readwrite', (store) => store.delete(id) as IDBRequest);
}

export function newDraftId(): string {
  return (
    Date.now().toString(36) +
    '-' +
    (globalThis.crypto?.getRandomValues(new Uint32Array(1))[0]?.toString(36) ??
      Math.random().toString(36).slice(2))
  );
}

export function draftFromPuzzle(name: string, puzzle: Puzzle): DraftRecord {
  return {
    id: newDraftId(),
    name,
    updatedAt: Date.now(),
    puzzle: clonePuzzle(puzzle),
    lastCheck: null,
    checkFingerprint: null
  };
}
