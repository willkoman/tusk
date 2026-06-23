// Pure SQL builders. Each returns a single statement (or, where noted, a small
// multi-statement script) that is `;`-free per statement — the run path splits on
// `;` and the editor-scaffold adds the trailing one. Quoting via ident.ts.

import { ident, qualify, qualifyIn, lit, sqlDialect } from "./ident";

/** DuckDB's DDL diverges from Postgres in a few mechanical ways (one ALTER action per
 *  statement, no constraints on ADD COLUMN, CTAS instead of LIKE, no role/identity
 *  clauses). Builders branch on this; unsupported actions (constraint ALTERs, rename
 *  index/seq/constraint, …) are gated off in the UI, not here. */
const isDuck = () => sqlDialect() === "duckdb";

export type ColumnSpec = {
  name: string;
  type: string;
  nullable: boolean;
  default: string; // raw SQL expression; "" = none
  primaryKey?: boolean;
};

/** A single column definition for CREATE TABLE / ADD COLUMN. */
export function columnDef(c: ColumnSpec): string {
  let s = `${ident(c.name)} ${c.type.trim()}`;
  if (c.default.trim()) s += ` DEFAULT ${c.default.trim()}`;
  if (c.primaryKey) s += " PRIMARY KEY";
  else if (!c.nullable) s += " NOT NULL";
  return s;
}

/** DuckDB ADD COLUMN can't carry constraints, so split into a plain add + follow-up
 *  ALTERs (DuckDB takes one ALTER action per statement). NOTE: no backfill — DuckDB
 *  refuses `SET NOT NULL` with an outstanding UPDATE in the same transaction (the run
 *  path is transactional), and on a populated table the SET NOT NULL itself fails with
 *  a clear "NOT NULL constraint failed" — so adding a NOT NULL column works when the
 *  table is empty (schema design) and otherwise surfaces DuckDB's real limitation. */
function duckAddColumn(q: string, c: ColumnSpec): string[] {
  const col = ident(c.name);
  const out = [`ALTER TABLE ${q} ADD COLUMN ${col} ${c.type.trim()}`];
  if (c.default.trim()) out.push(`ALTER TABLE ${q} ALTER COLUMN ${col} SET DEFAULT ${c.default.trim()}`);
  if (c.primaryKey) out.push(`ALTER TABLE ${q} ADD PRIMARY KEY (${col})`); // implies NOT NULL
  else if (!c.nullable) out.push(`ALTER TABLE ${q} ALTER COLUMN ${col} SET NOT NULL`);
  return out;
}

export function addColumn(schema: string, table: string, c: ColumnSpec): string {
  const q = qualify(schema, table);
  if (isDuck()) return duckAddColumn(q, c).join(";\n");
  return `ALTER TABLE ${q} ADD COLUMN ${columnDef(c)}`;
}

export function dropColumn(schema: string, table: string, name: string, cascade: boolean): string {
  return `ALTER TABLE ${qualify(schema, table)} DROP COLUMN ${ident(name)}${cascade ? " CASCADE" : ""}`;
}

/** Combined ALTER COLUMN edit: type / default / not-null in one statement, plus a
 *  separate RENAME (Postgres forbids RENAME in a multi-action ALTER). Returns the
 *  joined script (`;`-separated when a rename is included). */
