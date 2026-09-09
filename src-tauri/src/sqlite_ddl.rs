//! Minimal reader for the `CREATE TABLE` text SQLite stores in `sqlite_master`.
//!
//! SQLite's pragmas describe columns, keys, indexes and foreign keys, but they say
//! nothing about CHECK constraints, per-column `COLLATE`, generated columns or the
//! `WITHOUT ROWID` / `STRICT` table options. The Modify-table rebuild (create → copy →
//! drop → rename, `rebuildTable` in `src/sql/ddl.ts`) recreates the table from that
//! description, so anything invisible here is silently destroyed by a rebuild.
//!
//! This module reads the stored definition instead: table-level constraint clauses come
//! back VERBATIM (names included) so the rebuild can paste them straight back, and the
//! per-column extras come back as the pieces `columnDef` re-emits. When the text cannot
//! be parsed the caller reports that, and the dialog refuses to rebuild rather than
//! dropping what it could not read.

/// A column definition as written in the stored `CREATE TABLE`.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct ParsedColumn {
    pub name: String,
    /// `COLLATE <name>` — the collation token exactly as written.
    pub collate: Option<String>,
    /// The expression inside a column-level `CHECK (…)`.
    pub check: Option<String>,
    /// A generated column's full clause, e.g. `GENERATED ALWAYS AS (a + b) STORED`.
    pub generated: Option<String>,
    /// The `AUTOINCREMENT` keyword is present on THIS column (a token-level check —
    /// scanning the whole CREATE text matches column names and string literals too).
    pub autoincrement: bool,
}

/// One table-level constraint clause, verbatim.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedConstraint {
    /// `CONSTRAINT <name>` if the author gave one (SQLite does not expose it anywhere
    /// else — `PRAGMA index_list` reports `sqlite_autoindex_…`).
    pub name: Option<String>,
    /// primary_key | unique | check | foreign_key
    pub kind: &'static str,
    /// The whole clause, ready to paste into a rebuilt `CREATE TABLE`.
    pub clause: String,
    /// The constrained column names (empty for CHECK, and for anything not written as
    /// a plain column list).
    pub columns: Vec<String>,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct ParsedTable {
    pub columns: Vec<ParsedColumn>,
    pub constraints: Vec<ParsedConstraint>,
    /// `WITHOUT ROWID` / `STRICT` tail, verbatim (empty when there is none).
    pub options: String,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Word,
    Quoted,
    Str,
    Paren,
    Punct,
}

#[derive(Clone, Copy, Debug)]
struct Tok {
    start: usize,
    end: usize,
    kind: Kind,
}

