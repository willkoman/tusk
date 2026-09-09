import { createSignal, createMemo, createEffect, on, onCleanup, untrack, For, Show, type Accessor } from "solid-js";
import { type Dataset, formatForCopy, formatWithOptions } from "./formats";
import { defaultExportOptions } from "./export";
import { clipWrite, clipRead } from "./clipboard";
import { type MenuItem } from "./ContextMenu";
import { type GridView, type SortKey, type PendingEdits } from "./tabs";
import { hiddenRuleCount, quickFilterOf, setQuickFilter, type FilterTree } from "./grid/filterModel";
import { boolWord } from "./grid/bool";
import { parseClipboardTable, type RowRef } from "./grid/paste";
import { cellTitle, columnRenders, displayText, type ColumnRender } from "./grid/cellRender";
import { findMatches, matchAtOrAfter, matchSet, stepMatch, type GridMatch } from "./grid/find";
import { summarizeSelection, type SelectionSummary } from "./grid/summary";
import { slotOffset, startPointerDrag, type PointerDragHandle } from "./dnd";

/** A grid selection offered to Export, bound to the result it was taken from. */
export type SelectionSource = Dataset & { tabId: string; generation: number };

/** What the status bar shows about the selection (loaded rows only). */
export type GridSelectionInfo = {
  /** 1-based position of the focused cell. */
  row: number;
  col: number;
  /** Column name under the focused cell. */
  column: string;
  summary: SelectionSummary;
};

// Hand-rolled, two-axis-virtualized, read-only result grid. Uses a synchronized-pane
// layout (header + gutter are transform-translated siblings of the body scroller, NOT
// position:sticky) for reliable frozen header/gutter in WKWebView. Selection, keyboard
// nav, multi-format copy, resize/autofit/reorder/hide, and server sort/filter affordances.

const HEAD_H = 30;
const FILTER_H = 30;
const FIND_H = 30;
const GUTTER_W = 56;
/** Gutter width with row numbers off — still wide enough to grab a row. */
const GUTTER_W_SLIM = 22;
const MIN_COL_W = 48;
const MAX_COL_W = 900;
const ROW_OVERSCAN = 8;
const COL_OVERSCAN = 2;

/** Pref-driven appearance (row height, measure font, zebra, NULL render, default width). */
export type GridStyle = {
  rowH: number;
  font: string; // canvas font string for autofit measurement — must match .rg-cell
  zebra: boolean;
  nullStyle: "null" | "empty" | "dash";
  defaultColW: number;
};

type SelMode = "none" | "cell" | "range" | "rows" | "cols";
type Sel = { mode: SelMode; ar: number; ac: number; fr: number; fc: number }; // col = display index
const EMPTY_SEL: Sel = { mode: "none", ar: -1, ac: -1, fr: -1, fc: -1 };

export type ResultGridProps = {
  columns: Accessor<string[]>;
  rows: Accessor<(string | null)[][]>;
  done: Accessor<boolean>;
  view: Accessor<GridView>;
  setView: (patch: Partial<GridView>) => void;
  activeTabId: Accessor<string>;
  /** Bumped on each new query (not on append) — grid resets scroll/selection. */
  epoch: Accessor<number>;
  /** Identity of the backend result loaded into this tab. */
  resultGeneration: Accessor<number>;
  onLoadMore: () => void;
  onSortFilter: (sorts: SortKey[], filters: FilterTree, kind: "sort" | "filter") => void;
  /** Open the visual filter builder, optionally pre-filled for one column. */
  onOpenFilter: (column?: string) => void;
  onMenu: (x: number, y: number, items: MenuItem[]) => void;
  onViewValue: (col: string, val: string | null) => void;
  onStatus: (text: string, tabId: string, resultGeneration: number) => void;
  canSort: Accessor<boolean>;
  /** Why sorting is unavailable right now (empty when `canSort`); surfaced as status on a header click. */
  sortUnavailable: Accessor<string>;
  canFilter: Accessor<boolean>;
  /** Canonical loaded-row indices in visible order; null = identity. */
  rowOrder: Accessor<number[] | null>;
  /** Include column names as a header row in copied text (default off). */
  copyHeaders: Accessor<boolean>;
  /** Appearance prefs (read via accessor inside memos/JSX — never captured). */
  gridStyle: Accessor<GridStyle>;
  /** In-grid editing: whether the current result is editable (single-table SELECT w/ PK). */
  editable: Accessor<boolean>;
  /** Human reason when not editable (shown in the cell context menu). */
  editReason: Accessor<string>;
  /** Uncommitted edits overlay (snapshot rows are never mutated). */
  pending: Accessor<PendingEdits | undefined>;
  /** Whether this ORIGINAL column belongs to the target table (defense-in-depth; non-table cells never edit). */
  canEditCol: (origCol: number) => boolean;
  /** Record a cell edit: null = SQL NULL, undefined = revert (clear pending entry). */
  onEditCell: (ref: RowRef, origCol: number, val: string | null | undefined) => void;
  /** Per ORIGINAL column: render textual booleans as TRUE/FALSE badges. */
  isBoolCol: (origCol: number) => boolean;
  /** Driver type of an ORIGINAL column when the source relation's detail is loaded. */
  colType: (origCol: number) => string | undefined;
  /** Table name "Copy as SQL INSERT" writes into ("" falls back to `exported`). */
  sqlTable: Accessor<string>;
  /** Focused-cell position and selection aggregates for the status bar. */
  onSelectionInfo?: (info: GridSelectionInfo | null) => void;
  /** Boolean editor info for an ORIGINAL column (null = free-text editor). */
  boolEdit: (origCol: number) => { trueVal: string; falseVal: string; nullable: boolean } | null;
  /** Toggle delete-marks on the given rows (insert rows are removed outright). */
  onMarkDelete: (rows: RowRef[]) => void;
  onAddRow: () => void;
  /** Hands the workbench a getter for the current selection, so Export can offer it as
   *  a scope. Returns null when nothing is selected, only uncommitted insert rows are
   *  selected, or the selection exceeds the copy ceiling (Export "All rows"/"Loaded
   *  rows" covers those). The snapshot carries the tab + result generation it belongs
   *  to, and the grid clears the registration on unmount, so a replaced or disposed
   *  result can never feed a later Export dialog. */
  registerSelectionSource?: (get: (() => SelectionSource | null) | null) => void;
  /**
   * Paste a parsed clipboard grid. `anchor`/`anchorDisplayIdx`/`displayOrigCols`
   * describe where a positional paste starts; header-mapped pastes ignore them.
   */
  onPaste: (anchor: RowRef, anchorDisplayIdx: number, displayOrigCols: number[], table: string[][]) => void;
};

