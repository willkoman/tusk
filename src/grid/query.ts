import { ident, lit, sqlDialect } from "../sql/ident";
import { lex, maskNonCode } from "../editor/lexer";
import { isReadStatement } from "../plan/explainSql";
import type { SortKey, Filter } from "../tabs";

// Server-side sort/filter works by wrapping the user's base query as a subquery and
// re-streaming it. Pure + unit-testable.

function queryShape(q: string): { inner: string; masked: string; safe: boolean } {
  const trimmed = q.trim();
  if (!trimmed) return { inner: "", masked: "", safe: false };
  // The lexer is engine-aware (backticks/`#` comments mask as non-code on
  // MySQL/SQLite), so no post-hoc backtick patching is needed here.
  const { spans } = lex(trimmed);
  const masked = maskNonCode(trimmed, spans, 0, trimmed.length);
  const semis = [...masked.matchAll(/;/g)].map((m) => m.index!);
  if (semis.length > 1) return { inner: trimmed, masked, safe: false };
  if (semis.length === 1 && masked.slice(semis[0] + 1).trim())
    return { inner: trimmed, masked, safe: false };
  if (!semis.length) return { inner: trimmed, masked, safe: true };
  const at = semis[0];
  return {
    inner: (trimmed.slice(0, at) + trimmed.slice(at + 1)).trim(),
    masked: masked.slice(0, at) + " " + masked.slice(at + 1),
    safe: true,
  };
}

/** Drop one true trailing statement terminator; semicolons in literals/comments stay intact. */
export function stripTrailingSemi(q: string): string {
  const shape = queryShape(q);
  return shape.safe ? shape.inner : q.trim();
}

/** Whether the base query can be wrapped as `SELECT * FROM (<q>) t` (single row-producing statement). */
export function wrappableQuery(q: string): boolean {
  const shape = queryShape(q);
  // The same structural WITH classifier protects Explain Analyze and backend
  // cursoring, so sorting/filtering cannot re-run a WITH-led write either.
  return shape.safe && isReadStatement(shape.inner, sqlDialect());
}

/** True when two result columns share a name (MySQL refuses to wrap those — error 1060). */
export function hasDuplicateColumns(cols: string[]): boolean {
  return new Set(cols.map((c) => c.toLowerCase())).size !== cols.length;
}

/** A grid view carries active ordering or a non-empty filter (so a re-run should re-apply it). */
export function hasViewRules(sorts: SortKey[], filters: Filter[]): boolean {
  return sorts.length > 0 || filters.some((f) => f.text.trim() !== "");
}

/** Per-dialect "stringify column and case-insensitively LIKE-match" expression. */
function filterExpr(col: string, text: string, dialect: string): string {
  const pat = lit("%" + text + "%");
  switch (dialect) {
    case "mysql":
      return `CAST(${ident(col)} AS CHAR) LIKE ${pat}`; // CI by default collation
    case "sqlite":
      return `CAST(${ident(col)} AS TEXT) LIKE ${pat}`; // LIKE is CI (ASCII) by default
    default: // postgres, duckdb
      return `${ident(col)}::text ILIKE ${pat}`;
  }
}

/**
 * Wrap `base` with optional WHERE (filters) and ORDER BY (sorts).
 * - ORDER BY uses **ordinal position** (`col+1`) to avoid duplicate-name ambiguity in `SELECT *`.
 * - Filters cast each column to text and case-insensitively match — per DIALECT
 *   (`ILIKE` is PG/DuckDB-only; MySQL/SQLite use CAST + LIKE), AND-combined.
 * Returns a single statement with no trailing `;` (streams via the server cursor).
 */
export function wrapQuery(
  base: string,
  sorts: SortKey[],
  filters: Filter[],
  columns: string[],
  dialect: string = "postgres",
): string {
  if (!wrappableQuery(base)) throw new Error("query cannot be safely wrapped for grid sorting or filtering");
  const inner = stripTrailingSemi(base);
  const activeFilters = filters.filter((f) => f.text.trim() !== "" && columns[f.col] != null);
  const duplicateNames = new Set(
    columns
      .map((name) => dialect === "postgres" ? name : name.toLowerCase())
      .filter((name, i, all) => all.indexOf(name) !== i),
  );
  if (activeFilters.some((f) => duplicateNames.has(dialect === "postgres" ? columns[f.col] : columns[f.col].toLowerCase())))
    throw new Error("cannot safely filter a result with duplicate target column names");
  const where = activeFilters
    .map((f) => filterExpr(columns[f.col], f.text, dialect))
    .join(" AND ");
  const order = sorts
    .filter((s) => s.col >= 0 && s.col < columns.length)
    .map((s) => `${s.col + 1} ${s.dir === "desc" ? "DESC" : "ASC"}`)
    .join(", ");
  // The newline keeps a trailing `--` comment inside the subquery from swallowing
  // the generated closing parenthesis.
  let sql = `SELECT * FROM (${inner}\n) AS _tusk`;
  if (where) sql += ` WHERE ${where}`;
  if (order) sql += ` ORDER BY ${order}`;
  return sql;
}
