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
