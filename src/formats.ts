// CSV / JSON / TSV / SQL / Markdown parsing + formatting for import / export.

export type Dataset = { columns: string[]; rows: (string | null)[][] };

export const IMPORT_LIMITS = {
  bytes: 20_000_000,
  chars: 20_000_000,
  rows: 200_000,
  columns: 10_000,
  cells: 2_000_000,
  fieldChars: 1_000_000,
} as const;

function importLimit(message: string): never {
  throw new Error(`import is too large: ${message}`);
}

// ---------- parsing (import) ----------

export function parseCSV(text: string, hasHeader: boolean, delimiter = ","): Dataset {
  if (text.length > IMPORT_LIMITS.chars) importLimit(`file exceeds ${IMPORT_LIMITS.chars.toLocaleString()} characters`);
  if (delimiter !== "," && delimiter !== "\t") throw new Error("unsupported import delimiter");
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let afterQuote = false;
  let fieldStarted = false;
  let i = 0;
  let parsedCells = 0;
  const pushField = () => {
    if (row.length >= IMPORT_LIMITS.columns) importLimit(`more than ${IMPORT_LIMITS.columns.toLocaleString()} columns`);
    if (++parsedCells > IMPORT_LIMITS.cells) importLimit(`more than ${IMPORT_LIMITS.cells.toLocaleString()} cells`);
    row.push(field);
    field = "";
    afterQuote = false;
    fieldStarted = false;
  };
  const pushRow = () => {
    if (rows.length >= IMPORT_LIMITS.rows) importLimit(`more than ${IMPORT_LIMITS.rows.toLocaleString()} rows`);
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        afterQuote = true;
        i++;
        continue;
      }
      field += ch;
      if (field.length > IMPORT_LIMITS.fieldChars) importLimit(`a field exceeds ${IMPORT_LIMITS.fieldChars.toLocaleString()} characters`);
      i++;
      continue;
    }
    if (afterQuote && ch !== delimiter && ch !== "\r" && ch !== "\n")
      throw new Error("malformed delimited file: characters after a closing quote");
    if (ch === '"') {
      if (fieldStarted || field.length)
        throw new Error("malformed delimited file: quote inside an unquoted field");
      inQuotes = true;
      fieldStarted = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r") {
      pushField();
      pushRow();
      i += text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      pushField();
      pushRow();
      i++;
      continue;
    }
    field += ch;
    if (field.length > IMPORT_LIMITS.fieldChars) importLimit(`a field exceeds ${IMPORT_LIMITS.fieldChars.toLocaleString()} characters`);
    fieldStarted = true;
    i++;
  }
  if (inQuotes) throw new Error("malformed delimited file: unterminated quoted field");
  if (fieldStarted || afterQuote || field.length > 0 || row.length > 0) {
    pushField();
    pushRow();
  }
  const data = rows;
  if (data.length === 0) return { columns: [], rows: [] };
  let width = data[0].length;
  if (!hasHeader) for (const r of data) width = Math.max(width, r.length);
  const columns = hasHeader ? data[0] : Array.from({ length: width }, (_, k) => `col${k + 1}`);
  const body = hasHeader ? data.slice(1) : data;
  if (hasHeader) {
    if (columns.some((column) => column === "")) throw new Error("delimited header contains an empty column name");
    const keys = columns.map((column) => column.toLowerCase());
    if (new Set(keys).size !== keys.length) throw new Error("delimited header contains duplicate column names");
    if (body.some((r) => r.length > columns.length))
      throw new Error("delimited row has more fields than the header");
  }
  if (columns.length * body.length > IMPORT_LIMITS.cells)
    importLimit(`dense result would exceed ${IMPORT_LIMITS.cells.toLocaleString()} cells`);
  return {
    columns,
    rows: body.map((r) => columns.map((_, k) => (k < r.length ? r[k] : null))),
  };
}

