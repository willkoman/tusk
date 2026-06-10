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
struct AppState {
    conns: Mutex<HashMap<String, Conn>>,
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
    fn arm_cancel(&self, id: &str, handle: CancelHandle, cfg: ConnectionConfig) {
        self.cancels.lock().unwrap().insert(id.to_string(), (handle, cfg));
    }
    fn disarm_cancel(&self, id: &str) {
        self.cancels.lock().unwrap().remove(id);
    }
    fn cancel_handle(&self, id: &str) -> Option<(CancelHandle, ConnectionConfig)> {
        self.cancels.lock().unwrap().get(id).cloned()
    }

    fn register(&self, backend: Backend, read_only: bool) -> String {
        let id = format!("conn-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let conn = Arc::new(AsyncMutex::new(ConnState { backend, read_only }));
        self.conns.lock().unwrap().insert(id.clone(), conn);
        id
    }
}

/// Re-open the connection if the client was dropped — idle timeout, server restart,
/// or a network drop that TCP keepalives surfaced as `is_closed`. Resets cursor
/// state since a fresh connection has none. Never caps query duration.
async fn ensure_alive(c: &mut ConnState) -> Result<(), AppError> {
    if c.backend.is_closed() {
        c.backend.reopen().await?;
    }
    Ok(())
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
fn is_read_only_stmt(sql: &str) -> bool {
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
    let password = profiles::get_password(&id);
    if p.save_password && password.as_deref().unwrap_or("").is_empty() {
        return Err(AppError::new(
            "couldn't read the saved password from the keychain (macOS may block keychain access for unsigned dev builds) — reconnect via the form, or re-save the connection",
        ));
    }
    let config = ConnectionConfig {
        driver: None,
        host: p.host,
        port: p.port,
        user: p.user,
        password: password.unwrap_or_default(),
        dbname: p.dbname,
        sslmode: p.sslmode,
        read_only: p.read_only,
        path: None,
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
    let removed = state.conns.lock().unwrap().remove(&connection_id);
    if let Some(conn) = removed {
        let mut c = conn.lock().await;
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
    let mut c = conn.lock().await;
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
                let out = c.backend.run_single(last_trimmed, page, true).await;
                if out.is_err() && c.backend.is_closed() {
                    ensure_alive(c).await?;
                    return c.backend.run_single(last_trimmed, page, true).await;
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
    let mut c = conn.lock().await;
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
fn has_bind_params(sql: &str) -> bool {
    let b = sql.as_bytes();
    (0..b.len()).any(|i| b[i] == b'$' && i + 1 < b.len() && b[i + 1].is_ascii_digit())
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
    let mut c = conn.lock().await;
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
    let mut c = conn.lock().await;
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
    let mut c = conn.lock().await;
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
    let mut c = conn.lock().await;
    ensure_alive(&mut c).await?;
    c.backend.rollback_cursor().await;
    c.backend.table_detail(&schema, &name).await
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
    let mut c = conn.lock().await;
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
    let mut c = conn.lock().await;
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
    let mut c = conn.lock().await;
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
    let mut c = conn.lock().await;
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
    let c = conn.lock().await;
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
    let mut c = conn.lock().await;
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
        let mut c = conn.lock().await;
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
        state.arm_cancel(&id, c.backend.cancel_handle(), c.backend.config().clone());
        let result = export::run_export_query(c.backend.pg()?, &sqls[0], &options, &path).await;
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
    let mut c = conn.lock().await;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
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
            ai::ai_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
