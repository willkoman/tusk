// Export configuration shared by the configurator dialog, the clipboard formatter
// (src/formats.ts), and the backend (src-tauri/src/export.rs ExportOptions mirror).

export type ExportFormat = "csv" | "tsv" | "json" | "sql" | "markdown" | "xlsx";
export type DelimiterKind = "comma" | "tab" | "semicolon" | "pipe" | "custom";
export type QuoteMode = "always" | "asNeeded" | "never";
export type NullMode = "empty" | "literal" | "custom";
export type LineEnding = "lf" | "crlf";
export type ExportScope = "all" | "loaded" | "selection";
export type ExportDest = "file" | "clipboard";

export type SqlExportOptions = {
  table: string;
  multiRow: boolean;
  includeCreate: boolean;
  /** Reconstructed engine DDL for the source table; used verbatim when `includeCreate`
   *  is on. Empty falls back to the synthetic all-`text` CREATE. */
  createSql: string;
};
export type XlsxExportOptions = {
  sheetName: string;
  headerStyling: boolean;
  autoFilter: boolean;
  freezeHeader: boolean;
};

export type ExportOptions = {
  format: ExportFormat;
  delimiter: DelimiterKind;
  customDelimiter: string;
  quote: QuoteMode;
  quoteChar: string;
  header: boolean;
  nullMode: NullMode;
  nullText: string;
  lineEnding: LineEnding;
  bom: boolean;
  /** Included source-column indices, in output order. Empty = all, natural order. */
  columnIndices: number[];
  /**
   * Source-column indices whose values are textual booleans (t/f, true/false, 0/1),
   * exported as TRUE/FALSE (native booleans in xlsx/JSON) instead of the driver's
   * raw token. Data-shape metadata, not a user-editable option: the grid's bool
   * detection seeds it (scope=loaded/clipboard); scope=all is overridden backend-side
   * by the server-reported column types. Empty = no mapping.
   */
  boolCols: number[];
  sql: SqlExportOptions;
  xlsx: XlsxExportOptions;
};

export const EXPORT_FORMATS: { value: ExportFormat; label: string }[] = [
  { value: "csv", label: "CSV" },
  { value: "tsv", label: "TSV" },
  { value: "json", label: "JSON" },
  { value: "sql", label: "SQL inserts" },
  { value: "markdown", label: "Markdown" },
  { value: "xlsx", label: "Excel (xlsx)" },
];

export const FORMAT_EXT: Record<ExportFormat, string> = {
  csv: "csv",
  tsv: "tsv",
  json: "json",
  sql: "sql",
  markdown: "md",
  xlsx: "xlsx",
};

/** A delimited text format whose delimiter/quote/null/encoding options apply. */
export function isDelimited(f: ExportFormat): boolean {
  return f === "csv" || f === "tsv";
}

/**
 * Excel sheet names may not be empty, exceed 31 characters, or contain `[ ] : * ? / \`.
 * PARITY PAIR with `sanitize_sheet` in src-tauri/src/export.rs: the backend validates
 * the option for xlsx, so an unsanitized relation name (`2024/Q1`) has to be cleaned
 * here rather than becoming an export error.
 */
export function sanitizeSheetName(name: string): string {
  const cleaned = Array.from(name)
    .map((c) => ("[]:*?/\\".includes(c) ? "_" : c))
    .join("");
  return Array.from(cleaned).slice(0, 26).join("") || "Sheet1";
}

export function defaultExportOptions(table: string): ExportOptions {
  return {
    format: "csv",
    delimiter: "comma",
    customDelimiter: "",
    quote: "asNeeded",
    quoteChar: '"',
    header: true,
    nullMode: "empty",
    nullText: "",
    lineEnding: "lf",
    bom: false,
    columnIndices: [],
    boolCols: [],
    sql: { table: table || "exported", multiRow: false, includeCreate: false, createSql: "" },
    xlsx: { sheetName: sanitizeSheetName(table), headerStyling: true, autoFilter: true, freezeHeader: true },
  };
}

export function resolvedDelimiter(o: ExportOptions): string {
  switch (o.delimiter) {
    case "tab":
      return "\t";
    case "semicolon":
      return ";";
    case "pipe":
      return "|";
    case "custom":
      return o.customDelimiter.charAt(0) || ",";
    default:
      return ",";
  }
}

export function nullString(o: ExportOptions): string {
  return o.nullMode === "literal" ? "NULL" : o.nullMode === "custom" ? o.nullText : "";
}

