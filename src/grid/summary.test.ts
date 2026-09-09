import { describe, it, expect } from "vitest";
import { fmtNumber, numericValue, summarizeSelection } from "./summary";

describe("numericValue", () => {
  it("accepts the literals a driver prints", () => {
    expect(numericValue("42")).toBe(42);
    expect(numericValue("-3.5")).toBe(-3.5);
    expect(numericValue(".5")).toBe(0.5);
    expect(numericValue("1e3")).toBe(1000);
  });

  it("rejects anything else", () => {
    expect(numericValue("")).toBeNull();
    expect(numericValue("12abc")).toBeNull();
    expect(numericValue("NaN")).toBeNull();
    expect(numericValue("0x10")).toBeNull();
    expect(numericValue(" 1 ")).toBeNull();
  });
});

describe("summarizeSelection", () => {
  const nums = [["1", "2"], ["3", null], ["5", "4"]];
  const cell = (r: number, c: number) => nums[r]?.[c] ?? null;

  it("aggregates a fully numeric selection and counts NULLs", () => {
    const s = summarizeSelection(3, 2, cell);
    expect(s.rows).toBe(3);
    expect(s.cols).toBe(2);
    expect(s.cells).toBe(6);
    expect(s.nulls).toBe(1);
    expect(s.numeric).toEqual({ count: 5, sum: 15, avg: 3, min: 1, max: 5 });
  });

  it("offers no aggregate when one value is not numeric", () => {
    const mixed = [["1"], ["x"]];
    expect(summarizeSelection(2, 1, (r, c) => mixed[r]?.[c] ?? null).numeric).toBeNull();
  });

  it("offers no aggregate for an all-NULL selection", () => {
    const s = summarizeSelection(2, 1, () => null);
    expect(s.numeric).toBeNull();
    expect(s.nulls).toBe(2);
  });

  it("refuses to scan past the cell ceiling", () => {
    const s = summarizeSelection(1000, 1000, () => "1", 1000);
    expect(s.truncated).toBe(true);
    expect(s.numeric).toBeNull();
    expect(s.cells).toBe(1_000_000);
  });

  it("handles an empty selection", () => {
    const s = summarizeSelection(0, 0, () => null);
    expect(s.cells).toBe(0);
    expect(s.numeric).toBeNull();
  });
});

describe("fmtNumber", () => {
  it("groups integers and bounds fractions", () => {
    expect(fmtNumber(1234567)).toBe("1,234,567");
    expect(fmtNumber(1 / 3)).toBe("0.333333");
  });

  it("falls back to exponential at the extremes", () => {
    expect(fmtNumber(1e20)).toBe("1.0000e+20");
    expect(fmtNumber(0.0000001)).toBe("1.0000e-7");
    expect(fmtNumber(0)).toBe("0");
  });
});
