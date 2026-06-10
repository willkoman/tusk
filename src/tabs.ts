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
  /** Bumped on each NEW query (not on streaming append) so the grid resets scroll/selection. */
  epoch: number;
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
  epoch: 0,
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

export type Tab = {
  id: string;
  title: string;
  sql: string;
  filePath: string | null;
  dirty: boolean;
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
    searchSchema: init?.searchSchema ?? null,
    result: init?.result ?? { ...EMPTY_RESULT },
    gridView: init?.gridView ?? { ...EMPTY_GRID_VIEW },
  };
}
