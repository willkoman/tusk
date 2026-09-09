// Multi-connection model. Tusk keeps several database sessions open at once; this
// module owns the *pure* part of that: the per-connection record, the list
// operations App.tsx drives its `connections` signal with, and the small derived
// facts the connection strip renders (state dot, label, colour, next/prev).
//
// Everything here is side-effect free so it can be unit tested without a DOM or a
// backend. App.tsx keeps the reactive signal and all IPC; the rules live here.

import type { DbTree, RelationDetail } from "./Tree";
import type { FkEdge } from "./sql/fk";
import type { HistoryEntry } from "./history/store";
import { IDLE_TRANSACTION, transactionOpen, type TransactionStatus } from "./transaction";

// --- driver catalogue -------------------------------------------------------

/** Supported drivers + their mascot (the brand icon adapts to the connected DB).
 *  `ready` drivers are connectable now; others are staged in the picker. */
export const DRIVERS = [
  { id: "postgres", label: "PostgreSQL", mascot: "🐘", ready: true },
  { id: "duckdb", label: "DuckDB", mascot: "🦆", ready: true },
  { id: "sqlite", label: "SQLite", mascot: "🪶", ready: true },
  { id: "mysql", label: "MySQL", mascot: "🐬", ready: true },
  { id: "mssql", label: "SQL Server", mascot: "🧱", ready: true },
] as const;

export const driverMascot = (id?: string | null): string =>
  DRIVERS.find((d) => d.id === id)?.mascot ?? "🐘";
export const driverLabel = (id?: string | null): string =>
  DRIVERS.find((d) => d.id === id)?.label ?? "PostgreSQL";

// --- shared backend-facing types -------------------------------------------

/** Per-driver feature flags from the backend `capabilities` command. */
export type Capabilities = {
  kind: string;
  serverCursor: boolean;
  bulkCopy: boolean;
  export: boolean;
  schemas: boolean;
  searchPath: boolean;
  transactionalDdl: boolean;
  tls: boolean;
  keychain: boolean;
  permissions: boolean;
  ddl: boolean;
  relationships: boolean;
  explainAnalyze: boolean;
  cancelQuery: boolean;
  manualTransactions: boolean;
  transactionSavepoints: boolean;
  setTransaction: boolean;
  autocommitMode: boolean;
  /** MySQL: the session's sql_mode has NO_BACKSLASH_ESCAPES (drives literal escaping). */
  noBackslashEscapes?: boolean;
};

export type ColumnInfo = { name: string; data_type: string };
export type TableInfo = { schema: string; name: string; columns: ColumnInfo[] };

export type TablePriv = {
  schema: string; name: string;
  select: boolean; insert: boolean; update: boolean; delete: boolean;
  truncate: boolean; references: boolean; trigger: boolean; isOwner: boolean;
};
export type SchemaPriv = { name: string; create: boolean; usage: boolean; isOwner: boolean };
/** The connected role's effective privileges (`permissions` command). `enforced` is
 *  false for drivers with no permission model — the UI then gates nothing extra. */
export type Permissions = {
  enforced: boolean;
  currentUser: string;
  isSuperuser: boolean;
  canCreateDb: boolean;
  canCreateRole: boolean;
  createInCurrentDb: boolean;
  schemas: SchemaPriv[];
  tables: TablePriv[];
};

/** Identity of one live backend session. `generation` distinguishes a reconnect to
 *  the same destination, so an async write-back from the previous session is dropped. */
export type Connected = {
  id: string;
  version: string;
  readOnly: boolean;
  driver: string;
  generation: number;
  /** Persistence key for this destination (tab recovery + history are scoped by it). */
  key: string;
  /** Database name / file basename — the chip label. */
  target: string;
  /** The session reaches the database through an SSH tunnel. */
  viaSsh: boolean;
  /** Saved profile this session came from, when any (drives "reopen last session"). */
  profileId: string | null;
};

// --- the per-connection record ---------------------------------------------

/**
 * Everything the workbench renders for ONE connection. App.tsx holds
 * `ConnectionState[]` plus an `activeConnectionId`; every accessor that used to
 * read a single-connection signal (`caps()`, `tree()`, `schema()`, …) now reads
 * the active entry's field, and every async write-back targets an explicit id.
 */
