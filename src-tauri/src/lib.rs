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
use tokio_postgres::SimpleQueryMessage;

use db::{
    AppError, ConnState, ConnectResult, ConnectionConfig, FetchResult, QueryOutcome, CURSOR_NAME,
};
use profiles::Profile;

type Conn = Arc<AsyncMutex<ConnState>>;

#[derive(Default)]
struct AppState {
    conns: Mutex<HashMap<String, Conn>>,
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

    match exec_items(&mut c, &items, page).await {
        Ok(out) => Ok(out),
        // If the connection dropped mid-query, reconnect and retry once.
        Err(_) if c.client.is_closed() => {
            ensure_alive(&mut c).await?;
            exec_items(&mut c, &items, page).await
        }
        Err(e) => Err(e),
    }
}

async fn exec_items(
    c: &mut db::ConnState,
    items: &[script::Item],
    page: u32,
) -> Result<QueryOutcome, AppError> {
    // Abandon any previously open cursor/transaction before starting a new query.
    if c.cursor_open {
        let _ = c.client.batch_execute("ROLLBACK").await;
        c.cursor_open = false;
    }

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
    ensure_alive(&mut c).await?;
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

#[tauri::command]
async fn export_to_file(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    sql: String,
    format: String,
    table: String,
    path: String,
) -> Result<u64, AppError> {
    let conn = state.get(&connection_id)?;
    let mut c = conn.lock().await;
    ensure_alive(&mut c).await?;
    if c.cursor_open {
        let _ = c.client.batch_execute("ROLLBACK").await;
        c.cursor_open = false;
    }
    let trimmed = sql.trim().trim_end_matches(';').trim();
    export::run_export(&c.client, trimmed, &format, &table, &path).await
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
    if create {
        db::create_table_text(&c.client, &schema, &table, &columns).await?;
    }
    db::copy_rows(&c.client, &schema, &table, &columns, &rows).await
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
            fetch_more,
            list_schema,
            db_tree,
            table_detail,
            object_ddl,
            export_to_file,
            import_rows
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
