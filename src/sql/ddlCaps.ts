// Per-engine DDL capability table — ONE place that answers "can this engine do X?".
//
// Both the SQL builders (`sql/ddl.ts`) and the Explorer menu gating (`App.tsx`)
// read this. Before it existed the knowledge was split between `isDuck()` branches
// inside the builders and scattered `noDuck("…")` spreads at every menu call site,
// which is why MySQL and SQLite could not be opened up: there was no single switch
// to flip. Add an engine by adding a row here, not by adding another branch.
//
// Facts encoded below are engine syntax facts, verified by `sql/ddl.test.ts` (the
// builders emit these forms) and `driver_conformance.rs` (`*_ddl_builder_forms_apply`
// executes the same strings on a real engine).

import { sqlDialect } from "./ident";

export type DdlDialect = "postgres" | "duckdb" | "mysql" | "sqlite";

/** How a column's type is changed in place. */
export type TypeChange =
  | "alter-type" // PG/DuckDB: ALTER COLUMN c TYPE t [USING …]
  | "modify" // MySQL: MODIFY COLUMN c <full definition>
  | "rebuild"; // SQLite: no ALTER form at all — rebuild the table

/** How an existing constraint is dropped. */
export type ConstraintDrop =
  | "constraint" // ALTER TABLE … DROP CONSTRAINT name
  | "typed" // MySQL: DROP FOREIGN KEY / DROP INDEX / DROP PRIMARY KEY / DROP CHECK
  | "none"; // DuckDB (no constraint ALTERs) / SQLite (rebuild only)

export type DdlCaps = {
  dialect: DdlDialect;
  label: string;

  // --- script shape ---
  /** Several ALTER actions may be comma-joined into one statement (DuckDB: no). */
  multiActionAlter: boolean;
  /** DDL takes part in the surrounding transaction (MySQL implicitly commits each one). */
  transactionalDdl: boolean;
  /** Unquoted identifiers fold case, so duplicate-name checks are case-insensitive. */
  foldsCase: boolean;

  // --- CREATE TABLE surface ---
  ifNotExists: boolean;
  temporary: boolean;
  inlineCheck: boolean;
  inlineUnique: boolean;
  inlineForeignKey: boolean;
  /** MySQL ENGINE= / DEFAULT CHARSET= / COLLATE= table options. */
  tableOptions: boolean;
  /** Auto-numbering form offered by the column editor. */
  identity: "identity" | "auto_increment" | "rowid" | "sequence";
  /** `serial` / `bigserial` pseudo-types exist. */
  serialTypes: boolean;
  /** Column-level COLLATE in a column definition. */
  collate: boolean;

  // --- ALTER TABLE surface ---
  addColumnConstraints: boolean; // constraints may ride along on ADD COLUMN
  dropColumn: boolean;
  renameColumn: boolean;
  /** `ALTER TABLE a RENAME TO b` vs MySQL's preferred `RENAME TABLE a TO b`. */
  renameTableForm: "alter" | "rename-table";
  setSchema: boolean; // PG: ALTER TABLE … SET SCHEMA
  changeType: TypeChange;
  usingClause: boolean; // PG type-change USING expression
  /** SET/DROP NOT NULL: an independent ALTER action, part of MODIFY, or a rebuild. */
  setNotNull: "alter" | "modify" | "rebuild";
  setDefault: "alter" | "modify" | "rebuild";
  addConstraint: boolean; // ALTER TABLE … ADD [CONSTRAINT] PK/UNIQUE/CHECK/FK
  dropConstraint: ConstraintDrop;
  addPrimaryKey: boolean;
  deferrable: boolean; // DEFERRABLE INITIALLY DEFERRED on a FK
  onUpdateAction: boolean; // ON UPDATE <action> on a FK

  // --- objects ---
  schemas: boolean;
  createSchema: boolean;
  renameSchema: boolean;
  createDatabase: boolean;
  dropDatabase: boolean;
  sequences: boolean;
  matviews: boolean;
  renameIndex: boolean;
  renameConstraint: boolean;
  renameSequence: boolean;
  alterSequence: boolean;
  /** MySQL's DROP INDEX needs the table: `DROP INDEX i ON t`. */
  dropIndexNeedsTable: boolean;
  /** `CREATE INDEX i ON <table>` takes a schema-qualified table (SQLite's grammar
   *  qualifies the INDEX name instead and rejects a qualified table there). */
  indexTableQualified: boolean;
  /** A FK's REFERENCES target may be schema-qualified (SQLite forbids it — a foreign
   *  key can only point inside the same database). */
  fkRefQualified: boolean;
  indexMethod: boolean; // USING btree/hash/gin/…
  partialIndex: boolean; // WHERE on CREATE INDEX
  cascade: boolean; // CASCADE on DROP
  truncate: boolean;
  truncateOptions: boolean; // RESTART IDENTITY / CASCADE
  duplicate: "like" | "ctas"; // CREATE TABLE … (LIKE …) vs CTAS
  comments: "standard" | "inline" | "none"; // COMMENT ON … / MySQL inline / none
  triggers: boolean;

  /** SQLite: dropping a column, changing its type, or toggling NOT NULL can need a
   *  full table rebuild (CREATE new → INSERT SELECT → DROP old → RENAME). */
  rebuild: boolean;
};

