import { describe, expect, it } from "vitest";
import {
  allRows,
  anyHas,
  expandSpans,
  forEachCell,
  forEachRow,
  makeRect,
  mergeSpans,
  productCols,
  runCellCount,
  runColSpans,
  runRowCount,
  selectionRuns,
  subtractRect,
  type SelRect,
} from "./selection";

const cells = (r0: number, c0: number, r1: number, c1: number): SelRect => makeRect("cells", r0, c0, r1, c1);
const rows = (r0: number, r1: number): SelRect => makeRect("rows", r0, 0, r1, 0);
const cols = (c0: number, c1: number): SelRect => makeRect("cols", 0, c0, 0, c1);

describe("makeRect / rectHas", () => {
  it("normalises a dragged rectangle whatever direction it was dragged in", () => {
    expect(makeRect("cells", 5, 4, 2, 1)).toEqual({ kind: "cells", r0: 2, r1: 5, c0: 1, c1: 4 });
  });

  it("whole-row and whole-column rectangles ignore the other axis", () => {
    expect(anyHas([rows(2, 3)], 3, 999)).toBe(true);
    expect(anyHas([cols(1, 1)], 999, 1)).toBe(true);
    expect(anyHas([cells(0, 0, 1, 1)], 2, 0)).toBe(false);
  });
});

describe("selectionRuns", () => {
  it("folds one rectangle into one run", () => {
    expect(selectionRuns([cells(1, 2, 3, 4)], 10, 10)).toEqual([{ r0: 1, r1: 3, cols: [[2, 4]] }]);
  });

  it("clamps to the loaded rows and visible columns", () => {
    expect(selectionRuns([cells(8, 8, 20, 20)], 10, 10)).toEqual([{ r0: 8, r1: 9, cols: [[8, 9]] }]);
    expect(selectionRuns([cells(20, 0, 30, 0)], 10, 10)).toEqual([]);
    expect(selectionRuns([cells(0, 0, 0, 0)], 0, 10)).toEqual([]);
  });

  it("whole rows span every column and whole columns every row", () => {
    expect(selectionRuns([rows(1, 2)], 5, 3)).toEqual([{ r0: 1, r1: 2, cols: [[0, 2]] }]);
    expect(selectionRuns([cols(1, 1)], 5, 3)).toEqual([{ r0: 0, r1: 4, cols: [[1, 1]] }]);
  });

  it("never counts an overlap twice", () => {
    const runs = selectionRuns([cells(0, 0, 2, 2), cells(1, 1, 3, 3)], 10, 10);
    expect(runs).toEqual([
      { r0: 0, r1: 0, cols: [[0, 2]] },
      { r0: 1, r1: 2, cols: [[0, 3]] },
      { r0: 3, r1: 3, cols: [[1, 3]] },
    ]);
    expect(runCellCount(runs)).toBe(9 + 9 - 4);
    expect(runRowCount(runs)).toBe(4);
  });

  it("fuses adjacent segments with identical columns and merges touching intervals", () => {
    expect(selectionRuns([cells(0, 0, 1, 0), cells(2, 0, 3, 0)], 10, 10)).toEqual([{ r0: 0, r1: 3, cols: [[0, 0]] }]);
    expect(selectionRuns([cells(0, 0, 0, 1), cells(0, 2, 0, 3)], 10, 10)).toEqual([{ r0: 0, r1: 0, cols: [[0, 3]] }]);
    expect(mergeSpans([[5, 6], [0, 1], [2, 2]])).toEqual([[0, 2], [5, 6]]);
  });

  it("keeps the runs in row order even when rectangles were added out of order", () => {
    const runs = selectionRuns([cells(7, 0, 7, 0), cells(2, 0, 2, 0)], 10, 10);
    expect(runs.map((r) => r.r0)).toEqual([2, 7]);
    const seen: number[] = [];
    forEachRow(runs, (r) => seen.push(r));
    expect(seen).toEqual([2, 7]);
  });
});

