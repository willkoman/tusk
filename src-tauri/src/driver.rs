//! Driver abstraction. A `Backend` is one connected database — Postgres (network) or
//! DuckDB (embedded), with more to follow. The connection-level surface the app needs —
//! query / exec / streaming page / cancel / search-path / introspection — is abstracted
//! here so a new driver is a new enum arm. PG-specific DDL reconstruction, export
//! streaming, server-lint, and import still reach the raw client via `Backend::pg()`
//! (errors on non-PG drivers) until each is abstracted per driver.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tokio_postgres::{CancelToken, Client, SimpleQueryMessage};

use crate::db::{
    self, AppError, ConnectionConfig, FetchResult, QueryOutcome, TransactionHealth,
    TransactionMode, TransactionState, TransactionStatus,
};
use crate::relgraph;
use crate::script;
use crate::tree;

type TextRows = (Vec<String>, Vec<Vec<Option<String>>>);

fn de<E: std::fmt::Display>(e: E) -> AppError {
    AppError::new(e.to_string())
}

/// Reversible text-protocol representation for binary cells. Matches PostgreSQL's
/// bytea hex output, so all drivers expose one explicit convention.
fn binary_text(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(2usize.saturating_add(bytes.len().saturating_mul(2)));
    out.push_str("\\x");
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Shared embedded-driver script runner: joins the SQL items and executes them
/// inside an explicit BEGIN…COMMIT (best-effort ROLLBACK on error).
fn embedded_script<C>(
    conn: &C,
    items: &[script::Item],
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
    /// The engine has a server-side bulk-copy protocol (PostgreSQL `COPY`). File import
    /// works on every engine regardless — this only says which loader path is used.
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
    /// An in-flight query can be cancelled out-of-band. PostgreSQL: CancelRequest.
    /// DuckDB: interrupt handle, except Windows where interrupt poisons the bundled
    /// connection. SQLite/MySQL expose no UI-query cancel handle.
    pub cancel_query: bool,
    pub manual_transactions: bool,
    pub transaction_savepoints: bool,
    pub set_transaction: bool,
    pub autocommit_mode: bool,
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
            cancel_query: true,
            manual_transactions: true,
            transaction_savepoints: true,
            set_transaction: true,
            autocommit_mode: false,
        }
    }
    pub fn duckdb() -> Self {
        Self {
            kind: "duckdb",
            server_cursor: false, // paged via LIMIT/OFFSET, not a server cursor
            bulk_copy: false,
            export: true, // paged export (export::run_export_paged)
            schemas: true,
            search_path: false,
            transactional_ddl: true,
            tls: false,
            keychain: false,
            permissions: false,
            ddl: true,           // best-effort via duckdb_tables()/duckdb_views()
            relationships: true, // best-effort via duckdb_constraints()
            explain_analyze: true,
            cancel_query: !cfg!(windows), // interrupt() poisons the bundled connection on Windows
            manual_transactions: true,
            transaction_savepoints: false,
            set_transaction: false,
            autocommit_mode: false,
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
            ddl: true,              // sqlite_master.sql
            relationships: true,    // pragma_foreign_key_list
            explain_analyze: false, // no EXPLAIN ANALYZE in SQLite
            cancel_query: false,    // no out-of-band cancel handle
            manual_transactions: true,
            transaction_savepoints: true,
            set_transaction: false,
            autocommit_mode: false,
        }
    }
    pub fn mssql() -> Self {
        Self {
            kind: "mssql",
            server_cursor: false, // paged via OFFSET/FETCH, not a server cursor
            bulk_copy: false,
            export: true, // paged export (not snapshot-consistent under writes)
            schemas: true,
            search_path: false, // T-SQL resolves through the login's default schema
            transactional_ddl: true,
            tls: true,
            keychain: true,
            permissions: false,
            ddl: true,           // reconstructed from sys.* / sys.sql_modules
            relationships: true, // sys.foreign_keys
            // T-SQL has no EXPLAIN; plans come from SHOWPLAN, which Tusk cannot render.
            explain_analyze: false,
            cancel_query: false, // tiberius exposes no out-of-band attention signal
            manual_transactions: true,
            transaction_savepoints: true, // SAVE TRANSACTION (no RELEASE)
            set_transaction: false,       // SET TRANSACTION ISOLATION LEVEL is session-wide
            autocommit_mode: false,
        }
    }
    pub fn mysql() -> Self {
        Self {
            kind: "mysql",
            server_cursor: false,
            bulk_copy: false,
            export: true,       // paged export (not snapshot-consistent under writes)
            schemas: true,      // databases-as-schemas
            search_path: false, // MySQL uses `USE db`, not search_path
            transactional_ddl: false, // MySQL DDL auto-commits
            tls: true,
            keychain: false,
            permissions: false,
            ddl: true,           // SHOW CREATE TABLE/VIEW
            relationships: true, // information_schema.KEY_COLUMN_USAGE
            explain_analyze: true,
            cancel_query: false, // no out-of-band cancel handle
            manual_transactions: true,
            transaction_savepoints: true,
            set_transaction: true,
            autocommit_mode: true,
        }
    }
}

/// A query-cancel handle usable without holding the connection lock. PG = libpq cancel
/// protocol (own short connection); DuckDB = an interrupt handle on the live connection.
#[derive(Clone)]
pub enum CancelHandle {
    Pg(CancelToken),
    Duck(Arc<duckdb::InterruptHandle>),
    /// A cooperative flag polled by a batched operation between units of work (bulk
    /// import). Works on every engine, including the ones with no out-of-band cancel,
    /// because each statement the operation issues is small and bounded.
    Flag(Arc<std::sync::atomic::AtomicBool>),
    /// No out-of-band cancel (e.g. SQLite) — queries are local and short.
    None,
}

