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
    fn indices(&self, ncols: usize) -> Vec<usize> {
        if self.column_indices.is_empty() {
            (0..ncols).collect()
        } else {
            self.column_indices.iter().copied().filter(|&i| i < ncols).collect()
        }
    }
}

fn project_cols(columns: &[String], idx: &[usize]) -> Vec<String> {
    idx.iter().map(|&i| columns[i].clone()).collect()
}
fn project_row(row: &[Option<String>], idx: &[usize]) -> Vec<Option<String>> {
    idx.iter().map(|&i| row.get(i).cloned().flatten()).collect()
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
fn header_text(opts: &ExportOptions, pcols: &[String]) -> String {
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
                let cols = pcols.iter().map(|c| format!("{} text", db::ident(c))).collect::<Vec<_>>().join(", ");
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
    writer: Option<BufWriter<File>>,
    wrote_rows: u64,
    sql_buf: Vec<String>, // pending value-tuples for a multi-row INSERT
}

impl<'a> TextEmit<'a> {
    fn new(opts: &'a ExportOptions, pcols: Vec<String>, path: &'a str) -> Self {
        Self { path, opts, pcols, writer: None, wrote_rows: 0, sql_buf: Vec::new() }
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
        let head = header_text(self.opts, &self.pcols);
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
            .unwrap()
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
                    let val = match &prow[k] {
                        Some(s) => json_str(s),
                        None => "null".to_string(),
                    };
                    out.push_str(&format!("{}: {}", json_str(c), val));
                }
                out.push('}');
                self.write(out.as_bytes()).await?;
            }
            "markdown" => {
                let cells: Vec<String> = prow
                    .iter()
                    .map(|v| match v {
                        None => String::new(),
                        Some(s) => s.replace('|', "\\|").replace('\n', " "),
                    })
                    .collect();
                self.write(format!("| {} |{nl}", cells.join(" | ")).as_bytes()).await?;
            }
            "sql" => {
                let tuple = format!("({})", prow.iter().map(sql_val).collect::<Vec<_>>().join(", "));
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
                let cells: Vec<String> = prow.iter().map(|v| delim_field(v, self.opts)).collect();
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
        self.writer.as_mut().unwrap().flush().await.map_err(|e| AppError::new(e.to_string()))
    }
}

// ---------------------------------------------------------------------------
// XlsxSink — buffers a workbook in memory (rust_xlsxwriter is not streaming),
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
    base_name: String,
    sheets: u32,    // number of sheets created so far
    row_in_sheet: u32, // next row index to write in the current sheet
    last_rows: Vec<u32>, // last written row index per sheet (for autofilter)
    started: bool,
}

impl<'a> XlsxSink<'a> {
    fn new(opts: &'a ExportOptions, pcols: Vec<String>) -> Self {
        Self {
            wb: Workbook::new(),
            opts,
            base_name: sanitize_sheet(&opts.xlsx.sheet_name),
            pcols,
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
        let ws = self.wb.add_worksheet();
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

    fn write_row(&mut self, prow: &[Option<String>]) -> Result<(), AppError> {
        self.started = true;
        if self.sheets == 0 || self.row_in_sheet >= XLSX_MAX_ROWS {
            self.new_sheet()?;
        }
        let r = self.row_in_sheet;
        let idx = (self.sheets - 1) as usize;
        let ws = self.wb.worksheet_from_index(idx).map_err(xerr)?;
        for (c, v) in prow.iter().enumerate() {
            if let Some(s) = v {
                ws.write_string(r, c as u16, s).map_err(xerr)?;
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
        if self.opts.xlsx.auto_filter && !self.pcols.is_empty() {
            let last_col = (self.pcols.len() - 1) as u16;
            for i in 0..self.sheets as usize {
                let last_row = self.last_rows[i];
                let ws = self.wb.worksheet_from_index(i).map_err(xerr)?;
                ws.autofilter(0, 0, last_row, last_col).map_err(xerr)?;
            }
        }
        self.wb.save(path).map_err(xerr)?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/// Stream a query's full result to `path`, honoring `opts`. Text formats stream in
/// constant memory; xlsx buffers the workbook (rust_xlsxwriter limitation).
pub async fn run_export_query(
    client: &Client,
    sql: &str,
    opts: &ExportOptions,
    path: &str,
) -> Result<u64, AppError> {
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

async fn stream_to_sink(client: &Client, opts: &ExportOptions, path: &str) -> Result<u64, AppError> {
    let is_xlsx = opts.format == "xlsx";
    let mut total: u64 = 0;
    let mut indices: Vec<usize> = Vec::new();
    let mut text: Option<TextEmit> = None;
    let mut xlsx: Option<XlsxSink> = None;

    loop {
        let fetch = format!("FETCH FORWARD {BATCH} FROM {EXPORT_CURSOR}");
        let messages = client.simple_query(&fetch).await?;
        let (cols, rows) = collect_rows(&messages);
        if !cols.is_empty() && indices.is_empty() {
            indices = opts.indices(cols.len());
            let pcols = project_cols(&cols, &indices);
            if is_xlsx {
                xlsx = Some(XlsxSink::new(opts, pcols));
            } else {
                text = Some(TextEmit::new(opts, pcols, path));
            }
        }
        if rows.is_empty() {
            break;
        }
        for row in &rows {
            let prow = project_row(row, &indices);
            if is_xlsx {
                xlsx.as_mut().unwrap().write_row(&prow)?;
            } else {
                text.as_mut().unwrap().row(&prow).await?;
            }
            total += 1;
        }
        if (rows.len() as u32) < BATCH {
            break;
        }
    }

    if is_xlsx {
        if let Some(s) = xlsx {
            s.finish(path)?;
        }
    } else if let Some(mut t) = text {
        t.finish().await?;
    }
    Ok(total)
}

/// Export an in-memory result (the rows already loaded in the grid) to `path`.
pub async fn run_export_rows(
    columns: &[String],
    rows: &[Vec<Option<String>>],
    opts: &ExportOptions,
    path: &str,
) -> Result<u64, AppError> {
    let indices = opts.indices(columns.len());
    let pcols = project_cols(columns, &indices);
    let mut total: u64 = 0;
    if opts.format == "xlsx" {
        let mut sink = XlsxSink::new(opts, pcols);
        for row in rows {
            sink.write_row(&project_row(row, &indices))?;
            total += 1;
        }
        sink.finish(path)?;
    } else {
        let mut emit = TextEmit::new(opts, pcols, path);
        for row in rows {
            emit.row(&project_row(row, &indices)).await?;
            total += 1;
        }
        emit.finish().await?;
    }
    Ok(total)
}
