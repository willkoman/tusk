// Import configuration + pure helpers shared by the multi-step Import dialog and the
// backend (src-tauri/src/import.rs mirrors these payloads field for field).

export type ImportFormat = "csv" | "json" | "xlsx";
export type ImportDelimiter = "comma" | "tab" | "semicolon" | "pipe" | "custom";
export type ImportEncoding = "utf-8" | "latin1";
export type ConflictMode = "error" | "ignore" | "update";

/** The type tokens the backend accepts. PARITY PAIR with `ColumnType` in import.rs. */
export type ImportColumnType =
  | "text"
  | "integer"
  | "bigint"
  | "numeric"
  | "boolean"
  | "date"
  | "timestamp";

export const IMPORT_COLUMN_TYPES: ImportColumnType[] = [
  "text",
  "integer",
  "bigint",
  "numeric",
  "boolean",
  "date",
  "timestamp",
];

export type ImportOptions = {
  format: ImportFormat;
  delimiter: ImportDelimiter;
  customDelimiter: string;
  quoteChar: string;
  escapeChar: string;
  header: boolean;
  encoding: ImportEncoding;
  nullText: string;
  skipRows: number;
  sheet: string;
  /** Column names seen in the preview; the run path refuses a file that changed. */
  sourceColumns: string[];
};

export type ImportColumnMapping = {
  /** Source column index, or null when the target column is skipped. */
  source: number | null;
  target: string;
  type: ImportColumnType;
  emptyAsNull: boolean;
};

export type ImportTarget = {
  schema: string;
  table: string;
  create: boolean;
  truncate: boolean;
  conflict: ConflictMode;
  columns: { source: number; target: string; type: ImportColumnType; emptyAsNull: boolean }[];
  keyColumns: string[];
};

export type ImportPreview = {
  columns: string[];
  rows: (string | null)[][];
  warnings: string[];
  sheets: string[];
  truncated: boolean;
  fileBytes: number;
};

export type ImportSummary = {
  rowsRead: number;
  rowsInserted: number;
  rowsSkipped: number;
  warnings: string[];
  /** MySQL commits DDL immediately, so a create-and-load import runs its `CREATE TABLE`
   *  before the transaction: the table is already committed when the rows load. */
  createdOutsideTransaction: boolean;
};

export type ImportProgress = {
  rowsRead: number;
  rowsInserted: number;
  bytesRead: number;
  totalBytes: number;
  done: boolean;
};

/** Extension → format + delimiter defaults. */
export function formatForFile(name: string): { format: ImportFormat; delimiter: ImportDelimiter } {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json") || lower.endsWith(".ndjson") || lower.endsWith(".jsonl"))
    return { format: "json", delimiter: "comma" };
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm") || lower.endsWith(".xls"))
    return { format: "xlsx", delimiter: "comma" };
  if (lower.endsWith(".tsv") || lower.endsWith(".tab")) return { format: "csv", delimiter: "tab" };
  return { format: "csv", delimiter: "comma" };
}

export function defaultImportOptions(fileName = ""): ImportOptions {
  const { format, delimiter } = formatForFile(fileName);
  return {
    format,
    delimiter,
    customDelimiter: "",
    quoteChar: '"',
    escapeChar: "",
    header: true,
    encoding: "utf-8",
    nullText: "",
    skipRows: 0,
    sheet: "",
    sourceColumns: [],
  };
}

