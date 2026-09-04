import { lex, type SqlEngine } from "../editor/lexer";
// Wrap a statement in the engine's best structured EXPLAIN form. Pure — used
// by the Explain / Explain Analyze actions.

export function explainSql(kind: string | null | undefined, analyze: boolean, stmt: string, duckJson: boolean): string {
  const s = stmt.trim().replace(/;+\s*$/, "");
  switch (kind) {
    case "mysql":
      return analyze ? `EXPLAIN ANALYZE ${s}` : `EXPLAIN FORMAT=JSON ${s}`;
    case "sqlite":
      return `EXPLAIN QUERY PLAN ${s}`; // no ANALYZE variant (caps-gated off)
    case "duckdb":
      // duckJson = the connect-time probe confirmed PG-style parenthesized
      // EXPLAIN options on this libduckdb build.
      if (analyze) return duckJson ? `EXPLAIN (ANALYZE, FORMAT json) ${s}` : `EXPLAIN ANALYZE ${s}`;
      return duckJson ? `EXPLAIN (FORMAT json) ${s}` : `EXPLAIN ${s}`;
    default: // postgres
      return analyze ? `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${s}` : `EXPLAIN (FORMAT JSON) ${s}`;
  }
}

/** True when EXPLAIN ANALYZE would execute a mutating statement. A `WITH` counts as a
 *  read only when the statement its CTEs feed is one (`WITH … UPDATE` is a write). */
export function analyzeExecutesWrite(stmt: string, kind?: string | null): boolean {
  const tokens = shapeTokens(stmt, kind);
  if (tokens === null) return true;
  if (!tokens.length) return false;
  if (!isSingleExplainStatement(stmt, kind)) return true;
  return !shapeTokensAreRead(tokens, kind);
}

function shapeTokensAreRead(tokens: ShapeToken[], kind?: string | null): boolean {
  const first = tokens[0].kind === "word" ? tokens[0].word : "";
  if (first === "with") {
    const shape = parseWithTokens(tokens, 0);
    return !!shape && !shape.modifyingCte && !shape.mainSelectInto && readHead(shape.main, kind);
  }
  if (first === "select") return !topLevelWord(tokens.slice(1), "into");
  return readHead(first, kind);
}

/** True only for one structurally understood, non-mutating result statement. */
export function isReadStatement(stmt: string, kind?: string | null): boolean {
  const tokens = shapeTokens(stmt, kind);
  return tokens !== null && tokens.length > 0 && shapeTokensAreRead(tokens, kind);
}

const READ_HEADS = new Set(["select", "table", "values"]);
const WITH_MAIN_WORDS = new Set(["select", "insert", "update", "delete", "merge", "table", "values", "from", "pivot"]);
const MODIFYING = new Set(["insert", "update", "delete", "merge"]);

const readHead = (word: string, kind?: string | null) =>
  READ_HEADS.has(word) || (kind === "duckdb" && (word === "from" || word === "pivot"));

type ShapeToken =
  | { kind: "word"; word: string }
  | { kind: "ident" | "open" | "close" | "comma" };

const MAX_SHAPE_TOKENS = 200_000;

function shapeEngine(kind?: string | null): SqlEngine | null {
  return kind === "postgres" || kind === "duckdb" || kind === "sqlite" || kind === "mysql" ? kind : null;
}

function lexForShape(stmt: string, kind?: string | null) {
  const engine = shapeEngine(kind);
  return engine ? lex(stmt, engine) : lex(stmt);
}

/** EXPLAIN wraps one statement. Refuse selections whose trailing statements would
 * otherwise run outside the EXPLAIN prefix. */
export function isSingleExplainStatement(stmt: string, kind?: string | null): boolean {
  let statements = 0;
  for (const candidate of lexForShape(stmt, kind).stmts) {
    const tokens = shapeTokens(candidate.text, kind);
    if (tokens === null) return false;
    if (tokens.length && ++statements > 1) return false;
  }
  return statements === 1;
}

/** Tokenise only real SQL code. Quoted identifiers become one opaque identifier token,
 * so `"select)"` cannot impersonate a keyword or alter parenthesis depth. */
function shapeTokens(stmt: string, kind?: string | null): ShapeToken[] | null {
  const spans = lexForShape(stmt, kind).spans;
  const tokens: ShapeToken[] = [];
  const re = /[\p{L}_][\p{L}\p{N}_$]*|[(),]/gu;
  const asciiWord = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const span of spans) {
    if (span.kind === "dquote" || span.kind === "btick") {
      tokens.push({ kind: "ident" });
      if (tokens.length > MAX_SHAPE_TOKENS) return null;
      continue;
    }
    if (span.kind !== "code") continue;
    const code = stmt.slice(span.from, span.to);
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(code))) {
      const token = match[0];
      if (token === "(") tokens.push({ kind: "open" });
      else if (token === ")") tokens.push({ kind: "close" });
      else if (token === ",") tokens.push({ kind: "comma" });
      else if (asciiWord.test(token)) tokens.push({ kind: "word", word: token.toLowerCase() });
      else tokens.push({ kind: "ident" });
      if (tokens.length > MAX_SHAPE_TOKENS) return null;
    }
  }
  return tokens;
}

const isWord = (token: ShapeToken | undefined, word: string) => token?.kind === "word" && token.word === word;
const isIdent = (token: ShapeToken | undefined) => token?.kind === "word" || token?.kind === "ident";

