//! Driver abstraction. A `Backend` is one connected database. Today only Postgres,
//! with DuckDB / MySQL / MSSQL to follow. The connection-level execution surface the
//! app needs — query / exec / streaming cursor / cancel / search-path — is abstracted
//! here so a new driver implements one `match` arm. PG-specific introspection, DDL
//! reconstruction, export streaming, server-lint, and import still reach the raw client
//! via `Backend::pg()` until each is abstracted per driver in later phases.

use tokio_postgres::{CancelToken, Client, SimpleQueryMessage};

use crate::db::{self, AppError, ConnectionConfig, FetchResult, QueryOutcome, CURSOR_NAME};
use crate::script;

/// What a driver supports. The UI gates features on these (hide COPY-import where
/// unsupported, hide the search-path selector, etc.). Serialized to the frontend.
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub kind: &'static str,
    pub server_cursor: bool,
    pub bulk_copy: bool,
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
            schemas: true,
            search_path: true,
            transactional_ddl: true,
            tls: true,
            keychain: true,
            permissions: true,
        }
    }
}

/// A query-cancel handle usable without holding the connection lock. For Postgres this
/// is the libpq cancel protocol (its own short-lived connection); other drivers map to
/// their own interrupt mechanism.
#[derive(Clone)]
pub enum CancelHandle {
    Pg(CancelToken),
}

impl CancelHandle {
    pub async fn cancel(self, cfg: &ConnectionConfig) -> Result<(), AppError> {
        match self {
            CancelHandle::Pg(token) => {
                let tls = db::make_tls(cfg)?;
                token.cancel_query(tls).await?;
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

/// One connected database, dispatched by driver.
pub enum Backend {
    Pg(PgConn),
}

impl Backend {
    pub fn postgres(client: Client, config: ConnectionConfig) -> Self {
        Backend::Pg(PgConn {
            client,
            config,
            cursor_open: false,
        })
    }

    pub fn capabilities(&self) -> Capabilities {
        match self {
            Backend::Pg(_) => Capabilities::postgres(),
        }
    }

    pub fn config(&self) -> &ConnectionConfig {
        match self {
            Backend::Pg(p) => &p.config,
        }
    }

    pub fn is_closed(&self) -> bool {
        match self {
            Backend::Pg(p) => p.client.is_closed(),
        }
    }

    pub fn cursor_open(&self) -> bool {
        match self {
            Backend::Pg(p) => p.cursor_open,
        }
    }

    pub fn cancel_handle(&self) -> CancelHandle {
        match self {
            Backend::Pg(p) => CancelHandle::Pg(p.client.cancel_token()),
        }
    }

    /// Raw Postgres client, for PG-only paths not yet abstracted per driver
    /// (introspection / DDL / export stream / server-lint / import). Errors on a
    /// driver that has no Postgres client.
    pub fn pg(&self) -> Result<&Client, AppError> {
        match self {
            Backend::Pg(p) => Ok(&p.client),
        }
    }

    /// Re-open a dropped connection (idle timeout / server restart / network drop).
    /// Resets cursor state — a fresh connection has none.
    pub async fn reopen(&mut self) -> Result<(), AppError> {
        match self {
            Backend::Pg(p) => {
                let (client, _version) = db::open(&p.config).await?;
                p.client = client;
                p.cursor_open = false;
                Ok(())
            }
        }
    }

    /// Apply the console's active schema (search_path), or reset to the default.
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
        }
    }

    /// Run a multi-statement script (transactional). PG-specific for now.
    pub async fn run_script(
        &self,
        items: &[script::Item],
        read_only: bool,
    ) -> Result<String, AppError> {
        match self {
            Backend::Pg(p) => script::run(&p.client, items, read_only).await,
        }
    }

    /// Run a single statement: stream a cursorable read via a server-side cursor,
    /// otherwise execute and report rows or affected-count.
    pub async fn run_single(
        &mut self,
        trimmed: &str,
        page: u32,
        cursorable: bool,
    ) -> Result<QueryOutcome, AppError> {
        match self {
            Backend::Pg(p) => p.run_single(trimmed, page, cursorable).await,
        }
    }

    /// Fetch the next page from the open streaming cursor.
    pub async fn fetch_page(&mut self, page: u32) -> Result<FetchResult, AppError> {
        match self {
            Backend::Pg(p) => p.fetch_page(page).await,
        }
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

/// One connected database in the app registry.
pub struct ConnState {
    pub backend: Backend,
    pub read_only: bool,
}
