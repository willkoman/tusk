//! Driver abstraction. A `Backend` is one connected database — Postgres (network) or
//! DuckDB (embedded), with more to follow. The connection-level surface the app needs —
//! query / exec / streaming page / cancel / search-path / introspection — is abstracted
//! here so a new driver is a new enum arm. PG-specific DDL reconstruction, export
//! streaming, server-lint, and import still reach the raw client via `Backend::pg()`
//! (errors on non-PG drivers) until each is abstracted per driver.

use std::sync::{Arc, Mutex};

use tokio_postgres::{CancelToken, Client, SimpleQueryMessage};

use crate::db::{self, AppError, ConnectionConfig, FetchResult, QueryOutcome, CURSOR_NAME};
use crate::relgraph;
use crate::script;
use crate::tree;

type TextRows = (Vec<String>, Vec<Vec<Option<String>>>);

fn de<E: std::fmt::Display>(e: E) -> AppError {
    AppError::new(e.to_string())
}

/// Shared embedded-driver script runner: joins the SQL items and executes them
/// inside an explicit BEGIN…COMMIT (best-effort ROLLBACK on error), unless the
/// script manages its own transaction.
fn embedded_script<C>(
    conn: &C,
    items: &[script::Item],
    user_txn: bool,
    exec: impl Fn(&C, &str) -> Result<(), AppError>,
) -> Result<String, AppError> {
    // Separators sit on their own line: a statement ending in a `--` comment would
    // otherwise swallow the appended `;` and merge with the next statement (or eat
    // the `;` before COMMIT, turning the wrapper into a phantom syntax error).
    let sql = items
        .iter()
        .filter_map(|it| match it {
            script::Item::Sql(s) => Some(s.trim()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n;\n");
    if user_txn {
        exec(conn, &sql)?;
        return Ok("OK".to_string());
    }
    match exec(conn, &format!("BEGIN;\n{sql}\n;\nCOMMIT;")) {
        Ok(()) => Ok("OK".to_string()),
        Err(e) => {
            let _ = exec(conn, "ROLLBACK");
            Err(e)
        }
    }
}

/// What a driver supports. The UI gates features on these (hide COPY-import / search-path
/// selector / etc. where unsupported). Serialized to the frontend.
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub kind: &'static str,
    pub server_cursor: bool,
    pub bulk_copy: bool,
    pub export: bool,
    pub schemas: bool,
    pub search_path: bool,
    pub transactional_ddl: bool,
    pub tls: bool,
    pub keychain: bool,
    pub permissions: bool,
    /// DDL reconstruction available (PG pg_catalog / SQLite sqlite_master /
    /// MySQL SHOW CREATE / DuckDB duckdb_tables — DuckDB is best-effort).
    pub ddl: bool,
    /// FK relationship introspection (table_relationships / schema_relationships).
    pub relationships: bool,
    /// EXPLAIN ANALYZE exists on this engine (SQLite has no ANALYZE variant).
    pub explain_analyze: bool,
}

impl Capabilities {
    pub fn postgres() -> Self {
        Self {
            kind: "postgres",
            server_cursor: true,
            bulk_copy: true,
            export: true,
            schemas: true,
            search_path: true,
            transactional_ddl: true,
            tls: true,
            keychain: true,
            permissions: true,
            ddl: true,
            relationships: true,
            explain_analyze: true,
        }
    }
    pub fn duckdb() -> Self {
        Self {
            kind: "duckdb",
            server_cursor: false, // paged via LIMIT/OFFSET, not a server cursor
            bulk_copy: false,     // import not yet abstracted for DuckDB
            export: true,         // paged export (export::run_export_paged)
            schemas: true,
            search_path: false,
            transactional_ddl: true,
            tls: false,
            keychain: false,
            permissions: false,
            ddl: true, // best-effort via duckdb_tables()/duckdb_views()
            relationships: true, // best-effort via duckdb_constraints()
            explain_analyze: true,
        }
    }
    pub fn sqlite() -> Self {
        Self {
            kind: "sqlite",
            server_cursor: false,
            bulk_copy: false,
            export: true,   // paged export
            schemas: false, // single schema
            search_path: false,
            transactional_ddl: true,
            tls: false,
            keychain: false,
            permissions: false,
            ddl: true, // sqlite_master.sql
            relationships: true, // pragma_foreign_key_list
            explain_analyze: false, // no EXPLAIN ANALYZE in SQLite
        }
    }
    pub fn mysql() -> Self {
        Self {
            kind: "mysql",
            server_cursor: false,
            bulk_copy: false,
            export: true,             // paged export (not snapshot-consistent under writes)
            schemas: true,            // databases-as-schemas
            search_path: false,       // MySQL uses `USE db`, not search_path
            transactional_ddl: false, // MySQL DDL auto-commits
            tls: true,
            keychain: false,
            permissions: false,
            ddl: true, // SHOW CREATE TABLE/VIEW
            relationships: true, // information_schema.KEY_COLUMN_USAGE
            explain_analyze: true,
        }
    }
}

/// A query-cancel handle usable without holding the connection lock. PG = libpq cancel
/// protocol (own short connection); DuckDB = an interrupt handle on the live connection.
#[derive(Clone)]
pub enum CancelHandle {
    Pg(CancelToken),
    Duck(Arc<duckdb::InterruptHandle>),
    /// No out-of-band cancel (e.g. SQLite) — queries are local and short.
    None,
}

impl CancelHandle {
    pub async fn cancel(self, cfg: &ConnectionConfig) -> Result<(), AppError> {
        match self {
            CancelHandle::Pg(token) => {
                let tls = db::make_tls(cfg)?;
                token.cancel_query(tls).await?;
                Ok(())
            }
            CancelHandle::Duck(handle) => {
                // Windows bundled DuckDB: interrupt() leaves the connection in the
                // #209 poisoned state — every later statement fails with "resource
                // deadlock would occur" and the leaked handle keeps a file-backed
                // .duckdb locked until app restart. A query that can't be cancelled
                // beats a database that can't be reopened.
                #[cfg(windows)]
                {
                    let _ = handle;
                    Err(AppError::new(
                        "cancel isn't available for DuckDB on Windows — the query will run to completion",
                    ))
                }
                #[cfg(not(windows))]
                {
                    handle.interrupt();
                    Ok(())
                }
            }
            CancelHandle::None => Ok(()),
        }
    }
}

/// A live Postgres connection plus its single streaming-cursor flag.
pub struct PgConn {
    pub client: Client,
    pub config: ConnectionConfig,
    pub cursor_open: bool,
}

/// A live embedded DuckDB connection. Paging is by LIMIT/OFFSET over the stored base
/// query (no server-side cursor), so `stream_sql`/`offset` are the pager state. The
/// `Connection` is `Send` but `!Sync` (interior `RefCell`); wrapping it in a `Mutex`
/// makes `ConnState` `Sync` so the Tauri command futures stay `Send`. The lock is
/// effectively uncontended — the per-connection `AsyncMutex` already serializes access.
pub struct DuckConn {
    /// `None` when the connection has been released while idle (a file-backed DuckDB
    /// holds an exclusive OS file lock for its whole lifetime — keeping it open while
    /// nothing is running blocks every other process from touching the file). Re-opened
    /// lazily by `ensure_alive` on the next command; closed by `release_idle` when a
    /// command finishes with no stream in flight. A `:memory:` DB can't be reopened
    /// (closing loses all data) so it stays open — see `keep_open`.
    pub conn: Mutex<Option<duckdb::Connection>>,
    /// True for `:memory:` (no file lock to free, and closing would drop the data).
    pub keep_open: bool,
    pub config: ConnectionConfig,
    pub stream_sql: Option<String>,
    pub offset: usize,
    /// Scratch in-memory connection that parse-checks user SQL before it reaches the
    /// real connection (`parse_check`). Lazily opened, replaced after it absorbs a
    /// parse error, released alongside the main connection when idle.
    gate: Mutex<Option<duckdb::Connection>>,
}

/// Deref'able lock guard so every existing `d.lock()` call site is unchanged: it borrows
/// the live `Connection` out of the `Option`. The connection is guaranteed present at any
/// call site — `ensure_alive`/`connect` open it before backend methods run.
struct DuckGuard<'a>(std::sync::MutexGuard<'a, Option<duckdb::Connection>>);
impl std::ops::Deref for DuckGuard<'_> {
    type Target = duckdb::Connection;
    fn deref(&self) -> &duckdb::Connection {
        self.0
            .as_ref()
            .expect("duckdb connection accessed while released — ensure_alive must reopen it first")
    }
}

