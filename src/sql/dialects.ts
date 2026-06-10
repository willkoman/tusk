import { PostgreSQL, MySQL, SQLite, MSSQL, type SQLDialect } from "@codemirror/lang-sql";

export type DialectId = "postgres" | "mysql" | "sqlite" | "mssql";

export type DialectSpec = {
  id: DialectId;
  cm: SQLDialect;
  /** Statement + clause keywords (rendered uppercase in completions). */
  keywords: string[];
  /** Statement-leading keywords offered at the start of a statement. */
  statementKeywords: string[];
  /** Built-in functions. */
  functions: string[];
  /** Data types. */
  types: string[];
};

// Keywords common to (most) SQL dialects.
const SHARED_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET",
  "JOIN", "INNER JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL JOIN", "CROSS JOIN", "ON", "USING",
  "AS", "AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE", "BETWEEN", "EXISTS", "CASE", "WHEN",
  "THEN", "ELSE", "END", "DISTINCT", "ALL", "UNION", "EXCEPT", "INTERSECT", "ASC", "DESC",
  "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "ALTER", "DROP", "TABLE",
  "VIEW", "INDEX", "PRIMARY KEY", "FOREIGN KEY", "REFERENCES", "DEFAULT", "UNIQUE", "CHECK",
  "CONSTRAINT", "CASCADE", "WITH",
];

const STATEMENT_KEYWORDS = [
  "SELECT", "INSERT", "UPDATE", "DELETE", "WITH", "CREATE", "ALTER", "DROP",
  "TRUNCATE", "EXPLAIN", "BEGIN", "COMMIT", "ROLLBACK",
];

/**
 * Every word that can legally open a statement in any supported engine
 * (Postgres, MySQL, SQLite, MSSQL, DuckDB). Used by the heuristic linter to
 * flag a misspelled leading keyword (`SELCT …`). A union — not per-dialect —
 * because DuckDB shares the `postgres` DialectId and a strict list would
 * false-positive on its extensions; typos appear in no engine's list, so the
 * check still fires.
 */
export const STATEMENT_STARTERS: Set<string> = new Set([
  // queries / DML
  "SELECT", "INSERT", "UPDATE", "DELETE", "WITH", "VALUES", "TABLE", "MERGE", "REPLACE",
  // DDL / object management
  "CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "REVOKE", "COMMENT", "RENAME",
  // session / transaction
  "SET", "RESET", "SHOW", "BEGIN", "START", "COMMIT", "END", "ROLLBACK", "ABORT",
  "SAVEPOINT", "RELEASE", "USE",
  // utility
  "EXPLAIN", "COPY", "VACUUM", "ANALYZE", "ANALYSE", "DO", "CALL", "DECLARE", "FETCH",
  "MOVE", "CLOSE", "PREPARE", "EXECUTE", "DEALLOCATE", "LISTEN", "NOTIFY", "UNLISTEN",
  "LOCK", "UNLOCK", "REINDEX", "CLUSTER", "REFRESH", "CHECKPOINT", "DISCARD", "IMPORT",
  "SECURITY", "DESCRIBE", "DESC",
  // SQLite / DuckDB
  "PRAGMA", "ATTACH", "DETACH", "INSTALL", "LOAD", "EXPORT", "SUMMARIZE", "PIVOT",
  "UNPIVOT", "FROM", "FORCE",
]);

const POSTGRES_FUNCTIONS = [
  "abs", "age", "array_agg", "array_length", "array_to_string", "ascii", "avg", "bit_length",
  "btrim", "cardinality", "ceil", "char_length", "chr", "coalesce", "concat", "concat_ws",
  "count", "current_date", "current_schema", "current_setting", "current_timestamp",
  "current_user", "date_part", "date_trunc", "decode", "dense_rank", "encode", "every",
  "extract", "first_value", "floor", "format", "gen_random_uuid", "generate_series", "greatest",
  "initcap", "json_agg", "json_build_object", "jsonb_agg", "jsonb_array_elements",
  "jsonb_build_object", "jsonb_each", "jsonb_object_keys", "jsonb_set", "jsonb_strip_nulls",
  "lag", "last_value", "lead", "least", "left", "length", "ln", "log", "lower", "lpad", "ltrim",
  "make_date", "make_timestamp", "max", "md5", "min", "mod", "now", "nth_value", "ntile",
  "nullif", "octet_length", "overlay", "percentile_cont", "pg_typeof", "position", "power",
  "quote_ident", "quote_literal", "random", "rank", "regexp_matches", "regexp_replace",
  "regexp_split_to_table", "repeat", "replace", "reverse", "right", "round", "row_number",
  "row_to_json", "rpad", "rtrim", "sign", "split_part", "sqrt", "stddev", "string_agg",
  "string_to_array", "strpos", "substring", "sum", "to_char", "to_date", "to_json", "to_jsonb",
  "to_number", "to_timestamp", "translate", "trim", "trunc", "unnest", "upper", "variance",
  "version", "width_bucket",
];

