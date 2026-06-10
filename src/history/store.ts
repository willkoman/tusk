import { invoke } from "@tauri-apps/api/core";

// Per-connection query history, file-backed via the `load_history`/`save_history`
// commands (<app-config>/history/<conn>.json — survives WebView storage resets).
// Failures degrade to in-memory history for the session; recording never blocks
// or fails a query run.

export type HistoryEntry = {
  id: string;
  sql: string;
  ts: number; // epoch ms
  durationMs: number;
  status: "ok" | "error" | "cancelled";
  /** Rows in the first page (streamed reads) or affected-rows summary; null when unknown. */
  rows: number | null;
  /** First line of the error message, when status !== "ok". */
  error: string | null;
  /** The tab's active schema (search_path) at run time. */
  schema: string | null;
};

const CAP = 500;
const SAVE_DEBOUNCE_MS = 500;

let counter = 0;
export const makeEntryId = (ts: number) => `${ts}-${++counter}`;

const cache = new Map<string, HistoryEntry[]>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSave(connKey: string) {
  clearTimeout(timers.get(connKey));
  timers.set(
    connKey,
    setTimeout(() => {
      const list = cache.get(connKey) ?? [];
      invoke("save_history", { connKey, json: JSON.stringify(list) }).catch(() => {
        /* degrade to in-memory */
      });
    }, SAVE_DEBOUNCE_MS),
  );
}

export const historyStore = {
  /** Newest-first list for a connection (loads from disk once, then cached). */
  async load(connKey: string): Promise<HistoryEntry[]> {
    const hit = cache.get(connKey);
    if (hit) return hit;
    let list: HistoryEntry[] = [];
    try {
      const raw = await invoke<string>("load_history", { connKey });
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed as HistoryEntry[];
    } catch {
      /* missing/corrupt/unavailable → start empty */
    }
    cache.set(connKey, list);
    return list;
  },

  /** Prepend an entry (dedupes a re-run of the identical newest SQL), cap, save. */
  append(connKey: string, entry: HistoryEntry): HistoryEntry[] {
    const list = cache.get(connKey) ?? [];
    let next: HistoryEntry[];
    if (list[0] && list[0].sql === entry.sql) {
      next = [entry, ...list.slice(1)]; // refresh ts/duration/status in place
    } else {
      next = [entry, ...list].slice(0, CAP);
    }
    cache.set(connKey, next);
    scheduleSave(connKey);
    return next;
  },

  clear(connKey: string): void {
    cache.set(connKey, []);
    scheduleSave(connKey);
  },
};