impl DuckConn {
    /// Lock the connection, recovering the guard even if a prior holder panicked
    /// (poisoning) — a panic mid-query shouldn't permanently brick the connection.
    fn lock(&self) -> DuckGuard<'_> {
        DuckGuard(self.conn.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// Whether the connection is currently open (a file lock is held).
    fn is_open(&self) -> bool {
        self.conn.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }

    /// Open the connection if it was released while idle (no-op if already open).
    fn ensure_open(&self) -> Result<(), AppError> {
        let mut g = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if g.is_none() {
            *g = Some(Self::open_conn(&self.config)?);
        }
        Ok(())
    }

    /// Release the connection (drop it → free the file lock) when it isn't needed:
    /// only a file-backed DB, and only when no result stream is mid-flight (an open
    /// stream keeps it for fast paging + a valid cancel handle).
    fn release_idle(&self) {
        if !self.keep_open && self.stream_sql.is_none() {
            let taken = self.conn.lock().unwrap_or_else(|e| e.into_inner()).take();
            if let Some(c) = taken {
                forget_if_poisoned(c);
            }
            *self.gate.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
    }

    /// Post-error net for poison classes the parse gate can't intercept (an
    /// interrupt mid-query, an unforeseen error path): if the live connection is in
    /// the #209 poisoned state, discard it — take + leak, dropping would abort the
    /// process — so `ensure_alive` opens a fresh one next command. Returns the
    /// user-facing consequence when a quarantine happened.
    fn quarantine_poisoned(&self) -> Option<&'static str> {
        let mut g = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let poisoned = g.as_ref().is_some_and(|c| c.prepare("SELECT 1").is_err());
        if !poisoned {
            return None;
        }
        if let Some(c) = g.take() {
            std::mem::forget(c);
        }
        Some(if self.keep_open {
            "the in-memory database was discarded (its data is lost) — the next query starts fresh"
        } else {
            "the connection was discarded — the next query reopens the file (if it stays locked, restart Tusk)"
        })
    }

    /// Wrap an operation error with the quarantine consequence when the error also
    /// poisoned the connection — otherwise "resource deadlock would occur" repeats
    /// on every later statement with no way out.
    fn quarantine_if_poisoned(&self, err: AppError) -> AppError {
        match self.quarantine_poisoned() {
            Some(hint) => AppError::new(format!(
                "{} — DuckDB left the connection unusable; {hint}",
                err.message
            )),
            None => err,
        }
    }

    /// Parse-check ONE statement before it touches the real connection.
    ///
    /// The bundled libduckdb (duckdb-rs #209, observed on Windows) leaves an internal
    /// mutex locked after a PARSER error: every later statement on that connection
    /// fails with "Invalid Error: resource deadlock would occur", and dropping the
    /// poisoned connection throws a C++ exception across the FFI boundary — a hard
    /// process abort ("Rust cannot catch foreign exceptions"). Binder/catalog/runtime
    /// errors are unaffected.
    ///
    /// So user SQL is prepared on a scratch in-memory connection first. Single-
    /// statement prepare never executes anything (duckdb-rs only auto-executes the
    /// LEADING statements of a multi-statement string — callers must pass one
    /// statement). Outcomes:
    /// - prepares cleanly → parse fine, run on the real connection;
    /// - fails but the scratch stays usable (probe succeeds) → binder/catalog error
    ///   from the empty scratch DB (missing tables etc.) → parse fine, run for real
    ///   so the real catalog produces the real error;
    /// - fails and the scratch is poisoned (probe fails) → exactly the error class
    ///   that would brick the real connection → report it, and `mem::forget` the
    ///   scratch (dropping it would abort the process). On platforms where parse
    ///   errors don't poison, the probe succeeds and the error surfaces from the
    ///   real connection — same behavior, no leak.
    fn parse_check(&self, sql: &str) -> Result<(), AppError> {
        let mut g = self.gate.lock().unwrap_or_else(|e| e.into_inner());
        let conn = match g.take() {
            Some(c) => c,
            None => duckdb::Connection::open_in_memory().map_err(de)?,
        };
        let err = match conn.prepare(sql) {
            Ok(_stmt) => None,
            Err(e) => Some(e),
        };
        match err {
            None => {
                *g = Some(conn);
                Ok(())
            }
            Some(e) => {
                let poisoned = conn.prepare("SELECT 1").is_err();
                if poisoned {
                    std::mem::forget(conn);
                    Err(de(e))
                } else {
                    *g = Some(conn);
                    Ok(())
                }
            }
        }
    }
}

/// Drop a DuckDB connection only if it is still healthy; a poisoned one (see
/// `parse_check`) is leaked instead — its destructor throws a foreign exception
/// that aborts the whole process.
fn forget_if_poisoned(conn: duckdb::Connection) {
    if conn.prepare("SELECT 1").is_err() {
        std::mem::forget(conn);
    }
}

impl Drop for DuckConn {
    fn drop(&mut self) {
        for m in [&self.conn, &self.gate] {
            let taken = m.lock().unwrap_or_else(|e| e.into_inner()).take();
            if let Some(c) = taken {
                forget_if_poisoned(c);
            }
        }
    }
}

/// A live embedded SQLite connection. Same LIMIT/OFFSET pager model as DuckDB; the
/// `Connection` is `!Sync` so it's wrapped in a `Mutex`.
pub struct SqliteConn {
    pub conn: Mutex<rusqlite::Connection>,
    pub config: ConnectionConfig,
    pub stream_sql: Option<String>,
    pub offset: usize,
}

impl SqliteConn {
    fn lock(&self) -> std::sync::MutexGuard<'_, rusqlite::Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// One connected database, dispatched by driver.
pub enum Backend {
    Pg(PgConn),
    Duck(DuckConn),
    Sqlite(SqliteConn),
    MySql(MySqlConn),
}

/// Open a connection for the configured driver. PG = network (TLS); DuckDB = a local
/// file (or `:memory:`), opened read-only when the connection is read-only.
pub async fn connect(config: &ConnectionConfig) -> Result<(Backend, String), AppError> {
    config.validate()?;
    match config.driver.as_deref().unwrap_or("postgres") {
        "postgres" => {
            let (client, version) = db::open(config).await?;
            Ok((
                Backend::Pg(PgConn {
                    client,
                    config: config.clone(),
                    cursor_open: false,
                }),
                version,
            ))
        }
        "duckdb" => DuckConn::open(config),
        "sqlite" => SqliteConn::open(config),
        "mysql" => MySqlConn::open(config).await,
        other => Err(AppError::new(format!("unknown driver: {other}"))),
    }
}

impl Backend {
    pub fn capabilities(&self) -> Capabilities {
        match self {
            Backend::Pg(_) => Capabilities::postgres(),
            Backend::Duck(_) => Capabilities::duckdb(),
            Backend::Sqlite(_) => Capabilities::sqlite(),
            Backend::MySql(_) => Capabilities::mysql(),
        }
    }

    pub fn config(&self) -> &ConnectionConfig {
        match self {
            Backend::Pg(p) => &p.config,
            Backend::Duck(d) => &d.config,
            Backend::Sqlite(s) => &s.config,
            Backend::MySql(m) => &m.config,
        }
    }

    pub fn is_closed(&self) -> bool {
        match self {
            Backend::Pg(p) => p.client.is_closed(),
            // DuckDB reports "closed" once it's been released while idle, so `ensure_alive`
            // re-opens it (and its file lock) lazily on the next command.
            Backend::Duck(d) => !d.is_open(),
            _ => false, // SQLite/MySQL — embedded/pooled, never "drops"
        }
    }

    /// After a command finishes, drop an embedded connection that doesn't need to stay
    /// open so it doesn't hold a file lock while idle. Currently only file-backed DuckDB
    /// (SQLite takes no exclusive idle lock; PG/MySQL are network). Re-opened by
    /// `ensure_alive` on the next command.
    pub fn release_idle(&self) {
        if let Backend::Duck(d) = self {
            d.release_idle();
        }
    }

    pub fn cursor_open(&self) -> bool {
        match self {
            Backend::Pg(p) => p.cursor_open,
            Backend::Duck(d) => d.stream_sql.is_some(),
            Backend::Sqlite(s) => s.stream_sql.is_some(),
            Backend::MySql(m) => m.stream_sql.is_some(),
        }
    }

    pub fn cancel_handle(&self) -> CancelHandle {
        match self {
            Backend::Pg(p) => CancelHandle::Pg(p.client.cancel_token()),
            Backend::Duck(d) => CancelHandle::Duck(d.lock().interrupt_handle()),
            _ => CancelHandle::None,
        }
    }

    /// Raw Postgres client, for PG-only paths not yet abstracted per driver
    /// (DDL reconstruction / export stream / server-lint / import). Errors otherwise.
    pub fn pg(&self) -> Result<&Client, AppError> {
        match self {
            Backend::Pg(p) => Ok(&p.client),
            _ => Err(AppError::new(
                "this operation isn't supported on this driver yet",
            )),
        }
    }

    /// Re-open a dropped connection. PG re-dials; DuckDB re-opens the file (no-op-ish).
    pub async fn reopen(&mut self) -> Result<(), AppError> {
        match self {
            Backend::Pg(p) => {
                let (client, _version) = db::open(&p.config).await?;
                p.client = client;
                p.cursor_open = false;
                Ok(())
            }
            // Re-open only the released connection; keep the pager/stream state intact
            // (the LIMIT/OFFSET pager re-derives each page from `stream_sql`, so a
            // released-then-reopened connection resumes paging correctly).
            Backend::Duck(d) => d.ensure_open(),
            Backend::Sqlite(s) => {
                let (backend, _v) = SqliteConn::open(&s.config)?;
                if let Backend::Sqlite(ns) = backend {
                    *s = ns;
                }
                Ok(())
            }
            Backend::MySql(m) => {
                let (backend, _v) = MySqlConn::open(&m.config).await?;
                if let Backend::MySql(nm) = backend {
                    *m = nm;
                }
                Ok(())
            }
        }
    }

    /// Apply the console's active schema (search_path). No-op where unsupported.
    pub async fn apply_search_path(&self, schema: &Option<String>) -> Result<(), AppError> {
        match self {
            Backend::Pg(p) => {
                let sql = match schema.as_deref() {
                    Some(s) if !s.is_empty() => {
                        format!("SET search_path TO {}, public", db::ident(s))
                    }
                    _ => "RESET search_path".to_string(),
                };
                p.client.batch_execute(&sql).await.map_err(Into::into)
            }
            _ => Ok(()), // embedded drivers have no per-session search_path
        }
    }

    /// Roll back + drop any open streaming cursor/transaction (no-op if none open).
    pub async fn rollback_cursor(&mut self) {
        match self {
            Backend::Pg(p) => {
                if p.cursor_open {
                    let _ = p.client.batch_execute("ROLLBACK").await;
                    p.cursor_open = false;
                }
            }
            Backend::Duck(d) => {
                d.stream_sql = None;
                d.offset = 0;
            }
            Backend::Sqlite(s) => {
                s.stream_sql = None;
                s.offset = 0;
            }
            Backend::MySql(m) => {
                m.stream_sql = None;
                m.offset = 0;
            }
        }
    }

    /// Run a multi-statement script — ONE transaction on every driver (PG via
    /// script::run; DuckDB/SQLite via an explicit BEGIN…COMMIT batch wrap;
    /// MySQL via START TRANSACTION around the loop, though MySQL DDL still
    /// auto-commits). Scripts that manage their own transaction (a BEGIN/
    /// COMMIT/SAVEPOINT statement anywhere) are run unwrapped — nesting would
    /// error on SQLite and silently misbehave elsewhere.
    pub async fn run_script(
        &self,
        items: &[script::Item],
        read_only: bool,
    ) -> Result<String, AppError> {
        let user_txn = script::has_txn_control(items);
        match self {
            Backend::Pg(p) => script::run(&p.client, items, read_only).await,
            Backend::Duck(d) => {
                // Parse-gate every statement before any of them executes (duckdb-rs
                // #209 — a parse error mid-batch would poison the connection).
                for it in items {
                    if let script::Item::Sql(s) = it {
                        d.parse_check(s)?;
                    }
                }
                // Two statements on purpose: the `d.lock()` temporary lives to the
                // end of the full expression, and quarantine_if_poisoned re-locks —
                // chaining map_err onto the same expression would self-deadlock.
                let r = embedded_script(&d.lock(), items, user_txn, |c, s| c.execute_batch(s).map_err(de));
                r.map_err(|e| d.quarantine_if_poisoned(e))
            }
            Backend::Sqlite(s) => embedded_script(&s.lock(), items, user_txn, |c, s| c.execute_batch(s).map_err(de)),
            Backend::MySql(m) => m.run_script(items, user_txn).await,
        }
    }

    /// Run a single statement: stream a cursorable read, else execute + report.
    pub async fn run_single(
        &mut self,
        trimmed: &str,
        page: u32,
        cursorable: bool,
    ) -> Result<QueryOutcome, AppError> {
        match self {
            Backend::Pg(p) => p.run_single(trimmed, page, cursorable).await,
            Backend::Duck(d) => d
                .run_single(trimmed, page, cursorable)
                .map_err(|e| d.quarantine_if_poisoned(e)),
            Backend::Sqlite(s) => s.run_single(trimmed, page, cursorable),
            Backend::MySql(m) => m.run_single(trimmed, page, cursorable).await,
        }
    }

    /// Run a Slack-approved read on a separately opened read-only backend. Refuse a
    /// writable backend rather than relying on SQL classification alone.
    pub async fn run_single_read_only(
        &mut self,
        trimmed: &str,
        page: u32,
        cursorable: bool,
    ) -> Result<QueryOutcome, AppError> {
        if !self.config().read_only {
            return Err(AppError::new("isolated Slack backend is not read-only"));
        }
        self.run_single(trimmed, page, cursorable).await
    }

    /// Fetch the next page from the open stream.
    pub async fn fetch_page(&mut self, page: u32) -> Result<FetchResult, AppError> {
        match self {
            Backend::Pg(p) => p.fetch_page(page).await,
            Backend::Duck(d) => d.fetch_page(page).map_err(|e| d.quarantine_if_poisoned(e)),
            Backend::Sqlite(s) => s.fetch_page(page),
            Backend::MySql(m) => m.fetch_page(page).await,
        }
    }

