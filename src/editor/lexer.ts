// Byte-faithful TS port of the backend lexer in `src-tauri/src/script.rs`
// (`split_impl` / `dollar_tag_end`), including its per-engine branches: MySQL
// `#` comments and whitespace-required `--`, MySQL backslash escapes inside
// quotes, MySQL/SQLite backtick identifiers, and the statement blocks that keep a
// T-SQL batch, a SQLite trigger or a MySQL stored program whole across its own `;`
// terminators (`block_depth` there, `blockDepth` here). One O(n) pass classifies every
// region of the doc as code / string / quoted-identifier / comment / dollar body
// and yields semicolon-delimited statement spans. Everything downstream
// (auto-fold, the heuristic + schema linters, the statement gutter, param
// detection, grid wrapping) reads this — so SQL syntax inside strings, comments,
// `$tag$…$tag$`, and backticks is never misinterpreted on any engine.
//
// Scope note: this drives editor *UI* only. The authoritative splitter for
// execution and server-side validation stays `script::parse_for_engine` in Rust.
// We deliberately skip the psql `\meta` and `COPY … FROM stdin` data-block
// handling here — they don't affect folding/lint correctness and only matter
// when running. Where Rust ERRORS (ambiguous `\'` / `\``), this lexer stays
// lenient and consumes the pair; the execution boundary still rejects it.

import { type EditorState } from "@codemirror/state";
import { sqlDialect } from "../sql/ident";

export type SqlEngine = "postgres" | "duckdb" | "sqlite" | "mysql" | "mssql";

export type SpanKind = "code" | "string" | "dquote" | "btick" | "bracket" | "line-comment" | "block-comment" | "dollar";

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

const HASH = 35; // #
const BACKSLASH = 92; // \
const BTICK = 96; // `
const LBRACK = 91; // [
const LPAREN = 40; // (
const RPAREN = 41; // )
const COMMA = 44; // ,
const COLON = 58; // :
const EQUALS = 61; // =
const RBRACK = 93; // ]
const SPACE = 32;
const TAB = 9;
const CR = 13;

const isSpaceOrControl = (cc: number): boolean => cc <= 32 || cc === 127;

/**
 * A T-SQL `GO` batch separator occupying the rest of the line starting at `i`.
 * Returns the index just past its newline, or -1. Mirrors `script.rs::mssql_go_line`;
 * `GO` is a client directive, so it ends a statement and reaches no server. A repeat
 * count is a boundary here too — the execution boundary is where it is refused.
 */
function goLineEnd(doc: string, start: number): number {
  const n = doc.length;
  let i = start;
  const space = (cc: number) => cc === SPACE || cc === TAB;
  while (i < n && space(doc.charCodeAt(i))) i++;
  if (i + 2 > n) return -1;
  if ((doc.charCodeAt(i) | 0x20) !== 103 || (doc.charCodeAt(i + 1) | 0x20) !== 111) return -1; // g, o
  i += 2;
  if (i < n && isWord(doc.charCodeAt(i))) return -1;
  while (i < n && space(doc.charCodeAt(i))) i++;
  while (i < n && doc.charCodeAt(i) >= 48 && doc.charCodeAt(i) <= 57) i++;
  while (i < n && space(doc.charCodeAt(i))) i++;
  // A trailing comment still leaves `GO` alone on its line (mirrors script.rs).
  const lineComment = () => {
    if (i + 1 < n && doc.charCodeAt(i) === DASH && doc.charCodeAt(i + 1) === DASH) {
      while (i < n && doc.charCodeAt(i) !== NL) i++;
    }
  };
  if (i + 1 < n && doc.charCodeAt(i) === SLASH && doc.charCodeAt(i + 1) === STAR) {
    const end = blockCommentEnd(doc, i, true);
    if (end < 0) return -1; // unterminated: not a batch separator
    i = end;
    while (i < n && space(doc.charCodeAt(i))) i++;
    lineComment();
  } else {
    lineComment();
  }
  if (i < n && doc.charCodeAt(i) === CR) i++;
  if (i >= n) return n;
  return doc.charCodeAt(i) === NL ? i + 1 : -1;
}