export function editColumn(
  schema: string,
  table: string,
  col: string,
  e: {
    newName?: string;
    type?: string; // new type, "" = unchanged
    using?: string; // USING expr for the type cast
    setDefault?: string | null; // string = SET DEFAULT, null = DROP DEFAULT, undefined = unchanged
    notNull?: boolean; // undefined = unchanged
  },
): string {
  const q = qualify(schema, table);
  const actions: string[] = [];
  if (e.type && e.type.trim()) {
    const using = e.using && e.using.trim() ? ` USING ${e.using.trim()}` : "";
    actions.push(`ALTER COLUMN ${ident(col)} TYPE ${e.type.trim()}${using}`);
  }
  if (e.notNull !== undefined) {
    actions.push(`ALTER COLUMN ${ident(col)} ${e.notNull ? "SET" : "DROP"} NOT NULL`);
  }
  if (e.setDefault !== undefined) {
    actions.push(
      e.setDefault === null || !e.setDefault.trim()
        ? `ALTER COLUMN ${ident(col)} DROP DEFAULT`
        : `ALTER COLUMN ${ident(col)} SET DEFAULT ${e.setDefault.trim()}`,
    );
  }
  const stmts: string[] = [];
  // DuckDB allows only one ALTER action per statement; Postgres takes them comma-joined.
  if (actions.length) {
    if (isDuck()) for (const a of actions) stmts.push(`ALTER TABLE ${q} ${a}`);
    else stmts.push(`ALTER TABLE ${q} ${actions.join(", ")}`);
  }
  if (e.newName && e.newName.trim() && e.newName !== col) {
    stmts.push(`ALTER TABLE ${q} RENAME COLUMN ${ident(col)} TO ${ident(e.newName.trim())}`);
  }
  return stmts.join(";\n");
}

// --- CREATE TABLE -----------------------------------------------------------

export type CreateTableSpec = {
  schema: string;
  name: string;
  columns: ColumnSpec[];
  ifNotExists?: boolean;
};

export function createTable(t: CreateTableSpec): string {
  const cols = t.columns.filter((c) => c.name.trim() && c.type.trim());
  const lines = cols.map((c) => "  " + columnDef({ ...c, primaryKey: false }));
  const pks = cols.filter((c) => c.primaryKey).map((c) => ident(c.name));
  if (pks.length) lines.push(`  PRIMARY KEY (${pks.join(", ")})`);
  const ine = t.ifNotExists ? "IF NOT EXISTS " : "";
  return `CREATE TABLE ${ine}${qualify(t.schema, t.name)} (\n${lines.join(",\n")}\n)`;
}

// --- MODIFY TABLE diff ------------------------------------------------------

export type DiffColumn = {
  orig: { name: string; type: string; nullable: boolean; default: string; comment: string } | null;
  name: string;
  type: string;
  nullable: boolean;
  default: string;
  comment: string;
  isPk: boolean;
  origPk: boolean;
  dropped: boolean;
};
export type TableDiffSpec = {
  schema: string;
  table: string;
  newName: string;
  newComment: string;
  origComment: string;
  pkName?: string;
  columns: DiffColumn[];
  dropIndexes: string[];
  dropConstraints: string[];
};

/** Minimal ALTER script turning the original table into the edited state.
 *  Column type/null/default/comment changes run by original name; column renames
 *  and the table rename run last so earlier statements still resolve. */
