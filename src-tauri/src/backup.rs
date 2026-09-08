//! Native backup / restore. No external binaries (no pg_dump / mysqldump): a dump is
//! produced entirely through the existing driver surface and is plain SQL that Tusk —
//! and the engine's own CLI client — can replay.
//!
//! Layout of a dump (sections omitted when the content option excludes them):
//!
//! ```text
//! -- header comment (tusk version, engine, database, timestamp, options)
//! BEGIN;                       -- only where DDL is transactional and asked for
//! DROP … IF EXISTS             -- include_drop, reverse dependency order
//! CREATE SCHEMA IF NOT EXISTS
//! CREATE SEQUENCE
//! CREATE TABLE (+ indexes, comments)      -- FOREIGN KEYs held back
//! <data>                       -- PG: COPY … FROM stdin blocks; others: INSERTs
//! CREATE VIEW / MATERIALIZED VIEW
//! CREATE FUNCTION / CREATE TRIGGER        -- where the driver can reconstruct them
//! ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY   -- after all data, so FK cycles restore
//! SELECT pg_catalog.setval(…)  -- PostgreSQL sequence positions
//! COMMIT;
//! ```
//!
//! Restore streams the file back through `script::parse_stream_chunk` so a
//! multi-gigabyte dump never has to be resident, and executes statement by statement
//! on the connected backend. A statement is never replayed after the server may have
//! seen it.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufWriter};

use crate::db::{self, AppError};
use crate::driver::Backend;
use crate::export::{ident_for, value_for, SqlDialect};
use crate::script;

// --- limits -----------------------------------------------------------------

/// Objects one backup may cover. A dump is unbounded in bytes by design (it is a
/// backup), but the object inventory it walks is not.
const MAX_BACKUP_OBJECTS: usize = 50_000;
const MAX_SELECTION_ENTRIES: usize = 20_000;
const MAX_NAME_BYTES: usize = 512;
/// Rows fetched per page when a driver has no COPY (DuckDB / SQLite / MySQL).
const DATA_PAGE: u32 = 5_000;
/// Value tuples per emitted multi-row INSERT (mirrors `export.rs`).
const TUPLES_PER_INSERT: usize = 500;
const INSERT_BUFFER_BYTES: usize = 512 * 1024;
/// A PostgreSQL `COPY … FROM stdin` block is closed and reopened every this many
/// bytes. Restore parses one statement (or one COPY data block) at a time, so
/// capping the block size is what keeps our own dumps restorable within
/// `MAX_RESTORE_UNIT_BYTES` no matter how large a table is.
const COPY_BLOCK_BYTES: u64 = 16 * 1024 * 1024;

/// Largest dump file `restore_from_file` will read.
pub const MAX_RESTORE_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Largest single statement (or single COPY data block) a restore will buffer.
const MAX_RESTORE_UNIT_BYTES: usize = 256 * 1024 * 1024;
/// Bytes pulled from disk per restore read (grows to the leftover size so a large
/// COPY block is not re-scanned once per small chunk).
const RESTORE_CHUNK_BYTES: usize = 4 * 1024 * 1024;
/// Header bytes `read_backup_header` returns for the restore pre-flight.
pub const MAX_HEADER_BYTES: usize = 8 * 1024;

const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);

// --- options ----------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualifiedName {
    pub schema: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupOptions {
    /// `database` | `schemas` | `tables`
    #[serde(default = "d_database")]
    pub scope: String,
    #[serde(default)]
    pub schemas: Vec<String>,
    #[serde(default)]
    pub tables: Vec<QualifiedName>,
    /// `all` (schema + data) | `schema` | `data`
    #[serde(default = "d_all")]
    pub content: String,
    #[serde(default)]
    pub include_drop: bool,
    #[serde(default)]
    pub single_transaction: bool,
}

fn d_database() -> String {
    "database".to_string()
}
fn d_all() -> String {
    "all".to_string()
}

fn check_name(value: &str, what: &str) -> Result<(), AppError> {
    if value.is_empty() || value.len() > MAX_NAME_BYTES || value.contains('\0') {
        return Err(AppError::new(format!(
            "invalid {what} name in the selection"
        )));
    }
    Ok(())
}

impl BackupOptions {
    pub fn validate(&self) -> Result<(), AppError> {
        if !matches!(self.scope.as_str(), "database" | "schemas" | "tables") {
            return Err(AppError::new("unsupported backup scope"));
        }
        if !matches!(self.content.as_str(), "all" | "schema" | "data") {
            return Err(AppError::new("unsupported backup content selection"));
        }
        if self.schemas.len() > MAX_SELECTION_ENTRIES || self.tables.len() > MAX_SELECTION_ENTRIES {
            return Err(AppError::new("backup selection exceeds its entry limit"));
        }
        for schema in &self.schemas {
            check_name(schema, "schema")?;
        }
        for table in &self.tables {
            check_name(&table.name, "table")?;
            if !table.schema.is_empty() {
                check_name(&table.schema, "schema")?;
            }
        }
        if self.scope == "schemas" && self.schemas.is_empty() {
            return Err(AppError::new("select at least one schema to back up"));
        }
        if self.scope == "tables" && self.tables.is_empty() {
            return Err(AppError::new("select at least one table to back up"));
        }
        Ok(())
    }

