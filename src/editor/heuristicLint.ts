import { type Diagnostic } from "@codemirror/lint";
import { type EditorView } from "@codemirror/view";
import { lexState, maskNonCode, spanAt } from "./lexer";

// Fast, offline heuristics that run as-you-type. Deliberately limited to checks
// that are reliably correct on real SQL (read off the masked, code-only view of
// each statement) so they don't cry wolf:
//   • unmatched ')'            → error
//   • unclosed '('             → warning (you may still be typing)
//   • trailing comma           → warning
//   • DELETE/UPDATE w/o WHERE  → warning (affects every row)
//
// Parser-grade errors (unknown columns, type errors, syntax) come from the server
// linter (serverLint.ts); unknown-function/unknown-dialect-keyword checks are left
// out on purpose — user-defined functions would make them pure noise.

export function heuristicLintSource() {
  return (view: EditorView): Diagnostic[] => {
    const { spans, stmts } = lexState(view.state);
    const doc = view.state.doc.toString();
    const out: Diagnostic[] = [];

    for (const stmt of stmts) {
      const base = stmt.from;
      const m = maskNonCode(doc, spans, stmt.from, stmt.to);
      const stack: number[] = [];

      for (let p = 0; p < m.length; p++) {
        const c = m[p];
        if (c === "(") {
          stack.push(p);
        } else if (c === ")") {
          if (stack.length) stack.pop();
          else out.push({ from: base + p, to: base + p + 1, severity: "error", message: "unmatched ')'" });
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
            else if (/^[a-zA-Z_]\w*/.exec(doc.slice(q, stmt.to))?.[0]?.toUpperCase() === "FROM") trailing = true;
            break;
          }
          if (trailing) out.push({ from: dp, to: dp + 1, severity: "warning", message: "trailing comma" });
        }
      }
      for (const openP of stack) {
        out.push({ from: base + openP, to: base + openP + 1, severity: "warning", message: "unclosed '('" });
      }

      const du = /^\s*(DELETE|UPDATE)\b/i.exec(m);
      if (du && !/\bWHERE\b/i.test(m)) {
        const kwStart = base + m.search(/\S/);
        out.push({
          from: kwStart,
          to: kwStart + du[1].length,
          severity: "warning",
          message: `${du[1].toUpperCase()} without WHERE — affects every row`,
        });
      }
    }
    return out;
  };
}