export function tableDiff(s: TableDiffSpec): string {
  const q = qualify(s.schema, s.table);
  const stmts: string[] = [];
  const renames: string[] = [];

  for (const r of s.columns) {
    if (!r.orig || r.dropped) continue;
    const on = r.orig.name;
    if (r.type.trim() && r.type.trim() !== r.orig.type)
      stmts.push(`ALTER TABLE ${q} ALTER COLUMN ${ident(on)} TYPE ${r.type.trim()}`);
    if (r.nullable !== r.orig.nullable)
      stmts.push(`ALTER TABLE ${q} ALTER COLUMN ${ident(on)} ${r.nullable ? "DROP" : "SET"} NOT NULL`);
    if (r.default.trim() !== r.orig.default.trim())
      stmts.push(
        `ALTER TABLE ${q} ALTER COLUMN ${ident(on)} ${r.default.trim() ? `SET DEFAULT ${r.default.trim()}` : "DROP DEFAULT"}`,
      );
    if (r.comment !== r.orig.comment)
      stmts.push(`COMMENT ON COLUMN ${q}.${ident(on)} IS ${r.comment.trim() === "" ? "NULL" : lit(r.comment)}`);
    if (r.name.trim() && r.name.trim() !== on)
      renames.push(`ALTER TABLE ${q} RENAME COLUMN ${ident(on)} TO ${ident(r.name.trim())}`);
  }
  stmts.push(...renames);

  for (const r of s.columns) if (r.orig && r.dropped) stmts.push(`ALTER TABLE ${q} DROP COLUMN ${ident(r.orig.name)}`);

  for (const r of s.columns) {
    if (r.orig || r.dropped || !r.name.trim() || !r.type.trim()) continue;
    const spec = { name: r.name.trim(), type: r.type, nullable: r.nullable, default: r.default };
    if (isDuck()) stmts.push(...duckAddColumn(q, spec));
    else stmts.push(`ALTER TABLE ${q} ADD COLUMN ${columnDef(spec)}`);
    if (r.comment.trim()) stmts.push(`COMMENT ON COLUMN ${q}.${ident(r.name.trim())} IS ${lit(r.comment)}`);
  }

  const origPk = s.columns.filter((r) => r.origPk && r.orig).map((r) => r.orig!.name);
  const newPk = s.columns.filter((r) => !r.dropped && r.isPk && r.name.trim()).map((r) => r.name.trim());
  if (origPk.join("") !== newPk.join("")) {
    if (s.pkName && origPk.length) stmts.push(`ALTER TABLE ${q} DROP CONSTRAINT ${ident(s.pkName)}`);
    if (newPk.length) stmts.push(`ALTER TABLE ${q} ADD PRIMARY KEY (${newPk.map(ident).join(", ")})`);
  }

  for (const ix of s.dropIndexes) stmts.push(`DROP INDEX ${qualify(s.schema, ix)}`);
  for (const c of s.dropConstraints) stmts.push(`ALTER TABLE ${q} DROP CONSTRAINT ${ident(c)}`);

  if (s.newComment !== s.origComment)
    stmts.push(`COMMENT ON TABLE ${q} IS ${s.newComment.trim() === "" ? "NULL" : lit(s.newComment)}`);
  if (s.newName.trim() && s.newName.trim() !== s.table)
    stmts.push(`ALTER TABLE ${q} RENAME TO ${ident(s.newName.trim())}`);

  return stmts.join(";\n");
}

// --- DROP / TRUNCATE --------------------------------------------------------

const RELATION_KEYWORD: Record<string, string> = {
  table: "TABLE",
  view: "VIEW",
  matview: "MATERIALIZED VIEW",
};

export function dropRelation(kind: string, schema: string, name: string, cascade: boolean): string {
  return `DROP ${RELATION_KEYWORD[kind] ?? "TABLE"} ${qualify(schema, name)}${cascade ? " CASCADE" : ""}`;
}

export function dropSchema(name: string, cascade: boolean): string {
  return `DROP SCHEMA ${ident(name)}${cascade ? " CASCADE" : ""}`;
}

/** DROP DATABASE — must run as a single statement (cannot be in a transaction). */
export function dropDatabase(name: string): string {
  return `DROP DATABASE ${ident(name)}`;
}

export function dropIndex(schema: string, name: string, cascade: boolean): string {
  return `DROP INDEX ${qualify(schema, name)}${cascade ? " CASCADE" : ""}`;
}

export function dropSequence(schema: string, name: string, cascade: boolean): string {
  return `DROP SEQUENCE ${qualify(schema, name)}${cascade ? " CASCADE" : ""}`;
}

/** DROP FUNCTION by name (best-effort; errors if overloaded — needs arg types then). */
export function dropFunction(schema: string, name: string, cascade: boolean): string {
  return `DROP FUNCTION ${qualify(schema, name)}${cascade ? " CASCADE" : ""}`;
}

export function dropConstraint(schema: string, table: string, name: string, cascade: boolean): string {
  return `ALTER TABLE ${qualify(schema, table)} DROP CONSTRAINT ${ident(name)}${cascade ? " CASCADE" : ""}`;
}

export function dropTrigger(schema: string, table: string, name: string, cascade: boolean): string {
  return `DROP TRIGGER ${ident(name)} ON ${qualify(schema, table)}${cascade ? " CASCADE" : ""}`;
}