    fn wants_schema(&self) -> bool {
        self.content != "data"
    }
    fn wants_data(&self) -> bool {
        self.content != "schema"
    }
    fn content_label(&self) -> &'static str {
        match self.content.as_str() {
            "schema" => "schema",
            "data" => "data",
            _ => "schema+data",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOptions {
    /// Stop at the first failing statement (default) instead of continuing.
    #[serde(default = "d_true")]
    pub stop_on_error: bool,
    /// Wrap the whole restore in one transaction (engines with transactional DDL).
    #[serde(default)]
    pub single_transaction: bool,
}

fn d_true() -> bool {
    true
}

impl RestoreOptions {
    fn validate(&self) -> Result<(), AppError> {
        if self.single_transaction && !self.stop_on_error {
            return Err(AppError::new(
                "continue-on-error cannot be combined with a single transaction — the first failure aborts the whole unit",
            ));
        }
        Ok(())
    }
}

// --- progress / summaries ---------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupProgress {
    /// `schema` | `data` | `constraints` | `done`
    pub phase: &'static str,
    pub object: String,
    pub tables_done: u64,
    pub tables_total: u64,
    pub rows: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub path: String,
    pub tables: u64,
    pub rows: u64,
    pub bytes: u64,
    pub objects: u64,
    /// Objects whose DDL the driver could not reconstruct (the dump notes them too).
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreProgress {
    pub statements_done: u64,
    /// Always `None` while streaming — the total is only known once the file ends.
    pub statements_total: Option<u64>,
    pub current: String,
    pub rows_copied: u64,
    pub bytes_read: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreFailure {
    pub statement_index: u64,
    pub line: u64,
    pub message: String,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSummary {
    pub statements_ok: u64,
    pub statements_failed: u64,
    pub rows_copied: u64,
    pub bytes_read: u64,
    pub first_error: Option<RestoreFailure>,
    pub cancelled: bool,
    pub committed: bool,
}

// --- timestamps -------------------------------------------------------------

/// Civil date from a day count since 1970-01-01 (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `YYYY-MM-DDTHH:MM:SSZ` for a Unix timestamp. `chrono` is built without its
/// `clock` feature here, so the conversion is done explicitly (and is testable).
pub fn iso_utc(unix_secs: i64) -> String {
    let days = unix_secs.div_euclid(86_400);
    let secs = unix_secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    iso_utc(secs)
}

// --- dump writer ------------------------------------------------------------

/// Sibling-temp writer: the destination is replaced only after a complete, fsynced
/// file exists, so a failed or cancelled backup leaves any previous dump untouched.
struct DumpFile {
    destination: PathBuf,
    temp: Option<tempfile::TempPath>,
    writer: BufWriter<File>,
    bytes: u64,
}

impl DumpFile {
    async fn create(path: &str) -> Result<Self, AppError> {
        let destination = PathBuf::from(path);
        let parent = destination
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let temp = tempfile::Builder::new()
            .prefix(".tusk-backup-")
            .tempfile_in(parent)
            .map_err(|e| AppError::new(format!("cannot create backup temp file: {e}")))?;
        if let Ok(meta) = std::fs::metadata(&destination) {
            let _ = temp.as_file().set_permissions(meta.permissions());
        }
        let temp = temp.into_temp_path();
        let name = temp
            .to_str()
            .ok_or_else(|| AppError::new("backup temp path is not valid UTF-8"))?
            .to_string();
        let file = File::create(&name)
            .await
            .map_err(|e| AppError::new(format!("cannot open backup temp file: {e}")))?;
        Ok(Self {
            destination,
            temp: Some(temp),
            writer: BufWriter::new(file),
            bytes: 0,
        })
    }

    async fn put(&mut self, text: &str) -> Result<(), AppError> {
        self.raw(text.as_bytes()).await
    }

    async fn raw(&mut self, bytes: &[u8]) -> Result<(), AppError> {
        self.writer
            .write_all(bytes)
            .await
            .map_err(|e| AppError::new(format!("backup write failed: {e}")))?;
        self.bytes = self.bytes.saturating_add(bytes.len() as u64);
        Ok(())
    }

    /// One SQL statement plus a terminating `;` and blank line.
    async fn stmt(&mut self, sql: &str) -> Result<(), AppError> {
        let trimmed = sql.trim_end();
        if trimmed.is_empty() {
            return Ok(());
        }
        let text = if trimmed.ends_with(';') {
            format!("{trimmed}\n\n")
        } else {
            format!("{trimmed};\n\n")
        };
        self.put(&text).await
    }

    async fn finish(mut self) -> Result<u64, AppError> {
        self.writer
            .flush()
            .await
            .map_err(|e| AppError::new(format!("backup flush failed: {e}")))?;
        // flush() only reaches the OS cache; sync before the rename so a dump we
        // reported as written survives a crash as far as the platform permits.
        self.writer
            .get_ref()
            .sync_all()
            .await
            .map_err(|e| AppError::new(format!("backup fsync failed: {e}")))?;
        let temp = self
            .temp
            .take()
            .ok_or_else(|| AppError::new("backup temp file disappeared"))?;
        let parent = self.destination.parent().map(Path::to_path_buf);
        temp.persist(&self.destination).map_err(|e| {
            AppError::new(format!("cannot replace backup destination: {}", e.error))
        })?;
        #[cfg(unix)]
        if let Some(parent) = parent {
            std::fs::File::open(parent)
                .and_then(|dir| dir.sync_all())
                .map_err(|e| AppError::new(format!("cannot sync backup directory: {e}")))?;
        }
        #[cfg(not(unix))]
        let _ = parent;
        Ok(self.bytes)
    }
}

// --- small helpers ----------------------------------------------------------

fn cancelled(flag: &AtomicBool) -> Result<(), AppError> {
    if flag.load(Ordering::Relaxed) {
        Err(AppError::new("cancelled"))
    } else {
        Ok(())
    }
}

fn comment_safe(text: &str) -> String {
    text.replace(['\r', '\n'], " ")
}

fn preview_of(sql: &str) -> String {
    comment_safe(sql.trim()).chars().take(120).collect()
}

struct Throttle {
    last: Instant,
}
impl Throttle {
    fn new() -> Self {
        Self {
            last: Instant::now() - PROGRESS_INTERVAL,
        }
    }
    fn ready(&mut self) -> bool {
        if self.last.elapsed() >= PROGRESS_INTERVAL {
            self.last = Instant::now();
            true
        } else {
            false
        }
    }
}

/// Relation identifier as the dump should reference it: schema-qualified where the
/// engine has schemas, bare on SQLite.
fn qual(schema: &str, name: &str, dialect: SqlDialect, schemas: bool) -> String {
    if schemas && !schema.is_empty() {
        format!(
            "{}.{}",
            ident_for(schema, dialect),
            ident_for(name, dialect)
        )
    } else {
        ident_for(name, dialect)
    }
}

/// Split PostgreSQL table DDL into the CREATE half and the trailing
/// `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` statements `ddl.rs` defers. Those
/// are re-emitted after ALL data so restore order can never break on an FK cycle.
fn split_fk_alters(ddl: &str) -> (String, Vec<String>) {
    let mut main = String::with_capacity(ddl.len());
    let mut fks = Vec::new();
    for line in ddl.lines() {
        if line.starts_with("ALTER TABLE ") && line.contains(" ADD CONSTRAINT ") {
            fks.push(line.trim_end().to_string());
        } else {
            main.push_str(line);
            main.push('\n');
        }
    }
    (main.trim_end().to_string(), fks)
}

/// MySQL's `SHOW CREATE TABLE` inlines foreign keys in the table body. Lift them out
/// into trailing `ALTER TABLE … ADD CONSTRAINT` statements, exactly as PostgreSQL's
/// reconstruction already does, so a dump restores in any order — FK cycles included —
/// without depending on a session-level `foreign_key_checks` setting surviving.
fn split_mysql_fk_alters(ddl: &str, relation: &str) -> (String, Vec<String>) {
    let mut body: Vec<String> = Vec::new();
    let mut fks: Vec<String> = Vec::new();
    for line in ddl.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("CONSTRAINT ") && trimmed.contains(" FOREIGN KEY ") {
            let clause = trimmed.trim_end().trim_end_matches(',');
            fks.push(format!("ALTER TABLE {relation} ADD {clause}"));
        } else {
            body.push(line.to_string());
        }
    }
    // Removing the final body entry leaves a dangling comma before the closing `)`.
    for i in 0..body.len() {
        let dangling = body[i].trim_end().ends_with(',')
            && body[i + 1..]
                .iter()
                .find(|l| !l.trim().is_empty())
                .is_some_and(|l| l.trim_start().starts_with(')'));
        if dangling {
            let trimmed = body[i].trim_end();
            body[i] = trimmed[..trimmed.len() - 1].to_string();
        }
    }
    (body.join("\n"), fks)
}

#[derive(Clone)]
struct Rel {
    schema: String,
    name: String,
    kind: String,
}

/// Order tables so a referenced table precedes the table referencing it. Best
/// effort: an FK cycle (or an engine that cannot report edges) keeps catalog order,
/// which is why PostgreSQL additionally defers every FK to a trailing ALTER.
fn topo_order(tables: &[Rel], edges: &[(String, String, String, String)]) -> Vec<Rel> {
    let index: HashMap<(String, String), usize> = tables
        .iter()
        .enumerate()
        .map(|(i, t)| ((t.schema.clone(), t.name.clone()), i))
        .collect();
    let mut deps: Vec<HashSet<usize>> = vec![HashSet::new(); tables.len()];
    for (ss, st, ds, dt) in edges {
        let (Some(&src), Some(&dst)) = (
            index.get(&(ss.clone(), st.clone())),
            index.get(&(ds.clone(), dt.clone())),
        ) else {
            continue;
        };
        if src != dst {
            deps[src].insert(dst);
        }
    }
    let mut done = vec![false; tables.len()];
    let mut out: Vec<Rel> = Vec::with_capacity(tables.len());
    // Repeated sweeps: cheap for the table counts a client deals with, and a cycle
    // simply stops making progress, at which point the rest is appended in order.
    loop {
        let mut progressed = false;
        for i in 0..tables.len() {
            if done[i] || !deps[i].iter().all(|d| done[*d]) {
                continue;
            }
            done[i] = true;
            out.push(tables[i].clone());
            progressed = true;
        }
        if !progressed {
            break;
        }
    }
    for (i, table) in tables.iter().enumerate() {
        if !done[i] {
            out.push(table.clone());
        }
    }
    out
}

// --- backup -----------------------------------------------------------------

/// Write a plain-SQL dump of the selected objects to `path`.
pub async fn run_backup(
    backend: &mut Backend,
    app_version: &str,
    opts: &BackupOptions,
    path: &str,
    cancel: &AtomicBool,
    progress: &mut (dyn FnMut(BackupProgress) + Send),
) -> Result<BackupSummary, AppError> {
    opts.validate()?;
    let is_pg = matches!(backend, Backend::Pg(_));

    // PostgreSQL reads the whole dump inside one repeatable-read transaction, so the
    // catalog and every table agree on one snapshot. The other drivers have no
    // equivalent here (their paged reads are not snapshot-consistent — same class as
    // grid paging), which the dump header does not claim otherwise.
    if is_pg {
        backend.rollback_cursor().await;
        backend
            .pg()?
            .batch_execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .await?;
    }
    let result = backup_inner(backend, app_version, opts, path, cancel, progress).await;
    if is_pg {
        if let Ok(client) = backend.pg() {
            let _ = client.batch_execute("COMMIT").await;
        }
    }
    backend.rollback_cursor().await;
    result
}

async fn backup_inner(
    backend: &mut Backend,
    app_version: &str,
    opts: &BackupOptions,
    path: &str,
    cancel: &AtomicBool,
    progress: &mut (dyn FnMut(BackupProgress) + Send),
) -> Result<BackupSummary, AppError> {
    let caps = backend.capabilities();
    let dialect = SqlDialect::parse(caps.kind)?;
    let is_pg = matches!(backend, Backend::Pg(_));
    let is_mysql = matches!(backend, Backend::MySql(_));

    let tree = backend.build_tree().await?;
    let database = tree.database.clone();

    // --- inventory ---
    let wanted_schema = |name: &str| match opts.scope.as_str() {
        "database" => true,
        "schemas" => opts.schemas.iter().any(|s| s == name),
        _ => opts.tables.iter().any(|t| t.schema == name),
    };
    let wanted_table = |schema: &str, name: &str| {
        opts.scope != "tables"
            || opts
                .tables
                .iter()
                .any(|t| t.schema == schema && t.name == name)
    };

    let mut tables: Vec<Rel> = Vec::new();
    let mut views: Vec<Rel> = Vec::new();
    let mut functions: Vec<(String, String)> = Vec::new();
    let mut schema_names: Vec<String> = Vec::new();
    for schema in &tree.schemas {
        if !wanted_schema(&schema.name) {
            continue;
        }
        schema_names.push(schema.name.clone());
        for t in &schema.tables {
            if wanted_table(&schema.name, &t.name) {
                tables.push(Rel {
                    schema: schema.name.clone(),
                    name: t.name.clone(),
                    kind: t.kind.clone(),
                });
            }
        }
        if opts.scope == "tables" {
            continue; // a table selection covers tables (and their data) only
        }
        for v in &schema.views {
            views.push(Rel {
                schema: schema.name.clone(),
                name: v.name.clone(),
                kind: v.kind.clone(),
            });
        }
        let mut seen_fn: HashSet<&str> = HashSet::new();
        for f in &schema.functions {
            if seen_fn.insert(f.name.as_str()) {
                functions.push((schema.name.clone(), f.name.clone()));
            }
        }
    }
    if opts.scope == "schemas" {
        for requested in &opts.schemas {
            if !schema_names.iter().any(|s| s == requested) {
                return Err(AppError::new(format!(
                    "schema `{}` does not exist on this connection",
                    comment_safe(requested)
                )));
            }
        }
    }
    if tables.len() + views.len() + functions.len() > MAX_BACKUP_OBJECTS {
        return Err(AppError::new(
            "this selection exceeds the 50000-object backup limit — back up fewer schemas at a time",
        ));
    }
    if tables.is_empty() && views.is_empty() && functions.is_empty() {
        return Err(AppError::new("the backup selection contains no objects"));
    }

    // Dependency order (referenced table first) for creates and data; reversed for drops.
    let mut edges: Vec<(String, String, String, String)> = Vec::new();
    for schema in &schema_names {
        if let Ok(graph) = backend.schema_relationships(schema).await {
            for e in graph.edges {
                edges.push((e.src_schema, e.src_table, e.dst_schema, e.dst_table));
            }
        }
    }
    let tables = topo_order(&tables, &edges);

    // PostgreSQL sequences: identity-owned ones are created by their table's DDL, so
    // only the independent ones get a CREATE. All of them get a setval.
    let mut create_sequences: Vec<(String, String)> = Vec::new();
    let mut all_sequences: Vec<(String, String)> = Vec::new();
    if is_pg && opts.scope != "tables" {
        let rows = db::collect_rows(
            &backend
                .pg()?
                .simple_query(
                    "SELECT n.nspname, c.relname, EXISTS (SELECT 1 FROM pg_depend d \
                       WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype = 'i') \
                     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                     WHERE c.relkind = 'S' ORDER BY n.nspname, c.relname",
                )
                .await?,
        )?
        .1;
        for r in &rows {
            let schema = cell(r, 0);
            let name = cell(r, 1);
            if !wanted_schema(&schema) {
                continue;
            }
            all_sequences.push((schema.clone(), name.clone()));
            if cell(r, 2) != "t" {
                create_sequences.push((schema, name));
            }
        }
    }

    // --- write ---
    let mut out = DumpFile::create(path).await?;
    let mut warnings: Vec<String> = Vec::new();
    let mut throttle = Throttle::new();
    let mut rows_total: u64 = 0;
    let mut tables_done: u64 = 0;
    let tables_total = tables.len() as u64;
    let mut objects: u64 = 0;

    let scope_label = match opts.scope.as_str() {
        "schemas" => format!("schemas ({})", schema_names.join(", ")),
        "tables" => format!("{} table(s)", opts.tables.len()),
        _ => "database".to_string(),
    };
    let header = format!(
        "-- Tusk backup\n\
         -- tusk-version: {}\n\
         -- engine: {}\n\
         -- database: {}\n\
         -- generated: {}\n\
         -- scope: {}\n\
         -- content: {}\n\
         -- include-drop: {}\n\
         -- single-transaction: {}\n\
         --\n\
         -- Replay with Tusk (Restore from file…) or this engine's CLI client.\n\n",
        comment_safe(app_version),
        caps.kind,
        comment_safe(&database),
        now_iso(),
        comment_safe(&scope_label),
        opts.content_label(),
        if opts.include_drop { "yes" } else { "no" },
        if opts.single_transaction { "yes" } else { "no" },
    );
    out.put(&header).await?;

    let wrap = opts.single_transaction && caps.transactional_ddl;
    if opts.single_transaction && !caps.transactional_ddl {
        warnings.push(format!(
            "{} does not have transactional DDL — the dump is not wrapped in a transaction",
            caps.kind
        ));
        out.put("-- note: this engine has no transactional DDL; the dump is not wrapped.\n\n")
            .await?;
    }
    if wrap {
        out.put("BEGIN;\n\n").await?;
    }
    if is_mysql {
        out.stmt("SET FOREIGN_KEY_CHECKS = 0").await?;
    }

    let mut fk_alters: Vec<String> = Vec::new();
    let mut triggers: Vec<String> = Vec::new();

    if opts.wants_schema() {
        // Drops, reverse dependency order.
        if opts.include_drop {
            out.put("-- drop existing objects\n").await?;
            for v in views.iter().rev() {
                let kw = if v.kind == "matview" {
                    "MATERIALIZED VIEW"
                } else {
                    "VIEW"
                };
                out.stmt(&format!(
                    "DROP {kw} IF EXISTS {}{}",
                    qual(&v.schema, &v.name, dialect, caps.schemas),
                    if is_pg { " CASCADE" } else { "" }
                ))
                .await?;
            }
            for t in tables.iter().rev() {
                let kw = if t.kind == "matview" {
                    "MATERIALIZED VIEW"
                } else {
                    "TABLE"
                };
                out.stmt(&format!(
                    "DROP {kw} IF EXISTS {}{}",
                    qual(&t.schema, &t.name, dialect, caps.schemas),
                    if is_pg { " CASCADE" } else { "" }
                ))
                .await?;
            }
            for (schema, name) in create_sequences.iter().rev() {
                out.stmt(&format!(
                    "DROP SEQUENCE IF EXISTS {} CASCADE",
                    qual(schema, name, dialect, caps.schemas)
                ))
                .await?;
            }
        }

        // Schemas.
        if caps.schemas {
            out.put("-- schemas\n").await?;
            for schema in &schema_names {
                let stmt = if is_mysql {
                    format!(
                        "CREATE DATABASE IF NOT EXISTS {}",
                        ident_for(schema, dialect)
                    )
                } else {
                    format!("CREATE SCHEMA IF NOT EXISTS {}", ident_for(schema, dialect))
                };
                out.stmt(&stmt).await?;
                objects += 1;
            }
        }

        // Sequences (PostgreSQL).
        if !create_sequences.is_empty() {
            out.put("-- sequences\n").await?;
            for (schema, name) in &create_sequences {
                cancelled(cancel)?;
                match backend.relation_ddl("sequence", schema, name).await {
                    Ok(ddl) => {
                        out.stmt(&ddl).await?;
                        objects += 1;
                    }
                    Err(e) => warnings.push(format!(
                        "sequence {schema}.{name}: {}",
                        comment_safe(&e.message)
                    )),
                }
            }
        }

        // Tables.
        out.put("-- tables\n").await?;
        for t in &tables {
            cancelled(cancel)?;
            if throttle.ready() {
                progress(BackupProgress {
                    phase: "schema",
                    object: format!("{}.{}", t.schema, t.name),
                    tables_done,
                    tables_total,
                    rows: rows_total,
                    bytes: out.bytes,
                });
            }
            match backend.relation_ddl(&t.kind, &t.schema, &t.name).await {
                Ok(ddl) => {
                    let (main, fks) = if is_pg {
                        split_fk_alters(&ddl)
                    } else if is_mysql {
                        split_mysql_fk_alters(
                            &ddl,
                            &qual(&t.schema, &t.name, dialect, caps.schemas),
                        )
                    } else {
                        (ddl, Vec::new())
                    };
                    out.stmt(&main).await?;
                    fk_alters.extend(fks);
                    objects += 1;
                }
                Err(e) => warnings.push(format!(
                    "table {}.{}: {}",
                    t.schema,
                    t.name,
                    comment_safe(&e.message)
                )),
            }
            if is_pg {
                if let Ok(detail) = backend.table_detail(&t.schema, &t.name).await {
                    for trigger in detail.triggers {
                        triggers.push(trigger.def);
                    }
                }
            }
        }
    }

    // Data.
    if opts.wants_data() {
        out.put("-- data\n").await?;
        for t in &tables {
            cancelled(cancel)?;
            if t.kind == "view" {
                continue;
            }
            let columns = data_columns(backend, &t.schema, &t.name, is_pg).await?;
            if columns.is_empty() {
                tables_done += 1;
                continue;
            }
            let binary_cols: Vec<bool> = columns.iter().map(|c| c.binary).collect();
            let columns: Vec<String> = columns.into_iter().map(|c| c.name).collect();
            progress(BackupProgress {
                phase: "data",
                object: format!("{}.{}", t.schema, t.name),
                tables_done,
                tables_total,
                rows: rows_total,
                bytes: out.bytes,
            });
            let relation = qual(&t.schema, &t.name, dialect, caps.schemas);
            let column_list = columns
                .iter()
                .map(|c| ident_for(c, dialect))
                .collect::<Vec<_>>()
                .join(", ");
            if is_pg {
                copy_out_table(
                    backend,
                    &mut out,
                    &relation,
                    &column_list,
                    cancel,
                    &mut throttle,
                    progress,
                    &mut rows_total,
                    tables_done,
                    tables_total,
                    &format!("{}.{}", t.schema, t.name),
                )
                .await?;
            } else {
                insert_table(
                    backend,
                    &mut out,
                    &relation,
                    &column_list,
                    &columns,
                    &binary_cols,
                    dialect,
                    cancel,
                    &mut throttle,
                    progress,
                    &mut rows_total,
                    tables_done,
                    tables_total,
                    &format!("{}.{}", t.schema, t.name),
                )
                .await?;
            }
            tables_done += 1;
        }
    }

    if opts.wants_schema() {
        if !views.is_empty() {
            out.put("-- views\n").await?;
            for v in &views {
                cancelled(cancel)?;
                match backend.relation_ddl(&v.kind, &v.schema, &v.name).await {
                    Ok(ddl) => {
                        out.stmt(&ddl).await?;
                        objects += 1;
                    }
                    Err(e) => warnings.push(format!(
                        "view {}.{}: {}",
                        v.schema,
                        v.name,
                        comment_safe(&e.message)
                    )),
                }
            }
        }
        if is_pg && !functions.is_empty() {
            out.put("-- functions\n").await?;
            for (schema, name) in &functions {
                cancelled(cancel)?;
                match backend.relation_ddl("function", schema, name).await {
                    Ok(ddl) => {
                        out.stmt(&ddl).await?;
                        objects += 1;
                    }
                    Err(e) => warnings.push(format!(
                        "function {schema}.{name}: {}",
                        comment_safe(&e.message)
                    )),
                }
            }
        }
        if !triggers.is_empty() {
            out.put("-- triggers\n").await?;
            for def in &triggers {
                out.stmt(def).await?;
                objects += 1;
            }
        }
        if !fk_alters.is_empty() {
            progress(BackupProgress {
                phase: "constraints",
                object: "foreign keys".to_string(),
                tables_done,
                tables_total,
                rows: rows_total,
                bytes: out.bytes,
            });
            out.put("-- foreign keys (after all data, so cycles restore cleanly)\n")
                .await?;
            for alter in &fk_alters {
                out.stmt(alter).await?;
            }
        }
    }

    // Sequence positions (PostgreSQL) — data, so only when data is included.
    if is_pg && opts.wants_data() && !all_sequences.is_empty() {
        out.put("-- sequence positions\n").await?;
        for (schema, name) in &all_sequences {
            cancelled(cancel)?;
            let relation = format!("{}.{}", db::ident(schema), db::ident(name));
            let read = format!("SELECT last_value, is_called FROM {relation}");
            let Ok(rows) = db::collect_rows(&backend.pg()?.simple_query(&read).await?) else {
                continue;
            };
            let Some(row) = rows.1.first() else { continue };
            let last = cell(row, 0);
            if last.is_empty() {
                continue;
            }
            let called = cell(row, 1) == "t";
            out.stmt(&format!(
                "SELECT pg_catalog.setval({}, {last}, {})",
                db::pg_string_literal(&relation)?,
                if called { "true" } else { "false" }
            ))
            .await?;
        }
    }

    if is_mysql {
        out.stmt("SET FOREIGN_KEY_CHECKS = 1").await?;
    }
    if wrap {
        out.put("COMMIT;\n\n").await?;
    }
    for warning in &warnings {
        out.put(&format!("-- warning: {}\n", comment_safe(warning)))
            .await?;
    }
    out.put(&format!(
        "-- Tusk backup complete: {tables_done} table(s), {rows_total} row(s).\n"
    ))
    .await?;

    let bytes = out.finish().await?;
    progress(BackupProgress {
        phase: "done",
        object: String::new(),
        tables_done,
        tables_total,
        rows: rows_total,
        bytes,
    });
    Ok(BackupSummary {
        path: path.to_string(),
        tables: tables_done,
        rows: rows_total,
        bytes,
        objects,
        warnings,
    })
}

fn cell(row: &[Option<String>], i: usize) -> String {
    row.get(i).and_then(|v| v.clone()).unwrap_or_default()
}

struct DataColumn {
    name: String,
    /// Declared as a binary type, so the driver's reversible `\x…` hex rendering
    /// must go back in as a native blob literal rather than as text.
    binary: bool,
}

fn is_binary_type(data_type: &str) -> bool {
    let t = data_type.trim().to_ascii_lowercase();
    t.contains("blob")
        || t.starts_with("binary")
        || t.starts_with("varbinary")
        || t == "bytea"
        || t == "bit"
}

/// Columns whose values a dump may restore. PostgreSQL asks the catalog directly so
/// generated columns are skipped — `COPY … (generated_col)` is an error on restore.
async fn data_columns(
    backend: &Backend,
    schema: &str,
    name: &str,
    is_pg: bool,
) -> Result<Vec<DataColumn>, AppError> {
    if is_pg {
        // PostgreSQL data goes through COPY, which round-trips bytea itself.
        let rows = backend
            .pg()?
            .query(
                "SELECT a.attname FROM pg_attribute a \
                 JOIN pg_class c ON c.oid = a.attrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 \
                   AND NOT a.attisdropped AND a.attgenerated = '' \
                 ORDER BY a.attnum",
                &[&schema, &name],
            )
            .await?;
        return Ok(rows
            .iter()
            .filter_map(|r| r.try_get::<_, String>(0).ok())
            .map(|name| DataColumn {
                name,
                binary: false,
            })
            .collect());
    }
    Ok(backend
        .table_detail(schema, name)
        .await
        .map(|d| {
            d.columns
                .into_iter()
                .map(|c| DataColumn {
                    binary: is_binary_type(&c.data_type),
                    name: c.name,
                })
                .collect()
        })
        .unwrap_or_default())
}

/// A driver-rendered binary cell (`\x` + lowercase hex, see `driver::binary_text`).
fn binary_hex(value: &str) -> Option<&str> {
    let hex = value.strip_prefix("\\x")?;
    if hex.len() % 2 == 0 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(hex)
    } else {
        None
    }
}

/// Literal for one value of a declared-binary column: a native blob literal when the
/// cell is the driver's reversible hex rendering, otherwise the ordinary dialect
/// literal (a binary column can still hold NULL, and a non-hex value is not ours to
/// reinterpret).
fn binary_literal(value: &Option<String>, dialect: SqlDialect) -> Result<Option<String>, AppError> {
    let Some(text) = value.as_deref() else {
        return Ok(None);
    };
    let Some(hex) = binary_hex(text) else {
        return Ok(None);
    };
    Ok(Some(match dialect {
        SqlDialect::Sqlite | SqlDialect::MySql => format!("X'{hex}'"),
        SqlDialect::DuckDb => format!("from_hex('{hex}')"),
        SqlDialect::Postgres => format!("'\\x{hex}'::bytea"),
    }))
}

/// PostgreSQL data: `COPY … TO STDOUT` streamed straight into the dump as
/// `COPY … FROM stdin` blocks. Nothing is buffered beyond one line.
#[allow(clippy::too_many_arguments)]
async fn copy_out_table(
    backend: &Backend,
    out: &mut DumpFile,
    relation: &str,
    column_list: &str,
    cancel: &AtomicBool,
    throttle: &mut Throttle,
    progress: &mut (dyn FnMut(BackupProgress) + Send),
    rows_total: &mut u64,
    tables_done: u64,
    tables_total: u64,
    object: &str,
) -> Result<u64, AppError> {
    let client = backend.pg()?;
    let header = format!("COPY {relation} ({column_list}) FROM stdin;\n");
    let read_sql = format!("COPY {relation} ({column_list}) TO STDOUT");
    let stream = client.copy_out(read_sql.as_str()).await?;
    futures_util::pin_mut!(stream);
    out.put(&header).await?;
    let mut carry: Vec<u8> = Vec::new();
    let mut rows: u64 = 0;
    let mut block_bytes: u64 = 0;
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::new("cancelled"));
        }
        let chunk = chunk?;
        carry.extend_from_slice(&chunk);
        let mut start = 0usize;
        while let Some(offset) = carry[start..].iter().position(|&b| b == b'\n') {
            let end = start + offset + 1;
            out.raw(&carry[start..end]).await?;
            rows += 1;
            *rows_total += 1;
            block_bytes = block_bytes.saturating_add((end - start) as u64);
            start = end;
            if block_bytes >= COPY_BLOCK_BYTES {
                // Close and reopen the block so restore never has to buffer more
                // than COPY_BLOCK_BYTES of data for one statement unit.
                out.put("\\.\n\n").await?;
                out.put(&header).await?;
                block_bytes = 0;
            }
        }
        carry.drain(..start);
        if throttle.ready() {
            progress(BackupProgress {
                phase: "data",
                object: object.to_string(),
                tables_done,
                tables_total,
                rows: *rows_total,
                bytes: out.bytes,
            });
        }
    }
    if !carry.is_empty() {
        out.raw(&carry).await?;
        out.put("\n").await?;
        rows += 1;
        *rows_total += 1;
    }
    out.put("\\.\n\n").await?;
    Ok(rows)
}

