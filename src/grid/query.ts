import { ident, lit } from "../sql/ident";
import type { SortKey, Filter } from "../tabs";

// Server-side sort/filter works by wrapping the user's base query as a subquery and
// re-streaming it. Pure + unit-testable.

/** Drop a single trailing `;` (and surrounding whitespace) so the query is a valid subquery. */
export function stripTrailingSemi(q: string): string {
  return q.trim().replace(/;\s*$/, "").trim();
}

/** Whether the base query can be wrapped as `SELECT * FROM (<q>) t` (single row-producing statement). */
export function wrappableQuery(q: string): boolean {
  return /^(select|with|table|values)\b/i.test(stripTrailingSemi(q));
}

/**
 * Wrap `base` with optional WHERE (filters) and ORDER BY (sorts).
 * - ORDER BY uses **ordinal position** (`col+1`) to avoid duplicate-name ambiguity in `SELECT *`.
 * - Filters cast each column to text and ILIKE-match (works on any type), AND-combined.
 * Returns a single statement with no trailing `;` (streams via the server cursor).
 */
export function wrapQuery(base: string, sorts: SortKey[], filters: Filter[], columns: string[]): string {
  const inner = stripTrailingSemi(base);
  const where = filters
    .filter((f) => f.text.trim() !== "" && columns[f.col] != null)
    .map((f) => `${ident(columns[f.col])}::text ILIKE ${lit("%" + f.text + "%")}`)
    .join(" AND ");
  const order = sorts
    .filter((s) => s.col >= 0 && s.col < columns.length)
    .map((s) => `${s.col + 1} ${s.dir === "desc" ? "DESC" : "ASC"}`)
    .join(", ");
  let sql = `SELECT * FROM (${inner}) AS _tusk`;
  if (where) sql += ` WHERE ${where}`;
  if (order) sql += ` ORDER BY ${order}`;
  return sql;
}