/** A file name turned into a plausible new-table name. */
export function tableNameFromFile(name: string): string {
  const stem = name.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const cleaned = stem.replace(/[^\w]/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return cleaned || "imported";
}

// ---------------------------------------------------------------------------
// Type inference
// ---------------------------------------------------------------------------

const INT_RE = /^[+-]?\d+$/;
const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
/** `0`/`1` are deliberately excluded — an integer column must not read as boolean. */
const BOOL_WORDS = new Set(["true", "false", "t", "f", "yes", "no", "y", "n"]);

/**
 * Above this magnitude an `integer` column is a bad bet even when every sampled value
 * fits: the sample is at most 50 rows, and a later row past `int4` would be rejected by
 * the engine after the load has already been running for a while.
 */
const INT32_SAFE = 1073741823; // INT32_MAX / 2
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** Does this all-digits token fit the `bigint` the loader coerces with? */
function fitsInt64(v: string): boolean {
  try {
    const n = BigInt(v);
    return n >= INT64_MIN && n <= INT64_MAX;
  } catch {
    return false;
  }
}

/**
 * Infer one column's type from sampled values. Blank (including whitespace-only) and
 * NULL values are ignored — the loader treats them as empty too — and a column with
 * nothing to go on stays `text`, which never rejects a row. Integers are checked before
 * booleans so a 0/1 column imports as a number.
 */
export function inferType(values: (string | null)[]): ImportColumnType {
  const seen: string[] = [];
  for (const value of values) {
    if (value === null) continue;
    const trimmed = value.trim();
    if (trimmed === "") continue;
    seen.push(trimmed);
    if (seen.length >= 500) break;
  }
  if (!seen.length) return "text";
  if (seen.every((v) => INT_RE.test(v))) {
    // A value the loader's i64 coercion would reject is not an integer column at all —
    // `bigint` would fail at row 1 and truncate even if it landed. Text keeps it.
    if (!seen.every(fitsInt64)) return "text";
    const fitsInt32 = seen.every((v) => {
      const n = Number(v);
      return Number.isSafeInteger(n) && Math.abs(n) <= INT32_SAFE;
    });
    return fitsInt32 ? "integer" : "bigint";
  }
  if (seen.every((v) => NUM_RE.test(v))) return "numeric";
  if (seen.every((v) => BOOL_WORDS.has(v.toLowerCase()))) return "boolean";
  if (seen.every((v) => DATE_RE.test(v))) return "date";
  if (seen.every((v) => TIMESTAMP_RE.test(v) || DATE_RE.test(v))) return "timestamp";
  return "text";
}

/** Infer every column of a preview at once. */
export function inferTypes(columns: string[], rows: (string | null)[][]): ImportColumnType[] {
  return columns.map((_, i) => inferType(rows.map((r) => r[i] ?? null)));
}

/**
 * Map a database's declared column type onto an import token, so values headed for an
 * existing column are validated (and booleans normalized) before they reach the engine.
 * Anything unrecognized stays `text` — a quoted literal the engine casts itself.
 */
export function tokenForDeclaredType(declared: string): ImportColumnType {
  const t = declared.toLowerCase().replace(/\(.*$/, "").trim();
  // NOT tinyint: MySQL reports `tinyint` for every width, and DuckDB's TINYINT is a
  // true 1-byte integer with a separate BOOLEAN. Mapping it to boolean rejected every
  // value outside 0/1 (`4` in a ratings column failed the whole import).
  if (/^(bool|boolean)$/.test(t)) return "boolean";
  if (/^(smallint|int2|integer|int|int4|mediumint|serial|tinyint)$/.test(t)) return "integer";
  if (/^(bigint|int8|bigserial)$/.test(t)) return "bigint";
  if (/^(numeric|decimal|real|double|double precision|float|float4|float8|hugeint)$/.test(t))
    return "numeric";
  if (t === "date") return "date";
  // Timestamps and dates both go through the string-literal path; the token only
  // affects the CREATE TABLE type, so treating them alike is safe.
  if (/^(timestamp|datetime)/.test(t)) return "timestamp";
  return "text";
}

/**
 * The engine type an inferred token creates as. PARITY PAIR with `ColumnType::sql` in
 * src-tauri/src/import.rs — the backend is authoritative; this drives the preview only.
 */
export const SQL_TYPES: Record<string, Record<ImportColumnType, string>> = {
  postgres: {
    text: "text",
    integer: "integer",
    bigint: "bigint",
    numeric: "numeric",
    boolean: "boolean",
    date: "date",
    timestamp: "timestamp",
  },
  duckdb: {
    text: "VARCHAR",
    integer: "INTEGER",
    bigint: "BIGINT",
    numeric: "DOUBLE",
    boolean: "BOOLEAN",
    date: "DATE",
    timestamp: "TIMESTAMP",
  },
  sqlite: {
    text: "TEXT",
    integer: "INTEGER",
    bigint: "INTEGER",
    numeric: "NUMERIC",
    boolean: "INTEGER",
    date: "TEXT",
    timestamp: "TEXT",
  },
  mysql: {
    text: "TEXT",
    integer: "INT",
    bigint: "BIGINT",
    numeric: "DECIMAL(38,10)",
    boolean: "TINYINT(1)",
    date: "DATE",
    timestamp: "DATETIME",
  },
};

export function sqlTypeFor(token: ImportColumnType, dialect: string): string {
  return (SQL_TYPES[dialect] ?? SQL_TYPES.postgres)[token];
}

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Auto-match file columns onto target columns: exact case-insensitive names first, then
 * a normalized comparison (underscores/spaces/case ignored). Every source column is used
 * at most once; unmatched targets come back `null` (skipped).
 */
export function autoMatch(sourceColumns: string[], targetColumns: string[]): (number | null)[] {
  const taken = new Set<number>();
  const pick = (test: (source: string) => boolean): number | null => {
    for (let i = 0; i < sourceColumns.length; i++) {
      if (!taken.has(i) && test(sourceColumns[i])) {
        taken.add(i);
        return i;
      }
    }
    return null;
  };
  const exact = targetColumns.map((target) =>
    pick((source) => source.toLowerCase() === target.toLowerCase()),
  );
  return targetColumns.map((target, k) =>
    exact[k] !== null ? exact[k] : pick((source) => normalize(source) === normalize(target)),
  );
}

/** Mapping for "create a new table": one target column per source column. */
export function newTableMapping(
  columns: string[],
  types: ImportColumnType[],
): ImportColumnMapping[] {
  return columns.map((name, i) => ({
    source: i,
    target: name,
    type: types[i] ?? "text",
    emptyAsNull: (types[i] ?? "text") !== "text",
  }));
}

/** Mapping for an existing table: auto-matched sources, target types from the catalog. */
export function existingTableMapping(
  sourceColumns: string[],
  targetColumns: { name: string; data_type: string }[],
): ImportColumnMapping[] {
  const matched = autoMatch(
    sourceColumns,
    targetColumns.map((c) => c.name),
  );
  return targetColumns.map((column, k) => {
    const type = tokenForDeclaredType(column.data_type);
    return {
      source: matched[k],
      target: column.name,
      type,
      emptyAsNull: type !== "text",
    };
  });
}

export type MappingIssue = { level: "error" | "warning"; message: string };

/** Everything that would make the backend refuse, checked before the run step. */
export function mappingIssues(
  mapping: ImportColumnMapping[],
  target: { table: string; conflict: ConflictMode; keyColumns: string[] },
  dialect: string,
): MappingIssue[] {
  const issues: MappingIssue[] = [];
  const active = mapping.filter((m) => m.source !== null);
  if (!target.table.trim()) issues.push({ level: "error", message: "Choose a target table." });
  if (!active.length) issues.push({ level: "error", message: "Map at least one column." });
  const names = active.map((m) => m.target.toLowerCase());
  if (new Set(names).size !== names.length)
    issues.push({ level: "error", message: "A target column is mapped twice." });
  if (active.some((m) => !m.target.trim()))
    issues.push({ level: "error", message: "A mapped column has no target name." });
  const skipped = mapping.length - active.length;
  if (skipped > 0)
    issues.push({
      level: "warning",
      message: `${skipped} column${skipped > 1 ? "s are" : " is"} skipped and will keep the table's default.`,
    });
  if (target.conflict === "update") {
    if (dialect === "postgres" && !target.keyColumns.length)
      issues.push({
        level: "error",
        message: "PostgreSQL upsert needs at least one conflict key column.",
      });
    for (const key of target.keyColumns)
      if (!active.some((m) => m.target === key))
        issues.push({ level: "error", message: `Key column ${key} is not mapped.` });
    if (dialect === "sqlite" || dialect === "duckdb")
      issues.push({
        level: "warning",
        message: "This engine upserts with INSERT OR REPLACE — unmapped columns reset to their default.",
      });
    if (dialect === "mysql")
      issues.push({
        level: "warning",
        message: "MySQL updates on any duplicate key, not only the columns chosen here.",
      });
  }
  return issues;
}

/** The exact `target` payload `import_from_file` expects. */
export function buildTarget(
  mapping: ImportColumnMapping[],
  base: {
    schema: string;
    table: string;
    create: boolean;
    truncate: boolean;
    conflict: ConflictMode;
    keyColumns: string[];
  },
): ImportTarget {
  const columns = mapping
    .filter((m): m is ImportColumnMapping & { source: number } => m.source !== null)
    .map((m) => ({
      source: m.source,
      target: m.target,
      type: m.type,
      emptyAsNull: m.emptyAsNull,
    }));
  return {
    schema: base.schema,
    table: base.table,
    create: base.create,
    truncate: base.truncate,
    conflict: base.conflict,
    columns,
    keyColumns: base.conflict === "update" ? base.keyColumns.filter((k) => columns.some((c) => c.target === k)) : [],
  };
}

/** The `options` payload for the run step: the preview's columns are pinned into it. */
export function runOptions(options: ImportOptions, previewColumns: string[]): ImportOptions {
  return { ...options, sourceColumns: [...previewColumns] };
}

/** Human-readable conflict labels per engine (the SQL each one generates differs). */
export function conflictLabel(mode: ConflictMode, dialect: string): string {
  if (mode === "error") return "Fail on conflict";
  if (mode === "ignore")
    return dialect === "postgres"
      ? "Skip conflicting rows (ON CONFLICT DO NOTHING)"
      : dialect === "mysql"
        ? "Skip conflicting rows (INSERT IGNORE)"
        : "Skip conflicting rows (INSERT OR IGNORE)";
  return dialect === "postgres"
    ? "Update conflicting rows (ON CONFLICT DO UPDATE)"
    : dialect === "mysql"
      ? "Update conflicting rows (ON DUPLICATE KEY UPDATE)"
      : "Replace conflicting rows (INSERT OR REPLACE)";
}
