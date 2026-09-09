// Identifier + literal quoting. One source of truth for building SQL strings on the
// frontend. Identifier quoting is dialect-aware: MySQL uses backticks (`x`), SQL Server
// brackets ([x]), everyone else standard double-quotes ("x"). For Postgres it matches
// Rust `db::ident`, which is only used on PG-only backend paths (import/DDL).
//
// MULTI-CONNECTION RULE. Several connections are open at once, so this module var is
// only ever the ACTIVE connection's dialect (App re-applies `setSqlDialect` on every
// active-connection switch). Any SQL built for a SPECIFIC tab, dialog, or frozen
// snapshot must pin its own dialect instead of trusting the global:
//   * builders that already take a dialect/kind argument (wrapQuery, buildCommitScript,
//     formatWithOptions, explainSql, the filter SQL) — pass the owning connection's kind;
//   * everything that reaches `ident`/`lit`/`sqlDialect()` implicitly (sql/ddl.ts, the
//     Explorer scaffolds, export previews) — wrap the call in `withDialect(kind, …)`.
// `withDialect` is synchronous only: never `await` inside it, or another builder would
// observe the borrowed dialect.

let backtick = false; // true = MySQL identifier quoting
let bracket = false; // true = SQL Server identifier quoting
let dialect = "postgres"; // active driver dialect (drives DDL emission quirks)
// Whether the connected MySQL session runs with NO_BACKSLASH_ESCAPES. The backend reads
// `@@session.sql_mode` once at connect and reports it in the driver capabilities; App
// sets this alongside the SQL dialect. There is no literal form that is correct under
// both modes, so this has to be known rather than guessed. It lives here, beside the
// dialect, so `withDialect` saves and restores it as well — leaving it behind was a gap
// in the contract documented above (`sql/ddl.ts`'s `mysqlTextLiteral` reads it).
let noBackslashEscapes = false;

/** Set identifier quoting + dialect for the connected driver. Call on connect / dialect change. */
export function setSqlDialect(d: string): void {
  dialect = d;
  backtick = d === "mysql";
  bracket = d === "mssql";
}

/** The active dialect ("postgres" | "duckdb" | "mysql" | "sqlite" | "mssql"). */
export function sqlDialect(): string {
  return dialect;
}

/** Record the connected MySQL session's NO_BACKSLASH_ESCAPES mode. Call on connect. */
export function setMysqlNoBackslashEscapes(on: boolean): void {
  noBackslashEscapes = on;
}

/** Whether the dialect currently in force treats backslashes as literal characters. */
export function mysqlNoBackslashEscapes(): boolean {
  return noBackslashEscapes;
}

/**
 * Run `build` with `d` as the identifier/literal dialect, then restore the previous
 * one. This is how SQL for a NON-active connection is generated: the module-level
 * dialect belongs to the active connection, and a query must never be built with
 * another connection's quoting. Synchronous only — `build` must not await.
 */
export function withDialect<T>(d: string, build: () => T): T {
  const previousDialect = dialect;
  const previousBacktick = backtick;
  const previousBracket = bracket;
  const previousNoBackslashEscapes = noBackslashEscapes;
  setSqlDialect(d);
  // Borrowing another connection's dialect means its `sql_mode` is unknown, so fall
  // back to the default (backslashes ARE escapes) rather than carrying the active
  // connection's answer into SQL bound for a different server. Borrowing the SAME
  // dialect is in practice the same connection, so that case keeps what it had.
  if (d !== previousDialect) noBackslashEscapes = false;
  try {
    return build();
  } finally {
    dialect = previousDialect;
    backtick = previousBacktick;
    bracket = previousBracket;
    noBackslashEscapes = previousNoBackslashEscapes;
  }
}

/** Quote an identifier: `users` → `"users"` (`` `users` `` on MySQL, `[users]` on SQL Server). */
export function ident(name: string): string {
  if (backtick) return `\`${name.replace(/`/g, "``")}\``;
  if (bracket) return `[${name.replace(/]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

/** Schema-qualified identifier: `("public","users")` → `"public"."users"`. */
export function qualify(schema: string, name: string): string {
  return `${ident(schema)}.${ident(name)}`;
}

/**
 * Qualify a name, but drop the schema prefix when it matches the console's active
 * schema (search_path) — so generated queries read `"users"` instead of
 * `"sales"."users"` when you're already working in `sales`. Used only for query
 * scaffolds, never DDL (which stays explicitly qualified).
 */
export function qualifyIn(schema: string, name: string, activeSchema?: string | null): string {
  return activeSchema && schema === activeSchema ? ident(name) : qualify(schema, name);
}

const hexText = (s: string): string =>
  Array.from(new TextEncoder().encode(s), (byte) => byte.toString(16).padStart(2, "0")).join("");
const hasControl = (s: string): boolean => Array.from(s).some((ch) => {
  const code = ch.charCodeAt(0);
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
});

/** Quote a string literal. MySQL uses a UTF-8 hex literal so backslash modes and control chars cannot realign quotes. */
export function lit(s: string): string {
  if (dialect === "mysql" && s !== "") {
    const hex = Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");
    return `_utf8mb4 X'${hex}'`;
  }
  if (dialect === "postgres") {
    if (s.includes("\0")) throw new Error("PostgreSQL text literals cannot contain a zero byte");
    // Explicit escape syntax makes backslashes deterministic even when the session
    // has `standard_conforming_strings = off`. Quotes still use SQL doubling.
    if (s.includes("\\")) return `E'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  }
  if (dialect === "sqlite" && hasControl(s)) return `CAST(X'${hexText(s)}' AS TEXT)`;
  if (dialect === "duckdb" && hasControl(s)) return `decode(from_hex('${hexText(s)}'))`;
  // T-SQL has no escape character inside a string, so doubling quotes is complete; the
  // `N` prefix keeps non-ASCII text intact regardless of the column's collation.
  if (dialect === "mssql") {
    if (s.includes("\0")) throw new Error("SQL Server text literals cannot contain a zero byte");
    return `N'${s.replace(/'/g, "''")}'`;
  }
  return `'${s.replace(/'/g, "''")}'`;
}
