//! File-driven data import.
//!
//! `import_preview` parses the head of a file with no database involved; the UI uses it
//! to show detected columns, sampled rows and warnings before anything is written.
//! `import_from_file` streams the same file in bounded batches straight from disk into
//! the connected database — the file bytes never cross the Tauri IPC boundary.
//!
//! The row load is one transaction, so a failed or cancelled load leaves no rows behind.
//! MySQL DDL implicitly commits *and ends* a transaction, so a `create` import against
//! MySQL runs its `CREATE TABLE` BEFORE the transaction opens and reports it as a
//! separately committed step: the rows still roll back, but the empty table remains.
//!
//! Acceptance rules for delimited text, JSON and xlsx live here and are pinned by the
//! fixtures in `tests` below. `src/formats.ts` is the clipboard/paste formatter, not a
//! second import parser — it has no parity obligation to this file.

use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use bytes::Bytes;
use futures_util::SinkExt;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::db::AppError;
use crate::driver::{Backend, CancelHandle};

// ---------------------------------------------------------------------------
// Limits (documented in docs/adversarial-hardening.md)
// ---------------------------------------------------------------------------

/// Streamed text formats never load the whole file, but a runaway path is still bounded.
const MAX_TEXT_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// xlsx must be decompressed in memory by `calamine`, so it gets a much smaller budget.
const MAX_XLSX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_IMPORT_COLUMNS: usize = 10_000;
const MAX_IMPORT_ROWS: u64 = 10_000_000;
const MAX_FIELD_BYTES: usize = 1_000_000;
/// One source/target column NAME. Keeps `source_columns` (up to 10,000 entries) and a
/// parsed header bounded per element, not only in count.
const MAX_COLUMN_NAME_BYTES: usize = 512;
/// One JSON array element / NDJSON line.
const MAX_JSON_ELEMENT_BYTES: usize = 16 * 1024 * 1024;
const MAX_XLSX_CELLS: usize = 5_000_000;
/// Rows sampled by `import_preview`.
pub const PREVIEW_ROWS: usize = 50;
/// Aggregate ceiling on the `ImportPreview` IPC payload. Sampling stops (and the
/// preview reports itself truncated) rather than shipping an unbounded blob.
const MAX_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
/// One previewed cell. Longer values are elided for display/inference only — the load
/// path re-reads the file and never sees the truncation.
const MAX_PREVIEW_CELL_CHARS: usize = 2_000;
/// Rows per parsed batch handed to the loader.
const BATCH_ROWS: usize = 1_000;
/// Byte ceiling for one generated statement — safely under MySQL's 16 MiB client
/// `max_allowed_packet` default and every other engine's statement limit.
const BATCH_BYTES: usize = 1024 * 1024;
const MAX_IDENT_BYTES: usize = 512;
const MAX_WARNINGS: usize = 32;
/// Minimum gap between `import-progress` events.
const PROGRESS_INTERVAL_MS: u128 = 120;

fn de<E: std::fmt::Display>(e: E) -> AppError {
    AppError::new(e.to_string())
}

// ---------------------------------------------------------------------------
// Options / target payloads (mirrors src/import.ts)
// ---------------------------------------------------------------------------

fn d_comma() -> String {
    "comma".to_string()
}
fn d_dquote() -> String {
    "\"".to_string()
}
fn d_true() -> bool {
    true
}
fn d_utf8() -> String {
    "utf-8".to_string()
}
fn d_error() -> String {
    "error".to_string()
}
fn d_text() -> String {
    "text".to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    /// "csv" (TSV is the tab delimiter), "json", or "xlsx".
    pub format: String,
    #[serde(default = "d_comma")]
    pub delimiter: String,
    #[serde(default)]
    pub custom_delimiter: String,
    /// One character, or empty to turn quoting off entirely (every delimiter and quote
    /// byte is then literal field content).
    #[serde(default = "d_dquote")]
    pub quote_char: String,
    /// Empty = RFC 4180 doubled quotes only. One character additionally acts as a
    /// backslash-style escape inside a quoted field.
    #[serde(default)]
    pub escape_char: String,
    #[serde(default = "d_true")]
    pub header: bool,
    /// "utf-8" (a UTF-8 BOM is accepted and stripped) or "latin1".
    #[serde(default = "d_utf8")]
    pub encoding: String,
    /// A field exactly equal to this text becomes NULL. Empty disables the mapping.
    #[serde(default)]
    pub null_text: String,
    /// Rows discarded before the header row is read.
    #[serde(default)]
    pub skip_rows: u32,
    /// xlsx sheet name; empty selects the first sheet.
    #[serde(default)]
    pub sheet: String,
    /// The source column names the UI saw in the preview. Empty while previewing; the
    /// run path requires them, so a file edited between preview and run is refused
    /// instead of silently landing in the wrong columns.
    #[serde(default)]
    pub source_columns: Vec<String>,
}

