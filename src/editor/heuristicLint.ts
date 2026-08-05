import { type Diagnostic } from "@codemirror/lint";
import { type EditorView } from "@codemirror/view";
import { STATEMENT_STARTERS } from "../sql/dialects";

// Hoisted once — the lint source runs per statement per 300ms keystroke window;
// no per-run spread of the keyword set.
const STARTER_LIST = [...STATEMENT_STARTERS];

// Words that end a WHERE/HAVING region at the same paren depth. Conservative on
// purpose: CASE arms (WHEN/THEN/ELSE/END) also end detection so a comma after a
// CASE expression is never mis-flagged.
const WHERE_REGION_END = new Set([
  "GROUP", "ORDER", "HAVING", "WINDOW", "UNION", "INTERSECT", "EXCEPT", "LIMIT",
  "OFFSET", "FETCH", "FOR", "RETURNING", "QUALIFY", "ON", "WHEN", "THEN", "ELSE",
  "END", "SELECT", "SET", "VALUES", "JOIN", "USING",
]);
import { closest } from "./distance";
import { docString, lexState, maskNonCode, spanAt } from "./lexer";
import { LINT_DIAGNOSTIC_LIMIT, LINT_STATEMENT_LIMIT, LIVE_ANALYSIS_MAX_CHARS } from "./limits";