    /// Column indices of `sql`'s result set whose server-reported type is boolean.
    /// Feeds export's TRUE/FALSE mapping (scope=all — the frontend's grid-based
    /// detection can't see rows it hasn't loaded, so the server types are the truth
    /// here). Best-effort: any failure returns empty and the export proceeds unmapped.
    ///
    /// - Postgres: extended-protocol prepare (parse+plan only, nothing executes) —
    ///   also types expressions (`a AND b`), which no declared-type tier can.
    /// - DuckDB: `DESCRIBE <sql>` (binder output; types expressions too).
    /// - SQLite: declared column types off the prepared statement (no execution);
    ///   expressions have no decltype and are skipped — same tier as the grid.
    /// - MySQL: none. `tinyint(1)` is a display width the metadata drops, and the
    ///   grid deliberately shows 0/1 there — the export must match the grid.
    pub async fn bool_columns(&self, sql: &str) -> Vec<usize> {
        match self {
            Backend::Pg(p) => match p.client.prepare(sql).await {
                Ok(stmt) => stmt
                    .columns()
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| *c.type_() == tokio_postgres::types::Type::BOOL)
                    .map(|(i, _)| i)
                    .collect(),
                Err(_) => Vec::new(),
            },
            Backend::Duck(d) => {
                // Parse-gate the COMPOSED statement, not the raw sql: statements
                // that parse fine on their own (SHOW TABLES, SET, EXPLAIN …) are
                // parser errors under DESCRIBE, and that parser error would poison
                // the real connection (duckdb-rs #209). Best-effort contract.
                let wrapped = format!("DESCRIBE {sql}");
                if d.parse_check(&wrapped).is_err() {
                    return Vec::new();
                }
                // DESCRIBE returns one row per result column, in order; find the
                // column_type field by name so a layout change can't misread it.
                // Bind before matching — the lock temporary must drop before the
                // Err arm's quarantine probe re-locks.
                let described = duck_query(&d.lock(), &wrapped);
                match described {
                    Ok((cols, rows)) => {
                        let Some(ty) = cols.iter().position(|c| c == "column_type") else {
                            return Vec::new();
                        };
                        rows.iter()
                            .enumerate()
                            .filter(|(_, r)| r.get(ty).and_then(|v| v.as_deref()) == Some("BOOLEAN"))
                            .map(|(i, _)| i)
                            .collect()
                    }
                    Err(_) => {
                        let _ = d.quarantine_poisoned(); // best-effort result, but never leave the connection bricked
                        Vec::new()
                    }
                }
            }
            Backend::Sqlite(s) => {
                let conn = s.lock();
                let found = match conn.prepare(sql) {
                    Ok(stmt) => stmt
                        .columns()
                        .iter()
                        .enumerate()
                        .filter(|(_, c)| {
                            c.decl_type()
                                .map(|t| t.trim().eq_ignore_ascii_case("bool") || t.trim().eq_ignore_ascii_case("boolean"))
                                .unwrap_or(false)
                        })
                        .map(|(i, _)| i)
                        .collect(),
                    Err(_) => Vec::new(),
                };
                found
            }
            Backend::MySql(_) => Vec::new(),
        }
    }

    /// Run an internal text-returning query (introspection): columns + text rows.
    async fn query_text(
        &self,
        sql: &str,
    ) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), AppError> {
        match self {
            Backend::Pg(p) => {
                let m = p.client.simple_query(sql).await?;
                Ok(db::collect_rows(&m))
            }
            Backend::Duck(d) => duck_query(&d.lock(), sql),
            Backend::Sqlite(s) => sqlite_query(&s.lock(), sql),
            Backend::MySql(m) => {
                let (c, r, _a) = mysql_run(&m.pool, sql).await?;
                Ok((c, r))
            }
        }
    }

    /// Shallow object tree (sidebar). PG = rich pg_catalog; embedded = catalog views.
    pub async fn build_tree(&self) -> Result<tree::DbTree, AppError> {
        match self {
            Backend::Pg(p) => tree::build_shallow(&p.client).await,
            Backend::Duck(d) => duck_build_tree(&d.lock()),
            Backend::Sqlite(s) => sqlite_build_tree(&s.lock()),
            Backend::MySql(m) => mysql_build_tree(&m.pool).await,
        }
    }

    /// The connected database's NAME, as the sidebar shows it — i.e. what `build_tree()`
    /// puts in `DbTree.database`, derived from the server, NOT from `ConnectionConfig.dbname`.
    ///
    /// These differ, and the difference is silent: `dbname` is the field the user typed, so
    /// it's **empty for DuckDB/SQLite** (path-based) and empty on Postgres whenever libpq
    /// defaults it. Anything that scopes behaviour by database — notably **AI skills**, in
    /// both the panel and the Slack bot — must agree on one value, or a skill applies in one
    /// place and silently vanishes in the other. `driver_conformance` pins this to `build_tree`.
    pub async fn database_name(&self) -> String {
        match self {
            Backend::Pg(_) => self
                .query_text("SELECT current_database()")
                .await
                .ok()
                .and_then(|(_c, rows)| rows.into_iter().next())
                .and_then(|r| r.into_iter().next().flatten())
                .unwrap_or_default(),
            Backend::Duck(d) => d
                .lock()
                .query_row("SELECT current_database()", [], |r| r.get::<_, String>(0))
                .unwrap_or_default(),
            // SQLite's single attached database is always `main` (see `sqlite_build_tree`).
            Backend::Sqlite(_) => "main".to_string(),
            Backend::MySql(m) => mysql_run(&m.pool, "SELECT database()")
                .await
                .ok()
                .and_then(|(_c, rows, _a)| rows.into_iter().next())
                .and_then(|r| r.into_iter().next().flatten())
                .unwrap_or_default(),
        }
    }

    /// Per-relation detail (columns + indexes/constraints) on expand.
    pub async fn table_detail(
        &self,
        schema: &str,
        name: &str,
    ) -> Result<tree::RelationDetail, AppError> {
        match self {
            Backend::Pg(p) => tree::table_detail(&p.client, schema, name).await,
            Backend::Duck(d) => duck_table_detail(&d.lock(), schema, name),
            Backend::Sqlite(s) => sqlite_table_detail(&s.lock(), name),
            Backend::MySql(m) => mysql_table_detail(&m.pool, schema, name).await,
        }
    }

    /// FK relationships of one relation (outbound + inbound). Best-effort:
    /// engines that can't answer return empty lists, never errors.
    pub async fn table_relationships(
        &self,
        schema: &str,
        name: &str,
    ) -> Result<relgraph::Relationships, AppError> {
        match self {
            Backend::Pg(p) => relgraph::pg_table_relationships(&p.client, schema, name).await,
            Backend::Duck(d) => {
                let conn = d.lock();
                let edges = duck_fk_edges(&conn);
                let mut outbound = Vec::new();
                let mut inbound = Vec::new();
                for e in edges {
                    if e.src_schema == schema && e.src_table == name {
                        outbound.push(e.clone());
                    }
                    if e.dst_schema == schema && e.dst_table == name {
                        inbound.push(e);
                    }
                }
                Ok(relgraph::Relationships { outbound, inbound })
            }
            Backend::Sqlite(s) => {
                let conn = s.lock();
                let q = move |sql: &str| sqlite_query(&conn, sql);
                Ok(relgraph::sqlite_table_relationships(&q, name))
            }
            Backend::MySql(m) => {
                let (_c, rows, _a) = mysql_run(&m.pool, &relgraph::mysql_relationship_queries(schema, name)).await?;
                Ok(relgraph::mysql_split(&rows, schema, name))
            }
        }
    }

    /// All FK edges + table/column summaries of a schema, for the ERD view.
    pub async fn schema_relationships(&self, schema: &str) -> Result<relgraph::SchemaGraph, AppError> {
        match self {
            Backend::Pg(p) => relgraph::pg_schema_relationships(&p.client, schema).await,
            Backend::Duck(d) => {
                let conn = d.lock();
                let edges: Vec<relgraph::FkEdge> = duck_fk_edges(&conn)
                    .into_iter()
                    .filter(|e| e.src_schema == schema || e.dst_schema == schema)
                    .collect();
                // PK membership best-effort from duckdb_constraints().
                let mut pk: std::collections::HashSet<(String, String)> = Default::default();
                if let Ok((_c, rows)) = duck_query(&conn, relgraph::DUCK_PK) {
                    for r in &rows {
                        if dcell(r, 0) == schema {
                            let t = dcell(r, 1);
                            for c in dcell(r, 2).trim_matches(['[', ']']).split(", ") {
                                if !c.is_empty() {
                                    pk.insert((t.clone(), c.to_string()));
                                }
                            }
                        }
                    }
                }
                let fk: std::collections::HashSet<(String, String)> = edges
                    .iter()
                    .filter(|e| e.src_schema == schema)
                    .flat_map(|e| e.src_cols.iter().map(|c| (e.src_table.clone(), c.clone())))
                    .collect();
                let (_c, col_rows) = duck_query(
                    &conn,
                    &format!(
                        "SELECT table_name, column_name, data_type FROM information_schema.columns \
                         WHERE table_schema = {} ORDER BY table_name, ordinal_position",
                        dlit(schema)
                    ),
                )?;
                let mut tables: Vec<relgraph::ErdTable> = Vec::new();
                for r in &col_rows {
                    let t = dcell(r, 0);
                    if tables.last().map(|x| x.name != t).unwrap_or(true) {
                        tables.push(relgraph::ErdTable { schema: schema.to_string(), name: t.clone(), columns: Vec::new() });
                    }
                    let cname = dcell(r, 1);
                    if let Some(table) = tables.last_mut() {
                        table.columns.push(relgraph::ErdColumn {
                            is_pk: pk.contains(&(t.clone(), cname.clone())),
                            is_fk: fk.contains(&(t, cname.clone())),
                            name: cname,
                            data_type: dcell(r, 2),
                        });
                    }
                }
                Ok(relgraph::SchemaGraph { tables, edges })
            }
            Backend::Sqlite(s) => {
                let conn = s.lock();
                let q = move |sql: &str| sqlite_query(&conn, sql);
                Ok(relgraph::sqlite_schema_relationships(&q))
            }
            Backend::MySql(m) => {
                let (_c, edge_rows, _a) = mysql_run(&m.pool, &relgraph::mysql_schema_edges_query(schema)).await?;
                let (_c2, col_rows, _a2) = mysql_run(&m.pool, &relgraph::mysql_columns_query(schema)).await?;
                Ok(relgraph::mysql_schema_graph(&col_rows, &edge_rows, schema))
            }
        }
    }

