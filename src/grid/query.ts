import { sqlDialect } from "../sql/ident";
import { lex, maskNonCode } from "../editor/lexer";
import { isReadStatement } from "../plan/explainSql";
import { type ColumnClass, type FilterTree } from "./filterModel";
import { activeConditionCount, renderWhere } from "./filterSql";
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
 * A grid view carries active ordering or a filter that will actually generate
 * SQL. Conditions naming a column the result no longer has render as nothing, so
 * they must not count: a dead rule left over from an earlier result would
 * otherwise force every re-run through the server wrapper and permanently
 * disable the in-memory sort.
 */
export function hasViewRules(sorts: SortKey[], filters: FilterTree, columns: string[]): boolean {
  return sorts.length > 0 || activeConditionCount(filters, columns) > 0;
}

/**
 * Wrap `base` with optional WHERE (filters) and ORDER BY (sorts).
 * - ORDER BY uses **ordinal position** (`col+1`) to avoid duplicate-name ambiguity in `SELECT *`.
 * - The WHERE body is rendered by `grid/filterSql.ts` from the structured filter tree.
 * Returns a single statement with no trailing `;` (streams via the server cursor).
 */
export function wrapQuery(
  base: string,
  sorts: SortKey[],
  filters: FilterTree,
  columns: string[],
  dialect: string = "postgres",
  classOf?: (column: string) => ColumnClass,
): string {
  if (!wrappableQuery(base)) throw new Error("query cannot be safely wrapped for grid sorting or filtering");
  const inner = stripTrailingSemi(base);
  const where = renderWhere(filters, { columns, dialect, classOf });
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
