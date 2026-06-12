import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { type DialectSpec } from "./dialects";
import {
  aliasMap,
  currentStatement,
  makeIndexer,
  tableByRef,
  type Col,
  type Table,
} from "./aliases";
import { joinConditions } from "./joinHints";
import { type FkEdge } from "./fk";

export type { Col, Table };

const TABLE_CTX = new Set(["FROM", "JOIN", "INTO", "UPDATE", "TABLE", "USING"]);
const COLUMN_CTX = new Set([
  "SELECT", "WHERE", "ON", "HAVING", "SET", "GROUP BY", "ORDER BY", "RETURNING", "AND", "OR",
  "VALUES", "BY",
]);
/** After these, the user is naming something callable — rank the live catalog top. */
const CALLABLE_CTX = new Set(["CALL", "EXECUTE", "EXEC", "PERFORM"]);

/**
 * Build a context-aware, dialect-specific completion source.
 * Reads the live table list via `getTables` (memoized on array identity).
 */
export function makeSqlCompletion(
  getTables: () => Table[],
  spec: DialectSpec,
  getActiveSchema: () => string | null = () => null,
  getFkEdges: () => FkEdge[] = () => [],
  getLiveFuncs: () => ReadonlySet<string> = () => new Set(),
) {
  const kwOptions: Completion[] = spec.keywords.map((label) => ({ label, type: "keyword", boost: -50 }));
  const stmtKwOptions: Completion[] = spec.statementKeywords.map((label) => ({ label, type: "keyword", boost: 50 }));
  const fnOptions: Completion[] = spec.functions.map((label) => ({ label, type: "function", boost: -30 }));
  const typeOptions: Completion[] = spec.types.map((label) => ({ label, type: "type", boost: -60 }));

  // Live database functions/procedures (the `list_functions` catalog), memoized
  // on set identity; dialect builtins filtered out so they don't double up.
  const builtinLc = new Set(spec.functions.map((f) => f.toLowerCase()));
  let lastFuncs: ReadonlySet<string> | null = null;
  let liveFnOptions: Completion[] = [];
  const liveOptions = (): Completion[] => {
    const s = getLiveFuncs();
    if (s !== lastFuncs) {
      lastFuncs = s;
      liveFnOptions = [...s]
        .filter((n) => !builtinLc.has(n.toLowerCase()))
        .sort()
        .map((label) => ({ label, type: "function", detail: "db function", boost: -20 }));
    }
    return liveFnOptions;
  };

  // Memoize the schema index on the tables array identity.
  const indexOf = makeIndexer();

  const VALID = /^\w*$/;

  return (ctx: CompletionContext): CompletionResult | null => {
    try {
      const word = ctx.matchBefore(/\w*/);
      const from = word ? word.from : ctx.pos;
      const doc = ctx.state.doc.toString();
      const before = doc.slice(Math.max(0, from - 240), from);
      const { text: stmt, start: stmtStart } = currentStatement(doc, ctx.pos);
      const idx = indexOf(getTables());
      const aliases = aliasMap(stmt);

      // 1) Qualified: `alias.` / `table.` / `schema.` / `schema.table.`
      const dot = /(\w+(?:\.\w+)*)\.\s*$/.exec(before);
      if (dot) {
        const qual = dot[1];
        const last = qual.split(".").pop()!.toLowerCase();
        const ref = aliases.get(last) ?? qual;
        const t = tableByRef(idx, ref) ?? tableByRef(idx, qual);
        if (t) {
          return {
            from,
            validFor: VALID,
            options: t.columns.map((c) => ({ label: c.name, type: "property", detail: c.data_type, boost: 90 })),
          };
        }
        if (idx.schemas.some((s) => s.toLowerCase() === last)) {
          return {
            from,
            validFor: VALID,
            options: idx.tables
              .filter((x) => x.schema.toLowerCase() === last)
              .map((x) => ({ label: x.name, type: "class", detail: x.schema, boost: 90 })),
          };
        }
        return null;
      }

      // Don't pop on an empty token unless explicitly invoked.
      if (!word?.text && !ctx.explicit) return null;

      // In-scope columns from tables referenced in this statement's FROM/JOIN.
      const scopeRefs = new Set([...aliases.values()].map((r) => r.toLowerCase()));
      const inScopeCols: Completion[] = [];
      for (const ref of scopeRefs) {
        const t = tableByRef(idx, ref);
        if (t) for (const c of t.columns) {
          inScopeCols.push({ label: c.name, type: "property", detail: `${c.data_type} · ${t.name}`, boost: 80 });
        }
      }

      // Tables in the active schema (and public) are offered bare and ranked higher,
      // matching the session search_path so unqualified names resolve at run time.
      const active = getActiveSchema();
      const tableOptions: Completion[] = idx.tables.map((t) => {
        const bare = t.schema === "public" || t.schema === active;
        return {
          label: bare ? t.name : `${t.schema}.${t.name}`,
          type: "class",
          detail: t.schema,
          boost: t.schema === active ? 55 : 40,
        } as Completion;
      });
      const schemaOptions: Completion[] = idx.schemas.map((s) => ({ label: s, type: "namespace", boost: 20 }));

      // 2) Clause context: last significant keyword before the cursor.
      const head = before.toUpperCase();
      const kwRe = /\b(SELECT|FROM|JOIN|WHERE|ON|USING|GROUP\s+BY|ORDER\s+BY|HAVING|SET|INTO|UPDATE|VALUES|RETURNING|AND|OR|TABLE|BY|CALL|EXECUTE|EXEC|PERFORM)\b/g;
      let lastKw: string | null = null;
      let mm: RegExpExecArray | null;
      while ((mm = kwRe.exec(head))) lastKw = mm[1].replace(/\s+/g, " ");

      const headTrim = doc.slice(stmtStart, from).trim();

      let options: Completion[];
      if (!headTrim) {
        options = stmtKwOptions; // statement start
      } else if (lastKw && CALLABLE_CTX.has(lastKw)) {
        // CALL / EXEC: the live procedure/function catalog tops the list.
        options = [
          ...liveOptions().map((o) => ({ ...o, detail: "procedure/function", boost: 90 })),
          ...fnOptions,
          ...schemaOptions,
        ];
      } else if (lastKw && TABLE_CTX.has(lastKw)) {
        options = [...tableOptions, ...schemaOptions];
      } else if (lastKw && COLUMN_CTX.has(lastKw)) {
        const cols = inScopeCols.length
          ? inScopeCols
          : idx.tables.flatMap((t) =>
              t.columns.map((c) => ({ label: c.name, type: "property", detail: `${c.data_type} · ${t.name}`, boost: 10 } as Completion)),
            );
        // FK-aware JOIN hints: right after ON, propose complete join conditions
        // (`o.user_id = u.id`) from the live FK catalog, ranked above columns.
        const fkHints: Completion[] =
          lastKw === "ON"
            ? joinConditions(doc.slice(stmtStart, ctx.pos), idx, getFkEdges()).map((cond) => ({
                label: cond,
                type: "text",
                detail: "foreign key",
                boost: 95,
              }))
            : [];
        options = [...fkHints, ...cols, ...fnOptions, ...liveOptions(), ...kwOptions];
      } else {
        options = [...inScopeCols, ...tableOptions, ...fnOptions, ...liveOptions(), ...kwOptions, ...typeOptions];
      }

      return { from, validFor: VALID, options };
    } catch {
      return null;
    }
  };
}
