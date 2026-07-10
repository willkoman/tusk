// CSV / JSON / TSV / SQL / Markdown parsing + formatting for import / export.

export type Dataset = { columns: string[]; rows: (string | null)[][] };

// ---------- parsing (import) ----------

export function parseCSV(text: string, hasHeader: boolean): Dataset {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
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
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      pushField();
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    pushField();
    pushRow();
  }
  const data = rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
  if (data.length === 0) return { columns: [], rows: [] };
  const columns = hasHeader ? data[0] : data[0].map((_, k) => `col${k + 1}`);
  const body = hasHeader ? data.slice(1) : data;
  return {
    columns,
    rows: body.map((r) => columns.map((_, k) => (k < r.length ? r[k] : null))),
  };
}

export function parseJSON(text: string): Dataset {
  const parsed = JSON.parse(text);
  const arr: any[] = Array.isArray(parsed) ? parsed : [parsed];
  const columns: string[] = [];
  for (const o of arr) {
    if (o && typeof o === "object") {
      for (const k of Object.keys(o)) if (!columns.includes(k)) columns.push(k);
    }
  }
  const rows = arr.map((o) =>
    columns.map((c) => {
      const v = o?.[c];
      if (v === undefined || v === null) return null;
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    }),
  );
  return { columns, rows };
}

// ---------- formatting (export) ----------

function quoteCell(v: string | null, sep: string): string {
  if (v === null) return "";
  if (v.includes(sep) || v.includes('"') || v.includes("\n") || v.includes("\r")) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

export function toCSV(d: Dataset, header = true): string {
  const lines: string[] = [];
  if (header) lines.push(d.columns.map((c) => quoteCell(c, ",")).join(","));
  for (const r of d.rows) lines.push(r.map((v) => quoteCell(v, ",")).join(","));
  return lines.join("\n");
}

export function toTSV(d: Dataset, header = true): string {
  const esc = (v: string | null) => (v === null ? "" : v.replace(/[\t\n\r]/g, " "));
  const lines: string[] = [];
  if (header) lines.push(d.columns.join("\t"));
  for (const r of d.rows) lines.push(r.map(esc).join("\t"));
  return lines.join("\n");
}

export function toJSON(d: Dataset, header = true): string {
  // With headers → array of objects keyed by column name; without → array of value
  // arrays (the column names are exactly what the user is opting out of).
  const value = header
    ? d.rows.map((r) => Object.fromEntries(d.columns.map((c, k) => [c, r[k]])))
    : d.rows.map((r) => [...r]);
  return JSON.stringify(value, null, 2);
}

function sqlVal(v: string | null): string {
  return v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`;
}

export function toSQL(d: Dataset, table: string): string {
  const cols = d.columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
  return d.rows
    .map((r) => `INSERT INTO "${table}" (${cols}) VALUES (${r.map(sqlVal).join(", ")});`)
    .join("\n");
}

export function toMarkdown(d: Dataset, header = true): string {
  const esc = (v: string | null) => (v === null ? "" : v.replace(/\|/g, "\\|").replace(/\n/g, " "));
  const body = d.rows.map((r) => `| ${r.map(esc).join(" | ")} |`).join("\n");
  if (!header) return body;
  const head = `| ${d.columns.join(" | ")} |`;
  const sep = `| ${d.columns.map(() => "---").join(" | ")} |`;
  return [head, sep, body].join("\n");
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

import { type ExportOptions, resolvedDelimiter, nullString } from "./export";
import { boolWord } from "./grid/bool";

function delimField(v: string | null, o: ExportOptions): string {
  if (v === null) return nullString(o);
  const q = o.quoteChar.charAt(0) || '"';
  const d = resolvedDelimiter(o);
  const doubled = v.split(q).join(q + q);
  if (o.quote === "never") return v.split(d).join(" ").replace(/[\n\r]/g, " ");
  if (o.quote === "always") return `${q}${doubled}${q}`;
  if (v === "" || v.includes(d) || v.includes(q) || v.includes("\n") || v.includes("\r")) {
    return `${q}${doubled}${q}`;
  }
  return v;
}

const qIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

export function formatWithOptions(d: Dataset, o: ExportOptions): string {
  const idx = o.columnIndices.length
    ? o.columnIndices.filter((i) => i < d.columns.length)
    : d.columns.map((_, i) => i);
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

  switch (o.format) {
    case "json":
      return JSON.stringify(
        rows.map((r) =>
          Object.fromEntries(
            cols.map((c, k) => {
              const v = r[k];
              const w = v !== null && pbool[k] ? boolWord(v) : null;
              return [c, w !== null ? w === "TRUE" : v];
            }),
          ),
        ),
        null,
        2,
      );
    case "markdown": {
      const esc = (v: string | null) => (v === null ? "" : v.replace(/\|/g, "\\|").replace(/\n/g, " "));
      const head = `| ${cols.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
      const sep = `| ${cols.map(() => "---").join(" | ")} |`;
      return [head, sep, ...rows.map((r) => `| ${r.map((v, k) => esc(word(k, v))).join(" | ")} |`)].join(nl);
    }
    case "sql": {
      const colList = cols.map(qIdent).join(", ");
      // Recognized booleans emit as unquoted TRUE/FALSE literals (valid on PG /
      // DuckDB / MySQL / SQLite); anything else stays a quoted string.
      const tuple = (r: (string | null)[]) =>
        `(${r
          .map((v, k) => {
            if (v === null) return "NULL";
            const w = pbool[k] ? boolWord(v) : null;
            return w ?? `'${v.replace(/'/g, "''")}'`;
          })
          .join(", ")})`;
      const lines: string[] = [];
      if (o.sql.includeCreate) {
        lines.push(
          `CREATE TABLE ${qIdent(table)} (${cols.map((c, k) => `${qIdent(c)} ${pbool[k] ? "boolean" : "text"}`).join(", ")});`,
        );
      }
      if (o.sql.multiRow) {
        for (let i = 0; i < rows.length; i += 1000) {
          const chunk = rows.slice(i, i + 1000).map(tuple).join(`,${nl}`);
          lines.push(`INSERT INTO ${qIdent(table)} (${colList}) VALUES${nl}${chunk};`);
        }
      } else {
        for (const r of rows) lines.push(`INSERT INTO ${qIdent(table)} (${colList}) VALUES ${tuple(r)};`);
      }
      return lines.join(nl);
    }
    default: {
      const delim = resolvedDelimiter(o);
      const lines: string[] = [];
      if (o.header) lines.push(cols.map((c) => delimField(c, o)).join(delim));
      for (const r of rows) lines.push(r.map((v, k) => delimField(word(k, v), o)).join(delim));
      return lines.join(nl);
    }
  }
}
