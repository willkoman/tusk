import type { Column } from "../Tree";
import { sqlDialect } from "../sql/ident";

// Boolean display/editing support for the result grid. Pure + vitest-covered.
//
// Detection is column-level, two-tier:
//  - type-based (exact) when the target table's detail is loaded (editable
//    grids): bool/boolean column types — covers PG ("t"/"f"), DuckDB
//    ("true"/"false"), SQLite declared-BOOLEAN ("0"/"1"). MySQL has no real
//    boolean (tinyint(1) is a display width, and information_schema.data_type
//    drops it) — never type-detected there. SQL Server's boolean is `bit`, and
//    ONLY on SQL Server: PostgreSQL's `bit` is a bit string, so the match is
//    dialect-gated rather than added to the pattern.
//  - value heuristic otherwise: every non-NULL loaded value is a textual
//    boolean token. "0"/"1" are deliberately NOT heuristic tokens — they would
//    misclassify integer columns; numeric booleans are only recognized when
//    the column type says so.
//
// The token a boolean edit COMMITS is dialect-dependent — see `boolEditTokens`.

/**
 * Whether a driver-reported column type is a boolean. `dialect` defaults to the
 * ACTIVE connection's; pass the owning connection's kind explicitly wherever the
 * result may not belong to it.
 */
export const isBoolType = (t: string, dialect: string = sqlDialect()): boolean => {
  const type = t.trim();
  if (dialect === "mssql") return /^bit$/i.test(type);
  return /^bool(ean)?$/i.test(type);
};

/**
 * The literal a boolean grid edit COMMITS, per dialect. Parity-bound to
 * `grid/filterSql.ts`'s `booleanLiteral`, `formats.ts`'s `sqlExportBool` and Rust
 * `export.rs`'s `sql_bool_literal`: SQLite/MySQL/SQL Server store 0/1, and T-SQL
 * has no TRUE/FALSE literal at all, so the quoted `N'true'` that `lit()` would
 * emit is rejected by a `bit` column.
 */
export function boolEditTokens(dialect: string = sqlDialect()): { trueVal: string; falseVal: string } {
  const numeric = dialect === "mysql" || dialect === "sqlite" || dialect === "mssql";
  return numeric ? { trueVal: "1", falseVal: "0" } : { trueVal: "true", falseVal: "false" };
}

/** Map a driver's textual boolean to its display word; null = not a boolean token. */
export function boolWord(v: string): "TRUE" | "FALSE" | null {
  switch (v) {
    case "t": case "true": case "TRUE": case "1": return "TRUE";
    case "f": case "false": case "FALSE": case "0": return "FALSE";
    default: return null;
  }
}

/**
 * What a boolean column STORES for pasted or filled text. Copy writes the display
 * word (`TRUE`/`FALSE`) and other grids write their own tokens (`t`, `1`,
 * `true`); a paste maps any of those to the connected engine's edit token,
 * exactly as the in-cell dropdown would — SQLite would otherwise keep the text
 * `TRUE` in an integer column and MySQL would reject it. NULL and text that is
 * not a boolean token pass through untouched for the server to judge.
 */
export function boolPasteValue(v: string | null, tokens: { trueVal: string; falseVal: string }): string | null {
  if (v === null) return null;
  const w = boolWord(v.trim());
  return w === "TRUE" ? tokens.trueVal : w === "FALSE" ? tokens.falseVal : v;
}

const HEUR_TOKENS = new Set(["t", "f", "true", "false", "TRUE", "FALSE"]);

/**
 * Heuristic: original column indices whose loaded values are all boolean
 * tokens (with at least one non-NULL value seen).
 */
export function detectBoolCols(columns: string[], rows: (string | null)[][]): Set<number> {
  const out = new Set<number>();
  for (let c = 0; c < columns.length; c++) {
    let seen = false;
    let ok = true;
    for (let r = 0; r < rows.length; r++) {
      const v = rows[r]?.[c];
      if (v === null || v === undefined) continue;
      seen = true;
      if (!HEUR_TOKENS.has(v)) { ok = false; break; }
    }
    if (ok && seen) out.add(c);
  }
  return out;
}

/** Type-based: result columns matched (case-insensitively) to bool-typed table columns. */
export function typeBoolCols(
  resultColumns: string[],
  tableCols: Column[],
  dialect: string = sqlDialect(),
): Set<number> {
  const types = new Map(tableCols.map((c) => [c.name.toLowerCase(), c.data_type]));
  const out = new Set<number>();
  resultColumns.forEach((name, i) => {
    const t = types.get(name.toLowerCase());
    if (t && isBoolType(t, dialect)) out.add(i);
  });
  return out;
}
