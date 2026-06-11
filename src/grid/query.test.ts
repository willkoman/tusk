import { afterEach, describe, expect, it } from "vitest";
import { hasDuplicateColumns, stripTrailingSemi, wrapQuery, wrappableQuery } from "./query";
import { setSqlDialect } from "../sql/ident";

afterEach(() => setSqlDialect("postgres"));

const SORTS = [{ col: 1, dir: "desc" as const }];
const FILTERS = [{ col: 0, text: "abc" }];
const COLS = ["id", "name"];

describe("wrapQuery dialects", () => {
  it("postgres/duckdb use ::text ILIKE", () => {
    for (const d of ["postgres", "duckdb"]) {
      const sql = wrapQuery("SELECT * FROM t;", SORTS, FILTERS, COLS, d);
      expect(sql).toBe(`SELECT * FROM (SELECT * FROM t) AS _tusk WHERE "id"::text ILIKE '%abc%' ORDER BY 2 DESC`);
    }
  });

  it("mysql uses CAST AS CHAR + LIKE with backticks", () => {
    setSqlDialect("mysql");
    const sql = wrapQuery("SELECT * FROM t", SORTS, FILTERS, COLS, "mysql");
    expect(sql).toBe("SELECT * FROM (SELECT * FROM t) AS _tusk WHERE CAST(`id` AS CHAR) LIKE '%abc%' ORDER BY 2 DESC");
  });

  it("sqlite uses CAST AS TEXT + LIKE", () => {
    const sql = wrapQuery("SELECT * FROM t", SORTS, FILTERS, COLS, "sqlite");
    expect(sql).toBe(`SELECT * FROM (SELECT * FROM t) AS _tusk WHERE CAST("id" AS TEXT) LIKE '%abc%' ORDER BY 2 DESC`);
  });

  it("default dialect stays postgres (back-compat)", () => {
    expect(wrapQuery("SELECT 1", [], FILTERS, COLS)).toContain("ILIKE");
  });

  it("escapes quotes in the filter text", () => {
    const sql = wrapQuery("SELECT * FROM t", [], [{ col: 0, text: "o'b" }], COLS, "postgres");
    expect(sql).toContain("'%o''b%'");
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
});
