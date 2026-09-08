import { describe, expect, it } from "vitest";
import {
  autoMatch,
  buildTarget,
  conflictLabel,
  defaultImportOptions,
  existingTableMapping,
  formatForFile,
  inferType,
  inferTypes,
  mappingIssues,
  newTableMapping,
  runOptions,
  sqlTypeFor,
  tableNameFromFile,
  tokenForDeclaredType,
  type ImportColumnMapping,
  type ImportColumnType,
} from "./import";

describe("format detection", () => {
  it("picks the parser and delimiter from the extension", () => {
    expect(formatForFile("a.CSV")).toEqual({ format: "csv", delimiter: "comma" });
    expect(formatForFile("a.tsv")).toEqual({ format: "csv", delimiter: "tab" });
    expect(formatForFile("a.ndjson")).toEqual({ format: "json", delimiter: "comma" });
    expect(formatForFile("a.xlsx")).toEqual({ format: "xlsx", delimiter: "comma" });
    expect(formatForFile("a.dat")).toEqual({ format: "csv", delimiter: "comma" });
    expect(defaultImportOptions("a.tsv").delimiter).toBe("tab");
  });

  it("derives a table name from a file name", () => {
    expect(tableNameFromFile("/tmp/Sales Report-2024.csv")).toBe("sales_report_2024");
    expect(tableNameFromFile("...")).toBe("imported");
  });
});

describe("type inference", () => {
  it("prefers integers over booleans for 0/1 columns", () => {
    expect(inferType(["0", "1", "1"])).toBe("integer");
    expect(inferType(["true", "false", "YES"])).toBe("boolean");
  });

  it("widens to bigint past the 32-bit range", () => {
    expect(inferType(["1", "1073741823"])).toBe("integer");
    expect(inferType(["1", "2147483648"])).toBe("bigint");
    expect(inferType(["-2147483649"])).toBe("bigint");
  });

  it("biases away from integer near the 32-bit edge", () => {
    // The sample is at most 50 rows: a column already at ~1e9 is one row away from
    // an int4 the engine would reject after a long load.
    expect(inferType(["2147483647"])).toBe("bigint");
    expect(inferType(["1", "2000000000"])).toBe("bigint");
  });

  it("falls back to text when a value would not fit the loader's i64 coercion", () => {
    // PARITY: `literal`/`copy_line` in src-tauri/src/import.rs reject these outright,
    // so inferring bigint would fail the whole import at row 1.
    expect(inferType(["12345678901234567890"])).toBe("text");
    expect(inferType(["1", "-99999999999999999999"])).toBe("text");
    expect(inferType(["9223372036854775807"])).toBe("bigint");
  });

  it("detects decimals, dates and timestamps", () => {
    expect(inferType(["1.5", "-2", "3e4"])).toBe("numeric");
    expect(inferType(["2024-01-02", "1999-12-31"])).toBe("date");
    expect(inferType(["2024-01-02 03:04:05", "2024-01-02T03:04:05Z"])).toBe("timestamp");
    expect(inferType(["2024-01-02", "2024-01-02 03:04"])).toBe("timestamp");
  });

  it("ignores blanks and falls back to text", () => {
    expect(inferType([null, "", "  "])).toBe("text");
    expect(inferType([null, "7", ""])).toBe("integer");
    expect(inferType(["7", "seven"])).toBe("text");
  });

  // PARITY FIXTURE — mirrored verbatim by `inference_and_coercion_agree` in
  // src-tauri/src/import.rs. Every column the preview types this way must be a column
  // the loader can actually coerce those same values into; a disagreement is a load
  // that dies half-way through with "row N is not a valid …".
  it("only infers a type the backend loader accepts", () => {
    const fixture: [string[], ImportColumnType][] = [
      [["1", "2", " ", "3"], "integer"], // a whitespace-only cell is blank, not data
      [["4", "-3", "42"], "integer"], // TINYINT values outside 0/1 are integers
      [["0", "1", "1"], "integer"],
      [["1", "2000000000"], "bigint"],
      [["12345678901234567890"], "text"], // wider than i64
      [["1.5", "-2", ".5"], "numeric"],
      [["true", "no", "Y"], "boolean"],
      [["2024-01-01", "2024-12-31"], "date"],
      [["2024-01-01T00:00:00Z", "2024-06-02 03:04"], "timestamp"],
    ];
    for (const [values, token] of fixture) expect(inferType(values)).toBe(token);
  });

  it("infers a whole preview column-wise", () => {
    expect(
      inferTypes(
        ["id", "name", "flag"],
        [
          ["1", "a", "true"],
          ["2", "b", "false"],
        ],
      ),
    ).toEqual(["integer", "text", "boolean"]);
  });
});

