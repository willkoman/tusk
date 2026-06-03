mod db;
mod ddl;
mod export;
mod profiles;
mod script;
mod tree;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

use tokio::sync::Mutex as AsyncMutex;
use tokio_postgres::{CancelToken, SimpleQueryMessage};

use db::{
    AppError, ConnState, ConnectResult, ConnectionConfig, FetchResult, QueryOutcome, CURSOR_NAME,
};
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
    cancels: Mutex<HashMap<String, (CancelToken, ConnectionConfig)>>,
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
    fn arm_cancel(&self, id: &str, token: CancelToken, cfg: ConnectionConfig) {
        self.cancels.lock().unwrap().insert(id.to_string(), (token, cfg));
    }
    fn disarm_cancel(&self, id: &str) {
        self.cancels.lock().unwrap().remove(id);
    }
    fn cancel_handle(&self, id: &str) -> Option<(CancelToken, ConnectionConfig)> {
        self.cancels.lock().unwrap().get(id).cloned()
    }

    fn register(&self, client: tokio_postgres::Client, config: ConnectionConfig) -> String {
        let id = format!("conn-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let conn = Arc::new(AsyncMutex::new(ConnState {
            client,
            cursor_open: false,
            read_only: config.read_only,
            config,
        }));
        self.conns.lock().unwrap().insert(id.clone(), conn);
        id
    }
}

/// Re-open the connection if the client was dropped — idle timeout, server restart,
/// or a network drop that TCP keepalives surfaced as `is_closed`. Resets cursor
/// state since a fresh connection has none. Never caps query duration.
async fn ensure_alive(c: &mut ConnState) -> Result<(), AppError> {
    if c.client.is_closed() {
        let (client, _version) = db::open(&c.config).await?;
        c.client = client;
        c.cursor_open = false;
    }
    Ok(())
}

