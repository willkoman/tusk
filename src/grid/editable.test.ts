import { describe, expect, it } from "vitest";
import { editTarget, editPlan } from "./editable";
import { buildIndex, type Table } from "../sql/aliases";
import type { RelationDetail, Column } from "../Tree";

const TABLES: Table[] = [
  { schema: "public", name: "users", columns: [{ name: "id", data_type: "int" }, { name: "email", data_type: "text" }] },
  { schema: "public", name: "orders", columns: [{ name: "id", data_type: "int" }, { name: "user_id", data_type: "int" }] },
];
const IDX = buildIndex(TABLES);

const col = (name: string, is_pk = false): Column => ({
  name, data_type: "text", nullable: !is_pk, is_pk, is_fk: false, default: null, comment: null,
});
const detail = (kind: string, cols: Column[]): RelationDetail => ({
  name: "users", kind, comment: null, columns: cols, indexes: [], constraints: [], triggers: [],
});

describe("editTarget", () => {
  it("accepts a plain single-table SELECT", () => {
    const r = editTarget("SELECT * FROM users", IDX);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.table.name).toBe("users");
  });

  it("accepts aliased + qualified forms and trailing semicolons", () => {
    expect(editTarget('SELECT u.id FROM public."users" u;', IDX).ok).toBe(true);
  });

  it("rejects scripts and empty bases", () => {
    expect(editTarget("", IDX)).toMatchObject({ ok: false });
    expect(editTarget("SELECT 1; SELECT 2", IDX)).toMatchObject({ ok: false });
  });

  it("rejects non-SELECT statements", () => {
    expect(editTarget("UPDATE users SET email='x'", IDX)).toMatchObject({ ok: false });
  });

  it("rejects joins / aggregation / set ops, with reasons", () => {
    for (const q of [
      "SELECT * FROM users u JOIN orders o ON o.user_id = u.id",
      "SELECT email FROM users GROUP BY email",
      "SELECT DISTINCT email FROM users",
      "SELECT id FROM users UNION SELECT id FROM orders",
    ]) {
      const r = editTarget(q, IDX);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it("ignores reject-keywords inside strings and comments", () => {
    expect(editTarget("SELECT * FROM users WHERE email = 'join me' -- union\n", IDX).ok).toBe(true);
  });

  it("rejects unknown tables and table-less selects", () => {
    expect(editTarget("SELECT * FROM nope", IDX)).toMatchObject({ ok: false });
    expect(editTarget("SELECT 1", IDX)).toMatchObject({ ok: false });
  });

  it("rejects expressions/aliases in the select list (wrong-row hazard)", () => {
    // `id*2 AS id` would make the commit WHERE clause target the wrong row.
    for (const q of [
      "SELECT id*2 AS id, email FROM users",
      "SELECT email AS id FROM users",
      "SELECT email e FROM users",
      "SELECT upper(email) FROM users",
      "SELECT CASE WHEN id > 0 THEN 1 ELSE 0 END AS id FROM users",
      "SELECT 1, * FROM users",
      "SELECT (SELECT 1) AS id FROM users",
      "SELECT id || '!' FROM users",
    ]) {
      const r = editTarget(q, IDX);
      expect(r, q).toMatchObject({ ok: false });
    }
  });

  it("rejects WITH/TABLE/VALUES forms", () => {
    expect(editTarget("WITH a AS (SELECT 1) SELECT * FROM users", IDX)).toMatchObject({ ok: false });
    expect(editTarget("TABLE users", IDX)).toMatchObject({ ok: false });
    expect(editTarget("VALUES (1)", IDX)).toMatchObject({ ok: false });
  });

  it("accepts plain and qualified column lists, star forms", () => {
    expect(editTarget("SELECT id, email FROM users", IDX).ok).toBe(true);
    expect(editTarget("SELECT u.id, u.email FROM users u", IDX).ok).toBe(true);
    expect(editTarget("SELECT u.* FROM users u", IDX).ok).toBe(true);
    expect(editTarget('SELECT "id", u."email" FROM users u', IDX).ok).toBe(true);
  });

  it("a subquery in WHERE still finds the top-level FROM", () => {
    // Different table inside the subquery → multi-table reject, not a parse miss.
    const r = editTarget("SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)", IDX);
    expect(r).toMatchObject({ ok: false });
    // Same table in the subquery resolves to a single ref → editable.
    expect(editTarget("SELECT * FROM users WHERE id IN (SELECT id FROM users)", IDX).ok).toBe(true);
  });
});

describe("editPlan", () => {
  const target = TABLES[0];

  it("builds a plan with PK indices and table-column mapping", () => {
    const d = detail("table", [col("id", true), col("email")]);
    const p = editPlan(d, ["id", "email"], target);
    expect(p).toMatchObject({ ok: true, schema: "public", table: "users", pkIdx: [0], isTableCol: [true, true] });
  });

  it("maps composite PKs and flags non-table columns", () => {
    const d = detail("table", [col("a", true), col("b", true), col("v")]);
    const p = editPlan(d, ["b", "computed", "a"], target);
    expect(p).toMatchObject({ ok: true, pkIdx: [2, 0], isTableCol: [true, false, true] });
  });

  it("rejects views, missing PK, missing PK column, dup columns", () => {
    expect(editPlan(detail("view", [col("id", true)]), ["id"], target)).toMatchObject({ ok: false });
    expect(editPlan(detail("table", [col("id")]), ["id"], target)).toMatchObject({ ok: false });
    expect(editPlan(detail("table", [col("id", true)]), ["email"], target)).toMatchObject({ ok: false });
    expect(editPlan(detail("table", [col("id", true)]), ["id", "ID"], target)).toMatchObject({ ok: false });
  });
});
