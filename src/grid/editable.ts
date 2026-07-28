import { lex, maskNonCode } from "../editor/lexer";
import { aliasMap, identifierParts, tableByRef, tableByRefUnique, type Index, type Table } from "../sql/aliases";
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
const IDENT = `(?:"(?:[^"]|"")+"|\`(?:[^\`]|\`\`)+\`|[A-Za-z_]\\w*)`;
const PLAIN_ITEM = new RegExp(`^(?:(${IDENT})\\s*\\.\\s*)?(${IDENT}|\\*)$`);
const TABLE_SOURCE = new RegExp(
  `^(${IDENT})(?:\\s*\\.\\s*(${IDENT}))?(?:\\s+(?:AS\\s+)?(${IDENT}))?$`,
  "i",
);

type TopToken = { kind: "word" | "comma"; text: string; from: number; to: number };

/** Bare top-level words/commas, skipping quoted identifiers and nested expressions. */
function topTokens(sql: string): TopToken[] {
  const out: TopToken[] = [];
  let depth = 0;
  for (let i = 0; i < sql.length;) {
    const ch = sql[i];
    if (ch === '"' || ch === "`") {
      const q = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "(") { depth++; i++; continue; }
    if (ch === ")") { depth--; i++; continue; }
    if (depth === 0 && ch === ",") { out.push({ kind: "comma", text: ch, from: i, to: i + 1 }); i++; continue; }
    if (depth === 0 && /[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < sql.length && /\w/.test(sql[j])) j++;
      out.push({ kind: "word", text: sql.slice(i, j), from: i, to: j });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

function splitItems(list: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const q = list[i] === '"' || list[i] === "`" ? list[i] : null;
    if (q) {
      i++;
      while (i < list.length) {
        if (list[i] === q) {
          if (list[i + 1] === q) { i += 2; continue; }
          break;
        }
        i++;
      }
    } else if (list[i] === ",") {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  return out;
}

/**
 * Validate that the select list (masked text between SELECT and the top-level
 * FROM) contains only plain column references. Depth-tracked so a parenthesized
 * subexpression never hides the real FROM; any paren in the list itself fails
 * the per-item shape check.
 */
function plainSelectList(masked: string, selectEnd: number, listEnd: number): { ok: boolean; reason?: string; qualifiers: string[] } {
  const qualifiers: string[] = [];
  const items = splitItems(masked.slice(selectEnd, listEnd));
  for (const raw of items) {
    const item = raw.trim();
    const m = PLAIN_ITEM.exec(item);
    if (!m)
      return { ok: false, reason: "only plain column selects are editable (no expressions or aliases)", qualifiers };
    if (m[1]) qualifiers.push(m[1]);
  }
  return { ok: true, qualifiers };
}

function sameQualifier(a: string, b: string): boolean {
  const ap = identifierParts(a);
  const bp = identifierParts(b);
  if (!ap || !bp || ap.length !== 1 || bp.length !== 1) return false;
  const x = ap[0];
  const y = bp[0];
  return x.quoted === '"' || y.quoted === '"'
    ? (x.quoted === '"' ? x.value : x.value.toLowerCase()) === (y.quoted === '"' ? y.value : y.value.toLowerCase())
    : x.value.toLowerCase() === y.value.toLowerCase();
}

function hasCommaJoin(sql: string): boolean {
  const active = new Set<number>();
  const stop = new Set(["where", "group", "order", "having", "limit", "offset", "fetch", "for", "union", "intersect", "except", "window", "qualify", "returning"]);
  let depth = 0;
  for (let i = 0; i < sql.length;) {
    const ch = sql[i];
    if (ch === '"' || ch === "`") {
      const q = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "(") { depth++; i++; continue; }
    if (ch === ")") { active.delete(depth); depth--; i++; continue; }
    if (ch === "," && active.has(depth)) return true;
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < sql.length && /\w/.test(sql[j])) j++;
      const word = sql.slice(i, j).toLowerCase();
      if (word === "from") active.add(depth);
      else if (stop.has(word)) active.delete(depth);
      i = j;
      continue;
    }
    i++;
  }
  return false;
}

/** Resolve the single table a base query reads from, or a reason it can't be edited.
 * `activeSchema` = the tab's active schema when set: it pins the server's
 * `search_path` to `<schema>, public`, so a bare name may resolve through that
 * chain. With NO active schema the server default (`"$user", public`) is not
 * knowable client-side, and an ambiguous bare name stays uneditable — a write
 * must never guess which physical table the query read. */
export function editTarget(baseQuery: string, idx: Index, activeSchema: string | null = null): EditTarget {
  const resolve = (ref: string) =>
    activeSchema != null ? tableByRef(idx, ref, activeSchema) : tableByRefUnique(idx, ref);
  const base = stripTrailingSemi(baseQuery);
  if (!base) return { ok: false, reason: "results from a script — run a single SELECT to edit" };
  // Plain SELECT only — WITH/TABLE/VALUES results can't be safely mapped back to rows.
  if (!wrappableQuery(base))
    return { ok: false, reason: "only SELECT results are editable" };
  const { spans, stmts } = lex(base);
  if (stmts.length > 1) return { ok: false, reason: "results from a script — run a single SELECT to edit" };
  // keepDquote: quoted identifiers are names the alias map must see (strings stay masked).
  const masked = maskNonCode(base, spans, 0, base.length, true);
  // Reject words only in SQL code, not inside either identifier quote style.
  const keywordText = masked.replace(/"(?:[^"]|"")*"|`(?:[^`]|``)*`/g, (s) => " ".repeat(s.length));
  const m = REJECT.exec(keywordText);
  if (m) return { ok: false, reason: `${m[1].toLowerCase().replace(/\s+/g, " ")} queries aren't editable` };
  if (/\bfrom\s*\(/i.test(keywordText)) return { ok: false, reason: "derived-table queries aren't editable" };
  const functionSource = /\bfrom\s+[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)?\s*\(/i;
  if (functionSource.test(keywordText)) return { ok: false, reason: "table-function queries aren't editable" };
  if (hasCommaJoin(masked)) return { ok: false, reason: "comma-join queries aren't editable" };

  const tokens = topTokens(masked);
  const select = tokens.find((token) => token.kind === "word");
  if (!select || select.text.toLowerCase() !== "select")
    return { ok: false, reason: "only SELECT results are editable" };
  const fromAt = tokens.findIndex((token) => token.kind === "word" && token.text.toLowerCase() === "from");
  if (fromAt < 0) return { ok: false, reason: "no table detected in the query" };
  const from = tokens[fromAt];
  const endWords = new Set(["where", "group", "having", "order", "limit", "offset", "fetch", "for", "union", "intersect", "except", "window", "qualify", "returning"]);
  const sourceEnd = tokens.slice(fromAt + 1).find((token) => token.kind === "word" && endWords.has(token.text.toLowerCase()))?.from ?? masked.length;
  const sourceTokens = tokens.filter((token) => token.from >= from.to && token.from < sourceEnd);
  if (sourceTokens.some((token) => token.kind === "comma"))
    return { ok: false, reason: "comma-join queries aren't editable" };
  const source = masked.slice(from.to, sourceEnd).trim();
  if (source.startsWith("(")) return { ok: false, reason: "derived-table queries aren't editable" };
  const sourceMatch = TABLE_SOURCE.exec(source);
  if (!sourceMatch) {
    const functionHead = new RegExp(`^${IDENT}(?:\\s*\\.\\s*${IDENT})?\\s*\\(`, "i");
    if (functionHead.test(source)) return { ok: false, reason: "table-function queries aren't editable" };
    return { ok: false, reason: "only one plain table source is editable" };
  }

  const sl = plainSelectList(masked, select.to, from.from);
  if (!sl.ok) return { ok: false, reason: sl.reason! };

  const ref = sourceMatch[2] ? `${sourceMatch[1]}.${sourceMatch[2]}` : sourceMatch[1];
  const t = resolve(ref);
  if (!t) return { ok: false, reason: "table not found, case-colliding, or ambiguous in the schema" };

  const effectiveQualifier = sourceMatch[3] ?? sourceMatch[2] ?? sourceMatch[1];
  if (sl.qualifiers.some((qualifier) => !sameQualifier(qualifier, effectiveQualifier)))
    return { ok: false, reason: "selected-column qualifier doesn't match the target table or alias" };

  // Subqueries used only for filtering may remain, but every table ref they contain
  // must resolve to this same physical relation. Never infer identity through an
  // unknown function/CTE or a second table.
  for (const nestedRef of new Set(aliasMap(masked).values())) {
    if (resolve(nestedRef) !== t)
      return { ok: false, reason: "multi-table or unresolved-source queries aren't editable" };
  }
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
  if (detail.name !== target.name) return { ok: false, reason: "relation metadata no longer matches the query target" };
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
