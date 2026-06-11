import { createSignal, createMemo, createEffect, on, For, Show, type Accessor } from "solid-js";
import { type Dataset, toTSV, toCSV, toJSON, toMarkdown } from "./formats";
import { clipWrite } from "./clipboard";
import { type MenuItem } from "./ContextMenu";
import { type GridView, type SortKey, type Filter, type PendingEdits } from "./tabs";

// Hand-rolled, two-axis-virtualized, read-only result grid. Uses a synchronized-pane
// layout (header + gutter are transform-translated siblings of the body scroller, NOT
// position:sticky) for reliable frozen header/gutter in WKWebView. Selection, keyboard
// nav, multi-format copy, resize/autofit/reorder/hide, and server sort/filter affordances.

const HEAD_H = 30;
const FILTER_H = 30;
const GUTTER_W = 56;
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
  onLoadMore: () => void;
  onSortFilter: (sorts: SortKey[], filters: Filter[]) => void;
  onMenu: (x: number, y: number, items: MenuItem[]) => void;
  onViewValue: (col: string, val: string | null) => void;
  onStatus: (text: string) => void;
  canSortFilter: Accessor<boolean>;
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
  onEditCell: (row: number, origCol: number, val: string | null | undefined) => void;
  /** Toggle delete-marks on the given virtual row indices (insert rows are removed). */
  onMarkDelete: (rows: number[]) => void;
  onAddRow: () => void;
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

  const headTop = () => HEAD_H + (props.view().filterRowOpen ? FILTER_H : 0);
  const rowH = () => props.gridStyle().rowH;

  // --- display-column mapping (recomputes only on order/hidden change) ---
  const displayCols = createMemo(() => {
    const hidden = new Set(props.view().hidden);
    const order = props.view().order;
    return order.filter((oi) => !hidden.has(oi));
  });
  const colWidth = (oi: number) => props.view().widths[oi] ?? props.gridStyle().defaultColW;
  const offsets = createMemo(() => {
    const dc = displayCols();
    const out = new Array(dc.length + 1);
    out[0] = 0;
    for (let k = 0; k < dc.length; k++) out[k + 1] = out[k] + colWidth(dc[k]);
    return out;
  });
  const contentW = () => offsets()[offsets().length - 1] || 0;

  // --- pending-edits overlay (virtual rows = loaded rows + insert rows) ---
  const nLoaded = () => props.rows().length;
  const nIns = () => props.pending()?.inserts.length ?? 0;
  const nRows = createMemo(() => nLoaded() + nIns());
  const delSet = createMemo(() => new Set(props.pending()?.deletes ?? []));
  const insRec = (r: number) => props.pending()?.inserts[r - nLoaded()];
  /** Displayed value: pending edit > snapshot; insert rows read their sparse record. */
  const cellVal = (r: number, oi: number): string | null => {
    if (r >= nLoaded()) return insRec(r)?.[oi] ?? null;
    const e = props.pending()?.cells[r]?.[oi];
    return e !== undefined ? e : props.rows()[r]?.[oi] ?? null;
  };
  const isDirty = (r: number, oi: number) => r < nLoaded() && props.pending()?.cells[r]?.[oi] !== undefined;
  const isInsUntouched = (r: number, oi: number) => r >= nLoaded() && insRec(r)?.[oi] === undefined;

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

  // --- scroll handling (rAF-coalesced) ---
  // Scroll updates ONLY the local signals (which only the grid's row/col window memos
  // depend on) + a non-reactive per-tab memory. It must NOT write to the tab's gridView:
  // that would rebuild the tabs array and invalidate `activeTab` across the whole App on
  // every scroll frame (the cause of the large-table jank/crash).
  const scrollMem = new Map<string, { top: number; left: number }>();
  let rafPending = false;
  function onScroll() {
    if (!scroller || rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
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
    requestAnimationFrame(measure);
    new ResizeObserver(measure).observe(el);
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
  const resultKey = createMemo(() => `${props.activeTabId()}:${props.epoch()}`);
  createEffect(
    on(resultKey, (key, prev) => {
      setSel(EMPTY_SEL);
      setEditing(null);
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
    if (dc < o.length - 1) {
      if (o[dc] < sc.scrollLeft) sc.scrollLeft = o[dc];
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

  // --- inline cell editing ---
  const [editing, setEditing] = createSignal<{ r: number; dc: number } | null>(null);
  let editInput: HTMLInputElement | undefined;
  let editOrig: string | null = null; // displayed value when the editor opened
  let editCancelled = false;
  function beginEdit(r: number, dc: number) {
    if (!props.editable() || delSet().has(r)) return;
    const oi = displayCols()[dc];
    if (oi === undefined || !props.canEditCol(oi)) return;
    editOrig = cellVal(r, oi);
    editCancelled = false;
    setSel({ mode: "cell", ar: r, ac: dc, fr: r, fc: dc });
    setEditing({ r, dc });
    scrollCellIntoView(r, dc);
  }
  function commitEdit(move?: "down" | "right") {
    const ed = editing();
    if (!ed || !editInput) return;
    const v = editInput.value;
    setEditing(null);
    // Typing nothing over a NULL is not an edit (don't turn NULL into '').
    if (!(editOrig === null && v === "")) props.onEditCell(ed.r, displayCols()[ed.dc], v);
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
    props.onEditCell(ed.r, displayCols()[ed.dc], null);
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
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const nr = nRows(),
      nc = displayCols().length;
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
      case "Escape": setSel({ mode: "cell", ar: fr, ac: fc, fr, fc }); break;
      case "a": if (mod) { selectAll(); e.preventDefault(); } break;
      case "c": if (mod) { void copySelection("tsv"); e.preventDefault(); } break;
      case "Enter":
      case "F2":
        if (props.editable() && s.mode !== "none") { beginEdit(fr, fc); e.preventDefault(); }
        break;
      case "Delete":
      case "Backspace":
        // Row-selection only — a stray Delete on a cell selection must not mark rows.
        if (props.editable() && s.mode === "rows") { props.onMarkDelete(selectedRowIndices()); e.preventDefault(); }
        break;
    }
  }

  // --- copy ---
  function selectionDataset(): Dataset {
    const dc = displayCols();
    const names = props.columns();
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
    // Read through the pending overlay so copy matches what's displayed
    // (edited cells, insert rows).
    const rows: (string | null)[][] = [];
    for (let r = r0; r <= r1; r++) rows.push(cols.map((oi) => cellVal(r, oi)));
    return { columns: cols.map((oi) => names[oi]), rows };
  }
  async function copySelection(fmt: "tsv" | "csv" | "json" | "md") {
    const d = selectionDataset();
    const h = props.copyHeaders();
    const cells = d.rows.length * d.columns.length;
    if (cells > 5_000_000) props.onStatus(`copying ${cells.toLocaleString()} cells…`);
    const text = fmt === "csv" ? toCSV(d, h) : fmt === "json" ? toJSON(d, h) : fmt === "md" ? toMarkdown(d, h) : toTSV(d, h);
    const ok = await clipWrite(text);
    props.onStatus(ok ? `copied ${d.rows.length}×${d.columns.length}` : "clipboard unavailable");
  }
  async function copyText(t: string, msg: string) {
    const ok = await clipWrite(t);
    props.onStatus(ok ? msg : "clipboard unavailable");
  }
  const columnDataset = (oi: number): Dataset => ({
    columns: [props.columns()[oi]],
    rows: Array.from({ length: nRows() }, (_, r) => [cellVal(r, oi)]),
  });

  // --- context menus ---
  function onCellContext(e: MouseEvent, r: number, dc: number, oi: number, val: string | null) {
    e.preventDefault();
    e.stopPropagation();
    if (!isSel(r, dc)) setSel({ mode: "cell", ar: r, ac: dc, fr: r, fc: dc });
    const name = props.columns()[oi];
    const editItems: MenuItem[] = [];
    if (props.editable()) {
      const selRows = selectedRowIndices(r);
      const allDel = selRows.length > 0 && selRows.every((x) => delSet().has(x));
      const colOk = props.canEditCol(oi) && !delSet().has(r);
      editItems.push(
        { label: "Edit cell", icon: "edit", disabled: !colOk, title: colOk ? undefined : "column doesn't belong to the table", onClick: () => beginEdit(r, dc) },
        { label: "Set NULL", icon: "slash", disabled: !colOk, onClick: () => props.onEditCell(r, oi, null) },
      );
      if (isDirty(r, oi)) editItems.push({ label: "Revert cell", icon: "eraser", onClick: () => props.onEditCell(r, oi, undefined) });
      editItems.push(
        { label: allDel ? `Undelete row${selRows.length > 1 ? "s" : ""}` : `Delete row${selRows.length > 1 ? "s" : ""}`, icon: "trash", danger: !allDel, onClick: () => props.onMarkDelete(selRows) },
        { label: "Insert row", icon: "plus", onClick: () => props.onAddRow() },
        { sep: true },
      );
    } else if (props.editReason()) {
      editItems.push({ label: "Edit cell", icon: "edit", disabled: true, title: props.editReason(), onClick: () => {} }, { sep: true });
    }
    props.onMenu(e.clientX, e.clientY, [
      ...editItems,
      { label: "Copy", icon: "copy", onClick: () => void copySelection("tsv") },
      { label: "Copy as CSV", icon: "copy", onClick: () => void copySelection("csv") },
      { label: "Copy as JSON", icon: "copy", onClick: () => void copySelection("json") },
      { label: "Copy as Markdown", icon: "copy", onClick: () => void copySelection("md") },
      { sep: true },
      { label: val === null ? "Copy value (NULL→empty)" : "Copy cell value", icon: "copy", onClick: () => void copyText(val ?? "", "copied value") },
      { label: "Copy column", icon: "copy", onClick: () => void copyText(toTSV(columnDataset(oi), props.copyHeaders()), "copied column") },
      { label: "View value…", icon: "search", onClick: () => props.onViewValue(name, val) },
    ]);
  }
  function onHeaderContext(e: MouseEvent, oi: number, dc: number) {
    e.preventDefault();
    e.stopPropagation();
    const items: MenuItem[] = [];
    if (props.canSortFilter()) {
      items.push(
        { label: "Sort ascending", icon: "sortAsc", onClick: () => setSort(oi, "asc") },
        { label: "Sort descending", icon: "sortDesc", onClick: () => setSort(oi, "desc") },
        { label: "Clear sort", icon: "close", onClick: () => clearSort(oi) },
        { label: props.view().filterRowOpen ? "Hide filter row" : "Filter…", icon: "search", onClick: () => props.setView({ filterRowOpen: !props.view().filterRowOpen }) },
        { sep: true },
      );
    }
    items.push(
      { label: "Autofit column", icon: "resize", onClick: () => autofit(oi) },
      { label: "Hide column", icon: "eyeOff", onClick: () => hideCol(oi) },
    );
    const hidden = props.view().hidden;
    if (hidden.length) {
      items.push({ sep: true });
      for (const h of hidden) items.push({ label: `Show "${props.columns()[h]}"`, icon: "eye", onClick: () => showCol(h) });
      items.push({ label: "Show all columns", icon: "eye", onClick: () => props.setView({ hidden: [] }) });
    }
    items.push({ sep: true }, { label: "Copy column", icon: "copy", onClick: () => void copyText(toTSV(columnDataset(oi), props.copyHeaders()), "copied column") });
    void dc;
    props.onMenu(e.clientX, e.clientY, items);
  }

  // --- sort / filter ---
  function setSort(oi: number, dir: "asc" | "desc") {
    const next: SortKey[] = [{ col: oi, dir }];
    props.setView({ sorts: next });
    props.onSortFilter(next, props.view().filters);
  }
  function clearSort(oi: number) {
    const next = props.view().sorts.filter((s) => s.col !== oi);
    props.setView({ sorts: next });
    props.onSortFilter(next, props.view().filters);
  }
  function cycleSort(oi: number, additive: boolean) {
    if (!props.canSortFilter()) return;
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
    props.setView({ sorts: next });
    props.onSortFilter(next, props.view().filters);
  }
  const sortFor = (oi: number) => props.view().sorts.find((s) => s.col === oi);
  const sortIndex = (oi: number) => props.view().sorts.findIndex((s) => s.col === oi);

  let filterTimer: ReturnType<typeof setTimeout> | undefined;
  function onFilterInput(oi: number, text: string) {
    const filters = props.view().filters.filter((f) => f.col !== oi);
    if (text.trim() !== "") filters.push({ col: oi, text });
    props.setView({ filters });
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => props.onSortFilter(props.view().sorts, filters), 300);
  }
  const filterFor = (oi: number) => props.view().filters.find((f) => f.col === oi)?.text ?? "";

  // --- resize / autofit / reorder / hide ---
  function startResize(e: MouseEvent, oi: number) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX,
      startW = colWidth(oi);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const mv = (ev: MouseEvent) =>
      props.setView({ widths: { ...props.view().widths, [oi]: Math.max(MIN_COL_W, Math.min(MAX_COL_W, startW + ev.clientX - startX)) } });
    const up = () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", mv);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
  }
  let measureCtx: CanvasRenderingContext2D | null = null;
  function autofit(oi: number) {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    if (!measureCtx) return;
    measureCtx.font = props.gridStyle().font;
    let max = measureCtx.measureText(props.columns()[oi]).width + 34;
    const R = props.rows();
    const { start, end } = visRows();
    for (let r = start; r < end; r++) {
      const v = R[r]?.[oi];
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
  function insertionIndex(x: number): number {
    const o = offsets();
    for (let k = 0; k < o.length - 1; k++) if (x < (o[k] + o[k + 1]) / 2) return k;
    return o.length - 1;
  }

  // header label mousedown: distinguish click (sort + select) vs drag (reorder)
  let headerDown: { dc: number; oi: number; x: number; shift: boolean; moved: boolean } | null = null;
  function onHeaderDown(e: MouseEvent, dc: number, oi: number) {
    if (e.button !== 0) return;
    focusGrid();
    headerDown = { dc, oi, x: e.clientX, shift: e.shiftKey, moved: false };
    window.addEventListener("mousemove", onHeaderMove);
    window.addEventListener("mouseup", onHeaderUp);
  }
  function onHeaderMove(e: MouseEvent) {
    if (!headerDown) return;
    if (!headerDown.moved && Math.abs(e.clientX - headerDown.x) > 4) {
      headerDown.moved = true;
      document.body.style.userSelect = "none";
    }
    if (headerDown.moved) {
      const b = scroller!.getBoundingClientRect();
      setReorderTo(insertionIndex(e.clientX - b.left + scroller!.scrollLeft));
    }
  }
  function onHeaderUp() {
    if (!headerDown) return;
    if (headerDown.moved) {
      const to = reorderTo();
      if (to != null) moveColumn(headerDown.dc, to);
    } else {
      const nr = nRows();
      setSel({ mode: "cols", ar: 0, ac: headerDown.dc, fr: nr - 1, fc: headerDown.dc });
      cycleSort(headerDown.oi, headerDown.shift);
    }
    setReorderTo(null);
    document.body.style.userSelect = "";
    headerDown = null;
    window.removeEventListener("mousemove", onHeaderMove);
    window.removeEventListener("mouseup", onHeaderUp);
  }

  return (
    <div class="rg" ref={root} tabindex={0} onKeyDown={onKeyDown}>
      {/* corner: select-all */}
      <div class="rg-corner" style={{ width: `${GUTTER_W}px`, height: `${headTop()}px` }} onClick={selectAll} title="Select all (⌘/Ctrl+A)" />

      {/* header (+ optional filter row), translated horizontally */}
      <div class="rg-headwrap" style={{ left: `${GUTTER_W}px`, height: `${headTop()}px` }}>
        <div class="rg-head" style={{ width: `${contentW()}px`, transform: `translateX(${-scrollLeft()}px)` }}>
          <For each={range(visCols().start, visCols().end)}>
            {(k) => {
              const oi = () => displayCols()[k];
              const s = () => sortFor(oi());
              return (
                <div
                  class="rg-headcell"
                  classList={{ sel: sel().mode === "cols" && isSel(0, k) }}
                  style={{ left: `${offsets()[k]}px`, width: `${colWidth(oi())}px`, height: `${HEAD_H}px` }}
                  title={props.columns()[oi()]}
                  onMouseDown={(e) => onHeaderDown(e, k, oi())}
                  onContextMenu={(e) => onHeaderContext(e, oi(), k)}
                >
                  <span class="rg-headname">{props.columns()[oi()]}</span>
                  <Show when={s()}>
                    {(sk) => <span class="rg-sort">{sk().dir === "asc" ? "▲" : "▼"}{props.view().sorts.length > 1 ? sortIndex(oi()) + 1 : ""}</span>}
                  </Show>
                  <div class="rg-resize" onMouseDown={(e) => startResize(e, oi())} onDblClick={(e) => (e.stopPropagation(), autofit(oi()))} />
                </div>
              );
            }}
          </For>
          <Show when={props.view().filterRowOpen}>
            <div class="rg-filter" style={{ top: `${HEAD_H}px`, width: `${contentW()}px`, height: `${FILTER_H}px` }}>
              <For each={range(visCols().start, visCols().end)}>
                {(k) => {
                  const oi = () => displayCols()[k];
                  return (
                    <input
                      class="rg-filter-input"
                      style={{ left: `${offsets()[k]}px`, width: `${colWidth(oi()) - 6}px` }}
                      placeholder="filter…"
                      value={filterFor(oi())}
                      onInput={(e) => onFilterInput(oi(), e.currentTarget.value)}
                    />
                  );
                }}
              </For>
            </div>
          </Show>
          <Show when={reorderTo() != null}>
            <div class="rg-reorder" style={{ left: `${offsets()[reorderTo()!] ?? contentW()}px`, height: `${headTop()}px` }} />
          </Show>
        </div>
      </div>

      {/* gutter: row numbers, translated vertically */}
      <div class="rg-gutwrap" style={{ width: `${GUTTER_W}px`, top: `${headTop()}px` }}>
        <div class="rg-gut" style={{ height: `${totalH()}px`, transform: `translateY(${-scrollTop()}px)` }}>
          <For each={range(visRows().start, visRows().end)}>
            {(r) => (
              <div
                class="rg-gutnum"
                classList={{ sel: sel().mode === "rows" && isSel(r, 0), "rg-del": delSet().has(r), "rg-new": r >= nLoaded() }}
                style={{ top: `${r * rowH()}px`, height: `${rowH()}px` }}
                onMouseDown={(e) => onGutterDown(e, r)}
              >
                {r >= nLoaded() ? "+" : r + 1}
              </div>
            )}
          </For>
        </div>
      </div>

      {/* body scroller */}
      <div class="rg-scroll" ref={mountScroller} style={{ top: `${headTop()}px`, left: `${GUTTER_W}px` }} onScroll={onScroll}>
        <div class="rg-sizer" style={{ width: `${contentW()}px`, height: `${totalH()}px` }}>
          <For each={range(visRows().start, visRows().end)}>
            {(r) => (
              <div
                class="rg-row"
                classList={{ odd: props.gridStyle().zebra && r % 2 === 1, "rg-del": delSet().has(r), "rg-new": r >= nLoaded() }}
                style={{ top: `${r * rowH()}px`, height: `${rowH()}px`, width: `${contentW()}px` }}
              >
                <For each={range(visCols().start, visCols().end)}>
                  {(k) => {
                    const oi = () => displayCols()[k];
                    const val = () => cellVal(r, oi());
                    return (
                      <div
                        class="rg-cell"
                        classList={{ sel: isSel(r, k), active: isActive(r, k), "rg-dirty": isDirty(r, oi()) }}
                        style={{ left: `${offsets()[k]}px`, width: `${colWidth(oi())}px` }}
                        onMouseDown={(e) => onCellDown(e, r, k)}
                        onDblClick={(e) => {
                          // Editable grids edit on dbl-click; Ctrl/Cmd+dbl-click (or a
                          // non-editable column/row) falls back to View value.
                          if (props.editable() && !(e.ctrlKey || e.metaKey) && props.canEditCol(oi()) && !delSet().has(r)) beginEdit(r, k);
                          else props.onViewValue(props.columns()[oi()], val());
                        }}
                        onContextMenu={(e) => onCellContext(e, r, k, oi(), val())}
                      >
                        {isInsUntouched(r, oi())
                          ? <span class="rg-defaultval" title="column default" />
                          : val() === null
                            ? <span class="null">{props.gridStyle().nullStyle === "null" ? "NULL" : props.gridStyle().nullStyle === "dash" ? "—" : ""}</span>
                            : val()}
                      </div>
                    );
                  }}
                </For>
              </div>
            )}
          </For>
          <Show when={editing()}>
            {(ed) => (
              <input
                class="rg-edit"
                ref={(el) => {
                  editInput = el;
                  queueMicrotask(() => { el.focus(); el.select(); });
                }}
                style={{
                  top: `${ed().r * rowH()}px`,
                  left: `${offsets()[ed().dc]}px`,
                  width: `${colWidth(displayCols()[ed().dc])}px`,
                  height: `${rowH()}px`,
                }}
                value={cellVal(ed().r, displayCols()[ed().dc]) ?? ""}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") { e.preventDefault(); commitEdit("down"); }
                  else if (e.key === "Tab") { e.preventDefault(); commitEdit("right"); }
                  else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
                  else if (e.altKey && e.key.toLowerCase() === "n") { e.preventDefault(); editToNull(); }
                }}
                onBlur={() => { if (!editCancelled && editing()) commitEdit(); }}
                onMouseDown={(e) => e.stopPropagation()}
              />
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}
