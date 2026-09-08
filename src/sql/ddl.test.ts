import { afterEach, describe, expect, it } from "vitest";
import { setSqlDialect } from "./ident";
import {
  addColumn,
  commentOnColumn,
  commentOnTable,
  createIndex,
  createSchema,
  createTable,
  dropColumn,
  dropConstraint,
  dropIndex,
  duplicateTable,
  editColumn,
  needsRebuild,
  renameColumn,
  renameRelation,
  scriptNote,
  tableDiff,
  truncate,
  validateColumns,
  type DiffColumn,
} from "./ddl";

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

// ---------------------------------------------------------------------------
// Per-dialect builder forms. The exact strings below are mirrored as fixtures in
// `src-tauri/src/driver_conformance.rs` (`*_ddl_builder_forms_apply`), which executes
// them on a real engine — so a drift here is caught there, and vice versa.
// ---------------------------------------------------------------------------

describe("createTable · postgres", () => {
  it("identity key, inline unique/check, table + column comments", () => {
    setSqlDialect("postgres");
    expect(
      createTable({
        schema: "public",
        name: "orders",
        ifNotExists: true,
        comment: "customer orders",
        columns: [
          { name: "id", type: "bigint", nullable: false, default: "", primaryKey: true, identity: true },
          { name: "code", type: "text", nullable: false, default: "", unique: true, comment: "order code" },
          { name: "qty", type: "integer", nullable: false, default: "0", check: "qty > 0" },
        ],
      }),
    ).toBe(
      [
        `CREATE TABLE IF NOT EXISTS "public"."orders" (`,
        `  "id" bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,`,
        `  "code" text NOT NULL UNIQUE,`,
        `  "qty" integer DEFAULT 0 NOT NULL CHECK (qty > 0)`,
        `);`,
        `COMMENT ON TABLE "public"."orders" IS 'customer orders';`,
        `COMMENT ON COLUMN "public"."orders"."code" IS 'order code'`,
      ].join("\n"),
    );
  });
  it("composite key becomes a table constraint, with a foreign key", () => {
    setSqlDialect("postgres");
    expect(
      createTable({
        schema: "public",
        name: "lines",
        columns: [
          { name: "order_id", type: "bigint", nullable: false, default: "", primaryKey: true },
          { name: "line_no", type: "integer", nullable: false, default: "", primaryKey: true },
        ],
        foreignKeys: [
          {
            name: "lines_order_fk",
            columns: ["order_id"],
            refSchema: "public",
            refTable: "orders",
            refColumns: ["id"],
            onDelete: "CASCADE",
            onUpdate: "NO ACTION",
            deferrable: true,
            initiallyDeferred: true,
          },
        ],
      }),
    ).toBe(
      [
        `CREATE TABLE "public"."lines" (`,
        `  "order_id" bigint NOT NULL,`,
        `  "line_no" integer NOT NULL,`,
        `  PRIMARY KEY ("order_id", "line_no"),`,
        `  CONSTRAINT "lines_order_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders" ("id") ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`,
        `)`,
      ].join("\n"),
    );
  });
});

describe("createTable · mysql", () => {
  it("AUTO_INCREMENT key, inline comments, engine/charset options", () => {
    setSqlDialect("mysql");
    expect(
      createTable({
        schema: "test",
        name: "orders",
        ifNotExists: true,
        comment: "customer orders",
        columns: [
          { name: "id", type: "bigint", nullable: false, default: "", primaryKey: true, identity: true },
          { name: "code", type: "varchar(32)", nullable: false, default: "", unique: true, comment: "order code" },
          { name: "qty", type: "int", nullable: true, default: "0" },
        ],
        options: { engine: "InnoDB", charset: "utf8mb4", collation: "utf8mb4_0900_ai_ci" },
      }),
    ).toBe(
      [
        "CREATE TABLE IF NOT EXISTS `test`.`orders` (",
        "  `id` bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,",
        "  `code` varchar(32) NOT NULL UNIQUE COMMENT 'order code',",
        "  `qty` int DEFAULT 0",
        ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='customer orders'",
      ].join("\n"),
    );
  });
});

describe("createTable · sqlite", () => {
  it("INTEGER PRIMARY KEY AUTOINCREMENT and an unqualified FK target", () => {
    setSqlDialect("sqlite");
    expect(
      createTable({
        schema: "main",
        name: "lines",
        columns: [
          { name: "id", type: "integer", nullable: false, default: "", primaryKey: true, identity: true },
          { name: "order_id", type: "integer", nullable: false, default: "" },
          { name: "note", type: "text", nullable: true, default: "'-'" },
        ],
        foreignKeys: [
          { columns: ["order_id"], refSchema: "main", refTable: "orders", refColumns: ["id"], onDelete: "CASCADE" },
        ],
      }),
    ).toBe(
      [
        `CREATE TABLE "main"."lines" (`,
        `  "id" INTEGER PRIMARY KEY AUTOINCREMENT,`,
        `  "order_id" integer NOT NULL,`,
        `  "note" text DEFAULT '-',`,
        `  FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE CASCADE`,
        `)`,
      ].join("\n"),
    );
  });
});

