// Selection summary for the status bar. Pure + vitest-covered.
//
// Aggregates are computed over LOADED rows only — the same rows the grid can
// show — so they answer "what is in front of me", not "what is in the table".
// A numeric summary appears only when every non-NULL value in the selection is
// a numeric literal; one stray value makes the whole selection non-numeric,
// matching how local sort decides a column is numeric.

export type NumericSummary = {
  count: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
};

export type SelectionSummary = {
  rows: number;
  cols: number;
  cells: number;
  /** NULL cells in the selection (reported alongside a numeric summary). */
  nulls: number;
  numeric: NumericSummary | null;
  /** The scan hit its ceiling; no aggregate is offered. */
  truncated: boolean;
};

/** Ceiling on cells scanned for one summary (matches the grid's copy ceiling). */
export const SUMMARY_MAX_CELLS = 1_000_000;

const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Numeric value of a driver text cell, or null when it is not a plain number. */
export function numericValue(v: string): number | null {
  if (!NUMERIC_RE.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Summarize a rectangular selection. `cell` reads the DISPLAYED value (pending
 * edits included), so the numbers match what the user is looking at.
 */
export function summarizeSelection(
  rows: number,
  cols: number,
  cell: (r: number, c: number) => string | null,
  maxCells = SUMMARY_MAX_CELLS,
): SelectionSummary {
  if (rows <= 0 || cols <= 0) return { rows: Math.max(0, rows), cols: Math.max(0, cols), cells: 0, nulls: 0, numeric: null, truncated: false };
  function* values() {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) yield cell(r, c);
  }
  return summarizeValues({ rows, cols, cells: rows * cols }, values(), maxCells);
}

/**
 * Summarize any set of cells — a multi-area selection is not a rectangle, so the
 * grid hands over its distinct rows, distinct columns, distinct cell count and
 * the displayed values in reading order. Above `maxCells` nothing is read.
 */
export function summarizeValues(
  shape: { rows: number; cols: number; cells: number },
  values: Iterable<string | null>,
  maxCells = SUMMARY_MAX_CELLS,
): SelectionSummary {
  const { rows, cols, cells } = shape;
  const base = { rows, cols, cells, nulls: 0, numeric: null, truncated: false };
  if (cells <= 0) return { ...base, cells: 0 };
  if (cells > maxCells) return { ...base, truncated: true };
  let count = 0;
  let nulls = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let numeric = true;
  for (const v of values) {
    if (v === null) {
      nulls++;
      continue;
    }
    if (!numeric) continue;
    const n = numericValue(v);
    if (n === null) {
      numeric = false;
      continue;
    }
    count++;
    sum += n;
    if (n < min) min = n;
    if (n > max) max = n;
  }
  return {
    rows,
    cols,
    cells,
    nulls,
    numeric: numeric && count > 0 ? { count, sum, avg: sum / count, min, max } : null,
    truncated: false,
  };
}

/**
 * Compact fixed-locale number for the status bar. Fixed to en-US so a summary
 * reads the same everywhere the app runs and stays testable.
 */
export function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-4)) return n.toExponential(4);
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
