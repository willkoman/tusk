mod ai;
mod crash;
mod db;
mod ddl;
mod driver;
#[cfg(test)]
mod driver_conformance;
mod export;
mod perms;
mod profiles;
mod relgraph;
mod script;
mod skills;
mod slack;
mod tree;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

use tokio::io::AsyncReadExt;
use tokio::sync::Mutex as AsyncMutex;

use db::{
    AppError, ConnectResult, ConnectionConfig, FetchResponse, QueryOutcome, QueryResult,
    TransactionState, TransactionStatus,
};
use driver::{Backend, CancelHandle, ConnState};
use profiles::Profile;

pub(crate) struct RegisteredConn {
    inner: AsyncMutex<ConnState>,
    closed: AtomicBool,
}

type Conn = Arc<RegisteredConn>;

#[derive(Clone)]
struct CancelEntry {
    generation: u64,
    handle: CancelHandle,
    config: ConnectionConfig,
    cancelling: bool,
    completed: Arc<AtomicBool>,
    completed_notify: Arc<tokio::sync::Notify>,
    owner: Option<String>,
    transaction: TransactionStatus,
}

struct CancelRegistration<'a> {
    state: &'a AppState,
    id: String,
    generation: u64,
}

impl Drop for CancelRegistration<'_> {
    fn drop(&mut self) {
        self.state
            .complete_cancel_generation(&self.id, self.generation);
    }
}

pub(crate) fn lock_sync<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Default)]
pub(crate) struct AppState {
    conns: Mutex<HashMap<String, Conn>>,
    /// The connection the UI most recently opened — what the Slack bot runs against.
    /// Maintained by register()/disconnect (the app is single-connection).
    active_conn_id: Mutex<Option<String>>,
    // Cancel handles for the *currently running* cancellable operation (export/import)
    // on a connection, keyed by connection id. Kept OUTSIDE the per-connection async
    // Mutex (which the long operation holds for its whole duration) so `cancel_operation`
    // can reach it without blocking. The `CancelToken` opens its own short-lived
    // connection to issue a Postgres CancelRequest; the config is stored so we can build
    // a matching TLS connector for it.
    cancels: Mutex<HashMap<String, CancelEntry>>,
    next_id: AtomicU64,
    next_cancel_generation: AtomicU64,
}

impl AppState {
    fn get(&self, id: &str) -> Result<Conn, AppError> {
        self.conns
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::new("no such connection"))
    }

    /// Arm cancellation for an operation about to run on `id` (call after `ensure_alive`,
    /// with the current client's token). Generation-aware cleanup must run when it ends.
    fn arm_cancel(
        &self,
        id: &str,
        handle: CancelHandle,
        config: ConnectionConfig,
        owner: Option<&str>,
        transaction: TransactionStatus,
    ) -> Result<CancelRegistration<'_>, AppError> {
        // Hold registry visibility through insertion. Disconnect removes the entry
        // under this same lock, so an already-detached command cannot arm afterwards.
        let conns = lock_sync(&self.conns);
        let Some(conn) = conns.get(id) else {
            return Err(AppError::new("connection is disconnecting"));
        };
        if conn.closed.load(Ordering::Acquire) {
            return Err(AppError::new("connection is disconnecting"));
        }
        let generation = self.next_cancel_generation.fetch_add(1, Ordering::Relaxed);
        let mut cancels = lock_sync(&self.cancels);
        if cancels.get(id).is_some_and(|entry| entry.cancelling) {
            return Err(AppError::new(
                "the previous cancellation is still completing",
            ));
        }
        cancels.insert(
            id.to_string(),
            CancelEntry {
                generation,
                handle,
                config,
                cancelling: false,
                completed: Arc::new(AtomicBool::new(false)),
                completed_notify: Arc::new(tokio::sync::Notify::new()),
                owner: owner.map(str::to_string),
                transaction,
            },
        );
        drop(cancels);
        drop(conns);
        Ok(CancelRegistration {
            state: self,
            id: id.to_string(),
            generation,
        })
    }

    fn complete_cancel_generation(&self, id: &str, generation: u64) {
        let mut cancels = lock_sync(&self.cancels);
        let Some(entry) = cancels.get(id) else {
            return;
        };
        if entry.generation != generation {
            return;
        }
        if entry.cancelling {
            entry.completed.store(true, Ordering::Release);
            entry.completed_notify.notify_waiters();
        } else {
            cancels.remove(id);
        }
    }

    fn begin_cancel(&self, id: &str) -> Option<CancelEntry> {
        let mut cancels = lock_sync(&self.cancels);
        let entry = cancels.get_mut(id)?;
        if entry.cancelling {
            return None;
        }
        entry.cancelling = true;
        Some(entry.clone())
    }

    fn abort_cancel_generation(&self, id: &str, generation: u64) {
        let mut cancels = lock_sync(&self.cancels);
        let Some(entry) = cancels.get_mut(id) else {
            return;
        };
        if entry.generation != generation {
            return;
        }
        if entry.completed.load(Ordering::Acquire) {
            cancels.remove(id);
        } else {
            entry.cancelling = false;
        }
    }

    fn finish_cancel_generation(&self, id: &str, generation: u64) {
        let mut cancels = lock_sync(&self.cancels);
        if cancels.get(id).map(|entry| entry.generation) == Some(generation) {
            cancels.remove(id);
        }
    }
    fn clear_cancel(&self, id: &str) {
        lock_sync(&self.cancels).remove(id);
    }
    #[cfg(test)]
    fn cancel_entry(&self, id: &str) -> Option<CancelEntry> {
        lock_sync(&self.cancels).get(id).cloned()
    }
    fn register(&self, backend: Backend, read_only: bool) -> String {
        let id = format!("conn-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let conn = Arc::new(RegisteredConn {
            inner: AsyncMutex::new(ConnState::new(backend, read_only)),
            closed: AtomicBool::new(false),
        });
        lock_sync(&self.conns).insert(id.clone(), conn);
        *lock_sync(&self.active_conn_id) = Some(id.clone());
        id
    }

    /// The connection the Slack bot should use: the UI's active one, falling back to
    /// the sole registered connection.
    pub(crate) fn active(&self) -> Result<(String, Conn), AppError> {
        let active = lock_sync(&self.active_conn_id).clone();
        let conns = lock_sync(&self.conns);
        if let Some(id) = active {
            if let Some(c) = conns.get(&id) {
                return Ok((id, c.clone()));
            }
        }
        if conns.len() == 1 {
            if let Some((k, v)) = conns.iter().next() {
                return Ok((k.clone(), v.clone()));
            }
        }
        Err(AppError::new(
            "no active database connection in Tusk — connect to a database first",
        ))
    }
}

/// Re-open the connection if the client was dropped — idle timeout, server restart,
/// or a network drop that TCP keepalives surfaced as `is_closed`. Resets cursor
/// state since a fresh connection has none. Never caps query duration.
pub(crate) async fn ensure_alive(c: &mut ConnState) -> Result<(), AppError> {
    if c.transaction.state == TransactionState::Lost {
        return Err(
            AppError::new("manual transaction session was lost; disconnect and reconnect")
                .with_transaction(c.transaction.clone()),
        );
    }
    if c.transaction.owns_session() && c.backend.manual_session_ended() {
        c.mark_transaction_lost();
        return Err(AppError::new(
            "the database ended the manual transaction unexpectedly; reconnect required",
        )
        .with_transaction(c.transaction.clone()));
    }
    if c.backend.is_closed() {
        if c.transaction.owns_session() {
            c.mark_transaction_lost();
            return Err(AppError::new(
                "connection was lost during a manual transaction; reconnect required",
            )
            .with_transaction(c.transaction.clone()));
        }
        c.backend.reopen().await?;
    }
    Ok(())
}

/// A locked connection for the duration of one command. On drop (every return path,
/// including `?`) it releases an embedded connection that no longer needs to be held —
/// a file-backed DuckDB otherwise keeps an exclusive OS file lock while idle, blocking
/// other tools/processes from opening the file. Re-opened lazily by `ensure_alive` on the
/// next command. Deref(Mut) makes it a drop-in for the raw `MutexGuard<ConnState>`.
pub(crate) struct ConnGuard<'a> {
    inner: tokio::sync::MutexGuard<'a, ConnState>,
}
impl Drop for ConnGuard<'_> {
    fn drop(&mut self) {
        self.inner
            .backend
            .release_idle(self.inner.transaction.owns_session());
    }
}
impl std::ops::Deref for ConnGuard<'_> {
    type Target = ConnState;
    fn deref(&self) -> &ConnState {
        &self.inner
    }
}
impl std::ops::DerefMut for ConnGuard<'_> {
    fn deref_mut(&mut self) -> &mut ConnState {
        &mut self.inner
    }
}
pub(crate) async fn lock_conn(conn: &Conn) -> Result<ConnGuard<'_>, AppError> {
    if conn.closed.load(Ordering::Acquire) {
        return Err(AppError::new("connection is disconnected"));
    }
    let inner = conn.inner.lock().await;
    if conn.closed.load(Ordering::Acquire) {
        return Err(AppError::new("connection is disconnected"));
    }
    Ok(ConnGuard { inner })
}

