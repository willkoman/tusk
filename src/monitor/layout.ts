/**
 * Monitor layout and chart geometry. Pure, vitest-covered (layout.test.ts); the
 * canvas code in TimeSeries.tsx stays a thin painter over these numbers.
 */

import { niceCeil } from "./model";

export type Pad = { left: number; right: number; top: number; bottom: number };
export type Rect = { x0: number; x1: number; yTop: number; yBot: number; w: number; h: number };

export const CHART_PAD: Pad = { left: 44, right: 8, top: 6, bottom: 16 };
/** Sparklines have no axes. */
export const SPARK_PAD: Pad = { left: 1, right: 1, top: 2, bottom: 2 };

/**
 * Redraw pacing (plan decision 6): a chart repaints when the scroll has moved this
 * many CSS pixels. 2 px on a ~700 px 1-minute plot is ~6 redraws a second, which the
 * spike measured at ~2% of a core; WebView2's composite per redraw, not the drawing,
 * is the cost.
 */
export const STEP_PX = 2;
/** Two chart columns from this container width up. */
export const TWO_COLUMNS_MIN = 1100;

export function plotRect(cssW: number, cssH: number, pad: Pad = CHART_PAD): Rect {
  const x0 = pad.left;
  const x1 = Math.max(x0 + 1, cssW - pad.right);
  const yTop = pad.top;
  const yBot = Math.max(yTop + 1, cssH - pad.bottom);
  return { x0, x1, yTop, yBot, w: x1 - x0, h: yBot - yTop };
}

/**
 * A y axis for values up to `peak`: a nice step (1/2/2.5/5 × 10^k) for about `ticks`
 * gridlines, and the smallest multiple of it that holds the peak. `integer` keeps the
 * step whole (session counts: a 0.5-session gridline means nothing).
 */
export function niceScale(peak: number, ticks = 4, integer = false, binary = false): { max: number; step: number } {
  const p = Number.isFinite(peak) && peak > 0 ? peak : 0;
  // Bytes step in whole KiB/MiB/GiB (5 MiB, not 4.77): nice in the unit, scaled back.
  const unit = binary && p >= 1024 ? 1024 ** Math.min(4, Math.floor(Math.log(p) / Math.log(1024))) : 1;
  let step = niceCeil(p > 0 ? p / unit / ticks : integer ? 1 : 1 / ticks) * unit;
  if (integer || binary) step = Math.max(1, Math.ceil(step));
  const max = Math.max(step, Math.ceil(p / step - 1e-9) * step);
  return { max, step };
}

const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1000);

/** Time gridline spacing that keeps labels at least `minPx` apart. */
export function timeTickStep(windowMs: number, plotW: number, minPx = 90): number {
  const msPerPx = windowMs / Math.max(1, plotW);
  return TIME_STEPS.find((s) => s / msPerPx >= minPx) ?? TIME_STEPS[TIME_STEPS.length - 1];
}

/**
 * Gridline times inside [tStart, tEnd], aligned to the WALL clock (round seconds and
 * minutes), so they scroll with the data rather than sitting still. `wallOffset` is
 * `Date.now() - performance.now()`.
 */
export function timeTicks(tStart: number, tEnd: number, step: number, wallOffset: number): number[] {
  const out: number[] = [];
  for (let t = Math.ceil((tStart + wallOffset) / step) * step - wallOffset; t <= tEnd && out.length < 64; t += step) out.push(t);
  return out;
}

/** Milliseconds between paced redraws for a window drawn over `plotW` pixels. */
export function stepMs(windowMs: number, plotW: number, stepPx = STEP_PX): number {
  return (windowMs / Math.max(1, plotW)) * stepPx;
}

/**
 * How far behind real time a smoothly scrolling chart draws: one interval plus a
 * little, so a new sample is already in the ring when its point reaches the right
 * edge and enters from there instead of popping in.
 */
export const renderDelay = (intervalMs: number) => intervalMs + 300;

export type RenderMode = "smooth" | "step";

/**
 * The right edge of every chart, in local (performance.now) time.
 * - paused by the user: frozen on the last sample,
 * - reduced motion: the newest sample (the chart steps once per sample),
 * - otherwise: now minus the render delay (the chart glides).
 */
export function renderEnd(now: number, latest: number | null, intervalMs: number, mode: RenderMode, frozen: boolean): number {
  if (frozen || mode === "step") return latest ?? now;
  return now - renderDelay(intervalMs);
}

