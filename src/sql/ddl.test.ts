import { afterEach, describe, expect, it } from "vitest";
import { setSqlDialect } from "./ident";
import { ddlCaps } from "./ddlCaps";
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
  droppableIndexes,
  dropSchema,
  duplicateTable,
  editColumn,
  isPlaceholderColumn,
  mentionsIdentifier,
  mysqlTextLiteral,
  needsRebuild,
  renameColumn,
  renameRelation,
  scriptNote,
  setMysqlNoBackslashEscapes,
  tableDiff,
  tableDiffProblems,
  truncate,
  uniqueIndexColumns,
  validateColumns,
  validateTableOptions,
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
        // Since 3.25 a plain RENAME TO re-parses every sqlite_schema entry, so a view
        // or trigger naming the just-dropped original aborts the whole rebuild.
        `PRAGMA legacy_alter_table=1;`,
        `DROP TABLE "main"."t";`,
        `ALTER TABLE "main"."t__tusk_rebuild" RENAME TO "t";`,
        `PRAGMA legacy_alter_table=0;`,
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
  // Everything below is what the pragmas cannot see: dropping it on a rebuild destroyed
  // the constraint/collation/expression with no error and no warning.
  it("carries CHECK, COLLATE, generated columns, triggers and table options across", () => {
    setSqlDialect("sqlite");
    const s = {
      ...rebuildSpec(),
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
          orig: { name: "email", type: "text", nullable: true, default: "", comment: "" },
          name: "email",
          type: "varchar(80)",
          nullable: true,
          collate: "NOCASE",
          check: "email <> ''",
        }),
        origCol({
          orig: { name: "total", type: "int", nullable: true, default: "", comment: "" },
          name: "total",
          type: "int",
          nullable: true,
          generated: "GENERATED ALWAYS AS (id * 2) STORED",
        }),
      ],
      keepIndexes: [] as string[],
      keepConstraints: [`CONSTRAINT "ck_qty" CHECK (qty > 0)`],
      keepTriggers: [`CREATE TRIGGER "t_ins" AFTER INSERT ON "t" BEGIN SELECT 1; END`],
      tableOptions: "WITHOUT ROWID",
    };
    expect(tableDiff(s)).toBe(
      [
        `-- SQLite can't ALTER "main"."t" in place — rebuilding it (create → copy → drop → rename).`,
        `CREATE TABLE "main"."t__tusk_rebuild" (`,
        `  "id" integer PRIMARY KEY,`,
        `  "email" varchar(80) COLLATE NOCASE CHECK (email <> ''),`,
        `  "total" int GENERATED ALWAYS AS (id * 2) STORED,`,
        `  CONSTRAINT "ck_qty" CHECK (qty > 0)`,
        `) WITHOUT ROWID;`,
        // A generated column has no stored value to copy.
        `INSERT INTO "main"."t__tusk_rebuild" ("id", "email")`,
        `SELECT "id", "email" FROM "main"."t";`,
        `PRAGMA legacy_alter_table=1;`,
        `DROP TABLE "main"."t";`,
        `ALTER TABLE "main"."t__tusk_rebuild" RENAME TO "t";`,
        `PRAGMA legacy_alter_table=0;`,
        `CREATE TRIGGER "t_ins" AFTER INSERT ON "t" BEGIN SELECT 1; END`,
      ].join("\n"),
    );
  });
  it("refuses a rename in the same pass as a rebuild", () => {
    setSqlDialect("sqlite");
    const renamedTable = { ...rebuildSpec(), newName: "t2" };
    expect(tableDiffProblems(renamedTable).map((p) => p.message).join(" ")).toMatch(/rename on its own first/);
    const cols = rebuildSpec().columns;
    cols[1] = { ...cols[1], name: "amount" };
    const renamedCol = { ...rebuildSpec(), columns: cols };
    expect(tableDiffProblems(renamedCol).map((p) => p.message).join(" ")).toMatch(/rename on its own first/);
    // …but a rename with no rebuild is still fine.
    expect(tableDiffProblems({ ...rebuildSpec(), newName: "t2", columns: [] })).toEqual([]);
  });
  it("refuses a rebuild when the stored definition could not be read", () => {
    setSqlDialect("sqlite");
    expect(
      tableDiffProblems({ ...rebuildSpec(), definitionRead: false }).map((p) => p.message).join(" "),
    ).toMatch(/couldn't read this table's stored CREATE statement/);
  });
  it("dropping an indexed column needs a rebuild, and refuses while the index survives", () => {
    setSqlDialect("sqlite");
    const dropQty = {
      ...rebuildSpec(),
      columns: [
        rebuildSpec().columns[0],
        { ...rebuildSpec().columns[1], type: "integer", dropped: true },
      ],
      dependents: [{ name: "t_qty_idx", kind: "index" as const, columns: ["qty"] }],
    };
    // SQLite's DROP COLUMN refuses an indexed column outright.
    expect(needsRebuild(dropQty)).toBe(true);
    expect(tableDiffProblems(dropQty).map((p) => p.message).join(" ")).toMatch(/used by index "t_qty_idx"/);
    // With the index ticked for dropping there is no dependency and no rebuild.
    const withIndexDropped = { ...dropQty, dependents: [], dropIndexes: ["t_qty_idx"] };
    expect(needsRebuild(withIndexDropped)).toBe(false);
    expect(tableDiffProblems(withIndexDropped)).toEqual([]);
    // The index must go BEFORE the column, or the engine refuses the drop.
    expect(tableDiff(withIndexDropped)).toBe(
      [`DROP INDEX "main"."t_qty_idx"`, `ALTER TABLE "main"."t" DROP COLUMN "qty"`].join(";\n"),
    );
  });
  it("reordering columns is a rebuild (and only SQLite can express it)", () => {
    setSqlDialect("sqlite");
    const s = rebuildSpec();
    const swapped = {
      ...s,
      columns: [
        { ...s.columns[1], type: "integer" },
        s.columns[0],
      ],
      origOrder: ["id", "qty"],
    };
    expect(needsRebuild(swapped)).toBe(true);
    expect(tableDiff(swapped)).toContain(`INSERT INTO "main"."t__tusk_rebuild" ("qty", "id")`);
    // Same order = no rebuild.
    expect(needsRebuild({ ...s, columns: [s.columns[0], { ...s.columns[1], type: "integer" }], origOrder: ["id", "qty"] })).toBe(
      false,
    );
  });
  it("a constraint-backed index is offered once, under Constraints", () => {
    const indexes = [{ name: "uq" }, { name: "PRIMARY" }, { name: "plain_idx" }];
    expect(droppableIndexes(indexes, [{ name: "uq" }, { name: "PRIMARY" }]).map((i) => i.name)).toEqual([
      "plain_idx",
    ]);
  });
  it("unique key columns come from the index data, not from its def text", () => {
    expect(
      uniqueIndexColumns([
        { unique: true, columns: ["user_id"] },
        { unique: false, columns: ["created_at"] },
        // An expression index reports no columns: it contributes none, rather than
        // every column whose name appears somewhere in the rendered definition.
        { unique: true, columns: [] },
      ]),
    ).toEqual(["user_id"]);
  });
  it("mentionsIdentifier matches whole tokens, not substrings", () => {
    expect(mentionsIdentifier(`CREATE TRIGGER x BEGIN UPDATE t SET a = NEW."qty"; END`, "qty")).toBe(true);
    expect(mentionsIdentifier(`CREATE TRIGGER x BEGIN UPDATE t SET a = NEW.qty_total; END`, "qty")).toBe(false);
  });
});

