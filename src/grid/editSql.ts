import { ident, lit, qualify } from "../sql/ident";
import type { PendingEdits } from "../tabs";

// Commit-script builder for in-grid edits. Pure + vitest-covered.
//
// Statement order: UPDATEs, then DELETEs, then INSERTs. WHERE clauses always
// use the ORIGINAL snapshot values (the PK itself may have been edited);
// composite PKs are AND-ed; a NULL original compares with IS NULL. All values
// are text (simple protocol) — quoted via `lit`, which is dialect-aware.

export type CommitInput = {
  schema: string;
  table: string;
  /** Result columns, original order. */
  columns: string[];
  /** Per result column: belongs to the target table (others never written). */
  isTableCol: boolean[];
  /** Result-column indices of the PK columns. */
  pkIdx: number[];
  /** ORIGINAL loaded rows (snapshot — never mutated by editing). */
  rows: (string | null)[][];
  pending: PendingEdits;
  /** Drives the empty-INSERT form only (quoting follows the module-level dialect). */
  dialect?: string;
};

function pkWhere(input: CommitInput, row: (string | null)[]): string {
  const predicates = input.pkIdx
    .map((i) => {
      const v = row[i];
      return v === null || v === undefined
        ? `${ident(input.columns[i])} IS NULL`
        : `${ident(input.columns[i])} = ${lit(v)}`;
    });
  // Group every component and the conjunction itself. This keeps composite row
  // identity explicit if callers later compose the predicate with another clause.
  return `(${predicates.map((predicate) => `(${predicate})`).join(" AND ")})`;
}

/** The commit script as ordered single statements (joined by the caller). */
export function buildCommitScript(input: CommitInput): string[] {
  const { columns, isTableCol, rows, pending } = input;
  const target = qualify(input.schema, input.table);
  const deletes = new Set(pending.deletes);
  const out: string[] = [];

  // UPDATEs — skip rows marked for delete (delete wins).
  for (const key of Object.keys(pending.cells).map(Number).sort((a, b) => a - b)) {
    if (deletes.has(key)) continue;
    const row = rows[key];
    if (!row) continue;
    const sets: string[] = [];
    for (const c of Object.keys(pending.cells[key]).map(Number).sort((a, b) => a - b)) {
      if (!isTableCol[c]) continue;
      const v = pending.cells[key][c];
      sets.push(`${ident(columns[c])} = ${v === null ? "NULL" : lit(v)}`);
    }
    if (!sets.length) continue;
    out.push(`UPDATE ${target} SET ${sets.join(", ")} WHERE ${pkWhere(input, row)}`);
  }

  // DELETEs.
  for (const r of [...pending.deletes].sort((a, b) => a - b)) {
    const row = rows[r];
    if (!row) continue;
    out.push(`DELETE FROM ${target} WHERE ${pkWhere(input, row)}`);
  }

  // INSERTs — only touched cells; untouched columns are omitted (server defaults).
  for (const ins of pending.inserts) {
    const cols = Object.keys(ins).map(Number).filter((c) => isTableCol[c]).sort((a, b) => a - b);
    if (!cols.length) {
      out.push(
        input.dialect === "mysql"
          ? `INSERT INTO ${target} () VALUES ()`
          : `INSERT INTO ${target} DEFAULT VALUES`,
      );
      continue;
    }
    const names = cols.map((c) => ident(columns[c])).join(", ");
    const vals = cols.map((c) => (ins[c] === null ? "NULL" : lit(ins[c] as string))).join(", ");
    out.push(`INSERT INTO ${target} (${names}) VALUES (${vals})`);
  }

  return out;
}