    /// Reconstructed CREATE DDL for one relation, per engine: PG pg_catalog
    /// (full reconstruction in ddl.rs), SQLite sqlite_master (+ index DDL),
    /// MySQL SHOW CREATE, DuckDB duckdb_tables()/duckdb_views() best-effort.
    pub async fn relation_ddl(&self, kind: &str, schema: &str, name: &str) -> Result<String, AppError> {
        match self {
            Backend::Pg(p) => crate::ddl::object_ddl(&p.client, kind, schema, name).await,
            Backend::Sqlite(s) => {
                let conn = s.lock();
                let lit = |x: &str| format!("'{}'", x.replace('\'', "''"));
                let (_c, rows) = sqlite_query(
                    &conn,
                    &format!("SELECT sql FROM sqlite_master WHERE name = {} AND sql IS NOT NULL", lit(name)),
                )?;
                let mut parts: Vec<String> = rows.iter().filter_map(|r| r.first().cloned().flatten()).collect();
                if parts.is_empty() {
                    return Err(AppError::new("no stored DDL for this object"));
                }
                let (_c2, idx) = sqlite_query(
                    &conn,
                    &format!(
                        "SELECT sql FROM sqlite_master WHERE tbl_name = {} AND type = 'index' AND sql IS NOT NULL ORDER BY name",
                        lit(name)
                    ),
                )?;
                parts.extend(idx.iter().filter_map(|r| r.first().cloned().flatten()));
                Ok(parts.join(";\n\n") + ";\n")
            }
            Backend::MySql(m) => {
                let is_view = kind == "view" || kind == "matview";
                let q = format!(
                    "SHOW CREATE {} `{}`.`{}`",
                    if is_view { "VIEW" } else { "TABLE" },
                    schema.replace('`', "``"),
                    name.replace('`', "``")
                );
                let (_c, rows, _a) = mysql_run(&m.pool, &q).await?;
                rows.first()
                    .and_then(|r| r.get(1).cloned().flatten())
                    .map(|s| s + ";\n")
                    .ok_or_else(|| AppError::new("no DDL returned"))
            }
            Backend::Duck(d) => {
                let conn = d.lock();
                let src = if kind == "view" { "duckdb_views()" } else { "duckdb_tables()" };
                let q = format!(
                    "SELECT sql FROM {src} WHERE schema_name = {} AND {} = {}",
                    dlit(schema),
                    if kind == "view" { "view_name" } else { "table_name" },
                    dlit(name)
                );
                let (_c, rows) = duck_query(&conn, &q).map_err(|_| {
                    AppError::new("DDL reconstruction isn't supported on this DuckDB build")
                })?;
                rows.first()
                    .and_then(|r| r.first().cloned().flatten())
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| if s.trim_end().ends_with(';') { s + "\n" } else { s + ";\n" })
                    .ok_or_else(|| AppError::new("no stored DDL for this object"))
            }
        }
    }

    /// Every callable function/procedure name visible on this connection
    /// (builtins + user-defined), for the editor's unknown-function lint and
    /// autocomplete. Best-effort: an engine without a complete catalog returns
    /// EMPTY, which tells the frontend to skip function linting entirely
    /// (never lint against a partial list — false positives kill trust).
    pub async fn list_functions(&self) -> Result<Vec<String>, AppError> {
        match self {
            Backend::Pg(p) => {
                let msgs = p
                    .client
                    .simple_query("SELECT DISTINCT proname FROM pg_proc")
                    .await?;
                let (_c, rows) = db::collect_rows(&msgs);
                Ok(rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect())
            }
            Backend::Duck(d) => {
                let conn = d.lock();
                let (_c, rows) = duck_query(&conn, "SELECT DISTINCT function_name FROM duckdb_functions()")?;
                Ok(rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect())
            }
            Backend::Sqlite(s) => {
                let conn = s.lock();
                let (_c, rows) = sqlite_query(&conn, "SELECT DISTINCT name FROM pragma_function_list")?;
                Ok(rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect())
            }
            // MySQL has no catalog of BUILTIN functions (information_schema.routines
            // is user routines only) — a partial list would false-positive on every
            // uncommon builtin, so report none and the lint stays off.
            Backend::MySql(_) => Ok(Vec::new()),
        }
    }

    /// Effective privileges of the connected role. Postgres only for now; other drivers
    /// report `unrestricted` (the UI imposes no extra gating).
    pub async fn permissions(&self) -> Result<crate::perms::Permissions, AppError> {
        match self {
            Backend::Pg(p) => crate::perms::collect(&p.client).await,
            _ => Ok(crate::perms::Permissions::unrestricted()),
        }
    }

    /// Flat schema/table/column list that feeds frontend autocomplete.
    pub async fn list_tables(&self) -> Result<Vec<tree::TableInfo>, AppError> {
        // SQLite has no information_schema — build from sqlite_master + PRAGMA.
        if let Backend::Sqlite(s) = self {
            return sqlite_list_tables(&s.lock());
        }
        // Same information_schema shape across PG / DuckDB / MySQL, only the system-schema
        // exclusion differs.
        let exclude = match self {
            Backend::MySql(_) => "('mysql','information_schema','performance_schema','sys')",
            _ => "('pg_catalog','information_schema')",
        };
        let sql = format!(
            "SELECT table_schema, table_name, column_name, data_type \
             FROM information_schema.columns \
             WHERE table_schema NOT IN {exclude} \
             ORDER BY table_schema, table_name, ordinal_position"
        );
        let (_cols, rows) = self.query_text(&sql).await?;
        Ok(tree::tables_from_rows(rows))
    }

    /// A few sample rows from a relation (text values), for AI context. Read-only and
    /// **does not touch the streaming cursor** — on PG it runs via `simple_query` in
    /// whatever transaction is current, leaving an in-flight stream intact. Best-effort:
    /// the caller treats any error as "no sample".
    pub async fn sample_rows(
        &self,
        schema: &str,
        table: &str,
        limit: u32,
    ) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), AppError> {
        self.query_text(&sample_sql(self, schema, table, limit.clamp(1, 50))).await
    }
}

/// `SELECT * FROM <rel> LIMIT n`, identifier-quoted per dialect (MySQL backticks,
/// everyone else double quotes). Schema-qualified when a schema is given.
fn sample_sql(b: &Backend, schema: &str, table: &str, limit: u32) -> String {
    let mysql = matches!(b, Backend::MySql(_));
    let q = |s: &str| {
        if mysql {
            format!("`{}`", s.replace('`', "``"))
        } else {
            format!("\"{}\"", s.replace('"', "\"\""))
        }
    };
    let rel = if schema.is_empty() { q(table) } else { format!("{}.{}", q(schema), q(table)) };
    format!("SELECT * FROM {rel} LIMIT {limit}")
}

impl PgConn {
    async fn run_single(
        &mut self,
        trimmed: &str,
        page: u32,
        cursorable: bool,
    ) -> Result<QueryOutcome, AppError> {
        if cursorable {
            self.client.batch_execute("BEGIN").await?;
            let declare = format!("DECLARE {CURSOR_NAME} CURSOR FOR {trimmed}");
            if let Err(e) = self.client.batch_execute(&declare).await {
                let _ = self.client.batch_execute("ROLLBACK").await;
                return Err(e.into());
            }
            let fetch = format!("FETCH FORWARD {page} FROM {CURSOR_NAME}");
            // On a failed/cancelled FETCH the BEGIN transaction is left aborted — roll it
            // back so the next query on this (still-alive) session isn't poisoned.
            let messages = match self.client.simple_query(&fetch).await {
                Ok(m) => m,
                Err(e) => {
                    let _ = self.client.batch_execute("ROLLBACK").await;
                    self.cursor_open = false;
                    return Err(e.into());
                }
            };
            let (columns, rows) = db::collect_rows(&messages);
            let done = (rows.len() as u32) < page;
            if done {
                let _ = self
                    .client
                    .batch_execute(&format!("CLOSE {CURSOR_NAME}"))
                    .await;
                let _ = self.client.batch_execute("COMMIT").await;
                self.cursor_open = false;
            } else {
                self.cursor_open = true;
            }
            Ok(QueryOutcome::Rows {
                columns,
                rows,
                done,
                note: None,
            })
        } else {
            let messages = self.client.simple_query(trimmed).await?;
            let (columns, rows) = db::collect_rows(&messages);
            if !columns.is_empty() {
                Ok(QueryOutcome::Rows {
                    columns,
                    rows,
                    done: true,
                    note: None,
                })
            } else {
                let affected: u64 = messages
                    .iter()
                    .filter_map(|m| match m {
                        SimpleQueryMessage::CommandComplete(n) => Some(*n),
                        _ => None,
                    })
                    .last()
                    .unwrap_or(0);
                Ok(QueryOutcome::Exec {
                    // "(0 rows affected)" after a successful ALTER reads like failure.
                    message: if script::is_ddl(trimmed) { "OK".to_string() } else { format!("OK ({affected} rows affected)") },
                })
            }
        }
    }

    async fn fetch_page(&mut self, page: u32) -> Result<FetchResult, AppError> {
        let fetch = format!("FETCH FORWARD {page} FROM {CURSOR_NAME}");
        let messages = self.client.simple_query(&fetch).await?;
        let (_cols, rows) = db::collect_rows(&messages);
        let done = (rows.len() as u32) < page;
        if done {
            let _ = self
                .client
                .batch_execute(&format!("CLOSE {CURSOR_NAME}"))
                .await;
            let _ = self.client.batch_execute("COMMIT").await;
            self.cursor_open = false;
        }
        Ok(FetchResult { rows, done })
    }
}

