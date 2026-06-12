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

const SCHEMA_BUDGET = 12000; // chars of full table(columns) lines before falling back to names
const NAME_LIST_BUDGET = 2500; // chars of the names-only tail for tables past the budget

const QUOTE_NOTE: Record<string, string> = {
  mysql: "Quote identifiers with backticks (`col`).",
  postgres: 'Quote identifiers with double quotes ("col").',
  duckdb: 'Quote identifiers with double quotes ("col").',
  sqlite: 'Quote identifiers with double quotes ("col").',
};

function schemaSummary(tables: AiCtxTable[], focus: string): string {
  // Relevance first: tables whose name appears in the conversation (or shares a
  // word with it) get their full column lists ahead of the budget cutoff, so
  // asking about `product_vendor_link` pulls it in even on a 500-table schema.
  const f = focus.toLowerCase();
  const fWords = new Set(f.split(/[^a-z0-9_]+/).filter((w) => w.length > 2));
  const score = (t: AiCtxTable): number => {
    const n = t.name.toLowerCase();
    if (f.includes(n)) return 0;
    if (n.split("_").some((tok) => fWords.has(tok))) return 1;
    return 2;
  };
  const ranked = tables.map((t, i) => ({ t, i, s: score(t) })).sort((a, b) => a.s - b.s || a.i - b.i);

  let out = "";
  const rest: string[] = [];
  for (const { t } of ranked) {
    const cols = t.columns.map((c) => `${c.name} ${c.data_type}`).join(", ");
    const line = `${t.schema}.${t.name}(${cols})\n`;
    if (out.length + line.length > SCHEMA_BUDGET) rest.push(`${t.schema}.${t.name}`);
    else out += line;
  }
  if (rest.length) {
    // Never silently drop a table: the remainder is listed by NAME so the
    // model knows it exists and can ask for its columns.
    let names = "";
    let listed = 0;
    for (const n of rest) {
      if (names.length + n.length + 2 > NAME_LIST_BUDGET) break;
      names += (names ? ", " : "") + n;
      listed++;
    }
    out += `\nOther tables (columns available on request — ask the user to mention the table):\n${names}`;
    if (listed < rest.length) out += `, … and ${rest.length - listed} more`;
    out += "\n";
  }
  return out || "(no user tables)";
}

export function buildSystemPrompt(c: AiContext, conversationText = ""): string {
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
    schemaSummary(c.tables, `${conversationText} ${c.currentSql} ${c.selection}`),
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