describe("declared-type tokens and DDL parity", () => {
  it("maps engine types onto import tokens, defaulting to text", () => {
    expect(tokenForDeclaredType("character varying(20)")).toBe("text");
    expect(tokenForDeclaredType("BOOLEAN")).toBe("boolean");
    // MySQL reports `tinyint` for every width and DuckDB's TINYINT is a 1-byte int:
    // mapping it to boolean rejected any value outside 0/1.
    expect(tokenForDeclaredType("tinyint(1)")).toBe("integer");
    expect(tokenForDeclaredType("tinyint")).toBe("integer");
    expect(tokenForDeclaredType("int4")).toBe("integer");
    expect(tokenForDeclaredType("bigint")).toBe("bigint");
    expect(tokenForDeclaredType("numeric(10,2)")).toBe("numeric");
    expect(tokenForDeclaredType("DOUBLE")).toBe("numeric");
    expect(tokenForDeclaredType("timestamp with time zone")).toBe("timestamp");
    expect(tokenForDeclaredType("jsonb")).toBe("text");
  });

  // PARITY PAIR with `create_sql_maps_types_per_engine` in src-tauri/src/import.rs.
  it("renders the same CREATE types the backend uses", () => {
    expect(sqlTypeFor("numeric", "postgres")).toBe("numeric");
    expect(sqlTypeFor("numeric", "duckdb")).toBe("DOUBLE");
    expect(sqlTypeFor("numeric", "mysql")).toBe("DECIMAL(38,10)");
    expect(sqlTypeFor("boolean", "sqlite")).toBe("INTEGER");
    expect(sqlTypeFor("bigint", "sqlite")).toBe("INTEGER");
    expect(sqlTypeFor("text", "duckdb")).toBe("VARCHAR");
  });
});

describe("column mapping", () => {
  it("matches exactly first, then normalized, and never reuses a source", () => {
    expect(autoMatch(["User ID", "name", "id"], ["id", "user_id", "email"])).toEqual([2, 0, null]);
  });

  it("builds a new-table mapping straight from the file", () => {
    const mapping = newTableMapping(["id", "name"], ["integer", "text"]);
    expect(mapping).toEqual([
      { source: 0, target: "id", type: "integer", emptyAsNull: true },
      { source: 1, target: "name", type: "text", emptyAsNull: false },
    ]);
  });

  it("builds an existing-table mapping from the catalog", () => {
    const mapping = existingTableMapping(
      ["name", "id"],
      [
        { name: "id", data_type: "integer" },
        { name: "name", data_type: "text" },
        { name: "extra", data_type: "text" },
      ],
    );
    expect(mapping.map((m) => m.source)).toEqual([1, 0, null]);
    expect(mapping[0].type).toBe("integer");
    expect(mapping[0].emptyAsNull).toBe(true);
  });
});

describe("validation and payloads", () => {
  const mapping: ImportColumnMapping[] = [
    { source: 0, target: "id", type: "integer", emptyAsNull: false },
    { source: 1, target: "name", type: "text", emptyAsNull: true },
    { source: null, target: "extra", type: "text", emptyAsNull: false },
  ];

  it("flags empty tables, unmapped everything and duplicate targets", () => {
    const none = mappingIssues([], { table: "", conflict: "error", keyColumns: [] }, "postgres");
    expect(none.filter((i) => i.level === "error").length).toBe(2);
    const dup: ImportColumnMapping[] = [
      { source: 0, target: "id", type: "text", emptyAsNull: false },
      { source: 1, target: "ID", type: "text", emptyAsNull: false },
    ];
    expect(
      mappingIssues(dup, { table: "t", conflict: "error", keyColumns: [] }, "postgres"),
    ).toContainEqual({ level: "error", message: "A target column is mapped twice." });
  });

  it("warns about skipped columns and engine upsert semantics", () => {
    const issues = mappingIssues(mapping, { table: "t", conflict: "error", keyColumns: [] }, "postgres");
    expect(issues).toEqual([
      { level: "warning", message: "1 column is skipped and will keep the table's default." },
    ]);
    const pgUpsert = mappingIssues(mapping, { table: "t", conflict: "update", keyColumns: [] }, "postgres");
    expect(pgUpsert.some((i) => i.level === "error" && /conflict key/i.test(i.message))).toBe(true);
    const sqliteUpsert = mappingIssues(
      mapping,
      { table: "t", conflict: "update", keyColumns: ["id"] },
      "sqlite",
    );
    expect(sqliteUpsert.every((i) => i.level === "warning")).toBe(true);
  });

  it("drops skipped columns and unmapped keys from the command payload", () => {
    const target = buildTarget(mapping, {
      schema: "public",
      table: "t",
      create: false,
      truncate: true,
      conflict: "update",
      keyColumns: ["id", "extra"],
    });
    expect(target.columns).toEqual([
      { source: 0, target: "id", type: "integer", emptyAsNull: false },
      { source: 1, target: "name", type: "text", emptyAsNull: true },
    ]);
    expect(target.keyColumns).toEqual(["id"]);
    expect(target.truncate).toBe(true);
    // Key columns are only meaningful for an upsert.
    expect(
      buildTarget(mapping, {
        schema: "public",
        table: "t",
        create: false,
        truncate: false,
        conflict: "ignore",
        keyColumns: ["id"],
      }).keyColumns,
    ).toEqual([]);
  });

  it("pins the preview's columns into the run options", () => {
    const options = runOptions(defaultImportOptions("a.csv"), ["id", "name"]);
    expect(options.sourceColumns).toEqual(["id", "name"]);
  });

  it("labels the conflict modes per engine", () => {
    expect(conflictLabel("ignore", "mysql")).toMatch(/INSERT IGNORE/);
    expect(conflictLabel("ignore", "sqlite")).toMatch(/INSERT OR IGNORE/);
    expect(conflictLabel("update", "postgres")).toMatch(/ON CONFLICT DO UPDATE/);
    expect(conflictLabel("update", "duckdb")).toMatch(/INSERT OR REPLACE/);
    expect(conflictLabel("error", "postgres")).toMatch(/Fail/);
  });
});