/// DuckDB / SQLite / MySQL data: paged reads formatted as batched multi-row INSERTs
/// through the same dialect-aware literal helpers `export.rs` uses.
#[allow(clippy::too_many_arguments)]
async fn insert_table(
    backend: &mut Backend,
    out: &mut DumpFile,
    relation: &str,
    column_list: &str,
    columns: &[String],
    binary_cols: &[bool],
    dialect: SqlDialect,
    cancel: &AtomicBool,
    throttle: &mut Throttle,
    progress: &mut (dyn FnMut(BackupProgress) + Send),
    rows_total: &mut u64,
    tables_done: u64,
    tables_total: u64,
    object: &str,
) -> Result<u64, AppError> {
    let select = format!("SELECT {column_list} FROM {relation}");
    backend.rollback_cursor().await;
    let first = backend.run_single(&select, DATA_PAGE, true).await?;
    let (mut rows, mut done) = match first {
        db::QueryOutcome::Rows { rows, done, .. } => (rows, done),
        db::QueryOutcome::Exec { .. } => {
            backend.rollback_cursor().await;
            return Ok(0);
        }
    };
    let mut written: u64 = 0;
    let mut buffer: Vec<String> = Vec::new();
    let mut buffer_bytes = 0usize;
    let insert_head = format!("INSERT INTO {relation} ({column_list}) VALUES\n");

    let result: Result<(), AppError> = async {
        loop {
            cancelled(cancel)?;
            for row in &rows {
                if row.len() != columns.len() {
                    return Err(AppError::new(format!(
                        "unexpected column count while reading {object} for backup"
                    )));
                }
                let mut values = Vec::with_capacity(row.len());
                for (k, value) in row.iter().enumerate() {
                    let blob = if binary_cols.get(k).copied().unwrap_or(false) {
                        binary_literal(value, dialect)?
                    } else {
                        None
                    };
                    values.push(match blob {
                        Some(literal) => literal,
                        None => value_for(value, dialect)?,
                    });
                }
                let tuple = format!("({})", values.join(", "));
                if !buffer.is_empty()
                    && buffer_bytes.saturating_add(tuple.len()) > INSERT_BUFFER_BYTES
                {
                    flush_inserts(out, &insert_head, &mut buffer, &mut buffer_bytes).await?;
                }
                buffer_bytes = buffer_bytes.saturating_add(tuple.len());
                buffer.push(tuple);
                if buffer.len() >= TUPLES_PER_INSERT {
                    flush_inserts(out, &insert_head, &mut buffer, &mut buffer_bytes).await?;
                }
                written += 1;
                *rows_total += 1;
            }
            if throttle.ready() {
                progress(BackupProgress {
                    phase: "data",
                    object: object.to_string(),
                    tables_done,
                    tables_total,
                    rows: *rows_total,
                    bytes: out.bytes,
                });
            }
            if done {
                break;
            }
            let page = backend.fetch_page(DATA_PAGE).await?;
            done = page.done;
            rows = page.rows;
        }
        flush_inserts(out, &insert_head, &mut buffer, &mut buffer_bytes).await
    }
    .await;
    backend.rollback_cursor().await;
    result?;
    Ok(written)
}

