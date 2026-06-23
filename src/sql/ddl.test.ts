import { afterEach, describe, expect, it } from "vitest";
import { setSqlDialect } from "./ident";
import { addColumn, editColumn, tableDiff, createIndex, duplicateTable, createSchema, truncate, type DiffColumn } from "./ddl";

// The builders are dialect-aware via the module-level dialect. DuckDB diverges from
// Postgres: one ALTER action per statement, no constraints on ADD COLUMN, CTAS instead
// of LIKE, no AUTHORIZATION / TRUNCATE options. Reset to postgres after each test.
afterEach(() => setSqlDialect("postgres"));

describe("addColumn", () => {
  it("postgres: inline constraints, single statement", () => {
    setSqlDialect("postgres");
    expect(addColumn("s", "t", { name: "c", type: "int", nullable: false, default: "0" })).toBe(
      `ALTER TABLE "s"."t" ADD COLUMN "c" int DEFAULT 0 NOT NULL`,
    );
  });
  it("duckdb: plain add for a nullable column", () => {
    setSqlDialect("duckdb");
    expect(addColumn("s", "t", { name: "c", type: "INTEGER", nullable: true, default: "" })).toBe(
      `ALTER TABLE "s"."t" ADD COLUMN "c" INTEGER`,
    );
  });
  it("duckdb: NOT NULL + default → add, set default, set not null (one action per stmt)", () => {
    setSqlDialect("duckdb");
    expect(addColumn("s", "t", { name: "c", type: "INTEGER", nullable: false, default: "0" })).toBe(
      [
        `ALTER TABLE "s"."t" ADD COLUMN "c" INTEGER`,
        `ALTER TABLE "s"."t" ALTER COLUMN "c" SET DEFAULT 0`,
        `ALTER TABLE "s"."t" ALTER COLUMN "c" SET NOT NULL`,
      ].join(";\n"),
    );
  });
  it("duckdb: primary-key column adds the PK separately", () => {
    setSqlDialect("duckdb");
    expect(addColumn("s", "t", { name: "id", type: "INTEGER", nullable: false, default: "", primaryKey: true })).toBe(
      [`ALTER TABLE "s"."t" ADD COLUMN "id" INTEGER`, `ALTER TABLE "s"."t" ADD PRIMARY KEY ("id")`].join(";\n"),
    );
  });
});

describe("editColumn", () => {
  it("postgres: combines actions in one ALTER", () => {
    setSqlDialect("postgres");
    expect(editColumn("s", "t", "c", { type: "bigint", notNull: true, setDefault: "0" })).toBe(
      `ALTER TABLE "s"."t" ALTER COLUMN "c" TYPE bigint, ALTER COLUMN "c" SET NOT NULL, ALTER COLUMN "c" SET DEFAULT 0`,
    );
  });
  it("duckdb: one ALTER per action", () => {
    setSqlDialect("duckdb");
    expect(editColumn("s", "t", "c", { type: "bigint", notNull: true, setDefault: "0" })).toBe(
      [
        `ALTER TABLE "s"."t" ALTER COLUMN "c" TYPE bigint`,
        `ALTER TABLE "s"."t" ALTER COLUMN "c" SET NOT NULL`,
        `ALTER TABLE "s"."t" ALTER COLUMN "c" SET DEFAULT 0`,
      ].join(";\n"),
    );
  });
});

const origCol = (over: Partial<DiffColumn> = {}): DiffColumn => ({
  orig: { name: "a", type: "int", nullable: true, default: "", comment: "" },
  name: "a",
  type: "int",
  nullable: true,
  default: "",
  comment: "",
  isPk: false,
  origPk: false,
  dropped: false,
  ...over,
});
const newCol = (over: Partial<DiffColumn>): DiffColumn => ({
  orig: null,
  name: "",
  type: "",
  nullable: true,
  default: "",
  comment: "",
  isPk: false,
  origPk: false,
  dropped: false,
  ...over,
});

describe("tableDiff add-column", () => {
  const spec = (cols: DiffColumn[]) => ({
    schema: "s",
    table: "t",
    newName: "t",
    newComment: "",
    origComment: "",
    columns: cols,
    dropIndexes: [],
    dropConstraints: [],
  });
  it("duckdb: splits a new NOT NULL column with a default", () => {
    setSqlDialect("duckdb");
    const out = tableDiff(spec([newCol({ name: "c", type: "INTEGER", nullable: false, default: "0" })]));
    expect(out).toBe(
      [
        `ALTER TABLE "s"."t" ADD COLUMN "c" INTEGER`,
        `ALTER TABLE "s"."t" ALTER COLUMN "c" SET DEFAULT 0`,
        `ALTER TABLE "s"."t" ALTER COLUMN "c" SET NOT NULL`,
      ].join(";\n"),
    );
  });
  it("postgres: inline new column", () => {
    setSqlDialect("postgres");
    const out = tableDiff(spec([newCol({ name: "c", type: "INTEGER", nullable: false, default: "0" })]));
    expect(out).toBe(`ALTER TABLE "s"."t" ADD COLUMN "c" INTEGER DEFAULT 0 NOT NULL`);
  });
  it("per-column type change is one statement on both dialects", () => {
    setSqlDialect("duckdb");
    const out = tableDiff(spec([origCol({ type: "bigint" })]));
    expect(out).toBe(`ALTER TABLE "s"."t" ALTER COLUMN "a" TYPE bigint`);
  });
});

describe("dialect-specific syntax", () => {
  it("createIndex omits USING on duckdb", () => {
    setSqlDialect("duckdb");
    expect(createIndex({ schema: "s", table: "t", unique: false, method: "hash", columns: ["a"] })).toBe(
      `CREATE INDEX ON "s"."t" ("a")`,
    );
    setSqlDialect("postgres");
    expect(createIndex({ schema: "s", table: "t", unique: false, method: "hash", columns: ["a"] })).toBe(
      `CREATE INDEX ON "s"."t" USING hash ("a")`,
    );
  });
  it("duplicateTable uses CTAS on duckdb, LIKE on postgres", () => {
    setSqlDialect("duckdb");
    expect(duplicateTable("s", "t", "t2", false)).toBe(`CREATE TABLE "s"."t2" AS SELECT * FROM "s"."t" LIMIT 0`);
    expect(duplicateTable("s", "t", "t2", true)).toBe(`CREATE TABLE "s"."t2" AS SELECT * FROM "s"."t"`);
    setSqlDialect("postgres");
    expect(duplicateTable("s", "t", "t2", false)).toBe(`CREATE TABLE "s"."t2" (LIKE "s"."t" INCLUDING ALL)`);
  });
  it("createSchema drops AUTHORIZATION on duckdb", () => {
    setSqlDialect("duckdb");
    expect(createSchema("s1", "owner")).toBe(`CREATE SCHEMA "s1"`);
    setSqlDialect("postgres");
    expect(createSchema("s1", "owner")).toBe(`CREATE SCHEMA "s1" AUTHORIZATION "owner"`);
  });
  it("truncate drops options on duckdb", () => {
    setSqlDialect("duckdb");
    expect(truncate("s", "t", { cascade: true, restartIdentity: true })).toBe(`TRUNCATE TABLE "s"."t"`);
    setSqlDialect("postgres");
    expect(truncate("s", "t", { cascade: true, restartIdentity: true })).toBe(`TRUNCATE TABLE "s"."t" RESTART IDENTITY CASCADE`);
  });
});
