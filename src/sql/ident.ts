// Identifier + literal quoting. One source of truth for building SQL strings on the
// frontend. Identifier quoting is dialect-aware: MySQL uses backticks (`x`), everyone
// else standard double-quotes ("x"). The active dialect is set once per connection
// (`setSqlDialect`) — the app is single-connection, so this avoids threading a dialect
// arg through every call site (scaffolds, grid filters, DDL builders). For Postgres it
// matches Rust `db::ident`, which is only used on PG-only backend paths (import/DDL).

let backtick = false; // true = MySQL identifier quoting
let dialect = "postgres"; // active driver dialect (drives DDL emission quirks)

/** Set identifier quoting + dialect for the connected driver. Call on connect / dialect change. */
export function setSqlDialect(d: string): void {
  dialect = d;
  backtick = d === "mysql";
}

/** The active dialect ("postgres" | "duckdb" | "mysql" | "sqlite"). */
export function sqlDialect(): string {
  return dialect;
}

/** Quote an identifier: `users` → `"users"` (or `` `users` `` on MySQL). */
export function ident(name: string): string {
  return backtick ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;
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
  return `'${s.replace(/'/g, "''")}'`;
}
