use bytes::Bytes;
use futures_util::SinkExt;
use serde::{Deserialize, Serialize};
use tokio_postgres::config::SslMode;
use tokio_postgres::{Client, SimpleQueryMessage};

/// Error type returned to the frontend. Transaction-aware commands attach the
/// authoritative state observed after the failure.
#[derive(Debug, Serialize)]
pub struct AppError {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transaction: Option<TransactionStatus>,
}

impl AppError {
    pub fn new(msg: impl Into<String>) -> Self {
        Self {
            message: msg.into(),
            transaction: None,
        }
    }

    pub fn with_transaction(mut self, transaction: TransactionStatus) -> Self {
        self.transaction = Some(transaction);
        self
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
        Self {
            message,
            transaction: None,
        }
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

impl ConnectionConfig {
    pub fn validate(&self) -> Result<(), AppError> {
        let driver = self.driver.as_deref().unwrap_or("postgres");
        if !matches!(driver, "postgres" | "duckdb" | "sqlite" | "mysql") {
            return Err(AppError::new(format!("unknown driver: {driver}")));
        }
        if matches!(driver, "postgres" | "mysql") {
            if self.port == 0 {
                return Err(AppError::new("port must be between 1 and 65535"));
            }
            if self.host.len() > 1_000
                || self.user.len() > 1_000
                || self.dbname.len() > 1_000
                || self.password.len() > 64 * 1024
            {
                return Err(AppError::new("connection field exceeds its size limit"));
            }
            let ssl = self.sslmode.as_deref().unwrap_or("prefer");
            if !matches!(
                ssl,
                "disable" | "prefer" | "require" | "verify-ca" | "verify-full"
            ) {
                return Err(AppError::new(format!("unknown sslmode: {ssl}")));
            }
        } else if self.path.as_ref().is_some_and(|p| p.len() > 32_768) {
            return Err(AppError::new("database path is too long"));
        }
        Ok(())
    }
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
        /// Optional advisory context for the result status line.
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    Exec {
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionState {
    Idle,
    Configured,
    Active,
    Failed,
    Lost,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionMode {
    None,
    Explicit,
    AutocommitOff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionHealth {
    Healthy,
    RecoveryRequired,
    Lost,
}

/// Authoritative manual-transaction state for one registered connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionStatus {
    pub state: TransactionState,
    pub revision: u64,
    pub id: Option<String>,
    pub owner: Option<String>,
    pub mode: TransactionMode,
    pub health: TransactionHealth,
}

impl Default for TransactionStatus {
    fn default() -> Self {
        Self {
            state: TransactionState::Idle,
            revision: 0,
            id: None,
            owner: None,
            mode: TransactionMode::None,
            health: TransactionHealth::Healthy,
        }
    }
}

impl TransactionStatus {
    pub fn owns_session(&self) -> bool {
        self.state != TransactionState::Idle
    }
}

/// `run_query` success payload. Flattening preserves the existing outcome fields while
/// adding transaction state beside them.
#[derive(Debug, Serialize)]
pub struct QueryResult {
    #[serde(flatten)]
    pub outcome: QueryOutcome,
    pub transaction: TransactionStatus,
}

/// Internal page returned by drivers.
#[derive(Debug, Serialize)]
pub struct FetchResult {
    pub rows: Vec<Vec<Option<String>>>,
    pub done: bool,
}

/// `fetch_more` success payload.
#[derive(Debug, Serialize)]
pub struct FetchResponse {
    pub rows: Vec<Vec<Option<String>>>,
    pub done: bool,
    /// The stream still had an owner but its server-side cursor was already closed by an
    /// intervening command (metadata read, sidebar DDL, export, import). The rows loaded
    /// so far are all the UI will ever get from this result; it must be marked
    /// incomplete rather than silently reported as complete.
    pub interrupted: bool,
    pub transaction: TransactionStatus,
}

/// Open a Postgres connection (TLS per sslmode) and return the client + server version.
/// Map an sslmode string to a `SslMode` (encrypt) flag.
fn ssl_mode_of(cfg: &ConnectionConfig) -> Result<SslMode, AppError> {
    match cfg.sslmode.as_deref().unwrap_or("prefer") {
        "disable" => Ok(SslMode::Disable),
        "prefer" => Ok(SslMode::Prefer),
        "require" | "verify-ca" | "verify-full" => Ok(SslMode::Require),
        other => Err(AppError::new(format!("unknown sslmode: {other}"))),
    }
}

/// Build a TLS connector matching the connection's sslmode: always encrypt, but verify
/// the certificate only for `verify-ca`/`verify-full` (libpq semantics). Reused by
/// `open` and by the query-cancel path (which opens its own short-lived connection).
pub fn make_tls(cfg: &ConnectionConfig) -> Result<postgres_native_tls::MakeTlsConnector, AppError> {
    let strict = matches!(
        cfg.sslmode.as_deref(),
        Some("verify-ca") | Some("verify-full")
    );
    let mut builder = native_tls::TlsConnector::builder();
    if !strict {
        builder.danger_accept_invalid_certs(true);
        builder.danger_accept_invalid_hostnames(true);
    }
    let connector = builder.build().map_err(|e| AppError::new(e.to_string()))?;
    Ok(postgres_native_tls::MakeTlsConnector::new(connector))
}

pub async fn open(cfg: &ConnectionConfig) -> Result<(Client, String), AppError> {
    let ssl_mode = ssl_mode_of(cfg)?;
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
            SimpleQueryMessage::Row(r) => r.try_get(0).ok().flatten().map(|s| s.to_string()),
            _ => None,
        })
        .unwrap_or_else(|| "unknown".to_string());

    Ok((client, server_version))
}

pub type TextResult = (Vec<String>, Vec<Vec<Option<String>>>);

#[derive(Clone, Copy)]
pub(crate) struct TextLimits {
    pub max_rows: usize,
    pub max_columns: usize,
    pub max_cells: usize,
    pub max_cell_bytes: usize,
    pub max_total_bytes: usize,
}

/// Limits for query pages crossing the Tauri IPC boundary.
pub(crate) const USER_TEXT_LIMITS: TextLimits = TextLimits {
    max_rows: 50_000,
    max_columns: 10_000,
    max_cells: 2_000_000,
    max_cell_bytes: 1024 * 1024,
    max_total_bytes: 64 * 1024 * 1024,
};

/// Limits for catalog output. DDL reconstruction opts into a larger per-cell limit
/// below, but ordinary metadata should never need multi-megabyte scalar values.
pub(crate) const CATALOG_TEXT_LIMITS: TextLimits = TextLimits {
    max_rows: 100_000,
    ..USER_TEXT_LIMITS
};

pub(crate) const DDL_TEXT_LIMITS: TextLimits = TextLimits {
    max_rows: 100_000,
    max_cell_bytes: 8 * 1024 * 1024,
    max_total_bytes: 32 * 1024 * 1024,
    ..USER_TEXT_LIMITS
};

pub(crate) struct TextBudget {
    limits: TextLimits,
    columns: usize,
    rows: usize,
    cells: usize,
    bytes: usize,
}

impl TextBudget {
    pub(crate) fn new(columns: &[String], limits: TextLimits) -> Result<Self, AppError> {
        if columns.len() > limits.max_columns {
            return Err(AppError::new("database result has too many columns"));
        }
        let mut budget = Self {
            limits,
            columns: columns.len(),
            rows: 0,
            cells: 0,
            bytes: 0,
        };
        for column in columns {
            budget.add_value(column, "column name")?;
        }
        Ok(budget)
    }

    fn add_value(&mut self, value: &str, label: &str) -> Result<(), AppError> {
        if value.len() > self.limits.max_cell_bytes {
            return Err(AppError::new(format!(
                "database result {label} exceeds the {}-byte limit",
                self.limits.max_cell_bytes
            )));
        }
        self.bytes = self.bytes.saturating_add(value.len());
        if self.bytes > self.limits.max_total_bytes {
            return Err(AppError::new(format!(
                "database result exceeds the {}-byte limit",
                self.limits.max_total_bytes
            )));
        }
        Ok(())
    }

    pub(crate) fn add_row(&mut self, row: &[Option<String>]) -> Result<(), AppError> {
        if row.len() != self.columns {
            return Err(AppError::new("database returned an inconsistent row shape"));
        }
        self.rows = self.rows.saturating_add(1);
        self.cells = self.cells.saturating_add(row.len());
        if self.rows > self.limits.max_rows || self.cells > self.limits.max_cells {
            return Err(AppError::new(
                "database result exceeds its row or cell limit",
            ));
        }
        for value in row.iter().flatten() {
            self.add_value(value, "value")?;
        }
        Ok(())
    }
}

/// Extract one result set as text. Invalid server-encoding text is a typed failure:
/// `SimpleQueryRow` doesn't expose the original bytes, so replacement characters could
/// not be reversed. Binary types represented by valid text (for example PostgreSQL
/// bytea's `\x...`) pass through unchanged.
pub fn collect_rows(messages: &[SimpleQueryMessage]) -> Result<TextResult, AppError> {
    collect_rows_limited(messages, CATALOG_TEXT_LIMITS)
}

pub(crate) fn collect_rows_limited(
    messages: &[SimpleQueryMessage],
    limits: TextLimits,
) -> Result<TextResult, AppError> {
    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut budget: Option<TextBudget> = None;
    for m in messages {
        match m {
            // Sent before the data rows — so a zero-row result still reports its column
            // names (an empty SELECT shows its headers instead of "no results").
            SimpleQueryMessage::RowDescription(cols) => {
                if columns.is_empty() {
                    columns = cols.iter().map(|c| c.name().to_string()).collect();
                    budget = Some(TextBudget::new(&columns, limits)?);
                } else {
                    return Err(AppError::new(
                        "database returned multiple result sets where one was expected",
                    ));
                }
            }
            SimpleQueryMessage::Row(r) => {
                let cols = r.columns();
                if columns.is_empty() {
                    columns = cols.iter().map(|c| c.name().to_string()).collect();
                    budget = Some(TextBudget::new(&columns, limits)?);
                }
                let mut row = Vec::with_capacity(cols.len());
                for i in 0..cols.len() {
                    // try_get, never get: `get` PANICS when the value isn't valid
                    // UTF-8, which is reachable with zero malice — an SQL_ASCII
                    // database holding latin1 bytes fails here on every SELECT.
                    row.push(match r.try_get(i) {
                        Ok(v) => v.map(|s| s.to_string()),
                        Err(error) => {
                            return Err(AppError::new(format!(
                                "query result column {} contains invalid UTF-8: {error}",
                                i + 1
                            )))
                        }
                    });
                }
                if budget.is_none() {
                    budget = Some(TextBudget::new(&columns, limits)?);
                }
                budget
                    .as_mut()
                    .expect("row columns initialize the text budget")
                    .add_row(&row)?;
                rows.push(row);
            }
            _ => {}
        }
    }
    Ok((columns, rows))
}

/// Quote a Postgres identifier.
pub fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Quote a PostgreSQL text literal independently of the session's
/// `standard_conforming_strings` setting. Escape-string syntax gives backslashes
/// one defined meaning; doubling both backslashes and quotes preserves the input.
pub fn pg_string_literal(value: &str) -> Result<String, AppError> {
    if value.contains('\0') {
        return Err(AppError::new(
            "PostgreSQL text literals cannot contain a zero byte",
        ));
    }
    let mut out = String::with_capacity(value.len().saturating_add(3));
    out.push_str("E'");
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("''"),
            _ => out.push(ch),
        }
    }
    out.push('\'');
    Ok(out)
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
    let cols = columns
        .iter()
        .map(|c| ident(c))
        .collect::<Vec<_>>()
        .join(", ");
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn postgres_literal_is_independent_of_standard_string_mode() {
        assert_eq!(
            pg_string_literal("quote ' and slash \\ and newline\n").unwrap(),
            "E'quote '' and slash \\\\ and newline\n'"
        );
        assert!(pg_string_literal("zero\0byte").is_err());
    }

    #[test]
    fn identifiers_double_embedded_quotes() {
        assert_eq!(ident("odd\"name"), "\"odd\"\"name\"");
    }

    #[test]
    fn text_budget_rejects_shape_and_bytes_incrementally() {
        let limits = TextLimits {
            max_rows: 1,
            max_columns: 2,
            max_cells: 2,
            max_cell_bytes: 3,
            max_total_bytes: 5,
        };
        let columns = vec!["a".to_string(), "b".to_string()];
        let mut budget = TextBudget::new(&columns, limits).unwrap();
        budget
            .add_row(&[Some("x".into()), Some("yy".into())])
            .unwrap();
        assert!(budget.add_row(&[None, None]).is_err());

        assert!(TextBudget::new(&["wide".into()], limits).is_err());
        let mut ragged = TextBudget::new(&columns, limits).unwrap();
        assert!(ragged.add_row(&[Some("x".into())]).is_err());
    }

    #[test]
    fn transaction_ipc_contract_is_structured_on_success_and_error() {
        let transaction = TransactionStatus {
            state: TransactionState::Failed,
            revision: 7,
            id: Some("tx-3".into()),
            owner: Some("tab-9".into()),
            mode: TransactionMode::Explicit,
            health: TransactionHealth::RecoveryRequired,
        };
        let result = QueryResult {
            outcome: QueryOutcome::Exec {
                message: "OK".into(),
            },
            transaction: transaction.clone(),
        };
        let value = serde_json::to_value(result).unwrap();
        assert_eq!(value["kind"], "exec");
        assert_eq!(value["transaction"]["state"], "failed");
        assert_eq!(value["transaction"]["revision"], 7);
        assert_eq!(value["transaction"]["id"], "tx-3");
        assert_eq!(value["transaction"]["owner"], "tab-9");
        assert_eq!(value["transaction"]["mode"], "explicit");
        assert_eq!(value["transaction"]["health"], "recovery_required");

        let error =
            serde_json::to_value(AppError::new("failed").with_transaction(transaction)).unwrap();
        assert_eq!(error["message"], "failed");
        assert_eq!(error["transaction"]["state"], "failed");
    }
}