/// Only plain read queries can be wrapped in a server-side cursor for streaming.
/// `duck` additionally admits DuckDB's FROM-first and PIVOT forms — they wrap as
/// subqueries fine (pinned by `duck_from_first_and_pivot_stream`), and classifying
/// them non-cursorable buffered ENTIRE tables in RAM (`FROM events` on a big table
/// was an allocation-abort waiting to happen).
fn is_cursorable(sql: &str, duck: bool) -> bool {
    let w = first_sql_word(sql);
    matches!(w.as_str(), "select" | "with" | "table" | "values")
        || (duck && matches!(w.as_str(), "from" | "pivot"))
}

/// Statements allowed on a read-only connection.
pub(crate) fn is_read_only_stmt(sql: &str) -> bool {
    let first = first_sql_word(sql);
    let allowed = matches!(
        first.as_str(),
        "select" | "with" | "show" | "explain" | "table" | "values" | "from" | "pivot"
    );
    allowed
        && !script::contains_code_word(sql, "set_config")
        && !(first == "explain"
            && (script::contains_code_word(sql, "analyze")
                || script::contains_code_word(sql, "analyse")))
        && (first == "show" || slack::processor::find_mutation_word(sql).is_none())
}

fn first_sql_word(sql: &str) -> String {
    script::effective_start(sql)
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .flat_map(char::to_lowercase)
        .collect()
}

fn transaction_requests_write(sql: &str, action: Option<script::TransactionAction>) -> bool {
    matches!(
        action,
        Some(script::TransactionAction::Begin | script::TransactionAction::SetTransaction)
    ) && script::contains_code_word(sql, "write")
}

const DEFAULT_PAGE_SIZE: u32 = 1000;
const MAX_PAGE_SIZE: u32 = 50_000;
const MAX_SQL_BYTES: usize = 20 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_HISTORY_BYTES: usize = 10 * 1024 * 1024;
const MAX_IPC_ROWS: usize = 200_000;
const MAX_IPC_COLUMNS: usize = 10_000;
const MAX_IPC_CELLS: usize = 2_000_000;
const MAX_IPC_CELL_BYTES: usize = 1024 * 1024;
const MAX_IPC_PAYLOAD_BYTES: usize = 64 * 1024 * 1024;
const MAX_TRANSACTION_OWNER_BYTES: usize = 256;

fn validate_transaction_owner(owner: &str) -> Result<(), AppError> {
    if owner.trim().is_empty() || owner.len() > MAX_TRANSACTION_OWNER_BYTES {
        return Err(AppError::new(format!(
            "transaction owner must be between 1 and {MAX_TRANSACTION_OWNER_BYTES} bytes"
        )));
    }
    Ok(())
}

fn checked_page_size(page: Option<u32>) -> Result<u32, AppError> {
    let page = page.unwrap_or(DEFAULT_PAGE_SIZE);
    if !(1..=MAX_PAGE_SIZE).contains(&page) {
        return Err(AppError::new(format!(
            "page size must be between 1 and {MAX_PAGE_SIZE}"
        )));
    }
    Ok(page)
}

fn validate_sql_size(sql: &str) -> Result<(), AppError> {
    if sql.len() > MAX_SQL_BYTES {
        return Err(AppError::new(format!(
            "SQL exceeds the {MAX_SQL_BYTES}-byte limit"
        )));
    }
    Ok(())
}

fn validate_tabular_payload(
    columns: &[String],
    rows: &[Vec<Option<String>>],
) -> Result<(), AppError> {
    if columns.is_empty() || columns.len() > MAX_IPC_COLUMNS {
        return Err(AppError::new(format!(
            "column count must be between 1 and {MAX_IPC_COLUMNS}"
        )));
    }
    if rows.len() > MAX_IPC_ROWS || rows.len().saturating_mul(columns.len()) > MAX_IPC_CELLS {
        return Err(AppError::new(format!(
            "row payload exceeds the {MAX_IPC_CELLS}-cell limit"
        )));
    }
    if rows.iter().any(|r| r.len() != columns.len()) {
        return Err(AppError::new(
            "every row must have exactly the same number of values as columns",
        ));
    }
    let mut bytes = 0usize;
    for value in columns.iter().chain(rows.iter().flatten().flatten()) {
        if value.len() > MAX_IPC_CELL_BYTES {
            return Err(AppError::new(format!(
                "a column name or value exceeds the {MAX_IPC_CELL_BYTES}-byte limit"
            )));
        }
        bytes = bytes.saturating_add(value.len());
        if bytes > MAX_IPC_PAYLOAD_BYTES {
            return Err(AppError::new(format!(
                "row payload exceeds the {MAX_IPC_PAYLOAD_BYTES}-byte limit"
            )));
        }
    }
    Ok(())
}

fn validate_result_page(columns: &[String], rows: &[Vec<Option<String>>]) -> Result<(), AppError> {
    if columns.len() > MAX_IPC_COLUMNS {
        return Err(AppError::new(format!(
            "query result exceeds the {MAX_IPC_COLUMNS}-column limit"
        )));
    }
    if rows.len() > MAX_IPC_ROWS || rows.len().saturating_mul(columns.len()) > MAX_IPC_CELLS {
        return Err(AppError::new(format!(
            "query result exceeds the {MAX_IPC_CELLS}-cell page limit"
        )));
    }
    if rows.iter().any(|r| r.len() != columns.len()) {
        return Err(AppError::new("query returned an inconsistent row shape"));
    }
    validate_result_bytes(columns.iter(), rows)
}

fn validate_fetch_page(rows: &[Vec<Option<String>>]) -> Result<(), AppError> {
    let columns = rows.first().map_or(0, Vec::len);
    if columns > MAX_IPC_COLUMNS
        || rows.len() > MAX_IPC_ROWS
        || rows.len().saturating_mul(columns) > MAX_IPC_CELLS
        || rows.iter().any(|r| r.len() != columns)
    {
        return Err(AppError::new(
            "fetched result page exceeds IPC shape limits",
        ));
    }
    validate_result_bytes(std::iter::empty::<&String>(), rows)
}

fn validate_result_bytes<'a>(
    columns: impl Iterator<Item = &'a String>,
    rows: &'a [Vec<Option<String>>],
) -> Result<(), AppError> {
    let mut bytes = 0usize;
    for value in columns.chain(rows.iter().flatten().flatten()) {
        if value.len() > MAX_IPC_CELL_BYTES {
            return Err(AppError::new(format!(
                "query result contains a value over the {MAX_IPC_CELL_BYTES}-byte limit"
            )));
        }
        bytes = bytes.saturating_add(value.len());
        if bytes > MAX_IPC_PAYLOAD_BYTES {
            return Err(AppError::new(format!(
                "query result page exceeds the {MAX_IPC_PAYLOAD_BYTES}-byte limit"
            )));
        }
    }
    Ok(())
}

#[tauri::command]
async fn connect(
    state: tauri::State<'_, AppState>,
    config: ConnectionConfig,
) -> Result<ConnectResult, AppError> {
    let read_only = config.read_only;
    let (backend, server_version) = driver::connect(&config).await?;
    Ok(ConnectResult {
        connection_id: state.register(backend, read_only),
        server_version,
        read_only,
    })
}

#[tauri::command]
async fn connect_profile(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    id: String,
) -> Result<ConnectResult, AppError> {
    let p = profiles::load_all(&app)?
        .into_iter()
        .find(|x| x.id == id)
        .ok_or_else(|| AppError::new("no such profile"))?;
    // Embedded drivers have no password — skip the keychain entirely.
    let embedded = matches!(p.driver.as_deref(), Some("duckdb") | Some("sqlite"));
    let password = if embedded {
        None
    } else {
        profiles::get_password(&id)
    };
    if !embedded && p.save_password && password.as_deref().unwrap_or("").is_empty() {
        return Err(AppError::new(
            "couldn't read the saved password from the keychain (macOS may block keychain access for unsigned dev builds) — reconnect via the form, or re-save the connection",
        ));
    }
    let config = ConnectionConfig {
        driver: p.driver.clone(),
        host: p.host,
        port: p.port,
        user: p.user,
        password: password.unwrap_or_default(),
        dbname: p.dbname,
        sslmode: p.sslmode,
        read_only: p.read_only,
        path: p.path.clone(),
    };
    let read_only = config.read_only;
    let (backend, server_version) = driver::connect(&config).await?;
    Ok(ConnectResult {
        connection_id: state.register(backend, read_only),
        server_version,
        read_only,
    })
}

