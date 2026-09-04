import { afterEach, describe, expect, it } from "vitest";
import { hasDuplicateColumns, hasViewRules, stripTrailingSemi, wrapQuery, wrappableQuery } from "./query";
import { setSqlDialect } from "../sql/ident";

afterEach(() => setSqlDialect("postgres"));

const SORTS = [{ col: 1, dir: "desc" as const }];
const FILTERS = [{ col: 0, text: "abc" }];
const COLS = ["id", "name"];

describe("wrapQuery dialects", () => {
  it("postgres/duckdb use ::text ILIKE", () => {
    for (const d of ["postgres", "duckdb"]) {
      const sql = wrapQuery("SELECT * FROM t;", SORTS, FILTERS, COLS, d);
      expect(sql).toBe(`SELECT * FROM (SELECT * FROM t\n) AS _tusk WHERE "id"::text ILIKE '%abc%' ORDER BY 2 DESC`);
    }
  });

  it("mysql uses CAST AS CHAR + LIKE with backticks", () => {
    setSqlDialect("mysql");
    const sql = wrapQuery("SELECT * FROM t", SORTS, FILTERS, COLS, "mysql");
    expect(sql).toBe("SELECT * FROM (SELECT * FROM t\n) AS _tusk WHERE CAST(`id` AS CHAR) LIKE _utf8mb4 X'2561626325' ORDER BY 2 DESC");
  });

  it("sqlite uses CAST AS TEXT + LIKE", () => {
    const sql = wrapQuery("SELECT * FROM t", SORTS, FILTERS, COLS, "sqlite");
    expect(sql).toBe(`SELECT * FROM (SELECT * FROM t\n) AS _tusk WHERE CAST("id" AS TEXT) LIKE '%abc%' ORDER BY 2 DESC`);
  });

  it("default dialect stays postgres (back-compat)", () => {
    expect(wrapQuery("SELECT 1", [], FILTERS, COLS)).toContain("ILIKE");
  });

  it("escapes quotes in the filter text", () => {
    const sql = wrapQuery("SELECT * FROM t", [], [{ col: 0, text: "o'b" }], COLS, "postgres");
    expect(sql).toContain("'%o''b%'");
  });

  it("rejects duplicate filter targets instead of emitting ambiguous SQL", () => {
    expect(() => wrapQuery("SELECT 1", [], [{ col: 0, text: "x" }], ["same", "same"], "postgres"))
      .toThrow(/duplicate/i);
    expect(() => wrapQuery("SELECT 1", [], [{ col: 0, text: "x" }], ["same", "SAME"], "mysql"))
      .toThrow(/duplicate/i);
    expect(() => wrapQuery("SELECT 1", [], [{ col: 0, text: "x" }], ["same", "SAME"], "postgres"))
      .not.toThrow();
  });
});

describe("hasDuplicateColumns", () => {
  it("detects dups case-insensitively", () => {
    expect(hasDuplicateColumns(["id", "name"])).toBe(false);
    expect(hasDuplicateColumns(["id", "ID"])).toBe(true);
    expect(hasDuplicateColumns(["a", "b", "a"])).toBe(true);
    expect(hasDuplicateColumns([])).toBe(false);
  });
});

describe("existing helpers", () => {
  it("wrappableQuery + stripTrailingSemi unchanged", () => {
    expect(wrappableQuery("SELECT 1;")).toBe(true);
    expect(wrappableQuery("UPDATE t SET a=1")).toBe(false);
    expect(stripTrailingSemi("  SELECT 1 ;  ")).toBe("SELECT 1");
  });

  it("handles real terminators/comments safely and refuses scripts or writable CTEs", () => {
    expect(wrappableQuery("-- lead;\nSELECT ';'; -- tail")).toBe(true);
    expect(stripTrailingSemi("SELECT ';'; -- tail")).toBe("SELECT ';' -- tail");
    expect(wrappableQuery("SELECT 1; SELECT 2")).toBe(false);
    expect(wrappableQuery("WITH changed AS (DELETE FROM t RETURNING *) SELECT * FROM changed")).toBe(false);
    expect(wrappableQuery("WITH x AS (\n  -- note\n  UPDATE t SET a=1 RETURNING *\n) SELECT * FROM x")).toBe(false);
    expect(wrappableQuery("WITH x AS (SELECT 1) UPDATE t SET a=1 RETURNING *")).toBe(false);
    expect(wrappableQuery("WITH x AS (SELECT 1) SELECT * INTO archived FROM x")).toBe(false);
    expect(wrapQuery("SELECT 1 -- tail", [], [], ["x"])).toContain("-- tail\n) AS _tusk");
  });

  it("mutation words in harmless positions do not kill wrapping", () => {
    expect(wrappableQuery("SELECT TRUNCATE(price, 2) FROM sales")).toBe(true);
    expect(wrappableQuery("SELECT copy, do, merge FROM audit_log")).toBe(true);
    expect(wrappableQuery("SELECT * FROM t WHERE action = 'delete' AND kind = 'insert'")).toBe(true);
    expect(wrappableQuery("SELECT id AS insert_id, updated_at FROM t")).toBe(true);
    expect(wrappableQuery("WITH recent AS (SELECT * FROM orders) SELECT * FROM recent")).toBe(true);
  });

  it("wraps DuckDB FROM-first reads", () => {
    setSqlDialect("duckdb");
    expect(wrappableQuery("FROM events")).toBe(true);
    expect(wrappableQuery("WITH recent AS (SELECT * FROM events) FROM recent")).toBe(true);
  });
});

describe("hasViewRules", () => {
  it("true for any sort", () => {
    expect(hasViewRules([{ col: 0, dir: "asc" }], [])).toBe(true);
  });
  it("true only for a non-blank filter", () => {
    expect(hasViewRules([], [{ col: 0, text: "x" }])).toBe(true);
    expect(hasViewRules([], [{ col: 0, text: "   " }])).toBe(false);
  });
  it("false when empty", () => {
    expect(hasViewRules([], [])).toBe(false);
  });
});
