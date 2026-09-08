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
    Some(ConnectionConfig {
        driver: Some("mysql".into()),
        host: "127.0.0.1".into(),
        port,
        user: "root".into(),
        password: "test".into(),
        dbname: "test".into(),
        sslmode: Some("disable".into()),
        ..base()
    })
}

// --- helpers ---

/// The production classifier (non-DuckDB form): a `WITH`-led write must not stream.
fn cursorable(sql: &str) -> bool {
    crate::is_cursorable(sql, TransactionEngine::Postgres)
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
    let cursorable = |sql: &str| crate::is_cursorable(sql, eng.engine);
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
        _ => format!("{col}::text"),
    };
    let bool_is = |col: &str, want: bool| match eng.name {
        "postgres" | "duckdb" => format!("{col} IS {}", if want { "TRUE" } else { "FALSE" }),
        _ => format!("{col} = {}", if want { "1" } else { "0" }),
    };

    exec(b, &format!("DROP TABLE IF EXISTS {}", q("filt_t"))).await;
    exec(
        b,
        &format!(
            "CREATE TABLE {} (id INTEGER, name VARCHAR(40), qty DECIMAL(10,2), flag BOOLEAN)",
            q("filt_t")
        ),
    )
    .await;
    exec(
        b,
        &format!(
            "INSERT INTO {} VALUES (1, 'Alpha', 10.00, TRUE), (2, 'beta', 20.50, FALSE), \
             (3, '50% off', 30.00, TRUE), (4, 'a_b', NULL, NULL), (5, 'o''brien', 5.00, FALSE), \
             (6, '', 0.00, TRUE), (7, 'axb', 1.00, FALSE), (8, 'b!c', 2.00, FALSE)",
            q("filt_t")
        ),
    )
    .await;

    let cases: Vec<(String, Vec<&str>)> = vec![
        // contains — case-insensitive on every engine, ESCAPE always declared
        (ci(&text_cast(&name), "'%alph%'", esc), vec!["1"]),
        // starts with, `%` in the user's text escaped (matches literally, not as a wildcard)
        (ci(&text_cast(&name), "'50!%%'", esc), vec!["3"]),
        // contains, `_` escaped: 'a_b' matches, 'axb' must not
        (ci(&text_cast(&name), "'%a!_b%'", esc), vec!["4"]),
        // contains, an escape character in the user's own text is escaped with itself
        (ci(&text_cast(&name), "'%b!!c%'", esc), vec!["8"]),
        // like — raw pattern, the wildcards are the user's
        (
            format!("{} LIKE '%b%'", text_cast(&name)),
            vec!["2", "4", "5", "7", "8"],
        ),
        // every LIKE comparison is done on the text form of the column
        (ci(&text_cast(&qty), "'%20%'", esc), vec!["2"]),
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
        (format!("{} = ''", text_cast(&name)), vec!["6"]),
        (format!("{name} = 'o''brien'"), vec!["5"]),
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

    // Composite-key FK ordering (declared order, not alphabetical) — PG + MySQL.
    if eng.name == "postgres" || eng.name == "mysql" {
        exec(b, &format!("DROP TABLE IF EXISTS {}", q("rel_c2"))).await;
        exec(b, &format!("DROP TABLE IF EXISTS {}", q("rel_p2"))).await;
        exec(
            b,
            &format!(
                "CREATE TABLE {} (a INTEGER, b INTEGER, PRIMARY KEY (b, a))",
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
    crate::export::run_export_paged(b, &sql, &opts, &p)
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

    let _ = std::fs::remove_file(&path);
    reset(b, &reset_sql).await;
}

/// Bulk file import (src/import.rs) against every engine: create-and-load, per-engine
/// conflict handling (PostgreSQL `ON CONFLICT`, MySQL `INSERT IGNORE` / `ON DUPLICATE
/// KEY UPDATE`, SQLite/DuckDB `INSERT OR IGNORE` / `OR REPLACE`), truncate-and-reload,
/// and rollback of a whole failed import.
async fn import_battery(b: &mut Backend, eng: &Eng) {
    use crate::import::{run_import, ImportColumn, ImportOptions, ImportRequest, ImportTarget};
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    let q = |n: &str| (eng.quote)(n);
    let table = format!("{}.{}", q(eng.schema), q("imp_t"));
    let cancel = Arc::new(AtomicBool::new(false));

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
    binary_output_battery(&mut b, &eng).await;
    buffered_export_dialect_battery(&eng).await;
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
    ] {
        assert!(
            b.run_single(write, 100, false).await.is_err(),
            "read-only mssql must reject: {write}"
        );
    }
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

// --- command layer (lib.rs exec_items: routing + the app-layer read-only guard that
//     protects engines with no server-side read-only, e.g. MySQL) ---

use crate::driver::ConnState;

async fn state(cfg: &ConnectionConfig, read_only: bool) -> ConnState {
    let (backend, _v) = connect(cfg).await.unwrap();
    ConnState::new(backend, read_only)
}

async fn command_exec(
    c: &mut ConnState,
    items: &[crate::script::Item],
) -> Result<QueryOutcome, crate::db::AppError> {
    let actions =
        crate::script::preflight_transactions(items, c.transaction_engine(), &c.transaction)?;
    match crate::exec_items(c, items, &actions, 100, &None, "test-owner").await {
        Ok(outcome) => Ok(outcome),
        Err(error) => {
            if c.backend.is_closed()
                || (c.transaction.owns_session() && c.backend.manual_session_ended())
            {
                c.mark_transaction_lost();
            } else if c.backend.manual_errors_require_recovery() {
                c.mark_transaction_failed();
            }
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
    for s in [
        "SELECT 1",
        "  with x as (select 1) select * from x",
        "SHOW search_path",
        "EXPLAIN select 1",
        "TABLE t",
        "VALUES (1)",
    ] {
        assert!(crate::is_read_only_stmt(s), "{s:?} should be read-only");
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
            !crate::is_read_only_stmt(s),
            "{s:?} should NOT be read-only"
        );
    }
    assert!(crate::is_read_only_stmt(
        "SELECT 'set_config' AS harmless -- EXPLAIN ANALYZE"
    ));
}

#[tokio::test]
async fn app_readonly_guard_blocks_writes_single_and_multi() {
    // The app-layer guard (exec_items) blocks writes on a read-only connection — single
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
async fn exec_items_routes_single_vs_script() {
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
        r#"DROP TABLE "main"."orders""#,
        r#"ALTER TABLE "main"."orders__tusk_rebuild" RENAME TO "orders""#,
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

/// The SQLite rebuild the builders emit runs through `script::run` wrapped in
/// BEGIN…COMMIT, so the whole create -> copy -> drop -> rename swap must succeed as one
/// unit AND keep the rows — including while another table holds a foreign key on the
/// table being rebuilt. (Tusk leaves `PRAGMA foreign_keys` at SQLite's default off, and
/// the pragma is a no-op inside a transaction anyway, so the intermediate DROP is safe.)
#[test]
fn sqlite_ddl_rebuild_runs_transactionally() {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    c.execute_batch(
        r#"CREATE TABLE "t" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "qty" integer);
CREATE TABLE "child" ("id" integer, FOREIGN KEY ("id") REFERENCES "t" ("id"));
INSERT INTO "t" ("qty") VALUES (7);"#,
    )
    .unwrap();
    let script = r#"BEGIN;
CREATE TABLE "main"."t__tusk_rebuild" (
  "id" integer PRIMARY KEY,
  "qty" bigint NOT NULL DEFAULT 0
);
INSERT INTO "main"."t__tusk_rebuild" ("id", "qty")
SELECT "id", "qty" FROM "main"."t";
DROP TABLE "main"."t";
ALTER TABLE "main"."t__tusk_rebuild" RENAME TO "t";
CREATE INDEX "t_qty_idx" ON "t" ("qty");
COMMIT;"#;
    c.execute_batch(script)
        .expect("SQLite must accept the whole rebuild in one transaction");
    let v: i64 = c
        .query_row("SELECT qty FROM t WHERE id = 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, 7, "rows survive the rebuild");
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
         `d` datetime DEFAULT CURRENT_TIMESTAMP, \
         `e` varchar(10) DEFAULT 'x\\\\y')",
    )
    .await;
    let detail = b.table_detail("test", "defs").await.expect("detail");
    for c in &detail.columns {
        let def = c.default.clone().unwrap_or_default();
        assert!(!def.is_empty(), "column {} lost its default", c.name);
        // Exactly what `columnDef` emits for MySQL, with the default as reported.
        let sql = format!(
            "ALTER TABLE `test`.`defs` MODIFY COLUMN `{}` {} DEFAULT {}",
            c.name, c.data_type, def
        );
        exec(&mut b, &sql).await;
    }
    let after = b.table_detail("test", "defs").await.expect("detail again");
    assert_eq!(
        after
            .columns
            .iter()
            .map(|c| c.default.clone().unwrap_or_default())
            .collect::<Vec<_>>(),
        detail
            .columns
            .iter()
            .map(|c| c.default.clone().unwrap_or_default())
            .collect::<Vec<_>>(),
        "defaults must survive a MODIFY COLUMN round trip unchanged"
    );
    exec(&mut b, "DROP TABLE `test`.`defs`").await;
}
