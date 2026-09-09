// Type-aware result rendering. Pure + vitest-covered.
//
// Result values cross IPC as text with no type metadata, so a column's render
// class comes from two sources, in order:
//   1. the driver type reported by `table_detail` (exact, when the result's
//      source relation happens to be loaded — the editability path fetches it),
//   2. the loaded values themselves (a column is numeric or JSON only when EVERY
//      sampled non-NULL value is, so one stray value keeps the column on text).
//
// The class only drives PRESENTATION — alignment, the header badge, elision and
// the value viewer. `copyVal` in ResultGrid still reads the raw driver text, so
// copy and export bytes never depend on anything decided here.

import { columnKind } from "./sort";
import { classifyType } from "./filterModel";

/** How a column's cells are painted. */
export type CellClass = "number" | "boolean" | "datetime" | "json" | "text";

export type ColumnRender = {
  cls: CellClass;
  /** Short header badge ("" = no badge). */
  badge: string;
  /** Badge tooltip: the full driver type, or how the class was guessed. */
  badgeTitle: string;
  /** True when the class came from loaded values rather than a driver type. */
  inferred: boolean;
};

/** Longest cell text put into the DOM. Beyond this the cell shows a head + "…". */
export const MAX_CELL_TEXT = 300;
/** Longest cell text put into a `title` tooltip. */
export const MAX_CELL_TITLE = 600;
/** Values longer than this are never JSON-probed (parsing them would stall the frame). */
export const MAX_JSON_PROBE = 256 * 1024;
/** Rows sampled when a column's class is guessed from values. */
export const CLASS_SAMPLE_ROWS = 200;

const TYPE_ALIASES: Record<string, string> = {
  "character varying": "varchar",
  "character": "char",
  "bit varying": "varbit",
  "timestamp without time zone": "timestamp",
  "timestamp with time zone": "timestamptz",
  "time without time zone": "time",
  "time with time zone": "timetz",
  "double precision": "float8",
  "integer": "int",
  "bigint": "int8",
  "smallint": "int2",
  "boolean": "bool",
  "character large object": "clob",
};

/**
 * Compact header label for a driver type: precision/length dropped, the long
 * SQL spellings mapped to their short names, arrays keeping their `[]`.
 */
export function typeBadge(dataType: string): string {
  const raw = dataType.trim().toLowerCase().replace(/^"|"$/g, "");
  if (!raw) return "";
  const array = raw.endsWith("[]");
  const base = (array ? raw.slice(0, -2) : raw).replace(/\s*\([^)]*\)/g, "").trim();
  const short = TYPE_ALIASES[base] ?? base.split(/\s+/)[0];
  const capped = short.length > 12 ? short.slice(0, 12) : short;
  return array ? `${capped}[]` : capped;
}

const JSON_TYPE = /^(json|jsonb)$/;

/** Whether a value is a JSON object or array Tusk can pretty-print. */
export function looksJson(v: string): boolean {
  if (v.length > MAX_JSON_PROBE) return false;
  const t = v.trim();
  if (!((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]")))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/** Pretty-printed JSON for the value viewer, or null when the value is not JSON. */
export function prettyJson(v: string): string | null {
  if (v.length > MAX_JSON_PROBE) return null;
  const t = v.trim();
  if (!((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]")))) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

/** Cell text as rendered: long values are cut so one huge value cannot bloat the DOM. */
export function displayText(v: string, max = MAX_CELL_TEXT): { text: string; truncated: boolean } {
  if (v.length <= max) return { text: v, truncated: false };
  return { text: `${v.slice(0, max)}…`, truncated: true };
}

/** Tooltip text for an elided cell ("" = no tooltip needed). */
export function cellTitle(v: string | null, max = MAX_CELL_TITLE): string {
  if (v === null) return "";
  if (v.length <= MAX_CELL_TEXT) return "";
  return v.length <= max ? v : `${v.slice(0, max)}…`;
}

function jsonByValues(rows: readonly (readonly (string | null)[])[], col: number, probe: number): boolean {
  let seen = 0;
  for (const row of rows) {
    const v = row?.[col];
    if (v === null || v === undefined) continue;
    if (!looksJson(v)) return false;
    if (++seen >= probe) break;
  }
  return seen > 0;
}

/** ISO-8601 date, or date + time with an optional fraction and offset. Deliberately
 *  strict: a false positive would right-pad and re-badge a plain text column. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?([+-]\d{2}(:?\d{2})?|Z)?$/;

/** "date" / "timestamp" when EVERY sampled non-NULL value is one; null otherwise. */
function datetimeByValues(
  rows: readonly (readonly (string | null)[])[],
  col: number,
  probe: number,
): "date" | "timestamp" | null {
  let seen = 0;
  let anyTime = false;
  for (const row of rows) {
    const v = row?.[col];
    if (v === null || v === undefined) continue;
    if (TIMESTAMP.test(v)) anyTime = true;
    else if (!DATE_ONLY.test(v)) return null;
    if (++seen >= probe) break;
  }
  return seen > 0 ? (anyTime ? "timestamp" : "date") : null;
}

/**
 * Render class + header badge for every result column.
 *
 * `typeOf` returns the driver type of an ORIGINAL column index when it is known;
 * `isBool` is the grid's existing boolean-column detection (type-based when the
 * relation detail is loaded, value heuristic otherwise), so booleans stay one
 * decision.
 */
export function columnRenders(
  columns: readonly string[],
  rows: readonly (readonly (string | null)[])[],
  typeOf: (col: number) => string | undefined,
  isBool: (col: number) => boolean,
  sampleRows = CLASS_SAMPLE_ROWS,
): ColumnRender[] {
  const sample = rows.length > sampleRows ? rows.slice(0, sampleRows) : rows;
  return columns.map((_name, i) => {
    const dataType = typeOf(i);
    if (dataType && dataType.trim()) {
      const badge = typeBadge(dataType);
      const bare = dataType.trim().toLowerCase().replace(/\s*\([^)]*\)/g, "");
      const cls: CellClass = JSON_TYPE.test(bare)
        ? "json"
        : isBool(i)
          ? "boolean"
          : ((c) => (c === "number" || c === "datetime" ? c : "text"))(classifyType(dataType));
      return { cls, badge, badgeTitle: dataType.trim(), inferred: false };
    }
    if (isBool(i)) return { cls: "boolean", badge: "bool", badgeTitle: "boolean values", inferred: true };
    if (columnKind(sample, i) !== "text")
      return { cls: "number", badge: "num", badgeTitle: "numeric values", inferred: true };
    if (jsonByValues(sample, i, 20))
      return { cls: "json", badge: "json", badgeTitle: "JSON values", inferred: true };
    const stamp = datetimeByValues(sample, i, 20);
    if (stamp) return { cls: "datetime", badge: stamp, badgeTitle: `${stamp} values`, inferred: true };
    // Every header in a row carries a badge, or none of them do. A half-badged
    // header row reads as a rendering fault rather than as "this one is untyped".
    return { cls: "text", badge: "text", badgeTitle: "text values", inferred: true };
  });
}
