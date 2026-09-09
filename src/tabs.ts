import type { PersistedTabs } from "./store";
import { EMPTY_FILTER, type FilterTree } from "./grid/filterModel";

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
  /**
   * Non-empty when the loaded rows are NOT the full result: the stream was closed
   * before it drained (another tab ran, a metadata/Explorer/export/import command
   * rolled the cursor back, or the connection dropped). The reason is shown to the
   * user; local sort and "loaded rows" export treat the snapshot as partial.
   */
  incomplete: string;
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
  incomplete: "",
};

/**
 * Patch that freezes a still-streaming snapshot as an explicitly incomplete result.
 * Returns null when the snapshot already finished (nothing was lost).
 */
export function interruptedResult(
  result: Pick<ResultSnapshot, "rows" | "done">,
  reason: string,
): Pick<ResultSnapshot, "done" | "incomplete" | "status"> | null {
  if (result.done) return null;
  return {
    done: true,
    incomplete: reason,
    // The cause is a tooltip (`incomplete`), not a status line: the bar has room
    // for the count and the action, and the action is the part that matters.
    status: `${result.rows.length.toLocaleString()} rows loaded. Re-run for all rows.`,
  };
}

// --- result-grid display state (per tab, ephemeral — not persisted) ---
export type SortKey = { col: number; dir: "asc" | "desc" }; // col = ORIGINAL column index

export type GridView = {
  /** origIdx -> px width (sparse; absent = default). */
  widths: Record<number, number>;
  /** display order: a permutation of original column indices. */
  order: number[];
  /** original indices hidden (display-only). */
  hidden: number[];
  /** multi-sort keys, in priority order (server ORDER BY). */
  sorts: SortKey[];
  /**
   * Structured filter tree (server WHERE) — the single source of truth for both
   * the visual filter builder and the per-column quick-filter row, which reads
   * and writes top-level `contains` conditions in it.
   */
  filters: FilterTree;
  filterRowOpen: boolean;
  /** Show the row number in the gutter (off narrows the gutter to a select strip). */
  rowNumbers: boolean;
  /** Keep the first displayed column pinned while the body scrolls sideways. */
  stickyFirst: boolean;
  /** Record view: the focused row as a name/value list beside the grid. */
  recordOpen: boolean;
  /** Find-in-loaded-rows bar above the grid. */
  findOpen: boolean;
};

export const EMPTY_GRID_VIEW: GridView = {
  widths: {},
  order: [],
  hidden: [],
  sorts: [],
  filters: EMPTY_FILTER,
  filterRowOpen: false,
  rowNumbers: true,
  stickyFirst: false,
  recordOpen: false,
  findOpen: false,
};

/** Fresh grid view sized to a column count (display order 0..n-1). */
export function gridViewFor(ncols: number): GridView {
  return { ...EMPTY_GRID_VIEW, order: Array.from({ length: ncols }, (_, i) => i) };
}

/**
 * The parts of a grid view that are UI preferences rather than result state.
 * A new query resets widths, order, sorts and filters; these panel toggles are
 * things the user turned on and expects to still be on after the next run.
 */
export function carryViewPrefs(prev: GridView | undefined): Pick<
  GridView,
  "filterRowOpen" | "rowNumbers" | "stickyFirst" | "recordOpen" | "findOpen"
