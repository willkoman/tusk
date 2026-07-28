import { afterEach, describe, it, expect } from "vitest";
import { formatForCopy, formatWithOptions, parseCSV, parseJSON, toJSON, toMarkdown, toSQL, toTSV, type Dataset } from "./formats";
import { defaultExportOptions, type ExportOptions } from "./export";
import { boolWord } from "./grid/bool";
import { setSqlDialect } from "./sql/ident";

afterEach(() => setSqlDialect("postgres"));

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
    expect(() => parseCSV('id,name\n1,a"b', true)).toThrow(/unquoted/i);
    expect(() => parseCSV('id,name\n1,"a"tail', true)).toThrow(/closing quote/i);
    const header = Array.from({ length: 2001 }, (_, i) => `c${i}`).join(",");
    const body = Array.from({ length: 1000 }, () => "x").join("\n");
    expect(() => parseCSV(`${header}\n${body}`, true)).toThrow(/dense result/i);
    const ragged = Array.from({ length: 251 }, () => Array(10_000).fill("x").join(",")).join("\n");
    expect(() => parseCSV(`only_one_output_column\n${ragged}`, true)).toThrow(/too large|cells/i);
  });

  it("preserves widest headerless rows and rejects ambiguous header shapes", () => {
    expect(parseCSV("1\n2,3", false)).toEqual({
      columns: ["col1", "col2"],
      rows: [["1", null], ["2", "3"]],
    });
    expect(() => parseCSV("id,id\n1,2", true)).toThrow(/duplicate/i);
    expect(() => parseCSV("id\n1,2", true)).toThrow(/more fields/i);
    expect(parseCSV('id,note\r\n1,"a\r\nb"\r2,x', true).rows).toEqual([["1", "a\r\nb"], ["2", "x"]]);
  });

  it("handles a large headerless row count without argument spreading", () => {
    const parsed = parseCSV(Array.from({ length: 150_000 }, () => "x").join("\n"), false);
    expect(parsed.columns).toEqual(["col1"]);
    expect(parsed.rows).toHaveLength(150_000);
  });

  it("parses object JSON linearly and rejects non-object rows", () => {
    expect(parseJSON('[{"a":1},{"b":{"x":2}}]')).toEqual({
      columns: ["a", "b"],
      rows: [["1", null], [null, '{"x":2}']],
    });
    expect(() => parseJSON("[1,2,3]")).toThrow(/array of objects/i);
    expect(() => parseJSON(JSON.stringify({ huge: "x".repeat(1_000_001) }))).toThrow(/field/i);
  });

  it("rejects duplicate JSON keys before JSON.parse can discard them", () => {
    expect(() => parseJSON('{"a":1,"a":2}')).toThrow(/duplicate object key/i);
    expect(() => parseJSON('{"a":1,"\\u0061":2}')).toThrow(/duplicate object key/i);
    expect(() => parseJSON('{"a":{"x":1,"x":2}}')).toThrow(/duplicate object key/i);
  });
});

describe("shape-safe formatting", () => {
  it("quotes TSV controls so parsing recovers exact fields", () => {
    const d: Dataset = { columns: ["a", "b"], rows: [["x\ty", "line1\r\nline2"]] };
    expect(parseCSV(toTSV(d), true, "\t")).toEqual(d);
  });

  it("formatForCopy = export formatter bytes; empty string and NULL stay distinct; md always has headers", () => {
    const d: Dataset = { columns: ["a", "b"], rows: [["", null]] };
    const csv = formatForCopy(d, "csv", true);
    expect(csv).toBe('a,b\n"",\n'); // "" = empty string, bare = NULL — round-trippable
    expect(formatForCopy(d, "csv", true)).toBe(formatWithOptions(d, { ...defaultExportOptions(""), format: "csv" }));
    // Markdown without headers would not be a valid table — headers are forced.
    expect(formatForCopy(d, "md", false).startsWith("| a | b |")).toBe(true);
    // The TSV bytes keep '' (quoted) and NULL (bare) distinguishable for consumers.
    expect(formatForCopy(d, "tsv", true)).toBe('a\tb\n""\t\n');
  });

  it("escapes pipes and flattens newlines exactly like the Rust file exporter", () => {
    const out = toMarkdown({ columns: ["a|b"], rows: [["x\\|y\r\nz"]] });
    expect(out).toContain("| a\\|b |");
    expect(out).toContain("| x\\\\|y\r z |");
  });

  it("rejects ragged rows and duplicate JSON object keys", () => {
    expect(() => toTSV({ columns: ["a", "b"], rows: [["x"]] })).toThrow(/rectangular/i);
    expect(() => toJSON({ columns: ["same", "same"], rows: [["a", "b"]] })).toThrow(/unique/i);
    expect(() => toTSV({ columns: ["a"], rows: [["x".repeat(1_000_001)]] })).toThrow(/oversized/i);
  });

  it("uses safe PostgreSQL literals in legacy SQL output", () => {
    expect(toSQL({ columns: ["v"], rows: [["a\\b'c"]] }, 't"x')).toBe(
      `INSERT INTO "t""x" ("v") VALUES (E'a\\\\b''c');`,
    );
  });
});

