use crate::db::{self, collect_rows, AppError};
use rust_xlsxwriter::{Format, Workbook};
use serde::Deserialize;
use tokio::fs::File;
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio_postgres::Client;

const EXPORT_CURSOR: &str = "tusk_export_cur";
const BATCH: u32 = 10_000;
/// Excel's hard per-sheet row limit; we roll into a new sheet past this.
const XLSX_MAX_ROWS: u32 = 1_048_576;
/// Value-tuples per multi-row INSERT statement.
const SQL_TUPLES_PER_INSERT: usize = 1000;

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

impl ExportOptions {
    pub fn validate(&self) -> Result<(), AppError> {
        if !matches!(self.format.as_str(), "csv" | "tsv" | "json" | "sql" | "markdown" | "xlsx") {
            return Err(AppError::new("unsupported export format"));
        }
        if !matches!(self.delimiter.as_str(), "comma" | "tab" | "semicolon" | "pipe" | "custom")
            || !matches!(self.quote.as_str(), "always" | "asNeeded" | "never")
            || !matches!(self.null_mode.as_str(), "empty" | "literal" | "custom")
            || !matches!(self.line_ending.as_str(), "lf" | "crlf")
        {
            return Err(AppError::new("invalid export formatting option"));
        }
        if self.quote_char.chars().count() != 1
            || (self.delimiter == "custom" && self.custom_delimiter.chars().count() != 1)
            || self.custom_delimiter.chars().any(|c| matches!(c, '\r' | '\n'))
            || self.quote_char.chars().any(|c| matches!(c, '\r' | '\n'))
        {
            return Err(AppError::new("export delimiter and quote character must each be one non-newline character"));
        }
        if self.null_text.len() > 1024 * 1024 || self.sql.table.len() > 1_000
            || self.column_indices.len() > 10_000 || self.bool_cols.len() > 10_000
            || self.xlsx.sheet_name.is_empty() || self.xlsx.sheet_name.chars().count() > 31
            || self.xlsx.sheet_name.chars().any(|c| matches!(c, '[' | ']' | ':' | '*' | '?' | '/' | '\\'))
        {
            return Err(AppError::new("export option exceeds its size limit"));
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
            Err(AppError::new("export column selection contains an out-of-range index"))
        } else {
            Ok(self.column_indices.clone())
        }
    }
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
            if s.is_empty() || s.contains(d) || s.contains(q) || s.contains('\n') || s.contains('\r') {
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

fn sql_val(v: &Option<String>) -> String {
    match v {
        None => "NULL".to_string(),
        Some(s) => format!("'{}'", s.replace('\'', "''")),
    }
}

/// The header / preamble for a format (delimited header row, markdown rule, `[`,
/// or a SQL `CREATE TABLE`). Empty when the format has none.
fn header_text(opts: &ExportOptions, pcols: &[String], pbool: &[bool]) -> String {
    let nl = opts.newline();
    match opts.format.as_str() {
        "json" => "[".to_string(),
        "markdown" => {
            let head: Vec<String> = pcols.iter().map(|c| c.replace('|', "\\|")).collect();
            let sep: Vec<&str> = pcols.iter().map(|_| "---").collect();
            format!("| {} |{nl}| {} |{nl}", head.join(" | "), sep.join(" | "))
        }
        "sql" => {
            if opts.sql.include_create {
                let table = if opts.sql.table.is_empty() { "exported".to_string() } else { opts.sql.table.clone() };
                let cols = pcols
                    .iter()
                    .enumerate()
                    .map(|(k, c)| {
                        let ty = if pbool.get(k).copied().unwrap_or(false) { "boolean" } else { "text" };
                        format!("{} {ty}", db::ident(c))
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("CREATE TABLE {} ({cols});{nl}", db::ident(&table))
            } else {
                String::new()
            }
        }
        // csv / tsv / custom delimited
        _ => {
            if !opts.header {
                return String::new();
            }
            let cells: Vec<String> = pcols.iter().map(|c| delim_field(&Some(c.clone()), opts)).collect();
            format!("{}{nl}", cells.join(&opts.delim().to_string()))
        }
    }
}

// ---------------------------------------------------------------------------
// TextEmit — lazy file writer shared by the streaming and inline paths. The file
// is created on the first row (empty result => no file). Handles BOM, header,
// per-format row formatting, JSON element commas, and batched multi-row INSERTs.
// ---------------------------------------------------------------------------

struct TextEmit<'a> {
    path: &'a str,
    opts: &'a ExportOptions,
    pcols: Vec<String>,
    pbool: Vec<bool>, // per projected column: map textual booleans to TRUE/FALSE
    writer: Option<BufWriter<File>>,
    wrote_rows: u64,
    sql_buf: Vec<String>, // pending value-tuples for a multi-row INSERT
}

impl<'a> TextEmit<'a> {
    fn new(opts: &'a ExportOptions, pcols: Vec<String>, pbool: Vec<bool>, path: &'a str) -> Self {
        Self { path, opts, pcols, pbool, writer: None, wrote_rows: 0, sql_buf: Vec::new() }
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
        let file = File::create(self.path).await.map_err(|e| AppError::new(e.to_string()))?;
        let mut w = BufWriter::new(file);
        if self.opts.bom {
            w.write_all(&[0xEF, 0xBB, 0xBF]).await.map_err(|e| AppError::new(e.to_string()))?;
        }
        let head = header_text(self.opts, &self.pcols, &self.pbool);
        if !head.is_empty() {
            w.write_all(head.as_bytes()).await.map_err(|e| AppError::new(e.to_string()))?;
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
        let cols = self.pcols.iter().map(|c| db::ident(c)).collect::<Vec<_>>().join(", ");
        let tuples = std::mem::take(&mut self.sql_buf).join(&format!(",{nl}"));
        let stmt = format!("INSERT INTO {} ({cols}) VALUES{nl}{tuples};{nl}", db::ident(&self.sql_table()));
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
                self.write(format!("| {} |{nl}", cells.join(" | ")).as_bytes()).await?;
            }
            "sql" => {
                // Recognized booleans emit as unquoted TRUE/FALSE literals (valid on
                // PG / DuckDB / MySQL / SQLite); anything else stays a quoted string.
                let tuple = format!(
                    "({})",
                    prow.iter()
                        .enumerate()
                        .map(|(k, v)| match self.word(k, v) {
                            Some(w) => w.to_string(),
                            None => sql_val(v),
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                );
                if self.opts.sql.multi_row {
                    self.sql_buf.push(tuple);
                    if self.sql_buf.len() >= SQL_TUPLES_PER_INSERT {
                        self.flush_sql_buf().await?;
                    }
                } else {
                    let cols = self.pcols.iter().map(|c| db::ident(c)).collect::<Vec<_>>().join(", ");
                    let stmt = format!("INSERT INTO {} ({cols}) VALUES {tuple};{nl}", db::ident(&self.sql_table()));
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
                self.write(format!("{}{nl}", cells.join(&self.opts.delim().to_string())).as_bytes()).await?;
            }
        }
        self.wrote_rows += 1;
        Ok(())
    }

    async fn finish(&mut self) -> Result<(), AppError> {
        if self.writer.is_none() {
            return Ok(()); // no rows => no file
        }
        if self.opts.format == "sql" && self.opts.sql.multi_row {
            self.flush_sql_buf().await?;
        }
        if self.opts.format == "json" {
            let nl = self.opts.newline();
            self.write(format!("{nl}]{nl}").as_bytes()).await?;
        }
        self.writer
            .as_mut()
            .ok_or_else(|| AppError::new("export writer disappeared before flush"))?
            .flush()
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
    sheets: u32,    // number of sheets created so far
    row_in_sheet: u32, // next row index to write in the current sheet
    last_rows: Vec<u32>, // last written row index per sheet (for autofilter)
    started: bool,
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
            started: false,
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
                    Some(f) => ws.write_string_with_format(0, c as u16, col, f).map_err(xerr)?,
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
        if !self.opts.xlsx.auto_filter || self.pcols.is_empty() || self.sheets == 0 {
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
        self.started = true;
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
                match self.pbool.get(c).copied().unwrap_or(false).then(|| bool_token(s)).flatten() {
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
        if !self.started {
            return Ok(()); // no rows => no file
        }
        self.seal_current_sheet()?; // autofilter for the final sheet
        self.wb.save(path).map_err(xerr)?;
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
    client.batch_execute("BEGIN").await?;
    let declare = format!("DECLARE {EXPORT_CURSOR} CURSOR FOR {sql}");
    if let Err(e) = client.batch_execute(&declare).await {
        let _ = client.batch_execute("ROLLBACK").await;
        return Err(e.into());
    }

    match stream_to_sink(client, opts, path).await {
        Ok(n) => {
            let _ = client.batch_execute(&format!("CLOSE {EXPORT_CURSOR}")).await;
            let _ = client.batch_execute("COMMIT").await;
            Ok(n)
        }
        Err(e) => {
            // Cancelled mid-stream or failed: roll the read transaction back and remove
            // the partial file (text formats create + stream lazily; xlsx writes only at
            // finish, so there's nothing on disk yet in that case).
            let _ = client.batch_execute("ROLLBACK").await;
            let _ = tokio::fs::remove_file(path).await;
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
    is_xlsx: bool,
    indices: Vec<usize>,
    initialized: bool,
    text: Option<TextEmit<'a>>,
    xlsx: Option<XlsxSink<'a>>,
    total: u64,
}

impl<'a> SinkFeeder<'a> {
    fn new(opts: &'a ExportOptions, path: &'a str) -> Self {
        Self { opts, path, is_xlsx: opts.format == "xlsx", indices: Vec::new(), initialized: false, text: None, xlsx: None, total: 0 }
    }

    fn init_cols(&mut self, cols: &[String]) -> Result<(), AppError> {
        if cols.is_empty() || self.initialized {
            return Ok(());
        }
        self.indices = self.opts.indices(cols.len())?;
        if self.opts.bool_cols.iter().any(|&i| i >= cols.len()) {
            return Err(AppError::new("export boolean-column metadata contains an out-of-range index"));
        }
        self.initialized = true;
        let pcols = project_cols(cols, &self.indices);
        let pbool = project_bools(self.opts, &self.indices);
        if self.is_xlsx {
            self.xlsx = Some(XlsxSink::new(self.opts, pcols, pbool));
        } else {
            self.text = Some(TextEmit::new(self.opts, pcols, pbool, self.path));
        }
        Ok(())
    }

    async fn feed(&mut self, rows: &[Vec<Option<String>>]) -> Result<(), AppError> {
        if !rows.is_empty() && self.text.is_none() && self.xlsx.is_none() {
            return Err(AppError::new("the export result contains rows but no columns"));
        }
        for row in rows {
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

async fn stream_to_sink(client: &Client, opts: &ExportOptions, path: &str) -> Result<u64, AppError> {
    let mut feeder = SinkFeeder::new(opts, path);
    loop {
        let fetch = format!("FETCH FORWARD {BATCH} FROM {EXPORT_CURSOR}");
        let messages = client.simple_query(&fetch).await?;
        let (cols, rows) = collect_rows(&messages);
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
/// reset and the partial file removed. NOTE: LIMIT/OFFSET pages aren't
/// snapshot-consistent under concurrent writes (same class as grid paging).
pub async fn run_export_paged(
    backend: &mut crate::driver::Backend,
    sql: &str,
    opts: &ExportOptions,
    path: &str,
) -> Result<u64, AppError> {
    opts.validate()?;
    backend.rollback_cursor().await;
    match paged_inner(backend, sql, opts, path).await {
        Ok(n) => {
            backend.rollback_cursor().await; // close any remaining pager state
            Ok(n)
        }
        Err(e) => {
            backend.rollback_cursor().await;
            let _ = tokio::fs::remove_file(path).await;
            Err(e)
        }
    }
}

async fn paged_inner(
    backend: &mut crate::driver::Backend,
    sql: &str,
    opts: &ExportOptions,
    path: &str,
) -> Result<u64, AppError> {
    let mut feeder = SinkFeeder::new(opts, path);
    let out = backend.run_single(sql, BATCH, true).await?;
    let (cols, rows, mut done) = match out {
        db::QueryOutcome::Rows { columns, rows, done, .. } => (columns, rows, done),
        db::QueryOutcome::Exec { .. } => return Err(AppError::new("the export query returned no result set")),
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

/// Format inline rows into an in-memory byte buffer (Slack file attachments).
/// Reuses the file sinks unchanged via a tempfile — the extra I/O is negligible at
/// attachment sizes, and every format (incl. xlsx + BOM handling) stays identical
/// to the file-export path by construction.
pub async fn export_rows_to_bytes(
    columns: &[String],
    rows: &[Vec<Option<String>>],
    opts: &ExportOptions,
) -> Result<Vec<u8>, AppError> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("tusk-slack-{nanos}.tmp"));
    let path_str = path.to_string_lossy().to_string();
    let result = run_export_rows(columns, rows, opts, &path_str).await;
    let bytes = match &result {
        // Zero rows never create the file (lazy sink) — return an empty buffer.
        Ok(_) => match tokio::fs::read(&path).await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => {
                let _ = tokio::fs::remove_file(&path).await;
                return Err(AppError::new(e.to_string()));
            }
        },
        Err(_) => Vec::new(),
    };
    let _ = tokio::fs::remove_file(&path).await;
    result.map(|_| bytes)
}

/// Export an in-memory result (the rows already loaded in the grid) to `path`.
pub async fn run_export_rows(
    columns: &[String],
    rows: &[Vec<Option<String>>],
    opts: &ExportOptions,
    path: &str,
) -> Result<u64, AppError> {
    opts.validate()?;
    let indices = opts.indices(columns.len())?;
    if opts.bool_cols.iter().any(|&i| i >= columns.len()) {
        return Err(AppError::new("export boolean-column metadata contains an out-of-range index"));
    }
    let pcols = project_cols(columns, &indices);
    let pbool = project_bools(opts, &indices);
    let mut total: u64 = 0;
    if opts.format == "xlsx" {
        let mut sink = XlsxSink::new(opts, pcols, pbool);
        for row in rows {
            sink.write_row(&project_row(row, &indices))?;
            total += 1;
        }
        sink.finish(path)?;
    } else {
        let mut emit = TextEmit::new(opts, pcols, pbool, path);
        for row in rows {
            emit.row(&project_row(row, &indices)).await?;
            total += 1;
        }
        emit.finish().await?;
    }
    Ok(total)
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
        let mut feeder = SinkFeeder::new(&options, "unused.csv");
        feeder.init_cols(&[]).unwrap();
        let err = feeder.feed(&[vec![]]).await.unwrap_err();
        assert!(err.message.contains("no columns"));
    }

    #[test]
    fn out_of_range_projection_is_rejected_before_writing() {
        let mut options = opts(r#"{"format":"csv","columnIndices":[99]}"#);
        let mut feeder = SinkFeeder::new(&options, "unused.csv");
        assert!(feeder.init_cols(&["only".into()]).is_err());
        drop(feeder);
        options.column_indices = vec![0];
        options.quote_char = "\n".into();
        assert!(options.validate().is_err());
    }

    async fn export(o: &ExportOptions, name: &str) -> String {
        let (cols, rows) = data();
        let path = std::env::temp_dir().join(format!("tusk_boolexp_{}_{}", std::process::id(), name));
        let p = path.to_string_lossy().to_string();
        run_export_rows(&cols, &rows, o, &p).await.unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        text
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
            vec![Some("false".into()), Some("0".into()), None, Some("x".into())],
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
    async fn sql_emits_unquoted_literals_and_boolean_create_type() {
        let text = export(
            &opts(r#"{"format":"sql","boolCols":[1],"sql":{"table":"exported","includeCreate":true}}"#),
            "sql",
        )
        .await;
        assert!(text.contains(r#"CREATE TABLE "exported" ("id" text, "active" boolean, "note" text);"#), "{text}");
        assert!(text.contains("VALUES ('1', TRUE, 't');"), "{text}");
        assert!(text.contains("VALUES ('3', NULL, NULL);"), "{text}");
    }

    #[tokio::test]
    async fn markdown_maps_to_display_words() {
        let text = export(&opts(r#"{"format":"markdown","boolCols":[1]}"#), "md").await;
        assert!(text.contains("| 1 | TRUE | t |"), "{text}");
        assert!(text.contains("| 2 | FALSE | plain |"), "{text}");
    }

    #[tokio::test]
    async fn bool_cols_are_source_indices_surviving_projection() {
        let text = export(&opts(r#"{"format":"csv","boolCols":[1],"columnIndices":[2,1]}"#), "proj").await;
        assert_eq!(text, "note,active\nt,TRUE\nplain,FALSE\n,\n");
    }

    #[tokio::test]
    async fn unrecognized_tokens_in_a_bool_col_pass_raw() {
        let cols = vec!["b".into()];
        let rows: Vec<Vec<Option<String>>> =
            vec![vec![Some("maybe".into())], vec![Some("1".into())], vec![Some("0".into())]];
        let path = std::env::temp_dir().join(format!("tusk_boolexp_{}_raw.csv", std::process::id()));
        let p = path.to_string_lossy().to_string();
        run_export_rows(&cols, &rows, &opts(r#"{"format":"csv","boolCols":[0]}"#), &p).await.unwrap();
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
        let n = run_export_rows(&cols, &rows, &opts(r#"{"format":"xlsx","boolCols":[1]}"#), &p).await.unwrap();
        assert_eq!(n, 3);
        let meta = std::fs::metadata(&path).unwrap();
        assert!(meta.len() > 0);
        let _ = std::fs::remove_file(&path);
    }
}