export function truncate(
  schema: string,
  name: string,
  o: { cascade: boolean; restartIdentity: boolean },
): string {
  // DuckDB's TRUNCATE takes no options.
  if (isDuck()) return `TRUNCATE TABLE ${qualify(schema, name)}`;
  let s = `TRUNCATE TABLE ${qualify(schema, name)}`;
  if (o.restartIdentity) s += " RESTART IDENTITY";
  if (o.cascade) s += " CASCADE";
  return s;
}

// --- RENAME -----------------------------------------------------------------

export function renameRelation(kind: string, schema: string, name: string, newName: string): string {
  const kw = kind === "view" ? "VIEW" : kind === "matview" ? "MATERIALIZED VIEW" : "TABLE";
  return `ALTER ${kw} ${qualify(schema, name)} RENAME TO ${ident(newName)}`;
}
export function renameColumn(schema: string, table: string, name: string, newName: string): string {
  return `ALTER TABLE ${qualify(schema, table)} RENAME COLUMN ${ident(name)} TO ${ident(newName)}`;
}
export function renameSchema(name: string, newName: string): string {
  return `ALTER SCHEMA ${ident(name)} RENAME TO ${ident(newName)}`;
}
export function renameIndex(schema: string, name: string, newName: string): string {
  return `ALTER INDEX ${qualify(schema, name)} RENAME TO ${ident(newName)}`;
}
export function renameConstraint(schema: string, table: string, name: string, newName: string): string {
  return `ALTER TABLE ${qualify(schema, table)} RENAME CONSTRAINT ${ident(name)} TO ${ident(newName)}`;
}
export function renameSequence(schema: string, name: string, newName: string): string {
  return `ALTER SEQUENCE ${qualify(schema, name)} RENAME TO ${ident(newName)}`;
}

// --- DUPLICATE --------------------------------------------------------------

/** Copy a table's structure (LIKE … INCLUDING ALL — defaults/constraints/indexes,
 *  but NOT foreign keys referencing it or triggers), optionally with data. */
export function duplicateTable(schema: string, name: string, newName: string, withData: boolean): string {
  const src = qualify(schema, name);
  const dst = qualify(schema, newName);
  // DuckDB has no `LIKE … INCLUDING ALL` — use CTAS (structure-only via `LIMIT 0`).
  // Note: CTAS copies columns/types but not PK/indexes/defaults (DuckDB limitation).
  if (isDuck()) return `CREATE TABLE ${dst} AS SELECT * FROM ${src}${withData ? "" : " LIMIT 0"}`;
  const create = `CREATE TABLE ${dst} (LIKE ${src} INCLUDING ALL)`;
  return withData ? `${create};\nINSERT INTO ${dst} SELECT * FROM ${src}` : create;
}

// --- INDEX / CONSTRAINT -----------------------------------------------------

export type IndexSpec = {
  schema: string;
  table: string;
  name?: string;
  unique: boolean;
  method: string;
  columns: string[];
  where?: string;
};
export function createIndex(ix: IndexSpec): string {
  const u = ix.unique ? "UNIQUE " : "";
  const nm = ix.name && ix.name.trim() ? `${ident(ix.name.trim())} ` : "";
  // DuckDB has a single (ART) index type and rejects `USING <method>`; omit it there.
  const m = !isDuck() && ix.method && ix.method !== "btree" ? ` USING ${ix.method}` : "";
  const w = ix.where && ix.where.trim() ? ` WHERE ${ix.where.trim()}` : "";
  return `CREATE ${u}INDEX ${nm}ON ${qualify(ix.schema, ix.table)}${m} (${ix.columns.map(ident).join(", ")})${w}`;
}

