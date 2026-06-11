import { lex, maskNonCode } from "../editor/lexer";
import { lit } from "./ident";

// Parameter detection + safe literal substitution for the pre-run prompt.
// Pure and lexer-masked: params inside strings, comments, and dollar-quoted
// bodies are never matched ($tag$…$tag$ vs $1 is already the lexer's job).
//
// Styles: positional `$1 $2 …` and named `:name` (not preceded by `:` — kills
// `::type` casts — nor by a word/quote character). Documented limitation:
// PG array slices with identifier bounds (`arr[i:j]`) can false-positive on
// `:j`; the "raw" toggle is the escape hatch.

export type Param = { name: string; kind: "positional" | "named" };
export type ParamValue = { value: string; raw: boolean; isNull: boolean };

type Span = { name: string; kind: Param["kind"]; from: number; to: number };

function scan(sqlText: string): Span[] {
  const { spans } = lex(sqlText);
  const masked = maskNonCode(sqlText, spans, 0, sqlText.length);
  const out: Span[] = [];
  const re = /\$(\d+)|:([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    if (m[1] !== undefined) {
      out.push({ name: `$${m[1]}`, kind: "positional", from: m.index, to: m.index + m[0].length });
    } else {
      const prev = m.index > 0 ? masked[m.index - 1] : "";
      if (prev === ":" || /[\w"'\]]/.test(prev)) continue; // ::cast, slice end, adjacency
      const next = masked[m.index + m[0].length] ?? "";
      if (next === ":") continue; // first half of `::`
      out.push({ name: `:${m[2]}`, kind: "named", from: m.index, to: m.index + m[0].length });
    }
  }
  return out;
}

/** Unique params in first-occurrence order. */
export function detectParams(sqlText: string): Param[] {
  const seen = new Set<string>();
  const out: Param[] = [];
  for (const s of scan(sqlText)) {
    if (!seen.has(s.name)) {
      seen.add(s.name);
      out.push({ name: s.name, kind: s.kind });
    }
  }
  return out;
}

/**
 * Replace every occurrence of each param with its value: SQL NULL, raw text
 * (numbers/expressions), or a safely-quoted literal via `lit` (dialect-aware).
 * Spans are replaced right-to-left so positions stay valid. Params without a
 * provided value are left untouched.
 */
export function substituteParams(sqlText: string, values: Record<string, ParamValue>): string {
  const all = scan(sqlText).filter((s) => values[s.name] !== undefined);
  let out = sqlText;
  for (const s of all.sort((a, b) => b.from - a.from)) {
    const v = values[s.name];
    const text = v.isNull ? "NULL" : v.raw ? v.value : lit(v.value);
    out = out.slice(0, s.from) + text + out.slice(s.to);
  }
  return out;
}