impl CancelHandle {
    pub async fn cancel(self, cfg: &ConnectionConfig) -> Result<(), AppError> {
        match self {
            CancelHandle::Flag(flag) => {
                flag.store(true, Ordering::Release);
                Ok(())
            }
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
    /// The configuration the USER supplied — the real database host/port and any SSH
    /// settings. Dialling goes through `ssh::dial_config`, so everything else
    /// (Slack isolation, connection display, cancel TLS) keeps seeing the true target.
    pub config: ConnectionConfig,
    /// Kept alive for the lifetime of the connection: dropping it closes the SSH
    /// session and its loopback listener.
    tunnel: Option<crate::ssh::Tunnel>,
    cursor_name: Option<String>,
    cursor_auto_transaction: bool,
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
    /// Each parser poison must be leaked because DuckDB aborts while dropping it.
    /// Bound repeated bad-input leaks; restart resets the budget.
    gate_poison_leaks: AtomicUsize,
}

const MAX_DUCK_GATE_POISON_LEAKS: usize = 16;

/// Deref'able lock guard so every existing `d.lock()` call site is unchanged: it borrows
/// the live `Connection` out of the `Option`. The connection is guaranteed present at any
/// call site — `ensure_alive`/`connect` open it before backend methods run.
pub(crate) struct DuckGuard<'a>(std::sync::MutexGuard<'a, Option<duckdb::Connection>>);
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
    pub(crate) fn lock(&self) -> DuckGuard<'_> {
        DuckGuard(self.conn.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// Whether the connection is currently open (a file lock is held).
    fn is_open(&self) -> bool {
        self.conn
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
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
    fn release_idle(&self, manual_session: bool) {
        if !manual_session && !self.keep_open && self.stream_sql.is_none() {
            let taken = self.conn.lock().unwrap_or_else(|e| e.into_inner()).take();
            if let Some(c) = taken {
                if forget_if_poisoned(c) {
                    self.gate_poison_leaks.fetch_add(1, Ordering::Relaxed);
                }
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
        let poisoned = g.as_ref().is_some_and(|c| {
            c.prepare("SELECT 1")
                .is_err_and(|error| duck_error_is_poison(&error))
        });
        if !poisoned {
            return None;
        }
        if let Some(c) = g.take() {
            std::mem::forget(c);
            self.gate_poison_leaks.fetch_add(1, Ordering::Relaxed);
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
    pub(crate) fn quarantine_if_poisoned(&self, err: AppError) -> AppError {
        match self.quarantine_poisoned() {
            Some(hint) => AppError::new(format!(
                "{} — DuckDB left the connection unusable; {hint}",
                err.message
            )),
            None => err,
        }
    }

    fn manual_transaction_aborted(&self) -> bool {
        self.conn
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .is_some_and(|conn| {
                conn.prepare("SELECT 1").is_err_and(|error| {
                    !duck_error_is_poison(&error)
                        && error
                            .to_string()
                            .to_ascii_lowercase()
                            .contains("current transaction is aborted")
                })
            })
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
    pub(crate) fn parse_check(&self, sql: &str) -> Result<(), AppError> {
        if self.gate_poison_leaks.load(Ordering::Relaxed) >= MAX_DUCK_GATE_POISON_LEAKS {
            return Err(AppError::new(
                "DuckDB parser safety budget exhausted after repeated parser failures — restart Tusk before running more SQL",
            ));
        }
        let mut g = self.gate.lock().unwrap_or_else(|e| e.into_inner());
        let conn = match g.take() {
            Some(c) => c,
            None => duckdb::Connection::open_in_memory().map_err(de)?,
        };
        let err = conn.prepare(sql).err();
        match err {
            None => {
                *g = Some(conn);
                Ok(())
            }
            Some(e) => {
                let poisoned = conn.prepare("SELECT 1").is_err();
                if poisoned {
                    self.gate_poison_leaks.fetch_add(1, Ordering::Relaxed);
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
fn forget_if_poisoned(conn: duckdb::Connection) -> bool {
    if conn
        .prepare("SELECT 1")
        .is_err_and(|error| duck_error_is_poison(&error))
    {
        std::mem::forget(conn);
        true
    } else {
        false
    }
}

fn duck_error_is_poison(error: &duckdb::Error) -> bool {
    // A normal statement error aborts a DuckDB manual transaction. Until ROLLBACK,
    // every probe reports this state; it is recoverable and must not be confused with
    // the libduckdb parser/interrupt poison that requires leaking the handle.
    !error
        .to_string()
        .to_ascii_lowercase()
        .contains("current transaction is aborted")
}

impl Drop for DuckConn {
    fn drop(&mut self) {
        for m in [&self.conn, &self.gate] {
            let taken = m.lock().unwrap_or_else(|e| e.into_inner()).take();
            if let Some(c) = taken {
                let _ = forget_if_poisoned(c);
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
    pub(crate) fn lock(&self) -> std::sync::MutexGuard<'_, rusqlite::Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// One connected database, dispatched by driver.
pub enum Backend {
    Pg(PgConn),
    Duck(DuckConn),
    Sqlite(SqliteConn),
    MySql(MySqlConn),
    // Boxed: the tiberius client is far larger than the other connection structs.
    MsSql(Box<MsSqlConn>),
}

/// Open a connection for the configured driver. PG = network (TLS); DuckDB = a local
/// file (or `:memory:`), opened read-only when the connection is read-only.
pub async fn connect(config: &ConnectionConfig) -> Result<(Backend, String), AppError> {
    config.validate()?;
    match config.driver.as_deref().unwrap_or("postgres") {
        "postgres" => {
            // The tunnel comes up first so a failure names the SSH stage, not the DB.
            let tunnel = crate::ssh::ensure(None, config).await?;
            // Through a tunnel the socket is loopback but the TLS peer is still the
            // real server, so `verify-full` must check the configured hostname.
            let tls_host = crate::ssh::tls_host(config, tunnel.as_ref());
            let (client, version) = db::open_with_tls_host(
                &crate::ssh::dial_config(config, tunnel.as_ref()),
                tls_host.as_deref(),
            )
            .await
            .map_err(|e| crate::ssh::explain_db_failure(tunnel.as_ref(), e))?;
            Ok((
                Backend::Pg(PgConn {
                    client,
                    config: config.clone(),
                    tunnel,
                    cursor_name: None,
                    cursor_auto_transaction: false,
                }),
                version,
            ))
        }
        "duckdb" => DuckConn::open(config),
        "sqlite" => SqliteConn::open(config),
        "mysql" => MySqlConn::open(config, None).await,
        "mssql" => MsSqlConn::open(config, None).await,
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
            Backend::MsSql(_) => Capabilities::mssql(),
        }
    }

    pub fn config(&self) -> &ConnectionConfig {
        match self {
            Backend::Pg(p) => &p.config,
            Backend::Duck(d) => &d.config,
            Backend::Sqlite(s) => &s.config,
            Backend::MySql(m) => &m.config,
            Backend::MsSql(m) => &m.config,
        }
    }

    pub fn is_closed(&self) -> bool {
        match self {
            Backend::Pg(p) => p.client.is_closed(),
            // DuckDB reports "closed" once it's been released while idle, so `ensure_alive`
            // re-opens it (and its file lock) lazily on the next command.
            Backend::Duck(d) => !d.is_open(),
            Backend::MySql(m) => m.manual_lost,
            // tiberius exposes no liveness probe; the driver latches transport failures.
            Backend::MsSql(m) => m.is_dead(),
            Backend::Sqlite(_) => false,
        }
    }

    /// True when a tracked manual session no longer has a physical transaction to own.
    /// Callers must only use this while `TransactionStatus::owns_session()` is true.
    pub fn manual_session_ended(&self) -> bool {
        match self {
            Backend::Pg(pg) => pg.client.is_closed(),
            Backend::Duck(duck) => duck
                .conn
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_none(),
            Backend::Sqlite(sqlite) => sqlite.lock().is_autocommit(),
            Backend::MySql(mysql) => mysql.manual_lost,
            Backend::MsSql(mssql) => mssql.manual_lost || mssql.is_dead(),
        }
    }

    /// After a command finishes, drop an embedded connection that doesn't need to stay
    /// open so it doesn't hold a file lock while idle. Currently only file-backed DuckDB
    /// (SQLite takes no exclusive idle lock; PG/MySQL are network). Re-opened by
    /// `ensure_alive` on the next command.
    pub fn release_idle(&self, manual_session: bool) {
        if let Backend::Duck(d) = self {
            d.release_idle(manual_session);
        }
    }

    pub fn cursor_open(&self) -> bool {
        match self {
            Backend::Pg(p) => p.cursor_name.is_some(),
            Backend::Duck(d) => d.stream_sql.is_some(),
            Backend::Sqlite(s) => s.stream_sql.is_some(),
            Backend::MySql(m) => m.stream_sql.is_some(),
            Backend::MsSql(m) => m.stream_sql.is_some(),
        }
    }

    #[cfg(test)]
    pub fn mysql_manual_session_pinned(&self) -> bool {
        matches!(self, Backend::MySql(mysql) if mysql.pinned.is_some())
    }

    pub fn manual_errors_require_recovery(&self) -> bool {
        match self {
            Backend::Pg(_) => true,
            Backend::Duck(duck) => duck.manual_transaction_aborted(),
            // SQL Server dooms a transaction only for some errors; the driver records
            // XACT_STATE() = -1 when it observes one (probing here would need async).
            Backend::MsSql(mssql) => mssql.doomed,
            _ => false,
        }
    }

    /// The script/transaction dialect of this backend.
    pub fn engine(&self) -> script::TransactionEngine {
        match self {
            Backend::Pg(_) => script::TransactionEngine::Postgres,
            Backend::Duck(_) => script::TransactionEngine::DuckDb,
            Backend::Sqlite(_) => script::TransactionEngine::Sqlite,
            Backend::MySql(_) => script::TransactionEngine::MySql,
            Backend::MsSql(_) => script::TransactionEngine::MsSql,
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
    /// Tunnelled connections re-verify the SSH session first: a live tunnel is reused,
    /// a dead one is rebuilt on a fresh loopback port, and a tunnel that cannot be
    /// rebuilt fails the reconnect rather than dialling a port that is no longer ours.
    pub async fn reopen(&mut self) -> Result<(), AppError> {
        match self {
            Backend::Pg(p) => {
                p.tunnel = crate::ssh::ensure(p.tunnel.take(), &p.config).await?;
                let tls_host = crate::ssh::tls_host(&p.config, p.tunnel.as_ref());
                let (client, _version) = db::open_with_tls_host(
                    &crate::ssh::dial_config(&p.config, p.tunnel.as_ref()),
                    tls_host.as_deref(),
                )
                .await
                .map_err(|e| crate::ssh::explain_db_failure(p.tunnel.as_ref(), e))?;
                p.client = client;
                p.cursor_name = None;
                p.cursor_auto_transaction = false;
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
                // Hand the live tunnel to the replacement pool so the reconnect keeps
                // the same SSH session (and so `*m = nm` cannot drop it mid-flight).
                let tunnel = crate::ssh::ensure(m.tunnel.take(), &m.config).await?;
                let (backend, _v) = MySqlConn::open(&m.config, tunnel).await?;
                if let Backend::MySql(nm) = backend {
                    *m = nm;
                }
                Ok(())
            }
            Backend::MsSql(m) => {
                // Same as MySQL: keep the SSH session across the reconnect.
                let tunnel = crate::ssh::ensure(m.tunnel.take(), &m.config).await?;
                let (backend, _v) = MsSqlConn::open(&m.config, tunnel).await?;
                if let Backend::MsSql(nm) = backend {
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

    /// Pin one physical session for a long single-threaded run (restore).
    ///
    /// Only MySQL needs it: every other backend already owns exactly one connection,
    /// while MySQL checks one out of the pool per statement and the pool RESETS a
    /// connection when it is returned. Session state a dump sets up for its own replay
    /// — `SET FOREIGN_KEY_CHECKS = 0` most obviously — therefore applied to nothing at
    /// all, and could equally have leaked into a later user query had the reset not
    /// happened. Callers MUST pair this with `end_bulk_session`.
    pub async fn begin_bulk_session(&mut self) -> Result<(), AppError> {
        match self {
            Backend::MySql(m) => m.begin_bulk().await,
            _ => Ok(()),
        }
    }

    /// Release the pinned session, returning the connection (and its session state) to
    /// the pool. Infallible by design: it runs on every restore exit path.
    pub async fn end_bulk_session(&mut self) {
        if let Backend::MySql(m) = self {
            m.end_bulk().await;
        }
    }

    /// Roll back + drop any open streaming cursor/transaction. PostgreSQL issues
    /// ROLLBACK only when cursor state is tracked — an idle autocommit session has
    /// nothing to roll back, and doing it anyway costs a round trip plus a server
    /// `WARNING: there is no transaction in progress` on every metadata command.
    pub async fn rollback_cursor(&mut self) {
        match self {
            Backend::Pg(p) => {
                if p.cursor_name.is_some() || p.cursor_auto_transaction {
                    let _ = p.client.batch_execute("ROLLBACK").await;
                }
                p.cursor_name = None;
                p.cursor_auto_transaction = false;
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
            Backend::MsSql(m) => m.reset_stream(),
        }
    }

    /// Close an existing result stream without ending a user-owned transaction.
    pub async fn close_stream(&mut self, manual_transaction: bool) -> Result<(), AppError> {
        match self {
            Backend::Pg(p) if p.cursor_name.is_some() && manual_transaction => {
                let name = p.cursor_name.take().expect("checked above");
                p.cursor_auto_transaction = false;
                p.client
                    .batch_execute(&format!("CLOSE {}", db::ident(&name)))
                    .await
                    .map_err(Into::into)
            }
            Backend::Pg(p) if p.cursor_name.is_some() => {
                let result = p.client.batch_execute("ROLLBACK").await;
                p.cursor_name = None;
                p.cursor_auto_transaction = false;
                result.map_err(Into::into)
            }
            Backend::Pg(_) => Ok(()),
            Backend::Duck(d) => {
                d.stream_sql = None;
                d.offset = 0;
                Ok(())
            }
            Backend::Sqlite(s) => {
                s.stream_sql = None;
                s.offset = 0;
                Ok(())
            }
            Backend::MySql(m) => {
                m.stream_sql = None;
                m.offset = 0;
                Ok(())
            }
            Backend::MsSql(m) => {
                m.reset_stream();
                Ok(())
            }
        }
    }

    /// Best-effort disconnect cleanup on the same physical session.
    pub async fn rollback_manual(&mut self) {
        self.rollback_cursor().await;
        match self {
            Backend::Pg(p) => {
                // A manual transaction owns the session without tracked cursor state,
                // and `rollback_cursor` only rolls back when a cursor is tracked —
                // end the unit explicitly (a redundant ROLLBACK is just a warning).
                let _ = p.client.batch_execute("ROLLBACK").await;
            }
            Backend::Duck(d) => {
                if d.is_open() {
                    let result = d.lock().execute_batch("ROLLBACK").map_err(de);
                    if result.is_err() {
                        let _ = d.quarantine_poisoned();
                    }
                }
            }
            Backend::Sqlite(s) => {
                let _ = s.lock().execute_batch("ROLLBACK");
            }
            Backend::MySql(m) => m.rollback_pinned().await,
            Backend::MsSql(m) => m.rollback_manual().await,
        }
    }

    /// Run a multi-statement script — ONE transaction on every driver (PG via
    /// script::run; DuckDB/SQLite via an explicit BEGIN…COMMIT batch wrap;
    /// MySQL via START TRANSACTION around the loop, though MySQL DDL still
    /// auto-commits). This idle-only app wrapper rejects transaction control;
    /// `exec_items` routes manual lifecycle scripts statement-by-statement instead.
    pub async fn run_script(
        &self,
        items: &[script::Item],
        read_only: bool,
    ) -> Result<String, AppError> {
        if script::has_txn_control_for(items, self.engine()) {
            return Err(AppError::new(
                "transaction-control statements are not supported; run the statements as one script without BEGIN/COMMIT",
            ));
        }
        if !matches!(self, Backend::Pg(_))
            && items
                .iter()
                .any(|item| matches!(item, script::Item::Copy { .. }))
        {
            return Err(AppError::new(
                "COPY FROM stdin is only supported by PostgreSQL",
            ));
        }
        if matches!(self, Backend::MySql(_))
            && items.iter().any(|item| {
                let sql = match item {
                    script::Item::Sql(sql) => sql,
                    script::Item::Copy { stmt, .. } => stmt,
                };
                script::contains_mysql_executable_comment(sql)
            })
        {
            return Err(AppError::new(
                "MySQL/MariaDB executable comments are blocked because they can hide transaction control",
            ));
        }
        let enforce_read_only = read_only || self.config().read_only;
        if enforce_read_only
            && items.iter().any(|item| match item {
                script::Item::Sql(sql) => !crate::is_read_only_stmt(sql),
                script::Item::Copy { .. } => true,
            })
        {
            return Err(AppError::new(
                "connection is read-only — script contains writes or side effects",
            ));
        }
        match self {
            Backend::Pg(p) => script::run(&p.client, items, enforce_read_only).await,
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
                let r = embedded_script(&d.lock(), items, |c, s| c.execute_batch(s).map_err(de));
                r.map_err(|e| d.quarantine_if_poisoned(e))
            }
            Backend::Sqlite(s) => {
                embedded_script(&s.lock(), items, |c, s| c.execute_batch(s).map_err(de))
            }
            Backend::MySql(m) => m.run_script(items).await,
            Backend::MsSql(m) => m.run_script(items).await,
        }
    }

    /// Run a single idle statement: stream a cursorable read, else execute + report.
    pub async fn run_single(
        &mut self,
        trimmed: &str,
        page: u32,
        cursorable: bool,
    ) -> Result<QueryOutcome, AppError> {
        if script::effective_start(trimmed).starts_with('\\') {
            return Err(AppError::new("psql meta-commands are not supported"));
        }
        if self.config().read_only && !crate::is_read_only_stmt(trimmed) {
            return Err(AppError::new(
                "connection is read-only — writes and side effects are blocked",
            ));
        }
        match self {
            Backend::Pg(p) => p.run_single(trimmed, page, cursorable, false).await,
            Backend::Duck(d) => d
                .run_single(trimmed, page, cursorable)
                .map_err(|e| d.quarantine_if_poisoned(e)),
            Backend::Sqlite(s) => s.run_single(trimmed, page, cursorable),
            Backend::MySql(m) => m.run_single(trimmed, page, cursorable).await,
            Backend::MsSql(m) => m.run_single(trimmed, page, cursorable, false).await,
        }
    }

    /// Run SQL on the physical session owned by a manual transaction. PostgreSQL
    /// cursors do not add a nested BEGIN; MySQL uses its pinned connection.
    pub async fn run_manual_single(
        &mut self,
        trimmed: &str,
        page: u32,
        cursorable: bool,
        mode: TransactionMode,
    ) -> Result<QueryOutcome, AppError> {
        // Same driver-level guards as `run_single`: the command layer already
        // enforces these, but the manual-transaction path must not be the one
        // route with a single enforcement layer.
        if script::effective_start(trimmed).starts_with('\\') {
            return Err(AppError::new("psql meta-commands are not supported"));
        }
        if self.config().read_only && !crate::is_read_only_stmt(trimmed) {
            return Err(AppError::new(
                "connection is read-only — writes and side effects are blocked",
            ));
        }
        match self {
            Backend::Pg(p) => p.run_single(trimmed, page, cursorable, true).await,
            Backend::Duck(d) => d
                .run_single(trimmed, page, cursorable)
                .map_err(|e| d.quarantine_if_poisoned(e)),
            Backend::Sqlite(s) => s.run_single(trimmed, page, cursorable),
            Backend::MySql(m) => m.run_manual_single(trimmed, page, cursorable, mode).await,
            Backend::MsSql(m) => m.run_single(trimmed, page, cursorable, true).await,
        }
    }

    pub async fn run_transaction_statement(
        &mut self,
        sql: &str,
        action: script::TransactionAction,
        current_mode: TransactionMode,
    ) -> Result<QueryOutcome, AppError> {
        match self {
            Backend::Pg(p) => p.run_single(sql, 1, false, true).await,
            Backend::Duck(d) => {
                d.parse_check(sql)?;
                let result = d.lock().execute_batch(sql).map_err(de);
                result
                    .map(|()| QueryOutcome::Exec {
                        message: "OK".to_string(),
                    })
                    .map_err(|e| d.quarantine_if_poisoned(e))
            }
            Backend::Sqlite(s) => {
                s.lock().execute_batch(sql).map_err(de)?;
                Ok(QueryOutcome::Exec {
                    message: "OK".to_string(),
                })
            }
            Backend::MySql(m) => m.run_transaction_statement(sql, action, current_mode).await,
            Backend::MsSql(m) => m.run_transaction_statement(sql, action).await,
        }
    }

    pub async fn run_manual_copy(&mut self, stmt: &str, data: &str) -> Result<u64, AppError> {
        if self.config().read_only {
            return Err(AppError::new(
                "connection is read-only — COPY FROM stdin is blocked",
            ));
        }
        match self {
            Backend::Pg(p) => script::copy_in_text(&p.client, stmt, data).await,
            _ => Err(AppError::new(
                "COPY FROM stdin is only supported by PostgreSQL",
            )),
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
            Backend::MsSql(m) => m.fetch_page(page).await,
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
                            .filter(|(_, r)| {
                                r.get(ty).and_then(|v| v.as_deref()) == Some("BOOLEAN")
                            })
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
                                .map(|t| {
                                    t.trim().eq_ignore_ascii_case("bool")
                                        || t.trim().eq_ignore_ascii_case("boolean")
                                })
                                .unwrap_or(false)
                        })
                        .map(|(i, _)| i)
                        .collect(),
                    Err(_) => Vec::new(),
                };
                found
            }
            Backend::MySql(_) => Vec::new(),
            // sys.dm_exec_describe_first_result_set parses without executing.
            Backend::MsSql(m) => m.bool_columns(sql).await,
        }
    }

    /// Run an internal text-returning query (introspection): columns + text rows.
    async fn query_text_limited(
        &self,
        sql: &str,
        limits: db::TextLimits,
    ) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), AppError> {
        match self {
            Backend::Pg(p) => {
                let m = p.client.simple_query(sql).await?;
                db::collect_rows_limited(&m, limits)
            }
            Backend::Duck(d) => duck_query_limited(&d.lock(), sql, limits),
            Backend::Sqlite(s) => sqlite_query_limited(&s.lock(), sql, limits),
            Backend::MySql(m) => {
                let (c, r, _a) = mysql_run_limited(&m.pool, sql, limits).await?;
                Ok((c, r))
            }
            Backend::MsSql(m) => m.query_text(sql, limits).await,
        }
    }

    async fn query_text(
        &self,
        sql: &str,
    ) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), AppError> {
        self.query_text_limited(sql, db::CATALOG_TEXT_LIMITS).await
    }

    /// Shallow object tree (sidebar). PG = rich pg_catalog; embedded = catalog views.
    pub async fn build_tree(&self) -> Result<tree::DbTree, AppError> {
        match self {
            Backend::Pg(p) => tree::build_shallow(&p.client).await,
            Backend::Duck(d) => duck_build_tree(&d.lock()),
            Backend::Sqlite(s) => sqlite_build_tree(&s.lock()),
            Backend::MySql(m) => mysql_build_tree(&m.pool).await,
            Backend::MsSql(m) => m.build_tree().await,
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
            Backend::MsSql(m) => m
                .query_text("SELECT DB_NAME()", db::CATALOG_TEXT_LIMITS)
                .await
                .ok()
                .and_then(|(_c, rows)| rows.into_iter().next())
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
            Backend::MsSql(m) => m.table_detail(schema, name).await,
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
                let sql = "SELECT kcu.CONSTRAINT_NAME, kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME, \
                           kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME \
                           FROM information_schema.KEY_COLUMN_USAGE kcu \
                           WHERE kcu.REFERENCED_TABLE_NAME IS NOT NULL \
                           AND ((kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ?) \
                             OR (kcu.REFERENCED_TABLE_SCHEMA = ? AND kcu.REFERENCED_TABLE_NAME = ?)) \
                           ORDER BY kcu.CONSTRAINT_NAME, kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.ORDINAL_POSITION";
                let params = mysql_async::Params::Positional(vec![
                    schema.into(),
                    name.into(),
                    schema.into(),
                    name.into(),
                ]);
                let (_c, rows, _a) = mysql_run_params(&m.pool, sql, params).await?;
                Ok(relgraph::mysql_split(&rows, schema, name))
            }
            Backend::MsSql(m) => {
                let rows = m.fk_edge_rows(Some((schema, name))).await?;
                Ok(relgraph::mysql_split(&rows, schema, name))
            }
        }
    }

    /// All FK edges + table/column summaries of a schema, for the ERD view.
    pub async fn schema_relationships(
        &self,
        schema: &str,
    ) -> Result<relgraph::SchemaGraph, AppError> {
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
                        tables.push(relgraph::ErdTable {
                            schema: schema.to_string(),
                            name: t.clone(),
                            columns: Vec::new(),
                        });
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
                let edge_sql = "SELECT kcu.CONSTRAINT_NAME, kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME, \
                                kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME \
                                FROM information_schema.KEY_COLUMN_USAGE kcu \
                                WHERE kcu.REFERENCED_TABLE_NAME IS NOT NULL \
                                AND (kcu.TABLE_SCHEMA = ? OR kcu.REFERENCED_TABLE_SCHEMA = ?) \
                                ORDER BY kcu.CONSTRAINT_NAME, kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.ORDINAL_POSITION";
                let edge_params =
                    mysql_async::Params::Positional(vec![schema.into(), schema.into()]);
                let (_c, edge_rows, _a) = mysql_run_params(&m.pool, edge_sql, edge_params).await?;
                let col_sql = "SELECT table_name, column_name, data_type, column_key \
                               FROM information_schema.columns WHERE table_schema = ? \
                               ORDER BY table_name, ordinal_position";
                let col_params = mysql_async::Params::Positional(vec![schema.into()]);
                let (_c2, col_rows, _a2) = mysql_run_params(&m.pool, col_sql, col_params).await?;
                Ok(relgraph::mysql_schema_graph(&col_rows, &edge_rows, schema))
            }
            Backend::MsSql(m) => {
                let edge_rows = m.fk_edge_rows(None).await?;
                let edge_rows: Vec<Vec<Option<String>>> = edge_rows
                    .into_iter()
                    .filter(|row| dcell(row, 1) == schema || dcell(row, 4) == schema)
                    .collect();
                let col_rows = m.erd_column_rows(schema).await?;
                Ok(relgraph::mysql_schema_graph(&col_rows, &edge_rows, schema))
            }
        }
    }

    /// Reconstructed CREATE DDL for one relation, per engine: PG pg_catalog
    /// (full reconstruction in ddl.rs), SQLite sqlite_master (+ index DDL),
    /// MySQL SHOW CREATE, DuckDB duckdb_tables()/duckdb_views() best-effort.
    pub async fn relation_ddl(
        &self,
        kind: &str,
        schema: &str,
        name: &str,
    ) -> Result<String, AppError> {
        match self {
            Backend::Pg(p) => crate::ddl::object_ddl(&p.client, kind, schema, name).await,
            Backend::Sqlite(s) => {
                let conn = s.lock();
                let lit = |x: &str| format!("'{}'", x.replace('\'', "''"));
                let (_c, rows) = sqlite_query_limited(
                    &conn,
                    &format!(
                        "SELECT sql FROM sqlite_master WHERE name = {} AND sql IS NOT NULL",
                        lit(name)
                    ),
                    db::DDL_TEXT_LIMITS,
                )?;
                let mut parts: Vec<String> = rows
                    .iter()
                    .filter_map(|r| r.first().cloned().flatten())
                    .collect();
                if parts.is_empty() {
                    return Err(AppError::new("no stored DDL for this object"));
                }
                let (_c2, idx) = sqlite_query_limited(
                    &conn,
                    &format!(
                        "SELECT sql FROM sqlite_master WHERE tbl_name = {} AND type = 'index' AND sql IS NOT NULL ORDER BY name",
                        lit(name)
                    ),
                    db::DDL_TEXT_LIMITS,
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
                let (_c, rows, _a) = mysql_run_limited(&m.pool, &q, db::DDL_TEXT_LIMITS).await?;
                rows.first()
                    .and_then(|r| r.get(1).cloned().flatten())
                    .map(|s| s + ";\n")
                    .ok_or_else(|| AppError::new("no DDL returned"))
            }
            Backend::Duck(d) => {
                let conn = d.lock();
                let src = if kind == "view" {
                    "duckdb_views()"
                } else {
                    "duckdb_tables()"
                };
                let q = format!(
                    "SELECT sql FROM {src} WHERE schema_name = {} AND {} = {}",
                    dlit(schema),
                    if kind == "view" {
                        "view_name"
                    } else {
                        "table_name"
                    },
                    dlit(name)
                );
                let (_c, rows) =
                    duck_query_limited(&conn, &q, db::DDL_TEXT_LIMITS).map_err(|_| {
                        AppError::new("DDL reconstruction isn't supported on this DuckDB build")
                    })?;
                rows.first()
                    .and_then(|r| r.first().cloned().flatten())
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| {
                        if s.trim_end().ends_with(';') {
                            s + "\n"
                        } else {
                            s + ";\n"
                        }
                    })
                    .ok_or_else(|| AppError::new("no stored DDL for this object"))
            }
            Backend::MsSql(m) => m.relation_ddl(kind, schema, name).await,
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
                let (_c, rows) = db::collect_rows(&msgs)?;
                Ok(rows
                    .into_iter()
                    .filter_map(|r| r.into_iter().next().flatten())
                    .collect())
            }
            Backend::Duck(d) => {
                let conn = d.lock();
                let (_c, rows) = duck_query(
                    &conn,
                    "SELECT DISTINCT function_name FROM duckdb_functions()",
                )?;
                Ok(rows
                    .into_iter()
                    .filter_map(|r| r.into_iter().next().flatten())
                    .collect())
            }
            Backend::Sqlite(s) => {
                let conn = s.lock();
                let (_c, rows) =
                    sqlite_query(&conn, "SELECT DISTINCT name FROM pragma_function_list")?;
                Ok(rows
                    .into_iter()
                    .filter_map(|r| r.into_iter().next().flatten())
                    .collect())
            }
            // MySQL has no catalog of BUILTIN functions (information_schema.routines
            // is user routines only) — a partial list would false-positive on every
            // uncommon builtin, so report none and the lint stays off.
            Backend::MySql(_) => Ok(Vec::new()),
            // SQL Server keeps no catalog of built-in functions either (sys.objects is
            // user objects only), so linting against it would flag every builtin.
            Backend::MsSql(_) => Ok(Vec::new()),
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
            Backend::MsSql(_) => "('sys','INFORMATION_SCHEMA')",
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
        self.query_text_limited(
            &sample_sql(self, schema, table, limit.clamp(1, 50)),
            db::USER_TEXT_LIMITS,
        )
        .await
    }
}

/// `SELECT * FROM <rel> LIMIT n`, identifier-quoted per dialect (MySQL backticks,
/// everyone else double quotes). Schema-qualified when a schema is given.
fn sample_sql(b: &Backend, schema: &str, table: &str, limit: u32) -> String {
    let mysql = matches!(b, Backend::MySql(_));
    let mssql = matches!(b, Backend::MsSql(_));
    let q = |s: &str| {
        if mysql {
            format!("`{}`", s.replace('`', "``"))
        } else if mssql {
            format!("[{}]", s.replace(']', "]]"))
        } else {
            format!("\"{}\"", s.replace('"', "\"\""))
        }
    };
    let rel = if schema.is_empty() {
        q(table)
    } else {
        format!("{}.{}", q(schema), q(table))
    };
    if mssql {
        // T-SQL has no LIMIT; TOP is the row-count form that needs no ORDER BY.
        return format!("SELECT TOP {limit} * FROM {rel}");
    }
    format!("SELECT * FROM {rel} LIMIT {limit}")
}

impl PgConn {
    fn next_cursor_name() -> String {
        static NEXT_CURSOR: AtomicUsize = AtomicUsize::new(1);
        let serial = NEXT_CURSOR.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        format!("tusk_{}_{}_{}", std::process::id(), nanos, serial)
    }

    async fn finish_cursor(&mut self) -> Result<(), AppError> {
        let Some(name) = self.cursor_name.take() else {
            return Ok(());
        };
        let auto_transaction = self.cursor_auto_transaction;
        self.cursor_auto_transaction = false;
        if let Err(e) = self
            .client
            .batch_execute(&format!("CLOSE {}", db::ident(&name)))
            .await
        {
            if auto_transaction {
                let _ = self.client.batch_execute("ROLLBACK").await;
            }
            return Err(e.into());
        }
        if !auto_transaction {
            return Ok(());
        }
        if let Err(e) = self.client.batch_execute("COMMIT").await {
            let _ = self.client.batch_execute("ROLLBACK").await;
            return Err(AppError::new(format!(
                "commit acknowledgement failed; query outcome is unknown — verify database state before retrying ({e})"
            )));
        }
        Ok(())
    }

    async fn fail_cursor(&mut self) {
        let auto_transaction = self.cursor_auto_transaction;
        self.cursor_name = None;
        self.cursor_auto_transaction = false;
        if auto_transaction {
            let _ = self.client.batch_execute("ROLLBACK").await;
        }
    }

    async fn run_single(
        &mut self,
        trimmed: &str,
        page: u32,
        cursorable: bool,
        manual_transaction: bool,
    ) -> Result<QueryOutcome, AppError> {
        if cursorable {
            if !manual_transaction {
                self.client.batch_execute("BEGIN").await?;
            }
            let cursor_name = Self::next_cursor_name();
            let declare = format!("DECLARE {} CURSOR FOR {trimmed}", db::ident(&cursor_name));
            if let Err(e) = self.client.batch_execute(&declare).await {
                if !manual_transaction {
                    let _ = self.client.batch_execute("ROLLBACK").await;
                }
                return Err(e.into());
            }
            self.cursor_name = Some(cursor_name.clone());
            self.cursor_auto_transaction = !manual_transaction;
            let fetch = format!("FETCH FORWARD {page} FROM {}", db::ident(&cursor_name));
            let messages = match self.client.simple_query(&fetch).await {
                Ok(m) => m,
                Err(e) => {
                    self.fail_cursor().await;
                    return Err(e.into());
                }
            };
            let (columns, rows) = match db::collect_rows_limited(&messages, db::USER_TEXT_LIMITS) {
                Ok(result) => result,
                Err(error) => {
                    self.fail_cursor().await;
                    return Err(error);
                }
            };
            let done = (rows.len() as u32) < page;
            if done {
                self.finish_cursor().await?;
            }
            Ok(QueryOutcome::Rows {
                columns,
                rows,
                done,
                note: None,
            })
        } else {
            let messages = self.client.simple_query(trimmed).await?;
            let (columns, rows) = db::collect_rows_limited(&messages, db::USER_TEXT_LIMITS)?;
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
                    message: if script::is_ddl(trimmed) {
                        "OK".to_string()
                    } else {
                        format!("OK ({affected} rows affected)")
                    },
                })
            }
        }
    }

    async fn fetch_page(&mut self, page: u32) -> Result<FetchResult, AppError> {
        let Some(name) = self.cursor_name.clone() else {
            return Ok(FetchResult {
                rows: Vec::new(),
                done: true,
            });
        };
        let fetch = format!("FETCH FORWARD {page} FROM {}", db::ident(&name));
        let messages = match self.client.simple_query(&fetch).await {
            Ok(messages) => messages,
            Err(e) => {
                self.fail_cursor().await;
                return Err(e.into());
            }
        };
        let (_cols, rows) = match db::collect_rows_limited(&messages, db::USER_TEXT_LIMITS) {
            Ok(result) => result,
            Err(error) => {
                self.fail_cursor().await;
                return Err(error);
            }
        };
        let done = (rows.len() as u32) < page;
        if done {
            self.finish_cursor().await?;
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
        static ICU_UNAVAILABLE: std::sync::atomic::AtomicBool =
            std::sync::atomic::AtomicBool::new(false);
        if conn.execute("LOAD icu", []).is_err() && !ICU_UNAVAILABLE.load(Ordering::Relaxed) {
            let _ = conn.execute("INSTALL icu", []);
            if let Err(e) = conn.execute("LOAD icu", []) {
                ICU_UNAVAILABLE.store(true, Ordering::Relaxed);
                eprintln!(
                    "[tusk] DuckDB ICU extension unavailable ({e}); TIMESTAMPTZ casts will fail"
                );
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
                gate_poison_leaks: AtomicUsize::new(0),
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
            // Read native values and render them in `duck_value_repr`. A blanket
            // VARCHAR cast uses DuckDB's mixed printable/escaped BLOB syntax, which
            // diverges from the reversible `\x...` convention used by every driver.
            let wrapped = format!("SELECT * FROM ({trimmed}) AS _tusk LIMIT {page}");
            self.parse_check(&wrapped)?;
            let (columns, rows) = {
                let g = self.lock();
                duck_query_limited(&g, &wrapped, db::USER_TEXT_LIMITS)?
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
                duck_query_limited(&g, trimmed, db::USER_TEXT_LIMITS)?
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
            "SELECT * FROM ({base}) AS _tusk LIMIT {page} OFFSET {}",
            self.offset
        );
        let (_cols, rows) = {
            let g = self.lock();
            duck_query_limited(&g, &wrapped, db::USER_TEXT_LIMITS)?
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
                sqlite_query_limited(&g, &wrapped, db::USER_TEXT_LIMITS)?
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
            let (columns, rows) = sqlite_query_limited(&g, trimmed, db::USER_TEXT_LIMITS)?;
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
                    message: if script::is_ddl(trimmed) {
                        "OK".to_string()
                    } else {
                        format!("OK ({} rows affected)", g.changes())
                    },
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
            sqlite_query_limited(&g, &wrapped, db::USER_TEXT_LIMITS)?
        };
        let done = (rows.len() as u32) < page;
        self.offset += rows.len();
        if done {
            self.stream_sql = None;
        }
        Ok(FetchResult { rows, done })
    }
}

fn sqlite_value(v: rusqlite::types::ValueRef) -> Result<Option<String>, AppError> {
    use rusqlite::types::ValueRef as V;
    match v {
        V::Null => Ok(None),
        V::Integer(n) => Ok(Some(n.to_string())),
        V::Real(f) => Ok(Some(f.to_string())),
        V::Text(bytes) => std::str::from_utf8(bytes)
            .map(|text| Some(text.to_string()))
            .map_err(|error| {
                AppError::new(format!("SQLite text value contains invalid UTF-8: {error}"))
            }),
        V::Blob(bytes) => Ok(Some(binary_text(bytes))),
    }
}

fn sqlite_query(conn: &rusqlite::Connection, sql: &str) -> Result<TextRows, AppError> {
    sqlite_query_limited(conn, sql, db::CATALOG_TEXT_LIMITS)
}

fn sqlite_query_limited(
    conn: &rusqlite::Connection,
    sql: &str,
    limits: db::TextLimits,
) -> Result<TextRows, AppError> {
    let mut stmt = conn.prepare(sql).map_err(de)?;
    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let ncols = columns.len();
    let mut budget = db::TextBudget::new(&columns, limits)?;
    let mut rows = stmt.query([]).map_err(de)?;
    let mut data: Vec<Vec<Option<String>>> = Vec::new();
    while let Some(row) = rows.next().map_err(de)? {
        let mut r = Vec::with_capacity(ncols);
        for i in 0..ncols {
            r.push(sqlite_value(row.get_ref(i).map_err(de)?)?);
        }
        budget.add_row(&r)?;
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

/// MySQL reports `COLUMN_DEFAULT` UNQUOTED: a `DEFAULT 'abc'` comes back as `abc`,
/// indistinguishable from an expression by shape alone. Anything that has to put the
/// default back into SQL — the Modify dialog's `MODIFY COLUMN`, which restates the whole
/// definition — would then emit `DEFAULT abc` and fail. Turn it into a runnable
/// expression here, once, where the column type and `extra` are both in hand.
fn mysql_default_expr(raw: &str, column_type: &str, extra: &str) -> String {
    let d = raw.trim();
    if d.is_empty() {
        return String::new();
    }
    // 8.0.13+ marks a real expression default in `extra`.
    if extra.to_ascii_lowercase().contains("default_generated") {
        return d.to_string();
    }
    let upper = d.to_ascii_uppercase();
    // Temporal auto-defaults are expressions without the DEFAULT_GENERATED marker.
    let temporal = ["CURRENT_TIMESTAMP", "NOW()", "CURRENT_DATE", "CURRENT_TIME"];
    if temporal.iter().any(|k| upper == *k)
        || (upper.starts_with("CURRENT_TIMESTAMP(") && upper.ends_with(')'))
    {
        return d.to_string();
    }
    // Bit / hex literals are already written as literals.
    if upper.starts_with("B'") || upper.starts_with("X'") || upper.starts_with("0X") {
        return d.to_string();
    }
    // A numeric column with a numeric default needs no quoting.
    let ty = column_type.to_ascii_lowercase();
    let numeric = [
        "int", "decimal", "numeric", "float", "double", "real", "bit", "year",
    ];
    if numeric.iter().any(|k| ty.starts_with(k)) && d.parse::<f64>().is_ok() {
        return d.to_string();
    }
    // Everything else is the literal text of a string/temporal/enum default.
    format!("'{}'", d.replace('\\', "\\\\").replace('\'', "''"))
}

/// One foreign key while its per-column catalog rows are being grouped (SQLite).
struct FkGroup {
    id: String,
    cols: Vec<String>,
    ref_cols: Vec<String>,
    ref_table: String,
    actions: String,
}

/// Same, for MySQL, where the referenced table is schema-qualified.
struct MySqlFkGroup {
    name: String,
    cols: Vec<String>,
    ref_schema: String,
    ref_table: String,
    ref_cols: Vec<String>,
}

/// SQLite has no `information_schema`: columns come from `PRAGMA table_info`, keys and
/// indexes from `PRAGMA index_list`/`index_info`/`foreign_key_list`, and the index DDL
/// from `sqlite_master`. Constraint `def`s are synthesized as the CLAUSE the table
/// rebuild can paste straight back into a `CREATE TABLE` (see `rebuildTable` in
/// `sql/ddl.ts`) — CHECK constraints are the one shape SQLite refuses to enumerate,
/// so the Modify dialog warns instead of silently dropping them.
fn sqlite_table_detail(
    conn: &rusqlite::Connection,
    name: &str,
) -> Result<tree::RelationDetail, AppError> {
    let q = db::ident(name);
    // The stored CREATE text is the only place AUTOINCREMENT is visible.
    let stored = sqlite_query(
        conn,
        &format!(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name={}",
            sqlite_lit(name)
        ),
    )
    .ok()
    .and_then(|(_c, rs)| rs.first().map(|r| dcell(r, 0)))
    .unwrap_or_default();
    let autoincrement = stored.to_ascii_uppercase().contains("AUTOINCREMENT");

    // PRAGMA table_info → (cid, name, type, notnull, dflt_value, pk).
    let (_c, rows) = sqlite_query(conn, &format!("PRAGMA table_info({q})"))?;

    // foreign_key_list → (id, seq, table, from, to, on_update, on_delete, match).
    let fk_rows = sqlite_query(conn, &format!("PRAGMA foreign_key_list({q})"))
        .map(|(_c, rs)| rs)
        .unwrap_or_default();
    let fk_cols: std::collections::HashSet<String> = fk_rows.iter().map(|r| dcell(r, 3)).collect();

    let columns: Vec<tree::Column> = rows
        .iter()
        .map(|r| {
            let is_pk = dcell(r, 5) != "0" && !dcell(r, 5).is_empty();
            let name = dcell(r, 1);
            let data_type = dcell(r, 2);
            tree::Column {
                identity: is_pk && autoincrement && data_type.eq_ignore_ascii_case("INTEGER"),
                is_fk: fk_cols.contains(&name),
                name,
                data_type,
                nullable: dcell(r, 3) != "1",
                is_pk,
                default: r.get(4).and_then(|v| v.clone()),
                comment: None, // SQLite has no COMMENT syntax at all
            }
        })
        .collect();

    let mut constraints: Vec<tree::Constraint> = Vec::new();
    let pk_cols: Vec<String> = columns
        .iter()
        .filter(|c| c.is_pk)
        .map(|c| db::ident(&c.name))
        .collect();
    if !pk_cols.is_empty() {
        constraints.push(tree::Constraint {
            name: format!("{name}_pk"),
            kind: "primary_key".to_string(),
            def: format!("PRIMARY KEY ({})", pk_cols.join(", ")),
        });
    }

    // index_list → (seq, name, unique, origin, partial); origin 'u' = UNIQUE constraint,
    // 'pk' = the primary key's index, 'c' = an explicit CREATE INDEX.
    let idx_rows = sqlite_query(conn, &format!("PRAGMA index_list({q})"))
        .map(|(_c, rs)| rs)
        .unwrap_or_default();
    let mut indexes: Vec<tree::Index> = Vec::new();
    for r in &idx_rows {
        let iname = dcell(r, 1);
        let unique = dcell(r, 2) == "1";
        let origin = dcell(r, 3);
        let cols: Vec<String> =
            sqlite_query(conn, &format!("PRAGMA index_info({})", db::ident(&iname)))
                .map(|(_c, rs)| rs.iter().map(|x| dcell(x, 2)).collect())
                .unwrap_or_default();
        if origin == "u" {
            constraints.push(tree::Constraint {
                name: iname.clone(),
                kind: "unique".to_string(),
                def: format!(
                    "UNIQUE ({})",
                    cols.iter()
                        .map(|c| db::ident(c))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            });
        }
        let def = sqlite_query(
            conn,
            &format!(
                "SELECT sql FROM sqlite_master WHERE type='index' AND name={} AND sql IS NOT NULL",
                sqlite_lit(&iname)
            ),
        )
        .ok()
        .and_then(|(_c, rs)| rs.first().map(|x| dcell(x, 0)))
        .unwrap_or_default();
        indexes.push(tree::Index {
            name: iname,
            unique,
            primary: origin == "pk",
            def,
        });
    }

    // Group the FK rows by constraint id, keeping column order.
    let mut fk_groups: Vec<FkGroup> = Vec::new();
    for r in &fk_rows {
        let id = dcell(r, 0);
        let entry = match fk_groups.iter_mut().find(|g| g.id == id) {
            Some(e) => e,
            None => {
                fk_groups.push(FkGroup {
                    id,
                    cols: Vec::new(),
                    ref_cols: Vec::new(),
                    ref_table: dcell(r, 2),
                    actions: String::new(),
                });
                fk_groups.last_mut().expect("just pushed")
            }
        };
        entry.cols.push(db::ident(&dcell(r, 3)));
        entry.ref_cols.push(db::ident(&dcell(r, 4)));
        let on_update = dcell(r, 5);
        let on_delete = dcell(r, 6);
        entry.actions = format!(
            "{}{}",
            if on_delete.is_empty() || on_delete == "NO ACTION" {
                String::new()
            } else {
                format!(" ON DELETE {on_delete}")
            },
            if on_update.is_empty() || on_update == "NO ACTION" {
                String::new()
            } else {
                format!(" ON UPDATE {on_update}")
            }
        );
    }
    for g in fk_groups {
        constraints.push(tree::Constraint {
            name: format!("{name}_fk_{}", g.id),
            kind: "foreign_key".to_string(),
            def: format!(
                "FOREIGN KEY ({}) REFERENCES {} ({}){}",
                g.cols.join(", "),
                db::ident(&g.ref_table),
                g.ref_cols.join(", "),
                g.actions
            ),
        });
    }

    let triggers = sqlite_query(
        conn,
        &format!(
            "SELECT name, COALESCE(sql,'') FROM sqlite_master WHERE type='trigger' AND tbl_name={} ORDER BY name",
            sqlite_lit(name)
        ),
    )
    .map(|(_c, rs)| {
        rs.iter()
            .map(|r| tree::Trigger {
                name: dcell(r, 0),
                def: dcell(r, 1),
            })
            .collect()
    })
    .unwrap_or_default();

    Ok(tree::RelationDetail {
        name: name.to_string(),
        kind: "table".to_string(),
        comment: None,
        columns,
        indexes,
        constraints,
        triggers,
    })
}

/// A SQLite text literal for catalog lookups (identifier quoting is `db::ident`).
fn sqlite_lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// A live MySQL connection pool. A `Pool` is Send+Sync+Clone (no `!Sync`-connection
/// problem); paging is LIMIT/OFFSET over the base query (each page is an independent
/// query — fine over a pool).
pub struct MySqlConn {
    pub pool: mysql_async::Pool,
    /// The user's configuration (real host/port + SSH settings); the pool dials
    /// `ssh::dial_config` instead when tunnelled.
    pub config: ConnectionConfig,
    pub stream_sql: Option<String>,
    pub offset: usize,
    /// Owns the SSH session for this connection; dropping it closes the tunnel.
    tunnel: Option<crate::ssh::Tunnel>,
    pinned: Option<mysql_async::Conn>,
    /// One connection held for the duration of a bulk run (restore), so the session
    /// state a dump sets up survives from statement to statement. Distinct from
    /// `pinned`, which belongs to the manual-transaction machinery.
    bulk: Option<mysql_async::Conn>,
    manual_lost: bool,
    autocommit_off: bool,
}

#[derive(Clone, Copy)]
struct MySqlSessionState {
    active: Option<bool>,
    autocommit: bool,
}

impl MySqlConn {
    /// `tunnel` is `None` for a fresh connect (one is opened when the config asks for
    /// it) and `Some(live)` when a reconnect hands over an already-verified session.
    async fn open(
        config: &ConnectionConfig,
        tunnel: Option<crate::ssh::Tunnel>,
    ) -> Result<(Backend, String), AppError> {
        let tunnel = crate::ssh::ensure(tunnel, config).await?;
        let dial = crate::ssh::dial_config(config, tunnel.as_ref());
        let mut builder = mysql_async::OptsBuilder::default()
            .ip_or_hostname(dial.host.clone())
            .tcp_port(dial.port)
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
                } else if let Some(name) = crate::ssh::tls_host(config, tunnel.as_ref()) {
                    // Through a tunnel the socket is loopback while the TLS peer is
                    // still the real server: verify the certificate against the
                    // configured hostname, not against 127.0.0.1.
                    ssl = ssl.with_danger_tls_hostname_override(Some(name));
                }
                builder = builder.ssl_opts(Some(ssl));
            }
        }
        let pool = mysql_async::Pool::new(builder);
        // Fail fast + capture the server version.
        let (_c, rows, _a) = mysql_run(&pool, "SELECT version()")
            .await
            .map_err(|e| crate::ssh::explain_db_failure(tunnel.as_ref(), e))?;
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
                tunnel,
                pinned: None,
                bulk: None,
                manual_lost: false,
                autocommit_off: false,
            }),
            format!("MySQL {version}"),
        ))
    }

    async fn begin_bulk(&mut self) -> Result<(), AppError> {
        if self.bulk.is_none() {
            self.bulk = Some(self.pool.get_conn().await.map_err(de)?);
        }
        Ok(())
    }

    /// Drop the bulk connection rather than returning it explicitly: mysql_async resets
    /// a pooled connection on return, so whatever the dump set on it (FK checks off,
    /// say) cannot survive into a later user query either way.
    async fn end_bulk(&mut self) {
        self.bulk.take();
    }

    async fn ensure_pinned(&mut self) -> Result<(), AppError> {
        if self.manual_lost {
            return Err(AppError::new(
                "MySQL manual transaction connection was lost; reconnect required",
            ));
        }
        if self.pinned.is_none() {
            self.pinned = Some(self.pool.get_conn().await.map_err(de)?);
        }
        Ok(())
    }

    async fn probe_pinned(&mut self) -> Result<(u32, MySqlSessionState), AppError> {
        use mysql_async::consts::StatusFlags;

        let conn = self
            .pinned
            .as_mut()
            .ok_or_else(|| AppError::new("MySQL manual transaction has no pinned connection"))?;
        let connection_id = conn.id();
        let (_columns, rows, _) =
            mysql_run_conn_limited(conn, "SELECT @@session.autocommit", db::USER_TEXT_LIMITS)
                .await?;
        let row = rows
            .first()
            .ok_or_else(|| AppError::new("MySQL transaction status probe returned no row"))?;
        let autocommit = row
            .first()
            .and_then(|value| value.as_deref())
            .ok_or_else(|| AppError::new("MySQL returned no autocommit status"))?
            == "1";
        // The final protocol packet reports state after the probe statement. Unlike a
        // Performance Schema query, SERVER_STATUS_IN_TRANS does not mistake the probe's
        // own in-flight autocommit statement for a surviving explicit transaction.
        let flags = conn
            .last_ok_packet()
            .ok_or_else(|| AppError::new("MySQL returned no transaction status flags"))?
            .status_flags();
        Ok((
            connection_id,
            MySqlSessionState {
                active: Some(flags.contains(StatusFlags::SERVER_STATUS_IN_TRANS)),
                autocommit,
            },
        ))
    }

    async fn verify_pinned_result<T>(
        &mut self,
        result: Result<T, AppError>,
        success: MySqlSessionState,
        failure: MySqlSessionState,
    ) -> Result<T, AppError> {
        match self.probe_pinned().await {
            Ok((_connection_id, actual))
                if if result.is_ok() {
                    success.active
                } else {
                    failure.active
                }
                .is_none_or(|expected| actual.active == Some(expected))
                    && actual.autocommit
                        == if result.is_ok() {
                            success.autocommit
                        } else {
                            failure.autocommit
                        } =>
            {
                result
            }
            Ok((_connection_id, actual)) => {
                self.manual_lost = true;
                Err(match result {
                    Ok(_) => AppError::new(format!(
                        "MySQL ended or changed the manual transaction unexpectedly (active={}, autocommit={}); reconnect required",
                        actual.active.unwrap_or(false), actual.autocommit
                    )),
                    Err(error) => AppError::new(format!(
                        "{}; MySQL transaction state also changed unexpectedly (active={}, autocommit={}); reconnect required",
                        error.message,
                        actual.active.unwrap_or(false),
                        actual.autocommit
                    )),
                })
            }
            Err(probe_error) => {
                self.manual_lost = true;
                Err(match result {
                    Ok(_) => AppError::new(format!(
                        "MySQL manual transaction connection was lost: {}",
                        probe_error.message
                    )),
                    Err(error) => AppError::new(format!(
                        "{}; MySQL transaction status is unavailable: {}",
                        error.message, probe_error.message
                    )),
                })
            }
        }
    }

    async fn run_manual_single(
        &mut self,
        trimmed: &str,
        page: u32,
        cursorable: bool,
        mode: TransactionMode,
    ) -> Result<QueryOutcome, AppError> {
        self.ensure_pinned().await?;
        let result = if cursorable {
            let result = {
                let conn = self.pinned.as_mut().expect("pinned above");
                mysql_page_conn(conn, trimmed, page, 0).await
            };
            result.map(|(columns, rows)| {
                let done = (rows.len() as u32) < page;
                if done {
                    self.stream_sql = None;
                    self.offset = 0;
                } else {
                    self.stream_sql = Some(trimmed.to_string());
                    self.offset = page as usize;
                }
                QueryOutcome::Rows {
                    columns,
                    rows,
                    done,
                    note: None,
                }
            })
        } else {
            let result = {
                let conn = self.pinned.as_mut().expect("pinned above");
                mysql_run_conn_limited(conn, trimmed, db::USER_TEXT_LIMITS).await
            };
            result.map(|(columns, rows, affected)| {
                if columns.is_empty() {
                    QueryOutcome::Exec {
                        message: if script::is_ddl(trimmed) {
                            "OK".to_string()
                        } else {
                            format!("OK ({affected} rows affected)")
                        },
                    }
                } else {
                    QueryOutcome::Rows {
                        columns,
                        rows,
                        done: true,
                        note: None,
                    }
                }
            })
        };
        self.autocommit_off = mode == TransactionMode::AutocommitOff;
        let expected = MySqlSessionState {
            active: (mode == TransactionMode::Explicit).then_some(true),
            autocommit: mode != TransactionMode::AutocommitOff,
        };
        self.verify_pinned_result(result, expected, expected).await
    }

    async fn run_transaction_statement(
        &mut self,
        sql: &str,
        action: script::TransactionAction,
        current_mode: TransactionMode,
    ) -> Result<QueryOutcome, AppError> {
        self.ensure_pinned().await?;
        let result = {
            let conn = self.pinned.as_mut().expect("pinned above");
            mysql_run_conn_limited(conn, sql, db::USER_TEXT_LIMITS).await
        };
        let (columns, rows, affected) = if action == script::TransactionAction::SetTransaction {
            // MySQL's unscoped SET TRANSACTION applies to the next transaction. Any
            // status SELECT here would consume it before the user's START TRANSACTION.
            result?
        } else {
            let current = match action {
                script::TransactionAction::Begin => MySqlSessionState {
                    active: Some(false),
                    autocommit: true,
                },
                script::TransactionAction::AutocommitOff
                    if current_mode != TransactionMode::AutocommitOff =>
                {
                    MySqlSessionState {
                        active: Some(false),
                        autocommit: true,
                    }
                }
                script::TransactionAction::AutocommitOn
                    if current_mode != TransactionMode::AutocommitOff =>
                {
                    MySqlSessionState {
                        active: Some(false),
                        autocommit: true,
                    }
                }
                _ => MySqlSessionState {
                    active: (current_mode != TransactionMode::AutocommitOff).then_some(true),
                    autocommit: current_mode != TransactionMode::AutocommitOff,
                },
            };
            let success = match action {
                script::TransactionAction::Begin
                | script::TransactionAction::Savepoint
                | script::TransactionAction::Release
                | script::TransactionAction::RollbackTo => MySqlSessionState {
                    active: Some(true),
                    autocommit: current_mode != TransactionMode::AutocommitOff,
                },
                script::TransactionAction::Commit | script::TransactionAction::Rollback
                    if current_mode != TransactionMode::AutocommitOff =>
                {
                    MySqlSessionState {
                        active: Some(false),
                        autocommit: true,
                    }
                }
                script::TransactionAction::AutocommitOn => MySqlSessionState {
                    active: Some(false),
                    autocommit: true,
                },
                script::TransactionAction::Commit
                | script::TransactionAction::Rollback
                | script::TransactionAction::AutocommitOff => MySqlSessionState {
                    active: None,
                    autocommit: false,
                },
                script::TransactionAction::SetTransaction => unreachable!("handled above"),
            };
            self.verify_pinned_result(result, success, current).await?
        };
        if action == script::TransactionAction::AutocommitOff {
            self.autocommit_off = true;
        } else if action == script::TransactionAction::AutocommitOn {
            self.autocommit_off = false;
        }
        if action == script::TransactionAction::AutocommitOn
            || (matches!(
                action,
                script::TransactionAction::Commit | script::TransactionAction::Rollback
            ) && current_mode != TransactionMode::AutocommitOff)
        {
            self.pinned.take();
        }
        Ok(if columns.is_empty() {
            QueryOutcome::Exec {
                message: format!("OK ({affected} rows affected)"),
            }
        } else {
            QueryOutcome::Rows {
                columns,
                rows,
                done: true,
                note: None,
            }
        })
    }

    async fn rollback_pinned(&mut self) {
        use mysql_async::prelude::Queryable;
        if let Some(mut conn) = self.pinned.take() {
            // Never follow an unacknowledged rollback with SET autocommit=1: that SET
            // commits an active autocommit-off transaction in MySQL. Dropping the
            // connection is the safe fallback when rollback acknowledgement is lost.
            if conn.query_drop("ROLLBACK").await.is_ok() && self.autocommit_off {
                let _ = conn.query_drop("SET autocommit=1").await;
            }
        }
        self.manual_lost = false;
        self.autocommit_off = false;
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
            // A bulk run (restore) keeps ONE session so the dump's own `SET`s apply to
            // the statements that follow them.
            let (columns, rows, affected) = match self.bulk.as_mut() {
                Some(conn) => {
                    mysql_single_statement(trimmed)?;
                    mysql_run_conn_limited(conn, trimmed, db::USER_TEXT_LIMITS).await?
                }
                None => mysql_run_limited(&self.pool, trimmed, db::USER_TEXT_LIMITS).await?,
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
                    message: if script::is_ddl(trimmed) {
                        "OK".to_string()
                    } else {
                        format!("OK ({affected} rows affected)")
                    },
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
        let result = if let Some(conn) = self.pinned.as_mut() {
            mysql_page_conn(conn, &base, page, self.offset).await
        } else {
            mysql_page(&self.pool, &base, page, self.offset).await
        };
        let (_c, rows) = if self.pinned.is_some() {
            let expected = MySqlSessionState {
                active: (!self.autocommit_off).then_some(true),
                autocommit: !self.autocommit_off,
            };
            self.verify_pinned_result(result, expected, expected)
                .await?
        } else {
            result?
        };
        let done = (rows.len() as u32) < page;
        self.offset += rows.len();
        if done {
            self.stream_sql = None;
        }
        Ok(FetchResult { rows, done })
    }

    /// MySQL DDL statements implicitly commit; DML-only scripts are atomic.
    async fn run_script(&self, items: &[script::Item]) -> Result<String, AppError> {
        use mysql_async::prelude::Queryable;
        let mut conn = self.pool.get_conn().await.map_err(de)?;
        conn.query_drop("START TRANSACTION").await.map_err(de)?;
        for it in items {
            if let script::Item::Sql(s) = it {
                if let Err(e) = conn.query_drop(s.trim()).await.map_err(de) {
                    let _ = conn.query_drop("ROLLBACK").await;
                    return Err(e);
                }
            }
        }
        conn.query_drop("COMMIT").await.map_err(|e| {
            AppError::new(format!(
                "commit acknowledgement failed; transaction outcome is unknown — verify database state before retrying ({e})"
            ))
        })?;
        Ok("OK".to_string())
    }
}

#[derive(Clone, Copy)]
struct MySqlColumnMeta {
    column_type: mysql_async::consts::ColumnType,
    binary: bool,
}

fn mysql_value_to_string(
    v: &mysql_async::Value,
    metadata: Option<MySqlColumnMeta>,
) -> Result<Option<String>, AppError> {
    use mysql_async::Value as V;
    match v {
        V::NULL => Ok(None),
        V::Bytes(bytes) if metadata.is_some_and(|meta| meta.binary) => Ok(Some(binary_text(bytes))),
        V::Bytes(bytes) => String::from_utf8(bytes.clone()).map(Some).map_err(|error| {
            AppError::new(format!("MySQL text value contains invalid UTF-8: {error}"))
        }),
        V::Int(n) => Ok(Some(n.to_string())),
        V::UInt(n) => Ok(Some(n.to_string())),
        V::Float(f) => Ok(Some(f.to_string())),
        V::Double(f) => Ok(Some(f.to_string())),
        V::Date(y, mo, d, h, mi, s, us) => {
            // Value::Date carries DATE and DATETIME/TIMESTAMP. Preserve midnight on
            // timestamp-like columns by consulting result metadata.
            if metadata.map(|meta| meta.column_type)
                == Some(mysql_async::consts::ColumnType::MYSQL_TYPE_DATE)
            {
                Ok(Some(format!("{y:04}-{mo:02}-{d:02}")))
            } else {
                let base = format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}");
                Ok(Some(if *us > 0 {
                    format!("{base}.{us:06}")
                } else {
                    base
                }))
            }
        }
        V::Time(neg, d, h, mi, s, us) => {
            let hours = d * 24 + *h as u32;
            let base = format!("{}{hours:02}:{mi:02}:{s:02}", if *neg { "-" } else { "" });
            Ok(Some(if *us > 0 {
                format!("{base}.{us:06}")
            } else {
                base
            }))
        }
    }
}

fn mysql_metadata(
    columns: Option<&std::sync::Arc<[mysql_async::Column]>>,
) -> (Vec<String>, Vec<MySqlColumnMeta>) {
    let Some(columns) = columns else {
        return (Vec::new(), Vec::new());
    };
    let names = columns
        .iter()
        .map(|column| column.name_str().to_string())
        .collect();
    let metadata = columns
        .iter()
        .map(|column| MySqlColumnMeta {
            column_type: column.column_type(),
            binary: mysql_is_binary_column(column.column_type(), column.character_set()),
        })
        .collect();
    (names, metadata)
}

fn mysql_is_binary_column(
    column_type: mysql_async::consts::ColumnType,
    character_set: u16,
) -> bool {
    use mysql_async::consts::ColumnType;
    let binary_capable = matches!(
        column_type,
        ColumnType::MYSQL_TYPE_VARCHAR
            | ColumnType::MYSQL_TYPE_BIT
            | ColumnType::MYSQL_TYPE_TINY_BLOB
            | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
            | ColumnType::MYSQL_TYPE_LONG_BLOB
            | ColumnType::MYSQL_TYPE_BLOB
            | ColumnType::MYSQL_TYPE_VAR_STRING
            | ColumnType::MYSQL_TYPE_STRING
            | ColumnType::MYSQL_TYPE_GEOMETRY
    );
    binary_capable && character_set == 63
}

fn mysql_text_row(
    row: &mysql_async::Row,
    metadata: &[MySqlColumnMeta],
) -> Result<Vec<Option<String>>, AppError> {
    (0..metadata.len())
        .map(|i| match row.as_ref(i) {
            Some(value) => mysql_value_to_string(value, metadata.get(i).copied()),
            None => Err(AppError::new("MySQL returned an inconsistent row shape")),
        })
        .collect()
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
    match mysql_run_limited(pool, &wrapped, db::USER_TEXT_LIMITS).await {
        Ok((c, r, _)) => Ok((c, r)),
        Err(e) if e.message.contains("Duplicate column name") => {
            let appended = format!("{base} LIMIT {limit} OFFSET {offset}");
            let (c, r, _) = mysql_run_limited(pool, &appended, db::USER_TEXT_LIMITS).await?;
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
    mysql_run_limited(pool, sql, db::CATALOG_TEXT_LIMITS).await
}

async fn mysql_run_limited(
    pool: &mysql_async::Pool,
    sql: &str,
    limits: db::TextLimits,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>, u64), AppError> {
    mysql_single_statement(sql)?;
    let mut conn = pool.get_conn().await.map_err(de)?;
    mysql_run_conn_limited(&mut conn, sql, limits).await
}

async fn mysql_run_conn_limited(
    conn: &mut mysql_async::Conn,
    sql: &str,
    limits: db::TextLimits,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>, u64), AppError> {
    mysql_single_statement(sql)?;
    use mysql_async::prelude::Queryable;
    let mut result = conn.query_iter(sql).await.map_err(de)?;
    let (columns, metadata) = mysql_metadata(result.columns().as_ref());
    let affected = result.affected_rows();
    let mut budget = db::TextBudget::new(&columns, limits)?;
    let mut data = Vec::new();
    while let Some(row) = result.next().await.map_err(de)? {
        let row = mysql_text_row(&row, &metadata)?;
        budget.add_row(&row)?;
        data.push(row);
    }
    Ok((columns, data, affected))
}

async fn mysql_page_conn(
    conn: &mut mysql_async::Conn,
    base: &str,
    limit: u32,
    offset: usize,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), AppError> {
    let wrapped = format!("SELECT * FROM ({base}) AS _tusk LIMIT {limit} OFFSET {offset}");
    match mysql_run_conn_limited(conn, &wrapped, db::USER_TEXT_LIMITS).await {
        Ok((columns, rows, _)) => Ok((columns, rows)),
        Err(error) if error.message.contains("Duplicate column name") => {
            let appended = format!("{base} LIMIT {limit} OFFSET {offset}");
            let (columns, rows, _) =
                mysql_run_conn_limited(conn, &appended, db::USER_TEXT_LIMITS).await?;
            Ok((columns, rows))
        }
        Err(error) => Err(error),
    }
}

async fn mysql_run_params(
    pool: &mysql_async::Pool,
    sql: &str,
    params: mysql_async::Params,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>, u64), AppError> {
    mysql_single_statement(sql)?;
    use mysql_async::prelude::Queryable;
    let mut conn = pool.get_conn().await.map_err(de)?;
    let mut result = conn.exec_iter(sql, params).await.map_err(de)?;
    let (columns, metadata) = mysql_metadata(result.columns().as_ref());
    let affected = result.affected_rows();
    let mut budget = db::TextBudget::new(&columns, db::CATALOG_TEXT_LIMITS)?;
    let mut data = Vec::new();
    while let Some(row) = result.next().await.map_err(de)? {
        let row = mysql_text_row(&row, &metadata)?;
        budget.add_row(&row)?;
        data.push(row);
    }
    Ok((columns, data, affected))
}

fn mysql_single_statement(sql: &str) -> Result<(), AppError> {
    if script::contains_mysql_executable_comment(sql) {
        return Err(AppError::new(
            "MySQL/MariaDB executable comments are not supported",
        ));
    }
    match script::parse_for_engine(sql, script::TransactionEngine::MySql)?.as_slice() {
        [script::Item::Sql(_)] => Ok(()),
        _ => Err(AppError::new(
            "MySQL driver refused a multi-statement or COPY query",
        )),
    }
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
    // `column_type` (not `data_type`) keeps the length/precision — the Modify dialog's
    // MODIFY COLUMN restates the definition, so `varchar` alone would truncate it.
    let q = "SELECT column_name, column_type, is_nullable, column_default, column_key, \
             COALESCE(extra,''), COALESCE(column_comment,'') \
             FROM information_schema.columns \
             WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position";
    let params = mysql_async::Params::Positional(vec![schema.into(), name.into()]);
    let (_c, rows, _a) = mysql_run_params(pool, q, params).await?;

    // Foreign-key columns + the FK constraint shapes, in key order.
    let fk_sql = "SELECT kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_SCHEMA, \
                  kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME \
                  FROM information_schema.KEY_COLUMN_USAGE kcu \
                  WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ? AND kcu.REFERENCED_TABLE_NAME IS NOT NULL \
                  ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION";
    let fk_rows = mysql_run_params(
        pool,
        fk_sql,
        mysql_async::Params::Positional(vec![schema.into(), name.into()]),
    )
    .await
    .map(|(_c, rs, _a)| rs)
    .unwrap_or_default();
    let fk_cols: std::collections::HashSet<String> = fk_rows.iter().map(|r| dcell(r, 1)).collect();

    let columns = rows
        .iter()
        .map(|r| {
            let cname = dcell(r, 0);
            let comment = dcell(r, 6);
            let column_type = dcell(r, 1);
            let extra = dcell(r, 5);
            tree::Column {
                identity: extra.to_ascii_lowercase().contains("auto_increment"),
                is_fk: fk_cols.contains(&cname),
                nullable: dcell(r, 2).eq_ignore_ascii_case("YES"),
                is_pk: dcell(r, 4) == "PRI",
                default: r
                    .get(3)
                    .and_then(|v| v.clone())
                    .map(|d| mysql_default_expr(&d, &column_type, &extra)),
                comment: if comment.is_empty() {
                    None
                } else {
                    Some(comment)
                },
                data_type: column_type,
                name: cname,
            }
        })
        .collect();

    // Indexes: information_schema.statistics has one row per (index, column).
    let idx_sql = "SELECT index_name, non_unique, column_name FROM information_schema.statistics \
                   WHERE table_schema = ? AND table_name = ? ORDER BY index_name, seq_in_index";
    let idx_rows = mysql_run_params(
        pool,
        idx_sql,
        mysql_async::Params::Positional(vec![schema.into(), name.into()]),
    )
    .await
    .map(|(_c, rs, _a)| rs)
    .unwrap_or_default();
    let mut indexes: Vec<tree::Index> = Vec::new();
    let mut index_cols: Vec<(String, Vec<String>)> = Vec::new();
    for r in &idx_rows {
        let iname = dcell(r, 0);
        let unique = dcell(r, 1) == "0";
        match indexes.last_mut() {
            Some(last) if last.name == iname => {}
            _ => {
                indexes.push(tree::Index {
                    name: iname.clone(),
                    unique,
                    primary: iname == "PRIMARY",
                    def: String::new(),
                });
                index_cols.push((iname.clone(), Vec::new()));
            }
        }
        if let Some((_n, cols)) = index_cols.last_mut() {
            cols.push(dcell(r, 2));
        }
    }
    for (ix, (_n, cols)) in indexes.iter_mut().zip(index_cols.iter()) {
        let quoted: Vec<String> = cols.iter().map(|c| db::ident(c)).collect();
        ix.def = if ix.primary {
            format!("PRIMARY KEY ({})", quoted.join(", "))
        } else {
            format!(
                "{}INDEX {} ({})",
                if ix.unique { "UNIQUE " } else { "" },
                db::ident(&ix.name),
                quoted.join(", ")
            )
        };
    }

    // Constraints: PK/UNIQUE from the index list, FKs grouped above, CHECKs from 8.0.16+.
    let mut constraints: Vec<tree::Constraint> = Vec::new();
    for (ix, (_n, cols)) in indexes.iter().zip(index_cols.iter()) {
        if !ix.unique {
            continue;
        }
        let quoted: Vec<String> = cols.iter().map(|c| db::ident(c)).collect();
        constraints.push(tree::Constraint {
            name: ix.name.clone(),
            kind: if ix.primary { "primary_key" } else { "unique" }.to_string(),
            def: format!(
                "{} ({})",
                if ix.primary { "PRIMARY KEY" } else { "UNIQUE" },
                quoted.join(", ")
            ),
        });
    }
    let mut fk_groups: Vec<MySqlFkGroup> = Vec::new();
    for r in &fk_rows {
        let cname = dcell(r, 0);
        let entry = match fk_groups.iter_mut().find(|g| g.name == cname) {
            Some(e) => e,
            None => {
                fk_groups.push(MySqlFkGroup {
                    name: cname,
                    cols: Vec::new(),
                    ref_schema: dcell(r, 2),
                    ref_table: dcell(r, 3),
                    ref_cols: Vec::new(),
                });
                fk_groups.last_mut().expect("just pushed")
            }
        };
        entry.cols.push(db::ident(&dcell(r, 1)));
        entry.ref_cols.push(db::ident(&dcell(r, 4)));
    }
    for g in fk_groups {
        constraints.push(tree::Constraint {
            name: g.name,
            kind: "foreign_key".to_string(),
            def: format!(
                "FOREIGN KEY ({}) REFERENCES {}.{} ({})",
                g.cols.join(", "),
                db::ident(&g.ref_schema),
                db::ident(&g.ref_table),
                g.ref_cols.join(", ")
            ),
        });
    }
    let check_sql = "SELECT cc.CONSTRAINT_NAME, cc.CHECK_CLAUSE \
                     FROM information_schema.CHECK_CONSTRAINTS cc \
                     JOIN information_schema.TABLE_CONSTRAINTS tc \
                       ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA \
                      AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME \
                     WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? ORDER BY cc.CONSTRAINT_NAME";
    // CHECK_CONSTRAINTS only exists on MySQL 8.0.16+ — a missing view is not an error.
    if let Ok((_c, crows, _a)) = mysql_run_params(
        pool,
        check_sql,
        mysql_async::Params::Positional(vec![schema.into(), name.into()]),
    )
    .await
    {
        for r in &crows {
            constraints.push(tree::Constraint {
                name: dcell(r, 0),
                kind: "check".to_string(),
                def: format!("CHECK ({})", dcell(r, 1)),
            });
        }
    }

    let comment = mysql_run_params(
        pool,
        "SELECT COALESCE(table_comment,'') FROM information_schema.tables \
         WHERE table_schema = ? AND table_name = ?",
        mysql_async::Params::Positional(vec![schema.into(), name.into()]),
    )
    .await
    .ok()
    .and_then(|(_c, rs, _a)| rs.first().map(|r| dcell(r, 0)))
    .filter(|s| !s.is_empty());

    let triggers = mysql_run_params(
        pool,
        "SELECT trigger_name, CONCAT(action_timing,' ',event_manipulation,' ON ',event_object_table) \
         FROM information_schema.triggers \
         WHERE event_object_schema = ? AND event_object_table = ? ORDER BY trigger_name",
        mysql_async::Params::Positional(vec![schema.into(), name.into()]),
    )
    .await
    .map(|(_c, rs, _a)| {
        rs.iter()
            .map(|r| tree::Trigger {
                name: dcell(r, 0),
                def: dcell(r, 1),
            })
            .collect()
    })
    .unwrap_or_default();

    Ok(tree::RelationDetail {
        name: name.to_string(),
        kind: "table".to_string(),
        comment,
        columns,
        indexes,
        constraints,
        triggers,
    })
}

// --- SQL Server (tiberius / TDS) ---

type MsSqlStream = tokio_util::compat::Compat<tokio::net::TcpStream>;
type MsSqlClient = tiberius::Client<MsSqlStream>;

/// A live SQL Server connection. tiberius owns one TDS session and is neither a pool
/// nor `Sync`, so the client sits behind an async mutex: `Backend` methods that only
/// take `&self` (introspection, script runs, export feeds) still need exclusive access
/// to the socket. The per-connection `AsyncMutex` in the registry already serializes
/// commands, so this lock is effectively uncontended.
///
/// Paging has no server cursor: `stream_sql` plus `offset` re-derive each page with
/// `OFFSET … ROWS FETCH NEXT … ROWS ONLY`, and `paging` records which of the three
/// T-SQL forms is safe for that statement (see `script::mssql_paging`).
pub struct MsSqlConn {
    client: tokio::sync::Mutex<MsSqlClient>,
    pub config: ConnectionConfig,
    pub stream_sql: Option<String>,
    pub offset: usize,
    paging: script::MsSqlPaging,
    /// Latched transport failure — tiberius has no `is_closed`, so a lost socket is
    /// remembered here and `ensure_alive` re-dials before the next explicit command.
    dead: std::sync::atomic::AtomicBool,
    /// The tracked manual transaction no longer exists on the server.
    manual_lost: bool,
    /// SQL Server reported `XACT_STATE() = -1`: the transaction can only be rolled back.
    doomed: bool,
    /// Owns the SSH session for this connection; dropping it closes the tunnel.
    tunnel: Option<crate::ssh::Tunnel>,
}

fn mssql_err(error: tiberius::error::Error) -> AppError {
    // tiberius' Display for a server token is already the SQL Server message text.
    AppError::new(error.to_string())
}

/// `[bracket]` identifier quoting (`]` doubles), the T-SQL form Tusk emits everywhere.
fn mssql_ident(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

fn mssql_lit(value: &str) -> String {
    format!("N'{}'", value.replace('\'', "''"))
}

/// Render a `numeric`/`decimal` from its unscaled integer and scale. tiberius' own
/// `Display` composes `int_part` and `dec_part` separately, which prints `-1.-50`
/// for negative values.
fn mssql_numeric(value: tiberius::numeric::Numeric) -> String {
    let scale = value.scale() as usize;
    let raw = value.value();
    let sign = if raw < 0 { "-" } else { "" };
    let digits = raw.unsigned_abs().to_string();
    if scale == 0 {
        return format!("{sign}{digits}");
    }
    let padded = if digits.len() <= scale {
        format!("{}{digits}", "0".repeat(scale + 1 - digits.len()))
    } else {
        digits
    };
    let split = padded.len() - scale;
    format!("{sign}{}.{}", &padded[..split], &padded[split..])
}

/// One TDS value as the text-or-NULL cell that crosses IPC. Binary columns use the
/// same reversible lowercase `\x…` hex as every other driver; `bit` renders
/// `true`/`false` so the grid's boolean heuristic and export share one vocabulary.
fn mssql_value(data: &tiberius::ColumnData<'static>) -> Result<Option<String>, AppError> {
    use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime};
    use tiberius::ColumnData as C;
    use tiberius::FromSql;

    fn temporal<'a, T: FromSql<'a>>(
        data: &'a tiberius::ColumnData<'static>,
    ) -> Result<Option<T>, AppError> {
        T::from_sql(data).map_err(mssql_err)
    }

    Ok(match data {
        C::U8(v) => v.map(|n| n.to_string()),
        C::I16(v) => v.map(|n| n.to_string()),
        C::I32(v) => v.map(|n| n.to_string()),
        C::I64(v) => v.map(|n| n.to_string()),
        C::F32(v) => v.map(|n| n.to_string()),
        C::F64(v) => v.map(|n| n.to_string()),
        C::Bit(v) => v.map(|b| if b { "true" } else { "false" }.to_string()),
        C::String(v) => v.as_ref().map(|s| s.to_string()),
        C::Guid(v) => v.map(|g| g.to_string()),
        C::Binary(v) => v.as_ref().map(|b| binary_text(b)),
        C::Numeric(v) => v.map(mssql_numeric),
        C::Xml(v) => v.as_ref().map(|x| x.as_ref().to_string()),
        C::DateTime(_) | C::SmallDateTime(_) | C::DateTime2(_) => {
            temporal::<NaiveDateTime>(data)?.map(|t| t.format("%Y-%m-%d %H:%M:%S%.f").to_string())
        }
        C::Date(_) => temporal::<NaiveDate>(data)?.map(|d| d.format("%Y-%m-%d").to_string()),
        C::Time(_) => temporal::<NaiveTime>(data)?.map(|t| t.format("%H:%M:%S%.f").to_string()),
        C::DateTimeOffset(_) => temporal::<DateTime<FixedOffset>>(data)?
            .map(|t| t.format("%Y-%m-%d %H:%M:%S%.f %:z").to_string()),
    })
}

/// Drain one `QueryStream` into bounded text rows. A second result set is rejected —
/// the app's contract is one result per statement, and silently keeping the first
/// would hide half the output.
async fn mssql_collect(
    mut stream: tiberius::QueryStream<'_>,
    limits: db::TextLimits,
) -> Result<TextRows, AppError> {
    use futures_util::TryStreamExt;

    let columns: Vec<String> = match stream.columns().await.map_err(mssql_err)? {
        Some(columns) => columns.iter().map(|c| c.name().to_string()).collect(),
        None => Vec::new(),
    };
    let mut budget = db::TextBudget::new(&columns, limits)?;
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    while let Some(item) = stream.try_next().await.map_err(mssql_err)? {
        if item
            .as_metadata()
            .is_some_and(|meta| meta.result_index() > 0)
        {
            return Err(AppError::new(
                "database returned multiple result sets where one was expected",
            ));
        }
        let Some(row) = item.into_row() else { continue };
        if row.result_index() > 0 {
            return Err(AppError::new(
                "database returned multiple result sets where one was expected",
            ));
        }
        let mut out = Vec::with_capacity(columns.len());
        for (_column, data) in row.cells() {
            out.push(mssql_value(data)?);
        }
        budget.add_row(&out)?;
        rows.push(out);
    }
    Ok((columns, rows))
}

/// Reject anything but one plain statement before it reaches the session. The command
/// layer already splits, but the driver must not be the one path with a single check.
fn mssql_single_statement(sql: &str) -> Result<(), AppError> {
    match script::parse_for_engine(sql, script::TransactionEngine::MsSql)?.as_slice() {
        [script::Item::Sql(_)] => Ok(()),
        _ => Err(AppError::new(
            "SQL Server driver refused a multi-statement or COPY query",
        )),
    }
}

impl MsSqlConn {
    /// `tunnel` is `None` for a fresh connect (one is opened when the config asks for
    /// SSH); `reopen` hands the live tunnel back in so a reconnect reuses the session.
    async fn open(
        config: &ConnectionConfig,
        tunnel: Option<crate::ssh::Tunnel>,
    ) -> Result<(Backend, String), AppError> {
        if config.user.trim().is_empty() {
            return Err(AppError::new(
                "SQL Server integrated (Windows) authentication isn't supported yet — enter a SQL login and password",
            ));
        }
        // The tunnel comes up first so a failure names the SSH stage, not the DB.
        let tunnel = crate::ssh::ensure(tunnel, config).await?;
        let dial = crate::ssh::dial_config(config, tunnel.as_ref());
        let client = Self::open_client(&dial)
            .await
            .map_err(|e| crate::ssh::explain_db_failure(tunnel.as_ref(), e))?;
        let conn = MsSqlConn {
            client: tokio::sync::Mutex::new(client),
            config: config.clone(),
            stream_sql: None,
            offset: 0,
            paging: script::MsSqlPaging::Buffered,
            dead: std::sync::atomic::AtomicBool::new(false),
            manual_lost: false,
            doomed: false,
            tunnel,
        };
        let version = conn
            .query_text(
                "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128))",
                db::CATALOG_TEXT_LIMITS,
            )
            .await
            .ok()
            .and_then(|(_c, rows)| rows.into_iter().next())
            .and_then(|row| row.into_iter().next().flatten())
            .unwrap_or_else(|| "unknown".to_string());
        Ok((
            Backend::MsSql(Box::new(conn)),
            format!("SQL Server {version}"),
        ))
    }

    async fn open_client(config: &ConnectionConfig) -> Result<MsSqlClient, AppError> {
        use tokio_util::compat::TokioAsyncWriteCompatExt;

        let mut cfg = tiberius::Config::new();
        cfg.host(&config.host);
        cfg.port(if config.port == 0 { 1433 } else { config.port });
        if !config.dbname.is_empty() {
            cfg.database(&config.dbname);
        }
        cfg.application_name("Tusk");
        cfg.authentication(tiberius::AuthMethod::sql_server(
            &config.user,
            &config.password,
        ));
        // libpq-shaped sslmode: `disable` turns TDS encryption off entirely, `prefer`
        // and `require` encrypt without verifying the certificate, and the `verify-*`
        // modes encrypt and validate against the system trust store.
        match config.sslmode.as_deref().unwrap_or("prefer") {
            "disable" => cfg.encryption(tiberius::EncryptionLevel::NotSupported),
            "verify-ca" | "verify-full" => cfg.encryption(tiberius::EncryptionLevel::Required),
            _ => {
                cfg.encryption(tiberius::EncryptionLevel::Required);
                cfg.trust_cert();
            }
        }
        let addr = cfg.get_addr();
        let tcp = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            tokio::net::TcpStream::connect(&addr),
        )
        .await
        .map_err(|_| AppError::new(format!("timed out connecting to {addr}")))?
        .map_err(de)?;
        tcp.set_nodelay(true).map_err(de)?;
        tiberius::Client::connect(cfg, tcp.compat_write())
            .await
            .map_err(mssql_err)
    }

    fn is_dead(&self) -> bool {
        self.dead.load(Ordering::Acquire)
    }

    fn reset_stream(&mut self) {
        self.stream_sql = None;
        self.offset = 0;
        self.paging = script::MsSqlPaging::Buffered;
    }

    /// Latch transport-level failures so `ensure_alive` re-dials instead of replaying
    /// commands over a dead socket. Server-reported SQL errors leave the session usable.
    fn note_error(&self, error: &AppError) -> AppError {
        // Only tiberius' I/O and protocol errors qualify: a server-reported SQL error
        // ("Token error: …") leaves the session perfectly usable, and treating one as a
        // lost connection would wrongly declare an owned manual transaction lost.
        // Matching is on the two `Display` prefixes because either can surface from
        // inside `mssql_collect` as well as from the initial request.
        const TRANSPORT_PREFIXES: [&str; 2] = [
            "An error occurred during the attempt of performing I/O",
            "Protocol error",
        ];
        if TRANSPORT_PREFIXES
            .iter()
            .any(|prefix| error.message.starts_with(prefix))
        {
            self.dead.store(true, Ordering::Release);
        }
        AppError::new(error.message.clone())
    }

    async fn run_text(&self, sql: &str, limits: db::TextLimits) -> Result<TextRows, AppError> {
        let mut client = self.client.lock().await;
        let result = async {
            let stream = client.simple_query(sql).await.map_err(mssql_err)?;
            mssql_collect(stream, limits).await
        }
        .await;
        result.map_err(|error| self.note_error(&error))
    }

    async fn query_text(&self, sql: &str, limits: db::TextLimits) -> Result<TextRows, AppError> {
        self.run_text(sql, limits).await
    }

    /// Catalog read with `@P1…` parameters. Runs through `sp_executesql`, which is safe
    /// for reads: it never changes the outer session's transaction or database.
    async fn query_params(
        &self,
        sql: &str,
        params: &[&str],
        limits: db::TextLimits,
    ) -> Result<TextRows, AppError> {
        let mut client = self.client.lock().await;
        let result = async {
            let bound: Vec<&dyn tiberius::ToSql> =
                params.iter().map(|p| p as &dyn tiberius::ToSql).collect();
            let stream = client.query(sql, &bound).await.map_err(mssql_err)?;
            mssql_collect(stream, limits).await
        }
        .await;
        result.map_err(|error| self.note_error(&error))
    }

    /// Rows touched by the previous statement on this session. `@@ROWCOUNT` is session
    /// state that survives the batch boundary, so a follow-up batch reads the count the
    /// user's statement produced. Best-effort: a failure just omits the count.
    async fn last_rowcount(&self) -> Option<u64> {
        self.run_text("SELECT @@ROWCOUNT", db::CATALOG_TEXT_LIMITS)
            .await
            .ok()
            .and_then(|(_c, rows)| rows.into_iter().next())
            .and_then(|row| row.into_iter().next().flatten())
            .and_then(|value| value.parse::<u64>().ok())
    }

    fn page_sql(base: &str, paging: script::MsSqlPaging, limit: u32, offset: usize) -> String {
        // The newline matters: a statement ending in a `--` comment would otherwise
        // swallow the appended clause.
        match paging {
            script::MsSqlPaging::Append => {
                format!("{base}\nOFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY")
            }
            // T-SQL requires an ORDER BY before OFFSET/FETCH; `(SELECT NULL)` is the
            // documented no-op sort. Row order is then engine-defined across pages,
            // exactly like MySQL's LIMIT/OFFSET without ORDER BY.
            _ => format!(
                "{base}\nORDER BY (SELECT NULL)\nOFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY"
            ),
        }
    }

    async fn run_single(
        &mut self,
        trimmed: &str,
        page: u32,
        cursorable: bool,
        manual: bool,
    ) -> Result<QueryOutcome, AppError> {
        mssql_single_statement(trimmed)?;
        let paging = script::mssql_paging(trimmed);
        let outcome = self
            .run_single_inner(trimmed, page, cursorable, paging)
            .await;
        if manual {
            // Probe even when the statement failed: that is exactly when SQL Server may
            // have doomed (XACT_STATE = -1) or already unwound the transaction.
            self.verify_manual(true).await?;
        }
        outcome
    }

    async fn run_single_inner(
        &mut self,
        trimmed: &str,
        page: u32,
        cursorable: bool,
        paging: script::MsSqlPaging,
    ) -> Result<QueryOutcome, AppError> {
        if cursorable && paging != script::MsSqlPaging::Buffered {
            let sql = Self::page_sql(trimmed, paging, page, 0);
            let (columns, rows) = self.run_text(&sql, db::USER_TEXT_LIMITS).await?;
            let done = (rows.len() as u32) < page;
            if done {
                self.reset_stream();
            } else {
                self.stream_sql = Some(trimmed.to_string());
                self.offset = page as usize;
                self.paging = paging;
            }
            return Ok(QueryOutcome::Rows {
                columns,
                rows,
                done,
                note: None,
            });
        }
        let (columns, rows) = self.run_text(trimmed, db::USER_TEXT_LIMITS).await?;
        if columns.is_empty() {
            let message = if script::is_ddl(trimmed) {
                "OK".to_string()
            } else {
                match self.last_rowcount().await {
                    Some(n) => format!("OK ({n} rows affected)"),
                    None => "OK".to_string(),
                }
            };
            return Ok(QueryOutcome::Exec { message });
        }
        Ok(QueryOutcome::Rows {
            columns,
            rows,
            done: true,
            // A statement Tusk cannot page safely (TOP, its own OFFSET/FETCH,
            // FOR XML/JSON, OPTION, or an unordered set operation) is read once
            // under the result budget instead of being silently truncated.
            note: (cursorable && paging == script::MsSqlPaging::Buffered).then(|| {
                "read in one page — SQL Server can't page this statement shape".to_string()
            }),
        })
    }

    async fn fetch_page(&mut self, page: u32) -> Result<FetchResult, AppError> {
        let (base, paging) = match &self.stream_sql {
            Some(base) => (base.clone(), self.paging),
            None => {
                return Ok(FetchResult {
                    rows: vec![],
                    done: true,
                })
            }
        };
        let sql = Self::page_sql(&base, paging, page, self.offset);
        let (_columns, rows) = self.run_text(&sql, db::USER_TEXT_LIMITS).await?;
        let done = (rows.len() as u32) < page;
        self.offset += rows.len();
        if done {
            self.stream_sql = None;
        }
        Ok(FetchResult { rows, done })
    }

    /// `@@TRANCOUNT` plus `XACT_STATE()` for the tracked manual transaction. The server
    /// is authoritative: a transaction that ended underneath Tusk must become `Lost`
    /// rather than silently accepting further work.
    async fn verify_manual(&mut self, expect_active: bool) -> Result<(), AppError> {
        let probe = self
            .run_text(
                "SELECT @@TRANCOUNT, CAST(XACT_STATE() AS int)",
                db::CATALOG_TEXT_LIMITS,
            )
            .await;
        let row = match probe {
            Ok((_c, rows)) => rows.into_iter().next(),
            Err(error) => {
                self.manual_lost = true;
                return Err(AppError::new(format!(
                    "SQL Server manual transaction status is unavailable: {}",
                    error.message
                )));
            }
        };
        let read = |row: &Vec<Option<String>>, index: usize| -> i64 {
            row.get(index)
                .and_then(|v| v.as_deref())
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(0)
        };
        let Some(row) = row else {
            self.manual_lost = true;
            return Err(AppError::new(
                "SQL Server returned no transaction status row",
            ));
        };
        let trancount = read(&row, 0);
        let xact_state = read(&row, 1);
        self.doomed = xact_state == -1;
        if expect_active && trancount == 0 {
            self.manual_lost = true;
            return Err(AppError::new(
                "SQL Server ended the manual transaction unexpectedly; reconnect required",
            ));
        }
        Ok(())
    }

    async fn run_transaction_statement(
        &mut self,
        sql: &str,
        action: script::TransactionAction,
    ) -> Result<QueryOutcome, AppError> {
        mssql_single_statement(sql)?;
        let result = self.run_text(sql, db::USER_TEXT_LIMITS).await;
        let ends_unit = matches!(
            action,
            script::TransactionAction::Commit | script::TransactionAction::Rollback
        );
        // A failed COMMIT/ROLLBACK may leave the unit open; verify against the server
        // either way rather than trusting the statement's own success.
        self.verify_manual(!ends_unit && result.is_ok()).await?;
        let (columns, rows) = result?;
        if matches!(
            action,
            script::TransactionAction::Rollback | script::TransactionAction::RollbackTo
        ) {
            self.doomed = false;
        }
        Ok(if columns.is_empty() {
            QueryOutcome::Exec {
                message: "OK".to_string(),
            }
        } else {
            QueryOutcome::Rows {
                columns,
                rows,
                done: true,
                note: None,
            }
        })
    }

    async fn rollback_manual(&mut self) {
        let _ = self
            .run_text(
                "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION",
                db::CATALOG_TEXT_LIMITS,
            )
            .await;
        self.manual_lost = false;
        self.doomed = false;
    }

    /// One app-owned transaction around an ordinary multi-statement script. Each item
    /// runs as its own TDS batch, so batch-leading DDL (`CREATE VIEW`, `CREATE PROCEDURE`)
    /// still works. `XACT_ABORT ON` makes any runtime error abort the whole unit instead
    /// of leaving earlier statements committed, and is restored afterwards because it is
    /// session state the user's own SQL would otherwise inherit.
    async fn run_script(&self, items: &[script::Item]) -> Result<String, AppError> {
        self.run_text("SET XACT_ABORT ON", db::CATALOG_TEXT_LIMITS)
            .await?;
        let outcome = self.run_script_inner(items).await;
        let _ = self
            .run_text("SET XACT_ABORT OFF", db::CATALOG_TEXT_LIMITS)
            .await;
        outcome
    }

    async fn run_script_inner(&self, items: &[script::Item]) -> Result<String, AppError> {
        self.run_text("BEGIN TRANSACTION", db::CATALOG_TEXT_LIMITS)
            .await?;
        let mut stmts = 0u64;
        for item in items {
            let script::Item::Sql(sql) = item else {
                continue;
            };
            if let Err(error) = self.run_text(sql.trim(), db::USER_TEXT_LIMITS).await {
                let _ = self
                    .run_text(
                        "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION",
                        db::CATALOG_TEXT_LIMITS,
                    )
                    .await;
                return Err(AppError::new(format!(
                    "{} — at statement {} ({})",
                    error.message,
                    stmts + 1,
                    sql.lines()
                        .next()
                        .unwrap_or("")
                        .chars()
                        .take(70)
                        .collect::<String>()
                )));
            }
            stmts += 1;
        }
        self.run_text("COMMIT TRANSACTION", db::CATALOG_TEXT_LIMITS)
            .await
            .map_err(|error| {
                AppError::new(format!(
                    "commit acknowledgement failed; transaction outcome is unknown — verify database state before retrying ({})",
                    error.message
                ))
            })?;
        Ok(format!("OK — {stmts} statements run, 0 rows copied"))
    }

    /// Result-column types without executing anything: `sys.dm_exec_describe_first_result_set`
    /// parses and binds the batch only. Best-effort — any failure means no boolean mapping.
    async fn bool_columns(&self, sql: &str) -> Vec<usize> {
        let query = format!(
            "SELECT column_ordinal, system_type_name FROM sys.dm_exec_describe_first_result_set({}, NULL, 0)",
            mssql_lit(sql)
        );
        let Ok((_columns, rows)) = self.query_text(&query, db::CATALOG_TEXT_LIMITS).await else {
            return Vec::new();
        };
        rows.iter()
            .filter(|row| dcell(row, 1).eq_ignore_ascii_case("bit"))
            .filter_map(|row| dcell(row, 0).parse::<usize>().ok())
            .filter_map(|ordinal| ordinal.checked_sub(1))
            .collect()
    }

    async fn object_id(&self, schema: &str, name: &str) -> Result<i64, AppError> {
        let (_columns, rows) = self
            .query_params(
                "SELECT o.object_id FROM sys.objects o \
                 JOIN sys.schemas s ON s.schema_id = o.schema_id \
                 WHERE s.name = @P1 AND o.name = @P2",
                &[schema, name],
                db::CATALOG_TEXT_LIMITS,
            )
            .await?;
        rows.first()
            .and_then(|row| dcell(row, 0).parse::<i64>().ok())
            .ok_or_else(|| AppError::new(format!("no such relation: {schema}.{name}")))
    }

    async fn build_tree(&self) -> Result<tree::DbTree, AppError> {
        let (_c, schema_rows) = self
            .query_text(MSSQL_SCHEMAS, db::CATALOG_TEXT_LIMITS)
            .await?;
        let (_c2, rel_rows) = self.query_text(MSSQL_RELS, db::CATALOG_TEXT_LIMITS).await?;
        let (_c3, seq_rows) = self.query_text(MSSQL_SEQS, db::CATALOG_TEXT_LIMITS).await?;
        let (_c4, func_rows) = self
            .query_text(MSSQL_ROUTINES, db::CATALOG_TEXT_LIMITS)
            .await?;
        let database = self
            .query_text("SELECT DB_NAME()", db::CATALOG_TEXT_LIMITS)
            .await
            .ok()
            .and_then(|(_c, rows)| rows.into_iter().next())
            .and_then(|row| row.into_iter().next().flatten())
            .unwrap_or_default();
        let databases = self
            .query_text(
                "SELECT name FROM sys.databases ORDER BY name",
                db::CATALOG_TEXT_LIMITS,
            )
            .await
            .map(|(_c, rows)| rows.iter().map(|row| dcell(row, 0)).collect())
            .unwrap_or_else(|_| vec![database.clone()]);

        let mut schemas: Vec<tree::Schema> = schema_rows
            .iter()
            .map(|row| tree::Schema {
                name: dcell(row, 0),
                tables: vec![],
                views: vec![],
                sequences: vec![],
                functions: vec![],
            })
            .collect();
        let index: std::collections::HashMap<String, usize> = schemas
            .iter()
            .enumerate()
            .map(|(i, s)| (s.name.clone(), i))
            .collect();
        for row in &rel_rows {
            let Some(&i) = index.get(&dcell(row, 0)) else {
                continue;
            };
            let is_view = dcell(row, 2).eq_ignore_ascii_case("VIEW");
            let stub = tree::RelStub {
                name: dcell(row, 1),
                kind: if is_view { "view" } else { "table" }.to_string(),
                comment: row.get(5).cloned().flatten(),
                rows: row
                    .get(3)
                    .and_then(|v| v.as_deref())
                    .and_then(|v| v.parse().ok()),
                size: row
                    .get(4)
                    .and_then(|v| v.as_deref())
                    .and_then(|v| v.parse::<i64>().ok())
                    .map(mssql_pretty_kb),
            };
            if is_view {
                schemas[i].views.push(stub);
            } else {
                schemas[i].tables.push(stub);
            }
        }
        for row in &seq_rows {
            if let Some(&i) = index.get(&dcell(row, 0)) {
                schemas[i].sequences.push(dcell(row, 1));
            }
        }
        for row in &func_rows {
            if let Some(&i) = index.get(&dcell(row, 0)) {
                schemas[i].functions.push(tree::Func {
                    name: dcell(row, 1),
                    args: String::new(),
                    returns: dcell(row, 2),
                });
            }
        }
        Ok(tree::DbTree {
            database,
            databases,
            schemas,
        })
    }

    async fn table_detail(
        &self,
        schema: &str,
        name: &str,
    ) -> Result<tree::RelationDetail, AppError> {
        let oid = self.object_id(schema, name).await?;
        let (_c, column_rows) = self
            .query_text(&mssql_columns_sql(oid), db::CATALOG_TEXT_LIMITS)
            .await?;
        let columns = column_rows
            .iter()
            .map(|row| tree::Column {
                name: dcell(row, 0),
                data_type: dcell(row, 1),
                nullable: dcell(row, 2) == "1",
                is_pk: dcell(row, 4) == "1",
                is_fk: dcell(row, 5) == "1",
                default: row.get(3).cloned().flatten(),
                comment: row.get(6).cloned().flatten(),
                identity: dcell(row, 7) == "1",
            })
            .collect();
        let (_c2, index_rows) = self
            .query_text(&mssql_indexes_sql(oid), db::CATALOG_TEXT_LIMITS)
            .await
            .unwrap_or_default();
        let qualified = format!("{}.{}", mssql_ident(schema), mssql_ident(name));
        let indexes = index_rows
            .iter()
            .map(|row| {
                let unique = dcell(row, 1) == "1";
                let primary = dcell(row, 2) == "1";
                tree::Index {
                    def: format!(
                        "CREATE {}INDEX {} ON {qualified} ({})",
                        if unique { "UNIQUE " } else { "" },
                        mssql_ident(&dcell(row, 0)),
                        dcell(row, 3)
                    ),
                    name: dcell(row, 0),
                    unique,
                    primary,
                }
            })
            .collect();
        let (_c3, constraint_rows) = self
            .query_text(&mssql_constraints_sql(oid), db::CATALOG_TEXT_LIMITS)
            .await
            .unwrap_or_default();
        let constraints = constraint_rows
            .iter()
            .map(|row| tree::Constraint {
                name: dcell(row, 0),
                kind: dcell(row, 1),
                def: dcell(row, 2),
            })
            .collect();
        let (_c4, trigger_rows) = self
            .query_text(&mssql_triggers_sql(oid), db::CATALOG_TEXT_LIMITS)
            .await
            .unwrap_or_default();
        let triggers = trigger_rows
            .iter()
            .map(|row| tree::Trigger {
                name: dcell(row, 0),
                def: dcell(row, 1),
            })
            .collect();
        let (_c5, kind_rows) = self
            .query_text(
                &format!("SELECT type FROM sys.objects WHERE object_id = {oid}"),
                db::CATALOG_TEXT_LIMITS,
            )
            .await
            .unwrap_or_default();
        let kind = match kind_rows.first().map(|row| dcell(row, 0)).as_deref() {
            Some(t) if t.trim() == "V" => "view",
            _ => "table",
        };
        Ok(tree::RelationDetail {
            name: name.to_string(),
            kind: kind.to_string(),
            comment: None,
            columns,
            indexes,
            constraints,
            triggers,
        })
    }

    /// `(constraint, src_schema, src_table, src_col, dst_schema, dst_table, dst_col)`
    /// rows ordered by constraint then key position — the shape `relgraph`'s grouping
    /// helpers expect.
    async fn fk_edge_rows(
        &self,
        scope: Option<(&str, &str)>,
    ) -> Result<Vec<Vec<Option<String>>>, AppError> {
        let sql = mssql_fk_sql(scope.is_some());
        let params: Vec<&str> = match scope {
            Some((schema, name)) => vec![schema, name, schema, name],
            None => vec![],
        };
        let (_columns, rows) = self
            .query_params(&sql, &params, db::CATALOG_TEXT_LIMITS)
            .await?;
        Ok(rows)
    }

    /// `(table, column, data_type, key)` rows for the ERD, with `PRI` marking primary-key
    /// columns (the marker `relgraph::mysql_schema_graph` reads).
    async fn erd_column_rows(&self, schema: &str) -> Result<Vec<Vec<Option<String>>>, AppError> {
        let (_columns, rows) = self
            .query_params(MSSQL_ERD_COLUMNS, &[schema], db::CATALOG_TEXT_LIMITS)
            .await?;
        Ok(rows)
    }

    async fn relation_ddl(&self, kind: &str, schema: &str, name: &str) -> Result<String, AppError> {
        let oid = self.object_id(schema, name).await?;
        if kind != "table" {
            // Views, procedures, functions and triggers keep their original text.
            let (_c, rows) = self
                .query_text(
                    &format!("SELECT definition FROM sys.sql_modules WHERE object_id = {oid}"),
                    db::DDL_TEXT_LIMITS,
                )
                .await?;
            if let Some(definition) = rows.first().and_then(|row| row.first().cloned().flatten()) {
                return Ok(format!(
                    "{};\n",
                    definition.trim_end().trim_end_matches(';')
                ));
            }
            return Err(AppError::new("no stored DDL for this object"));
        }
        let qualified = format!("{}.{}", mssql_ident(schema), mssql_ident(name));
        let (_c, column_rows) = self
            .query_text(&mssql_ddl_columns_sql(oid), db::DDL_TEXT_LIMITS)
            .await?;
        if column_rows.is_empty() {
            return Err(AppError::new("no columns found for this table"));
        }
        let mut parts: Vec<String> = column_rows
            .iter()
            .map(|row| {
                let mut line = format!("    {} {}", mssql_ident(&dcell(row, 0)), dcell(row, 1));
                if dcell(row, 4) == "1" {
                    line.push_str(&format!(" IDENTITY({},{})", dcell(row, 5), dcell(row, 6)));
                }
                if dcell(row, 2) == "1" {
                    line.push_str(" NULL");
                } else {
                    line.push_str(" NOT NULL");
                }
                if let Some(default) = row.get(3).cloned().flatten() {
                    line.push_str(&format!(" DEFAULT {default}"));
                }
                line
            })
            .collect();
        let (_c2, constraint_rows) = self
            .query_text(&mssql_constraints_sql(oid), db::DDL_TEXT_LIMITS)
            .await
            .unwrap_or_default();
        for row in &constraint_rows {
            // Foreign keys are deferred to trailing ALTERs so replaying the script in
            // dependency order cannot fail on a table that does not exist yet.
            if dcell(row, 1) == "foreign_key" {
                continue;
            }
            parts.push(format!(
                "    CONSTRAINT {} {}",
                mssql_ident(&dcell(row, 0)),
                dcell(row, 2)
            ));
        }
        let mut out = format!("CREATE TABLE {qualified} (\n{}\n);\n", parts.join(",\n"));
        let (_c3, index_rows) = self
            .query_text(&mssql_ddl_indexes_sql(oid), db::DDL_TEXT_LIMITS)
            .await
            .unwrap_or_default();
        for row in &index_rows {
            out.push_str(&format!(
                "\nCREATE {}INDEX {} ON {qualified} ({});\n",
                if dcell(row, 1) == "1" { "UNIQUE " } else { "" },
                mssql_ident(&dcell(row, 0)),
                dcell(row, 3)
            ));
        }
        for row in &constraint_rows {
            if dcell(row, 1) == "foreign_key" {
                out.push_str(&format!(
                    "\nALTER TABLE {qualified} ADD CONSTRAINT {} {};\n",
                    mssql_ident(&dcell(row, 0)),
                    dcell(row, 2)
                ));
            }
        }
        Ok(out)
    }
}

/// Pretty-print a size given in KiB, mirroring `pg_size_pretty`'s shape.
fn mssql_pretty_kb(kb: i64) -> String {
    let kb = kb.max(0) as f64;
    const UNITS: [&str; 4] = ["kB", "MB", "GB", "TB"];
    let mut value = kb;
    let mut unit = 0usize;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} {}", value.round() as i64, UNITS[unit])
    } else {
        format!("{value:.0} {}", UNITS[unit])
    }
}

// Schemas the server owns or creates for the fixed database roles are noise in the
// sidebar; user schemas always have `schema_id < 16384`.
const MSSQL_SCHEMAS: &str = "SELECT s.name FROM sys.schemas s \
     WHERE s.schema_id < 16384 AND s.name NOT IN ('sys','INFORMATION_SCHEMA','guest') \
     ORDER BY s.name";

const MSSQL_RELS: &str = "SELECT sch.name, o.name, \
       CASE WHEN o.type = 'V' THEN 'VIEW' ELSE 'BASE TABLE' END, \
       CAST(ps.row_count AS varchar(32)), \
       CASE WHEN o.type = 'V' THEN NULL ELSE CAST(ps.total_kb AS varchar(32)) END, \
       CAST(ep.value AS nvarchar(max)) \
     FROM sys.objects o \
     JOIN sys.schemas sch ON sch.schema_id = o.schema_id \
     LEFT JOIN (SELECT object_id, \
                       SUM(CASE WHEN index_id IN (0,1) THEN row_count ELSE 0 END) AS row_count, \
                       SUM(used_page_count) * 8 AS total_kb \
                FROM sys.dm_db_partition_stats GROUP BY object_id) ps \
            ON ps.object_id = o.object_id \
     LEFT JOIN sys.extended_properties ep \
            ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 \
           AND ep.name = 'MS_Description' \
     WHERE o.type IN ('U','V') AND o.is_ms_shipped = 0 AND sch.schema_id < 16384 \
     ORDER BY sch.name, o.name";

const MSSQL_SEQS: &str = "SELECT sch.name, sq.name FROM sys.sequences sq \
     JOIN sys.schemas sch ON sch.schema_id = sq.schema_id ORDER BY sch.name, sq.name";

const MSSQL_ROUTINES: &str = "SELECT sch.name, o.name, \
       CASE o.type WHEN 'P' THEN 'procedure' WHEN 'PC' THEN 'procedure' \
                   WHEN 'IF' THEN 'table function' WHEN 'TF' THEN 'table function' \
                   WHEN 'FT' THEN 'table function' WHEN 'AF' THEN 'aggregate' \
                   ELSE 'function' END \
     FROM sys.objects o JOIN sys.schemas sch ON sch.schema_id = o.schema_id \
     WHERE o.type IN ('FN','IF','TF','P','AF','FS','FT','PC') AND o.is_ms_shipped = 0 \
     ORDER BY sch.name, o.name";

/// Rendered column type with its length/precision, matching how SSMS shows it.
const MSSQL_TYPE_EXPR: &str = "t.name + CASE \
       WHEN t.name IN ('varchar','char','varbinary','binary') \
         THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(11)) END + ')' \
       WHEN t.name IN ('nvarchar','nchar') \
         THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(11)) END + ')' \
       WHEN t.name IN ('decimal','numeric') \
         THEN '(' + CAST(c.precision AS varchar(11)) + ',' + CAST(c.scale AS varchar(11)) + ')' \
       WHEN t.name IN ('datetime2','datetimeoffset','time') \
         THEN '(' + CAST(c.scale AS varchar(11)) + ')' \
       ELSE '' END";

fn mssql_columns_sql(oid: i64) -> String {
    format!(
        "SELECT c.name, {MSSQL_TYPE_EXPR}, CAST(c.is_nullable AS int), dc.definition, \
                CAST(CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS int), \
                CAST(CASE WHEN fk.parent_column_id IS NULL THEN 0 ELSE 1 END AS int), \
                CAST(ep.value AS nvarchar(max)), CAST(c.is_identity AS int) \
         FROM sys.columns c \
         JOIN sys.types t ON t.user_type_id = c.user_type_id \
         LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id \
         LEFT JOIN (SELECT ic.object_id, ic.column_id FROM sys.index_columns ic \
                    JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id \
                    WHERE i.is_primary_key = 1) pk \
                ON pk.object_id = c.object_id AND pk.column_id = c.column_id \
         LEFT JOIN (SELECT DISTINCT parent_object_id, parent_column_id FROM sys.foreign_key_columns) fk \
                ON fk.parent_object_id = c.object_id AND fk.parent_column_id = c.column_id \
         LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = c.object_id \
               AND ep.minor_id = c.column_id AND ep.name = 'MS_Description' \
         WHERE c.object_id = {oid} ORDER BY c.column_id"
    )
}

fn mssql_ddl_columns_sql(oid: i64) -> String {
    format!(
        "SELECT c.name, {MSSQL_TYPE_EXPR}, CAST(c.is_nullable AS int), dc.definition, \
                CAST(c.is_identity AS int), \
                CAST(ISNULL(ic.seed_value, 1) AS varchar(32)), \
                CAST(ISNULL(ic.increment_value, 1) AS varchar(32)) \
         FROM sys.columns c \
         JOIN sys.types t ON t.user_type_id = c.user_type_id \
         LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id \
         LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id \
         WHERE c.object_id = {oid} ORDER BY c.column_id"
    )
}

/// Key columns of one index, in key order. `STRING_AGG` needs SQL Server 2017+.
const MSSQL_INDEX_COLUMNS: &str =
    "STRING_AGG(QUOTENAME(c.name), ', ') WITHIN GROUP (ORDER BY ic.key_ordinal)";

fn mssql_indexes_sql(oid: i64) -> String {
    format!(
        "SELECT i.name, CAST(i.is_unique AS int), CAST(i.is_primary_key AS int), {MSSQL_INDEX_COLUMNS} \
         FROM sys.indexes i \
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
         WHERE i.object_id = {oid} AND i.name IS NOT NULL AND ic.is_included_column = 0 \
         GROUP BY i.name, i.is_unique, i.is_primary_key ORDER BY i.name"
    )
}

/// Plain indexes only — constraint-backed ones are already emitted inline, exactly like
/// the PostgreSQL reconstruction.
fn mssql_ddl_indexes_sql(oid: i64) -> String {
    format!(
        "SELECT i.name, CAST(i.is_unique AS int), CAST(i.is_primary_key AS int), {MSSQL_INDEX_COLUMNS} \
         FROM sys.indexes i \
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
         WHERE i.object_id = {oid} AND i.name IS NOT NULL AND ic.is_included_column = 0 \
           AND i.is_primary_key = 0 AND i.is_unique_constraint = 0 \
         GROUP BY i.name, i.is_unique, i.is_primary_key ORDER BY i.name"
    )
}

fn mssql_constraints_sql(oid: i64) -> String {
    format!(
        "SELECT kc.name, CASE kc.type WHEN 'PK' THEN 'primary_key' ELSE 'unique' END, \
                CASE kc.type WHEN 'PK' THEN 'PRIMARY KEY (' ELSE 'UNIQUE (' END + \
                (SELECT STRING_AGG(QUOTENAME(c.name), ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) \
                 FROM sys.index_columns ic JOIN sys.columns c \
                   ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
                 WHERE ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id \
                   AND ic.is_included_column = 0) + ')' \
         FROM sys.key_constraints kc WHERE kc.parent_object_id = {oid} \
         UNION ALL \
         SELECT fk.name, 'foreign_key', \
                'FOREIGN KEY (' + \
                (SELECT STRING_AGG(QUOTENAME(pc.name), ', ') WITHIN GROUP (ORDER BY fkc.constraint_column_id) \
                 FROM sys.foreign_key_columns fkc JOIN sys.columns pc \
                   ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id \
                 WHERE fkc.constraint_object_id = fk.object_id) + \
                ') REFERENCES ' + QUOTENAME(rs.name) + '.' + QUOTENAME(rt.name) + ' (' + \
                (SELECT STRING_AGG(QUOTENAME(rc.name), ', ') WITHIN GROUP (ORDER BY fkc.constraint_column_id) \
                 FROM sys.foreign_key_columns fkc JOIN sys.columns rc \
                   ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
                 WHERE fkc.constraint_object_id = fk.object_id) + ')' \
         FROM sys.foreign_keys fk \
         JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id \
         JOIN sys.schemas rs ON rs.schema_id = rt.schema_id \
         WHERE fk.parent_object_id = {oid} \
         UNION ALL \
         SELECT cc.name, 'check', 'CHECK ' + cc.definition \
         FROM sys.check_constraints cc WHERE cc.parent_object_id = {oid}"
    )
}

fn mssql_triggers_sql(oid: i64) -> String {
    format!(
        "SELECT tr.name, ISNULL(m.definition, '') FROM sys.triggers tr \
         LEFT JOIN sys.sql_modules m ON m.object_id = tr.object_id \
         WHERE tr.parent_id = {oid} AND tr.is_ms_shipped = 0 ORDER BY tr.name"
    )
}

const MSSQL_FK_SELECT: &str = "SELECT fk.name, ps.name, pt.name, pc.name, rs.name, rt.name, rc.name \
     FROM sys.foreign_keys fk \
     JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
     JOIN sys.tables pt ON pt.object_id = fk.parent_object_id \
     JOIN sys.schemas ps ON ps.schema_id = pt.schema_id \
     JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id \
     JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id \
     JOIN sys.schemas rs ON rs.schema_id = rt.schema_id \
     JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id";

const MSSQL_FK_ORDER: &str = " ORDER BY fk.name, ps.name, pt.name, fkc.constraint_column_id";

fn mssql_fk_sql(scoped: bool) -> String {
    let filter = if scoped {
        " WHERE (ps.name = @P1 AND pt.name = @P2) OR (rs.name = @P3 AND rt.name = @P4)"
    } else {
        ""
    };
    format!("{MSSQL_FK_SELECT}{filter}{MSSQL_FK_ORDER}")
}

const MSSQL_ERD_COLUMNS: &str = "SELECT t.name, c.name, ty.name, \
       CASE WHEN pk.column_id IS NULL THEN '' ELSE 'PRI' END \
     FROM sys.tables t \
     JOIN sys.schemas s ON s.schema_id = t.schema_id \
     JOIN sys.columns c ON c.object_id = t.object_id \
     JOIN sys.types ty ON ty.user_type_id = c.user_type_id \
     LEFT JOIN (SELECT ic.object_id, ic.column_id FROM sys.index_columns ic \
                JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id \
                WHERE i.is_primary_key = 1) pk \
            ON pk.object_id = c.object_id AND pk.column_id = c.column_id \
     WHERE s.name = @P1 ORDER BY t.name, c.column_id";

/// One connected database in the app registry.
pub struct ConnState {
    pub backend: Backend,
    pub read_only: bool,
    pub transaction: TransactionStatus,
    next_transaction_id: u64,
    pub stream_owner: Option<String>,
}

impl ConnState {
    pub fn new(backend: Backend, read_only: bool) -> Self {
        Self {
            backend,
            read_only,
            transaction: TransactionStatus::default(),
            next_transaction_id: 1,
            stream_owner: None,
        }
    }

    pub fn transaction_engine(&self) -> script::TransactionEngine {
        match &self.backend {
            Backend::Pg(_) => script::TransactionEngine::Postgres,
            Backend::Duck(_) => script::TransactionEngine::DuckDb,
            Backend::Sqlite(_) => script::TransactionEngine::Sqlite,
            Backend::MySql(_) => script::TransactionEngine::MySql,
            Backend::MsSql(_) => script::TransactionEngine::MsSql,
        }
    }

    /// Transaction-ownership gate only. A new run may take over the shared result
    /// stream (it closes the old cursor before executing), so `run_query` must not
    /// be blocked by `stream_owner`; paging and cancel must be (`require_owner`).
    pub fn require_transaction_owner(&self, owner: &str) -> Result<(), AppError> {
        if self.transaction.owns_session() && self.transaction.owner.as_deref() != Some(owner) {
            return Err(AppError::new(format!(
                "manual transaction is owned by `{}`",
                self.transaction.owner.as_deref().unwrap_or("unknown")
            ))
            .with_transaction(self.transaction.clone()));
        }
        Ok(())
    }

    pub fn require_owner(&self, owner: &str) -> Result<(), AppError> {
        self.require_transaction_owner(owner)?;
        if self
            .stream_owner
            .as_deref()
            .is_some_and(|active| active != owner)
        {
            return Err(AppError::new("result stream is owned by another tab")
                .with_transaction(self.transaction.clone()));
        }
        Ok(())
    }

    pub fn require_idle(&self, operation: &str) -> Result<(), AppError> {
        if self.transaction.owns_session() {
            return Err(AppError::new(format!(
                "{operation} is blocked while a manual transaction owns the session"
            ))
            .with_transaction(self.transaction.clone()));
        }
        Ok(())
    }

    fn start_transaction(&mut self, owner: &str, state: TransactionState, mode: TransactionMode) {
        let id = format!("tx-{}", self.next_transaction_id);
        self.next_transaction_id = self.next_transaction_id.saturating_add(1);
        self.transaction.id = Some(id);
        self.transaction.owner = Some(owner.to_string());
        self.transaction.state = state;
        self.transaction.mode = mode;
        self.transaction.health = TransactionHealth::Healthy;
    }

    fn finish_transaction(&mut self) {
        self.transaction.state = TransactionState::Idle;
        self.transaction.id = None;
        self.transaction.owner = None;
        self.transaction.mode = TransactionMode::None;
        self.transaction.health = TransactionHealth::Healthy;
    }

    pub fn apply_transaction_action(&mut self, action: script::TransactionAction, owner: &str) {
        use script::TransactionAction as A;
        match action {
            A::Begin => {
                if self.transaction.state == TransactionState::Configured {
                    self.transaction.state = TransactionState::Active;
                } else {
                    self.start_transaction(
                        owner,
                        TransactionState::Active,
                        TransactionMode::Explicit,
                    );
                }
            }
            A::Commit | A::Rollback => {
                if self.transaction.mode == TransactionMode::AutocommitOff {
                    self.transaction.state = TransactionState::Active;
                    self.transaction.health = TransactionHealth::Healthy;
                } else {
                    self.finish_transaction();
                }
            }
            A::RollbackTo => {
                self.transaction.state = TransactionState::Active;
                self.transaction.health = TransactionHealth::Healthy;
            }
            A::SetTransaction if self.transaction.state == TransactionState::Idle => {
                self.start_transaction(
                    owner,
                    TransactionState::Configured,
                    TransactionMode::Explicit,
                );
            }
            A::AutocommitOff if self.transaction.state == TransactionState::Idle => {
                self.start_transaction(
                    owner,
                    TransactionState::Active,
                    TransactionMode::AutocommitOff,
                );
            }
            A::AutocommitOn => self.finish_transaction(),
            A::Savepoint | A::Release | A::SetTransaction | A::AutocommitOff => {}
        }
        self.transaction.revision = self.transaction.revision.saturating_add(1);
    }

    pub fn mark_transaction_failed(&mut self) {
        if self.transaction.state == TransactionState::Active {
            self.transaction.state = TransactionState::Failed;
            self.transaction.health = TransactionHealth::RecoveryRequired;
            self.transaction.revision = self.transaction.revision.saturating_add(1);
        }
    }

    pub fn mark_transaction_lost(&mut self) {
        if self.transaction.owns_session() && self.transaction.state != TransactionState::Lost {
            self.transaction.state = TransactionState::Lost;
            self.transaction.health = TransactionHealth::Lost;
            self.transaction.revision = self.transaction.revision.saturating_add(1);
        }
    }
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
    (
        v.div_euclid(per_sec),
        (v.rem_euclid(per_sec) * scale) as u32,
    )
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
        V::Blob(bytes) => binary_text(&bytes),
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
            format!(
                "{:02}:{:02}:{:02}{}",
                s / 3600,
                (s % 3600) / 60,
                s % 60,
                duck_frac(nanos)
            )
        }
        // INTERVAL: a readable "N years N months N days HH:MM:SS" (best-effort).
        V::Interval {
            months,
            days,
            nanos,
        } => duck_interval(months, days, nanos),
        // Nested types — recurse so a list/array reads like `[a, b, c]`, a struct like
        // `{'k': v}` (close to DuckDB's VARCHAR form; readable rather than Debug).
        V::List(xs) | V::Array(xs) => {
            format!(
                "[{}]",
                xs.into_iter()
                    .map(duck_value_repr)
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
        V::Struct(m) => {
            let body = m
                .iter()
                .map(|(k, val)| format!("'{k}': {}", duck_value_repr(val.clone())))
                .collect::<Vec<_>>()
                .join(", ");
            format!("{{{body}}}")
        }
        V::Map(m) => {
            let body = m
                .iter()
                .map(|(key, value)| {
                    format!(
                        "{}: {}",
                        duck_value_repr(key.clone()),
                        duck_value_repr(value.clone())
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("{{{body}}}")
        }
        V::Union(value) => duck_value_repr(*value),
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
        parts.push(format!(
            "{:02}:{:02}:{:02}{}",
            s / 3600,
            (s % 3600) / 60,
            s % 60,
            duck_frac(sub)
        ));
    }
    parts.join(" ")
}

fn duck_query(conn: &duckdb::Connection, sql: &str) -> Result<TextRows, AppError> {
    duck_query_limited(conn, sql, db::CATALOG_TEXT_LIMITS)
}

fn duck_query_limited(
    conn: &duckdb::Connection,
    sql: &str,
    limits: db::TextLimits,
) -> Result<TextRows, AppError> {
    let mut stmt = conn.prepare(sql).map_err(de)?;
    // Column metadata is only valid AFTER the statement is executed (duckdb-rs panics
    // otherwise), so query first, then read names from the Rows' statement.
    let mut rows = stmt.query([]).map_err(de)?;
    let columns: Vec<String> = rows.as_ref().map(|s| s.column_names()).unwrap_or_default();
    let ncols = columns.len();
    let mut budget = db::TextBudget::new(&columns, limits)?;
    let mut data: Vec<Vec<Option<String>>> = Vec::new();
    while let Some(row) = rows.next().map_err(de)? {
        let mut r = Vec::with_capacity(ncols);
        for i in 0..ncols {
            let v: duckdb::types::Value = row.get(i).map_err(de)?;
            r.push(duck_value_to_string(v));
        }
        budget.add_row(&r)?;
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
    let idx: std::collections::HashMap<String, usize> = schemas
        .iter()
        .enumerate()
        .map(|(i, s)| (s.name.clone(), i))
        .collect();
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
            ssh: None,
        }
    }
    fn duck_mem() -> ConnectionConfig {
        mem("duckdb")
    }

    #[test]
    fn mysql_date_rendering_preserves_midnight_timestamp_type() {
        use mysql_async::consts::ColumnType::{MYSQL_TYPE_DATE, MYSQL_TYPE_DATETIME};

        let midnight = mysql_async::Value::Date(2026, 7, 23, 0, 0, 0, 0);
        let meta = |column_type| MySqlColumnMeta {
            column_type,
            binary: false,
        };
        assert_eq!(
            mysql_value_to_string(&midnight, Some(meta(MYSQL_TYPE_DATE)))
                .unwrap()
                .as_deref(),
            Some("2026-07-23")
        );
        assert_eq!(
            mysql_value_to_string(&midnight, Some(meta(MYSQL_TYPE_DATETIME)))
                .unwrap()
                .as_deref(),
            Some("2026-07-23 00:00:00")
        );
    }

    #[test]
    fn binary_cells_use_reversible_hex_and_invalid_text_fails() {
        let sqlite = rusqlite::Connection::open_in_memory().unwrap();
        let (_, rows) = sqlite_query(&sqlite, "SELECT X'00FF41'").unwrap();
        assert_eq!(rows, vec![vec![Some("\\x00ff41".into())]]);
        let error = sqlite_query(&sqlite, "SELECT CAST(X'80' AS TEXT)").unwrap_err();
        assert!(error.message.contains("invalid UTF-8"));

        let duck = duckdb::Connection::open_in_memory().unwrap();
        let (_, rows) = duck_query(&duck, "SELECT from_hex('00ff41')").unwrap();
        assert_eq!(rows, vec![vec![Some("\\x00ff41".into())]]);
        let (backend, _) = DuckConn::open(&duck_mem()).unwrap();
        let mut duck = match backend {
            Backend::Duck(duck) => duck,
            _ => panic!("expected DuckDB backend"),
        };
        match duck
            .run_single("SELECT from_hex('00ff41')", 10, true)
            .unwrap()
        {
            QueryOutcome::Rows { rows, .. } => {
                assert_eq!(rows, vec![vec![Some("\\x00ff41".into())]])
            }
            _ => panic!("expected rows"),
        }

        let binary = MySqlColumnMeta {
            column_type: mysql_async::consts::ColumnType::MYSQL_TYPE_BLOB,
            binary: true,
        };
        assert_eq!(
            mysql_value_to_string(
                &mysql_async::Value::Bytes(vec![0x00, 0xff, 0x41]),
                Some(binary),
            )
            .unwrap(),
            Some("\\x00ff41".into())
        );
        let text = MySqlColumnMeta {
            binary: false,
            ..binary
        };
        assert!(
            mysql_value_to_string(&mysql_async::Value::Bytes(vec![0xff]), Some(text),).is_err()
        );
        use mysql_async::consts::ColumnType;
        assert!(!mysql_is_binary_column(ColumnType::MYSQL_TYPE_LONG, 63,));
        assert!(mysql_is_binary_column(ColumnType::MYSQL_TYPE_BLOB, 63,));
    }

    #[test]
    fn mysql_query_boundary_refuses_multiple_statements() {
        assert!(mysql_single_statement("SELECT 1").is_ok());
        assert!(mysql_single_statement("SELECT ';' AS value").is_ok());
        assert!(mysql_single_statement("SELECT 1; DROP TABLE t").is_err());
        assert!(mysql_single_statement("SELECT 1 /*! COMMIT */").is_err());
        assert!(mysql_single_statement("COPY t FROM stdin;\n1\n\\.\n").is_err());
    }

    #[test]
    fn duck_parser_poison_leak_budget_stops_new_gates() {
        let (backend, _) = DuckConn::open(&duck_mem()).unwrap();
        let d = match backend {
            Backend::Duck(d) => d,
            _ => panic!("expected DuckDB backend"),
        };
        d.gate_poison_leaks
            .store(MAX_DUCK_GATE_POISON_LEAKS, Ordering::Relaxed);
        let err = d.parse_check("SELECT 1").unwrap_err();
        assert!(err.message.contains("safety budget exhausted"));
    }

    /// FROM-first / PIVOT forms must stream through the LIMIT/OFFSET pager like any
    /// SELECT (they classify as cursorable in lib.rs): the subquery wrap must accept
    /// them, and the non-cursorable path would buffer entire tables in RAM.
    #[tokio::test]
    async fn duck_from_first_and_pivot_stream() {
        let (mut b, _) = connect(&duck_mem()).await.unwrap();
        b.run_single("CREATE TABLE t(a INT, k TEXT)", 1, false)
            .await
            .unwrap();
        b.run_single("INSERT INTO t VALUES (1,'x'),(2,'y'),(3,'x')", 1, false)
            .await
            .unwrap();
        match b.run_single("FROM t", 2, true).await.unwrap() {
            QueryOutcome::Rows { rows, done, .. } => {
                assert_eq!(rows.len(), 2);
                assert!(!done);
            }
            _ => panic!("expected rows from FROM-first"),
        }
        b.rollback_cursor().await;
        match b
            .run_single("PIVOT t ON k USING sum(a)", 10, true)
            .await
            .unwrap()
        {
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
        b.run_single("CREATE TABLE t(a INT)", 1, false)
            .await
            .unwrap();
        b.run_single("INSERT INTO t VALUES (1),(2)", 1, false)
            .await
            .unwrap();

        // comment-eaten comma → NOT IN (1 2) → parser error
        let bad = "SELECT * FROM t WHERE a NOT IN (\n  1 -- one,\n  2 -- two\n)";
        let e = b.run_single(bad, 100, true).await.unwrap_err();
        assert!(
            e.message.contains("Parser Error"),
            "want parser error, got: {}",
            e.message
        );
        assert!(
            !e.message.contains("deadlock"),
            "poisoned connection leaked through: {}",
            e.message
        );

        // connection still works after the syntax error
        match b
            .run_single("SELECT a FROM t ORDER BY a", 100, true)
            .await
            .unwrap()
        {
            QueryOutcome::Rows { rows, .. } => assert_eq!(rows.len(), 2),
            _ => panic!("expected rows"),
        }

        // repeat: bad DDL (execute_batch path), bad script path, then a good query
        let e2 = b
            .run_single("CREATE TABLEX u(a INT)", 1, false)
            .await
            .unwrap_err();
        assert!(e2.message.contains("Parser Error"), "got: {}", e2.message);
        let items = script::split("INSERT INTO t VALUES (3);\nSELCT * FROM t;");
        let e3 = b.run_script(&items, false).await.unwrap_err();
        assert!(e3.message.contains("Parser Error"), "got: {}", e3.message);
        // the script's leading INSERT must not have executed (gated before the batch ran)
        match b
            .run_single("SELECT count(*) FROM t", 100, true)
            .await
            .unwrap()
        {
            QueryOutcome::Rows { rows, .. } => assert_eq!(rows[0][0].as_deref(), Some("2")),
            _ => panic!("expected rows"),
        }

        // binder errors (valid parse, missing table) still come from the real catalog
        let e4 = b
            .run_single("SELECT * FROM no_such_table", 100, true)
            .await
            .unwrap_err();
        assert!(e4.message.contains("no_such_table"), "got: {}", e4.message);

        // bool_columns on unparseable SQL degrades to empty, doesn't poison
        assert!(b.bool_columns("SELCT 1").await.is_empty());
        match b
            .run_single("SELECT a FROM t ORDER BY a", 100, true)
            .await
            .unwrap()
        {
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
        b.run_single("CREATE TABLE t(a INT)", 1, false)
            .await
            .unwrap();
        b.run_single("INSERT INTO t VALUES (42)", 1, false)
            .await
            .unwrap();
        assert!(!b.is_closed(), "open while in use");

        // A command finishing with nothing streaming releases the connection → lock freed.
        b.release_idle(false);
        assert!(b.is_closed(), "released when idle");

        // The same file can now be opened by a fresh connection (the lock is gone).
        let (b2, _) = connect(&cfg)
            .await
            .expect("file lock freed after release_idle");
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

    #[tokio::test]
    async fn duckdb_manual_session_suppresses_idle_release() {
        let path =
            std::env::temp_dir().join(format!("tusk_manual_idle_{}.duckdb", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut cfg = duck_mem();
        cfg.path = Some(path.to_string_lossy().into_owned());
        let (mut backend, _) = connect(&cfg).await.unwrap();
        backend
            .run_transaction_statement(
                "BEGIN",
                script::TransactionAction::Begin,
                TransactionMode::None,
            )
            .await
            .unwrap();

        backend.release_idle(true);
        assert!(
            !backend.is_closed(),
            "manual transaction must retain file lock"
        );
        backend.rollback_manual().await;
        backend.release_idle(false);
        assert!(
            backend.is_closed(),
            "finished transaction releases file lock"
        );
        let _ = std::fs::remove_file(path);
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
        let (_c2, cast) = duck_query(
            &conn,
            &format!("SELECT CAST(COLUMNS(*) AS VARCHAR) FROM ({sel}) _t"),
        )
        .unwrap();
        assert_eq!(raw[0], cast[0], "formatter must match the VARCHAR cast");
        assert_eq!(
            raw[0][0].as_deref(),
            Some("2024-03-15"),
            "DATE renders ISO, not Date32(..)"
        );
        assert!(
            !raw[0]
                .iter()
                .flatten()
                .any(|s| s.contains("Date32") || s.contains("Timestamp(") || s.contains("Time64")),
            "no Rust Debug leaks: {:?}",
            raw[0]
        );
    }

    /// A `:memory:` DuckDB must NOT be released on idle — closing it would lose all data.
    #[tokio::test]
    async fn duckdb_memory_stays_open_when_idle() {
        let (b, _) = connect(&duck_mem()).await.unwrap();
        b.release_idle(false);
        assert!(
            !b.is_closed(),
            ":memory: must stay open across idle (closing loses data)"
        );
    }

    #[test]
    fn duckdb_manual_error_state_is_recoverable() {
        let conn = duckdb::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE t(a INTEGER PRIMARY KEY); BEGIN; INSERT INTO t VALUES (1)",
        )
        .unwrap();
        let error = conn.execute_batch("INSERT INTO t VALUES (1)").unwrap_err();
        assert!(error.to_string().contains("duplicate key"));
        let probe = conn.execute_batch("SELECT 1").unwrap_err();
        assert!(!duck_error_is_poison(&probe));
        conn.execute_batch("ROLLBACK").unwrap();
        conn.execute_batch("SELECT 1").unwrap();
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
            QueryOutcome::Rows {
                columns,
                rows,
                done,
                ..
            } => (columns, rows, done),
            _ => panic!("expected rows"),
        };
        assert_eq!(cols, vec!["a", "b"]);
        assert_eq!(all.len(), 2);
        assert!(!done1);
        let p2 = s.fetch_page(2).unwrap();
        assert_eq!(p2.rows.len(), 1);
        assert!(p2.done);
        all.extend(p2.rows);
        assert!(all
            .iter()
            .any(|r| r[0] == Some("1".to_string()) && r[1] == Some("x".to_string())));
        assert!(all
            .iter()
            .any(|r| r[0] == Some("3".to_string()) && r[1].is_none()));

        let tree = sqlite_build_tree(&s.lock()).unwrap();
        assert!(tree.schemas[0].tables.iter().any(|t| t.name == "t"));
        let det = sqlite_table_detail(&s.lock(), "t").unwrap();
        assert_eq!(det.columns.len(), 2);
        assert_eq!(det.columns[0].name, "a");
        let list = sqlite_list_tables(&s.lock()).unwrap();
        assert!(list.iter().any(|t| t.name == "t" && t.columns.len() == 2));
    }

    #[test]
    fn transaction_tracker_recovery_loss_and_owner_are_revisioned() {
        let (backend, _) = SqliteConn::open(&mem("sqlite")).unwrap();
        let mut state = ConnState::new(backend, false);
        state.apply_transaction_action(script::TransactionAction::Begin, "tab-a");
        let id = state.transaction.id.clone();
        assert_eq!(state.transaction.state, TransactionState::Active);
        assert_eq!(state.transaction.revision, 1);
        assert!(state.require_owner("tab-b").is_err());

        state.mark_transaction_failed();
        assert_eq!(state.transaction.state, TransactionState::Failed);
        assert_eq!(
            state.transaction.health,
            TransactionHealth::RecoveryRequired
        );
        state.apply_transaction_action(script::TransactionAction::RollbackTo, "tab-a");
        assert_eq!(state.transaction.state, TransactionState::Active);
        assert_eq!(state.transaction.id, id);
        assert_eq!(state.transaction.health, TransactionHealth::Healthy);

        state.mark_transaction_lost();
        assert_eq!(state.transaction.state, TransactionState::Lost);
        assert_eq!(state.transaction.health, TransactionHealth::Lost);
        assert_eq!(state.transaction.revision, 4);
        state.mark_transaction_lost();
        assert_eq!(state.transaction.revision, 4);
    }

    /// A new run takes over the shared result stream, so another tab's unfinished
    /// page must not block `run_query` (transaction gate only) — while paging and
    /// cancel keep the strict stream-owner gate.
    #[test]
    fn stream_owner_blocks_paging_but_not_new_runs() {
        let (backend, _) = SqliteConn::open(&mem("sqlite")).unwrap();
        let mut state = ConnState::new(backend, false);
        state.stream_owner = Some("tab-a".to_string());
        assert!(state.require_transaction_owner("tab-b").is_ok());
        assert!(state.require_owner("tab-b").is_err());
        assert!(state.require_owner("tab-a").is_ok());

        // Under a manual transaction, both gates still refuse non-owner tabs.
        state.apply_transaction_action(script::TransactionAction::Begin, "tab-a");
        assert!(state.require_transaction_owner("tab-b").is_err());
        assert!(state.require_transaction_owner("tab-a").is_ok());
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
            1,
            false,
        )
        .await
        .unwrap();
        b.run_single(
            "INSERT INTO inventory_action VALUES (1, 1, now(), 5, 10, 'MAIN', 'PURCHASE')",
            1,
            false,
        )
        .await
        .unwrap();

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
        b.release_idle(false);
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
            QueryOutcome::Rows {
                columns,
                rows,
                done,
                ..
            } => (columns, rows, done),
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
        assert!(all
            .iter()
            .any(|r| r[0] == Some("1".to_string()) && r[1] == Some("x".to_string())));
        assert!(all
            .iter()
            .any(|r| r[0] == Some("3".to_string()) && r[1].is_none()));

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
    // FK columns from the same edge scan the ERD uses.
    let fk_cols: std::collections::HashSet<String> = duck_fk_edges(conn)
        .into_iter()
        .filter(|e| e.src_schema == schema && e.src_table == name)
        .flat_map(|e| e.src_cols)
        .collect();
    let columns = rows
        .iter()
        .map(|r| {
            let nm = dcell(r, 0);
            let default = r.get(3).and_then(|v| v.clone());
            tree::Column {
                is_pk: pk.contains(&nm),
                identity: default
                    .as_deref()
                    .is_some_and(|d| d.trim_start().to_ascii_lowercase().starts_with("nextval(")),
                is_fk: fk_cols.contains(&nm),
                name: nm,
                data_type: dcell(r, 1),
                nullable: dcell(r, 2).eq_ignore_ascii_case("YES"),
                default,
                comment: None,
            }
        })
        .collect();

    // Indexes + constraints, best-effort: an older DuckDB may not have these catalog
    // functions, and an empty list is the documented fallback (never an error).
    let indexes = duck_query(
        conn,
        &format!(
            "SELECT index_name, is_unique, COALESCE(sql,'') FROM duckdb_indexes() \
             WHERE schema_name = {} AND table_name = {} ORDER BY index_name",
            dlit(schema),
            dlit(name)
        ),
    )
    .map(|(_c, rs)| {
        rs.iter()
            .map(|r| tree::Index {
                name: dcell(r, 0),
                unique: dcell(r, 1) == "true" || dcell(r, 1) == "t",
                primary: false,
                def: dcell(r, 2),
            })
            .collect()
    })
    .unwrap_or_default();
    let constraints = duck_query(
        conn,
        &format!(
            "SELECT constraint_type, COALESCE(constraint_text,'') FROM duckdb_constraints() \
             WHERE schema_name = {} AND table_name = {}",
            dlit(schema),
            dlit(name)
        ),
    )
    .map(|(_c, rs)| {
        rs.iter()
            .enumerate()
            .map(|(i, r)| {
                let raw = dcell(r, 0).to_ascii_uppercase();
                let kind = match raw.as_str() {
                    "PRIMARY KEY" => "primary_key",
                    "FOREIGN KEY" => "foreign_key",
                    "UNIQUE" => "unique",
                    "CHECK" => "check",
                    _ => "other",
                };
                // DuckDB doesn't name table constraints; synthesize a stable label.
                tree::Constraint {
                    name: format!("{name}_{}_{i}", kind),
                    kind: kind.to_string(),
                    def: dcell(r, 1),
                }
            })
            .collect()
    })
    .unwrap_or_default();

    Ok(tree::RelationDetail {
        name: name.to_string(),
        kind: "table".to_string(),
        comment: None,
        columns,
        indexes,
        constraints,
        triggers: vec![],
    })
}
