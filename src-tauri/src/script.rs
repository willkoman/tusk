use crate::db::{AppError, TransactionMode, TransactionState, TransactionStatus};
use bytes::Bytes;
use futures_util::SinkExt;
use tokio_postgres::Client;

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

/// Parse a SQL script for execution, respecting comments, quoted strings,
/// quoted identifiers, dollar-quoted bodies, and `COPY ... FROM stdin` data blocks.
/// psql meta-commands and unterminated COPY data are rejected instead of silently
/// disappearing or being sent to the server as partial input.
pub fn parse(script: &str) -> Result<Vec<Item>, AppError> {
    split_impl(script, true, TransactionEngine::Postgres)
}

/// Checked execution splitter with the connected engine's string/comment rules.
/// MySQL backslash escapes, `#` comments, and backtick identifiers must be handled
/// before transaction preflight or text inside them can become a separate command.
pub fn parse_for_engine(script: &str, engine: TransactionEngine) -> Result<Vec<Item>, AppError> {
    split_impl(script, true, engine)
}

/// Lenient splitter used by editor-only classification paths. Execution paths must
/// use `parse`, which reports unsupported psql commands and malformed COPY blocks.
pub fn split(script: &str) -> Vec<Item> {
    split_impl(script, false, TransactionEngine::Postgres).unwrap_or_default()
}