impl DuckConn {
    /// Resolve the effective DuckDB path (`:memory:` when blank/unset).
    fn resolve_path(config: &ConnectionConfig) -> String {
        config
            .path
            .clone()
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| ":memory:".to_string())
    }

    /// Open a raw DuckDB connection per the config (memory / read-only file / read-write file).
    fn open_conn(config: &ConnectionConfig) -> Result<duckdb::Connection, AppError> {
        let path = Self::resolve_path(config);
        let conn = if path == ":memory:" {
            duckdb::Connection::open_in_memory().map_err(de)?
        } else if config.read_only {
            let cfg = duckdb::Config::default()
                .access_mode(duckdb::AccessMode::ReadOnly)
                .map_err(de)?;
            duckdb::Connection::open_with_flags(&path, cfg).map_err(de)?
        } else {
            duckdb::Connection::open(&path).map_err(de)?
        };
        // Without ICU, TIMESTAMP WITH TIME ZONE casts fail ("Unimplemented type for cast
        // (TIMESTAMP WITH TIME ZONE -> DATE)"). The bundled libduckdb does NOT ship ICU
        // compiled in — `LOAD icu` returns `Extension "icu" is an existing extension.
        // Install it first using "INSTALL icu"` until the extension has been downloaded
        // into the user's extension dir (~/.duckdb/extensions/<ver>/<platform>/).
        //
        // So: fast-path LOAD (already downloaded), else INSTALL once (one-time network
        // fetch, cached on disk) and LOAD again. `SET autoinstall_known_extensions` /
        // `autoload_known_extensions` do NOT help — a cast doesn't trigger autoload.
        //
        // Best-effort throughout: a cold + offline machine degrades exactly as before
        // (TIMESTAMPTZ casts error), rather than failing the whole connection.
        // Memoized: `open_conn` runs on EVERY reopen after an idle file-lock release, i.e.
        // potentially once per command. `INSTALL` is a blocking network download, so on a
        // cold + offline machine an un-memoized fallback would stall every single query on
        // a connect timeout. Once it has failed, don't reach for the network again.
        static ICU_UNAVAILABLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        use std::sync::atomic::Ordering;
        if conn.execute("LOAD icu", []).is_err() && !ICU_UNAVAILABLE.load(Ordering::Relaxed) {
            let _ = conn.execute("INSTALL icu", []);
            if let Err(e) = conn.execute("LOAD icu", []) {
                ICU_UNAVAILABLE.store(true, Ordering::Relaxed);
                eprintln!("[tusk] DuckDB ICU extension unavailable ({e}); TIMESTAMPTZ casts will fail");
            }
        }
        Ok(conn)
    }

    fn open(config: &ConnectionConfig) -> Result<(Backend, String), AppError> {
        let conn = Self::open_conn(config)?;
        let version = conn
            .query_row("SELECT version()", [], |r| r.get::<_, String>(0))
            .unwrap_or_else(|_| "DuckDB".to_string());
        Ok((
            Backend::Duck(DuckConn {
                conn: Mutex::new(Some(conn)),
                keep_open: Self::resolve_path(config) == ":memory:",
                config: config.clone(),
                stream_sql: None,
                offset: 0,
                gate: Mutex::new(None),
            }),
            version,
        ))
    }

    fn run_single(
        &mut self,
        trimmed: &str,
        page: u32,
        cursorable: bool,
    ) -> Result<QueryOutcome, AppError> {
        // Gate the user text first (error positions match what they typed), then the
        // wrap we actually execute (a trailing `--` comment in the user text would
        // swallow the wrap's closing paren — a parse error the first gate can't see).
        self.parse_check(trimmed)?;
        if cursorable {
            // CAST(COLUMNS(*) AS VARCHAR) renders every column as text (matching the
            // all-text model — handles dates/decimals/etc. cleanly); LIMIT pages it.
            let wrapped =
                format!("SELECT CAST(COLUMNS(*) AS VARCHAR) FROM ({trimmed}) AS _tusk LIMIT {page}");
            self.parse_check(&wrapped)?;
            let (columns, rows) = {
                let g = self.lock();
                duck_query(&g, &wrapped)?
            };
            let done = (rows.len() as u32) < page;
            if done {
                self.stream_sql = None;
                self.offset = 0;
            } else {
                self.stream_sql = Some(trimmed.to_string());
                self.offset = page as usize;
            }
            Ok(QueryOutcome::Rows {
                columns,
                rows,
                done,
                note: None,
            })
        } else {
            // DuckDB surfaces a synthetic "Count" result column for DDL/DML run
            // through query(), which would misclassify them as Rows — route DDL
            // straight to execute_batch and report a clean "OK".
            if script::is_ddl(trimmed) {
                let g = self.lock();
                g.execute_batch(trimmed).map_err(de)?;
                return Ok(QueryOutcome::Exec {
                    message: "OK".to_string(),
                });
            }
            let (columns, rows) = {
                let g = self.lock();
                duck_query(&g, trimmed)?
            };
            if !columns.is_empty() {
                Ok(QueryOutcome::Rows {
                    columns,
                    rows,
                    done: true,
                    note: None,
                })
            } else {
                Ok(QueryOutcome::Exec {
                    message: "OK".to_string(),
                })
            }
        }
    }

    fn fetch_page(&mut self, page: u32) -> Result<FetchResult, AppError> {
        let base = match &self.stream_sql {
            Some(s) => s.clone(),
            None => {
                return Ok(FetchResult {
                    rows: vec![],
                    done: true,
                })
            }
        };
        let wrapped = format!(
            "SELECT CAST(COLUMNS(*) AS VARCHAR) FROM ({base}) AS _tusk LIMIT {page} OFFSET {}",
            self.offset
        );
        let (_cols, rows) = {
            let g = self.lock();
            duck_query(&g, &wrapped)?
        };
        let done = (rows.len() as u32) < page;
        self.offset += rows.len();
        if done {
            self.stream_sql = None;
        }
        Ok(FetchResult { rows, done })
    }
}

impl SqliteConn {
    fn open(config: &ConnectionConfig) -> Result<(Backend, String), AppError> {
        let path = config
            .path
            .clone()
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| ":memory:".to_string());
        let conn = if path == ":memory:" {
            rusqlite::Connection::open_in_memory().map_err(de)?
        } else if config.read_only {
            rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(de)?
        } else {
            rusqlite::Connection::open(&path).map_err(de)?
        };
        let version: String = conn
            .query_row("SELECT sqlite_version()", [], |r| r.get(0))
            .unwrap_or_else(|_| "unknown".to_string());
        Ok((
            Backend::Sqlite(SqliteConn {
                conn: Mutex::new(conn),
                config: config.clone(),
                stream_sql: None,
                offset: 0,
            }),
            format!("SQLite {version}"),
        ))
    }

    fn run_single(
        &mut self,
        trimmed: &str,
        page: u32,
        cursorable: bool,
    ) -> Result<QueryOutcome, AppError> {
        if cursorable {
            // SQLite ValueRef already yields text per cell, so a plain wrap suffices.
            let wrapped = format!("SELECT * FROM ({trimmed}) LIMIT {page}");
            let (columns, rows) = {
                let g = self.lock();
                sqlite_query(&g, &wrapped)?
            };
            let done = (rows.len() as u32) < page;
            if done {
                self.stream_sql = None;
                self.offset = 0;
            } else {
                self.stream_sql = Some(trimmed.to_string());
                self.offset = page as usize;
            }
            Ok(QueryOutcome::Rows {
                columns,
                rows,
                done,
                note: None,
            })
        } else {
            let g = self.lock();
            let (columns, rows) = sqlite_query(&g, trimmed)?;
            if !columns.is_empty() {
                Ok(QueryOutcome::Rows {
                    columns,
                    rows,
                    done: true,
                    note: None,
                })
            } else {
                Ok(QueryOutcome::Exec {
                    // sqlite `changes()` is STALE after DDL (reports the previous
                    // statement's count) — and DDL counts are noise anyway.
                    message: if script::is_ddl(trimmed) { "OK".to_string() } else { format!("OK ({} rows affected)", g.changes()) },
                })
            }
        }
    }

    fn fetch_page(&mut self, page: u32) -> Result<FetchResult, AppError> {
        let base = match &self.stream_sql {
            Some(s) => s.clone(),
            None => {
                return Ok(FetchResult {
                    rows: vec![],
                    done: true,
                })
            }
        };
        let wrapped = format!("SELECT * FROM ({base}) LIMIT {page} OFFSET {}", self.offset);
        let (_cols, rows) = {
            let g = self.lock();
            sqlite_query(&g, &wrapped)?
        };
        let done = (rows.len() as u32) < page;
        self.offset += rows.len();
        if done {
            self.stream_sql = None;
        }
        Ok(FetchResult { rows, done })
    }
}

fn sqlite_value(v: rusqlite::types::ValueRef) -> Option<String> {
    use rusqlite::types::ValueRef as V;
    match v {
        V::Null => None,
        V::Integer(n) => Some(n.to_string()),
        V::Real(f) => Some(f.to_string()),
        V::Text(b) => Some(String::from_utf8_lossy(b).into_owned()),
        V::Blob(b) => Some(String::from_utf8_lossy(b).into_owned()),
    }
}

fn sqlite_query(
    conn: &rusqlite::Connection,
    sql: &str,
) -> Result<TextRows, AppError> {
    let mut stmt = conn.prepare(sql).map_err(de)?;
    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let ncols = columns.len();
    let mut rows = stmt.query([]).map_err(de)?;
    let mut data: Vec<Vec<Option<String>>> = Vec::new();
    while let Some(row) = rows.next().map_err(de)? {
        let mut r = Vec::with_capacity(ncols);
        for i in 0..ncols {
            r.push(sqlite_value(row.get_ref(i).map_err(de)?));
        }
        data.push(r);
    }
    Ok((columns, data))
}

