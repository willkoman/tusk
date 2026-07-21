import { describe, it, expect } from "vitest";
import { formatWithOptions, parseCSV, parseJSON, type Dataset } from "./formats";
import { defaultExportOptions, type ExportOptions } from "./export";
import { boolWord } from "./grid/bool";

// Boolean export mapping — PARITY PAIR with src-tauri/src/export.rs (`bool_token`
// + the per-format emission). The Rust unit tests assert the same outputs; change
// both together.

const data: Dataset = {
  columns: ["id", "active", "note"],
  rows: [
    ["1", "t", "t"], // note deliberately holds a bool-looking token: unmapped (not in boolCols)
    ["2", "f", "plain"],
    ["3", null, null],
  ],
};

function opts(patch: Partial<ExportOptions>): ExportOptions {
  return { ...defaultExportOptions("exported"), boolCols: [1], ...patch };
}

describe("import parsing boundaries", () => {
  it("parses CSV, TSV, quoted fields, and ragged rows", () => {
    expect(parseCSV('id,name\n1,"a,b"\n2', true)).toEqual({
      columns: ["id", "name"],
      rows: [["1", "a,b"], ["2", null]],
    });
    expect(parseCSV("id\tname\n1\tduck", true, "\t")).toEqual({
      columns: ["id", "name"],
      rows: [["1", "duck"]],
    });
  });

  it("rejects malformed quotes and dense amplification", () => {
    expect(() => parseCSV('id,name\n1,"open', true)).toThrow(/unterminated/i);
    const header = Array.from({ length: 2001 }, (_, i) => `c${i}`).join(",");
    const body = Array.from({ length: 1000 }, () => "x").join("\n");
    expect(() => parseCSV(`${header}\n${body}`, true)).toThrow(/dense result/i);
    const ragged = Array.from({ length: 251 }, () => Array(10_000).fill("x").join(",")).join("\n");
    expect(() => parseCSV(`only_one_output_column\n${ragged}`, true)).toThrow(/too large|cells/i);
  });

  it("parses object JSON linearly and rejects non-object rows", () => {
    expect(parseJSON('[{"a":1},{"b":{"x":2}}]')).toEqual({
      columns: ["a", "b"],
      rows: [["1", null], [null, '{"x":2}']],
    });
    expect(() => parseJSON("[1,2,3]")).toThrow(/array of objects/i);
    expect(() => parseJSON(JSON.stringify({ huge: "x".repeat(1_000_001) }))).toThrow(/field/i);
  });
});

describe("formatWithOptions boolean mapping", () => {
  it("csv maps only boolCols; NULL and non-bool columns untouched", () => {
    const out = formatWithOptions(data, opts({ format: "csv" }));
    expect(out).toBe("id,active,note\n1,TRUE,t\n2,FALSE,plain\n3,,");
  });

  it("tsv/delimited uses the same words as the grid (boolWord parity)", () => {
    const out = formatWithOptions(data, opts({ format: "csv", delimiter: "tab" }));
    expect(out.split("\n")[1]).toBe("1\tTRUE\tt");
    expect(boolWord("t")).toBe("TRUE"); // single source of the word set
  });

  it("json emits real booleans for bool columns, strings elsewhere", () => {
    const out = formatWithOptions(data, opts({ format: "json" }));
    const parsed = JSON.parse(out);
    expect(parsed[0]).toEqual({ id: "1", active: true, note: "t" });
    expect(parsed[1]).toEqual({ id: "2", active: false, note: "plain" });
    expect(parsed[2]).toEqual({ id: "3", active: null, note: null });
  });

  it("sql emits unquoted TRUE/FALSE and a boolean CREATE type", () => {
    const out = formatWithOptions(
      data,
      opts({ format: "sql", sql: { table: "exported", multiRow: false, includeCreate: true } }),
    );
    expect(out).toContain('CREATE TABLE "exported" ("id" text, "active" boolean, "note" text);');
    expect(out).toContain(`INSERT INTO "exported" ("id", "active", "note") VALUES ('1', TRUE, 't');`);
    expect(out).toContain(`INSERT INTO "exported" ("id", "active", "note") VALUES ('3', NULL, NULL);`);
  });

  it("markdown maps to the display words", () => {
    const out = formatWithOptions(data, opts({ format: "markdown" }));
    expect(out.split("\n")[2]).toBe("| 1 | TRUE | t |");
  });

  it("unrecognized tokens in a bool column pass through raw", () => {
    const d: Dataset = { columns: ["b"], rows: [["maybe"], ["1"], ["0"]] };
    const out = formatWithOptions(d, { ...defaultExportOptions("x"), format: "csv", boolCols: [0] });
    // 1/0 are recognized tokens (SQLite/MySQL numeric booleans); junk stays raw.
    expect(out).toBe("b\nmaybe\nTRUE\nFALSE");
  });

  it("no boolCols → byte-identical to the pre-mapping output", () => {
    const out = formatWithOptions(data, opts({ format: "csv", boolCols: [] }));
    expect(out).toBe("id,active,note\n1,t,t\n2,f,plain\n3,,");
  });

  it("boolCols are SOURCE indices — survive column projection/reorder", () => {
    const out = formatWithOptions(data, opts({ format: "csv", columnIndices: [2, 1] }));
    expect(out).toBe("note,active\nt,TRUE\nplain,FALSE\n,");
  });
});