function closeGroup(tokens: ShapeToken[], open: number): number | null {
  if (tokens[open]?.kind !== "open") return null;
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].kind === "open") depth++;
    else if (tokens[i].kind === "close" && --depth === 0) return i;
  }
  return null;
}

function topLevelWord(tokens: ShapeToken[], word: string): boolean {
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === "open") depth++;
    else if (token.kind === "close") depth = Math.max(0, depth - 1);
    else if (depth === 0 && isWord(token, word)) return true;
  }
  return false;
}

function skipSearchClause(tokens: ShapeToken[], start: number): number | null {
  let pos = start;
  if (!isWord(tokens[pos], "search")) return pos;
  pos++;
  if (!(isWord(tokens[pos], "breadth") || isWord(tokens[pos], "depth"))) return null;
  if (!isWord(tokens[++pos], "first") || !isWord(tokens[++pos], "by")) return null;
  pos++;
  while (pos < tokens.length && !isWord(tokens[pos], "set")) pos++;
  return isWord(tokens[pos], "set") && isIdent(tokens[pos + 1]) ? pos + 2 : null;
}

function skipCycleClause(tokens: ShapeToken[], start: number): number | null {
  let pos = start;
  if (!isWord(tokens[pos], "cycle")) return pos;
  pos++;
  while (pos < tokens.length && !isWord(tokens[pos], "set")) pos++;
  if (!isWord(tokens[pos], "set") || !isIdent(tokens[pos + 1])) return null;
  pos += 2;
  while (pos < tokens.length && !isWord(tokens[pos], "using")) pos++;
  return isWord(tokens[pos], "using") && isIdent(tokens[pos + 1]) ? pos + 2 : null;
}

type WithShape = { main: string; modifyingCte: boolean; mainSelectInto: boolean };

function bodyModifies(tokens: ShapeToken[], nesting: number): boolean {
  if (nesting > 64) return true;
  if (isWord(tokens[0], "with")) {
    const shape = parseWithTokens(tokens, nesting + 1);
    return !shape || shape.modifyingCte || shape.mainSelectInto || MODIFYING.has(shape.main);
  }
  return !!(tokens[0]?.kind === "word" && MODIFYING.has(tokens[0].word)) ||
    (isWord(tokens[0], "select") && topLevelWord(tokens.slice(1), "into"));
}

function mainShape(tokens: ShapeToken[], pos: number, modifyingCte: boolean, nesting: number): WithShape | null {
  if (nesting > 64) return null;
  if (tokens[pos]?.kind === "open") {
    const close = closeGroup(tokens, pos);
    if (close === null) return null;
    if (isWord(tokens[pos + 1], "with")) {
      const shape = parseWithTokens(tokens.slice(pos + 1, close), nesting + 1);
      return shape ? { ...shape, modifyingCte: shape.modifyingCte || modifyingCte } : null;
    }
    return mainShape(tokens.slice(pos + 1, close), 0, modifyingCte, nesting + 1);
  }
  const token = tokens[pos];
  if (token?.kind !== "word" || !WITH_MAIN_WORDS.has(token.word)) return null;
  return {
    main: token.word,
    modifyingCte,
    mainSelectInto: token.word === "select" && topLevelWord(tokens.slice(pos + 1), "into"),
  };
}

function parseWithTokens(tokens: ShapeToken[], nesting: number): WithShape | null {
  if (nesting > 64 || !isWord(tokens[0], "with")) return null;
  let pos = 1;
  if (isWord(tokens[pos], "recursive")) pos++;
  let modifyingCte = false;
  while (pos < tokens.length) {
    // cte_name [(columns)] [USING KEY (columns)] AS [NOT] MATERIALIZED (query)
    if (!isIdent(tokens[pos])) return null;
    pos++;
    if (tokens[pos]?.kind === "open") {
      const close = closeGroup(tokens, pos);
      if (close === null) return null;
      pos = close + 1;
    }
    if (isWord(tokens[pos], "using")) {
      if (!isWord(tokens[++pos], "key")) return null;
      const close = closeGroup(tokens, ++pos);
      if (close === null) return null;
      pos = close + 1;
    }
    if (!isWord(tokens[pos], "as")) return null;
    pos++;
    if (isWord(tokens[pos], "not")) {
      if (!isWord(tokens[++pos], "materialized")) return null;
      pos++;
    } else if (isWord(tokens[pos], "materialized")) {
      pos++;
    }
    const close = closeGroup(tokens, pos);
    if (close === null) return null;
    modifyingCte ||= bodyModifies(tokens.slice(pos + 1, close), nesting);
    pos = close + 1;

    const afterSearch = skipSearchClause(tokens, pos);
    if (afterSearch === null) return null;
    const afterCycle = skipCycleClause(tokens, afterSearch);
    if (afterCycle === null) return null;
    pos = afterCycle;
    if (tokens[pos]?.kind === "comma") {
      pos++;
      continue;
    }
    return mainShape(tokens, pos, modifyingCte, nesting);
  }
  return null;
}

/** The shape of a `WITH`-led statement — TS mirror of Rust `script::with_shape`:
 *  `main` = the keyword of the statement the CTEs feed, `modifyingCte` = a CTE body is
 *  itself a write. `null` when not WITH-led or no main statement is found. A CTE name is
 *  a depth-0 word followed by `AS` (PostgreSQL leaves `update`/`delete` non-reserved). */
export function withShape(stmt: string, kind?: string | null): WithShape | null {
  const tokens = shapeTokens(stmt, kind);
  return tokens ? parseWithTokens(tokens, 0) : null;
}
