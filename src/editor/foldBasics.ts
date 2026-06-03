import { codeFolding, foldGutter, foldKeymap, foldService } from "@codemirror/language";
import { type Extension } from "@codemirror/state";
import { lexState, isCode, type Span } from "./lexer";

// General (manual) code folding: a fold gutter plus a SQL-aware fold service that
// folds a multi-line parenthesized / bracketed block from the line that opens it
// (CTE bodies, subqueries, big tuples). Distinct from the automatic literal folding
// in autofold.ts — this one only folds when the user clicks the gutter.

export { foldKeymap };

const OPEN_PAREN = 40,
  OPEN_BRACKET = 91,
  CLOSE_PAREN = 41,
  CLOSE_BRACKET = 93;

/** Index of the bracket matching `open`, searching only code spans; -1 if none. */
function matchingClose(doc: string, spans: Span[], open: number): number {
  const openCh = doc.charCodeAt(open);
  const closeCh = openCh === OPEN_PAREN ? CLOSE_PAREN : openCh === OPEN_BRACKET ? CLOSE_BRACKET : -1;
  if (closeCh < 0) return -1;
  let depth = 0;
  for (const s of spans) {
    if (s.kind !== "code" || s.to <= open) continue;
    for (let p = Math.max(s.from, open); p < s.to; p++) {
      const cc = doc.charCodeAt(p);
      if (cc === openCh) depth++;
      else if (cc === closeCh && --depth === 0) return p;
    }
  }
  return -1;
}

const sqlFoldService = foldService.of((state, lineStart, lineEnd) => {
  const { spans } = lexState(state);
  const doc = state.doc.toString();
  for (let p = lineStart; p < lineEnd; p++) {
    if (!isCode(spans, p)) continue;
    const cc = doc.charCodeAt(p);
    if (cc === OPEN_PAREN || cc === OPEN_BRACKET) {
      const close = matchingClose(doc, spans, p);
      if (close > lineEnd) return { from: p + 1, to: close };
    }
  }
  return null;
});

export function foldBasics(): Extension {
  return [codeFolding(), foldGutter(), sqlFoldService];
}