export function addPrimaryKey(schema: string, table: string, cols: string[]): string {
  return `ALTER TABLE ${qualify(schema, table)} ADD PRIMARY KEY (${cols.map(ident).join(", ")})`;
}
export function addUnique(schema: string, table: string, cols: string[], name?: string): string {
  const n = name && name.trim() ? `CONSTRAINT ${ident(name.trim())} ` : "";
  return `ALTER TABLE ${qualify(schema, table)} ADD ${n}UNIQUE (${cols.map(ident).join(", ")})`;
}
export function addCheck(schema: string, table: string, expr: string, name?: string): string {
  const n = name && name.trim() ? `CONSTRAINT ${ident(name.trim())} ` : "";
  return `ALTER TABLE ${qualify(schema, table)} ADD ${n}CHECK (${expr.trim()})`;
}
export type FkSpec = {
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
  name?: string;
};
export function addForeignKey(schema: string, table: string, fk: FkSpec): string {
  const n = fk.name && fk.name.trim() ? `CONSTRAINT ${ident(fk.name.trim())} ` : "";
  let s =
    `ALTER TABLE ${qualify(schema, table)} ADD ${n}FOREIGN KEY (${fk.columns.map(ident).join(", ")}) ` +
    `REFERENCES ${qualify(fk.refSchema, fk.refTable)} (${fk.refColumns.map(ident).join(", ")})`;
  if (fk.onDelete) s += ` ON DELETE ${fk.onDelete}`;
  if (fk.onUpdate) s += ` ON UPDATE ${fk.onUpdate}`;
  return s;
}

// --- SCHEMA / DATABASE ------------------------------------------------------

export function createSchema(name: string, authorization?: string): string {
  // DuckDB has no roles → no AUTHORIZATION clause.
  const a = !isDuck() && authorization && authorization.trim() ? ` AUTHORIZATION ${ident(authorization.trim())}` : "";
  return `CREATE SCHEMA ${ident(name)}${a}`;
}
export function createDatabase(name: string, owner?: string, encoding?: string): string {
  const opts: string[] = [];
  if (owner && owner.trim()) opts.push(`OWNER ${ident(owner.trim())}`);
  if (encoding && encoding.trim()) opts.push(`ENCODING ${lit(encoding.trim())}`);
  return `CREATE DATABASE ${ident(name)}${opts.length ? " WITH " + opts.join(" ") : ""}`;
}

// --- COMMENT ----------------------------------------------------------------

/** target e.g. `TABLE "public"."users"` or `COLUMN "public"."users"."id"`. */
export function comment(target: string, text: string | null): string {
  return `COMMENT ON ${target} IS ${text === null || text === "" ? "NULL" : lit(text)}`;
}

// --- MATVIEW / SEQUENCE actions ---------------------------------------------

export function refreshMatview(schema: string, name: string, concurrently: boolean): string {
  return `REFRESH MATERIALIZED VIEW ${concurrently ? "CONCURRENTLY " : ""}${qualify(schema, name)}`;
}
export function alterSequenceRestart(schema: string, name: string, value: string): string {
  return `ALTER SEQUENCE ${qualify(schema, name)} RESTART${value.trim() ? ` WITH ${value.trim()}` : ""}`;
}

// --- GENERATE statement scaffolds -------------------------------------------

// Query scaffolds drop the schema prefix when it matches the console's active
// schema (search_path) — see qualifyIn.
export function genSelect(schema: string, table: string, cols: string[], activeSchema?: string | null): string {
  const c = cols.length ? cols.map(ident).join(", ") : "*";
  return `SELECT ${c}\nFROM ${qualifyIn(schema, table, activeSchema)}\nLIMIT 100`;
}
export function genInsert(schema: string, table: string, cols: string[], activeSchema?: string | null): string {
  const names = cols.length ? cols : ["column"];
  return `INSERT INTO ${qualifyIn(schema, table, activeSchema)} (${names.map(ident).join(", ")})\nVALUES (${names
    .map(() => "NULL")
    .join(", ")})`;
}
export function genUpdate(
  schema: string,
  table: string,
  cols: string[],
  pkCols: string[],
  activeSchema?: string | null,
): string {
  const sets = (cols.length ? cols : ["column"]).map((c) => `${ident(c)} = NULL`).join(",\n  ");
  const keys = pkCols.length ? pkCols : cols.slice(0, 1);
  const where = (keys.length ? keys : ["id"]).map((c) => `${ident(c)} = NULL`).join(" AND ");
  return `UPDATE ${qualifyIn(schema, table, activeSchema)} SET\n  ${sets}\nWHERE ${where}`;
}
