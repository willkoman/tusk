import { sqlDialect, withDialect } from "../sql/ident";
import { lex, maskNonCode, type SqlEngine } from "../editor/lexer";
import { isReadStatement } from "../plan/explainSql";
import { type ColumnClass, type FilterTree } from "./filterModel";
import { activeConditionCount, renderWhere } from "./filterSql";
import type { SortKey } from "../tabs";

// Server-side sort/filter works by wrapping the user's base query as a subquery and
// re-streaming it. Pure + unit-testable.

function queryShape(q: string, dialect: string = sqlDialect()): { inner: string; masked: string; safe: boolean } {
  const trimmed = q.trim();
  if (!trimmed) return { inner: "", masked: "", safe: false };
  // The lexer is engine-aware (backticks/`#` comments mask as non-code on
  // MySQL/SQLite), so no post-hoc backtick patching is needed here. Pass the OWNING
  // connection's dialect: the module default is the active connection's.
  const { spans } = lex(trimmed, dialect as SqlEngine);
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
export function stripTrailingSemi(q: string, dialect: string = sqlDialect()): string {
  const shape = queryShape(q, dialect);
  return shape.safe ? shape.inner : q.trim();
}

/**
 * A top-level `ORDER BY` that runs to the end of `inner`, split off from the body it
 * orders. T-SQL forbids a bare `ORDER BY` inside a derived table, so the wrapper lifts
 * that clause out and re-applies it to the wrap instead of refusing to filter every
 * ordered query.
 *
 * Returns null when there is nothing liftable: no top-level `ORDER BY`, more than one,
 * one that is not the trailing clause, or one carrying `OFFSET`/`FETCH` — that pagination
 * has to stay INSIDE the derived table (filtering before it would change which rows the
 * page holds), and T-SQL accepts an ordered subquery once it is present anyway.
 * `ORDER BY` inside parentheses (a subquery, an `OVER (…)` window) is not top level and
 * never counts.
 */
export function mssqlOrderTail(inner: string): { body: string; order: string } | null {
  const { spans } = lex(inner, "mssql");
  const masked = maskNonCode(inner, spans, 0, inner.length);
  let depth = 0;
  const tops: number[] = [];
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === "o" || c === "O")) {
      const m = /^order\s+by(?=\W|$)/i.exec(masked.slice(i));
      if (m && (i === 0 || /\W/.test(masked[i - 1]))) {
        tops.push(i);
        i += m[0].length - 1;
      }
    }
  }
  if (tops.length !== 1) return null;
  const at = tops[0];
  if (/(^|\W)(offset|fetch)(\W|$)/i.test(masked.slice(at))) return null;
  return { body: inner.slice(0, at).trimEnd(), order: inner.slice(at).trim() };
}

/**
 * T-SQL forbids both `WITH` and a bare `ORDER BY` inside a derived table, so a CTE-led
 * statement cannot be wrapped for grid sort/filter there. A trailing top-level
 * `ORDER BY` is not a refusal any more — `wrapQuery` lifts it onto the wrapper (see
 * `mssqlOrderTail`); only an ordering the wrap cannot hoist still blocks the wrap.
 */
export function mssqlWrappable(inner: string): boolean {
  const { spans } = lex(inner, "mssql");
  const masked = maskNonCode(inner, spans, 0, inner.length);
  if (/(^|\W)with\s/i.test(masked)) return false;
  if (!/(^|\W)order\s+by(\W|$)/i.test(masked)) return true;
  const lifted = mssqlOrderTail(inner);
  if (!lifted) return false;
  // Conservative, as before: window ordering (`OVER (ORDER BY …)`) and ordered
  // subqueries stay a refusal. Only a statement whose ONLY ordering is the trailing
  // top-level clause can be wrapped, because only that one is hoisted out.
  const rest = lex(lifted.body, "mssql");
  return !/(^|\W)order\s+by(\W|$)/i.test(maskNonCode(lifted.body, rest.spans, 0, lifted.body.length));
}

/**
 * Whether the base query can be wrapped as `SELECT * FROM (<q>) t` (single
 * row-producing statement). `dialect` must be the OWNING connection's kind — with
 * several connections open the module-level dialect belongs to the active one, and
 * a wrap decided under the wrong dialect would emit SQL the server rejects (or,
 * worse, accept a shape T-SQL cannot nest).
 */
export function wrappableQuery(q: string, dialect: string = sqlDialect()): boolean {
  const shape = queryShape(q, dialect);
  // The same structural WITH classifier protects Explain Analyze and backend
  // cursoring, so sorting/filtering cannot re-run a WITH-led write either.
  if (!shape.safe || !isReadStatement(shape.inner, dialect)) return false;
  return dialect !== "mssql" || mssqlWrappable(shape.inner);
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
  if (!wrappableQuery(base, dialect)) throw new Error("query cannot be safely wrapped for grid sorting or filtering");
  const stripped = stripTrailingSemi(base, dialect);
  // T-SQL rejects a bare ORDER BY inside a derived table, so the base query's trailing
  // ordering moves onto the wrapper — where it still orders the result the user sees,
  // and where a grid sort simply replaces it.
  const lifted = dialect === "mssql" ? mssqlOrderTail(stripped) : null;
  const inner = lifted?.body ?? stripped;
  // `renderWhere` reaches `ident`/`lit` implicitly, which read the ACTIVE connection's
  // dialect — pin the owning one, per the rule in `sql/ident.ts`.
  const where = withDialect(dialect, () => renderWhere(filters, { columns, dialect, classOf }));
  const order = sorts
    .filter((s) => s.col >= 0 && s.col < columns.length)
    .map((s) => `${s.col + 1} ${s.dir === "desc" ? "DESC" : "ASC"}`)
    .join(", ");
  // The newline keeps a trailing `--` comment inside the subquery from swallowing
  // the generated closing parenthesis.
  let sql = `SELECT * FROM (${inner}\n) AS _tusk`;
  if (where) sql += ` WHERE ${where}`;
  if (order) sql += ` ORDER BY ${order}`;
  else if (lifted) sql += ` ${lifted.order}`;
  return sql;
}