#[tauri::command]
async fn disconnect(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<(), AppError> {
    disconnect_registered(&state, &connection_id).await
}

async fn disconnect_registered(state: &AppState, connection_id: &str) -> Result<(), AppError> {
    {
        let mut active = lock_sync(&state.active_conn_id);
        if active.as_deref() == Some(connection_id) {
            *active = None;
        }
    }
    let removed = lock_sync(&state.conns).remove(connection_id);
    if let Some(conn) = removed {
        conn.closed.store(true, Ordering::Release);
        // Remove registry visibility first, then best-effort cancel any operation that
        // already armed itself. A command that raced before removal may still hold its
        // Arc; waiting for its lock below makes disconnect deterministic.
        if let Some(entry) = state.begin_cancel(connection_id) {
            let _ = entry.handle.cancel(&entry.config).await;
        }
        let mut c = conn.inner.lock().await;
        if c.transaction.owns_session() {
            c.backend.rollback_manual().await;
        } else {
            c.backend.rollback_cursor().await;
        }
    }
    // Clear after the removed connection is quiescent so a racing operation cannot arm
    // a stale handle after an earlier clear.
    state.clear_cancel(connection_id);
    Ok(())
}

#[tauri::command]
async fn list_profiles(app: tauri::AppHandle) -> Result<Vec<Profile>, AppError> {
    profiles::load_all(&app)
}

#[tauri::command]
async fn save_profile(
    app: tauri::AppHandle,
    profile: Profile,
    password: Option<String>,
) -> Result<Profile, AppError> {
    profiles::upsert(&app, profile, password)
}

#[tauri::command]
async fn delete_profile(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
    profiles::delete(&app, &id)
}

#[tauri::command]
async fn run_query(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    owner_id: String,
    sql: String,
    page_size: Option<u32>,
    search_path: Option<String>,
) -> Result<QueryResult, AppError> {
    validate_transaction_owner(&owner_id)?;
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await?;
    // A run takes over the single result stream (exec_items closes the old cursor
    // and clears `stream_owner`), so only the manual-transaction owner gate applies
    // here — otherwise one tab's unfinished page would lock every other tab out.
    c.require_transaction_owner(&owner_id)?;
    ensure_alive(&mut c)
        .await
        .map_err(|error| error.with_transaction(c.transaction.clone()))?;
    validate_sql_size(&sql).map_err(|error| error.with_transaction(c.transaction.clone()))?;
    let page = checked_page_size(page_size)
        .map_err(|error| error.with_transaction(c.transaction.clone()))?;
    let items = script::parse_for_engine(sql.trim(), c.transaction_engine())
        .map_err(|error| error.with_transaction(c.transaction.clone()))?;
    if items.is_empty() {
        return Ok(QueryResult {
            outcome: QueryOutcome::Exec {
                message: "OK (nothing to run)".to_string(),
            },
            transaction: c.transaction.clone(),
        });
    }
    let actions = script::preflight_transactions(&items, c.transaction_engine(), &c.transaction)
        .map_err(|error| error.with_transaction(c.transaction.clone()))?;

    if c.read_only
        && items.iter().zip(&actions).any(|(item, action)| match item {
            script::Item::Sql(sql) => {
                (action.is_none() && !is_read_only_stmt(sql.trim()))
                    || transaction_requests_write(sql, *action)
            }
            script::Item::Copy { .. } => true,
        })
    {
        return Err(
            AppError::new("connection is read-only — writes and DDL are blocked")
                .with_transaction(c.transaction.clone()),
        );
    }
    // Arm cancellation so the Run button can interrupt this query (Postgres CancelRequest)
    // by re-clicking. Armed after ensure_alive so the handle matches the live backend; the
    // handle lives outside the per-connection lock we hold here so `cancel_operation` reaches it.
    let cancel_registration = state
        .arm_cancel(
            &connection_id,
            c.backend.cancel_handle(),
            c.backend.config().clone(),
            Some(&owner_id),
            c.transaction.clone(),
        )
        .map_err(|error| error.with_transaction(c.transaction.clone()))?;
    let out = match exec_items(&mut c, &items, &actions, page, &search_path, &owner_id).await {
        Ok(outcome) => Ok(QueryResult {
            outcome,
            transaction: c.transaction.clone(),
        }),
        // Never replay a statement after it reached the server. Even read-only SQL may
        // call volatile functions or external systems, so its effects are ambiguous.
        // `ensure_alive` reconnects before the user's next explicit run instead.
        Err(e)
            if c.backend.is_closed()
                || (c.transaction.owns_session() && c.backend.manual_session_ended()) =>
        {
            c.mark_transaction_lost();
            Err(AppError::new(format!(
                "connection dropped while the query was running; execution outcome is unknown. Verify database state before retrying. ({})",
                e.message
            ))
            .with_transaction(c.transaction.clone()))
        }
        Err(e) => {
            if c.backend.manual_errors_require_recovery() {
                c.mark_transaction_failed();
            }
            Err(e.with_transaction(c.transaction.clone()))
        }
    };
    drop(c);
    drop(cancel_registration);
    out
}

async fn exec_items(
    c: &mut ConnState,
    items: &[script::Item],
    actions: &[Option<script::TransactionAction>],
    page: u32,
    search_path: &Option<String>,
    owner: &str,
) -> Result<QueryOutcome, AppError> {
    if c.read_only
        && items.iter().zip(actions).any(|(item, action)| match item {
            script::Item::Sql(sql) => {
                (action.is_none() && !is_read_only_stmt(sql.trim()))
                    || transaction_requests_write(sql, *action)
            }
            script::Item::Copy { .. } => true,
        })
    {
        return Err(AppError::new(
            "connection is read-only — writes and DDL are blocked",
        ));
    }
    let manual = c.transaction.owns_session();
    c.backend.close_stream(manual).await?;
    c.stream_owner = None;

    let recovery_only = c.transaction.state == TransactionState::Failed
        && actions.iter().all(|action| {
            matches!(
                action,
                Some(
                    script::TransactionAction::Rollback
                        | script::TransactionAction::RollbackTo
                        | script::TransactionAction::Commit
                )
            )
        });
    let control_only = actions.iter().all(Option::is_some);
    if !recovery_only && !control_only {
        c.backend.apply_search_path(search_path).await?;
    }

    // A single plain statement runs interactively (streaming result grid).
    let duck = matches!(c.backend, crate::driver::Backend::Duck(_));
    if items.len() == 1 {
        if let script::Item::Sql(stmt) = &items[0] {
            let trimmed = stmt.trim();
            let out = if let Some(action) = actions[0] {
                let mode = c.transaction.mode;
                let owned_before = c.transaction.owns_session();
                let result = c
                    .backend
                    .run_transaction_statement(trimmed, action, mode)
                    .await;
                let out = match result {
                    Ok(out) => out,
                    Err(error) => {
                        if !owned_before {
                            c.backend.rollback_manual().await;
                        }
                        return Err(error);
                    }
                };
                c.apply_transaction_action(action, owner);
                out
            } else if c.transaction.owns_session() {
                c.backend
                    .run_manual_single(
                        trimmed,
                        page,
                        is_cursorable(trimmed, duck),
                        c.transaction.mode,
                    )
                    .await?
            } else {
                c.backend
                    .run_single(trimmed, page, is_cursorable(trimmed, duck))
                    .await?
            };
            if let QueryOutcome::Rows { columns, rows, .. } = &out {
                if let Err(e) = validate_result_page(columns, rows) {
                    c.backend.close_stream(c.transaction.owns_session()).await?;
                    return Err(e);
                }
            }
            if matches!(&out, QueryOutcome::Rows { done: false, .. }) {
                c.stream_owner = Some(owner.to_string());
            }
            return Ok(out);
        }
    }

    if actions.iter().all(Option::is_none) && !c.transaction.owns_session() {
        // Preserve the app-owned atomic wrapper for ordinary idle scripts.
        let message = c.backend.run_script(items, c.read_only).await?;
        return Ok(QueryOutcome::Exec { message });
    }

    let mut statements = 0u64;
    let mut copied = 0u64;
    for (item, action) in items.iter().zip(actions) {
        match item {
            script::Item::Sql(sql) => {
                let trimmed = sql.trim();
                if let Some(action) = action {
                    let mode = c.transaction.mode;
                    let owned_before = c.transaction.owns_session();
                    let result = c
                        .backend
                        .run_transaction_statement(trimmed, *action, mode)
                        .await;
                    if let Err(error) = result {
                        if !owned_before {
                            c.backend.rollback_manual().await;
                        }
                        return Err(error);
                    }
                    c.apply_transaction_action(*action, owner);
                } else if c.transaction.owns_session() {
                    c.backend
                        .run_manual_single(trimmed, page, false, c.transaction.mode)
                        .await?;
                } else {
                    c.backend.run_single(trimmed, page, false).await?;
                }
            }
            script::Item::Copy { stmt, data } => {
                copied = copied.saturating_add(c.backend.run_manual_copy(stmt, data).await?);
            }
        }
        statements = statements.saturating_add(1);
    }
    Ok(QueryOutcome::Exec {
        message: format!("OK — {statements} statements run, {copied} rows copied"),
    })
}

#[tauri::command]
async fn fetch_more(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    owner_id: String,
    page_size: Option<u32>,
) -> Result<FetchResponse, AppError> {
    validate_transaction_owner(&owner_id)?;
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await?;
    c.require_owner(&owner_id)?;
    let was_streaming = c.backend.cursor_open();
    ensure_alive(&mut c)
        .await
        .map_err(|error| error.with_transaction(c.transaction.clone()))?;
    let page = checked_page_size(page_size)
        .map_err(|error| error.with_transaction(c.transaction.clone()))?;
    // A live stream whose connection had to be re-opened (idle timeout, server restart,
    // or a network drop surfaced by TCP keepalives) has lost its server-side cursor — it
    // lived in a transaction on the old connection. Don't silently report `done`: that
    // truncates the result with no indication. Surface the break so the UI can show it;
    // the user re-runs to load the rest.
    if was_streaming && !c.backend.cursor_open() {
        c.mark_transaction_lost();
        return Err(AppError::new(
            "connection dropped mid-stream — the result is incomplete. Re-run the query to load the rest.",
        )
        .with_transaction(c.transaction.clone()));
    }
    if !c.backend.cursor_open() {
        // A stream that finished naturally already released its owner. An owner that is
        // still registered means something else (a metadata command, sidebar DDL, an
        // export or import) rolled the cursor back underneath it: report that
        // explicitly so the UI never presents the partial rows as the full result.
        let interrupted = c.stream_owner.take().is_some();
        return Ok(FetchResponse {
            rows: vec![],
            done: true,
            interrupted,
            transaction: c.transaction.clone(),
        });
    }
    let cancel_registration = state
        .arm_cancel(
            &connection_id,
            c.backend.cancel_handle(),
            c.backend.config().clone(),
            Some(&owner_id),
            c.transaction.clone(),
        )
        .map_err(|error| error.with_transaction(c.transaction.clone()))?;
    let result = c.backend.fetch_page(page).await;
    let result = match result {
        Ok(page) => {
            if let Err(e) = validate_fetch_page(&page.rows) {
                if c.transaction.owns_session() {
                    let _ = c.backend.close_stream(true).await;
                } else {
                    c.backend.rollback_cursor().await;
                }
                Err(e)
            } else {
                Ok(page)
            }
        }
        Err(e) => {
            if c.transaction.owns_session() {
                let _ = c.backend.close_stream(true).await;
            } else {
                c.backend.rollback_cursor().await;
            }
            Err(e)
        }
    };
    let result = match result {
        Ok(page) => {
            if page.done {
                c.stream_owner = None;
            }
            Ok(FetchResponse {
                rows: page.rows,
                done: page.done,
                interrupted: false,
                transaction: c.transaction.clone(),
            })
        }
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
    };
    drop(c);
    drop(cancel_registration);
    result
}

/// One diagnostic from `validate_sql`: a statement that failed to PREPARE.
#[derive(serde::Serialize)]
struct StmtDiag {
    stmt_index: usize,
    message: String,
    /// 1-based char offset within the statement, mapped back from Postgres.
    position: Option<i32>,
}

/// Statements PREPARE legitimately rejects (DDL / utility / transaction control) —
/// skip those. Everything else is PREPAREd, so an unrecognized leading word
/// (`SELCT …`) gets a real parser diagnostic instead of being silently skipped
/// (the old allow-list meant a misspelled first keyword produced no lint at all).
fn is_prepareable(sql: &str) -> bool {
    const SKIP: &[&str] = &[
        "create",
        "alter",
        "drop",
        "truncate",
        "grant",
        "revoke",
        "comment",
        "set",
        "reset",
        "show",
        "copy",
        "vacuum",
        "analyze",
        "analyse",
        "begin",
        "start",
        "commit",
        "end",
        "rollback",
        "abort",
        "savepoint",
        "release",
        "do",
        "call",
        "declare",
        "fetch",
        "move",
        "close",
        "prepare",
        "execute",
        "deallocate",
        "listen",
        "notify",
        "unlisten",
        "lock",
        "reindex",
        "cluster",
        "refresh",
        "checkpoint",
        "discard",
        "import",
        "security",
        "explain",
    ];
    let t = script::effective_start(sql).to_ascii_lowercase();
    if t.is_empty() || t.starts_with('\\') {
        return false; // comment-only or psql meta-command
    }
    // First word = leading alphabetic run ("explain(analyze)" → "explain").
    let first: String = t.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    !SKIP.contains(&first.as_str())
}

/// PREPARE rejects statements with bind parameters ("could not determine data type
/// of parameter $1"), which would be a false-positive lint — skip those statements.
/// Also treats `:name` and DB-API `%s` (prompted at run time) as parameters,
/// scanning OUTSIDE strings/comments/quoted idents/dollar bodies so lookalikes
/// such as `'a:b'`, `::casts`, and `'%s'` don't trigger it.
fn has_bind_params(sql: &str) -> bool {
    let b = sql.as_bytes();
    let n = b.len();
    let mut i = 0usize;
    while i < n {
        let c = b[i];
        // skip line comment
        if c == b'-' && i + 1 < n && b[i + 1] == b'-' {
            while i < n && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // skip block comment
        if c == b'/' && i + 1 < n && b[i + 1] == b'*' {
            i += 2;
            while i + 1 < n && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(n);
            continue;
        }
        // skip quoted regions
        if c == b'\'' || c == b'"' {
            let q = c;
            i += 1;
            while i < n {
                if b[i] == q {
                    if i + 1 < n && b[i + 1] == q {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if c == b'$' {
            if i + 1 < n && b[i + 1].is_ascii_digit() {
                return true; // $1-style
            }
            // dollar-quoted body — skip to the closing tag
            if let Some(tag_end) = dollar_tag_end(b, i) {
                let tag = &b[i..tag_end];
                let mut j = tag_end;
                while j + tag.len() <= n {
                    if &b[j..j + tag.len()] == tag {
                        i = j + tag.len();
                        break;
                    }
                    j += 1;
                }
                if j + tag.len() > n {
                    return false;
                } // unterminated — nothing further to find
                continue;
            }
            i += 1;
            continue;
        }
        if c == b':' {
            // `::cast` is two colons; word-adjacent colons aren't params either.
            let prev = if i > 0 { b[i - 1] } else { b' ' };
            let next = if i + 1 < n { b[i + 1] } else { b' ' };
            if next == b':' || prev == b':' {
                i += 2.min(n - i);
                continue;
            }
            if (next.is_ascii_alphabetic() || next == b'_')
                && !(prev.is_ascii_alphanumeric()
                    || prev == b'_'
                    || prev == b'"'
                    || prev == b'\''
                    || prev == b']')
            {
                return true; // :name-style
            }
        }
        if c == b'%' && i + 1 < n && b[i + 1] == b's' {
            let prev = if i > 0 { b[i - 1] } else { b' ' };
            let next = if i + 2 < n { b[i + 2] } else { b' ' };
            // Match the frontend scanner: `%%s` is escaped, `a%s` is compact
            // modulo, and `%sfoo` is an identifier lookalike.
            let adjacent_prev = prev.is_ascii_alphanumeric()
                || prev == b'_'
                || prev == b'"'
                || prev == b'\''
                || prev == b']'
                || prev == b')';
            if prev != b'%' && !adjacent_prev && !(next.is_ascii_alphanumeric() || next == b'_') {
                return true;
            }
            i += 2;
            continue;
        }
        i += 1;
    }
    false
}

/// `$tag$` opener at `b[i]` → byte offset just past the closing `$` of the tag,
/// or None when this `$` doesn't open a dollar-quote (mirrors script.rs lexing).
fn dollar_tag_end(b: &[u8], i: usize) -> Option<usize> {
    let n = b.len();
    let mut j = i + 1;
    while j < n && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
        j += 1;
    }
    (j < n && b[j] == b'$').then_some(j + 1)
}

#[cfg(test)]
mod bind_param_tests {
    use super::{
        checked_page_size, disconnect_registered, exec_items, has_bind_params, is_cursorable,
        is_read_only_stmt, lock_conn, persist_export_temp, validate_fetch_page,
        validate_result_page, validate_sql_size, validate_tabular_payload, AppState, CancelHandle,
        ConnectionConfig, TransactionStatus, MAX_IPC_CELL_BYTES, MAX_SQL_BYTES,
    };
    use crate::driver;
    use std::sync::atomic::Ordering;

    #[test]
    fn detects_supported_bind_styles() {
        assert!(has_bind_params("SELECT $1"));
        assert!(has_bind_params("SELECT :name"));
        assert!(has_bind_params("SELECT 1 WHERE 1 = ANY(%s::int[])"));
    }

    #[test]
    fn ignores_masked_and_lookalike_format_params() {
        for sql in [
            "SELECT '%s'",
            "SELECT \"%s\"",
            "SELECT 1 -- %s",
            "SELECT /* %s */ 1",
            "DO $fn$ SELECT %s $fn$",
            "SELECT %%s",
            "SELECT a%s",
            "SELECT %sfoo",
        ] {
            assert!(!has_bind_params(sql), "unexpected bind param in {sql}");
        }
    }

    #[test]
    fn query_classification_skips_comments_and_matches_whole_keywords() {
        assert!(is_cursorable("-- heading\nSELECT 1", false));
        assert!(is_read_only_stmt(
            "/* heading */ WITH x AS (SELECT 1) SELECT * FROM x"
        ));
        assert!(!is_cursorable("selection FROM t", false));
        assert!(!is_read_only_stmt("showcase"));
        // DuckDB-only forms stream (buffering FROM <big table> whole was an OOM-abort
        // class); other engines keep rejecting them as cursorable.
        assert!(is_cursorable("FROM events", true));
        assert!(is_cursorable("PIVOT t ON k USING sum(v)", true));
        assert!(!is_cursorable("FROM events", false));
        assert!(is_read_only_stmt("FROM events"));
        assert!(!is_read_only_stmt("frombulate"));
    }

    #[test]
    fn readonly_guard_rejects_writable_ctes_and_row_locks() {
        assert!(!is_read_only_stmt(
            "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"
        ));
        assert!(!is_read_only_stmt("SELECT * FROM t FOR UPDATE"));
        assert!(!is_read_only_stmt("SELECT * FROM t FOR SHARE"));
        assert!(!is_read_only_stmt("SELECT * FROM t FOR\nSHARE"));
        assert!(!is_read_only_stmt("SELECT * FROM t INTO OUTFILE '/tmp/x'"));
        assert!(is_read_only_stmt("SELECT 'delete' AS word -- update"));
    }

    #[test]
    fn page_size_rejects_zero_and_unbounded_requests() {
        assert_eq!(checked_page_size(None).unwrap(), 1000);
        assert_eq!(checked_page_size(Some(1)).unwrap(), 1);
        assert_eq!(checked_page_size(Some(50_000)).unwrap(), 50_000);
        assert!(checked_page_size(Some(0)).is_err());
        assert!(checked_page_size(Some(50_001)).is_err());
        assert!(checked_page_size(Some(u32::MAX)).is_err());
    }

    #[test]
    fn ipc_resource_limits_reject_oversized_and_ragged_payloads() {
        assert!(validate_sql_size(&"x".repeat(MAX_SQL_BYTES + 1)).is_err());
        assert!(validate_tabular_payload(&[], &[]).is_err());
        assert!(
            validate_tabular_payload(&["a".into(), "b".into()], &[vec![Some("1".into())]]).is_err()
        );
        assert!(validate_tabular_payload(&["a".into()], &[vec![Some("1".into())]]).is_ok());
        assert!(validate_result_page(
            &["a".into()],
            &[vec![Some("x".repeat(MAX_IPC_CELL_BYTES + 1))]]
        )
        .is_err());
        assert!(validate_fetch_page(&[
            vec![Some("1".into())],
            vec![Some("2".into()), Some("ragged".into())],
        ])
        .is_err());
    }

    #[test]
    fn zero_row_command_temp_replaces_stale_destination() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("empty.csv");
        std::fs::write(&destination, "stale").unwrap();
        let temp = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        std::fs::write(temp.path(), "id\n").unwrap();

        persist_export_temp(temp.into_temp_path(), &destination).unwrap();

        assert_eq!(std::fs::read_to_string(destination).unwrap(), "id\n");
    }

    #[test]
    fn connection_config_rejects_unknown_security_modes_and_ports() {
        let mut cfg = ConnectionConfig {
            driver: Some("postgres".into()),
            host: "localhost".into(),
            port: 5432,
            user: "u".into(),
            password: String::new(),
            dbname: "d".into(),
            sslmode: Some("verify-full".into()),
            read_only: false,
            path: None,
        };
        assert!(cfg.validate().is_ok());
        cfg.sslmode = Some("verfy-full".into());
        assert!(cfg.validate().is_err());
        cfg.sslmode = Some("prefer".into());
        cfg.port = 0;
        assert!(cfg.validate().is_err());
        cfg.driver = Some("oracle".into());
        assert!(cfg.validate().is_err());
    }

    fn sqlite_cancel_config() -> ConnectionConfig {
        ConnectionConfig {
            driver: Some("sqlite".into()),
            host: String::new(),
            port: 1,
            user: String::new(),
            password: String::new(),
            dbname: String::new(),
            sslmode: None,
            read_only: false,
            path: Some(":memory:".into()),
        }
    }

    #[tokio::test]
    async fn stale_cancel_cleanup_cannot_remove_new_operation() {
        let state = AppState::default();
        let cfg = sqlite_cancel_config();
        let (backend, _) = driver::connect(&cfg).await.unwrap();
        let id = state.register(backend, false);
        let old = state
            .arm_cancel(
                &id,
                CancelHandle::None,
                cfg.clone(),
                None,
                TransactionStatus::default(),
            )
            .unwrap();
        let new = state
            .arm_cancel(
                &id,
                CancelHandle::None,
                cfg,
                None,
                TransactionStatus::default(),
            )
            .unwrap();
        let new_generation = new.generation;
        drop(old);
        assert_eq!(state.cancel_entry(&id).unwrap().generation, new_generation);
        drop(new);
        assert!(state.cancel_entry(&id).is_none());
    }

    #[tokio::test]
    async fn cancelling_generation_blocks_replacement_until_owner_completes() {
        let state = AppState::default();
        let cfg = sqlite_cancel_config();
        let (backend, _) = driver::connect(&cfg).await.unwrap();
        let id = state.register(backend, false);
        let registration = state
            .arm_cancel(
                &id,
                CancelHandle::None,
                cfg.clone(),
                None,
                TransactionStatus::default(),
            )
            .unwrap();
        let cancelling = state.begin_cancel(&id).unwrap();
        assert!(state
            .arm_cancel(
                &id,
                CancelHandle::None,
                cfg,
                None,
                TransactionStatus::default(),
            )
            .is_err());
        drop(registration);
        assert!(cancelling.completed.load(Ordering::Acquire));
        assert!(state.cancel_entry(&id).is_some());
        state.finish_cancel_generation(&id, cancelling.generation);
        assert!(state.cancel_entry(&id).is_none());
    }

    #[tokio::test]
    async fn disconnect_rolls_back_manual_transaction_on_owned_session() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("disconnect.sqlite");
        let cfg = ConnectionConfig {
            driver: Some("sqlite".into()),
            host: String::new(),
            port: 1,
            user: String::new(),
            password: String::new(),
            dbname: String::new(),
            sslmode: None,
            read_only: false,
            path: Some(path.to_string_lossy().into_owned()),
        };
        let (mut backend, _) = driver::connect(&cfg).await.unwrap();
        backend
            .run_single("CREATE TABLE t(a INTEGER)", 100, false)
            .await
            .unwrap();
        let state = AppState::default();
        let id = state.register(backend, false);
        let conn = state.get(&id).unwrap();
        {
            let mut c = lock_conn(&conn).await.unwrap();
            for sql in ["BEGIN", "INSERT INTO t VALUES (1)"] {
                let items = crate::script::parse(sql).unwrap();
                let actions = crate::script::preflight_transactions(
                    &items,
                    c.transaction_engine(),
                    &c.transaction,
                )
                .unwrap();
                exec_items(&mut c, &items, &actions, 100, &None, "tab-1")
                    .await
                    .unwrap();
            }
        }

        disconnect_registered(&state, &id).await.unwrap();

        let observer = rusqlite::Connection::open(path).unwrap();
        let count: i64 = observer
            .query_row("SELECT COUNT(*) FROM t", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}

/// Turn a PREPARE error into a diagnostic, remapping Postgres' 1-based position
/// (relative to the `PREPARE … AS ` wrapper) back into the user's statement.
fn db_error_diag(e: &tokio_postgres::Error, prefix_chars: i32, stmt_index: usize) -> StmtDiag {
    let (message, raw_pos) = match e.as_db_error() {
        Some(db) => {
            let msg = match db.hint() {
                Some(h) => format!("{} (hint: {h})", db.message()),
                None => db.message().to_string(),
            };
            let pos = match db.position() {
                Some(tokio_postgres::error::ErrorPosition::Original(p)) => Some(*p as i32),
                _ => None,
            };
            (msg, pos)
        }
        None => (e.to_string(), None),
    };
    let position = raw_pos.and_then(|p| {
        let adj = p - prefix_chars;
        if adj >= 1 {
            Some(adj)
        } else {
            None
        }
    });
    StmtDiag {
        stmt_index,
        message,
        position,
    }
}

/// Validate each statement by PREPARE-ing it (parse + plan, never execute) and
/// reporting the parser-grade error. Read-only safe; isolated from the streaming
/// cursor; runs in autocommit so a failing statement doesn't poison the next one.
#[tauri::command]
async fn validate_sql(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    sql: String,
    search_path: Option<String>,
) -> Result<Vec<StmtDiag>, AppError> {
    validate_sql_size(&sql)?;
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await?;
    ensure_alive(&mut c).await?;
    c.require_idle("SQL validation")?;
    c.backend.rollback_cursor().await;
    c.backend.apply_search_path(&search_path).await?;
    let client = c.backend.pg()?;
    let _ = client.batch_execute("DEALLOCATE ALL").await;

    let items = script::parse(sql.trim())?;
    let mut diags: Vec<StmtDiag> = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let stmt = match item {
            script::Item::Sql(s) => s,
            script::Item::Copy { .. } => continue,
        };
        if !is_prepareable(stmt) || has_bind_params(stmt) {
            continue;
        }
        let name = format!("tusk_validate_{i}");
        let prefix = format!("PREPARE {name} AS ");
        let prefix_chars = prefix.chars().count() as i32;
        match client.batch_execute(&format!("{prefix}{stmt}")).await {
            Ok(()) => {
                let _ = client.batch_execute(&format!("DEALLOCATE {name}")).await;
            }
            Err(e) => diags.push(db_error_diag(&e, prefix_chars, i)),
        }
    }
    Ok(diags)
}

#[tauri::command]
async fn list_schema(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<tree::TableInfo>, AppError> {
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await?;
    ensure_alive(&mut c).await?;
    c.require_idle("schema metadata")?;
    c.backend.rollback_cursor().await;
    c.backend.list_tables().await
}

#[tauri::command]
async fn db_tree(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<tree::DbTree, AppError> {
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await?;
    ensure_alive(&mut c).await?;
    c.require_idle("database metadata")?;
    c.backend.rollback_cursor().await;
    c.backend.build_tree().await
}

#[tauri::command]
async fn table_detail(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    schema: String,
    name: String,
) -> Result<tree::RelationDetail, AppError> {
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await?;
    ensure_alive(&mut c).await?;
    c.require_idle("relation metadata")?;
    c.backend.rollback_cursor().await;
    c.backend.table_detail(&schema, &name).await
}

/// A handful of sample rows from a relation, for the AI assistant's context (so it can
/// answer targeted questions about real data without the user pasting any). Read-only;
/// deliberately does NOT roll back the streaming cursor, so it never interrupts an
/// in-flight result.
#[derive(serde::Serialize)]
struct SampleResult {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
}

#[tauri::command]
async fn sample_rows(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    schema: String,
    name: String,
    limit: Option<u32>,
) -> Result<SampleResult, AppError> {
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await?;
    ensure_alive(&mut c).await?;
    c.require_idle("sample-row metadata")?;
    let (columns, rows) = c
        .backend
        .sample_rows(&schema, &name, limit.unwrap_or(5))
        .await?;
    validate_result_page(&columns, &rows)?;
    Ok(SampleResult { columns, rows })
}

#[tauri::command]
async fn object_ddl(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    kind: String,
    schema: String,
    name: String,
) -> Result<String, AppError> {
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await?;
    ensure_alive(&mut c).await?;
    c.require_idle("DDL metadata")?;
    c.backend.rollback_cursor().await;
    // Multi-engine: PG full reconstruction, SQLite sqlite_master, MySQL SHOW
    // CREATE, DuckDB duckdb_tables()/views() best-effort.
    c.backend.relation_ddl(&kind, &schema, &name).await
}

/// All callable function/procedure names (builtins + user-defined), feeding the
/// editor's unknown-function lint. Empty = engine can't enumerate reliably.
#[tauri::command]
async fn list_functions(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<String>, AppError> {
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await?;
    ensure_alive(&mut c).await?;
    c.require_idle("function metadata")?;
    c.backend.rollback_cursor().await;
    c.backend.list_functions().await
}

/// FK relationships of one relation (outbound + inbound), for the relationship
/// graph. Best-effort per driver — engines without the catalog answer empty.
#[tauri::command]
async fn table_relationships(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    schema: String,
    name: String,
) -> Result<relgraph::Relationships, AppError> {
    if schema.len() > 1_000 || name.len() > 1_000 {
        return Err(AppError::new("schema or relation name is too long"));
    }
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await?;
    ensure_alive(&mut c).await?;
    c.require_idle("relationship metadata")?;
    c.backend.rollback_cursor().await;
    let graph = c.backend.table_relationships(&schema, &name).await?;
    if graph.outbound.len().saturating_add(graph.inbound.len()) > 50_000 {
        return Err(AppError::new(
            "relationship graph exceeds the 50000-edge limit",
        ));
    }
    Ok(graph)
}

/// All FK edges + table summaries of one schema, for the whole-schema ERD.
#[tauri::command]
async fn schema_relationships(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    schema: String,
) -> Result<relgraph::SchemaGraph, AppError> {
    if schema.len() > 1_000 {
        return Err(AppError::new("schema name is too long"));
    }
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await?;
    ensure_alive(&mut c).await?;
    c.require_idle("schema relationship metadata")?;
    c.backend.rollback_cursor().await;
    let graph = c.backend.schema_relationships(&schema).await?;
    let columns = graph.tables.iter().map(|t| t.columns.len()).sum::<usize>();
    if graph.tables.len() > 5_000 || graph.edges.len() > 50_000 || columns > 100_000 {
        return Err(AppError::new(
            "schema graph exceeds the 5000-table/50000-edge/100000-column limits",
        ));
    }
    Ok(graph)
}

/// Report what the connected driver supports, so the UI can gate features (hide
/// COPY-import / search-path / etc. where unsupported). PG today; per-driver later.
#[tauri::command]
async fn capabilities(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<driver::Capabilities, AppError> {
    let conn = state.get(&connection_id)?;
    let c = lock_conn(&conn).await?;
    Ok(c.backend.capabilities())
}

#[tauri::command]
async fn transaction_status(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<TransactionStatus, AppError> {
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await?;
    if c.transaction.owns_session() && c.backend.manual_session_ended() {
        c.mark_transaction_lost();
    }
    Ok(c.transaction.clone())
}

/// The connected role's effective privileges (Postgres). The frontend gates sidebar DDL
/// actions on these; refreshed on every introspection reload.
#[tauri::command]
async fn permissions(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<perms::Permissions, AppError> {
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await?;
    ensure_alive(&mut c).await?;
    c.require_idle("permission metadata")?;
    c.backend.rollback_cursor().await;
    c.backend.permissions().await
}

/// Immediately cancel the query, fetch, export, or import currently armed on this
/// connection. PostgreSQL uses an out-of-band CancelRequest; the operation command
/// owns rollback and partial-output cleanup. A no-op if nothing is armed.
#[tauri::command]
async fn cancel_operation(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    owner_id: String,
) -> Result<TransactionStatus, AppError> {
    validate_transaction_owner(&owner_id)?;
    let Some(entry) = state.begin_cancel(&connection_id) else {
        let conn = state.get(&connection_id)?;
        let mut c = lock_conn(&conn).await?;
        if c.transaction.owns_session() && c.backend.manual_session_ended() {
            c.mark_transaction_lost();
        }
        c.require_owner(&owner_id)?;
        return Ok(c.transaction.clone());
    };
    if entry
        .owner
        .as_deref()
        .is_some_and(|owner| owner != owner_id)
    {
        state.abort_cancel_generation(&connection_id, entry.generation);
        return Err(AppError::new("in-flight operation is owned by another tab")
            .with_transaction(entry.transaction));
    }
    if matches!(entry.handle, CancelHandle::None) {
        state.abort_cancel_generation(&connection_id, entry.generation);
        return Err(
            AppError::new("this database driver cannot cancel an in-flight query")
                .with_transaction(entry.transaction),
        );
    }
    if let Err(error) = entry.handle.clone().cancel(&entry.config).await {
        state.abort_cancel_generation(&connection_id, entry.generation);
        return Err(error.with_transaction(entry.transaction));
    }

    // Keep the generation tombstone until the owning command has observed the
    // cancellation and released its connection lock. Otherwise a delayed PostgreSQL
    // CancelRequest can land on the next operation using the same backend PID.
    while !entry.completed.load(Ordering::Acquire) {
        let notified = entry.completed_notify.notified();
        tokio::pin!(notified);
        // Register the waiter BEFORE re-checking: `notify_waiters` stores no permit,
        // so a completion landing between an unregistered check and the first poll
        // would be lost and this await would hang forever.
        notified.as_mut().enable();
        if entry.completed.load(Ordering::Acquire) {
            break;
        }
        notified.await;
    }
    state.finish_cancel_generation(&connection_id, entry.generation);
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await?;
    if c.transaction.owns_session() && c.backend.manual_session_ended() {
        c.mark_transaction_lost();
    }
    Ok(c.transaction.clone())
}

fn persist_export_temp(
    temp_path: tempfile::TempPath,
    destination: &std::path::Path,
) -> Result<(), AppError> {
    let parent = destination.parent().map(std::path::Path::to_path_buf);
    std::fs::OpenOptions::new()
        .write(true)
        .open(&temp_path)
        .and_then(|file| file.sync_all())
        .map_err(|error| AppError::new(format!("cannot sync export temp file: {error}")))?;
    temp_path.persist(destination).map_err(|error| {
        AppError::new(format!(
            "cannot replace export destination: {}",
            error.error
        ))
    })?;
    #[cfg(unix)]
    if let Some(parent) = parent {
        std::fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| AppError::new(format!("cannot sync export directory: {e}")))?;
    }
    #[cfg(not(unix))]
    let _ = parent;
    Ok(())
}

/// Export to a file with a full options payload. Either streams a query
/// (scope=all, needs a connection) or formats inline rows (scope=loaded).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri deserializes this stable IPC payload by field name.
async fn export_to_file(
    state: tauri::State<'_, AppState>,
    connection_id: Option<String>,
    sql: Option<String>,
    columns: Option<Vec<String>>,
    rows: Option<Vec<Vec<Option<String>>>>,
    options: export::ExportOptions,
    path: String,
    search_path: Option<String>,
) -> Result<u64, AppError> {
    options.validate()?;
    let destination = std::path::PathBuf::from(&path);
    let parent = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| AppError::new("export destination must include a parent directory"))?;
    let temp = tempfile::Builder::new()
        .prefix(".tusk-export-")
        .tempfile_in(parent)
        .map_err(|e| AppError::new(format!("cannot create export temp file: {e}")))?;
    if let Ok(meta) = std::fs::metadata(&destination) {
        temp.as_file()
            .set_permissions(meta.permissions())
            .map_err(|e| AppError::new(e.to_string()))?;
    }
    let temp_path = temp.into_temp_path();
    let temp_name = temp_path
        .to_str()
        .ok_or_else(|| AppError::new("export temp path is not valid UTF-8"))?
        .to_string();

    let result = if let Some(q) = sql {
        validate_sql_size(&q)?;
        let id = connection_id.ok_or_else(|| AppError::new("no connection"))?;
        let conn = state.get(&id)?;
        let mut c = lock_conn(&conn).await?;
        ensure_alive(&mut c).await?;
        c.require_idle("query export")?;
        // Export streams exactly one query through a cursor. Split (dollar-quote aware)
        // so a multi-statement input can't smuggle extra statements (e.g. a trailing
        // DROP) into the DECLARE … CURSOR FOR.
        let items = script::parse_for_engine(q.trim(), c.transaction_engine())?;
        script::preflight_transactions(&items, c.transaction_engine(), &c.transaction)?;
        let export_sql = match items.as_slice() {
            [script::Item::Sql(s)] if !s.trim_end_matches(';').trim().is_empty() => {
                s.trim_end_matches(';').trim().to_string()
            }
            _ => {
                return Err(AppError::new(
                    "export streams exactly one SQL query — select one statement",
                ))
            }
        };
        let duck = matches!(c.backend, driver::Backend::Duck(_));
        if !is_read_only_stmt(&export_sql) || !is_cursorable(&export_sql, duck) {
            return Err(AppError::new(
                "export can re-run exactly one read-only result query",
            ));
        }
        let cancel_registration = state.arm_cancel(
            &id,
            c.backend.cancel_handle(),
            c.backend.config().clone(),
            None,
            c.transaction.clone(),
        )?;
        c.backend.rollback_cursor().await;
        c.backend.apply_search_path(&search_path).await?;
        // Scope=all re-runs the query, so the frontend's grid-based bool detection
        // (typed or heuristic over the LOADED rows) can't vouch for rows it never
        // saw. Override with the server-reported column types — exact for the full
        // stream, including expression columns. Best-effort: empty on failure.
        let mut options = options;
        options.bool_cols = c.backend.bool_columns(&export_sql).await;
        // Cancellation covers type discovery and the full stream.
        // PG streams through a server-side cursor (snapshot-consistent);
        // other drivers page via LIMIT/OFFSET through the same sink feeder.
        let result = if matches!(c.backend, driver::Backend::Pg(_)) {
            export::run_export_query(c.backend.pg()?, &export_sql, &options, &temp_name).await
        } else {
            export::run_export_paged(&mut c.backend, &export_sql, &options, &temp_name).await
        };
        drop(c);
        drop(cancel_registration);
        result
    } else if let (Some(cols), Some(rs)) = (columns, rows) {
        validate_tabular_payload(&cols, &rs)?;
        // Loaded rows carry no backend handle in their payload. Resolve the source
        // dialect from the still-active connection; App's frozen-origin check ensures
        // this is the connection that produced the rows.
        let conn = match connection_id {
            Some(id) => state.get(&id)?,
            None => state.active()?.1,
        };
        let dialect = {
            let c = lock_conn(&conn).await?;
            c.backend.capabilities().kind
        };
        export::run_export_rows_for_dialect(&cols, &rs, &options, dialect, &temp_name).await
    } else {
        Err(AppError::new(
            "export: provide either a query or inline rows",
        ))
    };
    match result {
        Ok(n) => {
            // Empty exports are still valid files (headers, `[]`, CREATE DDL, or an
            // empty workbook) and must replace stale destination content.
            persist_export_temp(temp_path, &destination)?;
            Ok(n)
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
async fn import_rows(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    create: bool,
) -> Result<u64, AppError> {
    validate_tabular_payload(&columns, &rows)?;
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await?;
    ensure_alive(&mut c).await?;
    c.require_idle("import")?;
    if c.read_only {
        return Err(AppError::new("connection is read-only — import blocked"));
    }
    c.backend.rollback_cursor().await;
    // Run create + copy in one transaction so a cancel (or any error) rolls the whole
    // import back — no half-created table, no partial rows. Cancellable via the token.
    let client = c.backend.pg()?;
    let cancel_registration = state.arm_cancel(
        &connection_id,
        c.backend.cancel_handle(),
        c.backend.config().clone(),
        None,
        c.transaction.clone(),
    )?;
    let res = async {
        client.batch_execute("BEGIN").await?;
        if create {
            db::create_table_text(client, &schema, &table, &columns).await?;
        }
        db::copy_rows(client, &schema, &table, &columns, &rows).await
    }
    .await;
    let result = match res {
        Ok(n) => {
            client.batch_execute("COMMIT").await.map_err(|e| {
                AppError::new(format!(
                    "import commit acknowledgement failed; transaction outcome is unknown — verify database state before retrying ({e})"
                ))
            })?;
            Ok(n)
        }
        Err(e) => {
            let _ = client.batch_execute("ROLLBACK").await;
            Err(e)
        }
    };
    drop(c);
    drop(cancel_registration);
    result
}

/// Read a UTF-8 text file by absolute path (the path comes from a native open dialog,
/// i.e. an explicit user gesture). Used by the editor's Open flow.
#[tauri::command]
async fn read_text_file(path: String) -> Result<String, AppError> {
    read_utf8_bounded(
        std::path::Path::new(&path),
        MAX_TEXT_FILE_BYTES as usize,
        "text file",
    )
    .await
}

async fn read_utf8_bounded(
    path: &std::path::Path,
    max: usize,
    label: &str,
) -> Result<String, AppError> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|e| AppError::new(format!("cannot read {}: {e}", path.display())))?;
    let mut bytes = Vec::new();
    file.take((max as u64).saturating_add(1))
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| AppError::new(format!("cannot read {}: {e}", path.display())))?;
    if bytes.len() > max {
        return Err(AppError::new(format!(
            "{label} exceeds the {max}-byte limit"
        )));
    }
    String::from_utf8(bytes).map_err(|_| AppError::new(format!("{label} is not valid UTF-8")))
}

/// Write a UTF-8 text file by absolute path (from a native save dialog). Editor Save flow.
#[tauri::command]
async fn write_text_file(path: String, contents: String) -> Result<(), AppError> {
    if contents.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err(AppError::new(format!(
            "text file exceeds the {MAX_TEXT_FILE_BYTES}-byte limit"
        )));
    }
    atomic_write(std::path::PathBuf::from(path), contents.into_bytes()).await
}

async fn atomic_write(path: std::path::PathBuf, bytes: Vec<u8>) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        let parent = path
            .parent()
            .ok_or_else(|| AppError::new("destination has no parent directory"))?;
        let mut temp =
            tempfile::NamedTempFile::new_in(parent).map_err(|e| AppError::new(e.to_string()))?;
        if let Ok(meta) = std::fs::metadata(&path) {
            temp.as_file()
                .set_permissions(meta.permissions())
                .map_err(|e| AppError::new(e.to_string()))?;
        }
        temp.write_all(&bytes)
            .map_err(|e| AppError::new(e.to_string()))?;
        temp.as_file_mut()
            .sync_all()
            .map_err(|e| AppError::new(e.to_string()))?;
        temp.persist(&path)
            .map_err(|e| AppError::new(e.error.to_string()))?;
        #[cfg(unix)]
        std::fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| AppError::new(format!("cannot sync destination directory: {e}")))?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::new(format!("file write task failed: {e}")))?
}

/// Query-history storage: one JSON file per connection under
/// `<app-config>/history/`. File-backed (not localStorage) so history survives
/// WebView profile resets; the frontend treats failures as "no history" and
/// never blocks query execution on these.
fn history_path(app: &tauri::AppHandle, conn_key: &str) -> Result<std::path::PathBuf, AppError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::new(e.to_string()))?
        .join("history");
    if conn_key.is_empty() || conn_key.len() > 10_000 {
        return Err(AppError::new("invalid history connection key"));
    }
    let safe: String = conn_key
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    // Stable FNV-1a suffix prevents different punctuation-heavy keys from mapping
    // to the same sanitized filename.
    let hash = conn_key
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325u64, |h, b| {
            (h ^ u64::from(*b)).wrapping_mul(0x100000001b3)
        });
    Ok(dir.join(format!("{safe}-{hash:016x}.json")))
}

fn legacy_history_path(
    app: &tauri::AppHandle,
    conn_key: &str,
) -> Result<std::path::PathBuf, AppError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::new(e.to_string()))?
        .join("history");
    let safe: String = conn_key
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    Ok(dir.join(format!("{safe}.json")))
}