/// Tokenize one SQLite statement fragment: words, quoted identifiers, string literals,
/// balanced parenthesized groups (as ONE token) and single punctuation characters.
/// Comments are skipped. Returns `None` on an unterminated quote or paren.
fn tokens(s: &str) -> Option<Vec<Tok>> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < b.len() {
        let c = b[i] as char;
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if c == '-' && b.get(i + 1) == Some(&b'-') {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && b.get(i + 1) == Some(&b'*') {
            let end = s[i + 2..].find("*/")?;
            i = i + 2 + end + 2;
            continue;
        }
        let start = i;
        match c {
            '\'' | '"' | '`' => {
                let q = b[i];
                i += 1;
                loop {
                    if i >= b.len() {
                        return None;
                    }
                    if b[i] == q {
                        if b.get(i + 1) == Some(&q) {
                            i += 2;
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    i += 1;
                }
                out.push(Tok {
                    start,
                    end: i,
                    kind: if c == '\'' { Kind::Str } else { Kind::Quoted },
                });
            }
            '[' => {
                let end = s[i..].find(']')?;
                i = i + end + 1;
                out.push(Tok {
                    start,
                    end: i,
                    kind: Kind::Quoted,
                });
            }
            '(' => {
                let mut depth = 0usize;
                loop {
                    if i >= b.len() {
                        return None;
                    }
                    match b[i] {
                        b'(' => {
                            depth += 1;
                            i += 1;
                        }
                        b')' => {
                            depth -= 1;
                            i += 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        b'\'' | b'"' | b'`' => {
                            let q = b[i];
                            i += 1;
                            loop {
                                if i >= b.len() {
                                    return None;
                                }
                                if b[i] == q {
                                    if b.get(i + 1) == Some(&q) {
                                        i += 2;
                                        continue;
                                    }
                                    i += 1;
                                    break;
                                }
                                i += 1;
                            }
                        }
                        b'-' if b.get(i + 1) == Some(&b'-') => {
                            while i < b.len() && b[i] != b'\n' {
                                i += 1;
                            }
                        }
                        b'/' if b.get(i + 1) == Some(&b'*') => {
                            let end = s[i + 2..].find("*/")?;
                            i = i + 2 + end + 2;
                        }
                        _ => i += 1,
                    }
                }
                out.push(Tok {
                    start,
                    end: i,
                    kind: Kind::Paren,
                });
            }
            _ if c.is_alphanumeric() || c == '_' || c == '$' || !c.is_ascii() => {
                while i < b.len() {
                    let ch = s[i..].chars().next().unwrap_or(' ');
                    if ch.is_alphanumeric() || ch == '_' || ch == '$' || !ch.is_ascii() {
                        i += ch.len_utf8();
                    } else {
                        break;
                    }
                }
                out.push(Tok {
                    start,
                    end: i,
                    kind: Kind::Word,
                });
            }
            _ => {
                i += 1;
                out.push(Tok {
                    start,
                    end: i,
                    kind: Kind::Punct,
                });
            }
        }
    }
    Some(out)
}

fn text<'a>(s: &'a str, t: &Tok) -> &'a str {
    &s[t.start..t.end]
}

/// Strip one layer of SQLite identifier quoting (`"x"`, `` `x` ``, `[x]`).
fn unquote(s: &str) -> String {
    let t = s.trim();
    let b = t.as_bytes();
    if b.len() >= 2 {
        match (b[0], b[b.len() - 1]) {
            (b'"', b'"') => return t[1..t.len() - 1].replace("\"\"", "\""),
            (b'`', b'`') => return t[1..t.len() - 1].replace("``", "`"),
            (b'[', b']') => return t[1..t.len() - 1].to_string(),
            _ => {}
        }
    }
    t.to_string()
}

fn eq_kw(s: &str, kw: &str) -> bool {
    s.eq_ignore_ascii_case(kw)
}

/// Split a top-level `(a, b, c)` group (the token text, parens included) into its
/// comma-separated items.
fn split_items(group: &str) -> Option<Vec<String>> {
    let inner = group.strip_prefix('(')?.strip_suffix(')')?;
    let toks = tokens(inner)?;
    let mut out = Vec::new();
    let mut start = 0usize;
    for t in &toks {
        if t.kind == Kind::Punct && &inner[t.start..t.end] == "," {
            out.push(inner[start..t.start].trim().to_string());
            start = t.end;
        }
    }
    let tail = inner[start..].trim();
    if !tail.is_empty() || !out.is_empty() {
        out.push(tail.to_string());
    }
    Some(out)
}

/// The plain column names in a `(a, b)` list, ignoring `COLLATE x` / `ASC` / `DESC`
/// suffixes. Returns an empty vec when any entry is an expression rather than a name.
fn column_list(group: &str) -> Vec<String> {
    let Some(items) = split_items(group) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        let Some(toks) = tokens(&item) else {
            return Vec::new();
        };
        match toks.first() {
            Some(t) if t.kind == Kind::Word || t.kind == Kind::Quoted => {
                // `a COLLATE nocase DESC` is still the column `a`; `lower(a)` is not.
                if toks.len() > 1 && toks[1].kind == Kind::Paren {
                    return Vec::new();
                }
                out.push(unquote(text(&item, t)));
            }
            _ => return Vec::new(),
        }
    }
    out
}

const TABLE_CONSTRAINT_KW: [(&str, &str); 4] = [
    ("PRIMARY", "primary_key"),
    ("UNIQUE", "unique"),
    ("CHECK", "check"),
    ("FOREIGN", "foreign_key"),
];

