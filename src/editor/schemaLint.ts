import { type Diagnostic } from "@codemirror/lint";
import { type EditorView } from "@codemirror/view";
import { aliasMap, makeIndexer, strip, tableByRef, type Index, type Table } from "../sql/aliases";
import { ALL_SQL_FUNCTIONS, ALL_SQL_WORDS } from "../sql/dialects";
import { docString, lexState, maskNonCode, type Span, type Stmt } from "./lexer";
import { closest, damerau } from "./distance";

// `EXTRACT(YEAR FROM x)` / `SUBSTRING(s FROM 2)` / `TRIM(x FROM y)` … contain a
// grammatical FROM that is NOT a table position. Blank those argument lists
// (length-preserving) in the copy used for table-ref scanning.
const FN_KEYWORD_ARGS = /\b(?:EXTRACT|SUBSTRING|POSITION|OVERLAY|TRIM)\s*\(([^()]*)\)/gi;
function maskFnKeywordArgs(masked: string): string {
  return masked.replace(FN_KEYWORD_ARGS, (m) => m[0] + " ".repeat(m.length - 1));
}

// Schema-aware identifier lint — the production-editor layer. Flags, with
// did-you-mean suggestions:
//   (1) unknown columns in qualified `alias.col` refs
//   (2) unknown tables after FROM/JOIN/UPDATE/INTO
//   (3) unknown function/procedure calls — ONLY when the live function catalog
//       is loaded (PG pg_proc / DuckDB / SQLite; empty catalog = lint off, a
//       partial list would false-positive on every uncommon builtin)
//   (4) bare identifiers that are neither SQL vocabulary, a function, an alias,
//       nor a column of any in-scope table — catches misspelled columns AND
//       misspelled mid-statement keywords (`SELECT * FORM t`)
//
// (4) is the false-positive minefield, so it's heavily gated: DML statements
// only, every table ref must resolve, and statements with CTEs or derived
// tables (whose column sets we can't know) skip it entirely. All diagnostics
// are warnings — the server linter stays the ground truth when connected.

