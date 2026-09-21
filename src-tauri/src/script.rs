use crate::db::{AppError, TransactionMode, TransactionState, TransactionStatus};
use bytes::Bytes;
use futures_util::SinkExt;
use tokio_postgres::Client;

#[derive(Clone)]
pub enum Item {
    Sql(String),
    /// `COPY ... FROM stdin` plus its inline data block (text format).
    Copy {
        stmt: String,
        data: String,
    },
}

fn flush(buf: Vec<u8>) -> String {
    // The splitter copies input bytes verbatim, so this conversion cannot lose data.
    // If that invariant ever breaks, degrade lossily instead of panicking inside a
    // Tauri command reachable from every run/lint/editor path.
    debug_assert!(
        std::str::from_utf8(&buf).is_ok(),
        "SQL splitter preserves UTF-8 input bytes"
    );
    String::from_utf8_lossy(&buf).into_owned()
}

/// If `b[i]` begins a valid dollar-quote tag (`$$`, `$_$`, `$body$`), return the
/// index of its closing `$`. `$1` (a parameter) is not a dollar quote.
pub(crate) fn dollar_tag_end(b: &[u8], i: usize) -> Option<usize> {
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

/// Parse a SQL script for execution, respecting comments, quoted strings,
/// quoted identifiers, dollar-quoted bodies, and `COPY ... FROM stdin` data blocks.
/// psql meta-commands and unterminated COPY data are rejected instead of silently
/// disappearing or being sent to the server as partial input.
pub fn parse(script: &str) -> Result<Vec<Item>, AppError> {
    split_impl(script, true, TransactionEngine::Postgres)
}

/// A T-SQL `GO` batch separator occupying the rest of the line. Returns the index
/// just past the terminating newline plus whether a repeat count followed it.
/// `GO` is a client directive (sqlcmd/SSMS), never sent to the server, so the
/// splitter treats it as a statement boundary that produces no item of its own.
fn mssql_go_line(b: &[u8], start: usize) -> Option<(usize, bool)> {
    let n = b.len();
    let mut i = start;
    let space = |c: u8| matches!(c, b' ' | b'\t');
    while i < n && space(b[i]) {
        i += 1;
    }
    if i + 2 > n || (b[i] | 0x20) != b'g' || (b[i + 1] | 0x20) != b'o' {
        return None;
    }
    i += 2;
    if i < n && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
        return None;
    }
    while i < n && space(b[i]) {
        i += 1;
    }
    let digits = i;
    while i < n && b[i].is_ascii_digit() {
        i += 1;
    }
    let counted = i > digits;
    while i < n && space(b[i]) {
        i += 1;
    }
    // A trailing comment still leaves `GO` alone on its line. Both forms are skipped:
    // `GO /* end of batch */` that fails this test reaches the server as SQL and
    // fails with "Could not find stored procedure 'GO'".
    if i + 1 < n && b[i] == b'-' && b[i + 1] == b'-' {
        while i < n && b[i] != b'\n' {
            i += 1;
        }
    } else if i + 1 < n && b[i] == b'/' && b[i + 1] == b'*' {
        // An unterminated block comment is not a batch separator: leave the text to
        // the ordinary comment scanner.
        i = block_comment_end_at(b, i, true)?;
        while i < n && space(b[i]) {
            i += 1;
        }
        if i + 1 < n && b[i] == b'-' && b[i + 1] == b'-' {
            while i < n && b[i] != b'\n' {
                i += 1;
            }
        }
    }
    if i < n && b[i] == b'\r' {
        i += 1;
    }
    match b.get(i) {
        None => Some((n, counted)),
        Some(b'\n') => Some((i + 1, counted)),
        Some(_) => None,
    }
}

/// Checked execution splitter with the connected engine's string/comment rules.
/// MySQL backslash escapes, `#` comments, and backtick identifiers must be handled
/// before transaction preflight or text inside them can become a separate command.
/// SQL Server adds `[bracket]` identifiers, nested block comments, and `GO`.
pub fn parse_for_engine(script: &str, engine: TransactionEngine) -> Result<Vec<Item>, AppError> {
    split_impl(script, true, engine)
}

/// Lenient splitter used by editor-only classification paths. Execution paths must
/// use `parse`, which reports unsupported psql commands and malformed COPY blocks.
#[cfg(test)]
pub fn split(script: &str) -> Vec<Item> {
    split_impl(script, false, TransactionEngine::Postgres).unwrap_or_default()
}

/// One streaming parse step over a chunk of a larger script.
pub struct StreamSplit {
    /// Statements that are definitely complete within the fed chunk.
    pub items: Vec<Item>,
    /// Byte offset in the fed chunk where each item's statement text began
    /// (same length/order as `items`) — lets a caller report line numbers.
    pub starts: Vec<usize>,
    /// Byte offset of the unparsed tail; feed `chunk[tail_start..]` back with the
    /// next chunk. Always an ASCII boundary (0, or just past a `;` / newline).
    pub tail_start: usize,
}

/// Parse the complete statements of one chunk of a larger script, reporting where
/// the (possibly incomplete) trailing statement begins. Restore streams a dump
/// file through this so a multi-gigabyte file never has to be resident *and* the
/// checked lexer below stays the ONE authority on SQL statement boundaries — an
/// independent streaming splitter would be a second lexer to keep in sync.
pub fn parse_stream_chunk(chunk: &str, engine: TransactionEngine) -> Result<StreamSplit, AppError> {
    split_core(chunk, true, engine, true)
}

fn split_impl(
    script: &str,
    checked: bool,
    engine: TransactionEngine,
) -> Result<Vec<Item>, AppError> {
    split_core(script, checked, engine, false).map(|out| out.items)
}

/// The next identifier word at or after `i`, lowercased. Only whitespace is skipped —
/// the block classifier below needs the word that immediately follows `BEGIN`.
fn peek_word(b: &[u8], mut i: usize) -> String {
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    let start = i;
    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
        i += 1;
    }
    String::from_utf8_lossy(&b[start..i]).to_ascii_lowercase()
}

/// The head words of a statement spell `CREATE [OR REPLACE] [TEMP|TEMPORARY] TRIGGER`.
/// Only that shape opens a SQLite trigger body, so nothing else lets a bare `END`
/// close a block (and, outside a trigger, `END` stays a COMMIT synonym).
fn sqlite_trigger_head(words: &[String]) -> bool {
    let mut it = words.iter().map(|w| w.as_str());
    if it.next() != Some("create") {
        return false;
    }
    for w in it {
        match w {
            "or" | "replace" | "temp" | "temporary" => continue,
            "trigger" => return true,
            _ => return false,
        }
    }
    false
}

fn split_core(
    script: &str,
    checked: bool,
    engine: TransactionEngine,
    stream: bool,
) -> Result<StreamSplit, AppError> {
    let b = script.as_bytes();
    let n = b.len();
    let mut i = 0usize;
    // T-SQL statement-block nesting (`BEGIN … END`, `BEGIN TRY`/`BEGIN CATCH`,
    // `CASE … END`). T-SQL has no dollar quoting, so without this a stored
    // procedure body is shredded at its own semicolons and every piece is a
    // syntax error. `BEGIN TRAN[SACTION]` / `BEGIN DISTRIBUTED TRAN` open a
    // transaction, not a block, and must NOT raise the depth.
    //
    // SQLite reuses the same counter for `CREATE TRIGGER … BEGIN … END` bodies:
    // SQLite has no dollar quoting either, so the body's own `;` terminators would
    // otherwise shred a replayed trigger and leave a bare `END` that
    // `transaction_action` reads as COMMIT — which is exactly how the table-rebuild
    // path failed on any table carrying a trigger.
    let mut block_depth = 0usize;
    // First code words of the statement being accumulated (SQLite only, capped),
    // and whether they opened a trigger.
    let mut head: Vec<String> = Vec::new();
    let mut in_trigger = false;
    let mut items: Vec<Item> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    // Byte offset where the statement currently accumulating in `cur` began.
    let mut stmt_start = 0usize;
    let mut cur: Vec<u8> = Vec::new();

    while i < n {
        let c = b[i];

        // T-SQL `GO`: a client-side batch separator on a line of its own. It ends the
        // current statement and is never forwarded to the server. A repeat count would
        // silently change how many times the batch runs, so execution rejects it.
        if engine == TransactionEngine::MsSql && (i == 0 || b[i - 1] == b'\n') {
            if let Some((next, counted)) = mssql_go_line(b, i) {
                if checked && counted {
                    return Err(AppError::new(
                        "GO with a repeat count is not supported. Run the batch explicitly.",
                    ));
                }
                let stmt = flush(std::mem::take(&mut cur)).trim().to_string();
                if !stmt.is_empty() {
                    items.push(Item::Sql(stmt));
                    if stream {
                        starts.push(stmt_start);
                    }
                }
                i = next;
                stmt_start = i;
                block_depth = 0;
                continue;
            }
        }

        // psql backslash meta-command at statement start (e.g. \connect). Tusk is
        // not psql: execution must fail visibly rather than silently omit the line.
        let at_statement_start = || {
            let prefix = String::from_utf8_lossy(&cur);
            effective_start(&prefix).is_empty()
        };
        if c == b'\\' && at_statement_start() {
            let start = i;
            while i < n && b[i] != b'\n' {
                i += 1;
            }
            // Streaming: a chunk may have cut the line in half — hand the whole
            // statement back as the tail rather than judging a partial line.
            if stream && i >= n {
                return Ok(StreamSplit {
                    items,
                    starts,
                    tail_start: stmt_start,
                });
            }
            if checked {
                let command = String::from_utf8_lossy(&b[start..i]);
                return Err(AppError::new(format!(
                    "psql meta-command `{}` is not supported",
                    command.trim()
                )));
            }
            if i < n {
                i += 1;
            }
            cur.clear();
            continue;
        }
        // line comment
        if c == b'-'
            && i + 1 < n
            && b[i + 1] == b'-'
            && (engine != TransactionEngine::MySql
                || i + 2 == n
                || b[i + 2].is_ascii_whitespace()
                || b[i + 2].is_ascii_control())
        {
            while i < n && b[i] != b'\n' {
                cur.push(b[i]);
                i += 1;
            }
            continue;
        }
        // MySQL's `#` comment runs to end-of-line. Without engine-aware handling,
        // a semicolon inside the comment can become a real COMMIT/ROLLBACK item.
        if engine == TransactionEngine::MySql && c == b'#' {
            while i < n && b[i] != b'\n' {
                cur.push(b[i]);
                i += 1;
            }
            continue;
        }
        // block comment (T-SQL nests them; the other engines do not)
        if c == b'/' && i + 1 < n && b[i + 1] == b'*' {
            let nests = engine == TransactionEngine::MsSql;
            cur.push(b'/');
            cur.push(b'*');
            i += 2;
            let mut depth = 1usize;
            while i < n {
                if b[i] == b'*' && i + 1 < n && b[i + 1] == b'/' {
                    cur.push(b'*');
                    cur.push(b'/');
                    i += 2;
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    continue;
                }
                if nests && b[i] == b'/' && i + 1 < n && b[i + 1] == b'*' {
                    cur.push(b'/');
                    cur.push(b'*');
                    i += 2;
                    depth += 1;
                    continue;
                }
                cur.push(b[i]);
                i += 1;
            }
            continue;
        }
        // single-quoted string
        if c == b'\'' {
            cur.push(b'\'');
            i += 1;
            while i < n {
                if engine == TransactionEngine::MySql
                    && b[i] == b'\\'
                    && i + 1 < n
                    && b[i + 1] == b'\''
                {
                    return Err(AppError::new(
                        "MySQL backslash-escaped quotes are ambiguous under NO_BACKSLASH_ESCAPES. Use doubled quotes.",
                    ));
                }
                if engine == TransactionEngine::MySql && b[i] == b'\\' && i + 1 < n {
                    cur.push(b[i]);
                    cur.push(b[i + 1]);
                    i += 2;
                    continue;
                }
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
                if engine == TransactionEngine::MySql
                    && b[i] == b'\\'
                    && i + 1 < n
                    && b[i + 1] == b'"'
                {
                    return Err(AppError::new(
                        "MySQL backslash-escaped quotes are ambiguous under NO_BACKSLASH_ESCAPES. Use doubled quotes.",
                    ));
                }
                if engine == TransactionEngine::MySql && b[i] == b'\\' && i + 1 < n {
                    cur.push(b[i]);
                    cur.push(b[i + 1]);
                    i += 2;
                    continue;
                }
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
        // MySQL and SQLite accept backtick-quoted identifiers. Keep delimiters inside
        // one item; PostgreSQL/DuckDB must retain their native interpretation.
        if matches!(engine, TransactionEngine::MySql | TransactionEngine::Sqlite) && c == b'`' {
            cur.push(b'`');
            i += 1;
            while i < n {
                if engine == TransactionEngine::MySql
                    && b[i] == b'\\'
                    && i + 1 < n
                    && b[i + 1] == b'`'
                {
                    return Err(AppError::new(
                        "MySQL backslash-escaped identifier quotes are ambiguous. Use doubled backticks.",
                    ));
                }
                if engine == TransactionEngine::MySql && b[i] == b'\\' && i + 1 < n {
                    cur.push(b[i]);
                    cur.push(b[i + 1]);
                    i += 2;
                    continue;
                }
                if b[i] == b'`' {
                    cur.push(b'`');
                    i += 1;
                    if i < n && b[i] == b'`' {
                        cur.push(b'`');
                        i += 1;
                        continue;
                    }
                    break;
                }
                cur.push(b[i]);
                i += 1;
            }
            continue;
        }
        // SQL Server `[bracket]` identifiers (`]]` escapes a literal `]`). A `;` or
        // quote inside one is part of the name, not a statement boundary.
        if engine == TransactionEngine::MsSql && c == b'[' {
            cur.push(b'[');
            i += 1;
            while i < n {
                if b[i] == b']' {
                    cur.push(b']');
                    i += 1;
                    if i < n && b[i] == b']' {
                        cur.push(b']');
                        i += 1;
                        continue;
                    }
                    break;
                }
                cur.push(b[i]);
                i += 1;
            }
            continue;
        }
        // dollar-quoted body. T-SQL has no dollar quoting (`$` is an identifier and
        // money-literal character), so it must stay an ordinary code byte there.
        if c == b'$' {
            if engine != TransactionEngine::MsSql {
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
            }
            cur.push(b'$');
            i += 1;
            continue;
        }
        // T-SQL statement blocks. Consumed as whole words so `BEGIN`/`END`/`CASE`
        // inside an identifier (`ended`) or a bracket/string never counts.
        if engine == TransactionEngine::MsSql && (c.is_ascii_alphabetic() || c == b'_') {
            let start = i;
            while i < n && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1;
            }
            let word = String::from_utf8_lossy(&b[start..i]).to_ascii_lowercase();
            match word.as_str() {
                "case" => block_depth += 1,
                "begin" => {
                    let next = peek_word(b, i);
                    // BEGIN TRAN[SACTION] / BEGIN DISTRIBUTED TRAN[SACTION] start a
                    // transaction; everything else (incl. BEGIN TRY/CATCH) is a block.
                    if !matches!(next.as_str(), "tran" | "transaction" | "distributed") {
                        block_depth += 1;
                    }
                }
                "end" => block_depth = block_depth.saturating_sub(1),
                _ => {}
            }
            cur.extend_from_slice(&b[start..i]);
            continue;
        }
        // SQLite trigger bodies. Whole words again, so `END` inside an identifier
        // (`appended`) or a quoted string never closes the body. `CASE … END` is
        // counted too: an unpaired `END` in the body would close the block early.
        if engine == TransactionEngine::Sqlite && (c.is_ascii_alphabetic() || c == b'_') {
            let start = i;
            while i < n && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1;
            }
            let word = String::from_utf8_lossy(&b[start..i]).to_ascii_lowercase();
            if !in_trigger && head.len() < 5 {
                head.push(word.clone());
                in_trigger = sqlite_trigger_head(&head);
            }
            if in_trigger {
                match word.as_str() {
                    "begin" | "case" => block_depth += 1,
                    "end" => block_depth = block_depth.saturating_sub(1),
                    _ => {}
                }
            }
            cur.extend_from_slice(&b[start..i]);
            continue;
        }
        // statement terminator
        if c == b';' && block_depth > 0 {
            cur.push(c);
            i += 1;
            continue;
        }
        if c == b';' {
            i += 1;
            let this_start = stmt_start;
            stmt_start = i;
            head.clear();
            in_trigger = false;
            let stmt = flush(std::mem::take(&mut cur)).trim().to_string();
            if stmt.is_empty() {
                continue;
            }
            if is_copy_from_stdin(&stmt) {
                let copy_stmt = effective_start(&stmt).to_string();
                // Skip to the next line, then collect data rows until a line "\.".
                while i < n && b[i] != b'\n' {
                    i += 1;
                }
                if i < n {
                    i += 1;
                }
                let mut data: Vec<u8> = Vec::new();
                let mut terminated = false;
                loop {
                    if i >= n {
                        break;
                    }
                    let ls = i;
                    while i < n && b[i] != b'\n' {
                        i += 1;
                    }
                    let line = &b[ls..i];
                    let line = line.strip_suffix(b"\r").unwrap_or(line);
                    if i < n {
                        i += 1;
                    }
                    if line == b"\\." {
                        terminated = true;
                        break;
                    }
                    data.extend_from_slice(line);
                    data.push(b'\n');
                }
                if !terminated {
                    // Streaming: the data block continues past this chunk — replay the
                    // whole COPY statement (header + data so far) as the tail.
                    if stream {
                        return Ok(StreamSplit {
                            items,
                            starts,
                            tail_start: this_start,
                        });
                    }
                    if checked {
                        return Err(AppError::new(
                            "COPY FROM stdin data is missing the terminating `\\.` line",
                        ));
                    }
                }
                items.push(Item::Copy {
                    stmt: copy_stmt,
                    data: flush(data),
                });
                if stream {
                    starts.push(this_start);
                }
                stmt_start = i;
            } else {
                items.push(Item::Sql(stmt));
                if stream {
                    starts.push(this_start);
                }
            }
            continue;
        }

        cur.push(c);
        i += 1;
    }

    if stream {
        return Ok(StreamSplit {
            items,
            starts,
            tail_start: stmt_start,
        });
    }
    let last = flush(cur).trim().to_string();
    if !last.is_empty() {
        if checked && is_copy_from_stdin(&last) {
            return Err(AppError::new(
                "COPY FROM stdin requires `;`, data rows, and a terminating `\\.` line",
            ));
        }
        items.push(Item::Sql(last));
    }
    Ok(StreamSplit {
        items,
        starts,
        tail_start: n,
    })
}

