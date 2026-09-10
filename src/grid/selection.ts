// Multi-area grid selection. Pure + vitest-covered.
//
// The grid keeps one LIVE rectangle (anchor + focus, extended by drag or Shift)
// plus the rectangles committed with Ctrl/Cmd. Every consumer of "what is
// selected" - painting, copy, export, the status-bar summary, paste into the
// selection, delete marks - reads the union through `selectionRuns`, which folds
// the rectangles into row runs with merged column intervals. Overlapping areas
// are therefore never counted, copied or written twice, and a rectangle that
// hangs past the loaded rows or the visible columns is clamped, never an error.
//
// Coordinates are DISPLAY coordinates: virtual row index (insert rows first) and
// display column index. The grid maps them to row identities and original
// column indices itself.

export type SelKind = "cells" | "rows" | "cols";

/** Inclusive rectangle. `rows` spans every column, `cols` every row; those axes are ignored. */
export type SelRect = { kind: SelKind; r0: number; r1: number; c0: number; c1: number };

/** Inclusive column interval. */
export type ColSpan = [number, number];

/** Rows r0..r1 (inclusive) that share exactly the same covered columns. */
export type SelRun = { r0: number; r1: number; cols: ColSpan[] };

/** Ceiling on committed rectangles; Ctrl-clicking past it replaces the oldest. */
export const MAX_SEL_RECTS = 1000;

export function makeRect(kind: SelKind, ar: number, ac: number, fr: number, fc: number): SelRect {
  return { kind, r0: Math.min(ar, fr), r1: Math.max(ar, fr), c0: Math.min(ac, fc), c1: Math.max(ac, fc) };
}

export function rectHas(x: SelRect, r: number, c: number): boolean {
  if (x.kind === "rows") return r >= x.r0 && r <= x.r1;
  if (x.kind === "cols") return c >= x.c0 && c <= x.c1;
  return r >= x.r0 && r <= x.r1 && c >= x.c0 && c <= x.c1;
}

export function anyHas(rects: readonly SelRect[], r: number, c: number): boolean {
  for (const x of rects) if (rectHas(x, r, c)) return true;
  return false;
}

/** Row interval a rectangle covers in an `nRows`-tall grid, or null when it lies outside. */
function rowSpan(x: SelRect, nRows: number): [number, number] | null {
  const r0 = x.kind === "cols" ? 0 : Math.max(0, x.r0);
  const r1 = x.kind === "cols" ? nRows - 1 : Math.min(nRows - 1, x.r1);
  return r0 <= r1 ? [r0, r1] : null;
}

function colSpan(x: SelRect, nCols: number): ColSpan | null {
  const c0 = x.kind === "rows" ? 0 : Math.max(0, x.c0);
  const c1 = x.kind === "rows" ? nCols - 1 : Math.min(nCols - 1, x.c1);
  return c0 <= c1 ? [c0, c1] : null;
}