function assertUniqueJsonKeys(text: string): void {
  let i = 0;
  const malformed = (): never => { throw new Error("malformed JSON import"); };
  const ws = () => {
    while (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r") i++;
  };
  const tokenRe = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
  const string = (decode: boolean): string => {
    const start = i;
    if (text[i++] !== '"') return malformed();
    while (i < text.length) {
      const ch = text[i++];
      if (ch === '"') {
        if (!decode) return "";
        try { return JSON.parse(text.slice(start, i)); }
        catch { return malformed(); }
      }
      if (ch === "\\") {
        if (i >= text.length) return malformed();
        i++;
      } else if (ch.charCodeAt(0) < 0x20) return malformed();
    }
    return malformed();
  };
  const value = (depth: number): void => {
    if (depth > 256) throw new Error("JSON import exceeds the 256-level nesting limit");
    ws();
    if (text[i] === "{") {
      i++;
      ws();
      const keys = new Set<string>();
      if (text[i] === "}") { i++; return; }
      while (i < text.length) {
        const key = string(true);
        if (keys.has(key)) throw new Error(`JSON import contains duplicate object key ${JSON.stringify(key)}`);
        keys.add(key);
        ws();
        if (text[i++] !== ":") return malformed();
        value(depth + 1);
        ws();
        if (text[i] === "}") { i++; return; }
        if (text[i++] !== ",") return malformed();
        ws();
      }
      return malformed();
    }
    if (text[i] === "[") {
      i++;
      ws();
      if (text[i] === "]") { i++; return; }
      while (i < text.length) {
        value(depth + 1);
        ws();
        if (text[i] === "]") { i++; return; }
        if (text[i++] !== ",") return malformed();
      }
      return malformed();
    }
    if (text[i] === '"') { string(false); return; }
    tokenRe.lastIndex = i;
    const token = tokenRe.exec(text);
    if (!token) return malformed();
    i += token[0].length;
  };
  ws();
  value(0);
  ws();
  if (i !== text.length) malformed();
}

export function parseJSON(text: string): Dataset {
  if (text.length > IMPORT_LIMITS.chars) importLimit(`file exceeds ${IMPORT_LIMITS.chars.toLocaleString()} characters`);
  assertUniqueJsonKeys(text);
  const parsed = JSON.parse(text);
  const arr: any[] = Array.isArray(parsed) ? parsed : [parsed];
  if (arr.length > IMPORT_LIMITS.rows) importLimit(`more than ${IMPORT_LIMITS.rows.toLocaleString()} rows`);
  if (arr.some((o) => !o || typeof o !== "object" || Array.isArray(o)))
    throw new Error("JSON import requires an object or an array of objects");
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const o of arr) {
    for (const k of Object.keys(o)) {
      if (!seen.has(k)) {
        if (columns.length >= IMPORT_LIMITS.columns) importLimit(`more than ${IMPORT_LIMITS.columns.toLocaleString()} columns`);
        seen.add(k);
        columns.push(k);
      }
    }
  }
  if (columns.length * arr.length > IMPORT_LIMITS.cells)
    importLimit(`dense result would exceed ${IMPORT_LIMITS.cells.toLocaleString()} cells`);
  const rows = arr.map((o) =>
    columns.map((c) => {
      const v = o?.[c];
      if (v === undefined || v === null) return null;
      const rendered = typeof v === "object" ? JSON.stringify(v) : String(v);
      if (rendered.length > IMPORT_LIMITS.fieldChars)
        importLimit(`a field exceeds ${IMPORT_LIMITS.fieldChars.toLocaleString()} characters`);
      return rendered;
    }),
  );
  return { columns, rows };
}

// ---------- formatting (export) ----------

const FORMAT_LIMITS = {
  rows: 200_000,
  columns: 10_000,
  cells: 2_000_000,
  fieldChars: 1_000_000,
  metadataChars: 8 * 1024 * 1024,
  outputChars: 64 * 1024 * 1024,
} as const;

