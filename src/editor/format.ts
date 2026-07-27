import { type EditorView } from "@codemirror/view";
import { lex, maskNonCode } from "./lexer";
import { type DialectId } from "../sql/dialects";
import { FORMAT_MAX_CHARS } from "./limits";

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
  if (text.length > FORMAT_MAX_CHARS) return text;
  let sqlFormat: typeof import("sql-formatter")["format"];
  try {
    ({ format: sqlFormat } = await loadFormatter());
  } catch {
    // A failed lazy chunk must not become an unhandled rejection or poison every
    // later attempt. Keep the buffer unchanged and allow a future retry.
    formatterMod = null;
    return text;
  }
  const { spans } = lex(text);
  const bodies: string[] = [];
  const bodyTokens: string[] = [];
  const modTokens: string[] = [];
  // Sentinels must be absent from user text. Fixed markers can replace a real
  // string/comment when restoring dollar bodies after formatting.
  let markerPad = "_";
  let markerPrefix = `__TUSK${markerPad}FORMAT_`;
  // Double the pad on collision. Even a crafted 1 MiB input can force only
  // O(log n) full-text checks, unlike adding one character per retry.
  while (text.includes(markerPrefix)) {
    markerPad += markerPad;
    markerPrefix = `__TUSK${markerPad}FORMAT_`;
  }
  const masked = maskNonCode(text, spans, 0, text.length);
  const protectedRanges: { from: number; to: number; replacement: string }[] = [];
  for (const s of spans) {
    if (s.kind !== "dollar") continue;
    const i = bodies.length;
    bodies.push(text.slice(s.from, s.to));
    const token = `${markerPrefix}DQ_${i}__`;
    bodyTokens.push(token);
    protectedRanges.push({ from: s.from, to: s.to, replacement: `'${token}'` });
  }
  for (const m of masked.matchAll(/%s/g)) {
    const from = m.index;
    const prev = from > 0 ? masked[from - 1] : "";
    // `a%s` is compact modulo, not a DB-API placeholder. Give the formatter a
    // temporary identifier, then restore it as `% s` so formatting cannot turn
    // it into a promptable `%s` token.
    if (!/[\w"'\]\)]/.test(prev)) continue;
    const token = `${markerPrefix}MOD_S_${modTokens.length}__`;
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
  let restored = formatted;
  // Function replacers: a string replacement arg treats `$$`/`$&`/`$'` in the
  // body as substitution patterns, silently corrupting dollar-quoted SQL.
  for (let i = 0; i < bodyTokens.length; i++) restored = restored.replace(`'${bodyTokens[i]}'`, () => bodies[i]);
  for (const token of modTokens) restored = restored.replace(token, () => " % s");
  return restored;
}

/** Format the selection (when non-empty and `selectionOnly`) or the whole buffer. */
export async function formatDoc(
  view: EditorView,
  selectionOnly: boolean,
  dialect: DialectId,
  getIdentity: () => unknown = () => undefined,
): Promise<void> {
  const sel = view.state.selection.main;
  const useSel = selectionOnly && !sel.empty;
  const from = useSel ? sel.from : 0;
  const to = useSel ? sel.to : view.state.doc.length;
  const text = view.state.sliceDoc(from, to);
  const sourceDoc = view.state.doc;
  const sourceIdentity = getIdentity();
  const out = await formatSql(text, dialect);
  // Slice equality alone is insufficient: another tab can contain identical SQL.
  // Require both immutable CM document and owning tab identity to still match.
  if (view.state.doc !== sourceDoc || getIdentity() !== sourceIdentity) return;
  if (out !== text) view.dispatch({ changes: { from, to, insert: out } });
  view.focus();
}