/** Index just past the terminator that closes the block comment at `start`, or -1. */
function blockCommentEnd(doc: string, start: number, nests: boolean): number {
  const n = doc.length;
  let i = start + 2;
  let depth = 1;
  while (i + 1 < n) {
    if (doc.charCodeAt(i) === STAR && doc.charCodeAt(i + 1) === SLASH) {
      i += 2;
      if (--depth === 0) return i;
      continue;
    }
    if (nests && doc.charCodeAt(i) === SLASH && doc.charCodeAt(i + 1) === STAR) {
      i += 2;
      depth++;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * The next identifier word at or after `i`, lowercased — whitespace skipped only.
 * Mirrors `script.rs::peek_word`; it decides whether a `BEGIN` opens a T-SQL block
 * or a transaction.
 */
function peekWord(doc: string, i: number): string {
  const n = doc.length;
  while (i < n && /\s/.test(doc[i])) i++;
  const start = i;
  while (i < n && isWord(doc.charCodeAt(i))) i++;
  return doc.slice(start, i).toLowerCase();
}

/**
 * The head words of a statement spell `CREATE [OR REPLACE] [TEMP|TEMPORARY] TRIGGER`.
 * Mirrors `script.rs::sqlite_trigger_head`: only that shape opens a SQLite trigger
 * body, so nothing else lets a bare `END` close a block (outside a trigger, SQLite
 * `END` is a COMMIT synonym).
 */
function sqliteTriggerHead(words: string[]): boolean {
  if (words[0] !== "create") return false;
  for (const w of words.slice(1)) {
    if (w === "or" || w === "replace" || w === "temp" || w === "temporary") continue;
    return w === "trigger";
  }
  return false;
}

const MYSQL_PROGRAM_KINDS = new Set(["procedure", "function", "trigger", "event"]);

/**
 * The head words spell `CREATE [OR REPLACE] [DEFINER = user] [AGGREGATE]
 * {PROCEDURE|FUNCTION|TRIGGER|EVENT}`: a MySQL stored program. `null` while the words
 * seen so far could still become that head. Mirrors `script.rs::mysql_program_head`.
 */
function mysqlProgramHead(words: string[]): boolean | null {
  let i = 0;
  if (i >= words.length) return null;
  if (words[i] !== "create") return false;
  i = 1;
  if (i >= words.length) return null;
  if (words[i] === "or") {
    if (i + 1 >= words.length) return null;
    if (words[i + 1] !== "replace") return false;
    i += 2;
  }
  if (i >= words.length) return null;
  if (words[i] === "definer") {
    i++;
    // `CURRENT_USER` or an unquoted `user@host`: at most two bare words.
    for (let k = 0; k < 2; k++) {
      if (i >= words.length) return null;
      if (MYSQL_PROGRAM_KINDS.has(words[i]) || words[i] === "aggregate") break;
      i++;
    }
  }
  if (i >= words.length) return null;
  if (words[i] === "aggregate") i++;
  if (i >= words.length) return null;
  return MYSQL_PROGRAM_KINDS.has(words[i]);
}

// MySQL stored programs. Mirrors script.rs (`MyFrame`, `MyPhase`, `MyHandler`,
// `MyBody`, `mysql_body_word` / `mysql_compound_word` / `mysql_end` / `mysql_body_value`
// / `mysql_body_punct`, and the `MYSQL_*` word lists, copied verbatim). The head is read
// by its grammar so the body's first token is found exactly: a compound statement there
// opens a frame, anything else makes the body one plain statement that cannot hold a `;`.
// Inside a compound body, MySQL does not reserve BEGIN/END, so a compound statement opens
// only where a statement starts and every frame but a CASE expression closes only with
// its own `END …` right after the `;` of its last statement.
type MyFrame = "block" | "caseStmt" | "caseExpr" | "if" | "loop" | "while" | "repeat" | "for";
// Maps, not object literals: `word in obj` / `obj[word]` would also see `constructor`.
const OPENED_BY = new Map<string, MyFrame>([
  ["begin", "block"],
  ["case", "caseStmt"],
  ["if", "if"],
  ["loop", "loop"],
  ["while", "while"],
  ["repeat", "repeat"],
  ["for", "for"],
]);
const listsAtOnce = (f: MyFrame): boolean => f === "block" || f === "loop" || f === "repeat";
const END_TAILS = new Set(["case", "if", "loop", "while", "repeat", "for"]);
const MYSQL_EXPR_NAME_PREV = new Set([
  "then", "else", "when", "and", "or", "xor", "not", "is", "like", "between", "in", "div",
  "mod", "regexp", "rlike", "interval", "case", "select", "from", "where", "by", "as", "on",
  "distinct", "exists", "having", "using", "join", "binary",
]);
const MYSQL_IDENT_PUNCT = "(,.=<>!+-*/%|&^~@";
const MYSQL_CHARACTERISTICS = new Map<string, number>([
  ["comment", 1],
  ["language", 1],
  ["not", 1],
  ["deterministic", 0],
  ["contains", 1],
  ["no", 1],
  ["reads", 2],
  ["modifies", 2],
  ["sql", 2],
]);
const MYSQL_FUNCTION_BODY = new Set(["return", "begin", "case", "if", "loop", "while", "repeat", "for"]);
type MyPhase =
  | "name" | "params" | "chars" | "returns" | "trigger" | "triggerOrder" | "event" | "bodyStart" | "compound" | "simple";
type MyHandler = "none" | "awaitFor" | "conditions" | "conditionsDone";

/** MySQL unquoted-identifier character: letters, digits, `_`, `$` and non-ASCII. */
function isMyWord(cc: number): boolean {
  return isWord(cc) || cc === DOLLAR || cc >= 0x80;
}
/** Rust's `u8::is_ascii_whitespace` (no vertical tab, unlike `\s`). */
function isAsciiWs(cc: number): boolean {
  return cc === SPACE || cc === TAB || cc === NL || cc === 12 || cc === CR;
}
/** ASCII-only lowercase, like Rust's `to_ascii_lowercase`. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/**
 * The first char code of the next code token at or after `i` (-1 at the end), the word
 * it starts (ASCII-lowercased; "" when not a word) and the index just past that word —
 * skipping whitespace and MySQL comments. Mirrors `script.rs::mysql_peek`.
 */
function mysqlPeek(doc: string, i: number): { next: number; word: string; after: number } {
  const n = doc.length;
  for (;;) {
    while (i < n && isAsciiWs(doc.charCodeAt(i))) i++;
    const dash =
      i + 1 < n && doc.charCodeAt(i) === DASH && doc.charCodeAt(i + 1) === DASH &&
      (i + 2 === n || isSpaceOrControl(doc.charCodeAt(i + 2)));
    if (dash || (i < n && doc.charCodeAt(i) === HASH)) {
      while (i < n && doc.charCodeAt(i) !== NL) i++;
      continue;
    }
    if (i + 1 < n && doc.charCodeAt(i) === SLASH && doc.charCodeAt(i + 1) === STAR) {
      const end = blockCommentEnd(doc, i, false);
      if (end < 0) return { next: -1, word: "", after: n };
      i = end;
      continue;
    }
    break;
  }
  if (i >= n) return { next: -1, word: "", after: n };
  const start = i;
  while (i < n && isMyWord(doc.charCodeAt(i))) i++;
  return { next: doc.charCodeAt(start), word: asciiLower(doc.slice(start, i)), after: i };
}

/** The token ending at `i` is a label: a `:` follows (`:=` is an assignment). */
function mysqlLabelFollows(doc: string, i: number): boolean {
  const { next, word, after } = mysqlPeek(doc, i);
  return next === COLON && word === "" && doc.charCodeAt(after + 1) !== EQUALS;
}

// `prev` encodes the previous code token: "" for a value (string, quoted name, BEGIN/END
// read as a name), a single non-word character for punctuation, or a lowercased word.
const isPunct = (prev: string): boolean => prev.length === 1 && !isMyWord(prev.charCodeAt(0));

/** Lexer state for one MySQL statement; inert until its head proves it a stored program. */
class MyProgram {
  active = false;
  fn = false;
  phase: MyPhase = "name";
  /** Parenthesis depth (params/returns/event) or words still due (chars/triggerOrder). */
  n = 0;
  frames: MyFrame[] = [];
  stmt = false;
  label = false;
  tail = false;
  handler: MyHandler = "none";
  done = false;

  start(kind: string): void {
    this.active = true;
    this.fn = kind === "function";
    this.phase = kind === "trigger" ? "trigger" : kind === "event" ? "event" : "name";
    this.n = 0;
  }

  /** The body's first token (`script.rs::mysql_body_start`). */
  private bodyStart(doc: string, word: string, end: number): void {
    if (mysqlLabelFollows(doc, end)) {
      this.phase = "bodyStart";
      return;
    }
    const frame = OPENED_BY.get(word);
    if (frame) {
      this.phase = "compound";
      this.stmt = listsAtOnce(frame);
      this.frames.push(frame);
    } else this.phase = "simple";
  }

  /** One word (`script.rs::mysql_body_word`); returns the token it leaves behind. */
  word(doc: string, word: string, end: number, prev: string): string {
    switch (this.phase) {
      case "chars":
        if (this.n > 0) this.n--;
        else if (MYSQL_CHARACTERISTICS.has(word)) this.n = MYSQL_CHARACTERISTICS.get(word)!;
        else this.bodyStart(doc, word, end);
        break;
      case "returns":
        if (this.n === 0 && (MYSQL_FUNCTION_BODY.has(word) || mysqlLabelFollows(doc, end))) this.bodyStart(doc, word, end);
        break;
      case "trigger":
        if (word === "row" && prev === "each") {
          this.phase = "triggerOrder";
          this.n = 0;
        }
        break;
      case "triggerOrder":
        if (this.n === 1) this.phase = "bodyStart";
        else if (word === "follows" || word === "precedes") this.n = 1;
        else this.bodyStart(doc, word, end);
        break;
      case "event":
        if (this.n === 0 && word === "do") this.phase = "bodyStart";
        break;
      case "bodyStart":
        this.bodyStart(doc, word, end);
        break;
      case "compound":
        return this.compoundWord(doc, word, end, prev);
    }
    return word;
  }

  /** `script.rs::mysql_compound_word` (with `mysql_end`); Rust's errors are not raised here. */
  private compoundWord(doc: string, word: string, end: number, prev: string): string {
    if (this.tail) {
      this.tail = false;
      this.stmt = false;
      this.label = false;
      return word;
    }
    if (this.done) return word;
    let atStmt = this.stmt;
    if (this.handler === "conditionsDone") {
      atStmt = true;
      this.handler = "none";
    }
    this.stmt = false;
    this.label = false;
    const top = this.frames.length ? this.frames[this.frames.length - 1] : null;
    if (word === "end") {
      if (top === null) return "";
      const next = mysqlPeek(doc, end).word;
      let closes: boolean;
      if (top === "caseExpr") {
        if (prev === "") closes = true;
        else if (isPunct(prev)) closes = !MYSQL_IDENT_PUNCT.includes(prev);
        else closes = !MYSQL_EXPR_NAME_PREV.has(prev);
      } else if (top === "repeat") closes = next === "repeat" || atStmt;
      else closes = atStmt;
      if (!closes) return "";
      if (top !== "caseExpr") this.tail = END_TAILS.has(next);
      this.frames.pop();
      if (this.frames.length === 0) this.done = true;
      return word;
    }
    if (word === "then" || word === "else") {
      this.stmt = top === "if" || top === "caseStmt";
      return word;
    }
    if (word === "do") {
      this.stmt = !atStmt && (top === "while" || top === "for");
      return word;
    }
    if (this.handler === "awaitFor" && word === "for") {
      this.handler = "conditions";
      return word;
    }
    if (this.handler === "conditions") {
      this.handler = word === "not" || word === "sqlstate" || word === "value" ? "conditions" : "conditionsDone";
      return word;
    }
    if (word === "handler" && (prev === "continue" || prev === "exit" || prev === "undo")) {
      this.handler = "awaitFor";
      return word;
    }
    if (atStmt) {
      const frame = OPENED_BY.get(word);
      if (frame) {
        this.stmt = listsAtOnce(frame);
        this.frames.push(frame);
      } else this.label = true;
    } else if (word === "case") this.frames.push("caseExpr");
    return word;
  }

  /** A string or quoted identifier ending at `end` (`script.rs::mysql_body_value`). */
  value(doc: string, end: number): void {
    if (!this.active) return;
    switch (this.phase) {
      case "chars":
        if (this.n > 0) this.n--;
        else this.phase = mysqlLabelFollows(doc, end) ? "bodyStart" : "simple";
        break;
      case "bodyStart":
        this.phase = mysqlLabelFollows(doc, end) ? "bodyStart" : "simple";
        break;
      case "triggerOrder":
        if (this.n === 1) this.phase = "bodyStart";
        else this.phase = mysqlLabelFollows(doc, end) ? "bodyStart" : "simple";
        break;
      case "returns":
        if (this.n === 0 && mysqlLabelFollows(doc, end)) this.phase = "bodyStart";
        break;
      case "compound":
        if (this.done) return;
        if (this.handler === "conditions" || this.handler === "conditionsDone") this.handler = "conditionsDone";
        this.label = this.stmt;
        this.stmt = false;
        this.tail = false;
        break;
    }
  }

  /** A punctuation char other than `;` (`script.rs::mysql_body_punct`). */
  punct(cc: number): void {
    if (!this.active) return;
    switch (this.phase) {
      case "name":
        if (cc === LPAREN) {
          this.phase = "params";
          this.n = 1;
        }
        break;
      case "params":
        if (cc === LPAREN) this.n++;
        else if (cc === RPAREN) {
          if (this.n > 1) this.n--;
          else {
            this.phase = this.fn ? "returns" : "chars";
            this.n = 0;
          }
        }
        break;
      case "returns":
        if (cc === LPAREN) this.n++;
        else if (cc === RPAREN) this.n = Math.max(0, this.n - 1);
        else if (cc === COLON && this.n === 0) this.phase = "bodyStart";
        break;
      case "event":
        if (cc === LPAREN) this.n++;
        else if (cc === RPAREN) this.n = Math.max(0, this.n - 1);
        break;
      case "bodyStart":
        if (cc !== COLON) this.phase = "simple";
        break;
      case "chars":
      case "triggerOrder":
        this.phase = "simple";
        break;
      case "compound":
        if (this.done) return;
        if (cc === COMMA && (this.handler === "conditions" || this.handler === "conditionsDone")) this.handler = "conditions";
        this.stmt = cc === COLON && this.label;
        this.label = false;
        this.tail = false;
        break;
    }
  }

  /** A `;` inside the body. */
  semi(): void {
    this.stmt = true;
    this.label = false;
    this.tail = false;
    this.handler = "none";
  }
}

export function lex(doc: string, engine: SqlEngine = sqlDialect() as SqlEngine): LexResult {
  const n = doc.length;
  const spans: Span[] = [];
  const stmts: Stmt[] = [];
  const mysql = engine === "mysql";
  const mssql = engine === "mssql";
  const sqlite = engine === "sqlite";
  const bticks = mysql || sqlite;
  let i = 0;
  let codeStart = 0;
  let stmtStart = 0;
  // T-SQL statement-block nesting (`BEGIN … END`, `BEGIN TRY`/`BEGIN CATCH`,
  // `CASE … END`). A `;` inside a block is not a statement boundary — T-SQL has no
  // dollar quoting, so without this a procedure body is shredded into fragments.
  // `BEGIN TRAN[SACTION]` / `BEGIN DISTRIBUTED TRAN` open a transaction, not a block.
  // SQLite shares the counter for `CREATE TRIGGER … BEGIN … END` bodies, and MySQL
  // for stored-program bodies (`CREATE PROCEDURE|FUNCTION|TRIGGER|EVENT`).
  let blockDepth = 0;
  // First code words of the statement being scanned (SQLite/MySQL only, capped) and
  // whether they opened a trigger body (SQLite) or a stored program (MySQL; `null`
  // while undecided).
  let head: string[] = [];
  let inTrigger = false;
  let mysqlHead: boolean | null = null;
  // MySQL stored-program state (mirrors `script.rs::MyBody`): the token before the
  // current one (see `isPunct` for the encoding) and the program being read.
  let myPrev = "";
  let my = new MyProgram();

  const pushCode = (to: number) => {
    if (to > codeStart) spans.push({ from: codeStart, to, kind: "code" });
  };
  const pushStmt = (from: number, to: number) => {
    const text = doc.slice(from, to);
    if (text.trim().length) stmts.push({ from, to, text });
  };
  // Consume a quoted region ending at `quote`, honoring '' doubling and — on
  // MySQL — backslash escape pairs (mirrors script.rs; `\'`/`\"` consumed
  // leniently where Rust errors, since editor lexing cannot reject).
  const quoted = (start: number, quote: number, kind: SpanKind) => {
    pushCode(start);
    i = start + 1;
    while (i < n) {
      const c = doc.charCodeAt(i);
      if (mysql && c === BACKSLASH && i + 1 < n) {
        i += 2;
        continue;
      }
      if (c === quote) {
        if (i + 1 < n && doc.charCodeAt(i + 1) === quote) {
          i += 2;
          continue;
        }
        i++;
        break;
      }
      i++;
    }
    spans.push({ from: start, to: i, kind });
    codeStart = i;
    myPrev = "";
    if (mysql) my.value(doc, i);
  };

  while (i < n) {
    const cc = doc.charCodeAt(i);

    // T-SQL `GO`: a client-side batch separator alone on its line. It ends the current
    // statement and produces no code of its own.
    if (mssql && (i === 0 || doc.charCodeAt(i - 1) === NL)) {
      const end = goLineEnd(doc, i);
      if (end >= 0) {
        pushCode(i);
        pushStmt(stmtStart, i);
        spans.push({ from: i, to: end, kind: "line-comment" });
        i = end;
        codeStart = end;
        stmtStart = end;
        blockDepth = 0;
        continue;
      }
    }
    // line comment  --…\n  (MySQL requires whitespace/EOL after `--`: `1--2` is math)
    if (
      cc === DASH && i + 1 < n && doc.charCodeAt(i + 1) === DASH &&
      (!mysql || i + 2 >= n || isSpaceOrControl(doc.charCodeAt(i + 2)))
    ) {
      pushCode(i);
      const start = i;
      while (i < n && doc.charCodeAt(i) !== NL) i++;
      spans.push({ from: start, to: i, kind: "line-comment" });
      codeStart = i;
      continue;
    }
    // MySQL `#` comment runs to end-of-line (a `;` inside must not split statements)
    if (mysql && cc === HASH) {
      pushCode(i);
      const start = i;
      while (i < n && doc.charCodeAt(i) !== NL) i++;
      spans.push({ from: start, to: i, kind: "line-comment" });
      codeStart = i;
      continue;
    }
    // block comment  /* … */  (T-SQL nests them; the other engines do not)
    if (cc === SLASH && i + 1 < n && doc.charCodeAt(i + 1) === STAR) {
      pushCode(i);
      const start = i;
      i += 2;
      let depth = 1;
      while (i < n) {
        if (doc.charCodeAt(i) === STAR && i + 1 < n && doc.charCodeAt(i + 1) === SLASH) {
          i += 2;
          if (--depth === 0) break;
          continue;
        }
        if (mssql && doc.charCodeAt(i) === SLASH && i + 1 < n && doc.charCodeAt(i + 1) === STAR) {
          i += 2;
          depth++;
          continue;
        }
        i++;
      }
      spans.push({ from: start, to: i, kind: "block-comment" });
      codeStart = i;
      continue;
    }
    // single-quoted string  '…'  ('' = escaped quote; MySQL also \-escapes)
    if (cc === SQUOTE) {
      quoted(i, SQUOTE, "string");
      continue;
    }
    // double-quoted identifier  "…"  ("" = escaped quote; MySQL also \-escapes)
    if (cc === DQUOTE) {
      quoted(i, DQUOTE, "dquote");
      continue;
    }
    // backtick identifier  `…`  (MySQL/SQLite; `` = escaped backtick)
    if (bticks && cc === BTICK) {
      quoted(i, BTICK, "btick");
      continue;
    }
    // T-SQL `[bracket]` identifier (`]]` = escaped `]`)
    if (mssql && cc === LBRACK) {
      pushCode(i);
      const start = i;
      i++;
      while (i < n) {
        if (doc.charCodeAt(i) === RBRACK) {
          i++;
          if (i < n && doc.charCodeAt(i) === RBRACK) {
            i++;
            continue;
          }
          break;
        }
        i++;
      }
      spans.push({ from: start, to: i, kind: "bracket" });
      codeStart = i;
      continue;
    }
    // dollar-quoted body  $tag$ … $tag$  (not a T-SQL construct: `$` is an identifier
    // and money-literal character there)
    // (not MySQL either: `$` is an identifier char there, read by the word branch)
    if (cc === DOLLAR && !mssql && !mysql) {
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
        myPrev = "";
        continue;
      }
      i++;
      myPrev = "$";
      continue;
    }
    // T-SQL statement blocks. Consumed as whole words so `BEGIN`/`END`/`CASE` inside
    // an identifier (`ended`), a bracket, a string or a comment never counts.
    if (mssql && isAlphaOrUnderscore(cc)) {
      const start = i;
      while (i < n && isWord(doc.charCodeAt(i))) i++;
      const word = doc.slice(start, i).toLowerCase();
      if (word === "case") blockDepth++;
      else if (word === "begin") {
        const next = peekWord(doc, i);
        if (next !== "tran" && next !== "transaction" && next !== "distributed") blockDepth++;
      } else if (word === "end") blockDepth = Math.max(0, blockDepth - 1);
      continue;
    }
    // SQLite `CREATE TRIGGER … BEGIN … END` bodies. Whole words again, so `END`
    // inside an identifier or a quoted region never closes the body; `CASE … END`
    // is counted so an unpaired `END` cannot close the block early.
    if (sqlite && isAlphaOrUnderscore(cc)) {
      const start = i;
      while (i < n && isWord(doc.charCodeAt(i))) i++;
      const word = doc.slice(start, i).toLowerCase();
      if (!inTrigger && head.length < 5) {
        head.push(word);
        inTrigger = sqliteTriggerHead(head);
      }
      if (inTrigger) {
        if (word === "begin" || word === "case") blockDepth++;
        else if (word === "end") blockDepth = Math.max(0, blockDepth - 1);
      }
      continue;
    }
    // MySQL stored-program bodies. Whole words, so END inside an identifier, a string,
    // a backtick name or a comment never counts; a word may lead with a digit or a
    // non-ASCII char there.
    if (mysql && isMyWord(cc)) {
      const start = i;
      while (i < n && isMyWord(doc.charCodeAt(i))) i++;
      const word = asciiLower(doc.slice(start, i));
      if (mysqlHead === null) {
        head.push(word);
        mysqlHead = mysqlProgramHead(head);
        myPrev = word;
        if (mysqlHead) my.start(word);
      } else if (mysqlHead) {
        myPrev = my.word(doc, word, i, myPrev);
        blockDepth = my.frames.length;
      }
      continue;
    }
    // statement terminator (inside a T-SQL block it is part of the statement)
    if (cc === SEMI && blockDepth === 0) {
      i++;
      pushCode(i); // include the ';' in the trailing code span
      pushStmt(stmtStart, i);
      codeStart = i;
      stmtStart = i;
      head = [];
      inTrigger = false;
      mysqlHead = null;
      my = new MyProgram();
      continue;
    }

    if (mysql && !isAsciiWs(cc)) {
      myPrev = doc[i];
      if (cc === SEMI) my.semi();
      else my.punct(cc);
    }
    i++;
  }

  pushCode(n);
  pushStmt(stmtStart, n);
  return { spans, stmts };
}

// Shared lex cache keyed on the immutable Text instance, so auto-fold, the fold
// gutter, and the linters all reuse a single O(n) pass per document version.
// The engine participates in the key: connecting to a different driver with the
// same document must re-lex (backticks/`#` mean different things).
const lexCache = new WeakMap<object, { engine: SqlEngine; result: LexResult }>();

export function lexState(state: EditorState): LexResult {
  const key = state.doc as unknown as object;
  const engine = sqlDialect() as SqlEngine;
  let r = lexCache.get(key);
  if (!r || r.engine !== engine) {
    r = { engine, result: lex(docString(state), engine) };
    lexCache.set(key, r);
  }
  return r.result;
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
  // Keep quoted identifiers (`"col"`, MySQL/SQLite `` `col` ``, T-SQL `[col]`) intact —
  // they're names, not string literals. The schema linter and grid editability need
  // them; the paren/heuristic linter does not (a `)` inside a quoted identifier would
  // otherwise count as a real paren), so it stays false.
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
    if (
      s.kind === "code" ||
      (keepDquote && (s.kind === "dquote" || s.kind === "btick" || s.kind === "bracket"))
    ) continue;
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

/**
 * Text for the "run statement" action. A non-blank selection always wins: silently
 * expanding an inner CTE selection to its enclosing statement can turn a selected
 * read into an UPDATE/DELETE. With no useful selection, fall back to the statement
 * under the cursor.
 */
export function statementRunText(doc: string, stmts: Stmt[], anchor: number, head: number): string {
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);
  const selected = doc.slice(from, to);
  if (selected.trim()) return selected;
  return statementAt(stmts, head)?.stmt.text ?? doc;
}

/** Text for the ordinary Run action: exact non-blank selection, otherwise all. */
export function selectionRunText(doc: string, anchor: number, head: number): string {
  const selected = doc.slice(Math.min(anchor, head), Math.max(anchor, head));
  return selected.trim() ? selected : doc;
}
