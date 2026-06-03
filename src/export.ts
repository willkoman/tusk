// Export configuration shared by the configurator dialog, the clipboard formatter
// (src/formats.ts), and the backend (src-tauri/src/export.rs ExportOptions mirror).

export type ExportFormat = "csv" | "tsv" | "json" | "sql" | "markdown" | "xlsx";
export type DelimiterKind = "comma" | "tab" | "semicolon" | "pipe" | "custom";
export type QuoteMode = "always" | "asNeeded" | "never";
export type NullMode = "empty" | "literal" | "custom";
export type LineEnding = "lf" | "crlf";
export type ExportScope = "all" | "loaded";
export type ExportDest = "file" | "clipboard";

export type SqlExportOptions = { table: string; multiRow: boolean; includeCreate: boolean };
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
    sql: { table: table || "exported", multiRow: false, includeCreate: false },
    xlsx: { sheetName: (table || "Sheet1").slice(0, 26), headerStyling: true, autoFilter: true, freezeHeader: true },
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
