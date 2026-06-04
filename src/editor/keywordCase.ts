import { EditorState, type Extension } from "@codemirror/state";
import { type DialectSpec } from "../sql/dialects";

/**
 * Live auto-capitalization of SQL keywords. When a word boundary is typed right
 * after a recognized keyword, rewrite it uppercase — skipping strings and
 * qualified names (`t.select`, `"select"`).
 *
 * Moved verbatim from SqlEditor.tsx. `$` is excluded from completion tokens
 * elsewhere (which is what keeps completion accept — Tab or Enter — safe around
 * dollar-quotes); this filter must not regress dollar-quote handling, so it bails
 * inside an open single-quoted string.
 */
export function keywordCase(words: Set<string>): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !tr.isUserEvent("input.type")) return tr;
    const changes: { from: number; to: number; insert: string }[] = [];
    tr.changes.iterChanges((_fa, _ta, fromB, _toB, inserted) => {
      const ins = inserted.toString();
      if (ins.length !== 1 || /[\w$]/.test(ins)) return;
      const doc = tr.newDoc;
      let start = fromB;
      while (start > 0 && /[\w$]/.test(doc.sliceString(start - 1, start))) start--;
      if (start === fromB) return;
      const word = doc.sliceString(start, fromB);
      const upper = word.toUpperCase();
      if (word === upper || !words.has(upper)) return;
      const prev = start > 0 ? doc.sliceString(start - 1, start) : "";
      if (prev === "." || prev === '"') return;
      const lineStart = doc.lineAt(start).from;
      const pre = doc.sliceString(lineStart, start);
      if ((pre.match(/'/g) || []).length % 2 === 1) return;
      changes.push({ from: start, to: fromB, insert: upper });
    });
    return changes.length ? [tr, { changes, sequential: true }] : tr;
  });
}

/** The set of single-word keyword tokens (split multi-word keywords) for a dialect. */
export function keywordSet(spec: DialectSpec): Set<string> {
  return new Set(
    [...spec.keywords, ...spec.statementKeywords]
      .flatMap((k) => k.split(/\s+/))
      .map((w) => w.toUpperCase()),
  );
}