#[tauri::command]
async fn load_history(app: tauri::AppHandle, conn_key: String) -> Result<String, AppError> {
    let mut path = history_path(&app, &conn_key)?;
    if !path.exists() {
        if conn_key.len() > 180 {
            return Ok("[]".into());
        }
        let legacy = legacy_history_path(&app, &conn_key)?;
        if !legacy.exists() {
            return Ok("[]".into());
        }
        path = legacy;
    }
    read_utf8_bounded(&path, MAX_HISTORY_BYTES, "history file").await
}

fn validate_history_json(json: &str) -> Result<(), AppError> {
    let parsed: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| AppError::new(format!("history is not valid JSON: {e}")))?;
    if !parsed.is_array() {
        return Err(AppError::new("history must be a JSON array"));
    }
    Ok(())
}

#[tauri::command]
async fn save_history(
    app: tauri::AppHandle,
    conn_key: String,
    json: String,
) -> Result<(), AppError> {
    if json.len() > MAX_HISTORY_BYTES {
        return Err(AppError::new(format!(
            "history exceeds the {MAX_HISTORY_BYTES}-byte limit"
        )));
    }
    validate_history_json(&json)?;
    let path = history_path(&app, &conn_key)?;
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| AppError::new(e.to_string()))?;
    }
    atomic_write(path, json.into_bytes()).await
}