const IDENT = `(?:"[^"]+"|[A-Za-z_]\\w*)`;
const QUALIFIED = /\b([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)\b/g;
const TABLE_POS = new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO)\\s+(${IDENT}(?:\\.${IDENT})?)`, "gi");
const CTE_DEF = new RegExp(`(${IDENT})\\s+AS\\s*\\(`, "gi");
const FN_CALL = /(?:([A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*\(/g;
const AS_TARGET = /\bAS\s+([A-Za-z_]\w*)/gi;
const WINDOW_DEF = /\bWINDOW\s+([A-Za-z_]\w*)/gi;
const WORD = /[A-Za-z_]\w*/g;
/** Heads of statements where bare-identifier checking is safe to attempt. */
const DML_HEADS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "WITH"]);
/** A word right after one of these is a name being DEFINED/referenced, not a column. */
const PREV_SKIP = new Set(["AS", "USING", "OVER", "WINDOW", "EXCLUDE", "LANGUAGE", "ISOLATION"]);
/** Suggestion pool for misspelled clause keywords (curated — obscure words are noise). */
const KEYWORD_SUGGESTIONS = ["FROM", "WHERE", "SELECT", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "JOIN", "VALUES", "BETWEEN", "DISTINCT", "RETURNING", "UNION"];

export type SchemaDiag = {
  from: number;
  to: number;
  message: string;
  /** Replacement suggestion (drives the quick-fix action). */
  suggestion?: string;
};

/**
 * Pure diagnostic core (unit-tested without an EditorView). `funcs` is the
 * lowercase live function catalog — empty set disables check (3).
 */
export function schemaDiagnostics(
  doc: string,
  spans: Span[],
  stmts: Stmt[],
  idx: Index,
  funcs: ReadonlySet<string>,
): SchemaDiag[] {
  const diags: SchemaDiag[] = [];

  for (const stmt of stmts) {
    const masked = maskNonCode(doc, spans, stmt.from, stmt.to, true); // keep "quoted" identifiers
    const base = stmt.from;
    // Table positions are scanned on a copy with EXTRACT/SUBSTRING/… argument
    // lists blanked, so their grammatical FROM doesn't read as a table ref.
    const tableScan = maskFnKeywordArgs(masked);
    const aliases = aliasMap(tableScan);

    const cte = new Set<string>();
    for (const m of masked.matchAll(CTE_DEF)) cte.add(strip(m[1]).toLowerCase());

    // (1) Qualified column references: alias.col / table.col.
    for (const m of masked.matchAll(QUALIFIED)) {
      const alias = m[1];
      const col = m[2];
      // x.y( is a qualified function call, not a column ref.
      let after = m.index! + m[0].length;
      while (after < masked.length && /\s/.test(masked[after])) after++;
      if (masked[after] === "(") continue;
      const ref = aliases.get(alias.toLowerCase()) ?? alias;
      const t = tableByRef(idx, ref);
      if (!t || cte.has(alias.toLowerCase())) continue;
      if (t.columns.some((c) => c.name.toLowerCase() === col.toLowerCase())) continue;
      const colStart = base + m.index! + alias.length + 1;
      const sugg = closest(col, t.columns.map((c) => c.name));
      diags.push({
        from: colStart,
        to: colStart + col.length,
        message: `no column "${col}" on ${t.name}${sugg ? ` — did you mean "${sugg}"?` : ""}`,
        suggestion: sugg ?? undefined,
      });
    }

    // (2) Table references after FROM / JOIN / UPDATE / INTO.
    let allTablesResolve = true;
    let sawTable = false;
    for (const m of tableScan.matchAll(TABLE_POS)) {
      const raw = m[1];
      const name = strip(raw);
      sawTable = true;
      if (tableByRef(idx, name)) continue;
      const parts = name.split(".");
      const bare = parts[parts.length - 1].toLowerCase();
      if (cte.has(bare)) {
        continue; // known CTE — fine, but its columns are opaque (gates check 4 via `cte`)
      }
      let after = m.index! + m[0].length;
      while (after < tableScan.length && /\s/.test(tableScan[after])) after++;
      if (after < tableScan.length && tableScan[after] === "(") continue; // table function
      if (parts.length > 1 && !idx.schemas.some((s) => s.toLowerCase() === parts[parts.length - 2].toLowerCase())) {
        allTablesResolve = false; // foreign catalog — unverifiable
        continue;
      }
      allTablesResolve = false;
      const tokStart = base + m.index! + (m[0].length - raw.length);
      const sugg = closest(bare, idx.tables.map((t) => t.name));
      diags.push({
        from: tokStart,
        to: tokStart + raw.length,
        message: `unknown table "${name}"${sugg ? ` — did you mean "${sugg}"?` : ""}`,
        suggestion: sugg ?? undefined,
      });
    }

    // (3) Function / procedure calls, against the live catalog.
    if (funcs.size) {
      FN_CALL.lastIndex = 0;
      let fm: RegExpExecArray | null;
      while ((fm = FN_CALL.exec(masked))) {
        const qualifier = fm[1]?.toLowerCase();
        const name = fm[2];
        const lower = name.toLowerCase();
        if (ALL_SQL_WORDS.has(name.toUpperCase())) continue; // CAST( / VALUES( / ANY( …
        if (ALL_SQL_FUNCTIONS.has(lower) || funcs.has(lower)) continue;
        if (cte.has(lower) || aliases.has(lower) || idx.byBare.has(lower)) continue;
        if (qualifier) {
          // schema-qualified → still the same proname; alias-qualified → not a call we judge
          if (!idx.schemas.some((s) => s.toLowerCase() === qualifier)) continue;
        }
        const start = base + fm.index + (fm[1] ? fm[0].indexOf(name, fm[1].length) : 0);
        const sugg = closest(lower, funcs);
        diags.push({
          from: start,
          to: start + name.length,
          message: `unknown function "${name}"${sugg ? ` — did you mean "${sugg}"?` : ""}`,
          suggestion: sugg ?? undefined,
        });
      }
    }

    // (4) Bare identifiers — only under heavy gates. Two modes:
    //   full: every table resolved → unknown bare names checked against the
    //         in-scope column union (catches misspelled columns + keywords).
    //   keyword-typo: tables unresolved/absent (often BECAUSE a clause keyword
    //         is misspelled — `SELECT id FORM users`) → flag only tokens one
    //         edit away from a clause keyword. Surgical, zero column guessing.
    const headMatch = /[A-Za-z_]\w*/.exec(masked);
    const head = headMatch?.[0]?.toUpperCase() ?? "";
    const hasDerived = /\b(?:FROM|JOIN)\s*\(/i.test(masked);
    if (!DML_HEADS.has(head) || cte.size || hasDerived) continue;
    const fullMode = sawTable && allTablesResolve;

    const scopeCols = new Set<string>();
    const scopeColNames: string[] = [];
    if (fullMode) {
      for (const ref of new Set(aliases.values())) {
        const t = tableByRef(idx, ref);
        if (!t) continue;
        for (const c of t.columns) {
          const lc = c.name.toLowerCase();
          if (!scopeCols.has(lc)) {
            scopeCols.add(lc);
            scopeColNames.push(c.name);
          }
        }
      }
      if (!scopeCols.size) continue;
    }

    const asTargets = new Set<string>();
    for (const m of masked.matchAll(AS_TARGET)) asTargets.add(m[1].toLowerCase());
    for (const m of masked.matchAll(WINDOW_DEF)) asTargets.add(m[1].toLowerCase());

    WORD.lastIndex = 0;
    let prevWord = "";
    let prevEnd = 0;
    let quotes = 0; // running '"' parity — tokens inside quoted identifiers are skipped
    let wm: RegExpExecArray | null;
    while ((wm = WORD.exec(masked))) {
      const tok = wm[0];
      const at = wm.index;
      for (let i = prevEnd; i < at; i++) if (masked[i] === '"') quotes++;
      const inQuoted = quotes % 2 === 1;
      const before = at > 0 ? masked[at - 1] : "";
      let after = at + tok.length;
      while (after < masked.length && /[ \t]/.test(masked[after])) after++;
      const nextCh = masked[after] ?? "";
      const adjacentPrev = masked.slice(prevEnd, at).trim() === "" ? prevWord : "";
      prevWord = tok.toUpperCase();
      prevEnd = at + tok.length;

      const upper = tok.toUpperCase();
      const lower = tok.toLowerCase();
      if (inQuoted) continue;
      if (ALL_SQL_WORDS.has(upper)) continue;
      if (before === "." || before === '"' || before === ":" || before === "@" || before === "$" || (before === "%" && lower === "s")) continue;
      if (nextCh === "(" || nextCh === ".") continue; // function call / qualifier — other checks own these
      if (PREV_SKIP.has(adjacentPrev)) continue;
      if (aliases.has(lower) || cte.has(lower) || asTargets.has(lower)) continue;
      if (ALL_SQL_FUNCTIONS.has(lower) || funcs.has(lower)) continue;

      if (fullMode) {
        if (scopeCols.has(lower)) continue;
        const sugg = closest(tok, [...scopeColNames, ...KEYWORD_SUGGESTIONS]);
        diags.push({
          from: base + at,
          to: base + at + tok.length,
          message: `unknown identifier "${tok}"${sugg ? ` — did you mean "${sugg}"?` : ""}`,
          suggestion: sugg ?? undefined,
        });
      } else {
        const kw = KEYWORD_SUGGESTIONS.find((k) => damerau(upper, k) === 1);
        if (kw) {
          diags.push({
            from: base + at,
            to: base + at + tok.length,
            message: `unknown keyword "${tok}" — did you mean ${kw}?`,
            suggestion: kw,
          });
        }
      }
    }
  }
  return diags;
}

function replaceAction(from: number, to: number, text: string) {
  return [
    {
      name: `Replace with "${text}"`,
      apply: (view: EditorView) => view.dispatch({ changes: { from, to, insert: text } }),
    },
  ];
}

/** CodeMirror wrapper: live schema + function catalog in, Diagnostics out. */
export function schemaLintSource(getSchema: () => Table[], getFuncs: () => ReadonlySet<string>) {
  const indexOf = makeIndexer();
  return (view: EditorView): Diagnostic[] => {
    const tables = getSchema();
    if (!tables.length) return []; // schema not loaded yet — don't guess
    const idx = indexOf(tables);
    const { spans, stmts } = lexState(view.state);
    const doc = docString(view.state);
    return schemaDiagnostics(doc, spans, stmts, idx, getFuncs()).map((d) => ({
      from: d.from,
      to: d.to,
      severity: "warning" as const,
      message: d.message,
      actions: d.suggestion ? replaceAction(d.from, d.to, d.suggestion) : undefined,
    }));
  };
}

export type { Table };
