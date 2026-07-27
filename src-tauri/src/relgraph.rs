//! Foreign-key relationship introspection for the "DDL & relationships" view.
//! Per-engine, best-effort: engines that can't answer return EMPTY results,
//! never errors (the UI renders an honest empty state). Column lists keep the
//! constraint's declared order.

use tokio_postgres::Client;

use crate::db::AppError;

/// One FK: src table's columns reference dst table's columns, in order.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FkEdge {
    pub constraint: String,
    pub src_schema: String,
    pub src_table: String,
    pub src_cols: Vec<String>,
    pub dst_schema: String,
    pub dst_table: String,
    pub dst_cols: Vec<String>,
}

#[derive(serde::Serialize)]
pub struct Relationships {
    pub outbound: Vec<FkEdge>,
    pub inbound: Vec<FkEdge>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErdColumn {
    pub name: String,
    pub data_type: String,
    pub is_pk: bool,
    pub is_fk: bool,
}

#[derive(serde::Serialize)]
pub struct ErdTable {
    pub schema: String,
    pub name: String,
    pub columns: Vec<ErdColumn>,
}

#[derive(serde::Serialize)]
pub struct SchemaGraph {
    pub tables: Vec<ErdTable>,
    pub edges: Vec<FkEdge>,
}

/// Unit separator — collision-proof join for aggregated column lists (a comma
/// can appear in a quoted identifier).
const SEP: char = '\u{1f}';

fn split_cols(s: &str) -> Vec<String> {
    if s.is_empty() {
        Vec::new()
    } else {
        s.split(SEP).map(|x| x.to_string()).collect()
    }
}

// ---------------- Postgres ----------------

/// The per-side column-list subquery, ordered by the constraint's key order.
const PG_COLS_SRC: &str = "(SELECT string_agg(a.attname, chr(31) ORDER BY k.ord) \
   FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) \
   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum)";
const PG_COLS_DST: &str = "(SELECT string_agg(a.attname, chr(31) ORDER BY k.ord) \
   FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord) \
   JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum)";

fn pg_edge_select(filter: &str) -> String {
    format!(
        "SELECT con.conname, sn.nspname, sr.relname, {PG_COLS_SRC}, dn.nspname, dr.relname, {PG_COLS_DST} \
         FROM pg_constraint con \
         JOIN pg_class sr ON sr.oid = con.conrelid JOIN pg_namespace sn ON sn.oid = sr.relnamespace \
         JOIN pg_class dr ON dr.oid = con.confrelid JOIN pg_namespace dn ON dn.oid = dr.relnamespace \
         WHERE con.contype = 'f' AND ({filter}) \
         ORDER BY sn.nspname, sr.relname, con.conname"
    )
}

// Fallible on purpose: typed `get` panics on a type mismatch, and this module's
// contract is best-effort (a weird row is dropped, never a process abort).
fn pg_edge(row: &tokio_postgres::Row) -> Option<FkEdge> {
    let src: Option<String> = row.try_get(3).ok()?;
    let dst: Option<String> = row.try_get(6).ok()?;
    Some(FkEdge {
        constraint: row.try_get(0).ok()?,
        src_schema: row.try_get(1).ok()?,
        src_table: row.try_get(2).ok()?,
        src_cols: split_cols(&src.unwrap_or_default()),
        dst_schema: row.try_get(4).ok()?,
        dst_table: row.try_get(5).ok()?,
        dst_cols: split_cols(&dst.unwrap_or_default()),
    })
}

pub async fn pg_table_relationships(
    client: &Client,
    schema: &str,
    name: &str,
) -> Result<Relationships, AppError> {
    // Resolve the OID with bound params (no interpolation of user input).
    let rows = client
        .query(
            "SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2",
            &[&schema, &name],
        )
        .await?;
    let oid: u32 = match rows.first() {
        Some(r) => r
            .try_get(0)
            .map_err(|e| AppError::new(format!("unexpected catalog shape: {e}")))?,
        None => return Err(AppError::new("relation not found")),
    };
    let q = pg_edge_select("con.conrelid = $1 OR con.confrelid = $1");
    let rows = client.query(q.as_str(), &[&oid]).await?;
    let mut outbound = Vec::new();
    let mut inbound = Vec::new();
    for row in &rows {
        let Some(e) = pg_edge(row) else { continue };
        // Self-referencing FKs land in both lists on purpose.
        if e.src_schema == schema && e.src_table == name {
            outbound.push(e.clone());
        }
        if e.dst_schema == schema && e.dst_table == name {
            inbound.push(e);
        }
    }
    Ok(Relationships { outbound, inbound })
}

pub async fn pg_schema_relationships(
    client: &Client,
    schema: &str,
) -> Result<SchemaGraph, AppError> {
    let q = pg_edge_select("sn.nspname = $1 OR dn.nspname = $1");
    let edge_rows = client.query(q.as_str(), &[&schema]).await?;
    let edges: Vec<FkEdge> = edge_rows.iter().filter_map(pg_edge).collect();

    let col_rows = client
        .query(
            "SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             JOIN pg_attribute a ON a.attrelid = c.oid \
             WHERE n.nspname = $1 AND c.relkind IN ('r','p') \
               AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY c.relname, a.attnum",
            &[&schema],
        )
        .await?;
    let key_rows = client
        .query(
            "SELECT c.relname, a.attname, con.contype::text \
             FROM pg_constraint con \
             JOIN pg_class c ON c.oid = con.conrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey) \
             WHERE n.nspname = $1 AND con.contype IN ('p','f')",
            &[&schema],
        )
        .await?;
    let mut pk: std::collections::HashSet<(String, String)> = Default::default();
    let mut fk: std::collections::HashSet<(String, String)> = Default::default();
    for r in &key_rows {
        let (Ok(t), Ok(c), Ok(ty)) = (
            r.try_get::<_, String>(0),
            r.try_get::<_, String>(1),
            r.try_get::<_, String>(2),
        ) else {
            continue; // best-effort: drop the weird row, never panic
        };
        let key = (t, c);
        match ty.as_str() {
            "p" => {
                pk.insert(key);
            }
            _ => {
                fk.insert(key);
            }
        }
    }

    let mut tables: Vec<ErdTable> = Vec::new();
    for r in &col_rows {
        let (Ok(tname), Ok(cname)) = (r.try_get::<_, String>(0), r.try_get::<_, String>(1)) else {
            continue;
        };
        if tables
            .last()
            .map(|t: &ErdTable| t.name != tname)
            .unwrap_or(true)
        {
            tables.push(ErdTable {
                schema: schema.to_string(),
                name: tname.clone(),
                columns: Vec::new(),
            });
        }
        let k = (tname, cname.clone());
        if let Some(table) = tables.last_mut() {
            table.columns.push(ErdColumn {
                is_pk: pk.contains(&k),
                is_fk: fk.contains(&k),
                name: cname,
                data_type: r.try_get(2).unwrap_or_default(),
            });
        }
    }
    Ok(SchemaGraph { tables, edges })
}

// ---------------- shared text-row helpers (embedded / mysql paths) ----------------

fn cell(r: &[Option<String>], i: usize) -> String {
    r.get(i).and_then(|v| v.clone()).unwrap_or_default()
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

/// SQLite string literals built from bytes avoid parser ambiguity around quotes,
/// backslashes, control characters, and embedded zero bytes. (MySQL metadata
/// queries now bind parameters in `driver.rs` instead of building literals here.)
fn sqlite_lit(s: &str) -> String {
    format!("CAST(X'{}' AS TEXT)", hex_bytes(s))
}

// ---------------- SQLite ----------------

type TextQuery<'a> = &'a dyn Fn(&str) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), AppError>;

/// PK column names of one table, in PK order, via pragma_table_info.
fn sqlite_pk_cols(q: TextQuery, table: &str) -> Vec<String> {
    let sql = format!(
        "SELECT name, pk FROM pragma_table_info({}) WHERE pk > 0 ORDER BY pk",
        sqlite_lit(table)
    );
    match q(&sql) {
        Ok((_c, rows)) => rows.iter().map(|r| cell(r, 0)).collect(),
        Err(_) => Vec::new(),
    }
}

/// Outbound FK edges of one table via pragma_foreign_key_list (id groups rows;
/// a NULL "to" means the referenced table's PK, resolved here).
fn sqlite_outbound(q: TextQuery, table: &str) -> Vec<FkEdge> {
    let sql = format!(
        "SELECT id, seq, \"table\", \"from\", \"to\" FROM pragma_foreign_key_list({}) ORDER BY id, seq",
        sqlite_lit(table)
    );
    let rows = match q(&sql) {
        Ok((_c, rows)) => rows,
        Err(_) => return Vec::new(),
    };
    let mut edges: Vec<FkEdge> = Vec::new();
    let mut cur_id: Option<String> = None;
    for r in &rows {
        let id = cell(r, 0);
        if cur_id.as_deref() != Some(id.as_str()) {
            cur_id = Some(id.clone());
            edges.push(FkEdge {
                constraint: format!("fk_{}_{}", table, id),
                src_schema: "main".into(),
                src_table: table.to_string(),
                src_cols: Vec::new(),
                dst_schema: "main".into(),
                dst_table: cell(r, 2),
                dst_cols: Vec::new(),
            });
        }
        let Some(e) = edges.last_mut() else { continue };
        e.src_cols.push(cell(r, 3));
        let to = r.get(4).and_then(|v| v.clone());
        if let Some(t) = to {
            e.dst_cols.push(t);
        }
    }
    // Resolve implicit-PK references (empty dst_cols).
    for e in &mut edges {
        if e.dst_cols.is_empty() {
            e.dst_cols = sqlite_pk_cols(q, &e.dst_table);
        }
    }
    edges
}

fn sqlite_user_tables(q: TextQuery) -> Vec<String> {
    match q("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name") {
        Ok((_c, rows)) => rows.iter().map(|r| cell(r, 0)).collect(),
        Err(_) => Vec::new(),
    }
}

pub fn sqlite_table_relationships(q: TextQuery, name: &str) -> Relationships {
    let outbound = sqlite_outbound(q, name);
    let mut inbound = Vec::new();
    let target = name.to_lowercase();
    for t in sqlite_user_tables(q) {
        for e in sqlite_outbound(q, &t) {
            if e.dst_table.to_lowercase() == target {
                inbound.push(e);
            }
        }
    }
    Relationships { outbound, inbound }
}

pub fn sqlite_schema_relationships(q: TextQuery) -> SchemaGraph {
    let mut tables = Vec::new();
    let mut edges = Vec::new();
    for t in sqlite_user_tables(q) {
        let out = sqlite_outbound(q, &t);
        let fk_cols: std::collections::HashSet<String> = out
            .iter()
            .flat_map(|e| e.src_cols.iter().cloned())
            .collect();
        let cols = match q(&format!(
            "SELECT name, type, pk FROM pragma_table_info({}) ORDER BY cid",
            sqlite_lit(&t)
        )) {
            Ok((_c, rows)) => rows
                .iter()
                .map(|r| ErdColumn {
                    name: cell(r, 0),
                    data_type: cell(r, 1),
                    is_pk: cell(r, 2) != "0" && !cell(r, 2).is_empty(),
                    is_fk: fk_cols.contains(&cell(r, 0)),
                })
                .collect(),
            Err(_) => Vec::new(),
        };
        tables.push(ErdTable {
            schema: "main".into(),
            name: t,
            columns: cols,
        });
        edges.extend(out);
    }
    SchemaGraph { tables, edges }
}

// ---------------- MySQL ----------------

fn mysql_group_edges(rows: &[Vec<Option<String>>]) -> Vec<FkEdge> {
    // rows: constraint, src_schema, src_table, src_col, dst_schema, dst_table, dst_col
    // ordered by constraint/src/ordinal. Group key includes the table — constraint
    // names are only unique per table in MySQL.
    let mut edges: Vec<FkEdge> = Vec::new();
    let mut key: Option<(String, String, String)> = None;
    for r in rows {
        let k = (cell(r, 0), cell(r, 1), cell(r, 2));
        if key.as_ref() != Some(&k) {
            key = Some(k.clone());
            edges.push(FkEdge {
                constraint: k.0,
                src_schema: k.1,
                src_table: k.2,
                src_cols: Vec::new(),
                dst_schema: cell(r, 4),
                dst_table: cell(r, 5),
                dst_cols: Vec::new(),
            });
        }
        let Some(e) = edges.last_mut() else { continue };
        e.src_cols.push(cell(r, 3));
        e.dst_cols.push(cell(r, 6));
    }
    edges
}

pub fn mysql_split(rows: &[Vec<Option<String>>], schema: &str, name: &str) -> Relationships {
    let edges = mysql_group_edges(rows);
    let mut outbound = Vec::new();
    let mut inbound = Vec::new();
    for e in edges {
        if e.src_schema == schema && e.src_table == name {
            outbound.push(e.clone());
        }
        if e.dst_schema == schema && e.dst_table == name {
            inbound.push(e);
        }
    }
    Relationships { outbound, inbound }
}

pub fn mysql_schema_graph(
    col_rows: &[Vec<Option<String>>],
    edge_rows: &[Vec<Option<String>>],
    schema: &str,
) -> SchemaGraph {
    // col_rows: table_name, column_name, data_type, column_key — ordered by table, ordinal.
    let edges = mysql_group_edges(edge_rows);
    let fk_cols: std::collections::HashSet<(String, String)> = edges
        .iter()
        .filter(|e| e.src_schema == schema)
        .flat_map(|e| e.src_cols.iter().map(|c| (e.src_table.clone(), c.clone())))
        .collect();
    let mut tables: Vec<ErdTable> = Vec::new();
    for r in col_rows {
        let t = cell(r, 0);
        if tables
            .last()
            .map(|x: &ErdTable| x.name != t)
            .unwrap_or(true)
        {
            tables.push(ErdTable {
                schema: schema.to_string(),
                name: t.clone(),
                columns: Vec::new(),
            });
        }
        let cname = cell(r, 1);
        if let Some(table) = tables.last_mut() {
            table.columns.push(ErdColumn {
                is_pk: cell(r, 3) == "PRI",
                is_fk: fk_cols.contains(&(t, cname.clone())),
                name: cname,
                data_type: cell(r, 2),
            });
        }
    }
    SchemaGraph { tables, edges }
}

// ---------------- DuckDB ----------------

/// Parse a DuckDB VARCHAR-cast list like "[a, b]" into column names.
fn duck_list(s: &str) -> Vec<String> {
    let t = s.trim().trim_start_matches('[').trim_end_matches(']');
    if t.is_empty() {
        return Vec::new();
    }
    t.split(", ").map(|x| x.trim().to_string()).collect()
}

/// Fallback: pull "FOREIGN KEY (a, b) REFERENCES tbl(x, y)" apart without regex.
fn duck_parse_constraint_text(text: &str) -> Option<(Vec<String>, String, Vec<String>)> {
    // ASCII uppercase ONLY: `to_uppercase()` can change byte length (ǰ→J̌, ﬁ→FI),
    // and the offsets found in `up` are used to slice `text` — a length drift lands
    // mid-char and panics. The keywords being matched are pure ASCII, so ASCII
    // case-folding is byte-length-preserving and exactly as good here.
    let up = text.to_ascii_uppercase();
    let fk = up.find("FOREIGN KEY")?;
    let open = text[fk..].find('(')? + fk;
    let close = text[open..].find(')')? + open;
    let src_cols: Vec<String> = text[open + 1..close]
        .split(',')
        .map(|c| c.trim().trim_matches('"').to_string())
        .collect();
    let refp = up[close..].find("REFERENCES")? + close + "REFERENCES".len();
    let rest = text[refp..].trim_start();
    let popen = rest.find('(')?;
    let table = rest[..popen].trim().trim_matches('"').to_string();
    let pclose = rest[popen..].find(')')? + popen;
    let dst_cols: Vec<String> = rest[popen + 1..pclose]
        .split(',')
        .map(|c| c.trim().trim_matches('"').to_string())
        .collect();
    Some((src_cols, table, dst_cols))
}

/// Build edges from duckdb_constraints() rows fetched as text. `structured` rows
/// carry (schema, table, constraint_text, referenced_table, constraint_column_names,
/// referenced_column_names); the text fallback only the first three.
pub fn duck_edges(rows: &[Vec<Option<String>>], structured: bool) -> Vec<FkEdge> {
    let mut out = Vec::new();
    for (i, r) in rows.iter().enumerate() {
        let schema = cell(r, 0);
        let table = cell(r, 1);
        let text = cell(r, 2);
        if structured {
            let dst_table = cell(r, 3);
            let src_cols = duck_list(&cell(r, 4));
            let dst_cols = duck_list(&cell(r, 5));
            if !dst_table.is_empty() && !src_cols.is_empty() {
                out.push(FkEdge {
                    constraint: format!("fk_{table}_{i}"),
                    src_schema: schema.clone(),
                    src_table: table,
                    src_cols,
                    dst_schema: schema,
                    dst_table,
                    dst_cols,
                });
                continue;
            }
        }
        if let Some((src_cols, dst_table, dst_cols)) = duck_parse_constraint_text(&text) {
            out.push(FkEdge {
                constraint: format!("fk_{table}_{i}"),
                src_schema: schema.clone(),
                src_table: table,
                src_cols,
                dst_schema: schema,
                dst_table,
                dst_cols,
            });
        }
    }
    out
}

pub const DUCK_FK_STRUCTURED: &str =
    "SELECT schema_name, table_name, constraint_text, referenced_table, \
       CAST(constraint_column_names AS VARCHAR), CAST(referenced_column_names AS VARCHAR) \
     FROM duckdb_constraints() WHERE constraint_type = 'FOREIGN KEY'";
pub const DUCK_FK_TEXT: &str = "SELECT schema_name, table_name, constraint_text \
     FROM duckdb_constraints() WHERE constraint_type = 'FOREIGN KEY'";
pub const DUCK_PK: &str =
    "SELECT schema_name, table_name, CAST(constraint_column_names AS VARCHAR) \
     FROM duckdb_constraints() WHERE constraint_type = 'PRIMARY KEY'";

#[cfg(test)]
mod tests {
    use super::*;

