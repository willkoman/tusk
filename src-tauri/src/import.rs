//! File-driven data import.
//!
//! `import_preview` parses the head of a file with no database involved; the UI uses it
//! to show detected columns, sampled rows and warnings before anything is written.
//! `import_from_file` streams the same file in bounded batches straight from disk into
//! the connected database — the file bytes never cross the Tauri IPC boundary.
//!
//! One import is one transaction, so a failure or a cancel leaves nothing behind. MySQL
//! DDL implicitly commits, so a `create` import against MySQL can leave the empty table
//! behind when the row load fails; that is the documented caveat.
//!
//! Acceptance rules for delimited text and JSON are kept in step with the frontend
//! parser in `src/formats.ts` (quotes, embedded newlines, BOM, ragged rows, duplicate
//! headers) — the fixtures in `tests` below are the shared parity set.

use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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
const MAX_FIELD_CHARS: usize = 1_000_000;
/// One JSON array element / NDJSON line.
const MAX_JSON_ELEMENT_BYTES: usize = 16 * 1024 * 1024;
const MAX_XLSX_CELLS: usize = 5_000_000;
/// Rows sampled by `import_preview`.
pub const PREVIEW_ROWS: usize = 50;
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
        if !one_char(&self.quote_char)
            || (self.delimiter == "custom" && !one_char(&self.custom_delimiter))
            || (!self.escape_char.is_empty() && !one_char(&self.escape_char))
        {
            return Err(AppError::new(
                "import delimiter, quote and escape characters must each be one non-newline character",
            ));
        }
        if self.delim() == self.quote_c() {
            return Err(AppError::new(
                "import delimiter and quote character must differ",
            ));
        }
        if self.null_text.len() > 1024
            || self.skip_rows > 1_000_000
            || self.sheet.len() > 200
            || self.source_columns.len() > MAX_IMPORT_COLUMNS
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
    fn quote_c(&self) -> char {
        self.quote_char.chars().next().unwrap_or('"')
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
    if len > MAX_FIELD_CHARS {
        return Err(AppError::new(format!(
            "import is too large: a field exceeds {MAX_FIELD_CHARS} characters"
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

/// Reject an empty or duplicated (case-insensitive) header, matching `src/formats.ts`.
fn validate_header(columns: &[String]) -> Result<(), AppError> {
    columns_guard(columns.len())?;
    if columns.iter().any(|c| c.is_empty()) {
        return Err(AppError::new(
            "delimited header contains an empty column name",
        ));
    }
    let mut seen = std::collections::HashSet::with_capacity(columns.len());
    if columns.iter().any(|c| !seen.insert(c.to_lowercase())) {
        return Err(AppError::new(
            "delimited header contains duplicate column names",
        ));
    }
    Ok(())
}

/// Shape a raw parsed row against the resolved columns: pad short rows with NULL, reject
/// wide ones (the `src/formats.ts` rule).
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
            "row {row_number} has only {} of {width} fields — the rest import as NULL",
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
                        "import file is not valid UTF-8 — pick the Latin-1 encoding if that is the file's encoding",
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

/// Streaming delimited-text parser. The state machine mirrors `parseCSV` in
/// `src/formats.ts`: a quote may only open a field, characters after a closing quote are
/// an error, an unterminated quoted field is an error.
struct DelimitedParser {
    delim: char,
    quote: char,
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
                if ch == self.quote {
                    if i + 1 >= chars.len() && !last {
                        break; // the next character decides doubled vs. closing
                    }
                    if chars.get(i + 1) == Some(&self.quote) {
                        self.field.push(self.quote);
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
            if ch == self.quote {
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
            let raw = if columns.is_none() {
                if options.header {
                    validate_header(&raw)?;
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
/// way `assertUniqueJsonKeys` in `src/formats.ts` does.
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

/// Render a JSON value as import text. Objects/arrays stringify (the `src/formats.ts`
/// rule); numbers keep the file's own spelling; null is NULL.
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

struct JsonState {
    columns: Vec<String>,
    discovered: bool,
    row_number: u64,
    budget: RowBudget,
}

/// Turn buffered JSON elements into rows. Returns false when the consumer stopped.
fn drain_json(
    elements: &mut Vec<String>,
    state: &mut JsonState,
    options: &ImportOptions,
    bytes_read: u64,
    emit: RowSink<'_>,
) -> Result<bool, AppError> {
    for element in elements.drain(..) {
        let trimmed = element.trim();
        if trimmed.is_empty() {
            continue;
        }
        let fields = json_object_fields(trimmed)?;
        if state.discovered {
            for (key, _) in &fields {
                if !state.columns.iter().any(|c| c == key) {
                    state.columns.push(key.clone());
                    columns_guard(state.columns.len())?;
                }
            }
        }
        state.row_number += 1;
        state.budget.count()?;
        let row = state
            .columns
            .iter()
            .map(|c| {
                fields
                    .iter()
                    .find(|(k, _)| k == c)
                    .and_then(|(_, v)| v.clone())
                    .and_then(|v| options.null_of(v))
            })
            .collect::<Vec<_>>();
        if !emit(&state.columns, row, bytes_read) {
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
    let mut state = JsonState {
        discovered: options.source_columns.is_empty(),
        columns: options.source_columns.clone(),
        row_number: 0,
        budget: RowBudget::new(),
    };
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
                && !drain_json(&mut elements, &mut state, options, bytes_read, emit)?
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
            let read = reader.read_until(b'\n', &mut raw).map_err(de)?;
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
            if !drain_json(&mut elements, &mut state, options, bytes_read, emit)? {
                break;
            }
        }
    }
    if state.columns.is_empty() {
        return Err(AppError::new("the import file contains no columns"));
    }
    Ok(ParseOutcome {
        columns: state.columns,
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
    let range = workbook
        .worksheet_range(&name)
        .map_err(|e| AppError::new(format!("cannot read sheet {name}: {e}")))?;
    let width = range.width();
    columns_guard(width)?;
    if width.saturating_mul(range.height()) > MAX_XLSX_CELLS {
        return Err(AppError::new(format!(
            "the sheet exceeds the {MAX_XLSX_CELLS}-cell import limit"
        )));
    }
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
        let names: Vec<String> = head
            .iter()
            .map(cell_text)
            .collect::<Result<Vec<_>, AppError>>()?;
        validate_header(&names)?;
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
        if !emit(&columns, shaped, 0) {
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

pub fn preview_file(path: &Path, options: &ImportOptions) -> Result<ImportPreview, AppError> {
    options.validate()?;
    let file_bytes = file_size(path)?;
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut seen = 0u64;
    // Read one row past the sample so `truncated` is accurate.
    let outcome = parse_file(path, options, &mut |_columns, row, _| {
        seen += 1;
        if rows.len() < PREVIEW_ROWS {
            rows.push(row);
        }
        seen <= PREVIEW_ROWS as u64
    })?;
    Ok(ImportPreview {
        columns: outcome.columns,
        rows,
        warnings: outcome.warnings,
        sheets: outcome.sheets,
        truncated: seen > PREVIEW_ROWS as u64,
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

    /// Project one source row onto the mapped columns and render its value tuple.
    fn tuple(&self, row: &[Option<String>], row_number: u64) -> Result<String, AppError> {
        let mut parts = Vec::with_capacity(self.columns.len());
        for column in &self.columns {
            let raw = match row.get(column.source).cloned().flatten() {
                Some(v) if column.empty_as_null && v.is_empty() => None,
                other => other,
            };
            parts.push(self.literal(column, raw.as_deref(), row_number)?);
        }
        Ok(format!("({})", parts.join(", ")))
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
        let reject = |expected: &str| {
            AppError::new(format!(
                "row {row_number}, column {}: {} is not a valid {expected}",
                column.target,
                truncate_for_error(value)
            ))
        };
        Ok(match column.kind {
            ColumnType::Text | ColumnType::Date | ColumnType::Timestamp => {
                self.dialect.string_literal(value)?
            }
            ColumnType::Integer | ColumnType::BigInt => {
                let trimmed = value.trim();
                if !is_integer_text(trimmed) {
                    return Err(reject("integer"));
                }
                if trimmed.parse::<i64>().is_err() {
                    return Err(reject("64-bit integer"));
                }
                trimmed.trim_start_matches('+').to_string()
            }
            ColumnType::Numeric => {
                let trimmed = value.trim();
                if !is_numeric_text(trimmed) {
                    return Err(reject("number"));
                }
                trimmed.trim_start_matches('+').to_string()
            }
            ColumnType::Boolean => {
                let Some(flag) = bool_text(value) else {
                    return Err(reject("boolean"));
                };
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
                .to_string()
            }
        })
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
                "import commit acknowledgement failed; transaction outcome is unknown — verify database state before retrying ({})",
                e.message
            ))
        })
    }

    async fn rollback(&mut self) {
        let _ = self.batch("ROLLBACK").await;
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

/// One parsed batch handed from the blocking parser to the async loader.
struct Chunk {
    rows: Vec<Vec<Option<String>>>,
    bytes_read: u64,
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
                };
                if tx.blocking_send(Ok(chunk)).is_err() {
                    return false;
                }
            }
            !parse_cancel.load(Ordering::Acquire)
        });
        let changed = AppError::new(
            "the file's columns changed since the preview — reopen the import dialog",
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
            Ok(_) => {
                if !batch.is_empty() {
                    let _ = tx.blocking_send(Ok(Chunk {
                        rows: batch,
                        bytes_read: total_bytes,
                    }));
                }
            }
        }
    });

    let mut session = match backend {
        Backend::Pg(pg) => Session::Pg(&pg.client),
        Backend::Duck(duck) => Session::Duck(duck),
        Backend::Sqlite(sqlite) => Session::Sqlite(sqlite),
        Backend::MySql(mysql) => Session::MySql(Box::new(mysql.pool.get_conn().await.map_err(de)?)),
    };

    let mut summary = ImportSummary {
        rows_read: 0,
        rows_inserted: 0,
        rows_skipped: 0,
        warnings: Vec::new(),
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
        Err(error) => {
            session.rollback().await;
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
    session.begin().await?;
    if plan.create {
        session.batch(&plan.create_sql()).await?;
    }
    if plan.truncate {
        session.batch(&plan.clear_sql()).await?;
    }
    let head = plan.insert_head();
    let tail = plan.insert_tail();
    while let Some(chunk) = rx.recv().await {
        if cancel.load(Ordering::Acquire) {
            return Err(AppError::new("import cancelled — rolled back"));
        }
        let chunk = chunk?;
        let mut tuples: Vec<String> = Vec::new();
        let mut tuple_bytes = 0usize;
        for row in &chunk.rows {
            summary.rows_read += 1;
            let tuple = plan.tuple(row, summary.rows_read)?;
            if !tuples.is_empty() && tuple_bytes.saturating_add(tuple.len()) > BATCH_BYTES {
                summary.rows_inserted += flush(session, &head, &tail, &mut tuples).await?;
                tuple_bytes = 0;
            }
            tuple_bytes = tuple_bytes.saturating_add(tuple.len());
            tuples.push(tuple);
        }
        summary.rows_inserted += flush(session, &head, &tail, &mut tuples).await?;
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
        return Err(AppError::new("import cancelled — rolled back"));
    }
    Ok(())
}

async fn flush(
    session: &mut Session<'_>,
    head: &str,
    tail: &str,
    tuples: &mut Vec<String>,
) -> Result<u64, AppError> {
    if tuples.is_empty() {
        return Ok(0);
    }
    let sql = format!("{head}{}{tail}", std::mem::take(tuples).join(", "));
    session.insert(&sql).await
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
        return Err(AppError::new("connection is read-only — import blocked"));
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
