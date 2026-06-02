use serde::{Deserialize, Serialize};
use tokio_postgres::{Client, NoTls, SimpleQueryMessage};

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

#[derive(Debug, Deserialize)]
pub struct ConnectionConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub password: String,
    pub dbname: String,
}

#[derive(Debug, Serialize)]
pub struct ConnectResult {
    pub connection_id: String,
    pub server_version: String,
}

/// Result of a query: either a page of rows (reads) or a status message (writes/DDL).
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueryOutcome {
    Rows {
        columns: Vec<String>,
        rows: Vec<Vec<Option<String>>>,
        /// true if the full result set has been delivered (no open cursor remains).
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

/// A live connection plus whether a streaming cursor is currently open on it.
pub struct ConnState {
    pub client: Client,
    pub cursor_open: bool,
}

/// Name of the server-side cursor used for streaming reads. One per connection.
pub const CURSOR_NAME: &str = "tusk_cur";

/// Open a Postgres connection and return the client + server version string.
pub async fn open(cfg: &ConnectionConfig) -> Result<(Client, String), AppError> {
    let (client, connection) = tokio_postgres::Config::new()
        .host(&cfg.host)
        .port(cfg.port)
        .user(&cfg.user)
        .password(&cfg.password)
        .dbname(&cfg.dbname)
        .connect(NoTls)
        .await?;

    // Drive the connection's I/O in the background on Tauri's async runtime.
    tauri::async_runtime::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("[tusk] postgres connection error: {e}");
        }
    });

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
        if let SimpleQueryMessage::Row(r) = m {
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
    }
    (columns, rows)
}