export type ConnectionState = {
  conn: Connected;
  /** Stable display colour index; the strip and tab chips derive their tint from it. */
  colorIndex: number;
  caps: Capabilities | null;
  tree: DbTree | null;
  schema: TableInfo[];
  funcs: ReadonlySet<string>;
  fkEdges: FkEdge[];
  perms: Permissions | null;
  details: Record<string, RelationDetail>;
  history: HistoryEntry[];
  transaction: TransactionStatus;
  transactionStartedAt: number | null;
  transactionWarning: string;
  schemaLoading: boolean;
  /** A query is in flight on THIS connection (per connection: another one may idle). */
  running: boolean;
  runningTabId: string | null;
  runMs: number;
  cancelling: boolean;
  fetchingMore: boolean;
  loadingAll: boolean;
  /** DuckDB only: whether this build accepts PG-style `EXPLAIN (FORMAT json)`. */
  duckJsonExplain: boolean;
};

/** Hard ceiling on simultaneously open connections (mirrors the Rust registry cap). */
export const MAX_CONNECTIONS = 16;

/** Distinct chip tints, cycled by open order. Values are CSS colours used as-is. */
export const CONNECTION_COLORS = [
  "#5b9dd9", "#c98f4b", "#5fae7f", "#b06fc4", "#d0705f", "#6f8fd0", "#b3a44e", "#4faab0",
] as const;

export const connectionColor = (index: number): string =>
  CONNECTION_COLORS[((index % CONNECTION_COLORS.length) + CONNECTION_COLORS.length) % CONNECTION_COLORS.length];

/** Fresh per-connection state for a session that just opened. */
export function makeConnectionState(conn: Connected, colorIndex: number): ConnectionState {
  return {
    conn,
    colorIndex,
    caps: null,
    tree: null,
    schema: [],
    funcs: new Set<string>(),
    fkEdges: [],
    perms: null,
    details: {},
    history: [],
    transaction: { ...IDLE_TRANSACTION },
    transactionStartedAt: null,
    transactionWarning: "",
    schemaLoading: false,
    running: false,
    runningTabId: null,
    runMs: 0,
    cancelling: false,
    fetchingMore: false,
    loadingAll: false,
    duckJsonExplain: false,
  };
}

/** The lowest colour index not already taken (so a close+open reuses the free slot). */
export function nextColorIndex(list: readonly { colorIndex: number }[]): number {
  const taken = new Set(list.map((c) => c.colorIndex));
  for (let i = 0; i < CONNECTION_COLORS.length * 4; i++) if (!taken.has(i)) return i;
  return list.length;
}

/**
 * The minimum an entry needs to take part in the list operations. App.tsx's own
 * entry adds per-connection signals and non-reactive bookkeeping on top, so these
 * helpers are generic rather than tied to the plain `ConnectionState` record.
 */
export type ConnectionLike = { conn: Connected; colorIndex: number };

export function findConnection<T extends { conn: Pick<Connected, "id"> }>(
  list: readonly T[],
  id: string | null,
): T | null {
  return id ? list.find((c) => c.conn.id === id) ?? null : null;
}

/** Replace an existing entry by id, or append it. Order is open order. */
export function upsertConnection<T extends ConnectionLike>(list: readonly T[], next: T): T[] {
  const at = list.findIndex((c) => c.conn.id === next.conn.id);
  if (at < 0) return [...list, next];
  const out = list.slice();
  out[at] = next;
  return out;
}

export function patchConnection<T extends ConnectionLike>(
  list: readonly T[],
  id: string,
  patch: Partial<T>,
): T[] {
  let changed = false;
  const out = list.map((c) => {
    if (c.conn.id !== id) return c;
    changed = true;
    return { ...c, ...patch };
  });
  return changed ? out : (list as T[]);
}

export function removeConnection<T extends { conn: Pick<Connected, "id"> }>(
  list: readonly T[],
  id: string,
): T[] {
  return list.filter((c) => c.conn.id !== id);
}

/** True when `c` is still the same live session (same id AND same generation). */
export function connectionMatches(
  list: readonly { conn: Pick<Connected, "id" | "generation"> }[],
  c: Pick<Connected, "id" | "generation">,
): boolean {
  const found = list.find((x) => x.conn.id === c.id);
  return !!found && found.conn.generation === c.generation;
}

/** Driver kind for SQL generation: what the backend reported, else what was dialled. */
export const connectionKindOf = (
  state: { caps: Capabilities | null; conn: Pick<Connected, "driver"> } | null | undefined,
): string => state?.caps?.kind ?? state?.conn.driver ?? "postgres";

// --- derived chip facts -----------------------------------------------------

/** Connection-strip state dot, most severe first. */
export type ConnectionDot = "lost" | "failed" | "transaction" | "running" | "idle";

export function connectionDot(state: ConnectionState): ConnectionDot {
  if (state.transaction.state === "lost") return "lost";
  if (state.transaction.state === "failed") return "failed";
  if (transactionOpen(state.transaction)) return "transaction";
  if (state.running || state.fetchingMore || state.loadingAll) return "running";
  return "idle";
}

