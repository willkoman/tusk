import { EditorState, type Extension } from "@codemirror/state";
import { type DialectSpec } from "../sql/dialects";
import { isCode, lexState, spanAt } from "./lexer";
import { LIVE_ANALYSIS_MAX_CHARS } from "./limits";

/**
 * Live auto-capitalization of SQL keywords. When a word boundary is typed right
 * after a recognized keyword, rewrite it uppercase — skipping strings and
 * qualified names (`t.select`, `"select"`).
 *
 * `$` stays excluded from completion tokens elsewhere, keeping Tab/Enter completion
 * acceptance safe around dollar-quotes. Lexical spans are authoritative here too:
 * no string, comment, dollar body, or quoted identifier can be rewritten.
 */
export function keywordCase(words: Set<string>): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !tr.isUserEvent("input.type")) return tr;
    if (tr.startState.doc.length > LIVE_ANALYSIS_MAX_CHARS) return tr;
    const spans = lexState(tr.startState).spans;
    const changes: { from: number; to: number; insert: string }[] = [];
    tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
      const ins = inserted.toString();
      if (ins.length !== 1 || /[\w$]/.test(ins)) return;
      // A normal boundary keystroke inserts without replacing existing text. Reading
      // the preceding word from startState lets every editor feature share lexState's
      // cached spans instead of reparsing the new full document in this filter.
      if (fromA !== toA || fromA === 0 || !isCode(spans, fromA - 1)) return;
      let startA = fromA;
      while (startA > 0 && /[\w$]/.test(tr.startState.sliceDoc(startA - 1, startA))) startA--;
      if (startA === fromA) return;
      const span = spanAt(spans, startA);
      if (span?.kind !== "code" || fromA > span.to) return;
      const word = tr.startState.sliceDoc(startA, fromA);
      const upper = word.toUpperCase();
      if (word === upper || !words.has(upper)) return;
      const prev = startA > 0 ? tr.startState.sliceDoc(startA - 1, startA) : "";
      if (prev === ".") return;
      const startB = fromB - word.length;
      if (tr.newDoc.sliceString(startB, fromB) !== word) return;
      changes.push({ from: startB, to: fromB, insert: upper });
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