fn sqlite_list_tables(conn: &rusqlite::Connection) -> Result<Vec<tree::TableInfo>, AppError> {
    let (_c, trows) = sqlite_query(
        conn,
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') \
         AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let mut out: Vec<tree::TableInfo> = Vec::new();
    for tr in &trows {
        let name = dcell(tr, 0);
        let (_c2, crows) = sqlite_query(conn, &format!("PRAGMA table_info({})", db::ident(&name)))?;
        let columns = crows
            .iter()
            .map(|r| tree::ColumnInfo {
                name: dcell(r, 1),
                data_type: dcell(r, 2),
            })
            .collect();
        out.push(tree::TableInfo {
            schema: "main".to_string(),
            name,
            columns,
        });
    }
    Ok(out)
}

fn sqlite_build_tree(conn: &rusqlite::Connection) -> Result<tree::DbTree, AppError> {
    let (_c, rows) = sqlite_query(
        conn,
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') \
         AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let mut tables: Vec<tree::RelStub> = Vec::new();
    let mut views: Vec<tree::RelStub> = Vec::new();
    for r in &rows {
        let name = dcell(r, 0);
        let is_view = dcell(r, 1).eq_ignore_ascii_case("view");
        let stub = tree::RelStub {
            name,
            kind: if is_view { "view" } else { "table" }.to_string(),
            comment: None,
            rows: None,
            size: None,
        };
        if is_view {
            views.push(stub);
        } else {
            tables.push(stub);
        }
    }
    Ok(tree::DbTree {
        database: "main".to_string(),
        databases: vec!["main".to_string()],
        schemas: vec![tree::Schema {
            name: "main".to_string(),
            tables,
            views,
            sequences: vec![],
            functions: vec![],
        }],
    })
}

fn sqlite_table_detail(
    conn: &rusqlite::Connection,
    name: &str,
) -> Result<tree::RelationDetail, AppError> {
    // PRAGMA table_info → (cid, name, type, notnull, dflt_value, pk).
    let (_c, rows) = sqlite_query(conn, &format!("PRAGMA table_info({})", db::ident(name)))?;
    let columns = rows
        .iter()
        .map(|r| tree::Column {
            name: dcell(r, 1),
            data_type: dcell(r, 2),
            nullable: dcell(r, 3) != "1",
            is_pk: dcell(r, 5) != "0" && !dcell(r, 5).is_empty(),
            is_fk: false,
            default: r.get(4).and_then(|v| v.clone()),
            comment: None,
        })
        .collect();
    Ok(tree::RelationDetail {
        name: name.to_string(),
        kind: "table".to_string(),
        comment: None,
        columns,
        indexes: vec![],
        constraints: vec![],
        triggers: vec![],
    })
}

/// A live MySQL connection pool. A `Pool` is Send+Sync+Clone (no `!Sync`-connection
/// problem); paging is LIMIT/OFFSET over the base query (each page is an independent
/// query — fine over a pool).
pub struct MySqlConn {
    pub pool: mysql_async::Pool,
    pub config: ConnectionConfig,
    pub stream_sql: Option<String>,
    pub offset: usize,
}

impl MySqlConn {
    async fn open(config: &ConnectionConfig) -> Result<(Backend, String), AppError> {
        let mut builder = mysql_async::OptsBuilder::default()
            .ip_or_hostname(config.host.clone())
            .tcp_port(config.port)
            .user(Some(config.user.clone()))
            .pass(Some(config.password.clone()));
        if !config.dbname.is_empty() {
            builder = builder.db_name(Some(config.dbname.clone()));
        }
        if config.read_only {
            // Applied to every pooled connection, not merely the first one checked
            // out. This catches side-effecting functions that a SQL token scan cannot.
            // `setup` is rerun after mysql_async resets a pooled connection;
            // `init` only runs at creation and would be cleared on first return.
            builder = builder.setup(vec!["SET SESSION TRANSACTION READ ONLY"]);
        }
        match config.sslmode.as_deref().unwrap_or("prefer") {
            "disable" => {}
            mode => {
                let mut ssl = mysql_async::SslOpts::default();
                if mode != "verify-ca" && mode != "verify-full" {
                    ssl = ssl
                        .with_danger_accept_invalid_certs(true)
                        .with_danger_skip_domain_validation(true);
                }
                builder = builder.ssl_opts(Some(ssl));
            }
        }
        let pool = mysql_async::Pool::new(builder);
        // Fail fast + capture the server version.
        let (_c, rows, _a) = mysql_run(&pool, "SELECT version()").await?;
        let version = rows
            .first()
            .and_then(|r| r.first().cloned().flatten())
            .unwrap_or_else(|| "unknown".to_string());
        Ok((
            Backend::MySql(MySqlConn {
                pool,
                config: config.clone(),
                stream_sql: None,
                offset: 0,
            }),
            format!("MySQL {version}"),
        ))
    }

    async fn run_single(
        &mut self,
        trimmed: &str,
        page: u32,
        cursorable: bool,
    ) -> Result<QueryOutcome, AppError> {
        if cursorable {
            let (columns, rows) = mysql_page(&self.pool, trimmed, page, 0).await?;
            let done = (rows.len() as u32) < page;
            if done {
                self.stream_sql = None;
                self.offset = 0;
            } else {
                self.stream_sql = Some(trimmed.to_string());
                self.offset = page as usize;
            }
            Ok(QueryOutcome::Rows {
                columns,
                rows,
                done,
                note: None,
            })
        } else {
            let (columns, rows, affected) = mysql_run(&self.pool, trimmed).await?;
            if !columns.is_empty() {
                Ok(QueryOutcome::Rows {
                    columns,
                    rows,
                    done: true,
                    note: None,
                })
            } else {
                Ok(QueryOutcome::Exec {
                    message: if script::is_ddl(trimmed) { "OK".to_string() } else { format!("OK ({affected} rows affected)") },
                })
            }
        }
    }

    async fn fetch_page(&mut self, page: u32) -> Result<FetchResult, AppError> {
        let base = match &self.stream_sql {
            Some(s) => s.clone(),
            None => {
                return Ok(FetchResult {
                    rows: vec![],
                    done: true,
                })
            }
        };
        let (_c, rows) = mysql_page(&self.pool, &base, page, self.offset).await?;
        let done = (rows.len() as u32) < page;
        self.offset += rows.len();
        if done {
            self.stream_sql = None;
        }
        Ok(FetchResult { rows, done })
    }

    /// Transactional unless the script manages its own transaction. NOTE:
    /// MySQL DDL statements implicitly commit — DML-only scripts are atomic.
    async fn run_script(&self, items: &[script::Item], user_txn: bool) -> Result<String, AppError> {
        use mysql_async::prelude::Queryable;
        let mut conn = self.pool.get_conn().await.map_err(de)?;
        if !user_txn {
            conn.query_drop("START TRANSACTION").await.map_err(de)?;
        }
        for it in items {
            if let script::Item::Sql(s) = it {
                if let Err(e) = conn.query_drop(s.trim()).await.map_err(de) {
                    if !user_txn {
                        let _ = conn.query_drop("ROLLBACK").await;
                    }
                    return Err(e);
                }
            }
        }
        if !user_txn {
            conn.query_drop("COMMIT").await.map_err(de)?;
        }
        Ok("OK".to_string())
    }
}

fn mysql_value_to_string(v: &mysql_async::Value) -> Option<String> {
    use mysql_async::Value as V;
    match v {
        V::NULL => None,
        V::Bytes(b) => Some(String::from_utf8_lossy(b).into_owned()),
        V::Int(n) => Some(n.to_string()),
        V::UInt(n) => Some(n.to_string()),
        V::Float(f) => Some(f.to_string()),
        V::Double(f) => Some(f.to_string()),
        V::Date(y, mo, d, h, mi, s, us) => {
            // A pure DATE (and DATETIME/TIMESTAMP at exact midnight) renders date-only;
            // a non-zero time renders the full timestamp. (Value::Date can't distinguish
            // DATE from DATETIME, so the zero-time heuristic keeps DATE columns clean.)
            if *h == 0 && *mi == 0 && *s == 0 && *us == 0 {
                Some(format!("{y:04}-{mo:02}-{d:02}"))
            } else {
                let base = format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}");
                Some(if *us > 0 { format!("{base}.{us:06}") } else { base })
            }
        }
        V::Time(neg, d, h, mi, s, us) => {
            let hours = d * 24 + *h as u32;
            let base = format!("{}{hours:02}:{mi:02}:{s:02}", if *neg { "-" } else { "" });
            Some(if *us > 0 { format!("{base}.{us:06}") } else { base })
        }
    }
}

/// Page a MySQL query by LIMIT/OFFSET. Wraps as a derived table (robust to a query's own
/// trailing `LIMIT`/`ORDER BY`/`UNION`); but MySQL forbids duplicate column names in a
/// derived table (error 1060), so on that error it falls back to appending LIMIT/OFFSET
/// directly — which streams duplicate output columns (e.g. `a JOIN b` sharing a column).
async fn mysql_page(
    pool: &mysql_async::Pool,
    base: &str,
    limit: u32,
    offset: usize,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), AppError> {
    let wrapped = format!("SELECT * FROM ({base}) AS _tusk LIMIT {limit} OFFSET {offset}");
    match mysql_run(pool, &wrapped).await {
        Ok((c, r, _)) => Ok((c, r)),
        Err(e) if e.message.contains("Duplicate column name") => {
            let appended = format!("{base} LIMIT {limit} OFFSET {offset}");
            let (c, r, _) = mysql_run(pool, &appended).await?;
            Ok((c, r))
        }
        Err(e) => Err(e),
    }
}

/// Run a MySQL query: returns (column names, text rows, affected-rows).
async fn mysql_run(
    pool: &mysql_async::Pool,
    sql: &str,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>, u64), AppError> {
    use mysql_async::prelude::Queryable;
    let mut conn = pool.get_conn().await.map_err(de)?;
    let mut result = conn.query_iter(sql).await.map_err(de)?;
    let columns: Vec<String> = result
        .columns()
        .map(|arc| arc.iter().map(|c| c.name_str().to_string()).collect())
        .unwrap_or_default();
    let affected = result.affected_rows();
    let raw: Vec<mysql_async::Row> = result.collect().await.map_err(de)?;
    let ncols = columns.len();
    let data: Vec<Vec<Option<String>>> = raw
        .iter()
        .map(|row| {
            (0..ncols)
                .map(|i| row.as_ref(i).and_then(mysql_value_to_string))
                .collect()
        })
        .collect();
    Ok((columns, data, affected))
}

async fn mysql_build_tree(pool: &mysql_async::Pool) -> Result<tree::DbTree, AppError> {
    const SYS: &str = "('mysql','information_schema','performance_schema','sys')";
    let (_c, schema_rows, _a) = mysql_run(
        pool,
        &format!(
            "SELECT schema_name FROM information_schema.schemata \
             WHERE schema_name NOT IN {SYS} ORDER BY schema_name"
        ),
    )
    .await?;
    let (_c2, table_rows, _a2) = mysql_run(
        pool,
        &format!(
            "SELECT table_schema, table_name, table_type FROM information_schema.tables \
             WHERE table_schema NOT IN {SYS} ORDER BY table_schema, table_name"
        ),
    )
    .await?;
    let (_c3, dbrow, _a3) = mysql_run(pool, "SELECT database()").await?;
    let database = dbrow
        .first()
        .and_then(|r| r.first().cloned().flatten())
        .unwrap_or_default();
    let mut schemas: Vec<tree::Schema> = schema_rows
        .iter()
        .map(|r| tree::Schema {
            name: dcell(r, 0),
            tables: vec![],
            views: vec![],
            sequences: vec![],
            functions: vec![],
        })
        .collect();
    attach_rels(&mut schemas, &table_rows);
    let databases = schemas.iter().map(|s| s.name.clone()).collect();
    Ok(tree::DbTree {
        database,
        databases,
        schemas,
    })
}

async fn mysql_table_detail(
    pool: &mysql_async::Pool,
    schema: &str,
    name: &str,
) -> Result<tree::RelationDetail, AppError> {
    let q = format!(
        "SELECT column_name, data_type, is_nullable, column_default, column_key \
         FROM information_schema.columns \
         WHERE table_schema = {} AND table_name = {} ORDER BY ordinal_position",
        dlit(schema),
        dlit(name)
    );
    let (_c, rows, _a) = mysql_run(pool, &q).await?;
    let columns = rows
        .iter()
        .map(|r| tree::Column {
            name: dcell(r, 0),
            data_type: dcell(r, 1),
            nullable: dcell(r, 2).eq_ignore_ascii_case("YES"),
            is_pk: dcell(r, 4) == "PRI",
            is_fk: false,
            default: r.get(3).and_then(|v| v.clone()),
            comment: None,
        })
        .collect();
    Ok(tree::RelationDetail {
        name: name.to_string(),
        kind: "table".to_string(),
        comment: None,
        columns,
        indexes: vec![],
        constraints: vec![],
        triggers: vec![],
    })
}

/// One connected database in the app registry.
pub struct ConnState {
    pub backend: Backend,
    pub read_only: bool,
}

// --- DuckDB helpers ---

fn duck_value_to_string(v: duckdb::types::Value) -> Option<String> {
    match v {
        duckdb::types::Value::Null => None,
        other => Some(duck_value_repr(other)),
    }
}

/// Split a `TimeUnit`-scaled count into (whole seconds, sub-second nanos), Euclidean so
/// negative timestamps (pre-1970) still floor correctly.
fn duck_time_parts(unit: duckdb::types::TimeUnit, v: i64) -> (i64, u32) {
    use duckdb::types::TimeUnit as U;
    let per_sec: i64 = match unit {
        U::Second => 1,
        U::Millisecond => 1_000,
        U::Microsecond => 1_000_000,
        U::Nanosecond => 1_000_000_000,
    };
    let scale = 1_000_000_000 / per_sec; // sub-unit → nanos
    (v.div_euclid(per_sec), (v.rem_euclid(per_sec) * scale) as u32)
}

/// `.123` style fractional-seconds suffix (micro precision, trailing zeros trimmed) —
/// matches DuckDB's VARCHAR rendering; empty when there's no sub-second part.
fn duck_frac(nanos: u32) -> String {
    let micros = nanos / 1000;
    if micros == 0 {
        return String::new();
    }
    format!(".{}", format!("{micros:06}").trim_end_matches('0'))
}

/// Render a non-NULL DuckDB value to text, matching `CAST(… AS VARCHAR)` for the common
/// scalar types so paths that don't cast (introspection / sample rows / a read that
/// wasn't routed through the cursor) don't leak Rust Debug like `Date32(19797)`.
fn duck_value_repr(v: duckdb::types::Value) -> String {
    use duckdb::types::Value as V;
    match v {
        V::Null => "NULL".to_string(),
        V::Boolean(b) => b.to_string(),
        V::TinyInt(n) => n.to_string(),
        V::SmallInt(n) => n.to_string(),
        V::Int(n) => n.to_string(),
        V::BigInt(n) => n.to_string(),
        V::HugeInt(n) => n.to_string(),
        V::UTinyInt(n) => n.to_string(),
        V::USmallInt(n) => n.to_string(),
        V::UInt(n) => n.to_string(),
        V::UBigInt(n) => n.to_string(),
        V::Float(n) => n.to_string(),
        V::Double(n) => n.to_string(),
        V::Decimal(d) => d.to_string(),
        V::Text(s) => s,
        V::Enum(s) => s,
        V::Blob(b) => String::from_utf8_lossy(&b).into_owned(),
        // DATE: days since the Unix epoch → YYYY-MM-DD.
        V::Date32(days) => chrono::DateTime::from_timestamp(days as i64 * 86_400, 0)
            .map(|dt| dt.format("%Y-%m-%d").to_string())
            .unwrap_or_else(|| days.to_string()),
        // TIMESTAMP (tz-naive): YYYY-MM-DD HH:MM:SS[.ffffff].
        V::Timestamp(unit, t) => {
            let (secs, nanos) = duck_time_parts(unit, t);
            chrono::DateTime::from_timestamp(secs, nanos)
                .map(|dt| format!("{}{}", dt.format("%Y-%m-%d %H:%M:%S"), duck_frac(nanos)))
                .unwrap_or_else(|| t.to_string())
        }
        // TIME: HH:MM:SS[.ffffff] (count is within a day).
        V::Time64(unit, t) => {
            let (secs, nanos) = duck_time_parts(unit, t);
            let s = secs.rem_euclid(86_400) as u32;
            format!("{:02}:{:02}:{:02}{}", s / 3600, (s % 3600) / 60, s % 60, duck_frac(nanos))
        }
        // INTERVAL: a readable "N years N months N days HH:MM:SS" (best-effort).
        V::Interval { months, days, nanos } => duck_interval(months, days, nanos),
        // Nested types — recurse so a list/array reads like `[a, b, c]`, a struct like
        // `{'k': v}` (close to DuckDB's VARCHAR form; readable rather than Debug).
        V::List(xs) | V::Array(xs) => {
            format!("[{}]", xs.into_iter().map(duck_value_repr).collect::<Vec<_>>().join(", "))
        }
        V::Struct(m) => {
            let body = m
                .iter()
                .map(|(k, val)| format!("'{k}': {}", duck_value_repr(val.clone())))
                .collect::<Vec<_>>()
                .join(", ");
            format!("{{{body}}}")
        }
        other => format!("{other:?}"),
    }
}

fn duck_interval(months: i32, days: i32, nanos: i64) -> String {
    let mut parts: Vec<String> = Vec::new();
    let (y, mo) = (months / 12, months % 12);
    let plural = |n: i32| if n.abs() == 1 { "" } else { "s" };
    if y != 0 {
        parts.push(format!("{y} year{}", plural(y)));
    }
    if mo != 0 {
        parts.push(format!("{mo} month{}", plural(mo)));
    }
    if days != 0 {
        parts.push(format!("{days} day{}", plural(days)));
    }
    let total_secs = nanos / 1_000_000_000;
    let sub = (nanos % 1_000_000_000) as u32;
    let s = total_secs.rem_euclid(86_400);
    if s != 0 || sub != 0 || parts.is_empty() {
        parts.push(format!("{:02}:{:02}:{:02}{}", s / 3600, (s % 3600) / 60, s % 60, duck_frac(sub)));
    }
    parts.join(" ")
}

fn duck_query(
    conn: &duckdb::Connection,
    sql: &str,
) -> Result<TextRows, AppError> {
    let mut stmt = conn.prepare(sql).map_err(de)?;
    // Column metadata is only valid AFTER the statement is executed (duckdb-rs panics
    // otherwise), so query first, then read names from the Rows' statement.
    let mut rows = stmt.query([]).map_err(de)?;
    let columns: Vec<String> = rows.as_ref().map(|s| s.column_names()).unwrap_or_default();
    let ncols = columns.len();
    let mut data: Vec<Vec<Option<String>>> = Vec::new();
    while let Some(row) = rows.next().map_err(de)? {
        let mut r = Vec::with_capacity(ncols);
        for i in 0..ncols {
            let v: duckdb::types::Value = row.get(i).map_err(de)?;
            r.push(duck_value_to_string(v));
        }
        data.push(r);
    }
    Ok((columns, data))
}

fn dcell(r: &[Option<String>], i: usize) -> String {
    r.get(i).and_then(|v| v.clone()).unwrap_or_default()
}

/// Attach `(schema, name, type)` rows to their schema in the tree. Uses a name→index
/// map so a wide catalog (hundreds of tables across many schemas) is O(rows + schemas),
/// not O(rows × schemas) — the previous `schemas.iter_mut().find(..)` per row. Shared by
/// the MySQL and DuckDB build paths (both feed `information_schema.tables`-shaped rows:
/// col 0 = schema, 1 = name, 2 = table_type where "VIEW" ⇒ view).
fn attach_rels(schemas: &mut [tree::Schema], table_rows: &[Vec<Option<String>>]) {
    let idx: std::collections::HashMap<String, usize> =
        schemas.iter().enumerate().map(|(i, s)| (s.name.clone(), i)).collect();
    for r in table_rows {
        let schema = dcell(r, 0);
        let Some(&i) = idx.get(&schema) else { continue };
        let is_view = dcell(r, 2).eq_ignore_ascii_case("VIEW");
        let stub = tree::RelStub {
            name: dcell(r, 1),
            kind: if is_view { "view" } else { "table" }.to_string(),
            comment: None,
            rows: None,
            size: None,
        };
        if is_view {
            schemas[i].views.push(stub);
        } else {
            schemas[i].tables.push(stub);
        }
    }
}

/// FK edges from duckdb_constraints(), trying the structured columns first
/// (newer libduckdb) and falling back to parsing constraint_text; any failure
/// yields an empty list (best-effort contract — never an error).
fn duck_fk_edges(conn: &duckdb::Connection) -> Vec<relgraph::FkEdge> {
    if let Ok((_c, rows)) = duck_query(conn, relgraph::DUCK_FK_STRUCTURED) {
        return relgraph::duck_edges(&rows, true);
    }
    if let Ok((_c, rows)) = duck_query(conn, relgraph::DUCK_FK_TEXT) {
        return relgraph::duck_edges(&rows, false);
    }
    Vec::new()
}

fn dlit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn duck_build_tree(conn: &duckdb::Connection) -> Result<tree::DbTree, AppError> {
    let database = conn
        .query_row("SELECT current_database()", [], |r| r.get::<_, String>(0))
        .unwrap_or_default();
    let (_c, schema_rows) = duck_query(
        conn,
        // DuckDB's information_schema spans every ATTACHED catalog (memory/system/temp),
        // each of which has its own `main` schema — filter to the current database or the
        // sidebar shows `main` (and any user schema) once per catalog.
        "SELECT schema_name FROM information_schema.schemata \
         WHERE catalog_name = current_database() \
         AND schema_name NOT IN ('information_schema','pg_catalog') ORDER BY schema_name",
    )?;
    let (_c2, table_rows) = duck_query(
        conn,
        "SELECT table_schema, table_name, table_type FROM information_schema.tables \
         WHERE table_catalog = current_database() \
         AND table_schema NOT IN ('information_schema','pg_catalog') \
         ORDER BY table_schema, table_name",
    )?;
    let mut schemas: Vec<tree::Schema> = schema_rows
        .iter()
        .map(|r| tree::Schema {
            name: dcell(r, 0),
            tables: vec![],
            views: vec![],
            sequences: vec![],
            functions: vec![],
        })
        .collect();
    attach_rels(&mut schemas, &table_rows);
    Ok(tree::DbTree {
        database: database.clone(),
        databases: vec![database],
        schemas,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::QueryOutcome;

    fn mem(driver: &str) -> ConnectionConfig {
        ConnectionConfig {
            driver: Some(driver.to_string()),
            host: String::new(),
            port: 0,
            user: String::new(),
            password: String::new(),
            dbname: String::new(),
            sslmode: None,
            read_only: false,
            path: Some(":memory:".to_string()),
        }
    }
    fn duck_mem() -> ConnectionConfig {
        mem("duckdb")
    }

    /// FROM-first / PIVOT forms must stream through the LIMIT/OFFSET pager like any
    /// SELECT (they classify as cursorable in lib.rs): the subquery wrap must accept
    /// them, and the non-cursorable path would buffer entire tables in RAM.
    #[tokio::test]
    async fn duck_from_first_and_pivot_stream() {
        let (mut b, _) = connect(&duck_mem()).await.unwrap();
        b.run_single("CREATE TABLE t(a INT, k TEXT)", 1, false).await.unwrap();
        b.run_single("INSERT INTO t VALUES (1,'x'),(2,'y'),(3,'x')", 1, false).await.unwrap();
        match b.run_single("FROM t", 2, true).await.unwrap() {
            QueryOutcome::Rows { rows, done, .. } => {
                assert_eq!(rows.len(), 2);
                assert!(!done);
            }
            _ => panic!("expected rows from FROM-first"),
        }
        b.rollback_cursor().await;
        match b.run_single("PIVOT t ON k USING sum(a)", 10, true).await.unwrap() {
            QueryOutcome::Rows { rows, .. } => assert_eq!(rows.len(), 1),
            _ => panic!("expected rows from PIVOT"),
        }
    }

    /// duckdb-rs #209: a parser error poisons the connection ("resource deadlock
    /// would occur" on every later statement) and dropping the poisoned connection
    /// aborts the whole process via a foreign C++ exception. The parse gate must
    /// absorb the parse error so (a) it surfaces as a normal Err, (b) the connection
    /// keeps working afterwards, and (c) dropping the backend doesn't abort the test
    /// process — this test completing IS the drop assertion.
    #[tokio::test]
    async fn duck_syntax_error_survivable() {
        let (mut b, _) = connect(&duck_mem()).await.unwrap();
        b.run_single("CREATE TABLE t(a INT)", 1, false).await.unwrap();
        b.run_single("INSERT INTO t VALUES (1),(2)", 1, false).await.unwrap();

        // comment-eaten comma → NOT IN (1 2) → parser error
        let bad = "SELECT * FROM t WHERE a NOT IN (\n  1 -- one,\n  2 -- two\n)";
        let e = b.run_single(bad, 100, true).await.unwrap_err();
        assert!(e.message.contains("Parser Error"), "want parser error, got: {}", e.message);
        assert!(!e.message.contains("deadlock"), "poisoned connection leaked through: {}", e.message);

        // connection still works after the syntax error
        match b.run_single("SELECT a FROM t ORDER BY a", 100, true).await.unwrap() {
            QueryOutcome::Rows { rows, .. } => assert_eq!(rows.len(), 2),
            _ => panic!("expected rows"),
        }

        // repeat: bad DDL (execute_batch path), bad script path, then a good query
        let e2 = b.run_single("CREATE TABLEX u(a INT)", 1, false).await.unwrap_err();
        assert!(e2.message.contains("Parser Error"), "got: {}", e2.message);
        let items = script::split("INSERT INTO t VALUES (3);\nSELCT * FROM t;");
        let e3 = b.run_script(&items, false).await.unwrap_err();
        assert!(e3.message.contains("Parser Error"), "got: {}", e3.message);
        // the script's leading INSERT must not have executed (gated before the batch ran)
        match b.run_single("SELECT count(*) FROM t", 100, true).await.unwrap() {
            QueryOutcome::Rows { rows, .. } => assert_eq!(rows[0][0].as_deref(), Some("2")),
            _ => panic!("expected rows"),
        }

        // binder errors (valid parse, missing table) still come from the real catalog
        let e4 = b.run_single("SELECT * FROM no_such_table", 100, true).await.unwrap_err();
        assert!(e4.message.contains("no_such_table"), "got: {}", e4.message);

        // bool_columns on unparseable SQL degrades to empty, doesn't poison
        assert!(b.bool_columns("SELCT 1").await.is_empty());
        match b.run_single("SELECT a FROM t ORDER BY a", 100, true).await.unwrap() {
            QueryOutcome::Rows { rows, .. } => assert_eq!(rows.len(), 2),
            _ => panic!("expected rows"),
        }
        // implicit: dropping `b` here must not abort the process
    }

    /// A file-backed DuckDB connection must drop (free its exclusive file lock) when idle,
    /// reopen lazily, and not lose written data across the release.
    #[tokio::test]
    async fn duckdb_releases_file_lock_when_idle() {
        let path = std::env::temp_dir().join(format!("tusk_idle_{}.duckdb", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut cfg = duck_mem();
        cfg.path = Some(path.to_string_lossy().into_owned());

        let (mut b, _) = connect(&cfg).await.unwrap();
        b.run_single("CREATE TABLE t(a INT)", 1, false).await.unwrap();
        b.run_single("INSERT INTO t VALUES (42)", 1, false).await.unwrap();
        assert!(!b.is_closed(), "open while in use");

        // A command finishing with nothing streaming releases the connection → lock freed.
        b.release_idle();
        assert!(b.is_closed(), "released when idle");

        // The same file can now be opened by a fresh connection (the lock is gone).
        let (b2, _) = connect(&cfg).await.expect("file lock freed after release_idle");
        drop(b2); // DuckDB is single-writer — free it before reopening b.

        // Reopen the original; the data written before the release must still be there.
        b.reopen().await.unwrap();
        match b.run_single("SELECT a FROM t", 10, true).await.unwrap() {
            QueryOutcome::Rows { rows, .. } => {
                assert_eq!(rows.len(), 1);
                assert_eq!(rows[0][0].as_deref(), Some("42"));
            }
            _ => panic!("expected rows"),
        }
        let _ = std::fs::remove_file(&path);
    }

    /// DuckDB temporal/decimal values must render like `CAST(… AS VARCHAR)` on the raw
    /// (non-cast) path — not Rust Debug like `Date32(19797)`. Covers every path that uses
    /// `duck_value_to_string` (introspection / sample rows / a non-cursorable read).
    #[test]
    fn duck_renders_temporal_types_like_varchar() {
        let conn = duckdb::Connection::open_in_memory().unwrap();
        let sel = "SELECT DATE '2024-03-15' AS d, \
                   TIMESTAMP '2024-03-15 10:30:45.123' AS ts, \
                   TIME '10:30:45.5' AS tm, \
                   CAST(3.14 AS DECIMAL(10,2)) AS dec, \
                   CAST(123456789012345678 AS HUGEINT) AS hug, \
                   DATE '2024-01-01' AS d2";
        // `duck_query` runs values through `duck_value_to_string`.
        let (_c, raw) = duck_query(&conn, sel).unwrap();
        // VARCHAR cast is the authoritative rendering.
        let (_c2, cast) = duck_query(&conn, &format!("SELECT CAST(COLUMNS(*) AS VARCHAR) FROM ({sel}) _t")).unwrap();
        assert_eq!(raw[0], cast[0], "formatter must match the VARCHAR cast");
        assert_eq!(raw[0][0].as_deref(), Some("2024-03-15"), "DATE renders ISO, not Date32(..)");
        assert!(
            !raw[0].iter().flatten().any(|s| s.contains("Date32") || s.contains("Timestamp(") || s.contains("Time64")),
            "no Rust Debug leaks: {:?}",
            raw[0]
        );
    }

    /// A `:memory:` DuckDB must NOT be released on idle — closing it would lose all data.
    #[tokio::test]
    async fn duckdb_memory_stays_open_when_idle() {
        let (b, _) = connect(&duck_mem()).await.unwrap();
        b.release_idle();
        assert!(!b.is_closed(), ":memory: must stay open across idle (closing loses data)");
    }

    #[test]
    fn sqlite_query_page_introspect() {
        let (backend, ver) = SqliteConn::open(&mem("sqlite")).unwrap();
        assert!(ver.starts_with("SQLite"));
        let mut s = match backend {
            Backend::Sqlite(s) => s,
            _ => panic!("expected SQLite backend"),
        };
        s.lock()
            .execute_batch(
                "CREATE TABLE t(a INTEGER, b TEXT); \
                 INSERT INTO t VALUES (1,'x'),(2,'y'),(3,NULL)",
            )
            .unwrap();

        let p1 = s.run_single("SELECT * FROM t ORDER BY a", 2, true).unwrap();
        let (cols, mut all, done1) = match p1 {
            QueryOutcome::Rows { columns, rows, done, .. } => (columns, rows, done),
            _ => panic!("expected rows"),
        };
        assert_eq!(cols, vec!["a", "b"]);
        assert_eq!(all.len(), 2);
        assert!(!done1);
        let p2 = s.fetch_page(2).unwrap();
        assert_eq!(p2.rows.len(), 1);
        assert!(p2.done);
        all.extend(p2.rows);
        assert!(all.iter().any(|r| r[0] == Some("1".to_string()) && r[1] == Some("x".to_string())));
        assert!(all.iter().any(|r| r[0] == Some("3".to_string()) && r[1].is_none()));

        let tree = sqlite_build_tree(&s.lock()).unwrap();
        assert!(tree.schemas[0].tables.iter().any(|t| t.name == "t"));
        let det = sqlite_table_detail(&s.lock(), "t").unwrap();
        assert_eq!(det.columns.len(), 2);
        assert_eq!(det.columns[0].name, "a");
        let list = sqlite_list_tables(&s.lock()).unwrap();
        assert!(list.iter().any(|t| t.name == "t" && t.columns.len() == 2));
    }

    /// The bundled libduckdb ships ICU installed-but-not-loaded, so
    /// `CAST(TIMESTAMPTZ AS DATE)` fails without explicitly loading the extension.
    /// `open_conn` now runs `LOAD icu` — verify the cast works through the full
    /// `run_single` path (what the app actually uses), and survives the
    /// release/reopen cycle (file-backed DuckDB drops the connection when idle).
    #[tokio::test]
    async fn duckdb_timestamptz_cast_after_icu_load() {
        let path = std::env::temp_dir().join(format!("tusk_icu_{}.duckdb", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut cfg = duck_mem();
        cfg.path = Some(path.to_string_lossy().into_owned());

        let (mut b, _) = connect(&cfg).await.unwrap();
        b.run_single(
            "CREATE TABLE inventory_action (id INT, item_id INT, created_at TIMESTAMPTZ, \
             qty_delta INT, cost_delta INT, location_key VARCHAR, type VARCHAR)",
            1, false,
        ).await.unwrap();
        b.run_single(
            "INSERT INTO inventory_action VALUES (1, 1, now(), 5, 10, 'MAIN', 'PURCHASE')",
            1, false,
        ).await.unwrap();

        let q = "SELECT CAST(ia.created_at AS DATE) AS action_date FROM inventory_action ia";
        // The point is that the TIMESTAMPTZ→DATE cast SUCCEEDS (ICU loaded) — assert a
        // YYYY-MM-DD shape, never a literal date (a hardcoded date is a time bomb).
        let is_date = |v: Option<&str>| {
            let s = v.expect("non-null date");
            s.len() == 10 && s.as_bytes()[4] == b'-' && s.as_bytes()[7] == b'-'
        };

        // Works on first connect (open_conn loads ICU).
        match b.run_single(q, 50, true).await.unwrap() {
            QueryOutcome::Rows { rows, .. } => {
                assert_eq!(rows.len(), 1);
                assert!(is_date(rows[0][0].as_deref()));
            }
            _ => panic!("expected rows"),
        }

        // Release + reopen (simulates idle lock release) — ICU must re-load.
        b.release_idle();
        b.reopen().await.unwrap();
        match b.run_single(q, 50, true).await.unwrap() {
            QueryOutcome::Rows { rows, .. } => {
                assert_eq!(rows.len(), 1);
                assert!(is_date(rows[0][0].as_deref()));
            }
            _ => panic!("expected rows after reopen"),
        }

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn duckdb_query_page_introspect() {
        let (backend, _v) = DuckConn::open(&duck_mem()).unwrap();
        let mut d = match backend {
            Backend::Duck(d) => d,
            _ => panic!("expected DuckDB backend"),
        };
        d.lock()
            .execute_batch(
                "CREATE TABLE t(a INTEGER, b VARCHAR); \
                 INSERT INTO t VALUES (1,'x'),(2,'y'),(3,NULL)",
            )
            .unwrap();

        // Page 1 of 2 over 3 rows: every value is text (COLUMNS(*) cast), not done.
        let p1 = d.run_single("SELECT * FROM t ORDER BY a", 2, true).unwrap();
        let (cols, mut all, done1) = match p1 {
            QueryOutcome::Rows { columns, rows, done, .. } => (columns, rows, done),
            _ => panic!("expected rows"),
        };
        assert_eq!(cols, vec!["a", "b"]);
        assert_eq!(all.len(), 2);
        assert!(!done1);
        // Page 2: the remaining row, done.
        let p2 = d.fetch_page(2).unwrap();
        assert_eq!(p2.rows.len(), 1);
        assert!(p2.done);
        all.extend(p2.rows);
        assert_eq!(all.len(), 3);
        // Values are text; NULL is None.
        assert!(all.iter().any(|r| r[0] == Some("1".to_string()) && r[1] == Some("x".to_string())));
        assert!(all.iter().any(|r| r[0] == Some("3".to_string()) && r[1].is_none()));

        // Introspection: the table shows up; detail has 2 columns.
        let tree = duck_build_tree(&d.lock()).unwrap();
        assert!(tree
            .schemas
            .iter()
            .any(|s| s.tables.iter().any(|t| t.name == "t")));
        let det = duck_table_detail(&d.lock(), "main", "t").unwrap();
        assert_eq!(det.columns.len(), 2);
        assert_eq!(det.columns[0].name, "a");
    }
}

#[allow(clippy::items_after_test_module)]
fn duck_table_detail(
    conn: &duckdb::Connection,
    schema: &str,
    name: &str,
) -> Result<tree::RelationDetail, AppError> {
    let q = format!(
        "SELECT column_name, data_type, is_nullable, column_default \
         FROM information_schema.columns \
         WHERE table_schema = {} AND table_name = {} ORDER BY ordinal_position",
        dlit(schema),
        dlit(name)
    );
    let (_c, rows) = duck_query(conn, &q)?;
    // PK flags via pragma_table_info (information_schema carries no key info);
    // best-effort — feeds the in-grid editor's PK requirement.
    let pk: std::collections::HashSet<String> = duck_query(
        conn,
        &format!(
            "SELECT name FROM pragma_table_info({}) WHERE pk",
            dlit(&format!("{schema}.{name}"))
        ),
    )
    .map(|(_c, rs)| rs.iter().map(|r| dcell(r, 0)).collect())
    .unwrap_or_default();
    let columns = rows
        .iter()
        .map(|r| {
            let nm = dcell(r, 0);
            tree::Column {
                is_pk: pk.contains(&nm),
                name: nm,
                data_type: dcell(r, 1),
                nullable: dcell(r, 2).eq_ignore_ascii_case("YES"),
                is_fk: false,
                default: r.get(3).and_then(|v| v.clone()),
                comment: None,
            }
        })
        .collect();
    Ok(tree::RelationDetail {
        name: name.to_string(),
        kind: "table".to_string(),
        comment: None,
        columns,
        indexes: vec![],
        constraints: vec![],
        triggers: vec![],
    })
}
