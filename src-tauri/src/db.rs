use bytes::Bytes;
use futures_util::SinkExt;
use serde::{Deserialize, Serialize};
use tokio_postgres::config::SslMode;
use tokio_postgres::{Client, SimpleQueryMessage};

/// Error type returned to the frontend. Serializes to `{ message: string }`.
#[derive(Debug, Serialize)]
pub struct AppError {
    pub message: String,
}

impl AppError {
    pub fn new(msg: impl Into<String>) -> Self {
        Self {
            message: msg.into(),
        }
    }
}

impl From<tokio_postgres::Error> for AppError {
    fn from(e: tokio_postgres::Error) -> Self {
        use std::error::Error;
        // tokio-postgres' top-level Display is often just "db error" / "error
        // connecting to server" — the useful detail lives in the DbError or the
        // source chain. Surface that instead.
        let message = if let Some(db) = e.as_db_error() {
            match db.hint() {
                Some(h) => format!("{} (hint: {h})", db.message()),
                None => db.message().to_string(),
            }
        } else if let Some(src) = e.source() {
            format!("{e}: {src}")
        } else {
            e.to_string()
        };
        Self { message }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionConfig {
    /// "postgres" (default) | "duckdb" | … — selects the driver. Network fields below
    /// are ignored by embedded drivers (DuckDB uses `path`).
    #[serde(default)]
    pub driver: Option<String>,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub dbname: String,
    /// "disable" | "prefer" (default) | "require" | "verify-full".
    #[serde(default)]
    pub sslmode: Option<String>,
    /// When true, the session is set read-only (writes/DDL rejected by the server).
    #[serde(default)]
    pub read_only: bool,
    /// Embedded-driver database file (DuckDB/SQLite): an absolute path or ":memory:".
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ConnectResult {
    pub connection_id: String,
    pub server_version: String,
    pub read_only: bool,
}

/// Result of a query: either a page of rows (reads) or a status message (writes/DDL).
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueryOutcome {
    Rows {
        columns: Vec<String>,
        rows: Vec<Vec<Option<String>>>,
        done: bool,
    },
    Exec {
        message: String,
    },
}

#[derive(Debug, Serialize)]
pub struct FetchResult {
    pub rows: Vec<Vec<Option<String>>>,
    pub done: bool,
}

/// Name of the server-side cursor used for streaming reads. One per connection.
pub const CURSOR_NAME: &str = "tusk_cur";

/// Open a Postgres connection (TLS per sslmode) and return the client + server version.
/// Map an sslmode string to a `SslMode` (encrypt) flag.
fn ssl_mode_of(cfg: &ConnectionConfig) -> SslMode {
    match cfg.sslmode.as_deref().unwrap_or("prefer") {
        "disable" => SslMode::Disable,
        "require" | "verify-ca" | "verify-full" => SslMode::Require,
        _ => SslMode::Prefer, // prefer: TLS if available, else plaintext
    }
}

/// Build a TLS connector matching the connection's sslmode: always encrypt, but verify
/// the certificate only for `verify-ca`/`verify-full` (libpq semantics). Reused by
/// `open` and by the query-cancel path (which opens its own short-lived connection).
pub fn make_tls(cfg: &ConnectionConfig) -> Result<postgres_native_tls::MakeTlsConnector, AppError> {
    let strict = matches!(cfg.sslmode.as_deref(), Some("verify-ca") | Some("verify-full"));
    let mut builder = native_tls::TlsConnector::builder();
    if !strict {
        builder.danger_accept_invalid_certs(true);
        builder.danger_accept_invalid_hostnames(true);
    }
    let connector = builder.build().map_err(|e| AppError::new(e.to_string()))?;
    Ok(postgres_native_tls::MakeTlsConnector::new(connector))
}

pub async fn open(cfg: &ConnectionConfig) -> Result<(Client, String), AppError> {
    let ssl_mode = ssl_mode_of(cfg);
    let tls = make_tls(cfg)?;

    let mut pgcfg = tokio_postgres::Config::new();
    pgcfg
        .host(&cfg.host)
        .port(cfg.port)
        .user(&cfg.user)
        .password(&cfg.password)
        .dbname(&cfg.dbname)
        .ssl_mode(ssl_mode)
        // Fail fast on a real network/host problem without ever capping query
        // duration: a 10s connect timeout bounds the open path, and aggressive TCP
        // keepalives (+ user-timeout) drop a *dead* connection in ~10-15s — while a
        // slow-but-alive query keeps getting ACKs and runs as long as it needs.
        .connect_timeout(std::time::Duration::from_secs(10))
        .tcp_user_timeout(std::time::Duration::from_secs(15))
        .keepalives(true)
        .keepalives_idle(std::time::Duration::from_secs(5))
        .keepalives_interval(std::time::Duration::from_secs(2))
        .keepalives_retries(3);

    let (client, connection) = pgcfg.connect(tls).await?;

    // Drive the connection's I/O in the background on Tauri's async runtime.
    tauri::async_runtime::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("[tusk] postgres connection error: {e}");
        }
    });

