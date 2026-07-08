// Assemble the system prompt: what the AI needs to be useful + safe — the connected
// database's dialect, a token-budgeted schema summary, the user's privileges, and the
// app's own capabilities. Kept compact; specific tables can be expanded on request later.

import type { FkEdge } from "../sql/fk";

export type AiCtxTable = { schema: string; name: string; columns: { name: string; data_type: string }[] };

/** Sample rows pulled from a relation, for grounding the model in real values. */
export type SampleTable = { schema: string; name: string; columns: string[]; rows: (string | null)[][] };

export type AiContext = {
  dialect: string; // "postgres" | "mysql" | "sqlite" | "duckdb"
  driverLabel: string;
  version: string;
  user: string;
  isSuperuser: boolean;
  permissionsEnforced: boolean;
  activeSchema: string | null;
  tables: AiCtxTable[];
  /** The schema's foreign keys. Tusk knows the join graph; without this the model
   *  guesses join columns from naming conventions and gets them wrong on any schema
   *  that doesn't follow `<table>_id`. Same edges the autocomplete JOIN hints use. */
  fks: FkEdge[];
  /** Whether the FK graph was actually retrieved. An empty `fks` is ambiguous — "none
   *  declared" vs "not fetched / driver can't report them" — and telling the model
   *  "this schema has no foreign keys" when we simply didn't look is worse than silence. */
  fksKnown: boolean;
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

/**
 * Score a table's relevance to the focus text: 0 = its name appears verbatim,
 * 1 = it shares a word with the focus, 2 = unrelated. Used to surface the right
 * tables (full columns + sample rows) ahead of any budget cutoff.
 */
function relevanceScore(t: AiCtxTable, focus: string): number {
  const f = focus.toLowerCase();
  const fWords = new Set(f.split(/[^a-z0-9_]+/).filter((w) => w.length > 2));
  const n = t.name.toLowerCase();
  if (f.includes(n)) return 0;
  if (n.split("_").some((tok) => fWords.has(tok))) return 1;
  return 2;
}

/** Tables actually relevant to the focus (score ≤ 1), most-relevant first, capped. */
export function relevantTables(tables: AiCtxTable[], focus: string, limit: number): AiCtxTable[] {
  return tables
    .map((t, i) => ({ t, i, s: relevanceScore(t, focus) }))
    .filter((x) => x.s <= 1)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.t);
}

const SAMPLE_BUDGET = 4000; // chars of sample-row text in the prompt
const CELL_CAP = 80; // max chars per sampled cell

/** Render fetched sample rows as a compact, budgeted block of pipe-separated tables. */
export function formatSamples(samples: SampleTable[]): string {
  const cell = (v: string | null) => {
    if (v === null) return "NULL";
    const s = v.replace(/\s+/g, " ");
    return s.length > CELL_CAP ? s.slice(0, CELL_CAP - 1) + "…" : s;
  };
  let out = "";
  for (const s of samples) {
    if (!s.columns.length || !s.rows.length) continue;
    let block = `\n${s.schema}.${s.name} (${s.rows.length} sample row${s.rows.length === 1 ? "" : "s"}):\n`;
    block += s.columns.join(" | ") + "\n";
    for (const r of s.rows) block += s.columns.map((_, k) => cell(r[k] ?? null)).join(" | ") + "\n";
    if (out.length + block.length > SAMPLE_BUDGET) break;
    out += block;
  }
  return out;
}

const FK_BUDGET = 3000; // chars of foreign-key lines

/** One FK as `orders.user_id -> users.id`, or `a.(x, y) -> b.(p, q)` when composite.
 *  Schema-qualified only when the two sides differ or it isn't `public`. */
function fkLine(e: FkEdge): string {
  const rel = (schema: string, table: string) => (schema && schema !== "public" ? `${schema}.${table}` : table);
  const cols = (c: string[]) => (c.length === 1 ? c[0] : `(${c.join(", ")})`);
  return `${rel(e.srcSchema, e.srcTable)}.${cols(e.srcCols)} -> ${rel(e.dstSchema, e.dstTable)}.${cols(e.dstCols)}`;
}

/** FK edges, most relevant to the focus first, budgeted. An edge is relevant when either
 *  side is a table the conversation is about — so the join path for the asked-about
 *  tables survives the cutoff on a large schema. */
export function foreignKeySummary(fks: FkEdge[], focus: string): string {
  if (!fks.length) return "";
  const f = focus.toLowerCase();
  const touches = (t: string) => f.includes(t.toLowerCase());
  const ranked = fks
    .map((e, i) => ({ e, i, s: touches(e.srcTable) || touches(e.dstTable) ? 0 : 1 }))
    .sort((a, b) => a.s - b.s || a.i - b.i);

  let out = "";
  let dropped = 0;
  for (const { e } of ranked) {
    const line = fkLine(e) + "\n";
    if (out.length + line.length > FK_BUDGET) dropped++;
    else out += line;
  }
  if (dropped) out += `… and ${dropped} more foreign keys\n`;
  return out;
}

function schemaSummary(tables: AiCtxTable[], focus: string): string {
  // Relevance first: tables whose name appears in the conversation (or shares a
  // word with it) get their full column lists ahead of the budget cutoff, so
  // asking about `product_vendor_link` pulls it in even on a 500-table schema.
  const score = (t: AiCtxTable): number => relevanceScore(t, focus);
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

export function buildSystemPrompt(c: AiContext, conversationText = "", samples: SampleTable[] = []): string {
  const quote = QUOTE_NOTE[c.dialect] ?? QUOTE_NOTE.postgres;
  const focus = `${conversationText} ${c.currentSql} ${c.selection}`;
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
    schemaSummary(c.tables, focus),
  );
  // The join graph. Emitted right after the schema so the model reads structure and
  // relationships together, before any sample data.
  const fkText = foreignKeySummary(c.fks, focus);
  if (fkText.trim()) {
    lines.push(
      "",
      "Foreign keys (src -> dst). JOIN on these rather than guessing column names — this list is authoritative for the tables shown above:",
      fkText.trimEnd(),
    );
  } else if (c.fksKnown && c.tables.length) {
    // Only assert this when we actually looked. Otherwise stay silent — claiming
    // "no foreign keys" on an unfetched graph invites confidently wrong joins.
    lines.push("", "This schema declares no foreign keys. Infer joins from column names, and say so when you do.");
  }
  const sampleText = formatSamples(samples);
  if (sampleText.trim()) {
    lines.push(
      "",
      "Sample rows from the most relevant tables (real data, so you understand value shapes/formats — never assume these are the only rows, and don't treat them as exhaustive):",
      sampleText.trimEnd(),
    );
  }
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
