import { type EditorView } from "@codemirror/view";
import { lex, maskNonCode } from "./lexer";
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
  const modTokens: string[] = [];
  let modPrefix = "__TUSK_FORMAT_MOD_S_";
  while (text.includes(modPrefix)) modPrefix = `_${modPrefix}`;
  const masked = maskNonCode(text, spans, 0, text.length);
  const protectedRanges: { from: number; to: number; replacement: string }[] = [];
  for (const s of spans) {
    if (s.kind !== "dollar") continue;
    const i = bodies.length;
    bodies.push(text.slice(s.from, s.to));
    protectedRanges.push({ from: s.from, to: s.to, replacement: `'__TUSK_DQ_${i}__'` });
  }
  for (const m of masked.matchAll(/%s/g)) {
    const from = m.index;
    const prev = from > 0 ? masked[from - 1] : "";
    // `a%s` is compact modulo, not a DB-API placeholder. Give the formatter a
    // temporary identifier, then restore it as `% s` so formatting cannot turn
    // it into a promptable `%s` token.
    if (!/[\w"'\]\)]/.test(prev)) continue;
    const token = `${modPrefix}${modTokens.length}__`;
    modTokens.push(token);
    protectedRanges.push({ from, to: from + 2, replacement: token });
  }
  protectedRanges.sort((a, b) => a.from - b.from);
  let carved = "";
  let last = 0;
  for (const range of protectedRanges) {
    carved += text.slice(last, range.from) + range.replacement;
    last = range.to;
  }
  carved += text.slice(last);

  let formatted: string;
  try {
    formatted = sqlFormat(carved, {
      language: LANG[dialect],
      keywordCase: "upper",
      // Without a custom param token sql-formatter rewrites `%s` to `% s`,
      // silently disabling the pre-run DB-API parameter prompt.
      paramTypes: { custom: [{ regex: "%%s" }, { regex: "%s" }] },
    });
  } catch {
    return text; // unparseable — leave the buffer untouched
  }
  let restored = formatted.replace(/'__TUSK_DQ_(\d+)__'/g, (m, i) => bodies[Number(i)] ?? m);
  for (const token of modTokens) restored = restored.replace(token, " % s");
  return restored;
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
