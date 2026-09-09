// Initial result-column widths, sampled from what is actually in the column.
// Pure + vitest-covered: the caller passes the text measurer, so this module has
// no DOM dependency and the same numbers can be asserted in tests.
//
// A fixed width for every column made a timestamp column a truncated lie on the
// default view of any table while narrow columns left the grid half empty. The
// sample is bounded on both axes — rows read and pixels produced — so a wide
// result can never turn the first paint into a layout stall.

/** Rows read per column when sizing. Later rows can still be autofit by hand. */
export const WIDTH_SAMPLE_ROWS = 60;
/** Longest value considered; anything past this measures as this many characters. */
export const WIDTH_SAMPLE_CHARS = 120;
/** Narrowest and widest a SAMPLED column may come out. Manual resize is unbounded by this. */
export const AUTO_MIN_W = 64;
export const AUTO_MAX_W = 360;
/** Slack around the header text: sort glyph, type badge, padding. */
export const HEAD_PAD = 46;
/** Slack around a cell value: cell padding plus the right border. */
export const CELL_PAD = 20;

export type SampleOptions = {
  sampleRows?: number;
  min?: number;
  max?: number;
  /** Used when a column has no measurable content at all. */
  fallback?: number;
};

/**
 * One width per column, in CSS pixels.
 *
 * `measure` returns the rendered width of a string in the grid's cell font. The
 * header is measured with the same function; headers and cells only differ in
 * how much slack they get.
 */
export function sampleColumnWidths(
  columns: readonly string[],
  rows: readonly (readonly (string | null)[])[],
  measure: (text: string) => number,
  opts: SampleOptions = {},
): number[] {
  const sampleRows = Math.max(0, opts.sampleRows ?? WIDTH_SAMPLE_ROWS);
  const min = opts.min ?? AUTO_MIN_W;
  const max = Math.max(min, opts.max ?? AUTO_MAX_W);
  const n = Math.min(rows.length, sampleRows);
  return columns.map((name, c) => {
    let w = measure(clip(name)) + HEAD_PAD;
    let seen = false;
    for (let r = 0; r < n; r++) {
      const v = rows[r]?.[c];
      if (v === null || v === undefined) continue;
      seen = true;
      const cell = measure(clip(v)) + CELL_PAD;
      if (cell > w) w = cell;
      if (w >= max) return max;
    }
    if (!seen && !name && opts.fallback !== undefined) return opts.fallback;
    return Math.max(min, Math.min(max, Math.ceil(w)));
  });
}

function clip(v: string): string {
  return v.length > WIDTH_SAMPLE_CHARS ? v.slice(0, WIDTH_SAMPLE_CHARS) : v;
}