describe("createTable · duckdb", () => {
  it("auto-numbering uses a sequence default created first", () => {
    setSqlDialect("duckdb");
    expect(
      createTable({
        schema: "main",
        name: "t",
        columns: [{ name: "id", type: "INTEGER", nullable: false, default: "", primaryKey: true, identity: true }],
      }),
    ).toBe(
      [
        `CREATE SEQUENCE "main"."t_id_seq";`,
        `CREATE TABLE "main"."t" (`,
        `  "id" INTEGER DEFAULT nextval('"main"."t_id_seq"') PRIMARY KEY`,
        `)`,
      ].join("\n"),
    );
  });
});

describe("mysql ALTER forms", () => {
  it("MODIFY COLUMN restates the whole definition", () => {
    setSqlDialect("mysql");
    expect(
      editColumn("test", "t", "qty", {
        type: "bigint",
        notNull: true,
        target: { name: "qty", type: "int", nullable: true, default: "0", comment: "count" },
      }),
    ).toBe("ALTER TABLE `test`.`t` MODIFY COLUMN `qty` bigint NOT NULL DEFAULT 0 COMMENT 'count'");
  });
  it("default-only edits use ALTER COLUMN, renames use RENAME COLUMN", () => {
    setSqlDialect("mysql");
    expect(editColumn("test", "t", "qty", { setDefault: "5" })).toBe(
      "ALTER TABLE `test`.`t` ALTER COLUMN `qty` SET DEFAULT 5",
    );
    expect(editColumn("test", "t", "qty", { newName: "amount" })).toBe(
      "ALTER TABLE `test`.`t` RENAME COLUMN `qty` TO `amount`",
    );
  });
  it("rename table / drop index / typed constraint drops", () => {
    setSqlDialect("mysql");
    expect(renameRelation("table", "test", "t", "t2")).toBe("RENAME TABLE `test`.`t` TO `test`.`t2`");
    // MySQL has no `ALTER VIEW … RENAME TO`; RENAME TABLE renames a view too.
    expect(renameRelation("view", "test", "v", "v2")).toBe("RENAME TABLE `test`.`v` TO `test`.`v2`");
    expect(dropIndex("test", "idx", false, "t")).toBe("DROP INDEX `idx` ON `test`.`t`");
    expect(dropConstraint("test", "t", "fk_o", false, "foreign_key")).toBe(
      "ALTER TABLE `test`.`t` DROP FOREIGN KEY `fk_o`",
    );
    expect(dropConstraint("test", "t", "uq_c", false, "unique")).toBe("ALTER TABLE `test`.`t` DROP INDEX `uq_c`");
    expect(dropConstraint("test", "t", "pk", false, "primary_key")).toBe("ALTER TABLE `test`.`t` DROP PRIMARY KEY");
  });
  it("table comment is an ALTER option, column comment restates the column", () => {
    setSqlDialect("mysql");
    expect(commentOnTable("test", "t", "hello")).toBe("ALTER TABLE `test`.`t` COMMENT = 'hello'");
    expect(commentOnColumn("test", "t", { name: "c", type: "int", nullable: true, default: "" }, "note")).toBe(
      "ALTER TABLE `test`.`t` MODIFY COLUMN `c` int COMMENT 'note'",
    );
  });
  it("duplicate uses MySQL's LIKE form and truncate takes no options", () => {
    setSqlDialect("mysql");
    expect(duplicateTable("test", "t", "t2", false)).toBe("CREATE TABLE `test`.`t2` LIKE `test`.`t`");
    expect(truncate("test", "t", { cascade: true, restartIdentity: true })).toBe("TRUNCATE TABLE `test`.`t`");
  });
});

describe("sqlite ALTER forms", () => {
  it("plain ALTERs where SQLite has them", () => {
    setSqlDialect("sqlite");
    expect(addColumn("main", "t", { name: "c", type: "text", nullable: true, default: "" })).toBe(
      `ALTER TABLE "main"."t" ADD COLUMN "c" text`,
    );
    expect(renameColumn("main", "t", "a", "b")).toBe(`ALTER TABLE "main"."t" RENAME COLUMN "a" TO "b"`);
    expect(renameRelation("table", "main", "t", "t2")).toBe(`ALTER TABLE "main"."t" RENAME TO "t2"`);
    expect(dropColumn("main", "t", "c", true)).toBe(`ALTER TABLE "main"."t" DROP COLUMN "c"`);
  });
  it("CREATE INDEX leaves the table unqualified and keeps a partial WHERE", () => {
    setSqlDialect("sqlite");
    expect(
      createIndex({
        schema: "main",
        table: "t",
        name: "idx",
        unique: true,
        method: "btree",
        columns: ["a"],
        where: "a IS NOT NULL",
      }),
    ).toBe(`CREATE UNIQUE INDEX "idx" ON "t" ("a") WHERE a IS NOT NULL`);
  });
  it("no TRUNCATE — an unqualified DELETE is the equivalent", () => {
    setSqlDialect("sqlite");
    expect(truncate("main", "t", { cascade: true, restartIdentity: true })).toBe(`DELETE FROM "main"."t"`);
  });
});

