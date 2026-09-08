import { describe, it, expect, beforeEach } from "vitest";
import { ident, lit, qualify, setSqlDialect, sqlDialect, withDialect } from "./ident";
import { createTable, dropRelation, renameRelation } from "./ddl";
import { wrapQuery, wrappableQuery } from "../grid/query";
import { buildCommitScript } from "../grid/editSql";
import { formatWithOptions, formatForCopy } from "../formats";
import { defaultExportOptions } from "../export";
import { EMPTY_FILTER } from "../grid/filterModel";

// Several connections are open at once, and the module-level dialect belongs to the
// ACTIVE one. Everything here pins the dialect of the connection the SQL is FOR, so a
// MySQL statement is never emitted with PostgreSQL quoting because a Postgres tab
// happened to have focus. These tests are the regression net for that rule.

beforeEach(() => setSqlDialect("postgres"));

describe("withDialect", () => {
  it("borrows a dialect for one synchronous build and restores the previous one", () => {
    expect(sqlDialect()).toBe("postgres");
    const out = withDialect("mysql", () => {
      expect(sqlDialect()).toBe("mysql");
      return ident("users");
    });
    expect(out).toBe("`users`");
    expect(sqlDialect()).toBe("postgres");
    expect(ident("users")).toBe('"users"');
  });

  it("restores the dialect even when the build throws", () => {
    expect(() => withDialect("mssql", () => { throw new Error("boom"); })).toThrow("boom");
    expect(sqlDialect()).toBe("postgres");
    expect(ident("x")).toBe('"x"');
  });

  it("nests", () => {
    withDialect("mysql", () => {
      withDialect("mssql", () => expect(ident("a")).toBe("[a]"));
      expect(ident("a")).toBe("`a`");
    });
    expect(ident("a")).toBe('"a"');
  });
});

describe("DDL generated for a non-active connection", () => {
  it("emits MySQL backticks while a PostgreSQL connection is active", () => {
    setSqlDialect("postgres"); // the workbench is focused on a Postgres connection
    const sql = withDialect("mysql", () =>
      createTable({
        schema: "app",
        name: "users",
        columns: [{ name: "id", type: "int", nullable: false, default: "", primaryKey: true }],
      }),
    );
    expect(sql).toContain("`app`.`users`");
    expect(sql).toContain("`id`");
    expect(sql).not.toContain('"users"');
    // …and the active connection's own quoting is untouched afterwards.
    expect(qualify("app", "users")).toBe('"app"."users"');
  });

  it("drops and renames with the target connection's quoting", () => {
    setSqlDialect("postgres");
    // MySQL renames with RENAME TABLE, and every identifier is backticked — both
    // facts come from the borrowed dialect, not from the focused connection.
    expect(withDialect("mysql", () => dropRelation("table", "app", "orders", false))).toBe("DROP TABLE `app`.`orders`");
    expect(withDialect("mysql", () => renameRelation("table", "app", "orders", "sales")))
      .toBe("RENAME TABLE `app`.`orders` TO `app`.`sales`");
    // Back on the focused connection, PostgreSQL forms and quoting are unchanged.
    expect(dropRelation("table", "app", "orders", false)).toBe('DROP TABLE "app"."orders"');
    expect(renameRelation("table", "app", "orders", "sales")).toBe('ALTER TABLE "app"."orders" RENAME TO "sales"');
  });

  it("keeps literals dialect-correct too (MySQL hex literals, T-SQL N'')", () => {
    setSqlDialect("postgres");
    expect(withDialect("mysql", () => lit("O'Hara"))).toMatch(/^_utf8mb4 X'[0-9a-f]+'$/);
    expect(withDialect("mssql", () => lit("O'Hara"))).toBe("N'O''Hara'");
    expect(lit("O'Hara")).toBe("'O''Hara'");
  });
});

describe("grid SQL is built for the owning tab's connection", () => {
  it("wraps with the passed dialect, not the module one", () => {
    setSqlDialect("postgres");
    const mysql = withDialect("mysql", () =>
      wrapQuery("SELECT * FROM t", [{ col: 0, dir: "asc" }], EMPTY_FILTER, ["id"], "mysql"),
    );
    expect(mysql).toContain("ORDER BY 1 ASC");
    expect(sqlDialect()).toBe("postgres");
  });

  it("wrappableQuery answers per dialect: T-SQL cannot nest WITH or ORDER BY", () => {
    const withLed = "WITH x AS (SELECT 1) SELECT * FROM x";
    expect(wrappableQuery(withLed, "postgres")).toBe(true);
    expect(wrappableQuery(withLed, "mssql")).toBe(false);
    // The default still follows the active connection, for call sites that have no tab.
    setSqlDialect("mssql");
    expect(wrappableQuery(withLed)).toBe(false);
    setSqlDialect("postgres");
    expect(wrappableQuery(withLed)).toBe(true);
  });

  it("commit scripts quote for input.dialect while another connection is active", () => {
    setSqlDialect("postgres");
    const script = buildCommitScript({
      schema: "app",
      table: "users",
      columns: ["id", "name"],
      isTableCol: [true, true],
      pkIdx: [0],
      rows: [["1", "old"]],
      pending: { cells: { 0: { 1: "new" } }, deletes: [], inserts: [] },
      dialect: "mysql",
    });
    expect(script).toHaveLength(1);
    expect(script[0]).toContain("`app`.`users`");
    expect(script[0]).toContain("`name`");
    expect(script[0]).not.toContain('"name"');
    expect(sqlDialect()).toBe("postgres");
  });
});

describe("export formatting is source-dialect bound", () => {
  const data = { columns: ["id", "name"], rows: [["1", "a'b"]] };

  it("SQL export quotes for the source connection, not the active one", () => {
    setSqlDialect("postgres");
    const options = { ...defaultExportOptions("t"), format: "sql" as const };
    const mysql = formatWithOptions(data, options, "mysql");
    expect(mysql).toContain("`t`");
    const pg = formatWithOptions(data, options, "postgres");
    expect(pg).toContain('"t"');
  });

  it("formatForCopy accepts an explicit source dialect", () => {
    setSqlDialect("mysql");
    const sqlOptions = { ...defaultExportOptions("t"), format: "sql" as const };
    // Default follows the active connection…
    expect(formatWithOptions(data, sqlOptions)).toContain("`t`");
    // …and the explicit argument wins over it.
    expect(formatForCopy(data, "csv", true, "postgres")).toBe(formatForCopy(data, "csv", true, "mysql"));
  });
});
