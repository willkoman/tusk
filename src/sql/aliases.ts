// Shared schema-index + alias-resolution helpers.
//
// Extracted from completion.ts so the autocomplete source and the schema-aware
// linter (src/editor/schemaLint.ts) resolve table/alias references through one
// implementation — they must never diverge.

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

/** Strip surrounding/embedded double-quotes from an identifier and trim it. */
export function strip(id: string): string {
  return id.replace(/"/g, "").trim();
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
  const r = strip(ref).toLowerCase();
  if (r.includes(".")) return idx.byQualified.get(r);
  return idx.byBare.get(r)?.[0];
}

/** Map alias (and bare table name) -> table reference, from FROM/JOIN/UPDATE/INTO in the statement. */
export function aliasMap(stmt: string): Map<string, string> {
  const m = new Map<string, string>();
  const re = /\b(?:FROM|JOIN|UPDATE|INTO)\s+("?[\w.]+"?)(?:\s+(?:AS\s+)?("?[a-zA-Z_]\w*"?))?/gi;
  let g: RegExpExecArray | null;
  while ((g = re.exec(stmt))) {
    const table = strip(g[1]);
    const bare = table.split(".").pop()!;
    const alias = g[2] ? strip(g[2]) : bare;
    m.set(alias.toLowerCase(), table);
    m.set(bare.toLowerCase(), table);
  }
  return m;
}

/** The statement (between semicolons) containing `pos`, and its start offset. */
export function currentStatement(doc: string, pos: number): { text: string; start: number } {
  const start = doc.lastIndexOf(";", pos - 1) + 1;
  let end = doc.indexOf(";", pos);
  if (end < 0) end = doc.length;
  return { text: doc.slice(start, end), start };
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