// Paste artifacts from web pages and chat apps that are invisible (or near-invisible)
// in the editor but are NOT whitespace to the server: PostgreSQL lexes any char >= 0x80
// as an identifier character, so ` p.master_id` parses as an alias plus a stray
// `.` -- a baffling "syntax error at or near \".\"" with nothing visibly wrong. Curly
// quotes are the same failure class (never valid SQL punctuation). Each maps to its
// replacement; zero-width characters map to removal.
const UNICODE_ARTIFACTS = new Map<string, { fix: string; what: string }>([
  ["\u00a0", { fix: " ", what: "non-breaking space" }],
  ["\u1680", { fix: " ", what: "Unicode space" }],
  ["\u202f", { fix: " ", what: "narrow no-break space" }],
  ["\u205f", { fix: " ", what: "Unicode space" }],
  ["\u3000", { fix: " ", what: "ideographic space" }],
  ["\u200b", { fix: "", what: "zero-width space" }],
  ["\ufeff", { fix: "", what: "zero-width BOM" }],
  ["\u2018", { fix: "'", what: "curly quote" }],
  ["\u2019", { fix: "'", what: "curly quote" }],
  ["\u201c", { fix: '"', what: "curly quote" }],
  ["\u201d", { fix: '"', what: "curly quote" }],
]);
for (let cp = 0x2000; cp <= 0x200a; cp++) UNICODE_ARTIFACTS.set(String.fromCharCode(cp), { fix: " ", what: "Unicode space" });
const ARTIFACT_RE = /[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000\ufeff\u2018\u2019\u201c\u201d]/g;
const uPlus = (ch: string) => `U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;

const artifactMessage = (ch: string, info: { fix: string; what: string }): string =>
  info.fix === " "
    ? `${info.what} (${uPlus(ch)}) \u2014 looks like a space, but the server reads it as an identifier character (usually a web-page paste)`
    : info.fix === ""
      ? `${info.what} (${uPlus(ch)}) \u2014 invisible, but the server still sees it`
      : `${info.what} (${uPlus(ch)}) \u2014 SQL needs straight quotes`;

/** Replace every paste artifact in the document's CODE regions (strings and comments
 *  are left alone \u2014 a non-breaking space inside a string literal is data). */
function fixAllArtifacts(view: EditorView): void {
  const { spans } = lexState(view.state);
  const doc = docString(view.state);
  const masked = maskNonCode(doc, spans, 0, doc.length);
  const changes: { from: number; to: number; insert: string }[] = [];
  ARTIFACT_RE.lastIndex = 0;
  for (let hit = ARTIFACT_RE.exec(masked); hit; hit = ARTIFACT_RE.exec(masked)) {
    changes.push({ from: hit.index, to: hit.index + 1, insert: UNICODE_ARTIFACTS.get(hit[0])!.fix });
  }
  if (changes.length) view.dispatch({ changes });
}

// Fast, offline heuristics that run as-you-type. Deliberately limited to checks
// that are reliably correct on real SQL (read off the masked, code-only view of
// each statement) so they don't cry wolf:
//   • unmatched ')'            → error
//   • unclosed '('             → warning (you may still be typing)
//   • trailing comma           → warning
//   • comma in WHERE/HAVING    → error (`WHERE a = 1, b = 2` — AND/OR intended;
//     invalid in every engine, and the server linter may be paused while a
//     result stream is open, so this must not wait for PREPARE)
//   • DELETE/UPDATE w/o WHERE  → warning (affects every row)
//   • unknown leading keyword  → error (`SELCT …` — a closed set, unlike functions)
//
// Parser-grade errors (unknown columns, type errors, syntax) come from the server
// linter (serverLint.ts); unknown-function/mid-statement-keyword checks are left
// out on purpose — user-defined functions would make them pure noise. The leading
// keyword IS checked: statement starters are a closed set across every engine
// (STATEMENT_STARTERS), and the server linter skips statements it can't classify,
// so without this a misspelled first word got no squiggle at all.

export function heuristicLintSource() {
  return (view: EditorView): Diagnostic[] => {
    if (view.state.doc.length > LIVE_ANALYSIS_MAX_CHARS) return [];
    const { spans, stmts } = lexState(view.state);
    const doc = docString(view.state);
    const out: Diagnostic[] = [];
    const add = (diag: Diagnostic): boolean => {
      out.push(diag);
      return out.length >= LINT_DIAGNOSTIC_LIMIT;
    };

    for (let stmtIndex = 0; stmtIndex < Math.min(stmts.length, LINT_STATEMENT_LIMIT); stmtIndex++) {
      const stmt = stmts[stmtIndex];
      const base = stmt.from;
      const m = maskNonCode(doc, spans, stmt.from, stmt.to);

      // Paste artifacts (see UNICODE_ARTIFACTS): flagged only in code — inside a
      // string literal they're data. The one action fixes the whole document, since
      // these arrive dozens at a time from a single paste.
      ARTIFACT_RE.lastIndex = 0;
      for (let hit = ARTIFACT_RE.exec(m); hit; hit = ARTIFACT_RE.exec(m)) {
        const info = UNICODE_ARTIFACTS.get(hit[0])!;
        if (add({
          from: base + hit.index,
          to: base + hit.index + 1,
          severity: "error",
          message: artifactMessage(hit[0], info),
          actions: [{ name: "fix all in document", apply: (v) => fixAllArtifacts(v) }],
        })) return out;
      }

      const stack: number[] = [];

      for (let p = 0; p < m.length; p++) {
        const c = m[p];
        if (c === "(") {
          stack.push(p);
        } else if (c === ")") {
          if (stack.length) stack.pop();
          else if (add({ from: base + p, to: base + p + 1, severity: "error", message: "unmatched ')'" })) return out;
        } else if (c === ",") {
          // Look at what actually follows the comma, span-aware: skip whitespace and
          // comments, but a string/quoted/dollar span IS a value element (the mask
          // blanks its chars to spaces, so the naive scan would mistake it for empty).
          const dp = base + p;
          let q = dp + 1;
          let trailing = q >= stmt.to; // comma at end of statement
          while (q < stmt.to) {
            const span = spanAt(spans, q);
            if (!span) break;
            if (span.kind === "line-comment" || span.kind === "block-comment") {
              q = span.to;
              continue;
            }
            if (span.kind !== "code") break; // a real value element → not trailing
            const ch = doc[q];
            if (/\s/.test(ch)) {
              q++;
              continue;
            }
            if (ch === ")" || ch === "]" || ch === ";") trailing = true;
            // Bounded window: only the next word matters, and this runs once per comma —
            // slicing to stmt.to copied the whole statement tail per comma, which froze
            // the UI on big VALUES dumps (O(commas × statement length)).
            else if (/^[a-zA-Z_]\w*/.exec(doc.slice(q, Math.min(stmt.to, q + 64)))?.[0]?.toUpperCase() === "FROM") trailing = true;
            break;
          }
          if (trailing && add({ from: dp, to: dp + 1, severity: "warning", message: "trailing comma" })) return out;
        }
      }
      for (const openP of stack) {
        if (add({ from: base + openP, to: base + openP + 1, severity: "warning", message: "unclosed '('" })) return out;
      }

      // Top-level comma inside a WHERE/HAVING region: no engine accepts it — the
      // user meant AND/OR. Legit commas (IN lists, row constructors, function
      // args) always sit one paren level deeper, so this cannot false-positive.
      // Subquery WHEREs nest via a depth stack; a conservative clause-word set
      // ends a region (missed detection beats a wrong squiggle).
      {
        const whereDepths: number[] = [];
        let depth = 0;
        let p = 0;
        while (p < m.length) {
          const c = m[p];
          if (c === "(") { depth++; p++; continue; }
          if (c === ")") {
            if (depth > 0) depth--;
            while (whereDepths.length && whereDepths[whereDepths.length - 1] > depth) whereDepths.pop();
            p++;
            continue;
          }
          if (c === ",") {
            if (whereDepths[whereDepths.length - 1] === depth &&
              add({ from: base + p, to: base + p + 1, severity: "error", message: "',' is not valid between conditions — join them with AND or OR" })) return out;
            p++;
            continue;
          }
          if (/[A-Za-z_]/.test(c)) {
            const w = /^[A-Za-z_]\w*/.exec(m.slice(p, p + 64))![0];
            const W = w.toUpperCase();
            if (W === "WHERE" || W === "HAVING") {
              if (whereDepths[whereDepths.length - 1] !== depth) whereDepths.push(depth);
            } else if (whereDepths[whereDepths.length - 1] === depth && WHERE_REGION_END.has(W)) {
              whereDepths.pop();
            }
            p += w.length;
            continue;
          }
          p++;
        }
      }

      // Unknown leading keyword: find the first code character (skipping comments),
      // and if it opens a word that no engine accepts as a statement starter, flag it.
      let p0 = stmt.from;
      while (p0 < stmt.to) {
        const span = spanAt(spans, p0);
        if (!span) break;
        if (span.kind === "line-comment" || span.kind === "block-comment") {
          p0 = span.to;
          continue;
        }
        if (span.kind !== "code") break; // starts with a literal/quoted ident — not ours to judge
        if (/\s/.test(doc[p0])) {
          p0++;
          continue;
        }
        const tok = /^[a-zA-Z_]\w*/.exec(doc.slice(p0, Math.min(stmt.to, p0 + 64)))?.[0];
        if (tok) {
          const word = tok.toUpperCase();
          // Don't flag a half-typed keyword under the cursor ("SEL|" while typing SELECT).
          const typingHere = view.state.selection.main.head === p0 + tok.length;
          const isPrefix = typingHere && STARTER_LIST.some((s) => s !== word && s.startsWith(word));
          if (!STATEMENT_STARTERS.has(word) && !isPrefix) {
            const hint = closest(word, STATEMENT_STARTERS);
            if (add({
              from: p0,
              to: p0 + tok.length,
              severity: "error",
              message: `unknown statement "${tok}"${hint ? ` — did you mean ${hint}?` : ""}`,
            })) return out;
          }
        }
        break; // first real code char handled either way
      }

      const du = /^\s*(DELETE|UPDATE)\b/i.exec(m);
      if (du && !/\bWHERE\b/i.test(m)) {
        const kwStart = base + m.search(/\S/);
        if (add({
          from: kwStart,
          to: kwStart + du[1].length,
          severity: "warning",
          message: `${du[1].toUpperCase()} without WHERE — affects every row`,
        })) return out;
      }
    }
    return out;
  };
}