const POSTGRES_TYPES = [
  "bigint", "bigserial", "bit", "boolean", "box", "bytea", "char", "character varying", "cidr",
  "circle", "date", "double precision", "float4", "float8", "inet", "int", "int2", "int4", "int8",
  "integer", "interval", "json", "jsonb", "line", "lseg", "macaddr", "money", "numeric", "decimal",
  "path", "point", "polygon", "real", "serial", "smallint", "smallserial", "text", "time",
  "timestamp", "timestamptz", "tsquery", "tsvector", "uuid", "varbit", "varchar", "xml",
];

// --- Stubs for future drivers (refine when each backend lands) ---
const MYSQL_FUNCTIONS = [
  "abs", "avg", "ceil", "char_length", "coalesce", "concat", "concat_ws", "count", "curdate",
  "current_date", "current_timestamp", "curtime", "date_add", "date_format", "date_sub",
  "datediff", "dayofweek", "floor", "found_rows", "greatest", "group_concat", "ifnull", "instr",
  "json_extract", "json_object", "last_insert_id", "least", "left", "length", "lower", "lpad",
  "ltrim", "max", "md5", "min", "mod", "now", "nullif", "rand", "replace", "right", "round",
  "rpad", "rtrim", "substring", "sum", "trim", "unix_timestamp", "upper", "uuid", "version",
];
const MYSQL_TYPES = [
  "bigint", "binary", "bit", "blob", "boolean", "char", "date", "datetime", "decimal", "double",
  "enum", "float", "int", "integer", "json", "longtext", "mediumtext", "set", "smallint", "text",
  "time", "timestamp", "tinyint", "varbinary", "varchar", "year",
];

const SQLITE_FUNCTIONS = [
  "abs", "avg", "changes", "char", "coalesce", "count", "date", "datetime", "glob", "group_concat",
  "hex", "ifnull", "instr", "json", "json_extract", "json_array", "json_object", "julianday",
  "last_insert_rowid", "length", "lower", "ltrim", "max", "min", "nullif", "printf", "quote",
  "random", "replace", "round", "rtrim", "strftime", "substr", "sum", "time", "total", "total_changes",
  "trim", "typeof", "unicode", "unixepoch", "upper", "zeroblob",
];
const SQLITE_TYPES = ["integer", "real", "text", "blob", "numeric", "boolean", "date", "datetime"];

const MSSQL_FUNCTIONS = [
  "abs", "avg", "cast", "ceiling", "charindex", "coalesce", "concat", "convert", "count",
  "current_timestamp", "dateadd", "datediff", "datepart", "day", "floor", "getdate", "getutcdate",
  "isnull", "left", "len", "lower", "ltrim", "max", "min", "month", "newid", "nullif", "patindex",
  "replace", "right", "round", "row_number", "rtrim", "stuff", "substring", "sum", "trim", "upper",
  "year",
];
const MSSQL_TYPES = [
  "bigint", "binary", "bit", "char", "date", "datetime", "datetime2", "decimal", "float", "int",
  "money", "nchar", "ntext", "numeric", "nvarchar", "real", "smallint", "text", "time", "tinyint",
  "uniqueidentifier", "varbinary", "varchar", "xml",
];

const DIALECTS: Record<DialectId, DialectSpec> = {
  postgres: {
    id: "postgres", cm: PostgreSQL, keywords: [...SHARED_KEYWORDS, "ILIKE", "RETURNING", "LATERAL", "OVER", "PARTITION BY"],
    statementKeywords: [...STATEMENT_KEYWORDS, "VACUUM", "ANALYZE", "COPY"],
    functions: POSTGRES_FUNCTIONS, types: POSTGRES_TYPES,
  },
  mysql: {
    id: "mysql", cm: MySQL, keywords: [...SHARED_KEYWORDS, "LIMIT", "REPLACE INTO", "STRAIGHT_JOIN"],
    statementKeywords: STATEMENT_KEYWORDS, functions: MYSQL_FUNCTIONS, types: MYSQL_TYPES,
  },
  sqlite: {
    id: "sqlite", cm: SQLite, keywords: [...SHARED_KEYWORDS, "PRAGMA", "VACUUM"],
    statementKeywords: [...STATEMENT_KEYWORDS, "PRAGMA", "VACUUM"], functions: SQLITE_FUNCTIONS, types: SQLITE_TYPES,
  },
  mssql: {
    id: "mssql", cm: MSSQL, keywords: [...SHARED_KEYWORDS, "TOP", "OUTPUT", "MERGE"],
    statementKeywords: [...STATEMENT_KEYWORDS, "MERGE"], functions: MSSQL_FUNCTIONS, types: MSSQL_TYPES,
  },
};

export function getDialect(id: DialectId): DialectSpec {
  return DIALECTS[id] ?? DIALECTS.postgres;
}