function validateDataset(d: Dataset): void {
  if (!Array.isArray(d.columns) || !Array.isArray(d.rows) || d.columns.length === 0)
    throw new Error("formatting requires at least one result column");
  if (d.columns.length > FORMAT_LIMITS.columns) throw new Error("formatting exceeds the 10,000-column limit");
  if (d.rows.length > FORMAT_LIMITS.rows) throw new Error("formatting exceeds the 200,000-row limit");
  if (d.columns.length * d.rows.length > FORMAT_LIMITS.cells)
    throw new Error("formatting exceeds the 2,000,000-cell limit");
  let metadata = 0;
  let inputChars = 0;
  for (const column of d.columns) {
    if (typeof column !== "string" || column.length > FORMAT_LIMITS.fieldChars || column.includes("\0"))
      throw new Error("formatting contains an invalid or oversized column name");
    metadata += column.length;
    inputChars += column.length;
    if (metadata > FORMAT_LIMITS.metadataChars) throw new Error("formatting column metadata exceeds 8 MiB");
  }
  for (const row of d.rows) {
    if (!Array.isArray(row) || row.length !== d.columns.length)
      throw new Error("formatting requires rectangular rows matching the result columns");
    for (const value of row) {
      if (value !== null && (typeof value !== "string" || value.length > FORMAT_LIMITS.fieldChars))
        throw new Error("formatting contains an invalid or oversized value");
      inputChars += value?.length ?? 0;
      if (inputChars > FORMAT_LIMITS.outputChars) throw new Error("formatting input exceeds the 64 MiB limit");
    }
  }
}

function bounded(text: string): string {
  if (
    text.length > FORMAT_LIMITS.outputChars ||
    new TextEncoder().encode(text).byteLength > FORMAT_LIMITS.outputChars
  ) throw new Error("formatted output exceeds the 64 MiB limit");
  return text;
}

function ensureFormatBudget(d: Dataset, expansion: number, nullChars = 0): void {
  let estimate = 32 + d.columns.length * 8 + d.rows.length * 4;
  for (const column of d.columns) estimate += column.length * expansion + 4;
  for (const row of d.rows) {
    for (const value of row) estimate += (value?.length ?? nullChars) * expansion + 4;
    if (estimate > FORMAT_LIMITS.outputChars)
      throw new Error("formatted output would exceed the 64 MiB limit");
  }
}

function requireUniqueColumns(columns: string[], format: string): void {
  if (new Set(columns).size !== columns.length)
    throw new Error(`${format} object export requires unique column names`);
}