#[tauri::command]
async fn migrate_history(
    app: tauri::AppHandle,
    from_key: String,
    to_key: String,
) -> Result<String, AppError> {
    let target = history_path(&app, &to_key)?;
    // New-key state is authoritative, including an intentionally cleared `[]`.
    if target.exists() {
        let json = read_utf8_bounded(&target, MAX_HISTORY_BYTES, "history file").await?;
        validate_history_json(&json)?;
        return Ok(json);
    }

    let hashed_source = history_path(&app, &from_key)?;
    let legacy_source = (from_key.len() <= 180)
        .then(|| legacy_history_path(&app, &from_key))
        .transpose()?;
    let source = if hashed_source.exists() {
        Some(hashed_source)
    } else {
        legacy_source.filter(|p| p.exists())
    };
    let Some(source) = source else {
        return Ok("[]".into());
    };
    let json = read_utf8_bounded(&source, MAX_HISTORY_BYTES, "legacy history file").await?;
    validate_history_json(&json)?;
    if let Some(dir) = target.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| AppError::new(e.to_string()))?;
    }
    atomic_write(target, json.as_bytes().to_vec()).await?;
    // Delete only after the new file is durable and validated. Failure leaves a
    // harmless duplicate; target existence prevents future resurrection.
    let _ = tokio::fs::remove_file(source).await;
    Ok(json)
}

