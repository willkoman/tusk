//! Cross-engine conformance suite. One battery of behaviours run against every driver,
//! so per-engine divergence and production-data edge cases (NULL, paging boundaries,
//! unicode/quotes/newlines, large values, writes-apply, introspection, weird
//! identifiers, read-only) are caught uniformly.
//!
//! DuckDB + SQLite run in-process (embedded). Postgres + MySQL run against a live server
//! when `TUSK_TEST_PG_PORT` / `TUSK_TEST_MYSQL_PORT` are set (e.g. `scripts/conformance.sh`
//! spins up throwaway Docker containers); otherwise those tests skip.

use crate::db::{ConnectionConfig, QueryOutcome};
use crate::driver::{connect, Backend};
use crate::script::TransactionEngine;

// --- engine descriptors ---

fn dq(n: &str) -> String {
    format!("\"{}\"", n.replace('"', "\"\""))
}
fn bt(n: &str) -> String {
    format!("`{}`", n.replace('`', "``"))
}
fn br(n: &str) -> String {
    format!("[{}]", n.replace(']', "]]"))
}

struct Eng {
    name: &'static str,
    schema: &'static str,      // schema arg for table_detail
    quote: fn(&str) -> String, // identifier quoting
    engine: TransactionEngine,
    /// Type spellings the batteries need. T-SQL has no TEXT that stores Unicode, no
    /// BOOLEAN, and `TIMESTAMP` there means `rowversion` — so these are per-engine.
    text_type: &'static str,
    timestamp_type: &'static str,
    bool_type: &'static str,
    /// Literals for the boolean column above.
    bool_true: &'static str,
    bool_false: &'static str,
    /// The engine's own transaction-start statement.
    begin: &'static str,
}

/// Every engine but SQL Server shares these spellings.
const STANDARD_TYPES: Eng = Eng {
    name: "",
    schema: "",
    quote: dq,
    engine: TransactionEngine::Postgres,
    text_type: "TEXT",
    timestamp_type: "TIMESTAMP",
    bool_type: "BOOLEAN",
    bool_true: "TRUE",
    bool_false: "FALSE",
    begin: "BEGIN",
};

fn base() -> ConnectionConfig {
    ConnectionConfig {
        driver: None,
        host: String::new(),
        port: 0,
        user: String::new(),
        password: String::new(),
        dbname: String::new(),
        sslmode: None,
        read_only: false,
        path: None,
        ssh: None,
    }
}
fn duck_cfg() -> ConnectionConfig {
    ConnectionConfig {
        driver: Some("duckdb".into()),
        path: Some(":memory:".into()),
        ..base()
    }
}
fn sqlite_cfg() -> ConnectionConfig {
    ConnectionConfig {
        driver: Some("sqlite".into()),
        path: Some(":memory:".into()),
        ..base()
    }
}
fn pg_cfg() -> Option<ConnectionConfig> {
    let port: u16 = std::env::var("TUSK_TEST_PG_PORT").ok()?.parse().ok()?;
    Some(ConnectionConfig {
        driver: Some("postgres".into()),
        host: "127.0.0.1".into(),
        port,
        user: "postgres".into(),
        password: "test".into(),
        dbname: "postgres".into(),
        sslmode: Some("disable".into()),
        ..base()
    })
}
fn mssql_cfg() -> Option<ConnectionConfig> {
    let port: u16 = std::env::var("TUSK_TEST_MSSQL_PORT").ok()?.parse().ok()?;
    Some(ConnectionConfig {
        driver: Some("mssql".into()),
        host: "127.0.0.1".into(),
        port,
        user: "sa".into(),
        password: std::env::var("TUSK_TEST_MSSQL_PASSWORD").ok()?,
        dbname: "tusk_test".into(),
        sslmode: Some("prefer".into()),
        ..base()
    })
}
fn mysql_cfg() -> Option<ConnectionConfig> {
    let port: u16 = std::env::var("TUSK_TEST_MYSQL_PORT").ok()?.parse().ok()?;
    Some(mysql_cfg_at(port))
}
/// A MySQL-protocol server on localhost (root / `test`, database `test`).
fn mysql_cfg_at(port: u16) -> ConnectionConfig {
    ConnectionConfig {
        driver: Some("mysql".into()),
        host: "127.0.0.1".into(),
        port,
        user: "root".into(),
        password: "test".into(),
        dbname: "test".into(),
        sslmode: Some("disable".into()),
        ..base()
    }
}

// --- helpers ---

/// The production classifier (non-DuckDB form): a `WITH`-led write must not stream.
fn cursorable(sql: &str) -> bool {
    crate::sqlguard::is_cursorable(sql, TransactionEngine::Postgres)
}

async fn exec(b: &mut Backend, sql: &str) {
    b.rollback_cursor().await;
    b.run_single(sql, 1000, cursorable(sql))
        .await
        .unwrap_or_else(|e| panic!("exec failed [{sql}]: {}", e.message));
}

/// Run a query and return all rows (single big page).
async fn all(b: &mut Backend, sql: &str) -> Vec<Vec<Option<String>>> {
    b.rollback_cursor().await;
    match b
        .run_single(sql, 1_000_000, true)
        .await
        .unwrap_or_else(|e| panic!("query failed [{sql}]: {}", e.message))
    {
        QueryOutcome::Rows { rows, .. } => rows,
        QueryOutcome::Exec { message } => panic!("expected rows, got exec [{sql}]: {message}"),
    }
}

/// Page a query and return (all rows in order, fetch count).
async fn page_all(b: &mut Backend, sql: &str, page: u32) -> (Vec<Vec<Option<String>>>, usize) {
    b.rollback_cursor().await;
    let mut out = Vec::new();
    let (mut rows, mut done) = match b.run_single(sql, page, true).await.unwrap() {
        QueryOutcome::Rows { rows, done, .. } => (rows, done),
        _ => panic!("expected rows"),
    };
    out.append(&mut rows);
    let mut fetches = 1;
    while !done {
        let fr = b.fetch_page(page).await.unwrap();
        done = fr.done;
        out.extend(fr.rows);
        fetches += 1;
        assert!(fetches < 100_000, "paging never terminated");
    }
    (out, fetches)
}

fn cell(r: &[Option<String>], i: usize) -> Option<String> {
    r.get(i).cloned().flatten()
}

// --- the battery ---

/// `Backend::database_name()` MUST equal what the sidebar shows (`DbTree.database`).
/// Anything that scopes by database — AI skills, in both the panel and the Slack bot —
/// reads one of these; if they drift, a skill applies in one place and silently vanishes
/// in the other. `ConnectionConfig.dbname` is NOT a valid source: it's the field the user
/// typed, empty for DuckDB/SQLite and empty on PG whenever libpq defaults it.
async fn database_name_battery(b: &mut Backend, eng: &Eng) {
    let from_tree = b.build_tree().await.expect("build_tree").database;
    let direct = b.database_name().await;
    assert_eq!(
        direct, from_tree,
        "[{}] database_name() must match DbTree.database",
        eng.name
    );
    assert!(
        !direct.is_empty(),
        "[{}] database_name() must not be empty",
        eng.name
    );

    // ...and it must not silently fall back to the typed config field, which is blank for
    // the embedded engines. This is the exact bug the Slack bot had.
    if matches!(b, Backend::Duck(_) | Backend::Sqlite(_)) {
        assert!(
            b.config().dbname.is_empty(),
            "[{}] embedded config.dbname is blank by construction",
            eng.name
        );
        assert_ne!(
            direct,
            b.config().dbname,
            "[{}] database_name() must not come from config.dbname",
            eng.name
        );
    }
}

/// A syntax error must surface as a normal Err and leave the connection fully
/// usable. On DuckDB this pins the parse gate (duckdb-rs #209: an ungated parser
/// error poisons the connection — every later statement fails with "resource
/// deadlock would occur" and dropping the backend aborts the whole process).
async fn syntax_error_recovery_battery(b: &mut Backend, eng: &Eng) {
    for bad in ["SELCT 1", "SELECT * FROM x WHERE a NOT IN (1 2)"] {
        let e = b
            .run_single(bad, 100, true)
            .await
            .expect_err("syntax error must be Err");
        assert!(
            !e.message.contains("deadlock"),
            "[{}] connection poisoned by syntax error: {}",
            eng.name,
            e.message
        );
    }
    match b.run_single("SELECT 1", 100, true).await.unwrap() {
        QueryOutcome::Rows { rows, .. } => {
            assert_eq!(
                rows.len(),
                1,
                "[{}] connection usable after syntax errors",
                eng.name
            )
        }
        _ => panic!("[{}] expected rows after syntax errors", eng.name),
    }
}

/// `WITH … UPDATE` is a write wearing a read's first word. It used to classify as
/// cursorable, so PostgreSQL received `DECLARE … CURSOR FOR WITH … UPDATE` (a syntax
/// error at UPDATE) and every engine routed the write through the read path.
async fn with_dml_battery(b: &mut Backend, eng: &Eng) {
    let q = eng.quote;
    let cursorable = |sql: &str| crate::sqlguard::is_cursorable(sql, eng.engine);
    exec(b, &format!("DROP TABLE IF EXISTS {}", q("wdml"))).await;
    exec(
        b,
        &format!("CREATE TABLE {} (id INTEGER, v INTEGER)", q("wdml")),
    )
    .await;
    exec(
        b,
        &format!("INSERT INTO {} VALUES (1, 0), (2, 0)", q("wdml")),
    )
    .await;
    let sql = format!(
        "WITH g AS (SELECT 1 AS id) UPDATE {} SET v = 9 WHERE id IN (SELECT id FROM g)",
        q("wdml")
    );
    assert!(
        !cursorable(&sql),
        "[{}] WITH-led UPDATE must not be cursorable",
        eng.name
    );
    b.rollback_cursor().await;
    // Outcome shape is engine-specific (DuckDB reports writes as a one-row `Count`
    // result); what matters is that it is not a cursor error and the write lands.
    if let Err(e) = b.run_single(&sql, 100, cursorable(&sql)).await {
        panic!("[{}] WITH … UPDATE failed: {}", eng.name, e.message);
    }
    let r = all(b, &format!("SELECT v FROM {} WHERE id = 1", q("wdml"))).await;
    assert_eq!(
        cell(&r[0], 0).as_deref(),
        Some("9"),
        "[{}] WITH … UPDATE applied",
        eng.name
    );
    // A read-headed WITH still streams through the cursor path.
    let sql = format!(
        "WITH g AS (SELECT id FROM {}) SELECT 1 AS ordinal FROM g ORDER BY id",
        q("wdml")
    );
    assert!(cursorable(&sql), "[{}] WITH … SELECT streams", eng.name);
    b.rollback_cursor().await;
    match b.run_single(&sql, 100, cursorable(&sql)).await.unwrap() {
        QueryOutcome::Rows { rows, .. } => {
            assert_eq!(rows.len(), 2, "[{}] WITH … SELECT rows", eng.name)
        }
        QueryOutcome::Exec { message } => {
            panic!("[{}] expected WITH … SELECT rows: {message}", eng.name)
        }
    }

    if eng.name == "postgres" {
        // SEARCH/CYCLE output-column names are still part of the CTE declaration.
        // A quoted `select` there must not disguise the UPDATE that follows.
        let sql = format!(
            "WITH RECURSIVE t(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM t WHERE n<2) \
             SEARCH DEPTH FIRST BY n SET \"select\" \
             UPDATE {} AS target SET v=7 WHERE id IN (SELECT n FROM t)",
            q("wdml")
        );
        assert!(
            !cursorable(&sql),
            "[{}] SEARCH column named select must not hide UPDATE",
            eng.name
        );
        b.rollback_cursor().await;
        b.run_single(&sql, 100, cursorable(&sql)).await.unwrap();
        let r = all(b, &format!("SELECT v FROM {} ORDER BY id", q("wdml"))).await;
        assert!(
            r.iter().all(|row| cell(row, 0).as_deref() == Some("7")),
            "[{}] SEARCH-led UPDATE applied",
            eng.name
        );

        // SELECT INTO creates a table and therefore belongs on the plain write path.
        let archive = q("wdml_archive");
        exec(b, &format!("DROP TABLE IF EXISTS {archive}")).await;
        let sql = format!(
            "WITH g AS (SELECT id FROM {}) SELECT * INTO TEMP TABLE {archive} FROM g",
            q("wdml")
        );
        assert!(
            !cursorable(&sql),
            "[{}] WITH … SELECT INTO must not be cursorable",
            eng.name
        );
        b.rollback_cursor().await;
        b.run_single(&sql, 100, cursorable(&sql)).await.unwrap();
        let r = all(b, &format!("SELECT count(*) FROM {archive}")).await;
        assert_eq!(
            r[0][0].as_deref(),
            Some("2"),
            "[{}] SELECT INTO applied",
            eng.name
        );
        exec(b, &format!("DROP TABLE {archive}")).await;
    }
    exec(b, &format!("DROP TABLE {}", q("wdml"))).await;
}

/// The WHERE clauses the visual filter builder generates must be VALID and mean the
/// same thing on every engine. `src/grid/filterSql.ts` decides the shapes (its vitest
/// suite pins the exact strings); this executes those shapes so a dialect mistake —
/// `IS TRUE` where booleans are 0/1, an `ESCAPE` clause the parser rejects, a cast
/// target that doesn't exist — fails here instead of in a user's grid.
async fn filter_where_battery(b: &mut Backend, eng: &Eng) {
    let q = eng.quote;
    let name = q("name");
    let qty = q("qty");
    let flag = q("flag");
    let id = q("id");
    // Mirrors filterSql.ts: ILIKE is native only on PG/DuckDB; everywhere else both
    // sides are folded explicitly rather than trusting the column's collation (a MySQL
    // `_bin`/`_cs` column, or SQLite with `PRAGMA case_sensitive_like`, is not).
    let ci = |expr: &str, pat: &str, tail: &str| match eng.name {
        "postgres" | "duckdb" => format!("{expr} ILIKE {pat}{tail}"),
        _ => format!("LOWER({expr}) LIKE LOWER({pat}){tail}"),
    };
    // `!`, never a backslash: MySQL under `sql_mode=ANSI` rejects `ESCAPE '\'` with
    // error 1210, and a backslash literal reads differently per dialect. The clause is
    // declared unconditionally for the patterns the builder constructs.
    let esc = " ESCAPE '!'";
    let text_cast = |col: &str| match eng.name {
        "mysql" => format!("CAST({col} AS CHAR)"),
        "sqlite" => format!("CAST({col} AS TEXT)"),
        // T-SQL has no `::` cast operator.
        "mssql" => format!("CAST({col} AS VARCHAR(MAX))"),
        _ => format!("{col}::text"),
    };
    // Mirrors `lit()` in src/sql/ident.ts: every SQL Server string literal is `N'…'`.
    let text = |literal: &str| match eng.name {
        "mssql" => format!("N{literal}"),
        _ => literal.to_string(),
    };
    let bool_is = |col: &str, want: bool| match eng.name {
        "postgres" | "duckdb" => format!("{col} IS {}", if want { "TRUE" } else { "FALSE" }),
        _ => format!("{col} = {}", if want { "1" } else { "0" }),
    };

    exec(b, &format!("DROP TABLE IF EXISTS {}", q("filt_t"))).await;
    // `BOOLEAN` is not a T-SQL type and `TRUE`/`FALSE` are not T-SQL literals, so the
    // fixture uses the engine's own spelling (`bit`, `1`/`0` there).
    exec(
        b,
        &format!(
            "CREATE TABLE {} (id INTEGER, name VARCHAR(40), qty DECIMAL(10,2), flag {})",
            q("filt_t"),
            eng.bool_type
        ),
    )
    .await;
    let (yes, no) = (eng.bool_true, eng.bool_false);
    exec(
        b,
        &format!(
            "INSERT INTO {} VALUES (1, 'Alpha', 10.00, {yes}), (2, 'beta', 20.50, {no}), \
             (3, '50% off', 30.00, {yes}), (4, 'a_b', NULL, NULL), (5, 'o''brien', 5.00, {no}), \
             (6, '', 0.00, {yes}), (7, 'axb', 1.00, {no}), (8, 'b!c', 2.00, {no})",
            q("filt_t")
        ),
    )
    .await;

    let cases: Vec<(String, Vec<&str>)> = vec![
        // contains — case-insensitive on every engine, ESCAPE always declared
        (ci(&text_cast(&name), &text("'%alph%'"), esc), vec!["1"]),
        // starts with, `%` in the user's text escaped (matches literally, not as a wildcard)
        (ci(&text_cast(&name), &text("'50!%%'"), esc), vec!["3"]),
        // contains, `_` escaped: 'a_b' matches, 'axb' must not
        (ci(&text_cast(&name), &text("'%a!_b%'"), esc), vec!["4"]),
        // contains, an escape character in the user's own text is escaped with itself
        (ci(&text_cast(&name), &text("'%b!!c%'"), esc), vec!["8"]),
        // like — raw pattern, the wildcards are the user's
        (
            format!("{} LIKE {}", text_cast(&name), text("'%b%'")),
            vec!["2", "4", "5", "7", "8"],
        ),
        // every LIKE comparison is done on the text form of the column
        (ci(&text_cast(&qty), &text("'%20%'"), esc), vec!["2"]),
        // typed comparisons: unquoted numeric literal against a numeric column
        (format!("{qty} BETWEEN 5 AND 20.5"), vec!["1", "2", "5"]),
        (
            format!("{qty} NOT BETWEEN 5 AND 20.5"),
            vec!["3", "6", "7", "8"],
        ),
        (format!("{id} IN (1, 2, 3)"), vec!["1", "2", "3"]),
        (
            format!("{id} NOT IN (1, 2)"),
            vec!["3", "4", "5", "6", "7", "8"],
        ),
        // explicit NULL semantics
        (format!("{qty} IS NULL"), vec!["4"]),
        (
            format!("{qty} IS NOT NULL"),
            vec!["1", "2", "3", "5", "6", "7", "8"],
        ),
        // boolean literal form
        (bool_is(&flag, true), vec!["1", "3", "6"]),
        (bool_is(&flag, false), vec!["2", "5", "7", "8"]),
        // is empty + a quote-carrying literal — both on the text form
        (format!("{} = {}", text_cast(&name), text("''")), vec!["6"]),
        (format!("{name} = {}", text("'o''brien'")), vec!["5"]),
        // AND of an OR group — the shape the builder emits for nested groups
        (
            format!("({id} = 1 OR {id} = 2) AND {}", bool_is(&flag, true)),
            vec!["1"],
        ),
        // OR of an AND group
        (
            format!("({qty} > 25 AND {}) OR {id} = 5", bool_is(&flag, true)),
            vec!["3", "5"],
        ),
    ];

    for (where_sql, want) in cases {
        let sql = format!(
            "SELECT {id} FROM {} WHERE {where_sql} ORDER BY {id}",
            q("filt_t")
        );
        let rows = all(b, &sql).await;
        let got: Vec<String> = rows.iter().filter_map(|r| cell(r, 0)).collect();
        assert_eq!(
            got, want,
            "[{}] generated filter WHERE mismatched: {sql}",
            eng.name
        );
    }
    exec(b, &format!("DROP TABLE {}", q("filt_t"))).await;
}

async fn run_battery(b: &mut Backend, eng: &Eng) {
    database_name_battery(b, eng).await;
    syntax_error_recovery_battery(b, eng).await;
    with_dml_battery(b, eng).await;
    filter_where_battery(b, eng).await;
    let q = eng.quote;

    // clean slate (idempotent across re-runs on a persistent server)
    for t in ["conf", "seq"] {
        exec(b, &format!("DROP TABLE IF EXISTS {}", q(t))).await;
    }

    // 1. CREATE + insert edge values: unicode/emoji, embedded quote, NULL (explicit +
    //    default), newline.
    exec(
        b,
        &format!(
            "CREATE TABLE {} (id INTEGER, name {})",
            q("conf"),
            eng.text_type
        ),
    )
    .await;
    exec(
        b,
        &format!("INSERT INTO {} VALUES (1, 'café 🦆')", q("conf")),
    )
    .await;
    exec(b, &format!("INSERT INTO {} VALUES (2, 'a''b')", q("conf"))).await;
    exec(b, &format!("INSERT INTO {} VALUES (3, NULL)", q("conf"))).await;
    exec(b, &format!("INSERT INTO {} (id) VALUES (4)", q("conf"))).await;
    exec(
        b,
        &format!("INSERT INTO {} VALUES (5, 'l1\nl2')", q("conf")),
    )
    .await;

    let r = all(
        b,
        &format!(
            "SELECT {},{} FROM {} ORDER BY id",
            q("id"),
            q("name"),
            q("conf")
        ),
    )
    .await;
    assert_eq!(r.len(), 5, "[{}] row count", eng.name);
    assert_eq!(
        cell(&r[0], 0).as_deref(),
        Some("1"),
        "[{}] int→text",
        eng.name
    );
    assert_eq!(
        cell(&r[0], 1).as_deref(),
        Some("café 🦆"),
        "[{}] unicode/emoji roundtrip",
        eng.name
    );
    assert_eq!(
        cell(&r[1], 1).as_deref(),
        Some("a'b"),
        "[{}] quote unescaped",
        eng.name
    );
    assert_eq!(cell(&r[2], 1), None, "[{}] explicit NULL → None", eng.name);
    assert_eq!(cell(&r[3], 1), None, "[{}] default NULL → None", eng.name);
    assert!(
        cell(&r[4], 1).unwrap().contains('\n'),
        "[{}] newline preserved",
        eng.name
    );

    // 2. empty result set: no rows, no error. (Postgres now reports column names even for
    //    a zero-row result via the simple-protocol RowDescription — see db::collect_rows —
    //    so an empty SELECT still shows its headers; column presence isn't asserted here.)
    let empty = b
        .run_single(
            &format!("SELECT {} FROM {} WHERE 1=0", q("id"), q("conf")),
            100,
            true,
        )
        .await
        .unwrap();
    match empty {
        QueryOutcome::Rows { rows, done, .. } => {
            assert!(rows.is_empty(), "[{}] empty result has no rows", eng.name);
            assert!(done, "[{}] empty result is done", eng.name);
        }
        _ => panic!("[{}] empty SELECT should be Rows", eng.name),
    }

    // 3. duplicate result column names — the realistic case (a column selected twice, or
    //    a join sharing a name). The pager wraps the query as a derived table; MySQL
    //    forbids duplicate names there (1060) and falls back to appending LIMIT/OFFSET.
    let dup = all(
        b,
        // Ordinal ordering: with two columns named `id`, SQL Server rejects `ORDER BY id`
        // as ambiguous, and every engine accepts the position.
        &format!("SELECT {0}, {0} FROM {1} ORDER BY 1", q("id"), q("conf")),
    )
    .await;
    assert_eq!(
        dup[0].len(),
        2,
        "[{}] duplicate result columns kept",
        eng.name
    );
    assert_eq!(
        cell(&dup[0], 0),
        cell(&dup[0], 1),
        "[{}] both dup columns same value",
        eng.name
    );

    // 3b. typed values render as readable text (the all-text model must not mangle
    //     dates/decimals — DuckDB casts via VARCHAR, MySQL formats its Value::Date).
    exec(b, &format!("DROP TABLE IF EXISTS {}", q("typ"))).await;
    // Column names quoted (`dec` is a reserved word in MySQL — exercises reserved-word
    // column handling too).
    exec(
        b,
        &format!(
            "CREATE TABLE {} ({} DATE, {} {}, {} DECIMAL(10,2))",
            q("typ"),
            q("d"),
            q("ts"),
            eng.timestamp_type,
            q("dec")
        ),
    )
    .await;
    exec(
        b,
        &format!(
            "INSERT INTO {} VALUES ('2024-01-15', '2024-01-15 00:00:00', 3.14)",
            q("typ")
        ),
    )
    .await;
    let t = all(
        b,
        &format!(
            "SELECT {},{},{} FROM {}",
            q("d"),
            q("ts"),
            q("dec"),
            q("typ")
        ),
    )
    .await;
    assert_eq!(
        cell(&t[0], 0).as_deref(),
        Some("2024-01-15"),
        "[{}] DATE → text",
        eng.name
    );
    assert!(
        cell(&t[0], 1).unwrap().starts_with("2024-01-15 00:00:00"),
        "[{}] midnight TIMESTAMP retains its time component: {:?}",
        eng.name,
        cell(&t[0], 1)
    );
    assert!(
        cell(&t[0], 2).unwrap().starts_with("3.14"),
        "[{}] DECIMAL → text: {:?}",
        eng.name,
        cell(&t[0], 2)
    );
    exec(b, &format!("DROP TABLE IF EXISTS {}", q("typ"))).await;

    // 4. paging boundaries — the critical edges. 20 rows, page 10:
    //    page1=10 (NOT done, == page), page2=10 (NOT done), page3=0 (done).
    //    Must collect all 20 in order with no dup/skip and exactly 3 fetches.
    exec(b, &format!("CREATE TABLE {} (n INTEGER)", q("seq"))).await;
    for i in 1..=20 {
        exec(b, &format!("INSERT INTO {} VALUES ({i})", q("seq"))).await;
    }
    let sel_seq = format!("SELECT {} FROM {} ORDER BY n", q("n"), q("seq"));
    let (rows20, fetches20) = page_all(b, &sel_seq, 10).await;
    assert_eq!(rows20.len(), 20, "[{}] paged 20 rows", eng.name);
    assert_eq!(
        fetches20, 3,
        "[{}] exactly-full page must do a final empty fetch",
        eng.name
    );
    let ids: Vec<i64> = rows20
        .iter()
        .map(|r| cell(r, 0).unwrap().parse().unwrap())
        .collect();
    assert_eq!(
        ids,
        (1..=20).collect::<Vec<_>>(),
        "[{}] paged order, no dup/skip",
        eng.name
    );
    // exact single-page boundary: 10 rows, page 10 → page1=10 (not done), page2=0 (done).
    // Expressed with a predicate rather than LIMIT/TOP so every engine reads the same
    // statement shape through its own pager.
    let ten = format!(
        "SELECT {0} FROM {1} WHERE {0} <= 10 ORDER BY {0}",
        q("n"),
        q("seq")
    );
    let (rows10, fetches10) = page_all(b, &ten, 10).await;
    assert_eq!(rows10.len(), 10, "[{}] single full page count", eng.name);
    assert_eq!(
        fetches10, 2,
        "[{}] full single page needs a trailing empty fetch",
        eng.name
    );

    // 5. large value (50 KB) survives the text pipeline intact (no truncation).
    let big = "x".repeat(50_000);
    exec(
        b,
        &format!("INSERT INTO {} VALUES (100, '{big}')", q("conf")),
    )
    .await;
    let lr = all(
        b,
        &format!("SELECT {} FROM {} WHERE id=100", q("name"), q("conf")),
    )
    .await;
    assert_eq!(
        cell(&lr[0], 0).unwrap().len(),
        50_000,
        "[{}] 50KB value intact",
        eng.name
    );

    // 6. writes actually apply (robust across affected-count reporting differences).
    exec(
        b,
        &format!("UPDATE {} SET {}='z' WHERE id=1", q("conf"), q("name")),
    )
    .await;
    let u = all(
        b,
        &format!("SELECT {} FROM {} WHERE id=1", q("name"), q("conf")),
    )
    .await;
    assert_eq!(
        cell(&u[0], 0).as_deref(),
        Some("z"),
        "[{}] UPDATE applied",
        eng.name
    );
    exec(b, &format!("DELETE FROM {} WHERE id=100", q("conf"))).await;
    let c = all(
        b,
        &format!("SELECT COUNT(*) FROM {} WHERE id=100", q("conf")),
    )
    .await;
    assert_eq!(
        cell(&c[0], 0).as_deref(),
        Some("0"),
        "[{}] DELETE applied",
        eng.name
    );

    // 7. introspection: tree / table_detail / autocomplete list all see the table + cols.
    let tree = b.build_tree().await.unwrap();
    let reported: Vec<_> = tree
        .schemas
        .iter()
        .map(|schema| {
            (
                schema.name.as_str(),
                schema
                    .tables
                    .iter()
                    .map(|table| table.name.as_str())
                    .collect::<Vec<_>>(),
            )
        })
        .collect();
    assert!(
        tree.schemas
            .iter()
            .any(|s| s.tables.iter().any(|t| t.name == "conf")),
        "[{}] build_tree includes conf; reported {reported:?}",
        eng.name,
    );
    // no duplicate schema rows — DuckDB's information_schema spans attached catalogs
    // (memory/system/temp), each with its own `main`, so an unfiltered schemata query
    // showed `main` three times in the sidebar. Every engine must report each schema once.
    {
        let mut names: Vec<&str> = tree.schemas.iter().map(|s| s.name.as_str()).collect();
        let total = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(
            total,
            names.len(),
            "[{}] duplicate schema rows: {names:?}",
            eng.name
        );
    }
    let det = b.table_detail(eng.schema, "conf").await.unwrap();
    let cols: Vec<&str> = det.columns.iter().map(|c| c.name.as_str()).collect();
    assert!(
        cols.contains(&"id") && cols.contains(&"name"),
        "[{}] table_detail cols {cols:?}",
        eng.name
    );
    let list = b.list_tables().await.unwrap();
    assert!(
        list.iter()
            .any(|t| t.name == "conf" && t.columns.len() >= 2),
        "[{}] list_tables includes conf w/ columns",
        eng.name
    );
    // sample_rows: read-only, dialect-quoted, bounded — feeds the AI assistant's context.
    let (scols, srows) = b.sample_rows(eng.schema, "conf", 3).await.unwrap();
    assert!(
        scols.iter().any(|c| c == "id"),
        "[{}] sample_rows columns {scols:?}",
        eng.name
    );
    assert!(
        !srows.is_empty() && srows.len() <= 3,
        "[{}] sample_rows bounded non-empty",
        eng.name
    );
    assert!(
        srows.iter().all(|r| r.len() == scols.len()),
        "[{}] sample_rows row width",
        eng.name
    );

    // 8. weird identifier (space + quote + apostrophe + backslash) — quoting and
    //    parameterized metadata-query robustness.
    let weird = "we ird'\\\"x";
    let qw = q(weird);
    exec(b, &format!("DROP TABLE IF EXISTS {qw}")).await;
    exec(b, &format!("CREATE TABLE {qw} ({} INTEGER)", q("a"))).await;
    exec(b, &format!("INSERT INTO {qw} VALUES (7)")).await;
    let wr = all(b, &format!("SELECT {} FROM {qw}", q("a"))).await;
    assert_eq!(
        cell(&wr[0], 0).as_deref(),
        Some("7"),
        "[{}] query weird-named table",
        eng.name
    );
    let list2 = b.list_tables().await.unwrap();
    assert!(
        list2.iter().any(|t| t.name == weird),
        "[{}] list_tables returns the exact weird name",
        eng.name
    );
    let wdet = b.table_detail(eng.schema, weird).await.unwrap();
    assert!(
        wdet.columns.iter().any(|c| c.name == "a"),
        "[{}] table_detail of weird name",
        eng.name
    );
    let wrels = b.table_relationships(eng.schema, weird).await.unwrap();
    assert!(
        wrels.outbound.is_empty() && wrels.inbound.is_empty(),
        "[{}] relationship lookup safely accepts weird name",
        eng.name
    );
    exec(b, &format!("DROP TABLE IF EXISTS {qw}")).await;
}

// --- relationships + DDL reconstruction (relgraph.rs / Backend::relation_ddl) ---

