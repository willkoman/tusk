// Filter tree → dialect-safe WHERE clause. Pure + vitest-covered.
//
// Rules that must not regress:
//  - Identifiers ALWAYS go through `ident` (dialect-aware quoting); values
//    ALWAYS go through `lit` (or a strict numeric/boolean literal). Nothing the
//    user types is ever interpolated raw into the statement.
//  - A column referenced by a condition must resolve to exactly ONE result
//    column; duplicates throw (the old flat filter did the same — an ambiguous
//    reference inside `SELECT * FROM (…) AS _tusk` is a server error at best).
//  - `ilike` is native only on Postgres/DuckDB; every other dialect gets the
//    LOWER(col) LIKE LOWER(pat) mapping, MySQL and SQLite included — their
//    default collations are usually case-insensitive but a `_bin`/`_cs` column
//    (or `PRAGMA case_sensitive_like`) is not, and "case-insensitive" has to mean
//    the same thing on every engine. `contains`/`starts with`/`ends with` use
//    that same mapping.
//  - Every LIKE-family comparison casts the column to text first, whatever its
//    class, so `char(n)` padding and non-text types behave identically.
//  - LIKE patterns built from user text escape `%`, `_` and the escape character
//    itself with `!` — never a backslash, whose meaning inside a string literal
//    depends on MySQL's `NO_BACKSLASH_ESCAPES`/`sql_mode=ANSI` (error 1210). The
//    `ESCAPE '!'` clause is always emitted for those operators.

import { ident, lit } from "../sql/ident";
import {
  arityOf,
  assertWithinLimits,
  conditions,
  isGroup,
  parseList,
  type ColumnClass,
  type Condition,
  type FilterNode,
  type FilterTree,
} from "./filterModel";

export type FilterSqlCtx = {
  /** Result columns, in original order — the resolution + ambiguity domain. */
  columns: string[];
  /** Real driver kind: "postgres" | "duckdb" | "sqlite" | "mysql" | "mssql". */
  dialect: string;
  /** Column name → value class. Absent ⇒ every column is "other" (text-cast). */
  classOf?: (column: string) => ColumnClass;
};

/** Strict numeric literal: only these may be emitted unquoted (number columns). */
const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const TRUTHY = new Set(["t", "true", "1", "y", "yes", "on"]);

const foldsCase = (dialect: string) => dialect !== "postgres";

/** Same folding rule the flat filter used: PG compares names exactly, others fold. */
function resolveColumn(name: string, ctx: FilterSqlCtx): string | null {
  const fold = (s: string) => (foldsCase(ctx.dialect) ? s.toLowerCase() : s);
  const key = fold(name);
  const hits = ctx.columns.filter((c) => fold(c) === key);
  if (hits.length === 0) return null;
  if (hits.length > 1) throw new Error("cannot safely filter a result with duplicate target column names");
  return hits[0];
}

/** Cast expression that makes a non-text column LIKE-able on each engine. */
function textCast(quoted: string, dialect: string): string {
  switch (dialect) {
    case "mysql":
      return `CAST(${quoted} AS CHAR)`;
    case "sqlite":
      return `CAST(${quoted} AS TEXT)`;
    case "mssql":
      return `CAST(${quoted} AS VARCHAR(MAX))`;
    default: // postgres, duckdb
      return `${quoted}::text`;
  }
}

function booleanLiteral(value: string, dialect: string): string {
  const truthy = TRUTHY.has(value.trim().toLowerCase());
  // MySQL/SQLite/MSSQL have no real boolean — they store 0/1, which is also what
  // the grid's boolean editor writes (see grid/bool.ts).
  const numeric = dialect === "mysql" || dialect === "sqlite" || dialect === "mssql";
  if (numeric) return truthy ? "1" : "0";
  return truthy ? "TRUE" : "FALSE";
}

/** Literal for one comparison value, honoring the column's class. */
function valueLiteral(value: string, cls: ColumnClass, dialect: string): string {
  if (cls === "boolean") return booleanLiteral(value, dialect);
  if (cls === "number") {
    const t = value.trim();
    // Anything that isn't unambiguously numeric stays a quoted literal — never
    // splice user text into the statement because the column happens to be a number.
    if (NUMERIC.test(t)) return t;
  }
  return lit(value);
}

/**
 * A dialect-independent LIKE escape character. `!` is a plain character in every
 * engine's string literals, so unlike a backslash it never depends on MySQL's
 * `NO_BACKSLASH_ESCAPES` (`sql_mode=ANSI` rejects `ESCAPE '\\'` with error 1210)
 * or PostgreSQL's `standard_conforming_strings`.
 */
const LIKE_ESCAPE = "!";
const ESCAPE_CLAUSE = ` ESCAPE '${LIKE_ESCAPE}'`;

const escapeLikeText = (s: string) => s.replace(/([!%_])/g, `${LIKE_ESCAPE}$1`);

/**
 * Case-insensitive LIKE, per engine. `tail` carries the ESCAPE clause for the
 * patterns this module builds (raw `ilike` patterns are the user's own).
 */
