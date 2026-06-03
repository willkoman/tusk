//! Driver abstraction. A `Backend` is one connected database — Postgres (network) or
//! DuckDB (embedded), with more to follow. The connection-level surface the app needs —
//! query / exec / streaming page / cancel / search-path / introspection — is abstracted
//! here so a new driver is a new enum arm. PG-specific DDL reconstruction, export
//! streaming, server-lint, and import still reach the raw client via `Backend::pg()`
//! (errors on non-PG drivers) until each is abstracted per driver.

use std::sync::{Arc, Mutex};

use tokio_postgres::{CancelToken, Client, SimpleQueryMessage};

use crate::db::{self, AppError, ConnectionConfig, FetchResult, QueryOutcome, CURSOR_NAME};
use crate::script;
use crate::tree;

fn de<E: std::fmt::Display>(e: E) -> AppError {
    AppError::new(e.to_string())
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
        }
    }
    pub fn duckdb() -> Self {
        Self {
            kind: "duckdb",
            server_cursor: false, // paged via LIMIT/OFFSET, not a server cursor
            bulk_copy: false,     // import not yet abstracted for DuckDB
            export: false,        // export streams via a PG cursor — not yet abstracted
            schemas: true,
            search_path: false,
            transactional_ddl: true,
            tls: false,
            keychain: false,
            permissions: false,
        }
    }
}

/// A query-cancel handle usable without holding the connection lock. PG = libpq cancel
/// protocol (own short connection); DuckDB = an interrupt handle on the live connection.
#[derive(Clone)]
pub enum CancelHandle {
    Pg(CancelToken),
    Duck(Arc<duckdb::InterruptHandle>),
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
                handle.interrupt();
                Ok(())
            }
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
    pub conn: Mutex<duckdb::Connection>,
    pub config: ConnectionConfig,
    pub stream_sql: Option<String>,
    pub offset: usize,
}

impl DuckConn {
    /// Lock the connection, recovering the guard even if a prior holder panicked
    /// (poisoning) — a panic mid-query shouldn't permanently brick the connection.
    fn lock(&self) -> std::sync::MutexGuard<'_, duckdb::Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// One connected database, dispatched by driver.
pub enum Backend {
    Pg(PgConn),
    Duck(DuckConn),
}

/// Open a connection for the configured driver. PG = network (TLS); DuckDB = a local
/// file (or `:memory:`), opened read-only when the connection is read-only.
pub async fn connect(config: &ConnectionConfig) -> Result<(Backend, String), AppError> {
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
        other => Err(AppError::new(format!("unknown driver: {other}"))),
    }
}

impl Backend {
    pub fn capabilities(&self) -> Capabilities {
        match self {
            Backend::Pg(_) => Capabilities::postgres(),
            Backend::Duck(_) => Capabilities::duckdb(),
        }
    }

    pub fn config(&self) -> &ConnectionConfig {
        match self {
            Backend::Pg(p) => &p.config,
            Backend::Duck(d) => &d.config,
        }
    }

    pub fn is_closed(&self) -> bool {
        match self {
            Backend::Pg(p) => p.client.is_closed(),
            Backend::Duck(_) => false, // embedded — never "drops"
        }
    }

    pub fn cursor_open(&self) -> bool {
        match self {
            Backend::Pg(p) => p.cursor_open,
            Backend::Duck(d) => d.stream_sql.is_some(),
        }
    }

    pub fn cancel_handle(&self) -> CancelHandle {
        match self {
            Backend::Pg(p) => CancelHandle::Pg(p.client.cancel_token()),
            Backend::Duck(d) => CancelHandle::Duck(d.lock().interrupt_handle()),
        }
    }

