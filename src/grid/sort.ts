import { type SortKey } from "../tabs";

export type DriverKind = "postgres" | "duckdb" | "sqlite" | "mysql" | string | undefined;

function nullsFirst(kind: DriverKind, dir: SortKey["dir"]): boolean {
  if (kind === "postgres") return dir === "desc";
  if (kind === "duckdb") return false;
  return dir === "asc"; // SQLite/MySQL defaults.
}

/** Plain decimal / scientific literal as every driver prints numbers over the text protocol. */
const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER_RE = /^[+-]?\d+$/;
const SPECIAL_FLOATS = new Set(["NaN", "Infinity", "-Infinity", "inf", "-inf", "+Infinity", "+inf"]);

type ColumnKind = "text" | "integer" | "number";

/**
 * Infer how a column's loaded values should compare. Result values carry no
 * type metadata, so a column is numeric only when EVERY non-null value is a
 * numeric literal — one stray value keeps the whole column on text ordering so
 * mixed data never sorts inconsistently. All-null/empty columns stay text.
 */
export function columnKind(rows: readonly (readonly (string | null)[])[], col: number): ColumnKind {
  let seen = false;
  let allInt = true;
  for (const row of rows) {
    const v = row?.[col];
    if (v === null || v === undefined) continue;
    seen = true;
    if (INTEGER_RE.test(v)) continue;
    allInt = false;
    if (!NUMERIC_RE.test(v) && !SPECIAL_FLOATS.has(v)) return "text";
  }
  if (!seen) return "text";
  return allInt ? "integer" : "number";
}

/** Exact integer comparison of decimal strings of any length (no Number precision loss). */
function compareIntegerText(a: string, b: string): number {
  const na = a[0] === "-";
  const nb = b[0] === "-";
  const da = a.replace(/^[+-]?0*/, "");
  const db = b.replace(/^[+-]?0*/, "");
  // "-0" and "0" are equal.
  const za = da === "";
  const zb = db === "";
  if (za && zb) return 0;
  if (za) return nb ? 1 : -1;
  if (zb) return na ? -1 : 1;
  if (na !== nb) return na ? -1 : 1;
  const mag = da.length === db.length ? (da < db ? -1 : da > db ? 1 : 0) : da.length < db.length ? -1 : 1;
  return na ? -mag : mag;
}

function toNumber(v: string): number {
  if (SPECIAL_FLOATS.has(v)) {
    if (v === "NaN") return NaN;
    return v[0] === "-" ? -Infinity : Infinity;
  }
  return Number(v);
}

/** Numeric compare; NaN sorts after every real number (PostgreSQL semantics). */
function compareNumberText(a: string, b: string): number {
  const x = toNumber(a);
  const y = toNumber(b);
  const xn = Number.isNaN(x);
  const yn = Number.isNaN(y);
  if (xn || yn) return xn && yn ? 0 : xn ? 1 : -1;
  return x < y ? -1 : x > y ? 1 : 0;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const COMPARATORS: Record<ColumnKind, (a: string, b: string) => number> = {
  text: compareText,
  integer: compareIntegerText,
  number: compareNumberText,
};

/**
 * Stable ordering over canonical row indices. Result values arrive as text, so
 * per-column numeric ordering is inferred from the loaded values (see
 * `columnKind`); everything else uses deterministic display-text ordering since
 * native date/collation semantics cannot be reproduced without type metadata.
 * The final canonical-index comparison makes ties deterministic and makes
 * every sort independent of gesture history.
 */
export function sortedRowOrder(
  rows: readonly (readonly (string | null)[])[],
  sorts: readonly SortKey[],
  kind?: DriverKind,
): number[] {
  const valid = sorts.filter((s) => Number.isInteger(s.col) && s.col >= 0);
  const order = Array.from({ length: rows.length }, (_, i) => i);
  if (!valid.length) return order;
  const cmps = valid.map((s) => COMPARATORS[columnKind(rows, s.col)]);
  order.sort((ai, bi) => {
    const a = rows[ai];
    const b = rows[bi];
    for (let k = 0; k < valid.length; k++) {
      const sort = valid[k];
      const av = a?.[sort.col] ?? null;
      const bv = b?.[sort.col] ?? null;
      if (av === bv) continue;
      if (av === null || bv === null) {
        const first = nullsFirst(kind, sort.dir);
        return av === null ? (first ? -1 : 1) : first ? 1 : -1;
      }
      const cmp = cmps[k](av, bv);
      if (cmp === 0) continue;
      return sort.dir === "asc" ? cmp : -cmp;
    }
    return ai - bi;
  });
  return order;
}

/** Materialize canonical rows in visible order without mutating either input. */
export function orderedRows<T>(rows: readonly T[], order: readonly number[] | null): T[] {
  if (!order) return [...rows];
  if (
    order.length !== rows.length ||
    new Set(order).size !== rows.length ||
    order.some((i) => !Number.isInteger(i) || i < 0 || i >= rows.length)
  ) return [...rows];
  return order.map((i) => rows[i]);
}
