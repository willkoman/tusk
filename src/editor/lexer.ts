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

// Same word lists as script.rs (`MYSQL_IDENT_PREV`, `MYSQL_STMT_PREV`,
// `MYSQL_EXPR_NAME_PREV`, `MYSQL_EXPR_FOLLOW`, `MYSQL_IDENT_PUNCT`). MySQL does not
// reserve BEGIN/END, so a stored-program body reads each one from where it stands.
const MYSQL_IDENT_PREV = new Set([
  "select", "set", "where", "and", "or", "xor", "not", "on", "by", "when", "in", "out", "inout",
  "declare", "into", "return", "is", "like", "between", "having", "distinct", "as", "using", "div",
  "mod", "interval", "case", "if", "elseif", "while", "until", "from", "join", "update", "table",
  "call", "procedure", "function", "trigger", "event", "all", "any", "some", "regexp", "rlike",
  "exists",
]);
const MYSQL_STMT_PREV = new Set(["then", "else", "do", "loop", "repeat"]);
const MYSQL_EXPR_NAME_PREV = new Set([
  "then", "else", "when", "and", "or", "xor", "not", "is", "like", "between", "in", "div",
  "mod", "regexp", "rlike", "interval", "case", "select", "from", "where", "by", "as", "on",
  "distinct", "exists", "having", "using", "join", "binary",
]);
const MYSQL_EXPR_FOLLOW = new Set([
  "from", "as", "is", "in", "and", "or", "xor", "div", "mod", "like", "between", "regexp", "rlike",
  "sounds", "collate", "desc", "asc", "then", "else", "when", "where", "into", "order", "group",
  "limit", "having", "union", "on", "using", "join", "inner", "left", "right", "cross",
  "straight_join", "natural", "force", "use", "ignore", "lock", "window", "except", "intersect",
  "partition",
]);
type MyFrame = "block" | "caseStmt" | "caseExpr";
// END IF / END LOOP / END WHILE / END REPEAT, and MariaDB's END FOR: never counted.
const MYSQL_NEUTRAL_END = new Set(["if", "loop", "while", "repeat", "for"]);
const MYSQL_IDENT_PUNCT = "(,.=<>!+-*/%|&^~@";

/** MySQL unquoted-identifier character: may lead with a digit or a non-ASCII char. */
function isMyWord(cc: number): boolean {
  return isWord(cc) || cc >= 0x80;
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

// `prev` encodes the previous code token of a MySQL body: "" for a value (string,
// quoted name, BEGIN/END read as a name), a single non-word character for punctuation,
// or a lowercased word.
const isPunct = (prev: string): boolean => prev.length === 1 && !isMyWord(prev.charCodeAt(0));

/** At depth 0: whether `prev` makes a following BEGIN/CASE an operand or a name. */
function mysqlIdentContext(prev: string): boolean {
  if (prev === "") return false;
  if (isPunct(prev)) return MYSQL_IDENT_PUNCT.includes(prev);
  return MYSQL_IDENT_PREV.has(prev);
}

/** Inside a body: the next word starts a statement. Mirrors `mysql_stmt_position`. */
function mysqlStmtPosition(prev: string): boolean {
  return prev === ";" || prev === ":" || prev === "begin" || MYSQL_STMT_PREV.has(prev);
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
  // current one (see `isPunct` for the encoding), the open BEGIN/CASE frames, whether a
  // handler's condition list is being read, and whether the outermost block closed.
  let myPrev = "";
  let myFrames: MyFrame[] = [];
  let myHandler = false;
  let myDone = false;

  // One word of a MySQL stored-program body. Mirrors `script.rs::mysql_body_word`:
  // BEGIN … END and CASE … END [CASE] are frames; IF/LOOP/WHILE/REPEAT/FOR are not, so
  // their END IF/END LOOP/… closers leave the stack alone. Inside a block a block opens
  // only at a statement position and closes only right after `;` (or its own BEGIN);
  // inside a CASE expression nothing opens and END closes unless something wants an
  // operand before it; only at depth 0 does BEGIN fall back to the surrounding words.
  const mysqlBodyWord = (word: string, end: number): string => {
    const top = myFrames.length ? myFrames[myFrames.length - 1] : null;
    if (word === "begin") {
      let opens: boolean;
      if (top === "caseExpr") opens = false;
      else if (top !== null) opens = mysqlStmtPosition(myPrev) || (myHandler && !mysqlIdentContext(myPrev));
      else {
        const { next, word: nextWord, after } = mysqlPeek(doc, end);
        const forUpdate = nextWord === "for" && ["update", "share"].includes(mysqlPeek(doc, after).word);
        opens =
          !mysqlIdentContext(myPrev) &&
          (next < 0 ||
            ((isAlphaOrUnderscore(next) || next === BTICK || next === LPAREN || next >= 0x80) &&
              !MYSQL_EXPR_FOLLOW.has(nextWord) &&
              !forUpdate));
      }
      if (!opens) return "";
      myHandler = false;
      myFrames.push("block");
    } else if (word === "end") {
      let closes: boolean;
      if (top === null) closes = false;
      else if (top === "block") closes = myPrev === ";" || myPrev === "begin";
      else if (top === "caseStmt") closes = myPrev === ";";
      else if (myPrev === "") closes = true;
      else if (isPunct(myPrev)) closes = !MYSQL_IDENT_PUNCT.includes(myPrev);
      else closes = !MYSQL_EXPR_NAME_PREV.has(myPrev);
      if (!closes) return "";
      const nextWord = mysqlPeek(doc, end).word;
      const pops = !MYSQL_NEUTRAL_END.has(nextWord) && !(top === "block" && nextWord === "case");
      if (pops) {
        myFrames.pop();
        if (top === "block" && myFrames.length === 0) myDone = true;
      }
    } else if (word === "case") {
      // CASE is reserved: always the keyword, except as the tail of `END CASE`.
      if (myPrev !== "end") {
        const statement =
          top === "caseExpr" ? false : top !== null ? mysqlStmtPosition(myPrev) || myHandler : !mysqlIdentContext(myPrev);
        if (statement) {
          myHandler = false;
          myFrames.push("caseStmt");
        } else myFrames.push("caseExpr");
      }
    } else if (word === "handler" && (myPrev === "continue" || myPrev === "exit" || myPrev === "undo")) {
      myHandler = true;
    }
    return word;
  };

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
    if (cc === DOLLAR && !mssql) {
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
      } else if (mysqlHead && !myDone) {
        // (After the program's closing END only a label may follow; Rust refuses
        // anything else at execution, so nothing there moves a boundary.)
        myPrev = mysqlBodyWord(word, i);
        blockDepth = myFrames.length;
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
      myFrames = [];
      myHandler = false;
      myDone = false;
      continue;
    }

    if (mysql && !isAsciiWs(cc)) {
      myPrev = doc[i];
      // A handler's condition list ends with its (single-statement) body.
      if (cc === SEMI) myHandler = false;
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