const DOT_TITLES: Record<ConnectionDot, string> = {
  lost: "transaction session lost — disconnect and reconnect",
  failed: "transaction failed — rollback required",
  transaction: "manual transaction open",
  running: "query running",
  idle: "idle",
};

export const connectionDotTitle = (dot: ConnectionDot): string => DOT_TITLES[dot];

/**
 * Chip label. The server-reported database name is the truth (`tree.database`);
 * before introspection lands, fall back to what the user dialled. A duplicate
 * label is disambiguated by the caller through `connectionLabels`.
 */
export const connectionLabel = (state: ConnectionState): string =>
  state.tree?.database || state.conn.target || driverLabel(connectionKindOf(state));

/**
 * Labels for the whole strip, with duplicates disambiguated. Two sessions on the
 * same database name are common (different hosts, or read-only vs read-write), and
 * an ambiguous chip is worse than a long one, so repeats get a `#n` suffix in open
 * order.
 */
export function connectionLabels(list: readonly ConnectionState[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const c of list) {
    const base = connectionLabel(c);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const c of list) {
    const base = connectionLabel(c);
    if ((counts.get(base) ?? 0) < 2) {
      out.set(c.conn.id, base);
      continue;
    }
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(c.conn.id, `${base} #${n}`);
  }
  return out;
}

/** Id of the connection `dir` steps from the active one, wrapping. Null when <2 open. */
export function stepConnection(
  list: readonly { conn: Pick<Connected, "id"> }[],
  activeId: string | null,
  dir: 1 | -1,
): string | null {
  if (list.length < 2) return null;
  const at = list.findIndex((c) => c.conn.id === activeId);
  if (at < 0) return list[0].conn.id;
  const n = list.length;
  return list[(at + dir + n) % n].conn.id;
}

/** Why a new connection cannot be opened right now (empty string = it can). */
export function connectionLimitError(list: readonly unknown[]): string {
  return list.length >= MAX_CONNECTIONS
    ? `Too many open connections (${MAX_CONNECTIONS}). Disconnect one before opening another.`
    : "";
}

// --- tab-recovery slots -----------------------------------------------------

/**
 * Where ONE session's tab snapshot lives. The destination key (`profile:<id>`,
 * `adhoc:[…]`) is not enough: the same profile can be opened twice, and two live
 * sessions sharing a snapshot means the second restores the first's tabs (every
 * file open twice, so saving fails on both) and then overwrites its unsaved buffers
 * on the next persist — silently, because the write itself succeeds, which also
 * defeats the dirty-recovery disconnect guard.
 *
 * Slot 0 keeps the bare key, so a single session keeps reading and writing exactly
 * the snapshot every previous version wrote. Only a second concurrent session to the
 * same destination gets a suffix.
 */
export const recoverySlotKey = (key: string, slot: number): string =>
  slot <= 0 ? key : `${key}#${slot}`;

/**
 * Lowest recovery slot for `key` not already claimed by an open session. `inUse` is
 * the set of recovery keys the open connections hold (App's `recoveryKeys` values).
 */
export function nextRecoverySlot(inUse: Iterable<string>, key: string): number {
  const taken = new Set(inUse);
  for (let slot = 0; slot < MAX_CONNECTIONS; slot++) {
    if (!taken.has(recoverySlotKey(key, slot))) return slot;
  }
  return MAX_CONNECTIONS;
}

// --- "reopen last session" --------------------------------------------------

/**
 * Profile ids worth remembering across restarts, in open order. Ad-hoc sessions are
 * deliberately excluded: their credentials were typed, never stored, so offering to
 * reopen one would either fail or prompt — neither is a session restore.
 */
export function rememberedProfileIds(list: readonly { conn: Pick<Connected, "profileId"> }[]): string[] {
  const out: string[] = [];
  for (const c of list) {
    const id = c.conn.profileId;
    if (id && !out.includes(id)) out.push(id);
  }
  return out.slice(0, MAX_CONNECTIONS);
}

/**
 * Merge the profiles that are open right now with the ones still waiting to be
 * reopened. Persisting only the open set erased the rest of the remembered session
 * the moment the first profile connected, which made "Reopen last session" useless
 * for the multi-connection setup it exists for. Open order first, then the pending
 * offer, de-duplicated and bounded.
 */
export function mergeRememberedIds(open: readonly string[], pending: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of [...open, ...pending]) {
    if (!id || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_CONNECTIONS) break;
  }
  return out;
}

/** Bound + de-duplicate a persisted id list before it is offered or reconnected. */
export function sanitizeRememberedIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !v || v.length > 200) continue;
    if (!out.includes(v)) out.push(v);
    if (out.length >= MAX_CONNECTIONS) break;
  }
  return out;
}
