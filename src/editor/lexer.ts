// Byte-faithful TS port of the backend lexer in `src-tauri/src/script.rs`
// (`split` / `dollar_tag_end`). One O(n) pass classifies every region of the doc
// as code / string / quoted-identifier / comment / dollar-quoted body, and yields
// semicolon-delimited statement spans. Everything downstream (auto-fold, the
// heuristic + schema linters, the statement gutter) reads this — so SQL syntax
// inside strings/comments/`$tag$…$tag$` bodies is never misinterpreted.
//
// Scope note: this drives editor *UI* only. The authoritative splitter for
// execution and server-side validation stays `script::split` in Rust. We
// deliberately skip the psql `\meta` and `COPY … FROM stdin` data-block handling
// here — they don't affect folding/lint correctness and only matter when running.

import { type EditorState } from "@codemirror/state";

export type SpanKind = "code" | "string" | "dquote" | "line-comment" | "block-comment" | "dollar";

export type Span = { from: number; to: number; kind: SpanKind };
export type Stmt = { from: number; to: number; text: string };
export type LexResult = { spans: Span[]; stmts: Stmt[] };

const DOLLAR = 36; // $
const SQUOTE = 39; // '
const DQUOTE = 34; // "
const DASH = 45; // -
const SLASH = 47; // /
const STAR = 42; // *
const SEMI = 59; // ;
const NL = 10; // \n