async fn flush_inserts(
    out: &mut DumpFile,
    head: &str,
    buffer: &mut Vec<String>,
    buffer_bytes: &mut usize,
) -> Result<(), AppError> {
    if buffer.is_empty() {
        return Ok(());
    }
    let tuples = std::mem::take(buffer).join(",\n");
    *buffer_bytes = 0;
    out.put(&format!("{head}{tuples};\n")).await
}

// --- restore ----------------------------------------------------------------

/// Pre-flight facts about a dump file: its size and its leading bytes, so the restore
/// dialog can show the header (engine / database / timestamp) before anything runs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFileInfo {
    pub path: String,
    pub bytes: u64,
    pub text: String,
    /// The file is larger than `restore_from_file` will read.
    pub too_large: bool,
}

pub async fn read_header(path: &str) -> Result<BackupFileInfo, AppError> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| AppError::new(format!("cannot read {path}: {e}")))?;
    if !meta.is_file() {
        return Err(AppError::new("the restore source is not a regular file"));
    }
    let file = File::open(path)
        .await
        .map_err(|e| AppError::new(format!("cannot read {path}: {e}")))?;
    let mut bytes = Vec::new();
    file.take(MAX_HEADER_BYTES as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| AppError::new(format!("cannot read {path}: {e}")))?;
    // The cut may land mid-character; keep only the valid prefix.
    let text = match std::str::from_utf8(&bytes) {
        Ok(s) => s.to_string(),
        Err(e) => String::from_utf8_lossy(&bytes[..e.valid_up_to()]).into_owned(),
    };
    Ok(BackupFileInfo {
        path: path.to_string(),
        bytes: meta.len(),
        text,
        too_large: meta.len() > MAX_RESTORE_FILE_BYTES,
    })
}

