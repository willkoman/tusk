use crate::db::{collect_rows, AppError};
use tokio::fs::File;
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio_postgres::Client;

const EXPORT_CURSOR: &str = "tusk_export_cur";
const BATCH: u32 = 10_000;

fn ident(name: &str) -> String {
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

fn tsv_field(v: &Option<String>) -> String {
    match v {
        None => String::new(),
        Some(s) => s.replace('\t', " ").replace(['\n', '\r'], " "),
    }
}

fn md_field(v: &Option<String>) -> String {
    match v {
        None => String::new(),
        Some(s) => s.replace('|', "\\|").replace('\n', " "),
    }
}

fn sql_val(v: &Option<String>) -> String {
    match v {
        None => "NULL".to_string(),
        Some(s) => format!("'{}'", s.replace('\'', "''")),
    }
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

fn header_for(format: &str, columns: &[String]) -> String {
    match format {
        "csv" => {
            let h: Vec<String> = columns.iter().map(|c| csv_field(&Some(c.clone()))).collect();
            format!("{}\n", h.join(","))
        }
        "tsv" => format!("{}\n", columns.join("\t")),
        "markdown" => {
            let sep: Vec<&str> = columns.iter().map(|_| "---").collect();
            format!("| {} |\n| {} |\n", columns.join(" | "), sep.join(" | "))
        }
        "json" => "[".to_string(),
        _ => String::new(),
    }
}

fn format_row(format: &str, table: &str, columns: &[String], row: &[Option<String>], idx: u64, out: &mut String) {
    match format {
        "tsv" => {
            let f: Vec<String> = row.iter().map(tsv_field).collect();
            out.push_str(&f.join("\t"));
            out.push('\n');
        }
        "markdown" => {
            let f: Vec<String> = row.iter().map(md_field).collect();
            out.push_str(&format!("| {} |\n", f.join(" | ")));
        }
        "sql" => {
            let cols = columns.iter().map(|c| ident(c)).collect::<Vec<_>>().join(", ");
            let vals = row.iter().map(sql_val).collect::<Vec<_>>().join(", ");
            out.push_str(&format!(
                "INSERT INTO {} ({}) VALUES ({});\n",
                ident(table),
                cols,
                vals
            ));
        }
        "json" => {
            if idx > 0 {
                out.push(',');
            }
            out.push_str("\n  {");
            for (k, c) in columns.iter().enumerate() {
                if k > 0 {
                    out.push(',');
                }
                let val = match row.get(k).and_then(|x| x.as_ref()) {
                    Some(s) => json_str(s),
                    None => "null".to_string(),
                };
                out.push_str(&format!("{}: {}", json_str(c), val));
            }
            out.push('}');
        }
        _ => {
            let f: Vec<String> = row.iter().map(csv_field).collect();
            out.push_str(&f.join(","));
            out.push('\n');
        }
    }
}

/// Stream a query's full result set to `path` in the given format, fetching from
/// a server-side cursor in batches so memory stays constant. The file is created
/// only once the first row arrives — an empty result writes no file.
pub async fn run_export(
    client: &Client,
    sql: &str,
    format: &str,
    table: &str,
    path: &str,
) -> Result<u64, AppError> {
    client.batch_execute("BEGIN").await?;
    let declare = format!("DECLARE {EXPORT_CURSOR} CURSOR FOR {sql}");
    if let Err(e) = client.batch_execute(&declare).await {
        let _ = client.batch_execute("ROLLBACK").await;
        return Err(e.into());
    }

    let mut total: u64 = 0;
    let mut columns: Vec<String> = Vec::new();
    let mut writer: Option<BufWriter<File>> = None;
    let mut err: Option<AppError> = None;

    loop {
        let fetch = format!("FETCH FORWARD {BATCH} FROM {EXPORT_CURSOR}");
        let messages = match client.simple_query(&fetch).await {
            Ok(m) => m,
            Err(e) => {
                err = Some(e.into());
                break;
            }
        };
        let (cols, rows) = collect_rows(&messages);
        if !cols.is_empty() {
            columns = cols;
        }
        if rows.is_empty() {
            break;
        }

        // Lazily create the file (+ header) only when there's actually data.
        if writer.is_none() {
            let file = match File::create(path).await {
                Ok(f) => f,
                Err(e) => {
                    err = Some(AppError::new(e.to_string()));
                    break;
                }
            };
            let mut w = BufWriter::new(file);
            let header = header_for(format, &columns);
            if !header.is_empty() {
                if let Err(e) = w.write_all(header.as_bytes()).await {
                    err = Some(AppError::new(e.to_string()));
                    break;
                }
            }
            writer = Some(w);
        }

        let mut out = String::new();
        for row in &rows {
            format_row(format, table, &columns, row, total, &mut out);
            total += 1;
        }
        if let Some(w) = writer.as_mut() {
            if let Err(e) = w.write_all(out.as_bytes()).await {
                err = Some(AppError::new(e.to_string()));
                break;
            }
        }

        if (rows.len() as u32) < BATCH {
            break;
        }
    }

    if err.is_none() {
        if let Some(w) = writer.as_mut() {
            if format == "json" {
                let _ = w.write_all(b"\n]\n").await;
            }
            if let Err(e) = w.flush().await {
                err = Some(AppError::new(e.to_string()));
            }
        }
    }

    let _ = client.batch_execute(&format!("CLOSE {EXPORT_CURSOR}")).await;
    let _ = client.batch_execute("COMMIT").await;

    match err {
        Some(e) => Err(e),
        None => Ok(total),
    }
}