export const xOf = (t: number, tStart: number, windowMs: number, r: Rect) => r.x0 + ((t - tStart) / windowMs) * r.w;

/** The time under a pointer at CSS x, or null outside the plot. */
export function timeAt(x: number, tStart: number, windowMs: number, r: Rect): number | null {
  if (x < r.x0 || x > r.x1) return null;
  return tStart + ((x - r.x0) / r.w) * windowMs;
}

export const chartColumns = (width: number): 1 | 2 => (width >= TWO_COLUMNS_MIN ? 2 : 1);

/** Decimation bucket of a row: by ABSOLUTE time, so a row keeps its bucket as the chart scrolls. */
export const bucketOf = (t: number, msPerPx: number) => Math.floor(t / msPerPx);

/**
 * Per-series min/max decimation for line charts: for each bucket, the indices of the
 * rows holding the minimum and the maximum, in time order, so a spike survives being
 * squeezed into one pixel column. A gap row (NaN) in a bucket is kept as its own
 * point so the line breaks there. `value(i)` reads row i of one series.
 */
export function minMaxRows(times: (i: number) => number, value: (i: number) => number, from: number, to: number, msPerPx: number): number[] {
  const out: number[] = [];
  let bucket = Number.NaN;
  let lo = -1;
  let hi = -1;
  let gap = -1;
  const flush = () => {
    const picks = [lo, hi, gap].filter((i) => i >= 0).sort((a, b) => a - b);
    for (const i of picks) if (out[out.length - 1] !== i) out.push(i);
  };
  for (let i = from; i < to; i++) {
    const b = bucketOf(times(i), msPerPx);
    if (b !== bucket) {
      flush();
      bucket = b;
      lo = hi = gap = -1;
    }
    const v = value(i);
    if (v !== v) {
      if (gap < 0) gap = i;
      continue;
    }
    if (lo < 0 || v < value(lo)) lo = i;
    if (hi < 0 || v > value(hi)) hi = i;
  }
  flush();
  return out;
}

// --- the Activity table ------------------------------------------------------

export type ActivityColumn =
  | "pid"
  | "user"
  | "database"
  | "application"
  | "client"
  | "backendType"
  | "state"
  | "wait"
  | "xact"
  | "query"
  | "blockedBy"
  | "text";

export const ACTIVITY_COLUMNS: { id: ActivityColumn; label: string; min: number }[] = [
  { id: "pid", label: "PID", min: 72 },
  { id: "user", label: "User", min: 96 },
  { id: "database", label: "Database", min: 96 },
  { id: "application", label: "Application", min: 110 },
  { id: "client", label: "Client", min: 104 },
  { id: "backendType", label: "Backend", min: 110 },
  { id: "state", label: "State", min: 120 },
  { id: "wait", label: "Wait", min: 140 },
  { id: "xact", label: "Transaction", min: 88 },
  { id: "query", label: "Query age", min: 82 },
  { id: "blockedBy", label: "Blocked by", min: 90 },
  { id: "text", label: "Query", min: 200 },
];

/** Low-value columns go first as the table narrows (plan §3.2). */
const DROP_ORDER: ActivityColumn[] = ["client", "backendType", "application", "database", "blockedBy", "xact", "user", "wait"];

export function activityColumns(width: number): ActivityColumn[] {
  const shown = new Set(ACTIVITY_COLUMNS.map((c) => c.id));
  const total = () => ACTIVITY_COLUMNS.filter((c) => shown.has(c.id)).reduce((a, c) => a + c.min, 0);
  for (const id of DROP_ORDER) {
    if (total() <= width) break;
    shown.delete(id);
  }
  return ACTIVITY_COLUMNS.filter((c) => shown.has(c.id)).map((c) => c.id);
}

/** Rows of a fixed-height virtual list to render for a scroll position (with overscan). */
export function visibleRange(scrollTop: number, viewport: number, rowH: number, count: number, overscan = 6): { start: number; end: number } {
  // A list that shrank under a stale scroll position clamps instead of going blank past its end.
  const start = Math.min(count, Math.max(0, Math.floor(scrollTop / rowH) - overscan));
  const end = Math.min(count, Math.ceil((scrollTop + viewport) / rowH) + overscan);
  return { start, end: Math.max(start, end) };
}