/// Replay a dump file onto the connected backend, streaming it statement by statement.
pub async fn run_restore(
    backend: &mut Backend,
    engine: script::TransactionEngine,
    path: &str,
    opts: &RestoreOptions,
    cancel: &AtomicBool,
    progress: &mut (dyn FnMut(RestoreProgress) + Send),
) -> Result<RestoreSummary, AppError> {
    opts.validate()?;
    let caps = backend.capabilities();
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| AppError::new(format!("cannot read {path}: {e}")))?;
    if !meta.is_file() {
        return Err(AppError::new("the restore source is not a regular file"));
    }
    if meta.len() > MAX_RESTORE_FILE_BYTES {
        return Err(AppError::new(format!(
            "the dump exceeds the {MAX_RESTORE_FILE_BYTES}-byte restore limit"
        )));
    }
    if opts.single_transaction && !caps.transactional_ddl {
        return Err(AppError::new(format!(
            "{} has no transactional DDL — restore cannot run as a single transaction",
            caps.kind
        )));
    }

    backend.rollback_cursor().await;
    let wrap = opts.single_transaction;
    if wrap {
        backend.run_single("BEGIN", 1, false).await?;
    }
    let outcome = restore_stream(backend, engine, path, opts, cancel, progress).await;
    let mut summary = match outcome {
        Ok(summary) => summary,
        Err(e) => {
            if wrap {
                let _ = backend.run_single("ROLLBACK", 1, false).await;
            }
            backend.rollback_cursor().await;
            return Err(e);
        }
    };
    if wrap {
        let clean = summary.statements_failed == 0 && !summary.cancelled;
        if clean {
            backend.run_single("COMMIT", 1, false).await.map_err(|e| {
                AppError::new(format!(
                    "restore commit acknowledgement failed; the outcome is unknown — verify database state before retrying ({})",
                    e.message
                ))
            })?;
            summary.committed = true;
        } else {
            let _ = backend.run_single("ROLLBACK", 1, false).await;
        }
    } else {
        summary.committed = summary.statements_ok > 0;
    }
    backend.rollback_cursor().await;
    Ok(summary)
}

