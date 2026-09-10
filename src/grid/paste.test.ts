import { describe, expect, it } from "vitest";
import { parseClipboardTable, planPaste, mergePaste, tileTable, type PlanPasteInput, type PastePlan } from "./paste";
import { EMPTY_PENDING, type PendingEdits } from "../tabs";

describe("parseClipboardTable", () => {
  it("parses TSV (the spreadsheet default) into a grid", () => {
    expect(parseClipboardTable("a\tb\tc\n1\t2\t3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("parses CSV when no tabs are present", () => {
    expect(parseClipboardTable("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("honors quoted fields with embedded delimiter, quote, and newline", () => {
    expect(parseClipboardTable('"a,b","c""d","e\nf"')).toEqual([["a,b", 'c"d', "e\nf"]]);
  });

  it("keeps blank cells (does not collapse them)", () => {
    expect(parseClipboardTable("1\t\t3")).toEqual([["1", "", "3"]]);
  });

  it("strips only the trailing-newline artifact row, not real blank rows", () => {
    expect(parseClipboardTable("1\n\n2\n")).toEqual([["1"], [""], ["2"]]);
  });

  it("returns [] for empty text", () => {
    expect(parseClipboardTable("")).toEqual([]);
  });

  it("rejects unterminated quotes and excessive columns", () => {
    expect(() => parseClipboardTable('"unterminated')).toThrow(/unterminated/i);
    expect(() => parseClipboardTable("\t".repeat(10_001))).toThrow(/too many columns/i);
  });

  it("treats bare quotes mid-field as literal data (external clipboards)", () => {
    expect(parseClipboardTable('5" pipe\tx')).toEqual([['5" pipe', "x"]]);
    expect(parseClipboardTable('a"b,c\n1,2')).toEqual([['a"b', "c"], ["1", "2"]]);
    expect(parseClipboardTable('"a"x,c')).toEqual([["ax", "c"]]);
  });

  it("never splits a single line on commas — a copied value is one value", () => {
    // `Doe, Jane` copied from one cell and pasted over a range used to land as
    // `Doe` in the selected column and ` Jane` in the one beside it.
    expect(parseClipboardTable("Doe, Jane\n")).toEqual([["Doe, Jane"]]);
    expect(parseClipboardTable("1,234")).toEqual([["1,234"]]);
    expect(parseClipboardTable('"quoted, single"\n')).toEqual([["quoted, single"]]);
    expect(parseClipboardTable("a, b, c\n")).toEqual([["a, b, c"]]);
  });

  it("reads comma-separated text only when the lines agree and the commas look like separators", () => {
    expect(parseClipboardTable("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseClipboardTable('"a","b"\n"1","2"')).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseClipboardTable("a,b\n\n1,2\n")).toEqual([["a", "b"], [""], ["1", "2"]]); // a blank row is not a disagreement
    expect(parseClipboardTable("a,b\n1,2,3")).toEqual([["a,b"], ["1,2,3"]]); // lines disagree
    expect(parseClipboardTable("Doe, Jane\nSmith, John\n")).toEqual([["Doe, Jane"], ["Smith, John"]]); // prose commas
  });

  it("detects delimiters outside quotes and preserves CR row endings", () => {
    expect(parseClipboardTable('"a\tb",c\r\n1,2')).toEqual([["a\tb", "c"], ["1", "2"]]);
    expect(parseClipboardTable("a\tb\r1\t2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

const baseInput = (over: Partial<PlanPasteInput> = {}): PlanPasteInput => ({
  table: [],
  resultColumns: ["id", "name", "email"],
  isTableCol: [true, true, true],
  displayOrigCols: [0, 1, 2],
  anchorDisplayIdx: 0,
  anchor: { kind: "insert", i: 0 },
  nLoaded: 3,
  nInsExisting: 0,
  ...over,
});

describe("planPaste — header-mapped mode", () => {
  it("maps by column name and appends one insert per data row", () => {
    const plan = planPaste(baseInput({
      table: [
        ["email", "id"], // header out of order — mapping is by name
        ["a@x.com", "10"],
        ["b@x.com", "11"],
      ],
    }));
    expect(plan.mode).toBe("mapped");
    expect(plan.updates).toEqual([]);
    expect(plan.inserts).toEqual([
      { 2: "a@x.com", 0: "10" },
      { 2: "b@x.com", 0: "11" },
    ]);
    expect(plan.rowCount).toBe(2);
  });

  it("blank cell → NULL; short row omits the missing column", () => {
    const plan = planPaste(baseInput({
      table: [
        ["id", "name", "email"],
        ["1", "", "x@y.com"], // name blank → NULL
        ["2", "Bo"], // email absent → omitted (server default)
      ],
    }));
    expect(plan.inserts).toEqual([
      { 0: "1", 1: null, 2: "x@y.com" },
      { 0: "2", 1: "Bo" },
    ]);
  });

  it("falls back to positional when a header cell is not a known column", () => {
    const plan = planPaste(baseInput({
      table: [
        ["id", "nope"],
        ["1", "2"],
      ],
    }));
    expect(plan.mode).toBe("positional");
  });

  it("does not treat non-table columns as a valid header", () => {
    const plan = planPaste(baseInput({
      isTableCol: [true, false, true],
      table: [
        ["id", "name"], // name not a table col → disqualifies header
        ["1", "x"],
      ],
    }));
    expect(plan.mode).toBe("positional");
  });

  it("rejects duplicate mapped headers instead of overwriting a field", () => {
    expect(() => planPaste(baseInput({
      table: [["id", "ID"], ["1", "2"]],
    }))).toThrow(/more than once/i);
  });
});

describe("planPaste — positional mode", () => {
  it("writes a block from the anchor over loaded rows, overflowing into inserts", () => {
    const plan = planPaste(baseInput({
      anchor: { kind: "loaded", i: 1 },
      anchorDisplayIdx: 1, // start at column 'name'
      table: [
        ["Al", "al@x"], // → loaded row 1, cols name,email
        ["Bo", "bo@x"], // → loaded row 2
        ["Cy", "cy@x"], // → overflow → new insert
      ],
    }));
    expect(plan.mode).toBe("positional");
    expect(plan.updates).toEqual([
      { ref: { kind: "loaded", i: 1 }, col: 1, val: "Al" },
      { ref: { kind: "loaded", i: 1 }, col: 2, val: "al@x" },
      { ref: { kind: "loaded", i: 2 }, col: 1, val: "Bo" },
      { ref: { kind: "loaded", i: 2 }, col: 2, val: "bo@x" },
    ]);
    expect(plan.inserts).toEqual([{ 1: "Cy", 2: "cy@x" }]);
  });

  it("maps vertical paste through locally sorted display order", () => {
    const plan = planPaste(baseInput({
      anchor: { kind: "loaded", i: 2 },
      loadedOrder: [2, 0, 1],
      table: [["first"], ["second"], ["third"], ["new"]],
    }));
    expect(plan.updates).toEqual([
      { ref: { kind: "loaded", i: 2 }, col: 0, val: "first" },
      { ref: { kind: "loaded", i: 0 }, col: 0, val: "second" },
      { ref: { kind: "loaded", i: 1 }, col: 0, val: "third" },
    ]);
    expect(plan.inserts).toEqual([{ 0: "new" }]);
  });

  it("skips columns that run past the visible columns", () => {
    const plan = planPaste(baseInput({
      anchor: { kind: "loaded", i: 0 },
      anchorDisplayIdx: 2, // anchored at last column; second pasted col has nowhere to go
      table: [["x", "overflow-col"]],
    }));
    expect(plan.updates).toEqual([{ ref: { kind: "loaded", i: 0 }, col: 2, val: "x" }]);
    expect(plan.inserts).toEqual([]);
  });

  it("anchored in the insert region appends as new rows (no loaded overwrite)", () => {
    const plan = planPaste(baseInput({
      anchor: { kind: "insert", i: 0 },
      nInsExisting: 0,
      table: [
        ["1", "A", "a@x"],
        ["2", "B", "b@x"],
      ],
    }));
    expect(plan.updates).toEqual([]);
    expect(plan.inserts).toEqual([
      { 0: "1", 1: "A", 2: "a@x" },
      { 0: "2", 1: "B", 2: "b@x" },
    ]);
  });

  it("positional blank cell → NULL", () => {
    const plan = planPaste(baseInput({
      anchor: { kind: "loaded", i: 0 },
      anchorDisplayIdx: 0,
      table: [["", "n"]],
    }));
    expect(plan.updates).toEqual([
      { ref: { kind: "loaded", i: 0 }, col: 0, val: null },
      { ref: { kind: "loaded", i: 0 }, col: 1, val: "n" },
    ]);
  });

  it("rejects argument-limit-scale row counts predictably", () => {
    const table = Array.from({ length: 50_001 }, (_, i) => [String(i)]);
    expect(() => planPaste(baseInput({ anchor: { kind: "insert", i: 0 }, table }))).toThrow(/too many rows/i);
  });

  it("rejects stale or duplicate display identity maps", () => {
    expect(() => planPaste(baseInput({
      anchor: { kind: "loaded", i: 1 },
      loadedOrder: [0, 0, 2],
      table: [["x"]],
    }))).toThrow(/row order/i);
  });
});

describe("mergePaste", () => {
  const loaded = [
    ["1", "Al", "a@x"],
    ["2", "Bo", "b@x"],
  ];

  it("appends mapped inserts and leaves existing pending untouched", () => {
    const pending: PendingEdits = { cells: { 0: { 1: "edited" } }, deletes: [], inserts: [{ 0: "9" }] };
    const plan: PastePlan = {
      mode: "mapped",
      updates: [],
      inserts: [{ 0: "10", 1: "Cy" }],
      rowCount: 1,
      colCount: 2,
    };
    const out = mergePaste(pending, plan, loaded);
    expect(out.inserts).toEqual([{ 0: "9" }, { 0: "10", 1: "Cy" }]);
    expect(out.cells).toEqual({ 0: { 1: "edited" } });
    // inputs not mutated
    expect(pending.inserts).toEqual([{ 0: "9" }]);
  });

  it("positional update to a loaded row records a cell edit", () => {
    const plan: PastePlan = {
      mode: "positional",
      updates: [{ ref: { kind: "loaded", i: 1 }, col: 1, val: "Bob" }],
      inserts: [],
      rowCount: 1,
      colCount: 1,
    };
    const out = mergePaste({ ...EMPTY_PENDING }, plan, loaded);
    expect(out.cells).toEqual({ 1: { 1: "Bob" } });
  });

  it("an update back to the original snapshot value is not recorded", () => {
    const plan: PastePlan = {
      mode: "positional",
      updates: [{ ref: { kind: "loaded", i: 0 }, col: 1, val: "Al" }], // same as snapshot
      inserts: [],
      rowCount: 1,
      colCount: 1,
    };
    const out = mergePaste({ ...EMPTY_PENDING }, plan, loaded);
    expect(out.cells).toEqual({});
  });

  it("writes into an existing insert row by index", () => {
    const pending: PendingEdits = { cells: {}, deletes: [], inserts: [{ 0: "5" }] };
    const plan: PastePlan = {
      mode: "positional",
      updates: [{ ref: { kind: "insert", i: 0 }, col: 1, val: "X" }],
      inserts: [],
      rowCount: 1,
      colCount: 1,
    };
    const out = mergePaste(pending, plan, loaded);
    expect(out.inserts).toEqual([{ 0: "5", 1: "X" }]);
    expect(pending.inserts[0]).toEqual({ 0: "5" }); // original untouched
  });
});

describe("tileTable (repeat a block across a selection)", () => {
  it("repeats vertically and horizontally when the selection is a whole multiple", () => {
    expect(tileTable([["a"], ["b"]], 6, 1)).toEqual({ table: [["a"], ["b"], ["a"], ["b"], ["a"], ["b"]], tiled: true });
    expect(tileTable([["a", "b"]], 1, 4)).toEqual({ table: [["a", "b", "a", "b"]], tiled: true });
    expect(tileTable([["1", "2"], ["3", "4"]], 4, 4).table).toEqual([
      ["1", "2", "1", "2"],
      ["3", "4", "3", "4"],
      ["1", "2", "1", "2"],
      ["3", "4", "3", "4"],
    ]);
  });

  it("pastes once when a dimension is not a multiple, and never shrinks", () => {
    expect(tileTable([["a"], ["b"]], 5, 1)).toEqual({ table: [["a"], ["b"]], tiled: false });
    expect(tileTable([["a"], ["b"]], 1, 1)).toEqual({ table: [["a"], ["b"]], tiled: false });
    // 5 rows: not a multiple of 2 → once; 4 columns: a multiple of 1 → across.
    expect(tileTable([["a"], ["b"]], 5, 4).table).toEqual([["a", "a", "a", "a"], ["b", "b", "b", "b"]]);
  });

  it("repeats a ragged block only vertically", () => {
    expect(tileTable([["a", "b"], ["c"]], 4, 4)).toEqual({ table: [["a", "b"], ["c"], ["a", "b"], ["c"]], tiled: true });
  });

  it("refuses to fan out past the clipboard cell ceiling", () => {
    expect(() => tileTable([["x"]], 250_001, 1)).toThrow(/250,000 cells/);
  });
});

describe("planPaste — tiling across the selected rectangle", () => {
  it("fills a 6-row selection with a 2-row block, three times over", () => {
    const plan = planPaste(baseInput({
      table: [["x"], ["y"]],
      anchor: { kind: "loaded", i: 0 },
      nLoaded: 6,
      tile: { rows: 6, cols: 1 },
    }));
    expect(plan.mode).toBe("positional");
    expect(plan.tiled).toBe(true);
    expect(plan.rowCount).toBe(6);
    expect(plan.updates.map((u) => [u.ref.i, u.col, u.val])).toEqual([
      [0, 0, "x"], [1, 0, "y"], [2, 0, "x"], [3, 0, "y"], [4, 0, "x"], [5, 0, "y"],
    ]);
    expect(plan.inserts).toEqual([]);
  });

  it("pastes once, from the anchor, when the selection is not a multiple", () => {
    const plan = planPaste(baseInput({
      table: [["x"], ["y"]],
      anchor: { kind: "loaded", i: 1 },
      nLoaded: 6,
      tile: { rows: 5, cols: 1 },
    }));
    expect(plan.tiled).toBe(false);
    expect(plan.updates.map((u) => u.ref.i)).toEqual([1, 2]);
  });

  it("never repeats a header-mapped paste", () => {
    const plan = planPaste(baseInput({
      table: [["id", "name"], ["1", "A"]],
      anchor: { kind: "loaded", i: 0 },
      tile: { rows: 4, cols: 2 },
    }));
    expect(plan.mode).toBe("mapped");
    expect(plan.inserts).toEqual([{ 0: "1", 1: "A" }]);
    expect(plan.tiled).toBeUndefined();
  });
});
