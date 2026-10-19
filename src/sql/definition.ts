// Read-only "View definition" text for Explorer objects whose definition already
// rides along in the cached relation detail (constraints, indexes, triggers), so
// showing one needs no round trip and never touches the connection's result stream.
// Functions, sequences, views and tables come from the backend's `object_ddl`.
//
// Builders quote through `ident`/`qualify`, so callers wrap them in
// `withDialect(kind, …)` for the owning connection like every other DDL builder.

import type { Con, Idx, Trg } from "../Tree";
import { ident, qualify } from "./ident";

/** A comment line can't be broken by a name containing a newline. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ");

/** Append `;` only when the statement lacks one. */
export function terminated(sql: string): string {
  const t = sql.trimEnd();
  return t.endsWith(";") ? t : `${t};`;
}

const CONSTRAINT_LABELS: Record<string, string> = {
  primary_key: "Primary key",
  foreign_key: "Foreign key",
  unique: "Unique",
  check: "Check",
};

/** "Foreign key", "Check", … — unknown kinds read as plain words. */
export function constraintLabel(kind: string): string {
  return CONSTRAINT_LABELS[kind] ?? (kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) || "Constraint");
}

/**
 * A constraint as the statement that would add it. Every driver reports `def` as the
 * CLAUSE a CREATE TABLE takes back verbatim (`FOREIGN KEY (…) REFERENCES …`), so on an
 * engine with `ALTER TABLE … ADD CONSTRAINT` it is a runnable statement; elsewhere it
 * is shown as the table-definition clause it is.
 */
export function constraintDefinition(schema: string, table: string, con: Con, canAlterAdd: boolean): string {
  const head = `-- ${constraintLabel(con.kind)} constraint ${oneLine(con.name || "(unnamed)")} on ${oneLine(`${schema}.${table}`)}`;
  const def = con.def.trim();
  if (!def) return `${head}\n-- The engine did not report its definition.\n`;
  const named = con.name ? `CONSTRAINT ${ident(con.name)} ${def}` : def;
  if (canAlterAdd) return `${head}\nALTER TABLE ${qualify(schema, table)}\n  ADD ${named};\n`;
  return `${head}\n-- Part of the table's definition: this engine cannot add it with ALTER TABLE.\n${named}\n`;
}

/** An index's stored definition (PostgreSQL `pg_get_indexdef`, SQLite's CREATE text, …). */
export function indexDefinition(schema: string, table: string, idx: Idx): string {
  const kind = idx.primary ? "Primary-key index" : idx.unique ? "Unique index" : "Index";
  const head = `-- ${kind} ${oneLine(idx.name)} on ${oneLine(`${schema}.${table}`)}`;
  const def = idx.def.trim();
  const cols = idx.columns?.length ? `\n-- Key columns: ${oneLine(idx.columns.join(", "))}` : "";
  if (!def) return `${head}${cols}\n-- The engine keeps no definition text for this index (it backs a constraint).\n`;
  return `${head}${cols}\n${terminated(def)}\n`;
}

/** A trigger's definition (`pg_get_triggerdef` and the other engines' stored text). */
export function triggerDefinition(schema: string, table: string, trg: Trg): string {
  const head = `-- Trigger ${oneLine(trg.name)} on ${oneLine(`${schema}.${table}`)}`;
  const def = trg.def.trim();
  return def ? `${head}\n${terminated(def)}\n` : `${head}\n-- The engine did not report its definition.\n`;
}
