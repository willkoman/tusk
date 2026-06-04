import { type Diagnostic } from "@codemirror/lint";
import { type EditorView } from "@codemirror/view";
import { aliasMap, makeIndexer, strip, tableByRef, type Table } from "../sql/aliases";
import { lexState, maskNonCode } from "./lexer";
import { closest } from "./distance";

// Schema-aware identifier check. Flags table/column references that don't exist in
// the live schema and suggests the closest real name. Alias-scoped via the same
// aliasMap the autocomplete uses (src/sql/aliases.ts) so `u.naem FROM customer u`
// resolves `u` → customer before checking the column.
//
// Conservative by design — diagnostics are warnings, never errors, and we only flag
// two high-signal positions (qualified `alias.col` and table refs after
// FROM/JOIN/UPDATE/INTO). Bare columns are intentionally left to the server linter,
// which has a real parser and won't false-positive on CTE columns, lateral refs, etc.

// An identifier part: double-quoted (any chars) or a bare word; a table ref is one or two
// (schema-qualified), each part independently quotable — so `public."customer"` parses.
const IDENT = `(?:"[^"]+"|[A-Za-z_]\\w*)`;
// Unquoted `alias.col` only — quoted columns are left to the server linter (avoids
// false-positives on CTE-derived / computed columns).
const QUALIFIED = /\b([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)\b/g;
const TABLE_POS = new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO)\\s+(${IDENT}(?:\\.${IDENT})?)`, "gi");
// CTE name (quoted or bare) before `AS (` — must register so its references aren't flagged.
const CTE_DEF = new RegExp(`(${IDENT})\\s+AS\\s*\\(`, "gi");

function replaceAction(from: number, to: number, text: string) {
  return [
    {
      name: `Replace with "${text}"`,
      apply: (view: EditorView) => view.dispatch({ changes: { from, to, insert: text } }),
    },
  ];
}

/** Build the schema-aware diagnostic source. Reads the live table list via getSchema. */
export function schemaLintSource(getSchema: () => Table[]) {
  const indexOf = makeIndexer();
  return (view: EditorView): Diagnostic[] => {
    const tables = getSchema();
    if (!tables.length) return []; // schema not loaded yet — don't guess
    const idx = indexOf(tables);
    const { spans, stmts } = lexState(view.state);
    const doc = view.state.doc.toString();
    const diags: Diagnostic[] = [];

    for (const stmt of stmts) {
      const masked = maskNonCode(doc, spans, stmt.from, stmt.to, true); // keep "quoted" identifiers
      const base = stmt.from;
      const aliases = aliasMap(masked);

      const cte = new Set<string>();
      for (const m of masked.matchAll(CTE_DEF)) cte.add(strip(m[1]).toLowerCase());

      // (1) Qualified column references: alias.col / table.col.
      for (const m of masked.matchAll(QUALIFIED)) {
        const alias = m[1];
        const col = m[2];
        const ref = aliases.get(alias.toLowerCase()) ?? alias;
        const t = tableByRef(idx, ref);
        // Unknown alias → could be a schema.table prefix or a CTE col; skip (no noise).
        if (!t || cte.has(alias.toLowerCase())) continue;
        if (t.columns.some((c) => c.name.toLowerCase() === col.toLowerCase())) continue;
        const colStart = base + m.index! + alias.length + 1;
        const sugg = closest(col, t.columns.map((c) => c.name));
        diags.push({
          from: colStart,
          to: colStart + col.length,
          severity: "warning",
          message: `no column "${col}" on ${t.name}${sugg ? ` — did you mean "${sugg}"?` : ""}`,
          actions: sugg ? replaceAction(colStart, colStart + col.length, sugg) : undefined,
        });
      }

      // (2) Table references after FROM / JOIN / UPDATE / INTO.
      for (const m of masked.matchAll(TABLE_POS)) {
        const raw = m[1];
        const name = strip(raw);
        if (tableByRef(idx, name)) continue;
        const parts = name.split(".");
        const bare = parts[parts.length - 1].toLowerCase();
        if (cte.has(bare)) continue;
        // Table function, e.g. FROM generate_series(...) — next token is "(" → skip.
        let after = m.index! + m[0].length;
        while (after < masked.length && /\s/.test(masked[after])) after++;
        if (after < masked.length && masked[after] === "(") continue;
        // Qualified by a schema we don't have introspected (system / other catalog) →
        // can't verify, so don't guess.
        if (parts.length > 1 && !idx.schemas.some((s) => s.toLowerCase() === parts[parts.length - 2].toLowerCase())) {
          continue;
        }
        const tokStart = base + m.index! + (m[0].length - raw.length);
        const sugg = closest(bare, idx.tables.map((t) => t.name));
        diags.push({
          from: tokStart,
          to: tokStart + raw.length,
          severity: "warning",
          message: `unknown table "${name}"${sugg ? ` — did you mean "${sugg}"?` : ""}`,
          actions: sugg ? replaceAction(tokStart, tokStart + raw.length, sugg) : undefined,
        });
      }
    }
    return diags;
  };
}
