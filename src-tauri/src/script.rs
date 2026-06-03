use crate::db::AppError;
use bytes::Bytes;
use futures_util::SinkExt;
use tokio_postgres::Client;

pub enum Item {
    Sql(String),
    /// `COPY ... FROM stdin` plus its inline data block (text format).
    Copy { stmt: String, data: String },
}

fn flush(buf: Vec<u8>) -> String {
    String::from_utf8(buf).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// If `b[i]` begins a valid dollar-quote tag (`$$`, `$_$`, `$body$`), return the
/// index of its closing `$`. `$1` (a parameter) is not a dollar quote.
fn dollar_tag_end(b: &[u8], i: usize) -> Option<usize> {
    let n = b.len();
    let mut j = i + 1;
    while j < n {
        let ch = b[j];
        if ch == b'$' {
            let tag = &b[i + 1..j];
            if (tag.is_empty() || tag[0].is_ascii_alphabetic() || tag[0] == b'_')
                && tag.iter().all(|&x| x.is_ascii_alphanumeric() || x == b'_')
            {
                return Some(j);
            }
            return None;
        }
        if ch.is_ascii_alphanumeric() || ch == b'_' {
            j += 1;
        } else {
            return None;
        }
    }
    None
}

/// Split a SQL script into statements, respecting comments, quoted strings,
/// quoted identifiers, dollar-quoted bodies, and `COPY ... FROM stdin` data blocks.
pub fn split(script: &str) -> Vec<Item> {
    let b = script.as_bytes();
    let n = b.len();
    let mut i = 0usize;
    let mut items: Vec<Item> = Vec::new();
    let mut cur: Vec<u8> = Vec::new();

    while i < n {
        let c = b[i];

        // psql backslash meta-command at statement start (e.g. \connect) — skip line.
        if c == b'\\' && cur.iter().all(|&x| x.is_ascii_whitespace()) {
            while i < n && b[i] != b'\n' {
                i += 1;
            }
            if i < n {
                i += 1;
            }
            cur.clear();
            continue;
        }
        // line comment
        if c == b'-' && i + 1 < n && b[i + 1] == b'-' {
            while i < n && b[i] != b'\n' {
                cur.push(b[i]);
                i += 1;
            }
            continue;
        }
        // block comment
        if c == b'/' && i + 1 < n && b[i + 1] == b'*' {
            cur.push(b'/');
            cur.push(b'*');
            i += 2;
            while i < n && !(b[i] == b'*' && i + 1 < n && b[i + 1] == b'/') {
                cur.push(b[i]);
                i += 1;
            }
            if i < n {
                cur.push(b'*');
                cur.push(b'/');
                i += 2;
            }
            continue;
        }
        // single-quoted string
        if c == b'\'' {
            cur.push(b'\'');
            i += 1;
            while i < n {
                if b[i] == b'\'' {
                    if i + 1 < n && b[i + 1] == b'\'' {
                        cur.push(b'\'');
                        cur.push(b'\'');
                        i += 2;
                        continue;
                    }
                    cur.push(b'\'');
                    i += 1;
                    break;
                }
                cur.push(b[i]);
                i += 1;
            }
            continue;
        }
        // double-quoted identifier
        if c == b'"' {
            cur.push(b'"');
            i += 1;
            while i < n {
                if b[i] == b'"' {
                    if i + 1 < n && b[i + 1] == b'"' {
                        cur.push(b'"');
                        cur.push(b'"');
                        i += 2;
                        continue;
                    }
                    cur.push(b'"');
                    i += 1;
                    break;
                }
                cur.push(b[i]);
                i += 1;
            }
            continue;
        }
        // dollar-quoted body
        if c == b'$' {
            if let Some(end) = dollar_tag_end(b, i) {
                let delim = &b[i..=end];
                let dl = delim.len();
                cur.extend_from_slice(delim);
                i = end + 1;
                while i < n {
                    if b[i] == b'$' && i + dl <= n && &b[i..i + dl] == delim {
                        cur.extend_from_slice(delim);
                        i += dl;
                        break;
                    }
                    cur.push(b[i]);
                    i += 1;
                }
                continue;
            }
            cur.push(b'$');
            i += 1;
            continue;
        }
        // statement terminator
        if c == b';' {
            i += 1;
            let stmt = flush(std::mem::take(&mut cur)).trim().to_string();
            if stmt.is_empty() {
                continue;
            }
            let eff = effective_start(&stmt).to_ascii_lowercase();
            if eff.starts_with("copy") && eff.ends_with("from stdin") {
                let copy_stmt = effective_start(&stmt).to_string();
                // Skip to the next line, then collect data rows until a line "\.".
                while i < n && b[i] != b'\n' {
                    i += 1;
                }
                if i < n {
                    i += 1;
                }
                let mut data: Vec<u8> = Vec::new();
                loop {
                    if i >= n {
                        break;
                    }
                    let ls = i;
                    while i < n && b[i] != b'\n' {
                        i += 1;
                    }
                    let line = &b[ls..i];
                    if i < n {
                        i += 1;
                    }
                    if line == b"\\." {
                        break;
                    }
                    data.extend_from_slice(line);
                    data.push(b'\n');
                }
                items.push(Item::Copy {
                    stmt: copy_stmt,
                    data: flush(data),
                });
            } else {
                items.push(Item::Sql(stmt));
            }
            continue;
        }

        cur.push(c);
        i += 1;
    }

    let last = flush(cur).trim().to_string();
    if !last.is_empty() {
        items.push(Item::Sql(last));
    }
    items
}

/// Skip leading whitespace and comment lines, returning the SQL that follows.
pub fn effective_start(s: &str) -> &str {
    let mut rest = s.trim_start();
    loop {
        if let Some(r) = rest.strip_prefix("--") {
            match r.find('\n') {
                Some(nl) => rest = r[nl + 1..].trim_start(),
                None => return "",
            }
        } else if let Some(r) = rest.strip_prefix("/*") {
            match r.find("*/") {
                Some(end) => rest = r[end + 2..].trim_start(),
                None => return "",
            }
        } else {
            return rest;
        }
    }
}

fn is_read(sql: &str) -> bool {
    let t = effective_start(sql).to_ascii_lowercase();
    t.is_empty()
        || t.starts_with("select")
        || t.starts_with("with")
        || t.starts_with("show")
        || t.starts_with("explain")
        || t.starts_with("table")
        || t.starts_with("values")
        || t.starts_with("set")
}

async fn copy_in_text(client: &Client, stmt: &str, data: &str) -> Result<u64, AppError> {
    let sink = client.copy_in(stmt).await?;
    futures_util::pin_mut!(sink);
    sink.send(Bytes::from(data.as_bytes().to_vec())).await?;
    Ok(sink.finish().await?)
}

fn snippet(item: &Item) -> String {
    let s = match item {
        Item::Sql(s) => s.lines().next().unwrap_or(""),
        Item::Copy { stmt, .. } => stmt,
    };
    s.chars().take(70).collect()
}

/// Run a parsed script inside a single transaction. Rolls back and reports
/// context on the first error. Returns a summary on success.
pub async fn run(client: &Client, items: &[Item], read_only: bool) -> Result<String, AppError> {
    let mut stmts = 0u64;
    let mut copied = 0u64;
    client.batch_execute("BEGIN").await?;
    for item in items {
        let res: Result<(), AppError> = match item {
            Item::Sql(s) => {
                if read_only && !is_read(s) {
                    Err(AppError::new("connection is read-only — script contains writes"))
                } else {
                    client.batch_execute(s).await.map_err(AppError::from)
                }
            }
            Item::Copy { stmt, data } => {
                if read_only {
                    Err(AppError::new("connection is read-only — COPY blocked"))
                } else {
                    copy_in_text(client, stmt, data).await.map(|n| copied += n)
                }
            }
        };
        if let Err(e) = res {
            let _ = client.batch_execute("ROLLBACK").await;
            return Err(AppError::new(format!(
                "{} — at statement {} ({})",
                e.message,
                stmts + 1,
                snippet(item)
            )));
        }
        stmts += 1;
    }
    client.batch_execute("COMMIT").await?;
    Ok(format!("OK — {stmts} statements run, {copied} rows copied"))
}
