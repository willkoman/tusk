//! Engine-aware statement classification: the one place that answers "may this
//! statement run on a read-only connection", "can it stream through a cursor", and
//! "can it be wrapped as a derived table".
//!
//! Every engine reads SQL with its own lexical rules (SQL Server nests block comments
//! and quotes identifiers with `[brackets]`, MySQL adds `#` comments and executable
//! `/*! */` bodies, PostgreSQL has dollar quoting), so every verdict here takes the
//! `TransactionEngine`. Classifying by the wrong engine's rules reads a different
//! statement than the server executes: that is how `/*/* */ SHOW 1 */ DROP TABLE t`
//! once passed the read-only gate on SQL Server, the one engine with no server-side
//! read-only enforcement.
//!
//! The command layer (`run_query`, export), the driver (`run_single`, `run_script`,
//! `run_manual_single`) and the Slack gate all call in here; nothing here calls out to
//! any of them. A false positive (a bare column literally named `delete`) fails closed.

use crate::script::{self, TransactionAction, TransactionEngine};

/// Mutation keywords that must never appear ANYWHERE in a read-only statement, not
/// just at the start. Catches writable CTEs (`WITH x AS (DELETE …) SELECT`), smuggled
/// DDL, and `FOR UPDATE` row locks. Scanned over MASKED sql (strings, comments,
/// dollar-quotes, quoted identifiers blanked), word-boundary matched.
const MUTATION_WORDS: [&str; 15] = [
    "insert", "update", "delete", "merge", "replace", "drop", "alter", "truncate", "create",
    "grant", "revoke", "outfile", "dumpfile", "into", "lock",
];

