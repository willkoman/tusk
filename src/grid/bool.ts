import type { Column } from "../Tree";

// Boolean display/editing support for the result grid. Pure + vitest-covered.
//
// Detection is column-level, two-tier:
//  - type-based (exact) when the target table's detail is loaded (editable
//    grids): bool/boolean column types — covers PG ("t"/"f"), DuckDB
//    ("true"/"false"), SQLite declared-BOOLEAN ("0"/"1"). MySQL has no real
//    boolean (tinyint(1) is a display width, and information_schema.data_type
//    drops it) — never type-detected there.
//  - value heuristic otherwise: every non-NULL loaded value is a textual
//    boolean token. "0"/"1" are deliberately NOT heuristic tokens — they would
//    misclassify integer columns; numeric booleans are only recognized when
//    the column type says so.

export const isBoolType = (t: string): boolean => /^bool(ean)?$/i.test(t.trim());

/** Map a driver's textual boolean to its display word; null = not a boolean token. */
export function boolWord(v: string): "TRUE" | "FALSE" | null {
  switch (v) {
    case "t": case "true": case "TRUE": case "1": return "TRUE";
    case "f": case "false": case "FALSE": case "0": return "FALSE";
    default: return null;
  }
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
export function typeBoolCols(resultColumns: string[], tableCols: Column[]): Set<number> {
  const types = new Map(tableCols.map((c) => [c.name.toLowerCase(), c.data_type]));
  const out = new Set<number>();
  resultColumns.forEach((name, i) => {
    const t = types.get(name.toLowerCase());
    if (t && isBoolType(t)) out.add(i);
  });
  return out;
}