// ---------------------------------------------------------------------------
// Slack integration commands (bot lifecycle + config; tokens live in the keychain).
// ---------------------------------------------------------------------------

/// Config + token presence for the settings pane (tokens themselves never returned).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SlackConfigInfo {
    config: slack::config::SlackConfig,
    has_bot_token: bool,
    has_app_token: bool,
}

#[tauri::command]
async fn slack_load_config(app: tauri::AppHandle) -> Result<SlackConfigInfo, AppError> {
    let config = slack::config::load(&app)?;
    let (has_bot_token, has_app_token) = slack::config::has_tokens();
    Ok(SlackConfigInfo {
        config,
        has_bot_token,
        has_app_token,
    })
}

#[tauri::command]
async fn slack_save_config(
    app: tauri::AppHandle,
    config: slack::config::SlackConfig,
    bot_token: Option<String>,
    app_token: Option<String>,
) -> Result<(), AppError> {
    config.validate()?;
    let previous = slack::config::load(&app)?;
    let old_tokens = (slack::config::bot_token(), slack::config::app_token());
    let replace_bot = bot_token.as_ref().is_some_and(|token| !token.is_empty());
    let replace_app = app_token.as_ref().is_some_and(|token| !token.is_empty());
    // A token identifies a Slack workspace. Pass through a credential-free state so a
    // crash can never pair newly supplied workspace credentials with the old config.
    if let Err(e) = slack::config::clear_selected_tokens(replace_bot, replace_app) {
        if let Err(rollback) =
            slack::config::restore_tokens(old_tokens.0.clone(), old_tokens.1.clone())
        {
            return Err(AppError::new(format!(
                "{}; Slack token rollback also failed: {}",
                e.message, rollback.message
            )));
        }
        return Err(e);
    }
    if let Err(e) = slack::config::save(&app, &config) {
        let config_rollback = slack::config::save(&app, &previous);
        let token_rollback =
            slack::config::restore_tokens(old_tokens.0.clone(), old_tokens.1.clone());
        if config_rollback.is_err() || token_rollback.is_err() {
            return Err(AppError::new(format!(
                "{}; Slack rollback also failed: config: {}; tokens: {}",
                e.message,
                config_rollback
                    .err()
                    .map(|error| error.message)
                    .unwrap_or_else(|| "restored".into()),
                token_rollback
                    .err()
                    .map(|error| error.message)
                    .unwrap_or_else(|| "restored".into())
            )));
        }
        return Err(e);
    }
    if let Err(e) = slack::config::save_tokens(bot_token, app_token) {
        let config_rollback = slack::config::save(&app, &previous);
        let token_rollback = slack::config::restore_tokens(old_tokens.0, old_tokens.1);
        if config_rollback.is_err() || token_rollback.is_err() {
            return Err(AppError::new(format!(
                "{}; Slack rollback also failed: config: {}; tokens: {}",
                e.message,
                config_rollback
                    .err()
                    .map(|error| error.message)
                    .unwrap_or_else(|| "restored".into()),
                token_rollback
                    .err()
                    .map(|error| error.message)
                    .unwrap_or_else(|| "restored".into())
            )));
        }
        return Err(e);
    }
    Ok(())
}

