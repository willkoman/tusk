import type { PersistedTabs } from "./store";

// Editor tab model. Each tab carries its own SQL buffer, file binding, and a
// snapshot of its last result grid. Only the tab that last ran a cursorable query
// streams live (there is one server-side cursor per connection); other tabs show a
// frozen snapshot.

export type ResultSnapshot = {
  columns: string[];
  rows: (string | null)[][];
  done: boolean;
  status: string;
  runErr: string;
  elapsed: number;
  lastQuery: string;
  /** The user's original wrappable query (';'-stripped) that sort/filter re-wrap from. */
  baseQuery: string;
  /** Rows are in the original observed order, so completed results may sort locally. */
  rowsAreBase: boolean;
  /** Bumped on each NEW query (not on streaming append) so the grid resets scroll/selection. */
  epoch: number;
  /** Identity of the backend result currently loaded in this snapshot. */
  generation: number;
  /** Manual transaction that produced this snapshot; null means normal autocommit. */
  transactionId: string | null;
  transactionRevision: number;
  /** Set when a transaction boundary makes edits against this snapshot unsafe. */
  transactionStale: string;
};

export const EMPTY_RESULT: ResultSnapshot = {
  columns: [],
  rows: [],
  done: true,
  status: "",
  runErr: "",
  elapsed: 0,
  lastQuery: "",
  baseQuery: "",
  rowsAreBase: true,
  epoch: 0,
  generation: 0,
  transactionId: null,
  transactionRevision: 0,
  transactionStale: "",
};

// --- result-grid display state (per tab, ephemeral — not persisted) ---
export type SortKey = { col: number; dir: "asc" | "desc" }; // col = ORIGINAL column index
export type Filter = { col: number; text: string };

export type GridView = {
  /** origIdx -> px width (sparse; absent = default). */
  widths: Record<number, number>;
  /** display order: a permutation of original column indices. */
  order: number[];
  /** original indices hidden (display-only). */
  hidden: number[];
  /** multi-sort keys, in priority order (server ORDER BY). */
  sorts: SortKey[];
  /** per-column filters (server WHERE ILIKE). */
  filters: Filter[];
  filterRowOpen: boolean;
};

export const EMPTY_GRID_VIEW: GridView = {
  widths: {},
  order: [],
  hidden: [],
  sorts: [],
  filters: [],
  filterRowOpen: false,
};

/** Fresh grid view sized to a column count (display order 0..n-1). */
export function gridViewFor(ncols: number): GridView {
  return { ...EMPTY_GRID_VIEW, order: Array.from({ length: ncols }, (_, i) => i) };
}

// --- in-grid pending edits (per tab, ephemeral — cleared on epoch bump) ---
// Snapshot rows are NEVER mutated: edits overlay rows by index, and commit WHERE
// clauses read the ORIGINAL snapshot values.
export type PendingEdits = {
  /** rowIdx -> origColIdx -> new value (null = SQL NULL). */
  cells: Record<number, Record<number, string | null>>;
  /** Row indices marked for DELETE (delete wins over cell edits on the same row). */
  deletes: number[];
  /** New rows, sparse: only touched cells present (null = explicit NULL; absent = column omitted from INSERT). */
  inserts: Record<number, string | null>[];
  /** Provenance copied from the immutable result snapshot on the first pending edit. */
  transactionId?: string | null;
  transactionRevision?: number;
  stale?: string;
};

export const EMPTY_PENDING: PendingEdits = { cells: {}, deletes: [], inserts: [] };

/** Total pending change count (edited rows + deletes + inserts). */
export function pendingCount(p: PendingEdits | undefined): number {
  if (!p) return 0;
  const deletes = new Set(p.deletes);
  const editedRows = Object.keys(p.cells).filter((r) => !deletes.has(+r)).length;
  return editedRows + p.deletes.length + p.inserts.length;
}

export type Tab = {
  id: string;
  title: string;
  sql: string;
  filePath: string | null;
  dirty: boolean;
  /** Bumped for every buffer edit; async saves may only clear the revision they wrote. */
  revision: number;
  /** Active schema for this console (Postgres search_path); null = connection default. */
  searchSchema: string | null;
  result: ResultSnapshot;
  /** Display overlay over the result (widths/order/hidden/sorts/filters). */
  gridView: GridView;
  /**
   * Result-area view when the result is a detected EXPLAIN plan: undefined =
   * default ("plan" when detectable), explicit "grid" = the raw output. The
   * parsed plan itself is never stored — it's derived lazily from the snapshot.
   */
  resultView?: "grid" | "plan";
  /** Last-used parameter values for this tab's queries (ephemeral, not persisted). */
  paramValues?: Record<string, { value: string; raw: boolean; isNull: boolean }>;
  /** Uncommitted in-grid edits (ephemeral, not persisted; cleared on epoch bump). */
  pending?: PendingEdits;
};

let counter = 0;

/** Basename of a file path (handles both / and \ separators). */
export function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

export function makeTab(init?: Partial<Tab>): Tab {
  counter += 1;
  return {
    id: `tab-${counter}`,
    title: init?.title ?? `Untitled ${counter}`,
    sql: init?.sql ?? "",
    filePath: init?.filePath ?? null,
    dirty: init?.dirty ?? false,
    revision: init?.revision ?? 0,
    searchSchema: init?.searchSchema ?? null,
    result: init?.result ?? { ...EMPTY_RESULT },
    gridView: init?.gridView ?? { ...EMPTY_GRID_VIEW },
    resultView: init?.resultView,
    paramValues: init?.paramValues,
    pending: init?.pending,
  };
}

/** Capture editor recovery state, including unsaved status and the active CM document. */
export function snapshotTabs(tabs: Tab[], activeTabId: string, activeDoc?: string): PersistedTabs {
  return {
    tabs: tabs.map((tab) => {
      const live = tab.id === activeTabId && activeDoc != null ? activeDoc : tab.sql;
      return {
        sql: live,
        filePath: tab.filePath,
        title: tab.title,
        searchSchema: tab.searchSchema,
        dirty: tab.dirty || live !== tab.sql,
      };
    }),
    activeIndex: Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId)),
  };
}