describe("formatWithOptions boolean mapping", () => {
  it("csv maps only boolCols; NULL and non-bool columns untouched", () => {
    const out = formatWithOptions(data, opts({ format: "csv" }));
    expect(out).toBe("id,active,note\n1,TRUE,t\n2,FALSE,plain\n3,,\n");
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

  it("markdown matches backend escaping and line normalization", () => {
    const d: Dataset = { columns: ["a|b"], rows: [["x\\|y\r\nz"]] };
    const out = formatWithOptions(d, opts({ format: "markdown", boolCols: [] }));
    expect(out).toBe("| a\\|b |\n| --- |\n| x\\\\|y\r z |\n");
  });

  it("unrecognized tokens in a bool column pass through raw", () => {
    const d: Dataset = { columns: ["b"], rows: [["maybe"], ["1"], ["0"]] };
    const out = formatWithOptions(d, { ...defaultExportOptions("x"), format: "csv", boolCols: [0] });
    // 1/0 are recognized tokens (SQLite/MySQL numeric booleans); junk stays raw.
    expect(out).toBe("b\nmaybe\nTRUE\nFALSE\n");
  });

  it("no boolCols → byte-identical to the pre-mapping output", () => {
    const out = formatWithOptions(data, opts({ format: "csv", boolCols: [] }));
    expect(out).toBe("id,active,note\n1,t,t\n2,f,plain\n3,,\n");
  });

  it("boolCols are SOURCE indices — survive column projection/reorder", () => {
    const out = formatWithOptions(data, opts({ format: "csv", columnIndices: [2, 1] }));
    expect(out).toBe("note,active\nt,TRUE\nplain,FALSE\n,\n");
  });

  it("rejects ragged rows, invalid projections, and duplicate JSON keys", () => {
    expect(() => formatWithOptions({ columns: ["a", "b"], rows: [["x"]] }, opts({ format: "csv" })))
      .toThrow(/rectangular/i);
    expect(() => formatWithOptions(data, opts({ format: "csv", columnIndices: [99] })))
      .toThrow(/out-of-range/i);
    expect(() => formatWithOptions(
      { columns: ["same", "same"], rows: [["a", "b"]] },
      opts({ format: "json" }),
    )).toThrow(/unique/i);
    expect(() => formatWithOptions(
      { columns: ["a"], rows: Array.from({ length: 100 }, () => [null]) },
      opts({ format: "csv", boolCols: [], nullMode: "custom", nullText: "x".repeat(1_000_000) }),
    )).toThrow(/64 MiB/i);
  });

  it("matches backend SQL dialect quoting and mode-safe values", () => {
    const d: Dataset = { columns: ["co`l"], rows: [["path\\name's"]] };
    const pg = formatWithOptions(d, opts({ format: "sql", boolCols: [], sql: { table: "t", multiRow: false, includeCreate: false } }));
    expect(pg).toContain(`VALUES (E'path\\\\name''s');`);

    setSqlDialect("mysql");
    const mysql = formatWithOptions(d, opts({ format: "sql", boolCols: [], sql: { table: "ta`ble", multiRow: false, includeCreate: true } }));
    expect(mysql).toContain("CREATE TABLE `ta``ble` (`co``l` text);");
    expect(mysql).toContain("CONVERT(X'706174685c6e616d652773' USING utf8mb4)");
  });
});