fn parse_item(item: &str) -> Option<Result<ParsedColumn, ParsedConstraint>> {
    let toks = tokens(item)?;
    if toks.is_empty() {
        return None;
    }
    // An optional `CONSTRAINT <name>` prefix only ever introduces a table constraint
    // here (a column definition names the column first).
    let (name, rest) = if toks[0].kind == Kind::Word
        && eq_kw(text(item, &toks[0]), "CONSTRAINT")
        && toks.len() > 1
    {
        (Some(unquote(text(item, &toks[1]))), &toks[2..])
    } else {
        (None, &toks[..])
    };
    let head = rest.first()?;
    if head.kind == Kind::Word {
        let h = text(item, head);
        if let Some((_, kind)) = TABLE_CONSTRAINT_KW.iter().find(|(k, _)| eq_kw(h, k)) {
            let columns = rest
                .iter()
                .find(|t| t.kind == Kind::Paren)
                .filter(|_| *kind != "check")
                .map(|t| column_list(text(item, t)))
                .unwrap_or_default();
            return Some(Err(ParsedConstraint {
                name,
                kind,
                clause: item.trim().to_string(),
                columns,
            }));
        }
    }
    if name.is_some() {
        // `CONSTRAINT x <not a constraint keyword>` — refuse rather than guess.
        return None;
    }
    let mut col = ParsedColumn {
        name: unquote(text(item, &toks[0])),
        ..Default::default()
    };
    let mut i = 1usize;
    while i < toks.len() {
        let t = toks[i];
        if t.kind == Kind::Word {
            let w = text(item, &t);
            if eq_kw(w, "AUTOINCREMENT") {
                col.autoincrement = true;
            } else if eq_kw(w, "COLLATE") {
                if let Some(n) = toks
                    .get(i + 1)
                    .filter(|n| n.kind == Kind::Word || n.kind == Kind::Quoted)
                {
                    col.collate = Some(text(item, n).to_string());
                    i += 2;
                    continue;
                }
            } else if eq_kw(w, "CHECK") {
                if let Some(p) = toks.get(i + 1).filter(|p| p.kind == Kind::Paren) {
                    let inner = text(item, p);
                    col.check = Some(inner[1..inner.len() - 1].trim().to_string());
                    i += 2;
                    continue;
                }
            } else if eq_kw(w, "GENERATED") || eq_kw(w, "AS") {
                // `GENERATED ALWAYS AS (expr) [STORED|VIRTUAL]`, or the short `AS (expr)`.
                let mut j = i + 1;
                if eq_kw(w, "GENERATED") {
                    while j < toks.len()
                        && toks[j].kind == Kind::Word
                        && !eq_kw(text(item, &toks[j]), "AS")
                    {
                        j += 1;
                    }
                    if j >= toks.len() {
                        return None;
                    }
                    j += 1; // past AS
                }
                let p = toks.get(j).filter(|p| p.kind == Kind::Paren)?;
                let mut end = p.end;
                if let Some(k) = toks.get(j + 1).filter(|k| {
                    k.kind == Kind::Word
                        && (eq_kw(text(item, k), "STORED") || eq_kw(text(item, k), "VIRTUAL"))
                }) {
                    end = k.end;
                }
                col.generated = Some(item[t.start..end].trim().to_string());
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    Some(Ok(col))
}

/// Parse the stored `CREATE TABLE` statement. `None` when the text is missing, is not a
/// CREATE TABLE, uses `CREATE TABLE … AS SELECT`, or contains anything this reader does
/// not fully understand — the caller must then refuse to rebuild the table.
pub fn parse_create_table(sql: &str) -> Option<ParsedTable> {
    let toks = tokens(sql)?;
    let head = toks.first()?;
    if head.kind != Kind::Word || !eq_kw(text(sql, head), "CREATE") {
        return None;
    }
    // The body is the first top-level parenthesized group; anything else (notably
    // `CREATE TABLE t AS SELECT …`) is out of scope.
    let body_at = toks.iter().position(|t| t.kind == Kind::Paren)?;
    if toks[..body_at]
        .iter()
        .any(|t| t.kind == Kind::Word && eq_kw(text(sql, t), "AS"))
    {
        return None;
    }
    let body = text(sql, &toks[body_at]);
    let mut out = ParsedTable::default();
    for item in split_items(body)? {
        if item.trim().is_empty() {
            continue;
        }
        match parse_item(&item)? {
            Ok(c) => {
                if c.name.is_empty() {
                    return None;
                }
                out.columns.push(c);
            }
            Err(k) => out.constraints.push(k),
        }
    }
    if out.columns.is_empty() {
        return None;
    }
    // The only legal tail is `WITHOUT ROWID` and/or `STRICT`; refuse anything else so an
    // unrecognized option can never be dropped from a rebuild silently.
    let tail = &toks[body_at + 1..];
    for t in tail {
        let w = text(sql, t);
        let ok = (t.kind == Kind::Word
            && (eq_kw(w, "WITHOUT") || eq_kw(w, "ROWID") || eq_kw(w, "STRICT")))
            || (t.kind == Kind::Punct && (w == "," || w == ";"));
        if !ok {
            return None;
        }
    }
    if let (Some(first), Some(last)) = (tail.first(), tail.last()) {
        out.options = sql[first.start..last.end]
            .trim()
            .trim_end_matches(';')
            .trim()
            .to_string();
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_column_extras_and_table_checks() {
        let p = parse_create_table(
            "CREATE TABLE t(\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  email TEXT COLLATE NOCASE CHECK (email <> ''),\n  qty INT,\n  total INT GENERATED ALWAYS AS (qty * 2) STORED,\n  CONSTRAINT ck_qty CHECK(qty > 0),\n  UNIQUE (email, qty)\n)",
        )
        .expect("parses");
        assert_eq!(p.columns.len(), 4);
        assert!(p.columns[0].autoincrement);
        assert!(!p.columns[1].autoincrement);
        assert_eq!(p.columns[1].collate.as_deref(), Some("NOCASE"));
        assert_eq!(p.columns[1].check.as_deref(), Some("email <> ''"));
        assert_eq!(
            p.columns[3].generated.as_deref(),
            Some("GENERATED ALWAYS AS (qty * 2) STORED")
        );
        assert_eq!(p.constraints.len(), 2);
        assert_eq!(p.constraints[0].kind, "check");
        assert_eq!(p.constraints[0].name.as_deref(), Some("ck_qty"));
        assert_eq!(p.constraints[0].clause, "CONSTRAINT ck_qty CHECK(qty > 0)");
        assert_eq!(p.constraints[1].kind, "unique");
        assert_eq!(p.constraints[1].columns, vec!["email", "qty"]);
    }

    #[test]
    fn autoincrement_is_token_level_not_a_substring() {
        // A column NAMED autoincrement_seq, a CHECK mentioning it and a default string
        // must not turn every INTEGER key into an AUTOINCREMENT one.
        let p = parse_create_table(
            "CREATE TABLE t(id INTEGER PRIMARY KEY, autoincrement_seq INT, note TEXT DEFAULT 'AUTOINCREMENT')",
        )
        .expect("parses");
        assert!(p.columns.iter().all(|c| !c.autoincrement));
        assert_eq!(p.columns[1].name, "autoincrement_seq");
    }

    #[test]
    fn keeps_quoted_names_commas_and_tail_options() {
        let p = parse_create_table(
            "CREATE TABLE \"my, tbl\" (\"a, b\" TEXT, `c` INT, [d] INT, PRIMARY KEY(\"a, b\")) WITHOUT ROWID",
        )
        .expect("parses");
        assert_eq!(
            p.columns
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>(),
            vec!["a, b", "c", "d"]
        );
        assert_eq!(p.constraints[0].columns, vec!["a, b"]);
        assert_eq!(p.options, "WITHOUT ROWID");
    }

    #[test]
    fn short_generated_form_and_virtual() {
        let p = parse_create_table("CREATE TABLE t(a INT, b AS (a+1) VIRTUAL)").expect("parses");
        assert_eq!(p.columns[1].generated.as_deref(), Some("AS (a+1) VIRTUAL"));
    }

    #[test]
    fn refuses_what_it_cannot_read() {
        assert!(parse_create_table("").is_none());
        assert!(parse_create_table("CREATE TABLE t AS SELECT 1 AS a").is_none());
        assert!(parse_create_table("CREATE TABLE t(a INT").is_none());
        assert!(parse_create_table("CREATE TABLE t(a INT) WEIRD OPTION").is_none());
        assert!(parse_create_table("CREATE VIEW v AS SELECT 1").is_none());
    }

    #[test]
    fn comments_inside_the_body_are_skipped() {
        let p = parse_create_table(
            "CREATE TABLE t( -- leading\n a INT, /* mid */ b TEXT COLLATE BINARY\n)",
        )
        .expect("parses");
        assert_eq!(p.columns.len(), 2);
        assert_eq!(p.columns[1].collate.as_deref(), Some("BINARY"));
    }
}
