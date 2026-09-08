// Backup / restore option shapes and pure helpers, shared by the two dialogs and
// App.tsx. Mirrors src-tauri/src/backup.rs (BackupOptions / RestoreOptions /
// BackupProgress / RestoreProgress / summaries).

export type BackupScope = "database" | "schemas" | "tables";
export type BackupContent = "all" | "schema" | "data";

export type QualifiedName = { schema: string; name: string };

export type BackupOptions = {
  scope: BackupScope;
  schemas: string[];
  tables: QualifiedName[];
  content: BackupContent;
  /** Emit `DROP … IF EXISTS` before each CREATE. */
  includeDrop: boolean;
  /** Wrap the dump in BEGIN/COMMIT (engines with transactional DDL only). */
  singleTransaction: boolean;
};

export type RestoreOptions = {
  stopOnError: boolean;
  singleTransaction: boolean;
};

export type BackupProgress = {
  phase: "schema" | "data" | "constraints" | "done";
  object: string;
  tablesDone: number;
  tablesTotal: number;
  rows: number;
  bytes: number;
};

export type BackupSummary = {
  path: string;
  tables: number;
  rows: number;
  bytes: number;
  objects: number;
  warnings: string[];
};

export type RestoreProgress = {
  statementsDone: number;
  statementsTotal: number | null;
  current: string;
  rowsCopied: number;
  bytesRead: number;
};

export type RestoreFailure = {
  statementIndex: number;
  line: number;
  message: string;
  preview: string;
};

export type RestoreSummary = {
  statementsOk: number;
  statementsFailed: number;
  rowsCopied: number;
  bytesRead: number;
  firstError: RestoreFailure | null;
  cancelled: boolean;
  committed: boolean;
};

export const BACKUP_CONTENTS: { value: BackupContent; label: string; hint: string }[] = [
  { value: "all", label: "Schema + data", hint: "Definitions and every row." },
  { value: "schema", label: "Schema only", hint: "Definitions, no rows." },
  { value: "data", label: "Data only", hint: "Rows for existing tables." },
];

/**
 * Engines whose DDL is transactional, so a dump can be wrapped in BEGIN/COMMIT and a
 * restore can run as one unit. MySQL commits DDL implicitly and is therefore excluded
 * — the backend enforces the same rule.
 */
export function supportsSingleTransaction(driverKind: string | undefined): boolean {
  return driverKind !== undefined && driverKind !== "mysql";
}

export function defaultBackupOptions(driverKind?: string): BackupOptions {
  return {
    scope: "database",
    schemas: [],
    tables: [],
    content: "all",
    includeDrop: false,
    singleTransaction: supportsSingleTransaction(driverKind),
  };
}

export function defaultRestoreOptions(): RestoreOptions {
  return { stopOnError: true, singleTransaction: false };
}

/** Command payload for `backup_to_file`. Selections not used by the scope are dropped. */
export function backupPayload(connectionId: string, path: string, o: BackupOptions) {
  return {
    connectionId,
    path,
    options: {
      scope: o.scope,
      schemas: o.scope === "schemas" ? [...o.schemas] : [],
      tables: o.scope === "tables" ? o.tables.map((t) => ({ schema: t.schema, name: t.name })) : [],
      content: o.content,
      includeDrop: o.includeDrop,
      singleTransaction: o.singleTransaction,
    } satisfies BackupOptions,
  };
}

/** Why the current selection can't be backed up yet, or "" when it can. */
export function backupBlocker(o: BackupOptions): string {
  if (o.scope === "schemas" && o.schemas.length === 0) return "Select at least one schema.";
  if (o.scope === "tables" && o.tables.length === 0) return "Select at least one table.";
  return "";
}

export type BackupHeader = {
  tuskVersion: string;
  engine: string;
  database: string;
  generated: string;
  scope: string;
  content: string;
};

/**
 * Parse the `-- key: value` preamble Tusk writes at the top of a dump. Returns null
 * for a file that isn't a Tusk dump (a hand-written or pg_dump script), which is not
 * an error — restore just can't pre-flight it.
 */
export function parseBackupHeader(text: string): BackupHeader | null {
  if (!text.startsWith("-- Tusk backup")) return null;
  const fields: Record<string, string> = {};
  for (const raw of text.split("\n").slice(1, 40)) {
    const line = raw.trim();
    if (!line.startsWith("--")) break;
    const body = line.slice(2).trim();
    const at = body.indexOf(":");
    if (at <= 0) continue;
    fields[body.slice(0, at).trim()] = body.slice(at + 1).trim();
  }
  return {
    tuskVersion: fields["tusk-version"] ?? "",
    engine: fields.engine ?? "",
    database: fields.database ?? "",
    generated: fields.generated ?? "",
    scope: fields.scope ?? "",
    content: fields.content ?? "",
  };
}

/**
 * Warning to show before restoring `header` onto a `driverKind` connection, or "".
 * A cross-engine dump usually fails part-way; saying so first beats a wall of errors.
 */
export function engineMismatch(header: BackupHeader | null, driverKind: string | undefined): string {
  if (!header || !header.engine || !driverKind || header.engine === driverKind) return "";
  return `This dump was taken from ${header.engine}; you are connected to ${driverKind}. Its SQL is unlikely to replay cleanly.`;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatCount(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString() : "—";
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes}m ${total % 60}s` : `${total}s`;
}

/** One-line status for the backup progress view. */
export function backupProgressLine(p: BackupProgress | null): string {
  if (!p) return "Starting…";
  if (p.phase === "done") return `Finished — ${formatCount(p.rows)} rows, ${formatBytes(p.bytes)}`;
  const where = p.object ? ` · ${p.object}` : "";
  const tables = p.tablesTotal ? ` (${p.tablesDone}/${p.tablesTotal} tables)` : "";
  const phase = p.phase === "constraints" ? "Foreign keys" : p.phase === "data" ? "Data" : "Schema";
  return `${phase}${where}${tables} · ${formatCount(p.rows)} rows · ${formatBytes(p.bytes)}`;
}

/** One-line status for the restore progress view. */
export function restoreProgressLine(p: RestoreProgress | null): string {
  if (!p) return "Starting…";
  const total = p.statementsTotal === null ? "" : ` / ${formatCount(p.statementsTotal)}`;
  const rows = p.rowsCopied ? ` · ${formatCount(p.rowsCopied)} rows copied` : "";
  const current = p.current ? ` · ${p.current}` : "";
  return `${formatCount(p.statementsDone)}${total} statements${rows} · ${formatBytes(p.bytesRead)} read${current}`;
}

/** Human summary of a finished restore, used for the result panel and history. */
export function restoreResultLine(s: RestoreSummary): string {
  const parts = [`${formatCount(s.statementsOk)} statements ran`];
  if (s.statementsFailed) parts.push(`${formatCount(s.statementsFailed)} failed`);
  if (s.rowsCopied) parts.push(`${formatCount(s.rowsCopied)} rows copied`);
  if (s.cancelled) parts.push("cancelled");
  else if (!s.committed && !s.statementsFailed) parts.push("nothing applied");
  else if (!s.committed) parts.push("rolled back");
  return parts.join(", ");
}
