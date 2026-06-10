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

/** True when EXPLAIN ANALYZE would execute a mutating statement. */
export function analyzeExecutesWrite(stmt: string): boolean {
  const t = stmt.replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "").toLowerCase();
  return !(t.startsWith("select") || t.startsWith("with") || t.startsWith("table") || t.startsWith("values") || t === "");
}
