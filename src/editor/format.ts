import { format as sqlFormat } from "sql-formatter";
import { type EditorView } from "@codemirror/view";
import { lex } from "./lexer";
import { type DialectId } from "../sql/dialects";

// SQL pretty-printer backed by `sql-formatter`. Dollar-quoted bodies are carved out
// first (the formatter doesn't understand `$tag$ … $tag$`) and restored byte-for-byte
// after, so function bodies are never reflowed.

const LANG: Record<DialectId, "postgresql" | "mysql" | "sqlite" | "transactsql"> = {
  postgres: "postgresql",
  mysql: "mysql",
  sqlite: "sqlite",
  mssql: "transactsql",
};

export function formatSql(text: string, dialect: DialectId): string {
  const { spans } = lex(text);
  const bodies: string[] = [];
  let carved = "";
  let last = 0;
  for (const s of spans) {
    if (s.kind !== "dollar") continue;
    carved += text.slice(last, s.from) + `'__TUSK_DQ_${bodies.length}__'`;
    bodies.push(text.slice(s.from, s.to));
    last = s.to;
  }
  carved += text.slice(last);

  let formatted: string;
  try {
    formatted = sqlFormat(carved, { language: LANG[dialect], keywordCase: "upper" });
  } catch {
    return text; // unparseable — leave the buffer untouched
  }
  return formatted.replace(/'__TUSK_DQ_(\d+)__'/g, (m, i) => bodies[Number(i)] ?? m);
}

/** Format the selection (when non-empty and `selectionOnly`) or the whole buffer. */
export function formatDoc(view: EditorView, selectionOnly: boolean, dialect: DialectId): void {
  const sel = view.state.selection.main;
  if (selectionOnly && !sel.empty) {
    const text = view.state.sliceDoc(sel.from, sel.to);
    const out = formatSql(text, dialect);
    if (out !== text) view.dispatch({ changes: { from: sel.from, to: sel.to, insert: out } });
  } else {
    const text = view.state.doc.toString();
    const out = formatSql(text, dialect);
    if (out !== text) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: out } });
  }
  view.focus();
}