/** Sorted, non-overlapping, adjacent intervals merged. Sorts its input in place. */
export function mergeSpans(spans: ColSpan[]): ColSpan[] {
  spans.sort((a, b) => a[0] - b[0]);
  const out: ColSpan[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

function sameSpans(a: readonly ColSpan[], b: readonly ColSpan[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  return true;
}

export const spanWidth = (spans: readonly ColSpan[]): number => spans.reduce((n, s) => n + s[1] - s[0] + 1, 0);

/**
 * Fold rectangles into row runs. Rows are cut at every rectangle edge, so within
 * one segment each rectangle either covers every row or none; the segment's
 * columns are the merged intervals of the rectangles covering it, and adjacent
 * segments with identical columns fuse back into one run. Runs come out in row
 * order and never overlap.
 */
export function selectionRuns(rects: readonly SelRect[], nRows: number, nCols: number): SelRun[] {
  if (nRows <= 0 || nCols <= 0 || !rects.length) return [];
  const items: { rows: [number, number]; cols: ColSpan }[] = [];
  for (const x of rects) {
    const rs = rowSpan(x, nRows);
    const cs = colSpan(x, nCols);
    if (rs && cs) items.push({ rows: rs, cols: cs });
  }
  if (!items.length) return [];
  const cuts = new Set<number>();
  for (const it of items) {
    cuts.add(it.rows[0]);
    cuts.add(it.rows[1] + 1);
  }
  const bounds = [...cuts].sort((a, b) => a - b);
  const runs: SelRun[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const r0 = bounds[i];
    const r1 = bounds[i + 1] - 1;
    const spans: ColSpan[] = [];
    for (const it of items) if (it.rows[0] <= r0 && it.rows[1] >= r1) spans.push([it.cols[0], it.cols[1]]);
    if (!spans.length) continue;
    const cols = mergeSpans(spans);
    const last = runs[runs.length - 1];
    if (last && last.r1 + 1 === r0 && sameSpans(last.cols, cols)) last.r1 = r1;
    else runs.push({ r0, r1, cols });
  }
  return runs;
}

/** Distinct rows covered. */
export function runRowCount(runs: readonly SelRun[]): number {
  return runs.reduce((n, run) => n + run.r1 - run.r0 + 1, 0);
}

/** Distinct cells covered. */
export function runCellCount(runs: readonly SelRun[]): number {
  return runs.reduce((n, run) => n + (run.r1 - run.r0 + 1) * spanWidth(run.cols), 0);
}

/** Union of the columns covered by any row, as merged intervals. */
export function runColSpans(runs: readonly SelRun[]): ColSpan[] {
  const all: ColSpan[] = [];
  for (const run of runs) for (const s of run.cols) all.push([s[0], s[1]]);
  return mergeSpans(all);
}

/**
 * The columns of the selection when it is a full product of its rows and its
 * columns - one rectangle, or areas that share the same rows or the same
 * columns (the rule every spreadsheet applies to copying a multi-area
 * selection). Null for an L-shape or a cross, which no rectangular clipboard
 * can hold without inventing cells.
 */
export function productCols(runs: readonly SelRun[]): ColSpan[] | null {
  if (!runs.length) return null;
  const first = runs[0].cols;
  for (let i = 1; i < runs.length; i++) if (!sameSpans(runs[i].cols, first)) return null;
  return first.map((s) => [s[0], s[1]]);
}

export function expandSpans(spans: readonly ColSpan[]): number[] {
  const out: number[] = [];
  for (const s of spans) for (let c = s[0]; c <= s[1]; c++) out.push(c);
  return out;
}

export function forEachRow(runs: readonly SelRun[], fn: (r: number) => void): void {
  for (const run of runs) for (let r = run.r0; r <= run.r1; r++) fn(r);
}

/** Row-major, columns ascending within a row - the order a clipboard block reads in. */
export function forEachCell(runs: readonly SelRun[], fn: (r: number, c: number) => void): void {
  for (const run of runs) for (let r = run.r0; r <= run.r1; r++) for (const s of run.cols) for (let c = s[0]; c <= s[1]; c++) fn(r, c);
}

/**
 * Remove `cut` from every rectangle (Ctrl-click on a selected cell, row or
 * column deselects it). Each touched rectangle splits into at most four pieces:
 * the bands above and below keep the kind of a `rows` rectangle, the bands left
 * and right keep the kind of a `cols` rectangle, everything else becomes plain
 * cells. Rectangles lying entirely outside the grid are dropped.
 */
export function subtractRect(rects: readonly SelRect[], cut: SelRect, nRows: number, nCols: number): SelRect[] {
  const out: SelRect[] = [];
  const cutR = rowSpan(cut, nRows);
  const cutC = colSpan(cut, nCols);
  if (!cutR || !cutC) return rects.slice();
  for (const x of rects) {
    const rs = rowSpan(x, nRows);
    const cs = colSpan(x, nCols);
    if (!rs || !cs) continue;
    if (rs[1] < cutR[0] || rs[0] > cutR[1] || cs[1] < cutC[0] || cs[0] > cutC[1]) {
      out.push(x);
      continue;
    }
    const piece = (kind: SelKind, r0: number, r1: number, c0: number, c1: number) => {
      if (r0 <= r1 && c0 <= c1) out.push({ kind, r0, r1, c0, c1 });
    };
    const bandKind: SelKind = x.kind === "rows" ? "rows" : "cells";
    const sideKind: SelKind = x.kind === "cols" ? "cols" : "cells";
    piece(bandKind, rs[0], cutR[0] - 1, cs[0], cs[1]);
    piece(bandKind, cutR[1] + 1, rs[1], cs[0], cs[1]);
    const m0 = Math.max(rs[0], cutR[0]);
    const m1 = Math.min(rs[1], cutR[1]);
    piece(sideKind, m0, m1, cs[0], cutC[0] - 1);
    piece(sideKind, m0, m1, cutC[1] + 1, cs[1]);
  }
  return out;
}

/** True when every rectangle is a whole-row selection (delete marks act on rows only). */
export function allRows(rects: readonly SelRect[]): boolean {
  return rects.length > 0 && rects.every((x) => x.kind === "rows");
}