function quoteCell(v: string | null, sep: string): string {
  if (v === null) return "";
  if (v.includes(sep) || v.includes('"') || v.includes("\n") || v.includes("\r")) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

// Parity with Rust `export.rs`: escape pipes and flatten newlines — no HTML-entity
// escaping, so the same result copied here and exported to file yields identical
// text and pasted cells still match the database values.
function markdownCell(v: string | null): string {
  return v === null ? "" : v.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Grid "Copy as X": the SAME bytes as Export→Clipboard/file for the same rows,
 *  with fixed sane options. One formatter for one user-facing concept — the legacy
 *  toCSV/toTSV/toJSON/toMarkdown helpers below survive only for paste round-trip
 *  tests. Markdown always emits its header (a headerless markdown table isn't
 *  valid markdown). */
export function formatForCopy(d: Dataset, fmt: "tsv" | "csv" | "json" | "md", header: boolean): string {
  const opts = defaultExportOptions("");
  opts.format = fmt === "md" ? "markdown" : fmt;
  opts.delimiter = fmt === "tsv" ? "tab" : "comma";
  opts.header = fmt === "md" ? true : header;
  return formatWithOptions(d, opts);
}

export function toCSV(d: Dataset, header = true): string {
  validateDataset(d);
  ensureFormatBudget(d, 2);
  const lines: string[] = [];
  if (header) lines.push(d.columns.map((c) => quoteCell(c, ",")).join(","));
  for (const r of d.rows) lines.push(r.map((v) => quoteCell(v, ",")).join(","));
  return bounded(lines.join("\n"));
}

export function toTSV(d: Dataset, header = true): string {
  validateDataset(d);
  ensureFormatBudget(d, 2);
  const lines: string[] = [];
  if (header) lines.push(d.columns.map((c) => quoteCell(c, "\t")).join("\t"));
  for (const r of d.rows) lines.push(r.map((v) => quoteCell(v, "\t")).join("\t"));
  return bounded(lines.join("\n"));
}

export function toJSON(d: Dataset, header = true): string {
  validateDataset(d);
  ensureFormatBudget(d, 6, 4);
  if (header) requireUniqueColumns(d.columns, "JSON");
  // With headers → array of objects keyed by column name; without → array of value
  // arrays (the column names are exactly what the user is opting out of).
  const value = header
    ? d.rows.map((r) => Object.fromEntries(d.columns.map((c, k) => [c, r[k]])))
    : d.rows.map((r) => [...r]);
  return bounded(JSON.stringify(value, null, 2));
}

function sqlVal(v: string | null): string {
  if (v === null) return "NULL";
  if (v.includes("\0")) throw new Error("PostgreSQL SQL output cannot represent a zero byte");
  return v.includes("\\")
    ? `E'${v.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`
    : `'${v.replace(/'/g, "''")}'`;
}

export function toSQL(d: Dataset, table: string): string {
  validateDataset(d);
  ensureFormatBudget(d, 6, 4);
  if (table.includes("\0")) throw new Error("SQL output table name contains a zero byte");
  const target = `"${table.replace(/"/g, '""')}"`;
  const cols = d.columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
  return bounded(d.rows
    .map((r) => `INSERT INTO ${target} (${cols}) VALUES (${r.map(sqlVal).join(", ")});`)
    .join("\n"));
}

export function toMarkdown(d: Dataset, header = true): string {
  validateDataset(d);
  ensureFormatBudget(d, 6);
  const body = d.rows.map((r) => `| ${r.map(markdownCell).join(" | ")} |`).join("\n");
  if (!header) return bounded(body);
  // Rust's header path escapes pipes only (`header_text`), so mirror that exactly.
  const head = `| ${d.columns.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
  const sep = `| ${d.columns.map(() => "---").join(" | ")} |`;
  return bounded([head, sep, body].join("\n"));
}

export const EXPORT_EXT: Record<string, string> = {
  csv: "csv",
  tsv: "tsv",
  json: "json",
  sql: "sql",
  markdown: "md",
};

export function formatDataset(d: Dataset, fmt: string, table: string): string {
  switch (fmt) {
    case "tsv":
      return toTSV(d);
    case "json":
      return toJSON(d);
    case "sql":
      return toSQL(d, table);
    case "markdown":
      return toMarkdown(d);
    default:
      return toCSV(d);
  }
}

// ---------- options-driven formatting (clipboard export) ----------
// Mirrors src-tauri/src/export.rs byte-for-byte (delimiter / quote mode / null /
// header / column projection / line ending / boolean mapping). xlsx is never
// produced here.

import { type ExportOptions, defaultExportOptions, resolvedDelimiter, nullString } from "./export";
import { boolWord } from "./grid/bool";
import { sqlDialect as activeSqlDialect } from "./sql/ident";

const delimiterOf = (o: ExportOptions): string =>
  o.delimiter === "custom" ? Array.from(o.customDelimiter)[0] ?? "," : resolvedDelimiter(o);

function delimField(v: string | null, o: ExportOptions): string {
  if (v === null) return nullString(o);
  const q = Array.from(o.quoteChar)[0] || '"';
  const d = delimiterOf(o);
  const doubled = v.split(q).join(q + q);
  if (o.quote === "never") return v.split(d).join(" ").replace(/[\n\r]/g, " ");
  if (o.quote === "always") return `${q}${doubled}${q}`;
  if (v === "" || v.includes(d) || v.includes(q) || v.includes("\n") || v.includes("\r")) {
    return `${q}${doubled}${q}`;
  }
  return v;
}

const qIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

const hexText = (s: string): string =>
  Array.from(new TextEncoder().encode(s), (byte) => byte.toString(16).padStart(2, "0")).join("");

function sqlExportIdent(s: string, dialect: string): string {
  return dialect === "mysql" ? `\`${s.replace(/`/g, "``")}\`` : qIdent(s);
}

