import { aliasMap, strip, tableByRef, type Index } from "./aliases";
import { type FkEdge } from "./fk";

// FK-aware JOIN condition hints: after `JOIN orders o ON `, propose
// `o.user_id = u.id` for every FK edge connecting the just-joined table to any
// other table in the statement's scope. Pure — vitest-covered.

const STOP = "ON|USING|WHERE|GROUP|ORDER|HAVING|LIMIT|OFFSET|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|FULL|NATURAL|UNION|EXCEPT|INTERSECT|AND|OR|SET|RETURNING|VALUES|SELECT";
// Alias capture must not swallow a following keyword (`FROM users JOIN …`
// would otherwise eat JOIN as users' alias and hide the next table ref).
const LAST_REF = new RegExp(
  `\\b(?:FROM|JOIN)\\s+((?:"[^"]+"|[A-Za-z_]\\w*)(?:\\.(?:"[^"]+"|[A-Za-z_]\\w*))?)(?:\\s+(?:AS\\s+)?(?!(?:${STOP})\\b)("[^"]+"|[A-Za-z_]\\w*))?`,
  "gi",
);

/**
 * JOIN conditions for the table of the LAST `FROM`/`JOIN` ref before the
 * cursor, against every other in-scope table, derived from the FK catalog.
 * `stmtUpToCursor` = the current statement's text up to the caret.
 */
export function joinConditions(stmtUpToCursor: string, idx: Index, edges: FkEdge[]): string[] {
  if (!edges.length) return [];
  const aliases = aliasMap(stmtUpToCursor);
  if (aliases.size < 2) return []; // need at least two tables in scope

  // The last-joined ref + its display name (alias if present, else bare name).
  let last: { table: string; display: string } | null = null;
  let m: RegExpExecArray | null;
  LAST_REF.lastIndex = 0;
  while ((m = LAST_REF.exec(stmtUpToCursor))) {
    const ref = strip(m[1]);
    const alias = m[2] ? strip(m[2]) : "";
    const t = tableByRef(idx, ref);
    if (!t) continue;
    last = { table: t.name.toLowerCase(), display: alias || ref.split(".").pop()! };
  }
  if (!last) return [];

  // Other in-scope tables, ONE display name per table (aliasMap registers both
  // the alias and the bare table name — prefer the alias when one exists).
  const byTable = new Map<string, string>();
  for (const [key, ref] of aliases) {
    const t = tableByRef(idx, ref);
    if (!t) continue;
    const tn = t.name.toLowerCase();
    if (tn === last.table) continue;
    const cur = byTable.get(tn);
    if (cur === undefined || cur.toLowerCase() === tn) byTable.set(tn, key); // alias overrides bare name
  }
  const others = [...byTable].map(([table, display]) => ({ table, display }));

  const out: string[] = [];
  const emitted = new Set<string>();
  for (const e of edges) {
    const src = e.srcTable.toLowerCase();
    const dst = e.dstTable.toLowerCase();
    for (const o of others) {
      if (o.table === last.table) continue;
      let pairs: [string, string][] | null = null; // [lastCol, otherCol]
      if (src === last.table && dst === o.table) {
        pairs = e.srcCols.map((c, i) => [c, e.dstCols[i]] as [string, string]);
      } else if (dst === last.table && src === o.table) {
        pairs = e.dstCols.map((c, i) => [c, e.srcCols[i]] as [string, string]);
      }
      if (!pairs) continue;
      const cond = pairs.map(([a, b]) => `${last!.display}.${a} = ${o.display}.${b}`).join(" AND ");
      if (!emitted.has(cond)) {
        emitted.add(cond);
        out.push(cond);
      }
    }
  }
  return out;
}
