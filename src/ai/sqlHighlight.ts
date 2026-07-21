// Lightweight SQL syntax tokenizer for the AI chat code blocks — no CodeMirror instance
// per block. Classifies comments / strings / quoted identifiers / numbers / keywords /
// functions / punctuation; everything else is a plain identifier.

export type Tok = { text: string; cls: string };

const KEYWORDS = new Set(
  (
    "select from where and or not null as on using join inner left right full outer cross natural lateral " +
    "group by order having limit offset fetch distinct all union intersect except with recursive " +
    "insert into values update set delete returning create alter drop truncate table view index sequence " +
    "schema database function trigger procedure materialized temporary temp if exists case when then else end " +
    "in is between like ilike similar to any some asc desc nulls first last primary key foreign references " +
    "unique check default constraint cascade restrict grant revoke commit rollback begin transaction " +
    "over partition window filter within collate cast array row add column rename replace explain analyze " +
    "vacuum copy show use describe pragma true false desc asc"
  ).split(/\s+/),
);
const TYPES = new Set(
  (
    "int integer bigint smallint tinyint serial bigserial smallserial numeric decimal real double precision " +
    "float boolean bool text varchar char character varying nchar nvarchar date time timestamp timestamptz " +
    "datetime interval json jsonb uuid bytea blob clob money bit"
  ).split(/\s+/),
);

// comment | string | quoted-ident | number | word | whitespace | punctuation
const TOKEN = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|(`(?:[^`]|``)*`?)|(\d[\d.]*\b)|([A-Za-z_][\w$]*)|(\s+)|([^\w\s])/g;

export function highlightSql(code: string): Tok[] {
  const out: Tok[] = [];
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(code))) {
    if (m[1]) out.push({ text: m[1], cls: "tok-com" });
    else if (m[2]) out.push({ text: m[2], cls: "tok-str" });
    else if (m[3] || m[4]) out.push({ text: (m[3] || m[4])!, cls: "tok-qid" }); // "ident" / `ident`
    else if (m[5]) out.push({ text: m[5], cls: "tok-num" });
    else if (m[6]) {
      const lower = m[6].toLowerCase();
      // Bounded lookahead — slicing the whole remaining string per identifier was
      // O(n²) and froze the UI on large streamed AI code blocks.
      const rest = code.slice(TOKEN.lastIndex, TOKEN.lastIndex + 16);
      if (KEYWORDS.has(lower)) out.push({ text: m[6], cls: "tok-kw" });
      else if (TYPES.has(lower)) out.push({ text: m[6], cls: "tok-type" });
      else if (/^\s*\(/.test(rest)) out.push({ text: m[6], cls: "tok-fn" }); // word immediately before "("
      else out.push({ text: m[6], cls: "tok-id" });
    } else if (m[7]) out.push({ text: m[7], cls: "tok-ws" });
    else if (m[8]) out.push({ text: m[8], cls: "tok-punct" });
  }
  return out;
}
