import { afterEach, describe, expect, it } from "vitest";
import { hasDuplicateColumns, hasViewRules, stripTrailingSemi, wrapQuery, wrappableQuery } from "./query";
import { emptyFilter, makeCondition, type FilterTree } from "./filterModel";
import { setSqlDialect } from "../sql/ident";

afterEach(() => setSqlDialect("postgres"));

const SORTS = [{ col: 1, dir: "desc" as const }];
const COLS = ["id", "name"];
/** The header quick filter: a root AND of one `contains` condition. */
const quick = (column: string, text: string): FilterTree => ({
  ...emptyFilter(),
  items: [makeCondition(column, "contains", [text])],
});
const FILTERS = quick("id", "abc");
const NONE = emptyFilter();

describe("wrapQuery dialects", () => {
  it("postgres/duckdb use ::text ILIKE", () => {
    for (const d of ["postgres", "duckdb"]) {
      const sql = wrapQuery("SELECT * FROM t;", SORTS, FILTERS, COLS, d);
      expect(sql).toBe(
        `SELECT * FROM (SELECT * FROM t\n) AS _tusk WHERE "id"::text ILIKE '%abc%' ESCAPE '!' ORDER BY 2 DESC`,
      );
    }
  });

  it("mysql casts to CHAR and folds case explicitly, with backticks", () => {
    setSqlDialect("mysql");
    const sql = wrapQuery("SELECT * FROM t", SORTS, FILTERS, COLS, "mysql");
    expect(sql).toBe(
      "SELECT * FROM (SELECT * FROM t\n) AS _tusk WHERE LOWER(CAST(`id` AS CHAR)) LIKE LOWER(_utf8mb4 X'2561626325') ESCAPE '!' ORDER BY 2 DESC",
    );
  });

  it("sqlite casts to TEXT and folds case explicitly", () => {
    const sql = wrapQuery("SELECT * FROM t", SORTS, FILTERS, COLS, "sqlite");
    expect(sql).toBe(
      `SELECT * FROM (SELECT * FROM t\n) AS _tusk WHERE LOWER(CAST("id" AS TEXT)) LIKE LOWER('%abc%') ESCAPE '!' ORDER BY 2 DESC`,
    );
  });

  it("default dialect stays postgres (back-compat)", () => {
    expect(wrapQuery("SELECT 1", [], FILTERS, COLS)).toContain("ILIKE");
  });

  it("escapes quotes in the filter text", () => {
    const sql = wrapQuery("SELECT * FROM t", [], quick("id", "o'b"), COLS, "postgres");
    expect(sql).toContain("'%o''b%'");
  });

  it("rejects duplicate filter targets instead of emitting ambiguous SQL", () => {
    expect(() => wrapQuery("SELECT 1", [], quick("same", "x"), ["same", "same"], "postgres")).toThrow(/duplicate/i);
    expect(() => wrapQuery("SELECT 1", [], quick("same", "x"), ["same", "SAME"], "mysql")).toThrow(/duplicate/i);
    expect(() => wrapQuery("SELECT 1", [], quick("same", "x"), ["same", "SAME"], "postgres")).not.toThrow();
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
    expect(wrapQuery("SELECT 1 -- tail", [], NONE, ["x"])).toContain("-- tail\n) AS _tusk");
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

  it("mssql casts to nvarchar and refuses shapes a derived table cannot hold", () => {
    setSqlDialect("mssql");
    expect(wrapQuery("SELECT * FROM t", SORTS, FILTERS, COLS, "mssql")).toBe(
      "SELECT * FROM (SELECT * FROM t\n) AS _tusk WHERE LOWER(CAST([id] AS VARCHAR(MAX))) LIKE LOWER(N'%abc%') ESCAPE '!' ORDER BY 2 DESC",
    );
    expect(wrappableQuery("SELECT * FROM t")).toBe(true);
    // T-SQL rejects WITH inside a derived table.
    expect(wrappableQuery("WITH recent AS (SELECT * FROM t) SELECT * FROM recent")).toBe(false);
    // Those words only matter as real code.
    expect(wrappableQuery("SELECT 'order by' AS x FROM t")).toBe(true);
    expect(wrappableQuery("SELECT [order by] FROM t")).toBe(true);
  });

  // Previously ANY ordered SQL Server query was unfilterable: the wrap put the ORDER BY
  // inside the derived table, which T-SQL rejects, so the button was disabled — and the
  // tooltip told the user to add the very clause that had disabled it.
  it("mssql lifts a trailing ORDER BY out of the derived table", () => {
    setSqlDialect("mssql");
    expect(wrappableQuery("SELECT * FROM dbo.books ORDER BY id")).toBe(true);
    // With no grid sort the base ordering becomes the wrapper's, after the WHERE.
    expect(wrapQuery("SELECT * FROM dbo.books ORDER BY id;", [], FILTERS, COLS, "mssql")).toBe(
      "SELECT * FROM (SELECT * FROM dbo.books\n) AS _tusk WHERE LOWER(CAST([id] AS VARCHAR(MAX))) LIKE LOWER(N'%abc%') ESCAPE '!' ORDER BY id",
    );
    // A grid sort is the explicit intent and replaces it.
    expect(wrapQuery("SELECT * FROM dbo.books ORDER BY id DESC", SORTS, NONE, COLS, "mssql")).toBe(
      "SELECT * FROM (SELECT * FROM dbo.books\n) AS _tusk ORDER BY 2 DESC",
    );
    // Multi-key ordering travels as one clause.
    expect(wrapQuery("SELECT * FROM t ORDER BY a ASC, b DESC", [], NONE, COLS, "mssql")).toBe(
      "SELECT * FROM (SELECT * FROM t\n) AS _tusk ORDER BY a ASC, b DESC",
    );
    // Only on SQL Server: every other engine nests an ORDER BY happily.
    expect(wrapQuery("SELECT * FROM t ORDER BY a", [], NONE, COLS, "postgres")).toBe(
      "SELECT * FROM (SELECT * FROM t ORDER BY a\n) AS _tusk",
    );
  });

  it("mssql still refuses an ordering the wrap cannot hoist", () => {
    setSqlDialect("mssql");
    // OFFSET/FETCH pagination has to stay inside: filtering before it would change which
    // rows the page holds. T-SQL accepts an ordered subquery once OFFSET is there.
    expect(wrappableQuery("SELECT * FROM t ORDER BY id OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY")).toBe(false);
    // Window ordering and ordered subqueries are not top level and are not hoisted.
    expect(wrappableQuery("SELECT ROW_NUMBER() OVER (ORDER BY id) AS n FROM t")).toBe(false);
    expect(wrappableQuery("SELECT * FROM (SELECT TOP 5 * FROM t ORDER BY id) x")).toBe(false);
    // A CTE still blocks the wrap even with a liftable trailing clause.
    expect(wrappableQuery("WITH r AS (SELECT * FROM t) SELECT * FROM r ORDER BY id")).toBe(false);
  });
});

describe("hasViewRules", () => {
  it("true for any sort", () => {
    expect(hasViewRules([{ col: 0, dir: "asc" }], NONE, COLS)).toBe(true);
  });
  it("true only for a filter that will actually generate SQL", () => {
    expect(hasViewRules([], quick("id", "x"), COLS)).toBe(true);
    // Incomplete (no value) contributes nothing.
    expect(hasViewRules([], { ...emptyFilter(), items: [makeCondition("id", "eq", [])] }, COLS)).toBe(false);
    // A rule naming a column this result no longer has renders as nothing, so it
    // must not force every re-run through the server wrapper (which would keep
    // the in-memory sort permanently disabled).
    expect(hasViewRules([], quick("gone", "x"), COLS)).toBe(false);
    expect(hasViewRules([], quick("gone", "x"), ["gone"])).toBe(true);
  });
  it("false when empty", () => {
    expect(hasViewRules([], NONE, COLS)).toBe(false);
  });
});