/// Blank out string literals, quoted identifiers, comments, and dollar-quoted bodies
/// so keyword scanning can't be fooled by values like 'DROP TABLE…'. Engine-aware: SQL
/// Server nests block comments and quotes identifiers with `[brackets]`, MySQL adds
/// `#` comments — masking any of those with the wrong rules either hides real code
/// from the scan or invents keywords that are only a column name. MySQL executable
/// comments keep a `/*!` marker because the server runs their bodies.
pub(crate) fn mask_sql(sql: &str, engine: TransactionEngine) -> String {
    let mssql = engine == TransactionEngine::MsSql;
    let b = sql.as_bytes();
    let n = b.len();
    let mut out = vec![b' '; n];
    let mut i = 0usize;
    while i < n {
        let c = b[i];
        // line comment
        if c == b'-' && i + 1 < n && b[i + 1] == b'-' {
            while i < n && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // MySQL `#` comment to end of line
        if c == b'#' && engine == TransactionEngine::MySql {
            while i < n && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // block comment (T-SQL nests them; the other engines do not)
        if c == b'/' && i + 1 < n && b[i + 1] == b'*' {
            let executable = i + 2 < n && b[i + 2] == b'!'
                || i + 3 < n && b[i + 2].eq_ignore_ascii_case(&b'm') && b[i + 3] == b'!';
            if executable {
                // Preserve a marker. MySQL/MariaDB execute these comment bodies, so
                // treating them like ordinary comments would hide mutations.
                out[i] = b'/';
                out[i + 1] = b'*';
                out[i + 2] = b'!';
            }
            let mut depth = 1usize;
            i += 2;
            while i + 1 < n {
                if b[i] == b'*' && b[i + 1] == b'/' {
                    i += 2;
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    continue;
                }
                if mssql && b[i] == b'/' && b[i + 1] == b'*' {
                    i += 2;
                    depth += 1;
                    continue;
                }
                i += 1;
            }
            if depth > 0 {
                i = n;
            }
            continue;
        }
        // SQL Server `[bracket]` identifier (`]]` escapes `]`). Like the other quoted
        // identifier forms it becomes opaque `q` markers: `SELECT [insert] FROM [Update]`
        // is a plain read, and a `'` inside a bracket must not open a phantom string.
        if mssql && c == b'[' {
            out[i] = b'q';
            i += 1;
            while i < n {
                if b[i] == b']' {
                    if i + 1 < n && b[i + 1] == b']' {
                        i += 2;
                        continue;
                    }
                    out[i] = b'q';
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        // quoted string / identifier (with doubled-quote escapes)
        if c == b'\'' || c == b'"' || (c == b'`' && !mssql) {
            let q = c;
            if q != b'\'' {
                // Quoted function names are rejected by the function policy. Keep
                // an opaque identifier token without exposing its keyword content.
                out[i] = b'q';
            }
            i += 1;
            while i < n {
                if b[i] == q {
                    if i + 1 < n && b[i + 1] == q {
                        i += 2;
                        continue;
                    }
                    if q != b'\'' {
                        out[i] = b'q';
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        // dollar-quoted body ($tag$ … $tag$; $1 is a param, not a tag). T-SQL has no
        // dollar quoting — treating a `$…$` region as opaque there would hide real code.
        if c == b'$' && !mssql {
            if let Some(close) = script::dollar_tag_end(b, i) {
                let tag = &b[i..=close];
                let mut j = close + 1;
                while j + tag.len() <= n && &b[j..j + tag.len()] != tag {
                    j += 1;
                }
                i = (j + tag.len()).min(n);
                continue;
            }
        }
        out[i] = c.to_ascii_lowercase();
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

/// The first mutation keyword found anywhere in the (masked) statement, if any, using
/// the engine's lexical rules. (`FOR UPDATE` row locks are caught by "update";
/// `FOR SHARE` is checked separately.) `allow_show_create` exempts the `CREATE` of
/// MySQL's `SHOW CREATE …` — a read whose own syntax carries a mutation keyword — and
/// nothing else: a second mutation word still fails.
pub(crate) fn find_mutation_word_for(
    sql: &str,
    engine: TransactionEngine,
    allow_show_create: bool,
) -> Option<&'static str> {
    let masked = mask_sql(sql, engine);
    let mut previous = "";
    let mut index = 0usize;
    for token in masked.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
        if token.is_empty() {
            continue;
        }
        let exempt = allow_show_create && index == 1 && previous == "show" && token == "create";
        if !exempt {
            if let Some(w) = MUTATION_WORDS.iter().find(|w| **w == token) {
                return Some(w);
            }
            if previous == "for" && token == "share" {
                return Some("share");
            }
        }
        previous = token;
        index += 1;
    }
    None
}

/// The statement's leading keyword, lowercased, with the engine's leading comments
/// skipped (`explain(analyze)` → `explain`).
pub(crate) fn first_sql_word(sql: &str, engine: TransactionEngine) -> String {
    script::effective_start_for(sql, engine)
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Statements allowed on a read-only connection. Engine-aware: SQL Server nests block
/// comments and quotes identifiers with brackets, so classifying its SQL by
/// PostgreSQL's lexical rules reads a different statement than the server executes.
pub(crate) fn is_read_only_stmt(sql: &str, engine: TransactionEngine) -> bool {
    let first = first_sql_word(sql, engine);
    let allowed = matches!(
        first.as_str(),
        "select" | "with" | "show" | "explain" | "table" | "values" | "from" | "pivot"
    );
    if !allowed
        || script::contains_code_word_for(sql, "set_config", engine)
        || (first == "explain"
            && (script::contains_code_word_for(sql, "analyze", engine)
                || script::contains_code_word_for(sql, "analyse", engine)))
    {
        return false;
    }
    // The mutation scan ALWAYS runs. It used to be skipped entirely for a leading
    // `SHOW`, which let `/*/* */ SHOW 1 */ DROP TABLE t` through on SQL Server (its
    // nested comments hide the SHOW from the server, and it is the one engine with no
    // server-side read-only enforcement). Only MySQL's `SHOW CREATE …` — a read whose
    // own syntax carries a mutation keyword — is exempt, and only for that one word.
    let allow_show_create = engine == TransactionEngine::MySql && first == "show";
    // MySQL/MariaDB execute `/*! … */` bodies. The masker keeps only a marker for them
    // (their content is not scanned as code), so the marker itself is the verdict: a
    // read that hides anything in an executable comment is not a read. `run_script`
    // and the Slack gate refused these already; the single-statement path did not.
    if engine == TransactionEngine::MySql && mask_sql(sql, engine).contains("/*!") {
        return false;
    }
    find_mutation_word_for(sql, engine, allow_show_create).is_none()
}

/// A transaction opener or `SET TRANSACTION` that asks for write access; refused on
/// a read-only connection even though the statement itself writes nothing.
pub(crate) fn transaction_requests_write(sql: &str, action: Option<TransactionAction>) -> bool {
    matches!(
        action,
        Some(TransactionAction::Begin | TransactionAction::SetTransaction)
    ) && script::contains_code_word(sql, "write")
}

/// Only plain read queries can be wrapped in a server-side cursor for streaming.
/// DuckDB additionally admits its FROM-first and PIVOT forms — they wrap as
/// subqueries fine (pinned by `duck_from_first_and_pivot_stream`), and classifying
/// them non-cursorable buffered ENTIRE tables in RAM (`FROM events` on a big table
/// was an allocation-abort waiting to happen).
pub(crate) fn is_cursorable(sql: &str, engine: TransactionEngine) -> bool {
    let duck = engine == TransactionEngine::DuckDb;
    let read_head = |w: &str| {
        matches!(w, "select" | "table" | "values") || (duck && matches!(w, "from" | "pivot"))
    };
    let w = first_sql_word(sql, engine);
    match w.as_str() {
        // `WITH … UPDATE/INSERT/DELETE/MERGE` is a write wearing a read's first word:
        // `DECLARE … CURSOR FOR` it is a syntax error, and a data-modifying CTE cannot
        // sit under a cursor either. Only a WITH whose main statement is a read streams;
        // anything else runs on the plain execute path.
        "with" => script::with_shape(sql, engine)
            .is_some_and(|s| !s.modifying_cte && !s.main_select_into && read_head(&s.main)),
        "select" => !script::has_top_level_into(sql, engine),
        _ => read_head(&w),
    }
}

/// A statement that can be wrapped as a derived table `SELECT * FROM (<it>) …`.
/// `is_read_only_stmt` also admits SHOW/EXPLAIN, which are read-only but CANNOT be a
/// subquery — a row-capped subselect wrapper must reject those at the gate (else
/// execution fails with a confusing parser error). T-SQL additionally rejects `WITH`
/// and a bare `ORDER BY` inside a derived table — the same rule `mssqlWrappable`
/// applies to the grid's sort/filter wrap.
pub(crate) fn is_wrappable_read(sql: &str, engine: TransactionEngine) -> bool {
    let first = first_sql_word(sql, engine);
    if engine == TransactionEngine::MsSql {
        // `WITH`-led statements are excluded by the SELECT-only head check.
        if first != "select" {
            return false;
        }
        let masked = mask_sql(sql, engine);
        let words: Vec<&str> = masked
            .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .filter(|w| !w.is_empty())
            .collect();
        return !words.windows(2).any(|w| w == ["order", "by"]);
    }
    matches!(first.as_str(), "select" | "with" | "table" | "values")
}

/// The row-capped wrapper an approved read runs through. T-SQL has no `LIMIT`; it
/// caps with `TOP` instead. `cap + 1` rows are read so truncation is detectable.
/// Newlines around the inner SQL so a trailing `-- line comment` in the query can't
/// swallow the closing paren or the cap.
pub(crate) fn wrap_capped(sql: &str, cap: usize, engine: TransactionEngine) -> String {
    if engine == TransactionEngine::MsSql {
        return format!("SELECT TOP {} * FROM (\n{sql}\n) AS _tusk", cap + 1);
    }
    format!("SELECT * FROM (\n{sql}\n) AS _tusk LIMIT {}", cap + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_read_only_stmt_pg(sql: &str) -> bool {
        is_read_only_stmt(sql, TransactionEngine::Postgres)
    }

    #[test]
    fn query_classification_skips_comments_and_matches_whole_keywords() {
        let pg = TransactionEngine::Postgres;
        let duck = TransactionEngine::DuckDb;
        let mysql = TransactionEngine::MySql;
        assert!(is_cursorable("-- heading\nSELECT 1", pg));
        assert!(is_read_only_stmt_pg(
            "/* heading */ WITH x AS (SELECT 1) SELECT * FROM x"
        ));
        assert!(!is_cursorable("selection FROM t", pg));
        assert!(!is_read_only_stmt_pg("showcase"));
        // WITH streams only when the statement it feeds is a read.
        assert!(is_cursorable("WITH x AS (SELECT 1) SELECT * FROM x", pg));
        assert!(is_cursorable(
            "WITH x AS (SELECT 1) SELECT 1 AS ordinal FROM x",
            pg
        ));
        assert!(is_cursorable("WITH x AS (SELECT 1) TABLE x", pg));
        assert!(!is_cursorable(
            "WITH bnr AS (SELECT id FROM vendor) UPDATE pvl SET a = NULL FROM bnr WHERE 1=1",
            pg
        ));
        assert!(!is_cursorable(
            "WITH g AS (SELECT 1) INSERT INTO t SELECT * FROM g",
            pg
        ));
        assert!(!is_cursorable(
            "WITH g AS (SELECT 1) DELETE FROM t USING g",
            pg
        ));
        assert!(!is_cursorable(
            "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
            pg
        ));
        assert!(!is_cursorable(
            "WITH RECURSIVE t(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM t WHERE n<2) SEARCH DEPTH FIRST BY n SET \"select\" UPDATE \"target\" AS u SET n=2",
            pg
        ));
        assert!(is_cursorable(
            "WITH update AS (SELECT 1) SELECT * FROM update",
            pg
        ));
        assert!(is_cursorable(
            "WITH RECURSIVE update(i) USING KEY(i) AS (VALUES (1)) SELECT * FROM update",
            duck
        ));
        assert!(is_cursorable(
            "WITH x AS (SELECT 1) # choose rows\nSELECT * FROM x",
            mysql
        ));
        assert!(is_cursorable("WITH x AS (SELECT 1) FROM x", duck));
        assert!(!is_cursorable("WITH x AS (SELECT 1) FROM x", pg));
        // DuckDB-only forms stream (buffering FROM <big table> whole was an OOM-abort
        // class); other engines keep rejecting them as cursorable.
        assert!(is_cursorable("FROM events", duck));
        assert!(is_cursorable("PIVOT t ON k USING sum(v)", duck));
        assert!(!is_cursorable("FROM events", pg));
        assert!(!is_cursorable("SELECT * INTO archived FROM events", pg));
        assert!(!is_cursorable(
            "WITH x AS (SELECT 1) SELECT * INTO archived FROM x",
            pg
        ));
        assert!(is_read_only_stmt_pg("FROM events"));
        assert!(!is_read_only_stmt_pg("frombulate"));
    }

    #[test]
    fn readonly_guard_rejects_writable_ctes_and_row_locks() {
        assert!(!is_read_only_stmt_pg(
            "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"
        ));
        assert!(!is_read_only_stmt_pg("SELECT * FROM t FOR UPDATE"));
        assert!(!is_read_only_stmt_pg("SELECT * FROM t FOR SHARE"));
        assert!(!is_read_only_stmt_pg("SELECT * FROM t FOR\nSHARE"));
        assert!(!is_read_only_stmt_pg(
            "SELECT * FROM t INTO OUTFILE '/tmp/x'"
        ));
        assert!(is_read_only_stmt_pg("SELECT 'delete' AS word -- update"));
        assert!(!is_read_only_stmt_pg("EXPLAIN ANALYZE SELECT 1"));
        assert!(!is_read_only_stmt_pg("SELECT set_config('x', 'y', false)"));
    }

    #[test]
    fn readonly_guard_reads_each_engine_with_its_own_rules() {
        let mssql = TransactionEngine::MsSql;
        let mysql = TransactionEngine::MySql;
        // Nested comments hide the SHOW from SQL Server; the scan must still see DROP.
        assert!(!is_read_only_stmt("/*/* */ SHOW 1 */ DROP TABLE t", mssql));
        // Bracket identifiers are names, not keywords.
        assert!(is_read_only_stmt(
            "SELECT [insert], [delete] FROM [dbo].[Update]",
            mssql
        ));
        // MySQL's SHOW CREATE is the one exempt mutation word.
        assert!(is_read_only_stmt("SHOW CREATE TABLE t", mysql));
        assert!(!is_read_only_stmt(
            "SHOW CREATE TABLE t; DROP TABLE u",
            mysql
        ));
        // A `#` comment is only a comment on MySQL.
        assert!(is_read_only_stmt("SELECT 1 # DROP TABLE t", mysql));
        assert!(!is_read_only_stmt(
            "SELECT 1 # DROP TABLE t",
            TransactionEngine::Postgres
        ));
        // An executable comment is refused outright on MySQL (its body is not scanned
        // as code) and is only a comment elsewhere.
        assert!(!is_read_only_stmt(
            "SELECT 1 /*!50000 INTO OUTFILE '/tmp/x' */",
            mysql
        ));
        assert!(is_read_only_stmt(
            "SELECT 1 /*!50000 INTO OUTFILE '/tmp/x' */",
            TransactionEngine::Postgres
        ));
        assert!(is_read_only_stmt(
            "SELECT '/*! DROP TABLE x */' AS text",
            mysql
        ));
    }

    #[test]
    fn transaction_openers_that_ask_for_write_are_writes() {
        assert!(transaction_requests_write(
            "BEGIN READ WRITE",
            Some(TransactionAction::Begin)
        ));
        assert!(!transaction_requests_write(
            "BEGIN READ ONLY",
            Some(TransactionAction::Begin)
        ));
        assert!(!transaction_requests_write("SELECT 'write'", None));
    }

    #[test]
    fn capped_wrap_is_per_engine() {
        // T-SQL has no LIMIT: every approved query used to die on "Incorrect syntax
        // near 'LIMIT'".
        let mssql = wrap_capped("SELECT a FROM t", 100, TransactionEngine::MsSql);
        assert!(mssql.starts_with("SELECT TOP 101 * FROM ("), "{mssql}");
        assert!(!mssql.contains("LIMIT"), "{mssql}");
        let pg = wrap_capped("SELECT a FROM t", 100, TransactionEngine::Postgres);
        assert!(pg.ends_with(") AS _tusk LIMIT 101"), "{pg}");
        // A derived table on T-SQL rejects WITH and a bare ORDER BY, so the gate must
        // refuse those shapes rather than emit SQL the server won't parse.
        let mssql_engine = TransactionEngine::MsSql;
        assert!(is_wrappable_read("SELECT a FROM t", mssql_engine));
        assert!(!is_wrappable_read(
            "SELECT a FROM t ORDER BY a",
            mssql_engine
        ));
        assert!(!is_wrappable_read(
            "SELECT a FROM t\nORDER\nBY a",
            mssql_engine
        ));
        assert!(!is_wrappable_read(
            "WITH c AS (SELECT 1 AS a) SELECT * FROM c",
            mssql_engine
        ));
        assert!(is_wrappable_read(
            "WITH c AS (SELECT 1 AS a) SELECT * FROM c",
            TransactionEngine::Postgres
        ));
        // Read-only but not a subquery.
        assert!(!is_wrappable_read("SHOW TABLES", TransactionEngine::MySql));
        assert!(!is_wrappable_read(
            "EXPLAIN SELECT 1",
            TransactionEngine::Postgres
        ));
    }

    #[test]
    fn bracket_identifiers_are_names_not_keywords() {
        // `SELECT [insert] FROM [dbo].[Update]` is a plain read; the mutation scan used
        // to see `insert`/`update` and blame the user for DML that isn't there.
        assert!(find_mutation_word_for(
            "SELECT [insert], [delete] FROM [dbo].[Update]",
            TransactionEngine::MsSql,
            false
        )
        .is_none());
        // A `'` inside a bracket must not open a phantom string that hides real code.
        assert_eq!(
            find_mutation_word_for(
                "SELECT [a'b] FROM t; DROP TABLE u",
                TransactionEngine::MsSql,
                false
            ),
            Some("drop")
        );
        // Nested comments hide nothing from the scan either.
        assert_eq!(
            find_mutation_word_for(
                "/*/* */ SELECT 1 */ DROP TABLE u",
                TransactionEngine::MsSql,
                false
            ),
            Some("drop")
        );
        // MySQL's SHOW CREATE is the only exemption, and only for that one word.
        assert!(
            find_mutation_word_for("SHOW CREATE TABLE t", TransactionEngine::MySql, true).is_none()
        );
        assert_eq!(
            find_mutation_word_for(
                "SHOW CREATE TABLE t; DROP TABLE u",
                TransactionEngine::MySql,
                true
            ),
            Some("drop")
        );
    }

    #[test]
    fn masking_hides_values_and_keeps_code() {
        let pg = TransactionEngine::Postgres;
        // Values never leak keywords; dollar bodies are opaque.
        assert!(find_mutation_word_for("SELECT 'DROP TABLE t'", pg, false).is_none());
        assert!(find_mutation_word_for("SELECT $$DROP TABLE t$$", pg, false).is_none());
        assert!(find_mutation_word_for("SELECT $fn$ DROP $fn$", pg, false).is_none());
        // `$1` is a parameter, not a tag: the code after it stays visible.
        assert_eq!(
            find_mutation_word_for("SELECT $1; DROP TABLE t", pg, false),
            Some("drop")
        );
        // Quoted identifiers are opaque `q…q` tokens.
        assert!(mask_sql("SELECT \"delete\" FROM t", pg).contains("q"));
        assert!(find_mutation_word_for("SELECT \"delete\" FROM t", pg, false).is_none());
        // Unterminated comment masks to the end rather than exposing a tail.
        assert!(find_mutation_word_for("SELECT 1 /* DROP TABLE t", pg, false).is_none());
    }
}
