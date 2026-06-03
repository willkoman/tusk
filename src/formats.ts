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

export function toCSV(d: Dataset): string {
  const lines = [d.columns.map((c) => quoteCell(c, ",")).join(",")];
  for (const r of d.rows) lines.push(r.map((v) => quoteCell(v, ",")).join(","));
  return lines.join("\n");
}

export function toTSV(d: Dataset): string {
  const esc = (v: string | null) => (v === null ? "" : v.replace(/[\t\n\r]/g, " "));
  const lines = [d.columns.join("\t")];
  for (const r of d.rows) lines.push(r.map(esc).join("\t"));
  return lines.join("\n");
}

export function toJSON(d: Dataset): string {
  return JSON.stringify(
    d.rows.map((r) => Object.fromEntries(d.columns.map((c, k) => [c, r[k]]))),
    null,
    2,
  );
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

export function toMarkdown(d: Dataset): string {
  const esc = (v: string | null) => (v === null ? "" : v.replace(/\|/g, "\\|").replace(/\n/g, " "));
  const head = `| ${d.columns.join(" | ")} |`;
  const sep = `| ${d.columns.map(() => "---").join(" | ")} |`;
  const body = d.rows.map((r) => `| ${r.map(esc).join(" | ")} |`).join("\n");
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
