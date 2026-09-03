import { describe, expect, it } from "vitest";
import { columnKind, orderedRows, sortedRowOrder } from "./sort";

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

  it("sorts an all-numeric column by value, not by text", () => {
    expect(sortedRowOrder(rows([["2"], ["10"], ["1"]]), [{ col: 0, dir: "asc" }])).toEqual([2, 0, 1]);
    const input = rows([["911"], ["90"], ["9"], ["893"], ["89"], ["87"]]);
    expect(orderedRows(input, sortedRowOrder(input, [{ col: 0, dir: "desc" }]))).toEqual(
      [["911"], ["893"], ["90"], ["89"], ["87"], ["9"]],
    );
    expect(orderedRows(input, sortedRowOrder(input, [{ col: 0, dir: "asc" }]))).toEqual(
      [["9"], ["87"], ["89"], ["90"], ["893"], ["911"]],
    );
  });

  it("compares integers exactly beyond double precision and handles signs/zeros", () => {
    const input = rows([["9007199254740993"], ["9007199254740992"], ["-5"], ["-10"], ["0"], ["-0"], ["007"]]);
    expect(orderedRows(input, sortedRowOrder(input, [{ col: 0, dir: "asc" }]))).toEqual(
      [["-10"], ["-5"], ["0"], ["-0"], ["007"], ["9007199254740992"], ["9007199254740993"]],
    );
  });

  it("sorts decimals and scientific notation numerically with NaN last", () => {
    const input = rows([["1.5"], ["-2.25"], ["1e3"], ["NaN"], [".5"], ["-Infinity"], ["Infinity"], [null]]);
    expect(orderedRows(input, sortedRowOrder(input, [{ col: 0, dir: "asc" }], "postgres"))).toEqual(
      [["-Infinity"], ["-2.25"], [".5"], ["1.5"], ["1e3"], ["Infinity"], ["NaN"], [null]],
    );
  });

  it("falls back to text ordering when any value is non-numeric", () => {
    expect(columnKind(rows([["2"], ["10"], ["x"]]), 0)).toBe("text");
    expect(columnKind(rows([["2"], ["10"], [null]]), 0)).toBe("integer");
    expect(columnKind(rows([["2"], ["1.5"]]), 0)).toBe("number");
    expect(columnKind(rows([[null], [null]]), 0)).toBe("text");
    expect(columnKind(rows([[""], ["1"]]), 0)).toBe("text");
    expect(columnKind(rows([["\x00ff"], ["\x01"]]), 0)).toBe("text");
    expect(sortedRowOrder(rows([["2"], ["10"], ["1a"]]), [{ col: 0, dir: "asc" }])).toEqual([1, 2, 0]);
  });

  it("infers each sort column independently", () => {
    const input = rows([["b", "10"], ["a", "9"], ["a", "10"]]);
    expect(sortedRowOrder(input, [{ col: 0, dir: "asc" }, { col: 1, dir: "asc" }])).toEqual([1, 2, 0]);
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