async fn relationship_battery(b: &mut Backend, eng: &Eng) {
    let q = eng.quote;
    // child first (FK dependency blocks dropping the parent on PG/MySQL)
    exec(b, &format!("DROP TABLE IF EXISTS {}", q("rel_child"))).await;
    exec(b, &format!("DROP TABLE IF EXISTS {}", q("rel_parent"))).await;
    exec(
        b,
        &format!(
            "CREATE TABLE {} (id INTEGER PRIMARY KEY, label {})",
            q("rel_parent"),
            eng.text_type
        ),
    )
    .await;
    exec(
        b,
        &format!(
            "CREATE TABLE {} (id INTEGER PRIMARY KEY, parent_id INTEGER, \
         FOREIGN KEY (parent_id) REFERENCES {}(id))",
            q("rel_child"),
            q("rel_parent")
        ),
    )
    .await;

    // DuckDB's duckdb_constraints() column set varies by version: the contract
    // there is edges-or-empty, never an error. Everything else must report.
    let strict = eng.name != "duckdb";

    let rel = b
        .table_relationships(eng.schema, "rel_child")
        .await
        .unwrap_or_else(|e| panic!("[{}] table_relationships(child): {}", eng.name, e.message));
    if strict || !rel.outbound.is_empty() {
        assert_eq!(rel.outbound.len(), 1, "[{}] one outbound FK", eng.name);
        let e = &rel.outbound[0];
        assert_eq!(e.src_table, "rel_child", "[{}] src table", eng.name);
        assert_eq!(e.src_cols, vec!["parent_id"], "[{}] src cols", eng.name);
        assert_eq!(e.dst_table, "rel_parent", "[{}] dst table", eng.name);
        assert_eq!(e.dst_cols, vec!["id"], "[{}] dst cols", eng.name);
    }
    let relp = b
        .table_relationships(eng.schema, "rel_parent")
        .await
        .unwrap();
    if strict || !relp.inbound.is_empty() {
        assert_eq!(
            relp.inbound.len(),
            1,
            "[{}] one inbound FK on the parent",
            eng.name
        );
        assert_eq!(
            relp.inbound[0].src_table, "rel_child",
            "[{}] inbound src",
            eng.name
        );
        assert!(
            relp.outbound.is_empty(),
            "[{}] parent has no outbound FK",
            eng.name
        );
    }

    let g = b
        .schema_relationships(eng.schema)
        .await
        .unwrap_or_else(|e| panic!("[{}] schema_relationships: {}", eng.name, e.message));
    assert!(
        g.tables.iter().any(|t| t.name == "rel_parent")
            && g.tables.iter().any(|t| t.name == "rel_child"),
        "[{}] ERD tables present",
        eng.name
    );
    if strict {
        assert!(
            g.edges
                .iter()
                .any(|e| e.src_table == "rel_child" && e.dst_table == "rel_parent"),
            "[{}] ERD edge present",
            eng.name
        );
        let parent = g.tables.iter().find(|t| t.name == "rel_parent").unwrap();
        assert!(
            parent.columns.iter().any(|c| c.name == "id" && c.is_pk),
            "[{}] ERD pk flag on rel_parent.id",
            eng.name
        );
        let child = g.tables.iter().find(|t| t.name == "rel_child").unwrap();
        assert!(
            child
                .columns
                .iter()
                .any(|c| c.name == "parent_id" && c.is_fk),
            "[{}] ERD fk flag on rel_child.parent_id",
            eng.name
        );
    }

    // Composite-key FK ordering (declared order, not alphabetical) — PG, MySQL and
    // SQL Server, whose FK queries all order by the constraint's own key position
    // (`fkc.constraint_column_id` in `MSSQL_FK_ORDER`). NOT NULL is spelled out because
    // SQL Server, unlike PG/MySQL, refuses a PRIMARY KEY over nullable columns.
    if matches!(eng.name, "postgres" | "mysql" | "mssql") {
        exec(b, &format!("DROP TABLE IF EXISTS {}", q("rel_c2"))).await;
        exec(b, &format!("DROP TABLE IF EXISTS {}", q("rel_p2"))).await;
        exec(
            b,
            &format!(
                "CREATE TABLE {} (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (b, a))",
                q("rel_p2")
            ),
        )
        .await;
        exec(
            b,
            &format!(
                "CREATE TABLE {} (x INTEGER, y INTEGER, FOREIGN KEY (y, x) REFERENCES {} (b, a))",
                q("rel_c2"),
                q("rel_p2")
            ),
        )
        .await;
        let r2 = b.table_relationships(eng.schema, "rel_c2").await.unwrap();
        assert_eq!(r2.outbound.len(), 1, "[{}] composite FK found", eng.name);
        assert_eq!(
            r2.outbound[0].src_cols,
            vec!["y", "x"],
            "[{}] composite src order",
            eng.name
        );
        assert_eq!(
            r2.outbound[0].dst_cols,
            vec!["b", "a"],
            "[{}] composite dst order",
            eng.name
        );
        exec(b, &format!("DROP TABLE IF EXISTS {}", q("rel_c2"))).await;
        exec(b, &format!("DROP TABLE IF EXISTS {}", q("rel_p2"))).await;
    }

    // DDL reconstruction: must contain CREATE TABLE (DuckDB may report a friendly
    // unsupported error instead — never a panic).
    match b.relation_ddl("table", eng.schema, "rel_child").await {
        Ok(ddl) => {
            assert!(
                ddl.to_lowercase().contains("create table"),
                "[{}] relation_ddl contains CREATE TABLE: {ddl}",
                eng.name
            );
            assert!(
                ddl.to_lowercase().contains("rel_child"),
                "[{}] relation_ddl names the table",
                eng.name
            );
        }
        Err(e) => assert!(
            eng.name == "duckdb",
            "[{}] relation_ddl errored: {}",
            eng.name,
            e.message
        ),
    }

    exec(b, &format!("DROP TABLE IF EXISTS {}", q("rel_child"))).await;
    exec(b, &format!("DROP TABLE IF EXISTS {}", q("rel_parent"))).await;
}

// --- script atomicity + exec-message + paged-export batteries (v0.4.0 sweep) ---

async fn sweep_battery(b: &mut Backend, eng: &Eng) {
    let q = eng.quote;

    // B0: a multi-statement DML script failing mid-way leaves NOTHING applied.
    exec(b, &format!("DROP TABLE IF EXISTS {}", q("atomic_t"))).await;
    exec(b, &format!("CREATE TABLE {} (a INTEGER)", q("atomic_t"))).await;
    let items = crate::script::split(&format!(
        "INSERT INTO {0} VALUES (1); INSERT INTO no_such_table_xyz VALUES (2); INSERT INTO {0} VALUES (3);",
        q("atomic_t")
    ));
    let res = b.run_script(&items, false).await;
    assert!(res.is_err(), "[{}] failing script must error", eng.name);
    let n = all(b, &format!("SELECT COUNT(*) FROM {}", q("atomic_t"))).await;
    assert_eq!(
        cell(&n[0], 0).as_deref(),
        Some("0"),
        "[{}] failed script rolled back fully",
        eng.name
    );

    // B0: the idle app-owned wrapper rejects transaction control. The command layer
    // routes manual scripts separately, without nesting this wrapper.
    let items2 = crate::script::split(&format!(
        "{}; INSERT INTO {} VALUES (7); COMMIT;",
        eng.begin,
        q("atomic_t")
    ));
    let tx_err = b.run_script(&items2, false).await.unwrap_err();
    assert!(
        tx_err.message.contains("transaction-control"),
        "[{}] clear transaction rejection: {}",
        eng.name,
        tx_err.message
    );
    let n2 = all(b, &format!("SELECT COUNT(*) FROM {}", q("atomic_t"))).await;
    assert_eq!(
        cell(&n2[0], 0).as_deref(),
        Some("0"),
        "[{}] rejected transaction applied nothing",
        eng.name
    );

    // B0: a failing trailing read is part of the same transaction. Leading writes
    // must not commit merely because the last statement was cursorable.
    let trailing = crate::script::split(&format!(
        "INSERT INTO {} VALUES (8); SELECT * FROM no_such_table_xyz;",
        q("atomic_t")
    ));
    assert!(
        b.run_script(&trailing, false).await.is_err(),
        "[{}] trailing read must fail the script",
        eng.name
    );
    let n3 = all(b, &format!("SELECT COUNT(*) FROM {}", q("atomic_t"))).await;
    assert_eq!(
        cell(&n3[0], 0).as_deref(),
        Some("0"),
        "[{}] failing trailing read rolled back leading write",
        eng.name
    );

    // B6: DDL exec message is exactly "OK" — no bogus "(0 rows affected)".
    b.rollback_cursor().await;
    let out = b
        .run_single(&format!("DROP TABLE {}", q("atomic_t")), 100, false)
        .await
        .unwrap();
    match out {
        QueryOutcome::Exec { message } => assert_eq!(message, "OK", "[{}] DDL message", eng.name),
        _ => panic!("[{}] DDL should be Exec", eng.name),
    }
}

/// B1: paged export crosses the 10k batch boundary with an exact row count.
async fn export_battery(b: &mut Backend, eng: &Eng) {
    let q = eng.quote;
    exec(b, &format!("DROP TABLE IF EXISTS {}", q("exp_t"))).await;
    exec(b, &format!("CREATE TABLE {} (n INTEGER)", q("exp_t"))).await;
    // Bulk-fill 25k rows in one statement. A 125×200 cross join keeps recursion
    // depth ≤200 (MySQL's cte_max_recursion_depth defaults to 1000).
    let fill = if eng.name == "mssql" {
        // T-SQL rejects a CTE inside a derived table, so number the rows of a
        // cross-joined catalog view instead.
        format!(
            "INSERT INTO {} (n) SELECT TOP 25000 CAST(ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS int) \
             FROM sys.all_objects a CROSS JOIN sys.all_objects b",
            q("exp_t")
        )
    } else {
        format!(
            "INSERT INTO {} SELECT (a.n - 1) * 200 + b.n FROM \
             (WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM g WHERE n < 125) SELECT n FROM g) AS a, \
             (WITH RECURSIVE h(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM h WHERE n < 200) SELECT n FROM h) AS b",
            q("exp_t")
        )
    };
    exec(b, &fill).await;
    let path = std::env::temp_dir().join(format!(
        "tusk_export_{}_{}.csv",
        eng.name,
        std::process::id()
    ));
    let p = path.to_string_lossy().to_string();
    let opts: crate::export::ExportOptions = serde_json::from_str(r#"{"format":"csv"}"#).unwrap();
    let n = crate::export::run_export_paged(
        b,
        &format!("SELECT n FROM {} ORDER BY n", q("exp_t")),
        &opts,
        &p,
        &std::sync::atomic::AtomicBool::new(false),
    )
    .await
    .unwrap_or_else(|e| panic!("[{}] paged export: {}", eng.name, e.message));
    assert_eq!(n, 25_000, "[{}] export row count", eng.name);
    let text = std::fs::read_to_string(&path).unwrap();
    assert_eq!(
        text.lines().count(),
        25_001,
        "[{}] csv lines incl. header",
        eng.name
    );
    assert!(text.starts_with("n"), "[{}] header row", eng.name);
    let _ = std::fs::remove_file(&path);

    // A valid zero-row query must still replace stale output with a valid file.
    std::fs::write(&path, "stale").unwrap();
    let n = crate::export::run_export_paged(
        b,
        &format!("SELECT n FROM {} WHERE 1 = 0", q("exp_t")),
        &opts,
        &p,
        &std::sync::atomic::AtomicBool::new(false),
    )
    .await
    .unwrap_or_else(|e| panic!("[{}] empty paged export: {}", eng.name, e.message));
    assert_eq!(n, 0, "[{}] empty export row count", eng.name);
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "n\n",
        "[{}] empty export replaces stale destination",
        eng.name
    );
    // A Cancel the engine never saw (it landed between two pages, where PostgreSQL
    // ignores a CancelRequest and DuckDB's next page clears the interrupt) still
    // stops the export through the cooperative flag, and the previous file stays.
    std::fs::write(&path, "stale").unwrap();
    let err = crate::export::run_export_paged(
        b,
        &format!("SELECT n FROM {} ORDER BY n", q("exp_t")),
        &opts,
        &p,
        &std::sync::atomic::AtomicBool::new(true),
    )
    .await
    .expect_err("a cancelled export fails");
    assert_eq!(err.cancelled, Some(true), "[{}] {}", eng.name, err.message);
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "stale",
        "[{}] a cancelled export leaves the destination alone",
        eng.name
    );
    let _ = std::fs::remove_file(&path);
    exec(b, &format!("DROP TABLE IF EXISTS {}", q("exp_t"))).await;
}

/// Database binary values stay reversible in the text protocol on every driver.
async fn binary_output_battery(b: &mut Backend, eng: &Eng) {
    let sql = match eng.name {
        "postgres" => "SELECT decode('00ff41', 'hex')",
        "duckdb" => "SELECT from_hex('00ff41')",
        "sqlite" => "SELECT X'00FF41'",
        "mysql" => "SELECT X'00FF41'",
        "mssql" => "SELECT 0x00FF41",
        _ => unreachable!(),
    };
    let rows = all(b, sql).await;
    assert_eq!(
        rows,
        vec![vec![Some("\\x00ff41".into())]],
        "[{}] binary text representation",
        eng.name
    );
}