    /// `ǰ` uppercases to a 3-byte `J̌` via Unicode folding — with `to_uppercase()`
    /// the offsets found in the folded string desynced from the original and the
    /// slice panicked mid-char. ASCII folding keeps byte offsets identical.
    #[test]
    fn duck_constraint_text_survives_multibyte_identifiers() {
        let (src, table, dst) =
            duck_parse_constraint_text("FOREIGN KEY (ǰ) REFERENCES a(x)").unwrap();
        assert_eq!(src, vec!["ǰ"]);
        assert_eq!(table, "a");
        assert_eq!(dst, vec!["x"]);

        let (src2, table2, dst2) =
            duck_parse_constraint_text("FOREIGN KEY (ﬁrst_id, b) REFERENCES übertabelle(x, y)")
                .unwrap();
        assert_eq!(src2, vec!["ﬁrst_id", "b"]);
        assert_eq!(table2, "übertabelle");
        assert_eq!(dst2, vec!["x", "y"]);
    }

    #[test]
    fn empty_aggregated_column_list_stays_empty() {
        assert!(split_cols("").is_empty());
        assert_eq!(split_cols("a\u{1f}b"), vec!["a", "b"]);
    }

    #[test]
    fn metadata_literals_do_not_embed_untrusted_text() {
        let hostile = "x'\\\0 OR 1=1 -- 雪";
        let sqlite = sqlite_lit(hostile);
        assert!(!sqlite.contains(hostile));
        assert!(sqlite.starts_with("CAST(X'"));
        assert!(sqlite.contains(&hex_bytes(hostile)));
    }
}