// Grammar words that legally appear as bare identifier-like tokens in SQL but are
// never columns — clause/frame/field/cast vocabulary across every engine. Used
// by the bare-identifier lint as a NOT-a-column allowlist; bias generous (a
// missing word here is a false positive, an extra word only a missed squiggle).
const GRAMMAR_WORDS = [
  "AS", "ON", "BY", "IF", "DO", "AT", "TO", "IS", "IN", "OF", "FOR", "FROM", "ONLY", "BOTH",
  "TRUE", "FALSE", "UNKNOWN", "NULLS", "FIRST", "LAST", "ASC", "DESC", "USING", "NATURAL",
  "LATERAL", "ORDINALITY", "TABLESAMPLE", "REPEATABLE", "RECURSIVE", "MATERIALIZED",
  "FILTER", "WITHIN", "OVER", "WINDOW", "PARTITION", "RANGE", "ROWS", "GROUPS", "PRECEDING",
  "FOLLOWING", "UNBOUNDED", "CURRENT", "ROW", "TIES", "EXCLUDE", "OTHERS", "FETCH", "NEXT",
  "ANY", "SOME", "ALL", "EXISTS", "COLLATE", "ZONE", "TIME", "LOCAL", "SESSION", "INTERVAL",
  "YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND", "EPOCH", "QUARTER", "WEEK", "DOW",
  "DOY", "ISODOW", "ISOYEAR", "CENTURY", "DECADE", "MILLENNIUM", "MICROSECONDS",
  "MILLISECONDS", "TIMEZONE", "TIMEZONE_HOUR", "TIMEZONE_MINUTE", "CAST", "EXTRACT",
  "SUBSTRING", "POSITION", "OVERLAY", "TRIM", "LEADING", "TRAILING", "SYMMETRIC",
  "ASYMMETRIC", "ESCAPE", "SIMILAR", "ILIKE", "ISNULL", "NOTNULL", "OVERLAPS", "BETWEEN",
  "DISTINCT", "CASE", "WHEN", "THEN", "ELSE", "END", "DEFAULT", "CONFLICT", "NOTHING",
  "RETURNING", "ARRAY", "GROUPING", "SETS", "CUBE", "ROLLUP", "VARIADIC", "ORDER", "GROUP",
  "HAVING", "WHERE", "LIMIT", "OFFSET", "UNION", "EXCEPT", "INTERSECT", "JOIN", "INNER",
  "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "AND", "OR", "NOT", "NULL", "LIKE", "SET",
  "VALUES", "INTO", "CONSTRAINT", "PRIMARY", "FOREIGN", "KEY", "REFERENCES", "UNIQUE",
  "CHECK", "INDEX", "CASCADE", "RESTRICT", "TEMP", "TEMPORARY", "UNLOGGED", "CONCURRENTLY",
  "DEFERRABLE", "INITIALLY", "DEFERRED", "IMMEDIATE", "ADD", "COLUMN", "TYPE", "OWNER",
  "RENAME", "GENERATED", "ALWAYS", "IDENTITY", "STORED", "BINARY", "SEPARATOR", "DIV", "MOD",
  "REGEXP", "RLIKE", "GLOB", "INDEXED", "STRICT", "WITHOUT", "ROWID", "AUTOINCREMENT",
  "AUTO_INCREMENT", "ENGINE", "CHARSET",
];

/**
 * Every word that can legitimately appear as a bare token in SQL without being
 * a column: keywords, types, statement starters, and grammar vocabulary —
 * union across ALL dialects (multi-word entries split). The bare-identifier
 * lint treats membership here as "not a column, not an error".
 */
export const ALL_SQL_WORDS: Set<string> = (() => {
  const out = new Set<string>(GRAMMAR_WORDS);
  for (const w of STATEMENT_STARTERS) out.add(w);
  for (const d of Object.values(DIALECTS)) {
    for (const list of [d.keywords, d.statementKeywords, d.types]) {
      for (const entry of list) for (const w of entry.toUpperCase().split(/\s+/)) out.add(w);
    }
  }
  return out;
})();

/** Union of every dialect's curated built-in function names (lowercase). */
export const ALL_SQL_FUNCTIONS: Set<string> = (() => {
  const out = new Set<string>();
  for (const d of Object.values(DIALECTS)) for (const f of d.functions) out.add(f.toLowerCase());
  return out;
})();

/** Map a connected-driver kind to the editor dialect. DuckDB is PostgreSQL-compatible
 *  SQL, so it reuses the Postgres dialect (highlighting / keywords / functions). */
export function driverDialect(kind?: string | null): DialectId {
  switch (kind) {
    case "mysql":
      return "mysql";
    case "sqlite":
      return "sqlite";
    case "mssql":
      return "mssql";
    default: // postgres, duckdb, unknown
      return "postgres";
  }
}