/// Set the session `search_path` to the console's active schema (+ public), or reset
/// to the connection default when no schema is chosen. Session-level, so it's
/// re-applied on every run to keep tabs isolated over the shared connection.
async fn apply_search_path(
    client: &tokio_postgres::Client,
    schema: &Option<String>,
) -> Result<(), AppError> {
    let sql = match schema.as_deref() {
        Some(s) if !s.is_empty() => format!("SET search_path TO {}, public", db::ident(s)),
        _ => "RESET search_path".to_string(),
    };
    client.batch_execute(&sql).await.map_err(Into::into)
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
    let (client, server_version) = db::open(&config).await?;
    let read_only = config.read_only;
    Ok(ConnectResult {
        connection_id: state.register(client, config),
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
        host: p.host,
        port: p.port,
        user: p.user,
        password: password.unwrap_or_default(),
        dbname: p.dbname,
        sslmode: p.sslmode,
        read_only: p.read_only,
    };
    let read_only = config.read_only;
    let (client, server_version) = db::open(&config).await?;
    Ok(ConnectResult {
        connection_id: state.register(client, config),
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
        if c.cursor_open {
            let _ = c.client.batch_execute("ROLLBACK").await;
            c.cursor_open = false;
        }
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

    match exec_items(&mut c, &items, page, &search_path).await {
        Ok(out) => Ok(out),
        // If the connection dropped mid-query, reconnect and retry once.
        Err(_) if c.client.is_closed() => {
            ensure_alive(&mut c).await?;
            exec_items(&mut c, &items, page, &search_path).await
        }
        Err(e) => Err(e),
    }
}

async fn exec_items(
    c: &mut db::ConnState,
    items: &[script::Item],
    page: u32,
    search_path: &Option<String>,
) -> Result<QueryOutcome, AppError> {
    // Abandon any previously open cursor/transaction before starting a new query.
    if c.cursor_open {
        let _ = c.client.batch_execute("ROLLBACK").await;
        c.cursor_open = false;
    }
    apply_search_path(&c.client, search_path).await?;

    // A single plain statement runs interactively (streaming result grid).
    if items.len() == 1 {
        if let script::Item::Sql(stmt) = &items[0] {
            let trimmed = stmt.trim();
            if c.read_only && !is_read_only_stmt(trimmed) {
                return Err(AppError::new(
                    "connection is read-only — writes and DDL are blocked",
                ));
            }
            return run_single_stmt(c, trimmed, page).await;
        }
    }

    // Multiple statements (or a COPY block) run as a script.
    let msg = script::run(&c.client, items, c.read_only).await?;
    Ok(QueryOutcome::Exec { message: msg })
}

async fn run_single_stmt(
    c: &mut db::ConnState,
    trimmed: &str,
    page: u32,
) -> Result<QueryOutcome, AppError> {
    if is_cursorable(trimmed) {
        c.client.batch_execute("BEGIN").await?;
        let declare = format!("DECLARE {CURSOR_NAME} CURSOR FOR {trimmed}");
        if let Err(e) = c.client.batch_execute(&declare).await {
            let _ = c.client.batch_execute("ROLLBACK").await;
            return Err(e.into());
        }
        let fetch = format!("FETCH FORWARD {page} FROM {CURSOR_NAME}");
        let messages = c.client.simple_query(&fetch).await?;
        let (columns, rows) = db::collect_rows(&messages);
        let done = (rows.len() as u32) < page;
        if done {
            let _ = c
                .client
                .batch_execute(&format!("CLOSE {CURSOR_NAME}"))
                .await;
            let _ = c.client.batch_execute("COMMIT").await;
            c.cursor_open = false;
        } else {
            c.cursor_open = true;
        }
        Ok(QueryOutcome::Rows {
            columns,
            rows,
            done,
        })
    } else {
        let messages = c.client.simple_query(trimmed).await?;
        let (columns, rows) = db::collect_rows(&messages);
        if !columns.is_empty() {
            Ok(QueryOutcome::Rows {
                columns,
                rows,
                done: true,
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
                message: format!("OK ({affected} rows affected)"),
            })
        }
    }
}

#[tauri::command]
async fn fetch_more(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    page_size: Option<u32>,
) -> Result<FetchResult, AppError> {
    let conn = state.get(&connection_id)?;
    let mut c = conn.lock().await;
    let was_streaming = c.cursor_open;
    ensure_alive(&mut c).await?;
    // A live stream whose connection had to be re-opened (idle timeout, server restart,
    // or a network drop surfaced by TCP keepalives) has lost its server-side cursor — it
    // lived in a transaction on the old connection. Don't silently report `done`: that
    // truncates the result with no indication. Surface the break so the UI can show it;
    // the user re-runs to load the rest.
    if was_streaming && !c.cursor_open {
        return Err(AppError::new(
            "connection dropped mid-stream — the result is incomplete. Re-run the query to load the rest.",
        ));
    }
    let page = page_size.unwrap_or(1000);
    if !c.cursor_open {
        return Ok(FetchResult {
            rows: vec![],
            done: true,
        });
    }
    let fetch = format!("FETCH FORWARD {page} FROM {CURSOR_NAME}");
    let messages = c.client.simple_query(&fetch).await?;
    let (_cols, rows) = db::collect_rows(&messages);
    let done = (rows.len() as u32) < page;
    if done {
        let _ = c
            .client
            .batch_execute(&format!("CLOSE {CURSOR_NAME}"))
            .await;
        let _ = c.client.batch_execute("COMMIT").await;
        c.cursor_open = false;
    }
    Ok(FetchResult { rows, done })
}

/// One diagnostic from `validate_sql`: a statement that failed to PREPARE.
#[derive(serde::Serialize)]
struct StmtDiag {
    stmt_index: usize,
    message: String,
    /// 1-based char offset within the statement, mapped back from Postgres.
    position: Option<i32>,
}

/// Statements Postgres can PREPARE (parse + plan, no execution). DDL/utility
/// statements can't be prepared, so we skip them rather than risk anything.
fn is_prepareable(sql: &str) -> bool {
    let t = script::effective_start(sql).to_ascii_lowercase();
    t.starts_with("select")
        || t.starts_with("with")
        || t.starts_with("insert")
        || t.starts_with("update")
        || t.starts_with("delete")
        || t.starts_with("values")
        || t.starts_with("table")
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
    if c.cursor_open {
        let _ = c.client.batch_execute("ROLLBACK").await;
        c.cursor_open = false;
    }
    apply_search_path(&c.client, &search_path).await?;
    let _ = c.client.batch_execute("DEALLOCATE ALL").await;

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
        match c.client.batch_execute(&format!("{prefix}{stmt}")).await {
            Ok(()) => {
                let _ = c.client.batch_execute(&format!("DEALLOCATE {name}")).await;
            }
            Err(e) => diags.push(db_error_diag(&e, prefix_chars, i)),
        }
    }
    Ok(diags)
}

#[derive(serde::Serialize)]
struct ColumnInfo {
    name: String,
    data_type: String,
}

#[derive(serde::Serialize)]
struct TableInfo {
    schema: String,
    name: String,
    columns: Vec<ColumnInfo>,
}

#[tauri::command]
async fn list_schema(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<TableInfo>, AppError> {
    let conn = state.get(&connection_id)?;
    let mut c = conn.lock().await;
    ensure_alive(&mut c).await?;
    if c.cursor_open {
        let _ = c.client.batch_execute("ROLLBACK").await;
        c.cursor_open = false;
    }
    let q = "SELECT table_schema, table_name, column_name, data_type \
             FROM information_schema.columns \
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
             ORDER BY table_schema, table_name, ordinal_position";
    let messages = c.client.simple_query(q).await?;
    let mut tables: Vec<TableInfo> = Vec::new();
    for m in &messages {
        if let SimpleQueryMessage::Row(r) = m {
            let schema = r.get(0).unwrap_or("").to_string();
            let name = r.get(1).unwrap_or("").to_string();
            let col = ColumnInfo {
                name: r.get(2).unwrap_or("").to_string(),
                data_type: r.get(3).unwrap_or("").to_string(),
            };
            match tables.last_mut() {
                Some(t) if t.schema == schema && t.name == name => t.columns.push(col),
                _ => tables.push(TableInfo {
                    schema,
                    name,
                    columns: vec![col],
                }),
            }
        }
    }
    Ok(tables)
}

#[tauri::command]
async fn db_tree(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<tree::DbTree, AppError> {
    let conn = state.get(&connection_id)?;
    let mut c = conn.lock().await;
    ensure_alive(&mut c).await?;
    if c.cursor_open {
        let _ = c.client.batch_execute("ROLLBACK").await;
        c.cursor_open = false;
    }
    tree::build_shallow(&c.client).await
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
    if c.cursor_open {
        let _ = c.client.batch_execute("ROLLBACK").await;
        c.cursor_open = false;
    }
    tree::table_detail(&c.client, &schema, &name).await
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
    if c.cursor_open {
        let _ = c.client.batch_execute("ROLLBACK").await;
        c.cursor_open = false;
    }
    ddl::object_ddl(&c.client, &kind, &schema, &name).await
}

/// Immediately cancel the cancellable operation in flight on a connection (a streaming
/// export or an import). Sends a Postgres CancelRequest over a fresh connection, which
/// interrupts the running query; the operation's own command then rolls back (and an
/// export deletes its partial file). A no-op if nothing is armed.
#[tauri::command]
async fn cancel_operation(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<(), AppError> {
    if let Some((token, cfg)) = state.cancel_handle(&connection_id) {
        let tls = db::make_tls(&cfg)?;
        token.cancel_query(tls).await?;
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
        if c.cursor_open {
            let _ = c.client.batch_execute("ROLLBACK").await;
            c.cursor_open = false;
        }
        apply_search_path(&c.client, &search_path).await?;
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
        state.arm_cancel(&id, c.client.cancel_token(), c.config.clone());
        let result = export::run_export_query(&c.client, &sqls[0], &options, &path).await;
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
    if c.cursor_open {
        let _ = c.client.batch_execute("ROLLBACK").await;
        c.cursor_open = false;
    }
    // Run create + copy in one transaction so a cancel (or any error) rolls the whole
    // import back — no half-created table, no partial rows. Cancellable via the token.
    state.arm_cancel(&connection_id, c.client.cancel_token(), c.config.clone());
    let res = async {
        c.client.batch_execute("BEGIN").await?;
        if create {
            db::create_table_text(&c.client, &schema, &table, &columns).await?;
        }
        db::copy_rows(&c.client, &schema, &table, &columns, &rows).await
    }
    .await;
    state.disarm_cancel(&connection_id);
    match res {
        Ok(n) => {
            c.client.batch_execute("COMMIT").await?;
            Ok(n)
        }
        Err(e) => {
            let _ = c.client.batch_execute("ROLLBACK").await;
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
            export_to_file,
            cancel_operation,
            import_rows,
            read_text_file,
            write_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
