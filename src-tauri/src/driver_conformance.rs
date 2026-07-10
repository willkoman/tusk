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

// --- engine descriptors ---

fn dq(n: &str) -> String {
    format!("\"{}\"", n.replace('"', "\"\""))
}
fn bt(n: &str) -> String {
    format!("`{}`", n.replace('`', "``"))
}

struct Eng {
    name: &'static str,
    schema: &'static str,        // schema arg for table_detail
    quote: fn(&str) -> String,   // identifier quoting
}

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
    }
}
fn duck_cfg() -> ConnectionConfig {
    ConnectionConfig { driver: Some("duckdb".into()), path: Some(":memory:".into()), ..base() }
}
fn sqlite_cfg() -> ConnectionConfig {
    ConnectionConfig { driver: Some("sqlite".into()), path: Some(":memory:".into()), ..base() }
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

fn cursorable(sql: &str) -> bool {
    let t = sql.trim_start().to_ascii_lowercase();
    t.starts_with("select") || t.starts_with("with") || t.starts_with("table") || t.starts_with("values")
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
    assert_eq!(direct, from_tree, "[{}] database_name() must match DbTree.database", eng.name);
    assert!(!direct.is_empty(), "[{}] database_name() must not be empty", eng.name);

    // ...and it must not silently fall back to the typed config field, which is blank for
    // the embedded engines. This is the exact bug the Slack bot had.
    if matches!(b, Backend::Duck(_) | Backend::Sqlite(_)) {
        assert!(b.config().dbname.is_empty(), "[{}] embedded config.dbname is blank by construction", eng.name);
        assert_ne!(direct, b.config().dbname, "[{}] database_name() must not come from config.dbname", eng.name);
    }
}

async fn run_battery(b: &mut Backend, eng: &Eng) {
    database_name_battery(b, eng).await;
    let q = eng.quote;

    // clean slate (idempotent across re-runs on a persistent server)
    for t in ["conf", "seq"] {
        exec(b, &format!("DROP TABLE IF EXISTS {}", q(t))).await;
    }

    // 1. CREATE + insert edge values: unicode/emoji, embedded quote, NULL (explicit +
    //    default), newline.
    exec(b, &format!("CREATE TABLE {} (id INTEGER, name TEXT)", q("conf"))).await;
    exec(b, &format!("INSERT INTO {} VALUES (1, 'café 🦆')", q("conf"))).await;
    exec(b, &format!("INSERT INTO {} VALUES (2, 'a''b')", q("conf"))).await;
    exec(b, &format!("INSERT INTO {} VALUES (3, NULL)", q("conf"))).await;
    exec(b, &format!("INSERT INTO {} (id) VALUES (4)", q("conf"))).await;
    exec(b, &format!("INSERT INTO {} VALUES (5, 'l1\nl2')", q("conf"))).await;

    let r = all(b, &format!("SELECT {},{} FROM {} ORDER BY id", q("id"), q("name"), q("conf"))).await;
    assert_eq!(r.len(), 5, "[{}] row count", eng.name);
    assert_eq!(cell(&r[0], 0).as_deref(), Some("1"), "[{}] int→text", eng.name);
    assert_eq!(cell(&r[0], 1).as_deref(), Some("café 🦆"), "[{}] unicode/emoji roundtrip", eng.name);
    assert_eq!(cell(&r[1], 1).as_deref(), Some("a'b"), "[{}] quote unescaped", eng.name);
    assert_eq!(cell(&r[2], 1), None, "[{}] explicit NULL → None", eng.name);
    assert_eq!(cell(&r[3], 1), None, "[{}] default NULL → None", eng.name);
    assert!(cell(&r[4], 1).unwrap().contains('\n'), "[{}] newline preserved", eng.name);

    // 2. empty result set: no rows, no error. (Postgres now reports column names even for
    //    a zero-row result via the simple-protocol RowDescription — see db::collect_rows —
    //    so an empty SELECT still shows its headers; column presence isn't asserted here.)
    let empty = b
        .run_single(&format!("SELECT {} FROM {} WHERE 1=0", q("id"), q("conf")), 100, true)
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
    let dup = all(b, &format!("SELECT {0}, {0} FROM {1} ORDER BY id", q("id"), q("conf"))).await;
    assert_eq!(dup[0].len(), 2, "[{}] duplicate result columns kept", eng.name);
    assert_eq!(cell(&dup[0], 0), cell(&dup[0], 1), "[{}] both dup columns same value", eng.name);

    // 3b. typed values render as readable text (the all-text model must not mangle
    //     dates/decimals — DuckDB casts via VARCHAR, MySQL formats its Value::Date).
    exec(b, &format!("DROP TABLE IF EXISTS {}", q("typ"))).await;
    // Column names quoted (`dec` is a reserved word in MySQL — exercises reserved-word
    // column handling too).
    exec(b, &format!("CREATE TABLE {} ({} DATE, {} TIMESTAMP, {} DECIMAL(10,2))", q("typ"), q("d"), q("ts"), q("dec"))).await;
    exec(b, &format!("INSERT INTO {} VALUES ('2024-01-15', '2024-01-15 10:30:00', 3.14)", q("typ"))).await;
    let t = all(b, &format!("SELECT {},{},{} FROM {}", q("d"), q("ts"), q("dec"), q("typ"))).await;
    assert_eq!(cell(&t[0], 0).as_deref(), Some("2024-01-15"), "[{}] DATE → text", eng.name);
    assert!(
        cell(&t[0], 1).unwrap().starts_with("2024-01-15 10:30"),
        "[{}] TIMESTAMP → text: {:?}", eng.name, cell(&t[0], 1)
    );
    assert!(
        cell(&t[0], 2).unwrap().starts_with("3.14"),
        "[{}] DECIMAL → text: {:?}", eng.name, cell(&t[0], 2)
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
    assert_eq!(fetches20, 3, "[{}] exactly-full page must do a final empty fetch", eng.name);
    let ids: Vec<i64> = rows20.iter().map(|r| cell(r, 0).unwrap().parse().unwrap()).collect();
    assert_eq!(ids, (1..=20).collect::<Vec<_>>(), "[{}] paged order, no dup/skip", eng.name);
    // exact single-page boundary: 10 rows, page 10 → page1=10 (not done), page2=0 (done).
    let (rows10, fetches10) = page_all(b, &format!("{sel_seq} LIMIT 10"), 10).await;
    assert_eq!(rows10.len(), 10, "[{}] single full page count", eng.name);
    assert_eq!(fetches10, 2, "[{}] full single page needs a trailing empty fetch", eng.name);

    // 5. large value (50 KB) survives the text pipeline intact (no truncation).
    let big = "x".repeat(50_000);
    exec(b, &format!("INSERT INTO {} VALUES (100, '{big}')", q("conf"))).await;
    let lr = all(b, &format!("SELECT {} FROM {} WHERE id=100", q("name"), q("conf"))).await;
    assert_eq!(cell(&lr[0], 0).unwrap().len(), 50_000, "[{}] 50KB value intact", eng.name);

    // 6. writes actually apply (robust across affected-count reporting differences).
    exec(b, &format!("UPDATE {} SET {}='z' WHERE id=1", q("conf"), q("name"))).await;
    let u = all(b, &format!("SELECT {} FROM {} WHERE id=1", q("name"), q("conf"))).await;
    assert_eq!(cell(&u[0], 0).as_deref(), Some("z"), "[{}] UPDATE applied", eng.name);
    exec(b, &format!("DELETE FROM {} WHERE id=100", q("conf"))).await;
    let c = all(b, &format!("SELECT COUNT(*) FROM {} WHERE id=100", q("conf"))).await;
    assert_eq!(cell(&c[0], 0).as_deref(), Some("0"), "[{}] DELETE applied", eng.name);

    // 7. introspection: tree / table_detail / autocomplete list all see the table + cols.
    let tree = b.build_tree().await.unwrap();
    assert!(
        tree.schemas.iter().any(|s| s.tables.iter().any(|t| t.name == "conf")),
        "[{}] build_tree includes conf", eng.name
    );
    // no duplicate schema rows — DuckDB's information_schema spans attached catalogs
    // (memory/system/temp), each with its own `main`, so an unfiltered schemata query
    // showed `main` three times in the sidebar. Every engine must report each schema once.
    {
        let mut names: Vec<&str> = tree.schemas.iter().map(|s| s.name.as_str()).collect();
        let total = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(total, names.len(), "[{}] duplicate schema rows: {names:?}", eng.name);
    }
    let det = b.table_detail(eng.schema, "conf").await.unwrap();
    let cols: Vec<&str> = det.columns.iter().map(|c| c.name.as_str()).collect();
    assert!(cols.contains(&"id") && cols.contains(&"name"), "[{}] table_detail cols {cols:?}", eng.name);
    let list = b.list_tables().await.unwrap();
    assert!(
        list.iter().any(|t| t.name == "conf" && t.columns.len() >= 2),
        "[{}] list_tables includes conf w/ columns", eng.name
    );
    // sample_rows: read-only, dialect-quoted, bounded — feeds the AI assistant's context.
    let (scols, srows) = b.sample_rows(eng.schema, "conf", 3).await.unwrap();
    assert!(scols.iter().any(|c| c == "id"), "[{}] sample_rows columns {scols:?}", eng.name);
    assert!(!srows.is_empty() && srows.len() <= 3, "[{}] sample_rows bounded non-empty", eng.name);
    assert!(srows.iter().all(|r| r.len() == scols.len()), "[{}] sample_rows row width", eng.name);

    // 8. weird identifier (space + embedded quote) — quoting + introspection robustness
    //    (the injection-adjacent path: names get inlined into catalog queries).
    let weird = "we ird\"x";
    let qw = q(weird);
    exec(b, &format!("DROP TABLE IF EXISTS {qw}")).await;
    exec(b, &format!("CREATE TABLE {qw} ({} INTEGER)", q("a"))).await;
    exec(b, &format!("INSERT INTO {qw} VALUES (7)")).await;
    let wr = all(b, &format!("SELECT {} FROM {qw}", q("a"))).await;
    assert_eq!(cell(&wr[0], 0).as_deref(), Some("7"), "[{}] query weird-named table", eng.name);
    let list2 = b.list_tables().await.unwrap();
    assert!(
        list2.iter().any(|t| t.name == weird),
        "[{}] list_tables returns the exact weird name", eng.name
    );
    let wdet = b.table_detail(eng.schema, weird).await.unwrap();
    assert!(wdet.columns.iter().any(|c| c.name == "a"), "[{}] table_detail of weird name", eng.name);
    exec(b, &format!("DROP TABLE IF EXISTS {qw}")).await;
}

// --- relationships + DDL reconstruction (relgraph.rs / Backend::relation_ddl) ---

async fn relationship_battery(b: &mut Backend, eng: &Eng) {
    let q = eng.quote;
    // child first (FK dependency blocks dropping the parent on PG/MySQL)
    exec(b, &format!("DROP TABLE IF EXISTS {}", q("rel_child"))).await;
    exec(b, &format!("DROP TABLE IF EXISTS {}", q("rel_parent"))).await;
    exec(b, &format!("CREATE TABLE {} (id INTEGER PRIMARY KEY, label TEXT)", q("rel_parent"))).await;
    exec(b, &format!(
        "CREATE TABLE {} (id INTEGER PRIMARY KEY, parent_id INTEGER, \
         FOREIGN KEY (parent_id) REFERENCES {}(id))",
        q("rel_child"), q("rel_parent")
    )).await;

    // DuckDB's duckdb_constraints() column set varies by version: the contract
    // there is edges-or-empty, never an error. Everything else must report.
    let strict = eng.name != "duckdb";

    let rel = b.table_relationships(eng.schema, "rel_child").await
        .unwrap_or_else(|e| panic!("[{}] table_relationships(child): {}", eng.name, e.message));
    if strict || !rel.outbound.is_empty() {
        assert_eq!(rel.outbound.len(), 1, "[{}] one outbound FK", eng.name);
        let e = &rel.outbound[0];
        assert_eq!(e.src_table, "rel_child", "[{}] src table", eng.name);
        assert_eq!(e.src_cols, vec!["parent_id"], "[{}] src cols", eng.name);
        assert_eq!(e.dst_table, "rel_parent", "[{}] dst table", eng.name);
        assert_eq!(e.dst_cols, vec!["id"], "[{}] dst cols", eng.name);
    }
    let relp = b.table_relationships(eng.schema, "rel_parent").await.unwrap();
    if strict || !relp.inbound.is_empty() {
        assert_eq!(relp.inbound.len(), 1, "[{}] one inbound FK on the parent", eng.name);
        assert_eq!(relp.inbound[0].src_table, "rel_child", "[{}] inbound src", eng.name);
        assert!(relp.outbound.is_empty(), "[{}] parent has no outbound FK", eng.name);
    }

    let g = b.schema_relationships(eng.schema).await
        .unwrap_or_else(|e| panic!("[{}] schema_relationships: {}", eng.name, e.message));
    assert!(
        g.tables.iter().any(|t| t.name == "rel_parent") && g.tables.iter().any(|t| t.name == "rel_child"),
        "[{}] ERD tables present", eng.name
    );
    if strict {
        assert!(
            g.edges.iter().any(|e| e.src_table == "rel_child" && e.dst_table == "rel_parent"),
            "[{}] ERD edge present", eng.name
        );
        let parent = g.tables.iter().find(|t| t.name == "rel_parent").unwrap();
        assert!(
            parent.columns.iter().any(|c| c.name == "id" && c.is_pk),
            "[{}] ERD pk flag on rel_parent.id", eng.name
        );
        let child = g.tables.iter().find(|t| t.name == "rel_child").unwrap();
        assert!(
            child.columns.iter().any(|c| c.name == "parent_id" && c.is_fk),
            "[{}] ERD fk flag on rel_child.parent_id", eng.name
        );
    }

    // Composite-key FK ordering (declared order, not alphabetical) — PG + MySQL.
    if eng.name == "postgres" || eng.name == "mysql" {
        exec(b, &format!("DROP TABLE IF EXISTS {}", q("rel_c2"))).await;
        exec(b, &format!("DROP TABLE IF EXISTS {}", q("rel_p2"))).await;
        exec(b, &format!("CREATE TABLE {} (a INTEGER, b INTEGER, PRIMARY KEY (b, a))", q("rel_p2"))).await;
        exec(b, &format!(
            "CREATE TABLE {} (x INTEGER, y INTEGER, FOREIGN KEY (y, x) REFERENCES {} (b, a))",
            q("rel_c2"), q("rel_p2")
        )).await;
        let r2 = b.table_relationships(eng.schema, "rel_c2").await.unwrap();
        assert_eq!(r2.outbound.len(), 1, "[{}] composite FK found", eng.name);
        assert_eq!(r2.outbound[0].src_cols, vec!["y", "x"], "[{}] composite src order", eng.name);
        assert_eq!(r2.outbound[0].dst_cols, vec!["b", "a"], "[{}] composite dst order", eng.name);
        exec(b, &format!("DROP TABLE IF EXISTS {}", q("rel_c2"))).await;
        exec(b, &format!("DROP TABLE IF EXISTS {}", q("rel_p2"))).await;
    }

    // DDL reconstruction: must contain CREATE TABLE (DuckDB may report a friendly
    // unsupported error instead — never a panic).
    match b.relation_ddl("table", eng.schema, "rel_child").await {
        Ok(ddl) => {
            assert!(
                ddl.to_lowercase().contains("create table"),
                "[{}] relation_ddl contains CREATE TABLE: {ddl}", eng.name
            );
            assert!(ddl.to_lowercase().contains("rel_child"), "[{}] relation_ddl names the table", eng.name);
        }
        Err(e) => assert!(eng.name == "duckdb", "[{}] relation_ddl errored: {}", eng.name, e.message),
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
    assert_eq!(cell(&n[0], 0).as_deref(), Some("0"), "[{}] failed script rolled back fully", eng.name);

    // B0: user-managed transactions are NOT double-wrapped.
    let items2 = crate::script::split(&format!(
        "BEGIN; INSERT INTO {0} VALUES (7); COMMIT;",
        q("atomic_t")
    ));
    b.run_script(&items2, false).await
        .unwrap_or_else(|e| panic!("[{}] user-txn script: {}", eng.name, e.message));
    let n2 = all(b, &format!("SELECT COUNT(*) FROM {}", q("atomic_t"))).await;
    assert_eq!(cell(&n2[0], 0).as_deref(), Some("1"), "[{}] user-txn script applied", eng.name);

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
    exec(b, &format!(
        "INSERT INTO {} SELECT (a.n - 1) * 200 + b.n FROM \
         (WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM g WHERE n < 125) SELECT n FROM g) AS a, \
         (WITH RECURSIVE h(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM h WHERE n < 200) SELECT n FROM h) AS b",
        q("exp_t")
    )).await;
    let path = std::env::temp_dir().join(format!("tusk_export_{}_{}.csv", eng.name, std::process::id()));
    let p = path.to_string_lossy().to_string();
    let opts: crate::export::ExportOptions = serde_json::from_str(r#"{"format":"csv"}"#).unwrap();
    let n = crate::export::run_export_paged(b, &format!("SELECT n FROM {} ORDER BY n", q("exp_t")), &opts, &p)
        .await
        .unwrap_or_else(|e| panic!("[{}] paged export: {}", eng.name, e.message));
    assert_eq!(n, 25_000, "[{}] export row count", eng.name);
    let text = std::fs::read_to_string(&path).unwrap();
    assert_eq!(text.lines().count(), 25_001, "[{}] csv lines incl. header", eng.name);
    assert!(text.starts_with("n"), "[{}] header row", eng.name);
    let _ = std::fs::remove_file(&path);
    exec(b, &format!("DROP TABLE IF EXISTS {}", q("exp_t"))).await;
}

/// B1b: boolean export. `Backend::bool_columns` reports the server-typed bool columns
/// of an arbitrary query, and the export maps their driver tokens (PG `t`/`f`, DuckDB
/// `true`/`false`, SQLite `0`/`1`) to TRUE/FALSE — while a TEXT column holding the same
/// tokens passes through raw. MySQL is pinned to NO detection: `tinyint(1)` is a display
/// width the metadata drops, and the grid deliberately shows 0/1 there — export matches.
async fn bool_export_battery(b: &mut Backend, eng: &Eng) {
    let q = eng.quote;
    exec(b, &format!("DROP TABLE IF EXISTS {}", q("bool_t"))).await;
    exec(b, &format!("CREATE TABLE {} (id INTEGER, flag BOOLEAN, note VARCHAR(10))", q("bool_t"))).await;
    exec(b, &format!("INSERT INTO {} VALUES (1, TRUE, 't'), (2, FALSE, 'f'), (3, NULL, 'x')", q("bool_t"))).await;

    let sql = format!("SELECT id, flag, note FROM {} ORDER BY id", q("bool_t"));
    let bc = b.bool_columns(&sql).await;
    if eng.name == "mysql" {
        assert!(bc.is_empty(), "[{}] tinyint(1) must NOT be detected (grid shows 0/1)", eng.name);
    } else {
        assert_eq!(bc, vec![1], "[{}] flag column detected as boolean", eng.name);
    }

    // Expression columns: typed by the binder on PG/DuckDB (prepare/DESCRIBE); SQLite
    // decltype is declared-columns-only, so an expression is (correctly) not detected.
    let expr = b.bool_columns(&format!("SELECT flag AND flag AS x, id FROM {}", q("bool_t"))).await;
    match eng.name {
        "postgres" | "duckdb" => assert_eq!(expr, vec![0], "[{}] bool expression detected", eng.name),
        "sqlite" => assert!(expr.is_empty(), "[{}] expressions have no decltype", eng.name),
        _ => {}
    }

    // A garbage query must degrade to "no detection", never an error.
    assert!(b.bool_columns("SELECT * FROM no_such_table_xyz").await.is_empty());

    // End-to-end: the detected set drives the CSV mapping through the paged exporter.
    let mut opts: crate::export::ExportOptions = serde_json::from_str(r#"{"format":"csv"}"#).unwrap();
    opts.bool_cols = bc;
    let path = std::env::temp_dir().join(format!("tusk_boolexp_{}_{}.csv", eng.name, std::process::id()));
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

// --- entry points ---

#[tokio::test]
async fn conformance_duckdb() {
    let (mut b, _v) = connect(&duck_cfg()).await.unwrap();
    let eng = Eng { name: "duckdb", schema: "main", quote: dq };
    run_battery(&mut b, &eng).await;
    relationship_battery(&mut b, &eng).await;
    sweep_battery(&mut b, &eng).await;
    export_battery(&mut b, &eng).await;
    bool_export_battery(&mut b, &eng).await;
}

#[tokio::test]
async fn conformance_sqlite() {
    let (mut b, _v) = connect(&sqlite_cfg()).await.unwrap();
    let eng = Eng { name: "sqlite", schema: "main", quote: dq };
    run_battery(&mut b, &eng).await;
    relationship_battery(&mut b, &eng).await;
    sweep_battery(&mut b, &eng).await;
    export_battery(&mut b, &eng).await;
    bool_export_battery(&mut b, &eng).await;
}

#[tokio::test]
async fn conformance_postgres() {
    let Some(cfg) = pg_cfg() else {
        eprintln!("SKIP conformance_postgres (set TUSK_TEST_PG_PORT)");
        return;
    };
    let (mut b, _v) = connect(&cfg).await.expect("connect pg");
    let eng = Eng { name: "postgres", schema: "public", quote: dq };
    run_battery(&mut b, &eng).await;
    relationship_battery(&mut b, &eng).await;
    sweep_battery(&mut b, &eng).await;
    export_battery(&mut b, &eng).await;
    bool_export_battery(&mut b, &eng).await;
}

#[tokio::test]
async fn conformance_mysql() {
    let Some(cfg) = mysql_cfg() else {
        eprintln!("SKIP conformance_mysql (set TUSK_TEST_MYSQL_PORT)");
        return;
    };
    let (mut b, _v) = connect(&cfg).await.expect("connect mysql");
    let eng = Eng { name: "mysql", schema: "test", quote: bt };
    run_battery(&mut b, &eng).await;
    relationship_battery(&mut b, &eng).await;
    sweep_battery(&mut b, &eng).await;
    export_battery(&mut b, &eng).await;
    bool_export_battery(&mut b, &eng).await;
}

// --- read-only enforcement (production safety) ---

async fn readonly_embedded(driver: &str, ext: &str) {
    let dir = std::env::temp_dir();
    let path = dir.join(format!("tusk_ro_{}_{}.{ext}", driver, std::process::id()));
    let p = path.to_string_lossy().to_string();
    let _ = std::fs::remove_file(&path);
    let mut cfg = ConnectionConfig { driver: Some(driver.into()), path: Some(p.clone()), ..base() };
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
    let res = b.run_single("CREATE TABLE tusk_ro_probe (a int)", 100, false).await;
    assert!(res.is_err(), "read-only postgres must reject writes/DDL");
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
    assert!(psu.enforced && psu.is_superuser, "postgres role is an enforced superuser");
    assert!(
        psu.tables.iter().any(|t| t.name == "perm_t" && t.select && t.is_owner),
        "owner sees its table with SELECT + ownership"
    );

    // limited role: SELECT but no writes/ownership, USAGE-not-CREATE on public, no DB/role
    let mut lim = su.clone();
    lim.user = "tusk_limited".into();
    lim.password = "lim".into();
    let (b, _) = connect(&lim).await.expect("connect limited role");
    let pl = b.permissions().await.unwrap();
    assert!(pl.enforced && !pl.is_superuser, "limited role is enforced, not superuser");
    assert!(!pl.can_create_db && !pl.can_create_role, "limited can't create db/role");
    let pt = pl.tables.iter().find(|t| t.name == "perm_t").expect("perm_t visible to limited");
    assert!(pt.select, "limited has SELECT");
    assert!(!pt.insert && !pt.update && !pt.delete, "limited lacks write privileges");
    assert!(!pt.is_owner, "limited is not the owner");
    let pub_s = pl.schemas.iter().find(|s| s.name == "public").expect("public schema");
    assert!(pub_s.usage && !pub_s.create, "limited: USAGE not CREATE on public");

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
    ConnState { backend, read_only }
}

#[test]
fn is_read_only_stmt_classification() {
    for s in ["SELECT 1", "  with x as (select 1) select * from x", "SHOW search_path", "EXPLAIN select 1", "TABLE t", "VALUES (1)"] {
        assert!(crate::is_read_only_stmt(s), "{s:?} should be read-only");
    }
    for s in ["INSERT INTO t VALUES (1)", "UPDATE t SET a=1", "DELETE FROM t", "CREATE TABLE t(a int)", "DROP TABLE t", "TRUNCATE t", "ALTER TABLE t ADD c int"] {
        assert!(!crate::is_read_only_stmt(s), "{s:?} should NOT be read-only");
    }
}

#[tokio::test]
async fn app_readonly_guard_blocks_writes_single_and_multi() {
    // The app-layer guard (exec_items) blocks writes on a read-only connection — single
    // AND multi-statement — for every driver. This is the only protection for MySQL
    // (no engine-level read-only). Use SQLite in-memory as a stand-in for the guard logic.
    let mut c = state(&sqlite_cfg(), true).await;
    let block = |sql: &str| crate::script::split(sql);
    // single-statement write blocked
    assert!(crate::exec_items(&mut c, &block("INSERT INTO x VALUES (1)"), 100, &None).await.is_err());
    // multi-statement write blocked (the path that used to slip through on MySQL)
    assert!(crate::exec_items(&mut c, &block("CREATE TABLE y(a int); INSERT INTO y VALUES (1)"), 100, &None).await.is_err());
    // reads allowed
    assert!(crate::exec_items(&mut c, &block("SELECT 1"), 100, &None).await.is_ok());
}

#[tokio::test]
async fn exec_items_routes_single_vs_script() {
    let mut c = state(&sqlite_cfg(), false).await;
    let run = |sql: &str| crate::script::split(sql);
    crate::exec_items(&mut c, &run("CREATE TABLE t(a INTEGER)"), 100, &None).await.unwrap();
    // single SELECT → streaming Rows
    let single = crate::exec_items(&mut c, &run("SELECT 1 AS a"), 100, &None).await.unwrap();
    assert!(matches!(single, QueryOutcome::Rows { .. }), "single SELECT → Rows");
    // multi-statement → transactional script → Exec, and both writes apply
    let multi = crate::exec_items(&mut c, &run("INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)"), 100, &None).await.unwrap();
    assert!(matches!(multi, QueryOutcome::Exec { .. }), "multi-statement → Exec");
    let cnt = all(&mut c.backend, "SELECT COUNT(*) FROM t").await;
    assert_eq!(cell(&cnt[0], 0).as_deref(), Some("2"), "script applied both inserts");
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
    c.execute_batch(txn).expect("DuckDB must accept the add-column split (no backfill) in one transaction");
    // The new NOT NULL column with a default exists and is usable.
    c.execute_batch(r#"INSERT INTO "t" ("id") VALUES (7)"#).unwrap();
    let v: i64 = c.query_row("SELECT c FROM t WHERE id = 7", [], |r| r.get(0)).unwrap();
    assert_eq!(v, 0, "default applied to new rows");
}
