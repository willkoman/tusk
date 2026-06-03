// Identifier + literal quoting — mirrors Rust `db::ident` (src-tauri/src/db.rs).
// One source of truth for building SQL strings on the frontend.

/** Quote an identifier: `users` → `"users"`, `we"ird` → `"we""ird"`. */
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Schema-qualified identifier: `("public","users")` → `"public"."users"`. */
export function qualify(schema: string, name: string): string {
  return `${ident(schema)}.${ident(name)}`;
}

/** Quote a string literal: `O'Brien` → `'O''Brien'` (standard_conforming_strings assumed on). */
export function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
