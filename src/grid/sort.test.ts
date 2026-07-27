import { describe, expect, it } from "vitest";
import { orderedRows, sortedRowOrder } from "./sort";

const rows = (xs: (string | null)[][]) => xs;

describe("sortedRowOrder", () => {
  it("returns canonical identity order without sort keys", () => {
    expect(sortedRowOrder(rows([["b"], ["a"]]), [])).toEqual([0, 1]);
  });

  it("sorts text ascending and descending without mutating rows", () => {
    const input = rows([["b"], ["a"], ["c"]]);
    expect(sortedRowOrder(input, [{ col: 0, dir: "asc" }])).toEqual([1, 0, 2]);
    expect(sortedRowOrder(input, [{ col: 0, dir: "desc" }])).toEqual([2, 0, 1]);
    expect(input).toEqual([["b"], ["a"], ["c"]]);
  });

  it("uses deterministic display-text ordering for numeric-looking strings", () => {
    expect(sortedRowOrder(rows([["2"], ["10"], ["1"]]), [{ col: 0, dir: "asc" }])).toEqual([2, 1, 0]);
  });

  it("follows engine default NULL placement", () => {
    const input = rows([["b"], [null], ["a"]]);
    expect(sortedRowOrder(input, [{ col: 0, dir: "asc" }], "postgres")).toEqual([2, 0, 1]);
    expect(sortedRowOrder(input, [{ col: 0, dir: "desc" }], "postgres")).toEqual([1, 0, 2]);
    expect(sortedRowOrder(input, [{ col: 0, dir: "asc" }], "sqlite")).toEqual([1, 2, 0]);
    expect(sortedRowOrder(input, [{ col: 0, dir: "desc" }], "duckdb")).toEqual([0, 2, 1]);
  });

  it("applies multi-column priority and canonical tie stability", () => {
    const input = rows([["a", "2"], ["a", "1"], ["b", "0"], ["a", "1"]]);
    expect(sortedRowOrder(input, [{ col: 0, dir: "asc" }, { col: 1, dir: "asc" }])).toEqual([1, 3, 0, 2]);
    expect(sortedRowOrder(input, [{ col: 0, dir: "asc" }])).toEqual([0, 1, 3, 2]);
  });

  it("ignores unusable columns and never drops or duplicates row identities", () => {
    expect(sortedRowOrder(rows([["a"], ["b"]]), [{ col: -1, dir: "asc" }])).toEqual([0, 1]);
    expect(orderedRows(["a", "b", "c"], [2, 99, 0])).toEqual(["a", "b", "c"]);
    expect(orderedRows(["a", "b", "c"], [2, 2, 0])).toEqual(["a", "b", "c"]);
    expect(orderedRows(["a", "b", "c"], [2, 0, 1])).toEqual(["c", "a", "b"]);
  });
});
