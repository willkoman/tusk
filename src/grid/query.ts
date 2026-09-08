import { sqlDialect } from "../sql/ident";
import { lex, maskNonCode } from "../editor/lexer";
import { isReadStatement } from "../plan/explainSql";
import { hasConditions, toFilterTree, type ColumnClass, type FilterInput } from "./filterModel";
import { renderWhere } from "./filterSql";
import type { SortKey } from "../tabs";

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

/**
 * A grid view carries active ordering or a non-empty filter (so a re-run should
 * re-apply it). Accepts the structured filter tree or the legacy flat array.
 */
export function hasViewRules(sorts: SortKey[], filters: FilterInput): boolean {
  if (sorts.length > 0) return true;
  // The legacy flat shape carries its own text, so it needs no column list.
  if (Array.isArray(filters)) return filters.some((f) => f.text.trim() !== "");
  return hasConditions(filters);
}

/**
 * Wrap `base` with optional WHERE (filters) and ORDER BY (sorts).
 * - ORDER BY uses **ordinal position** (`col+1`) to avoid duplicate-name ambiguity in `SELECT *`.
 * - The WHERE body is rendered by `grid/filterSql.ts` from the structured filter
 *   tree (a legacy flat `Filter[]` is migrated to a root AND of `contains`
 *   conditions first, so its SQL is unchanged).
 * Returns a single statement with no trailing `;` (streams via the server cursor).
 */
export function wrapQuery(
  base: string,
  sorts: SortKey[],
  filters: FilterInput,
  columns: string[],
  dialect: string = "postgres",
  classOf?: (column: string) => ColumnClass,
): string {
  if (!wrappableQuery(base)) throw new Error("query cannot be safely wrapped for grid sorting or filtering");
  const inner = stripTrailingSemi(base);
  const where = renderWhere(toFilterTree(filters, columns), { columns, dialect, classOf });
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
