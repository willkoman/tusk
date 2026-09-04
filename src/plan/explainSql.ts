import { lex, maskNonCode } from "../editor/lexer";
// Wrap a statement in the engine's best structured EXPLAIN form. Pure — used
// by the Explain / Explain Analyze actions.

export function explainSql(kind: string | null | undefined, analyze: boolean, stmt: string, duckJson: boolean): string {
  const s = stmt.trim().replace(/;+\s*$/, "");
  switch (kind) {
    case "mysql":
      return analyze ? `EXPLAIN ANALYZE ${s}` : `EXPLAIN FORMAT=JSON ${s}`;
    case "sqlite":
      return `EXPLAIN QUERY PLAN ${s}`; // no ANALYZE variant (caps-gated off)
    case "duckdb":
      // duckJson = the connect-time probe confirmed PG-style parenthesized
      // EXPLAIN options on this libduckdb build.
      if (analyze) return duckJson ? `EXPLAIN (ANALYZE, FORMAT json) ${s}` : `EXPLAIN ANALYZE ${s}`;
      return duckJson ? `EXPLAIN (FORMAT json) ${s}` : `EXPLAIN ${s}`;
    default: // postgres
      return analyze ? `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${s}` : `EXPLAIN (FORMAT JSON) ${s}`;
  }
}

/** True when EXPLAIN ANALYZE would execute a mutating statement. A `WITH` counts as a
 *  read only when the statement its CTEs feed is one (`WITH … UPDATE` is a write). */
export function analyzeExecutesWrite(stmt: string): boolean {
  const t = stmt.replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "").toLowerCase();
  const first = /^[a-z]*/.exec(t)![0];
  if (first === "with") {
    const shape = withShape(stmt);
    // Unparseable = assume it writes; the confirmation dialog is the safe default.
    return !shape || shape.modifyingCte || !READ_HEADS.has(shape.main);
  }
  return !(first === "select" || first === "table" || first === "values" || t === "");
}

const READ_HEADS = new Set(["select", "table", "values"]);
const WITH_MAIN_WORDS = new Set(["select", "insert", "update", "delete", "merge", "table", "values", "from", "pivot"]);
const MODIFYING = new Set(["insert", "update", "delete", "merge"]);

/** The shape of a `WITH`-led statement — TS mirror of Rust `script::with_shape`:
 *  `main` = the keyword of the statement the CTEs feed, `modifyingCte` = a CTE body is
 *  itself a write. `null` when not WITH-led or no main statement is found. A CTE name is
 *  a depth-0 word followed by `AS` (PostgreSQL leaves `update`/`delete` non-reserved). */
export function withShape(stmt: string): { main: string; modifyingCte: boolean } | null {
  const masked = maskNonCode(stmt, lex(stmt).spans, 0, stmt.length);
  const top: string[] = [];
  let depth = 0;
  let prevDepth = 0;
  let expectBody = false;
  let modifyingCte = false;
  let parenMain: string | null = null;
  const re = /[A-Za-z_][A-Za-z0-9_]*|[()]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const tok = m[0];
    if (tok === "(") { depth++; continue; }
    if (tok === ")") { depth = Math.max(0, depth - 1); continue; }
    const w = tok.toLowerCase();
    if (depth === 0) {
      expectBody = w === "as" || w === "materialized";
      top.push(w);
    } else if (prevDepth === 0) {
      if (expectBody) {
        expectBody = false;
        if (MODIFYING.has(w)) modifyingCte = true;
      } else if (top.length > 1 && parenMain === null && READ_HEADS.has(w)) {
        parenMain = w;
      }
    }
    prevDepth = depth;
  }
  if (top[0] !== "with") return null;
  let main: string | null = null;
  for (let i = 1; i < top.length; i++) {
    if (WITH_MAIN_WORDS.has(top[i]) && top[i + 1] !== "as") { main = top[i]; break; }
  }
  main ??= parenMain;
  return main ? { main, modifyingCte } : null;
}
