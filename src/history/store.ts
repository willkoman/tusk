import { invoke } from "@tauri-apps/api/core";
import { KeyedSerialQueue } from "../asyncQueue";

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
const MAX_SQL_CHARS = 1_000_000;
const MAX_HISTORY_CHARS = 8_000_000;

let counter = 0;
export const makeEntryId = (ts: number) => `${ts}-${++counter}`;

const cache = new Map<string, HistoryEntry[]>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const loads = new Map<string, Promise<HistoryEntry[]>>();
const revisions = new Map<string, number>();
const loaded = new Set<string>();
const saves = new KeyedSerialQueue<string>();

const bump = (connKey: string) => revisions.set(connKey, (revisions.get(connKey) ?? 0) + 1);

function mergeHistory(newer: HistoryEntry[], older: HistoryEntry[]): HistoryEntry[] {
  const seen = new Set(newer.map((e) => e.id));
  return normalizeHistory([...newer, ...older.filter((e) => !seen.has(e.id))]);
}

function historyEntry(value: unknown): HistoryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.sql !== "string" || v.sql.length > MAX_SQL_CHARS) return null;
  if (typeof v.ts !== "number" || !Number.isFinite(v.ts) || typeof v.durationMs !== "number" || !Number.isFinite(v.durationMs)) return null;
  if (v.status !== "ok" && v.status !== "error" && v.status !== "cancelled") return null;
  const rows = v.rows === null || (typeof v.rows === "number" && Number.isFinite(v.rows)) ? v.rows as number | null : null;
  const error = v.error === null || typeof v.error === "string" ? (v.error as string | null)?.slice(0, 10_000) ?? null : null;
  const schema = v.schema === null || typeof v.schema === "string" ? v.schema as string | null : null;
  return { id: v.id.slice(0, 200), sql: v.sql, ts: v.ts, durationMs: Math.max(0, v.durationMs), status: v.status, rows, error, schema };
}

export function normalizeHistory(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const out: HistoryEntry[] = [];
  let chars = 0;
  for (const v of value.slice(0, CAP)) {
    const entry = historyEntry(v);
    if (!entry) continue;
    const next = entry.id.length + entry.sql.length + (entry.error?.length ?? 0) + (entry.schema?.length ?? 0);
    if (chars + next > MAX_HISTORY_CHARS) break;
    chars += next;
    out.push(entry);
  }
  return out;
}

function scheduleSave(connKey: string) {
  clearTimeout(timers.get(connKey));
  timers.set(
    connKey,
    setTimeout(() => {
      timers.delete(connKey);
      void saves.run(connKey, async () => {
        if (!loaded.has(connKey)) await historyStore.load(connKey);
        const list = cache.get(connKey) ?? [];
        try {
          await invoke("save_history", { connKey, json: JSON.stringify(list) });
        } catch {
          /* degrade to in-memory */
        }
      });
    }, SAVE_DEBOUNCE_MS),
  );
}

export const historyStore = {
  /** Newest-first list for a connection (loads from disk once, then cached). */
  async load(connKey: string): Promise<HistoryEntry[]> {
    const hit = cache.get(connKey);
    if (hit && loaded.has(connKey)) return hit;
    const pending = loads.get(connKey);
    if (pending) return pending;
    const revision = revisions.get(connKey) ?? 0;
    const request = (async () => {
      let list: HistoryEntry[] = [];
      try {
        const raw = await invoke<string>("load_history", { connKey });
        if (raw.length > MAX_HISTORY_CHARS) throw new Error("history is too large");
        list = normalizeHistory(JSON.parse(raw));
      } catch {
        /* missing/corrupt/unavailable -> start empty */
      }
      // clear/replace intentionally supersede disk. An append before/during the
      // first load instead merges with disk so an early query cannot erase history.
      if ((revisions.get(connKey) ?? 0) !== revision && loaded.has(connKey)) return cache.get(connKey) ?? [];
      const merged = mergeHistory(cache.get(connKey) ?? [], list);
      cache.set(connKey, merged);
      loaded.add(connKey);
      return merged;
    })().finally(() => loads.delete(connKey));
    loads.set(connKey, request);
    return request;
  },

  /** Prepend an entry (dedupes a re-run of the identical newest SQL), cap, save. */
  append(connKey: string, entry: HistoryEntry): HistoryEntry[] {
    const list = cache.get(connKey) ?? [];
    const safe = historyEntry(entry);
    if (!safe) return list;
    let next: HistoryEntry[];
    if (list[0] && list[0].sql === safe.sql) {
      next = [safe, ...list.slice(1)]; // refresh ts/duration/status in place
    } else {
      next = [safe, ...list].slice(0, CAP);
    }
    next = normalizeHistory(next);
    cache.set(connKey, next);
    bump(connKey);
    scheduleSave(connKey);
    return next;
  },

  clear(connKey: string): void {
    cache.set(connKey, []);
    loaded.add(connKey); // a deliberate clear must never resurrect disk state
    bump(connKey);
    scheduleSave(connKey);
  },

  /** Seed a renamed connection key without losing existing persisted history. */
  replace(connKey: string, entries: HistoryEntry[]): void {
    cache.set(connKey, normalizeHistory(entries));
    loaded.add(connKey);
    bump(connKey);
    scheduleSave(connKey);
  },

  /** Move a pre-key-migration history file only after the new file is durable. */
  async migrate(from: string, to: string): Promise<HistoryEntry[]> {
    try {
      const raw = await invoke<string>("migrate_history", { fromKey: from, toKey: to });
      if (raw.length > MAX_HISTORY_CHARS) throw new Error("history is too large");
      const migrated = normalizeHistory(JSON.parse(raw));
      const merged = mergeHistory(cache.get(to) ?? [], migrated);
      cache.set(to, merged);
      loaded.add(to);
      bump(to);
      cache.delete(from);
      loaded.delete(from);
      bump(from);
      return merged;
    } catch {
      return historyStore.load(to);
    }
  },
};