/// Buffered/loaded export receives the backend dialect out-of-band; ExportOptions
/// remains the exact Rust mirror of the frontend payload.
async fn buffered_export_dialect_battery(eng: &Eng) {
    let options: crate::export::ExportOptions =
        serde_json::from_str(r#"{"format":"sql","sql":{"table":"ta`ble","includeCreate":true}}"#)
            .unwrap();
    let path = std::env::temp_dir().join(format!(
        "tusk_loaded_export_{}_{}.sql",
        eng.name,
        std::process::id()
    ));
    let path_str = path.to_str().expect("test temp path is UTF-8");
    crate::export::run_export_rows_for_dialect(
        &["co`l".into()],
        &[vec![Some("path\\name\nline".into())]],
        &options,
        eng.name,
        path_str,
    )
    .await
    .unwrap_or_else(|error| panic!("[{}] loaded export: {}", eng.name, error.message));
    let text = std::fs::read_to_string(&path).unwrap();
    let _ = std::fs::remove_file(path);
    match eng.name {
        "postgres" => assert!(text.contains("E'path\\\\name\nline'"), "{text}"),
        "duckdb" => assert!(
            text.contains("decode(from_hex('706174685c6e616d650a6c696e65'))"),
            "{text}"
        ),
        "sqlite" => assert!(
            text.contains("CAST(X'706174685c6e616d650a6c696e65' AS TEXT)"),
            "{text}"
        ),
        "mysql" => {
            assert!(
                text.contains("CREATE TABLE `ta``ble` (`co``l` text);"),
                "{text}"
            );
            assert!(
                text.contains("CONVERT(X'706174685c6e616d650a6c696e65' USING utf8mb4)"),
                "{text}"
            );
        }
        "mssql" => {
            assert!(
                text.contains("CREATE TABLE [ta`ble] ([co`l] nvarchar(max));"),
                "{text}"
            );
            // Backslashes are ordinary characters in T-SQL; only quotes double.
            assert!(text.contains("N'path\\name\nline'"), "{text}");
        }
        _ => unreachable!(),
    }
}

/// B1b: boolean export. `Backend::bool_columns` reports the server-typed bool columns
/// of an arbitrary query, and the export maps their driver tokens (PG `t`/`f`, DuckDB
/// `true`/`false`, SQLite `0`/`1`) to TRUE/FALSE — while a TEXT column holding the same
/// tokens passes through raw. MySQL is pinned to NO detection: `tinyint(1)` is a display
/// width the metadata drops, and the grid deliberately shows 0/1 there — export matches.
async fn bool_export_battery(b: &mut Backend, eng: &Eng) {
    let q = eng.quote;
    exec(b, &format!("DROP TABLE IF EXISTS {}", q("bool_t"))).await;
    exec(
        b,
        &format!(
            "CREATE TABLE {} (id INTEGER, flag {}, note VARCHAR(10))",
            q("bool_t"),
            eng.bool_type
        ),
    )
    .await;
    exec(
        b,
        &format!(
            "INSERT INTO {} VALUES (1, {}, 't'), (2, {}, 'f'), (3, NULL, 'x')",
            q("bool_t"),
            eng.bool_true,
            eng.bool_false
        ),
    )
    .await;

    let sql = format!("SELECT id, flag, note FROM {} ORDER BY id", q("bool_t"));
    let bc = b.bool_columns(&sql).await;
    if eng.name == "mysql" {
        assert!(
            bc.is_empty(),
            "[{}] tinyint(1) must NOT be detected (grid shows 0/1)",
            eng.name
        );
    } else {
        assert_eq!(
            bc,
            vec![1],
            "[{}] flag column detected as boolean",
            eng.name
        );
    }

    // Expression columns: typed by the binder on PG/DuckDB (prepare/DESCRIBE); SQLite
    // decltype is declared-columns-only, so an expression is (correctly) not detected.
    // `bit` is not a boolean in T-SQL, so there is no equivalent expression there.
    let expr_sql = if eng.name == "mssql" {
        format!("SELECT flag | flag AS x, id FROM {}", q("bool_t"))
    } else {
        format!("SELECT flag AND flag AS x, id FROM {}", q("bool_t"))
    };
    let expr = b.bool_columns(&expr_sql).await;
    match eng.name {
        "postgres" | "duckdb" => {
            assert_eq!(expr, vec![0], "[{}] bool expression detected", eng.name)
        }
        "sqlite" => assert!(
            expr.is_empty(),
            "[{}] expressions have no decltype",
            eng.name
        ),
        "mssql" => assert_eq!(
            expr,
            vec![0],
            "[{}] describe_first_result_set types the bit expression",
            eng.name
        ),
        _ => {}
    }

    // A garbage query must degrade to "no detection", never an error.
    assert!(b
        .bool_columns("SELECT * FROM no_such_table_xyz")
        .await
        .is_empty());

    // End-to-end: the detected set drives the CSV mapping through the paged exporter.
    let mut opts: crate::export::ExportOptions =
        serde_json::from_str(r#"{"format":"csv"}"#).unwrap();
    opts.bool_cols = bc;
    let path = std::env::temp_dir().join(format!(
        "tusk_boolexp_{}_{}.csv",
        eng.name,
        std::process::id()
    ));
    let p = path.to_string_lossy().to_string();
    crate::export::run_export_paged(
        b,
        &sql,
        &opts,
        &p,
        &std::sync::atomic::AtomicBool::new(false),
    )
    .await
    .unwrap_or_else(|e| panic!("[{}] bool export: {}", eng.name, e.message));
    let text = std::fs::read_to_string(&path).unwrap();
    let _ = std::fs::remove_file(&path);
    let want = if eng.name == "mysql" {
        "id,flag,note\n1,1,t\n2,0,f\n3,,x\n"
    } else {
        "id,flag,note\n1,TRUE,t\n2,FALSE,f\n3,,x\n"
    };
    assert_eq!(text, want, "[{}] bool CSV output", eng.name);
    exec(b, &format!("DROP TABLE IF EXISTS {}", q("bool_t"))).await;
}

/// Best-effort teardown of an FK cycle: drop the constraints, then the tables.
async fn reset(b: &mut Backend, statements: &[String]) {
    for sql in statements {
        b.rollback_cursor().await;
        let _ = b.run_single(sql, 100, false).await;
    }
}

/// Native backup → restore on a real engine, with the cases that only a server can
/// show: PostgreSQL `COPY … FROM stdin` data blocks and `setval`, MySQL's inline
/// foreign keys lifted into trailing ALTERs, and — on both — an FK CYCLE, which only
/// restores because every foreign key is emitted after all data.
async fn backup_restore_battery(b: &mut Backend, eng: &Eng) {
    let q = eng.quote;
    let a_name = q("bk_a");
    let b_name = q("bk_b");
    // Cleanup must drop the constraints first: a cycle makes either DROP TABLE fail.
    let drop_fk = |table: &str, name: &str| match eng.name {
        "mysql" => format!("ALTER TABLE {table} DROP FOREIGN KEY {}", q(name)),
        _ => format!("ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {}", q(name)),
    };
    let reset_sql = [
        drop_fk(&a_name, "bk_a_b_fk"),
        drop_fk(&b_name, "bk_b_a_fk"),
        format!("DROP TABLE IF EXISTS {a_name}"),
        format!("DROP TABLE IF EXISTS {b_name}"),
    ];
    reset(b, &reset_sql).await;

    exec(b, &format!("CREATE TABLE {a_name} (id INTEGER NOT NULL PRIMARY KEY, b_id INTEGER, note VARCHAR(80))")).await;
    exec(
        b,
        &format!("CREATE TABLE {b_name} (id INTEGER NOT NULL PRIMARY KEY, a_id INTEGER)"),
    )
    .await;
    exec(
        b,
        &format!(
            "ALTER TABLE {a_name} ADD CONSTRAINT {} FOREIGN KEY (b_id) REFERENCES {b_name} (id)",
            q("bk_a_b_fk")
        ),
    )
    .await;
    exec(
        b,
        &format!(
            "ALTER TABLE {b_name} ADD CONSTRAINT {} FOREIGN KEY (a_id) REFERENCES {a_name} (id)",
            q("bk_b_a_fk")
        ),
    )
    .await;
    // Insert with NULL references, then close the cycle with UPDATEs.
    exec(
        b,
        &format!(
            "INSERT INTO {a_name} (id, b_id, note) VALUES (1, NULL, 'it''s a \"quoted\" note')"
        ),
    )
    .await;
    exec(
        b,
        &format!("INSERT INTO {a_name} (id, b_id, note) VALUES (2, NULL, NULL)"),
    )
    .await;
    exec(b, &format!("INSERT INTO {b_name} (id, a_id) VALUES (1, 1)")).await;
    exec(b, &format!("UPDATE {a_name} SET b_id = 1 WHERE id = 1")).await;

    let schema = eng.schema.to_string();
    let options = crate::backup::BackupOptions {
        scope: "tables".into(),
        schemas: Vec::new(),
        tables: vec![
            crate::backup::QualifiedName {
                schema: schema.clone(),
                name: "bk_a".into(),
            },
            crate::backup::QualifiedName {
                schema,
                name: "bk_b".into(),
            },
        ],
        content: "all".into(),
        include_drop: true,
        single_transaction: false,
    };
    let path = std::env::temp_dir().join(format!(
        "tusk_backup_{}_{}.sql",
        eng.name,
        std::process::id()
    ));
    let p = path.to_string_lossy().to_string();
    let flag = std::sync::atomic::AtomicBool::new(false);
    let summary = crate::backup::run_backup(b, "conformance", &options, &p, &flag, &mut |_| {})
        .await
        .unwrap_or_else(|e| panic!("[{}] backup: {}", eng.name, e.message));
    assert_eq!(summary.rows, 3, "[{}] rows dumped", eng.name);
    let text = std::fs::read_to_string(&path).unwrap();

    // Data representation per engine, and FK statements strictly AFTER the data.
    let data_at = if eng.name == "postgres" {
        assert!(
            text.contains("FROM stdin;"),
            "[{}] COPY blocks:\n{text}",
            eng.name
        );
        assert!(text.contains("\n\\.\n"), "[{}] COPY terminator", eng.name);
        text.find("FROM stdin;").unwrap()
    } else {
        assert!(
            text.contains("INSERT INTO"),
            "[{}] INSERTs:\n{text}",
            eng.name
        );
        text.find("INSERT INTO").unwrap()
    };
    let fk_at = text
        .find("ADD CONSTRAINT")
        .unwrap_or_else(|| panic!("[{}] foreign keys deferred to ALTERs:\n{text}", eng.name));
    assert!(
        fk_at > data_at,
        "[{}] foreign keys must follow all data:\n{text}",
        eng.name
    );

    // Restore into the same database after removing the cycle by hand.
    reset(b, &reset_sql).await;
    let restored = crate::backup::run_restore(
        b,
        eng.engine,
        &p,
        &crate::backup::RestoreOptions {
            stop_on_error: true,
            single_transaction: false,
        },
        &std::sync::atomic::AtomicBool::new(false),
        &mut |_| {},
    )
    .await
    .unwrap_or_else(|e| panic!("[{}] restore: {}", eng.name, e.message));
    assert_eq!(
        restored.statements_failed, 0,
        "[{}] restore errors: {:?}",
        eng.name, restored.first_error
    );
    let rows = all(
        b,
        &format!("SELECT id, b_id, note FROM {a_name} ORDER BY id"),
    )
    .await;
    assert_eq!(
        cell(&rows[0], 1).as_deref(),
        Some("1"),
        "[{}] cycle restored",
        eng.name
    );
    assert_eq!(
        cell(&rows[0], 2).as_deref(),
        Some("it's a \"quoted\" note"),
        "[{}] quoted text restored",
        eng.name
    );
    assert_eq!(cell(&rows[1], 2), None, "[{}] NULL restored", eng.name);
    assert_eq!(
        cell(
            &all(b, &format!("SELECT COUNT(*) FROM {b_name}")).await[0],
            0
        )
        .as_deref(),
        Some("1"),
        "[{}] second table restored",
        eng.name
    );

    // `single_transaction`, on both sides. The wrapper has to open with the engine's
    // real transaction statement: T-SQL's bare `BEGIN` opens a statement BLOCK, so a
    // dump (or a restore) using it replays in autocommit while claiming to be wrapped,
    // and the trailing COMMIT has nothing to commit.
    if b.capabilities().transactional_ddl {
        let expected_begin = if eng.name == "mssql" {
            "BEGIN TRANSACTION;"
        } else {
            "BEGIN;"
        };
        let wrapped_options = crate::backup::BackupOptions {
            single_transaction: true,
            ..options.clone()
        };
        crate::backup::run_backup(b, "conformance", &wrapped_options, &p, &flag, &mut |_| {})
            .await
            .unwrap_or_else(|e| panic!("[{}] wrapped backup: {}", eng.name, e.message));
        let text = std::fs::read_to_string(&path).unwrap();
        let begin_at = text.find(expected_begin).unwrap_or_else(|| {
            panic!(
                "[{}] a single-transaction dump must open with {expected_begin}:\n{text}",
                eng.name
            )
        });
        let commit_at = text
            .find("COMMIT;")
            .unwrap_or_else(|| panic!("[{}] wrapped dump commits:\n{text}", eng.name));
        assert!(
            commit_at > begin_at,
            "[{}] COMMIT must follow the opener:\n{text}",
            eng.name
        );
        // The engine has to actually accept the opener it was handed.
        reset(b, &reset_sql).await;
        let restored = crate::backup::run_restore(
            b,
            eng.engine,
            &p,
            &crate::backup::RestoreOptions {
                stop_on_error: true,
                single_transaction: false,
            },
            &std::sync::atomic::AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap_or_else(|e| panic!("[{}] wrapped restore: {}", eng.name, e.message));
        assert_eq!(
            restored.statements_failed, 0,
            "[{}] wrapped restore errors: {:?}",
            eng.name, restored.first_error
        );

        // …and restore's OWN opener, used when the dump does not wrap itself.
        crate::backup::run_backup(b, "conformance", &options, &p, &flag, &mut |_| {})
            .await
            .unwrap_or_else(|e| panic!("[{}] plain backup: {}", eng.name, e.message));
        reset(b, &reset_sql).await;
        let restored = crate::backup::run_restore(
            b,
            eng.engine,
            &p,
            &crate::backup::RestoreOptions {
                stop_on_error: true,
                single_transaction: true,
            },
            &std::sync::atomic::AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap_or_else(|e| panic!("[{}] single-transaction restore: {}", eng.name, e.message));
        assert_eq!(
            restored.statements_failed, 0,
            "[{}] single-transaction restore errors: {:?}",
            eng.name, restored.first_error
        );
        assert!(
            restored.committed,
            "[{}] a clean single-transaction restore commits",
            eng.name
        );
        assert_eq!(
            cell(
                &all(b, &format!("SELECT COUNT(*) FROM {a_name}")).await[0],
                0
            )
            .as_deref(),
            Some("2"),
            "[{}] single-transaction restore landed its rows",
            eng.name
        );
    }

    // PostgreSQL only: a schema-scoped dump carries CREATE SEQUENCE + setval, so a
    // serial column continues where it left off instead of colliding on restore.
    if eng.name == "postgres" {
        exec(b, "DROP SCHEMA IF EXISTS tusk_bk CASCADE").await;
        exec(b, "CREATE SCHEMA tusk_bk").await;
        exec(
            b,
            "CREATE TABLE tusk_bk.counter (id serial PRIMARY KEY, label text)",
        )
        .await;
        exec(
            b,
            "INSERT INTO tusk_bk.counter (label) VALUES ('a'), ('b'), ('c')",
        )
        .await;
        let seq_options = crate::backup::BackupOptions {
            scope: "schemas".into(),
            schemas: vec!["tusk_bk".into()],
            tables: Vec::new(),
            content: "all".into(),
            include_drop: true,
            single_transaction: false,
        };
        crate::backup::run_backup(b, "conformance", &seq_options, &p, &flag, &mut |_| {})
            .await
            .unwrap_or_else(|e| panic!("[pg] sequence backup: {}", e.message));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("CREATE SEQUENCE"), "sequence DDL:\n{text}");
        assert!(text.contains("pg_catalog.setval("), "setval:\n{text}");
        exec(b, "DROP SCHEMA tusk_bk CASCADE").await;
        let restored = crate::backup::run_restore(
            b,
            eng.engine,
            &p,
            &crate::backup::RestoreOptions {
                stop_on_error: true,
                single_transaction: false,
            },
            &std::sync::atomic::AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap_or_else(|e| panic!("[pg] sequence restore: {}", e.message));
        assert_eq!(
            restored.statements_failed, 0,
            "[pg] sequence restore errors: {:?}",
            restored.first_error
        );
        exec(b, "INSERT INTO tusk_bk.counter (label) VALUES ('d')").await;
        let rows = all(b, "SELECT id FROM tusk_bk.counter ORDER BY id DESC LIMIT 1").await;
        assert_eq!(
            cell(&rows[0], 0).as_deref(),
            Some("4"),
            "the restored sequence continues past the dumped rows"
        );
        exec(b, "DROP SCHEMA tusk_bk CASCADE").await;
    }

    // SQL Server only: an IDENTITY column refuses an explicit value (error 544) unless
    // IDENTITY_INSERT is on, so the dump must bracket the table's data with it —
    // otherwise the restore of every identity table fails.
    if eng.name == "mssql" {
        let ident = format!("{}.{}", q(eng.schema), q("bk_ident"));
        reset(b, &[format!("DROP TABLE IF EXISTS {ident}")]).await;
        exec(
            b,
            &format!(
                "CREATE TABLE {ident} (id INTEGER IDENTITY(1,1) PRIMARY KEY, label VARCHAR(20))"
            ),
        )
        .await;
        exec(b, &format!("INSERT INTO {ident} (label) VALUES ('a')")).await;
        exec(b, &format!("INSERT INTO {ident} (label) VALUES ('b')")).await;
        let ident_options = crate::backup::BackupOptions {
            scope: "tables".into(),
            schemas: Vec::new(),
            tables: vec![crate::backup::QualifiedName {
                schema: eng.schema.to_string(),
                name: "bk_ident".into(),
            }],
            content: "all".into(),
            include_drop: true,
            single_transaction: false,
        };
        crate::backup::run_backup(b, "conformance", &ident_options, &p, &flag, &mut |_| {})
            .await
            .unwrap_or_else(|e| panic!("[mssql] identity backup: {}", e.message));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("SET IDENTITY_INSERT") && text.contains("ON;") && text.contains("OFF;"),
            "[mssql] identity data block is bracketed:\n{text}"
        );
        reset(b, &[format!("DROP TABLE IF EXISTS {ident}")]).await;
        let restored = crate::backup::run_restore(
            b,
            eng.engine,
            &p,
            &crate::backup::RestoreOptions {
                stop_on_error: true,
                single_transaction: false,
            },
            &std::sync::atomic::AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap_or_else(|e| panic!("[mssql] identity restore: {}", e.message));
        assert_eq!(
            restored.statements_failed, 0,
            "[mssql] identity restore errors: {:?}",
            restored.first_error
        );
        let rows = all(b, &format!("SELECT id, label FROM {ident} ORDER BY id")).await;
        assert_eq!(rows.len(), 2, "[mssql] identity rows restored");
        assert_eq!(
            cell(&rows[0], 0).as_deref(),
            Some("1"),
            "[mssql] identity values round-trip instead of being renumbered"
        );
        reset(b, &[format!("DROP TABLE IF EXISTS {ident}")]).await;
    }

    let _ = std::fs::remove_file(&path);
    reset(b, &reset_sql).await;
}

/// Bulk file import (src/import.rs) against every engine: create-and-load, per-engine
/// conflict handling (PostgreSQL `ON CONFLICT`, MySQL `INSERT IGNORE` / `ON DUPLICATE
/// KEY UPDATE`, SQLite/DuckDB `INSERT OR IGNORE` / `OR REPLACE`), truncate-and-reload,
/// and rollback of a whole failed import.
/// The Docker-free half of `backup_restore_battery`. DuckDB and SQLite have no
/// `ALTER TABLE … ADD CONSTRAINT`, so their foreign keys stay inline in the dump
/// (`deferrable_fks` is PG/MySQL/SQL Server only) and tables must be dumped in
/// dependency order; SQLite additionally emits `PRAGMA foreign_keys = OFF` before
/// anything runs. Neither can express an FK cycle inline, so this battery uses a
/// one-way reference and pins the ordering rule instead.
async fn embedded_backup_restore_battery(b: &mut Backend, eng: &Eng) {
    let q = eng.quote;
    let a_name = q("bk_a");
    let b_name = q("bk_b");
    // `bk_a` references `bk_b`: drop the referrer first (DuckDB refuses to drop a
    // referenced table).
    let reset_sql = [
        format!("DROP TABLE IF EXISTS {a_name}"),
        format!("DROP TABLE IF EXISTS {b_name}"),
    ];
    reset(b, &reset_sql).await;
    exec(
        b,
        &format!("CREATE TABLE {b_name} (id INTEGER NOT NULL PRIMARY KEY)"),
    )
    .await;
    exec(
        b,
        &format!(
            "CREATE TABLE {a_name} (id INTEGER NOT NULL PRIMARY KEY, b_id INTEGER REFERENCES {b_name} (id), note VARCHAR(80))"
        ),
    )
    .await;
    exec(b, &format!("INSERT INTO {b_name} (id) VALUES (1)")).await;
    exec(
        b,
        &format!("INSERT INTO {a_name} (id, b_id, note) VALUES (1, 1, 'it''s a \"quoted\" note')"),
    )
    .await;
    exec(
        b,
        &format!("INSERT INTO {a_name} (id, b_id, note) VALUES (2, NULL, NULL)"),
    )
    .await;

    let schema = eng.schema.to_string();
    let options = crate::backup::BackupOptions {
        scope: "tables".into(),
        schemas: Vec::new(),
        tables: vec![
            crate::backup::QualifiedName {
                schema: schema.clone(),
                name: "bk_a".into(),
            },
            crate::backup::QualifiedName {
                schema,
                name: "bk_b".into(),
            },
        ],
        content: "all".into(),
        include_drop: true,
        single_transaction: false,
    };
    let path = std::env::temp_dir().join(format!(
        "tusk_backup_{}_{}.sql",
        eng.name,
        std::process::id()
    ));
    let p = path.to_string_lossy().to_string();
    let flag = std::sync::atomic::AtomicBool::new(false);
    let summary = crate::backup::run_backup(b, "conformance", &options, &p, &flag, &mut |_| {})
        .await
        .unwrap_or_else(|e| panic!("[{}] backup: {}", eng.name, e.message));
    assert_eq!(summary.rows, 3, "[{}] rows dumped", eng.name);
    let text = std::fs::read_to_string(&path).unwrap();

    assert!(
        text.contains("INSERT INTO"),
        "[{}] INSERTs:\n{text}",
        eng.name
    );
    assert!(
        !text.lines().any(|line| line.starts_with("ALTER TABLE")),
        "[{}] embedded engines keep foreign keys inline:\n{text}",
        eng.name
    );
    assert!(
        text.contains("REFERENCES"),
        "[{}] the inline foreign key is carried:\n{text}",
        eng.name
    );
    let create_b = text
        .find(&format!("CREATE TABLE {b_name}"))
        .or_else(|| text.find("CREATE TABLE bk_b"))
        .unwrap_or_else(|| panic!("[{}] CREATE for the referenced table:\n{text}", eng.name));
    let create_a = text
        .find(&format!("CREATE TABLE {a_name}"))
        .or_else(|| text.find("CREATE TABLE bk_a"))
        .unwrap_or_else(|| panic!("[{}] CREATE for the referrer:\n{text}", eng.name));
    assert!(
        create_b < create_a,
        "[{}] the referenced table is created first:\n{text}",
        eng.name
    );
    if eng.name == "sqlite" {
        assert!(
            text.contains("PRAGMA foreign_keys = OFF"),
            "[{}] foreign-key enforcement is suspended for the restore:\n{text}",
            eng.name
        );
    }

    reset(b, &reset_sql).await;
    let restored = crate::backup::run_restore(
        b,
        eng.engine,
        &p,
        &crate::backup::RestoreOptions {
            stop_on_error: true,
            single_transaction: false,
        },
        &std::sync::atomic::AtomicBool::new(false),
        &mut |_| {},
    )
    .await
    .unwrap_or_else(|e| panic!("[{}] restore: {}", eng.name, e.message));
    assert_eq!(
        restored.statements_failed, 0,
        "[{}] restore errors: {:?}",
        eng.name, restored.first_error
    );
    let rows = all(
        b,
        &format!("SELECT id, b_id, note FROM {a_name} ORDER BY id"),
    )
    .await;
    assert_eq!(
        cell(&rows[0], 1).as_deref(),
        Some("1"),
        "[{}] reference restored",
        eng.name
    );
    assert_eq!(
        cell(&rows[0], 2).as_deref(),
        Some("it's a \"quoted\" note"),
        "[{}] quoted text restored",
        eng.name
    );
    assert_eq!(cell(&rows[1], 2), None, "[{}] NULL restored", eng.name);

    // Both embedded engines have transactional DDL: a single-transaction restore commits.
    reset(b, &reset_sql).await;
    let restored = crate::backup::run_restore(
        b,
        eng.engine,
        &p,
        &crate::backup::RestoreOptions {
            stop_on_error: true,
            single_transaction: true,
        },
        &std::sync::atomic::AtomicBool::new(false),
        &mut |_| {},
    )
    .await
    .unwrap_or_else(|e| panic!("[{}] single-transaction restore: {}", eng.name, e.message));
    assert_eq!(
        restored.statements_failed, 0,
        "[{}] single-transaction restore errors: {:?}",
        eng.name, restored.first_error
    );
    assert!(
        restored.committed,
        "[{}] a clean single-transaction restore commits",
        eng.name
    );
    assert_eq!(
        cell(
            &all(b, &format!("SELECT COUNT(*) FROM {a_name}")).await[0],
            0
        )
        .as_deref(),
        Some("2"),
        "[{}] single-transaction restore landed its rows",
        eng.name
    );
    reset(b, &reset_sql).await;
    let _ = std::fs::remove_file(&path);
}

async fn import_battery(b: &mut Backend, eng: &Eng) {
    use crate::import::{run_import, ImportColumn, ImportOptions, ImportRequest, ImportTarget};
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    let q = |n: &str| (eng.quote)(n);
    let table = format!("{}.{}", q(eng.schema), q("imp_t"));
    let cancel = Arc::new(AtomicBool::new(false));

    // SQL Server has no import path yet. Pin the REFUSAL (the manual, the Explorer
    // tooltip and the hardening notes all say so) instead of running a battery that
    // asserts support the driver does not have.
    if eng.name == "mssql" {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("unsupported.csv");
        std::fs::write(&path, "id\n1\n").unwrap();
        let mut options: ImportOptions = serde_json::from_str(r#"{"format":"csv"}"#).unwrap();
        options.source_columns = vec!["id".to_string()];
        let error = run_import(
            b,
            &ImportRequest {
                path: path.to_string_lossy().to_string(),
                options,
                target: ImportTarget {
                    schema: eng.schema.to_string(),
                    table: "imp_t".to_string(),
                    create: true,
                    truncate: false,
                    conflict: "error".to_string(),
                    key_columns: Vec::new(),
                    columns: vec![ImportColumn {
                        source: 0,
                        target: "id".into(),
                        kind: "integer".into(),
                        empty_as_null: true,
                    }],
                },
            },
            &cancel,
            |_| {},
        )
        .await
        .expect_err("import is refused on SQL Server");
        assert!(
            error.message.contains("SQL Server"),
            "[mssql] import refusal must name the engine: {}",
            error.message
        );
        return;
    }

    let dir = tempfile::tempdir().unwrap();
    let write = |name: &str, body: &str| {
        let path = dir.path().join(name);
        std::fs::write(&path, body).unwrap();
        path.to_string_lossy().to_string()
    };
    let base = write(
        "base.csv",
        "id,name,flag,amount\n1,\"o'brien, jr\",true,12.5\n2,,no,\n3,ünïcode,1,-0.25\n",
    );
    let overlap = write(
        "overlap.csv",
        "id,name,flag,amount\n1,changed,false,1\n4,new,yes,2\n",
    );
    let broken = write(
        "broken.csv",
        "id,name,flag,amount\n5,ok,true,1\nnope,bad,true,1\n",
    );

    let options = |path: &str| {
        let mut o: ImportOptions = serde_json::from_str(r#"{"format":"csv"}"#).unwrap();
        o.source_columns = ["id", "name", "flag", "amount"]
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        let _ = path;
        o
    };
    let target = |create: bool, truncate: bool, conflict: &str| ImportTarget {
        schema: eng.schema.to_string(),
        table: "imp_t".to_string(),
        create,
        truncate,
        conflict: conflict.to_string(),
        key_columns: vec!["id".to_string()],
        columns: vec![
            ImportColumn {
                source: 0,
                target: "id".into(),
                kind: "integer".into(),
                empty_as_null: false,
            },
            ImportColumn {
                source: 1,
                target: "name".into(),
                kind: "text".into(),
                empty_as_null: true,
            },
            ImportColumn {
                source: 2,
                target: "flag".into(),
                kind: "boolean".into(),
                empty_as_null: true,
            },
            ImportColumn {
                source: 3,
                target: "amount".into(),
                kind: "numeric".into(),
                empty_as_null: true,
            },
        ],
    };
    let request = |path: &str, t: ImportTarget| ImportRequest {
        path: path.to_string(),
        options: options(path),
        target: t,
    };

    let _ = b
        .run_single(&format!("DROP TABLE IF EXISTS {table}"), 10, false)
        .await;
    b.rollback_cursor().await;

    // 1. Create the table from the mapping and load it.
    let summary = run_import(
        b,
        &request(&base, target(true, false, "error")),
        &cancel,
        |_| {},
    )
    .await
    .unwrap_or_else(|e| panic!("[{}] create import: {}", eng.name, e.message));
    assert_eq!(summary.rows_read, 3, "[{}] rows read", eng.name);

    let rows = all(
        b,
        &format!("SELECT id, name, flag, amount FROM {table} ORDER BY id"),
    )
    .await;
    assert_eq!(rows.len(), 3, "[{}] loaded rows", eng.name);
    assert_eq!(
        cell(&rows[0], 1).as_deref(),
        Some("o'brien, jr"),
        "[{}] quoted value",
        eng.name
    );
    assert_eq!(
        cell(&rows[1], 1),
        None,
        "[{}] empty string became NULL",
        eng.name
    );
    assert_eq!(
        cell(&rows[2], 1).as_deref(),
        Some("ünïcode"),
        "[{}] unicode",
        eng.name
    );
    assert_eq!(
        cell(&rows[1], 3),
        None,
        "[{}] empty numeric became NULL",
        eng.name
    );
    let truthy = |v: Option<String>| matches!(v.as_deref(), Some("t" | "true" | "1" | "TRUE"));
    assert!(truthy(cell(&rows[0], 2)), "[{}] boolean TRUE", eng.name);
    assert!(!truthy(cell(&rows[1], 2)), "[{}] boolean FALSE", eng.name);
    let amount: f64 = cell(&rows[0], 3).unwrap().parse().unwrap();
    assert!((amount - 12.5).abs() < 1e-9, "[{}] numeric value", eng.name);

    // A unique key so the conflict modes have something to collide with. (Created after
    // the load so the engine-specific PK syntax stays out of the import path.)
    // SQLite attaches the schema to the INDEX name, not the table; PostgreSQL forbids a
    // schema-qualified index name. Only SQLite needs the divergent form here.
    let unique_index = if eng.name == "sqlite" {
        format!(
            "CREATE UNIQUE INDEX {} ON {} ({})",
            q("imp_t_ix"),
            q("imp_t"),
            q("id")
        )
    } else {
        format!(
            "CREATE UNIQUE INDEX {} ON {table} ({})",
            q("imp_t_ix"),
            q("id")
        )
    };
    exec(b, &unique_index).await;

    // 2. conflict = ignore — the colliding row keeps its original value.
    run_import(
        b,
        &request(&overlap, target(false, false, "ignore")),
        &cancel,
        |_| {},
    )
    .await
    .unwrap_or_else(|e| panic!("[{}] ignore import: {}", eng.name, e.message));
    let rows = all(b, &format!("SELECT id, name FROM {table} ORDER BY id")).await;
    assert_eq!(rows.len(), 4, "[{}] ignore added exactly one row", eng.name);
    assert_eq!(
        cell(&rows[0], 1).as_deref(),
        Some("o'brien, jr"),
        "[{}] ignore kept the original",
        eng.name
    );

    // 3. conflict = update — the colliding row is replaced.
    run_import(
        b,
        &request(&overlap, target(false, false, "update")),
        &cancel,
        |_| {},
    )
    .await
    .unwrap_or_else(|e| panic!("[{}] upsert import: {}", eng.name, e.message));
    let rows = all(b, &format!("SELECT id, name FROM {table} ORDER BY id")).await;
    assert_eq!(rows.len(), 4, "[{}] upsert added no rows", eng.name);
    assert_eq!(
        cell(&rows[0], 1).as_deref(),
        Some("changed"),
        "[{}] upsert replaced the row",
        eng.name
    );

    // 4. truncate + reload leaves exactly the file's rows.
    run_import(
        b,
        &request(&base, target(false, true, "error")),
        &cancel,
        |_| {},
    )
    .await
    .unwrap_or_else(|e| panic!("[{}] truncate import: {}", eng.name, e.message));
    let rows = all(b, &format!("SELECT COUNT(*) FROM {table}")).await;
    assert_eq!(
        cell(&rows[0], 0).as_deref(),
        Some("3"),
        "[{}] truncate + reload",
        eng.name
    );

    // 5. A bad value fails the whole import; nothing from it lands.
    let err = run_import(
        b,
        &request(&broken, target(false, false, "error")),
        &cancel,
        |_| {},
    )
    .await
    .unwrap_err();
    assert!(
        err.message.contains("not a valid integer"),
        "[{}] {}",
        eng.name,
        err.message
    );
    let rows = all(b, &format!("SELECT COUNT(*) FROM {table}")).await;
    assert_eq!(
        cell(&rows[0], 0).as_deref(),
        Some("3"),
        "[{}] failed import rolled back",
        eng.name
    );

    // 6. A create-and-load that fails mid-load: the ROWS must never survive. MySQL
    //    commits DDL immediately, so its (deliberately pre-transaction) CREATE stays and
    //    the error says so; the other three engines roll the table back with the rows.
    let fresh = format!("{}.{}", q(eng.schema), q("imp_fresh"));
    let _ = b
        .run_single(&format!("DROP TABLE IF EXISTS {fresh}"), 10, false)
        .await;
    b.rollback_cursor().await;
    let mut create_fail = target(true, false, "error");
    create_fail.table = "imp_fresh".to_string();
    let err = run_import(b, &request(&broken, create_fail), &cancel, |_| {})
        .await
        .unwrap_err();
    assert!(
        err.message.contains("not a valid integer"),
        "[{}] {}",
        eng.name,
        err.message
    );
    b.rollback_cursor().await;
    let loaded = b
        .run_single(&format!("SELECT COUNT(*) FROM {fresh}"), 10, true)
        .await;
    if eng.name == "mysql" {
        assert!(
            err.message.contains("still exists"),
            "[{}] MySQL must report the separately committed CREATE: {}",
            eng.name,
            err.message
        );
        match loaded {
            Ok(crate::db::QueryOutcome::Rows { rows, .. }) => assert_eq!(
                cell(&rows[0], 0).as_deref(),
                Some("0"),
                "[{}] the rows must still roll back",
                eng.name
            ),
            other => panic!(
                "[{}] expected the committed empty table: {other:?}",
                eng.name
            ),
        }
        b.rollback_cursor().await;
        exec(b, &format!("DROP TABLE {fresh}")).await;
    } else {
        assert!(
            loaded.is_err(),
            "[{}] a failed create import must leave no table",
            eng.name
        );
    }
    b.rollback_cursor().await;

    exec(b, &format!("DROP TABLE {table}")).await;
}

// --- entry points ---

#[tokio::test]
async fn conformance_duckdb() {
    let (mut b, _v) = connect(&duck_cfg()).await.unwrap();
    let eng = Eng {
        name: "duckdb",
        schema: "main",
        quote: dq,
        engine: TransactionEngine::DuckDb,
        ..STANDARD_TYPES
    };
    run_battery(&mut b, &eng).await;
    relationship_battery(&mut b, &eng).await;
    sweep_battery(&mut b, &eng).await;
    export_battery(&mut b, &eng).await;
    bool_export_battery(&mut b, &eng).await;
    import_battery(&mut b, &eng).await;
    binary_output_battery(&mut b, &eng).await;
    buffered_export_dialect_battery(&eng).await;
    embedded_backup_restore_battery(&mut b, &eng).await;
    transaction_battery(&duck_cfg(), &eng).await;
}

#[tokio::test]
async fn conformance_sqlite() {
    let (mut b, _v) = connect(&sqlite_cfg()).await.unwrap();
    let eng = Eng {
        name: "sqlite",
        schema: "main",
        quote: dq,
        engine: TransactionEngine::Sqlite,
        ..STANDARD_TYPES
    };
    run_battery(&mut b, &eng).await;
    relationship_battery(&mut b, &eng).await;
    sweep_battery(&mut b, &eng).await;
    export_battery(&mut b, &eng).await;
    bool_export_battery(&mut b, &eng).await;
    import_battery(&mut b, &eng).await;
    binary_output_battery(&mut b, &eng).await;
    buffered_export_dialect_battery(&eng).await;
    embedded_backup_restore_battery(&mut b, &eng).await;
    transaction_battery(&sqlite_cfg(), &eng).await;
}

#[tokio::test]
async fn conformance_postgres() {
    let Some(cfg) = pg_cfg() else {
        eprintln!("SKIP conformance_postgres (set TUSK_TEST_PG_PORT)");
        return;
    };
    let (mut b, _v) = connect(&cfg).await.expect("connect pg");
    let eng = Eng {
        name: "postgres",
        schema: "public",
        quote: dq,
        engine: TransactionEngine::Postgres,
        ..STANDARD_TYPES
    };
    run_battery(&mut b, &eng).await;
    relationship_battery(&mut b, &eng).await;
    sweep_battery(&mut b, &eng).await;
    export_battery(&mut b, &eng).await;
    bool_export_battery(&mut b, &eng).await;
    import_battery(&mut b, &eng).await;
    binary_output_battery(&mut b, &eng).await;
    buffered_export_dialect_battery(&eng).await;
    backup_restore_battery(&mut b, &eng).await;
    transaction_battery(&cfg, &eng).await;
}

#[tokio::test]
async fn conformance_mysql() {
    let Some(cfg) = mysql_cfg() else {
        eprintln!("SKIP conformance_mysql (set TUSK_TEST_MYSQL_PORT)");
        return;
    };
    let (mut b, _v) = connect(&cfg).await.expect("connect mysql");
    let eng = Eng {
        name: "mysql",
        schema: "test",
        quote: bt,
        engine: TransactionEngine::MySql,
        ..STANDARD_TYPES
    };
    run_battery(&mut b, &eng).await;
    relationship_battery(&mut b, &eng).await;
    sweep_battery(&mut b, &eng).await;
    export_battery(&mut b, &eng).await;
    bool_export_battery(&mut b, &eng).await;
    import_battery(&mut b, &eng).await;
    binary_output_battery(&mut b, &eng).await;
    buffered_export_dialect_battery(&eng).await;
    backup_restore_battery(&mut b, &eng).await;
    transaction_battery(&cfg, &eng).await;
}

#[tokio::test]
async fn conformance_mssql() {
    let Some(cfg) = mssql_cfg() else {
        eprintln!("SKIP conformance_mssql (set TUSK_TEST_MSSQL_PORT + TUSK_TEST_MSSQL_PASSWORD)");
        return;
    };
    let (mut b, _v) = connect(&cfg).await.expect("connect mssql");
    let eng = Eng {
        name: "mssql",
        schema: "dbo",
        quote: br,
        engine: TransactionEngine::MsSql,
        text_type: "nvarchar(max)",
        timestamp_type: "datetime2",
        bool_type: "bit",
        bool_true: "1",
        bool_false: "0",
        begin: "BEGIN TRANSACTION",
    };
    run_battery(&mut b, &eng).await;
    relationship_battery(&mut b, &eng).await;
    sweep_battery(&mut b, &eng).await;
    export_battery(&mut b, &eng).await;
    bool_export_battery(&mut b, &eng).await;
    import_battery(&mut b, &eng).await;
    binary_output_battery(&mut b, &eng).await;
    buffered_export_dialect_battery(&eng).await;
    backup_restore_battery(&mut b, &eng).await;
    transaction_battery(&cfg, &eng).await;
}

// --- read-only enforcement (production safety) ---

async fn readonly_embedded(driver: &str, ext: &str) {
    let dir = std::env::temp_dir();
    let path = dir.join(format!("tusk_ro_{}_{}.{ext}", driver, std::process::id()));
    let p = path.to_string_lossy().to_string();
    let _ = std::fs::remove_file(&path);
    let mut cfg = ConnectionConfig {
        driver: Some(driver.into()),
        path: Some(p.clone()),
        ..base()
    };
    {
        let (mut b, _) = connect(&cfg).await.unwrap();
        exec(&mut b, "CREATE TABLE t (a INTEGER)").await;
        exec(&mut b, "INSERT INTO t VALUES (1)").await;
    }
    cfg.read_only = true;
    let (mut b, _) = connect(&cfg).await.unwrap();
    let res = b.run_single("INSERT INTO t VALUES (2)", 100, false).await;
    assert!(res.is_err(), "{driver}: read-only must reject INSERT");
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn readonly_sqlite_blocks_writes() {
    readonly_embedded("sqlite", "sqlite").await;
}

#[tokio::test]
async fn readonly_duckdb_blocks_writes() {
    readonly_embedded("duckdb", "duckdb").await;
}

#[tokio::test]
async fn readonly_postgres_blocks_writes() {
    let Some(mut cfg) = pg_cfg() else {
        eprintln!("SKIP readonly_postgres (set TUSK_TEST_PG_PORT)");
        return;
    };
    cfg.read_only = true;
    let (mut b, _) = connect(&cfg).await.expect("connect pg ro");
    let res = b
        .run_single("CREATE TABLE tusk_ro_probe (a int)", 100, false)
        .await;
    assert!(res.is_err(), "read-only postgres must reject writes/DDL");
}

#[tokio::test]
async fn readonly_mysql_blocks_writes_after_pool_reuse() {
    let Some(mut cfg) = mysql_cfg() else {
        eprintln!("SKIP readonly_mysql (set TUSK_TEST_MYSQL_PORT)");
        return;
    };
    let (mut setup, _) = connect(&cfg).await.expect("connect mysql setup");
    let _ = setup
        .run_single("DROP TABLE IF EXISTS tusk_ro_page", 100, false)
        .await;
    setup
        .run_single("CREATE TABLE tusk_ro_page (a int)", 100, false)
        .await
        .unwrap();
    setup
        .run_single("INSERT INTO tusk_ro_page VALUES (1),(2),(3)", 100, false)
        .await
        .unwrap();
    drop(setup);
    cfg.read_only = true;
    let (mut b, _) = connect(&cfg).await.expect("connect mysql ro");
    b.run_single("SELECT 1", 100, false)
        .await
        .expect("first read");
    b.run_single("SELECT 2", 100, false)
        .await
        .expect("pooled read");
    let first = b
        .run_single_read_only("SELECT a FROM tusk_ro_page ORDER BY a", 2, true)
        .await
        .unwrap();
    assert!(matches!(first, QueryOutcome::Rows { ref rows, done: false, .. } if rows.len() == 2));
    let second = b.fetch_page(2).await.unwrap();
    assert_eq!(second.rows.len(), 1);
    assert!(second.done);
    let res = b
        .run_single("CREATE TABLE tusk_ro_probe (a int)", 100, false)
        .await;
    assert!(
        res.is_err(),
        "read-only mysql must reject writes after pooled connection reset"
    );
}

/// The SQL Server catalog queries are hand-written `sys.*` SQL that the shared batteries
/// never reach: sequences and routines in the tree, row/size estimates, triggers, view
/// DDL, and the paging shapes that must fall back to one bounded read.
#[tokio::test]
async fn mssql_introspection_and_paging_fallbacks() {
    let Some(cfg) = mssql_cfg() else {
        eprintln!("SKIP mssql_introspection (set TUSK_TEST_MSSQL_PORT + TUSK_TEST_MSSQL_PASSWORD)");
        return;
    };
    let (mut b, version) = connect(&cfg).await.expect("connect mssql");
    assert!(version.starts_with("SQL Server "), "{version}");

    for sql in [
        "DROP TRIGGER IF EXISTS dbo.intro_trg",
        "DROP VIEW IF EXISTS dbo.intro_v",
        "DROP TABLE IF EXISTS dbo.intro_t",
        "DROP SEQUENCE IF EXISTS dbo.intro_seq",
        "DROP PROCEDURE IF EXISTS dbo.intro_p",
        "CREATE TABLE dbo.intro_t (id int IDENTITY(1,1) PRIMARY KEY, label nvarchar(50) NOT NULL DEFAULT 'x', tag nvarchar(10) NULL, CONSTRAINT uq_intro UNIQUE (tag), CONSTRAINT ck_intro CHECK (LEN(label) > 0))",
        "CREATE INDEX ix_intro_label ON dbo.intro_t (label)",
        "CREATE SEQUENCE dbo.intro_seq AS int START WITH 1",
        "CREATE VIEW dbo.intro_v AS SELECT id, label FROM dbo.intro_t",
        "CREATE PROCEDURE dbo.intro_p AS SELECT 1",
        "INSERT INTO dbo.intro_t (label, tag) VALUES ('a', 't1'), ('b', 't2'), ('c', NULL)",
        "EXEC sp_addextendedproperty @name = N'MS_Description', @value = N'intro table', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'intro_t'",
        "CREATE TRIGGER dbo.intro_trg ON dbo.intro_t AFTER INSERT AS SET NOCOUNT ON",
    ] {
        exec(&mut b, sql).await;
    }
    // Row estimates come from sys.dm_db_partition_stats, which lags DML slightly.
    exec(&mut b, "UPDATE STATISTICS dbo.intro_t").await;

    let tree = b.build_tree().await.expect("build_tree");
    assert_eq!(tree.database, "tusk_test", "connected database name");
    assert!(
        tree.databases.iter().any(|d| d == "master"),
        "sys.databases"
    );
    let dbo = tree
        .schemas
        .iter()
        .find(|s| s.name == "dbo")
        .expect("dbo schema");
    assert!(
        !tree
            .schemas
            .iter()
            .any(|s| s.name == "sys" || s.name == "db_owner"),
        "system and fixed-role schemas stay out of the sidebar"
    );
    let table = dbo
        .tables
        .iter()
        .find(|t| t.name == "intro_t")
        .expect("intro_t stub");
    assert_eq!(table.comment.as_deref(), Some("intro table"));
    assert_eq!(table.rows, Some(3), "row estimate");
    assert!(table.size.is_some(), "table size estimate");
    let view = dbo
        .views
        .iter()
        .find(|v| v.name == "intro_v")
        .expect("intro_v stub");
    assert!(view.size.is_none(), "views report no size");
    assert!(dbo.sequences.iter().any(|s| s == "intro_seq"));
    assert!(dbo
        .functions
        .iter()
        .any(|f| f.name == "intro_p" && f.returns == "procedure"));

    let detail = b
        .table_detail("dbo", "intro_t")
        .await
        .expect("table_detail");
    let label = detail
        .columns
        .iter()
        .find(|c| c.name == "label")
        .expect("label column");
    assert_eq!(label.data_type, "nvarchar(50)", "length-qualified type");
    assert!(!label.nullable);
    assert!(label.default.is_some(), "default constraint definition");
    assert!(detail.columns.iter().any(|c| c.name == "id" && c.is_pk));
    assert!(detail.indexes.iter().any(|i| i.name == "ix_intro_label"));
    let kinds: Vec<&str> = detail.constraints.iter().map(|c| c.kind.as_str()).collect();
    for kind in ["primary_key", "unique", "check"] {
        assert!(kinds.contains(&kind), "constraint kinds {kinds:?}");
    }
    assert!(detail.triggers.iter().any(|t| t.name == "intro_trg"));

    let view_ddl = b
        .relation_ddl("view", "dbo", "intro_v")
        .await
        .expect("view ddl");
    assert!(view_ddl.contains("CREATE VIEW"), "{view_ddl}");
    let table_ddl = b
        .relation_ddl("table", "dbo", "intro_t")
        .await
        .expect("table ddl");
    for needle in [
        "CREATE TABLE [dbo].[intro_t]",
        "IDENTITY(1,1)",
        "NOT NULL",
        "CREATE INDEX",
    ] {
        assert!(
            table_ddl.contains(needle),
            "{needle} missing from:\n{table_ddl}"
        );
    }

    // SQL Server has no catalog of built-in functions, so the unknown-function lint
    // must stay off rather than fire on every builtin.
    assert!(b.list_functions().await.unwrap().is_empty());
    assert!(!b.permissions().await.unwrap().enforced);

    // Paging: an ordered statement keeps its order, an unordered one is still paged,
    // and a shape T-SQL cannot take an appended OFFSET/FETCH reads once with a note.
    let (ordered, fetches) = page_all(
        &mut b,
        "SELECT label FROM dbo.intro_t ORDER BY label DESC",
        2,
    )
    .await;
    assert_eq!(fetches, 2);
    assert_eq!(
        ordered.iter().map(|r| cell(r, 0)).collect::<Vec<_>>(),
        vec![Some("c".into()), Some("b".into()), Some("a".into())],
    );
    let (unordered, _) = page_all(&mut b, "SELECT label FROM dbo.intro_t", 2).await;
    assert_eq!(unordered.len(), 3);
    b.rollback_cursor().await;
    match b
        .run_single("SELECT TOP 2 label FROM dbo.intro_t", 1, true)
        .await
        .unwrap()
    {
        QueryOutcome::Rows {
            rows, done, note, ..
        } => {
            assert_eq!(rows.len(), 2, "TOP is read whole, not paged");
            assert!(done);
            assert!(note.is_some_and(|n| n.contains("one page")), "explains why");
        }
        QueryOutcome::Exec { message } => panic!("expected rows: {message}"),
    }

    for sql in [
        "DROP TRIGGER IF EXISTS dbo.intro_trg",
        "DROP VIEW IF EXISTS dbo.intro_v",
        "DROP PROCEDURE IF EXISTS dbo.intro_p",
        "DROP TABLE IF EXISTS dbo.intro_t",
        "DROP SEQUENCE IF EXISTS dbo.intro_seq",
    ] {
        exec(&mut b, sql).await;
    }
}

/// SQL Server offers no session-level read-only flag, so the uniform client guard is
/// the whole enforcement story there — pin that it actually blocks writes.
#[tokio::test]
async fn readonly_mssql_blocks_writes() {
    let Some(mut cfg) = mssql_cfg() else {
        eprintln!("SKIP readonly_mssql (set TUSK_TEST_MSSQL_PORT + TUSK_TEST_MSSQL_PASSWORD)");
        return;
    };
    cfg.read_only = true;
    let (mut b, _) = connect(&cfg).await.expect("connect mssql ro");
    b.run_single("SELECT 1", 100, true).await.expect("read");
    for write in [
        "CREATE TABLE tusk_ro_probe (a int)",
        "INSERT INTO tusk_ro_probe VALUES (1)",
        "SELECT * INTO tusk_ro_probe2 FROM sys.objects",
        // SQL Server NESTS block comments: the server sees only the DROP/DELETE, while
        // a non-nesting classifier read a SELECT/SHOW — and the `SHOW` head used to skip
        // the mutation scan entirely. This engine has no server-side read-only mode, so
        // the client guard IS the enforcement.
        "/*/* */ SHOW 1 */ DROP TABLE tusk_ro_probe",
        "/*/* */ SELECT 1 */ DELETE FROM tusk_ro_probe",
        "/* outer /* inner */ still comment */ TRUNCATE TABLE tusk_ro_probe",
    ] {
        assert!(
            b.run_single(write, 100, false).await.is_err(),
            "read-only mssql must reject: {write}"
        );
    }
    // …while a read whose column names merely LOOK like keywords still runs.
    b.run_single(
        "SELECT 1 AS [insert], 2 AS [delete], 3 AS [Update]",
        100,
        true,
    )
    .await
    .expect("bracketed identifiers are names, not keywords");
    // The read-only connection must not have created anything above.
    let probes = all(
        &mut b,
        "SELECT COUNT(*) FROM sys.objects WHERE name LIKE 'tusk_ro_probe%'",
    )
    .await;
    assert_eq!(
        cell(&probes[0], 0).as_deref(),
        Some("0"),
        "no write reached the server"
    );
}

// --- Postgres permission model (Epic 2): effective privileges of a limited role ---

#[tokio::test]
async fn permissions_postgres() {
    let Some(su) = pg_cfg() else {
        eprintln!("SKIP permissions_postgres (set TUSK_TEST_PG_PORT)");
        return;
    };
    let (mut a, _) = connect(&su).await.expect("connect superuser");
    // setup: a SELECT-only role on one table
    exec(&mut a, "DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tusk_limited') THEN EXECUTE 'DROP OWNED BY tusk_limited'; DROP ROLE tusk_limited; END IF; END $$").await;
    exec(&mut a, "CREATE ROLE tusk_limited LOGIN PASSWORD 'lim'").await;
    exec(&mut a, "DROP TABLE IF EXISTS perm_t").await;
    exec(&mut a, "CREATE TABLE perm_t (a int)").await;
    exec(&mut a, "GRANT SELECT ON perm_t TO tusk_limited").await;
    exec(&mut a, "GRANT USAGE ON SCHEMA public TO tusk_limited").await;

    // superuser: enforced, owns its table with full privileges
    let psu = a.permissions().await.unwrap();
    assert!(
        psu.enforced && psu.is_superuser,
        "postgres role is an enforced superuser"
    );
    assert!(
        psu.tables
            .iter()
            .any(|t| t.name == "perm_t" && t.select && t.is_owner),
        "owner sees its table with SELECT + ownership"
    );

    // limited role: SELECT but no writes/ownership, USAGE-not-CREATE on public, no DB/role
    let mut lim = su.clone();
    lim.user = "tusk_limited".into();
    lim.password = "lim".into();
    let (b, _) = connect(&lim).await.expect("connect limited role");
    let pl = b.permissions().await.unwrap();
    assert!(
        pl.enforced && !pl.is_superuser,
        "limited role is enforced, not superuser"
    );
    assert!(
        !pl.can_create_db && !pl.can_create_role,
        "limited can't create db/role"
    );
    let pt = pl
        .tables
        .iter()
        .find(|t| t.name == "perm_t")
        .expect("perm_t visible to limited");
    assert!(pt.select, "limited has SELECT");
    assert!(
        !pt.insert && !pt.update && !pt.delete,
        "limited lacks write privileges"
    );
    assert!(!pt.is_owner, "limited is not the owner");
    let pub_s = pl
        .schemas
        .iter()
        .find(|s| s.name == "public")
        .expect("public schema");
    assert!(
        pub_s.usage && !pub_s.create,
        "limited: USAGE not CREATE on public"
    );

    // cleanup
    exec(&mut a, "DROP OWNED BY tusk_limited").await;
    exec(&mut a, "DROP ROLE IF EXISTS tusk_limited").await;
    exec(&mut a, "DROP TABLE IF EXISTS perm_t").await;
}

// --- command layer (query_plan + lib.rs exec_plan: routing + the app-layer read-only
//     guard that protects engines with no server-side read-only, e.g. MySQL) ---

use crate::driver::ConnState;

async fn state(cfg: &ConnectionConfig, read_only: bool) -> ConnState {
    let (backend, _v) = connect(cfg).await.unwrap();
    ConnState::new(backend, read_only)
}

async fn command_exec(
    c: &mut ConnState,
    items: &[crate::script::Item],
) -> Result<QueryOutcome, crate::db::AppError> {
    // The same planner and the same failure settlement the command uses: a routing
    // rule or an error branch cannot pass here and fail in `run_query`.
    let plan = crate::query_plan::plan_items(
        items.to_vec(),
        c.transaction_engine(),
        &c.transaction,
        c.read_only,
    )?;
    match crate::exec_plan(c, &plan, 100, &None, "test-owner").await {
        Ok(outcome) => Ok(outcome),
        Err(error) => {
            c.settle_failure();
            Err(error.with_transaction(c.transaction.clone()))
        }
    }
}

async fn transaction_count(c: &mut ConnState, table: &str) -> usize {
    let sql = format!("SELECT COUNT(*) FROM {table}");
    match command_exec(c, &crate::script::parse(&sql).unwrap())
        .await
        .unwrap()
    {
        QueryOutcome::Rows { rows, .. } => rows[0][0].as_deref().unwrap().parse().unwrap(),
        QueryOutcome::Exec { .. } => panic!("count query returned no rows"),
    }
}

async fn transaction_battery(cfg: &ConnectionConfig, eng: &Eng) {
    use crate::db::{TransactionHealth, TransactionMode, TransactionState};

    let table = match eng.name {
        "mysql" => "`tusk_manual_tx`",
        "mssql" => "[tusk_manual_tx]",
        _ => "\"tusk_manual_tx\"",
    };
    let mssql = eng.name == "mssql";
    // T-SQL: bare BEGIN/END delimit a statement block, savepoints are SAVE TRANSACTION,
    // and ROLLBACK TRANSACTION <name> targets a savepoint.
    let begin = eng.begin;
    let savepoint = |name: &str| {
        if mssql {
            format!("SAVE TRANSACTION {name}")
        } else {
            format!("SAVEPOINT {name}")
        }
    };
    let rollback_to = |name: &str| {
        if mssql {
            format!("ROLLBACK TRANSACTION {name}")
        } else {
            format!("ROLLBACK TO SAVEPOINT {name}")
        }
    };
    let mut c = state(cfg, false).await;
    command_exec(
        &mut c,
        &crate::script::parse(&format!("DROP TABLE IF EXISTS {table}")).unwrap(),
    )
    .await
    .unwrap();
    command_exec(
        &mut c,
        &crate::script::parse(&format!("CREATE TABLE {table} (a INTEGER PRIMARY KEY)")).unwrap(),
    )
    .await
    .unwrap();

    // Across-call rollback, owner isolation, and background-session guard.
    command_exec(&mut c, &crate::script::parse(begin).unwrap())
        .await
        .unwrap();
    assert_eq!(c.transaction.state, TransactionState::Active);
    assert_eq!(c.transaction.mode, TransactionMode::Explicit);
    assert_eq!(c.transaction.owner.as_deref(), Some("test-owner"));
    assert!(c.require_owner("other-owner").is_err());
    assert!(c.require_idle("metadata").is_err());
    command_exec(
        &mut c,
        &crate::script::parse(&format!("INSERT INTO {table} VALUES (1)")).unwrap(),
    )
    .await
    .unwrap();
    command_exec(&mut c, &crate::script::parse("ROLLBACK").unwrap())
        .await
        .unwrap();
    assert_eq!(c.transaction.state, TransactionState::Idle);
    assert_eq!(transaction_count(&mut c, table).await, 0);

    // Across-call commit and self-contained transaction script.
    let start = if matches!(eng.name, "postgres" | "mysql") {
        "START TRANSACTION"
    } else {
        begin
    };
    command_exec(&mut c, &crate::script::parse(start).unwrap())
        .await
        .unwrap();
    command_exec(
        &mut c,
        &crate::script::parse(&format!("INSERT INTO {table} VALUES (2)")).unwrap(),
    )
    .await
    .unwrap();
    let commit = if eng.name == "postgres" {
        "END"
    } else {
        "COMMIT"
    };
    command_exec(&mut c, &crate::script::parse(commit).unwrap())
        .await
        .unwrap();
    command_exec(
        &mut c,
        &crate::script::parse(&format!("{begin}; INSERT INTO {table} VALUES (3); COMMIT;"))
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(transaction_count(&mut c, table).await, 2);

    // A statement error never silently commits or releases the owned session. PostgreSQL
    // requires recovery here; the other engines keep this constraint error recoverable.
    command_exec(&mut c, &crate::script::parse(begin).unwrap())
        .await
        .unwrap();
    command_exec(
        &mut c,
        &crate::script::parse(&format!("INSERT INTO {table} VALUES (20)")).unwrap(),
    )
    .await
    .unwrap();
    command_exec(
        &mut c,
        &crate::script::parse(&format!("INSERT INTO {table} VALUES (20)")).unwrap(),
    )
    .await
    .unwrap_err();
    if eng.name == "postgres" {
        assert_eq!(c.transaction.state, TransactionState::Failed);
        assert_eq!(c.transaction.health, TransactionHealth::RecoveryRequired);
        let commit = command_exec(&mut c, &crate::script::parse("COMMIT").unwrap())
            .await
            .unwrap_err();
        assert!(commit.message.contains("ROLLBACK"));
    } else {
        assert_eq!(c.transaction.state, TransactionState::Active);
        assert_eq!(c.transaction.health, TransactionHealth::Healthy);
    }
    command_exec(&mut c, &crate::script::parse("ROLLBACK").unwrap())
        .await
        .unwrap();
    assert_eq!(transaction_count(&mut c, table).await, 2);

    if eng.name == "mysql" {
        // Failed setup must not strand an untracked pooled connection.
        let bad_begin = crate::script::parse("START TRANSACTION READ BOGUS").unwrap();
        command_exec(&mut c, &bad_begin).await.unwrap_err();
        assert_eq!(c.transaction.state, TransactionState::Idle);
        assert!(!c.backend.mysql_manual_session_pinned());
    }

    if eng.name == "duckdb" {
        let unsupported = crate::script::parse("BEGIN; SAVEPOINT s; COMMIT").unwrap();
        let error = command_exec(&mut c, &unsupported).await.unwrap_err();
        assert!(error.message.contains("savepoints"));
        assert_eq!(c.transaction.state, TransactionState::Idle);
    } else {
        // SQL Server keeps a savepoint until the transaction ends; RELEASE has no T-SQL
        // equivalent and preflight must say so instead of inventing one.
        let release = if mssql {
            String::new()
        } else {
            " RELEASE SAVEPOINT s;".to_string()
        };
        command_exec(
            &mut c,
            &crate::script::parse(&format!(
                "{begin}; {}; INSERT INTO {table} VALUES (4); {};{release} COMMIT;",
                savepoint("s"),
                rollback_to("s")
            ))
            .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(transaction_count(&mut c, table).await, 2);
        if mssql {
            let unsupported = crate::script::parse(&format!(
                "{begin}; {}; RELEASE SAVEPOINT s; COMMIT;",
                savepoint("s")
            ))
            .unwrap();
            let error = command_exec(&mut c, &unsupported).await.unwrap_err();
            assert!(
                error.message.contains("RELEASE SAVEPOINT"),
                "{}",
                error.message
            );
            assert_eq!(c.transaction.state, TransactionState::Idle);
        }
    }

    // SET TRANSACTION is native on PostgreSQL/MySQL and explicitly unsupported on
    // embedded engines that lack it.
    let set_script = if eng.name == "mysql" {
        "SET TRANSACTION ISOLATION LEVEL READ COMMITTED; BEGIN; ROLLBACK;".to_string()
    } else if mssql {
        "SET TRANSACTION ISOLATION LEVEL READ COMMITTED".to_string()
    } else {
        "BEGIN; SET TRANSACTION READ ONLY; ROLLBACK;".to_string()
    };
    let set_result = command_exec(&mut c, &crate::script::parse(&set_script).unwrap()).await;
    if matches!(eng.name, "postgres" | "mysql") {
        set_result.unwrap();
    } else {
        assert!(set_result.unwrap_err().message.contains("SET TRANSACTION"));
    }

    if eng.name == "postgres" {
        // PostgreSQL statement errors require recovery; rollback-to-savepoint restores
        // healthy state without ending the outer transaction.
        command_exec(
            &mut c,
            &crate::script::parse("BEGIN; SAVEPOINT recover_here").unwrap(),
        )
        .await
        .unwrap();
        command_exec(
            &mut c,
            &crate::script::parse("SELECT * FROM no_such_tx_table").unwrap(),
        )
        .await
        .unwrap_err();
        assert_eq!(c.transaction.state, TransactionState::Failed);
        assert_eq!(c.transaction.health, TransactionHealth::RecoveryRequired);
        assert!(
            command_exec(&mut c, &crate::script::parse("SELECT 1").unwrap())
                .await
                .is_err()
        );
        command_exec(
            &mut c,
            &crate::script::parse("ROLLBACK TO recover_here").unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(c.transaction.state, TransactionState::Active);
        assert_eq!(c.transaction.health, TransactionHealth::Healthy);

        // Cursor paging remains inside the manual transaction and COMMIT closes it
        // without a nested transaction wrapper.
        let first = command_exec(
            &mut c,
            &crate::script::parse("SELECT generate_series(1, 205)").unwrap(),
        )
        .await
        .unwrap();
        assert!(matches!(first, QueryOutcome::Rows { done: false, .. }));
        let second = c.backend.fetch_page(100).await.unwrap();
        let third = c.backend.fetch_page(100).await.unwrap();
        assert_eq!(second.rows.len(), 100);
        assert_eq!(third.rows.len(), 5);
        assert!(third.done);
        command_exec(&mut c, &crate::script::parse("COMMIT").unwrap())
            .await
            .unwrap();
    }

    if eng.name == "mysql" {
        // Explicit mode and autocommit-off mode keep one physical connection.
        command_exec(&mut c, &crate::script::parse("BEGIN").unwrap())
            .await
            .unwrap();
        let first = command_exec(
            &mut c,
            &crate::script::parse("SELECT CONNECTION_ID()").unwrap(),
        )
        .await
        .unwrap();
        let second = command_exec(
            &mut c,
            &crate::script::parse("SELECT CONNECTION_ID()").unwrap(),
        )
        .await
        .unwrap();
        let id = |out: QueryOutcome| match out {
            QueryOutcome::Rows { rows, .. } => rows[0][0].clone(),
            QueryOutcome::Exec { .. } => None,
        };
        assert_eq!(id(first), id(second));
        command_exec(&mut c, &crate::script::parse("ROLLBACK").unwrap())
            .await
            .unwrap();

        command_exec(&mut c, &crate::script::parse("SET autocommit=0").unwrap())
            .await
            .unwrap();
        let before = command_exec(
            &mut c,
            &crate::script::parse("SELECT CONNECTION_ID()").unwrap(),
        )
        .await
        .unwrap();
        command_exec(&mut c, &crate::script::parse("COMMIT").unwrap())
            .await
            .unwrap();
        assert_eq!(c.transaction.mode, TransactionMode::AutocommitOff);
        let after = command_exec(
            &mut c,
            &crate::script::parse("SELECT CONNECTION_ID()").unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(id(before), id(after));
        command_exec(&mut c, &crate::script::parse("ROLLBACK").unwrap())
            .await
            .unwrap();
        command_exec(&mut c, &crate::script::parse("SET autocommit=1").unwrap())
            .await
            .unwrap();
        assert_eq!(c.transaction.state, TransactionState::Idle);

        command_exec(&mut c, &crate::script::parse("BEGIN").unwrap())
            .await
            .unwrap();
        let autocommit_on = crate::script::parse("SET autocommit=1").unwrap();
        assert!(command_exec(&mut c, &autocommit_on).await.is_err());
        assert_eq!(c.transaction.state, TransactionState::Active);
        assert!(c.backend.mysql_manual_session_pinned());
        let implicit = crate::script::parse(&format!("ALTER TABLE {table} ADD b INTEGER")).unwrap();
        assert!(command_exec(&mut c, &implicit).await.is_err());
        command_exec(&mut c, &crate::script::parse("ROLLBACK").unwrap())
            .await
            .unwrap();
    }

    // App-layer read-only boundary permits lifecycle control but blocks writes before
    // engine access, leaving rollback available.
    c.read_only = true;
    command_exec(&mut c, &crate::script::parse(begin).unwrap())
        .await
        .unwrap();
    if eng.name != "duckdb" {
        let named = match eng.name {
            "mysql" => "`write`".to_string(),
            "mssql" => "[write]".to_string(),
            _ => "\"write\"".to_string(),
        };
        command_exec(&mut c, &crate::script::parse(&savepoint(&named)).unwrap())
            .await
            .unwrap();
        command_exec(&mut c, &crate::script::parse(&rollback_to(&named)).unwrap())
            .await
            .unwrap();
    }
    let blocked = crate::script::parse(&format!("INSERT INTO {table} VALUES (9)")).unwrap();
    assert!(command_exec(&mut c, &blocked).await.is_err());
    command_exec(&mut c, &crate::script::parse("ROLLBACK").unwrap())
        .await
        .unwrap();
    c.read_only = false;

    // Disconnect path uses this same-session rollback primitive.
    command_exec(&mut c, &crate::script::parse(begin).unwrap())
        .await
        .unwrap();
    command_exec(
        &mut c,
        &crate::script::parse(&format!("INSERT INTO {table} VALUES (10)")).unwrap(),
    )
    .await
    .unwrap();
    c.backend.rollback_manual().await;
    c.apply_transaction_action(crate::script::TransactionAction::Rollback, "test-owner");
    assert_eq!(transaction_count(&mut c, table).await, 2);
}

#[test]
fn is_read_only_stmt_classification() {
    let pg = TransactionEngine::Postgres;
    for s in [
        "SELECT 1",
        "  with x as (select 1) select * from x",
        "SHOW search_path",
        "EXPLAIN select 1",
        "TABLE t",
        "VALUES (1)",
    ] {
        assert!(
            crate::sqlguard::is_read_only_stmt(s, pg),
            "{s:?} should be read-only"
        );
    }
    for s in [
        "INSERT INTO t VALUES (1)",
        "UPDATE t SET a=1",
        "DELETE FROM t",
        "CREATE TABLE t(a int)",
        "DROP TABLE t",
        "TRUNCATE t",
        "ALTER TABLE t ADD c int",
        "EXPLAIN ANALYZE SELECT 1",
        "EXPLAIN (ANALYZE, BUFFERS) DELETE FROM t",
        "SELECT set_config('default_transaction_read_only', 'off', false)",
        "SELECT pg_catalog.\"set_config\"('default_transaction_read_only', 'off', false)",
    ] {
        assert!(
            !crate::sqlguard::is_read_only_stmt(s, pg),
            "{s:?} should NOT be read-only"
        );
    }
    assert!(crate::sqlguard::is_read_only_stmt(
        "SELECT 'set_config' AS harmless -- EXPLAIN ANALYZE",
        pg
    ));
}

#[test]
fn is_read_only_stmt_is_engine_aware() {
    let pg = TransactionEngine::Postgres;
    let mssql = TransactionEngine::MsSql;
    let mysql = TransactionEngine::MySql;
    // SQL Server nests block comments, so the server sees only the DROP. Classifying by
    // PostgreSQL's non-nesting rules read a `SHOW`, and the `show` short-circuit then
    // skipped the mutation scan entirely — arbitrary DDL on a read-only connection.
    for s in [
        "/*/* */ SHOW 1 */ DROP TABLE dbo.victim",
        "/*/* */ SELECT 1 */ DELETE FROM dbo.victim",
        "/* outer /* inner */ still comment */ TRUNCATE TABLE dbo.victim",
    ] {
        assert!(
            !crate::sqlguard::is_read_only_stmt(s, mssql),
            "{s:?} must be blocked on SQL Server"
        );
    }
    // …and the `SHOW` exemption is gone everywhere it was never justified.
    assert!(!crate::sqlguard::is_read_only_stmt(
        "SHOW 1; DROP TABLE t",
        pg
    ));
    assert!(!crate::sqlguard::is_read_only_stmt(
        "SHOW /* */ tables /* */ ; DROP TABLE t",
        pg
    ));
    // MySQL's SHOW CREATE is the one read whose own syntax carries a mutation word.
    assert!(crate::sqlguard::is_read_only_stmt(
        "SHOW CREATE TABLE t",
        mysql
    ));
    assert!(!crate::sqlguard::is_read_only_stmt(
        "SHOW CREATE TABLE t",
        pg
    ));
    assert!(!crate::sqlguard::is_read_only_stmt(
        "SHOW CREATE TABLE t /* DROP TABLE u */; DROP TABLE u",
        mysql
    ));
    // `[bracket]` identifiers are names, not keywords: a legitimate read survives, and
    // a `'` inside one cannot open a phantom string that hides following code.
    assert!(crate::sqlguard::is_read_only_stmt(
        "SELECT [insert], [delete] FROM [dbo].[Update]",
        mssql
    ));
    assert!(!crate::sqlguard::is_read_only_stmt(
        "SELECT [a'b] FROM t; DROP TABLE u",
        mssql
    ));
    assert!(!crate::sqlguard::is_read_only_stmt(
        "SELECT [set_config](1)",
        mssql
    ));
}

#[tokio::test]
async fn app_readonly_guard_blocks_writes_single_and_multi() {
    // The app-layer guard (query_plan) blocks writes on a read-only connection — single
    // AND multi-statement — for every driver. This is the only protection for MySQL
    // (no engine-level read-only). Use SQLite in-memory as a stand-in for the guard logic.
    let mut c = state(&sqlite_cfg(), true).await;
    let block = |sql: &str| crate::script::split(sql);
    // single-statement write blocked
    assert!(command_exec(&mut c, &block("INSERT INTO x VALUES (1)"))
        .await
        .is_err());
    // multi-statement write blocked (the path that used to slip through on MySQL)
    assert!(command_exec(
        &mut c,
        &block("CREATE TABLE y(a int); INSERT INTO y VALUES (1)")
    )
    .await
    .is_err());
    // reads allowed
    assert!(command_exec(&mut c, &block("SELECT 1")).await.is_ok());
}

#[tokio::test]
async fn exec_plan_routes_single_vs_script() {
    let mut c = state(&sqlite_cfg(), false).await;
    let run = |sql: &str| crate::script::split(sql);
    command_exec(&mut c, &run("CREATE TABLE t(a INTEGER)"))
        .await
        .unwrap();
    // single SELECT → streaming Rows
    let single = command_exec(&mut c, &run("SELECT 1 AS a")).await.unwrap();
    assert!(
        matches!(single, QueryOutcome::Rows { .. }),
        "single SELECT → Rows"
    );
    // multi-statement → transactional script → Exec, and both writes apply
    let multi = command_exec(
        &mut c,
        &run("INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)"),
    )
    .await
    .unwrap();
    assert!(
        matches!(multi, QueryOutcome::Exec { .. }),
        "multi-statement → Exec"
    );
    let cnt = all(&mut c.backend, "SELECT COUNT(*) FROM t").await;
    assert_eq!(
        cell(&cnt[0], 0).as_deref(),
        Some("2"),
        "script applied both inserts"
    );

    // A trailing read remains inside the script transaction. Its failure rolls back
    // the leading write instead of committing it before a separate streaming query.
    let trailing = command_exec(
        &mut c,
        &run("INSERT INTO t VALUES (3); SELECT * FROM no_such_table_xyz"),
    )
    .await;
    assert!(trailing.is_err());
    let cnt = all(&mut c.backend, "SELECT COUNT(*) FROM t").await;
    assert_eq!(cell(&cnt[0], 0).as_deref(), Some("2"));

    // Unsupported COPY is rejected before any preceding SQL can execute.
    let copy = crate::script::parse("INSERT INTO t VALUES (4); COPY t FROM stdin;\r\n5\r\n\\.\r\n")
        .unwrap();
    let copy_err = command_exec(&mut c, &copy).await.unwrap_err();
    assert!(copy_err.message.contains("only supported by PostgreSQL"));
    let cnt = all(&mut c.backend, "SELECT COUNT(*) FROM t").await;
    assert_eq!(cell(&cnt[0], 0).as_deref(), Some("2"));

    command_exec(&mut c, &run("BEGIN; SELECT 1; COMMIT"))
        .await
        .unwrap();
    assert_eq!(c.transaction.state, crate::db::TransactionState::Idle);
}

/// The exact DDL forms the frontend `sql/ddl.ts` builders emit FOR DUCKDB must all be
/// accepted by a real DuckDB. (Vitest asserts the builders produce these strings; this
/// asserts DuckDB executes them — closing the builder→engine loop for DuckDB DDL parity.)
#[test]
fn duckdb_ddl_builder_forms_apply() {
    let c = duckdb::Connection::open_in_memory().unwrap();
    let steps: &[&str] = &[
        // createTable (inline PK / NOT NULL / DEFAULT — DuckDB supports these in CREATE)
        r#"CREATE TABLE "main"."t" (
  "id" INTEGER,
  "a" TEXT NOT NULL,
  "qty" INTEGER DEFAULT 0,
  PRIMARY KEY ("id")
)"#,
        r#"INSERT INTO "main"."t" VALUES (1, 'x', 5)"#,
        // addColumn — plain (nullable) + nullable-with-default both apply on a populated table
        r#"ALTER TABLE "main"."t" ADD COLUMN "c1" INTEGER"#,
        r#"ALTER TABLE "main"."t" ADD COLUMN "c2" INTEGER"#,
        r#"ALTER TABLE "main"."t" ALTER COLUMN "c2" SET DEFAULT 0"#,
        // editColumn — one ALTER action per statement
        r#"ALTER TABLE "main"."t" ALTER COLUMN "qty" TYPE BIGINT"#,
        r#"ALTER TABLE "main"."t" ALTER COLUMN "qty" SET DEFAULT 1"#,
        r#"ALTER TABLE "main"."t" ALTER COLUMN "a" DROP NOT NULL"#,
        r#"ALTER TABLE "main"."t" RENAME COLUMN "a" TO "label""#,
        // dropColumn
        r#"ALTER TABLE "main"."t" DROP COLUMN "c1""#,
        // comment on table / column
        r#"COMMENT ON TABLE "main"."t" IS 'hi'"#,
        r#"COMMENT ON COLUMN "main"."t"."label" IS 'the label'"#,
        // createIndex (no USING) + dropIndex
        r#"CREATE INDEX "idx" ON "main"."t" ("qty")"#,
        r#"DROP INDEX "main"."idx""#,
        // duplicateTable via CTAS (structure-only + with-data)
        r#"CREATE TABLE "main"."t2" AS SELECT * FROM "main"."t" LIMIT 0"#,
        r#"CREATE TABLE "main"."t3" AS SELECT * FROM "main"."t""#,
        // schema
        r#"CREATE SCHEMA "s1""#,
        r#"DROP SCHEMA "s1""#,
        // sequence
        r#"CREATE SEQUENCE "main"."seq1""#,
        r#"DROP SEQUENCE "main"."seq1""#,
        // truncate (plain — no options)
        r#"TRUNCATE TABLE "main"."t3""#,
        // add PK where none existed
        r#"ALTER TABLE "main"."t3" ADD PRIMARY KEY ("id")"#,
        // addColumn — NOT NULL split on an EMPTY table (the schema-design case; no backfill)
        r#"CREATE TABLE "main"."e" ("id" INTEGER)"#,
        r#"ALTER TABLE "main"."e" ADD COLUMN "c" INTEGER"#,
        r#"ALTER TABLE "main"."e" ALTER COLUMN "c" SET DEFAULT 0"#,
        r#"ALTER TABLE "main"."e" ALTER COLUMN "c" SET NOT NULL"#,
        r#"DROP TABLE "main"."e""#,
        // rename table / drop relation (+ cascade) / drop view
        r#"CREATE VIEW "main"."v" AS SELECT * FROM "main"."t""#,
        r#"DROP VIEW "main"."v""#,
        r#"ALTER TABLE "main"."t" RENAME TO "renamed""#,
        r#"DROP TABLE "main"."t2""#,
        r#"DROP TABLE "main"."t3" CASCADE"#,
    ];
    for s in steps {
        c.execute_batch(s)
            .unwrap_or_else(|e| panic!("DuckDB rejected builder DDL:\n  {s}\n  -> {e}"));
    }
}

/// The multi-statement DuckDB add-column split the builders emit runs through
/// `script::run` wrapped in BEGIN…COMMIT, so it must execute in ONE transaction. DuckDB
/// refuses `SET NOT NULL` with an outstanding UPDATE in the same transaction (which is
/// why the builder emits NO backfill); the split below must therefore succeed on an
/// empty table within a single transaction.
#[test]
fn duckdb_ddl_split_runs_transactionally() {
    let c = duckdb::Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE t(id INTEGER)").unwrap();
    let txn = r#"BEGIN;
ALTER TABLE "t" ADD COLUMN "c" INTEGER;
ALTER TABLE "t" ALTER COLUMN "c" SET DEFAULT 0;
ALTER TABLE "t" ALTER COLUMN "c" SET NOT NULL;
COMMIT;"#;
    c.execute_batch(txn)
        .expect("DuckDB must accept the add-column split (no backfill) in one transaction");
    // The new NOT NULL column with a default exists and is usable.
    c.execute_batch(r#"INSERT INTO "t" ("id") VALUES (7)"#)
        .unwrap();
    let v: i64 = c
        .query_row("SELECT c FROM t WHERE id = 7", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, 0, "default applied to new rows");
}

// --- frontend DDL builder parity (sql/ddl.ts -> real engines) ----------------
//
// Every fixture below is COPIED from `src/sql/ddl.test.ts`, which asserts the
// TypeScript builders produce exactly these strings. Vitest pins the text; these tests
// pin that a real engine accepts it. Change one side and the other fails.

/// SQLite forms — mirrors `createTable · sqlite`, `sqlite ALTER forms` and
/// `sqlite rebuild` in `src/sql/ddl.test.ts`.
#[test]
fn sqlite_ddl_builder_forms_apply() {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    let steps: &[&str] = &[
        // createTable · sqlite: INTEGER PRIMARY KEY AUTOINCREMENT + inline UNIQUE/CHECK
        r#"CREATE TABLE "main"."orders" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "code" text NOT NULL UNIQUE,
  "qty" integer DEFAULT 0 CHECK (qty > 0)
)"#,
        // createTable · sqlite: the FK target is BARE (SQLite rejects a qualified one)
        r#"CREATE TABLE "main"."lines" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "order_id" integer NOT NULL,
  "note" text DEFAULT '-',
  FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE CASCADE
)"#,
        r#"INSERT INTO "main"."orders" ("code", "qty") VALUES ('a', 3)"#,
        // sqlite ALTER forms: the four actions SQLite's ALTER TABLE actually has
        r#"ALTER TABLE "main"."orders" ADD COLUMN "c" text"#,
        r#"ALTER TABLE "main"."orders" RENAME COLUMN "c" TO "c2""#,
        r#"ALTER TABLE "main"."orders" DROP COLUMN "c2""#,
        // sqlite ALTER forms: CREATE INDEX leaves the TABLE bare, keeps a partial WHERE
        r#"CREATE UNIQUE INDEX "idx_q" ON "orders" ("qty") WHERE qty IS NOT NULL"#,
        r#"DROP INDEX "main"."idx_q""#,
        // sqlite ALTER forms: no TRUNCATE — an unqualified DELETE is the equivalent
        r#"DELETE FROM "main"."lines""#,
        // sqlite rebuild: create -> copy -> drop -> rename, then replay the indexes
        r#"CREATE TABLE "main"."orders__tusk_rebuild" (
  "id" integer PRIMARY KEY,
  "code" text NOT NULL,
  "qty" bigint
)"#,
        r#"INSERT INTO "main"."orders__tusk_rebuild" ("id", "code", "qty")
SELECT "id", "code", "qty" FROM "main"."orders""#,
        r#"PRAGMA legacy_alter_table=1"#,
        r#"DROP TABLE "main"."orders""#,
        r#"ALTER TABLE "main"."orders__tusk_rebuild" RENAME TO "orders""#,
        r#"PRAGMA legacy_alter_table=0"#,
        r#"CREATE INDEX "orders_qty_idx" ON "orders" ("qty")"#,
        // rename / drop the relation
        r#"ALTER TABLE "main"."orders" RENAME TO "orders2""#,
        r#"DROP TABLE "main"."lines""#,
        r#"DROP TABLE "main"."orders2""#,
    ];
    for s in steps {
        c.execute_batch(s)
            .unwrap_or_else(|e| panic!("SQLite rejected builder DDL:\n  {s}\n  -> {e}"));
    }
}

/// Run a rebuild script the way the app does: split it with Tusk's own engine-aware
/// splitter, then execute the resulting statements inside one transaction. Anything the
/// splitter shreds (a trigger body's `;`) or misreads (a bare `END` is COMMIT on SQLite)
/// shows up here exactly as it does in the workbench.
fn sqlite_run_split_script(c: &rusqlite::Connection, script: &str) -> Result<(), String> {
    let items = crate::script::parse_for_engine(script, crate::script::TransactionEngine::Sqlite)
        .map_err(|e| e.message)?;
    let stmts: Vec<String> = items
        .iter()
        .map(|item| match item {
            crate::script::Item::Sql(sql) => sql.clone(),
            crate::script::Item::Copy { stmt, .. } => stmt.clone(),
        })
        .collect();
    assert!(
        !stmts.iter().any(|s| s.trim().eq_ignore_ascii_case("END")),
        "the splitter shredded a trigger body into a bare END (SQLite reads that as COMMIT): {stmts:?}"
    );
    c.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    for sql in &stmts {
        if let Err(e) = c.execute_batch(sql) {
            let _ = c.execute_batch("ROLLBACK");
            return Err(format!("{sql} -> {e}"));
        }
    }
    c.execute_batch("COMMIT").map_err(|e| e.to_string())
}

/// The SQLite rebuild the builders emit runs through `script::run` wrapped in
/// BEGIN…COMMIT, so the whole create -> copy -> drop -> rename swap must succeed as one
/// unit AND keep the rows — including while another table holds a foreign key on the
/// table being rebuilt AND the table carries a trigger whose body contains `;`.
/// Dropping the original performs an implicit `DELETE FROM`, so with foreign keys
/// enforced (Tusk's SQLite build does) a child row makes it fail — unless enforcement is
/// suspended AROUND the transaction, which is what `App.runDDL` does for a rebuild.
/// `PRAGMA foreign_keys` is a silent no-op inside a transaction, and `defer_foreign_keys`
/// only moves the same failure to the COMMIT.
#[test]
fn sqlite_ddl_rebuild_runs_transactionally() {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    c.execute_batch(
        r#"PRAGMA foreign_keys=ON;
CREATE TABLE "t" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "qty" integer);
CREATE TABLE "child" ("id" integer, FOREIGN KEY ("id") REFERENCES "t" ("id"));
CREATE TRIGGER "t_guard" AFTER INSERT ON "t" BEGIN SELECT 1; END;
INSERT INTO "t" ("qty") VALUES (7);
INSERT INTO "child" ("id") VALUES (1);"#,
    )
    .unwrap();
    let script = r#"CREATE TABLE "main"."t__tusk_rebuild" (
  "id" integer PRIMARY KEY,
  "qty" bigint NOT NULL DEFAULT 0
);
INSERT INTO "main"."t__tusk_rebuild" ("id", "qty")
SELECT "id", "qty" FROM "main"."t";
PRAGMA legacy_alter_table=1;
DROP TABLE "main"."t";
ALTER TABLE "main"."t__tusk_rebuild" RENAME TO "t";
PRAGMA legacy_alter_table=0;
CREATE INDEX "t_qty_idx" ON "t" ("qty");
CREATE TRIGGER "t_guard" AFTER INSERT ON "t" BEGIN SELECT 1; END"#;
    // Load-bearing: inside the transaction the DROP orphans `child` and the whole
    // rebuild rolls back. This is the smoke-test failure ("FOREIGN KEY constraint
    // failed") reproduced.
    let unguarded = sqlite_run_split_script(&c, script).expect_err("a referenced parent fails");
    assert!(
        unguarded.contains("FOREIGN KEY constraint failed"),
        "unexpected error: {unguarded}"
    );
    // How `App.runDDL` runs it: enforcement suspended by its own IDLE statement on
    // either side of the transaction.
    c.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
    sqlite_run_split_script(&c, script)
        .expect("SQLite must accept the whole rebuild in one transaction");
    c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    let v: i64 = c
        .query_row("SELECT qty FROM t WHERE id = 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, 7, "rows survive the rebuild");
    // The referencing row is still there and still resolves to the rebuilt parent.
    let kids: i64 = c
        .query_row("SELECT COUNT(*) FROM child", [], |r| r.get(0))
        .unwrap();
    assert_eq!(kids, 1);
    let violations: i64 = c
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(violations, 0, "no orphaned children after the rebuild");
}

/// The rebuild has to survive a table that a VIEW and another table's TRIGGER name.
/// Since 3.25 `ALTER TABLE … RENAME TO` re-parses every entry in `sqlite_schema`, so
/// after the intermediate `DROP TABLE` the rename fails with "error in view …: no such
/// table" and the whole edit rolls back — unless `legacy_alter_table` is on, exactly as
/// SQLite's own 12-step rebuild recipe prescribes. The script below is byte-for-byte
/// the one `sqlite rebuild` in `src/sql/ddl.test.ts` asserts the builder emits.
#[test]
fn sqlite_rebuild_survives_dependent_view_and_trigger() {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    c.execute_batch(
        r#"CREATE TABLE "t" ("id" integer PRIMARY KEY, "qty" integer);
CREATE INDEX "t_qty_idx" ON "t" ("qty");
CREATE VIEW "active" AS SELECT * FROM "t" WHERE qty > 0;
CREATE TABLE "log" ("n" integer);
CREATE TRIGGER "t_log" AFTER INSERT ON "t" BEGIN INSERT INTO "log" VALUES (NEW."qty"); END;
INSERT INTO "t" ("id", "qty") VALUES (1, 7);"#,
    )
    .unwrap();
    let rebuild = r#"CREATE TABLE "main"."t__tusk_rebuild" (
  "id" integer PRIMARY KEY,
  "qty" bigint
);
INSERT INTO "main"."t__tusk_rebuild" ("id", "qty")
SELECT "id", "qty" FROM "main"."t";
PRAGMA legacy_alter_table=1;
DROP TABLE "main"."t";
ALTER TABLE "main"."t__tusk_rebuild" RENAME TO "t";
PRAGMA legacy_alter_table=0;
CREATE INDEX "t_qty_idx" ON "t" ("qty");
CREATE TRIGGER "t_log" AFTER INSERT ON "t" BEGIN INSERT INTO "log" VALUES (NEW."qty"); END;"#;
    // Split by Tusk's own splitter: the replayed trigger body holds a `;`, and shredding
    // it leaves a bare `END` that SQLite executes as COMMIT.
    sqlite_run_split_script(&c, rebuild)
        .expect("the rebuild must survive a dependent view and trigger");
    let v: i64 = c
        .query_row("SELECT qty FROM active WHERE id = 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, 7, "the view still resolves after the swap");
    // The replayed trigger is live again.
    c.execute_batch(r#"INSERT INTO "t" ("id", "qty") VALUES (2, 9)"#)
        .unwrap();
    let logged: i64 = c
        .query_row("SELECT COUNT(*) FROM log WHERE n = 9", [], |r| r.get(0))
        .unwrap();
    assert_eq!(logged, 1, "the recreated trigger fired");

    // And the pragma is load-bearing: the identical script without it fails on the
    // rename, because the view can no longer be re-parsed.
    let c2 = rusqlite::Connection::open_in_memory().unwrap();
    c2.execute_batch(
        r#"CREATE TABLE "t" ("id" integer PRIMARY KEY, "qty" integer);
CREATE VIEW "active" AS SELECT * FROM "t" WHERE qty > 0;"#,
    )
    .unwrap();
    let err = c2
        .execute_batch(&format!(
            "BEGIN;\n{}\nCOMMIT;",
            rebuild.replace("PRAGMA legacy_alter_table=1;\n", "")
        ))
        .expect_err("without legacy_alter_table the rename must fail");
    assert!(
        err.to_string().to_lowercase().contains("no such table"),
        "unexpected error: {err}"
    );
}

/// The rebuild reaches the engine through `Backend::run_script` (the app-owned
/// transaction wrapper), not through raw `execute_batch` — so the `PRAGMA` statements it
/// now contains have to survive Tusk's own statement splitting and script runner too.
#[tokio::test]
async fn sqlite_rebuild_script_runs_through_the_driver() {
    let (mut b, _v) = connect(&sqlite_cfg()).await.expect("connect sqlite");
    exec(
        &mut b,
        r#"CREATE TABLE "t" ("id" integer PRIMARY KEY, "qty" integer)"#,
    )
    .await;
    exec(&mut b, r#"CREATE VIEW "active" AS SELECT * FROM "t""#).await;
    exec(&mut b, r#"CREATE TABLE "log" ("n" integer)"#).await;
    exec(
        &mut b,
        r#"CREATE TRIGGER "t_log" AFTER INSERT ON "t" BEGIN INSERT INTO "log" VALUES (NEW."qty"); END"#,
    )
    .await;
    exec(&mut b, r#"INSERT INTO "t" ("id", "qty") VALUES (1, 7)"#).await;
    let script = r#"-- SQLite can't ALTER "main"."t" in place — rebuilding it (create → copy → drop → rename).
CREATE TABLE "main"."t__tusk_rebuild" (
  "id" integer PRIMARY KEY,
  "qty" bigint
);
INSERT INTO "main"."t__tusk_rebuild" ("id", "qty")
SELECT "id", "qty" FROM "main"."t";
PRAGMA legacy_alter_table=1;
DROP TABLE "main"."t";
ALTER TABLE "main"."t__tusk_rebuild" RENAME TO "t";
PRAGMA legacy_alter_table=0;
CREATE TRIGGER "t_log" AFTER INSERT ON "t" BEGIN INSERT INTO "log" VALUES (NEW."qty"); END"#;
    // The engine-aware splitter is what execution uses: on SQLite the trigger body's `;`
    // must not become a boundary, or the trailing `END` runs as COMMIT and the script
    // dies with "COMMIT requires a healthy active transaction".
    let items = crate::script::parse_for_engine(script, crate::script::TransactionEngine::Sqlite)
        .expect("the rebuild script parses");
    b.run_script(&items, false)
        .await
        .expect("the driver must run the whole rebuild as one script");
    let rows = all(&mut b, r#"SELECT "qty" FROM "active""#).await;
    assert_eq!(cell(&rows[0], 0).as_deref(), Some("7"));
    // The replayed trigger is live on the rebuilt table.
    exec(&mut b, r#"INSERT INTO "t" ("id", "qty") VALUES (2, 9)"#).await;
    let logged = all(&mut b, r#"SELECT COUNT(*) FROM "log" WHERE "n" = 9"#).await;
    assert_eq!(cell(&logged[0], 0).as_deref(), Some("1"));
}

/// A rebuild must carry across everything only the stored CREATE text knows: table and
/// column CHECK constraints, COLLATE, generated columns and `WITHOUT ROWID` / `STRICT`.
/// The CREATE below is byte-for-byte the one `sqlite rebuild` in `src/sql/ddl.test.ts`
/// builds from a detail carrying those fields.
#[test]
fn sqlite_rebuild_keeps_checks_collation_and_generated_columns() {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    c.execute_batch(
        r#"CREATE TABLE "main"."t__tusk_rebuild" (
  "id" integer PRIMARY KEY,
  "email" varchar(80) COLLATE NOCASE CHECK (email <> ''),
  "total" int GENERATED ALWAYS AS (id * 2) STORED,
  CONSTRAINT "ck_qty" CHECK (id > 0)
) WITHOUT ROWID"#,
    )
    .expect("SQLite accepts the rebuilt CREATE with every carried-over clause");
    c.execute_batch(r#"INSERT INTO "main"."t__tusk_rebuild" ("id", "email") VALUES (3, 'A@b')"#)
        .unwrap();
    let total: i64 = c
        .query_row("SELECT total FROM t__tusk_rebuild", [], |r| r.get(0))
        .unwrap();
    assert_eq!(total, 6, "the generated column still computes");
    // The carried COLLATE is live too (NOCASE compares case-insensitively).
    let hits: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM t__tusk_rebuild WHERE email = 'a@B'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(hits, 1, "COLLATE NOCASE survived the rebuild");
}

/// PostgreSQL forms — mirrors `createTable · postgres`, `addColumn`, `editColumn` and
/// the shared drop/rename builders in `src/sql/ddl.test.ts`.
#[tokio::test]
async fn postgres_ddl_builder_forms_apply() {
    let Some(cfg) = pg_cfg() else {
        eprintln!("SKIP postgres_ddl_builder_forms_apply (set TUSK_TEST_PG_PORT)");
        return;
    };
    let (mut b, _v) = connect(&cfg).await.expect("connect pg");
    let steps: &[&str] = &[
        r#"DROP TABLE IF EXISTS "public"."lines""#,
        r#"DROP TABLE IF EXISTS "public"."t2""#,
        r#"DROP TABLE IF EXISTS "public"."orders""#,
        r#"DROP TABLE IF EXISTS "public"."orders2""#,
        r#"DROP SCHEMA IF EXISTS "s1" CASCADE"#,
        // createTable · postgres: identity key, inline UNIQUE/CHECK, comments
        r#"CREATE TABLE IF NOT EXISTS "public"."orders" (
  "id" bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  "code" text NOT NULL UNIQUE,
  "qty" integer DEFAULT 0 NOT NULL CHECK (qty > 0)
)"#,
        r#"COMMENT ON TABLE "public"."orders" IS 'customer orders'"#,
        r#"COMMENT ON COLUMN "public"."orders"."code" IS 'order code'"#,
        // createTable · postgres: composite key + a deferrable foreign key
        r#"CREATE TABLE "public"."lines" (
  "order_id" bigint NOT NULL,
  "line_no" integer NOT NULL,
  PRIMARY KEY ("order_id", "line_no"),
  CONSTRAINT "lines_order_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders" ("id") ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED
)"#,
        // addColumn / editColumn (actions comma-joined) / comment / rename / drop
        r#"ALTER TABLE "public"."orders" ADD COLUMN "c" int DEFAULT 0 NOT NULL"#,
        r#"ALTER TABLE "public"."orders" ALTER COLUMN "c" TYPE bigint, ALTER COLUMN "c" SET NOT NULL, ALTER COLUMN "c" SET DEFAULT 0"#,
        r#"COMMENT ON COLUMN "public"."orders"."c" IS 'a note'"#,
        r#"ALTER TABLE "public"."orders" RENAME COLUMN "c" TO "c2""#,
        r#"ALTER TABLE "public"."orders" DROP COLUMN "c2""#,
        // createIndex (access method + partial WHERE) / rename / drop
        r#"CREATE INDEX "idx_q" ON "public"."orders" USING hash ("qty")"#,
        r#"DROP INDEX "public"."idx_q""#,
        r#"CREATE UNIQUE INDEX "idx_p" ON "public"."orders" ("qty") WHERE qty > 0"#,
        r#"ALTER INDEX "public"."idx_p" RENAME TO "idx_p2""#,
        r#"DROP INDEX "public"."idx_p2" CASCADE"#,
        // constraint ALTERs
        r#"ALTER TABLE "public"."orders" ADD CONSTRAINT "uq_q" UNIQUE ("qty")"#,
        r#"ALTER TABLE "public"."orders" ADD CONSTRAINT "ck_q" CHECK (qty >= 0)"#,
        r#"ALTER TABLE "public"."orders" RENAME CONSTRAINT "ck_q" TO "ck_q2""#,
        r#"ALTER TABLE "public"."orders" DROP CONSTRAINT "ck_q2""#,
        r#"ALTER TABLE "public"."orders" DROP CONSTRAINT "uq_q""#,
        // move a table between schemas
        r#"CREATE SCHEMA "s1""#,
        r#"ALTER TABLE "public"."orders" SET SCHEMA "s1""#,
        r#"ALTER TABLE "s1"."orders" SET SCHEMA "public""#,
        r#"DROP SCHEMA "s1""#,
        // duplicate / truncate / rename / drop
        r#"CREATE TABLE "public"."t2" (LIKE "public"."orders" INCLUDING ALL)"#,
        r#"TRUNCATE TABLE "public"."t2" RESTART IDENTITY CASCADE"#,
        r#"ALTER TABLE "public"."orders" RENAME TO "orders2""#,
        r#"DROP TABLE "public"."lines""#,
        r#"DROP TABLE "public"."t2""#,
        r#"DROP TABLE "public"."orders2" CASCADE"#,
    ];
    for s in steps {
        exec(&mut b, s).await;
    }
}

/// MySQL forms — mirrors `createTable · mysql`, `mysql ALTER forms` and
/// `tableDiff · mysql` in `src/sql/ddl.test.ts`.
#[tokio::test]
async fn mysql_ddl_builder_forms_apply() {
    let Some(cfg) = mysql_cfg() else {
        eprintln!("SKIP mysql_ddl_builder_forms_apply (set TUSK_TEST_MYSQL_PORT)");
        return;
    };
    let (mut b, _v) = connect(&cfg).await.expect("connect mysql");
    let steps: &[&str] = &[
        r#"DROP TABLE IF EXISTS `test`.`lines`"#,
        r#"DROP TABLE IF EXISTS `test`.`t2`"#,
        r#"DROP TABLE IF EXISTS `test`.`orders`"#,
        r#"DROP TABLE IF EXISTS `test`.`orders2`"#,
        // createTable · mysql: AUTO_INCREMENT key, inline COMMENT, table options
        r#"CREATE TABLE IF NOT EXISTS `test`.`orders` (
  `id` bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `code` varchar(32) NOT NULL UNIQUE COMMENT 'order code',
  `qty` int DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='customer orders'"#,
        r#"CREATE TABLE `test`.`lines` (
  `order_id` bigint NOT NULL,
  `line_no` int NOT NULL,
  PRIMARY KEY (`order_id`, `line_no`),
  CONSTRAINT `lines_order_fk` FOREIGN KEY (`order_id`) REFERENCES `test`.`orders` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION
)"#,
        // addColumn / MODIFY restating the definition / default-only edit / rename / drop
        r#"ALTER TABLE `test`.`orders` ADD COLUMN `c` int NOT NULL DEFAULT 0"#,
        r#"ALTER TABLE `test`.`orders` MODIFY COLUMN `c` bigint NOT NULL DEFAULT 0 COMMENT 'count'"#,
        r#"ALTER TABLE `test`.`orders` ALTER COLUMN `c` SET DEFAULT 5"#,
        r#"ALTER TABLE `test`.`orders` ALTER COLUMN `c` DROP DEFAULT"#,
        r#"ALTER TABLE `test`.`orders` RENAME COLUMN `c` TO `c2`"#,
        r#"ALTER TABLE `test`.`orders` DROP COLUMN `c2`"#,
        // createIndex / renameIndex / dropIndex (MySQL needs the table on DROP INDEX)
        r#"CREATE INDEX `idx_q` ON `test`.`orders` (`qty`)"#,
        r#"ALTER TABLE `test`.`orders` RENAME INDEX `idx_q` TO `idx_q2`"#,
        r#"DROP INDEX `idx_q2` ON `test`.`orders`"#,
        // constraint ALTERs, dropped by kind
        r#"ALTER TABLE `test`.`orders` ADD CONSTRAINT `uq_q` UNIQUE (`qty`)"#,
        r#"ALTER TABLE `test`.`orders` DROP INDEX `uq_q`"#,
        r#"ALTER TABLE `test`.`orders` ADD CONSTRAINT `ck_q` CHECK (qty >= 0)"#,
        r#"ALTER TABLE `test`.`orders` DROP CHECK `ck_q`"#,
        r#"ALTER TABLE `test`.`lines` DROP FOREIGN KEY `lines_order_fk`"#,
        r#"ALTER TABLE `test`.`lines` DROP PRIMARY KEY"#,
        r#"ALTER TABLE `test`.`lines` ADD PRIMARY KEY (`order_id`)"#,
        // comments are table/column OPTIONS on MySQL, not statements
        r#"ALTER TABLE `test`.`orders` COMMENT = 'hello'"#,
        r#"ALTER TABLE `test`.`orders` MODIFY COLUMN `qty` int COMMENT 'note'"#,
        // duplicate / truncate / rename / drop
        r#"CREATE TABLE `test`.`t2` LIKE `test`.`orders`"#,
        r#"TRUNCATE TABLE `test`.`t2`"#,
        r#"RENAME TABLE `test`.`orders` TO `test`.`orders2`"#,
        r#"DROP TABLE `test`.`lines`"#,
        r#"DROP TABLE `test`.`t2`"#,
        r#"DROP TABLE `test`.`orders2`"#,
    ];
    for s in steps {
        exec(&mut b, s).await;
    }
}

/// MySQL's `MODIFY COLUMN` restates the whole column definition, and MySQL reports
/// `COLUMN_DEFAULT` UNQUOTED — so a string default read back from the catalog and put
/// straight into a MODIFY produces `DEFAULT abc` and fails. `table_detail` must hand the
/// frontend a RUNNABLE default expression; this round-trips one of each shape through
/// the exact statement the Modify dialog emits.
#[tokio::test]
async fn mysql_column_defaults_round_trip_through_modify() {
    let Some(cfg) = mysql_cfg() else {
        eprintln!("SKIP mysql_column_defaults_round_trip (set TUSK_TEST_MYSQL_PORT)");
        return;
    };
    let (mut b, _v) = connect(&cfg).await.expect("connect mysql");
    exec(&mut b, "DROP TABLE IF EXISTS `test`.`defs`").await;
    exec(
        &mut b,
        "CREATE TABLE `test`.`defs` (\
         `s` varchar(20) DEFAULT 'ab''c', \
         `n` int DEFAULT 7, \
         `big` bigint DEFAULT 9, \
         `tiny` tinyint DEFAULT 1, \
         `amount` decimal(10,2) DEFAULT 1.50, \
         `d` datetime DEFAULT CURRENT_TIMESTAMP, \
         `e` varchar(10) DEFAULT 'x\\\\y', \
         `u` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, \
         `g` int GENERATED ALWAYS AS (`n` + 1) STORED)",
    )
    .await;
    let detail = b.table_detail("test", "defs").await.expect("detail");
    // A generated column is reported WITH its clause: MODIFY cannot restate it from the
    // dialog's fields, so the frontend refuses to rewrite it instead of breaking it.
    let g = detail.columns.iter().find(|c| c.name == "g").unwrap();
    assert!(
        g.generated
            .as_deref()
            .is_some_and(|x| x.starts_with("GENERATED ALWAYS AS (") && x.ends_with("STORED")),
        "generated clause: {:?}",
        g.generated
    );
    // ON UPDATE lives in EXTRA, not in the column type — a MODIFY that omits it drops
    // the auto-update behaviour with no error at all.
    let u = detail.columns.iter().find(|c| c.name == "u").unwrap();
    assert_eq!(u.on_update.as_deref(), Some("ON UPDATE CURRENT_TIMESTAMP"));

    for c in detail.columns.iter().filter(|c| c.generated.is_none()) {
        let def = c.default.clone().unwrap_or_default();
        assert!(!def.is_empty(), "column {} lost its default", c.name);
        // Exactly what `columnDef` emits for MySQL, with the catalog's own values.
        let sql = format!(
            "ALTER TABLE `test`.`defs` MODIFY COLUMN `{}` {}{} DEFAULT {}{}",
            c.name,
            c.data_type,
            if c.nullable { "" } else { " NOT NULL" },
            def,
            c.on_update
                .as_deref()
                .map(|x| format!(" {x}"))
                .unwrap_or_default(),
        );
        exec(&mut b, &sql).await;
    }
    let after = b.table_detail("test", "defs").await.expect("detail again");
    let shape = |d: &crate::tree::RelationDetail| {
        d.columns
            .iter()
            .map(|c| {
                (
                    c.name.clone(),
                    c.default.clone().unwrap_or_default(),
                    c.on_update.clone().unwrap_or_default(),
                    c.nullable,
                )
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(
        shape(&after),
        shape(&detail),
        "defaults, ON UPDATE and nullability must survive a MODIFY COLUMN round trip"
    );
    exec(&mut b, "DROP TABLE `test`.`defs`").await;
}

/// PostgreSQL identity columns must be REPORTED as identity: the detection read a
/// column the query never selected, so `GENERATED … AS IDENTITY` came back false and
/// only the legacy `serial` (a nextval default) was recognized.
#[tokio::test]
async fn postgres_identity_columns_are_detected() {
    let Some(cfg) = pg_cfg() else {
        eprintln!("SKIP postgres_identity_columns_are_detected (set TUSK_TEST_PG_PORT)");
        return;
    };
    let (mut b, _v) = connect(&cfg).await.expect("connect pg");
    exec(&mut b, r#"DROP TABLE IF EXISTS "public"."ids""#).await;
    exec(
        &mut b,
        r#"CREATE TABLE "public"."ids" (
  "a" bigint GENERATED BY DEFAULT AS IDENTITY,
  "b" bigint GENERATED ALWAYS AS IDENTITY,
  "c" serial,
  "d" bigint
)"#,
    )
    .await;
    let d = b.table_detail("public", "ids").await.expect("detail");
    let is_identity = |n: &str| d.columns.iter().find(|c| c.name == n).unwrap().identity;
    assert!(is_identity("a"), "GENERATED BY DEFAULT AS IDENTITY");
    assert!(is_identity("b"), "GENERATED ALWAYS AS IDENTITY");
    assert!(is_identity("c"), "serial (nextval default)");
    assert!(!is_identity("d"), "a plain column is not identity");
    exec(&mut b, r#"DROP TABLE "public"."ids""#).await;
}

// --- Explorer routines and sequences (build_tree + relation_ddl) ---

/// DuckDB lists its sequences and user macros in the Explorer, and "View definition"
/// shows runnable DDL for both: the sequence's stored text with its name qualified and
/// quoted (DuckDB stores it bare and unquoted), and every macro overload restated. Each
/// definition is replayed after a drop, using the drop forms `sql/ddl.ts` emits for
/// DuckDB (`dropSequence` / `dropFunction` in `ddl.test.ts`).
#[tokio::test]
async fn duckdb_sequences_and_macros_listed_and_defined() {
    let (mut b, _v) = connect(&duck_cfg()).await.unwrap();
    for sql in [
        r#"CREATE SCHEMA "x""#,
        r#"CREATE SEQUENCE "main"."tusk_seq" START 5 INCREMENT BY 2"#,
        r#"CREATE SEQUENCE "x"."we""ird seq""#,
        r#"CREATE MACRO "main"."tusk_add"(a, b := 5) AS a + b, (a) AS a * 10"#,
        r#"CREATE MACRO "main"."tusk_typed"(a INTEGER, b VARCHAR) AS a"#,
        r#"CREATE MACRO "x"."tusk_rows"(n) AS TABLE SELECT * FROM range(n)"#,
    ] {
        exec(&mut b, sql).await;
    }

    let tree = b.build_tree().await.expect("build_tree");
    let schema = |n: &str| {
        tree.schemas
            .iter()
            .find(|s| s.name == n)
            .unwrap_or_else(|| panic!("schema {n}"))
    };
    assert_eq!(schema("main").sequences, vec!["tusk_seq".to_string()]);
    assert_eq!(schema("x").sequences, vec!["we\"ird seq".to_string()]);
    let routines = |n: &str| {
        schema(n)
            .functions
            .iter()
            .map(|f| (f.name.clone(), f.returns.clone()))
            .collect::<Vec<_>>()
    };
    // Overloads collapse into one node; internal macros never appear.
    assert_eq!(
        routines("main"),
        vec![
            ("tusk_add".to_string(), "macro".to_string()),
            ("tusk_typed".to_string(), "macro".to_string()),
        ]
    );
    assert_eq!(
        routines("x"),
        vec![("tusk_rows".to_string(), "table macro".to_string())]
    );

    // Sequences: qualified, quoted, options kept, and runnable.
    let seq = b
        .relation_ddl("sequence", "main", "tusk_seq")
        .await
        .expect("sequence ddl");
    assert!(
        seq.starts_with(r#"CREATE SEQUENCE "main"."tusk_seq" "#),
        "{seq}"
    );
    assert!(
        seq.contains("INCREMENT BY 2") && seq.contains("START 5"),
        "{seq}"
    );
    let weird = b
        .relation_ddl("sequence", "x", "we\"ird seq")
        .await
        .expect("weird sequence ddl");
    assert!(
        weird.starts_with(r#"CREATE SEQUENCE "x"."we""ird seq" "#),
        "{weird}"
    );
    exec(&mut b, r#"DROP SEQUENCE "x"."we""ird seq" CASCADE"#).await;
    exec(&mut b, &weird).await;
    // (`nextval('…')` cannot name it: DuckDB's string form does not undouble quotes.)
    let back = all(
        &mut b,
        r#"SELECT schema_name FROM duckdb_sequences() WHERE sequence_name = 'we"ird seq'"#,
    )
    .await;
    assert_eq!(back, vec![vec![Some("x".to_string())]], "replayed into x");
    exec(&mut b, r#"DROP SEQUENCE "main"."tusk_seq""#).await;
    exec(&mut b, &seq).await;
    let next = all(&mut b, r#"SELECT nextval('main.tusk_seq')"#).await;
    assert_eq!(next[0][0].as_deref(), Some("5"));

    // Macros: every overload, parameter types kept, and a defaults caveat.
    let add = b
        .relation_ddl("function", "main", "tusk_add")
        .await
        .expect("macro ddl");
    assert!(add.contains("parameter"), "defaults caveat: {add}");
    assert!(
        add.contains(r#"CREATE MACRO "main"."tusk_add"("a", "b") AS"#),
        "{add}"
    );
    assert!(add.contains(r#"("a") AS"#), "second overload: {add}");
    exec(&mut b, r#"DROP MACRO "main"."tusk_add" CASCADE"#).await;
    exec(&mut b, &add).await;
    let rows = all(
        &mut b,
        r#"SELECT "main"."tusk_add"(2, 3), "main"."tusk_add"(2)"#,
    )
    .await;
    assert_eq!(rows[0], vec![Some("5".to_string()), Some("20".to_string())]);

    let typed = b
        .relation_ddl("function", "main", "tusk_typed")
        .await
        .expect("typed macro ddl");
    assert!(typed.contains(r#"("a" INTEGER, "b" VARCHAR)"#), "{typed}");

    let table = b
        .relation_ddl("function", "x", "tusk_rows")
        .await
        .expect("table macro ddl");
    assert!(
        table.contains(r#"CREATE MACRO "x"."tusk_rows"("n") AS TABLE ("#),
        "{table}"
    );
    exec(&mut b, r#"DROP MACRO TABLE "x"."tusk_rows""#).await;
    exec(&mut b, &table).await;
    let rows = all(&mut b, r#"SELECT count(*) FROM "x"."tusk_rows"(4)"#).await;
    assert_eq!(rows[0][0].as_deref(), Some("4"));

    let missing = b.relation_ddl("function", "main", "no_such_macro").await;
    assert!(
        missing.is_err(),
        "an unknown macro is an error, not empty DDL"
    );
}

// --- DuckDB errors release the engine's locks ---

/// Run one step of a DuckDB scenario on its own OS thread, failing the test instead of
/// hanging it when the step blocks. The fresh thread matters: a lock leaked by a failed
/// statement makes the thread that leaked it fail with "resource deadlock would occur",
/// but blocks every OTHER thread forever, and Tusk's commands run on whichever tokio
/// worker is free.
fn duck_step<T, F, Fut>(b: Backend, what: &str, step: F) -> (Backend, T)
where
    T: Send + 'static,
    F: FnOnce(Backend) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = (Backend, T)>,
{
    use std::sync::mpsc::RecvTimeoutError;
    let (tx, rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _ = tx.send(rt.block_on(step(b)));
    });
    match rx.recv_timeout(std::time::Duration::from_secs(30)) {
        Ok(out) => out,
        // The blocked worker keeps the backend; it is leaked with the thread.
        Err(RecvTimeoutError::Timeout) => panic!(
            "DuckDB blocked during {what}: a failed statement left an engine lock held. \
             Is DuckDB compiled with /EHsc (.cargo/config.toml)?"
        ),
        Err(RecvTimeoutError::Disconnected) => {
            std::panic::resume_unwind(worker.join().expect_err("worker sent nothing"))
        }
    }
}

/// A DuckDB statement that fails while the engine holds an internal lock must release
/// the lock. libduckdb-sys compiles DuckDB without an /EH option, and MSVC then unwinds
/// a C++ exception without running destructors, so the `lock_guard` around the failing
/// code never unlocks (`.cargo/config.toml` supplies /EHsc). Two of the errors that hit
/// this are ordinary user mistakes:
/// - `nextval` on an exhausted NO CYCLE sequence, or `currval` before any `nextval`,
///   kept the sequence's lock. The Explorer's next refresh (`build_tree` reads
///   `duckdb_sequences()`), View definition and backup then blocked forever.
/// - A duplicate primary key kept a lock the table's next write needs, and that write
///   blocked forever.
///
/// The `SELECT 1` probe behind `quarantine_if_poisoned` passed in both cases, so nothing
/// discarded the connection. These must not be quarantined either: the in-memory
/// database keeps its rows.
#[test]
fn duckdb_failed_statements_release_engine_locks() {
    let (b, _version) = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(connect(&duck_cfg()))
        .unwrap();
    let (b, ()) = duck_step(b, "setup", |mut b| async move {
        for sql in [
            r#"CREATE SEQUENCE "main"."tusk_spent" MAXVALUE 2"#,
            r#"CREATE SEQUENCE "main"."tusk_unused""#,
            "SELECT nextval('main.tusk_spent')",
            "SELECT nextval('main.tusk_spent')",
            r#"CREATE TABLE "main"."tusk_keyed" (id INTEGER PRIMARY KEY)"#,
            r#"INSERT INTO "main"."tusk_keyed" VALUES (1)"#,
        ] {
            exec(&mut b, sql).await;
        }
        (b, ())
    });

    // The failures come from one thread; everything after runs on others.
    let (b, errors) = duck_step(b, "the failing statements", |mut b| async move {
        let mut errors = Vec::new();
        for sql in [
            "SELECT nextval('main.tusk_spent')",
            "SELECT currval('main.tusk_unused')",
            r#"INSERT INTO "main"."tusk_keyed" VALUES (1)"#,
        ] {
            b.rollback_cursor().await;
            let err = b
                .run_single(sql, 100, cursorable(sql))
                .await
                .expect_err(sql);
            errors.push(err.message);
        }
        (b, errors)
    });
    for (err, expected) in
        errors
            .iter()
            .zip(["reached maximum value", "not yet defined", "Duplicate key"])
    {
        assert!(err.contains(expected), "{expected}: {err}");
        assert!(!err.contains("unusable"), "quarantined: {err}");
    }

    let (b, tree) = duck_step(b, "the Explorer refresh", |b| async move {
        let tree = b.build_tree().await;
        (b, tree)
    });
    let tree = tree.expect("build_tree");
    let main = tree
        .schemas
        .iter()
        .find(|s| s.name == "main")
        .expect("main schema");
    // build_tree drops a failed sequence read silently, so an error shows up here.
    assert_eq!(main.sequences, vec!["tusk_spent", "tusk_unused"]);

    let (b, ddl) = duck_step(b, "View definition", |b| async move {
        let ddl = b.relation_ddl("sequence", "main", "tusk_spent").await;
        (b, ddl)
    });
    let ddl = ddl.expect("sequence ddl");
    assert!(ddl.contains("MAXVALUE 2"), "{ddl}");

    let (_b, (count, again)) = duck_step(b, "the next write", |mut b| async move {
        exec(&mut b, r#"INSERT INTO "main"."tusk_keyed" VALUES (2)"#).await;
        let count = all(&mut b, r#"SELECT count(*) FROM "main"."tusk_keyed""#).await;
        b.rollback_cursor().await;
        let again = b
            .run_single("SELECT nextval('main.tusk_spent')", 100, true)
            .await;
        (b, (count, again))
    });
    assert_eq!(count[0][0].as_deref(), Some("2"), "rows kept, write landed");
    let again = again.expect_err("the sequence is still exhausted");
    assert!(
        again.message.contains("reached maximum value"),
        "{}",
        again.message
    );
}

/// The parser-error face of the same build defect (duckdb-rs #209). `parse_check`
/// keeps parser errors off the real connection, so this asks libduckdb directly: with
/// /EHsc the connection stays usable on its own thread and on another.
#[test]
fn duckdb_parser_error_leaves_connection_usable() {
    // A poisoned connection aborts the process when dropped, so a failure here must
    // leak it rather than unwind through its destructor.
    let c = std::mem::ManuallyDrop::new(duckdb::Connection::open_in_memory().unwrap());
    assert!(c.prepare("SELEC 1").is_err(), "a parser error");
    let probe = c.prepare("SELECT 1").map(drop);
    assert!(probe.is_ok(), "same thread after a parser error: {probe:?}");
    let c = std::mem::ManuallyDrop::into_inner(c);
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let r = c.query_row("SELECT 42", [], |r| r.get::<_, i32>(0));
        let ok = matches!(r, Ok(42));
        let _ = tx.send(ok);
        if ok {
            drop(c);
        } else {
            std::mem::forget(c);
        }
    });
    let ok = rx
        .recv_timeout(std::time::Duration::from_secs(30))
        .expect("another thread blocked after a parser error");
    assert!(ok, "another thread after a parser error");
}

/// Cancel stops a running DuckDB query and the connection carries on, Windows included.
/// Without /EHsc an interrupt kept the same engine lock a failed statement did, so
/// Cancel was switched off on Windows. The interrupt goes through
/// `CancelHandle::cancel`, the call `cancel_operation` makes, while the query runs on
/// another thread; every later step runs on a thread of its own (`duck_step`). The
/// query fails with a message the UI files as cancelled, the in-memory database must
/// keep its rows (a quarantine would discard them) and the file-backed one must give
/// its file lock back once idle.
#[test]
fn duckdb_cancel_interrupts_and_leaves_connection_usable() {
    use std::sync::mpsc::RecvTimeoutError;
    use std::time::{Duration, Instant};
    const LONG: &str = "SELECT count(*) FROM range(100000000000) t(x) WHERE x % 7 = 3";

    let path = std::env::temp_dir().join(format!("tusk_cancel_{}.duckdb", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let file_cfg = ConnectionConfig {
        path: Some(path.to_string_lossy().into_owned()),
        ..duck_cfg()
    };
    let rt = tokio::runtime::Runtime::new().unwrap();
    for cfg in [duck_cfg(), file_cfg] {
        let (b, _version) = rt.block_on(connect(&cfg)).unwrap();
        let (b, ()) = duck_step(b, "setup", |mut b| async move {
            exec(&mut b, r#"CREATE TABLE "main"."tusk_cancel" (id INTEGER)"#).await;
            exec(&mut b, r#"INSERT INTO "main"."tusk_cancel" VALUES (1)"#).await;
            (b, ())
        });

        let handle = b.cancel_handle();
        assert!(
            matches!(handle, crate::driver::CancelHandle::Duck(_)),
            "DuckDB arms its interrupt handle"
        );
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let mut b = b;
            let out = rt.block_on(async {
                b.rollback_cursor().await;
                b.run_single(LONG, 100, cursorable(LONG)).await
            });
            let _ = tx.send((b, out));
        });
        // A query clears a pending interrupt when it starts, so one that lands before
        // the query is under way is lost: keep cancelling until the query stops.
        let deadline = Instant::now() + Duration::from_secs(30);
        let (b, outcome) = loop {
            rt.block_on(handle.clone().cancel(&cfg))
                .unwrap_or_else(|e| panic!("cancel refused: {}", e.message));
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(out) => break out,
                Err(RecvTimeoutError::Timeout) if Instant::now() < deadline => {}
                // The blocked worker keeps the backend; it is leaked with the thread.
                Err(RecvTimeoutError::Timeout) => {
                    panic!("the cancelled DuckDB query never stopped")
                }
                Err(RecvTimeoutError::Disconnected) => {
                    std::panic::resume_unwind(worker.join().expect_err("worker sent nothing"))
                }
            }
        };
        let err = outcome.expect_err("the cancelled query fails");
        // Named as a cancellation: the frontend files an outcome as cancelled, not
        // failed, only when the message says "cancel" (`isCancelMessage`).
        assert_eq!(
            err.message, "query cancelled (DuckDB: Interrupted!)",
            "an interrupt reads as a cancel, never as a quarantine"
        );

        let (b, one) = duck_step(b, "the next query", |mut b| async move {
            let one = all(&mut b, "SELECT 1").await;
            (b, one)
        });
        assert_eq!(one[0][0].as_deref(), Some("1"));

        let (b, tree) = duck_step(b, "the Explorer refresh", |b| async move {
            let tree = b.build_tree().await;
            (b, tree)
        });
        let tree = tree.expect("build_tree");
        let main = tree
            .schemas
            .iter()
            .find(|s| s.name == "main")
            .expect("main schema");
        let tables: Vec<&str> = main.tables.iter().map(|t| t.name.as_str()).collect();
        assert!(tables.contains(&"tusk_cancel"), "{tables:?}");

        let (b, count) = duck_step(b, "the next write", |mut b| async move {
            exec(&mut b, r#"INSERT INTO "main"."tusk_cancel" VALUES (2)"#).await;
            let count = all(&mut b, r#"SELECT count(*) FROM "main"."tusk_cancel""#).await;
            (b, count)
        });
        assert_eq!(count[0][0].as_deref(), Some("2"), "rows kept, write landed");

        if cfg.path.as_deref() != Some(":memory:") {
            let reopen_cfg = cfg.clone();
            let (_b, reopened) = duck_step(b, "releasing the file", |b| async move {
                b.release_idle(false);
                let closed = b.is_closed();
                // DuckDB takes an exclusive lock per process: a second open fails
                // while the first connection (or a leaked one) still holds the file.
                let reopened = match connect(&reopen_cfg).await {
                    Ok((mut other, _)) => {
                        Ok(all(&mut other, r#"SELECT count(*) FROM "main"."tusk_cancel""#).await)
                    }
                    Err(e) => Err(e.message),
                };
                (b, (closed, reopened))
            });
            assert!(reopened.0, "released when idle");
            let rows = reopened.1.expect("file lock freed after a cancel");
            assert_eq!(rows[0][0].as_deref(), Some("2"));
        }
    }
    let _ = std::fs::remove_file(&path);
}

async fn duck_backup(
    b: &mut Backend,
    tag: &str,
    options: &crate::backup::BackupOptions,
) -> (crate::backup::BackupSummary, String, std::path::PathBuf) {
    let path = std::env::temp_dir().join(format!("tusk_duck_seq_{tag}_{}.sql", std::process::id()));
    let flag = std::sync::atomic::AtomicBool::new(false);
    let summary = crate::backup::run_backup(
        b,
        "conformance",
        options,
        &path.to_string_lossy(),
        &flag,
        &mut |_| {},
    )
    .await
    .unwrap_or_else(|e| panic!("[{tag}] backup: {}", e.message));
    let text = std::fs::read_to_string(&path).unwrap();
    (summary, text, path)
}

async fn duck_restore(b: &mut Backend, tag: &str, path: &std::path::Path) {
    let restored = crate::backup::run_restore(
        b,
        TransactionEngine::DuckDb,
        &path.to_string_lossy(),
        &crate::backup::RestoreOptions {
            stop_on_error: true,
            single_transaction: false,
        },
        &std::sync::atomic::AtomicBool::new(false),
        &mut |_| {},
    )
    .await
    .unwrap_or_else(|e| panic!("[{tag}] restore: {}", e.message));
    assert_eq!(
        restored.statements_failed, 0,
        "[{tag}] restore errors: {:?}",
        restored.first_error
    );
}

/// DuckDB tables whose keys default to `nextval('…')` survive backup → drop → restore.
/// The dump creates each sequence before the tables (DuckDB checks a default's sequence
/// at CREATE TABLE), at the source's NEXT value — DuckDB has no `setval`, so the
/// position travels in the stored `START`. A `tables` selection carries only the
/// sequences its defaults name, resolved the way DuckDB binds them (an unqualified name
/// in the table's own schema first); drops leave out `CASCADE`, which on DuckDB drops
/// dependent tables; an exhausted sequence is replayed exhausted; and a data-only dump
/// warns that it cannot move positions.
#[tokio::test]
async fn duckdb_backup_restores_sequences() {
    let (mut b, _v) = connect(&duck_cfg()).await.unwrap();
    let teardown: Vec<String> = [
        r#"DROP TABLE IF EXISTS "x"."bk_t""#,
        r#"DROP TABLE IF EXISTS "main"."bk_s""#,
        r#"DROP SEQUENCE IF EXISTS "main"."bk_seq""#,
        r#"DROP SEQUENCE IF EXISTS "main"."bk_unused""#,
        r#"DROP SEQUENCE IF EXISTS "main"."bk_done""#,
        r#"DROP SEQUENCE IF EXISTS "x"."we'ird seq""#,
    ]
    .map(String::from)
    .to_vec();
    for sql in [
        r#"CREATE SCHEMA "x""#,
        r#"CREATE SEQUENCE "main"."bk_seq" START 5 INCREMENT BY 2"#,
        r#"CREATE SEQUENCE "main"."bk_unused""#,
        r#"CREATE SEQUENCE "main"."bk_done" MAXVALUE 2"#,
        r#"CREATE SEQUENCE "x"."we'ird seq" START 100"#,
        r#"CREATE TABLE "main"."bk_s" (id INTEGER DEFAULT nextval('bk_seq') PRIMARY KEY, v VARCHAR)"#,
        // Unqualified: binds to x's own sequence. Qualified: main's, shared with bk_s.
        r#"CREATE TABLE "x"."bk_t" (id INTEGER DEFAULT nextval('we''ird seq'), w INTEGER DEFAULT nextval('main.bk_seq'))"#,
        r#"INSERT INTO "main"."bk_s" (v) VALUES ('a'), ('b'), ('c')"#,
        r#"INSERT INTO "x"."bk_t" DEFAULT VALUES"#,
    ] {
        exec(&mut b, sql).await;
    }
    for _ in 0..2 {
        all(&mut b, "SELECT nextval('main.bk_done')").await;
    }
    // bk_seq issued 5, 7, 9 (bk_s) and 11 (bk_t.w): its next value is 13.

    // --- a `tables` selection: one table, the one sequence it names ---
    let only_s = crate::backup::BackupOptions {
        scope: "tables".into(),
        schemas: Vec::new(),
        tables: vec![crate::backup::QualifiedName {
            schema: "main".into(),
            name: "bk_s".into(),
        }],
        content: "all".into(),
        include_drop: true,
        single_transaction: false,
    };
    let (summary, text, path) = duck_backup(&mut b, "tables", &only_s).await;
    assert!(
        summary.warnings.iter().all(|w| !w.contains("sequence")),
        "{:?}",
        summary.warnings
    );
    let create_seq = text
        .find(r#"CREATE SEQUENCE "main"."bk_seq" "#)
        .unwrap_or_else(|| panic!("the referenced sequence is created:\n{text}"));
    let create_table = text
        .find("CREATE TABLE bk_s")
        .unwrap_or_else(|| panic!("the table is created:\n{text}"));
    assert!(create_seq < create_table, "sequence before table:\n{text}");
    assert!(
        text.contains("START 13 "),
        "the next value travels:\n{text}"
    );
    assert!(
        text.contains("DROP SEQUENCE IF EXISTS \"main\".\"bk_seq\";\n"),
        "dropped without CASCADE:\n{text}"
    );
    for absent in ["bk_unused", "bk_done", "ird seq", "CASCADE"] {
        assert!(
            !text.contains(absent),
            "{absent} is not in a bk_s dump:\n{text}"
        );
    }
    reset(&mut b, &teardown).await;
    duck_restore(&mut b, "tables", &path).await;
    let rows = all(&mut b, r#"SELECT id, v FROM "main"."bk_s" ORDER BY id"#).await;
    assert_eq!(
        rows.iter().map(|r| cell(r, 0)).collect::<Vec<_>>(),
        ["5", "7", "9"].map(|s| Some(s.to_string())).to_vec()
    );
    exec(&mut b, r#"INSERT INTO "main"."bk_s" (v) VALUES ('d')"#).await;
    let next = all(&mut b, r#"SELECT id FROM "main"."bk_s" WHERE v = 'd'"#).await;
    assert_eq!(
        cell(&next[0], 0).as_deref(),
        Some("13"),
        "numbering continues"
    );
    let _ = std::fs::remove_file(&path);

    // --- the whole database: every sequence, the exhausted one included ---
    reset(&mut b, &teardown).await;
    for sql in [
        r#"CREATE SEQUENCE "main"."bk_seq" START 5 INCREMENT BY 2"#,
        r#"CREATE SEQUENCE "main"."bk_unused""#,
        r#"CREATE SEQUENCE "main"."bk_done" MAXVALUE 2"#,
        r#"CREATE SEQUENCE "x"."we'ird seq" START 100"#,
        r#"CREATE TABLE "main"."bk_s" (id INTEGER DEFAULT nextval('bk_seq') PRIMARY KEY, v VARCHAR)"#,
        r#"CREATE TABLE "x"."bk_t" (id INTEGER DEFAULT nextval('we''ird seq'), w INTEGER DEFAULT nextval('main.bk_seq'))"#,
        r#"INSERT INTO "main"."bk_s" (v) VALUES ('a'), ('b'), ('c')"#,
        r#"INSERT INTO "x"."bk_t" DEFAULT VALUES"#,
    ] {
        exec(&mut b, sql).await;
    }
    for _ in 0..2 {
        all(&mut b, "SELECT nextval('main.bk_done')").await;
    }
    let whole = crate::backup::BackupOptions {
        scope: "database".into(),
        tables: Vec::new(),
        ..only_s.clone()
    };
    let (summary, text, path) = duck_backup(&mut b, "database", &whole).await;
    assert!(
        summary.warnings.iter().all(|w| !w.contains("sequence")),
        "{:?}",
        summary.warnings
    );
    for seq in [
        r#"CREATE SEQUENCE "main"."bk_seq" "#,
        r#"CREATE SEQUENCE "main"."bk_unused" "#,
        r#"CREATE SEQUENCE "main"."bk_done" "#,
        r#"CREATE SEQUENCE "x"."we'ird seq" "#,
    ] {
        assert!(text.contains(seq), "{seq}:\n{text}");
    }
    assert!(
        text.contains(r#"SELECT nextval('"main"."bk_done"')"#),
        "the exhausted sequence is consumed again:\n{text}"
    );
    reset(&mut b, &teardown).await;
    duck_restore(&mut b, "database", &path).await;
    // A second restore runs its drops against live dependencies: tables go first, so
    // the CASCADE-free sequence drops succeed.
    duck_restore(&mut b, "database again", &path).await;
    exec(&mut b, r#"INSERT INTO "x"."bk_t" DEFAULT VALUES"#).await;
    let rows = all(&mut b, r#"SELECT id, w FROM "x"."bk_t" ORDER BY id"#).await;
    assert_eq!(
        rows,
        vec![
            vec![Some("100".to_string()), Some("11".to_string())],
            vec![Some("101".to_string()), Some("13".to_string())],
        ],
        "both defaults resolve and continue"
    );
    let fresh = all(&mut b, "SELECT nextval('main.bk_unused')").await;
    assert_eq!(cell(&fresh[0], 0).as_deref(), Some("1"));
    // Exhausted like the source: its last value is the bound and its next one is past
    // it. Read from the catalog rather than by calling nextval and expecting the error
    // — on Windows the bundled DuckDB leaves the sequence's lock held after that error,
    // and every later read of `duckdb_sequences()` fails or blocks.
    let done = all(
        &mut b,
        "SELECT last_value, max_value, sql FROM duckdb_sequences() WHERE sequence_name = 'bk_done'",
    )
    .await;
    assert_eq!(
        cell(&done[0], 0),
        cell(&done[0], 1),
        "last value is the bound"
    );
    assert!(
        cell(&done[0], 2).is_some_and(|sql| sql.contains("MAXVALUE 2 START 3 ")),
        "{done:?}"
    );
    let _ = std::fs::remove_file(&path);

    // --- data only: no CREATE, so no way to move a position ---
    let data_only = crate::backup::BackupOptions {
        content: "data".into(),
        ..only_s.clone()
    };
    let (summary, text, path) = duck_backup(&mut b, "data", &data_only).await;
    assert!(!text.contains("CREATE SEQUENCE"), "{text}");
    assert!(
        summary.warnings.iter().any(|w| w.contains("setval")),
        "{:?}",
        summary.warnings
    );
    let _ = std::fs::remove_file(&path);
    reset(&mut b, &teardown).await;
}

/// A dump WITHOUT drops restores beside a sequence that is still there. A DuckDB
/// sequence outlives the table numbering from it, so dropping only the table and
/// restoring its backup into the same database used to stop at `CREATE SEQUENCE`
/// ("already exists"). The dump now says `IF NOT EXISTS`, leaves out the consuming
/// `nextval` of an exhausted sequence, and the live sequence keeps its position. The
/// backup runs wrapped in one transaction, the UI's default.
#[tokio::test]
async fn duckdb_backup_without_drops_restores_beside_a_live_sequence() {
    let (mut b, _v) = connect(&duck_cfg()).await.unwrap();
    let teardown: Vec<String> = [
        r#"DROP TABLE IF EXISTS "main"."nd_t""#,
        r#"DROP SEQUENCE IF EXISTS "main"."nd_seq""#,
        r#"DROP SEQUENCE IF EXISTS "main"."nd_done""#,
    ]
    .map(String::from)
    .to_vec();
    for sql in [
        r#"CREATE SEQUENCE "main"."nd_seq""#,
        r#"CREATE SEQUENCE "main"."nd_done" MAXVALUE 2"#,
        r#"CREATE TABLE "main"."nd_t" (id INTEGER DEFAULT nextval('nd_seq') PRIMARY KEY, d INTEGER DEFAULT nextval('nd_done'))"#,
        // ids 1, 2 and d 1, 2: nd_done is now exhausted.
        r#"INSERT INTO "main"."nd_t" DEFAULT VALUES"#,
        r#"INSERT INTO "main"."nd_t" DEFAULT VALUES"#,
    ] {
        exec(&mut b, sql).await;
    }
    let opts = crate::backup::BackupOptions {
        scope: "tables".into(),
        schemas: Vec::new(),
        tables: vec![crate::backup::QualifiedName {
            schema: "main".into(),
            name: "nd_t".into(),
        }],
        content: "all".into(),
        include_drop: false,
        single_transaction: true,
    };
    let (_summary, text, path) = duck_backup(&mut b, "no drops", &opts).await;
    for seq in [
        r#"CREATE SEQUENCE IF NOT EXISTS "main"."nd_seq" "#,
        r#"CREATE SEQUENCE IF NOT EXISTS "main"."nd_done" "#,
    ] {
        assert!(text.contains(seq), "{seq}:\n{text}");
    }
    assert!(
        !text.contains("SELECT nextval("),
        "no consuming nextval in a dump without drops:\n{text}"
    );
    // Drop only the table: DuckDB leaves both sequences in place.
    exec(&mut b, r#"DROP TABLE "main"."nd_t""#).await;
    duck_restore(&mut b, "no drops", &path).await;
    let rows = all(&mut b, r#"SELECT id, d FROM "main"."nd_t" ORDER BY id"#).await;
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_eq!(cell(&rows[1], 0).as_deref(), Some("2"));
    let next = all(&mut b, "SELECT nextval('main.nd_seq')").await;
    assert_eq!(
        cell(&next[0], 0).as_deref(),
        Some("3"),
        "the live position is kept"
    );
    reset(&mut b, &teardown).await;
    let _ = std::fs::remove_file(&path);
}

/// The backup reads which sequence a default names the way DuckDB's binder does, and
/// this checks that against DuckDB itself rather than against Tusk's reading of the
/// binder: from a table in schema `s`, `memory.bind_seq` is the catalog `memory`
/// searched like an unqualified name — the table's schema first — so it is `s`'s
/// sequence, not `main`'s. `'main.cast_seq'::VARCHAR` comes back from
/// `duckdb_columns()` as a CAST and still names its sequence. And an ATTACHed
/// database holding the same schema.table lends the table detail and the dump nothing.
#[tokio::test]
async fn duckdb_backup_resolves_sequences_like_the_binder() {
    let (mut b, _v) = connect(&duck_cfg()).await.unwrap();
    for sql in [
        r#"CREATE SCHEMA "s""#,
        r#"CREATE SEQUENCE "main"."bind_seq" START 100"#,
        r#"CREATE SEQUENCE "s"."bind_seq" START 500"#,
        r#"CREATE SEQUENCE "main"."cast_seq" START 900"#,
        r#"CREATE TABLE "s"."bind_t" (a INTEGER DEFAULT nextval('memory.bind_seq'), b INTEGER DEFAULT nextval('main.cast_seq'::VARCHAR), v VARCHAR)"#,
        r#"INSERT INTO "s"."bind_t" (v) VALUES ('x')"#,
        "ATTACH ':memory:' AS other",
        r#"CREATE SCHEMA other."s""#,
        r#"CREATE SEQUENCE other."s"."bind_other" START 7"#,
        r#"CREATE TABLE other."s"."bind_t" (z INTEGER DEFAULT nextval('other.s.bind_other'))"#,
    ] {
        exec(&mut b, sql).await;
    }
    let rows = all(&mut b, r#"SELECT a, b FROM "s"."bind_t""#).await;
    assert_eq!(
        rows,
        vec![vec![Some("500".to_string()), Some("900".to_string())]],
        "DuckDB bound memory.bind_seq to s's sequence"
    );
    let rendered = all(
        &mut b,
        "SELECT column_default FROM duckdb_columns() WHERE database_name = current_database() \
         AND table_name = 'bind_t' AND column_name = 'b'",
    )
    .await;
    assert_eq!(
        cell(&rendered[0], 0).as_deref(),
        Some("nextval(CAST('main.cast_seq' AS VARCHAR))"),
        "the cast is what the catalog hands back"
    );

    let detail = b.table_detail("s", "bind_t").await.expect("table detail");
    let names: Vec<&str> = detail.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(
        names,
        ["a", "b", "v"],
        "the attached bind_t adds no columns"
    );

    let opts = crate::backup::BackupOptions {
        scope: "tables".into(),
        schemas: Vec::new(),
        tables: vec![crate::backup::QualifiedName {
            schema: "s".into(),
            name: "bind_t".into(),
        }],
        content: "all".into(),
        include_drop: true,
        single_transaction: false,
    };
    let (summary, text, path) = duck_backup(&mut b, "binder", &opts).await;
    assert!(
        summary.warnings.iter().all(|w| !w.contains("sequence")),
        "{:?}",
        summary.warnings
    );
    for carried in [
        r#"CREATE SEQUENCE "s"."bind_seq" "#,
        r#"CREATE SEQUENCE "main"."cast_seq" "#,
    ] {
        assert!(text.contains(carried), "{carried}:\n{text}");
    }
    assert!(
        !text.contains(r#""main"."bind_seq""#),
        "main's namesake is not the sequence DuckDB bound:\n{text}"
    );
    assert!(!text.contains("bind_other"), "{text}");

    exec(&mut b, "DETACH other").await;
    reset(
        &mut b,
        &[
            r#"DROP TABLE IF EXISTS "s"."bind_t""#.to_string(),
            r#"DROP SEQUENCE IF EXISTS "s"."bind_seq""#.to_string(),
            r#"DROP SEQUENCE IF EXISTS "main"."cast_seq""#.to_string(),
        ],
    )
    .await;
    duck_restore(&mut b, "binder", &path).await;
    exec(&mut b, r#"INSERT INTO "s"."bind_t" (v) VALUES ('y')"#).await;
    let rows = all(&mut b, r#"SELECT a, b FROM "s"."bind_t" ORDER BY a"#).await;
    assert_eq!(
        rows,
        vec![
            vec![Some("500".to_string()), Some("900".to_string())],
            vec![Some("501".to_string()), Some("901".to_string())],
        ],
        "both defaults continue from the restored sequences"
    );
    let _ = std::fs::remove_file(&path);
}

/// A DuckDB FILE keeps no table → sequence dependency once it is closed and reopened
/// (`duckdb_dependencies()` comes back empty), which is why the backup reads column
/// defaults instead of the dependency catalog. Pinned on a real reopen: the source
/// file is written, closed and reopened before the backup, and the restore target is
/// a second file that is itself closed and reopened before its numbering is checked.
#[tokio::test]
async fn duckdb_backup_after_a_reopen_carries_sequences() {
    let dir = std::env::temp_dir();
    let pid = std::process::id();
    let src = dir.join(format!("tusk_seq_reopen_src_{pid}.duckdb"));
    let dst = dir.join(format!("tusk_seq_reopen_dst_{pid}.duckdb"));
    let clean = || {
        for p in [&src, &dst] {
            let _ = std::fs::remove_file(p);
            let _ = std::fs::remove_file(p.with_extension("duckdb.wal"));
        }
    };
    clean();
    let file = |p: &std::path::Path| ConnectionConfig {
        path: Some(p.to_string_lossy().into_owned()),
        ..duck_cfg()
    };
    {
        let (mut b, _v) = connect(&file(&src)).await.unwrap();
        for sql in [
            r#"CREATE SCHEMA "app""#,
            r#"CREATE SEQUENCE "app"."ids" START 10"#,
            r#"CREATE TABLE "app"."items" (id INTEGER DEFAULT nextval('ids') PRIMARY KEY, v VARCHAR)"#,
            r#"INSERT INTO "app"."items" (v) VALUES ('a'), ('b')"#,
        ] {
            exec(&mut b, sql).await;
        }
    } // closed
    let (mut b, _v) = connect(&file(&src)).await.unwrap();
    let opts = crate::backup::BackupOptions {
        scope: "tables".into(),
        schemas: Vec::new(),
        tables: vec![crate::backup::QualifiedName {
            schema: "app".into(),
            name: "items".into(),
        }],
        content: "all".into(),
        include_drop: true,
        single_transaction: true,
    };
    let (summary, text, dump) = duck_backup(&mut b, "reopen", &opts).await;
    assert!(
        summary.warnings.iter().all(|w| !w.contains("sequence")),
        "{:?}",
        summary.warnings
    );
    assert!(
        text.contains(r#"CREATE SEQUENCE "app"."ids" "#),
        "the reopened file's sequence is carried:\n{text}"
    );
    assert!(text.contains("START 12 "), "its position travels:\n{text}");
    drop(b);
    {
        let (mut b, _v) = connect(&file(&dst)).await.unwrap();
        duck_restore(&mut b, "reopen", &dump).await;
    } // closed
    let (mut b, _v) = connect(&file(&dst)).await.unwrap();
    exec(&mut b, r#"INSERT INTO "app"."items" (v) VALUES ('c')"#).await;
    let rows = all(&mut b, r#"SELECT id, v FROM "app"."items" ORDER BY id"#).await;
    assert_eq!(
        rows.iter().map(|r| cell(r, 0)).collect::<Vec<_>>(),
        ["10", "11", "12"].map(|s| Some(s.to_string())).to_vec(),
        "numbering continues in the restored, reopened file"
    );
    drop(b);
    let _ = std::fs::remove_file(&dump);
    clean();
}

/// MySQL lists stored procedures and functions in the Explorer (routine type in
/// `returns`), and "View definition" shows `SHOW CREATE PROCEDURE|FUNCTION`. One name
/// can be a procedure AND a function on MySQL, so each node asks for its own type;
/// kind "routine" looks the type up and shows both. The drop forms are the ones
/// `sql/ddl.ts` emits for MySQL (`dropFunction` in `ddl.test.ts`).
#[tokio::test]
async fn mysql_routines_listed_and_defined() {
    let Some(cfg) = mysql_cfg() else {
        eprintln!("SKIP mysql_routines_listed_and_defined (set TUSK_TEST_MYSQL_PORT)");
        return;
    };
    let (mut b, _v) = connect(&cfg).await.expect("connect mysql");
    for sql in [
        "DROP PROCEDURE IF EXISTS `test`.`tusk_p`",
        "DROP FUNCTION IF EXISTS `test`.`tusk_f`",
        "DROP PROCEDURE IF EXISTS `test`.`tusk_both`",
        "DROP FUNCTION IF EXISTS `test`.`tusk_both`",
        "CREATE PROCEDURE `test`.`tusk_p`(IN n INT) SELECT n + 1 AS next_n",
        "CREATE FUNCTION `test`.`tusk_f`(x INT) RETURNS INT DETERMINISTIC RETURN x * 2",
        "CREATE PROCEDURE `test`.`tusk_both`() SELECT 1",
        "CREATE FUNCTION `test`.`tusk_both`() RETURNS INT DETERMINISTIC RETURN 2",
    ] {
        exec(&mut b, sql).await;
    }

    let tree = b.build_tree().await.expect("build_tree");
    let test = tree
        .schemas
        .iter()
        .find(|s| s.name == "test")
        .expect("test schema");
    let has = |name: &str, returns: &str| {
        test.functions
            .iter()
            .any(|f| f.name == name && f.returns == returns)
    };
    assert!(has("tusk_p", "procedure"), "procedure listed");
    assert!(has("tusk_f", "function"), "function listed");
    assert!(
        has("tusk_both", "procedure") && has("tusk_both", "function"),
        "a name that is both is listed twice"
    );
    assert!(
        !tree.schemas.iter().any(|s| s.name == "sys"),
        "the sys schema (and its routines) stays out"
    );

    // Each Explorer node asks for its own type (`definitionKind` in Tree.tsx).
    let p = b
        .relation_ddl("procedure", "test", "tusk_p")
        .await
        .expect("procedure ddl");
    // Qualified with the schema it came from, so it replays from any default database.
    assert!(p.contains("PROCEDURE `test`.`tusk_p`"), "{p}");
    assert!(p.contains("SELECT n + 1"), "{p}");
    assert!(!p.contains("FUNCTION"), "{p}");
    let f = b
        .relation_ddl("function", "test", "tusk_f")
        .await
        .expect("function ddl");
    assert!(
        f.contains("FUNCTION `test`.`tusk_f`") && f.contains("RETURN x * 2"),
        "{f}"
    );
    let only_proc = b
        .relation_ddl("procedure", "test", "tusk_both")
        .await
        .expect("procedure-only ddl");
    assert!(
        only_proc.contains("PROCEDURE `test`.`tusk_both`") && !only_proc.contains("FUNCTION"),
        "{only_proc}"
    );
    let only_fn = b
        .relation_ddl("function", "test", "tusk_both")
        .await
        .expect("function-only ddl");
    assert!(
        only_fn.contains("FUNCTION `test`.`tusk_both`") && !only_fn.contains("PROCEDURE"),
        "{only_fn}"
    );
    // A caller that does not know the type looks it up, and a name that is both
    // shows both, procedure first.
    let looked_up = b
        .relation_ddl("routine", "test", "tusk_p")
        .await
        .expect("looked-up ddl");
    assert!(
        looked_up.contains("PROCEDURE `test`.`tusk_p`"),
        "{looked_up}"
    );
    let both = b
        .relation_ddl("routine", "test", "tusk_both")
        .await
        .expect("both ddl");
    let (pi, fi) = (
        both.find("PROCEDURE `test`.`tusk_both`")
            .expect("procedure part"),
        both.find("FUNCTION `test`.`tusk_both`")
            .expect("function part"),
    );
    assert!(pi < fi, "procedure first: {both}");
    assert!(b
        .relation_ddl("routine", "test", "tusk_missing")
        .await
        .is_err());
    assert!(b.relation_ddl("function", "test", "tusk_p").await.is_err());

    // The definition replays after the Explorer's drop.
    exec(&mut b, "DROP PROCEDURE `test`.`tusk_p`").await;
    exec(&mut b, &p).await;
    exec(&mut b, "DROP FUNCTION `test`.`tusk_f`").await;
    exec(&mut b, &f).await;
    let rows = all(&mut b, "SELECT `test`.`tusk_f`(21)").await;
    assert_eq!(rows[0][0].as_deref(), Some("42"));

    for sql in [
        "DROP PROCEDURE `test`.`tusk_p`",
        "DROP FUNCTION `test`.`tusk_f`",
        "DROP PROCEDURE `test`.`tusk_both`",
        "DROP FUNCTION `test`.`tusk_both`",
    ] {
        exec(&mut b, sql).await;
    }
}

/// Compound stored programs — `BEGIN … END` bodies with their own `;` — run as ONE
/// statement through the command path (planner + `run_script` for a script,
/// `run_single` for one statement), come back from `relation_ddl` as one statement, and
/// replay after a drop. A backup carries them and restores them into their own
/// database. The body also uses a column named `end`: BEGIN/END are not reserved in
/// MySQL, and the lexer has to agree with the server about which END closes the body.
#[tokio::test]
async fn mysql_compound_routines_run_replay_and_restore() {
    let Some(cfg) = mysql_cfg() else {
        eprintln!("SKIP mysql_compound_routines_run_replay_and_restore (set TUSK_TEST_MYSQL_PORT)");
        return;
    };
    let mysql = TransactionEngine::MySql;
    let items = |sql: &str| crate::script::parse_for_engine(sql, mysql).unwrap();
    let mut c = state(&cfg, false).await;

    // One script: drops, a table, a procedure, a function and a trigger, all compound.
    let setup = "DROP TRIGGER IF EXISTS `test`.`tusk_cmp_t`;
DROP PROCEDURE IF EXISTS `test`.`tusk_cmp_p`;
DROP FUNCTION IF EXISTS `test`.`tusk_cmp_f`;
DROP TABLE IF EXISTS `test`.`tusk_cmp_log`;
CREATE TABLE `test`.`tusk_cmp_log` (id INT AUTO_INCREMENT PRIMARY KEY, n INT, `end` INT);
CREATE PROCEDURE `test`.`tusk_cmp_p`(IN cnt INT)
BEGIN
  DECLARE i INT DEFAULT 0;
  fill: LOOP
    SET i = i + 1;
    IF i > cnt THEN LEAVE fill; END IF;
    INSERT INTO tusk_cmp_log (n) VALUES (CASE WHEN i % 2 = 0 THEN -i ELSE i END);
  END LOOP fill;
  UPDATE tusk_cmp_log SET end = n WHERE end IS NULL;
END;
CREATE FUNCTION `test`.`tusk_cmp_f`(x INT) RETURNS INT DETERMINISTIC
BEGIN
  DECLARE acc INT DEFAULT 0;
  WHILE x > 0 DO SET acc = acc + x; SET x = x - 1; END WHILE;
  RETURN CASE WHEN acc > 100 THEN 100 ELSE acc END;
END;
CREATE TRIGGER `test`.`tusk_cmp_t` BEFORE INSERT ON `test`.`tusk_cmp_log` FOR EACH ROW
BEGIN
  IF NEW.n < 0 THEN SET NEW.n = 0; END IF;
END;";
    let script = items(setup);
    assert_eq!(script.len(), 8, "one item per statement");
    command_exec(&mut c, &script)
        .await
        .unwrap_or_else(|e| panic!("compound script: {}", e.message));

    // A single compound statement takes the run_single path.
    command_exec(&mut c, &items("CALL `test`.`tusk_cmp_p`(4)"))
        .await
        .unwrap_or_else(|e| panic!("call: {}", e.message));
    let b = &mut c.backend;
    let rows = all(b, "SELECT n, `end` FROM `test`.`tusk_cmp_log` ORDER BY id").await;
    let got: Vec<(Option<String>, Option<String>)> =
        rows.iter().map(|r| (cell(r, 0), cell(r, 1))).collect();
    let want = |n: &str| (Some(n.to_string()), Some(n.to_string()));
    assert_eq!(got, vec![want("1"), want("0"), want("3"), want("0")]);
    let rows = all(b, "SELECT `test`.`tusk_cmp_f`(4), `test`.`tusk_cmp_f`(20)").await;
    assert_eq!(
        (cell(&rows[0], 0), cell(&rows[0], 1)),
        (Some("10".into()), Some("100".into()))
    );

    // Read back as one statement and replay after a drop, through the planner again.
    let p = b
        .relation_ddl("procedure", "test", "tusk_cmp_p")
        .await
        .expect("procedure ddl");
    assert!(
        p.contains("PROCEDURE `test`.`tusk_cmp_p`") && p.contains("END LOOP fill"),
        "{p}"
    );
    assert_eq!(items(&p).len(), 1, "{p}");
    let f = b
        .relation_ddl("function", "test", "tusk_cmp_f")
        .await
        .expect("function ddl");
    assert_eq!(items(&f).len(), 1, "{f}");
    exec(b, "DROP PROCEDURE `test`.`tusk_cmp_p`").await;
    exec(b, "DROP FUNCTION `test`.`tusk_cmp_f`").await;
    command_exec(&mut c, &items(&p))
        .await
        .unwrap_or_else(|e| panic!("replay procedure: {}", e.message));
    let b = &mut c.backend;
    exec(b, &f).await;
    exec(b, "CALL `test`.`tusk_cmp_p`(2)").await;
    let rows = all(b, "SELECT COUNT(*), SUM(n) FROM `test`.`tusk_cmp_log`").await;
    assert_eq!(cell(&rows[0], 0).as_deref(), Some("6"));
    let rows = all(b, "SELECT `test`.`tusk_cmp_f`(3)").await;
    assert_eq!(cell(&rows[0], 0).as_deref(), Some("6"));
    for sql in [
        "DROP TRIGGER `test`.`tusk_cmp_t`",
        "DROP PROCEDURE `test`.`tusk_cmp_p`",
        "DROP FUNCTION `test`.`tusk_cmp_f`",
        "DROP TABLE `test`.`tusk_cmp_log`",
    ] {
        exec(b, sql).await;
    }

    // A schema backup carries compound routines (before any view that might call them)
    // and restores them into THEIR database, not the session's default one, under the
    // sql_mode they were created with. A routine the restore could not replay (a
    // backslash-escaped quote) is left out with a warning — and not dropped either —
    // instead of stopping the restore after the tables and data; the foreign keys come
    // before every routine, so they cannot be lost to one.
    for sql in [
        "DROP DATABASE IF EXISTS `tusk_bk_routines`",
        "CREATE DATABASE `tusk_bk_routines`",
        "CREATE FUNCTION `tusk_bk_routines`.`tusk_bk_f`(x INT) RETURNS INT DETERMINISTIC BEGIN DECLARE y INT DEFAULT 0; SET y = x * 3; RETURN y; END",
        "CREATE PROCEDURE `tusk_bk_routines`.`tusk_bk_p`() BEGIN DECLARE z INT; SET z = 1; SELECT z; END",
        "CREATE TABLE `tusk_bk_routines`.`tusk_bk_parent` (id INT PRIMARY KEY)",
        "CREATE TABLE `tusk_bk_routines`.`tusk_bk_child` (id INT PRIMARY KEY, parent_id INT, CONSTRAINT `tusk_bk_child_fk` FOREIGN KEY (parent_id) REFERENCES `tusk_bk_routines`.`tusk_bk_parent` (id))",
        "INSERT INTO `tusk_bk_routines`.`tusk_bk_parent` VALUES (1), (2)",
        "INSERT INTO `tusk_bk_routines`.`tusk_bk_child` VALUES (10, 1), (20, 2)",
        "CREATE VIEW `tusk_bk_routines`.`tusk_bk_v` AS SELECT `tusk_bk_routines`.`tusk_bk_f`(id) AS tripled FROM `tusk_bk_routines`.`tusk_bk_child`",
    ] {
        exec(b, sql).await;
    }
    // Created on a raw session: Tusk's own lexer refuses `\'` (it is ambiguous under
    // NO_BACKSLASH_ESCAPES), and PIPES_AS_CONCAT must be the session's mode at CREATE.
    if let Backend::MySql(m) = &*b {
        use mysql_async::prelude::Queryable;
        let mut raw = m.pool.get_conn().await.expect("raw mysql connection");
        for sql in [
            r"CREATE PROCEDURE `tusk_bk_routines`.`tusk_bk_esc`() BEGIN SELECT 'can\'t'; END",
            "SET SESSION sql_mode = 'PIPES_AS_CONCAT'",
            "CREATE FUNCTION `tusk_bk_routines`.`tusk_bk_concat`() RETURNS VARCHAR(10) DETERMINISTIC RETURN 'a' || 'b'",
        ] {
            raw.query_drop(sql)
                .await
                .unwrap_or_else(|e| panic!("raw [{sql}]: {e}"));
        }
    }
    let options = crate::backup::BackupOptions {
        scope: "schemas".into(),
        schemas: vec!["tusk_bk_routines".into()],
        tables: Vec::new(),
        content: "all".into(),
        include_drop: true,
        single_transaction: false,
    };
    let path =
        std::env::temp_dir().join(format!("tusk_backup_routines_{}.sql", std::process::id()));
    let pth = path.to_string_lossy().to_string();
    let flag = std::sync::atomic::AtomicBool::new(false);
    let summary = crate::backup::run_backup(b, "conformance", &options, &pth, &flag, &mut |_| {})
        .await
        .unwrap_or_else(|e| panic!("backup: {}", e.message));
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(
        !summary
            .warnings
            .iter()
            .any(|w| w.contains("functions/procedures")),
        "{:?}",
        summary.warnings
    );
    assert!(
        summary
            .warnings
            .iter()
            .any(|w| w.contains("procedure tusk_bk_routines.tusk_bk_esc is NOT in the dump")),
        "{:?}",
        summary.warnings
    );
    assert!(
        text.contains("DROP FUNCTION IF EXISTS `tusk_bk_routines`.`tusk_bk_f`")
            && text.contains("FUNCTION `tusk_bk_routines`.`tusk_bk_f`(")
            && text.contains("PROCEDURE `tusk_bk_routines`.`tusk_bk_p`()")
            && text.contains("SET SESSION sql_mode = 'PIPES_AS_CONCAT'")
            && !text.contains("tusk_bk_esc`()")
            && !text.contains("DROP PROCEDURE IF EXISTS `tusk_bk_routines`.`tusk_bk_esc`"),
        "{text}"
    );
    let at = |needle: &str| {
        text.find(needle)
            .unwrap_or_else(|| panic!("{needle} missing:\n{text}"))
    };
    assert!(
        at("ADD CONSTRAINT") < at("-- routines") && at("-- routines") < at("-- views"),
        "foreign keys, then routines, then views:\n{text}"
    );
    exec(b, "DROP FUNCTION `tusk_bk_routines`.`tusk_bk_f`").await;
    exec(b, "DROP PROCEDURE `tusk_bk_routines`.`tusk_bk_p`").await;
    let restored = crate::backup::run_restore(
        b,
        mysql,
        &pth,
        &crate::backup::RestoreOptions {
            stop_on_error: true,
            single_transaction: false,
        },
        &std::sync::atomic::AtomicBool::new(false),
        &mut |_| {},
    )
    .await
    .unwrap_or_else(|e| panic!("restore: {}", e.message));
    assert_eq!(
        restored.statements_failed, 0,
        "restore errors: {:?}\n{text}",
        restored.first_error
    );
    let rows = all(b, "SELECT `tusk_bk_routines`.`tusk_bk_f`(5)").await;
    assert_eq!(cell(&rows[0], 0).as_deref(), Some("15"));
    // Recreated under its own sql_mode: `||` still concatenates.
    let rows = all(b, "SELECT `tusk_bk_routines`.`tusk_bk_concat`()").await;
    assert_eq!(cell(&rows[0], 0).as_deref(), Some("ab"));
    let rows = all(
        b,
        "SELECT tripled FROM `tusk_bk_routines`.`tusk_bk_v` ORDER BY tripled",
    )
    .await;
    assert_eq!(
        rows.iter().map(|r| cell(r, 0)).collect::<Vec<_>>(),
        vec![Some("30".to_string()), Some("60".to_string())]
    );
    let rows = all(
        b,
        "SELECT COUNT(*) FROM information_schema.referential_constraints WHERE constraint_schema = 'tusk_bk_routines'",
    )
    .await;
    assert_eq!(
        cell(&rows[0], 0).as_deref(),
        Some("1"),
        "foreign key restored"
    );
    // f, p, concat recreated; esc never dropped.
    let rows = all(
        b,
        "SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = 'tusk_bk_routines'",
    )
    .await;
    assert_eq!(cell(&rows[0], 0).as_deref(), Some("4"));
    let rows = all(
        b,
        "SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = 'test' AND routine_name LIKE 'tusk_bk_%'",
    )
    .await;
    assert_eq!(
        cell(&rows[0], 0).as_deref(),
        Some("0"),
        "nothing restored into the default database"
    );
    exec(b, "DROP DATABASE `tusk_bk_routines`").await;
    let _ = std::fs::remove_file(&path);
}

/// A dedicated session on a MySQL-protocol server (no pool), for checks that read session
/// counters or change session settings.
async fn mysql_session(cfg: &ConnectionConfig) -> mysql_async::Conn {
    let opts = mysql_async::OptsBuilder::default()
        .ip_or_hostname(cfg.host.clone())
        .tcp_port(cfg.port)
        .user(Some(cfg.user.clone()))
        .pass(Some(cfg.password.clone()))
        .db_name((!cfg.dbname.is_empty()).then(|| cfg.dbname.clone()));
    mysql_async::Conn::new(opts).await.expect("session")
}

async fn session_counter(conn: &mut mysql_async::Conn, name: &str) -> u64 {
    use mysql_async::prelude::Queryable;
    let row: Option<(String, String)> = conn
        .query_first(format!("SHOW SESSION STATUS LIKE '{name}'"))
        .await
        .expect(name);
    row.and_then(|(_, v)| v.parse().ok()).expect(name)
}

fn server_code(e: &mysql_async::Error) -> Option<u16> {
    match e {
        mysql_async::Error::Server(s) => Some(s.code),
        _ => None,
    }
}

/// The server-side belt under the MySQL splitter: before COM_QUERY runs a text that holds
/// a `;` before its end, the server must accept it as ONE statement. A text the client kept
/// together but the server reads as several (as a lexer misread would) is refused without
/// running anything; one stored program passes and then runs — including a label written
/// `lbl:begin`, which goes through SQL PREPARE because mysql_async would rewrite it — and
/// the check leaves no prepared statement or variable behind, asks the canary once per
/// connection, commits nothing, keeps a pending `SET TRANSACTION`, and never runs between a
/// statement and the SHOW WARNINGS that reports on it. What the quote-only skip lets
/// through is one statement under ANSI_QUOTES and multi-byte client charsets too, and what
/// it holds back can really read differently there.
async fn one_statement_belt_battery(cfg: &ConnectionConfig, engine: &str) {
    use crate::driver::{
        mysql_protocol_prepare as prepare, mysql_semicolons_only_quoted as skips,
        mysql_server_single_statement as check,
    };
    use mysql_async::prelude::Queryable;
    const REFUSED: &str = "the server could not confirm this is one statement:";
    let (mut b, _v) = connect(cfg).await.expect("connect");
    for sql in [
        "DROP PROCEDURE IF EXISTS `test`.`tusk_belt_p`",
        "DROP PROCEDURE IF EXISTS `test`.`tusk_belt_l`",
        "DROP TABLE IF EXISTS `test`.`tusk_belt_t`",
        "CREATE TABLE `test`.`tusk_belt_t` (id INT)",
        "INSERT INTO `test`.`tusk_belt_t` VALUES (1)",
    ] {
        exec(&mut b, sql).await;
    }
    let mut conn = mysql_session(cfg).await;
    let glued = "CREATE PROCEDURE `test`.`tusk_belt_p`() BEGIN SELECT 1; END; DELETE FROM `test`.`tusk_belt_t`; START TRANSACTION";
    // Every kind of stored program, glued to a second statement: MySQL's 1295 for a
    // stored-program CREATE only ever comes after the whole text parsed, so the second
    // statement is a parse error first.
    let tail = "; DELETE FROM `test`.`tusk_belt_t`";
    let programs = [
        "CREATE TRIGGER `test`.`tusk_belt_tr` BEFORE INSERT ON `test`.`tusk_belt_t` FOR EACH ROW BEGIN SET NEW.id = NEW.id; END",
        "CREATE EVENT `test`.`tusk_belt_e` ON SCHEDULE EVERY 1 DAY DO BEGIN SELECT 1; END",
        "CREATE FUNCTION `test`.`tusk_belt_f`() RETURNS INT DETERMINISTIC BEGIN RETURN 1; END",
    ];
    for text in std::iter::once(glued.to_string())
        .chain(programs.iter().map(|program| format!("{program}{tail}")))
    {
        let refused = check(&mut conn, &text)
            .await
            .expect_err("several statements are refused");
        assert!(
            refused.message.starts_with(REFUSED) && refused.message.contains("syntax"),
            "[{engine}] {text}: {}",
            refused.message
        );
    }
    for one in programs {
        check(&mut conn, one)
            .await
            .unwrap_or_else(|e| panic!("[{engine}] [{one}] {}", e.message));
    }

    // Statements whose `;` the skip will not vouch for (a backslash escape, a `$` outside
    // quotes, a comment) are checked, each after its own canary, and each prepared
    // statement is closed.
    let prepared = session_counter(&mut conn, "Com_stmt_prepare").await;
    let closed = session_counter(&mut conn, "Com_stmt_close").await;
    for one in [
        "INSERT INTO `test`.`tusk_belt_t` VALUES (LENGTH('é\\n;b'))",
        "SELECT 1 AS a$b, ';' AS c",
        "SELECT 1 /* ; */",
    ] {
        assert!(!skips(one), "[{engine}] {one}");
        check(&mut conn, one)
            .await
            .unwrap_or_else(|e| panic!("[{engine}] [{one}] {}", e.message));
    }
    assert_eq!(
        session_counter(&mut conn, "Com_stmt_prepare").await - prepared,
        6,
        "[{engine}] a canary and a prepare per text"
    );
    assert_eq!(
        session_counter(&mut conn, "Com_stmt_close").await - closed,
        3,
        "[{engine}] every prepared statement is closed"
    );

    // One stored program, plainly and with a `lbl:begin` label (SQL PREPARE).
    for one in [
        "CREATE PROCEDURE `test`.`tusk_belt_p`() BEGIN SELECT 1; SELECT 2; END",
        "CREATE PROCEDURE `test`.`tusk_belt_l`() lbl:begin SELECT 1; end lbl",
    ] {
        check(&mut conn, one)
            .await
            .unwrap_or_else(|e| panic!("[{engine}] [{one}] {}", e.message));
    }
    let gone = conn
        .query_drop("EXECUTE __tusk_one_statement")
        .await
        .expect_err("the SQL PREPARE statement is deallocated");
    assert_eq!(server_code(&gone), Some(1243), "[{engine}] {gone}");
    let probe: Option<Option<String>> = conn
        .query_first("SELECT @__tusk_one_statement")
        .await
        .expect("read the check's variable");
    assert_eq!(probe, Some(None), "[{engine}] the variable is cleared");

    // Inside a transaction the check commits nothing and leaves it open, refused or not.
    conn.query_drop("START TRANSACTION").await.expect("start");
    conn.query_drop("INSERT INTO `test`.`tusk_belt_t` VALUES (2)")
        .await
        .expect("insert");
    check(&mut conn, "SELECT 1 /* ; */")
        .await
        .expect("checked in a transaction");
    check(&mut conn, glued).await.expect_err("refused");
    conn.query_drop("ROLLBACK").await.expect("rollback");
    let count: Option<u64> = conn
        .query_first("SELECT COUNT(*) FROM `test`.`tusk_belt_t`")
        .await
        .expect("count");
    assert_eq!(count, Some(1), "[{engine}] the check committed nothing");

    // A diagnostics statement holding a `;` is refused before anything runs, so the
    // warnings it would report survive.
    let _ = conn.query_drop("SELECT CAST('x' AS SIGNED)").await;
    for text in [
        "SHOW WARNINGS /* ; */",
        "SELECT @@warning_count /* ; */",
        "/*!40100 SHOW WARNINGS */ /* ; */",
    ] {
        let refused = check(&mut conn, text)
            .await
            .expect_err("diagnostics refused");
        assert!(
            refused.message.contains("SHOW WARNINGS"),
            "[{engine}] {text}: {}",
            refused.message
        );
    }
    let warnings: Vec<(String, u32, String)> = conn.query("SHOW WARNINGS").await.expect("warnings");
    assert!(
        warnings.iter().any(|w| w.1 == 1292),
        "[{engine}] {warnings:?}"
    );
    drop(conn);

    // A pending SET TRANSACTION survives the check, canary included: it still applies to
    // the transaction the checked text starts.
    // Both mechanisms: COM_STMT_PREPARE, and SQL PREPARE for text with a `:name` in it.
    for start in [
        "START TRANSACTION /* ; */",
        "START TRANSACTION /* at:once; */",
    ] {
        let mut fresh = mysql_session(cfg).await;
        fresh
            .query_drop("SET TRANSACTION READ ONLY")
            .await
            .expect("set transaction");
        check(&mut fresh, start)
            .await
            .unwrap_or_else(|e| panic!("[{engine}] {start}: {}", e.message));
        fresh.query_drop(start).await.expect("start");
        let read_only = fresh
            .query_drop("INSERT INTO `test`.`tusk_belt_t` VALUES (3)")
            .await
            .expect_err("the transaction is read only");
        assert_eq!(
            server_code(&read_only),
            Some(1792),
            "[{engine}] {start}: {read_only}"
        );
        fresh.query_drop("ROLLBACK").await.expect("rollback");
    }

    // The skip under session settings. What it lets through is one statement there; a
    // backtick right after a non-ASCII byte is a trail byte in gbk and sjis, so the
    // server reads `;SELECT 2;` as code, which is why the skip leaves such text to it.
    let trap_gbk = "SELECT 1 AS `ソ`, 2 AS `;SELECT 2;`";
    let trap_sjis = "SELECT 1 AS `ā`, 2 AS `;SELECT 2;`";
    let mut cases = vec![
        (
            "SET SESSION sql_mode = CONCAT(@@sql_mode, ',ANSI_QUOTES')",
            "SELECT 'a;b' AS \"c;d\"",
            true,
            true,
        ),
        ("SET NAMES gbk", "SELECT 'é;' AS `é;`", true, true),
        ("SET NAMES sjis", "SELECT 'é;' AS `é;`", true, true),
        ("SET NAMES utf8mb4", trap_gbk, false, true),
        ("SET NAMES gbk", trap_gbk, false, false),
        ("SET NAMES utf8mb4", trap_sjis, false, true),
        ("SET NAMES sjis", trap_sjis, false, false),
    ];
    if engine == "mariadb" {
        // MariaDB's MSSQL mode quotes identifiers with brackets, which can hold a `'`.
        cases.push((
            "SET SESSION sql_mode = 'MSSQL'",
            "SELECT 1 AS [a'b]; SELECT 2 AS [c'd]",
            false,
            false,
        ));
    }
    for (setup, text, skipped, one) in cases {
        assert_eq!(skips(text), skipped, "[{engine}] {text}");
        let mut s = mysql_session(cfg).await;
        s.query_drop(setup).await.expect(setup);
        let answer = prepare(&mut s, text).await.expect("closed");
        if one {
            assert!(answer.is_ok(), "[{engine}] {setup}: {text}: {answer:?}");
        } else {
            let e = answer.expect_err(text);
            assert_eq!(
                server_code(&e),
                Some(1064),
                "[{engine}] {setup}: {text}: {e}"
            );
            let refused = check(&mut s, text).await.expect_err("refused");
            assert!(
                refused.message.starts_with(REFUSED),
                "[{engine}] {}",
                refused.message
            );
        }
    }

    // Nothing of the refused text ran: no procedure, and the row is still there. The
    // `lbl:begin` one runs through the ordinary path.
    let rows = all(
        &mut b,
        "SELECT (SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = 'test' AND routine_name IN ('tusk_belt_p', 'tusk_belt_f')) + (SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = 'test' AND trigger_name = 'tusk_belt_tr') + (SELECT COUNT(*) FROM information_schema.events WHERE event_schema = 'test' AND event_name = 'tusk_belt_e')",
    )
    .await;
    assert_eq!(cell(&rows[0], 0).as_deref(), Some("0"), "[{engine}]");
    let rows = all(&mut b, "SELECT COUNT(*) FROM `test`.`tusk_belt_t`").await;
    assert_eq!(cell(&rows[0], 0).as_deref(), Some("1"), "[{engine}]");
    exec(
        &mut b,
        "CREATE PROCEDURE `test`.`tusk_belt_l`() lbl:begin SELECT 1; end lbl",
    )
    .await;
    exec(&mut b, "DROP PROCEDURE `test`.`tusk_belt_l`").await;
    exec(&mut b, "DROP TABLE `test`.`tusk_belt_t`").await;
}

#[tokio::test]
async fn mysql_server_refuses_text_it_reads_as_several_statements() {
    let Some(cfg) = mysql_cfg() else {
        eprintln!(
            "SKIP mysql_server_refuses_text_it_reads_as_several_statements (set TUSK_TEST_MYSQL_PORT)"
        );
        return;
    };
    one_statement_belt_battery(&cfg, "mysql").await;
}

/// The same battery on MariaDB, which PREPAREs a `CREATE PROCEDURE` where MySQL answers
/// 1295. `scripts/conformance.sh` does not start MariaDB; point TUSK_TEST_MARIADB_PORT at a
/// `mariadb` container (root password `test`, database `test`) to run it.
#[tokio::test]
async fn mariadb_server_refuses_text_it_reads_as_several_statements() {
    let Some(port) = std::env::var("TUSK_TEST_MARIADB_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
    else {
        eprintln!(
            "SKIP mariadb_server_refuses_text_it_reads_as_several_statements (set TUSK_TEST_MARIADB_PORT)"
        );
        return;
    };
    one_statement_belt_battery(&mysql_cfg_at(port), "mariadb").await;
}

/// Vitess cannot vouch for text holding a `;` (vtgate splits statements itself; it answers
/// the canary with 1105 over COM_STMT_PREPARE and 1149 over SQL PREPARE, older releases
/// "prepare" it), so such text is refused through either mechanism before it is
/// sent, while text with no `;` is never checked. `scripts/conformance.sh` does not start
/// Vitess; point TUSK_TEST_VITESS_PORT at a `vitess/vttestserver` vtgate (keyspace `test`,
/// any user, no password) to run it.
#[tokio::test]
async fn vitess_refuses_text_holding_a_semicolon() {
    unvouched_server_battery("TUSK_TEST_VITESS_PORT").await;
}

/// TiDB answers the canary with its own 8115 ("Can not prepare multiple statements"), not
/// MySQL's parse error, so it is refused the same way, conservatively. Point
/// TUSK_TEST_TIDB_PORT at a `pingcap/tidb` container (root, no password) to run it.
#[tokio::test]
async fn tidb_refuses_text_holding_a_semicolon() {
    unvouched_server_battery("TUSK_TEST_TIDB_PORT").await;
}

async fn unvouched_server_battery(port_var: &str) {
    let Some(port) = std::env::var(port_var)
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
    else {
        eprintln!("SKIP {port_var} is not set");
        return;
    };
    let mut conn = mysql_session(&ConnectionConfig {
        password: String::new(),
        ..mysql_cfg_at(port)
    })
    .await;
    for text in [
        r"SELECT 'a\';b'",
        "CREATE PROCEDURE p() BEGIN SELECT 1; END",
        // A `:name` takes the SQL PREPARE path, whose canary must be refused too.
        "CREATE PROCEDURE p() lbl:begin SELECT 1; end lbl",
    ] {
        let refused = crate::driver::mysql_server_single_statement(&mut conn, text)
            .await
            .expect_err("refused");
        assert!(
            refused.message.contains("Vitess")
                && refused.message.contains("instead of MySQL's parse error"),
            "[{port_var}] {text}: {}",
            refused.message
        );
    }
    crate::driver::mysql_server_single_statement(&mut conn, "SELECT 1")
        .await
        .expect("no `;`, no check");
}

/// A MySQL backup of a database that is NOT the session's default one restores into
/// THAT database. `SHOW CREATE TABLE` names a table bare and the dump never selects a
/// database (a `USE` would outlive the restore on the pooled connection), so before
/// `relation_ddl` qualified the name, the tables were created in the session's default
/// database and the qualified INSERTs that followed failed. A view in the default
/// database is read on a session with none, so its body names its tables' database too.
#[tokio::test]
async fn mysql_backup_restores_a_non_default_database() {
    let Some(cfg) = mysql_cfg() else {
        eprintln!("SKIP mysql_backup_restores_a_non_default_database (set TUSK_TEST_MYSQL_PORT)");
        return;
    };
    let mysql = TransactionEngine::MySql;
    let (mut b, _v) = connect(&cfg).await.expect("connect mysql");
    let b = &mut b;
    let leftovers = [
        "DROP DATABASE IF EXISTS `tusk_bk_tables`".to_string(),
        "DROP VIEW IF EXISTS `test`.`tusk_bkt_dv`".to_string(),
        "DROP TABLE IF EXISTS `test`.`tusk_bkt_base`".to_string(),
    ];
    reset(b, &leftovers).await;

    // A view in the session's default database: SHOW CREATE VIEW on a pooled
    // connection prints it as `VIEW \`tusk_bkt_dv\` AS select … from \`tusk_bkt_base\``.
    exec(
        b,
        "CREATE TABLE `test`.`tusk_bkt_base` (id INT PRIMARY KEY)",
    )
    .await;
    exec(
        b,
        "CREATE VIEW `test`.`tusk_bkt_dv` AS SELECT id FROM tusk_bkt_base WHERE id > 0",
    )
    .await;
    let view = b
        .relation_ddl("view", "test", "tusk_bkt_dv")
        .await
        .expect("view ddl");
    assert!(
        view.contains("VIEW `test`.`tusk_bkt_dv` AS")
            && view.contains("from `test`.`tusk_bkt_base`"),
        "every name in the view qualified: {view}"
    );
    let table = b
        .relation_ddl("table", "test", "tusk_bkt_base")
        .await
        .expect("table ddl");
    assert!(
        table.starts_with("CREATE TABLE `test`.`tusk_bkt_base` ("),
        "{table}"
    );
    // The view read took its connection out of the pool; the pool still answers with
    // its default database selected.
    let rows = all(b, "SELECT DATABASE(), COUNT(*) FROM tusk_bkt_dv").await;
    assert_eq!(cell(&rows[0], 0).as_deref(), Some("test"));
    reset(b, &leftovers).await;

    for sql in [
        "CREATE DATABASE `tusk_bk_tables`",
        "CREATE TABLE `tusk_bk_tables`.`tusk_bkt_parent` (id INT PRIMARY KEY, label VARCHAR(20))",
        "CREATE TABLE `tusk_bk_tables`.`tusk_bkt_child` (id INT PRIMARY KEY, parent_id INT, \
         CONSTRAINT `tusk_bkt_fk` FOREIGN KEY (parent_id) REFERENCES `tusk_bk_tables`.`tusk_bkt_parent` (id))",
        "INSERT INTO `tusk_bk_tables`.`tusk_bkt_parent` VALUES (1, 'one'), (2, 'two')",
        "INSERT INTO `tusk_bk_tables`.`tusk_bkt_child` VALUES (10, 1), (20, 2), (30, 2)",
        "CREATE VIEW `tusk_bk_tables`.`tusk_bkt_v` AS SELECT c.id, p.label \
         FROM `tusk_bk_tables`.`tusk_bkt_child` c JOIN `tusk_bk_tables`.`tusk_bkt_parent` p ON p.id = c.parent_id",
    ] {
        exec(b, sql).await;
    }
    let options = crate::backup::BackupOptions {
        scope: "schemas".into(),
        schemas: vec!["tusk_bk_tables".into()],
        tables: Vec::new(),
        content: "all".into(),
        include_drop: true,
        single_transaction: false,
    };
    let path = std::env::temp_dir().join(format!("tusk_backup_tables_{}.sql", std::process::id()));
    let pth = path.to_string_lossy().to_string();
    let flag = std::sync::atomic::AtomicBool::new(false);
    let summary = crate::backup::run_backup(b, "conformance", &options, &pth, &flag, &mut |_| {})
        .await
        .unwrap_or_else(|e| panic!("backup: {}", e.message));
    assert_eq!(summary.rows, 5, "rows dumped");
    let text = std::fs::read_to_string(&path).unwrap();
    for needle in [
        "CREATE TABLE `tusk_bk_tables`.`tusk_bkt_parent` (",
        "CREATE TABLE `tusk_bk_tables`.`tusk_bkt_child` (",
        "VIEW `tusk_bk_tables`.`tusk_bkt_v` AS",
        "INSERT INTO `tusk_bk_tables`.`tusk_bkt_child`",
        "ALTER TABLE `tusk_bk_tables`.`tusk_bkt_child` ADD CONSTRAINT `tusk_bkt_fk` FOREIGN KEY",
    ] {
        assert!(text.contains(needle), "dump lacks {needle}:\n{text}");
    }
    assert!(
        !text.contains("USE "),
        "the dump never selects a database:\n{text}"
    );

    // Into a server where the database is gone, then again over the restored copy
    // (the dump's own drops), the session's default database staying `test` throughout.
    exec(b, "DROP DATABASE `tusk_bk_tables`").await;
    for pass in ["fresh", "over the restored copy"] {
        let restored = crate::backup::run_restore(
            b,
            mysql,
            &pth,
            &crate::backup::RestoreOptions {
                stop_on_error: true,
                single_transaction: false,
            },
            &std::sync::atomic::AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap_or_else(|e| panic!("restore {pass}: {}", e.message));
        assert_eq!(
            restored.statements_failed, 0,
            "restore {pass}: {:?}\n{text}",
            restored.first_error
        );
        let rows = all(
            b,
            "SELECT DATABASE(), \
               (SELECT COUNT(*) FROM `tusk_bk_tables`.`tusk_bkt_parent`), \
               (SELECT COUNT(*) FROM `tusk_bk_tables`.`tusk_bkt_child`), \
               (SELECT COUNT(*) FROM `tusk_bk_tables`.`tusk_bkt_v` WHERE label = 'two')",
        )
        .await;
        let got: Vec<Option<String>> = (0..4).map(|i| cell(&rows[0], i)).collect();
        assert_eq!(
            got,
            ["test", "2", "3", "2"].map(|s| Some(s.to_string())),
            "restore {pass}"
        );
        // The deferred foreign key names the parent bare; it has to resolve to the
        // child's own database, not the session's.
        let rows = all(
            b,
            "SELECT referenced_table_schema, referenced_table_name \
             FROM information_schema.key_column_usage \
             WHERE table_schema = 'tusk_bk_tables' AND constraint_name = 'tusk_bkt_fk'",
        )
        .await;
        assert_eq!(
            (cell(&rows[0], 0), cell(&rows[0], 1)),
            (
                Some("tusk_bk_tables".into()),
                Some("tusk_bkt_parent".into())
            ),
            "restore {pass}"
        );
        let rows = all(
            b,
            "SELECT COUNT(*) FROM information_schema.tables \
             WHERE table_schema = 'test' AND table_name LIKE 'tusk_bkt%'",
        )
        .await;
        assert_eq!(
            cell(&rows[0], 0).as_deref(),
            Some("0"),
            "restore {pass}: nothing landed in the default database"
        );
    }
    exec(b, "DROP DATABASE `tusk_bk_tables`").await;
    let _ = std::fs::remove_file(&path);
}

// --- database monitor (PostgreSQL) ---
//
// Drives the monitor through the same state-level functions its Tauri commands call:
// start on a registered connection, ticks with every fast-tier field present and
// finite, a process list that shows a sleeping session and a lock wait (blocking
// pids), cancel/terminate with their refusals, pause/resume, and a disconnect that
// leaves no `Tusk monitor` backend behind.

mod monitor_battery {
    use super::{connect, duck_cfg};
    use crate::db::ConnectionConfig;
    use crate::driver::Backend;
    use crate::monitor::{self, MonitorEvent, MonitorOptions, SignalAction};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    pub(super) type Events = Arc<Mutex<Vec<MonitorEvent>>>;

    pub(super) fn sink(events: &Events) -> monitor::Sink {
        let events = events.clone();
        Arc::new(move |e: &MonitorEvent| {
            events
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(e.clone());
        })
    }

    pub(super) fn snapshot(events: &Events) -> Vec<MonitorEvent> {
        events.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Poll until an event at or after index `from` satisfies `pred`; returns it and
    /// the index just past it.
    pub(super) async fn wait_event(
        events: &Events,
        from: usize,
        what: &str,
        pred: impl Fn(&MonitorEvent) -> bool,
    ) -> (MonitorEvent, usize) {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let all = snapshot(events);
            if let Some((i, e)) = all.iter().enumerate().skip(from).find(|(_, e)| pred(e)) {
                return (e.clone(), i + 1);
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}: {:#?}",
                all.last()
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    pub(super) async fn scalar(b: &Backend, sql: &str) -> Option<String> {
        let messages = b.pg().unwrap().simple_query(sql).await.expect(sql);
        let (_, rows) = crate::db::collect_rows(&messages).unwrap();
        rows.first().and_then(|r| r.first().cloned().flatten())
    }

    async fn monitor_backends(observer: &Backend) -> i64 {
        scalar(
            observer,
            "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'Tusk monitor'",
        )
        .await
        .and_then(|v| v.parse().ok())
        .unwrap_or(-1)
    }

    async fn wait_no_monitor_backend(observer: &Backend, what: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while monitor_backends(observer).await != 0 {
            assert!(
                Instant::now() < deadline,
                "{what}: a Tusk monitor backend is still connected"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    fn finite(v: f64, what: &str) {
        assert!(v.is_finite() && v >= 0.0, "{what} = {v}");
    }

    fn assert_fast_tier(e: &MonitorEvent, version_num: i32) {
        assert_eq!(e.status, "live", "{e:#?}");
        assert!(e.error.is_none());
        assert!(
            e.server_ms.is_some_and(|ms| ms > 1_600_000_000_000),
            "server clock"
        );
        finite(e.latency_ms, "latency");
        finite(e.mono_ms, "mono");
        let r = e.rates.expect("rates after the baseline");
        for (name, v) in [
            ("tps", r.tps),
            ("commits", r.commits),
            ("rollbacks", r.rollbacks),
            ("blks_read", r.blks_read),
            ("blks_hit", r.blks_hit),
            ("tup_returned", r.tup_returned),
            ("tup_fetched", r.tup_fetched),
            ("tup_inserted", r.tup_inserted),
            ("tup_updated", r.tup_updated),
            ("tup_deleted", r.tup_deleted),
            ("temp_bytes", r.temp_bytes),
        ] {
            finite(v, name);
        }
        if let Some(hit) = r.cache_hit {
            assert!((0.0..=1.0).contains(&hit), "cache hit {hit}");
        }
        finite(
            r.wal_bytes.expect("a primary reports its WAL position"),
            "wal_bytes",
        );
        assert_eq!(
            r.wal_fpi.is_some(),
            version_num >= 140_000,
            "pg_stat_wal is PostgreSQL 14+"
        );
        if let Some(fpi) = r.wal_fpi {
            finite(fpi, "wal_fpi");
        }
        let s = e.sessions.as_ref().expect("sessions");
        assert!(s.max_connections > 0);
        assert!(s.total >= 1, "the registered session is a client backend");
        assert_eq!(
            s.total,
            s.active
                + s.idle
                + s.idle_in_transaction
                + s.idle_in_transaction_aborted
                + s.other
                + s.hidden
        );
        assert!(e.load.is_some());
        assert!(e.blocked.is_some());
    }

    fn app_row<'a>(e: &'a MonitorEvent, app: &str) -> Option<&'a crate::monitor::ActivityRow> {
        e.activity
            .as_ref()?
            .rows
            .iter()
            .find(|r| r.application.as_deref() == Some(app))
    }

    pub(super) async fn run(cfg: &ConnectionConfig) {
        let state = crate::AppState::default();
        let (user, _) = connect(cfg).await.expect("connect user session");
        let id = state.register(user, false).expect("register");
        let (observer, _) = connect(cfg).await.expect("connect observer");
        wait_no_monitor_backend(&observer, "before the battery").await;

        // Embedded engines get no monitor.
        let (duck, _) = connect(&duck_cfg()).await.unwrap();
        let duck_id = state.register(duck, false).unwrap();
        let events: Events = Arc::default();
        let err = monitor::start(&state, &duck_id, MonitorOptions::default(), sink(&events))
            .await
            .err()
            .expect("DuckDB has no monitor");
        assert!(err.message.contains("PostgreSQL-only"), "{}", err.message);

        // A session to watch: sleeping, findable by application_name.
        let (victim, _) = connect(cfg).await.unwrap();
        let sleeper = tokio::spawn(async move {
            let c = victim.pg().unwrap();
            c.batch_execute("SET application_name = 'tusk-monitor-victim'")
                .await
                .unwrap();
            c.simple_query("SELECT pg_sleep(60)")
                .await
                .map(|_| ())
                .map_err(|e| crate::db::AppError::from(e).message)
        });

        let options = MonitorOptions {
            interval_ms: Some(250),
            paused: None,
            activity: Some(true),
            views: None,
        };
        let started = monitor::start(&state, &id, options, sink(&events))
            .await
            .expect("monitor start");
        let generation = started.generation;
        let server = started.server.clone();
        assert!(server.version_num >= 100_000);
        assert!(server.pid > 0);
        assert!(!started.read_only);
        assert_eq!(server.wal_stats, server.version_num >= 140_000);
        assert!(server.superuser, "the conformance role is postgres");
        assert_eq!(started.interval_ms, 250);
        assert_eq!(started.wait_types[0], "CPU");
        assert_eq!(
            monitor_backends(&observer).await,
            1,
            "one sidecar, identifiable by name"
        );
        // The fixed statements run prepared (planned once per session), not re-planned per tick.
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let last = scalar(
                &observer,
                "SELECT query FROM pg_stat_activity WHERE application_name = 'Tusk monitor'",
            )
            .await
            .unwrap_or_default();
            if last.starts_with("EXECUTE tusk_monitor_") {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "the sidecar's last statement was not prepared: {last}"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        // Three ticks with every fast-tier field present and finite.
        let mut from = 0;
        for _ in 0..3 {
            let (e, next) = wait_event(&events, from, "a tick with rates", |e| {
                e.generation == generation && e.rates.is_some()
            })
            .await;
            assert_fast_tier(&e, server.version_num);
            from = next;
        }

        // The process list shows the sleeper, never the monitor itself.
        let (e, _) = wait_event(
            &events,
            0,
            "the sleeping session in the process list",
            |e| {
                e.generation == generation
                    && app_row(e, "tusk-monitor-victim")
                        .is_some_and(|r| r.state.as_deref() == Some("active"))
            },
        )
        .await;
        let activity = e.activity.clone().unwrap();
        assert!(
            activity.rows.iter().all(|r| r.pid != server.pid),
            "the monitor excludes itself"
        );
        assert!(activity.total as usize >= activity.rows.len());
        let victim = app_row(&e, "tusk-monitor-victim").unwrap().clone();
        assert!(victim.query.as_deref().unwrap_or("").contains("pg_sleep"));
        assert!(victim.query_start_ms.is_some() && victim.backend_start_ms.is_some());
        assert_eq!(victim.backend_type.as_deref(), Some("client backend"));
        assert!(!victim.backend_start.is_empty());
        assert!(
            e.load.unwrap().iter().sum::<u32>() >= 1,
            "the sleeper is load"
        );

        // Refusals: the monitor's own pid, a pid whose backend start no longer matches,
        // a stale generation, and anything on a read-only connection.
        let err = monitor::signal(
            &state,
            &id,
            generation,
            server.pid,
            victim.backend_start.clone(),
            SignalAction::Cancel,
        )
        .await
        .unwrap_err();
        assert!(err.message.contains("monitor's own"), "{}", err.message);
        let err = monitor::signal(
            &state,
            &id,
            generation,
            victim.pid,
            "1999-01-01 00:00:00+00".into(),
            SignalAction::Cancel,
        )
        .await
        .unwrap_err();
        assert!(err.message.contains("already ended"), "{}", err.message);
        let err = monitor::signal(
            &state,
            &id,
            generation + 100,
            victim.pid,
            victim.backend_start.clone(),
            SignalAction::Cancel,
        )
        .await
        .unwrap_err();
        assert!(
            err.message.contains("stopped"),
            "a stale generation reaches nothing: {}",
            err.message
        );
        let (ro_backend, _) = connect(&ConnectionConfig {
            read_only: true,
            ..cfg.clone()
        })
        .await
        .unwrap();
        let ro_id = state.register(ro_backend, true).unwrap();
        let err = monitor::signal(
            &state,
            &ro_id,
            generation,
            victim.pid,
            victim.backend_start.clone(),
            SignalAction::Terminate,
        )
        .await
        .unwrap_err();
        assert!(err.message.contains("read-only"), "{}", err.message);

        // Cancel the sleeper's query: the server says yes and the query ends.
        let cancelled = monitor::signal(
            &state,
            &id,
            generation,
            victim.pid,
            victim.backend_start.clone(),
            SignalAction::Cancel,
        )
        .await
        .expect("cancel");
        assert!(cancelled);
        let outcome = tokio::time::timeout(Duration::from_secs(10), sleeper)
            .await
            .expect("sleeper ended")
            .unwrap();
        assert!(
            outcome.unwrap_err().contains("cancel"),
            "the sleep was cancelled"
        );

        // A lock wait: the holder keeps an exclusive lock idle in transaction, the
        // waiter queues behind it.
        let (setup, _) = connect(cfg).await.unwrap();
        setup
            .pg()
            .unwrap()
            .batch_execute(
                "DROP TABLE IF EXISTS tusk_monitor_lock; CREATE TABLE tusk_monitor_lock (id int)",
            )
            .await
            .unwrap();
        let (holder, _) = connect(cfg).await.unwrap();
        holder
            .pg()
            .unwrap()
            .batch_execute("SET application_name = 'tusk-monitor-holder'; BEGIN; LOCK TABLE tusk_monitor_lock IN ACCESS EXCLUSIVE MODE")
            .await
            .unwrap();
        let (waiter, _) = connect(cfg).await.unwrap();
        let waiting = tokio::spawn(async move {
            let c = waiter.pg().unwrap();
            c.batch_execute("SET application_name = 'tusk-monitor-waiter'")
                .await
                .unwrap();
            c.simple_query("SELECT count(*) FROM tusk_monitor_lock")
                .await
                .map(|_| ())
                .map_err(|e| crate::db::AppError::from(e).message)
        });
        let mark = snapshot(&events).len();
        let (e, _) = wait_event(&events, mark, "the waiter blocked by the holder", |e| {
            e.generation == generation
                && matches!(
                    (app_row(e, "tusk-monitor-holder"), app_row(e, "tusk-monitor-waiter")),
                    (Some(h), Some(w)) if w.blocked_by.contains(&h.pid)
                )
        })
        .await;
        let holder_row = app_row(&e, "tusk-monitor-holder").unwrap().clone();
        assert_eq!(holder_row.state.as_deref(), Some("idle in transaction"));
        assert!(holder_row.xact_start_ms.is_some());
        assert!(
            holder_row.blocked_by.is_empty(),
            "the root blocker waits on nothing"
        );
        assert_eq!(
            app_row(&e, "tusk-monitor-waiter")
                .unwrap()
                .wait_type
                .as_deref(),
            Some("Lock")
        );
        let (blocked_tick, _) =
            wait_event(&events, mark, "the blocked count on the fast tier", |e| {
                e.generation == generation && e.blocked.is_some_and(|b| b >= 1)
            })
            .await;
        let s = blocked_tick.sessions.as_ref().unwrap();
        assert!(s.idle_in_transaction >= 1, "{s:?}");
        assert!(
            blocked_tick.oldest_xact_ms.is_some(),
            "the holder's transaction is the oldest"
        );

        // Terminate the holder: the waiter gets its lock and finishes.
        let terminated = monitor::signal(
            &state,
            &id,
            generation,
            holder_row.pid,
            holder_row.backend_start.clone(),
            SignalAction::Terminate,
        )
        .await
        .expect("terminate");
        assert!(terminated);
        tokio::time::timeout(Duration::from_secs(10), waiting)
            .await
            .expect("waiter finished")
            .unwrap()
            .expect("the waiter's read succeeded once the lock was gone");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !holder.is_closed() {
            assert!(
                Instant::now() < deadline,
                "the terminated session is still open"
            );
            let _ = holder.pg().unwrap().simple_query("SELECT 1").await;
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        setup
            .pg()
            .unwrap()
            .batch_execute("DROP TABLE IF EXISTS tusk_monitor_lock")
            .await
            .unwrap();

        // Pause stops the queries; resume re-baselines (no rate across the gap).
        monitor::configure(
            &state,
            &id,
            generation,
            MonitorOptions {
                paused: Some(true),
                ..options
            },
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(400)).await; // let an in-flight tick land
        let paused_at = snapshot(&events).len();
        tokio::time::sleep(Duration::from_millis(1_200)).await;
        assert_eq!(
            snapshot(&events).len(),
            paused_at,
            "a paused monitor sends nothing"
        );
        monitor::configure(&state, &id, generation, options).unwrap();
        let (first, _) = wait_event(&events, paused_at, "the first tick after resume", |e| {
            e.generation == generation
        })
        .await;
        assert_eq!(first.status, "live");
        assert!(
            first.rates.is_none(),
            "the first reading after a pause is a baseline"
        );
        assert!(first.sessions.is_some());
        wait_event(&events, paused_at, "rates again after resume", |e| {
            e.generation == generation && e.rates.is_some()
        })
        .await;
        assert!(
            monitor::configure(&state, &id, generation + 100, options).is_err(),
            "stale generation"
        );

        // Disconnect takes the sidecar with it.
        crate::disconnect_registered(&state, &id).await.unwrap();
        assert_eq!(state.monitors.len(), 0);
        wait_no_monitor_backend(&observer, "after disconnect").await;
        assert!(monitor::configure(&state, &id, generation, options).is_err());

        // stop_all (the frontend's on-mount sweep) stops whatever is left.
        let ro_started = monitor::start(&state, &ro_id, options, sink(&events))
            .await
            .expect("read-only start");
        assert!(
            ro_started.read_only,
            "the USER's read-only flag is reported"
        );
        assert_eq!(monitor_backends(&observer).await, 1);
        assert_eq!(state.monitors.stop_all(), 1);
        wait_no_monitor_backend(&observer, "after stop_all").await;
    }
}

#[tokio::test]
async fn monitor_battery_postgres() {
    let Some(cfg) = pg_cfg() else {
        eprintln!("SKIP monitor_battery_postgres (set TUSK_TEST_PG_PORT)");
        return;
    };
    monitor_battery::run(&cfg).await;
}

// --- database monitor views (PostgreSQL) ---
//
// The phase-2 view tiers against a live server: maintenance (dead tuples,
// wraparound), replication slots, the lock-wait list and granted groups, COPY
// progress, the checkpoint / temp-file / deadlock event counts, pg_stat_io rates and
// pg_stat_statements deltas with their text, and that closing every view stops them.

mod monitor_views_battery {
    use super::connect;
    use super::monitor_battery::{scalar, sink, snapshot, wait_event, Events};
    use crate::db::ConnectionConfig;
    use crate::driver::Backend;
    use crate::monitor::{self, MonitorOptions, ViewSet};
    use futures_util::StreamExt;
    use std::sync::Arc;
    use std::time::Duration;

    async fn exec(b: &Backend, sql: &str) {
        b.pg()
            .unwrap()
            .batch_execute(sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {}", crate::db::AppError::from(e).message));
    }

    pub(super) async fn run(cfg: &ConnectionConfig) {
        let state = crate::AppState::default();
        let (user, _) = connect(cfg).await.expect("connect user session");
        let id = state.register(user, false).expect("register");
        let (setup, _) = connect(cfg).await.unwrap();
        let version: i32 = scalar(&setup, "SHOW server_version_num")
            .await
            .unwrap()
            .parse()
            .unwrap();
        let preload = scalar(&setup, "SHOW shared_preload_libraries")
            .await
            .unwrap_or_default()
            .contains("pg_stat_statements");
        if preload {
            exec(&setup, "CREATE EXTENSION IF NOT EXISTS pg_stat_statements").await;
        }
        // Made on a short-lived session: PostgreSQL 15+ backends defer their
        // statistics flush (up to 10 s while idle), but a backend that exits flushes.
        let (maker, _) = connect(cfg).await.unwrap();
        exec(
            &maker,
            "DROP TABLE IF EXISTS tusk_monitor_views; \
             CREATE TABLE tusk_monitor_views (id int PRIMARY KEY, v int); \
             INSERT INTO tusk_monitor_views SELECT g, g FROM generate_series(1, 2000) g; \
             DELETE FROM tusk_monitor_views WHERE id > 1000",
        )
        .await;
        drop(maker);
        exec(
            &setup,
            "SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = 'tusk_monitor_slot'; \
             SELECT pg_create_physical_replication_slot('tusk_monitor_slot', true)",
        )
        .await;
        // Table statistics reach pg_stat_user_tables once that backend has exited.
        tokio::time::sleep(Duration::from_millis(1_500)).await;

        let events: Events = Arc::default();
        let every_view = ViewSet {
            locks: true,
            statements: true,
            replication: true,
            tables: true,
            io: true,
        };
        let options = MonitorOptions {
            interval_ms: Some(250),
            paused: None,
            activity: Some(true),
            views: Some(every_view),
        };
        let started = monitor::start(&state, &id, options, sink(&events))
            .await
            .expect("monitor start");
        let generation = started.generation;
        assert_eq!(
            started.server.statements_available, preload,
            "{:?}",
            started.server.statements_note
        );
        if !preload {
            assert!(
                started.server.statements_note.is_some(),
                "an unusable pg_stat_statements says why"
            );
        }

        // Maintenance: the dead tuples just made, and every database's XID age.
        let (e, _) = wait_event(&events, 0, "maintenance", |e| {
            e.generation == generation && e.maintenance.is_some()
        })
        .await;
        let m = e.maintenance.unwrap();
        let t = m
            .tables
            .iter()
            .find(|t| t.name == "tusk_monitor_views")
            .expect("the table with dead tuples");
        assert!(t.dead.unwrap_or(0) >= 1000, "{t:?}");
        assert!(t.size_bytes.unwrap_or(0) > 0);
        assert!(m
            .wraparound
            .iter()
            .any(|d| d.database == "postgres" && d.xid_age > 0));
        assert!(m.freeze_max_age.is_some_and(|v| v > 0));

        // Replication: a primary with no replicas and the slot just created.
        let (e, _) = wait_event(&events, 0, "replication", |e| {
            e.generation == generation && e.replication.is_some()
        })
        .await;
        let r = e.replication.unwrap();
        assert!(!r.standby && r.receiver.is_none());
        assert!(r.replicas.is_empty());
        let slot = r
            .slots
            .iter()
            .find(|s| s.name == "tusk_monitor_slot")
            .expect("the slot");
        assert!(!slot.active);
        assert!(slot.retained_bytes.is_some_and(|b| b >= 0));
        assert_eq!(slot.wal_status.is_some(), version >= 130_000);

        // Locks: a holder idle in transaction and a waiter queued behind it.
        let (holder, _) = connect(cfg).await.unwrap();
        let holder_pid: i32 = scalar(&holder, "SELECT pg_backend_pid()")
            .await
            .unwrap()
            .parse()
            .unwrap();
        exec(
            &holder,
            "BEGIN; LOCK TABLE tusk_monitor_views IN ACCESS EXCLUSIVE MODE",
        )
        .await;
        let (waiter, _) = connect(cfg).await.unwrap();
        let waiting = tokio::spawn(async move {
            waiter
                .pg()
                .unwrap()
                .simple_query("SELECT count(*) FROM tusk_monitor_views")
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        });
        let mark = snapshot(&events).len();
        let (e, _) = wait_event(&events, mark, "the lock wait", |e| {
            e.generation == generation
                && e.locks
                    .as_ref()
                    .is_some_and(|l| l.waiting.iter().any(|w| w.blocked_by.contains(&holder_pid)))
        })
        .await;
        let locks = e.locks.unwrap();
        let w = locks
            .waiting
            .iter()
            .find(|w| w.blocked_by.contains(&holder_pid))
            .unwrap();
        assert_eq!(w.locktype, "relation");
        assert_eq!(w.mode, "AccessShareLock");
        assert!(w.target.contains("tusk_monitor_views"), "{}", w.target);
        assert_eq!(
            w.waited_ms.is_some(),
            version >= 140_000,
            "waitstart is PostgreSQL 14+"
        );
        assert!(!w.backend_start.is_empty());
        assert!(locks.waiting_total >= 1);
        let held = locks
            .held
            .iter()
            .find(|h| h.mode == "AccessExclusiveLock" && h.target.contains("tusk_monitor_views"))
            .expect("the holder's lock among the granted groups");
        assert!(held.pids.contains(&holder_pid));
        assert!(locks
            .held
            .iter()
            .all(|h| h.locktype != "virtualxid" && h.locktype != "transactionid"));
        exec(&holder, "ROLLBACK").await;
        tokio::time::timeout(Duration::from_secs(10), waiting)
            .await
            .unwrap()
            .unwrap()
            .unwrap();

        // Progress: a COPY that takes a few seconds (PostgreSQL 14+ reports COPY).
        if version >= 140_000 {
            let (copier, _) = connect(cfg).await.unwrap();
            let copying = tokio::spawn(async move {
                let stream = copier
                    .pg()
                    .unwrap()
                    .copy_out("COPY (SELECT pg_sleep(3)) TO STDOUT")
                    .await
                    .unwrap();
                let chunks: Vec<_> = stream.collect().await;
                chunks.len()
            });
            let mark = snapshot(&events).len();
            let (e, _) = wait_event(&events, mark, "COPY progress", |e| {
                e.generation == generation
                    && e.progress
                        .as_ref()
                        .is_some_and(|p| p.iter().any(|p| p.kind == "copy to"))
            })
            .await;
            let p = e
                .progress
                .unwrap()
                .into_iter()
                .find(|p| p.kind == "copy to")
                .unwrap();
            assert_eq!(p.total, None, "a query COPY has no known total");
            assert!(p.query.unwrap_or_default().contains("pg_sleep"));
            tokio::time::timeout(Duration::from_secs(10), copying)
                .await
                .unwrap()
                .unwrap();
        }

        // Events: a requested checkpoint, a temporary file, a deadlock.
        let mark = snapshot(&events).len();
        exec(&setup, "CHECKPOINT").await;
        wait_event(&events, mark, "a checkpoint event", |e| {
            e.generation == generation
                && e.rates.is_some_and(|r| r.events.checkpoints_requested >= 1)
        })
        .await;
        let mark = snapshot(&events).len();
        exec(
            &setup,
            "SET work_mem = '64kB'; \
             SELECT count(*) FROM (SELECT g FROM generate_series(1, 300000) g ORDER BY g DESC) s; \
             RESET work_mem",
        )
        .await;
        wait_event(&events, mark, "a temp-file event", |e| {
            e.generation == generation && e.rates.is_some_and(|r| r.events.temp_files >= 1)
        })
        .await;
        let (a, _) = connect(cfg).await.unwrap();
        let (b, _) = connect(cfg).await.unwrap();
        exec(
            &a,
            "BEGIN; UPDATE tusk_monitor_views SET v = v + 1 WHERE id = 1",
        )
        .await;
        exec(
            &b,
            "BEGIN; UPDATE tusk_monitor_views SET v = v + 1 WHERE id = 2",
        )
        .await;
        let mark = snapshot(&events).len();
        let first = tokio::spawn(async move {
            let r = a
                .pg()
                .unwrap()
                .batch_execute("UPDATE tusk_monitor_views SET v = v + 1 WHERE id = 2")
                .await
                .map_err(|e| crate::db::AppError::from(e).message);
            (a, r)
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        let second = b
            .pg()
            .unwrap()
            .batch_execute("UPDATE tusk_monitor_views SET v = v + 1 WHERE id = 1")
            .await
            .map_err(|e| crate::db::AppError::from(e).message);
        let (a, first) = tokio::time::timeout(Duration::from_secs(10), first)
            .await
            .unwrap()
            .unwrap();
        let victim = first
            .err()
            .or(second.err())
            .expect("one side is the deadlock victim");
        assert!(victim.contains("deadlock"), "{victim}");
        let _ = a.pg().unwrap().batch_execute("ROLLBACK").await;
        let _ = b.pg().unwrap().batch_execute("ROLLBACK").await;
        wait_event(&events, mark, "a deadlock event", |e| {
            e.generation == generation && e.rates.is_some_and(|r| r.events.deadlocks >= 1)
        })
        .await;

        // I/O (PostgreSQL 16+) and statements: rates need a second reading, 10 s on.
        if version >= 160_000 {
            let (e, _) = wait_event(&events, 0, "I/O rates", |e| {
                e.generation == generation && e.io.is_some()
            })
            .await;
            let io = e.io.unwrap();
            assert!(io.seconds > 0.0);
            assert!(
                io.rows.iter().any(|r| r.backend_type == "client backend"),
                "{:?}",
                io.rows.first()
            );
        }
        if preload {
            let (e, _) = wait_event(&events, 0, "statement deltas", |e| {
                e.generation == generation && e.statements.is_some()
            })
            .await;
            let s = e.statements.unwrap();
            assert!(s.seconds > 0.0);
            assert!(s.total_calls > 0.0);
            assert!(!s.rows.is_empty());
            assert!(
                s.rows.iter().any(|r| r.query.is_some()),
                "texts are fetched for the top statements"
            );
            assert!(s.tracked >= s.rows.len() as u32);
        }

        let all = snapshot(&events);
        let errors: Vec<_> = all.iter().filter_map(|e| e.view_errors.clone()).collect();
        assert!(errors.is_empty(), "no view tier failed: {errors:?}");

        // Closing every view stops every view tier.
        monitor::configure(
            &state,
            &id,
            generation,
            MonitorOptions {
                views: None,
                ..options
            },
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(600)).await;
        let mark = snapshot(&events).len();
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        let after = snapshot(&events);
        assert!(after.len() > mark, "the fast tier keeps ticking");
        assert!(
            after[mark..].iter().all(|e| e.locks.is_none()
                && e.replication.is_none()
                && e.progress.is_none()
                && e.maintenance.is_none()
                && e.io.is_none()
                && e.statements.is_none()),
            "no view tier runs once its view closed"
        );

        state.monitors.stop_all();
        exec(&setup, "SELECT pg_drop_replication_slot('tusk_monitor_slot'); DROP TABLE IF EXISTS tusk_monitor_views").await;
        if preload {
            exec(&setup, "DROP EXTENSION IF EXISTS pg_stat_statements").await;
        }
    }
}

#[tokio::test]
async fn monitor_views_postgres() {
    let Some(cfg) = pg_cfg() else {
        eprintln!("SKIP monitor_views_postgres (set TUSK_TEST_PG_PORT)");
        return;
    };
    monitor_views_battery::run(&cfg).await;
}