describe("engine-specific destructive actions", () => {
  // On MySQL a schema IS a database: `DROP SCHEMA` there destroys the whole database,
  // so the capability says so and the Explorer labels/guards it as a database drop.
  it("MySQL has no plain schema drop", () => {
    expect(ddlCaps("mysql").dropSchema).toBe("database");
    expect(ddlCaps("postgres").dropSchema).toBe("schema");
    expect(ddlCaps("duckdb").dropSchema).toBe("schema");
    expect(ddlCaps("sqlite").dropSchema).toBe(false);
    setSqlDialect("mysql");
    expect(dropSchema("app_prod", true)).toBe("DROP DATABASE `app_prod`");
    setSqlDialect("postgres");
    expect(dropSchema("s1", true)).toBe(`DROP SCHEMA "s1" CASCADE`);
  });
});

describe("generated columns and MySQL's ON UPDATE", () => {
  // MODIFY COLUMN restates the WHOLE definition: anything the builder does not carry
  // is dropped by the server without a word.
  it("MODIFY restates ON UPDATE CURRENT_TIMESTAMP", () => {
    setSqlDialect("mysql");
    const out = tableDiff({
      schema: "test",
      table: "t",
      newName: "t",
      newComment: "",
      origComment: "",
      columns: [
        origCol({
          orig: { name: "updated_at", type: "timestamp", nullable: false, default: "CURRENT_TIMESTAMP", comment: "" },
          name: "updated_at",
          type: "timestamp",
          nullable: false,
          default: "CURRENT_TIMESTAMP",
          comment: "when",
          onUpdate: "ON UPDATE CURRENT_TIMESTAMP",
        }),
      ],
      dropIndexes: [],
      dropConstraints: [],
    });
    expect(out).toBe(
      "ALTER TABLE `test`.`t` MODIFY COLUMN `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'when'",
    );
  });
  it("refuses to rewrite a generated column", () => {
    setSqlDialect("mysql");
    const spec = {
      schema: "test",
      table: "t",
      newName: "t",
      newComment: "",
      origComment: "",
      columns: [
        origCol({
          orig: { name: "total", type: "int", nullable: true, default: "", comment: "" },
          name: "total",
          type: "bigint",
          generated: "GENERATED ALWAYS AS (qty * 2) STORED",
        }),
      ],
      dropIndexes: [],
      dropConstraints: [],
    };
    expect(tableDiffProblems(spec).map((p) => p.message).join(" ")).toMatch(/is a generated column/);
    // Untouched, it emits nothing at all.
    const untouched = { ...spec, columns: [{ ...spec.columns[0], type: "int" }] };
    expect(tableDiffProblems(untouched)).toEqual([]);
    expect(tableDiff(untouched)).toBe("");
  });
});

