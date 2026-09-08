import { afterEach, describe, it, expect } from "vitest";
import { formatForCopy, formatWithOptions, toJSON, toMarkdown, toSQL, toTSV, type Dataset } from "./formats";
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

describe("shape-safe formatting", () => {
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
      opts({ format: "sql", sql: { table: "exported", multiRow: false, includeCreate: true, createSql: "" } }),
    );
    expect(out).toContain('CREATE TABLE "exported" ("id" text, "active" boolean, "note" text);');
    expect(out).toContain(`INSERT INTO "exported" ("id", "active", "note") VALUES ('1', TRUE, 't');`);
    expect(out).toContain(`INSERT INTO "exported" ("id", "active", "note") VALUES ('3', NULL, NULL);`);
  });

  // PARITY PAIR with `header_text` in src-tauri/src/export.rs: reconstructed engine DDL
  // replaces the synthetic all-text CREATE, normalized to exactly one trailing `;`.
  it("sql uses reconstructed engine DDL when one is supplied", () => {
    const out = formatWithOptions(
      data,
      opts({
        format: "sql",
        sql: {
          table: "exported",
          multiRow: false,
          includeCreate: true,
          createSql: 'CREATE TABLE "exported" ("id" integer NOT NULL);\n',
        },
      }),
    );
    expect(out.startsWith('CREATE TABLE "exported" ("id" integer NOT NULL);\n')).toBe(true);
    expect(out).not.toContain('"active" boolean');
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
    const pg = formatWithOptions(d, opts({ format: "sql", boolCols: [], sql: { table: "t", multiRow: false, includeCreate: false, createSql: "" } }));
    expect(pg).toContain(`VALUES (E'path\\\\name''s');`);

    setSqlDialect("mysql");
    const mysql = formatWithOptions(d, opts({ format: "sql", boolCols: [], sql: { table: "ta`ble", multiRow: false, includeCreate: true, createSql: "" } }));
    expect(mysql).toContain("CREATE TABLE `ta``ble` (`co``l` text);");
    expect(mysql).toContain("CONVERT(X'706174685c6e616d652773' USING utf8mb4)");

    setSqlDialect("mssql");
    const mssql = formatWithOptions(
      { columns: ["co]l", "flag"], rows: [["path\\name's", "true"], [null, "false"]] },
      opts({ format: "sql", boolCols: [1], sql: { table: "ta]ble", multiRow: false, includeCreate: true, createSql: "" } }),
    );
    // T-SQL has no boolean type or TRUE/FALSE literal — `bit` takes 1/0.
    expect(mssql).toContain("CREATE TABLE [ta]]ble] ([co]]l] nvarchar(max), [flag] bit);");
    expect(mssql).toContain("VALUES (N'path\\name''s', 1);");
    expect(mssql).toContain("VALUES (NULL, 0);");
  });
});