const POSTGRES: DdlCaps = {
  dialect: "postgres",
  label: "PostgreSQL",
  multiActionAlter: true,
  transactionalDdl: true,
  foldsCase: true,
  ifNotExists: true,
  temporary: true,
  inlineCheck: true,
  inlineUnique: true,
  inlineForeignKey: true,
  tableOptions: false,
  identity: "identity",
  serialTypes: true,
  collate: true,
  addColumnConstraints: true,
  dropColumn: true,
  renameColumn: true,
  renameTableForm: "alter",
  setSchema: true,
  changeType: "alter-type",
  usingClause: true,
  setNotNull: "alter",
  setDefault: "alter",
  addConstraint: true,
  dropConstraint: "constraint",
  addPrimaryKey: true,
  deferrable: true,
  onUpdateAction: true,
  schemas: true,
  createSchema: true,
  renameSchema: true,
  createDatabase: true,
  dropDatabase: true,
  sequences: true,
  matviews: true,
  renameIndex: true,
  renameConstraint: true,
  renameSequence: true,
  alterSequence: true,
  dropIndexNeedsTable: false,
  indexTableQualified: true,
  fkRefQualified: true,
  indexMethod: true,
  partialIndex: true,
  cascade: true,
  truncate: true,
  truncateOptions: true,
  duplicate: "like",
  comments: "standard",
  triggers: true,
  rebuild: false,
};

// DuckDB: PostgreSQL-shaped SQL, but one ALTER action per statement, no constraint
// ALTERs, no roles/identity clauses, no LIKE, and a single (ART) index type.
const DUCKDB: DdlCaps = {
  ...POSTGRES,
  dialect: "duckdb",
  label: "DuckDB",
  multiActionAlter: false,
  inlineForeignKey: true,
  identity: "sequence",
  serialTypes: false,
  collate: false,
  addColumnConstraints: false,
  setSchema: false,
  addConstraint: false,
  dropConstraint: "none",
  addPrimaryKey: true, // ADD PRIMARY KEY works; named ADD CONSTRAINT does not
  deferrable: false,
  createDatabase: false,
  dropDatabase: false,
  renameIndex: false,
  renameConstraint: false,
  renameSequence: false,
  alterSequence: false,
  indexMethod: false,
  partialIndex: false,
  truncateOptions: false,
  duplicate: "ctas",
  matviews: false,
  triggers: false,
};

