// Shared schema-index + alias-resolution helpers.
//
// Extracted from completion.ts so the autocomplete source and the schema-aware
// linter (src/editor/schemaLint.ts) resolve table/alias references through one
// implementation — they must never diverge.

import { lex } from "../editor/lexer";

export type Col = { name: string; data_type: string };
export type Table = { schema: string; name: string; columns: Col[] };

export type Index = {
  schemas: string[];
  tables: Table[];
  byQualified: Map<string, Table>;
  byBare: Map<string, Table[]>;
};

export const EMPTY_INDEX: Index = {
  schemas: [],
  tables: [],
  byQualified: new Map(),
  byBare: new Map(),
};

/** Decode one quoted or bare identifier. */
export function strip(id: string): string {
  const s = id.trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"')
    return s.slice(1, -1).replace(/""/g, '"');
  if (s.length >= 2 && s[0] === "`" && s[s.length - 1] === "`")
    return s.slice(1, -1).replace(/``/g, "`");
  return s;
}

export function buildIndex(tables: Table[]): Index {
  const byQualified = new Map<string, Table>();
  const byBare = new Map<string, Table[]>();
  const schemas = new Set<string>();
  for (const t of tables) {
    schemas.add(t.schema);
    byQualified.set(`${t.schema}.${t.name}`.toLowerCase(), t);
    const arr = byBare.get(t.name.toLowerCase()) ?? [];
    arr.push(t);
    byBare.set(t.name.toLowerCase(), arr);
  }
  return { schemas: [...schemas], tables, byQualified, byBare };
}

export function tableByRef(idx: Index, ref: string): Table | undefined {
  const parts = identifierParts(ref);
  if (!parts || parts.length > 2) return undefined;
  const matches = idx.tables.filter((table) => {
    const values = parts.length === 2 ? [table.schema, table.name] : [table.name];
    return parts.every((part, i) =>
      part.quoted === '"' ? values[i] === part.value : values[i].toLowerCase() === part.value.toLowerCase(),
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}

type IdentifierPart = { value: string; quoted: '"' | "`" | null };

/** Parse one- or two-part SQL identifier refs without losing quoted dots/case. */
export function identifierParts(ref: string): IdentifierPart[] | null {
  const parts: IdentifierPart[] = [];
  let i = 0;
  const ws = () => { while (/\s/.test(ref[i] ?? "")) i++; };
  ws();
  while (i < ref.length) {
    const quote = ref[i] === '"' || ref[i] === "`" ? ref[i] as '"' | "`" : null;
    let value = "";
    if (quote) {
      i++;
      let closed = false;
      while (i < ref.length) {
        if (ref[i] === quote) {
          if (ref[i + 1] === quote) { value += quote; i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        value += ref[i++];
      }
      if (!closed) return null;
    } else {
      const m = /^[A-Za-z_]\w*/.exec(ref.slice(i));
      if (!m) return null;
      value = m[0];
      i += m[0].length;
    }
    parts.push({ value, quoted: quote });
    ws();
    if (i === ref.length) return parts;
    if (ref[i] !== ".") return null;
    i++;
    ws();
    if (parts.length >= 2 || i === ref.length) return null;
  }
  return parts.length ? parts : null;
}

// An identifier part: a double/backtick-quoted name or a bare word. A table ref is
// `ident` or `ident.ident` (schema-qualified) — both parts independently quotable, so
// `public."customer"`, `"public"."customer"`, and MySQL backticks all work.
const IDENT = `(?:"(?:[^"]|"")+"|\`(?:[^\`]|\`\`)+\`|[A-Za-z_]\\w*)`;
// Keywords that can follow a table ref where an alias would otherwise be — must not be
// captured as the alias (e.g. `JOIN a ON …`, `FROM a WHERE …`).
const ALIAS_STOP = `(?:ON|USING|WHERE|GROUP|ORDER|HAVING|LIMIT|OFFSET|FETCH|FOR|WINDOW|QUALIFY|TABLESAMPLE|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|FULL|NATURAL|UNION|EXCEPT|INTERSECT|AND|OR|SET|RETURNING|VALUES)`;
const TABLE_REF = new RegExp(
  `\\b(?:FROM|JOIN|UPDATE|INTO)\\s+(${IDENT})(?:\\s*\\.\\s*(${IDENT}))?(?:\\s+(?:AS\\s+)?(?!${ALIAS_STOP}\\b)(${IDENT}))?`,
  "gi",
);

/** Map alias (and bare table name) -> table reference, from FROM/JOIN/UPDATE/INTO in the statement. */
export function aliasMap(stmt: string): Map<string, string> {
  const m = new Map<string, string>();
  let g: RegExpExecArray | null;
  TABLE_REF.lastIndex = 0;
  while ((g = TABLE_REF.exec(stmt))) {
    const schemaOrTable = strip(g[1]);
    const table = g[2] ? strip(g[2]) : schemaOrTable;
    // Keep source quoting in the ref so exact quoted identity survives resolution.
    const ref = g[2] ? `${g[1]}.${g[2]}` : g[1];
    const alias = g[3] ? strip(g[3]) : table;
    m.set(alias.toLowerCase(), ref);
    m.set(table.toLowerCase(), ref);
  }
  return m;
}

/** The statement (between semicolons) containing `pos`, and its start offset. */
export function currentStatement(doc: string, pos: number): { text: string; start: number } {
  const at = Math.max(0, Math.min(pos, doc.length));
  const stmts = lex(doc).stmts;
  for (const stmt of stmts) {
    if (at >= stmt.from && (at < stmt.to || (at === doc.length && stmt.to === doc.length))) {
      const end = stmt.to > stmt.from && doc[stmt.to - 1] === ";" ? stmt.to - 1 : stmt.to;
      return { text: doc.slice(stmt.from, end), start: stmt.from };
    }
  }
  const start = [...stmts].reverse().find((stmt) => stmt.to <= at)?.to ?? 0;
  return { text: doc.slice(start), start };
}

/**
 * A schema indexer memoized on the *identity* of the tables array — callers that
 * hold a stable array reference get the same `Index` back without rebuilding.
 */
export function makeIndexer(): (tables: Table[]) => Index {
  let cachedRef: Table[] | null = null;
  let cachedIdx: Index = EMPTY_INDEX;
  return (tables: Table[]) => {
    if (tables !== cachedRef) {
      cachedIdx = buildIndex(tables);
      cachedRef = tables;
    }
    return cachedIdx;
  };
}