fn split_impl(
    script: &str,
    checked: bool,
    engine: TransactionEngine,
) -> Result<Vec<Item>, AppError> {
    let b = script.as_bytes();
    let n = b.len();
    let mut i = 0usize;
    let mut items: Vec<Item> = Vec::new();
    let mut cur: Vec<u8> = Vec::new();

    while i < n {
        let c = b[i];

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
                if engine == TransactionEngine::MySql
                    && b[i] == b'\\'
                    && i + 1 < n
                    && b[i + 1] == b'\''
                {
                    return Err(AppError::new(
                        "MySQL backslash-escaped quotes are ambiguous under NO_BACKSLASH_ESCAPES; use doubled quotes instead",
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
                        "MySQL backslash-escaped quotes are ambiguous under NO_BACKSLASH_ESCAPES; use doubled quotes instead",
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
                        "MySQL backslash-escaped identifier quotes are ambiguous; use doubled backticks instead",
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
                if checked && !terminated {
                    return Err(AppError::new(
                        "COPY FROM stdin data is missing the terminating `\\.` line",
                    ));
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
        if checked && is_copy_from_stdin(&last) {
            return Err(AppError::new(
                "COPY FROM stdin requires `;`, data rows, and a terminating `\\.` line",
            ));
        }
        items.push(Item::Sql(last));
    }
    Ok(items)
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

/// First alphabetic word after comments/whitespace, lowercased.
fn first_word(sql: &str) -> String {
    effective_start(sql)
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
    let b = effective_start(sql).as_bytes();
    let mut words = Vec::new();
    let mut i = 0usize;
    while i < b.len() {
        if b[i] == b'-' && i + 1 < b.len() && b[i + 1] == b'-' {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b[i] == b'#' {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b[i] == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(b.len());
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
pub fn transaction_action(sql: &str) -> Result<Option<TransactionAction>, AppError> {
    let words = statement_words(sql);
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
    items.iter().any(|it| {
        let s = match it {
            Item::Sql(s) => s.as_str(),
            Item::Copy { stmt, .. } => stmt.as_str(),
        };
        is_txn_control_stmt(s)
    })
}

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
    let mut actions = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        if engine == TransactionEngine::MySql
            && item_sql(item).is_some_and(contains_mysql_executable_comment)
        {
            return Err(AppError::new(format!(
                "statement {} contains a MySQL/MariaDB executable comment, which is blocked because it can hide transaction control",
                index + 1
            )));
        }
        let action = match item {
            Item::Sql(sql) => transaction_action(sql)?,
            Item::Copy { .. } => None,
        };
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
            && matches!(item, Item::Sql(sql) if action.is_none() && matches!(first_word(sql).as_str(), "call" | "execute" | "xa"))
        {
            return Err(AppError::new(format!(
                "statement {} can end or replace a MySQL transaction indirectly and is blocked inside a manual transaction",
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
                if !matches!(
                    engine,
                    TransactionEngine::Postgres
                        | TransactionEngine::Sqlite
                        | TransactionEngine::MySql
                ) {
                    return Err(AppError::new("ROLLBACK TO is not supported by DuckDB"));
                }
                if !matches!(state, TransactionState::Active | TransactionState::Failed) {
                    return Err(AppError::new("ROLLBACK TO requires an active transaction"));
                }
                let name = transaction_savepoint_name(item, TransactionAction::RollbackTo)
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
                if !matches!(
                    engine,
                    TransactionEngine::Postgres
                        | TransactionEngine::Sqlite
                        | TransactionEngine::MySql
                ) {
                    return Err(AppError::new("savepoints are not supported by DuckDB"));
                }
                if state != TransactionState::Active {
                    return Err(AppError::new(
                        "savepoint command requires a healthy active transaction",
                    ));
                }
                let action = action.expect("matched some above");
                let name = transaction_savepoint_name(item, action)
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

fn transaction_savepoint_name(item: &Item, action: TransactionAction) -> Option<String> {
    let Item::Sql(sql) = item else {
        return None;
    };
    let words = statement_words(sql);
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

fn scan_code_words(sql: &str, mut visit: impl FnMut(&[u8], usize) -> bool) -> bool {
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
        if b[i] == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(b.len());
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
    scan_code_words(sql, |word, _| word.eq_ignore_ascii_case(needle.as_bytes()))
}

/// The shape of a `WITH`-led statement: `main` is the lowercased keyword of the statement
/// its CTEs feed (`select`, `insert`, `update`, `delete`, `merge`, `table`, `values`, or
/// DuckDB's `from`/`pivot`), `modifying_cte` says whether any CTE body is itself a write
/// (`WITH d AS (DELETE … RETURNING *) SELECT …`). `None` when the text is not WITH-led
/// or no main statement is found (a parenthesised main `SELECT` is still recognised).
///
/// A CTE *name* is a depth-0 word followed by `AS` (past its optional column list);
/// PostgreSQL leaves `update`/`delete`/`insert` non-reserved, so `WITH update AS (…)`
/// must not be mistaken for the main statement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WithShape {
    pub main: String,
    pub modifying_cte: bool,
}

const WITH_MAIN_WORDS: &[&str] = &[
    "select", "insert", "update", "delete", "merge", "table", "values", "from", "pivot",
];

pub fn with_shape(sql: &str) -> Option<WithShape> {
    if first_word(sql) != "with" {
        return None;
    }
    let mut top: Vec<String> = Vec::new();
    let mut expect_body = false;
    let mut modifying_cte = false;
    let mut paren_main: Option<String> = None;
    let mut prev_depth = 0usize;
    scan_code_words(effective_start(sql), |word, depth| {
        let w = String::from_utf8_lossy(word).to_ascii_lowercase();
        if depth == 0 {
            expect_body = matches!(w.as_str(), "as" | "materialized");
            top.push(w);
        } else if prev_depth == 0 {
            // First word of a new top-level paren group.
            if expect_body {
                expect_body = false;
                if matches!(w.as_str(), "insert" | "update" | "delete" | "merge") {
                    modifying_cte = true;
                }
            } else if top.len() > 1
                && paren_main.is_none()
                && matches!(w.as_str(), "select" | "table" | "values")
            {
                // `WITH x AS (…) (SELECT …) UNION …` — main statement in parens.
                paren_main = Some(w);
            }
        }
        prev_depth = depth;
        false
    });
    let main = top
        .iter()
        .enumerate()
        .skip(1)
        .find(|(i, w)| {
            WITH_MAIN_WORDS.contains(&w.as_str())
                && top.get(i + 1).map(String::as_str) != Some("as")
        })
        .map(|(_, w)| w.clone())
        .or(paren_main)?;
    Some(WithShape {
        main,
        modifying_cte,
    })
}

fn is_copy_from_stdin(sql: &str) -> bool {
    if first_word(sql) != "copy" {
        return false;
    }
    let mut saw_from = false;
    scan_code_words(sql, |word, depth| {
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
            "transaction-control statements are not supported; run the statements as one script without BEGIN/COMMIT",
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
                        "connection is read-only — script contains writes",
                    ))
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
    client.batch_execute("COMMIT").await.map_err(|e| {
        AppError::new(format!(
            "commit acknowledgement failed; transaction outcome is unknown — verify database state before retrying ({e})"
        ))
    })?;
    Ok(format!("OK — {stmts} statements run, {copied} rows copied"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn with_shape_finds_the_statement_the_ctes_feed() {
        use super::with_shape;
        let shape = |s: &str| with_shape(s).map(|w| (w.main, w.modifying_cte));
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