// MySQL 8: backtick quoting, schema == database, MODIFY/CHANGE COLUMN instead of
// ALTER COLUMN … TYPE, AUTO_INCREMENT, inline table/column COMMENT, and DDL that
// implicitly commits (so a multi-statement script is NOT atomic).
const MYSQL: DdlCaps = {
  dialect: "mysql",
  label: "MySQL",
  multiActionAlter: true,
  transactionalDdl: false,
  foldsCase: true,
  ifNotExists: true,
  temporary: true,
  inlineCheck: true,
  inlineUnique: true,
  inlineForeignKey: true,
  tableOptions: true,
  identity: "auto_increment",
  serialTypes: false,
  collate: true,
  addColumnConstraints: true,
  dropColumn: true,
  renameColumn: true,
  renameTableForm: "rename-table",
  setSchema: false,
  changeType: "modify",
  usingClause: false,
  setNotNull: "modify",
  setDefault: "alter", // ALTER COLUMN c SET/DROP DEFAULT does exist on MySQL
  addConstraint: true,
  dropConstraint: "typed",
  addPrimaryKey: true,
  deferrable: false,
  onUpdateAction: true,
  schemas: true,
  createSchema: true,
  renameSchema: false,
  createDatabase: true,
  dropDatabase: true,
  sequences: false,
  matviews: false,
  renameIndex: true, // ALTER TABLE t RENAME INDEX a TO b
  renameConstraint: false,
  renameSequence: false,
  alterSequence: false,
  dropIndexNeedsTable: true,
  indexTableQualified: true,
  fkRefQualified: true,
  indexMethod: false, // the index_type goes before ON — not worth a second shape
  partialIndex: false,
  cascade: false,
  truncate: true,
  truncateOptions: false,
  duplicate: "like",
  comments: "inline",
  triggers: true,
  rebuild: false,
};

// SQLite: ALTER TABLE does RENAME TO / RENAME COLUMN / ADD COLUMN / DROP COLUMN and
// nothing else. Type changes, NOT NULL changes and every constraint edit need the
// documented table rebuild. No comments, no schemas beyond main/temp/attached.
const SQLITE: DdlCaps = {
  dialect: "sqlite",
  label: "SQLite",
  multiActionAlter: false,
  transactionalDdl: true,
  foldsCase: true,
  ifNotExists: true,
  temporary: true,
  inlineCheck: true,
  inlineUnique: true,
  inlineForeignKey: true,
  tableOptions: false,
  identity: "rowid",
  serialTypes: false,
  collate: true,
  addColumnConstraints: true, // limited (no PK/UNIQUE, NOT NULL needs a default)
  dropColumn: true, // 3.35+; restrictions surface as engine errors
  renameColumn: true,
  renameTableForm: "alter",
  setSchema: false,
  changeType: "rebuild",
  usingClause: false,
  setNotNull: "rebuild",
  setDefault: "rebuild",
  addConstraint: false,
  dropConstraint: "none",
  addPrimaryKey: false,
  deferrable: true, // in a CREATE TABLE FK clause
  onUpdateAction: true,
  schemas: true, // main / temp / attached: qualification works, CREATE SCHEMA does not
  createSchema: false,
  renameSchema: false,
  createDatabase: false,
  dropDatabase: false,
  sequences: false,
  matviews: false,
  renameIndex: false,
  renameConstraint: false,
  renameSequence: false,
  alterSequence: false,
  dropIndexNeedsTable: false,
  indexTableQualified: false, // CREATE INDEX [schema.]name ON <bare table> (…)
  fkRefQualified: false, // REFERENCES takes a bare table name
  indexMethod: false,
  partialIndex: true, // SQLite has had partial indexes since 3.8
  cascade: false,
  truncate: false, // no TRUNCATE statement — DELETE FROM is the equivalent
  truncateOptions: false,
  duplicate: "ctas",
  comments: "none",
  triggers: true,
  rebuild: true,
};

const TABLE: Record<DdlDialect, DdlCaps> = {
  postgres: POSTGRES,
  duckdb: DUCKDB,
  mysql: MYSQL,
  sqlite: SQLITE,
};

/** Capabilities of the connected engine (or of an explicitly named dialect). */
export function ddlCaps(dialect: string = sqlDialect()): DdlCaps {
  return TABLE[dialect as DdlDialect] ?? POSTGRES;
}

/** True when the engine supports sidebar DDL at all (all four do, today). */
export function ddlSupported(dialect: string = sqlDialect()): boolean {
  return dialect in TABLE;
}