export function ResultGrid(props: ResultGridProps) {
  let scroller: HTMLDivElement | undefined;
  let root: HTMLDivElement | undefined;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [scrollLeft, setScrollLeft] = createSignal(0);
  const [viewportH, setViewportH] = createSignal(500);
  const [viewportW, setViewportW] = createSignal(800);
  const [sel, setSel] = createSignal<Sel>(EMPTY_SEL);
  const [reorderTo, setReorderTo] = createSignal<number | null>(null);
  // ORIGINAL index of the column being dragged (dimmed in place while its ghost
  // travels). A signal, not a class on the node: the header is virtualized, so the
  // node under a given display index is recycled as auto-scroll pans the columns.
  const [dragCol, setDragCol] = createSignal<number | null>(null);
  let headerDrag: PointerDragHandle | null = null;

  const headTop = () => HEAD_H + (props.view().filterRowOpen ? FILTER_H : 0);
  const rowH = () => props.gridStyle().rowH;
  // View toggles read through memos: `props.view()` gets a new identity on every
  // setView, so a plain accessor would re-fire the effects keyed off them.
  const findOpen = createMemo(() => props.view().findOpen);
  const recordOpen = createMemo(() => props.view().recordOpen);
  /** Height reserved above the header for the find bar. */
  const topOffset = () => (findOpen() ? FIND_H : 0);
  const gutW = () => (props.view().rowNumbers ? GUTTER_W : GUTTER_W_SLIM);

  // --- display-column mapping (recomputes only on order/hidden change) ---
  const displayCols = createMemo(() => {
    const hidden = new Set(props.view().hidden);
    const order = props.view().order;
    return order.filter((oi) => !hidden.has(oi));
  });
  /** First display column pinned in place (pointless with a single column). */
  const sticky = createMemo(() => props.view().stickyFirst && displayCols().length > 1);
  const frozenW = () => (sticky() ? colWidth(displayCols()[0]) : 0);
  const colWidth = (oi: number) => props.view().widths[oi] ?? props.gridStyle().defaultColW;
  const offsets = createMemo(() => {
    const dc = displayCols();
    const out = new Array(dc.length + 1);
    out[0] = 0;
    for (let k = 0; k < dc.length; k++) out[k + 1] = out[k] + colWidth(dc[k]);
    return out;
  });
  const contentW = () => offsets()[offsets().length - 1] || 0;

  // --- pending-edits overlay (virtual rows = insert rows FIRST, then loaded rows) ---
  // Insert rows occupy virtual indices [0, nIns) so they stay pinned at the top of the
  // grid, immediately reachable, regardless of how many loaded rows have streamed in (a
  // bottom-anchored insert would force scrolling to the end of a huge result to edit it).
  // The pending store still keys edits/deletes by LOADED index and inserts by array
  // index — `rowRef` is the single translation from a virtual row to that stable
  // identity, used both for rendering and for every callback into App.
  const nLoaded = () => props.rows().length;
  const nIns = () => props.pending()?.inserts.length ?? 0;
  const nRows = createMemo(() => nLoaded() + nIns());
  const isInsRow = (r: number) => r < nIns();
  const displayLoadedAt = (r: number) => r - nIns(); // valid when !isInsRow(r)
  const loadedAt = (r: number) => props.rowOrder()?.[displayLoadedAt(r)] ?? displayLoadedAt(r);
  const rowRef = (r: number): RowRef => (isInsRow(r) ? { kind: "insert", i: r } : { kind: "loaded", i: loadedAt(r) });
  const delSet = createMemo(() => new Set(props.pending()?.deletes ?? []));
  const isDeleted = (r: number) => !isInsRow(r) && delSet().has(loadedAt(r));
  const insRec = (r: number) => props.pending()?.inserts[r];
  /** Displayed value: pending edit > snapshot; insert rows read their sparse record. */
  const cellVal = (r: number, oi: number): string | null => {
    if (isInsRow(r)) return insRec(r)?.[oi] ?? null;
    const li = loadedAt(r);
    const e = props.pending()?.cells[li]?.[oi];
    return e !== undefined ? e : props.rows()[li]?.[oi] ?? null;
  };
  /** Copy-facing value: boolean columns yield the displayed word (TRUE/FALSE), not the driver token (t/f/0/1). */
  const copyVal = (r: number, oi: number): string | null => {
    const v = cellVal(r, oi);
    return v !== null && props.isBoolCol(oi) ? boolWord(v) ?? v : v;
  };
  const isDirty = (r: number, oi: number) => !isInsRow(r) && props.pending()?.cells[loadedAt(r)]?.[oi] !== undefined;
  const isInsUntouched = (r: number, oi: number) => isInsRow(r) && insRec(r)?.[oi] === undefined;

  const totalH = createMemo(() => nRows() * rowH());

  function colAt(x: number): number {
    const o = offsets();
    let lo = 0,
      hi = o.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (o[mid + 1] <= x) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo, Math.max(0, o.length - 2));
  }

  const visRows = createMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop() / rowH()) - ROW_OVERSCAN);
    const end = Math.min(nRows(), start + Math.ceil(viewportH() / rowH()) + ROW_OVERSCAN * 2);
    return { start, end };
  });
  const visCols = createMemo(() => {
    const n = displayCols().length;
    if (!n) return { start: 0, end: 0 };
    const start = Math.max(0, colAt(scrollLeft()) - COL_OVERSCAN);
    const end = Math.min(n, colAt(scrollLeft() + viewportW()) + 1 + COL_OVERSCAN);
    return { start, end };
  });
  const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
  // Display indices to render. With a pinned first column it stays in the list
  // even when scrolled far to the right — it is painted at the viewport edge by
  // a translate, so virtualization is untouched and hit-testing keeps using the
  // same content coordinates as every other column.
  const colWindow = createMemo(() => {
    const { start, end } = visCols();
    const window = range(start, end);
    return sticky() && start > 0 ? [0, ...window] : window;
  });

  // --- type-aware rendering (presentation only; copy/export read raw text) ---
  const DEFAULT_RENDER: ColumnRender = { cls: "text", badge: "", badgeTitle: "", inferred: true };
  const renders = createMemo(() =>
    columnRenders(props.columns(), props.rows(), props.colType, props.isBoolCol),
  );
  const renderOf = (oi: number): ColumnRender => renders()[oi] ?? DEFAULT_RENDER;

  // --- scroll handling (rAF-coalesced) ---
  // Scroll updates ONLY the local signals (which only the grid's row/col window memos
  // depend on) + a non-reactive per-tab memory. It must NOT write to the tab's gridView:
  // that would rebuild the tabs array and invalidate `activeTab` across the whole App on
  // every scroll frame (the cause of the large-table jank/crash).
  const scrollMem = new Map<string, { top: number; left: number }>();
  let rafPending = false;
  let scrollRaf: number | undefined;
  let measureRaf: number | undefined;
  let resizeObserver: ResizeObserver | undefined;
  function onScroll() {
    if (!scroller || rafPending) return;
    rafPending = true;
    scrollRaf = requestAnimationFrame(() => {
      rafPending = false;
      if (!scroller) return;
      const st = scroller.scrollTop,
        sl = scroller.scrollLeft;
      setScrollTop(st);
      setScrollLeft(sl);
      scrollMem.set(props.activeTabId(), { top: st, left: sl });
      const gap = totalH() - (st + scroller.clientHeight);
      if (!props.done() && gap < viewportH() * 1.5) props.onLoadMore();
    });
  }
  function mountScroller(el: HTMLDivElement) {
    scroller = el;
    const measure = () => {
      setViewportH(el.clientHeight);
      setViewportW(el.clientWidth);
    };
    measureRaf = requestAnimationFrame(measure);
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(el);
  }

  // Tab switch → restore that tab's saved scroll; new query in the same tab → reset to top.
  // Keyed on `${tabId}:${epoch}` so we can tell the two apart. NOTE: a sort/filter re-run
  // bumps epoch on purpose — it re-streams from the top, so the old scroll/selection point
  // at now-irrelevant rows; resetting them is the intended behavior (don't "fix" this).
  // MUST be a memo: `on()` re-runs its callback whenever a tracked dep *notifies*, not
  // only when the value changes. `props.epoch()` reads through App's `activeTab()` memo,
  // whose identity changes on every patchTab/patchResult (row append, resize, hide, …) —
  // so a plain function here fired the reset on every grid mutation, yanking scroll to 0
  // and clearing the selection. The memo dedupes by string value, so the callback runs
  // only on a real tab switch or new-query epoch bump.
  const resultKey = createMemo(() => `${props.activeTabId()}:${props.resultGeneration()}:${props.epoch()}`);
  createEffect(
    on(resultKey, (key, prev) => {
      setSel(EMPTY_SEL);
      setEditing(null);
      setFindIdx(-1); // match positions belong to the result they were found in
      const tab = key.split(":")[0];
      const switched = !prev || prev.split(":")[0] !== tab;
      if (!switched) scrollMem.set(tab, { top: 0, left: 0 }); // new query → reset
      const mem = scrollMem.get(tab) ?? { top: 0, left: 0 };
      const top = switched ? mem.top : 0;
      const left = switched ? mem.left : 0;
      queueMicrotask(() => {
        if (!scroller) return;
        scroller.scrollTop = top;
        scroller.scrollLeft = left;
        setScrollTop(top);
        setScrollLeft(left);
      });
    }),
  );

  // New insert rows (from +Row or paste) are appended to the pending insert array and
  // live at the TOP of the virtual space — reveal the first one and put the cursor on
  // its first editable cell so the user can type immediately without scrolling. Gated
  // to same-tab increases so a tab switch (different pending) never triggers it.
  let insTrack = { tab: "", n: 0 };
  createEffect(() => {
    const tab = props.activeTabId();
    const n = nIns();
    const prev = insTrack;
    insTrack = { tab, n };
    if (!props.editable() || prev.tab !== tab || n <= prev.n) return;
    const firstNew = prev.n; // virtual index of the first appended insert row
    const dc = displayCols();
    let col = 0;
    for (let k = 0; k < dc.length; k++) if (props.canEditCol(dc[k])) { col = k; break; }
    queueMicrotask(() => {
      setSel({ mode: "cell", ar: firstNew, ac: col, fr: firstNew, fc: col });
      scrollCellIntoView(firstNew, col);
      focusGrid(); // +Row leaves focus on the button; reclaim it for immediate typing
    });
  });

  // --- selection ---
  const rect = () => {
    const s = sel();
    return {
      r0: Math.min(s.ar, s.fr),
      r1: Math.max(s.ar, s.fr),
      c0: Math.min(s.ac, s.fc),
      c1: Math.max(s.ac, s.fc),
    };
  };
  function isSel(r: number, dc: number): boolean {
    const s = sel();
    if (s.mode === "none") return false;
    const { r0, r1, c0, c1 } = rect();
    if (s.mode === "rows") return r >= r0 && r <= r1;
    if (s.mode === "cols") return dc >= c0 && dc <= c1;
    return r >= r0 && r <= r1 && dc >= c0 && dc <= c1;
  }
  const isActive = (r: number, dc: number) => sel().fr === r && sel().fc === dc;
  const focusGrid = () => root?.focus();

  function scrollCellIntoView(r: number, dc: number) {
    const sc = scroller;
    if (!sc) return;
    const top = r * rowH();
    if (top < sc.scrollTop) sc.scrollTop = top;
    else if (top + rowH() > sc.scrollTop + sc.clientHeight) sc.scrollTop = top + rowH() - sc.clientHeight;
    const o = offsets();
    // The pinned column sits over the left `frozenW` px of the viewport: it never
    // needs scrolling to, and everything else must clear it.
    if (dc === 0 && sticky()) return;
    const fw = frozenW();
    if (dc < o.length - 1) {
      if (o[dc] < sc.scrollLeft + fw) sc.scrollLeft = Math.max(0, o[dc] - fw);
      else if (o[dc + 1] > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = o[dc + 1] - sc.clientWidth;
    }
  }

  // --- mouse drag (cells + rows) with edge auto-scroll ---
  let dragMode: null | "cell" | "rows" = null;
  let lastPtr = { x: 0, y: 0 };
  let autoRAF = 0;
  function cellFromPtr(cx: number, cy: number) {
    const sc = scroller!;
    const b = sc.getBoundingClientRect();
    const r = Math.max(0, Math.min(nRows() - 1, Math.floor((cy - b.top + sc.scrollTop) / rowH())));
    // A pinned first column covers the left edge of the viewport, so a press there
    // belongs to it whatever the scroll position says.
    if (sticky() && cx - b.left < frozenW()) return { r, c: 0 };
    const c = Math.max(0, Math.min(displayCols().length - 1, colAt(cx - b.left + sc.scrollLeft)));
    return { r, c };
  }
  function beginDrag(e: MouseEvent) {
    e.preventDefault();
    document.body.style.userSelect = "none";
    lastPtr = { x: e.clientX, y: e.clientY };
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", endDrag);
  }
  function onDragMove(e: MouseEvent) {
    lastPtr = { x: e.clientX, y: e.clientY };
    updateDragFocus();
    autoScroll(e.clientX, e.clientY);
  }
  function updateDragFocus() {
    const { r, c } = cellFromPtr(lastPtr.x, lastPtr.y);
    const s = sel();
    if (dragMode === "rows") setSel({ ...s, mode: "rows", fr: r });
    else setSel({ ...s, mode: s.ar === r && s.ac === c ? "cell" : "range", fr: r, fc: c });
  }
  function autoScroll(cx: number, cy: number) {
    const sc = scroller!;
    const b = sc.getBoundingClientRect();
    const EDGE = 30,
      STEP = 20;
    let dx = 0,
      dy = 0;
    if (cy < b.top + EDGE) dy = -STEP;
    else if (cy > b.bottom - EDGE) dy = STEP;
    if (cx < b.left + EDGE) dx = -STEP;
    else if (cx > b.right - EDGE) dx = STEP;
    cancelAnimationFrame(autoRAF);
    if (dx || dy) {
      const tick = () => {
        sc.scrollTop += dy;
        sc.scrollLeft += dx;
        updateDragFocus();
        autoRAF = requestAnimationFrame(tick);
      };
      autoRAF = requestAnimationFrame(tick);
    }
  }
  function endDrag() {
    dragMode = null;
    cancelAnimationFrame(autoRAF);
    autoRAF = 0;
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", endDrag);
  }
  function onCellDown(e: MouseEvent, r: number, dc: number) {
    if (e.button !== 0) return;
    focusGrid();
    if (e.shiftKey) setSel({ ...sel(), mode: "range", fr: r, fc: dc });
    else setSel({ mode: "cell", ar: r, ac: dc, fr: r, fc: dc });
    dragMode = "cell";
    beginDrag(e);
  }
  function onGutterDown(e: MouseEvent, r: number) {
    if (e.button !== 0) return;
    focusGrid();
    const n = displayCols().length;
    if (e.shiftKey) setSel({ ...sel(), mode: "rows", fr: r, fc: n - 1 });
    else setSel({ mode: "rows", ar: r, ac: 0, fr: r, fc: n - 1 });
    dragMode = "rows";
    beginDrag(e);
  }
  function selectAll() {
    const nr = nRows(),
      nc = displayCols().length;
    if (!nr || !nc) return;
    setSel({ mode: "range", ar: 0, ac: 0, fr: nr - 1, fc: nc - 1 });
  }

  // --- find in loaded rows ---
  // Client-side only: it scans the rows already in memory and never re-runs the
  // query, which is why every label says "loaded rows". The server-side filter
  // builder is the other surface, and the two never share state.
  // The box updates on every keystroke; the SCAN is debounced, because one pass
  // over a fully loaded result is millions of comparisons and must not run per
  // character typed.
  const [findText, setFindText] = createSignal("");
  const [findQuery, setFindQuery] = createSignal("");
  const [findIdx, setFindIdx] = createSignal(-1);
  let findInput: HTMLInputElement | undefined;
  let findTimer: ReturnType<typeof setTimeout> | undefined;
  function onFindInput(text: string) {
    setFindText(text);
    clearTimeout(findTimer);
    findTimer = setTimeout(() => setFindQuery(text), 180);
  }
  /** Scan now instead of waiting out the debounce (Enter, next/previous). */
  function flushFind() {
    clearTimeout(findTimer);
    if (findQuery() !== findText()) setFindQuery(findText());
  }
  const findHits = createMemo<{ matches: GridMatch[]; truncated: boolean }>(() => {
    if (!findOpen() || !findQuery()) return { matches: [], truncated: false };
    const dc = displayCols();
    return findMatches(nRows(), dc.length, findQuery(), (r, k) => {
      const oi = dc[k];
      return oi === undefined ? null : copyVal(r, oi);
    });
  });
  const findHitSet = createMemo(() => matchSet(findHits().matches));
  const isHit = (r: number, k: number) => findHitSet().has(`${r}:${k}`);
  const curHit = () => findHits().matches[findIdx()];
  const isCurHit = (r: number, k: number) => {
    const m = curHit();
    return !!m && m.r === r && m.dc === k;
  };
  function goToMatch(i: number) {
    const m = findHits().matches[i];
    setFindIdx(m ? i : -1);
    if (!m) return;
    setSel({ mode: "cell", ar: m.r, ac: m.dc, fr: m.r, fc: m.dc });
    scrollCellIntoView(m.r, m.dc);
  }
  function stepFind(dir: 1 | -1) {
    flushFind();
    goToMatch(stepMatch(findHits().matches.length, findIdx(), dir));
  }
  // A new needle re-seeds the cursor from the focused cell, so Find lands on the
  // nearest match instead of jumping to the top, and reveals it without taking
  // the selection away from the user. Reading the hits untracked keeps a
  // streaming append from silently moving the current match.
  createEffect(
    on(findQuery, () => {
      untrack(() => {
        const s = sel();
        const i = matchAtOrAfter(findHits().matches, Math.max(0, s.fr), Math.max(0, s.fc));
        setFindIdx(i);
        const m = findHits().matches[i];
        if (m) scrollCellIntoView(m.r, m.dc);
      });
    }, { defer: true }),
  );
  createEffect(
    on(findOpen, (open) => {
      if (open) queueMicrotask(() => findInput?.focus());
      else setFindIdx(-1);
    }),
  );
  function closeFind() {
    clearTimeout(findTimer);
    props.setView({ findOpen: false });
    focusGrid();
  }

  // --- inline cell editing ---
  const [editing, setEditing] = createSignal<{ r: number; dc: number } | null>(null);
  let editInput: HTMLInputElement | undefined;
  let editSelect: HTMLSelectElement | undefined;
  let editOrig: string | null = null; // displayed value when the editor opened
  let editCancelled = false;
  const NULL_OPT = "~null~"; // select-option sentinel for SQL NULL
  const DEFAULT_OPT = "~default~"; // untouched insert cell: omit column from INSERT
  function beginEdit(r: number, dc: number) {
    if (!props.editable() || isDeleted(r)) return;
    const oi = displayCols()[dc];
    if (oi === undefined || !props.canEditCol(oi)) return;
    editOrig = cellVal(r, oi);
    editCancelled = false;
    setSel({ mode: "cell", ar: r, ac: dc, fr: r, fc: dc });
    setEditing({ r, dc });
    scrollCellIntoView(r, dc);
  }
  /** Commit one boolean dropdown choice. Shared by the in-cell editor and the record view. */
  function applyBoolChoice(r: number, oi: number, v: string) {
    const be = props.boolEdit(oi);
    if (!be) return;
    if (v === DEFAULT_OPT) {
      props.onEditCell(rowRef(r), oi, undefined);
      return;
    }
    if (v === NULL_OPT) {
      props.onEditCell(rowRef(r), oi, null);
      return;
    }
    // Re-picking the original value reverts the pending edit instead of
    // recording a no-op write (PG snapshot "t" vs dropdown "true" would
    // otherwise compare unequal and stay dirty forever).
    const snap = !isInsRow(r) ? props.rows()[loadedAt(r)]?.[oi] ?? null : undefined;
    if (snap !== undefined && snap !== null && boolWord(snap) === v) props.onEditCell(rowRef(r), oi, undefined);
    else props.onEditCell(rowRef(r), oi, v === "TRUE" ? be.trueVal : be.falseVal);
  }
  /** Commit one text value. `orig` is what the editor opened on. */
  function applyTextValue(r: number, oi: number, orig: string | null, v: string) {
    // Typing nothing over a NULL is not an edit (don't turn NULL into '').
    if (orig === null && v === "") return;
    props.onEditCell(rowRef(r), oi, v);
  }
  function commitEdit(move?: "down" | "right") {
    const ed = editing();
    if (!ed) return;
    const oi = displayCols()[ed.dc];
    const be = props.boolEdit(oi);
    if (be) {
      if (!editSelect) return;
      const v = editSelect.value;
      setEditing(null);
      applyBoolChoice(ed.r, oi, v);
    } else {
      if (!editInput) return;
      const v = editInput.value;
      setEditing(null);
      applyTextValue(ed.r, oi, editOrig, v);
    }
    focusGrid();
    if (move === "down") moveSelTo(ed.r + 1, ed.dc);
    if (move === "right") moveSelTo(ed.r, ed.dc + 1);
  }
  function cancelEdit() {
    editCancelled = true;
    setEditing(null);
    focusGrid();
  }
  function editToNull() {
    const ed = editing();
    if (!ed) return;
    editCancelled = true;
    setEditing(null);
    props.onEditCell(rowRef(ed.r), displayCols()[ed.dc], null);
    focusGrid();
  }
  function moveSelTo(r: number, c: number) {
    r = Math.max(0, Math.min(nRows() - 1, r));
    c = Math.max(0, Math.min(displayCols().length - 1, c));
    setSel({ mode: "cell", ar: r, ac: c, fr: r, fc: c });
    scrollCellIntoView(r, c);
  }
  /**
   * Virtual row indices of the current selection (for delete-mark toggling).
   * A column selection spans ALL rows — never expand that into row deletes;
   * fall back to the clicked row instead.
   */
  function selectedRowIndices(clickRow?: number): number[] {
    const s = sel();
    if (s.mode === "none" || s.mode === "cols") return clickRow !== undefined ? [clickRow] : [];
    const { r0, r1 } = rect();
    const out: number[] = [];
    for (let r = Math.max(0, r0); r <= Math.min(nRows() - 1, r1); r++) out.push(r);
    return out;
  }

  // --- keyboard ---
  function onKeyDown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    const nr = nRows(),
      nc = displayCols().length;
    // Find stays reachable on an empty result so the bar can be dismissed.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      props.setView({ findOpen: true });
      queueMicrotask(() => findInput?.select());
      return;
    }
    if (!nr || !nc) return;
    const s = sel();
    const fr = s.fr < 0 ? 0 : s.fr,
      fc = s.fc < 0 ? 0 : s.fc;
    const mod = e.metaKey || e.ctrlKey;
    const move = (r: number, c: number) => {
      r = Math.max(0, Math.min(nr - 1, r));
      c = Math.max(0, Math.min(nc - 1, c));
      if (e.shiftKey) setSel({ ...sel(), mode: "range", fr: r, fc: c });
      else setSel({ mode: "cell", ar: r, ac: c, fr: r, fc: c });
      scrollCellIntoView(r, c);
      if (r > nr - 30) props.onLoadMore();
      e.preventDefault();
    };
    switch (e.key) {
      case "ArrowDown": move(fr + 1, fc); break;
      case "ArrowUp": move(fr - 1, fc); break;
      case "ArrowLeft": move(fr, fc - 1); break;
      case "ArrowRight": move(fr, fc + 1); break;
      case "Home": mod ? move(0, 0) : move(fr, 0); break;
      case "End": mod ? move(nr - 1, nc - 1) : move(fr, nc - 1); break;
      case "PageDown": move(fr + Math.floor(viewportH() / rowH()), fc); break;
      case "PageUp": move(fr - Math.floor(viewportH() / rowH()), fc); break;
      case "Escape":
        if (findOpen()) { closeFind(); e.preventDefault(); }
        else setSel({ mode: "cell", ar: fr, ac: fc, fr, fc });
        break;
      case "a": if (mod) { selectAll(); e.preventDefault(); } break;
      case "c": if (mod) { void copySelection("tsv"); e.preventDefault(); } break;
      case "v":
        if (mod && props.editable()) { e.preventDefault(); e.stopPropagation(); void doPaste(); }
        break;
      case "Enter":
      case "F2": {
        if (s.mode === "none") break;
        const oi = displayCols()[fc];
        // Editable cell → edit it; anything else → open the value viewer, so
        // Enter always does something on the focused cell.
        if (props.editable() && oi !== undefined && props.canEditCol(oi) && !isDeleted(fr)) beginEdit(fr, fc);
        else if (oi !== undefined) props.onViewValue(props.columns()[oi], cellVal(fr, oi));
        e.preventDefault();
        break;
      }
      case "Delete":
      case "Backspace":
        // Row-selection only — a stray Delete on a cell selection must not mark rows.
        if (props.editable() && s.mode === "rows") {
          const count = Math.max(0, rect().r1 - rect().r0 + 1);
          if (count > 100_000) props.onStatus("Select at most 100,000 rows per edit", props.activeTabId(), props.resultGeneration());
          else props.onMarkDelete(selectedRowIndices().map(rowRef));
          e.preventDefault();
        }
        break;
    }
  }

  // --- paste (Mod+V) — parse the clipboard and hand a grid + anchor to App ---
  async function doPaste() {
    const tabId = props.activeTabId();
    const generation = props.resultGeneration();
    const key = resultKey();
    const selected = { ...sel() };
    const dc = [...displayCols()];
    const pending = props.pending();
    const anchor = selected.mode === "none"
      ? { kind: "insert" as const, i: nIns() }
      : rowRef(Math.max(0, selected.fr < 0 ? 0 : Math.min(selected.fr, Math.max(0, nRows() - 1))));
    const anchorCol = selected.fc < 0 ? 0 : selected.fc;
    try {
      const text = await clipRead();
      if (props.activeTabId() !== tabId || resultKey() !== key || props.pending() !== pending) {
        props.onStatus("Paste cancelled. The result was replaced.", tabId, generation);
        return;
      }
      if (text == null || text === "") return;
      const table = parseClipboardTable(text);
      if (!table.length) return;
      // No active cell → anchor at the append region so a stray paste never overwrites
      // loaded rows; otherwise anchor at the focused cell captured before clipboard I/O.
      props.onPaste(anchor, selected.mode === "none" ? 0 : anchorCol, dc, table);
    } catch (e) {
      props.onStatus(`Paste rejected: ${e instanceof Error ? e.message : String(e)}`, tabId, generation);
    }
  }

  // --- copy ---
  // Hard ceiling on synchronous clipboard materialization. Beyond this the string
  // build (JSON pretty-print ≈ 2-4× expansion) freezes the UI thread and can OOM-kill
  // the WebView — the one crash class CrashGuard cannot catch. Export streams instead.
  const MAX_COPY_CELLS = 1_000_000;
  const MAX_COPY_CHARS = 8 * 1024 * 1024;
  function selectionBounds(): { r0: number; r1: number; cols: number[] } {
    const dc = displayCols();
    const s = sel();
    let r0 = 0,
      r1 = nRows() - 1,
      cols = dc;
    if (s.mode === "cell" || s.mode === "range" || s.mode === "rows") {
      const re = rect();
      r0 = Math.max(0, re.r0);
      r1 = Math.min(nRows() - 1, re.r1);
    }
    if (s.mode === "cell" || s.mode === "range" || s.mode === "cols") {
      const re = rect();
      cols = dc.slice(Math.max(0, re.c0), Math.min(dc.length, re.c1 + 1));
    }
    return { r0, r1, cols };
  }
  function selectionDataset(bounds = selectionBounds()): Dataset {
    const names = props.columns();
    const { r0, r1, cols } = bounds;
    // Read through the pending overlay + bool mapping so copy matches what's
    // displayed (edited cells, insert rows, TRUE/FALSE pills).
    const rows: (string | null)[][] = [];
    for (let r = r0; r <= r1; r++) rows.push(cols.map((oi) => copyVal(r, oi)));
    return { columns: cols.map((oi) => names[oi]), rows };
  }
  // The workbench reads the live selection through this getter (Export → Selection).
  // It returns the selected ROWS at full width in ORIGINAL column order, so the export
  // dialog's own column checkboxes and ordering still apply on top.
  //
  // Unlike clipboard copy, this reads the IMMUTABLE SNAPSHOT and skips pinned insert
  // rows: an export writes a file, and a file must not contain values that are not in
  // the database. That makes Selection and "Loaded rows" agree row for row.
  props.registerSelectionSource?.(() => {
    if (sel().mode === "none") return null;
    const b = selectionBounds();
    const names = props.columns();
    if (b.r1 < b.r0 || !names.length) return null;
    if ((b.r1 - b.r0 + 1) * names.length > MAX_COPY_CELLS) return null;
    const out: (string | null)[][] = [];
    for (let r = b.r0; r <= b.r1; r++) {
      if (isInsRow(r)) continue;
      const li = loadedAt(r);
      out.push(names.map((_, oi) => props.rows()[li]?.[oi] ?? null));
    }
    if (!out.length) return null;
    return {
      tabId: props.activeTabId(),
      generation: props.resultGeneration(),
      columns: names.slice(),
      rows: out,
    };
  });
  // A disposed grid must not keep feeding Export → Selection.
  onCleanup(() => props.registerSelectionSource?.(null));

  // --- selection facts for the status bar ---
  // Position and size are published immediately; the aggregate scan is deferred
  // for anything but a small selection so dragging a range stays smooth. The
  // deferred emit re-checks the tab and result generation, so a summary can
  // never land on a result it was not taken from.
  const SUMMARY_INLINE_CELLS = 2_000;
  let summaryTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const report = props.onSelectionInfo;
    if (!report) return;
    const s = sel();
    const dc = displayCols();
    void props.rows();
    void props.pending();
    clearTimeout(summaryTimer);
    if (s.mode === "none" || !dc.length || !nRows()) {
      report(null);
      return;
    }
    const b = selectionBounds();
    const rowsN = Math.max(0, b.r1 - b.r0 + 1);
    const colsN = b.cols.length;
    const at = {
      row: Math.max(0, s.fr) + 1,
      col: Math.max(0, s.fc) + 1,
      column: props.columns()[dc[Math.max(0, s.fc)]] ?? "",
    };
    const compute = () => summarizeSelection(rowsN, colsN, (r, c) => copyVal(b.r0 + r, b.cols[c]));
    if (rowsN * colsN <= SUMMARY_INLINE_CELLS) {
      report({ ...at, summary: compute() });
      return;
    }
    report({ ...at, summary: { rows: rowsN, cols: colsN, cells: rowsN * colsN, nulls: 0, numeric: null, truncated: false } });
    const tabId = props.activeTabId();
    const generation = props.resultGeneration();
    summaryTimer = setTimeout(() => {
      if (props.activeTabId() === tabId && props.resultGeneration() === generation) report({ ...at, summary: compute() });
    }, 150);
  });
  onCleanup(() => {
    clearTimeout(summaryTimer);
    props.onSelectionInfo?.(null);
  });

  /** Clipboard shapes offered by "Copy as". `headers` copies column names only. */
  type CopyFmt = "tsv" | "csv" | "json" | "md" | "sql" | "headers";

  /**
   * INSERT statements for the selection, through the same options-driven
   * formatter Export uses, so clipboard bytes match an exported .sql file.
   * `selectionDataset` has already mapped booleans to TRUE/FALSE, and
   * `boolCols` (projected indices) makes them unquoted literals of the source
   * dialect rather than quoted strings.
   */
  function sqlInsertText(d: Dataset, cols: number[]): string {
    const o = defaultExportOptions("");
    o.format = "sql";
    o.sql = { ...o.sql, table: props.sqlTable() || "exported", includeCreate: false, multiRow: false };
    o.boolCols = cols.map((oi, k) => (props.isBoolCol(oi) ? k : -1)).filter((k) => k >= 0);
    return formatWithOptions(d, o);
  }

  function copyColumnNames(cols: number[]) {
    const names = cols.map((oi) => props.columns()[oi]).filter((n): n is string => n != null);
    if (!names.length) return;
    const o = defaultExportOptions("");
    o.format = "tsv";
    o.delimiter = "tab";
    o.header = true;
    try {
      void copyText(
        formatWithOptions({ columns: names, rows: [] }, o),
        `copied ${names.length} column name${names.length === 1 ? "" : "s"}`,
      );
    } catch (e) {
      props.onStatus(`copy rejected: ${e instanceof Error ? e.message : String(e)}`, props.activeTabId(), props.resultGeneration());
    }
  }

  async function copySelection(fmt: CopyFmt) {
    const tabId = props.activeTabId();
    const generation = props.resultGeneration();
    const b = selectionBounds();
    if (fmt === "headers") {
      copyColumnNames(b.cols);
      return;
    }
    const cells = (b.r1 - b.r0 + 1) * b.cols.length;
    if (cells > MAX_COPY_CELLS) {
      props.onStatus(`Selection too large to copy (${cells.toLocaleString()} cells). Use Export… instead.`, tabId, generation);
      return;
    }
    let chars = props.copyHeaders() ? b.cols.reduce((n, oi) => n + (props.columns()[oi]?.length ?? 0), 0) : 0;
    outer: for (let r = b.r0; r <= b.r1; r++) {
      for (const oi of b.cols) {
        chars += copyVal(r, oi)?.length ?? 0;
        if (chars > MAX_COPY_CHARS) break outer;
      }
    }
    if (chars > MAX_COPY_CHARS) {
      props.onStatus(`Selection too large to copy (${chars.toLocaleString()}+ characters). Use Export… instead.`, tabId, generation);
      return;
    }
    const d = selectionDataset(b);
    const h = props.copyHeaders();
    try {
      const text = fmt === "sql" ? sqlInsertText(d, b.cols) : formatForCopy(d, fmt, h);
      const ok = await clipWrite(text);
      props.onStatus(ok ? `Copied ${d.rows.length}×${d.columns.length}` : "Clipboard unavailable", tabId, generation);
    } catch (e) {
      props.onStatus(`Copy rejected: ${e instanceof Error ? e.message : String(e)}`, tabId, generation);
    }
  }
  async function copyText(t: string, msg: string) {
    const tabId = props.activeTabId();
    const generation = props.resultGeneration();
    if (t.length > MAX_COPY_CHARS) {
      props.onStatus(`Value too large to copy (${t.length.toLocaleString()} characters). Use Export… instead.`, tabId, generation);
      return;
    }
    try {
      const ok = await clipWrite(t);
      props.onStatus(ok ? msg : "Clipboard unavailable", tabId, generation);
    } catch (e) {
      props.onStatus(`Copy rejected: ${e instanceof Error ? e.message : String(e)}`, tabId, generation);
    }
  }
  const columnDataset = (oi: number): Dataset => ({
    columns: [props.columns()[oi]],
    rows: Array.from({ length: nRows() }, (_, r) => [copyVal(r, oi)]),
  });
  function copyColumn(oi: number) {
    if (nRows() > MAX_COPY_CELLS) {
      props.onStatus(`Column too large to copy (${nRows().toLocaleString()} rows). Use Export… instead.`, props.activeTabId(), props.resultGeneration());
      return;
    }
    let chars = props.copyHeaders() ? props.columns()[oi]?.length ?? 0 : 0;
    for (let r = 0; r < nRows() && chars <= MAX_COPY_CHARS; r++) chars += copyVal(r, oi)?.length ?? 0;
    if (chars > MAX_COPY_CHARS) {
      props.onStatus(`Column too large to copy (${chars.toLocaleString()}+ characters). Use Export… instead.`, props.activeTabId(), props.resultGeneration());
      return;
    }
    void copyText(formatForCopy(columnDataset(oi), "tsv", props.copyHeaders()), "Copied column");
  }

  function bindMenuItems(items: MenuItem[]): MenuItem[] {
    const tabId = props.activeTabId();
    const key = resultKey();
    const pending = props.pending();
    const order = props.rowOrder();
    const view = props.view();
    const valid = () =>
      props.activeTabId() === tabId &&
      resultKey() === key &&
      props.pending() === pending &&
      props.rowOrder() === order &&
      props.view() === view;
    return items.map((item) => "sep" in item ? item : { ...item, valid });
  }

  // --- context menus ---
  /** "Copy as…" — every clipboard shape for the current selection, loaded rows only. */
  function openCopyAs(x: number, y: number) {
    props.onMenu(x, y, bindMenuItems([
      { label: "TSV", icon: "copy", onClick: () => void copySelection("tsv") },
      { label: "CSV", icon: "copy", onClick: () => void copySelection("csv") },
      { label: "JSON", icon: "copy", onClick: () => void copySelection("json") },
      { label: "Markdown", icon: "copy", onClick: () => void copySelection("md") },
      { label: "SQL INSERT", icon: "code", onClick: () => void copySelection("sql") },
      { sep: true },
      { label: "Column names", icon: "columns", onClick: () => void copySelection("headers") },
    ]));
  }
  function onCellContext(e: MouseEvent, r: number, dc: number, oi: number, val: string | null) {
    e.preventDefault();
    e.stopPropagation();
    if (!isSel(r, dc)) setSel({ mode: "cell", ar: r, ac: dc, fr: r, fc: dc });
    const name = props.columns()[oi];
    const clickedRef = rowRef(r);
    const editItems: MenuItem[] = [];
    if (props.editable()) {
      const selectedCount = sel().mode === "none" || sel().mode === "cols" ? 1 : Math.max(0, rect().r1 - rect().r0 + 1);
      const editSelectionTooLarge = selectedCount > 100_000;
      const selRows = editSelectionTooLarge ? [] : selectedRowIndices(r);
      // "Undelete" only when every LOADED row in the selection is already marked
      // (insert rows aren't delete-marked — they're removed outright).
      const loadedSel = selRows.filter((x) => !isInsRow(x));
      const allDel = loadedSel.length > 0 && loadedSel.every(isDeleted);
      const colOk = props.canEditCol(oi) && !isDeleted(r);
      editItems.push(
        { label: "Edit cell", icon: "edit", disabled: !colOk, title: colOk ? undefined : "Column is not part of the table", onClick: () => beginEdit(r, dc) },
        { label: "Set NULL", icon: "slash", disabled: !colOk, onClick: () => props.onEditCell(clickedRef, oi, null) },
      );
      if (isDirty(r, oi)) editItems.push({ label: "Revert cell", icon: "eraser", onClick: () => props.onEditCell(clickedRef, oi, undefined) });
      editItems.push(
        {
          label: editSelectionTooLarge ? "Delete rows" : allDel ? `Undelete row${selRows.length > 1 ? "s" : ""}` : `Delete row${selRows.length > 1 ? "s" : ""}`,
          icon: "trash",
          danger: !allDel,
          disabled: editSelectionTooLarge,
          title: editSelectionTooLarge ? "Select at most 100,000 rows per edit" : undefined,
          onClick: () => props.onMarkDelete(selRows.map(rowRef)),
        },
        { label: "Insert row", icon: "plus", onClick: () => props.onAddRow() },
        { sep: true },
      );
    } else if (props.editReason()) {
      editItems.push({ label: "Edit cell", icon: "edit", disabled: true, title: props.editReason(), onClick: () => {} }, { sep: true });
    }
    const copiedVal = copyVal(r, oi);
    const at = { x: e.clientX, y: e.clientY };
    props.onMenu(at.x, at.y, bindMenuItems([
      ...editItems,
      { label: "Copy", icon: "copy", onClick: () => void copySelection("tsv") },
      // A second menu at the same point rather than a nested one: the menu
      // component is flat by design, and one click still reaches every format.
      { label: "Copy as…", icon: "copy", onClick: () => openCopyAs(at.x, at.y) },
      { sep: true },
      { label: val === null ? "Copy value (empty for NULL)" : "Copy cell value", icon: "copy", onClick: () => void copyText(copiedVal ?? "", "Copied value") },
      { label: "Copy column", icon: "copy", onClick: () => copyColumn(oi) },
      { label: "View value…", icon: "search", onClick: () => props.onViewValue(name, val) },
    ]));
  }
  function onHeaderContext(e: MouseEvent, oi: number, dc: number) {
    e.preventDefault();
    e.stopPropagation();
    const items: MenuItem[] = [];
    if (props.canSort()) {
      items.push(
        { label: "Sort ascending", icon: "sortAsc", onClick: () => setSort(oi, "asc") },
        { label: "Sort descending", icon: "sortDesc", onClick: () => setSort(oi, "desc") },
        { label: "Clear sort", icon: "close", onClick: () => clearSort(oi) },
      );
    }
    if (props.canFilter()) {
      items.push(
        { label: "Filter by this column…", icon: "search", onClick: () => props.onOpenFilter(props.columns()[oi]) },
        { label: props.view().filterRowOpen ? "Hide filter row" : "Show filter row", icon: "search", onClick: () => props.setView({ filterRowOpen: !props.view().filterRowOpen }) },
      );
    }
    if (props.canSort() || props.canFilter()) items.push({ sep: true });
    items.push(
      { label: "Autofit column", icon: "resize", onClick: () => autofit(oi) },
      { label: "Hide column", icon: "eyeOff", onClick: () => hideCol(oi) },
      {
        label: props.view().stickyFirst ? "Unfreeze first column" : "Freeze first column",
        icon: "lock",
        onClick: () => props.setView({ stickyFirst: !props.view().stickyFirst }),
      },
      {
        label: props.view().rowNumbers ? "Hide row numbers" : "Show row numbers",
        icon: "hash",
        onClick: () => props.setView({ rowNumbers: !props.view().rowNumbers }),
      },
    );
    const hidden = props.view().hidden;
    if (hidden.length) {
      items.push({ sep: true });
      for (const h of hidden) items.push({ label: `Show "${props.columns()[h]}"`, icon: "eye", onClick: () => showCol(h) });
      items.push({ label: "Show all columns", icon: "eye", onClick: () => props.setView({ hidden: [] }) });
    }
    items.push({ sep: true }, { label: "Copy column", icon: "copy", onClick: () => copyColumn(oi) });
    void dc;
    props.onMenu(e.clientX, e.clientY, bindMenuItems(items));
  }

  // --- sort / filter ---
  function setSort(oi: number, dir: "asc" | "desc") {
    const next: SortKey[] = [{ col: oi, dir }];
    props.onSortFilter(next, props.view().filters, "sort");
  }
  function clearSort(oi: number) {
    const next = props.view().sorts.filter((s) => s.col !== oi);
    props.onSortFilter(next, props.view().filters, "sort");
  }
  function cycleSort(oi: number, additive: boolean) {
    if (!props.canSort()) {
      // A silent no-op reads as a broken header; say why instead.
      const why = props.sortUnavailable();
      if (why) props.onStatus(why, props.activeTabId(), props.resultGeneration());
      return;
    }
    const cur = props.view().sorts;
    const existing = cur.find((s) => s.col === oi);
    const cycled = !existing ? "asc" : existing.dir === "asc" ? "desc" : null;
    let next: SortKey[];
    if (additive) {
      next = cur.filter((s) => s.col !== oi);
      if (cycled) next.push({ col: oi, dir: cycled });
    } else {
      next = cycled ? [{ col: oi, dir: cycled }] : [];
    }
    props.onSortFilter(next, props.view().filters, "sort");
  }
  const sortFor = (oi: number) => props.view().sorts.find((s) => s.col === oi);
  const sortIndex = (oi: number) => props.view().sorts.findIndex((s) => s.col === oi);

  let filterTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeCleanup: (() => void) | null = null;
  // The quick-filter row writes top-level `contains` conditions into the same
  // structured tree the builder edits, so both surfaces share one model.
  function onFilterInput(oi: number, text: string) {
    const name = props.columns()[oi];
    if (name == null) return;
    const filters = setQuickFilter(props.view().filters, name, text);
    props.setView({ filters });
    clearTimeout(filterTimer);
    const key = resultKey();
    const tabId = props.activeTabId();
    const sorts = [...props.view().sorts];
    filterTimer = setTimeout(() => {
      if (props.activeTabId() === tabId && resultKey() === key) props.onSortFilter(sorts, filters, "filter");
    }, 300);
  }
  const filterFor = (oi: number) => quickFilterOf(props.view().filters, props.columns()[oi] ?? "");
  // Builder rules this one-line box cannot represent (another operator, or a rule
  // nested in a group). Without the marker an empty box reads as "no filter on
  // this column" while the result is in fact filtered by it.
  const hiddenRulesFor = (oi: number) => hiddenRuleCount(props.view().filters, props.columns()[oi] ?? "");

  onCleanup(() => {
    clearTimeout(filterTimer);
    clearTimeout(findTimer);
    resizeObserver?.disconnect();
    if (scrollRaf !== undefined) cancelAnimationFrame(scrollRaf);
    if (measureRaf !== undefined) cancelAnimationFrame(measureRaf);
    dragMode = null;
    cancelAnimationFrame(autoRAF);
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", endDrag);
    headerDrag?.cancel();
    headerDrag = null;
    resizeCleanup?.();
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  });

  // --- resize / autofit / reorder / hide ---
  // Pointer events, not mouse: the header cell's own reorder press is a pointerdown,
  // which fires BEFORE any mousedown — a mousedown-based stopPropagation here would
  // arrive too late and every resize would also arm a column drag. Selection is
  // cancelled by the header cell's mousedown handler, which this press bubbles to.
  function startResize(e: PointerEvent, oi: number) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const startX = e.clientX,
      startW = colWidth(oi);
    resizeCleanup?.();
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const mv = (ev: PointerEvent) =>
      props.setView({ widths: { ...props.view().widths, [oi]: Math.max(MIN_COL_W, Math.min(MAX_COL_W, startW + ev.clientX - startX)) } });
    const up = () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      resizeCleanup = null;
    };
    resizeCleanup = up;
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }
  let measureCtx: CanvasRenderingContext2D | null = null;
  function autofit(oi: number) {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    if (!measureCtx) return;
    measureCtx.font = props.gridStyle().font;
    let max = measureCtx.measureText(props.columns()[oi]).width + 34;
    const { start, end } = visRows();
    for (let r = start; r < end; r++) {
      const v = cellVal(r, oi);
      if (v != null) max = Math.max(max, measureCtx.measureText(v).width + 22);
    }
    props.setView({ widths: { ...props.view().widths, [oi]: Math.max(MIN_COL_W, Math.min(MAX_COL_W, Math.ceil(max))) } });
  }
  function hideCol(oi: number) {
    props.setView({ hidden: [...props.view().hidden, oi] });
  }
  function showCol(oi: number) {
    props.setView({ hidden: props.view().hidden.filter((h) => h !== oi) });
  }
  function moveColumn(fromDisp: number, toDisp: number) {
    const dc = displayCols();
    if (fromDisp === toDisp || toDisp === fromDisp + 1) return;
    const movingOi = dc[fromDisp];
    const remaining = dc.filter((_, i) => i !== fromDisp);
    const insertAt = toDisp > fromDisp ? toDisp - 1 : toDisp;
    remaining.splice(insertAt, 0, movingOi);
    props.setView({ order: [...remaining, ...props.view().hidden] });
  }

  /**
   * Header press: one gesture that is a sort click until the pointer travels
   * DRAG_THRESHOLD px, then becomes a column reorder with the shared ghost and
   * insertion bar (src/dnd.ts). Only `GridView.order` changes — canonical column
   * identity (the ORIGINAL index) is never touched, so edits, copies and export
   * keep addressing the same data. Column edges come from `offsets()`, already in
   * the body scroller's content coordinates, so the drag and the bar agree even
   * while auto-scroll pans the header.
   */
  function onHeaderDown(e: PointerEvent, dc: number, oi: number) {
    if (e.button !== 0) return;
    focusGrid();
    const shift = e.shiftKey;
    headerDrag?.cancel();
    headerDrag = startPointerDrag({
      event: e,
      from: dc,
      source: e.currentTarget as HTMLElement,
      scroller: scroller!,
      edges: () => offsets(),
      dropZone: () => root,
      onStart: () => setDragCol(oi),
      onSlot: (slot) => setReorderTo(slot),
      onDrop: (from, slot) => moveColumn(from, slot),
      onEnd: (moved) => {
        headerDrag = null;
        setDragCol(null);
        if (moved) return;
        const nr = nRows();
        setSel({ mode: "cols", ar: 0, ac: dc, fr: nr - 1, fc: dc });
        cycleSort(oi, shift);
      },
    });
  }

  // --- record view (the focused row as a name/value list) ---
  /** Fields rendered at once. The grid virtualizes columns; this list does not. */
  const MAX_RECORD_FIELDS = 200;
  const recFields = createMemo(() => displayCols().slice(0, MAX_RECORD_FIELDS));
  /** Virtual row the record view shows; -1 when nothing is selected. */
  const recRow = () => {
    const s = sel();
    if (s.mode === "none" || !nRows()) return -1;
    return Math.min(Math.max(0, s.fr), nRows() - 1);
  };
  function stepRecord(dir: 1 | -1) {
    const s = sel();
    moveSelTo(Math.max(0, s.fr) + dir, Math.max(0, s.fc));
  }
  function onRecordKey(e: KeyboardEvent) {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    e.stopPropagation();
    stepRecord(e.key === "ArrowDown" ? 1 : -1);
  }
  const findCountText = () => {
    if (!findQuery()) return "";
    const h = findHits();
    if (!h.matches.length) return "no matches";
    const at = findIdx() >= 0 && findIdx() < h.matches.length ? findIdx() + 1 : 1;
    return `${at} of ${h.matches.length}${h.truncated ? "+" : ""}`;
  };
  /** Cell text as painted: booleans keep their word, long values are elided. */
  const shownText = (v: string) => displayText(v).text;

  return (
    <div
      class="rg"
      classList={{ "rg-has-record": recordOpen() }}
      ref={root}
      tabindex={0}
      onKeyDown={onKeyDown}
      style={{ "--rg-rec": recordOpen() ? "clamp(200px, 28%, 360px)" : "0px" }}
    >
      {/* find in loaded rows — a strip above the header, never over it */}
      <Show when={findOpen()}>
        <div class="rg-find" style={{ height: `${FIND_H}px` }}>
          <span class="rg-find-label">Find (loaded rows)</span>
          <input
            ref={(el) => (findInput = el)}
            class="rg-find-input"
            value={findText()}
            placeholder="text to match"
            spellcheck={false}
            onInput={(e) => onFindInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
              else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
            }}
          />
          <span class="rg-find-count">{findCountText()}</span>
          <button class="rg-find-btn" title="Previous match (Shift+Enter)" disabled={!findHits().matches.length} onClick={() => stepFind(-1)}>‹</button>
          <button class="rg-find-btn" title="Next match (Enter)" disabled={!findHits().matches.length} onClick={() => stepFind(1)}>›</button>
          <button class="rg-find-btn" title="Close find (Esc)" onClick={closeFind}>✕</button>
        </div>
      </Show>

      {/* corner: select-all */}
      <div class="rg-corner" style={{ width: `${gutW()}px`, top: `${topOffset()}px`, height: `${headTop()}px` }} onClick={selectAll} title="Select all (⌘/Ctrl+A)" />

      {/* header (+ optional filter row), translated horizontally */}
      <div class="rg-headwrap" style={{ left: `${gutW()}px`, top: `${topOffset()}px`, height: `${headTop()}px` }}>
        <div class="rg-head" style={{ width: `${contentW()}px`, transform: `translateX(${-scrollLeft()}px)` }}>
          <For each={colWindow()}>
            {(k) => {
              const oi = () => displayCols()[k];
              const s = () => sortFor(oi());
              const pinned = () => sticky() && k === 0;
              return (
                <div
                  class="rg-headcell"
                  classList={{ sel: sel().mode === "cols" && isSel(0, k), "dnd-source": dragCol() === oi(), "rg-pinned": pinned() }}
                  style={{
                    left: `${offsets()[k]}px`,
                    width: `${colWidth(oi())}px`,
                    height: `${HEAD_H}px`,
                    ...(pinned() ? { transform: `translateX(${scrollLeft()}px)`, "z-index": "6" } : {}),
                  }}
                  title={props.columns()[oi()]}
                  onPointerDown={(e) => onHeaderDown(e, k, oi())}
                  // Chromium starts a text selection on press and paints it once the
                  // drag crosses selectable content. Cancelling the mousedown (not the
                  // pointerdown) keeps click/dblclick — the resize handle's autofit —
                  // intact; the resize child's own press bubbles here for the same fix.
                  onMouseDown={(e) => { if (e.button === 0) e.preventDefault(); }}
                  onContextMenu={(e) => onHeaderContext(e, oi(), k)}
                >
                  <span class="rg-headname">{props.columns()[oi()]}</span>
                  <Show when={renderOf(oi()).badge}>
                    <span
                      class="rg-type"
                      classList={{ inferred: renderOf(oi()).inferred }}
                      title={renderOf(oi()).inferred ? `${renderOf(oi()).badgeTitle} (guessed from loaded rows)` : renderOf(oi()).badgeTitle}
                    >
                      {renderOf(oi()).badge}
                    </span>
                  </Show>
                  <Show when={s()}>
                    {(sk) => <span class="rg-sort">{sk().dir === "asc" ? "▲" : "▼"}{props.view().sorts.length > 1 ? sortIndex(oi()) + 1 : ""}</span>}
                  </Show>
                  <div class="rg-resize" onPointerDown={(e) => startResize(e, oi())} onDblClick={(e) => (e.stopPropagation(), autofit(oi()))} />
                </div>
              );
            }}
          </For>
          <Show when={props.view().filterRowOpen}>
            <div class="rg-filter" style={{ top: `${HEAD_H}px`, width: `${contentW()}px`, height: `${FILTER_H}px` }}>
              <For each={colWindow()}>
                {(k) => {
                  const oi = () => displayCols()[k];
                  const hidden = () => hiddenRulesFor(oi());
                  const pinned = () => sticky() && k === 0;
                  return (
                    <input
                      class="rg-filter-input"
                      classList={{ "has-rules": hidden() > 0, "rg-pinned": pinned() }}
                      style={{
                        left: `${offsets()[k]}px`,
                        width: `${colWidth(oi()) - 6}px`,
                        ...(pinned() ? { transform: `translateX(${scrollLeft()}px)`, "z-index": "6" } : {}),
                      }}
                      placeholder={hidden() > 0 ? `${hidden()} rule${hidden() === 1 ? "" : "s"}` : "Filter…"}
                      title={hidden() > 0
                        ? `${hidden()} filter rule${hidden() === 1 ? "" : "s"} from the filter builder. Open Edit… to change them.`
                        : undefined}
                      value={filterFor(oi())}
                      disabled={!props.canFilter()}
                      onInput={(e) => onFilterInput(oi(), e.currentTarget.value)}
                    />
                  );
                }}
              </For>
            </div>
          </Show>
          <Show when={reorderTo() != null}>
            {/* translateX (not `left`) so the bar slides between slots; `.dnd-bar`
                carries the look and the 120 ms transition. */}
            <div
              class="rg-reorder dnd-bar"
              style={{ transform: `translateX(${slotOffset(offsets(), reorderTo()!) - 1}px)`, height: `${headTop()}px` }}
            />
          </Show>
        </div>
      </div>

      {/* gutter: row numbers, translated vertically */}
      <div class="rg-gutwrap" style={{ width: `${gutW()}px`, top: `${headTop() + topOffset()}px` }}>
        <div class="rg-gut" style={{ height: `${totalH()}px`, transform: `translateY(${-scrollTop()}px)` }}>
          <For each={range(visRows().start, visRows().end)}>
            {(r) => (
              <div
                class="rg-gutnum"
                classList={{ sel: sel().mode === "rows" && isSel(r, 0), "rg-del": isDeleted(r), "rg-new": isInsRow(r), slim: !props.view().rowNumbers }}
                style={{ top: `${r * rowH()}px`, height: `${rowH()}px` }}
                onMouseDown={(e) => onGutterDown(e, r)}
              >
                {isInsRow(r) ? "+" : props.view().rowNumbers ? displayLoadedAt(r) + 1 : ""}
              </div>
            )}
          </For>
        </div>
      </div>

      {/* body scroller */}
      <div class="rg-scroll" ref={mountScroller} style={{ top: `${headTop() + topOffset()}px`, left: `${gutW()}px` }} onScroll={onScroll}>
        <div class="rg-sizer" style={{ width: `${contentW()}px`, height: `${totalH()}px` }}>
          <For each={range(visRows().start, visRows().end)}>
            {(r) => (
              <div
                class="rg-row"
                classList={{ odd: props.gridStyle().zebra && r % 2 === 1, "rg-del": isDeleted(r), "rg-new": isInsRow(r) }}
                style={{ top: `${r * rowH()}px`, height: `${rowH()}px`, width: `${contentW()}px` }}
              >
                <For each={colWindow()}>
                  {(k) => {
                    const oi = () => displayCols()[k];
                    const val = () => cellVal(r, oi());
                    const cls = () => renderOf(oi()).cls;
                    const pinned = () => sticky() && k === 0;
                    return (
                      <div
                        class="rg-cell"
                        classList={{
                          sel: isSel(r, k),
                          active: isActive(r, k),
                          "rg-dirty": isDirty(r, oi()),
                          "rg-num": cls() === "number",
                          "rg-jsoncell": cls() === "json",
                          "rg-hit": isHit(r, k),
                          "rg-hit-cur": isCurHit(r, k),
                          "rg-pinned": pinned(),
                        }}
                        style={{
                          left: `${offsets()[k]}px`,
                          width: `${colWidth(oi())}px`,
                          ...(pinned() ? { transform: `translateX(${scrollLeft()}px)`, "z-index": "2" } : {}),
                        }}
                        title={cellTitle(val()) || undefined}
                        onMouseDown={(e) => onCellDown(e, r, k)}
                        onDblClick={(e) => {
                          // Editable grids edit on dbl-click; Ctrl/Cmd+dbl-click (or a
                          // non-editable column/row) falls back to View value.
                          if (props.editable() && !(e.ctrlKey || e.metaKey) && props.canEditCol(oi()) && !isDeleted(r)) beginEdit(r, k);
                          else props.onViewValue(props.columns()[oi()], val());
                        }}
                        onContextMenu={(e) => onCellContext(e, r, k, oi(), val())}
                      >
                        {(() => {
                          if (isInsUntouched(r, oi())) return <span class="rg-defaultval" title="Column default" />;
                          const v = val();
                          if (v === null)
                            return <span class="null">{props.gridStyle().nullStyle === "null" ? "NULL" : props.gridStyle().nullStyle === "dash" ? "—" : ""}</span>;
                          const w = props.isBoolCol(oi()) ? boolWord(v) : null;
                          if (w)
                            return (
                              <span class={w === "TRUE" ? "rg-bool rg-true" : "rg-bool rg-false"}>
                                <span class="rg-bool-mark" aria-hidden="true">{w === "TRUE" ? "✓" : "✕"}</span>
                                {w}
                              </span>
                            );
                          // Long values are elided in the DOM, not in the data: copy,
                          // export and the value viewer still see the whole string.
                          return shownText(v);
                        })()}
                      </div>
                    );
                  }}
                </For>
              </div>
            )}
          </For>
          <Show when={editing()}>
            {(ed) => {
              const oi = () => displayCols()[ed().dc];
              const editStyle = () => ({
                top: `${ed().r * rowH()}px`,
                left: `${offsets()[ed().dc]}px`,
                width: `${colWidth(oi())}px`,
                height: `${rowH()}px`,
              });
              const onEditKey = (e: KeyboardEvent) => {
                e.stopPropagation();
                if (e.key === "Enter") { e.preventDefault(); commitEdit("down"); }
                else if (e.key === "Tab") { e.preventDefault(); commitEdit("right"); }
                else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
                else if (e.altKey && e.key.toLowerCase() === "n") { e.preventDefault(); editToNull(); }
              };
              return (
                <Show
                  when={props.boolEdit(oi())}
                  fallback={
                    <input
                      class="rg-edit"
                      ref={(el) => {
                        editInput = el;
                        queueMicrotask(() => { el.focus(); el.select(); });
                      }}
                      style={editStyle()}
                      value={cellVal(ed().r, oi()) ?? ""}
                      onKeyDown={onEditKey}
                      onBlur={() => { if (!editCancelled && editing()) commitEdit(); }}
                      onMouseDown={(e) => e.stopPropagation()}
                    />
                  }
                >
                  {(be) => {
                    const cur = () => {
                      if (isInsUntouched(ed().r, oi())) return DEFAULT_OPT;
                      const v = cellVal(ed().r, oi());
                      return v === null ? NULL_OPT : boolWord(v) ?? "TRUE";
                    };
                    return (
                      <select
                        class="rg-edit rg-edit-bool"
                        ref={(el) => {
                          editSelect = el;
                          queueMicrotask(() => {
                            el.focus();
                            try { el.showPicker?.(); } catch { /* needs user activation; focus is enough */ }
                          });
                        }}
                        style={editStyle()}
                        value={cur()}
                        onChange={() => commitEdit()}
                        onKeyDown={onEditKey}
                        onBlur={() => { if (!editCancelled && editing()) commitEdit(); }}
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        <Show when={isInsUntouched(ed().r, oi())}>
                          <option value={DEFAULT_OPT}>{"<default>"}</option>
                        </Show>
                        <option value="TRUE">TRUE</option>
                        <option value="FALSE">FALSE</option>
                        <Show when={be().nullable}>
                          <option value={NULL_OPT}>{"<null>"}</option>
                        </Show>
                      </select>
                    );
                  }}
                </Show>
              );
            }}
          </Show>
        </div>
      </div>

      {/* record view: the focused row as a name/value list, docked right */}
      <Show when={recordOpen()}>
        <div class="rg-record" style={{ top: `${topOffset()}px` }} onKeyDown={onRecordKey}>
          <div class="rg-rec-head">
            <span class="rg-rec-title">Record</span>
            <Show when={recRow() >= 0}>
              <span class="rg-rec-pos">{isInsRow(recRow()) ? "new row" : `row ${displayLoadedAt(recRow()) + 1}`}</span>
            </Show>
            <span class="rg-rec-spacer" />
            <button class="rg-find-btn" title="Previous row (Alt+↑)" disabled={recRow() <= 0} onClick={() => stepRecord(-1)}>‹</button>
            <button class="rg-find-btn" title="Next row (Alt+↓)" disabled={recRow() < 0 || recRow() >= nRows() - 1} onClick={() => stepRecord(1)}>›</button>
            <button class="rg-find-btn" title="Close record view" onClick={() => { props.setView({ recordOpen: false }); focusGrid(); }}>✕</button>
          </div>
          <Show when={recRow() >= 0} fallback={<div class="rg-rec-empty">Select a cell to see its row.</div>}>
            <div class="rg-rec-body">
              <For each={recFields()}>
                {(oi) => {
                  const r = () => recRow();
                  const val = () => cellVal(r(), oi);
                  const editable = () => props.editable() && props.canEditCol(oi) && !isDeleted(r());
                  const be = () => (editable() ? props.boolEdit(oi) : null);
                  return (
                    <div class="rg-rec-row" classList={{ dirty: isDirty(r(), oi) }}>
                      <div class="rg-rec-name" title={props.columns()[oi]}>
                        <span class="rg-rec-col">{props.columns()[oi]}</span>
                        <Show when={renderOf(oi).badge}>
                          <span class="rg-type" classList={{ inferred: renderOf(oi).inferred }}>{renderOf(oi).badge}</span>
                        </Show>
                      </div>
                      <Show
                        when={editable()}
                        fallback={
                          <div class="rg-rec-val" classList={{ "rg-num": renderOf(oi).cls === "number" }}>
                            <Show when={val() !== null} fallback={<span class="null">NULL</span>}>{shownText(val() ?? "")}</Show>
                          </div>
                        }
                      >
                        <Show
                          when={be()}
                          fallback={
                            <input
                              class="rg-rec-input"
                              value={val() ?? ""}
                              placeholder={val() === null ? "NULL" : ""}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === "Enter") e.currentTarget.blur();
                                else if (e.key === "Escape") { e.currentTarget.value = val() ?? ""; e.currentTarget.blur(); }
                              }}
                              onChange={(e) => applyTextValue(r(), oi, val(), e.currentTarget.value)}
                            />
                          }
                        >
                          {(b) => (
                            <select
                              class="rg-rec-input"
                              value={isInsUntouched(r(), oi) ? DEFAULT_OPT : val() === null ? NULL_OPT : boolWord(val()!) ?? "TRUE"}
                              onKeyDown={(e) => e.stopPropagation()}
                              onChange={(e) => applyBoolChoice(r(), oi, e.currentTarget.value)}
                            >
                              <Show when={isInsUntouched(r(), oi)}>
                                <option value={DEFAULT_OPT}>{"<default>"}</option>
                              </Show>
                              <option value="TRUE">TRUE</option>
                              <option value="FALSE">FALSE</option>
                              <Show when={b().nullable}>
                                <option value={NULL_OPT}>{"<null>"}</option>
                              </Show>
                            </select>
                          )}
                        </Show>
                      </Show>
                    </div>
                  );
                }}
              </For>
              <Show when={displayCols().length > MAX_RECORD_FIELDS}>
                <div class="rg-rec-empty">
                  First {MAX_RECORD_FIELDS} of {displayCols().length.toLocaleString()} columns.
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
