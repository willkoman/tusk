import { describe, expect, it } from "vitest";
import {
  ACTIVITY_COLUMNS,
  CHART_PAD,
  STEP_PX,
  activityColumns,
  bucketOf,
  chartColumns,
  minMaxRows,
  niceScale,
  plotRect,
  renderDelay,
  renderEnd,
  stepMs,
  timeAt,
  timeTickStep,
  timeTicks,
  visibleRange,
  xOf,
} from "./layout";

describe("chart geometry", () => {
  it("insets the plot by its padding and never collapses", () => {
    const r = plotRect(744, 180);
    expect(r).toEqual({ x0: CHART_PAD.left, x1: 736, yTop: CHART_PAD.top, yBot: 164, w: 692, h: 158 });
    const tiny = plotRect(10, 5);
    expect(tiny.w).toBeGreaterThan(0);
    expect(tiny.h).toBeGreaterThan(0);
  });

  it("maps time to x and back", () => {
    const r = plotRect(744, 180);
    expect(xOf(1000, 1000, 60_000, r)).toBe(r.x0);
    expect(xOf(61_000, 1000, 60_000, r)).toBe(r.x1);
    expect(timeAt(r.x0 + r.w / 2, 1000, 60_000, r)).toBe(31_000);
    expect(timeAt(r.x0 - 1, 1000, 60_000, r)).toBeNull();
  });

  it("chooses nice axis steps that hold the peak", () => {
    expect(niceScale(101)).toEqual({ max: 150, step: 50 });
    expect(niceScale(3.2)).toEqual({ max: 4, step: 1 });
    expect(niceScale(0)).toEqual({ max: 0.25, step: 0.25 });
    expect(niceScale(0, 4, true)).toEqual({ max: 1, step: 1 });
    expect(niceScale(2, 4, true), "no half-session gridlines").toEqual({ max: 2, step: 1 });
    expect(niceScale(Number.NaN).max).toBeGreaterThan(0);
    // Bytes step in whole binary units.
    expect(niceScale(19 * 1024 ** 2, 4, false, true)).toEqual({ max: 20 * 1024 ** 2, step: 5 * 1024 ** 2 });
    expect(niceScale(700, 4, false, true).step, "below a KiB: plain bytes, whole").toBe(200);
    const s = niceScale(987_654);
    expect(s.max).toBeGreaterThanOrEqual(987_654);
    expect(s.max / s.step).toBeLessThanOrEqual(4);
  });

  it("spaces time labels at least 90 px apart and aligns them to the wall clock", () => {
    expect(timeTickStep(60_000, 700)).toBe(10_000);
    expect(timeTickStep(300_000, 700)).toBe(60_000);
    expect(timeTickStep(3_600_000, 700)).toBe(600_000);
    expect(timeTickStep(3_600_000, 60)).toBe(3_600_000);
    // performance.now() 0 is wall 1_000_500: ticks land on whole wall seconds.
    const ticks = timeTicks(0, 3_000, 1000, 1_000_500);
    expect(ticks).toEqual([500, 1500, 2500]);
  });

  it("paces redraws by distance scrolled: ~6/s on a 1-minute window", () => {
    expect(STEP_PX).toBe(2);
    const ms = stepMs(60_000, 700);
    expect(1000 / ms).toBeGreaterThan(5.5);
    expect(1000 / ms).toBeLessThan(6.5);
    expect(stepMs(3_600_000, 700), "an hour window barely moves").toBeGreaterThan(10_000);
  });

  it("draws behind real time when gliding, on the newest sample when stepping or frozen", () => {
    expect(renderDelay(1000)).toBe(1300);
    expect(renderEnd(10_000, 9_500, 1000, "smooth", false)).toBe(8_700);
    expect(renderEnd(10_000, 9_500, 1000, "step", false)).toBe(9_500);
    expect(renderEnd(10_000, 9_500, 1000, "smooth", true)).toBe(9_500);
    expect(renderEnd(10_000, null, 1000, "step", false)).toBe(10_000);
  });

  it("switches to two chart columns at 1100 px", () => {
    expect(chartColumns(1099)).toBe(1);
    expect(chartColumns(1100)).toBe(2);
  });
});

describe("decimation", () => {
  it("buckets by absolute time so a row keeps its bucket while scrolling", () => {
    expect(bucketOf(999, 100)).toBe(9);
    expect(bucketOf(1000, 100)).toBe(10);
  });

  it("keeps each bucket's min and max in time order, and its gaps", () => {
    const t = [0, 10, 20, 30, 100, 110, 120, 200];
    const v = [5, 1, 9, 4, 3, Number.NaN, 7, 2];
    const rows = minMaxRows((i) => t[i], (i) => v[i], 0, t.length, 100);
    // bucket 0: min at 1, max at 2; bucket 1: min 4, gap 5, max 6; bucket 2: the one row.
    expect(rows).toEqual([1, 2, 4, 5, 6, 7]);
  });

  it("emits a single row once when it is both the min and the max", () => {
    expect(minMaxRows((i) => i, () => 1, 0, 1, 100)).toEqual([0]);
    expect(minMaxRows((i) => i, () => 1, 0, 0, 100)).toEqual([]);
  });
});

describe("activity table layout", () => {
  const all = ACTIVITY_COLUMNS.reduce((a, c) => a + c.min, 0);

  it("shows every column when there is room", () => {
    expect(activityColumns(all)).toEqual(ACTIVITY_COLUMNS.map((c) => c.id));
  });

  it("drops client and backend type first as it narrows", () => {
    const cols = activityColumns(all - 1);
    expect(cols).not.toContain("client");
    expect(cols).toContain("backendType");
    const narrower = activityColumns(all - 200);
    expect(narrower).not.toContain("client");
    expect(narrower).not.toContain("backendType");
  });

  it("always keeps pid, state, query age and the query", () => {
    const cols = activityColumns(100);
    for (const id of ["pid", "state", "query", "text"] as const) expect(cols).toContain(id);
  });

  it("renders only the rows in view, plus overscan", () => {
    expect(visibleRange(0, 280, 28, 500)).toEqual({ start: 0, end: 16 });
    expect(visibleRange(2800, 280, 28, 500)).toEqual({ start: 94, end: 116 });
    expect(visibleRange(99_999, 280, 28, 20)).toEqual({ start: 20, end: 20 });
  });
});