describe("productCols (what a rectangular clipboard can hold)", () => {
  it("accepts one rectangle, and areas sharing the same rows or the same columns", () => {
    expect(productCols(selectionRuns([cells(0, 0, 2, 1)], 10, 10))).toEqual([[0, 1]]);
    // same rows, different columns → rows × union(columns)
    expect(productCols(selectionRuns([cells(0, 0, 2, 0), cells(0, 3, 2, 3)], 10, 10))).toEqual([[0, 0], [3, 3]]);
    // same columns, different rows
    expect(productCols(selectionRuns([cells(0, 1, 0, 2), cells(5, 1, 6, 2)], 10, 10))).toEqual([[1, 2]]);
    expect(runColSpans(selectionRuns([cells(0, 0, 2, 0), cells(0, 3, 2, 3)], 10, 10))).toEqual([[0, 0], [3, 3]]);
  });

  it("refuses an L-shape, a cross, and an empty selection", () => {
    expect(productCols(selectionRuns([cells(0, 0, 2, 0), cells(2, 1, 2, 3)], 10, 10))).toBeNull();
    expect(productCols(selectionRuns([rows(1, 1), cols(1, 1)], 10, 10))).toBeNull();
    expect(productCols([])).toBeNull();
  });

  it("expands intervals to the column list copy needs", () => {
    expect(expandSpans([[0, 1], [4, 4]])).toEqual([0, 1, 4]);
  });
});

describe("forEachCell", () => {
  it("visits row-major, columns ascending, without duplicates", () => {
    const runs = selectionRuns([cells(1, 2, 1, 3), cells(0, 0, 1, 0)], 10, 10);
    const seen: string[] = [];
    forEachCell(runs, (r, c) => seen.push(`${r}:${c}`));
    expect(seen).toEqual(["0:0", "1:0", "1:2", "1:3"]);
  });
});

describe("subtractRect (Ctrl-click deselects)", () => {
  it("cuts a cell out of the middle of a rectangle into four pieces", () => {
    const out = subtractRect([cells(0, 0, 2, 2)], cells(1, 1, 1, 1), 10, 10);
    expect(out).toEqual([
      { kind: "cells", r0: 0, r1: 0, c0: 0, c1: 2 },
      { kind: "cells", r0: 2, r1: 2, c0: 0, c1: 2 },
      { kind: "cells", r0: 1, r1: 1, c0: 0, c1: 0 },
      { kind: "cells", r0: 1, r1: 1, c0: 2, c1: 2 },
    ]);
    expect(anyHas(out, 1, 1)).toBe(false);
    expect(runCellCount(selectionRuns(out, 10, 10))).toBe(8);
  });

  it("removes a single cell entirely and leaves untouched rectangles alone", () => {
    expect(subtractRect([cells(3, 3, 3, 3), cells(0, 0, 0, 0)], cells(3, 3, 3, 3), 10, 10)).toEqual([cells(0, 0, 0, 0)]);
  });

  it("keeps the row kind above and below a cut through a whole-row selection", () => {
    const out = subtractRect([rows(0, 4)], cells(2, 1, 2, 1), 10, 3);
    expect(out).toEqual([
      { kind: "rows", r0: 0, r1: 1, c0: 0, c1: 2 },
      { kind: "rows", r0: 3, r1: 4, c0: 0, c1: 2 },
      { kind: "cells", r0: 2, r1: 2, c0: 0, c1: 0 },
      { kind: "cells", r0: 2, r1: 2, c0: 2, c1: 2 },
    ]);
    // A later shown column still belongs to the row bands, not to the cut row.
    expect(anyHas(out, 0, 5)).toBe(true);
    expect(anyHas(out, 2, 5)).toBe(false);
  });

  it("removing a whole row from a whole-column selection leaves column-bounded cells", () => {
    const out = subtractRect([cols(1, 1)], rows(2, 2), 5, 3);
    expect(out).toEqual([
      { kind: "cells", r0: 0, r1: 1, c0: 1, c1: 1 },
      { kind: "cells", r0: 3, r1: 4, c0: 1, c1: 1 },
    ]);
  });

  it("drops rectangles that no longer intersect the grid", () => {
    expect(subtractRect([cells(20, 0, 25, 0), cells(0, 0, 0, 0)], cells(9, 9, 9, 9), 10, 10)).toEqual([cells(0, 0, 0, 0)]);
  });
});

describe("allRows", () => {
  it("is true only for a non-empty, rows-only selection", () => {
    expect(allRows([rows(0, 1), rows(5, 5)])).toBe(true);
    expect(allRows([rows(0, 1), cells(0, 0, 0, 0)])).toBe(false);
    expect(allRows([])).toBe(false);
  });
});