> {
  return {
    filterRowOpen: prev?.filterRowOpen ?? EMPTY_GRID_VIEW.filterRowOpen,
    rowNumbers: prev?.rowNumbers ?? EMPTY_GRID_VIEW.rowNumbers,
    stickyFirst: prev?.stickyFirst ?? EMPTY_GRID_VIEW.stickyFirst,
    recordOpen: prev?.recordOpen ?? EMPTY_GRID_VIEW.recordOpen,
    findOpen: prev?.findOpen ?? EMPTY_GRID_VIEW.findOpen,
  };
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

// --- tab organisation: custom title, pin, colour tag ---

/** Colour tags offered in the tab context menu. "" = untagged. */
export const TAB_COLORS = ["red", "amber", "green", "teal", "violet", "pink"] as const;
export type TabColor = "" | (typeof TAB_COLORS)[number];

export const TAB_COLOR_LABELS: Record<Exclude<TabColor, "">, string> = {
  red: "Red",
  amber: "Amber",
  green: "Green",
  teal: "Teal",
  violet: "Violet",
  pink: "Pink",
};

/** Untrusted values (persisted state) resolve to "" rather than a bogus class. */
export function normalizeTabColor(v: unknown): TabColor {
  return (TAB_COLORS as readonly string[]).includes(String(v)) ? (v as TabColor) : "";
}

/** Longest custom title accepted (matches the persisted-title bound in store.ts). */
export const MAX_TAB_TITLE = 200;

export type Tab = {
  id: string;
  /**
   * The connection this tab runs against. Several connections are open at once and
   * one strip shows every tab, so the tab — not a global "current connection" — is
   * what decides where a query runs and which dialect its SQL is built with.
   */
  connectionId: string;
  /** Automatic title: "Untitled N", or the file basename once bound to a file. */
  title: string;
  /** User-set title. Non-empty wins over `title` and survives a Save as. */
  customTitle: string;
  /** Pinned tabs hold a fixed group at the left of the strip and resist close-many. */
  pinned: boolean;
  /** Colour tag shown as a dot in the strip. */
  color: TabColor;
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
    connectionId: init?.connectionId ?? "",
    title: init?.title ?? `Untitled ${counter}`,
    customTitle: init?.customTitle ?? "",
    pinned: init?.pinned ?? false,
    color: normalizeTabColor(init?.color),
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

// --- pure tab-organisation operations (covered by tabs.test.ts) -------------

/** The title to show: the user's, or the automatic one. */
export function tabLabel(tab: Pick<Tab, "title" | "customTitle">): string {
  return tab.customTitle.trim() || tab.title;
}

/** Clean a typed title: trimmed and bounded. Empty restores the automatic title. */
export function cleanTabTitle(raw: string): string {
  return raw.trim().slice(0, MAX_TAB_TITLE);
}

/**
 * Compact label for a pinned tab: the name without its extension, cut to `max`
 * characters. Pinned tabs are recognised by position and colour, so the strip
 * spends as little width on them as it can and keeps the full name in a tooltip.
 */
export function shortTabLabel(label: string, max = 4): string {
  const stem = label.replace(/\.[A-Za-z0-9]{1,8}$/, "").trim() || label.trim();
  return stem.length <= max ? stem : stem.slice(0, max);
}

/** How many tabs at the head of the strip are pinned (the invariant's boundary). */
export function pinnedCount(tabs: readonly Tab[]): number {
  let n = 0;
  while (n < tabs.length && tabs[n].pinned) n++;
  return n;
}

/**
 * Restore the invariant the strip relies on: every pinned tab precedes every
 * unpinned one, relative order preserved inside each group. Returns the SAME
 * array reference when nothing moves, so callers can skip a state write.
 */
export function sortPinned(tabs: readonly Tab[]): readonly Tab[] {
  if (tabs.length < 2) return tabs;
  if (pinnedCount(tabs) === tabs.filter((t) => t.pinned).length) return tabs;
  return [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];
}

/**
 * Clamp a drag/keyboard insertion slot so it stays inside the dragged tab's own
 * group: a pinned tab can never land right of an unpinned one, and vice versa.
 */
export function clampPinSlot(tabs: readonly Tab[], from: number, slot: number): number {
  const boundary = pinnedCount(tabs);
  const bounded = Math.max(0, Math.min(tabs.length, slot));
  if (from < 0 || from >= tabs.length) return bounded;
  return tabs[from].pinned
    ? Math.min(bounded, boundary)
    : Math.max(bounded, boundary);
}

export type CloseScope = "others" | "right" | "saved";

/**
 * Which tabs of ONE connection a close-many action targets. Pinned tabs are
 * never targeted, and the anchor survives "others"/"right". The caller still
 * applies the per-tab guards (dirty, pending edits, running query, transaction
 * owner) — this only decides the candidate set.
 */
export function closeManyTargets(owned: readonly Tab[], anchorId: string, scope: CloseScope): Tab[] {
  const anchor = owned.findIndex((t) => t.id === anchorId);
  return owned.filter((t, i) => {
    if (t.pinned) return false;
    if (scope === "others") return t.id !== anchorId;
    if (scope === "right") return anchor >= 0 && i > anchor;
    return !t.dirty;
  });
}

/**
 * Filter for the "All tabs" list: case-insensitive substring over the shown
 * title, the file path, and the connection label, so `orders.sql`, `prod`, and
 * a renamed tab all find their tab. A blank needle keeps everything.
 */
export function filterTabs<T extends { label: string; detail: string; connectionLabel: string }>(
  items: readonly T[],
  needle: string,
): T[] {
  const q = needle.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((it) =>
    `${it.label} ${it.detail} ${it.connectionLabel}`.toLowerCase().includes(q),
  );
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
        customTitle: tab.customTitle,
        pinned: tab.pinned,
        color: tab.color,
        searchSchema: tab.searchSchema,
        dirty: tab.dirty || live !== tab.sql,
      };
    }),
    activeIndex: Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId)),
  };
}