/// Byte index just past the `*/` that closes the block comment starting at `s[0..2]`,
/// or `None` when it never closes. `nests` mirrors T-SQL, where `/*` inside a block
/// comment opens a nested one.
fn block_comment_end(s: &str, nests: bool) -> Option<usize> {
    block_comment_end_at(s.as_bytes(), 0, nests)
}

/// `block_comment_end` over a byte slice: the index just past the `*/` closing the
/// comment that starts at `start`.
fn block_comment_end_at(b: &[u8], start: usize, nests: bool) -> Option<usize> {
    let mut i = start + 2;
    let mut depth = 1usize;
    while i + 1 < b.len() {
        if b[i] == b'*' && b[i + 1] == b'/' {
            i += 2;
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
            continue;
        }
        if nests && b[i] == b'/' && b[i + 1] == b'*' {
            i += 2;
            depth += 1;
            continue;
        }
        i += 1;
    }
    None
}

/// Skip leading whitespace and comment lines, returning the SQL that follows.
pub fn effective_start(s: &str) -> &str {
    effective_start_for(s, TransactionEngine::Postgres)
}

/// `effective_start` with the connected engine's comment rules. SQL Server NESTS block
/// comments, so `/*/* */ SELECT 1 */ DROP TABLE t` is one comment plus a DROP there
/// while a non-nesting scan reads it as a SELECT — classifying by the wrong text is how
/// a write slips past the read-only guard on the one engine with no server-side
/// enforcement.
pub fn effective_start_for(s: &str, engine: TransactionEngine) -> &str {
    let nests = engine == TransactionEngine::MsSql;
    let mut rest = s.trim_start();
    loop {
        if let Some(r) = rest.strip_prefix("--") {
            match r.find('\n') {
                Some(nl) => rest = r[nl + 1..].trim_start(),
                None => return "",
            }
        } else if rest.starts_with("/*") {
            match block_comment_end(rest, nests) {
                Some(end) => rest = rest[end..].trim_start(),
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

/// First alphabetic word after comments/whitespace, lowercased.
fn first_word(sql: &str) -> String {
    first_word_for(sql, TransactionEngine::Postgres)
}

/// `first_word` with the engine's comment rules (T-SQL nests block comments).
pub fn first_word_for(sql: &str, engine: TransactionEngine) -> String {
    effective_start_for(sql, engine)
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_lowercase()
}

/// DDL / utility statements where "(N rows affected)" is meaningless noise.
pub fn is_ddl(sql: &str) -> bool {
    matches!(
        first_word(sql).as_str(),
        "create"
            | "alter"
            | "drop"
            | "truncate"
            | "comment"
            | "grant"
            | "revoke"
            | "vacuum"
            | "analyze"
            | "analyse"
            | "reindex"
            | "set"
            | "reset"
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactionEngine {
    Postgres,
    DuckDb,
    Sqlite,
    MySql,
    MsSql,
}

impl TransactionEngine {
    /// The engine behind a `Capabilities::kind` string. An unknown kind falls back to
    /// PostgreSQL's rules.
    pub fn for_kind(kind: &str) -> Self {
        match kind {
            "duckdb" => TransactionEngine::DuckDb,
            "sqlite" => TransactionEngine::Sqlite,
            "mysql" => TransactionEngine::MySql,
            "mssql" => TransactionEngine::MsSql,
            _ => TransactionEngine::Postgres,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactionAction {
    Begin,
    Commit,
    Rollback,
    RollbackTo,
    Savepoint,
    Release,
    SetTransaction,
    AutocommitOff,
    AutocommitOn,
}

fn statement_words(sql: &str) -> Vec<String> {
    statement_words_for(sql, TransactionEngine::Postgres)
}

/// Lowercased identifier-ish words of one statement, with the engine's quoting rules.
/// `brackets` matters for SQL Server, where `SAVE TRANSACTION [a;b]` names a savepoint.
fn statement_words_for(sql: &str, engine: TransactionEngine) -> Vec<String> {
    let brackets = engine == TransactionEngine::MsSql;
    let b = effective_start_for(sql, engine).as_bytes();
    let mut words = Vec::new();
    let mut i = 0usize;
    while i < b.len() {
        if brackets && b[i] == b'[' {
            i += 1;
            let mut word = Vec::new();
            while i < b.len() {
                if b[i] == b']' {
                    i += 1;
                    if i < b.len() && b[i] == b']' {
                        word.push(b']');
                        i += 1;
                        continue;
                    }
                    break;
                }
                word.push(b[i]);
                i += 1;
            }
            if !word.is_empty() {
                words.push(String::from_utf8_lossy(&word).to_ascii_lowercase());
            }
            continue;
        }
        if b[i] == b'-' && i + 1 < b.len() && b[i + 1] == b'-' {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // `#` is a comment only on MySQL; on SQL Server it starts a temp-table name.
        if b[i] == b'#' && engine == TransactionEngine::MySql {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b[i] == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
            let mut depth = 1usize;
            i += 2;
            while i + 1 < b.len() {
                if b[i] == b'*' && b[i + 1] == b'/' {
                    i += 2;
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    continue;
                }
                // T-SQL nests block comments: a classifier that stops at the first
                // `*/` would read commented-out text as a real transaction command.
                if brackets && b[i] == b'/' && b[i + 1] == b'*' {
                    i += 2;
                    depth += 1;
                    continue;
                }
                i += 1;
            }
            if depth > 0 {
                i = b.len();
            }
            continue;
        }
        if b[i] == b'\'' {
            i += 1;
            while i < b.len() {
                if b[i] == b'\\' && i + 1 < b.len() {
                    i += 2;
                } else if b[i] == b'\'' {
                    i += 1;
                    if i < b.len() && b[i] == b'\'' {
                        i += 1;
                    } else {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            continue;
        }
        if b[i] == b'$' {
            if let Some(end) = dollar_tag_end(b, i) {
                let delim = &b[i..=end];
                i = end + 1;
                while i + delim.len() <= b.len() && &b[i..i + delim.len()] != delim {
                    i += 1;
                }
                i = (i + delim.len()).min(b.len());
                continue;
            }
        }
        if matches!(b[i], b'"' | b'`') {
            let quote = b[i];
            i += 1;
            let mut word = Vec::new();
            while i < b.len() {
                if b[i] == quote {
                    i += 1;
                    if i < b.len() && b[i] == quote {
                        word.push(quote);
                        i += 1;
                    } else {
                        break;
                    }
                } else {
                    word.push(b[i]);
                    i += 1;
                }
            }
            if !word.is_empty() {
                words.push(String::from_utf8_lossy(&word).to_ascii_lowercase());
            }
            continue;
        }
        if b[i].is_ascii_alphanumeric() || b[i] == b'_' {
            let start = i;
            i += 1;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1;
            }
            words.push(String::from_utf8_lossy(&b[start..i]).to_ascii_lowercase());
            continue;
        }
        i += 1;
    }
    words
}

/// Classify one transaction-control statement. Malformed lifecycle forms fail here so
/// a later bad command in a script cannot be discovered after earlier effects.
#[cfg(test)]
pub fn transaction_action(sql: &str) -> Result<Option<TransactionAction>, AppError> {
    transaction_action_for(sql, TransactionEngine::Postgres)
}

/// SQL Server's lifecycle vocabulary differs enough that it needs its own classifier:
/// bare `BEGIN`/`END` delimit a statement block (not a transaction), savepoints are
/// `SAVE TRANSACTION name`, and `ROLLBACK TRANSACTION name` rolls back TO that
/// savepoint rather than ending the unit.
fn mssql_transaction_action(words: &[String]) -> Result<Option<TransactionAction>, AppError> {
    let first = words.first().map(String::as_str).unwrap_or_default();
    let second = words.get(1).map(String::as_str).unwrap_or_default();
    let unit = matches!(second, "tran" | "transaction" | "work");
    Ok(match first {
        "begin" if matches!(second, "tran" | "transaction") => Some(TransactionAction::Begin),
        // BEGIN/END without TRANSACTION open and close a T-SQL statement block.
        "begin" | "end" => None,
        "commit" => Some(TransactionAction::Commit),
        "rollback" => {
            // ROLLBACK [TRAN[SACTION]] ends the unit; a trailing name targets a savepoint.
            let named = second == "to" || (unit && words.len() > 2);
            match named.then_some(2usize) {
                Some(index) => {
                    let index = if words.get(index).is_some_and(|word| word == "savepoint") {
                        index + 1
                    } else {
                        index
                    };
                    if words.len() <= index {
                        return Err(AppError::new(
                            "ROLLBACK TRANSACTION requires a savepoint name",
                        ));
                    }
                    Some(TransactionAction::RollbackTo)
                }
                None => Some(TransactionAction::Rollback),
            }
        }
        "save" if unit => {
            if words.len() < 3 {
                return Err(AppError::new("SAVE TRANSACTION requires a savepoint name"));
            }
            Some(TransactionAction::Savepoint)
        }
        // Recognized only so preflight can explain the gap: a ported PostgreSQL/MySQL
        // script should get that message, not a bare SQL Server syntax error.
        "release" => {
            let name_index = if second == "savepoint" { 2 } else { 1 };
            if words.len() <= name_index {
                return Err(AppError::new("RELEASE requires a savepoint name"));
            }
            Some(TransactionAction::Release)
        }
        "set" => {
            if words.iter().any(|word| word == "implicit_transactions") {
                return Err(AppError::new(
                    "SET IMPLICIT_TRANSACTIONS is not supported by Tusk; use BEGIN TRANSACTION",
                ));
            }
            if second == "transaction" {
                if words.len() < 3 {
                    return Err(AppError::new(
                        "SET TRANSACTION requires transaction characteristics",
                    ));
                }
                Some(TransactionAction::SetTransaction)
            } else {
                None
            }
        }
        _ => None,
    })
}

pub fn transaction_action_for(
    sql: &str,
    engine: TransactionEngine,
) -> Result<Option<TransactionAction>, AppError> {
    let words = statement_words_for(sql, engine);
    if engine == TransactionEngine::MsSql {
        return mssql_transaction_action(&words);
    }
    let first = words.first().map(String::as_str).unwrap_or_default();
    let second = words.get(1).map(String::as_str).unwrap_or_default();
    let action = match first {
        "begin" => Some(TransactionAction::Begin),
        "start" => {
            if second != "transaction" {
                return Ok(None);
            }
            Some(TransactionAction::Begin)
        }
        "commit" | "end" => {
            if second == "prepared" {
                return Err(AppError::new(
                    "prepared transactions are not supported by Tusk",
                ));
            }
            if words
                .iter()
                .any(|word| matches!(word.as_str(), "chain" | "release"))
            {
                return Err(AppError::new(
                    "COMMIT AND CHAIN/RELEASE is not supported by Tusk",
                ));
            }
            Some(TransactionAction::Commit)
        }
        "abort" => Some(TransactionAction::Rollback),
        "rollback" => {
            if second == "prepared" {
                return Err(AppError::new(
                    "prepared transactions are not supported by Tusk",
                ));
            }
            let to_index = if second == "to" {
                Some(1)
            } else if matches!(second, "work" | "transaction")
                && words.get(2).is_some_and(|word| word == "to")
            {
                Some(2)
            } else {
                None
            };
            if let Some(to_index) = to_index {
                let name_index = if words
                    .get(to_index + 1)
                    .is_some_and(|word| word == "savepoint")
                {
                    to_index + 2
                } else {
                    to_index + 1
                };
                if words.len() <= name_index {
                    return Err(AppError::new("ROLLBACK TO requires a savepoint name"));
                }
                Some(TransactionAction::RollbackTo)
            } else {
                if words
                    .iter()
                    .any(|word| matches!(word.as_str(), "chain" | "release"))
                {
                    return Err(AppError::new(
                        "ROLLBACK AND CHAIN/RELEASE is not supported by Tusk",
                    ));
                }
                Some(TransactionAction::Rollback)
            }
        }
        "savepoint" => {
            if words.len() < 2 {
                return Err(AppError::new("SAVEPOINT requires a name"));
            }
            Some(TransactionAction::Savepoint)
        }
        "release" => {
            let name_index = if second == "savepoint" { 2 } else { 1 };
            if words.len() <= name_index {
                return Err(AppError::new("RELEASE requires a savepoint name"));
            }
            Some(TransactionAction::Release)
        }
        "prepare" if second == "transaction" => {
            return Err(AppError::new(
                "prepared transactions are not supported by Tusk",
            ));
        }
        "set" => {
            let scoped_transaction = matches!(second, "session" | "global")
                && (words.get(2).is_some_and(|word| word == "transaction")
                    || words.iter().skip(2).any(|word| word == "transaction"));
            if scoped_transaction {
                return Err(AppError::new(
                    "SET SESSION/GLOBAL TRANSACTION is not supported; use unscoped SET TRANSACTION",
                ));
            }
            if second == "transaction" {
                if words.len() < 3 {
                    return Err(AppError::new(
                        "SET TRANSACTION requires transaction characteristics",
                    ));
                }
                Some(TransactionAction::SetTransaction)
            } else if let Some(position) = words.iter().position(|word| word == "autocommit") {
                let allowed_prefix =
                    position == 1 || (position == 2 && matches!(second, "session" | "local"));
                if !allowed_prefix {
                    if words[..position]
                        .iter()
                        .any(|word| matches!(word.as_str(), "global" | "persist" | "persist_only"))
                    {
                        return Err(AppError::new(
                            "global or persisted autocommit changes are not supported by Tusk",
                        ));
                    }
                    return Ok(None);
                }
                if words.len() != position + 2 {
                    return Err(AppError::new("SET autocommit requires 0, 1, OFF, or ON"));
                }
                match words[position + 1].as_str() {
                    "0" | "off" => Some(TransactionAction::AutocommitOff),
                    "1" | "on" => Some(TransactionAction::AutocommitOn),
                    _ => return Err(AppError::new("SET autocommit requires 0, 1, OFF, or ON")),
                }
            } else {
                None
            }
        }
        _ => None,
    };
    Ok(action)
}

/// True when the script manages its own transaction, so the idle app-owned atomic
/// wrapper must not be added.
pub fn has_txn_control(items: &[Item]) -> bool {
    has_txn_control_for(items, TransactionEngine::Postgres)
}

pub fn has_txn_control_for(items: &[Item], engine: TransactionEngine) -> bool {
    items.iter().any(|it| {
        let s = match it {
            Item::Sql(s) => s.as_str(),
            Item::Copy { stmt, .. } => stmt.as_str(),
        };
        !matches!(transaction_action_for(s, engine), Ok(None))
    })
}

#[cfg(test)]
pub fn is_txn_control_stmt(sql: &str) -> bool {
    !matches!(transaction_action(sql), Ok(None))
}

pub fn is_mysql_implicit_commit(sql: &str) -> bool {
    let words = statement_words(sql);
    let first = words.first().map(String::as_str).unwrap_or_default();
    let second = words.get(1).map(String::as_str).unwrap_or_default();
    // CREATE/DROP TEMPORARY TABLE are the documented exceptions: they participate
    // in the surrounding transaction instead of committing it.
    if matches!(first, "create" | "drop") && second == "temporary" {
        return false;
    }
    matches!(
        first,
        "alter"
            | "create"
            | "drop"
            | "rename"
            | "truncate"
            | "grant"
            | "revoke"
            | "install"
            | "uninstall"
            | "lock"
            | "unlock"
            | "reset"
            | "flush"
            | "change"
            | "clone"
            | "restart"
    ) || (matches!(
        first,
        "analyze" | "analyse" | "check" | "optimize" | "repair"
    ) && second == "table")
        || (first == "set" && second == "password")
        || (first == "cache" && second == "index")
        || (first == "load" && matches!(second, "index" | "data"))
        || (matches!(first, "start" | "stop") && matches!(second, "replica" | "slave"))
}

/// Validate the whole lifecycle before any statement is sent to an engine. The returned
/// action vector is position-aligned with `items` and drives authoritative state updates
/// after each successful statement.
pub fn preflight_transactions(
    items: &[Item],
    engine: TransactionEngine,
    current: &TransactionStatus,
) -> Result<Vec<Option<TransactionAction>>, AppError> {
    if engine != TransactionEngine::Postgres
        && items.iter().any(|item| matches!(item, Item::Copy { .. }))
    {
        return Err(AppError::new(
            "COPY FROM stdin is only supported by PostgreSQL",
        ));
    }

    let mut state = current.state;
    let mut mode = current.mode;
    // Savepoint names are known when this script starts idle/configured. An already
    // active transaction may own savepoints created by earlier run_query calls, so
    // their existence remains server-authoritative.
    let mut savepoints = Vec::<String>::new();
    let mut unknown_existing_savepoints =
        matches!(state, TransactionState::Active | TransactionState::Failed);
    // Known only for a transaction begun within this script. Existing active sessions
    // may have run prior commands, so PostgreSQL remains server-authoritative there.
    let mut postgres_work_seen = (state == TransactionState::Idle).then_some(false);
    // T-SQL names its transactions (`BEGIN TRAN work`), and `ROLLBACK TRAN work` then
    // ends the whole unit rather than rolling back to a savepoint of that name. Known
    // only for a transaction begun inside this script; an already-active one stays
    // server-authoritative.
    let mut unit_name: Option<String> = None;
    let mut actions = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        if engine == TransactionEngine::MySql
            && item_sql(item).is_some_and(contains_mysql_executable_comment)
        {
            return Err(AppError::new(format!(
                "statement {} contains a MySQL/MariaDB executable comment, which is blocked. Remove the comment and run again.",
                index + 1
            )));
        }
        let mut action = match item {
            Item::Sql(sql) => transaction_action_for(sql, engine)?,
            Item::Copy { .. } => None,
        };
        // Resolve T-SQL's ambiguous `ROLLBACK TRAN <name>`: the name is a savepoint's
        // or the transaction's own. A named transaction rollback ends the unit.
        if engine == TransactionEngine::MsSql && action == Some(TransactionAction::RollbackTo) {
            let name = transaction_savepoint_name(item, TransactionAction::RollbackTo, engine)
                .unwrap_or_default();
            let is_savepoint = savepoints.iter().any(|saved| saved == &name);
            if !is_savepoint && unit_name.as_deref() == Some(name.as_str()) {
                action = Some(TransactionAction::Rollback);
            } else if !is_savepoint && !unknown_existing_savepoints {
                return Err(AppError::new(format!(
                    "ROLLBACK TRANSACTION `{name}` names neither the current transaction nor a savepoint"
                )));
            }
        }
        if state == TransactionState::Lost {
            return Err(AppError::new(
                "manual transaction session was lost; disconnect and reconnect",
            ));
        }
        if state == TransactionState::Failed
            && !matches!(
                action,
                Some(TransactionAction::Rollback | TransactionAction::RollbackTo)
            )
        {
            return Err(AppError::new(
                "transaction requires ROLLBACK or ROLLBACK TO before more work",
            ));
        }
        if engine == TransactionEngine::MySql
            && state != TransactionState::Idle
            && matches!(item, Item::Sql(sql) if action.is_none() && is_mysql_implicit_commit(sql))
        {
            return Err(AppError::new(format!(
                "statement {} can implicitly commit in MySQL and is blocked inside a manual transaction",
                index + 1
            )));
        }
        if engine == TransactionEngine::MySql
            && state != TransactionState::Idle
            && matches!(item, Item::Sql(sql) if action.is_none() && matches!(first_word_for(sql, engine).as_str(), "call" | "execute" | "xa"))
        {
            return Err(AppError::new(format!(
                "statement {} can end or replace a MySQL transaction indirectly and is blocked inside a manual transaction",
                index + 1
            )));
        }
        // T-SQL's own DDL is transactional, but a procedure can COMMIT on Tusk's behalf
        // and USE cannot run inside a transaction at all.
        if engine == TransactionEngine::MsSql
            && state != TransactionState::Idle
            && matches!(item, Item::Sql(sql) if action.is_none() && matches!(first_word_for(sql, engine).as_str(), "use" | "exec" | "execute"))
        {
            return Err(AppError::new(format!(
                "statement {} can end or replace a SQL Server transaction indirectly and is blocked inside a manual transaction",
                index + 1
            )));
        }

        match action {
            Some(TransactionAction::Begin) => {
                if state == TransactionState::Configured && engine == TransactionEngine::MySql {
                    state = TransactionState::Active;
                } else if state == TransactionState::Idle {
                    state = TransactionState::Active;
                    mode = TransactionMode::Explicit;
                    savepoints.clear();
                    unknown_existing_savepoints = false;
                    postgres_work_seen = Some(false);
                    if engine == TransactionEngine::MsSql {
                        // BEGIN TRAN[SACTION] [<name>]
                        unit_name = match item {
                            Item::Sql(sql) => statement_words_for(sql, engine).get(2).cloned(),
                            Item::Copy { .. } => None,
                        };
                    }
                } else {
                    return Err(AppError::new(
                        "nested BEGIN/START TRANSACTION is not allowed",
                    ));
                }
            }
            Some(TransactionAction::Commit) => {
                if state != TransactionState::Active {
                    return Err(AppError::new(
                        "COMMIT requires a healthy active transaction; use ROLLBACK to recover a failed transaction",
                    ));
                }
                unit_name = None;
                if mode == TransactionMode::AutocommitOff {
                    state = TransactionState::Active;
                    savepoints.clear();
                    unknown_existing_savepoints = false;
                } else {
                    state = TransactionState::Idle;
                    mode = TransactionMode::None;
                    savepoints.clear();
                    unknown_existing_savepoints = false;
                }
                postgres_work_seen = Some(false);
            }
            Some(TransactionAction::Rollback) => {
                if !matches!(state, TransactionState::Active | TransactionState::Failed) {
                    return Err(AppError::new("no active transaction to finish"));
                }
                unit_name = None;
                if mode == TransactionMode::AutocommitOff {
                    state = TransactionState::Active;
                    savepoints.clear();
                    unknown_existing_savepoints = false;
                } else {
                    state = TransactionState::Idle;
                    mode = TransactionMode::None;
                    savepoints.clear();
                    unknown_existing_savepoints = false;
                }
                postgres_work_seen = Some(false);
            }
            Some(TransactionAction::RollbackTo) => {
                if engine == TransactionEngine::DuckDb {
                    return Err(AppError::new("ROLLBACK TO is not supported by DuckDB"));
                }
                if !matches!(state, TransactionState::Active | TransactionState::Failed) {
                    return Err(AppError::new("ROLLBACK TO requires an active transaction"));
                }
                let name = transaction_savepoint_name(item, TransactionAction::RollbackTo, engine)
                    .expect("transaction_action validated the name");
                if let Some(position) = savepoints.iter().rposition(|saved| saved == &name) {
                    savepoints.truncate(position + 1);
                } else if !unknown_existing_savepoints {
                    return Err(AppError::new(format!(
                        "ROLLBACK TO references unknown savepoint `{name}`"
                    )));
                }
                state = TransactionState::Active;
            }
            Some(TransactionAction::Savepoint | TransactionAction::Release) => {
                let action = action.expect("matched some above");
                if engine == TransactionEngine::DuckDb {
                    return Err(AppError::new("savepoints are not supported by DuckDB"));
                }
                if engine == TransactionEngine::MsSql && action == TransactionAction::Release {
                    return Err(AppError::new(
                        "SQL Server has no RELEASE SAVEPOINT. A savepoint lives until the transaction ends.",
                    ));
                }
                if state != TransactionState::Active {
                    return Err(AppError::new(
                        "savepoint command requires a healthy active transaction",
                    ));
                }
                let name = transaction_savepoint_name(item, action, engine)
                    .expect("transaction_action validated the name");
                if action == TransactionAction::Savepoint {
                    savepoints.push(name);
                } else if let Some(position) = savepoints.iter().rposition(|saved| saved == &name) {
                    savepoints.truncate(position);
                } else if !unknown_existing_savepoints {
                    return Err(AppError::new(format!(
                        "RELEASE references unknown savepoint `{name}`"
                    )));
                }
            }
            Some(TransactionAction::SetTransaction) => match engine {
                TransactionEngine::DuckDb => {
                    return Err(AppError::new("SET TRANSACTION is not supported by DuckDB"));
                }
                TransactionEngine::Sqlite => {
                    return Err(AppError::new("SET TRANSACTION is not supported by SQLite"));
                }
                // T-SQL's SET TRANSACTION ISOLATION LEVEL changes the whole session, not
                // one unit, so Tusk's per-transaction model cannot track it honestly.
                TransactionEngine::MsSql => {
                    return Err(AppError::new(
                        "SET TRANSACTION ISOLATION LEVEL changes the SQL Server session, not one transaction, and is not supported by Tusk",
                    ));
                }
                TransactionEngine::Postgres => {
                    if state != TransactionState::Active {
                        return Err(AppError::new(
                            "PostgreSQL SET TRANSACTION requires an active transaction",
                        ));
                    }
                    if postgres_work_seen == Some(true) {
                        return Err(AppError::new(
                            "PostgreSQL SET TRANSACTION must run before other statements in the transaction",
                        ));
                    }
                }
                TransactionEngine::MySql => {
                    if state == TransactionState::Idle {
                        state = TransactionState::Configured;
                        mode = TransactionMode::Explicit;
                    } else if state != TransactionState::Configured {
                        return Err(AppError::new(
                            "MySQL SET TRANSACTION must run before START TRANSACTION",
                        ));
                    }
                }
            },
            Some(TransactionAction::AutocommitOff) => {
                if engine != TransactionEngine::MySql {
                    return Err(AppError::new("SET autocommit is only supported by MySQL"));
                }
                if state == TransactionState::Idle {
                    state = TransactionState::Active;
                    mode = TransactionMode::AutocommitOff;
                    savepoints.clear();
                    unknown_existing_savepoints = false;
                } else if mode != TransactionMode::AutocommitOff {
                    return Err(AppError::new(
                        "SET autocommit=0 cannot replace an active explicit transaction",
                    ));
                }
            }
            Some(TransactionAction::AutocommitOn) => {
                if engine != TransactionEngine::MySql {
                    return Err(AppError::new("SET autocommit is only supported by MySQL"));
                }
                if !matches!(state, TransactionState::Idle)
                    && mode != TransactionMode::AutocommitOff
                {
                    return Err(AppError::new(
                        "SET autocommit=1 cannot finish an explicit transaction; use COMMIT or ROLLBACK",
                    ));
                }
                state = TransactionState::Idle;
                mode = TransactionMode::None;
                savepoints.clear();
                unknown_existing_savepoints = false;
            }
            None => {
                if state == TransactionState::Configured {
                    return Err(AppError::new(
                        "START TRANSACTION must follow MySQL SET TRANSACTION before other statements",
                    ));
                }
                if engine == TransactionEngine::Postgres && state == TransactionState::Active {
                    postgres_work_seen = Some(true);
                }
            }
        }
        actions.push(action);
    }
    Ok(actions)
}

fn transaction_savepoint_name(
    item: &Item,
    action: TransactionAction,
    engine: TransactionEngine,
) -> Option<String> {
    let Item::Sql(sql) = item else {
        return None;
    };
    let words = statement_words_for(sql, engine);
    if engine == TransactionEngine::MsSql {
        // SAVE TRAN[SACTION] <name> / ROLLBACK [TRAN[SACTION]|TO] [SAVEPOINT] <name>
        return match action {
            TransactionAction::Savepoint => words.get(2).cloned(),
            TransactionAction::RollbackTo => words
                .get(if words.get(2).is_some_and(|word| word == "savepoint") {
                    3
                } else {
                    2
                })
                .cloned(),
            _ => None,
        };
    }
    match action {
        TransactionAction::Savepoint => words.get(1).cloned(),
        TransactionAction::Release => words
            .get(if words.get(1).is_some_and(|word| word == "savepoint") {
                2
            } else {
                1
            })
            .cloned(),
        TransactionAction::RollbackTo => words
            .get({
                let to = if words.get(1).is_some_and(|word| word == "to") {
                    1
                } else {
                    2
                };
                if words.get(to + 1).is_some_and(|word| word == "savepoint") {
                    to + 2
                } else {
                    to + 1
                }
            })
            .cloned(),
        _ => None,
    }
}

fn item_sql(item: &Item) -> Option<&str> {
    match item {
        Item::Sql(sql) => Some(sql),
        Item::Copy { stmt, .. } => Some(stmt),
    }
}

pub fn contains_mysql_executable_comment(sql: &str) -> bool {
    let b = sql.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        if b[i] == b'\'' || b[i] == b'"' || b[i] == b'`' {
            let quote = b[i];
            i += 1;
            while i < b.len() {
                if b[i] == b'\\' && i + 1 < b.len() {
                    i += 2;
                } else if b[i] == quote {
                    i += 1;
                    if i < b.len() && b[i] == quote {
                        i += 1;
                    } else {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            continue;
        }
        // Ordinary comments cannot carry executable content: the server discards
        // `-- …` / `# …` to end of line, and a `/*!` inside a plain `/* … */`
        // block dies with the enclosing comment (MySQL comments do not nest).
        if b[i] == b'#'
            || (b[i] == b'-'
                && i + 1 < b.len()
                && b[i + 1] == b'-'
                && b.get(i + 2)
                    .is_none_or(|c| matches!(c, b' ' | b'\t' | b'\r' | b'\n')))
        {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b[i..].starts_with(b"/*!") || b[i..].starts_with(b"/*M!") {
            return true;
        }
        if b[i..].starts_with(b"/*") {
            i += 2;
            while i < b.len() && !b[i..].starts_with(b"*/") {
                i += 1;
            }
            i = (i + 2).min(b.len());
            continue;
        }
        i += 1;
    }
    false
}

fn scan_code_words(
    sql: &str,
    engine: TransactionEngine,
    mut visit: impl FnMut(&[u8], usize) -> bool,
) -> bool {
    let mssql = engine == TransactionEngine::MsSql;
    let b = sql.as_bytes();
    let mut i = 0usize;
    let mut depth = 0usize;
    while i < b.len() {
        if b[i] == b'-' && i + 1 < b.len() && b[i + 1] == b'-' {
            i += 2;
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b[i] == b'#' && engine == TransactionEngine::MySql {
            i += 1;
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b[i] == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
            let mut comment = 1usize;
            i += 2;
            while i + 1 < b.len() {
                if b[i] == b'*' && b[i + 1] == b'/' {
                    i += 2;
                    comment -= 1;
                    if comment == 0 {
                        break;
                    }
                    continue;
                }
                // T-SQL nests block comments.
                if mssql && b[i] == b'/' && b[i + 1] == b'*' {
                    i += 2;
                    comment += 1;
                    continue;
                }
                i += 1;
            }
            if comment > 0 {
                i = b.len();
            }
            continue;
        }
        // SQL Server `[bracket]` identifier. Kept VISIBLE like a double-quoted one, so
        // `[set_config](…)` cannot bypass a guard that scans for a bare word.
        if mssql && b[i] == b'[' {
            i += 1;
            let mut ident = Vec::new();
            while i < b.len() {
                if b[i] == b']' {
                    i += 1;
                    if i < b.len() && b[i] == b']' {
                        ident.push(b']');
                        i += 1;
                        continue;
                    }
                    break;
                }
                ident.push(b[i]);
                i += 1;
            }
            if visit(&ident, depth) {
                return true;
            }
            continue;
        }
        if b[i] == b'\'' {
            i += 1;
            while i < b.len() {
                if b[i] == b'\'' {
                    i += 1;
                    if i < b.len() && b[i] == b'\'' {
                        i += 1;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            continue;
        }
        if b[i] == b'$' && !mssql {
            if let Some(end) = dollar_tag_end(b, i) {
                let delim = &b[i..=end];
                i = end + 1;
                while i + delim.len() <= b.len() && &b[i..i + delim.len()] != delim {
                    i += 1;
                }
                i = (i + delim.len()).min(b.len());
                continue;
            }
        }
        if b[i] == b'"' {
            i += 1;
            let mut ident = Vec::new();
            while i < b.len() {
                if b[i] == b'"' {
                    i += 1;
                    if i < b.len() && b[i] == b'"' {
                        ident.push(b'"');
                        i += 1;
                        continue;
                    }
                    break;
                }
                ident.push(b[i]);
                i += 1;
            }
            if visit(&ident, depth) {
                return true;
            }
            continue;
        }
        if b[i].is_ascii_alphabetic() || b[i] == b'_' {
            let start = i;
            i += 1;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1;
            }
            if visit(&b[start..i], depth) {
                return true;
            }
            continue;
        }
        if b[i] == b'(' {
            depth = depth.saturating_add(1);
        } else if b[i] == b')' {
            depth = depth.saturating_sub(1);
        }
        i += 1;
    }
    false
}

/// Find an identifier-like word outside strings/comments/dollar bodies. Double-quoted
/// identifiers remain visible so `pg_catalog."set_config"(...)` cannot bypass a guard.
pub fn contains_code_word(sql: &str, needle: &str) -> bool {
    contains_code_word_for(sql, needle, TransactionEngine::Postgres)
}

/// `contains_code_word` with the engine's comment/identifier rules.
pub fn contains_code_word_for(sql: &str, needle: &str, engine: TransactionEngine) -> bool {
    scan_code_words(sql, engine, |word, _| {
        word.eq_ignore_ascii_case(needle.as_bytes())
    })
}

/// The shape of a `WITH`-led statement: `main` is the lowercased keyword of the statement
/// its CTEs feed (`select`, `insert`, `update`, `delete`, `merge`, `table`, `values`, or
/// DuckDB's `from`/`pivot`), `modifying_cte` says whether any CTE body is itself a write,
/// and `main_select_into` identifies the mutating PostgreSQL/MySQL `SELECT … INTO` form.
/// `None` means the shape is not understood, which callers deliberately treat as
/// non-cursorable. A parenthesised main statement is still recognised.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WithShape {
    pub main: String,
    pub modifying_cte: bool,
    pub main_select_into: bool,
}

const WITH_MAIN_WORDS: &[&str] = &[
    "select", "insert", "update", "delete", "merge", "table", "values", "from", "pivot",
];

#[derive(Debug, Clone, Copy)]
enum ShapeTokenKind<'a> {
    Word(&'a [u8]),
    Ident,
    Open,
    Close,
    Comma,
}

#[derive(Debug, Clone, Copy)]
struct ShapeToken<'a> {
    kind: ShapeTokenKind<'a>,
}

const MAX_SHAPE_TOKENS: usize = 200_000;

fn push_shape_token<'a>(out: &mut Vec<ShapeToken<'a>>, kind: ShapeTokenKind<'a>) -> bool {
    if out.len() >= MAX_SHAPE_TOKENS {
        return false;
    }
    out.push(ShapeToken { kind });
    true
}

fn shape_tokens(sql: &str, engine: TransactionEngine) -> Option<Vec<ShapeToken<'_>>> {
    let b = sql.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < b.len() {
        let dash_comment = b[i] == b'-'
            && i + 1 < b.len()
            && b[i + 1] == b'-'
            && (engine != TransactionEngine::MySql
                || b.get(i + 2)
                    .is_none_or(|c| matches!(c, b' ' | b'\t' | b'\r' | b'\n')));
        if dash_comment {
            i += 2;
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if engine == TransactionEngine::MySql && b[i] == b'#' {
            i += 1;
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b[i] == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
            let nests = engine == TransactionEngine::MsSql;
            i += 2;
            let mut depth = 1usize;
            while i + 1 < b.len() {
                if b[i] == b'*' && b[i + 1] == b'/' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    i += 2;
                    continue;
                }
                if nests && b[i] == b'/' && b[i + 1] == b'*' {
                    depth += 1;
                    i += 2;
                    continue;
                }
                i += 1;
            }
            i = (i + 2).min(b.len());
            continue;
        }
        // SQL Server `[bracket]` identifier: one opaque token, `]]` escapes `]`.
        if engine == TransactionEngine::MsSql && b[i] == b'[' {
            i += 1;
            while i < b.len() {
                if b[i] == b']' {
                    i += 1;
                    if i < b.len() && b[i] == b']' {
                        i += 1;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            if !push_shape_token(&mut out, ShapeTokenKind::Ident) {
                return None;
            }
            continue;
        }
        if b[i] == b'\'' {
            i += 1;
            while i < b.len() {
                if engine == TransactionEngine::MySql && b[i] == b'\\' && i + 1 < b.len() {
                    i += 2;
                    continue;
                }
                if b[i] == b'\'' {
                    i += 1;
                    if i < b.len() && b[i] == b'\'' {
                        i += 1;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            continue;
        }
        if b[i] == b'$' && engine != TransactionEngine::MsSql {
            if let Some(end) = dollar_tag_end(b, i) {
                let delim = &b[i..=end];
                i = end + 1;
                while i + delim.len() <= b.len() && &b[i..i + delim.len()] != delim {
                    i += 1;
                }
                i = (i + delim.len()).min(b.len());
                continue;
            }
        }
        if b[i] == b'"'
            || (b[i] == b'`'
                && matches!(engine, TransactionEngine::MySql | TransactionEngine::Sqlite))
        {
            let quote = b[i];
            i += 1;
            while i < b.len() {
                if engine == TransactionEngine::MySql && b[i] == b'\\' && i + 1 < b.len() {
                    i += 2;
                    continue;
                }
                if b[i] == quote {
                    i += 1;
                    if i < b.len() && b[i] == quote {
                        i += 1;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            if !push_shape_token(&mut out, ShapeTokenKind::Ident) {
                return None;
            }
            continue;
        }
        if b[i].is_ascii_alphabetic() || b[i] == b'_' || b[i] >= 0x80 {
            let start = i;
            i += 1;
            while i < b.len()
                && (b[i].is_ascii_alphanumeric() || matches!(b[i], b'_' | b'$') || b[i] >= 0x80)
            {
                i += 1;
            }
            let ident = &b[start..i];
            let kind = if ident.iter().any(|c| *c == b'$' || *c >= 0x80) {
                ShapeTokenKind::Ident
            } else {
                ShapeTokenKind::Word(ident)
            };
            if !push_shape_token(&mut out, kind) {
                return None;
            }
            continue;
        }
        let kind = match b[i] {
            b'(' => Some(ShapeTokenKind::Open),
            b')' => Some(ShapeTokenKind::Close),
            b',' => Some(ShapeTokenKind::Comma),
            _ => None,
        };
        if let Some(kind) = kind {
            if !push_shape_token(&mut out, kind) {
                return None;
            }
        }
        i += 1;
    }
    Some(out)
}

fn shape_word(token: Option<&ShapeToken<'_>>, expected: &str) -> bool {
    matches!(token.map(|t| t.kind), Some(ShapeTokenKind::Word(word)) if word.eq_ignore_ascii_case(expected.as_bytes()))
}

fn shape_ident(token: Option<&ShapeToken<'_>>) -> bool {
    matches!(
        token.map(|t| t.kind),
        Some(ShapeTokenKind::Word(_) | ShapeTokenKind::Ident)
    )
}

fn close_group(tokens: &[ShapeToken<'_>], open: usize) -> Option<usize> {
    if !matches!(tokens.get(open)?.kind, ShapeTokenKind::Open) {
        return None;
    }
    let mut depth = 0usize;
    for (i, token) in tokens.iter().enumerate().skip(open) {
        match token.kind {
            ShapeTokenKind::Open => depth += 1,
            ShapeTokenKind::Close => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

fn top_level_shape_word(tokens: &[ShapeToken<'_>], expected: &str) -> bool {
    let mut depth = 0usize;
    for token in tokens {
        match token.kind {
            ShapeTokenKind::Open => depth += 1,
            ShapeTokenKind::Close => depth = depth.saturating_sub(1),
            ShapeTokenKind::Word(word)
                if depth == 0 && word.eq_ignore_ascii_case(expected.as_bytes()) =>
            {
                return true;
            }
            _ => {}
        }
    }
    false
}

fn skip_search_clause(tokens: &[ShapeToken<'_>], mut pos: usize) -> Option<usize> {
    if !shape_word(tokens.get(pos), "search") {
        return Some(pos);
    }
    pos += 1;
    if !(shape_word(tokens.get(pos), "breadth") || shape_word(tokens.get(pos), "depth")) {
        return None;
    }
    pos += 1;
    if !shape_word(tokens.get(pos), "first") {
        return None;
    }
    pos += 1;
    if !shape_word(tokens.get(pos), "by") {
        return None;
    }
    pos += 1;
    while pos < tokens.len() && !shape_word(tokens.get(pos), "set") {
        pos += 1;
    }
    if !shape_word(tokens.get(pos), "set") || !shape_ident(tokens.get(pos + 1)) {
        return None;
    }
    Some(pos + 2)
}

fn skip_cycle_clause(tokens: &[ShapeToken<'_>], mut pos: usize) -> Option<usize> {
    if !shape_word(tokens.get(pos), "cycle") {
        return Some(pos);
    }
    pos += 1;
    while pos < tokens.len() && !shape_word(tokens.get(pos), "set") {
        pos += 1;
    }
    if !shape_word(tokens.get(pos), "set") || !shape_ident(tokens.get(pos + 1)) {
        return None;
    }
    pos += 2;
    while pos < tokens.len() && !shape_word(tokens.get(pos), "using") {
        pos += 1;
    }
    if !shape_word(tokens.get(pos), "using") || !shape_ident(tokens.get(pos + 1)) {
        return None;
    }
    Some(pos + 2)
}

fn body_modifies(tokens: &[ShapeToken<'_>], nesting: usize) -> bool {
    if nesting > 64 {
        return true;
    }
    if shape_word(tokens.first(), "with") {
        return parse_with_tokens(tokens, nesting + 1).is_none_or(|shape| {
            shape.modifying_cte
                || shape.main_select_into
                || matches!(
                    shape.main.as_str(),
                    "insert" | "update" | "delete" | "merge"
                )
        });
    }
    matches!(
        tokens.first().map(|t| t.kind),
        Some(ShapeTokenKind::Word(word))
            if ["insert", "update", "delete", "merge"]
                .iter()
                .any(|candidate| word.eq_ignore_ascii_case(candidate.as_bytes()))
    ) || (shape_word(tokens.first(), "select") && top_level_shape_word(&tokens[1..], "into"))
}

fn main_shape(
    tokens: &[ShapeToken<'_>],
    pos: usize,
    modifying_cte: bool,
    nesting: usize,
) -> Option<WithShape> {
    if nesting > 64 {
        return None;
    }
    if matches!(tokens.get(pos)?.kind, ShapeTokenKind::Open) {
        let close = close_group(tokens, pos)?;
        if shape_word(tokens.get(pos + 1), "with") {
            let mut shape = parse_with_tokens(&tokens[pos + 1..close], nesting + 1)?;
            shape.modifying_cte |= modifying_cte;
            return Some(shape);
        }
        return main_shape(&tokens[pos + 1..close], 0, modifying_cte, nesting + 1);
    }
    let ShapeTokenKind::Word(word) = tokens.get(pos)?.kind else {
        return None;
    };
    let main = String::from_utf8_lossy(word).to_ascii_lowercase();
    if !WITH_MAIN_WORDS.contains(&main.as_str()) {
        return None;
    }
    let main_select_into = main == "select" && top_level_shape_word(&tokens[pos + 1..], "into");
    Some(WithShape {
        main,
        modifying_cte,
        main_select_into,
    })
}

fn parse_with_tokens(tokens: &[ShapeToken<'_>], nesting: usize) -> Option<WithShape> {
    if nesting > 64 || !shape_word(tokens.first(), "with") {
        return None;
    }
    let mut pos = 1usize;
    if shape_word(tokens.get(pos), "recursive") {
        pos += 1;
    }
    let mut modifying_cte = false;
    loop {
        // cte_name [(columns)] [USING KEY (columns)] AS [NOT] MATERIALIZED (query)
        if !shape_ident(tokens.get(pos)) {
            return None;
        }
        pos += 1;
        if matches!(tokens.get(pos).map(|t| t.kind), Some(ShapeTokenKind::Open)) {
            pos = close_group(tokens, pos)? + 1;
        }
        if shape_word(tokens.get(pos), "using") {
            pos += 1;
            if !shape_word(tokens.get(pos), "key") {
                return None;
            }
            pos += 1;
            pos = close_group(tokens, pos)? + 1;
        }
        if !shape_word(tokens.get(pos), "as") {
            return None;
        }
        pos += 1;
        if shape_word(tokens.get(pos), "not") {
            pos += 1;
            if !shape_word(tokens.get(pos), "materialized") {
                return None;
            }
            pos += 1;
        } else if shape_word(tokens.get(pos), "materialized") {
            pos += 1;
        }
        let close = close_group(tokens, pos)?;
        modifying_cte |= body_modifies(&tokens[pos + 1..close], nesting);
        pos = close + 1;

        pos = skip_search_clause(tokens, pos)?;
        pos = skip_cycle_clause(tokens, pos)?;
        if matches!(tokens.get(pos).map(|t| t.kind), Some(ShapeTokenKind::Comma)) {
            pos += 1;
            continue;
        }
        return main_shape(tokens, pos, modifying_cte, nesting);
    }
}

/// Which T-SQL windowing form can page one read statement.
///
/// SQL Server has no `LIMIT` and no server-side cursor here: paging is
/// `OFFSET n ROWS FETCH NEXT m ROWS ONLY`, which the grammar only accepts after an
/// `ORDER BY`. Wrapping the statement as a derived table is not an option either —
/// T-SQL rejects `WITH` and a bare `ORDER BY` inside one — so Tusk appends the clause
/// to the statement itself and picks the form from its top-level shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MsSqlPaging {
    /// A top-level `ORDER BY` already exists: append `OFFSET/FETCH` and keep that order.
    Append,
    /// Nothing to order by: append `ORDER BY (SELECT NULL)` too. Row order is then
    /// engine-defined across pages, exactly like MySQL's `LIMIT/OFFSET` without an order.
    OrderNull,
    /// Appending would be a syntax or semantic error — `TOP` conflicts with `OFFSET`,
    /// the statement already has its own `OFFSET`/`FETCH`, `FOR XML|JSON`/`OPTION` must
    /// stay last, and an unordered `UNION`/`EXCEPT`/`INTERSECT` rejects
    /// `ORDER BY (SELECT NULL)`. The driver reads such a statement once, under the
    /// ordinary result budget, instead of paging it wrongly.
    Buffered,
}

pub fn mssql_paging(sql: &str) -> MsSqlPaging {
    let Some(tokens) = shape_tokens(
        effective_start_for(sql, TransactionEngine::MsSql),
        TransactionEngine::MsSql,
    ) else {
        return MsSqlPaging::Buffered;
    };
    let mut depth = 0usize;
    let mut order_by = false;
    let mut set_operation = false;
    let mut blocked = false;
    let mut after_order = false;
    for token in &tokens {
        match token.kind {
            ShapeTokenKind::Open => {
                depth += 1;
                after_order = false;
            }
            ShapeTokenKind::Close => {
                depth = depth.saturating_sub(1);
                after_order = false;
            }
            ShapeTokenKind::Word(word) if depth == 0 => {
                let is = |candidate: &str| word.eq_ignore_ascii_case(candidate.as_bytes());
                if after_order && is("by") {
                    order_by = true;
                }
                after_order = is("order");
                if is("top") || is("offset") || is("fetch") || is("for") || is("option") {
                    blocked = true;
                }
                if is("union") || is("except") || is("intersect") {
                    set_operation = true;
                }
            }
            _ => after_order = false,
        }
    }
    if blocked || (set_operation && !order_by) {
        MsSqlPaging::Buffered
    } else if order_by {
        MsSqlPaging::Append
    } else {
        MsSqlPaging::OrderNull
    }
}

pub fn with_shape(sql: &str, engine: TransactionEngine) -> Option<WithShape> {
    let tokens = shape_tokens(effective_start_for(sql, engine), engine)?;
    parse_with_tokens(&tokens, 0)
}

/// True when an unquoted `INTO` occurs at the statement's outer query level.
/// Used to keep `SELECT … INTO` off both cursor and no-confirm execution paths.
pub fn has_top_level_into(sql: &str, engine: TransactionEngine) -> bool {
    shape_tokens(effective_start_for(sql, engine), engine)
        .is_none_or(|tokens| top_level_shape_word(&tokens, "into"))
}

fn is_copy_from_stdin(sql: &str) -> bool {
    if first_word(sql) != "copy" {
        return false;
    }
    let mut saw_from = false;
    scan_code_words(sql, TransactionEngine::Postgres, |word, depth| {
        if depth != 0 {
            return false;
        }
        if saw_from && word.eq_ignore_ascii_case(b"stdin") {
            return true;
        }
        saw_from = word.eq_ignore_ascii_case(b"from");
        false
    })
}

pub(crate) async fn copy_in_text(client: &Client, stmt: &str, data: &str) -> Result<u64, AppError> {
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
    if has_txn_control(items) {
        return Err(AppError::new(
            "transaction-control statements are not supported. Run the statements as one script without BEGIN/COMMIT.",
        ));
    }
    let mut stmts = 0u64;
    let mut copied = 0u64;
    client.batch_execute("BEGIN").await?;
    for item in items {
        let res: Result<(), AppError> = match item {
            Item::Sql(s) => {
                if read_only && !is_read(s) {
                    Err(AppError::new(
                        "connection is read-only. The script contains writes.",
                    ))
                } else {
                    client.batch_execute(s).await.map_err(AppError::from)
                }
            }
            Item::Copy { stmt, data } => {
                if read_only {
                    Err(AppError::new("connection is read-only. COPY is blocked."))
                } else {
                    copy_in_text(client, stmt, data).await.map(|n| copied += n)
                }
            }
        };
        if let Err(e) = res {
            let _ = client.batch_execute("ROLLBACK").await;
            return Err(AppError::new(format!(
                "{} (at statement {}: {})",
                e.message,
                stmts + 1,
                snippet(item)
            )));
        }
        stmts += 1;
    }
    client.batch_execute("COMMIT").await.map_err(|e| {
        AppError::new(format!(
            "commit acknowledgement failed; transaction outcome is unknown — verify database state before retrying ({e})"
        ))
    })?;
    Ok(format!("{stmts} statements run, {copied} rows copied"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn with_shape_finds_the_statement_the_ctes_feed() {
        use super::with_shape;
        let shape =
            |s: &str| with_shape(s, TransactionEngine::Postgres).map(|w| (w.main, w.modifying_cte));
        assert_eq!(shape("SELECT 1"), None);
        assert_eq!(
            shape("WITH x AS (SELECT 1) SELECT * FROM x"),
            Some(("select".into(), false))
        );
        assert_eq!(
            shape("-- note\nWITH RECURSIVE t(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM t WHERE n < 5) TABLE t"),
            Some(("table".into(), false))
        );
        assert_eq!(
            shape("WITH bnr AS (SELECT id FROM vendor), good AS (SELECT 1) UPDATE pvl SET a = NULL FROM good g WHERE 1=1"),
            Some(("update".into(), false))
        );
        assert_eq!(
            shape("WITH g AS (SELECT 1) INSERT INTO t SELECT * FROM g"),
            Some(("insert".into(), false))
        );
        assert_eq!(
            shape("WITH g AS (SELECT 1) DELETE FROM t USING g"),
            Some(("delete".into(), false))
        );
        assert_eq!(
            shape("WITH g AS (SELECT 1) MERGE INTO t USING g ON 1=1 WHEN MATCHED THEN DELETE"),
            Some(("merge".into(), false))
        );
        // Non-reserved words as CTE names are names, not the main statement.
        assert_eq!(
            shape(
                "WITH update AS (SELECT 1), delete(a) AS (SELECT 2) SELECT * FROM update, delete"
            ),
            Some(("select".into(), false))
        );
        // Data-modifying CTE bodies, including NOT MATERIALIZED, are flagged.
        assert_eq!(
            shape("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"),
            Some(("select".into(), true))
        );
        assert_eq!(
            shape("WITH d AS NOT MATERIALIZED (UPDATE t SET a=1 RETURNING *) SELECT * FROM d"),
            Some(("select".into(), true))
        );
        // Keywords inside strings/comments/quoted identifiers are invisible.
        assert_eq!(
            shape("WITH x AS (SELECT 'update' /* delete */ AS \"insert\") SELECT * FROM x"),
            Some(("select".into(), false))
        );
        // Parenthesised main statement.
        assert_eq!(
            shape("WITH x AS (SELECT 1) (SELECT * FROM x) UNION (SELECT 2)"),
            Some(("select".into(), false))
        );
        assert_eq!(shape("WITH x AS (SELECT 1)"), None);
        assert_eq!(
            shape("WITH x AS (SELECT 1) SELECT 1 AS ordinal FROM x"),
            Some(("select".into(), false))
        );
        assert_eq!(
            shape(
                "WITH RECURSIVE t(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM t WHERE n<2) SEARCH DEPTH FIRST BY n SET \"select\" UPDATE \"target\" AS u SET n=2"
            ),
            Some(("update".into(), false))
        );
        assert_eq!(
            shape(
                "WITH RECURSIVE t(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM t WHERE n<2) SEARCH DEPTH FIRST BY n SET update SELECT n FROM t"
            ),
            Some(("select".into(), false))
        );
        assert_eq!(
            shape(
                "WITH RECURSIVE t(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM t WHERE n<2) CYCLE n SET is_cycle USING update SELECT n FROM t"
            ),
            Some(("select".into(), false))
        );
        assert_eq!(
            shape("WITH RECURSIVE update(i) USING KEY(i) AS (VALUES (1)) SELECT * FROM update"),
            Some(("select".into(), false))
        );
        assert_eq!(
            shape("WITH 測試 AS (SELECT 1) SELECT * FROM 測試"),
            Some(("select".into(), false))
        );
        assert_eq!(
            shape("WITH cte$name AS (SELECT 1) SELECT * FROM cte$name"),
            Some(("select".into(), false))
        );
        assert!(with_shape(
            "WITH x AS (SELECT 1) SELECT * INTO archived FROM x",
            TransactionEngine::Postgres,
        )
        .is_some_and(|shape| shape.main_select_into));
    }

    use super::*;

    #[test]
    fn checked_parser_rejects_psql_meta_commands() {
        let err = parse("\\connect other\nSELECT 1;").err().unwrap();
        assert!(err.message.contains("psql meta-command"));
        let err = parse("SELECT 1;\n  \\copy t from stdin\n").err().unwrap();
        assert!(err.message.contains("psql meta-command"));
        let err = parse("-- dump preamble\n/* generated */\n\\restrict token\nSELECT 1;")
            .err()
            .unwrap();
        assert!(err.message.contains("psql meta-command"));
    }

    #[test]
    fn copy_crlf_terminator_is_recognized_and_normalized() {
        let items =
            parse("COPY t FROM stdin WITH (FORMAT text);\r\n1\talpha\r\n2\tbeta\r\n\\.\r\n")
                .unwrap();
        match items.as_slice() {
            [Item::Copy { data, .. }] => assert_eq!(data, "1\talpha\n2\tbeta\n"),
            _ => panic!("expected one COPY item"),
        }

        // FROM inside a COPY query is nested and must not turn COPY TO into inline data.
        let query = parse("COPY (SELECT * FROM stdin) TO STDOUT;").unwrap();
        assert!(matches!(query.as_slice(), [Item::Sql(_)]));
    }

    #[test]
    fn checked_parser_rejects_unterminated_copy_before_execution() {
        for sql in ["COPY t FROM stdin;\n1\tx\n", "COPY t FROM stdin"] {
            let err = parse(sql).err().unwrap();
            assert!(err.message.contains("COPY FROM stdin"), "{err:?}");
        }
    }

    #[test]
    fn mysql_executable_comment_scan_skips_ordinary_comments() {
        assert!(contains_mysql_executable_comment("SELECT 1 /*!50000 x */"));
        assert!(contains_mysql_executable_comment(
            "SELECT 1 /*M!100100 x */"
        ));
        assert!(!contains_mysql_executable_comment("SELECT 1 -- /*! note"));
        assert!(!contains_mysql_executable_comment("SELECT 1 # /*! note"));
        assert!(!contains_mysql_executable_comment(
            "SELECT 1 /* /*! dead */"
        ));
        assert!(!contains_mysql_executable_comment("SELECT '/*! text */'"));
        // `--` without trailing whitespace is an expression in MySQL, not a comment.
        assert!(contains_mysql_executable_comment("SELECT 1--/*!50000 x*/"));
        // A real executable comment after an ordinary one still trips the scan.
        assert!(contains_mysql_executable_comment(
            "SELECT 1 -- note\n/*!50000 UNION SELECT 2 */"
        ));
    }

    #[test]
    fn mysql_temporary_tables_do_not_implicitly_commit() {
        assert!(!is_mysql_implicit_commit(
            "CREATE TEMPORARY TABLE tmp (id INT)"
        ));
        assert!(!is_mysql_implicit_commit("DROP TEMPORARY TABLE tmp"));
        assert!(is_mysql_implicit_commit("CREATE TABLE t (id INT)"));
        assert!(is_mysql_implicit_commit("DROP TABLE t"));
        assert!(is_mysql_implicit_commit("TRUNCATE TABLE t"));
    }

    #[test]
    fn transaction_control_detection_covers_session_forms() {
        for sql in [
            "BEGIN",
            "START TRANSACTION",
            "COMMIT",
            "ROLLBACK TO s",
            "SAVEPOINT s",
            "RELEASE SAVEPOINT s",
            "PREPARE TRANSACTION 'x'",
            "SET TRANSACTION READ ONLY",
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY",
        ] {
            assert!(is_txn_control_stmt(sql), "missed {sql}");
        }
        assert!(!is_txn_control_stmt("SET search_path TO public"));
        assert!(!is_txn_control_stmt("PREPARE q AS SELECT 1"));
        assert!(!is_txn_control_stmt(
            "SET search_path TO public /* transaction */"
        ));
        assert!(!is_txn_control_stmt("SET application_name = 'autocommit'"));
    }

    #[test]
    fn engine_splitter_keeps_mysql_comments_escapes_and_identifiers_inert() {
        let mysql = TransactionEngine::MySql;
        for sql in [
            "BEGIN;\nSELECT 1; # ; COMMIT;\nROLLBACK;",
            "BEGIN; SELECT 'x''; COMMIT; hidden'; ROLLBACK;",
            "BEGIN; SELECT `a;COMMIT` FROM t; ROLLBACK;",
            "BEGIN; SELECT 1--2; ROLLBACK;",
        ] {
            let items = parse_for_engine(sql, mysql).unwrap();
            let actions =
                preflight_transactions(&items, mysql, &TransactionStatus::default()).unwrap();
            assert_eq!(actions.len(), 3, "split changed for {sql}");
            assert_eq!(actions[0], Some(TransactionAction::Begin));
            assert_eq!(actions[1], None, "comment/string became control for {sql}");
            assert_eq!(actions[2], Some(TransactionAction::Rollback));
        }

        let ambiguous = parse_for_engine(r"SELECT 'x\'; COMMIT; hidden'", mysql)
            .err()
            .unwrap();
        assert!(ambiguous.message.contains("NO_BACKSLASH_ESCAPES"));

        let savepoint = parse_for_engine(
            "BEGIN; SAVEPOINT `s;COMMIT`; ROLLBACK TO SAVEPOINT `s;COMMIT`; ROLLBACK;",
            mysql,
        )
        .unwrap();
        let actions =
            preflight_transactions(&savepoint, mysql, &TransactionStatus::default()).unwrap();
        assert_eq!(
            actions,
            vec![
                Some(TransactionAction::Begin),
                Some(TransactionAction::Savepoint),
                Some(TransactionAction::RollbackTo),
                Some(TransactionAction::Rollback),
            ]
        );

        // PostgreSQL does not treat a backslash as a quote escape in a standard string.
        let pg = parse(r"BEGIN; SELECT '\'; COMMIT;").unwrap();
        assert_eq!(pg.len(), 3);
    }

    #[test]
    fn engine_splitter_handles_tsql_brackets_nested_comments_and_go() {
        let mssql = TransactionEngine::MsSql;
        let sql_of = |items: &[Item]| {
            items
                .iter()
                .map(|item| match item {
                    Item::Sql(sql) => sql.clone(),
                    Item::Copy { stmt, .. } => stmt.clone(),
                })
                .collect::<Vec<_>>()
        };

        // `;` and quotes inside a bracket identifier are part of the name.
        let items = parse_for_engine("SELECT [a;COMMIT] FROM [t]; SELECT 2;", mssql).unwrap();
        assert_eq!(
            sql_of(&items),
            vec!["SELECT [a;COMMIT] FROM [t]", "SELECT 2"]
        );
        // `]]` escapes a literal `]`.
        let escaped = parse_for_engine("SELECT [we]]ird]; SELECT 2;", mssql).unwrap();
        assert_eq!(sql_of(&escaped), vec!["SELECT [we]]ird]", "SELECT 2"]);

        // T-SQL block comments nest, so the inner `*/` must not end the outer comment.
        let nested =
            parse_for_engine("SELECT 1 /* a /* b */ ; DROP TABLE t; */ + 2", mssql).unwrap();
        assert_eq!(nested.len(), 1, "{:?}", sql_of(&nested));

        // GO is a client batch separator: a boundary that reaches no server.
        let batched = parse_for_engine("SELECT 1\nGO\nSELECT 2\ngo  -- trailing\n", mssql).unwrap();
        assert_eq!(sql_of(&batched), vec!["SELECT 1", "SELECT 2"]);
        assert_eq!(
            sql_of(&parse_for_engine("SELECT 1\nGO", mssql).unwrap()).len(),
            1
        );
        // `go` that is not alone on its line stays ordinary SQL.
        let alias = parse_for_engine("SELECT 1 AS go, 2", mssql).unwrap();
        assert_eq!(sql_of(&alias), vec!["SELECT 1 AS go, 2"]);
        // A repeat count would run the batch N times; refuse rather than run it once.
        assert!(parse_for_engine("SELECT 1\nGO 5\n", mssql)
            .err()
            .expect("GO with a repeat count is refused")
            .message
            .contains("repeat count"));

        // `GO` followed by a block comment is still a batch separator (it used to reach
        // the server as SQL: "Could not find stored procedure 'GO'").
        let commented =
            parse_for_engine("SELECT 1\nGO /* end of batch */\nSELECT 2\n", mssql).unwrap();
        assert_eq!(sql_of(&commented), vec!["SELECT 1", "SELECT 2"]);
        let both = parse_for_engine("SELECT 1\nGO /* x */ -- y\nSELECT 2\n", mssql).unwrap();
        assert_eq!(sql_of(&both), vec!["SELECT 1", "SELECT 2"]);
        // An unterminated comment after GO is not a separator; the text stays SQL.
        let unterminated = parse_for_engine("SELECT 1\nGO /* never closed\n", mssql).unwrap();
        assert_eq!(unterminated.len(), 1);

        // `N'…'` is an ordinary string; `$` is not a dollar-quote opener in T-SQL.
        let literals = parse_for_engine("SELECT N'a;b', $100; SELECT 2;", mssql).unwrap();
        assert_eq!(sql_of(&literals), vec!["SELECT N'a;b', $100", "SELECT 2"]);
    }

    /// Identical fixtures live in `src/editor/lexer.test.ts` — the two lexers must
    /// agree on where a T-SQL statement ends.
    #[test]
    fn tsql_statement_blocks_are_not_split_at_their_own_semicolons() {
        let mssql = TransactionEngine::MsSql;
        let sql_of = |items: &[Item]| {
            items
                .iter()
                .map(|item| match item {
                    Item::Sql(sql) => sql.clone(),
                    Item::Copy { stmt, .. } => stmt.clone(),
                })
                .collect::<Vec<_>>()
        };

        // A procedure body is ONE statement, not three syntax errors.
        let proc = parse_for_engine(
            "CREATE PROCEDURE dbo.p AS\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND",
            mssql,
        )
        .unwrap();
        assert_eq!(proc.len(), 1, "{:?}", sql_of(&proc));
        // TRY/CATCH and nested IF blocks.
        let try_catch = parse_for_engine(
            "BEGIN TRY\n  SELECT 1;\n  IF 1=1 BEGIN SELECT 2; END\nEND TRY\nBEGIN CATCH\n  SELECT ERROR_MESSAGE();\nEND CATCH",
            mssql,
        )
        .unwrap();
        assert_eq!(try_catch.len(), 1, "{:?}", sql_of(&try_catch));
        // CASE … END is a block too, but balances within the statement.
        let case = parse_for_engine(
            "SELECT CASE WHEN a = 1 THEN 'x' ELSE 'y' END FROM t; SELECT 2",
            mssql,
        )
        .unwrap();
        assert_eq!(case.len(), 2, "{:?}", sql_of(&case));
        // `BEGIN TRAN[SACTION]` opens a transaction, not a block: the `;` still splits.
        let tran = parse_for_engine("BEGIN TRANSACTION; SELECT 1; COMMIT", mssql).unwrap();
        assert_eq!(
            sql_of(&tran),
            vec!["BEGIN TRANSACTION", "SELECT 1", "COMMIT"]
        );
        let distributed =
            parse_for_engine("BEGIN DISTRIBUTED TRAN; SELECT 1; COMMIT", mssql).unwrap();
        assert_eq!(distributed.len(), 3, "{:?}", sql_of(&distributed));
        // `ended` is an identifier, not the END keyword.
        let identifier = parse_for_engine("SELECT ended FROM t; SELECT 2", mssql).unwrap();
        assert_eq!(identifier.len(), 2);
        // BEGIN/END inside a bracket, string or comment never counts.
        let quoted = parse_for_engine(
            "SELECT [begin], 'begin', /* begin */ 1 FROM t; SELECT 2",
            mssql,
        )
        .unwrap();
        assert_eq!(quoted.len(), 2, "{:?}", sql_of(&quoted));
        // GO closes an unbalanced block rather than gluing the rest of the file to it.
        let after_go = parse_for_engine("BEGIN\n SELECT 1;\nGO\nSELECT 2;", mssql).unwrap();
        assert_eq!(after_go.len(), 2, "{:?}", sql_of(&after_go));
        // Other engines are untouched: `BEGIN` there is transaction control.
        let pg = parse_for_engine("BEGIN; SELECT 1; COMMIT;", TransactionEngine::Postgres).unwrap();
        assert_eq!(pg.len(), 3);
    }

    /// Identical fixtures live in `src/editor/lexer.test.ts` — the two lexers must
    /// agree on where a SQLite trigger body ends.
    #[test]
    fn sqlite_trigger_bodies_are_not_split_at_their_own_semicolons() {
        let sqlite = TransactionEngine::Sqlite;
        let sql_of = |items: &[Item]| {
            items
                .iter()
                .map(|item| match item {
                    Item::Sql(sql) => sql.clone(),
                    Item::Copy { stmt, .. } => stmt.clone(),
                })
                .collect::<Vec<_>>()
        };

        // The rebuild path replays triggers verbatim: body `;` are not boundaries and
        // the closing `END` must stay inside the statement (a bare `END` is COMMIT).
        let trigger = parse_for_engine(
            "CREATE TRIGGER books_guard AFTER INSERT ON books BEGIN SELECT 1; UPDATE books SET n = 1; END;\nSELECT 2;",
            sqlite,
        )
        .unwrap();
        assert_eq!(
            sql_of(&trigger),
            vec![
                "CREATE TRIGGER books_guard AFTER INSERT ON books BEGIN SELECT 1; UPDATE books SET n = 1; END",
                "SELECT 2",
            ]
        );
        assert_eq!(
            transaction_action_for(&sql_of(&trigger)[0], sqlite).unwrap(),
            None
        );

        // TEMP / OR REPLACE headers, and a `CASE … END` inside the body.
        for head in [
            "CREATE TEMP TRIGGER t",
            "CREATE TEMPORARY TRIGGER t",
            "create trigger t",
        ] {
            let sql = format!(
                "{head} AFTER UPDATE ON x BEGIN SELECT CASE WHEN 1 THEN 2 ELSE 3 END; END; SELECT 9;"
            );
            let items = parse_for_engine(&sql, sqlite).unwrap();
            assert_eq!(items.len(), 2, "{head}: {:?}", sql_of(&items));
        }

        // A WHEN clause with its own CASE … END, before the body opens.
        let guarded = parse_for_engine(
            "CREATE TRIGGER t AFTER INSERT ON x WHEN (CASE WHEN 1 THEN 1 END) = 1 BEGIN DELETE FROM y; END; SELECT 9;",
            sqlite,
        )
        .unwrap();
        assert_eq!(guarded.len(), 2, "{:?}", sql_of(&guarded));

        // BEGIN/END inside a string, a quoted identifier or a comment never counts.
        let quoted = parse_for_engine(
            "CREATE TRIGGER t AFTER INSERT ON x BEGIN INSERT INTO y VALUES ('end;'), (\"end\"), (`end`); -- end\n END; SELECT 9;",
            sqlite,
        )
        .unwrap();
        assert_eq!(quoted.len(), 2, "{:?}", sql_of(&quoted));

        // Outside a trigger, SQLite `BEGIN`/`END` remain transaction control and the
        // `;` still splits — `appended` is an identifier, not the END keyword.
        let txn = parse_for_engine("BEGIN; SELECT appended FROM t; END;", sqlite).unwrap();
        assert_eq!(sql_of(&txn), vec!["BEGIN", "SELECT appended FROM t", "END"]);
        assert_eq!(
            transaction_action_for("END", sqlite).unwrap(),
            Some(TransactionAction::Commit)
        );
        // A non-trigger CREATE never opens a block.
        let table = parse_for_engine("CREATE TABLE t (a INT); SELECT 1;", sqlite).unwrap();
        assert_eq!(table.len(), 2, "{:?}", sql_of(&table));
        // Other engines are untouched: a SQLite-shaped trigger on Postgres still splits.
        let pg = parse_for_engine(
            "CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END;",
            TransactionEngine::Postgres,
        )
        .unwrap();
        assert_eq!(pg.len(), 2);
    }

    #[test]
    fn tsql_named_transaction_rollback_ends_the_unit() {
        let mssql = TransactionEngine::MsSql;
        let idle = TransactionStatus::default();
        // `ROLLBACK TRAN work` after `BEGIN TRAN work` ends the whole transaction; it
        // used to be classified as a savepoint rollback and refused by preflight.
        let named = parse_for_engine(
            "BEGIN TRANSACTION work; SELECT 1; ROLLBACK TRANSACTION work;",
            mssql,
        )
        .unwrap();
        assert_eq!(
            preflight_transactions(&named, mssql, &idle).unwrap(),
            vec![
                Some(TransactionAction::Begin),
                None,
                Some(TransactionAction::Rollback),
            ]
        );
        // A savepoint of the same shape still rolls back to the savepoint.
        let savepoint = parse_for_engine(
            "BEGIN TRAN work; SAVE TRAN s; ROLLBACK TRAN s; COMMIT;",
            mssql,
        )
        .unwrap();
        assert_eq!(
            preflight_transactions(&savepoint, mssql, &idle).unwrap()[2],
            Some(TransactionAction::RollbackTo)
        );
        // A name that is neither says so, instead of "unknown savepoint".
        let neither = parse_for_engine("BEGIN TRAN work; ROLLBACK TRAN other;", mssql).unwrap();
        let error = preflight_transactions(&neither, mssql, &idle).unwrap_err();
        assert!(error.message.contains("names neither"), "{}", error.message);
    }

    #[test]
    fn tsql_transaction_vocabulary_is_recognized_and_bounded() {
        let mssql = TransactionEngine::MsSql;
        let action = |sql: &str| transaction_action_for(sql, mssql).unwrap();
        assert_eq!(action("BEGIN TRANSACTION"), Some(TransactionAction::Begin));
        assert_eq!(action("BEGIN TRAN"), Some(TransactionAction::Begin));
        // A bare BEGIN/END opens and closes a statement block, not a transaction.
        assert_eq!(action("BEGIN"), None);
        assert_eq!(action("END"), None);
        assert_eq!(action("COMMIT"), Some(TransactionAction::Commit));
        assert_eq!(
            action("COMMIT TRANSACTION"),
            Some(TransactionAction::Commit)
        );
        assert_eq!(action("ROLLBACK"), Some(TransactionAction::Rollback));
        assert_eq!(
            action("ROLLBACK TRANSACTION"),
            Some(TransactionAction::Rollback)
        );
        // A named ROLLBACK TRANSACTION targets a savepoint.
        assert_eq!(
            action("ROLLBACK TRANSACTION [s]"),
            Some(TransactionAction::RollbackTo)
        );
        assert_eq!(
            action("SAVE TRANSACTION [s]"),
            Some(TransactionAction::Savepoint)
        );
        assert!(transaction_action_for("SAVE TRANSACTION", mssql).is_err());
        assert!(
            transaction_action_for("SET IMPLICIT_TRANSACTIONS ON", mssql)
                .unwrap_err()
                .message
                .contains("IMPLICIT_TRANSACTIONS")
        );

        let idle = TransactionStatus::default();
        let savepoints = parse_for_engine(
            "BEGIN TRANSACTION; SAVE TRANSACTION [a;b]; ROLLBACK TRANSACTION [a;b]; COMMIT;",
            mssql,
        )
        .unwrap();
        assert_eq!(
            preflight_transactions(&savepoints, mssql, &idle).unwrap(),
            vec![
                Some(TransactionAction::Begin),
                Some(TransactionAction::Savepoint),
                Some(TransactionAction::RollbackTo),
                Some(TransactionAction::Commit),
            ]
        );
        for (sql, needle) in [
            (
                "BEGIN TRANSACTION; SAVE TRANSACTION s; RELEASE SAVEPOINT s; COMMIT;",
                "RELEASE SAVEPOINT",
            ),
            (
                "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
                "SET TRANSACTION",
            ),
            ("BEGIN TRANSACTION; USE other; COMMIT;", "indirectly"),
            ("BEGIN TRANSACTION; EXEC dbo.p; COMMIT;", "indirectly"),
            ("BEGIN TRANSACTION; BEGIN TRANSACTION;", "nested"),
        ] {
            let items = parse_for_engine(sql, mssql).unwrap();
            let error = preflight_transactions(&items, mssql, &idle).unwrap_err();
            assert!(error.message.contains(needle), "{sql}: {}", error.message);
        }
    }

    #[test]
    fn tsql_paging_form_follows_the_statement_shape() {
        use MsSqlPaging::*;
        assert_eq!(mssql_paging("SELECT a FROM t"), OrderNull);
        assert_eq!(mssql_paging("SELECT a FROM t ORDER BY a"), Append);
        // Ordering inside a window function or subquery is not the statement's own.
        assert_eq!(
            mssql_paging("SELECT ROW_NUMBER() OVER (ORDER BY a) FROM t"),
            OrderNull
        );
        assert_eq!(
            mssql_paging("SELECT * FROM (SELECT a FROM t ORDER BY a OFFSET 0 ROWS) x"),
            OrderNull
        );
        // Forms that cannot take an appended OFFSET/FETCH read in one page instead.
        for sql in [
            "SELECT TOP 5 a FROM t",
            "SELECT a FROM t ORDER BY a OFFSET 5 ROWS FETCH NEXT 5 ROWS ONLY",
            "SELECT a FROM t FOR JSON AUTO",
            "SELECT a FROM t OPTION (RECOMPILE)",
            "SELECT a FROM t UNION SELECT b FROM u",
        ] {
            assert_eq!(mssql_paging(sql), Buffered, "{sql}");
        }
        // A set operation that already carries an ORDER BY pages by appending.
        assert_eq!(
            mssql_paging("SELECT a FROM t UNION SELECT b FROM u ORDER BY 1"),
            Append
        );
        // A CTE-led read pages like any other statement (T-SQL forbids wrapping it).
        assert_eq!(
            mssql_paging("WITH c AS (SELECT a FROM t) SELECT * FROM c"),
            OrderNull
        );
    }

    #[test]
    fn transaction_preflight_rejects_late_lifecycle_errors_before_execution() {
        let idle = TransactionStatus::default();
        for sql in [
            "BEGIN; BEGIN;",
            "BEGIN; COMMIT; COMMIT;",
            "SAVEPOINT s;",
            "BEGIN; RELEASE;",
            "BEGIN; INSERT INTO t VALUES (1); ROLLBACK TO missing;",
            "BEGIN; SAVEPOINT s; RELEASE missing; COMMIT;",
            "BEGIN; COMMIT AND CHAIN;",
            "BEGIN; ROLLBACK TO SAVEPOINT;",
            "BEGIN; ROLLBACK WORK TO SAVEPOINT;",
            "BEGIN; COMMIT PREPARED 'other';",
            "BEGIN; ROLLBACK PREPARED 'other';",
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY; SELECT 1;",
            "BEGIN; INSERT INTO t VALUES (1); SET TRANSACTION READ ONLY; ROLLBACK;",
        ] {
            let items = parse(sql).unwrap();
            assert!(
                preflight_transactions(&items, TransactionEngine::Postgres, &idle).is_err(),
                "accepted {sql}"
            );
        }
    }

    #[test]
    fn transaction_preflight_models_self_contained_and_engine_limits() {
        let idle = TransactionStatus::default();
        let items = parse("BEGIN; SAVEPOINT s; SELECT 1; ROLLBACK TO s; COMMIT;").unwrap();
        let actions = preflight_transactions(&items, TransactionEngine::Postgres, &idle).unwrap();
        assert_eq!(actions[0], Some(TransactionAction::Begin));
        assert_eq!(actions[4], Some(TransactionAction::Commit));

        let savepoint = parse("BEGIN; SAVEPOINT s; COMMIT;").unwrap();
        let err = preflight_transactions(&savepoint, TransactionEngine::DuckDb, &idle).unwrap_err();
        assert!(err.message.contains("savepoints"));
        let set = parse("BEGIN; SET TRANSACTION READ ONLY; COMMIT;").unwrap();
        let err = preflight_transactions(&set, TransactionEngine::Sqlite, &idle).unwrap_err();
        assert!(err.message.contains("SET TRANSACTION"));

        let sqlite =
            parse("BEGIN; SAVEPOINT s; ROLLBACK TRANSACTION TO SAVEPOINT s; COMMIT").unwrap();
        let actions = preflight_transactions(&sqlite, TransactionEngine::Sqlite, &idle).unwrap();
        assert_eq!(actions[2], Some(TransactionAction::RollbackTo));

        let failed = TransactionStatus {
            state: TransactionState::Failed,
            mode: TransactionMode::Explicit,
            ..TransactionStatus::default()
        };
        let commit = parse("COMMIT").unwrap();
        let err =
            preflight_transactions(&commit, TransactionEngine::Postgres, &failed).unwrap_err();
        assert!(err.message.contains("ROLLBACK"));
    }

    #[test]
    fn mysql_preflight_blocks_implicit_commit_inside_manual_mode() {
        let idle = TransactionStatus::default();
        let items =
            parse("START TRANSACTION; INSERT INTO t VALUES (1); ALTER TABLE t ADD x INT; COMMIT;")
                .unwrap();
        let err = preflight_transactions(&items, TransactionEngine::MySql, &idle).unwrap_err();
        assert!(err.message.contains("implicitly commit"));

        let configured =
            parse("SET TRANSACTION ISOLATION LEVEL READ COMMITTED; START TRANSACTION; COMMIT;")
                .unwrap();
        assert!(preflight_transactions(&configured, TransactionEngine::MySql, &idle).is_ok());

        for sql in [
            "START TRANSACTION; CALL can_commit(); COMMIT;",
            "START TRANSACTION; EXECUTE prepared_ddl; COMMIT;",
            "START TRANSACTION; XA START 'other'; COMMIT;",
            "START TRANSACTION; CLONE LOCAL DATA DIRECTORY = '/tmp/x'; COMMIT;",
            "START TRANSACTION; RESTART; COMMIT;",
            "START TRANSACTION; SELECT 1 /*! COMMIT */; COMMIT;",
            "START TRANSACTION; SELECT 1 /*M! COMMIT */; COMMIT;",
        ] {
            let items = parse_for_engine(sql, TransactionEngine::MySql).unwrap();
            assert!(
                preflight_transactions(&items, TransactionEngine::MySql, &idle).is_err(),
                "accepted MySQL transaction escape: {sql}"
            );
        }

        let explicit = TransactionStatus {
            state: TransactionState::Active,
            mode: TransactionMode::Explicit,
            ..TransactionStatus::default()
        };
        let autocommit_on = parse("SET autocommit=1").unwrap();
        let err = preflight_transactions(&autocommit_on, TransactionEngine::MySql, &explicit)
            .unwrap_err();
        assert!(err.message.contains("COMMIT or ROLLBACK"));

        for sql in [
            "SET GLOBAL autocommit=0",
            "SET PERSIST autocommit=0",
            "SET SESSION TRANSACTION READ WRITE",
        ] {
            let items = parse_for_engine(sql, TransactionEngine::MySql).unwrap();
            assert!(preflight_transactions(&items, TransactionEngine::MySql, &idle).is_err());
        }

        // Merely reading or naming autocommit is ordinary SET, not lifecycle control.
        for sql in [
            "SET @saved_autocommit = @@autocommit",
            "SET application_name = 'autocommit'",
        ] {
            assert_eq!(transaction_action(sql).unwrap(), None);
        }
    }

    #[test]
    fn code_word_scanner_masks_values_but_sees_quoted_identifiers() {
        assert!(!contains_code_word(
            "SELECT 'set_config', $$set_config$$ -- set_config\n",
            "set_config"
        ));
        assert!(contains_code_word(
            "SELECT pg_catalog.\"set_config\"('x', 'y', false)",
            "set_config"
        ));
    }
}
