import { type Diagnostic } from "@codemirror/lint";
import { type EditorView } from "@codemirror/view";
import { STATEMENT_STARTERS } from "../sql/dialects";

// Hoisted once — the lint source runs per statement per 300ms keystroke window;
// no per-run spread of the keyword set.
const STARTER_LIST = [...STATEMENT_STARTERS];
import { closest } from "./distance";
import { docString, lexState, maskNonCode, spanAt } from "./lexer";
import { LINT_DIAGNOSTIC_LIMIT, LINT_STATEMENT_LIMIT, LIVE_ANALYSIS_MAX_CHARS } from "./limits";

// Fast, offline heuristics that run as-you-type. Deliberately limited to checks
// that are reliably correct on real SQL (read off the masked, code-only view of
// each statement) so they don't cry wolf:
//   • unmatched ')'            → error
//   • unclosed '('             → warning (you may still be typing)
//   • trailing comma           → warning
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