function sqlExportString(s: string, dialect: string): string {
  const control = Array.from(s).some((ch) => {
    const code = ch.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
  if (dialect === "postgres") {
    if (s.includes("\0")) throw new Error("PostgreSQL SQL output cannot represent a zero byte");
    if (s.includes("\\")) return `E'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  }
  if (dialect === "mysql" && (s.includes("\\") || control))
    return `CONVERT(X'${hexText(s)}' USING utf8mb4)`;
  if (dialect === "sqlite" && control) return `CAST(X'${hexText(s)}' AS TEXT)`;
  if (dialect === "duckdb" && control) return `decode(from_hex('${hexText(s)}'))`;
  return `'${s.replace(/'/g, "''")}'`;
}

export function formatWithOptions(d: Dataset, o: ExportOptions, sourceDialect = activeSqlDialect()): string {
  validateDataset(d);
  if (!["csv", "tsv", "json", "sql", "markdown", "xlsx"].includes(o.format))
    throw new Error("unsupported export format");
  if (o.format === "xlsx") throw new Error("xlsx formatting is file-only");
  if (!["postgres", "duckdb", "sqlite", "mysql"].includes(sourceDialect))
    throw new Error("unsupported SQL export dialect");
  if (
    !["comma", "tab", "semicolon", "pipe", "custom"].includes(o.delimiter) ||
    !["always", "asNeeded", "never"].includes(o.quote) ||
    !["empty", "literal", "custom"].includes(o.nullMode) ||
    !["lf", "crlf"].includes(o.lineEnding)
  ) throw new Error("invalid export formatting option");
  const quoteChars = Array.from(o.quoteChar);
  const delimiterChars = Array.from(o.customDelimiter);
  if (
    quoteChars.length !== 1 || /[\r\n]/.test(o.quoteChar) ||
    (o.delimiter === "custom" && (delimiterChars.length !== 1 || /[\r\n]/.test(o.customDelimiter)))
  ) throw new Error("export delimiter and quote character must each be one non-newline character");
  if (
    o.nullText.length > FORMAT_LIMITS.fieldChars || o.sql.table.length > 1_000 ||
    o.columnIndices.length > FORMAT_LIMITS.columns || (o.boolCols ?? []).length > FORMAT_LIMITS.columns
  ) throw new Error("export option exceeds its size limit");
  const idx = o.columnIndices.length
    ? o.columnIndices
    : d.columns.map((_, i) => i);
  if (idx.some((i) => !Number.isInteger(i) || i < 0 || i >= d.columns.length))
    throw new Error("export column selection contains an out-of-range index");
  if ((o.boolCols ?? []).some((i) => !Number.isInteger(i) || i < 0 || i >= d.columns.length))
    throw new Error("export boolean-column metadata contains an out-of-range index");
  const cols = idx.map((i) => d.columns[i]);
  const rows = d.rows.map((r) => idx.map((i) => r[i] ?? null));
  const nl = o.lineEnding === "crlf" ? "\r\n" : "\n";
  const table = o.sql.table || "exported";
  // Per projected column: is the SOURCE column a boolean? (boolCols holds source
  // indices, like columnIndices.) A bool cell whose token isn't recognized (or NULL)
  // falls through to the raw value — the mapping never invents data.
  const pbool = idx.map((i) => (o.boolCols ?? []).includes(i));
  const word = (k: number, v: string | null): string | null =>
    v !== null && pbool[k] ? boolWord(v) ?? v : v;
  const expansion = o.format === "json" || o.format === "sql" || o.format === "markdown" ? 6 : 2;
  const nullChars = o.format === "json" || o.format === "sql" ? 4 : o.format === "markdown" ? 0 : nullString(o).length;
  ensureFormatBudget({ columns: cols, rows }, expansion, nullChars);
  const emit = (text: string) => bounded(`${o.bom ? "\uFEFF" : ""}${text}`);

  switch (o.format) {
    case "json": {
      requireUniqueColumns(cols, "JSON");
      // Match Rust's streaming JSON layout exactly: one compact object per line.
      // Row separators are LF in TextEmit; the configured ending is used at close.
      const objects = rows.map((r) => {
        const fields = cols.map((c, k) => {
          const v = r[k];
          const w = v !== null && pbool[k] ? boolWord(v) : null;
          const rendered = w !== null ? (w === "TRUE" ? "true" : "false") : v === null ? "null" : JSON.stringify(v);
          return `${JSON.stringify(c)}: ${rendered}`;
        });
        return `{${fields.join(",")}}`;
      });
      return emit(`[${objects.length ? `\n  ${objects.join(",\n  ")}` : ""}${nl}]${nl}`);
    }
    case "markdown": {
      const mdHeader = (v: string) => v.replace(/\|/g, "\\|");
      const mdValue = (v: string | null) => v === null ? "" : v.replace(/\|/g, "\\|").replace(/\n/g, " ");
      const head = `| ${cols.map(mdHeader).join(" | ")} |`;
      const sep = `| ${cols.map(() => "---").join(" | ")} |`;
      const body = rows.map((r) => `| ${r.map((v, k) => mdValue(word(k, v))).join(" | ")} |`);
      return emit(`${[head, sep, ...body].join(nl)}${nl}`);
    }
    case "sql": {
      const dialect = sourceDialect;
      if (table.includes("\0")) throw new Error("SQL output table name contains a zero byte");
      const sqlIdent = (s: string) => sqlExportIdent(s, dialect);
      const colList = cols.map(sqlIdent).join(", ");
      // Recognized booleans emit as unquoted TRUE/FALSE literals (valid on PG /
      // DuckDB / MySQL / SQLite); anything else stays a quoted string.
      const tuple = (r: (string | null)[]) =>
        `(${r
          .map((v, k) => {
            if (v === null) return "NULL";
            const w = pbool[k] ? boolWord(v) : null;
            return w ?? sqlExportString(v, dialect);
          })
          .join(", ")})`;
      let out = "";
      if (o.sql.includeCreate) {
        out += `CREATE TABLE ${sqlIdent(table)} (${cols.map((c, k) => `${sqlIdent(c)} ${pbool[k] ? "boolean" : "text"}`).join(", ")});${nl}`;
      }
      if (o.sql.multiRow) {
        let chunk: string[] = [];
        let chunkBytes = 0;
        const flush = () => {
          if (!chunk.length) return;
          out += `INSERT INTO ${sqlIdent(table)} (${colList}) VALUES${nl}${chunk.join(`,${nl}`)};${nl}`;
          chunk = [];
          chunkBytes = 0;
        };
        for (const row of rows) {
          const value = tuple(row);
          const valueBytes = new TextEncoder().encode(value).byteLength;
          if (chunk.length && chunkBytes + valueBytes > 1024 * 1024) flush();
          chunk.push(value);
          chunkBytes += valueBytes;
          if (chunk.length >= 1000) flush();
        }
        flush();
      } else {
        for (const r of rows) out += `INSERT INTO ${sqlIdent(table)} (${colList}) VALUES ${tuple(r)};${nl}`;
      }
      return emit(out);
    }
    default: {
      const delim = delimiterOf(o);
      const lines: string[] = [];
      if (o.header) lines.push(cols.map((c) => delimField(c, o)).join(delim));
      for (const r of rows) lines.push(r.map((v, k) => delimField(word(k, v), o)).join(delim));
      return emit(lines.length ? `${lines.join(nl)}${nl}` : "");
    }
  }
}
