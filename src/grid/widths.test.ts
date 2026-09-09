import { describe, it, expect } from "vitest";
import {
  sampleColumnWidths,
  AUTO_MIN_W,
  AUTO_MAX_W,
  HEAD_PAD,
  CELL_PAD,
  WIDTH_SAMPLE_CHARS,
} from "./widths";

/** Deterministic stand-in for canvas measurement: 7px per character. */
const measure = (s: string) => s.length * 7;

describe("sampleColumnWidths", () => {
  it("sizes a column to its widest sampled value", () => {
    const [w] = sampleColumnWidths(["id"], [["1"], ["22"], ["3".repeat(20)]], measure);
    expect(w).toBe(20 * 7 + CELL_PAD);
  });

  it("keeps the header readable when it is wider than the values", () => {
    const [w] = sampleColumnWidths(["display_name"], [["a"]], measure);
    expect(w).toBe("display_name".length * 7 + HEAD_PAD);
  });

  it("clamps to the floor and the ceiling", () => {
    const [narrow, wide] = sampleColumnWidths(
      ["a", "b"],
      [["x", "y".repeat(400)]],
      measure,
    );
    expect(narrow).toBe(AUTO_MIN_W);
    expect(wide).toBe(AUTO_MAX_W);
  });

  it("does not read past the row budget", () => {
    const short = "a-short-enough-value";
    const rows = [[short], [short], ["a-much-much-much-much-longer-value"]];
    const [w] = sampleColumnWidths(["c"], rows, measure, { sampleRows: 2 });
    expect(w).toBe(short.length * 7 + CELL_PAD);
  });

  it("never measures more than the character budget", () => {
    const long = "x".repeat(10_000);
    const [w] = sampleColumnWidths(["c"], [[long]], measure, { max: 100_000 });
    expect(w).toBe(WIDTH_SAMPLE_CHARS * 7 + CELL_PAD);
  });

  it("ignores NULLs", () => {
    const [w] = sampleColumnWidths(["c"], [[null], [null], ["ab"]], measure);
    expect(w).toBe(AUTO_MIN_W);
  });

  it("gives a timestamp column room for the whole value", () => {
    const stamp = "2026-09-09 20:22:03.527887+00";
    const [w] = sampleColumnWidths(["signup_at"], [[stamp]], measure);
    expect(w).toBeGreaterThanOrEqual(stamp.length * 7);
    expect(w).toBeLessThanOrEqual(AUTO_MAX_W);
  });

  it("returns one width per column and no NaNs", () => {
    const ws = sampleColumnWidths(["a", "b", "c"], [["1", null, "3"]], measure);
    expect(ws).toHaveLength(3);
    expect(ws.every((w) => Number.isFinite(w))).toBe(true);
  });

  it("falls back for an unnamed, empty column", () => {
    const [w] = sampleColumnWidths([""], [], measure, { fallback: 180 });
    expect(w).toBe(180);
  });
});