function ciLike(expr: string, pattern: string, dialect: string, negate: boolean, tail: string): string {
  const op = negate ? "NOT LIKE" : "LIKE";
  if (dialect === "postgres" || dialect === "duckdb")
    return `${expr} ${negate ? "NOT ILIKE" : "ILIKE"} ${pattern}${tail}`;
  // MySQL, SQLite and MSSQL all make case sensitivity a collation property, so
  // fold both sides explicitly rather than trusting the column's collation.
  return `LOWER(${expr}) ${op} LOWER(${pattern})${tail}`;
}

const CMP: Partial<Record<Condition["operator"], string>> = {
  eq: "=",
  ne: "<>",
  lt: "<",
  le: "<=",
  gt: ">",
  ge: ">=",
};

/**
 * One condition → SQL, or "" when it is incomplete/unresolvable.
 * Throws only for ambiguity (duplicate column names), which must not silently
 * produce a filter that matches the wrong column.
 */
export function renderCondition(cond: Condition, ctx: FilterSqlCtx): string {
  const resolved = resolveColumn(cond.column, ctx);
  if (resolved === null) return ""; // column no longer in the result — drop the rule
  const cls = ctx.classOf?.(resolved) ?? "other";
  const quoted = ident(resolved);
  const dialect = ctx.dialect;
  // LIKE-family matching is always done on text: a bare `char(n)` column would
  // otherwise match with its blank padding, and an unknown class must not decide
  // whether the comparison is textual.
  const textExpr = textCast(quoted, dialect);
  const v0 = cond.values[0] ?? "";
  const v1 = cond.values[1] ?? "";

  switch (cond.operator) {
    case "isNull":
      return `${quoted} IS NULL`;
    case "isNotNull":
      return `${quoted} IS NOT NULL`;
    case "isTrue":
    case "isFalse": {
      const want = cond.operator === "isTrue";
      if (dialect === "postgres" || dialect === "duckdb") return `${quoted} IS ${want ? "TRUE" : "FALSE"}`;
      return `${quoted} = ${want ? "1" : "0"}`;
    }
    case "isEmpty":
      return `${textExpr} = ${lit("")}`;
    case "eq":
    case "ne":
    case "lt":
    case "le":
    case "gt":
    case "ge":
      if (v0 === "") return "";
      return `${quoted} ${CMP[cond.operator]} ${valueLiteral(v0, cls, dialect)}`;
    case "between":
    case "notBetween": {
      if (v0 === "" || v1 === "") return "";
      const not = cond.operator === "notBetween" ? "NOT " : "";
      return `${quoted} ${not}BETWEEN ${valueLiteral(v0, cls, dialect)} AND ${valueLiteral(v1, cls, dialect)}`;
    }
    case "in":
    case "notIn": {
      const items = parseList(v0);
      if (!items.length) return "";
      const list = items.map((v) => valueLiteral(v, cls, dialect)).join(", ");
      return `${quoted} ${cond.operator === "notIn" ? "NOT IN" : "IN"} (${list})`;
    }
    case "like":
    case "notLike": {
      if (v0 === "") return "";
      // Raw pattern: the user owns the wildcards, so nothing is escaped.
      return `${textExpr} ${cond.operator === "notLike" ? "NOT LIKE" : "LIKE"} ${lit(v0)}`;
    }
    case "ilike":
      if (v0 === "") return "";
      return ciLike(textExpr, lit(v0), dialect, false, "");
    case "contains":
    case "startsWith":
    case "endsWith": {
      if (v0 === "") return "";
      const esc = escapeLikeText(v0);
      const pattern =
        cond.operator === "contains" ? `%${esc}%` : cond.operator === "startsWith" ? `${esc}%` : `%${esc}`;
      // Always declared: the clause is what makes the escaping above meaningful,
      // and emitting it unconditionally keeps the SQL identical whether or not
      // the typed text happened to contain a wildcard.
      return ciLike(textExpr, lit(pattern), dialect, false, ESCAPE_CLAUSE);
    }
  }
  return "";
}

function renderNode(node: FilterNode, ctx: FilterSqlCtx, top: boolean): string {
  if (!isGroup(node)) return renderCondition(node, ctx);
  const parts = node.items.map((i) => renderNode(i, ctx, false)).filter((s) => s !== "");
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0];
  const joined = parts.join(node.op === "or" ? " OR " : " AND ");
  return top ? joined : `(${joined})`;
}

/**
 * Render the whole tree as a WHERE body (no leading `WHERE`). Returns "" when
 * nothing is active. Throws on ambiguous column names or an over-budget tree.
 */
export function renderWhere(tree: FilterTree, ctx: FilterSqlCtx): string {
  assertWithinLimits(tree);
  return renderNode(tree, ctx, true);
}

/** Conditions that will actually contribute SQL (complete + resolvable). */
export function activeConditionCount(tree: FilterTree, columns: string[]): number {
  const names = new Set(columns.map((c) => c.toLowerCase()));
  return conditions(tree).filter((c) => names.has(c.column.toLowerCase())).length;
}

/** Value-slot count for a condition — the UI renders this many inputs. */
export function valueSlots(cond: Condition): number {
  const arity = arityOf(cond.operator);
  return arity === "list" ? 1 : arity;
}