describe("sqlite rebuild", () => {
  const rebuildSpec = () => ({
    schema: "main",
    table: "t",
    newName: "t",
    newComment: "",
    origComment: "",
    dropIndexes: [] as string[],
    dropConstraints: [] as string[],
    keepIndexes: [`CREATE INDEX "t_qty_idx" ON "t" ("qty")`],
    columns: [
      origCol({
        orig: { name: "id", type: "integer", nullable: false, default: "", comment: "" },
        name: "id",
        type: "integer",
        nullable: false,
        isPk: true,
        origPk: true,
      }),
      origCol({
        orig: { name: "qty", type: "integer", nullable: true, default: "", comment: "" },
        name: "qty",
        type: "bigint",
        nullable: true,
      }),
    ],
  });
  it("a type change becomes create → copy → drop → rename", () => {
    setSqlDialect("sqlite");
    expect(needsRebuild(rebuildSpec())).toBe(true);
    expect(tableDiff(rebuildSpec())).toBe(
      [
        `-- SQLite can't ALTER "main"."t" in place — rebuilding it (create → copy → drop → rename).`,
        `CREATE TABLE "main"."t__tusk_rebuild" (`,
        `  "id" integer PRIMARY KEY,`,
        `  "qty" bigint`,
        `);`,
        `INSERT INTO "main"."t__tusk_rebuild" ("id", "qty")`,
        `SELECT "id", "qty" FROM "main"."t";`,
        `DROP TABLE "main"."t";`,
        `ALTER TABLE "main"."t__tusk_rebuild" RENAME TO "t";`,
        `CREATE INDEX "t_qty_idx" ON "t" ("qty")`,
      ].join("\n"),
    );
  });
  it("a rename-only diff stays on plain ALTERs", () => {
    setSqlDialect("sqlite");
    const s = {
      ...rebuildSpec(),
      columns: [origCol({ orig: { name: "a", type: "int", nullable: true, default: "", comment: "" }, name: "b" })],
    };
    expect(needsRebuild(s)).toBe(false);
    expect(tableDiff(s)).toBe(`ALTER TABLE "main"."t" RENAME COLUMN "a" TO "b"`);
  });
});

describe("tableDiff · mysql", () => {
  it("restates the column on a type change and drops constraints by kind", () => {
    setSqlDialect("mysql");
    const out = tableDiff({
      schema: "test",
      table: "t",
      newName: "t",
      newComment: "hi",
      origComment: "",
      columns: [
        origCol({
          orig: { name: "qty", type: "int", nullable: true, default: "0", comment: "" },
          name: "qty",
          type: "bigint",
          nullable: false,
          default: "0",
        }),
      ],
      dropIndexes: ["idx"],
      dropConstraints: ["fk_o"],
      constraintKinds: { fk_o: "foreign_key" },
    });
    expect(out).toBe(
      [
        "ALTER TABLE `test`.`t` MODIFY COLUMN `qty` bigint NOT NULL DEFAULT 0",
        "DROP INDEX `idx` ON `test`.`t`",
        "ALTER TABLE `test`.`t` DROP FOREIGN KEY `fk_o`",
        "ALTER TABLE `test`.`t` COMMENT = 'hi'",
      ].join(";\n"),
    );
  });
});

describe("validateColumns", () => {
  it("rejects empty, duplicate (case-folded) and nullable-PK columns", () => {
    setSqlDialect("postgres");
    const problems = validateColumns([
      { name: "", type: "int", nullable: true },
      { name: "a", type: "int", nullable: true },
      { name: "A", type: "int", nullable: true },
      { name: "b", type: "", nullable: true },
      { name: "c", type: "int", nullable: true, primaryKey: true },
    ]);
    expect(problems.map((p) => p.message)).toEqual([
      "Every column needs a name.",
      `Column names "a" and "A" collide (this engine folds unquoted names).`,
      `Column "b" needs a type.`,
      `Primary-key column "c" cannot be nullable.`,
    ]);
  });
  it("accepts a well-formed list", () => {
    setSqlDialect("postgres");
    expect(validateColumns([{ name: "id", type: "bigint", nullable: false, primaryKey: true }])).toEqual([]);
  });
});

describe("scriptNote", () => {
  it("says atomic on transactional engines and warns on MySQL", () => {
    setSqlDialect("postgres");
    expect(scriptNote("A;\nB")).toMatch(/one transaction/);
    setSqlDialect("mysql");
    expect(scriptNote("A;\nB")).toMatch(/commits each DDL statement/);
    expect(scriptNote("A")).toBe("");
  });
});