describe("editColumn · sqlite", () => {
  // SQLite's ALTER TABLE has no ALTER COLUMN at all; the dialog used to preview
  // `ALTER COLUMN … TYPE …` with Apply enabled, which SQLite cannot even parse.
  it("emits only the rename", () => {
    setSqlDialect("sqlite");
    expect(
      editColumn("main", "t", "c", { newName: "c2", type: "bigint", notNull: true, setDefault: "0" }),
    ).toBe(`ALTER TABLE "main"."t" RENAME COLUMN "c" TO "c2"`);
    expect(editColumn("main", "t", "c", { type: "bigint", notNull: true })).toBe("");
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
  it("rejects empty, untyped and nullable-PK columns", () => {
    setSqlDialect("postgres");
    const problems = validateColumns([
      { name: "", type: "int", nullable: true },
      { name: "b", type: "", nullable: true },
      { name: "c", type: "int", nullable: true, primaryKey: true },
    ]);
    expect(problems.map((p) => p.message)).toEqual([
      "Every column needs a name.",
      `Column "b" needs a type.`,
      `Primary-key column "c" cannot be nullable.`,
    ]);
  });
  // Tusk ALWAYS quotes identifiers, and quoted "Id"/"id" are two distinct, legal
  // PostgreSQL columns — only the engines that compare identifiers case-insensitively
  // may reject the pair.
  it("case-folds duplicates only where the engine does", () => {
    const pair = [
      { name: "a", type: "int", nullable: true },
      { name: "A", type: "int", nullable: true },
    ];
    setSqlDialect("postgres");
    expect(validateColumns(pair)).toEqual([]);
    setSqlDialect("mysql");
    expect(validateColumns(pair).map((p) => p.message)).toEqual([
      `Column names "a" and "A" collide (MySQL compares identifiers case-insensitively).`,
    ]);
  });
  // The Modify dialog's rows carry `isPk`, the Create dialog's carry `primaryKey`;
  // reading only one of them made this check silently dead from Modify.
  it("reads the Modify dialog's isPk as well as primaryKey", () => {
    setSqlDialect("postgres");
    expect(validateColumns([{ name: "c", type: "int", nullable: true, isPk: true }]).map((p) => p.message)).toEqual([
      `Primary-key column "c" cannot be nullable.`,
    ]);
    // SQLite genuinely allows NULLs in a non-INTEGER primary key, so it must not block.
    setSqlDialect("sqlite");
    expect(validateColumns([{ name: "c", type: "text", nullable: true, isPk: true }])).toEqual([]);
  });
  it("accepts a well-formed list", () => {
    setSqlDialect("postgres");
    expect(validateColumns([{ name: "id", type: "bigint", nullable: false, primaryKey: true }])).toEqual([]);
  });
  // The Create dialog opens with a spare empty row; `createTable` drops it from the SQL,
  // so validation must ignore it too instead of blanking the preview on open.
  it("isPlaceholderColumn ignores the untouched spare row only", () => {
    expect(isPlaceholderColumn({ name: "", type: "text", nullable: true })).toBe(true);
    expect(isPlaceholderColumn({ name: "", type: "text", nullable: true, default: "1" })).toBe(false);
    expect(isPlaceholderColumn({ name: "", type: "text", nullable: true, primaryKey: true })).toBe(false);
    expect(isPlaceholderColumn({ name: "x", type: "text", nullable: true })).toBe(false);
  });
});

describe("MySQL literal escaping", () => {
  // There is no form that is right under both sql_modes, so the backend reports which
  // one the session uses. Doubling under NO_BACKSLASH_ESCAPES stores two backslashes;
  // not doubling under the default mode turns the escape into a control character.
  it("doubles backslashes only when the session treats them as escapes", () => {
    setMysqlNoBackslashEscapes(false);
    expect(mysqlTextLiteral("C:\\new\\it's")).toBe("'C:\\\\new\\\\it''s'");
    setMysqlNoBackslashEscapes(true);
    expect(mysqlTextLiteral("C:\\new\\it's")).toBe("'C:\\new\\it''s'");
    setMysqlNoBackslashEscapes(false);
  });
});

describe("MySQL table options", () => {
  it("validates the option tokens and never interpolates a bad one", () => {
    setSqlDialect("mysql");
    expect(validateTableOptions({ engine: "InnoDB", charset: "utf8mb4" })).toEqual([]);
    expect(validateTableOptions({ engine: "InnoDB' , x=(" }).map((p) => p.message)).toEqual([
      "Engine must be a plain name (letters, digits and _).",
    ]);
    const sql = createTable({
      schema: "test",
      name: "t",
      columns: [{ name: "a", type: "int", nullable: true, default: "" }],
      options: { engine: "InnoDB' , x=(", charset: "utf8mb4" },
    });
    expect(sql).toContain("DEFAULT CHARSET=utf8mb4");
    expect(sql).not.toContain("ENGINE=");
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