async fn restore_stream(
    backend: &mut Backend,
    engine: script::TransactionEngine,
    path: &str,
    opts: &RestoreOptions,
    cancel: &AtomicBool,
    progress: &mut (dyn FnMut(RestoreProgress) + Send),
) -> Result<RestoreSummary, AppError> {
    let mut file = File::open(path)
        .await
        .map_err(|e| AppError::new(format!("cannot read {path}: {e}")))?;
    let mut summary = RestoreSummary {
        statements_ok: 0,
        statements_failed: 0,
        rows_copied: 0,
        bytes_read: 0,
        first_error: None,
        cancelled: false,
        committed: false,
    };
    let mut throttle = Throttle::new();
    let mut leftover = String::new();
    let mut pending: Vec<u8> = Vec::new(); // incomplete UTF-8 tail across reads
    let mut lines_before: u64 = 0;
    let mut index: u64 = 0;
    let mut eof = false;
    // The last pass parses the remaining tail with the checked whole-input parser, so
    // an unterminated COPY block or a psql meta-command at the end still errors.
    let mut final_pass = false;

    loop {
        if !eof {
            // Read at least as much as we are already holding back, so a large COPY
            // block is re-scanned a logarithmic number of times, not once per chunk.
            let want = RESTORE_CHUNK_BYTES.max(leftover.len());
            let mut buf = vec![0u8; want];
            let mut filled = 0usize;
            while filled < want {
                let n = file
                    .read(&mut buf[filled..])
                    .await
                    .map_err(|e| AppError::new(format!("cannot read {path}: {e}")))?;
                if n == 0 {
                    eof = true;
                    break;
                }
                filled += n;
            }
            buf.truncate(filled);
            summary.bytes_read = summary.bytes_read.saturating_add(filled as u64);
            pending.extend_from_slice(&buf);
            let text = match std::str::from_utf8(&pending) {
                Ok(s) => {
                    let owned = s.to_string();
                    pending.clear();
                    owned
                }
                Err(e) => {
                    if e.error_len().is_some() || eof {
                        return Err(AppError::new("the dump file is not valid UTF-8"));
                    }
                    let valid = e.valid_up_to();
                    let owned = String::from_utf8_lossy(&pending[..valid]).into_owned();
                    pending.drain(..valid);
                    owned
                }
            };
            leftover.push_str(&text);
        }

        let split = if final_pass {
            let items = script::parse_for_engine(&leftover, engine)?;
            script::StreamSplit {
                starts: vec![0; items.len()],
                items,
                tail_start: leftover.len(),
            }
        } else {
            script::parse_stream_chunk(&leftover, engine)?
        };

        for (position, item) in split.items.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                summary.cancelled = true;
                return Ok(summary);
            }
            let text = match item {
                script::Item::Sql(sql) => sql.as_str(),
                script::Item::Copy { stmt, .. } => stmt.as_str(),
            };
            // A dump's trailing/section comments parse as statements with no SQL in
            // them. Executing one is an error on every engine — skip them, and don't
            // let them shift the statement numbering an error report refers to.
            if matches!(item, script::Item::Sql(_)) && script::effective_start(text).is_empty() {
                continue;
            }
            index += 1;
            let start = split
                .starts
                .get(position)
                .copied()
                .unwrap_or(0)
                .min(leftover.len());
            // `start` sits just past the previous `;`, so skip the whitespace before
            // the statement itself or every line number is one short.
            let lead = &leftover[start..];
            let skip = lead.len() - lead.trim_start().len();
            let line = lines_before + count_lines(&leftover[..start + skip]) + 1;
            let preview = preview_of(text);
            if throttle.ready() {
                progress(RestoreProgress {
                    statements_done: summary.statements_ok + summary.statements_failed,
                    statements_total: None,
                    current: preview.clone(),
                    rows_copied: summary.rows_copied,
                    bytes_read: summary.bytes_read,
                });
            }
            match exec_item(backend, item).await {
                Ok(copied) => {
                    summary.statements_ok += 1;
                    summary.rows_copied = summary.rows_copied.saturating_add(copied);
                }
                Err(e) => {
                    summary.statements_failed += 1;
                    if summary.first_error.is_none() {
                        summary.first_error = Some(RestoreFailure {
                            statement_index: index,
                            line,
                            message: e.message.clone(),
                            preview,
                        });
                    }
                    // A dropped connection makes the statement's outcome ambiguous —
                    // never replay it; surface the break instead.
                    if backend.is_closed() {
                        return Err(AppError::new(format!(
                            "connection dropped during restore at statement {index} (line {line}); execution outcome is unknown — verify database state before retrying ({})",
                            e.message
                        )));
                    }
                    if opts.stop_on_error {
                        return Ok(summary);
                    }
                }
            }
        }

        let consumed = split.tail_start.min(leftover.len());
        lines_before += count_lines(&leftover[..consumed]);
        leftover.drain(..consumed);
        if final_pass {
            break;
        }
        if eof {
            final_pass = true;
            continue;
        }
        if leftover.len() > MAX_RESTORE_UNIT_BYTES {
            return Err(AppError::new(format!(
                "a single statement or COPY block in the dump exceeds the {MAX_RESTORE_UNIT_BYTES}-byte restore limit"
            )));
        }
    }

    progress(RestoreProgress {
        statements_done: summary.statements_ok + summary.statements_failed,
        statements_total: Some(summary.statements_ok + summary.statements_failed),
        current: String::new(),
        rows_copied: summary.rows_copied,
        bytes_read: summary.bytes_read,
    });
    Ok(summary)
}

fn count_lines(text: &str) -> u64 {
    text.bytes().filter(|b| *b == b'\n').count() as u64
}

async fn exec_item(backend: &mut Backend, item: &script::Item) -> Result<u64, AppError> {
    match item {
        script::Item::Sql(sql) => {
            backend.run_single(sql.trim(), 1, false).await?;
            Ok(0)
        }
        script::Item::Copy { stmt, data } => backend.run_manual_copy(stmt, data).await,
    }
}