function isWord(cc: number): boolean {
  return (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || cc === 95;
}
function isAlphaOrUnderscore(cc: number): boolean {
  return (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || cc === 95;
}

/**
 * If `doc[i]` (a `$`) begins a valid dollar-quote tag (`$$`, `$_$`, `$body$`),
 * return the index of its closing `$`. `$1` (a bind parameter) is not a tag → -1.
 * Mirrors `script.rs::dollar_tag_end`.
 */
export function dollarTagEnd(doc: string, i: number): number {
  const n = doc.length;
  let j = i + 1;
  while (j < n) {
    const cc = doc.charCodeAt(j);
    if (cc === DOLLAR) {
      // tag = doc[i+1 .. j]
      if (j === i + 1) return j; // empty tag: $$
      if (!isAlphaOrUnderscore(doc.charCodeAt(i + 1))) return -1;
      for (let k = i + 1; k < j; k++) if (!isWord(doc.charCodeAt(k))) return -1;
      return j;
    }
    if (isWord(cc)) j++;
    else return -1;
  }
  return -1;
}

export function lex(doc: string): LexResult {
  const n = doc.length;
  const spans: Span[] = [];
  const stmts: Stmt[] = [];
  let i = 0;
  let codeStart = 0;
  let stmtStart = 0;

  const pushCode = (to: number) => {
    if (to > codeStart) spans.push({ from: codeStart, to, kind: "code" });
  };
  const pushStmt = (from: number, to: number) => {
    const text = doc.slice(from, to);
    if (text.trim().length) stmts.push({ from, to, text });
  };

  while (i < n) {
    const cc = doc.charCodeAt(i);

    // line comment  --…\n
    if (cc === DASH && i + 1 < n && doc.charCodeAt(i + 1) === DASH) {
      pushCode(i);
      const start = i;
      while (i < n && doc.charCodeAt(i) !== NL) i++;
      spans.push({ from: start, to: i, kind: "line-comment" });
      codeStart = i;
      continue;
    }
    // block comment  /* … */
    if (cc === SLASH && i + 1 < n && doc.charCodeAt(i + 1) === STAR) {
      pushCode(i);
      const start = i;
      i += 2;
      while (i < n && !(doc.charCodeAt(i) === STAR && i + 1 < n && doc.charCodeAt(i + 1) === SLASH)) i++;
      if (i < n) i += 2;
      spans.push({ from: start, to: i, kind: "block-comment" });
      codeStart = i;
      continue;
    }
    // single-quoted string  '…'  ('' = escaped quote)
    if (cc === SQUOTE) {
      pushCode(i);
      const start = i;
      i++;
      while (i < n) {
        if (doc.charCodeAt(i) === SQUOTE) {
          if (i + 1 < n && doc.charCodeAt(i + 1) === SQUOTE) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      spans.push({ from: start, to: i, kind: "string" });
      codeStart = i;
      continue;
    }
    // double-quoted identifier  "…"  ("" = escaped quote)
    if (cc === DQUOTE) {
      pushCode(i);
      const start = i;
      i++;
      while (i < n) {
        if (doc.charCodeAt(i) === DQUOTE) {
          if (i + 1 < n && doc.charCodeAt(i + 1) === DQUOTE) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      spans.push({ from: start, to: i, kind: "dquote" });
      codeStart = i;
      continue;
    }
    // dollar-quoted body  $tag$ … $tag$
    if (cc === DOLLAR) {
      const end = dollarTagEnd(doc, i);
      if (end >= 0) {
        pushCode(i);
        const start = i;
        const delim = doc.slice(i, end + 1);
        const dl = delim.length;
        i = end + 1;
        while (i < n) {
          if (doc.charCodeAt(i) === DOLLAR && i + dl <= n && doc.slice(i, i + dl) === delim) {
            i += dl;
            break;
          }
          i++;
        }
        spans.push({ from: start, to: i, kind: "dollar" });
        codeStart = i;
        continue;
      }
      i++;
      continue;
    }
    // statement terminator
    if (cc === SEMI) {
      i++;
      pushCode(i); // include the ';' in the trailing code span
      pushStmt(stmtStart, i);
      codeStart = i;
      stmtStart = i;
      continue;
    }

    i++;
  }

  pushCode(n);
  pushStmt(stmtStart, n);
  return { spans, stmts };
}

// Shared lex cache keyed on the immutable Text instance, so auto-fold, the fold
// gutter, and the linters all reuse a single O(n) pass per document version.
const lexCache = new WeakMap<object, LexResult>();

export function lexState(state: EditorState): LexResult {
  const key = state.doc as unknown as object;
  let r = lexCache.get(key);
  if (!r) {
    r = lex(docString(state));
    lexCache.set(key, r);
  }
  return r;
}

// Full-document string, cached per immutable Text instance. CM's doc.toString()
// materializes the whole rope every call; extensions that need the string in a
// per-line service (fold gutter) or per-pass (linters) must share one copy.
const strCache = new WeakMap<object, string>();

export function docString(state: EditorState): string {
  const key = state.doc as unknown as object;
  let s = strCache.get(key);
  if (s === undefined) {
    s = state.doc.toString();
    strCache.set(key, s);
  }
  return s;
}

/** Binary-search the span covering `pos` (spans cover [0, len] with no gaps). */
export function spanAt(spans: Span[], pos: number): Span | null {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = spans[mid];
    if (pos < s.from) hi = mid - 1;
    else if (pos >= s.to) lo = mid + 1;
    else return s;
  }
  return null;
}

/** True when `pos` is real SQL code (not inside a string / comment / dollar body). */
export function isCode(spans: Span[], pos: number): boolean {
  return spanAt(spans, pos)?.kind === "code";
}

/**
 * Return `doc[from..to]` with every non-code character (inside strings, comments,
 * dollar bodies) replaced by a space — newlines kept. Offsets are preserved, so a
 * regex match index maps straight back to a document position. Used by the linters
 * to scan only real SQL.
 */
export function maskNonCode(
  doc: string,
  spans: Span[],
  from: number,
  to: number,
  // Keep double-quoted identifiers (`"col"`) intact — they're names, not string
  // literals. The schema linter needs them; the paren/heuristic linter does not (a `)`
  // inside a quoted identifier would otherwise count as a real paren), so it stays false.
  keepDquote = false,
): string {
  const arr = doc.slice(from, to).split("");
  // Spans are sorted and non-overlapping: binary-search the first span that can
  // intersect [from, to) and stop at the first one past it. The previous full walk
  // made every call O(total spans in the document); linters call this once per
  // statement, so a many-statement script went quadratic and froze the UI.
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].to <= from) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < spans.length; i++) {
    const s = spans[i];
    if (s.from >= to) break;
    if (s.kind === "code" || (keepDquote && s.kind === "dquote")) continue;
    const a = Math.max(s.from, from);
    const b = Math.min(s.to, to);
    for (let p = a; p < b; p++) {
      if (arr[p - from] !== "\n") arr[p - from] = " ";
    }
  }
  return arr.join("");
}

/** The statement containing `pos` (inclusive of its trailing `;`); last statement as a fallback. */
export function statementAt(stmts: Stmt[], pos: number): { stmt: Stmt; index: number } | null {
  // First statement whose end reaches pos. Binary search keeps cursor moves O(log n)
  // in scripts with thousands of statements.
  let lo = 0;
  let hi = stmts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (stmts[mid].to < pos) lo = mid + 1;
    else hi = mid;
  }
  if (lo < stmts.length && pos >= stmts[lo].from) return { stmt: stmts[lo], index: lo };
  if (stmts.length) return { stmt: stmts[stmts.length - 1], index: stmts.length - 1 };
  return null;
}
