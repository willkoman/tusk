mod ai;
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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

use tokio::sync::Mutex as AsyncMutex;

use db::{AppError, ConnectResult, ConnectionConfig, FetchResult, QueryOutcome};
use driver::{Backend, CancelHandle, ConnState};
use profiles::Profile;

type Conn = Arc<AsyncMutex<ConnState>>;

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
    cancels: Mutex<HashMap<String, (CancelHandle, ConnectionConfig)>>,
    next_id: AtomicU64,
}

impl AppState {
    fn get(&self, id: &str) -> Result<Conn, AppError> {
        self.conns
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::new("no such connection"))
    }

    /// Arm cancellation for an operation about to run on `id` (call after `ensure_alive`,
    /// with the *current* client's token). `disarm_cancel` must be called when it ends.
    pub(crate) fn arm_cancel(&self, id: &str, handle: CancelHandle, cfg: ConnectionConfig) {
        self.cancels.lock().unwrap().insert(id.to_string(), (handle, cfg));
    }
    pub(crate) fn disarm_cancel(&self, id: &str) {
        self.cancels.lock().unwrap().remove(id);
    }
    pub(crate) fn cancel_handle(&self, id: &str) -> Option<(CancelHandle, ConnectionConfig)> {
        self.cancels.lock().unwrap().get(id).cloned()
    }

    fn register(&self, backend: Backend, read_only: bool) -> String {
        let id = format!("conn-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let conn = Arc::new(AsyncMutex::new(ConnState { backend, read_only }));
        self.conns.lock().unwrap().insert(id.clone(), conn);
        *self.active_conn_id.lock().unwrap() = Some(id.clone());
        id
    }

    /// The connection the Slack bot should use: the UI's active one, falling back to
    /// the sole registered connection.
    pub(crate) fn active(&self) -> Result<(String, Conn), AppError> {
        let active = self.active_conn_id.lock().unwrap().clone();
        let conns = self.conns.lock().unwrap();
        if let Some(id) = active {
            if let Some(c) = conns.get(&id) {
                return Ok((id, c.clone()));
            }
        }
        if conns.len() == 1 {
            let (k, v) = conns.iter().next().unwrap();
            return Ok((k.clone(), v.clone()));
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
    if c.backend.is_closed() {
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
        self.inner.backend.release_idle();
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
pub(crate) async fn lock_conn(conn: &Conn) -> ConnGuard<'_> {
    ConnGuard { inner: conn.lock().await }
}

/// Only plain read queries can be wrapped in a server-side cursor for streaming.
fn is_cursorable(sql: &str) -> bool {
    let t = sql.trim_start().to_ascii_lowercase();
    t.starts_with("select")
        || t.starts_with("with")
        || t.starts_with("table")
        || t.starts_with("values")
}

/// Statements allowed on a read-only connection.
pub(crate) fn is_read_only_stmt(sql: &str) -> bool {
    let t = sql.trim_start().to_ascii_lowercase();
    t.starts_with("select")
        || t.starts_with("with")
        || t.starts_with("show")
        || t.starts_with("explain")
        || t.starts_with("table")
        || t.starts_with("values")
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
    let password = if embedded { None } else { profiles::get_password(&id) };
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
    state.disarm_cancel(&connection_id);
    {
        let mut active = state.active_conn_id.lock().unwrap();
        if active.as_deref() == Some(connection_id.as_str()) {
            *active = None;
        }
    }
    let removed = state.conns.lock().unwrap().remove(&connection_id);
    if let Some(conn) = removed {
        let mut c = lock_conn(&conn).await;
        c.backend.rollback_cursor().await;
    }
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
    sql: String,
    page_size: Option<u32>,
    search_path: Option<String>,
) -> Result<QueryOutcome, AppError> {
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await;
    let page = page_size.unwrap_or(1000);
    ensure_alive(&mut c).await?;

    let items = script::split(sql.trim());
    if items.is_empty() {
        return Ok(QueryOutcome::Exec {
            message: "OK (nothing to run)".to_string(),
        });
    }

    // Arm cancellation so the Run button can interrupt this query (Postgres CancelRequest)
    // by re-clicking. Armed after ensure_alive so the handle matches the live backend; the
    // handle lives outside the per-connection lock we hold here so `cancel_operation` reaches it.
    state.arm_cancel(&connection_id, c.backend.cancel_handle(), c.backend.config().clone());
    let out = match exec_items(&mut c, &items, page, &search_path).await {
        Ok(out) => Ok(out),
        // If the connection dropped mid-query, reconnect and retry once.
        Err(_) if c.backend.is_closed() => {
            ensure_alive(&mut c).await?;
            state.arm_cancel(&connection_id, c.backend.cancel_handle(), c.backend.config().clone());
            exec_items(&mut c, &items, page, &search_path).await
        }
        Err(e) => Err(e),
    };
    state.disarm_cancel(&connection_id);
    out
}

async fn exec_items(
    c: &mut ConnState,
    items: &[script::Item],
    page: u32,
    search_path: &Option<String>,
) -> Result<QueryOutcome, AppError> {
    // Abandon any previously open cursor/transaction before starting a new query.
    c.backend.rollback_cursor().await;
    c.backend.apply_search_path(search_path).await?;

    // Read-only enforcement, uniform across drivers AND single/multi-statement input.
    // PG also sets `default_transaction_read_only` and embedded files open read-only, but
    // MySQL has no engine-level read-only — so this app-layer guard is what protects it.
    // Any write/DDL statement (or a COPY block) on a read-only connection is rejected.
    if c.read_only {
        let has_write = items.iter().any(|it| match it {
            script::Item::Sql(s) => !is_read_only_stmt(s.trim()),
            script::Item::Copy { .. } => true,
        });
        if has_write {
            return Err(AppError::new(
                "connection is read-only — writes and DDL are blocked",
            ));
        }
    }

    // A single plain statement runs interactively (streaming result grid).
    if items.len() == 1 {
        if let script::Item::Sql(stmt) = &items[0] {
            let trimmed = stmt.trim();
            return c.backend.run_single(trimmed, page, is_cursorable(trimmed)).await;
        }
    }

    // Multiple statements where the LAST one is a cursorable read: run the leading
    // statements as a transactional script (atomic — rolls back on error), then STREAM
    // the last statement to the grid so its result is shown, with full pagination just
    // like a single-statement run. (A trailing read can't dirty state, so the only
    // semantic shift vs. one big transaction is that a *failing* trailing SELECT no
    // longer rolls the already-committed leading statements back.)
    if items.len() > 1 {
        if let Some(script::Item::Sql(last)) = items.last() {
            let last_trimmed = last.trim();
            if is_cursorable(last_trimmed) {
                c.backend
                    .run_script(&items[..items.len() - 1], c.read_only)
                    .await?;
                // The leading statements are now committed and must never be replayed.
                // If streaming the trailing read trips on a dropped connection, heal it
                // in place and retry ONLY the read — then return alive so run_query's
                // outer retry (which re-runs the whole batch) can't fire and double-apply.
                let mut out = c.backend.run_single(last_trimmed, page, true).await;
                if out.is_err() && c.backend.is_closed() {
                    ensure_alive(c).await?;
                    out = c.backend.run_single(last_trimmed, page, true).await;
                }
                // Tell the user the earlier statements ran too — when several
                // are reads, their results were silently superseded by this one.
                if let Ok(QueryOutcome::Rows { note, .. }) = &mut out {
                    let leading_reads = items[..items.len() - 1].iter().any(|it| {
                        matches!(it, script::Item::Sql(s) if is_cursorable(s.trim()))
                    });
                    *note = Some(if leading_reads {
                        "earlier statements executed — only the last result is shown".into()
                    } else {
                        format!("{} earlier statement(s) executed", items.len() - 1)
                    });
                }
                return out;
            }
        }
    }

    // Multiple statements (or a COPY block) run as a script.
    let msg = c.backend.run_script(items, c.read_only).await?;
    Ok(QueryOutcome::Exec { message: msg })
}

#[tauri::command]
async fn fetch_more(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    page_size: Option<u32>,
) -> Result<FetchResult, AppError> {
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await;
    let was_streaming = c.backend.cursor_open();
    ensure_alive(&mut c).await?;
    // A live stream whose connection had to be re-opened (idle timeout, server restart,
    // or a network drop surfaced by TCP keepalives) has lost its server-side cursor — it
    // lived in a transaction on the old connection. Don't silently report `done`: that
    // truncates the result with no indication. Surface the break so the UI can show it;
    // the user re-runs to load the rest.
    if was_streaming && !c.backend.cursor_open() {
        return Err(AppError::new(
            "connection dropped mid-stream — the result is incomplete. Re-run the query to load the rest.",
        ));
    }
    let page = page_size.unwrap_or(1000);
    if !c.backend.cursor_open() {
        return Ok(FetchResult {
            rows: vec![],
            done: true,
        });
    }
    c.backend.fetch_page(page).await
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
        "create", "alter", "drop", "truncate", "grant", "revoke", "comment", "set", "reset",
        "show", "copy", "vacuum", "analyze", "analyse", "begin", "start", "commit", "end",
        "rollback", "abort", "savepoint", "release", "do", "call", "declare", "fetch", "move",
        "close", "prepare", "execute", "deallocate", "listen", "notify", "unlisten", "lock",
        "reindex", "cluster", "refresh", "checkpoint", "discard", "import", "security",
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
/// Also treats `:name` (the editor's named-parameter style, prompted at run time)
/// as a parameter, scanning OUTSIDE strings/comments/quoted idents/dollar bodies so
/// `'a:b'` or `::casts` don't trigger it.
fn has_bind_params(sql: &str) -> bool {
    let b = sql.as_bytes();
    let n = b.len();
    let mut i = 0usize;
    while i < n {
        let c = b[i];
        // skip line comment
        if c == b'-' && i + 1 < n && b[i + 1] == b'-' {
            while i < n && b[i] != b'\n' { i += 1; }
            continue;
        }
        // skip block comment
        if c == b'/' && i + 1 < n && b[i + 1] == b'*' {
            i += 2;
            while i + 1 < n && !(b[i] == b'*' && b[i + 1] == b'/') { i += 1; }
            i = (i + 2).min(n);
            continue;
        }
        // skip quoted regions
        if c == b'\'' || c == b'"' {
            let q = c;
            i += 1;
            while i < n {
                if b[i] == q {
                    if i + 1 < n && b[i + 1] == q { i += 2; continue; }
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
                    if &b[j..j + tag.len()] == tag { i = j + tag.len(); break; }
                    j += 1;
                }
                if j + tag.len() > n { return false; } // unterminated — nothing further to find
                continue;
            }
            i += 1;
            continue;
        }
        if c == b':' {
            // `::cast` is two colons; word-adjacent colons aren't params either.
            let prev = if i > 0 { b[i - 1] } else { b' ' };
            let next = if i + 1 < n { b[i + 1] } else { b' ' };
            if next == b':' || prev == b':' { i += 2.min(n - i); continue; }
            if (next.is_ascii_alphabetic() || next == b'_')
                && !(prev.is_ascii_alphanumeric() || prev == b'_' || prev == b'"' || prev == b'\'' || prev == b']')
            {
                return true; // :name-style
            }
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
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await;
    ensure_alive(&mut c).await?;
    c.backend.rollback_cursor().await;
    c.backend.apply_search_path(&search_path).await?;
    let client = c.backend.pg()?;
    let _ = client.batch_execute("DEALLOCATE ALL").await;

    let items = script::split(sql.trim());
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
    let mut c = lock_conn(&conn).await;
    ensure_alive(&mut c).await?;
    c.backend.rollback_cursor().await;
    c.backend.list_tables().await
}

#[tauri::command]
async fn db_tree(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<tree::DbTree, AppError> {
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await;
    ensure_alive(&mut c).await?;
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
    let mut c = lock_conn(&conn).await;
    ensure_alive(&mut c).await?;
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
    let mut c = lock_conn(&conn).await;
    ensure_alive(&mut c).await?;
    let (columns, rows) = c.backend.sample_rows(&schema, &name, limit.unwrap_or(5)).await?;
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
    let mut c = lock_conn(&conn).await;
    ensure_alive(&mut c).await?;
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
    let mut c = lock_conn(&conn).await;
    ensure_alive(&mut c).await?;
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
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await;
    ensure_alive(&mut c).await?;
    c.backend.rollback_cursor().await;
    c.backend.table_relationships(&schema, &name).await
}

/// All FK edges + table summaries of one schema, for the whole-schema ERD.
#[tauri::command]
async fn schema_relationships(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    schema: String,
) -> Result<relgraph::SchemaGraph, AppError> {
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await;
    ensure_alive(&mut c).await?;
    c.backend.rollback_cursor().await;
    c.backend.schema_relationships(&schema).await
}

/// Immediately cancel the cancellable operation in flight on a connection (a streaming
/// export or an import). Sends a Postgres CancelRequest over a fresh connection, which
/// interrupts the running query; the operation's own command then rolls back (and an
/// export deletes its partial file). A no-op if nothing is armed.
/// Report what the connected driver supports, so the UI can gate features (hide
/// COPY-import / search-path / etc. where unsupported). PG today; per-driver later.
#[tauri::command]
async fn capabilities(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<driver::Capabilities, AppError> {
    let conn = state.get(&connection_id)?;
    let c = lock_conn(&conn).await;
    Ok(c.backend.capabilities())
}

/// The connected role's effective privileges (Postgres). The frontend gates sidebar DDL
/// actions on these; refreshed on every introspection reload.
#[tauri::command]
async fn permissions(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<perms::Permissions, AppError> {
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await;
    ensure_alive(&mut c).await?;
    c.backend.rollback_cursor().await;
    c.backend.permissions().await
}

#[tauri::command]
async fn cancel_operation(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<(), AppError> {
    if let Some((handle, cfg)) = state.cancel_handle(&connection_id) {
        handle.cancel(&cfg).await?;
    }
    Ok(())
}

/// Export to a file with a full options payload. Either streams a query
/// (scope=all, needs a connection) or formats inline rows (scope=loaded).
#[tauri::command]
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
    if let Some(q) = sql {
        let id = connection_id.ok_or_else(|| AppError::new("no connection"))?;
        let conn = state.get(&id)?;
        let mut c = lock_conn(&conn).await;
        ensure_alive(&mut c).await?;
        c.backend.rollback_cursor().await;
        c.backend.apply_search_path(&search_path).await?;
        // Export streams exactly one query through a cursor. Split (dollar-quote aware)
        // so a multi-statement input can't smuggle extra statements (e.g. a trailing
        // DROP) into the DECLARE … CURSOR FOR.
        let sqls: Vec<String> = script::split(q.trim())
            .into_iter()
            .filter_map(|it| match it {
                script::Item::Sql(s) => {
                    let t = s.trim_end_matches(';').trim().to_string();
                    (!t.is_empty()).then_some(t)
                }
                _ => None,
            })
            .collect();
        if sqls.len() != 1 {
            return Err(AppError::new("export streams a single query — select one statement"));
        }
        // Arm cancellation for the duration of the stream, then always disarm.
        // PG streams through a server-side cursor (snapshot-consistent);
        // other drivers page via LIMIT/OFFSET through the same sink feeder.
        state.arm_cancel(&id, c.backend.cancel_handle(), c.backend.config().clone());
        let result = if matches!(c.backend, driver::Backend::Pg(_)) {
            export::run_export_query(c.backend.pg()?, &sqls[0], &options, &path).await
        } else {
            export::run_export_paged(&mut c.backend, &sqls[0], &options, &path).await
        };
        state.disarm_cancel(&id);
        result
    } else if let (Some(cols), Some(rs)) = (columns, rows) {
        export::run_export_rows(&cols, &rs, &options, &path).await
    } else {
        Err(AppError::new("export: provide either a query or inline rows"))
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
    let conn = state.get(&connection_id)?;
    let mut c = lock_conn(&conn).await;
    ensure_alive(&mut c).await?;
    if c.read_only {
        return Err(AppError::new("connection is read-only — import blocked"));
    }
    c.backend.rollback_cursor().await;
    // Run create + copy in one transaction so a cancel (or any error) rolls the whole
    // import back — no half-created table, no partial rows. Cancellable via the token.
    state.arm_cancel(&connection_id, c.backend.cancel_handle(), c.backend.config().clone());
    let client = c.backend.pg()?;
    let res = async {
        client.batch_execute("BEGIN").await?;
        if create {
            db::create_table_text(client, &schema, &table, &columns).await?;
        }
        db::copy_rows(client, &schema, &table, &columns, &rows).await
    }
    .await;
    state.disarm_cancel(&connection_id);
    match res {
        Ok(n) => {
            client.batch_execute("COMMIT").await?;
            Ok(n)
        }
        Err(e) => {
            let _ = client.batch_execute("ROLLBACK").await;
            Err(e)
        }
    }
}

/// Read a UTF-8 text file by absolute path (the path comes from a native open dialog,
/// i.e. an explicit user gesture). Used by the editor's Open flow.
#[tauri::command]
async fn read_text_file(path: String) -> Result<String, AppError> {
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| AppError::new(e.to_string()))
}

/// Write a UTF-8 text file by absolute path (from a native save dialog). Editor Save flow.
#[tauri::command]
async fn write_text_file(path: String, contents: String) -> Result<(), AppError> {
    tokio::fs::write(&path, contents)
        .await
        .map_err(|e| AppError::new(e.to_string()))
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
    let safe: String = conn_key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    Ok(dir.join(format!("{safe}.json")))
}

#[tauri::command]
async fn load_history(app: tauri::AppHandle, conn_key: String) -> Result<String, AppError> {
    let path = history_path(&app, &conn_key)?;
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("[]".into()),
        Err(e) => Err(AppError::new(e.to_string())),
    }
}

#[tauri::command]
async fn save_history(app: tauri::AppHandle, conn_key: String, json: String) -> Result<(), AppError> {
    let path = history_path(&app, &conn_key)?;
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| AppError::new(e.to_string()))?;
    }
    tokio::fs::write(&path, json)
        .await
        .map_err(|e| AppError::new(e.to_string()))
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
    Ok(SlackConfigInfo { config, has_bot_token, has_app_token })
}

#[tauri::command]
async fn slack_save_config(
    app: tauri::AppHandle,
    config: slack::config::SlackConfig,
    bot_token: Option<String>,
    app_token: Option<String>,
) -> Result<(), AppError> {
    slack::config::save_tokens(bot_token, app_token)?;
    slack::config::save(&app, &config)
}

#[tauri::command]
async fn slack_clear_tokens(app: tauri::AppHandle) -> Result<(), AppError> {
    slack::stop(&app);
    slack::config::clear_tokens();
    Ok(())
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
    let bot = slack::config::bot_token()
        .ok_or_else(|| AppError::new("no bot token saved"))?;
    let app_token = slack::config::app_token()
        .ok_or_else(|| AppError::new("no app-level token saved"))?;
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
            // Auto-start the Slack bot when enabled + tokens saved. Failures are
            // non-fatal: the settings pane shows the status and can retry.
            let handle = app.handle().clone();
            if slack::config::load(&handle).map(|c| c.enabled).unwrap_or(false) {
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
            permissions,
            cancel_operation,
            import_rows,
            read_text_file,
            write_text_file,
            load_history,
            save_history,
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
            slack_test
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
