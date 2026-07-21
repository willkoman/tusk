import { lex, maskNonCode } from "../editor/lexer";
import { aliasMap, tableByRef, type Index, type Table } from "../sql/aliases";
import { hasDuplicateColumns, stripTrailingSemi, wrappableQuery } from "./query";
import type { RelationDetail } from "../Tree";

// In-grid editability detection. Pure + vitest-covered.
//
// A result is editable when the base query is a single-statement, single-table
// SELECT (no joins/aggregation/set ops), the table has a primary key, and every
// PK column is present in the result. Rejections carry a human-readable reason
// (surfaced as a tooltip on the grid).

export type EditTarget =
  | { ok: true; table: Table }
  | { ok: false; reason: string };

// Constructs that make a row's origin ambiguous — reject on the masked text so
// strings/comments can't false-positive.
const REJECT = /\b(join|group\s+by|distinct|union|intersect|except|having|returning)\b/i;

// A select item that is verifiably a real row's column: `*`, `t.*`, `col`,
// `t.col` — each part bare or double-quoted, NO alias, NO expression. Anything
// else (functions, arithmetic, CASE, literals, `expr AS id`) could collide with
// a table column name and make the commit's PK WHERE clause target the WRONG
// ROW — so it must reject, never guess.
const PLAIN_ITEM = /^(?:(?:[A-Za-z_]\w*|"[^"]+")\s*\.\s*)?(?:[A-Za-z_]\w*|"[^"]+"|\*)$/;

/**
 * Validate that the select list (masked text between SELECT and the top-level
 * FROM) contains only plain column references. Depth-tracked so a parenthesized
 * subexpression never hides the real FROM; any paren in the list itself fails
 * the per-item shape check.
 */
function plainSelectList(masked: string): { ok: boolean; reason?: string } {
  const m = /^\s*select\b/i.exec(masked);
  if (!m) return { ok: false, reason: "only SELECT results are editable" };
  let depth = 0;
  let listEnd = -1;
  const fromRe = /\(|\)|\bfrom\b/gi;
  fromRe.lastIndex = m[0].length;
  let g: RegExpExecArray | null;
  while ((g = fromRe.exec(masked))) {
    if (g[0] === "(") depth++;
    else if (g[0] === ")") depth--;
    else if (depth === 0) { listEnd = g.index; break; }
  }
  if (listEnd < 0) return { ok: false, reason: "no table detected in the query" };
  const items = masked.slice(m[0].length, listEnd).split(",");
  for (const raw of items) {
    const item = raw.trim();
    if (!PLAIN_ITEM.test(item))
      return { ok: false, reason: "only plain column selects are editable (no expressions or aliases)" };
  }
  return { ok: true };
}

/** Resolve the single table a base query reads from, or a reason it can't be edited. */
export function editTarget(baseQuery: string, idx: Index): EditTarget {
  const base = stripTrailingSemi(baseQuery);
  if (!base) return { ok: false, reason: "results from a script — run a single SELECT to edit" };
  // Plain SELECT only — WITH/TABLE/VALUES results can't be safely mapped back to rows.
  if (!wrappableQuery(base) || !/^select\b/i.test(base))
    return { ok: false, reason: "only SELECT results are editable" };
  const { spans, stmts } = lex(base);
  if (stmts.length > 1) return { ok: false, reason: "results from a script — run a single SELECT to edit" };
  // keepDquote: quoted identifiers are names the alias map must see (strings stay masked).
  const masked = maskNonCode(base, spans, 0, base.length, true);
  const m = REJECT.exec(masked);
  if (m) return { ok: false, reason: `${m[1].toLowerCase().replace(/\s+/g, " ")} queries aren't editable` };

  const sl = plainSelectList(masked);
  if (!sl.ok) return { ok: false, reason: sl.reason! };

  // Exactly one distinct table reference in scope.
  const refs = new Set<string>();
  for (const ref of aliasMap(masked).values()) refs.add(ref.toLowerCase());
  if (refs.size === 0) return { ok: false, reason: "no table detected in the query" };
  if (refs.size > 1) return { ok: false, reason: "multi-table queries aren't editable" };
  const ref = [...refs][0];
  const cleanRef = ref.replace(/"/g, "").toLowerCase();
  const matches = idx.tables.filter((t) =>
    cleanRef.includes(".")
      ? `${t.schema}.${t.name}`.toLowerCase() === cleanRef
      : t.name.toLowerCase() === cleanRef,
  );
  if (matches.length > 1)
    return { ok: false, reason: "case-colliding or ambiguous table names aren't editable; qualify an exact unique table" };
  const t = tableByRef(idx, ref);
  if (!t) return { ok: false, reason: "table not found in the schema" };
  return { ok: true, table: t };
}

export type EditPlan =
  | {
      ok: true;
      schema: string;
      table: string;
      /** Result-column indices of the primary-key columns (WHERE identity). */
      pkIdx: number[];
      /** Per result column: belongs to the target table (editable). */
      isTableCol: boolean[];
    }
  | { ok: false; reason: string };

/** Validate the loaded relation detail + result columns into a concrete edit plan. */
export function editPlan(detail: RelationDetail, resultColumns: string[], target: Table): EditPlan {
  if (detail.kind !== "table") return { ok: false, reason: `${detail.kind}s aren't editable` };
  if (hasDuplicateColumns(resultColumns))
    return { ok: false, reason: "duplicate column names in the result" };
  if (new Set(detail.columns.map((c) => c.name.toLowerCase())).size !== detail.columns.length)
    return { ok: false, reason: "tables with case-colliding column names aren't safely editable" };

  const pk = detail.columns.filter((c) => c.is_pk).map((c) => c.name);
  if (!pk.length) return { ok: false, reason: `table ${target.name} has no primary key` };

  const colIdx = new Map<string, number>();
  resultColumns.forEach((c, i) => colIdx.set(c.toLowerCase(), i));
  const pkIdx: number[] = [];
  for (const p of pk) {
    const i = colIdx.get(p.toLowerCase());
    if (i === undefined)
      return { ok: false, reason: `primary key column "${p}" isn't in the result` };
    pkIdx.push(i);
  }

  const tableCols = new Set(detail.columns.map((c) => c.name.toLowerCase()));
  const isTableCol = resultColumns.map((c) => tableCols.has(c.toLowerCase()));
  return { ok: true, schema: target.schema, table: target.name, pkIdx, isTableCol };
}
