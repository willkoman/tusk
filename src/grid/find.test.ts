import { describe, it, expect } from "vitest";
import { findMatches, matchAtOrAfter, matchSet, stepMatch } from "./find";

const grid = [
  ["alpha", "one"],
  ["beta", "Alphabet"],
  ["gamma", null],
];
const cell = (r: number, c: number) => grid[r]?.[c] ?? null;

describe("findMatches", () => {
  it("scans row-major and matches case-insensitively", () => {
    const out = findMatches(3, 2, "alpha", cell);
    expect(out.matches).toEqual([{ r: 0, dc: 0 }, { r: 1, dc: 1 }]);
    expect(out.truncated).toBe(false);
  });

  it("returns nothing for an empty needle or empty grid", () => {
    expect(findMatches(3, 2, "", cell).matches).toEqual([]);
    expect(findMatches(0, 2, "a", cell).matches).toEqual([]);
    expect(findMatches(3, 0, "a", cell).matches).toEqual([]);
  });

  it("skips NULL cells", () => {
    expect(findMatches(3, 2, "null", cell).matches).toEqual([]);
  });

  it("stops at the match ceiling and says so", () => {
    const out = findMatches(10, 10, "x", () => "xx", { maxMatches: 4 });
    expect(out.matches.length).toBe(4);
    expect(out.truncated).toBe(true);
  });

  it("stops at the cell ceiling and says so", () => {
    const out = findMatches(10, 10, "zzz", () => "aaa", { maxCells: 25 });
    expect(out.matches).toEqual([]);
    expect(out.truncated).toBe(true);
  });
});

describe("stepMatch", () => {
  it("wraps in both directions and starts at the ends", () => {
    expect(stepMatch(3, -1, 1)).toBe(0);
    expect(stepMatch(3, -1, -1)).toBe(2);
    expect(stepMatch(3, 2, 1)).toBe(0);
    expect(stepMatch(3, 0, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });
});

describe("matchAtOrAfter", () => {
  const matches = [{ r: 1, dc: 2 }, { r: 4, dc: 0 }, { r: 4, dc: 3 }];

  it("finds the first match at or after a cell", () => {
    expect(matchAtOrAfter(matches, 0, 0)).toBe(0);
    expect(matchAtOrAfter(matches, 1, 2)).toBe(0);
    expect(matchAtOrAfter(matches, 1, 3)).toBe(1);
    expect(matchAtOrAfter(matches, 4, 1)).toBe(2);
  });

  it("wraps to the first match past the end, and is -1 when there are none", () => {
    expect(matchAtOrAfter(matches, 9, 0)).toBe(0);
    expect(matchAtOrAfter([], 0, 0)).toBe(-1);
  });
});

describe("matchSet", () => {
  it("keys by row and display column", () => {
    const s = matchSet([{ r: 1, dc: 2 }]);
    expect(s.has("1:2")).toBe(true);
    expect(s.has("2:1")).toBe(false);
  });
});
