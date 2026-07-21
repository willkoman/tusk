import { type SortKey } from "../tabs";

export type DriverKind = "postgres" | "duckdb" | "sqlite" | "mysql" | string | undefined;

function nullsFirst(kind: DriverKind, dir: SortKey["dir"]): boolean {
  if (kind === "postgres") return dir === "desc";
  if (kind === "duckdb") return false;
  return dir === "asc"; // SQLite/MySQL defaults.
}

/**
 * Stable display-text ordering over canonical row indices. Result values arrive
 * as text, so native numeric/date/collation ordering cannot be reproduced
 * without adding result type metadata. The final canonical-index comparison
 * makes ties deterministic and makes every sort independent of gesture history.
 */
export function sortedRowOrder(
  rows: readonly (readonly (string | null)[])[],
  sorts: readonly SortKey[],
  kind?: DriverKind,
): number[] {
  const valid = sorts.filter((s) => Number.isInteger(s.col) && s.col >= 0);
  const order = Array.from({ length: rows.length }, (_, i) => i);
  if (!valid.length) return order;
  order.sort((ai, bi) => {
    const a = rows[ai];
    const b = rows[bi];
    for (const sort of valid) {
      const av = a?.[sort.col] ?? null;
      const bv = b?.[sort.col] ?? null;
      if (av === bv) continue;
      if (av === null || bv === null) {
        const first = nullsFirst(kind, sort.dir);
        return av === null ? (first ? -1 : 1) : first ? 1 : -1;
      }
      const cmp = av < bv ? -1 : 1;
      return sort.dir === "asc" ? cmp : -cmp;
    }
    return ai - bi;
  });
  return order;
}

/** Materialize canonical rows in visible order without mutating either input. */
export function orderedRows<T>(rows: readonly T[], order: readonly number[] | null): T[] {
  if (!order) return [...rows];
  return order.flatMap((i) => (Number.isInteger(i) && i >= 0 && i < rows.length ? [rows[i]] : []));
}