    /// Raw Postgres client, for PG-only paths not yet abstracted per driver
    /// (DDL reconstruction / export stream / server-lint / import). Errors otherwise.
    pub fn pg(&self) -> Result<&Client, AppError> {
        match self {
            Backend::Pg(p) => Ok(&p.client),
            Backend::Duck(_) => Err(AppError::new(
                "this operation isn't supported on DuckDB yet",
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
            Backend::Duck(d) => {
                let (backend, _v) = DuckConn::open(&d.config)?;
                if let Backend::Duck(nd) = backend {
                    *d = nd;
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
            Backend::Duck(_) => Ok(()),
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
        }
    }

    /// Run a multi-statement script. PG = one transaction (script::run); DuckDB executes
    /// the SQL items as a batch.
    pub async fn run_script(
        &self,
        items: &[script::Item],
        read_only: bool,
    ) -> Result<String, AppError> {
        match self {
            Backend::Pg(p) => script::run(&p.client, items, read_only).await,
            Backend::Duck(d) => {
                let sql = items
                    .iter()
                    .filter_map(|it| match it {
                        script::Item::Sql(s) => Some(s.trim()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join(";\n");
                d.lock().execute_batch(&sql).map_err(de)?;
                Ok("OK".to_string())
            }
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
            Backend::Duck(d) => d.run_single(trimmed, page, cursorable),
        }
    }

    /// Fetch the next page from the open stream.
    pub async fn fetch_page(&mut self, page: u32) -> Result<FetchResult, AppError> {
        match self {
            Backend::Pg(p) => p.fetch_page(page).await,
            Backend::Duck(d) => d.fetch_page(page),
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
        }
    }

    /// Shallow object tree (sidebar). PG = rich pg_catalog; DuckDB = information_schema.
    pub async fn build_tree(&self) -> Result<tree::DbTree, AppError> {
        match self {
            Backend::Pg(p) => tree::build_shallow(&p.client).await,
            Backend::Duck(d) => duck_build_tree(&d.lock()),
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
        }
    }

    /// Flat schema/table/column list that feeds frontend autocomplete.
    pub async fn list_tables(&self) -> Result<Vec<tree::TableInfo>, AppError> {
        let sql = "SELECT table_schema, table_name, column_name, data_type \
                   FROM information_schema.columns \
                   WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
                   ORDER BY table_schema, table_name, ordinal_position";
        let (_cols, rows) = self.query_text(sql).await?;
        Ok(tree::tables_from_rows(rows))
    }
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
            let messages = self.client.simple_query(&fetch).await?;
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
            })
        } else {
            let messages = self.client.simple_query(trimmed).await?;
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
    fn open(config: &ConnectionConfig) -> Result<(Backend, String), AppError> {
        let path = config
            .path
            .clone()
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| ":memory:".to_string());
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
        let version = conn
            .query_row("SELECT version()", [], |r| r.get::<_, String>(0))
            .unwrap_or_else(|_| "DuckDB".to_string());
        Ok((
            Backend::Duck(DuckConn {
                conn: Mutex::new(conn),
                config: config.clone(),
                stream_sql: None,
                offset: 0,
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
        if cursorable {
            // CAST(COLUMNS(*) AS VARCHAR) renders every column as text (matching the
            // all-text model — handles dates/decimals/etc. cleanly); LIMIT pages it.
            let wrapped =
                format!("SELECT CAST(COLUMNS(*) AS VARCHAR) FROM ({trimmed}) AS _tusk LIMIT {page}");
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
            })
        } else {
            let (columns, rows) = {
                let g = self.lock();
                duck_query(&g, trimmed)?
            };
            if !columns.is_empty() {
                Ok(QueryOutcome::Rows {
                    columns,
                    rows,
                    done: true,
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

/// One connected database in the app registry.
pub struct ConnState {
    pub backend: Backend,
    pub read_only: bool,
}

// --- DuckDB helpers ---

fn duck_value_to_string(v: duckdb::types::Value) -> Option<String> {
    use duckdb::types::Value as V;
    match v {
        V::Null => None,
        V::Boolean(b) => Some(b.to_string()),
        V::TinyInt(n) => Some(n.to_string()),
        V::SmallInt(n) => Some(n.to_string()),
        V::Int(n) => Some(n.to_string()),
        V::BigInt(n) => Some(n.to_string()),
        V::HugeInt(n) => Some(n.to_string()),
        V::UTinyInt(n) => Some(n.to_string()),
        V::USmallInt(n) => Some(n.to_string()),
        V::UInt(n) => Some(n.to_string()),
        V::UBigInt(n) => Some(n.to_string()),
        V::Float(n) => Some(n.to_string()),
        V::Double(n) => Some(n.to_string()),
        V::Text(s) => Some(s),
        V::Blob(b) => Some(String::from_utf8_lossy(&b).into_owned()),
        // Decimal/Timestamp/Date/Time/List/Struct/… — user data is VARCHAR-cast before
        // it reaches here, so this fallback is rare; Debug is acceptable for v1.
        other => Some(format!("{other:?}")),
    }
}

fn duck_query(
    conn: &duckdb::Connection,
    sql: &str,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), AppError> {
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

fn dlit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn duck_build_tree(conn: &duckdb::Connection) -> Result<tree::DbTree, AppError> {
    let database = conn
        .query_row("SELECT current_database()", [], |r| r.get::<_, String>(0))
        .unwrap_or_default();
    let (_c, schema_rows) = duck_query(
        conn,
        "SELECT schema_name FROM information_schema.schemata \
         WHERE schema_name NOT IN ('information_schema','pg_catalog') ORDER BY schema_name",
    )?;
    let (_c2, table_rows) = duck_query(
        conn,
        "SELECT table_schema, table_name, table_type FROM information_schema.tables \
         WHERE table_schema NOT IN ('information_schema','pg_catalog') \
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
    for r in &table_rows {
        let schema = dcell(r, 0);
        let name = dcell(r, 1);
        let is_view = dcell(r, 2).eq_ignore_ascii_case("VIEW");
        if let Some(s) = schemas.iter_mut().find(|s| s.name == schema) {
            let stub = tree::RelStub {
                name,
                kind: if is_view { "view" } else { "table" }.to_string(),
                comment: None,
            };
            if is_view {
                s.views.push(stub);
            } else {
                s.tables.push(stub);
            }
        }
    }
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

    fn duck_mem() -> ConnectionConfig {
        ConnectionConfig {
            driver: Some("duckdb".to_string()),
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
            QueryOutcome::Rows { columns, rows, done } => (columns, rows, done),
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
    let columns = rows
        .iter()
        .map(|r| tree::Column {
            name: dcell(r, 0),
            data_type: dcell(r, 1),
            nullable: dcell(r, 2).eq_ignore_ascii_case("YES"),
            is_pk: false,
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
    })
}
