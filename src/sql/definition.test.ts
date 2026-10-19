import { afterEach, describe, expect, it } from "vitest";
import { constraintDefinition, constraintLabel, indexDefinition, terminated, triggerDefinition } from "./definition";
import { setSqlDialect, withDialect } from "./ident";

afterEach(() => setSqlDialect("postgres"));

describe("definition viewer text", () => {
  it("terminates once", () => {
    expect(terminated("SELECT 1")).toBe("SELECT 1;");
    expect(terminated("SELECT 1;  \n")).toBe("SELECT 1;");
  });

  it("renders a constraint as the ALTER that adds it where the engine can", () => {
    setSqlDialect("postgres");
    const sql = constraintDefinition("public", "orders", { name: "orders_user_fk", kind: "foreign_key", def: "FOREIGN KEY (user_id) REFERENCES users(id)" }, true);
    expect(sql).toBe(
      "-- Foreign key constraint orders_user_fk on public.orders\n" +
        'ALTER TABLE "public"."orders"\n  ADD CONSTRAINT "orders_user_fk" FOREIGN KEY (user_id) REFERENCES users(id);\n',
    );
  });

  it("shows the bare clause where ALTER TABLE cannot add it, quoted for the engine", () => {
    const sql = withDialect("sqlite", () =>
      constraintDefinition("main", "t", { name: "ck_qty", kind: "check", def: "CHECK (qty > 0)" }, false));
    expect(sql).toContain("-- Check constraint ck_qty on main.t\n");
    expect(sql).toContain("cannot add it with ALTER TABLE");
    expect(sql.trimEnd().endsWith('CONSTRAINT "ck_qty" CHECK (qty > 0)')).toBe(true);
  });

  it("keeps a newline in a name from breaking out of the comment", () => {
    const sql = constraintDefinition("s", "t", { name: "a\nDROP TABLE x", kind: "unique", def: "UNIQUE (a)" }, true);
    expect(sql.split("\n")[0]).toBe("-- Unique constraint a DROP TABLE x on s.t");
  });

  it("labels unknown constraint kinds readably", () => {
    expect(constraintLabel("exclusion")).toBe("Exclusion");
    expect(constraintLabel("")).toBe("Constraint");
  });

  it("renders index and trigger definitions, and says when there is none", () => {
    expect(indexDefinition("public", "t", { name: "t_a_idx", unique: false, primary: false, def: "CREATE INDEX t_a_idx ON public.t USING btree (a)", columns: ["a"] }))
      .toBe("-- Index t_a_idx on public.t\n-- Key columns: a\nCREATE INDEX t_a_idx ON public.t USING btree (a);\n");
    expect(indexDefinition("main", "t", { name: "sqlite_autoindex_t_1", unique: true, primary: false, def: "" }))
      .toContain("keeps no definition text");
    expect(triggerDefinition("public", "t", { name: "trg", def: "CREATE TRIGGER trg BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION f()" }))
      .toBe("-- Trigger trg on public.t\nCREATE TRIGGER trg BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION f();\n");
  });
});
