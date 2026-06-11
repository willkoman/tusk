import { type EditorView } from "@codemirror/view";
import { lex } from "./lexer";
import { type DialectId } from "../sql/dialects";

// SQL pretty-printer backed by `sql-formatter`. Dollar-quoted bodies are carved out
// first (the formatter doesn't understand `$tag$ … $tag$`) and restored byte-for-byte
// after, so function bodies are never reflowed.
//
// `sql-formatter` is the largest frontend dependency and is only needed when the
// user actually formats — it loads via dynamic import on first use (cached after).

const LANG: Record<DialectId, "postgresql" | "mysql" | "sqlite" | "transactsql"> = {
  postgres: "postgresql",
  mysql: "mysql",
  sqlite: "sqlite",
  mssql: "transactsql",
};

let formatterMod: Promise<typeof import("sql-formatter")> | null = null;
const loadFormatter = () => (formatterMod ??= import("sql-formatter"));

export async function formatSql(text: string, dialect: DialectId): Promise<string> {
  const { format: sqlFormat } = await loadFormatter();
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
  const useSel = selectionOnly && !sel.empty;
  const from = useSel ? sel.from : 0;
  const to = useSel ? sel.to : view.state.doc.length;
  const text = view.state.sliceDoc(from, to);
  void formatSql(text, dialect).then((out) => {
    // The formatter load is async — bail if the doc changed underneath (typing
    // during the first-use chunk load), so we never clobber newer edits.
    if (out === text || view.state.sliceDoc(from, to) !== text) {
      view.focus();
      return;
    }
    view.dispatch({ changes: { from, to, insert: out } });
    view.focus();
  });
}