// --- tests ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(json: &str) -> BackupOptions {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn iso_timestamps_are_correct() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(1_000_000_000), "2001-09-09T01:46:40Z");
        assert_eq!(iso_utc(1_767_225_600), "2026-01-01T00:00:00Z");
    }

    #[test]
    fn hostile_backup_options_are_rejected() {
        assert!(opts(r#"{"scope":"database"}"#).validate().is_ok());
        assert!(opts(r#"{"scope":"cluster"}"#).validate().is_err());
        assert!(opts(r#"{"content":"binary"}"#).validate().is_err());
        assert!(opts(r#"{"scope":"schemas","schemas":[]}"#)
            .validate()
            .is_err());
        assert!(opts(r#"{"scope":"tables","tables":[]}"#)
            .validate()
            .is_err());
        assert!(opts(r#"{"scope":"schemas","schemas":["a\u0000b"]}"#)
            .validate()
            .is_err());
    }

    #[test]
    fn restore_options_reject_meaningless_combinations() {
        let o: RestoreOptions =
            serde_json::from_str(r#"{"stopOnError":false,"singleTransaction":true}"#).unwrap();
        assert!(o.validate().is_err());
        let o: RestoreOptions = serde_json::from_str(r#"{}"#).unwrap();
        assert!(o.stop_on_error, "stop-on-error defaults on");
        assert!(o.validate().is_ok());
    }

    #[test]
    fn fk_alters_are_split_out_of_table_ddl() {
        let ddl = "CREATE TABLE \"public\".\"a\" (\n    \"id\" integer NOT NULL\n);\n\
                   ALTER TABLE \"public\".\"a\" ADD CONSTRAINT \"a_b_fk\" FOREIGN KEY (\"b\") REFERENCES \"public\".\"b\"(\"id\");\n\
                   CREATE INDEX \"a_idx\" ON \"public\".\"a\" USING btree (\"id\");";
        let (main, fks) = split_fk_alters(ddl);
        assert!(main.contains("CREATE TABLE"));
        assert!(main.contains("CREATE INDEX"));
        assert!(!main.contains("ADD CONSTRAINT"));
        assert_eq!(fks.len(), 1);
        assert!(fks[0].contains("FOREIGN KEY"));
    }

    #[test]
    fn mysql_inline_foreign_keys_become_trailing_alters() {
        let ddl = "CREATE TABLE `bk_a` (\n  \
                   `id` int NOT NULL,\n  \
                   `b_id` int DEFAULT NULL,\n  \
                   PRIMARY KEY (`id`),\n  \
                   KEY `bk_a_b_fk` (`b_id`),\n  \
                   CONSTRAINT `bk_a_b_fk` FOREIGN KEY (`b_id`) REFERENCES `bk_b` (`id`)\n\
                   ) ENGINE=InnoDB;\n";
        let (main, fks) = split_mysql_fk_alters(ddl, "`test`.`bk_a`");
        assert!(
            !main.contains("CONSTRAINT `bk_a_b_fk` FOREIGN KEY"),
            "{main}"
        );
        assert!(
            main.contains("KEY `bk_a_b_fk` (`b_id`)\n) ENGINE=InnoDB;"),
            "dangling comma removed:\n{main}"
        );
        assert_eq!(fks.len(), 1);
        assert_eq!(
            fks[0],
            "ALTER TABLE `test`.`bk_a` ADD CONSTRAINT `bk_a_b_fk` FOREIGN KEY (`b_id`) REFERENCES `bk_b` (`id`)"
        );
    }

    #[test]
    fn topological_order_puts_referenced_tables_first() {
        let rel = |name: &str| Rel {
            schema: "s".into(),
            name: name.into(),
            kind: "table".into(),
        };
        let tables = vec![rel("orders"), rel("users")];
        let edges = vec![(
            "s".to_string(),
            "orders".to_string(),
            "s".to_string(),
            "users".to_string(),
        )];
        let order: Vec<String> = topo_order(&tables, &edges)
            .into_iter()
            .map(|t| t.name)
            .collect();
        assert_eq!(order, vec!["users".to_string(), "orders".to_string()]);
    }

    #[test]
    fn a_foreign_key_cycle_still_emits_every_table_once() {
        let rel = |name: &str| Rel {
            schema: "s".into(),
            name: name.into(),
            kind: "table".into(),
        };
        let tables = vec![rel("a"), rel("b")];
        let edges = vec![
            ("s".into(), "a".into(), "s".into(), "b".into()),
            ("s".into(), "b".into(), "s".into(), "a".into()),
        ];
        let order = topo_order(&tables, &edges);
        assert_eq!(order.len(), 2);
        assert!(order.iter().any(|t| t.name == "a"));
        assert!(order.iter().any(|t| t.name == "b"));
    }

    #[test]
    fn comment_text_cannot_escape_its_line() {
        assert_eq!(comment_safe("a\nDROP TABLE t;\r--"), "a DROP TABLE t; --");
    }

    #[test]
    fn binary_literals_only_apply_to_the_drivers_hex_rendering() {
        assert_eq!(
            binary_literal(&Some("\\x00ff41".into()), SqlDialect::Sqlite).unwrap(),
            Some("X'00ff41'".to_string())
        );
        assert_eq!(
            binary_literal(&Some("\\x00ff41".into()), SqlDialect::DuckDb).unwrap(),
            Some("from_hex('00ff41')".to_string())
        );
        // Not a hex rendering, and NULL: fall through to the ordinary literal path.
        assert_eq!(
            binary_literal(&Some("\\xzz".into()), SqlDialect::Sqlite).unwrap(),
            None
        );
        assert_eq!(binary_literal(&None, SqlDialect::Sqlite).unwrap(), None);
        assert!(is_binary_type("BLOB") && is_binary_type("varbinary(16)"));
        assert!(!is_binary_type("text") && !is_binary_type("integer"));
    }

    // --- embedded round-trip suite ------------------------------------------
    //
    // Build a database with PK/FK/index/view/NULL/quote/newline/unicode/binary
    // content, back it up, restore into a FRESH database, and compare the row sets
    // and object lists. Runs on both embedded engines so the dump format is proven
    // end to end without a server.

    use crate::db::{ConnectionConfig, QueryOutcome};
    use crate::driver::connect;
    use std::sync::Arc;

    fn mem(driver: &str) -> ConnectionConfig {
        ConnectionConfig {
            driver: Some(driver.to_string()),
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

    fn engine_of(driver: &str) -> script::TransactionEngine {
        match driver {
            "duckdb" => script::TransactionEngine::DuckDb,
            _ => script::TransactionEngine::Sqlite,
        }
    }

    async fn run(b: &mut Backend, sql: &str) {
        b.rollback_cursor().await;
        b.run_single(sql, 1000, false)
            .await
            .unwrap_or_else(|e| panic!("setup failed [{sql}]: {}", e.message));
    }

    async fn read(b: &mut Backend, sql: &str) -> Vec<Vec<Option<String>>> {
        b.rollback_cursor().await;
        match b.run_single(sql, 100_000, true).await {
            Ok(QueryOutcome::Rows { rows, .. }) => rows,
            Ok(QueryOutcome::Exec { message }) => panic!("expected rows [{sql}]: {message}"),
            Err(e) => panic!("query failed [{sql}]: {}", e.message),
        }
    }

    /// Populate a fixture database. `blob` is the engine's binary literal.
    async fn seed(b: &mut Backend, blob: &str) {
        run(
            b,
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT)",
        )
        .await;
        run(
            b,
            "CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), amount TEXT)",
        )
        .await;
        run(
            b,
            "CREATE TABLE blobs (id INTEGER PRIMARY KEY, payload BLOB)",
        )
        .await;
        run(
            b,
            "INSERT INTO users VALUES (1, 'Ann', 'it''s a \"quoted\" note')",
        )
        .await;
        run(
            b,
            "INSERT INTO users VALUES (2, 'Bö', 'first line\nsecond line')",
        )
        .await;
        run(b, "INSERT INTO users VALUES (3, '日本語 ✓ emoji 🐘', NULL)").await;
        run(b, "INSERT INTO orders VALUES (10, 1, '12.50')").await;
        run(b, "INSERT INTO orders VALUES (11, 3, NULL)").await;
        run(b, &format!("INSERT INTO blobs VALUES (1, {blob})")).await;
        run(b, "INSERT INTO blobs VALUES (2, NULL)").await;
        run(b, "CREATE INDEX users_name_idx ON users (name)").await;
        run(
            b,
            "CREATE VIEW recent_orders AS SELECT id, user_id FROM orders WHERE id > 0",
        )
        .await;
    }

    async fn snapshot(b: &mut Backend) -> Vec<Vec<Vec<Option<String>>>> {
        vec![
            read(b, "SELECT id, name, note FROM users ORDER BY id").await,
            read(b, "SELECT id, user_id, amount FROM orders ORDER BY id").await,
            read(b, "SELECT id, payload FROM blobs ORDER BY id").await,
            read(b, "SELECT id, user_id FROM recent_orders ORDER BY id").await,
        ]
    }

    fn options(scope: &str, content: &str, include_drop: bool) -> BackupOptions {
        BackupOptions {
            scope: scope.to_string(),
            schemas: Vec::new(),
            tables: Vec::new(),
            content: content.to_string(),
            include_drop,
            single_transaction: true,
        }
    }

    fn temp_dump(tag: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(format!("{tag}.sql"));
        let name = path.to_string_lossy().to_string();
        (dir, name)
    }

    async fn dump(
        b: &mut Backend,
        opts: &BackupOptions,
        path: &str,
    ) -> Result<BackupSummary, AppError> {
        let flag = AtomicBool::new(false);
        run_backup(b, "test", opts, path, &flag, &mut |_| {}).await
    }

    async fn replay(b: &mut Backend, driver: &str, path: &str) -> RestoreSummary {
        let flag = AtomicBool::new(false);
        let opts = RestoreOptions {
            stop_on_error: true,
            single_transaction: false,
        };
        run_restore(b, engine_of(driver), path, &opts, &flag, &mut |_| {})
            .await
            .unwrap_or_else(|e| panic!("[{driver}] restore failed: {}", e.message))
    }

    async fn roundtrip(driver: &str, blob: &str) {
        let (_dir, path) = temp_dump(&format!("{driver}_roundtrip"));
        let (mut src, _v) = connect(&mem(driver)).await.unwrap();
        seed(&mut src, blob).await;
        let before = snapshot(&mut src).await;
        let summary = dump(&mut src, &options("database", "all", true), &path)
            .await
            .unwrap_or_else(|e| panic!("[{driver}] backup failed: {}", e.message));
        assert_eq!(summary.rows, 7, "[{driver}] rows dumped");
        assert!(summary.tables >= 3, "[{driver}] tables dumped");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("-- Tusk backup\n"), "[{driver}] header");
        assert!(text.contains(&format!("-- engine: {driver}")), "{text}");
        assert!(text.contains("DROP TABLE IF EXISTS"), "[{driver}] drops");

        let (mut dst, _v) = connect(&mem(driver)).await.unwrap();
        let restored = replay(&mut dst, driver, &path).await;
        assert_eq!(
            restored.statements_failed, 0,
            "[{driver}] restore errors: {:?}",
            restored.first_error
        );
        assert_eq!(
            snapshot(&mut dst).await,
            before,
            "[{driver}] row sets match"
        );

        // Object lists must match too (tables + views, not just their contents).
        let names = |t: &crate::tree::DbTree| {
            let mut out: Vec<String> = Vec::new();
            for s in &t.schemas {
                for r in s.tables.iter().chain(s.views.iter()) {
                    out.push(format!("{}.{}:{}", s.name, r.name, r.kind));
                }
            }
            out.sort();
            out
        };
        let source_tree = src.build_tree().await.unwrap();
        let restored_tree = dst.build_tree().await.unwrap();
        assert_eq!(
            names(&restored_tree),
            names(&source_tree),
            "[{driver}] object lists match"
        );

        // A second restore of the same dump succeeds because include_drop cleared
        // the objects first — the dump is replayable, not one-shot.
        let again = replay(&mut dst, driver, &path).await;
        assert_eq!(again.statements_failed, 0, "[{driver}] replayable dump");
        assert_eq!(snapshot(&mut dst).await, before, "[{driver}] stable replay");
    }

    #[tokio::test]
    async fn sqlite_backup_restore_roundtrip() {
        roundtrip("sqlite", "X'00FF41'").await;
    }

    #[tokio::test]
    async fn duckdb_backup_restore_roundtrip() {
        roundtrip("duckdb", "from_hex('00ff41')").await;
    }

    async fn schema_then_data(driver: &str, blob: &str) {
        let (_dir, schema_path) = temp_dump(&format!("{driver}_schema"));
        let (_dir2, data_path) = temp_dump(&format!("{driver}_data"));
        let (mut src, _v) = connect(&mem(driver)).await.unwrap();
        seed(&mut src, blob).await;
        let before = snapshot(&mut src).await;

        let schema_only = dump(
            &mut src,
            &options("database", "schema", false),
            &schema_path,
        )
        .await
        .unwrap();
        assert_eq!(
            schema_only.rows, 0,
            "[{driver}] schema-only carries no data"
        );
        let schema_text = std::fs::read_to_string(&schema_path).unwrap();
        assert!(
            !schema_text.contains("INSERT INTO"),
            "[{driver}] schema-only has no INSERTs:\n{schema_text}"
        );

        let data_only = dump(&mut src, &options("database", "data", false), &data_path)
            .await
            .unwrap();
        assert_eq!(data_only.rows, 7, "[{driver}] data-only row count");
        let data_text = std::fs::read_to_string(&data_path).unwrap();
        assert!(
            !data_text.contains("CREATE TABLE"),
            "[{driver}] data-only has no DDL:\n{data_text}"
        );

        let (mut dst, _v) = connect(&mem(driver)).await.unwrap();
        assert_eq!(
            replay(&mut dst, driver, &schema_path)
                .await
                .statements_failed,
            0
        );
        assert_eq!(
            replay(&mut dst, driver, &data_path).await.statements_failed,
            0
        );
        assert_eq!(
            snapshot(&mut dst).await,
            before,
            "[{driver}] schema-then-data restores the original"
        );
    }

    #[tokio::test]
    async fn sqlite_schema_only_then_data_only() {
        schema_then_data("sqlite", "X'00FF41'").await;
    }

    #[tokio::test]
    async fn duckdb_schema_only_then_data_only() {
        schema_then_data("duckdb", "from_hex('00ff41')").await;
    }

    #[tokio::test]
    async fn table_scope_backs_up_only_the_selected_table() {
        let (_dir, path) = temp_dump("sqlite_scope");
        let (mut src, _v) = connect(&mem("sqlite")).await.unwrap();
        seed(&mut src, "X'00FF41'").await;
        let mut opts = options("tables", "all", false);
        opts.tables = vec![QualifiedName {
            schema: "main".into(),
            name: "users".into(),
        }];
        dump(&mut src, &opts, &path).await.unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"users\""), "{text}");
        assert!(!text.contains("\"orders\""), "{text}");
        assert!(!text.contains("recent_orders"), "{text}");
    }

    #[tokio::test]
    async fn cancelling_a_backup_leaves_the_destination_untouched() {
        let (_dir, path) = temp_dump("sqlite_cancel");
        std::fs::write(&path, "PREVIOUS DUMP").unwrap();
        let (mut src, _v) = connect(&mem("sqlite")).await.unwrap();
        seed(&mut src, "X'00FF41'").await;
        let flag = Arc::new(AtomicBool::new(false));
        let trip = flag.clone();
        let opts = options("database", "all", false);
        let err = run_backup(&mut src, "test", &opts, &path, &flag, &mut move |p| {
            if p.phase == "data" {
                trip.store(true, Ordering::Relaxed);
            }
        })
        .await
        .expect_err("cancelled backup must fail");
        assert!(err.message.contains("cancelled"), "{}", err.message);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "PREVIOUS DUMP",
            "a cancelled backup never replaces the previous dump"
        );
    }

    #[tokio::test]
    async fn restore_reports_the_first_failure_with_its_line() {
        let (_dir, path) = temp_dump("sqlite_bad");
        std::fs::write(
            &path,
            "-- Tusk backup\nCREATE TABLE ok (a INTEGER);\nNOT SQL AT ALL;\nCREATE TABLE later (b INTEGER);\n",
        )
        .unwrap();
        let (mut b, _v) = connect(&mem("sqlite")).await.unwrap();
        let flag = AtomicBool::new(false);
        let stop = RestoreOptions {
            stop_on_error: true,
            single_transaction: false,
        };
        let summary = run_restore(
            &mut b,
            script::TransactionEngine::Sqlite,
            &path,
            &stop,
            &flag,
            &mut |_| {},
        )
        .await
        .unwrap();
        assert_eq!(summary.statements_ok, 1);
        assert_eq!(summary.statements_failed, 1);
        let failure = summary.first_error.expect("first error recorded");
        assert_eq!(failure.statement_index, 2);
        assert_eq!(failure.line, 3, "reported line");
        assert!(failure.preview.starts_with("NOT SQL"));

        // continue-on-error keeps going and still records the FIRST failure.
        let (mut b2, _v) = connect(&mem("sqlite")).await.unwrap();
        let keep_going = RestoreOptions {
            stop_on_error: false,
            single_transaction: false,
        };
        let summary = run_restore(
            &mut b2,
            script::TransactionEngine::Sqlite,
            &path,
            &keep_going,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap();
        assert_eq!(summary.statements_ok, 2);
        assert_eq!(summary.statements_failed, 1);
    }

    #[tokio::test]
    async fn restore_rejects_non_utf8_input() {
        let (_dir, path) = temp_dump("bad_utf8");
        std::fs::write(&path, [0x53u8, 0x45, 0x4c, 0xff, 0xfe, 0x3b]).unwrap();
        let (mut b, _v) = connect(&mem("sqlite")).await.unwrap();
        let err = run_restore(
            &mut b,
            script::TransactionEngine::Sqlite,
            &path,
            &RestoreOptions {
                stop_on_error: true,
                single_transaction: false,
            },
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap_err();
        assert!(err.message.contains("not valid UTF-8"), "{}", err.message);
    }

    /// The streaming splitter must land on exactly the same statements as the
    /// whole-input parser, whatever the chunk boundaries are.
    #[test]
    fn stream_chunking_matches_a_whole_input_parse() {
        let dump = "-- Tusk backup\nCREATE TABLE t (a TEXT);\n\
                    INSERT INTO t VALUES ('a;b'), ('-- not a comment'), ('$$');\n\
                    CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;\n\
                    COPY t (a) FROM stdin;\n1\n2\n\\.\nSELECT 1;\n";
        let whole: Vec<String> =
            script::parse_for_engine(dump, script::TransactionEngine::Postgres)
                .unwrap()
                .iter()
                .map(describe)
                .collect();
        for chunk in [1usize, 3, 7, 16, 64, 4096] {
            let mut leftover = String::new();
            let mut items: Vec<String> = Vec::new();
            let mut cursor = 0usize;
            while cursor < dump.len() {
                let mut end = (cursor + chunk).min(dump.len());
                while !dump.is_char_boundary(end) {
                    end += 1;
                }
                leftover.push_str(&dump[cursor..end]);
                cursor = end;
                let split =
                    script::parse_stream_chunk(&leftover, script::TransactionEngine::Postgres)
                        .unwrap();
                items.extend(split.items.iter().map(describe));
                leftover.drain(..split.tail_start);
            }
            items.extend(
                script::parse_for_engine(&leftover, script::TransactionEngine::Postgres)
                    .unwrap()
                    .iter()
                    .map(describe),
            );
            assert_eq!(items, whole, "chunk size {chunk}");
        }
    }

    fn describe(item: &script::Item) -> String {
        match item {
            script::Item::Sql(sql) => format!("SQL:{sql}"),
            script::Item::Copy { stmt, data } => format!("COPY:{stmt}|{data}"),
        }
    }
}
