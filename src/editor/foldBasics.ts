import { codeFolding, foldGutter, foldKeymap, foldService } from "@codemirror/language";
import { type EditorState, type Extension } from "@codemirror/state";
import { docString, lexState, isCode } from "./lexer";
import { LIVE_ANALYSIS_MAX_CHARS } from "./limits";

// General (manual) code folding: a fold gutter plus a SQL-aware fold service that
// folds a multi-line parenthesized / bracketed block from the line that opens it
// (CTE bodies, subqueries, big tuples). Distinct from the automatic literal folding
// in autofold.ts — this one only folds when the user clicks the gutter.

export { foldKeymap };

const OPEN_PAREN = 40,
  OPEN_BRACKET = 91,
  CLOSE_PAREN = 41,
  CLOSE_BRACKET = 93;

// Fold service runs once per visible line. Build all matching pairs in one cached
// O(n) pass instead of rescanning document tail for every opening bracket.
const closeCache = new WeakMap<object, Map<number, number>>();
function matchingCloses(state: EditorState): Map<number, number> {
  const key = state.doc as unknown as object;
  const cached = closeCache.get(key);
  if (cached) return cached;
  const out = new Map<number, number>();
  const stack: { ch: number; pos: number }[] = [];
  const doc = docString(state);
  const { spans } = lexState(state);
  for (const span of spans) {
    if (span.kind !== "code") continue;
    for (let p = span.from; p < span.to; p++) {
      const cc = doc.charCodeAt(p);
      if (cc === OPEN_PAREN || cc === OPEN_BRACKET) stack.push({ ch: cc, pos: p });
      else if (cc === CLOSE_PAREN || cc === CLOSE_BRACKET) {
        const want = cc === CLOSE_PAREN ? OPEN_PAREN : OPEN_BRACKET;
        // Tolerate malformed delimiters locally: a stray closer with no same-type
        // opener is ignored, and a crossing closer discards only the openers it
        // crosses (they never record, so folds stay non-overlapping). Wiping the
        // whole stack let one stray `]` kill folding for every enclosing block.
        let k = stack.length - 1;
        while (k >= 0 && stack[k].ch !== want) k--;
        if (k >= 0) {
          out.set(stack[k].pos, p);
          stack.length = k;
        }
      }
    }
  }
  closeCache.set(key, out);
  return out;
}

const sqlFoldService = foldService.of((state, lineStart, lineEnd) => {
  if (state.doc.length > LIVE_ANALYSIS_MAX_CHARS) return null;
  const { spans } = lexState(state);
  // Cached per doc version — toString() here ran per visible line, materializing
  // the whole document dozens of times per repaint on large buffers.
  const doc = docString(state);
  const closes = matchingCloses(state);
  for (let p = lineStart; p < lineEnd; p++) {
    if (!isCode(spans, p)) continue;
    const cc = doc.charCodeAt(p);
    if (cc === OPEN_PAREN || cc === OPEN_BRACKET) {
      const close = closes.get(p);
      if (close != null && close > lineEnd) return { from: p + 1, to: close };
    }
  }
  return null;
});

export function foldBasics(): Extension {
  return [codeFolding(), foldGutter(), sqlFoldService];
}
