// Live editor analysis must stay bounded for generated SQL and dump files. Commands
// that explicitly need the full buffer (run/save) remain available above these caps.
export const LIVE_ANALYSIS_MAX_CHARS = 1_000_000;
export const FORMAT_MAX_CHARS = 1_000_000;
export const LINT_DIAGNOSTIC_LIMIT = 200;
export const LINT_STATEMENT_LIMIT = 2_000;
export const FOLD_CANDIDATE_LIMIT = 1_000;
export const ACTIVE_STATEMENT_LINE_LIMIT = 2_000;
export const SCHEMA_LINT_TABLE_LIMIT = 5_000;
export const SCHEMA_LINT_COLUMN_LIMIT = 50_000;
export const LINT_SUGGESTION_POOL_LIMIT = 10_000;
export const LINT_SUGGESTION_RUN_LIMIT = 50;