impl ImportOptions {
    pub fn validate(&self) -> Result<(), AppError> {
        if !matches!(self.format.as_str(), "csv" | "json" | "xlsx") {
            return Err(AppError::new("unsupported import format"));
        }
        if !matches!(
            self.delimiter.as_str(),
            "comma" | "tab" | "semicolon" | "pipe" | "custom"
        ) {
            return Err(AppError::new("invalid import delimiter"));
        }
        if !matches!(self.encoding.as_str(), "utf-8" | "latin1") {
            return Err(AppError::new("unsupported import encoding"));
        }
        let one_char = |s: &str| s.chars().count() == 1 && !s.contains(['\r', '\n']);
        if (!self.quote_char.is_empty() && !one_char(&self.quote_char))
            || (self.delimiter == "custom" && !one_char(&self.custom_delimiter))
            || (!self.escape_char.is_empty() && !one_char(&self.escape_char))
        {
            return Err(AppError::new(
                "import delimiter, quote and escape characters must each be one non-newline character",
            ));
        }
        // An escape equal to the quote breaks RFC-4180 doubling; an escape equal to the
        // delimiter silently swallows separators. Both must be rejected, not guessed at.
        let delim = self.delim();
        if self.quote_c() == Some(delim) {
            return Err(AppError::new(
                "import delimiter and quote character must differ",
            ));
        }
        if let Some(escape) = self.escape_c() {
            if Some(escape) == self.quote_c() {
                return Err(AppError::new(
                    "import escape and quote character must differ. Leave Escape empty for doubled quotes.",
                ));
            }
            if escape == delim {
                return Err(AppError::new(
                    "import escape character and delimiter must differ",
                ));
            }
        }
        if self.null_text.len() > 1024
            || self.skip_rows > 1_000_000
            || self.sheet.len() > 200
            || self.source_columns.len() > MAX_IMPORT_COLUMNS
            || self
                .source_columns
                .iter()
                .any(|c| c.len() > MAX_COLUMN_NAME_BYTES)
        {
            return Err(AppError::new("import option exceeds its size limit"));
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
    /// `None` when quoting is turned off.
    fn quote_c(&self) -> Option<char> {
        self.quote_char.chars().next()
    }
    fn escape_c(&self) -> Option<char> {
        self.escape_char.chars().next()
    }
    fn null_of(&self, value: String) -> Option<String> {
        if !self.null_text.is_empty() && value == self.null_text {
            None
        } else {
            Some(value)
        }
    }
}

/// One mapped column: which source column feeds which target column, and how the text
/// becomes a SQL literal.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportColumn {
    /// Zero-based index into the parsed source row.
    pub source: usize,
    pub target: String,
    #[serde(rename = "type", default = "d_text")]
    pub kind: String,
    /// Treat an empty string in this column as NULL.
    #[serde(default)]
    pub empty_as_null: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTarget {
    #[serde(default)]
    pub schema: String,
    pub table: String,
    /// Create the target table from the mapped columns before loading.
    #[serde(default)]
    pub create: bool,
    /// Empty the table (inside the import transaction) before loading.
    #[serde(default)]
    pub truncate: bool,
    /// "error" (plain INSERT), "ignore", or "update" (upsert).
    #[serde(default = "d_error")]
    pub conflict: String,
    pub columns: Vec<ImportColumn>,
    /// Conflict target for `update` on PostgreSQL (`ON CONFLICT (…) DO UPDATE`).
    #[serde(default)]
    pub key_columns: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub warnings: Vec<String>,
    /// Sheet names for an xlsx workbook (empty for the text formats).
    pub sheets: Vec<String>,
    /// More rows exist beyond the sampled ones.
    pub truncated: bool,
    pub file_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub rows_read: u64,
    pub rows_inserted: u64,
    pub rows_skipped: u64,
    pub warnings: Vec<String>,
    /// MySQL DDL implicitly commits, so a create-and-load import runs its `CREATE TABLE`
    /// before the transaction opens. True means the table itself is already committed
    /// and would survive a failed or cancelled row load.
    pub created_outside_transaction: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgress {
    rows_read: u64,
    rows_inserted: u64,
    bytes_read: u64,
    total_bytes: u64,
    done: bool,
}

/// What `run_import` reports to its caller between batches.
pub struct ImportProgressUpdate {
    pub rows_read: u64,
    pub rows_inserted: u64,
    pub bytes_read: u64,
    pub total_bytes: u64,
    pub done: bool,
    /// Emit even if the throttle interval has not elapsed (first/last update).
    pub force: bool,
}

// ---------------------------------------------------------------------------
// Column types — the token set the UI infers, mapped per engine.
// PARITY PAIR with `SQL_TYPES` in src/import.ts.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnType {
    Text,
    Integer,
    BigInt,
    Numeric,
    Boolean,
    Date,
    Timestamp,
}

impl ColumnType {
    fn parse(value: &str) -> Result<Self, AppError> {
        Ok(match value {
            "text" => Self::Text,
            "integer" => Self::Integer,
            "bigint" => Self::BigInt,
            "numeric" => Self::Numeric,
            "boolean" => Self::Boolean,
            "date" => Self::Date,
            "timestamp" => Self::Timestamp,
            _ => {
                return Err(AppError::new(format!(
                    "unknown import column type: {value}"
                )))
            }
        })
    }

    /// The DDL type used when the import creates the table.
    fn sql(self, dialect: Dialect) -> &'static str {
        match self {
            Self::Text => match dialect {
                Dialect::Postgres => "text",
                Dialect::DuckDb => "VARCHAR",
                Dialect::Sqlite | Dialect::MySql => "TEXT",
            },
            Self::Integer => match dialect {
                Dialect::MySql => "INT",
                _ => "INTEGER",
            },
            Self::BigInt => match dialect {
                Dialect::Sqlite => "INTEGER",
                _ => "BIGINT",
            },
            Self::Numeric => match dialect {
                Dialect::Postgres => "numeric",
                Dialect::DuckDb => "DOUBLE",
                Dialect::Sqlite => "NUMERIC",
                Dialect::MySql => "DECIMAL(38,10)",
            },
            Self::Boolean => match dialect {
                Dialect::Postgres => "boolean",
                Dialect::DuckDb => "BOOLEAN",
                Dialect::Sqlite => "INTEGER",
                Dialect::MySql => "TINYINT(1)",
            },
            Self::Date => match dialect {
                Dialect::Postgres => "date",
                Dialect::Sqlite => "TEXT",
                _ => "DATE",
            },
            Self::Timestamp => match dialect {
                Dialect::Postgres => "timestamp",
                Dialect::DuckDb => "TIMESTAMP",
                Dialect::Sqlite => "TEXT",
                Dialect::MySql => "DATETIME",
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Dialect quoting + literals. PARITY PAIR with export.rs `sql_ident`/`sql_string`.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Dialect {
    Postgres,
    DuckDb,
    Sqlite,
    MySql,
}

impl Dialect {
    fn parse(kind: &str) -> Result<Self, AppError> {
        Ok(match kind {
            "postgres" => Self::Postgres,
            "duckdb" => Self::DuckDb,
            "sqlite" => Self::Sqlite,
            "mysql" => Self::MySql,
            // Named explicitly: this is the reason the Explorer's disabled import
            // items, the manual and `docs/adversarial-hardening.md` all give.
            "mssql" => {
                return Err(AppError::new(
                    "file import isn't available on SQL Server yet. Use the SQL editor or a bulk-load tool.",
                ))
            }
            _ => return Err(AppError::new("unsupported import dialect")),
        })
    }

    fn ident(self, name: &str) -> String {
        match self {
            Self::MySql => format!("`{}`", name.replace('`', "``")),
            _ => crate::db::ident(name),
        }
    }

    fn qualify(self, schema: &str, table: &str) -> String {
        if schema.is_empty() {
            self.ident(table)
        } else {
            format!("{}.{}", self.ident(schema), self.ident(table))
        }
    }

    fn string_literal(self, value: &str) -> Result<String, AppError> {
        let control = value.chars().any(char::is_control);
        match self {
            Self::Postgres if value.contains('\0') => Err(AppError::new(
                "PostgreSQL cannot store a text value containing a zero byte",
            )),
            Self::Postgres if value.contains('\\') => crate::db::pg_string_literal(value),
            Self::MySql if value.contains('\\') || control => {
                Ok(format!("CONVERT(X'{}' USING utf8mb4)", hex_bytes(value)))
            }
            Self::Sqlite if control => Ok(format!("CAST(X'{}' AS TEXT)", hex_bytes(value))),
            Self::DuckDb if control => Ok(format!("decode(from_hex('{}'))", hex_bytes(value))),
            _ => Ok(format!("'{}'", value.replace('\'', "''"))),
        }
    }
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

fn is_integer_text(v: &str) -> bool {
    let body = v.strip_prefix(['+', '-']).unwrap_or(v);
    !body.is_empty() && body.bytes().all(|b| b.is_ascii_digit())
}

fn is_numeric_text(v: &str) -> bool {
    let body = v.strip_prefix(['+', '-']).unwrap_or(v);
    let (mantissa, exponent) = match body.split_once(['e', 'E']) {
        Some((m, e)) => (m, Some(e)),
        None => (body, None),
    };
    let mut parts = mantissa.split('.');
    let whole = parts.next().unwrap_or("");
    let frac = parts.next().unwrap_or("");
    if parts.next().is_some() || (whole.is_empty() && frac.is_empty()) {
        return false;
    }
    if !whole.bytes().all(|b| b.is_ascii_digit()) || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    match exponent {
        None => true,
        Some(e) => is_integer_text(e),
    }
}

/// Recognized boolean spellings in imported text. Deliberately wider than the export
/// token set — files carry `yes`/`no`, `Y`/`N`, `TRUE` — and case-insensitive.
fn bool_text(v: &str) -> Option<bool> {
    match v.trim().to_ascii_lowercase().as_str() {
        "t" | "true" | "yes" | "y" | "1" | "on" => Some(true),
        "f" | "false" | "no" | "n" | "0" | "off" => Some(false),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Shared parsing helpers
// ---------------------------------------------------------------------------

/// The callback every parser drives: resolved columns, one shaped row, bytes consumed.
/// Returning `false` stops parsing without an error.
type RowSink<'a> = &'a mut dyn FnMut(&[String], Vec<Option<String>>, u64) -> bool;

struct ParseOutcome {
    columns: Vec<String>,
    warnings: Vec<String>,
    sheets: Vec<String>,
}

struct RowBudget {
    rows: u64,
}

impl RowBudget {
    fn new() -> Self {
        Self { rows: 0 }
    }
    fn count(&mut self) -> Result<(), AppError> {
        self.rows = self.rows.saturating_add(1);
        if self.rows > MAX_IMPORT_ROWS {
            return Err(AppError::new(format!(
                "import exceeds the {MAX_IMPORT_ROWS}-row limit"
            )));
        }
        Ok(())
    }
}

fn field_guard(len: usize) -> Result<(), AppError> {
    if len > MAX_FIELD_BYTES {
        return Err(AppError::new(format!(
            "import is too large: a field exceeds {MAX_FIELD_BYTES} bytes"
        )));
    }
    Ok(())
}

fn columns_guard(n: usize) -> Result<(), AppError> {
    if n > MAX_IMPORT_COLUMNS {
        return Err(AppError::new(format!(
            "import is too large: more than {MAX_IMPORT_COLUMNS} columns"
        )));
    }
    Ok(())
}

/// Reject an empty, over-long or duplicated (case-insensitive) header. `noun` names the
/// source in the error so an xlsx problem does not read as a delimited one.
fn validate_header(columns: &[String], noun: &str) -> Result<(), AppError> {
    columns_guard(columns.len())?;
    if columns.iter().any(|c| c.is_empty()) {
        return Err(AppError::new(format!(
            "{noun} header contains an empty column name"
        )));
    }
    if columns.iter().any(|c| c.len() > MAX_COLUMN_NAME_BYTES) {
        return Err(AppError::new(format!(
            "{noun} header contains a column name longer than {MAX_COLUMN_NAME_BYTES} bytes"
        )));
    }
    let mut seen = std::collections::HashSet::with_capacity(columns.len());
    if columns.iter().any(|c| !seen.insert(c.to_lowercase())) {
        return Err(AppError::new(format!(
            "{noun} header contains duplicate column names"
        )));
    }
    Ok(())
}

/// Shape a raw parsed row against the resolved columns: pad short rows with NULL, reject
/// wide ones.
fn shape_row(
    raw: Vec<String>,
    width: usize,
    row_number: u64,
    options: &ImportOptions,
    warnings: &mut Vec<String>,
) -> Result<Vec<Option<String>>, AppError> {
    if raw.len() > width {
        return Err(AppError::new(format!(
            "row {row_number} has more fields ({}) than the {width} detected columns",
            raw.len()
        )));
    }
    if raw.len() < width && warnings.len() < MAX_WARNINGS {
        warnings.push(format!(
            "row {row_number} has only {} of {width} fields. The rest import as NULL.",
            raw.len()
        ));
    }
    let mut out = Vec::with_capacity(width);
    let mut raw = raw.into_iter();
    for _ in 0..width {
        out.push(match raw.next() {
            Some(v) => options.null_of(v),
            None => None,
        });
    }
    Ok(out)
}

/// Decode a byte stream to text. UTF-8 (with an optional BOM) is validated strictly and
/// never degrades to replacement characters; Latin-1 maps every byte to its code point.
struct Decoder {
    latin1: bool,
    pending: Vec<u8>,
    started: bool,
}

impl Decoder {
    fn new(latin1: bool) -> Self {
        Self {
            latin1,
            pending: Vec::new(),
            started: false,
        }
    }

    fn push(&mut self, bytes: &[u8], out: &mut String) -> Result<(), AppError> {
        self.pending.extend_from_slice(bytes);
        if !self.started {
            if self.pending.starts_with(&[0xEF, 0xBB, 0xBF]) {
                self.pending.drain(..3);
                self.started = true;
            } else if self.pending.len() >= 3 || bytes.is_empty() {
                self.started = true;
            } else {
                return Ok(());
            }
        }
        if self.latin1 {
            for &b in &self.pending {
                out.push(b as char);
            }
            self.pending.clear();
            return Ok(());
        }
        match std::str::from_utf8(&self.pending) {
            Ok(text) => {
                out.push_str(text);
                self.pending.clear();
            }
            Err(error) => {
                if error.error_len().is_some() {
                    return Err(AppError::new(
                        "import file is not valid UTF-8. Pick the Latin-1 encoding if the file uses it.",
                    ));
                }
                let valid = error.valid_up_to();
                out.push_str(std::str::from_utf8(&self.pending[..valid]).expect("validated"));
                self.pending.drain(..valid);
            }
        }
        Ok(())
    }

    fn finish(&mut self, out: &mut String) -> Result<(), AppError> {
        self.push(&[], out)?;
        if !self.pending.is_empty() {
            return Err(AppError::new(
                "import file ends with an incomplete character sequence",
            ));
        }
        Ok(())
    }
}

/// Streaming delimited-text parser and the sole definition of what Tusk accepts: a
/// quote may only open a field, characters after a closing quote are an error, an
/// unterminated quoted field is an error, and a wholly blank line is a separator.
struct DelimitedParser {
    delim: char,
    /// `None` when the user turned quoting off; every byte is then literal content.
    quote: Option<char>,
    escape: Option<char>,
    in_quotes: bool,
    after_quote: bool,
    field_started: bool,
    escaped: bool,
    field: String,
    row: Vec<String>,
}

impl DelimitedParser {
    fn new(options: &ImportOptions) -> Self {
        Self {
            delim: options.delim(),
            quote: options.quote_c(),
            escape: options.escape_c(),
            in_quotes: false,
            after_quote: false,
            field_started: false,
            escaped: false,
            field: String::new(),
            row: Vec::new(),
        }
    }

    fn push_field(&mut self) -> Result<(), AppError> {
        columns_guard(self.row.len().saturating_add(1))?;
        self.row.push(std::mem::take(&mut self.field));
        self.after_quote = false;
        self.field_started = false;
        Ok(())
    }

    /// Feed decoded text; complete rows land in `out`. `last` marks EOF, which resolves
    /// the pending lookaheads and flushes a trailing row. Returns bytes consumed.
    fn feed(
        &mut self,
        text: &str,
        last: bool,
        out: &mut Vec<Vec<String>>,
    ) -> Result<usize, AppError> {
        let chars: Vec<char> = text.chars().collect();
        let mut i = 0usize;
        while i < chars.len() {
            let ch = chars[i];
            if self.in_quotes {
                if self.escaped {
                    self.field.push(ch);
                    field_guard(self.field.len())?;
                    self.escaped = false;
                    i += 1;
                    continue;
                }
                if Some(ch) == self.escape {
                    if i + 1 >= chars.len() && !last {
                        break;
                    }
                    self.escaped = true;
                    i += 1;
                    continue;
                }
                if Some(ch) == self.quote {
                    if i + 1 >= chars.len() && !last {
                        break; // the next character decides doubled vs. closing
                    }
                    if chars.get(i + 1) == self.quote.as_ref() {
                        self.field.push(ch);
                        field_guard(self.field.len())?;
                        i += 2;
                        continue;
                    }
                    self.in_quotes = false;
                    self.after_quote = true;
                    i += 1;
                    continue;
                }
                self.field.push(ch);
                field_guard(self.field.len())?;
                i += 1;
                continue;
            }
            if self.after_quote && ch != self.delim && ch != '\r' && ch != '\n' {
                return Err(AppError::new(
                    "malformed delimited file: characters after a closing quote",
                ));
            }
            if Some(ch) == self.quote {
                if self.field_started || !self.field.is_empty() {
                    return Err(AppError::new(
                        "malformed delimited file: quote inside an unquoted field",
                    ));
                }
                self.in_quotes = true;
                self.field_started = true;
                i += 1;
                continue;
            }
            if ch == self.delim {
                self.push_field()?;
                i += 1;
                continue;
            }
            if ch == '\r' {
                if i + 1 >= chars.len() && !last {
                    break; // an \n may follow
                }
                self.push_field()?;
                out.push(std::mem::take(&mut self.row));
                i += if chars.get(i + 1) == Some(&'\n') {
                    2
                } else {
                    1
                };
                continue;
            }
            if ch == '\n' {
                self.push_field()?;
                out.push(std::mem::take(&mut self.row));
                i += 1;
                continue;
            }
            self.field.push(ch);
            field_guard(self.field.len())?;
            self.field_started = true;
            i += 1;
        }
        if last {
            if self.in_quotes {
                return Err(AppError::new(
                    "malformed delimited file: unterminated quoted field",
                ));
            }
            if self.field_started
                || self.after_quote
                || !self.field.is_empty()
                || !self.row.is_empty()
            {
                self.push_field()?;
                out.push(std::mem::take(&mut self.row));
            }
        }
        Ok(chars[..i].iter().map(|c| c.len_utf8()).sum())
    }
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

fn file_size(path: &Path) -> Result<u64, AppError> {
    let meta = std::fs::metadata(path)
        .map_err(|e| AppError::new(format!("cannot read {}: {e}", path.display())))?;
    if !meta.is_file() {
        return Err(AppError::new("import source must be a regular file"));
    }
    Ok(meta.len())
}

/// Parse a file, invoking `emit` for every data row. Stops early without error when
/// `emit` returns false.
fn parse_file(
    path: &Path,
    options: &ImportOptions,
    emit: RowSink<'_>,
) -> Result<ParseOutcome, AppError> {
    let size = file_size(path)?;
    let mut warnings: Vec<String> = Vec::new();
    if options.format == "xlsx" {
        if size > MAX_XLSX_FILE_BYTES {
            return Err(AppError::new(format!(
                "xlsx import exceeds the {MAX_XLSX_FILE_BYTES}-byte limit"
            )));
        }
        return parse_xlsx(path, options, &mut warnings, emit);
    }
    if size > MAX_TEXT_FILE_BYTES {
        return Err(AppError::new(format!(
            "import exceeds the {MAX_TEXT_FILE_BYTES}-byte limit"
        )));
    }
    let file = std::fs::File::open(path)
        .map_err(|e| AppError::new(format!("cannot read {}: {e}", path.display())))?;
    let reader = BufReader::with_capacity(64 * 1024, file);
    if options.format == "json" {
        parse_json(reader, options, &mut warnings, emit)
    } else {
        parse_delimited(reader, options, &mut warnings, emit)
    }
}

fn parse_delimited(
    mut reader: BufReader<std::fs::File>,
    options: &ImportOptions,
    warnings: &mut Vec<String>,
    emit: RowSink<'_>,
) -> Result<ParseOutcome, AppError> {
    let mut parser = DelimitedParser::new(options);
    let mut decoder = Decoder::new(options.encoding == "latin1");
    let mut budget = RowBudget::new();
    let mut columns: Option<Vec<String>> = None;
    let mut skipped = 0u32;
    let mut bytes_read = 0u64;
    let mut pending = String::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut row_number = 0u64;
    let mut stopped = false;
    loop {
        let read = reader.read(&mut buffer).map_err(de)?;
        let last = read == 0;
        bytes_read = bytes_read.saturating_add(read as u64);
        if last {
            decoder.finish(&mut pending)?;
        } else {
            decoder.push(&buffer[..read], &mut pending)?;
        }
        let mut rows: Vec<Vec<String>> = Vec::new();
        let consumed = parser.feed(&pending, last, &mut rows)?;
        pending.drain(..consumed);
        for raw in rows {
            if skipped < options.skip_rows {
                skipped += 1;
                continue;
            }
            // A wholly blank line is a separator, not a one-empty-field row: importing it
            // would write an all-NULL row for every trailing newline in the file.
            if raw.len() == 1 && raw[0].is_empty() {
                continue;
            }
            let raw = if columns.is_none() {
                if options.header {
                    validate_header(&raw, "delimited")?;
                    columns = Some(raw);
                    continue;
                }
                let synthetic: Vec<String> =
                    (1..=raw.len().max(1)).map(|k| format!("col{k}")).collect();
                columns_guard(synthetic.len())?;
                columns = Some(synthetic);
                raw
            } else {
                raw
            };
            let cols = columns.as_ref().expect("columns resolved above");
            row_number += 1;
            budget.count()?;
            let shaped = shape_row(raw, cols.len(), row_number, options, warnings)?;
            if !emit(cols, shaped, bytes_read) {
                stopped = true;
                break;
            }
        }
        if stopped || last {
            break;
        }
    }
    let columns = columns.unwrap_or_default();
    if columns.is_empty() {
        return Err(AppError::new("the import file contains no columns"));
    }
    Ok(ParseOutcome {
        columns,
        warnings: std::mem::take(warnings),
        sheets: Vec::new(),
    })
}

/// Detect an array document (`[`) versus newline-delimited objects.
fn json_is_array(reader: &mut BufReader<std::fs::File>) -> Result<bool, AppError> {
    loop {
        let buf = reader.fill_buf().map_err(de)?;
        if buf.is_empty() {
            return Ok(false);
        }
        let mut skip = 0usize;
        let mut answer: Option<bool> = None;
        for &b in buf {
            if b.is_ascii_whitespace() || b == 0xEF || b == 0xBB || b == 0xBF {
                skip += 1;
                continue;
            }
            answer = Some(b == b'[');
            break;
        }
        // Never consume the deciding byte: the element scanner re-reads it.
        reader.consume(skip);
        if let Some(a) = answer {
            return Ok(a);
        }
    }
}

/// Top-level fields of one JSON object, in document order, rejecting duplicate keys the
/// way the frontend clipboard JSON reader does.
fn json_object_fields(text: &str) -> Result<Vec<(String, Option<String>)>, AppError> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| AppError::new(format!("malformed JSON import: {e}")))?;
    let object = match value {
        serde_json::Value::Object(map) => map,
        _ => {
            return Err(AppError::new(
                "JSON import requires an object or an array of objects",
            ))
        }
    };
    // serde_json's map silently keeps the last duplicate, so scan the raw text for the
    // top-level key sequence instead of trusting the parsed map.
    let mut seen = std::collections::HashSet::new();
    let mut order: Vec<String> = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0usize;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    let mut string_start = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
                if depth == 1 {
                    let mut j = i + 1;
                    while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                        j += 1;
                    }
                    if bytes.get(j) == Some(&b':') {
                        let key: String = serde_json::from_str(&text[string_start..=i])
                            .map_err(|_| AppError::new("malformed JSON import"))?;
                        if !seen.insert(key.clone()) {
                            return Err(AppError::new(format!(
                                "JSON import contains duplicate object key {}",
                                serde_json::to_string(&key).unwrap_or_default()
                            )));
                        }
                        order.push(key);
                    }
                }
            }
            i += 1;
            continue;
        }
        match b {
            b'"' => {
                in_string = true;
                string_start = i;
            }
            b'{' | b'[' => depth += 1,
            b'}' | b']' => depth = depth.saturating_sub(1),
            _ => {}
        }
        i += 1;
    }
    let mut fields = Vec::with_capacity(order.len());
    for key in order {
        let value = object.get(&key).cloned().unwrap_or(serde_json::Value::Null);
        fields.push((key, json_scalar(&value)?));
    }
    Ok(fields)
}

/// Render a JSON value as import text. Objects/arrays stringify; numbers go through
/// `serde_json`, which canonicalises them (`1.50` becomes `1.5`); null is NULL.
fn json_scalar(value: &serde_json::Value) -> Result<Option<String>, AppError> {
    let rendered = match value {
        serde_json::Value::Null => return Ok(None),
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        other => serde_json::to_string(other).map_err(de)?,
    };
    field_guard(rendered.len())?;
    Ok(Some(rendered))
}

/// JSON has no header row, so the column set is *discovered* from the objects. The
/// preview discovers freely; the run path pins the preview's list (row values must land
/// on the mapped indices) but KEEPS discovering, so a changed file and a key that only
/// appears past the sampled window are both caught instead of silently dropped.
struct JsonState {
    /// Every key seen so far, in first-seen order.
    discovered: Vec<String>,
    /// The preview's column list on the run path; `None` while previewing.
    pinned: Option<Vec<String>>,
    /// Keys reported as unimportable, so one warning is emitted per key.
    warned: std::collections::HashSet<String>,
    row_number: u64,
    budget: RowBudget,
}

impl JsonState {
    fn new(options: &ImportOptions) -> Self {
        Self {
            discovered: Vec::new(),
            pinned: if options.source_columns.is_empty() {
                None
            } else {
                Some(options.source_columns.clone())
            },
            warned: std::collections::HashSet::new(),
            row_number: 0,
            budget: RowBudget::new(),
        }
    }

    /// The column list rows are projected onto.
    fn columns(&self) -> &[String] {
        match &self.pinned {
            Some(pinned) => pinned,
            None => &self.discovered,
        }
    }
}

/// Turn buffered JSON elements into rows. Returns false when the consumer stopped.
fn drain_json(
    elements: &mut Vec<String>,
    state: &mut JsonState,
    options: &ImportOptions,
    bytes_read: u64,
    warnings: &mut Vec<String>,
    emit: RowSink<'_>,
) -> Result<bool, AppError> {
    for element in elements.drain(..) {
        let trimmed = element.trim();
        if trimmed.is_empty() {
            continue;
        }
        let fields = json_object_fields(trimmed)?;
        let first = state.discovered.is_empty();
        for (key, _) in &fields {
            if !state.discovered.iter().any(|c| c == key) {
                if key.len() > MAX_COLUMN_NAME_BYTES {
                    return Err(AppError::new(format!(
                        "JSON import contains an object key longer than {MAX_COLUMN_NAME_BYTES} bytes"
                    )));
                }
                state.discovered.push(key.clone());
                columns_guard(state.discovered.len())?;
            }
        }
        if let Some(pinned) = &state.pinned {
            // A file swapped between preview and run has no key in common with what the
            // mapping was built from; every row would otherwise import as all-NULL.
            if first && !fields.iter().any(|(k, _)| pinned.iter().any(|p| p == k)) {
                return Err(AppError::new(
                    "the file's columns changed since the preview. Reopen the import dialog.",
                ));
            }
            for (key, _) in &fields {
                if !pinned.iter().any(|p| p == key)
                    && state.warned.insert(key.clone())
                    && warnings.len() < MAX_WARNINGS
                {
                    warnings.push(format!(
                        "key {key} appears after the previewed sample and is not imported. Reopen the import dialog to map it."
                    ));
                }
            }
        }
        state.row_number += 1;
        state.budget.count()?;
        let columns = state.columns();
        let row = columns
            .iter()
            .map(|c| {
                fields
                    .iter()
                    .find(|(k, _)| k == c)
                    .and_then(|(_, v)| v.clone())
                    .and_then(|v| options.null_of(v))
            })
            .collect::<Vec<_>>();
        if !emit(columns, row, bytes_read) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn parse_json(
    mut reader: BufReader<std::fs::File>,
    options: &ImportOptions,
    warnings: &mut Vec<String>,
    emit: RowSink<'_>,
) -> Result<ParseOutcome, AppError> {
    let array = json_is_array(&mut reader)?;
    let mut state = JsonState::new(options);
    let mut bytes_read = 0u64;
    let mut elements: Vec<String> = Vec::new();

    if array {
        let mut buffer = [0u8; 64 * 1024];
        let mut current = String::new();
        let mut depth = 0i64;
        let mut in_string = false;
        let mut escaped = false;
        let mut started = false;
        let mut finished = false;
        let mut stopped = false;
        let mut decoder = Decoder::new(false);
        let mut pending = String::new();
        loop {
            let read = reader.read(&mut buffer).map_err(de)?;
            bytes_read = bytes_read.saturating_add(read as u64);
            if read == 0 {
                decoder.finish(&mut pending)?;
            } else {
                decoder.push(&buffer[..read], &mut pending)?;
            }
            for ch in pending.chars() {
                if finished {
                    if !ch.is_whitespace() {
                        return Err(AppError::new("malformed JSON import"));
                    }
                    continue;
                }
                if !started {
                    if ch.is_whitespace() {
                        continue;
                    }
                    if ch != '[' {
                        return Err(AppError::new("malformed JSON import"));
                    }
                    started = true;
                    continue;
                }
                if in_string {
                    current.push(ch);
                    if escaped {
                        escaped = false;
                    } else if ch == '\\' {
                        escaped = true;
                    } else if ch == '"' {
                        in_string = false;
                    }
                } else {
                    match ch {
                        '"' => {
                            in_string = true;
                            current.push(ch);
                        }
                        '{' | '[' => {
                            depth += 1;
                            current.push(ch);
                        }
                        '}' | ']' if depth > 0 => {
                            depth -= 1;
                            current.push(ch);
                        }
                        ']' => {
                            if !current.trim().is_empty() {
                                elements.push(std::mem::take(&mut current));
                            }
                            current.clear();
                            finished = true;
                        }
                        ',' if depth == 0 => elements.push(std::mem::take(&mut current)),
                        _ => current.push(ch),
                    }
                }
                if current.len() > MAX_JSON_ELEMENT_BYTES {
                    return Err(AppError::new(
                        "a JSON import element exceeds the 16 MiB limit",
                    ));
                }
            }
            pending.clear();
            if (elements.len() >= 256 || read == 0)
                && !drain_json(
                    &mut elements,
                    &mut state,
                    options,
                    bytes_read,
                    warnings,
                    emit,
                )?
            {
                stopped = true;
            }
            if stopped || read == 0 {
                break;
            }
        }
        if !stopped && !finished {
            return Err(AppError::new("malformed JSON import"));
        }
    } else {
        let mut raw = Vec::new();
        loop {
            raw.clear();
            // BOUND BEFORE ALLOCATING: an unbounded `read_until` would materialize a
            // newline-free multi-gigabyte file in full before the cap could fire.
            let read = (&mut reader)
                .take(MAX_JSON_ELEMENT_BYTES as u64 + 1)
                .read_until(b'\n', &mut raw)
                .map_err(de)?;
            if read == 0 {
                break;
            }
            bytes_read = bytes_read.saturating_add(read as u64);
            if raw.len() > MAX_JSON_ELEMENT_BYTES {
                return Err(AppError::new(
                    "a JSON import element exceeds the 16 MiB limit",
                ));
            }
            let body: &[u8] = if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
                &raw[3..]
            } else {
                &raw
            };
            let line = std::str::from_utf8(body)
                .map_err(|_| AppError::new("import file is not valid UTF-8"))?;
            if line.trim().is_empty() {
                continue;
            }
            elements.push(line.trim().to_string());
            if !drain_json(
                &mut elements,
                &mut state,
                options,
                bytes_read,
                warnings,
                emit,
            )? {
                break;
            }
        }
    }
    if state.columns().is_empty() {
        return Err(AppError::new("the import file contains no columns"));
    }
    Ok(ParseOutcome {
        columns: state.columns().to_vec(),
        warnings: std::mem::take(warnings),
        sheets: Vec::new(),
    })
}

fn parse_xlsx(
    path: &Path,
    options: &ImportOptions,
    warnings: &mut Vec<String>,
    emit: RowSink<'_>,
) -> Result<ParseOutcome, AppError> {
    use calamine::{Data, Reader};
    let mut workbook = calamine::open_workbook_auto(path)
        .map_err(|e| AppError::new(format!("cannot read the workbook: {e}")))?;
    let sheets = workbook.sheet_names().to_vec();
    let name = if options.sheet.is_empty() {
        sheets
            .first()
            .cloned()
            .ok_or_else(|| AppError::new("the workbook contains no sheets"))?
    } else {
        if !sheets.iter().any(|s| s == &options.sheet) {
            return Err(AppError::new(format!(
                "the workbook has no sheet named {}",
                options.sheet
            )));
        }
        options.sheet.clone()
    };
    // Check the declared sheet dimensions BEFORE `worksheet_range` materializes every
    // cell. calamine only exposes a header-only cell reader for the `.xlsx` shape, so
    // `.xls`/`.xlsb`/`.ods` still expand first (recorded as a residual risk in
    // docs/adversarial-hardening.md).
    if let calamine::Sheets::Xlsx(xl) = &mut workbook {
        if let Ok(reader) = xl.worksheet_cells_reader(&name) {
            let d = reader.dimensions();
            let w = d.end.1.saturating_sub(d.start.1).saturating_add(1) as usize;
            let h = d.end.0.saturating_sub(d.start.0).saturating_add(1) as usize;
            columns_guard(w)?;
            if w.saturating_mul(h) > MAX_XLSX_CELLS {
                return Err(AppError::new(format!(
                    "the sheet exceeds the {MAX_XLSX_CELLS}-cell import limit"
                )));
            }
        }
    }
    let range = workbook
        .worksheet_range(&name)
        .map_err(|e| AppError::new(format!("cannot read sheet {name}: {e}")))?;
    let width = range.width();
    let height = range.height();
    columns_guard(width)?;
    if width.saturating_mul(height) > MAX_XLSX_CELLS {
        return Err(AppError::new(format!(
            "the sheet exceeds the {MAX_XLSX_CELLS}-cell import limit"
        )));
    }
    // xlsx is read whole rather than streamed, so there are no bytes-consumed
    // milestones; report progress as the row fraction of the file's size instead.
    let total_bytes = file_size(path)?;
    let data_rows = height.saturating_sub(options.skip_rows as usize + usize::from(options.header));
    let cell_text = |d: &Data| -> Result<String, AppError> {
        Ok(match d {
            Data::Empty => String::new(),
            Data::String(s) => s.clone(),
            Data::Bool(b) => b.to_string(),
            Data::Int(i) => i.to_string(),
            Data::Float(f) => {
                if f.fract() == 0.0 && f.abs() < 1e15 {
                    format!("{}", *f as i64)
                } else {
                    format!("{f}")
                }
            }
            Data::DateTime(dt) => match dt.as_datetime() {
                Some(value) => value.format("%Y-%m-%d %H:%M:%S").to_string(),
                None => dt.as_f64().to_string(),
            },
            Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
            Data::Error(e) => {
                return Err(AppError::new(format!(
                    "the sheet contains a cell error: {e}"
                )))
            }
        })
    };
    let mut rows = range.rows();
    let mut budget = RowBudget::new();
    let mut skipped = 0u32;
    while skipped < options.skip_rows {
        if rows.next().is_none() {
            break;
        }
        skipped += 1;
    }
    let columns: Vec<String> = if options.header {
        let head = rows
            .next()
            .ok_or_else(|| AppError::new("the sheet contains no header row"))?;
        let mut names: Vec<String> = head
            .iter()
            .map(cell_text)
            .collect::<Result<Vec<_>, AppError>>()?;
        // A range's width is the sheet's, not the header's: one once-touched cell far to
        // the right pads the header with blanks. Drop those the way the data rows do,
        // instead of rejecting the whole sheet for an "empty column name".
        while names.len() > 1 && names.last().is_some_and(|n| n.is_empty()) {
            names.pop();
        }
        validate_header(&names, "sheet")?;
        names
    } else {
        (1..=width.max(1)).map(|k| format!("col{k}")).collect()
    };
    let mut row_number = 0u64;
    for raw in rows {
        row_number += 1;
        budget.count()?;
        let mut values: Vec<String> = Vec::with_capacity(raw.len());
        for cell in raw {
            let text = cell_text(cell)?;
            field_guard(text.len())?;
            values.push(text);
        }
        // Trailing blanks in a sheet are indistinguishable from missing cells; drop them
        // rather than rejecting the row as too wide.
        while values.len() > columns.len() && values.last().is_some_and(|v| v.is_empty()) {
            values.pop();
        }
        let shaped = shape_row(values, columns.len(), row_number, options, warnings)?;
        let progressed = if data_rows == 0 {
            total_bytes
        } else {
            total_bytes.saturating_mul(row_number.min(data_rows as u64)) / data_rows as u64
        };
        if !emit(&columns, shaped, progressed) {
            break;
        }
    }
    Ok(ParseOutcome {
        columns,
        warnings: std::mem::take(warnings),
        sheets,
    })
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/// Elide one previewed cell. The preview is a display/inference sample, never the data
/// the loader sees, so a truncated value cannot reach the database.
fn preview_cell(value: String) -> String {
    if value.chars().count() <= MAX_PREVIEW_CELL_CHARS {
        return value;
    }
    let mut out: String = value.chars().take(MAX_PREVIEW_CELL_CHARS).collect();
    out.push('…');
    out
}

pub fn preview_file(path: &Path, options: &ImportOptions) -> Result<ImportPreview, AppError> {
    options.validate()?;
    let file_bytes = file_size(path)?;
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut seen = 0u64;
    // The preview is the one IPC payload built from a file the user chose, so it carries
    // its own aggregate budget: sampling stops early rather than shipping 50 rows of
    // 10,000 megabyte-sized cells to the WebView.
    let mut budget = 0usize;
    let mut capped = false;
    // Read one row past the sample so `truncated` is accurate.
    let outcome = parse_file(path, options, &mut |_columns, row, _| {
        seen += 1;
        if rows.len() < PREVIEW_ROWS && !capped {
            let trimmed: Vec<Option<String>> =
                row.into_iter().map(|v| v.map(preview_cell)).collect();
            budget += trimmed
                .iter()
                .map(|v| v.as_ref().map_or(4, |s| s.len()))
                .sum::<usize>();
            rows.push(trimmed);
            if budget > MAX_PREVIEW_BYTES {
                capped = true;
            }
        }
        seen <= PREVIEW_ROWS as u64 && !capped
    })?;
    let mut warnings = outcome.warnings;
    if capped && warnings.len() < MAX_WARNINGS {
        warnings.push(format!(
            "the sampled rows exceed the {MAX_PREVIEW_BYTES}-byte preview budget. Fewer rows are shown."
        ));
    }
    Ok(ImportPreview {
        columns: outcome.columns,
        rows,
        warnings,
        sheets: outcome.sheets,
        truncated: capped || seen > PREVIEW_ROWS as u64,
        file_bytes,
    })
}

// ---------------------------------------------------------------------------
// Load plan
// ---------------------------------------------------------------------------

struct PlanColumn {
    target: String,
    kind: ColumnType,
    empty_as_null: bool,
    source: usize,
}

struct Plan {
    dialect: Dialect,
    qualified: String,
    columns: Vec<PlanColumn>,
    conflict: String,
    key_columns: Vec<String>,
    create: bool,
    truncate: bool,
}

impl Plan {
    fn build(
        target: &ImportTarget,
        dialect: Dialect,
        source_width: usize,
    ) -> Result<Self, AppError> {
        if target.table.trim().is_empty() {
            return Err(AppError::new("choose a target table"));
        }
        if target.table.len() > MAX_IDENT_BYTES
            || target.schema.len() > MAX_IDENT_BYTES
            || target.table.contains('\0')
            || target.schema.contains('\0')
        {
            return Err(AppError::new("target table name is invalid or too long"));
        }
        if target.columns.is_empty() {
            return Err(AppError::new("map at least one column"));
        }
        columns_guard(target.columns.len())?;
        if !matches!(target.conflict.as_str(), "error" | "ignore" | "update") {
            return Err(AppError::new("unknown import conflict mode"));
        }
        let mut seen = std::collections::HashSet::new();
        let mut columns = Vec::with_capacity(target.columns.len());
        for column in &target.columns {
            if column.target.trim().is_empty()
                || column.target.len() > MAX_IDENT_BYTES
                || column.target.contains('\0')
            {
                return Err(AppError::new("a target column name is invalid or too long"));
            }
            if !seen.insert(column.target.to_lowercase()) {
                return Err(AppError::new(format!(
                    "target column {} is mapped twice",
                    column.target
                )));
            }
            if column.source >= source_width {
                return Err(AppError::new(format!(
                    "column {} maps to source column {} which the file does not have",
                    column.target,
                    column.source + 1
                )));
            }
            columns.push(PlanColumn {
                target: column.target.clone(),
                kind: ColumnType::parse(&column.kind)?,
                empty_as_null: column.empty_as_null,
                source: column.source,
            });
        }
        if target.key_columns.len() > MAX_IMPORT_COLUMNS
            || target
                .key_columns
                .iter()
                .any(|k| k.len() > MAX_COLUMN_NAME_BYTES)
        {
            return Err(AppError::new(
                "import conflict key list is invalid or too long",
            ));
        }
        if target.conflict == "update" {
            if dialect == Dialect::Postgres && target.key_columns.is_empty() {
                return Err(AppError::new(
                    "PostgreSQL upsert needs at least one conflict key column",
                ));
            }
            for key in &target.key_columns {
                if !columns.iter().any(|c| &c.target == key) {
                    return Err(AppError::new(format!(
                        "conflict key column {key} is not among the mapped columns"
                    )));
                }
            }
        }
        Ok(Self {
            dialect,
            qualified: dialect.qualify(&target.schema, &target.table),
            columns,
            conflict: target.conflict.clone(),
            key_columns: target.key_columns.clone(),
            create: target.create,
            truncate: target.truncate,
        })
    }

    fn create_sql(&self) -> String {
        let cols = self
            .columns
            .iter()
            .map(|c| {
                format!(
                    "{} {}",
                    self.dialect.ident(&c.target),
                    c.kind.sql(self.dialect)
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!("CREATE TABLE {} ({cols})", self.qualified)
    }

    fn clear_sql(&self) -> String {
        match self.dialect {
            // SQLite has no TRUNCATE, and MySQL's TRUNCATE implicitly COMMITs — which
            // would break the "one transaction" guarantee. DELETE keeps both atomic.
            Dialect::Sqlite | Dialect::MySql => format!("DELETE FROM {}", self.qualified),
            _ => format!("TRUNCATE TABLE {}", self.qualified),
        }
    }

    fn column_list(&self) -> String {
        self.columns
            .iter()
            .map(|c| self.dialect.ident(&c.target))
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// `INSERT INTO t (cols) VALUES ` with the engine's conflict prefix applied.
    fn insert_head(&self) -> String {
        let verb = match (self.dialect, self.conflict.as_str()) {
            (Dialect::MySql, "ignore") => "INSERT IGNORE INTO",
            (Dialect::Sqlite | Dialect::DuckDb, "ignore") => "INSERT OR IGNORE INTO",
            (Dialect::Sqlite | Dialect::DuckDb, "update") => "INSERT OR REPLACE INTO",
            _ => "INSERT INTO",
        };
        format!("{verb} {} ({}) VALUES ", self.qualified, self.column_list())
    }

    /// The engine-specific suffix implementing the conflict mode.
    fn insert_tail(&self) -> String {
        match (self.dialect, self.conflict.as_str()) {
            (Dialect::Postgres, "ignore") => " ON CONFLICT DO NOTHING".to_string(),
            (Dialect::Postgres, "update") => {
                let keys = self
                    .key_columns
                    .iter()
                    .map(|k| self.dialect.ident(k))
                    .collect::<Vec<_>>()
                    .join(", ");
                let sets = self
                    .columns
                    .iter()
                    .filter(|c| !self.key_columns.iter().any(|k| k == &c.target))
                    .map(|c| {
                        let quoted = self.dialect.ident(&c.target);
                        format!("{quoted} = EXCLUDED.{quoted}")
                    })
                    .collect::<Vec<_>>();
                if sets.is_empty() {
                    format!(" ON CONFLICT ({keys}) DO NOTHING")
                } else {
                    format!(" ON CONFLICT ({keys}) DO UPDATE SET {}", sets.join(", "))
                }
            }
            (Dialect::MySql, "update") => {
                let sets = self
                    .columns
                    .iter()
                    .map(|c| {
                        let quoted = self.dialect.ident(&c.target);
                        format!("{quoted} = VALUES({quoted})")
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(" ON DUPLICATE KEY UPDATE {sets}")
            }
            _ => String::new(),
        }
    }

    /// `COPY <table> (cols) FROM STDIN` — the PostgreSQL fast path for a plain insert.
    fn copy_sql(&self) -> String {
        format!(
            "COPY {} ({}) FROM STDIN",
            self.qualified,
            self.column_list()
        )
    }

    /// COPY carries no conflict clause, so only a plain insert can take that path.
    fn use_copy(&self) -> bool {
        self.dialect == Dialect::Postgres && self.conflict == "error"
    }

    /// The value a source row contributes to one mapped column, with `empty → NULL`
    /// applied. A whitespace-only cell counts as empty: the preview's type inference
    /// skips blanks, so treating `" "` as data made a sampled `integer` column reject
    /// mid-load.
    fn cell<'r>(&self, column: &PlanColumn, row: &'r [Option<String>]) -> Option<&'r str> {
        match row.get(column.source).and_then(|v| v.as_deref()) {
            Some(v) if column.empty_as_null && v.trim().is_empty() => None,
            other => other,
        }
    }

    /// Project one source row onto the mapped columns and render its value tuple.
    fn tuple(&self, row: &[Option<String>], row_number: u64) -> Result<String, AppError> {
        let mut parts = Vec::with_capacity(self.columns.len());
        for column in &self.columns {
            let raw = self.cell(column, row);
            parts.push(self.literal(column, raw, row_number)?);
        }
        Ok(format!("({})", parts.join(", ")))
    }

    /// Append one PostgreSQL text-format COPY line for `row`. Values are validated by
    /// exactly the same rules as `literal`, so the COPY and INSERT paths accept and
    /// reject the same files with the same messages.
    fn copy_line(
        &self,
        row: &[Option<String>],
        row_number: u64,
        out: &mut String,
    ) -> Result<(), AppError> {
        for (k, column) in self.columns.iter().enumerate() {
            if k > 0 {
                out.push('\t');
            }
            let Some(value) = self.cell(column, row) else {
                out.push_str("\\N");
                continue;
            };
            let coerced = self.coerce(column, value, row_number)?;
            let text = match coerced {
                Coerced::Verbatim(v) => v,
                Coerced::Text(v) => v,
            };
            if text.contains('\0') {
                return Err(AppError::new(
                    "PostgreSQL cannot store a text value containing a zero byte",
                ));
            }
            for ch in text.chars() {
                match ch {
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    other => out.push(other),
                }
            }
        }
        out.push('\n');
        Ok(())
    }

    /// Validate + normalize one value by its declared token. `Verbatim` values are safe
    /// as unquoted SQL (numbers, boolean keywords); `Text` values must be quoted.
    fn coerce(
        &self,
        column: &PlanColumn,
        value: &str,
        row_number: u64,
    ) -> Result<Coerced, AppError> {
        let reject = |expected: &str| {
            AppError::new(format!(
                "row {row_number}, column {}: {} is not a valid {expected}",
                column.target,
                truncate_for_error(value)
            ))
        };
        Ok(match column.kind {
            ColumnType::Text => Coerced::Text(value.to_string()),
            ColumnType::Date => {
                let trimmed = value.trim();
                if !valid_date(trimmed) {
                    return Err(reject("date (YYYY-MM-DD)"));
                }
                Coerced::Text(trimmed.to_string())
            }
            ColumnType::Timestamp => {
                let trimmed = value.trim();
                match normalize_timestamp(trimmed, self.dialect) {
                    Ok(normalized) => Coerced::Text(normalized),
                    Err(why) => {
                        return Err(AppError::new(format!(
                            "row {row_number}, column {}: {} {why}",
                            column.target,
                            truncate_for_error(value)
                        )))
                    }
                }
            }
            ColumnType::Integer | ColumnType::BigInt => {
                let trimmed = value.trim();
                if !is_integer_text(trimmed) {
                    return Err(reject("integer"));
                }
                if trimmed.parse::<i64>().is_err() {
                    return Err(reject("64-bit integer"));
                }
                Coerced::Verbatim(trimmed.trim_start_matches('+').to_string())
            }
            ColumnType::Numeric => {
                let trimmed = value.trim();
                if !is_numeric_text(trimmed) {
                    return Err(reject("number"));
                }
                Coerced::Verbatim(trimmed.trim_start_matches('+').to_string())
            }
            ColumnType::Boolean => {
                let Some(flag) = bool_text(value) else {
                    return Err(reject("boolean"));
                };
                Coerced::Verbatim(
                    match self.dialect {
                        Dialect::Sqlite | Dialect::MySql => {
                            if flag {
                                "1"
                            } else {
                                "0"
                            }
                        }
                        _ => {
                            if flag {
                                "TRUE"
                            } else {
                                "FALSE"
                            }
                        }
                    }
                    .to_string(),
                )
            }
        })
    }

    fn literal(
        &self,
        column: &PlanColumn,
        raw: Option<&str>,
        row_number: u64,
    ) -> Result<String, AppError> {
        let Some(value) = raw else {
            return Ok("NULL".to_string());
        };
        Ok(match self.coerce(column, value, row_number)? {
            Coerced::Verbatim(v) => v,
            Coerced::Text(v) => self.dialect.string_literal(&v)?,
        })
    }
}

enum Coerced {
    /// Safe to emit unquoted (validated digits / boolean keyword).
    Verbatim(String),
    /// Must be rendered as a string literal by the dialect.
    Text(String),
}

/// A `YYYY-MM-DD` value that is also a real calendar date. `2024-02-30` matches the
/// shape the preview infers from but no engine accepts it, so it must fail here with a
/// row number rather than half-way through the load.
fn valid_date(v: &str) -> bool {
    chrono::NaiveDate::parse_from_str(v, "%Y-%m-%d").is_ok()
}

/// Validate `YYYY-MM-DD` or `YYYY-MM-DD[ T]HH:MM[:SS[.fff]][Z|±HH[:]MM]` and normalize it
/// for the target engine. MySQL's `DATETIME` has no zone: a trailing `Z` is dropped (the
/// value is already UTC-naive) and a numeric offset is refused rather than mis-stored.
fn normalize_timestamp(v: &str, dialect: Dialect) -> Result<String, &'static str> {
    const SHAPE: &str = "is not a valid timestamp (YYYY-MM-DD[ HH:MM[:SS]])";
    if v.len() < 10 || !v.is_char_boundary(10) {
        return Err(SHAPE);
    }
    let (date, rest) = v.split_at(10);
    if !valid_date(date) {
        return Err(SHAPE);
    }
    if rest.is_empty() {
        return Ok(v.to_string()); // a bare date is a valid timestamp everywhere
    }
    let Some(rest) = rest.strip_prefix(['T', 't', ' ']) else {
        return Err(SHAPE);
    };
    // Split the time from an optional zone designator.
    let (time, zone) = match rest.find(['Z', 'z', '+']) {
        Some(i) => rest.split_at(i),
        None => match rest.rfind('-') {
            Some(i) => rest.split_at(i),
            None => (rest, ""),
        },
    };
    if chrono::NaiveTime::parse_from_str(time, "%H:%M:%S%.f").is_err()
        && chrono::NaiveTime::parse_from_str(time, "%H:%M").is_err()
    {
        return Err(SHAPE);
    }
    let numeric_offset = match zone {
        "" | "Z" | "z" => false,
        other => {
            let Some(body) = other.strip_prefix(['+', '-']) else {
                return Err(SHAPE);
            };
            let digits: String = body.chars().filter(|c| *c != ':').collect();
            if digits.len() != 4 || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return Err(SHAPE);
            }
            true
        }
    };
    match (dialect, numeric_offset) {
        (Dialect::MySql, true) => Err(
            "carries a time-zone offset that MySQL DATETIME cannot store. Convert it to UTC first.",
        ),
        (Dialect::MySql, false) => Ok(format!("{date} {time}")),
        _ => Ok(v.to_string()),
    }
}

fn truncate_for_error(value: &str) -> String {
    let shown: String = value.chars().take(60).collect();
    if shown.len() < value.len() {
        format!("{shown:?}…")
    } else {
        format!("{shown:?}")
    }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// One import's physical session. Import owns its own transaction, so it deliberately
/// bypasses the app's script wrapper; `require_idle` guarantees nothing else owns the
/// connection while it runs.
enum Session<'a> {
    Pg(&'a tokio_postgres::Client),
    Duck(&'a crate::driver::DuckConn),
    Sqlite(&'a crate::driver::SqliteConn),
    MySql(Box<mysql_async::Conn>),
}

impl Session<'_> {
    async fn begin(&mut self) -> Result<(), AppError> {
        let sql = match self {
            Session::MySql(_) => "START TRANSACTION",
            _ => "BEGIN",
        };
        self.batch(sql).await
    }

    async fn commit(&mut self) -> Result<(), AppError> {
        self.batch("COMMIT").await.map_err(|e| {
            AppError::new(format!(
                "import commit acknowledgement failed and the outcome is unknown. Verify database state before retrying ({}).",
                e.message
            ))
        })
    }

    async fn rollback(&mut self) -> Result<(), AppError> {
        self.batch("ROLLBACK").await
    }

    /// Control / DDL statements: no row count needed, and DuckDB prefers `execute_batch`.
    async fn batch(&mut self, sql: &str) -> Result<(), AppError> {
        match self {
            Session::Pg(client) => client.batch_execute(sql).await.map_err(Into::into),
            Session::Duck(duck) => {
                duck.parse_check(sql)?;
                let result = duck.lock().execute_batch(sql).map_err(de);
                result.map_err(|e| duck.quarantine_if_poisoned(e))
            }
            Session::Sqlite(sqlite) => sqlite.lock().execute_batch(sql).map_err(de),
            Session::MySql(conn) => {
                use mysql_async::prelude::Queryable;
                conn.query_drop(sql).await.map_err(de)
            }
        }
    }

    /// One INSERT batch; returns the affected-row count the driver reports.
    async fn insert(&mut self, sql: &str) -> Result<u64, AppError> {
        match self {
            Session::Pg(client) => {
                let messages = client.simple_query(sql).await?;
                Ok(messages
                    .iter()
                    .filter_map(|m| match m {
                        tokio_postgres::SimpleQueryMessage::CommandComplete(n) => Some(*n),
                        _ => None,
                    })
                    .sum())
            }
            Session::Duck(duck) => {
                // duckdb-rs #209: an ungated parser error poisons the connection and
                // dropping it aborts the process — composed SQL goes through the gate too.
                duck.parse_check(sql)?;
                let result = duck.lock().execute(sql, []).map_err(de);
                result
                    .map(|n| n as u64)
                    .map_err(|e| duck.quarantine_if_poisoned(e))
            }
            Session::Sqlite(sqlite) => sqlite.lock().execute(sql, []).map(|n| n as u64).map_err(de),
            Session::MySql(conn) => {
                use mysql_async::prelude::Queryable;
                conn.query_drop(sql).await.map_err(de)?;
                Ok(conn.affected_rows())
            }
        }
    }
}

/// Everything the loader needs once the connection lock has been taken.
pub struct ImportRequest {
    pub path: String,
    pub options: ImportOptions,
    pub target: ImportTarget,
}

/// One parsed batch handed from the blocking parser to the async loader. The final chunk
/// also carries the parser's accumulated warnings, which end up in the run summary.
struct Chunk {
    rows: Vec<Vec<Option<String>>>,
    bytes_read: u64,
    warnings: Vec<String>,
}

/// Load `request` into `backend`. The caller owns `require_idle`, read-only refusal,
/// cursor rollback and cancel arming.
pub async fn run_import(
    backend: &mut Backend,
    request: &ImportRequest,
    cancel: &Arc<AtomicBool>,
    progress: impl Fn(ImportProgressUpdate),
) -> Result<ImportSummary, AppError> {
    request.options.validate()?;
    if request.options.source_columns.is_empty() {
        return Err(AppError::new(
            "import needs the column list from the preview step",
        ));
    }
    let dialect = Dialect::parse(backend.capabilities().kind)?;
    let plan = Plan::build(
        &request.target,
        dialect,
        request.options.source_columns.len(),
    )?;
    let path = std::path::PathBuf::from(&request.path);
    let total_bytes = file_size(&path)?;

    // Parse on a blocking thread and pull bounded batches, so neither side buffers the
    // file. Dropping the receiver stops the parser (cancel or loader error).
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<Chunk, AppError>>(2);
    let parse_options = request.options.clone();
    let parse_path = path.clone();
    let parse_cancel = Arc::clone(cancel);
    let parser = tokio::task::spawn_blocking(move || {
        let mut batch: Vec<Vec<Option<String>>> = Vec::with_capacity(BATCH_ROWS);
        let mut checked = false;
        let mut mismatch = false;
        let outcome = parse_file(&parse_path, &parse_options, &mut |columns, row, bytes| {
            if !checked {
                checked = true;
                if columns != parse_options.source_columns.as_slice() {
                    mismatch = true;
                    return false;
                }
            }
            batch.push(row);
            if batch.len() >= BATCH_ROWS {
                let chunk = Chunk {
                    rows: std::mem::take(&mut batch),
                    bytes_read: bytes,
                    warnings: Vec::new(),
                };
                if tx.blocking_send(Ok(chunk)).is_err() {
                    return false;
                }
            }
            !parse_cancel.load(Ordering::Acquire)
        });
        let changed = AppError::new(
            "the file's columns changed since the preview. Reopen the import dialog.",
        );
        match outcome {
            Err(error) => {
                let _ = tx.blocking_send(Err(error));
            }
            Ok(_) if mismatch => {
                let _ = tx.blocking_send(Err(changed));
            }
            Ok(outcome) if !checked && outcome.columns != parse_options.source_columns => {
                let _ = tx.blocking_send(Err(changed));
            }
            Ok(outcome) => {
                // Always send the tail chunk: it carries the parser's warnings (short
                // rows, late JSON keys), which the run summary reports.
                let _ = tx.blocking_send(Ok(Chunk {
                    rows: batch,
                    bytes_read: total_bytes,
                    warnings: outcome.warnings,
                }));
            }
        }
    });

    let mut session = match backend {
        Backend::Pg(pg) => Session::Pg(&pg.client),
        Backend::Duck(duck) => Session::Duck(duck),
        Backend::Sqlite(sqlite) => Session::Sqlite(sqlite),
        Backend::MySql(mysql) => Session::MySql(Box::new(mysql.pool.get_conn().await.map_err(de)?)),
        Backend::MsSql(_) => {
            return Err(AppError::new(
                "file import isn't available on SQL Server yet. Use the SQL editor or a bulk-load tool.",
            ))
        }
    };

    let mut summary = ImportSummary {
        rows_read: 0,
        rows_inserted: 0,
        rows_skipped: 0,
        warnings: Vec::new(),
        created_outside_transaction: false,
    };
    let result = load(
        &mut session,
        &plan,
        &mut rx,
        cancel,
        total_bytes,
        &progress,
        &mut summary,
    )
    .await;
    rx.close();
    while rx.recv().await.is_some() {} // let the parser finish its pending send
    match result {
        Ok(()) => {
            session.commit().await?;
            let _ = parser.await;
            summary.rows_skipped = summary.rows_read.saturating_sub(summary.rows_inserted);
            progress(ImportProgressUpdate {
                rows_read: summary.rows_read,
                rows_inserted: summary.rows_inserted,
                bytes_read: total_bytes,
                total_bytes,
                done: true,
                force: true,
            });
            Ok(summary)
        }
        Err(mut error) => {
            // A ROLLBACK that itself fails leaves an open transaction the app does not
            // track — say so instead of swallowing it.
            if let Err(rollback) = session.rollback().await {
                error.message = format!(
                    "{}\n(rollback also failed: {}. Verify database state before retrying.)",
                    error.message, rollback.message
                );
            }
            if summary.created_outside_transaction {
                error.message = format!(
                    "{}\n(the new table {} was created outside the transaction and still exists. Drop it before retrying.)",
                    error.message, plan.qualified
                );
            }
            let _ = parser.await;
            Err(error)
        }
    }
}

async fn load(
    session: &mut Session<'_>,
    plan: &Plan,
    rx: &mut tokio::sync::mpsc::Receiver<Result<Chunk, AppError>>,
    cancel: &Arc<AtomicBool>,
    total_bytes: u64,
    progress: &impl Fn(ImportProgressUpdate),
    summary: &mut ImportSummary,
) -> Result<(), AppError> {
    // MySQL's CREATE TABLE implicitly COMMITs *and ends* the transaction, leaving the
    // pooled connection back at autocommit=1 — every later INSERT would then commit
    // itself and ROLLBACK would be a no-op. Create before the transaction opens instead,
    // and report it as a separately committed step.
    let mysql = matches!(session, Session::MySql(_));
    if plan.create && mysql {
        session.batch(&plan.create_sql()).await?;
        summary.created_outside_transaction = true;
    }
    session.begin().await?;
    if plan.create && !mysql {
        session.batch(&plan.create_sql()).await?;
    }
    if plan.truncate {
        session.batch(&plan.clear_sql()).await?;
    }
    if plan.use_copy() {
        return copy_load(session, plan, rx, cancel, total_bytes, progress, summary).await;
    }
    // MySQL reports 2 affected rows for every row an upsert UPDATES, so its own count
    // cannot say how many rows were written; each tuple is written by definition.
    let count_tuples = plan.dialect == Dialect::MySql && plan.conflict == "update";
    let head = plan.insert_head();
    let tail = plan.insert_tail();
    while let Some(chunk) = rx.recv().await {
        if cancel.load(Ordering::Acquire) {
            return Err(AppError::new("import cancelled and rolled back"));
        }
        let chunk = chunk?;
        take_warnings(summary, chunk.warnings);
        let mut tuples: Vec<String> = Vec::new();
        let mut tuple_bytes = 0usize;
        for row in &chunk.rows {
            summary.rows_read += 1;
            let tuple = plan.tuple(row, summary.rows_read)?;
            if !tuples.is_empty() && tuple_bytes.saturating_add(tuple.len()) > BATCH_BYTES {
                summary.rows_inserted +=
                    flush(session, &head, &tail, &mut tuples, count_tuples).await?;
                tuple_bytes = 0;
            }
            tuple_bytes = tuple_bytes.saturating_add(tuple.len());
            tuples.push(tuple);
        }
        summary.rows_inserted += flush(session, &head, &tail, &mut tuples, count_tuples).await?;
        progress(ImportProgressUpdate {
            rows_read: summary.rows_read,
            rows_inserted: summary.rows_inserted,
            bytes_read: chunk.bytes_read,
            total_bytes,
            done: false,
            force: false,
        });
    }
    if cancel.load(Ordering::Acquire) {
        return Err(AppError::new("import cancelled and rolled back"));
    }
    Ok(())
}

/// The PostgreSQL plain-insert path: one `COPY … FROM STDIN` for the whole load, inside
/// the import transaction. COPY has no `ON CONFLICT`, so `ignore`/`update` keep the
/// batched multi-row `INSERT`.
async fn copy_load(
    session: &mut Session<'_>,
    plan: &Plan,
    rx: &mut tokio::sync::mpsc::Receiver<Result<Chunk, AppError>>,
    cancel: &Arc<AtomicBool>,
    total_bytes: u64,
    progress: &impl Fn(ImportProgressUpdate),
    summary: &mut ImportSummary,
) -> Result<(), AppError> {
    let Session::Pg(client) = session else {
        return Err(AppError::new("COPY import requires a PostgreSQL session"));
    };
    let mut sink = Box::pin(client.copy_in::<str, Bytes>(&plan.copy_sql()).await?);
    let mut buf = String::new();
    let outcome = async {
        while let Some(chunk) = rx.recv().await {
            if cancel.load(Ordering::Acquire) {
                return Err(AppError::new("import cancelled and rolled back"));
            }
            let chunk = chunk?;
            take_warnings(summary, chunk.warnings);
            for row in &chunk.rows {
                summary.rows_read += 1;
                plan.copy_line(row, summary.rows_read, &mut buf)?;
                if buf.len() >= BATCH_BYTES {
                    sink.as_mut()
                        .send(Bytes::from(std::mem::take(&mut buf)))
                        .await?;
                }
            }
            progress(ImportProgressUpdate {
                rows_read: summary.rows_read,
                rows_inserted: summary.rows_read,
                bytes_read: chunk.bytes_read,
                total_bytes,
                done: false,
                force: false,
            });
        }
        if cancel.load(Ordering::Acquire) {
            return Err(AppError::new("import cancelled and rolled back"));
        }
        if !buf.is_empty() {
            sink.as_mut().send(Bytes::from(buf)).await?;
        }
        Ok(())
    }
    .await;
    match outcome {
        Ok(()) => {
            summary.rows_inserted = sink.as_mut().finish().await?;
            Ok(())
        }
        Err(error) => {
            // Close the COPY either way so the protocol resyncs before ROLLBACK; the
            // rows it accepted are inside the transaction that is about to roll back.
            let _ = sink.as_mut().finish().await;
            Err(error)
        }
    }
}

fn take_warnings(summary: &mut ImportSummary, warnings: Vec<String>) {
    for warning in warnings {
        if summary.warnings.len() >= MAX_WARNINGS {
            break;
        }
        summary.warnings.push(warning);
    }
}

async fn flush(
    session: &mut Session<'_>,
    head: &str,
    tail: &str,
    tuples: &mut Vec<String>,
    count_tuples: bool,
) -> Result<u64, AppError> {
    if tuples.is_empty() {
        return Ok(0);
    }
    let written = tuples.len() as u64;
    let sql = format!("{head}{}{tail}", std::mem::take(tuples).join(", "));
    let reported = session.insert(&sql).await?;
    Ok(if count_tuples { written } else { reported })
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn import_preview(
    path: String,
    options: ImportOptions,
) -> Result<ImportPreview, AppError> {
    options.validate()?;
    tokio::task::spawn_blocking(move || preview_file(std::path::Path::new(&path), &options))
        .await
        .map_err(|e| AppError::new(format!("import preview task failed: {e}")))?
}

#[tauri::command]
pub async fn import_from_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    connection_id: String,
    path: String,
    options: ImportOptions,
    target: ImportTarget,
) -> Result<ImportSummary, AppError> {
    options.validate()?;
    let conn = state.get(&connection_id)?;
    let mut c = crate::lock_conn(&conn).await?;
    crate::ensure_alive(&mut c).await?;
    c.require_idle("import")?;
    if c.read_only || c.backend.config().read_only {
        return Err(AppError::new("connection is read-only. Import is blocked."));
    }
    c.backend.rollback_cursor().await;
    let cancel = Arc::new(AtomicBool::new(false));
    let registration = state.arm_cancel(
        &connection_id,
        CancelHandle::Flag(Arc::clone(&cancel)),
        c.backend.config().clone(),
        None,
        c.transaction.clone(),
    )?;
    let last = std::sync::Mutex::new(std::time::Instant::now());
    let emitter = app.clone();
    let request = ImportRequest {
        path,
        options,
        target,
    };
    let result = run_import(&mut c.backend, &request, &cancel, |update| {
        {
            let mut guard = crate::lock_sync(&last);
            if !update.force && guard.elapsed().as_millis() < PROGRESS_INTERVAL_MS {
                return;
            }
            *guard = std::time::Instant::now();
        }
        let _ = emitter.emit(
            "import-progress",
            ImportProgress {
                rows_read: update.rows_read,
                rows_inserted: update.rows_inserted,
                bytes_read: update.bytes_read,
                total_bytes: update.total_bytes,
                done: update.done,
            },
        );
    })
    .await;
    drop(c);
    drop(registration);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(json: &str) -> ImportOptions {
        serde_json::from_str(json).unwrap()
    }

    fn write(name: &str, body: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name);
        std::fs::write(&path, body).unwrap();
        (dir, path)
    }

    fn parse(name: &str, body: &[u8], options: &ImportOptions) -> Result<ImportPreview, AppError> {
        let (_dir, path) = write(name, body);
        preview_file(&path, options)
    }

    // --- parity fixtures (mirrored by src/formats.test.ts) --------------------

    #[test]
    fn csv_accepts_quotes_newlines_and_crlf() {
        let preview = parse(
            "a.csv",
            b"id,note\r\n1,\"a\r\nb\"\r2,x\n",
            &opts(r#"{"format":"csv"}"#),
        )
        .unwrap();
        assert_eq!(preview.columns, vec!["id", "note"]);
        assert_eq!(
            preview.rows,
            vec![
                vec![Some("1".into()), Some("a\r\nb".into())],
                vec![Some("2".into()), Some("x".into())],
            ]
        );
    }

    #[test]
    fn csv_strips_a_utf8_bom_from_the_first_header() {
        let preview = parse(
            "b.csv",
            "\u{feff}id,name\n1,duck\n".as_bytes(),
            &opts(r#"{"format":"csv"}"#),
        )
        .unwrap();
        assert_eq!(preview.columns, vec!["id", "name"]);
    }

    #[test]
    fn csv_rejects_the_same_shapes_the_frontend_parser_rejects() {
        for (body, needle) in [
            (b"id,name\n1,\"open".as_ref(), "unterminated"),
            (b"id,name\n1,a\"b".as_ref(), "unquoted"),
            (b"id,name\n1,\"a\"tail".as_ref(), "closing quote"),
            (b"id,id\n1,2".as_ref(), "duplicate"),
            (b"id,\n1,2".as_ref(), "empty column name"),
            (b"id\n1,2".as_ref(), "more fields"),
        ] {
            let err = parse("c.csv", body, &opts(r#"{"format":"csv"}"#)).unwrap_err();
            assert!(
                err.message.to_lowercase().contains(needle),
                "{body:?} → {}",
                err.message
            );
        }
    }

    #[test]
    fn csv_pads_short_rows_and_warns() {
        let preview = parse(
            "d.csv",
            b"id,name,note\n1,duck\n",
            &opts(r#"{"format":"csv"}"#),
        )
        .unwrap();
        assert_eq!(
            preview.rows,
            vec![vec![Some("1".into()), Some("duck".into()), None]]
        );
        assert!(preview.warnings[0].contains("row 1"));
    }

    #[test]
    fn tab_delimiter_and_null_text_apply() {
        let preview = parse(
            "e.tsv",
            b"id\tname\n1\t\\N\n",
            &opts(r#"{"format":"csv","delimiter":"tab","nullText":"\\N"}"#),
        )
        .unwrap();
        assert_eq!(preview.rows, vec![vec![Some("1".into()), None]]);
    }

    #[test]
    fn latin1_decoding_is_opt_in_and_utf8_errors_are_explicit() {
        let body = b"id,name\n1,caf\xe9\n";
        let err = parse("f.csv", body, &opts(r#"{"format":"csv"}"#)).unwrap_err();
        assert!(err.message.contains("not valid UTF-8"), "{}", err.message);
        let preview = parse(
            "f.csv",
            body,
            &opts(r#"{"format":"csv","encoding":"latin1"}"#),
        )
        .unwrap();
        assert_eq!(preview.rows[0][1].as_deref(), Some("café"));
    }

    #[test]
    fn headerless_csv_synthesizes_column_names() {
        let preview = parse(
            "g.csv",
            b"1,duck\n2,goose\n",
            &opts(r#"{"format":"csv","header":false}"#),
        )
        .unwrap();
        assert_eq!(preview.columns, vec!["col1", "col2"]);
        assert_eq!(preview.rows.len(), 2);
    }

    #[test]
    fn skip_rows_drops_a_preamble_before_the_header() {
        let preview = parse(
            "h.csv",
            b"# exported\n\nid,name\n1,duck\n",
            &opts(r#"{"format":"csv","skipRows":2}"#),
        )
        .unwrap();
        assert_eq!(preview.columns, vec!["id", "name"]);
        assert_eq!(preview.rows.len(), 1);
    }

    #[test]
    fn a_quoted_field_spanning_a_read_boundary_survives() {
        // Force many 64 KiB reads with quotes and newlines straddling the boundary.
        let mut body = String::from("id,note\n");
        for i in 0..4_000 {
            body.push_str(&format!("{i},\"line \"\"{i}\"\"\na,b\"\n"));
        }
        let preview = parse("big.csv", body.as_bytes(), &opts(r#"{"format":"csv"}"#)).unwrap();
        assert_eq!(preview.rows.len(), PREVIEW_ROWS);
        assert_eq!(
            preview.rows[3][1].as_deref(),
            Some("line \"3\"\na,b"),
            "quoted value must survive chunk boundaries"
        );
    }

    #[test]
    fn json_array_and_ndjson_agree_and_reject_duplicate_keys() {
        let array = parse(
            "a.json",
            br#"[{"a":1,"b":"x"},{"b":{"n":2}}]"#,
            &opts(r#"{"format":"json"}"#),
        )
        .unwrap();
        assert_eq!(array.columns, vec!["a", "b"]);
        assert_eq!(
            array.rows,
            vec![
                vec![Some("1".into()), Some("x".into())],
                vec![None, Some("{\"n\":2}".into())],
            ]
        );

        let nd = parse(
            "b.json",
            b"{\"a\":1}\n{\"a\":2}\n",
            &opts(r#"{"format":"json"}"#),
        )
        .unwrap();
        assert_eq!(nd.rows.len(), 2);

        let dup = parse(
            "c.json",
            br#"[{"a":1,"a":2}]"#,
            &opts(r#"{"format":"json"}"#),
        )
        .unwrap_err();
        assert!(
            dup.message.contains("duplicate object key"),
            "{}",
            dup.message
        );

        let scalars = parse("d.json", b"[1,2]", &opts(r#"{"format":"json"}"#)).unwrap_err();
        assert!(scalars.message.contains("array of objects"));
    }

    #[test]
    fn json_null_becomes_null_not_empty_text() {
        let preview = parse(
            "e.json",
            br#"[{"a":null,"b":""}]"#,
            &opts(r#"{"format":"json"}"#),
        )
        .unwrap();
        assert_eq!(preview.rows, vec![vec![None, Some(String::new())]]);
    }

    #[test]
    fn preview_reports_truncation_past_the_sample() {
        let mut body = String::from("id\n");
        for i in 0..(PREVIEW_ROWS + 5) {
            body.push_str(&format!("{i}\n"));
        }
        let preview = parse("i.csv", body.as_bytes(), &opts(r#"{"format":"csv"}"#)).unwrap();
        assert_eq!(preview.rows.len(), PREVIEW_ROWS);
        assert!(preview.truncated);
    }

    #[test]
    fn xlsx_round_trips_through_the_writer() {
        use rust_xlsxwriter::Workbook;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.xlsx");
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Data").unwrap();
        for (c, name) in ["id", "name", "flag"].iter().enumerate() {
            ws.write_string(0, c as u16, *name).unwrap();
        }
        ws.write_number(1, 0, 1.0).unwrap();
        ws.write_string(1, 1, "duck").unwrap();
        ws.write_boolean(1, 2, true).unwrap();
        wb.save(&path).unwrap();
        let preview = preview_file(&path, &opts(r#"{"format":"xlsx"}"#)).unwrap();
        assert_eq!(preview.columns, vec!["id", "name", "flag"]);
        assert_eq!(
            preview.rows,
            vec![vec![
                Some("1".into()),
                Some("duck".into()),
                Some("true".into())
            ]]
        );
        assert_eq!(preview.sheets, vec!["Data"]);
    }

    // --- plan / SQL generation ------------------------------------------------

    fn plan(dialect: Dialect, conflict: &str, keys: &[&str]) -> Plan {
        let target = ImportTarget {
            schema: "public".into(),
            table: "t".into(),
            create: false,
            truncate: false,
            conflict: conflict.into(),
            key_columns: keys.iter().map(|k| (*k).to_string()).collect(),
            columns: vec![
                ImportColumn {
                    source: 0,
                    target: "id".into(),
                    kind: "integer".into(),
                    empty_as_null: false,
                },
                ImportColumn {
                    source: 1,
                    target: "name".into(),
                    kind: "text".into(),
                    empty_as_null: true,
                },
            ],
        };
        Plan::build(&target, dialect, 2).unwrap()
    }

    #[test]
    fn conflict_sql_is_engine_specific() {
        assert_eq!(
            plan(Dialect::Postgres, "ignore", &[]).insert_tail(),
            " ON CONFLICT DO NOTHING"
        );
        assert_eq!(
            plan(Dialect::Postgres, "update", &["id"]).insert_tail(),
            " ON CONFLICT (\"id\") DO UPDATE SET \"name\" = EXCLUDED.\"name\""
        );
        assert!(plan(Dialect::MySql, "ignore", &[])
            .insert_head()
            .starts_with("INSERT IGNORE INTO `public`.`t`"));
        assert!(plan(Dialect::MySql, "update", &[])
            .insert_tail()
            .contains("ON DUPLICATE KEY UPDATE `id` = VALUES(`id`)"));
        assert!(plan(Dialect::Sqlite, "ignore", &[])
            .insert_head()
            .starts_with("INSERT OR IGNORE INTO"));
        assert!(plan(Dialect::DuckDb, "update", &[])
            .insert_head()
            .starts_with("INSERT OR REPLACE INTO"));
    }

    #[test]
    fn tuples_coerce_by_declared_type_and_reject_bad_values() {
        let p = plan(Dialect::Postgres, "error", &[]);
        assert_eq!(
            p.tuple(&[Some("7".into()), Some("o'brien".into())], 1)
                .unwrap(),
            "(7, 'o''brien')"
        );
        assert_eq!(
            p.tuple(&[Some("7".into()), Some(String::new())], 1)
                .unwrap(),
            "(7, NULL)"
        );
        let err = p
            .tuple(&[Some("seven".into()), Some("x".into())], 4)
            .unwrap_err();
        assert!(err.message.contains("row 4, column id"), "{}", err.message);
    }

    #[test]
    fn boolean_literals_match_each_engine() {
        for (dialect, want) in [
            (Dialect::Postgres, "TRUE"),
            (Dialect::DuckDb, "TRUE"),
            (Dialect::Sqlite, "1"),
            (Dialect::MySql, "1"),
        ] {
            let p = Plan {
                dialect,
                qualified: dialect.qualify("", "t"),
                columns: vec![PlanColumn {
                    target: "flag".into(),
                    kind: ColumnType::Boolean,
                    empty_as_null: false,
                    source: 0,
                }],
                conflict: "error".into(),
                key_columns: Vec::new(),
                create: false,
                truncate: false,
            };
            assert_eq!(
                p.tuple(&[Some("yes".into())], 1).unwrap(),
                format!("({want})")
            );
            assert!(p.tuple(&[Some("maybe".into())], 1).is_err());
        }
    }

    #[test]
    fn create_sql_maps_types_per_engine() {
        let target = ImportTarget {
            schema: String::new(),
            table: "t".into(),
            create: true,
            truncate: false,
            conflict: "error".into(),
            key_columns: Vec::new(),
            columns: vec![ImportColumn {
                source: 0,
                target: "n".into(),
                kind: "numeric".into(),
                empty_as_null: false,
            }],
        };
        assert_eq!(
            Plan::build(&target, Dialect::Postgres, 1)
                .unwrap()
                .create_sql(),
            "CREATE TABLE \"t\" (\"n\" numeric)"
        );
        assert_eq!(
            Plan::build(&target, Dialect::MySql, 1)
                .unwrap()
                .create_sql(),
            "CREATE TABLE `t` (`n` DECIMAL(38,10))"
        );
        assert_eq!(
            Plan::build(&target, Dialect::DuckDb, 1)
                .unwrap()
                .create_sql(),
            "CREATE TABLE \"t\" (\"n\" DOUBLE)"
        );
        // MySQL TRUNCATE implicitly commits, so the transactional path uses DELETE.
        assert_eq!(
            Plan::build(&target, Dialect::MySql, 1).unwrap().clear_sql(),
            "DELETE FROM `t`"
        );
    }

    #[test]
    fn hostile_targets_are_rejected() {
        let column = ImportColumn {
            source: 0,
            target: "a".into(),
            kind: "text".into(),
            empty_as_null: false,
        };
        let base = ImportTarget {
            schema: String::new(),
            table: "t".into(),
            create: false,
            truncate: false,
            conflict: "error".into(),
            key_columns: Vec::new(),
            columns: vec![column.clone()],
        };
        assert!(Plan::build(&base, Dialect::Postgres, 0).is_err());
        let mut dup = base.clone();
        dup.columns = vec![column.clone(), column.clone()];
        assert!(Plan::build(&dup, Dialect::Postgres, 1).is_err());
        let mut bad = base.clone();
        bad.conflict = "drop".into();
        assert!(Plan::build(&bad, Dialect::Postgres, 1).is_err());
        let mut upsert = base.clone();
        upsert.conflict = "update".into();
        assert!(Plan::build(&upsert, Dialect::Postgres, 1).is_err());
        let mut ty = base.clone();
        ty.columns[0].kind = "money".into();
        assert!(Plan::build(&ty, Dialect::Postgres, 1).is_err());
        let mut nul = base.clone();
        nul.table = "a\0b".into();
        assert!(Plan::build(&nul, Dialect::Postgres, 1).is_err());
    }

    #[test]
    fn hostile_options_are_rejected() {
        for json in [
            r#"{"format":"exe"}"#,
            r#"{"format":"csv","delimiter":"custom","customDelimiter":"\n"}"#,
            r#"{"format":"csv","quoteChar":"ab"}"#,
            r#"{"format":"csv","encoding":"utf-16"}"#,
            r#"{"format":"csv","delimiter":"custom","customDelimiter":"\""}"#,
        ] {
            assert!(opts(json).validate().is_err(), "{json}");
        }
        assert!(opts(r#"{"format":"csv"}"#).validate().is_ok());
    }

    #[test]
    fn blank_lines_are_separators_not_all_null_rows() {
        let preview = parse(
            "blank.csv",
            b"id,name\n1,duck\n\n2,goose\n\n",
            &opts(r#"{"format":"csv"}"#),
        )
        .unwrap();
        assert_eq!(preview.rows.len(), 2, "blank lines must not become rows");
        assert!(preview.warnings.is_empty(), "{:?}", preview.warnings);
    }

    #[test]
    fn escape_must_differ_from_quote_and_delimiter() {
        // escape == quote breaks ordinary RFC-4180 doubling.
        let err = opts(r#"{"format":"csv","escapeChar":"\""}"#)
            .validate()
            .unwrap_err();
        assert!(err.message.contains("escape and quote"), "{}", err.message);
        // escape == delimiter silently swallows separators.
        let err = opts(r#"{"format":"csv","escapeChar":","}"#)
            .validate()
            .unwrap_err();
        assert!(
            err.message.contains("escape character and delimiter"),
            "{}",
            err.message
        );
    }

    #[test]
    fn quoting_can_be_turned_off_entirely() {
        let options = opts(r#"{"format":"csv","quoteChar":""}"#);
        options.validate().unwrap();
        let preview = parse("q.csv", b"size,note\n5\" pipe,a\"b\n", &options).unwrap();
        assert_eq!(
            preview.rows,
            vec![vec![Some("5\" pipe".into()), Some("a\"b".into())]]
        );
        // The same file is a hard error with quoting on — that is the bug this escapes.
        assert!(parse(
            "q.csv",
            b"size,note\n5\" pipe,a\n",
            &opts(r#"{"format":"csv"}"#)
        )
        .is_err());
    }

    #[test]
    fn ndjson_bounds_a_newline_free_line_before_allocating() {
        // A single line just over the element cap must be refused, not materialized.
        let mut body = Vec::with_capacity(MAX_JSON_ELEMENT_BYTES + 64);
        body.extend_from_slice(br#"{"a":""#);
        body.resize(MAX_JSON_ELEMENT_BYTES + 8, b'x');
        body.extend_from_slice(br#""}"#);
        let err = parse("big.ndjson", &body, &opts(r#"{"format":"json"}"#)).unwrap_err();
        assert!(err.message.contains("16 MiB limit"), "{}", err.message);
    }

    #[test]
    fn json_run_path_detects_a_swapped_file_and_warns_about_late_keys() {
        let mut pinned = opts(r#"{"format":"json"}"#);
        pinned.source_columns = vec!["id".into(), "name".into()];
        // Wholly different keys: every row would otherwise import as all-NULL.
        let err = parse("swap.json", b"{\"other\":1}\n", &pinned).unwrap_err();
        assert!(
            err.message.contains("changed since the preview"),
            "{}",
            err.message
        );
        // A key that only shows up past the sampled window warns instead of vanishing.
        let preview = parse(
            "late.json",
            b"{\"id\":1}\n{\"id\":2,\"email\":\"x\"}\n",
            &pinned,
        )
        .unwrap();
        assert_eq!(preview.columns, vec!["id", "name"]);
        assert!(
            preview.warnings.iter().any(|w| w.contains("email")),
            "{:?}",
            preview.warnings
        );
    }

    #[test]
    fn sheet_headers_drop_trailing_blanks_instead_of_erroring() {
        use rust_xlsxwriter::Workbook;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wide.xlsx");
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        for (c, name) in ["id", "name"].iter().enumerate() {
            ws.write_string(0, c as u16, *name).unwrap();
        }
        // One once-touched cell far to the right widens the sheet's range.
        ws.write_string(0, 5, "").unwrap();
        ws.write_number(1, 0, 1.0).unwrap();
        ws.write_string(1, 1, "duck").unwrap();
        wb.save(&path).unwrap();
        let preview = preview_file(&path, &opts(r#"{"format":"xlsx"}"#)).unwrap();
        assert_eq!(preview.columns, vec!["id", "name"]);
        assert_eq!(
            preview.rows,
            vec![vec![Some("1".into()), Some("duck".into())]]
        );
    }

    #[test]
    fn preview_bounds_its_own_payload() {
        // One megabyte-sized cell is elided rather than shipped over IPC.
        let narrow = parse(
            "fat.csv",
            format!("id,blob\n1,{}\n", "x".repeat(900_000)).as_bytes(),
            &opts(r#"{"format":"csv"}"#),
        )
        .unwrap();
        let cell = narrow.rows[0][1].as_ref().unwrap();
        assert!(cell.ends_with('…') && cell.chars().count() == MAX_PREVIEW_CELL_CHARS + 1);

        // Many wide cells hit the aggregate budget, so sampling stops early and the
        // preview reports itself truncated instead of returning an unbounded payload.
        const COLS: usize = 100;
        let header = (0..COLS)
            .map(|k| format!("c{k}"))
            .collect::<Vec<_>>()
            .join(",");
        let value = "y".repeat(2_100);
        let row = vec![value.as_str(); COLS].join(",");
        let mut body = String::with_capacity(45 * (row.len() + 1) + header.len() + 1);
        body.push_str(&header);
        body.push('\n');
        for _ in 0..45 {
            body.push_str(&row);
            body.push('\n');
        }
        let preview = parse("wide.csv", body.as_bytes(), &opts(r#"{"format":"csv"}"#)).unwrap();
        let bytes: usize = preview
            .rows
            .iter()
            .flatten()
            .map(|v| v.as_ref().map_or(0, |s| s.len()))
            .sum();
        assert!(
            bytes <= MAX_PREVIEW_BYTES + COLS * (MAX_PREVIEW_CELL_CHARS + 3),
            "preview payload {bytes} bytes"
        );
        assert!(preview.rows.len() < 45, "sampling stopped at the budget");
        assert!(preview.truncated);
    }

    #[test]
    fn whitespace_only_cells_count_as_empty() {
        let p = plan(Dialect::Postgres, "error", &[]);
        // `name` has emptyAsNull on; `id` does not, so a blank integer still errors.
        assert_eq!(
            p.tuple(&[Some("7".into()), Some("   ".into())], 1).unwrap(),
            "(7, NULL)"
        );
        assert!(p.tuple(&[Some(" ".into()), Some("x".into())], 1).is_err());
    }

    #[test]
    fn dates_and_timestamps_are_validated_and_trimmed() {
        let column = |kind: ColumnType| PlanColumn {
            target: "at".into(),
            kind,
            empty_as_null: false,
            source: 0,
        };
        let plan_for = |dialect: Dialect, kind: ColumnType| Plan {
            dialect,
            qualified: dialect.qualify("", "t"),
            columns: vec![column(kind)],
            conflict: "error".into(),
            key_columns: Vec::new(),
            create: false,
            truncate: false,
        };
        let pg_date = plan_for(Dialect::Postgres, ColumnType::Date);
        assert_eq!(
            pg_date.tuple(&[Some(" 2024-01-01 ".into())], 1).unwrap(),
            "('2024-01-01')",
            "leading/trailing space is trimmed, not sent"
        );
        assert!(
            pg_date.tuple(&[Some("2024-02-30".into())], 1).is_err(),
            "a shape-valid but impossible date must fail here, not at row N"
        );
        let pg_ts = plan_for(Dialect::Postgres, ColumnType::Timestamp);
        assert_eq!(
            pg_ts
                .tuple(&[Some("2024-01-01T00:00:00Z".into())], 1)
                .unwrap(),
            "('2024-01-01T00:00:00Z')"
        );
        assert_eq!(
            pg_ts.tuple(&[Some("2024-01-01".into())], 1).unwrap(),
            "('2024-01-01')",
            "a bare date is a valid timestamp"
        );
        assert!(pg_ts.tuple(&[Some("2024-01-01 25:00".into())], 1).is_err());
        // MySQL DATETIME has no zone: Z is dropped, a numeric offset is refused.
        let my_ts = plan_for(Dialect::MySql, ColumnType::Timestamp);
        assert_eq!(
            my_ts
                .tuple(&[Some("2024-01-01T00:00:00Z".into())], 1)
                .unwrap(),
            "('2024-01-01 00:00:00')"
        );
        let err = my_ts
            .tuple(&[Some("2024-01-01T00:00:00+05:00".into())], 1)
            .unwrap_err();
        assert!(err.message.contains("time-zone offset"), "{}", err.message);
    }

    #[test]
    fn postgres_copy_lines_escape_and_validate_like_the_insert_path() {
        let p = plan(Dialect::Postgres, "error", &[]);
        assert!(p.use_copy(), "a plain PG insert takes the COPY path");
        assert!(
            !plan(Dialect::Postgres, "ignore", &[]).use_copy(),
            "COPY has no ON CONFLICT"
        );
        assert!(!plan(Dialect::MySql, "error", &[]).use_copy());
        assert_eq!(
            p.copy_sql(),
            "COPY \"public\".\"t\" (\"id\", \"name\") FROM STDIN"
        );
        let mut out = String::new();
        p.copy_line(&[Some("7".into()), Some("a\tb\\c\nd".into())], 1, &mut out)
            .unwrap();
        p.copy_line(&[Some("+8".into()), Some(String::new())], 2, &mut out)
            .unwrap();
        assert_eq!(out, "7\ta\\tb\\\\c\\nd\n8\t\\N\n");
        // The same rejections, with the same message, as the INSERT path.
        let mut bad = String::new();
        let err = p
            .copy_line(&[Some("seven".into()), Some("x".into())], 4, &mut bad)
            .unwrap_err();
        assert!(err.message.contains("row 4, column id"), "{}", err.message);
    }

    /// PARITY FIXTURE — mirrored verbatim by "only infers a type the backend loader
    /// accepts" in src/import.test.ts. The frontend infers these tokens from these
    /// values; the loader must then accept every one of them on every engine.
    #[test]
    fn inference_and_coercion_agree() {
        let fixture: &[(&[&str], ColumnType)] = &[
            (&["1", "2", " ", "3"], ColumnType::Integer),
            (&["4", "-3", "42"], ColumnType::Integer),
            (&["0", "1", "1"], ColumnType::Integer),
            (&["1", "2000000000"], ColumnType::BigInt),
            (&["12345678901234567890"], ColumnType::Text),
            (&["1.5", "-2", ".5"], ColumnType::Numeric),
            (&["true", "no", "Y"], ColumnType::Boolean),
            (&["2024-01-01", "2024-12-31"], ColumnType::Date),
            (
                &["2024-01-01T00:00:00Z", "2024-06-02 03:04"],
                ColumnType::Timestamp,
            ),
        ];
        for dialect in [
            Dialect::Postgres,
            Dialect::DuckDb,
            Dialect::Sqlite,
            Dialect::MySql,
        ] {
            for (values, kind) in fixture {
                let p = Plan {
                    dialect,
                    qualified: dialect.qualify("", "t"),
                    columns: vec![PlanColumn {
                        target: "v".into(),
                        kind: *kind,
                        // The preview skips blanks, so the loader must too.
                        empty_as_null: true,
                        source: 0,
                    }],
                    conflict: "error".into(),
                    key_columns: Vec::new(),
                    create: false,
                    truncate: false,
                };
                for value in *values {
                    p.tuple(&[Some((*value).to_string())], 1)
                        .unwrap_or_else(|e| {
                            panic!("[{dialect:?}] {kind:?} rejected {value:?}: {}", e.message)
                        });
                }
            }
        }
    }

    #[test]
    fn numeric_and_integer_recognition() {
        for good in ["1", "-2", "+3", "0009"] {
            assert!(is_integer_text(good), "{good}");
        }
        for bad in ["", "-", "1.0", "1e3", "1 "] {
            assert!(!is_integer_text(bad), "{bad}");
        }
        for good in ["1", "-2.5", ".5", "5.", "1e10", "-1.5E-3"] {
            assert!(is_numeric_text(good), "{good}");
        }
        for bad in ["", ".", "1.2.3", "1e", "abc", "0x10"] {
            assert!(!is_numeric_text(bad), "{bad}");
        }
    }

    // --- embedded round trips -------------------------------------------------

    async fn embedded_backend(driver: &str) -> Backend {
        let cfg = crate::db::ConnectionConfig {
            driver: Some(driver.into()),
            host: String::new(),
            port: 0,
            user: String::new(),
            password: String::new(),
            dbname: String::new(),
            sslmode: None,
            read_only: false,
            path: Some(":memory:".into()),
            ssh: None,
        };
        crate::driver::connect(&cfg).await.unwrap().0
    }

    fn request(path: &std::path::Path, target: ImportTarget, columns: &[&str]) -> ImportRequest {
        let mut options = opts(r#"{"format":"csv"}"#);
        options.source_columns = columns.iter().map(|c| (*c).to_string()).collect();
        ImportRequest {
            path: path.to_string_lossy().to_string(),
            options,
            target,
        }
    }

    fn people_target(create: bool, conflict: &str) -> ImportTarget {
        ImportTarget {
            schema: String::new(),
            table: "people".into(),
            create,
            truncate: false,
            conflict: conflict.into(),
            key_columns: vec!["id".into()],
            columns: vec![
                ImportColumn {
                    source: 0,
                    target: "id".into(),
                    kind: "integer".into(),
                    empty_as_null: false,
                },
                ImportColumn {
                    source: 1,
                    target: "name".into(),
                    kind: "text".into(),
                    empty_as_null: true,
                },
            ],
        }
    }

    async fn rows_of(backend: &mut Backend, sql: &str) -> Vec<Vec<Option<String>>> {
        backend.rollback_cursor().await;
        match backend.run_single(sql, 1000, true).await.unwrap() {
            crate::db::QueryOutcome::Rows { rows, .. } => rows,
            other => panic!("expected rows, got {other:?}"),
        }
    }

    async fn round_trip(driver: &str) {
        let mut backend = embedded_backend(driver).await;
        // A real PK so the conflict modes have something to collide with.
        backend
            .run_single(
                "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT)",
                10,
                false,
            )
            .await
            .unwrap();
        let (_dir, path) = write("people.csv", b"id,name\n1,duck\n2,\n3,go'ose\n");
        let cancel = Arc::new(AtomicBool::new(false));
        let summary = run_import(
            &mut backend,
            &request(&path, people_target(false, "error"), &["id", "name"]),
            &cancel,
            |_| {},
        )
        .await
        .unwrap_or_else(|e| panic!("[{driver}] import: {}", e.message));
        assert_eq!(summary.rows_read, 3, "[{driver}] rows read");

        let rows = rows_of(&mut backend, "SELECT id, name FROM people ORDER BY id").await;
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0][1].as_deref(), Some("duck"));
        assert_eq!(rows[1][1], None, "[{driver}] empty string mapped to NULL");
        assert_eq!(rows[2][1].as_deref(), Some("go'ose"));

        // Re-import with "ignore": the colliding row keeps its original value.
        let (_d2, path2) = write("more.csv", b"id,name\n1,changed\n4,new\n");
        run_import(
            &mut backend,
            &request(&path2, people_target(false, "ignore"), &["id", "name"]),
            &cancel,
            |_| {},
        )
        .await
        .unwrap_or_else(|e| panic!("[{driver}] ignore import: {}", e.message));
        let rows = rows_of(&mut backend, "SELECT id, name FROM people ORDER BY id").await;
        assert_eq!(rows.len(), 4, "[{driver}] one new row only");
        assert_eq!(
            rows[0][1].as_deref(),
            Some("duck"),
            "[{driver}] kept the original"
        );

        // Re-import with "update": the colliding row is replaced.
        run_import(
            &mut backend,
            &request(&path2, people_target(false, "update"), &["id", "name"]),
            &cancel,
            |_| {},
        )
        .await
        .unwrap_or_else(|e| panic!("[{driver}] upsert import: {}", e.message));
        let rows = rows_of(&mut backend, "SELECT id, name FROM people ORDER BY id").await;
        assert_eq!(rows.len(), 4);
        assert_eq!(
            rows[0][1].as_deref(),
            Some("changed"),
            "[{driver}] upsert replaced the row"
        );

        // Truncate + create paths.
        let mut fresh = people_target(true, "error");
        fresh.table = "people2".into();
        run_import(
            &mut backend,
            &request(&path, fresh, &["id", "name"]),
            &cancel,
            |_| {},
        )
        .await
        .unwrap_or_else(|e| panic!("[{driver}] create import: {}", e.message));
        let rows = rows_of(&mut backend, "SELECT COUNT(*) FROM people2").await;
        assert_eq!(rows[0][0].as_deref(), Some("3"));

        let mut again = people_target(false, "error");
        again.table = "people2".into();
        again.truncate = true;
        run_import(
            &mut backend,
            &request(&path, again, &["id", "name"]),
            &cancel,
            |_| {},
        )
        .await
        .unwrap_or_else(|e| panic!("[{driver}] truncate import: {}", e.message));
        let rows = rows_of(&mut backend, "SELECT COUNT(*) FROM people2").await;
        assert_eq!(
            rows[0][0].as_deref(),
            Some("3"),
            "[{driver}] truncate+reload"
        );
    }

    #[tokio::test]
    async fn sqlite_round_trip() {
        round_trip("sqlite").await;
    }

    #[tokio::test]
    async fn duckdb_round_trip() {
        round_trip("duckdb").await;
    }

    #[tokio::test]
    async fn a_bad_value_rolls_the_whole_import_back() {
        let mut backend = embedded_backend("sqlite").await;
        backend
            .run_single("CREATE TABLE people (id INTEGER, name TEXT)", 10, false)
            .await
            .unwrap();
        let (_dir, path) = write("bad.csv", b"id,name\n1,ok\nnope,bad\n");
        let cancel = Arc::new(AtomicBool::new(false));
        let err = run_import(
            &mut backend,
            &request(&path, people_target(false, "error"), &["id", "name"]),
            &cancel,
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(
            err.message.contains("not a valid integer"),
            "{}",
            err.message
        );
        let rows = rows_of(&mut backend, "SELECT COUNT(*) FROM people").await;
        assert_eq!(
            rows[0][0].as_deref(),
            Some("0"),
            "a failed import leaves nothing behind"
        );
    }

    #[tokio::test]
    async fn a_changed_file_header_is_refused() {
        let mut backend = embedded_backend("sqlite").await;
        let (_dir, path) = write("x.csv", b"id,other\n1,a\n");
        let cancel = Arc::new(AtomicBool::new(false));
        let err = run_import(
            &mut backend,
            &request(&path, people_target(true, "error"), &["id", "name"]),
            &cancel,
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(
            err.message.contains("changed since the preview"),
            "{}",
            err.message
        );
    }

    #[tokio::test]
    async fn cancelling_stops_and_rolls_back() {
        let mut backend = embedded_backend("sqlite").await;
        let mut body = String::from("id,name\n");
        for i in 0..5_000 {
            body.push_str(&format!("{i},row{i}\n"));
        }
        let (_dir, path) = write("big.csv", body.as_bytes());
        let cancel = Arc::new(AtomicBool::new(true)); // pre-cancelled
        let err = run_import(
            &mut backend,
            &request(&path, people_target(true, "error"), &["id", "name"]),
            &cancel,
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(err.message.contains("cancelled"), "{}", err.message);
        let missing = backend
            .run_single("SELECT COUNT(*) FROM people", 10, true)
            .await;
        assert!(missing.is_err(), "the created table was rolled back");
    }
}