#[tauri::command]
async fn slack_clear_tokens(app: tauri::AppHandle) -> Result<(), AppError> {
    slack::stop(&app);
    slack::config::clear_tokens()
}

#[tauri::command]
async fn slack_start(app: tauri::AppHandle) -> Result<(), AppError> {
    slack::start(app).await
}

#[tauri::command]
async fn slack_stop(app: tauri::AppHandle) -> Result<(), AppError> {
    slack::stop(&app);
    Ok(())
}

#[tauri::command]
fn slack_status(runtime: tauri::State<'_, slack::SlackRuntime>) -> slack::StatusInfo {
    runtime.status_info()
}

/// Validate both saved tokens without starting the bot: auth.test (bot token) +
/// apps.connections.open (app-level token). Returns the workspace name.
#[tauri::command]
async fn slack_test() -> Result<String, AppError> {
    let bot = slack::config::bot_token().ok_or_else(|| AppError::new("no bot token saved"))?;
    let app_token =
        slack::config::app_token().ok_or_else(|| AppError::new("no app-level token saved"))?;
    let api = slack::api::SlackApi::new(bot);
    let (team, _bot_user) = api.auth_test().await?;
    // Mint (and discard) a socket URL to prove the xapp token + connections:write scope.
    let client = reqwest::Client::new();
    let v: serde_json::Value = client
        .post("https://slack.com/api/apps.connections.open")
        .bearer_auth(&app_token)
        .header("content-type", "application/x-www-form-urlencoded")
        .send()
        .await
        .map_err(|e| AppError::new(e.to_string()))?
        .json()
        .await
        .map_err(|e| AppError::new(e.to_string()))?;
    if v["ok"].as_bool() != Some(true) {
        let err = v["error"].as_str().unwrap_or("unknown error");
        return Err(AppError::new(format!(
            "app-level token check failed: {err} (the xapp token needs the connections:write scope)"
        )));
    }
    Ok(team)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Pin the process-wide rustls CryptoProvider: the dep graph carries BOTH ring
    // (reqwest rustls-tls) and aws-lc-rs (tokio-tungstenite's rustls default) — with
    // two providers present rustls has no default and panics when a TLS config is
    // built (the Slack WebSocket). Ring also spares Windows CI the CMake+NASM
    // toolchain aws-lc-rs needs.
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .manage(slack::SlackRuntime::default())
        .manage(ai::AiCancels::default())
        .setup(|app| {
            crash::install(app.handle());
            // Auto-start the Slack bot when enabled + tokens saved. Failures are
            // non-fatal: the settings pane shows the status and can retry.
            let handle = app.handle().clone();
            if slack::config::load(&handle)
                .map(|c| c.enabled)
                .unwrap_or(false)
            {
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = slack::start(handle).await {
                        eprintln!("[tusk-slack] autostart failed: {}", e.message);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connect,
            connect_profile,
            disconnect,
            list_profiles,
            save_profile,
            delete_profile,
            run_query,
            validate_sql,
            fetch_more,
            list_schema,
            db_tree,
            table_detail,
            sample_rows,
            object_ddl,
            table_relationships,
            schema_relationships,
            list_functions,
            export_to_file,
            capabilities,
            transaction_status,
            permissions,
            cancel_operation,
            import_rows,
            read_text_file,
            write_text_file,
            load_history,
            save_history,
            migrate_history,
            ai::ai_save_key,
            ai::ai_has_key,
            ai::ai_clear_key,
            ai::ai_chat,
            ai::ai_cancel,
            skills::skills_list,
            skills::skills_save,
            skills::skills_delete,
            skills::skills_export,
            skills::skills_import,
            ai::ai_list_models,
            slack_load_config,
            slack_save_config,
            slack_clear_tokens,
            slack_start,
            slack_stop,
            slack_status,
            slack_test,
            crash::crash_report_get,
            crash::crash_report_write,
            crash::crash_report_clear
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
