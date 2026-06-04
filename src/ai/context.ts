// Assemble the system prompt: what the AI needs to be useful + safe — the connected
// database's dialect, a token-budgeted schema summary, the user's privileges, and the
// app's own capabilities. Kept compact; specific tables can be expanded on request later.

export type AiCtxTable = { schema: string; name: string; columns: { name: string; data_type: string }[] };

export type AiContext = {
  dialect: string; // "postgres" | "mysql" | "sqlite" | "duckdb"
  driverLabel: string;
  version: string;
  user: string;
  isSuperuser: boolean;
  permissionsEnforced: boolean;
  activeSchema: string | null;
  tables: AiCtxTable[];
  currentSql: string;
  selection: string;
  lastError: string;
};

const SCHEMA_BUDGET = 8000; // chars of schema dump before truncation

const QUOTE_NOTE: Record<string, string> = {
  mysql: "Quote identifiers with backticks (`col`).",
  postgres: 'Quote identifiers with double quotes ("col").',
  duckdb: 'Quote identifiers with double quotes ("col").',
  sqlite: 'Quote identifiers with double quotes ("col").',
};

function schemaSummary(tables: AiCtxTable[]): string {
  let out = "";
  let shown = 0;
  for (const t of tables) {
    const cols = t.columns.map((c) => `${c.name} ${c.data_type}`).join(", ");
    const line = `${t.schema}.${t.name}(${cols})\n`;
    if (out.length + line.length > SCHEMA_BUDGET) break;
    out += line;
    shown++;
  }
  if (shown < tables.length) out += `… and ${tables.length - shown} more tables (ask to see a specific one).\n`;
  return out || "(no user tables)";
}

export function buildSystemPrompt(c: AiContext): string {
  const quote = QUOTE_NOTE[c.dialect] ?? QUOTE_NOTE.postgres;
  const lines: string[] = [
    "You are an AI assistant embedded in Tusk, a desktop SQL client. Help the user write, understand, fix, and optimize SQL.",
    "",
    `Connected database: ${c.driverLabel} ${c.version}. SQL dialect: ${c.dialect}. ${quote}`,
    `Current role: ${c.user || "(unknown)"}${c.isSuperuser ? " (superuser)" : ""}.${c.activeSchema ? ` Active schema (search_path): ${c.activeSchema}.` : ""}`,
  ];
  if (c.permissionsEnforced && !c.isSuperuser) {
    lines.push("This role has limited privileges — prefer reads, and warn before suggesting writes/DDL it may not be allowed to run.");
  }
  lines.push(
    "",
    "How the app works (your capabilities):",
    "- Put runnable SQL in fenced ```sql code blocks. The user can open any block in a new editor tab and run it — you never execute anything yourself.",
    "- For destructive statements (DROP/DELETE/UPDATE/TRUNCATE/ALTER), call it out clearly and prefer a WHERE clause / a SELECT preview first.",
    "- Generate SQL in the dialect above and quote identifiers as noted. Be concise.",
    "",
    "Database schema (schema.table(columns)):",
    schemaSummary(c.tables),
  );
  if (c.currentSql.trim()) {
    const sql = c.selection.trim() || c.currentSql;
    lines.push("", "The user's current editor SQL:", "```sql", sql.slice(0, 4000), "```");
  }
  if (c.lastError.trim()) {
    lines.push("", `The last query error was: ${c.lastError.slice(0, 800)}`);
  }
  return lines.join("\n");
}

/** Extract fenced ```sql blocks (or any fenced block) from an assistant message. */
export function extractSqlBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```(?:sql)?\s*\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trim();
    if (body) out.push(body);
  }
  return out;
}
