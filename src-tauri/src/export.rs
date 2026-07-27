use crate::db::{self, collect_rows_limited, AppError, USER_TEXT_LIMITS};
use rust_xlsxwriter::{Format, Workbook};
use serde::Deserialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tokio::fs::File;
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio_postgres::Client;

const EXPORT_CURSOR: &str = "tusk_export_cur";
const BATCH: u32 = 10_000;
/// Excel's hard per-sheet row limit; we roll into a new sheet past this.
const XLSX_MAX_ROWS: u32 = 1_048_576;
/// Value-tuples per multi-row INSERT statement.
const SQL_TUPLES_PER_INSERT: usize = 1000;
const SQL_INSERT_BUFFER_BYTES: usize = 1024 * 1024;
const MAX_EXPORT_COLUMNS: usize = 10_000;
const MAX_COLUMN_BYTES: usize = 1024 * 1024;
const MAX_COLUMN_METADATA_BYTES: usize = 8 * 1024 * 1024;
const MAX_CELL_BYTES: usize = 1024 * 1024;
const MAX_IN_MEMORY_EXPORT_BYTES: u64 = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Options (mirrors src/export.ts ExportOptions; camelCase to match the payload)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlOptions {
    #[serde(default)]
    pub table: String,
    #[serde(default)]
    pub multi_row: bool,
    #[serde(default)]
    pub include_create: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxOptions {
    #[serde(default = "default_sheet")]
    pub sheet_name: String,
    #[serde(default)]
    pub header_styling: bool,
    #[serde(default)]
    pub auto_filter: bool,
    #[serde(default)]
    pub freeze_header: bool,
}

impl Default for XlsxOptions {
    fn default() -> Self {
        Self {
            sheet_name: default_sheet(),
            header_styling: false,
            auto_filter: false,
            freeze_header: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub format: String,
    #[serde(default = "d_comma")]
    pub delimiter: String,
    #[serde(default)]
    pub custom_delimiter: String,
    #[serde(default = "d_asneeded")]
    pub quote: String,
    #[serde(default = "d_dquote")]
    pub quote_char: String,
    #[serde(default = "d_true")]
    pub header: bool,
    #[serde(default = "d_empty")]
    pub null_mode: String,
    #[serde(default)]
    pub null_text: String,
    #[serde(default = "d_lf")]
    pub line_ending: String,
    #[serde(default)]
    pub bom: bool,
    /// Included source-column indices, in output order. Empty = all, natural order.
    #[serde(default)]
    pub column_indices: Vec<usize>,
    /// Source-column indices whose values are textual booleans, exported as
    /// TRUE/FALSE (native booleans in xlsx/JSON) instead of the driver's raw
    /// token (PG `t`/`f`, DuckDB `true`/`false`, SQLite `0`/`1`). The frontend
    /// seeds it from the grid's bool detection (scope=loaded/clipboard);
    /// `export_to_file` overrides it with the server-reported column types for
    /// scope=all (`Backend::bool_columns`). Empty = no mapping.
    #[serde(default)]
    pub bool_cols: Vec<usize>,
    #[serde(default)]
    pub sql: SqlOptions,
    #[serde(default)]
    pub xlsx: XlsxOptions,
}

fn default_sheet() -> String {
    "Sheet1".to_string()
}
fn d_comma() -> String {
    "comma".to_string()
}
fn d_asneeded() -> String {
    "asNeeded".to_string()
}
fn d_dquote() -> String {
    "\"".to_string()
}
fn d_empty() -> String {
    "empty".to_string()
}
fn d_lf() -> String {
    "lf".to_string()
}
fn d_true() -> bool {
    true
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SqlDialect {
    Postgres,
    DuckDb,
    Sqlite,
    MySql,
}

impl SqlDialect {
    fn parse(value: &str) -> Result<Self, AppError> {
        match value {
            "" | "postgres" => Ok(Self::Postgres),
            "duckdb" => Ok(Self::DuckDb),
            "sqlite" => Ok(Self::Sqlite),
            "mysql" => Ok(Self::MySql),
            _ => Err(AppError::new("unsupported SQL export dialect")),
        }
    }
}

impl ExportOptions {
    pub fn validate(&self) -> Result<(), AppError> {
        if !matches!(
            self.format.as_str(),
            "csv" | "tsv" | "json" | "sql" | "markdown" | "xlsx"
        ) {
            return Err(AppError::new("unsupported export format"));
        }
        if !matches!(
            self.delimiter.as_str(),
            "comma" | "tab" | "semicolon" | "pipe" | "custom"
        ) || !matches!(self.quote.as_str(), "always" | "asNeeded" | "never")
            || !matches!(self.null_mode.as_str(), "empty" | "literal" | "custom")
            || !matches!(self.line_ending.as_str(), "lf" | "crlf")
        {
            return Err(AppError::new("invalid export formatting option"));
        }
        if self.quote_char.chars().count() != 1
            || (self.delimiter == "custom" && self.custom_delimiter.chars().count() != 1)
            || self
                .custom_delimiter
                .chars()
                .any(|c| matches!(c, '\r' | '\n'))
            || self.quote_char.chars().any(|c| matches!(c, '\r' | '\n'))
        {
            return Err(AppError::new(
                "export delimiter and quote character must each be one non-newline character",
            ));
        }
        if self.null_text.len() > 1024 * 1024
            || self.sql.table.len() > 1_000
            || self.column_indices.len() > 10_000
            || self.bool_cols.len() > 10_000
            || self.xlsx.sheet_name.is_empty()
            || self.xlsx.sheet_name.chars().count() > 31
            || self
                .xlsx
                .sheet_name
                .chars()
                .any(|c| matches!(c, '[' | ']' | ':' | '*' | '?' | '/' | '\\'))
        {
            return Err(AppError::new("export option exceeds its size limit"));
        }
        if self.format == "sql" && self.sql.table.contains('\0') {
            return Err(AppError::new("SQL export table name contains a zero byte"));
        }
        Ok(())
    }

    fn delim(&self) -> char {
        match self.delimiter.as_str() {
            "tab" => '\t',
            "semicolon" => ';',
            "pipe" => '|',
            "custom" => self.custom_delimiter.chars().next().unwrap_or(','),
            _ => ',',
        }
    }
    fn newline(&self) -> &str {
        if self.line_ending == "crlf" {
            "\r\n"
        } else {
            "\n"
        }
    }
    fn quote_c(&self) -> char {
        self.quote_char.chars().next().unwrap_or('"')
    }
    fn null_str(&self) -> &str {
        match self.null_mode.as_str() {
            "literal" => "NULL",
            "custom" => &self.null_text,
            _ => "",
        }
    }
    /// Resolve the included column indices for a result with `ncols` columns.
    fn indices(&self, ncols: usize) -> Result<Vec<usize>, AppError> {
        if self.column_indices.is_empty() {
            Ok((0..ncols).collect())
        } else if self.column_indices.iter().any(|&i| i >= ncols) {
            Err(AppError::new(
                "export column selection contains an out-of-range index",
            ))
        } else {
            Ok(self.column_indices.clone())
        }
    }
}

fn validate_columns(columns: &[String]) -> Result<(), AppError> {
    if columns.is_empty() {
        return Err(AppError::new("the export result contains no columns"));
    }
    if columns.len() > MAX_EXPORT_COLUMNS {
        return Err(AppError::new(
            "the export result exceeds the 10000-column limit",
        ));
    }
    let mut bytes = 0usize;
    for column in columns {
        if column.len() > MAX_COLUMN_BYTES || column.contains('\0') {
            return Err(AppError::new(
                "an export column name is invalid or too large",
            ));
        }
        bytes = bytes.saturating_add(column.len());
        if bytes > MAX_COLUMN_METADATA_BYTES {
            return Err(AppError::new(
                "export column metadata exceeds the 8 MiB limit",
            ));
        }
    }
    Ok(())
}

fn validate_projected_columns(format: &str, columns: &[String]) -> Result<(), AppError> {
    if format == "json" {
        let mut seen = HashSet::with_capacity(columns.len());
        if columns.iter().any(|column| !seen.insert(column.as_str())) {
            return Err(AppError::new(
                "JSON object export requires unique column names",
            ));
        }
    }
    Ok(())
}

fn project_cols(columns: &[String], idx: &[usize]) -> Vec<String> {
    idx.iter().map(|&i| columns[i].clone()).collect()
}
fn project_row(row: &[Option<String>], idx: &[usize]) -> Vec<Option<String>> {
    idx.iter().map(|&i| row.get(i).cloned().flatten()).collect()
}
/// Per PROJECTED column: is the source column a declared boolean?
fn project_bools(opts: &ExportOptions, idx: &[usize]) -> Vec<bool> {
    idx.iter().map(|i| opts.bool_cols.contains(i)).collect()
}

// ---------------------------------------------------------------------------
// Boolean mapping — PARITY PAIR with src/grid/bool.ts `boolWord` (the grid's
// display words) and src/formats.ts `formatWithOptions` (the clipboard path).
// Change all three together.
// ---------------------------------------------------------------------------

/// Map a driver's textual boolean token; `None` = not a recognized token (the
/// raw value passes through — the mapping never invents data). Exactly the
/// token set of the grid's `boolWord`: PG `t`/`f`, DuckDB `true`/`false`,
/// SQLite/MySQL `1`/`0`, plus the display words themselves.
pub fn bool_token(v: &str) -> Option<bool> {
    match v {
        "t" | "true" | "TRUE" | "1" => Some(true),
        "f" | "false" | "FALSE" | "0" => Some(false),
        _ => None,
    }
}

fn bool_display(b: bool) -> &'static str {
    if b {
        "TRUE"
    } else {
        "FALSE"
    }
}

/// Value heuristic mirroring the grid's `detectBoolCols` (src/grid/bool.ts):
/// columns whose non-NULL values are all t/f/true/false tokens (with at least
/// one non-NULL seen). `0`/`1` are deliberately NOT heuristic tokens — they
/// would misclassify integer columns. Used by the Slack export path, where the
/// full result is buffered and no column-type metadata survives execution.
pub fn detect_bool_cols(ncols: usize, rows: &[Vec<Option<String>>]) -> Vec<usize> {
    (0..ncols)
        .filter(|&c| {
            let mut seen = false;
            for row in rows {
                match row.get(c).and_then(|v| v.as_deref()) {
                    None => continue,
                    Some("t" | "f" | "true" | "false" | "TRUE" | "FALSE") => seen = true,
                    Some(_) => return false,
                }
            }
            seen
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Field / row formatting (pure). Mirrors src/formats.ts `formatWithOptions`.
// ---------------------------------------------------------------------------

fn delim_field(v: &Option<String>, opts: &ExportOptions) -> String {
    let s = match v {
        None => return opts.null_str().to_string(),
        Some(s) => s,
    };
    let q = opts.quote_c();
    let d = opts.delim();
    let doubled = s.replace(q, &format!("{q}{q}"));
    match opts.quote.as_str() {
        "never" => s.replace(d, " ").replace(['\n', '\r'], " "),
        "always" => format!("{q}{doubled}{q}"),
        _ => {
            if s.is_empty()
                || s.contains(d)
                || s.contains(q)
                || s.contains('\n')
                || s.contains('\r')
            {
                format!("{q}{doubled}{q}")
            } else {
                s.clone()
            }
        }
    }
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

fn hex_bytes(s: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(s.len().saturating_mul(2));
    for &byte in s.as_bytes() {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn sql_ident(name: &str, dialect: SqlDialect) -> String {
    match dialect {
        SqlDialect::MySql => format!("`{}`", name.replace('`', "``")),
        _ => db::ident(name),
    }
}

fn sql_string(value: &str, dialect: SqlDialect) -> Result<String, AppError> {
    match dialect {
        SqlDialect::Postgres if value.contains('\0') => Err(AppError::new(
            "PostgreSQL SQL export cannot represent a text value containing a zero byte",
        )),
        // An explicit E literal is independent of standard_conforming_strings.
        SqlDialect::Postgres if value.contains('\\') => db::pg_string_literal(value),
        // These expressions preserve control bytes without depending on parser modes.
        SqlDialect::MySql if value.contains('\\') || value.chars().any(char::is_control) => {
            Ok(format!("CONVERT(X'{}' USING utf8mb4)", hex_bytes(value)))
        }
        SqlDialect::Sqlite if value.chars().any(char::is_control) => {
            Ok(format!("CAST(X'{}' AS TEXT)", hex_bytes(value)))
        }
        SqlDialect::DuckDb if value.chars().any(char::is_control) => {
            Ok(format!("decode(from_hex('{}'))", hex_bytes(value)))
        }
        _ => Ok(format!("'{}'", value.replace('\'', "''"))),
    }
}

fn sql_val(v: &Option<String>, dialect: SqlDialect) -> Result<String, AppError> {
    match v {
        None => Ok("NULL".to_string()),
        Some(s) => sql_string(s, dialect),
    }
}

/// The header / preamble for a format (delimited header row, markdown rule, `[`,
/// or a SQL `CREATE TABLE`). Empty when the format has none.
fn header_text(
    opts: &ExportOptions,
    pcols: &[String],
    pbool: &[bool],
    dialect: SqlDialect,
) -> Result<String, AppError> {
    let nl = opts.newline();
    Ok(match opts.format.as_str() {
        "json" => "[".to_string(),
        "markdown" => {
            let head: Vec<String> = pcols.iter().map(|c| c.replace('|', "\\|")).collect();
            let sep: Vec<&str> = pcols.iter().map(|_| "---").collect();
            format!("| {} |{nl}| {} |{nl}", head.join(" | "), sep.join(" | "))
        }
        "sql" => {
            if opts.sql.include_create {
                let table = if opts.sql.table.is_empty() {
                    "exported".to_string()
                } else {
                    opts.sql.table.clone()
                };
                let cols = pcols
                    .iter()
                    .enumerate()
                    .map(|(k, c)| {
                        let ty = if pbool.get(k).copied().unwrap_or(false) {
                            "boolean"
                        } else {
                            "text"
                        };
                        format!("{} {ty}", sql_ident(c, dialect))
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("CREATE TABLE {} ({cols});{nl}", sql_ident(&table, dialect))
            } else {
                String::new()
            }
        }
        // csv / tsv / custom delimited
        _ => {
            if !opts.header {
                return Ok(String::new());
            }
            let cells: Vec<String> = pcols
                .iter()
                .map(|c| delim_field(&Some(c.clone()), opts))
                .collect();
            format!("{}{nl}", cells.join(&opts.delim().to_string()))
        }
    })
}

// ---------------------------------------------------------------------------
// TextEmit — file writer shared by the streaming and inline paths. The file opens
// on the first row or at finish for an empty result. Handles BOM, header,
// per-format row formatting, JSON element commas, and batched multi-row INSERTs.
// ---------------------------------------------------------------------------

struct TextEmit<'a> {
    path: &'a str,
    opts: &'a ExportOptions,
    pcols: Vec<String>,
    pbool: Vec<bool>, // per projected column: map textual booleans to TRUE/FALSE
    dialect: SqlDialect,
    writer: Option<BufWriter<File>>,
    wrote_rows: u64,
    sql_buf: Vec<String>, // pending value-tuples for a multi-row INSERT
    sql_buf_bytes: usize,
}

impl<'a> TextEmit<'a> {
    fn new(
        opts: &'a ExportOptions,
        pcols: Vec<String>,
        pbool: Vec<bool>,
        dialect: SqlDialect,
        path: &'a str,
    ) -> Self {
        Self {
            path,
            opts,
            pcols,
            pbool,
            dialect,
            writer: None,
            wrote_rows: 0,
            sql_buf: Vec::new(),
            sql_buf_bytes: 0,
        }
    }

    /// The recognized boolean word for projected cell `k`, if the column is a
    /// boolean and the value a known token.
    fn word(&self, k: usize, v: &Option<String>) -> Option<&'static str> {
        if !self.pbool.get(k).copied().unwrap_or(false) {
            return None;
        }
        v.as_deref().and_then(bool_token).map(bool_display)
    }

    async fn ensure_open(&mut self) -> Result<(), AppError> {
        if self.writer.is_some() {
            return Ok(());
        }
        let file = File::create(self.path)
            .await
            .map_err(|e| AppError::new(e.to_string()))?;
        let mut w = BufWriter::new(file);
        if self.opts.bom {
            w.write_all(&[0xEF, 0xBB, 0xBF])
                .await
                .map_err(|e| AppError::new(e.to_string()))?;
        }
        let head = header_text(self.opts, &self.pcols, &self.pbool, self.dialect)?;
        if !head.is_empty() {
            w.write_all(head.as_bytes())
                .await
                .map_err(|e| AppError::new(e.to_string()))?;
        }
        self.writer = Some(w);
        Ok(())
    }

    fn sql_table(&self) -> String {
        if self.opts.sql.table.is_empty() {
            "exported".to_string()
        } else {
            self.opts.sql.table.clone()
        }
    }

    async fn write(&mut self, bytes: &[u8]) -> Result<(), AppError> {
        self.writer
            .as_mut()
            .ok_or_else(|| AppError::new("export writer was not initialized"))?
            .write_all(bytes)
            .await
            .map_err(|e| AppError::new(e.to_string()))
    }

    async fn flush_sql_buf(&mut self) -> Result<(), AppError> {
        if self.sql_buf.is_empty() {
            return Ok(());
        }
        let nl = self.opts.newline();
        let cols = self
            .pcols
            .iter()
            .map(|c| sql_ident(c, self.dialect))
            .collect::<Vec<_>>()
            .join(", ");
        let tuples = std::mem::take(&mut self.sql_buf).join(&format!(",{nl}"));
        self.sql_buf_bytes = 0;
        let stmt = format!(
            "INSERT INTO {} ({cols}) VALUES{nl}{tuples};{nl}",
            sql_ident(&self.sql_table(), self.dialect)
        );
        self.write(stmt.as_bytes()).await
    }

    async fn row(&mut self, prow: &[Option<String>]) -> Result<(), AppError> {
        self.ensure_open().await?;
        let nl = self.opts.newline();
        match self.opts.format.as_str() {
            "json" => {
                let mut out = String::new();
                if self.wrote_rows > 0 {
                    out.push(',');
                }
                out.push_str("\n  {");
                for (k, c) in self.pcols.iter().enumerate() {
                    if k > 0 {
                        out.push(',');
                    }
                    // Booleans emit as real JSON booleans, not quoted tokens.
                    let val = match (self.word(k, &prow[k]), &prow[k]) {
                        (Some(w), _) => w.to_ascii_lowercase(),
                        (None, Some(s)) => json_str(s),
                        (None, None) => "null".to_string(),
                    };
                    out.push_str(&format!("{}: {}", json_str(c), val));
                }
                out.push('}');
                self.write(out.as_bytes()).await?;
            }
            "markdown" => {
                let cells: Vec<String> = prow
                    .iter()
                    .enumerate()
                    .map(|(k, v)| match (self.word(k, v), v) {
                        (Some(w), _) => w.to_string(),
                        (None, Some(s)) => s.replace('|', "\\|").replace('\n', " "),
                        (None, None) => String::new(),
                    })
                    .collect();
                self.write(format!("| {} |{nl}", cells.join(" | ")).as_bytes())
                    .await?;
            }
            "sql" => {
                // Recognized booleans emit as unquoted TRUE/FALSE literals (valid on
                // PG / DuckDB / MySQL / SQLite); anything else stays a quoted string.
                let mut values = Vec::with_capacity(prow.len());
                for (k, value) in prow.iter().enumerate() {
                    values.push(match self.word(k, value) {
                        Some(word) => word.to_string(),
                        None => sql_val(value, self.dialect)?,
                    });
                }
                let tuple = format!("({})", values.join(", "));
                if self.opts.sql.multi_row {
                    if !self.sql_buf.is_empty()
                        && self.sql_buf_bytes.saturating_add(tuple.len()) > SQL_INSERT_BUFFER_BYTES
                    {
                        self.flush_sql_buf().await?;
                    }
                    self.sql_buf_bytes = self.sql_buf_bytes.saturating_add(tuple.len());
                    self.sql_buf.push(tuple);
                    if self.sql_buf.len() >= SQL_TUPLES_PER_INSERT {
                        self.flush_sql_buf().await?;
                    }
                } else {
                    let cols = self
                        .pcols
                        .iter()
                        .map(|c| sql_ident(c, self.dialect))
                        .collect::<Vec<_>>()
                        .join(", ");
                    let stmt = format!(
                        "INSERT INTO {} ({cols}) VALUES {tuple};{nl}",
                        sql_ident(&self.sql_table(), self.dialect)
                    );
                    self.write(stmt.as_bytes()).await?;
                }
            }
            // csv / tsv / custom delimited
            _ => {
                let cells: Vec<String> = prow
                    .iter()
                    .enumerate()
                    .map(|(k, v)| match self.word(k, v) {
                        Some(w) => delim_field(&Some(w.to_string()), self.opts),
                        None => delim_field(v, self.opts),
                    })
                    .collect();
                self.write(
                    format!("{}{nl}", cells.join(&self.opts.delim().to_string())).as_bytes(),
                )
                .await?;
            }
        }
        self.wrote_rows += 1;
        Ok(())
    }

    async fn finish(&mut self) -> Result<(), AppError> {
        // Open even for zero rows: callers must be able to atomically replace a stale
        // destination with a valid empty result (headers/[]/CREATE where applicable).
        self.ensure_open().await?;
        if self.opts.format == "sql" && self.opts.sql.multi_row {
            self.flush_sql_buf().await?;
        }
        if self.opts.format == "json" {
            let nl = self.opts.newline();
            self.write(format!("{nl}]{nl}").as_bytes()).await?;
        }
        let mut writer = self
            .writer
            .take()
            .ok_or_else(|| AppError::new("export writer disappeared before flush"))?;
        writer
            .flush()
            .await
            .map_err(|e| AppError::new(e.to_string()))?;
        // `flush()` only reaches the OS cache. Sync before the atomic rename so a
        // reported-success export survives a crash as far as the platform permits.
        writer
            .get_ref()
            .sync_all()
            .await
            .map_err(|e| AppError::new(e.to_string()))
    }
}

// ---------------------------------------------------------------------------
// XlsxSink — streams rows to the workbook in constant-memory mode (each worksheet
// flushes its rows to a tempfile, so RAM stays flat regardless of row count),
// rolling into a new sheet every XLSX_MAX_ROWS so all data is exported.
// ---------------------------------------------------------------------------

fn xerr(e: rust_xlsxwriter::XlsxError) -> AppError {
    AppError::new(e.to_string())
}

/// Excel sheet names: max 31 chars, none of []:*?/\.
fn sanitize_sheet(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "[]:*?/\\".contains(c) { '_' } else { c })
        .collect();
    cleaned.chars().take(26).collect::<String>()
}

struct XlsxSink<'a> {
    wb: Workbook,
    opts: &'a ExportOptions,
    pcols: Vec<String>,
    pbool: Vec<bool>, // per projected column: write native Excel booleans
    base_name: String,
    sheets: u32,         // number of sheets created so far
    row_in_sheet: u32,   // next row index to write in the current sheet
    last_rows: Vec<u32>, // last written row index per sheet (for autofilter)
}

impl<'a> XlsxSink<'a> {
    fn new(opts: &'a ExportOptions, pcols: Vec<String>, pbool: Vec<bool>) -> Self {
        Self {
            wb: Workbook::new(),
            opts,
            base_name: sanitize_sheet(&opts.xlsx.sheet_name),
            pcols,
            pbool,
            sheets: 0,
            row_in_sheet: 0,
            last_rows: Vec::new(),
        }
    }

    fn new_sheet(&mut self) -> Result<(), AppError> {
        let raw = if self.sheets == 0 {
            self.base_name.clone()
        } else {
            format!("{} ({})", self.base_name, self.sheets + 1)
        };
        // Excel hard-caps sheet names at 31 chars; the " (N)" suffix can push a long
        // base over the limit (which would make set_name error). Truncate to fit.
        let name: String = raw.chars().take(31).collect();
        let header_style = if self.opts.xlsx.header_styling {
            Some(Format::new().set_bold())
        } else {
            None
        };
        // Constant-memory mode: each worksheet streams its rows to a tempfile instead of
        // buffering them in RAM, so a multi-hundred-thousand-row export stays flat (~MBs)
        // instead of growing to hundreds of MB. Requires writing rows strictly
        // top-to-bottom (which the streaming export does) and per-row formatting only on
        // the current row (the bold header is row 0, written before any data row).
        let ws = self.wb.add_worksheet_with_constant_memory();
        ws.set_name(&name).map_err(xerr)?;
        if self.opts.header {
            for (c, col) in self.pcols.iter().enumerate() {
                match &header_style {
                    Some(f) => ws
                        .write_string_with_format(0, c as u16, col, f)
                        .map_err(xerr)?,
                    None => ws.write_string(0, c as u16, col).map_err(xerr)?,
                };
            }
            if self.opts.xlsx.freeze_header {
                ws.set_freeze_panes(1, 0).map_err(xerr)?;
            }
            self.row_in_sheet = 1;
        } else {
            self.row_in_sheet = 0;
        }
        self.sheets += 1;
        self.last_rows.push(self.row_in_sheet.saturating_sub(1));
        Ok(())
    }

    /// Apply the autofilter to the CURRENT (active) worksheet. Done while the sheet is
    /// still current so constant-memory mode never has to reach back into a sheet whose
    /// rows have already been streamed out to its tempfile.
    fn seal_current_sheet(&mut self) -> Result<(), AppError> {
        if !self.opts.xlsx.auto_filter
            || !self.opts.header
            || self.pcols.is_empty()
            || self.sheets == 0
        {
            return Ok(());
        }
        let idx = (self.sheets - 1) as usize;
        let last_row = self.last_rows[idx];
        let last_col = (self.pcols.len() - 1) as u16;
        let ws = self.wb.worksheet_from_index(idx).map_err(xerr)?;
        ws.autofilter(0, 0, last_row, last_col).map_err(xerr)?;
        Ok(())
    }

    fn write_row(&mut self, prow: &[Option<String>]) -> Result<(), AppError> {
        if self.sheets == 0 {
            self.new_sheet()?;
        } else if self.row_in_sheet >= XLSX_MAX_ROWS {
            self.seal_current_sheet()?; // finalize the full sheet before rolling to the next
            self.new_sheet()?;
        }
        let r = self.row_in_sheet;
        let idx = (self.sheets - 1) as usize;
        let ws = self.wb.worksheet_from_index(idx).map_err(xerr)?;
        for (c, v) in prow.iter().enumerate() {
            if let Some(s) = v {
                // Boolean columns land as native Excel booleans (cell type `b`,
                // displayed TRUE/FALSE, usable in formulas); an unrecognized token
                // in a bool column degrades to the raw string.
                match self
                    .pbool
                    .get(c)
                    .copied()
                    .unwrap_or(false)
                    .then(|| bool_token(s))
                    .flatten()
                {
                    Some(b) => ws.write_boolean(r, c as u16, b).map_err(xerr)?,
                    None => ws.write_string(r, c as u16, s).map_err(xerr)?,
                };
            }
        }
        self.row_in_sheet += 1;
        self.last_rows[idx] = r;
        Ok(())
    }

    fn finish(mut self, path: &str) -> Result<(), AppError> {
        if self.sheets == 0 {
            self.new_sheet()?;
        }
        self.seal_current_sheet()?; // autofilter for the final sheet
        self.wb.save(path).map_err(xerr)?;
        drop(self.wb);
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .and_then(|file| file.sync_all())
            .map_err(|e| AppError::new(e.to_string()))?;
        Ok(())
    }
}

/// Sibling-temp writer used by every file export entry point. The destination is
/// untouched on format/query/fsync failure and replaced only after a complete file
/// is durable. This also makes direct callers safe; `lib.rs` may wrap it in another
/// temp file for command-level transaction/cancellation coordination.
struct AtomicExport {
    destination: PathBuf,
    temp: tempfile::TempPath,
    temp_name: String,
}

impl AtomicExport {
    fn new(path: &str) -> Result<Self, AppError> {
        let destination = PathBuf::from(path);
        let parent = destination
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let temp = tempfile::Builder::new()
            .prefix(".tusk-export-")
            .tempfile_in(parent)
            .map_err(|e| AppError::new(format!("cannot create export temp file: {e}")))?;
        if let Ok(meta) = std::fs::metadata(&destination) {
            temp.as_file()
                .set_permissions(meta.permissions())
                .map_err(|e| AppError::new(e.to_string()))?;
        }
        let temp = temp.into_temp_path();
        let temp_name = temp
            .to_str()
            .ok_or_else(|| AppError::new("export temp path is not valid UTF-8"))?
            .to_string();
        Ok(Self {
            destination,
            temp,
            temp_name,
        })
    }

    fn path(&self) -> &str {
        &self.temp_name
    }

    fn persist(self) -> Result<(), AppError> {
        let parent = self.destination.parent().map(Path::to_path_buf);
        self.temp.persist(&self.destination).map_err(|e| {
            AppError::new(format!("cannot replace export destination: {}", e.error))
        })?;
        // A directory fsync makes the rename durable on Unix. Windows doesn't allow
        // opening directories this way; the fully synced file still prevents torn data.
        #[cfg(unix)]
        if let Some(parent) = parent {
            std::fs::File::open(parent)
                .and_then(|dir| dir.sync_all())
                .map_err(|e| AppError::new(format!("cannot sync export directory: {e}")))?;
        }
        #[cfg(not(unix))]
        let _ = parent;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/// Stream a query's full result to `path`, honoring `opts`. Text formats stream in
/// constant memory; xlsx uses rust_xlsxwriter's constant-memory mode (per-sheet tempfile),
/// so RAM stays flat for both.
pub async fn run_export_query(
    client: &Client,
    sql: &str,
    opts: &ExportOptions,
    path: &str,
) -> Result<u64, AppError> {
    opts.validate()?;
    let output = AtomicExport::new(path)?;
    client.batch_execute("BEGIN").await?;
    let declare = format!("DECLARE {EXPORT_CURSOR} CURSOR FOR {sql}");
    if let Err(e) = client.batch_execute(&declare).await {
        let _ = client.batch_execute("ROLLBACK").await;
        return Err(e.into());
    }

    match stream_to_sink(client, opts, SqlDialect::Postgres, output.path()).await {
        Ok(n) => {
            if let Err(error) = client.batch_execute("COMMIT").await {
                let _ = client.batch_execute("ROLLBACK").await;
                return Err(AppError::new(format!(
                    "export commit acknowledgement failed: {error}"
                )));
            }
            output.persist()?;
            Ok(n)
        }
        Err(e) => {
            // AtomicExport removes its sibling temp on drop; the prior destination stays.
            let _ = client.batch_execute("ROLLBACK").await;
            Err(e)
        }
    }
}

/// Shared sink feeder: lazily initializes the right sink on first column set,
/// projects + writes rows, finishes. Used by the PG cursor stream AND the
/// driver-paged path so the two can never drift.
struct SinkFeeder<'a> {
    opts: &'a ExportOptions,
    path: &'a str,
    dialect: SqlDialect,
    is_xlsx: bool,
    indices: Vec<usize>,
    source_cols: usize,
    initialized: bool,
    text: Option<TextEmit<'a>>,
    xlsx: Option<XlsxSink<'a>>,
    total: u64,
}

impl<'a> SinkFeeder<'a> {
    fn new(opts: &'a ExportOptions, dialect: SqlDialect, path: &'a str) -> Self {
        Self {
            opts,
            path,
            dialect,
            is_xlsx: opts.format == "xlsx",
            indices: Vec::new(),
            source_cols: 0,
            initialized: false,
            text: None,
            xlsx: None,
            total: 0,
        }
    }

    fn init_cols(&mut self, cols: &[String]) -> Result<(), AppError> {
        if self.initialized {
            return Ok(());
        }
        validate_columns(cols)?;
        self.source_cols = cols.len();
        self.indices = self.opts.indices(cols.len())?;
        if self.opts.bool_cols.iter().any(|&i| i >= cols.len()) {
            return Err(AppError::new(
                "export boolean-column metadata contains an out-of-range index",
            ));
        }
        self.initialized = true;
        let pcols = project_cols(cols, &self.indices);
        validate_projected_columns(&self.opts.format, &pcols)?;
        let pbool = project_bools(self.opts, &self.indices);
        if self.is_xlsx {
            self.xlsx = Some(XlsxSink::new(self.opts, pcols, pbool));
        } else {
            self.text = Some(TextEmit::new(
                self.opts,
                pcols,
                pbool,
                self.dialect,
                self.path,
            ));
        }
        Ok(())
    }

    async fn feed(&mut self, rows: &[Vec<Option<String>>]) -> Result<(), AppError> {
        if !rows.is_empty() && self.text.is_none() && self.xlsx.is_none() {
            return Err(AppError::new(
                "the export result contains rows but no columns",
            ));
        }
        for row in rows {
            if row.len() != self.source_cols {
                return Err(AppError::new("the export result contains a ragged row"));
            }
            if row
                .iter()
                .flatten()
                .any(|value| value.len() > MAX_CELL_BYTES)
            {
                return Err(AppError::new("an export value exceeds the 1 MiB limit"));
            }
            let prow = project_row(row, &self.indices);
            if self.is_xlsx {
                self.xlsx
                    .as_mut()
                    .ok_or_else(|| AppError::new("xlsx export sink was not initialized"))?
                    .write_row(&prow)?;
            } else {
                self.text
                    .as_mut()
                    .ok_or_else(|| AppError::new("text export sink was not initialized"))?
                    .row(&prow)
                    .await?;
            }
            self.total += 1;
        }
        Ok(())
    }

    async fn finish(self) -> Result<u64, AppError> {
        if self.is_xlsx {
            if let Some(s) = self.xlsx {
                s.finish(self.path)?;
            }
        } else if let Some(mut t) = self.text {
            t.finish().await?;
        }
        Ok(self.total)
    }
}

async fn stream_to_sink(
    client: &Client,
    opts: &ExportOptions,
    dialect: SqlDialect,
    path: &str,
) -> Result<u64, AppError> {
    let mut feeder = SinkFeeder::new(opts, dialect, path);
    loop {
        let fetch = format!("FETCH FORWARD {BATCH} FROM {EXPORT_CURSOR}");
        let messages = client.simple_query(&fetch).await?;
        let (cols, rows) = collect_rows_limited(&messages, USER_TEXT_LIMITS)?;
        feeder.init_cols(&cols)?;
        if rows.is_empty() {
            break;
        }
        let short = (rows.len() as u32) < BATCH;
        feeder.feed(&rows).await?;
        if short {
            break;
        }
    }
    feeder.finish().await
}

/// Driver-paged export for engines without a server-side cursor (DuckDB /
/// SQLite / MySQL): page 1 via `run_single`, then `fetch_page` until done,
/// through the same SinkFeeder as the PG cursor path. On error the pager is
/// reset and the sibling temp removed. NOTE: LIMIT/OFFSET pages aren't
/// snapshot-consistent under concurrent writes (same class as grid paging).
pub async fn run_export_paged(
    backend: &mut crate::driver::Backend,
    sql: &str,
    opts: &ExportOptions,
    path: &str,
) -> Result<u64, AppError> {
    opts.validate()?;
    let dialect = SqlDialect::parse(backend.capabilities().kind)?;
    let output = AtomicExport::new(path)?;
    backend.rollback_cursor().await;
    match paged_inner(backend, sql, opts, dialect, output.path()).await {
        Ok(n) => {
            backend.rollback_cursor().await; // close any remaining pager state
            output.persist()?;
            Ok(n)
        }
        Err(e) => {
            backend.rollback_cursor().await;
            Err(e)
        }
    }
}

async fn paged_inner(
    backend: &mut crate::driver::Backend,
    sql: &str,
    opts: &ExportOptions,
    dialect: SqlDialect,
    path: &str,
) -> Result<u64, AppError> {
    let mut feeder = SinkFeeder::new(opts, dialect, path);
    let out = backend.run_single(sql, BATCH, true).await?;
    let (cols, rows, mut done) = match out {
        db::QueryOutcome::Rows {
            columns,
            rows,
            done,
            ..
        } => (columns, rows, done),
        db::QueryOutcome::Exec { .. } => {
            return Err(AppError::new("the export query returned no result set"))
        }
    };
    feeder.init_cols(&cols)?;
    feeder.feed(&rows).await?;
    while !done {
        let page = backend.fetch_page(BATCH).await?;
        done = page.done;
        feeder.feed(&page.rows).await?;
    }
    feeder.finish().await
}

/// Format buffered rows into an in-memory byte buffer (Slack file attachments).
/// Reuses the file sinks unchanged via a tempfile; `dialect` is the source backend
/// and affects SQL output only.
pub async fn export_rows_to_bytes_for_dialect(
    columns: &[String],
    rows: &[Vec<Option<String>>],
    opts: &ExportOptions,
    dialect: &str,
) -> Result<Vec<u8>, AppError> {
    let dir = tempfile::tempdir().map_err(|e| AppError::new(e.to_string()))?;
    let path = dir.path().join("result.tmp");
    let path_str = path
        .to_str()
        .ok_or_else(|| AppError::new("export temp path is not valid UTF-8"))?;
    run_export_rows_for_dialect(columns, rows, opts, dialect, path_str).await?;
    let len = tokio::fs::metadata(&path)
        .await
        .map_err(|e| AppError::new(e.to_string()))?
        .len();
    if len > MAX_IN_MEMORY_EXPORT_BYTES {
        return Err(AppError::new(
            "formatted attachment exceeds the 64 MiB in-memory limit",
        ));
    }
    tokio::fs::read(&path)
        .await
        .map_err(|e| AppError::new(e.to_string()))
}

/// Export an in-memory result (the rows already loaded in the grid) to `path`.
#[cfg(test)]
pub async fn run_export_rows(
    columns: &[String],
    rows: &[Vec<Option<String>>],
    opts: &ExportOptions,
    path: &str,
) -> Result<u64, AppError> {
    run_export_rows_for_dialect(columns, rows, opts, "postgres", path).await
}

/// Inline export with an explicit source dialect. Callers formatting loaded rows
/// should use this instead of relying on the default PostgreSQL dialect.
pub async fn run_export_rows_for_dialect(
    columns: &[String],
    rows: &[Vec<Option<String>>],
    opts: &ExportOptions,
    dialect: &str,
    path: &str,
) -> Result<u64, AppError> {
    opts.validate()?;
    let dialect = SqlDialect::parse(dialect)?;
    validate_columns(columns)?;
    let output = AtomicExport::new(path)?;
    let total = run_export_rows_inner(columns, rows, opts, dialect, output.path()).await?;
    output.persist()?;
    Ok(total)
}

async fn run_export_rows_inner(
    columns: &[String],
    rows: &[Vec<Option<String>>],
    opts: &ExportOptions,
    dialect: SqlDialect,
    path: &str,
) -> Result<u64, AppError> {
    let indices = opts.indices(columns.len())?;
    if opts.bool_cols.iter().any(|&i| i >= columns.len()) {
        return Err(AppError::new(
            "export boolean-column metadata contains an out-of-range index",
        ));
    }
    let pcols = project_cols(columns, &indices);
    validate_projected_columns(&opts.format, &pcols)?;
    let pbool = project_bools(opts, &indices);
    let mut total: u64 = 0;
    if opts.format == "xlsx" {
        let mut sink = XlsxSink::new(opts, pcols, pbool);
        for row in rows {
            validate_export_row(row, columns.len())?;
            sink.write_row(&project_row(row, &indices))?;
            total += 1;
        }
        sink.finish(path)?;
    } else {
        let mut emit = TextEmit::new(opts, pcols, pbool, dialect, path);
        for row in rows {
            validate_export_row(row, columns.len())?;
            emit.row(&project_row(row, &indices)).await?;
            total += 1;
        }
        emit.finish().await?;
    }
    Ok(total)
}

fn validate_export_row(row: &[Option<String>], columns: usize) -> Result<(), AppError> {
    if row.len() != columns {
        return Err(AppError::new("the export result contains a ragged row"));
    }
    if row
        .iter()
        .flatten()
        .any(|value| value.len() > MAX_CELL_BYTES)
    {
        return Err(AppError::new("an export value exceeds the 1 MiB limit"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests — the boolean mapping here is a PARITY PAIR with src/formats.test.ts
// (`formatWithOptions`): both assert the same outputs for the same inputs.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(json: &str) -> ExportOptions {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn hostile_export_options_are_rejected() {
        let mut o = opts(r#"{"format":"csv"}"#);
        assert!(o.validate().is_ok());
        o.format = "exe".into();
        assert!(o.validate().is_err());
        o.format = "csv".into();
        o.delimiter = "custom".into();
        o.custom_delimiter = "\n".into();
        assert!(o.validate().is_err());
        o.custom_delimiter = ",".into();
        o.xlsx.sheet_name = "bad/name".into();
        assert!(o.validate().is_err());

        // The SQL table option is inert for non-SQL formats, matching the frontend
        // formatter; only SQL output must reject an unrepresentable identifier.
        let mut table = opts(r#"{"format":"csv","sql":{"table":"bad\u0000name"}}"#);
        assert!(table.validate().is_ok());
        table.format = "sql".into();
        assert!(table.validate().is_err());
    }

    /// `note` deliberately holds bool-looking tokens: NOT in bool_cols, must pass raw.
    fn data() -> (Vec<String>, Vec<Vec<Option<String>>>) {
        let cols = vec!["id".into(), "active".into(), "note".into()];
        let rows = vec![
            vec![Some("1".into()), Some("t".into()), Some("t".into())],
            vec![Some("2".into()), Some("f".into()), Some("plain".into())],
            vec![Some("3".into()), None, None],
        ];
        (cols, rows)
    }

    #[tokio::test]
    async fn zero_column_rows_return_an_error_instead_of_panicking() {
        let options = opts(r#"{"format":"csv"}"#);
        let mut feeder = SinkFeeder::new(&options, SqlDialect::Postgres, "unused.csv");
        let err = feeder.init_cols(&[]).unwrap_err();
        assert!(err.message.contains("no columns"));
    }

    #[test]
    fn out_of_range_projection_is_rejected_before_writing() {
        let mut options = opts(r#"{"format":"csv","columnIndices":[99]}"#);
        let mut feeder = SinkFeeder::new(&options, SqlDialect::Postgres, "unused.csv");
        assert!(feeder.init_cols(&["only".into()]).is_err());
        drop(feeder);
        options.column_indices = vec![0];
        options.quote_char = "\n".into();
        assert!(options.validate().is_err());
    }

    async fn export(o: &ExportOptions, name: &str) -> String {
        let (cols, rows) = data();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name);
        let p = path.to_string_lossy().to_string();
        run_export_rows(&cols, &rows, o, &p).await.unwrap();
        std::fs::read_to_string(&path).unwrap()
    }

    #[test]
    fn bool_token_matches_grid_word_set() {
        // Exactly src/grid/bool.ts boolWord — no more, no less.
        for (v, want) in [
            ("t", Some(true)),
            ("true", Some(true)),
            ("TRUE", Some(true)),
            ("1", Some(true)),
            ("f", Some(false)),
            ("false", Some(false)),
            ("FALSE", Some(false)),
            ("0", Some(false)),
            ("T", None),
            ("True", None),
            ("yes", None),
            ("", None),
        ] {
            assert_eq!(bool_token(v), want, "token {v:?}");
        }
    }

    #[test]
    fn detect_heuristic_mirrors_grid() {
        let rows: Vec<Vec<Option<String>>> = vec![
            vec![Some("t".into()), Some("1".into()), None, Some("t".into())],
            vec![
                Some("false".into()),
                Some("0".into()),
                None,
                Some("x".into()),
            ],
        ];
        // col0: all tokens → detected. col1: 0/1 are NOT heuristic tokens (integer
        // columns would misclassify). col2: all-NULL → not detected. col3: mixed → no.
        assert_eq!(detect_bool_cols(4, &rows), vec![0]);
    }

    #[tokio::test]
    async fn csv_maps_only_bool_cols() {
        let text = export(&opts(r#"{"format":"csv","boolCols":[1]}"#), "csv").await;
        assert_eq!(text, "id,active,note\n1,TRUE,t\n2,FALSE,plain\n3,,\n");
    }

    #[tokio::test]
    async fn csv_without_bool_cols_is_unchanged() {
        let text = export(&opts(r#"{"format":"csv"}"#), "csv_raw").await;
        assert_eq!(text, "id,active,note\n1,t,t\n2,f,plain\n3,,\n");
    }

    #[tokio::test]
    async fn json_emits_real_booleans() {
        let text = export(&opts(r#"{"format":"json","boolCols":[1]}"#), "json").await;
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v[0]["active"], serde_json::Value::Bool(true));
        assert_eq!(v[0]["note"], serde_json::Value::String("t".into()));
        assert_eq!(v[1]["active"], serde_json::Value::Bool(false));
        assert_eq!(v[2]["active"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn json_rejects_duplicate_projected_keys_without_touching_destination() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("result.json");
        std::fs::write(&path, "stale").unwrap();
        let err = run_export_rows(
            &["same".into(), "same".into()],
            &[vec![Some("a".into()), Some("b".into())]],
            &opts(r#"{"format":"json"}"#),
            path.to_str().unwrap(),
        )
        .await
        .unwrap_err();
        assert!(err.message.contains("unique column names"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), "stale");
    }

    #[tokio::test]
    async fn sql_emits_unquoted_literals_and_boolean_create_type() {
        let text = export(
            &opts(r#"{"format":"sql","boolCols":[1],"sql":{"table":"exported","includeCreate":true}}"#),
            "sql",
        )
        .await;
        assert!(
            text.contains(r#"CREATE TABLE "exported" ("id" text, "active" boolean, "note" text);"#),
            "{text}"
        );
        assert!(text.contains("VALUES ('1', TRUE, 't');"), "{text}");
        assert!(text.contains("VALUES ('3', NULL, NULL);"), "{text}");
    }

    #[tokio::test]
    async fn sql_export_quotes_mysql_identifiers_and_uses_mode_safe_values() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("result.sql");
        let options = opts(r#"{"format":"sql","sql":{"table":"ta`ble","includeCreate":true}}"#);
        run_export_rows_for_dialect(
            &["co`l".into()],
            &[vec![Some("path\\name's".into())]],
            &options,
            "mysql",
            path.to_str().unwrap(),
        )
        .await
        .unwrap();
        let text = std::fs::read_to_string(path).unwrap();
        assert!(
            text.contains("CREATE TABLE `ta``ble` (`co``l` text);"),
            "{text}"
        );
        assert!(
            text.contains("CONVERT(X'706174685c6e616d652773' USING utf8mb4)"),
            "{text}"
        );
        assert!(!text.contains("'path\\name"), "{text}");
    }

    #[test]
    fn sql_literals_preserve_controls_or_fail_explicitly() {
        assert_eq!(
            sql_string("a\\b'c", SqlDialect::Postgres).unwrap(),
            "E'a\\\\b''c'"
        );
        assert!(sql_string("a\0b", SqlDialect::Postgres).is_err());
        assert_eq!(
            sql_string("a\0b", SqlDialect::Sqlite).unwrap(),
            "CAST(X'610062' AS TEXT)"
        );
        assert_eq!(
            sql_string("a\0b", SqlDialect::DuckDb).unwrap(),
            "decode(from_hex('610062'))"
        );
    }

    #[test]
    fn embedded_dialect_control_literals_round_trip() {
        let value = "first\nsecond";

        let sqlite = rusqlite::Connection::open_in_memory().unwrap();
        let sqlite_sql = format!("SELECT {}", sql_string(value, SqlDialect::Sqlite).unwrap());
        let sqlite_value: String = sqlite.query_row(&sqlite_sql, [], |row| row.get(0)).unwrap();
        assert_eq!(sqlite_value, value);

        let duck = duckdb::Connection::open_in_memory().unwrap();
        let duck_sql = format!("SELECT {}", sql_string(value, SqlDialect::DuckDb).unwrap());
        let duck_value: String = duck.query_row(&duck_sql, [], |row| row.get(0)).unwrap();
        assert_eq!(duck_value, value);
    }

    #[tokio::test]
    async fn zero_rows_atomically_replace_stale_files_with_valid_outputs() {
        let dir = tempfile::tempdir().unwrap();
        let columns = vec!["id".into()];
        let rows: Vec<Vec<Option<String>>> = Vec::new();

        let csv = dir.path().join("empty.csv");
        std::fs::write(&csv, "stale").unwrap();
        assert_eq!(
            run_export_rows(
                &columns,
                &rows,
                &opts(r#"{"format":"csv"}"#),
                csv.to_str().unwrap(),
            )
            .await
            .unwrap(),
            0
        );
        assert_eq!(std::fs::read_to_string(&csv).unwrap(), "id\n");

        let json = dir.path().join("empty.json");
        std::fs::write(&json, "stale").unwrap();
        run_export_rows(
            &columns,
            &rows,
            &opts(r#"{"format":"json"}"#),
            json.to_str().unwrap(),
        )
        .await
        .unwrap();
        let text = std::fs::read_to_string(json).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&text).unwrap(),
            serde_json::json!([])
        );

        let sql = dir.path().join("empty.sql");
        std::fs::write(&sql, "stale").unwrap();
        run_export_rows(
            &columns,
            &rows,
            &opts(r#"{"format":"sql","sql":{"table":"empty","includeCreate":true}}"#),
            sql.to_str().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(sql).unwrap(),
            "CREATE TABLE \"empty\" (\"id\" text);\n"
        );
    }

    #[tokio::test]
    async fn zero_row_xlsx_is_a_valid_nonempty_workbook() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.xlsx");
        std::fs::write(&path, "stale").unwrap();
        run_export_rows(
            &["id".into()],
            &[],
            &opts(r#"{"format":"xlsx"}"#),
            path.to_str().unwrap(),
        )
        .await
        .unwrap();
        let bytes = std::fs::read(path).unwrap();
        assert!(bytes.starts_with(b"PK"));
        assert!(bytes.len() > 100);
    }

    #[tokio::test]
    async fn markdown_maps_to_display_words() {
        let text = export(&opts(r#"{"format":"markdown","boolCols":[1]}"#), "md").await;
        assert!(text.contains("| 1 | TRUE | t |"), "{text}");
        assert!(text.contains("| 2 | FALSE | plain |"), "{text}");
    }

    #[tokio::test]
    async fn bool_cols_are_source_indices_surviving_projection() {
        let text = export(
            &opts(r#"{"format":"csv","boolCols":[1],"columnIndices":[2,1]}"#),
            "proj",
        )
        .await;
        assert_eq!(text, "note,active\nt,TRUE\nplain,FALSE\n,\n");
    }

    #[tokio::test]
    async fn unrecognized_tokens_in_a_bool_col_pass_raw() {
        let cols = vec!["b".into()];
        let rows: Vec<Vec<Option<String>>> = vec![
            vec![Some("maybe".into())],
            vec![Some("1".into())],
            vec![Some("0".into())],
        ];
        let path =
            std::env::temp_dir().join(format!("tusk_boolexp_{}_raw.csv", std::process::id()));
        let p = path.to_string_lossy().to_string();
        run_export_rows(
            &cols,
            &rows,
            &opts(r#"{"format":"csv","boolCols":[0]}"#),
            &p,
        )
        .await
        .unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        // 1/0 are recognized tokens (SQLite/MySQL numeric booleans); junk stays raw.
        assert_eq!(text, "b\nmaybe\nTRUE\nFALSE\n");
    }

    #[tokio::test]
    async fn xlsx_bool_col_writes_without_error() {
        let (cols, rows) = data();
        let path = std::env::temp_dir().join(format!("tusk_boolexp_{}.xlsx", std::process::id()));
        let p = path.to_string_lossy().to_string();
        let n = run_export_rows(
            &cols,
            &rows,
            &opts(r#"{"format":"xlsx","boolCols":[1]}"#),
            &p,
        )
        .await
        .unwrap();
        assert_eq!(n, 3);
        let meta = std::fs::metadata(&path).unwrap();
        assert!(meta.len() > 0);
        let _ = std::fs::remove_file(&path);
    }
}