// --- last-used options, per format --------------------------------------------
// Only formatting choices persist. Column projection, boolean metadata, the SQL table
// name and any reconstructed CREATE belong to one result and are always recomputed.

const REMEMBERED_KEYS = [
  "delimiter",
  "customDelimiter",
  "quote",
  "quoteChar",
  "header",
  "nullMode",
  "nullText",
  "lineEnding",
  "bom",
] as const;

// `includeCreate` is deliberately NOT remembered: restoring it would re-tick the box
// without re-fetching the source table's DDL, silently writing the synthetic all-`text`
// CREATE with none of the promised note.
const REMEMBERED_SQL_KEYS = ["multiRow"] as const;
const REMEMBERED_XLSX_KEYS = ["headerStyling", "autoFilter", "freezeHeader"] as const;

/** The subset of `o` worth remembering for its format. */
export function rememberableExportOptions(o: ExportOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of REMEMBERED_KEYS) out[key] = o[key];
  for (const key of REMEMBERED_SQL_KEYS) out[`sql.${key}`] = o.sql[key];
  for (const key of REMEMBERED_XLSX_KEYS) out[`xlsx.${key}`] = o.xlsx[key];
  return out;
}

const ALLOWED: Record<string, readonly string[]> = {
  delimiter: ["comma", "tab", "semicolon", "pipe", "custom"],
  quote: ["always", "asNeeded", "never"],
  nullMode: ["empty", "literal", "custom"],
  lineEnding: ["lf", "crlf"],
};

/**
 * Merge a remembered blob over freshly built defaults, ignoring anything that isn't a
 * value this build accepts. Stored settings are user data, not a contract: an unknown
 * or malformed entry degrades to the default rather than producing an invalid export.
 */
export function applyRememberedExportOptions(
  defaults: ExportOptions,
  remembered: Record<string, unknown> | undefined,
): ExportOptions {
  if (!remembered || typeof remembered !== "object") return defaults;
  const out: ExportOptions = { ...defaults, sql: { ...defaults.sql }, xlsx: { ...defaults.xlsx } };
  for (const key of REMEMBERED_KEYS) {
    const value = (remembered as Record<string, unknown>)[key];
    const fallback = defaults[key];
    if (typeof fallback === "boolean") {
      if (typeof value === "boolean") (out as Record<string, unknown>)[key] = value;
      continue;
    }
    if (typeof value !== "string" || value.length > 1_000) continue;
    if (ALLOWED[key] && !ALLOWED[key].includes(value)) continue;
    if ((key === "quoteChar" || key === "customDelimiter") && (Array.from(value).length > 1 || /[\r\n]/.test(value)))
      continue;
    (out as Record<string, unknown>)[key] = value;
  }
  for (const key of REMEMBERED_SQL_KEYS) {
    const value = (remembered as Record<string, unknown>)[`sql.${key}`];
    if (typeof value === "boolean") out.sql[key] = value;
  }
  for (const key of REMEMBERED_XLSX_KEYS) {
    const value = (remembered as Record<string, unknown>)[`xlsx.${key}`];
    if (typeof value === "boolean") out.xlsx[key] = value;
  }
  // A custom delimiter with no character would silently fall back to a comma.
  if (out.delimiter === "custom" && Array.from(out.customDelimiter).length !== 1)
    out.delimiter = defaults.delimiter;
  return out;
}

/**
 * Options for the Explorer's multi-table export. It exposes far fewer controls than the
 * single-result dialog, so anything it cannot show is reset to the default rather than
 * silently inherited from the last single-result export — a remembered custom NULL text
 * or CRLF ending would otherwise apply to every file with nothing on screen saying so.
 */
export function tablesExportOptions(
  format: ExportFormat,
  remembered: Record<string, Record<string, unknown>> | undefined,
): ExportOptions {
  const defaults = defaultExportOptions("");
  const out = applyRememberedExportOptions({ ...defaults, format }, remembered?.[format]);
  out.quote = defaults.quote;
  out.quoteChar = defaults.quoteChar;
  out.lineEnding = defaults.lineEnding;
  out.customDelimiter = defaults.customDelimiter;
  out.nullText = defaults.nullText;
  if (out.delimiter === "custom") out.delimiter = defaults.delimiter;
  if (out.nullMode === "custom") out.nullMode = defaults.nullMode;
  // The per-table CREATE would be the synthetic all-`text` one (export_tables never
  // reconstructs DDL), and there is no checkbox here to turn it back off.
  out.sql = { ...out.sql, includeCreate: false, createSql: "" };
  return out;
}