    if cfg.read_only {
        client
            .batch_execute("SET default_transaction_read_only = on")
            .await?;
    }

    let server_version = client
        .simple_query("SHOW server_version")
        .await?
        .into_iter()
        .find_map(|m| match m {
            SimpleQueryMessage::Row(r) => r.get(0).map(|s| s.to_string()),
            _ => None,
        })
        .unwrap_or_else(|| "unknown".to_string());

    Ok((client, server_version))
}

/// Extract column names and text-encoded rows from a batch of simple-query messages.
pub fn collect_rows(messages: &[SimpleQueryMessage]) -> (Vec<String>, Vec<Vec<Option<String>>>) {
    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    for m in messages {
        match m {
            // Sent before the data rows — so a zero-row result still reports its column
            // names (an empty SELECT shows its headers instead of "no results").
            SimpleQueryMessage::RowDescription(cols) => {
                if columns.is_empty() {
                    columns = cols.iter().map(|c| c.name().to_string()).collect();
                }
            }
            SimpleQueryMessage::Row(r) => {
                let cols = r.columns();
                if columns.is_empty() {
                    columns = cols.iter().map(|c| c.name().to_string()).collect();
                }
                let mut row = Vec::with_capacity(cols.len());
                for i in 0..cols.len() {
                    row.push(r.get(i).map(|s| s.to_string()));
                }
                rows.push(row);
            }
            _ => {}
        }
    }
    (columns, rows)
}

/// Quote a Postgres identifier.
pub fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn csv_field(v: &Option<String>) -> String {
    match v {
        None => String::new(),
        Some(s) => {
            if s.is_empty()
                || s.contains(',')
                || s.contains('"')
                || s.contains('\n')
                || s.contains('\r')
            {
                format!("\"{}\"", s.replace('"', "\"\""))
            } else {
                s.clone()
            }
        }
    }
}

/// Create a table whose columns are all `text` (for "create table on import").
pub async fn create_table_text(
    client: &Client,
    schema: &str,
    table: &str,
    columns: &[String],
) -> Result<(), AppError> {
    let cols = columns
        .iter()
        .map(|c| format!("{} text", ident(c)))
        .collect::<Vec<_>>()
        .join(", ");
    client
        .batch_execute(&format!(
            "CREATE TABLE {}.{} ({cols})",
            ident(schema),
            ident(table)
        ))
        .await?;
    Ok(())
}

/// Bulk-insert rows via COPY ... FROM STDIN (CSV). Returns rows written.
pub async fn copy_rows(
    client: &Client,
    schema: &str,
    table: &str,
    columns: &[String],
    rows: &[Vec<Option<String>>],
) -> Result<u64, AppError> {
    let cols = columns.iter().map(|c| ident(c)).collect::<Vec<_>>().join(", ");
    let copy = format!(
        "COPY {}.{} ({cols}) FROM STDIN WITH (FORMAT csv)",
        ident(schema),
        ident(table)
    );
    let sink = client.copy_in(&copy).await?;
    futures_util::pin_mut!(sink);
    let mut buf = String::new();
    for row in rows {
        let line = row.iter().map(csv_field).collect::<Vec<_>>().join(",");
        buf.push_str(&line);
        buf.push('\n');
        if buf.len() >= 64 * 1024 {
            sink.send(Bytes::from(std::mem::take(&mut buf))).await?;
        }
    }
    if !buf.is_empty() {
        sink.send(Bytes::from(buf)).await?;
    }
    Ok(sink.finish().await?)
}
