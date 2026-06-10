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
    s.split(SEP).map(|x| x.to_string()).collect()
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

fn pg_edge(row: &tokio_postgres::Row) -> FkEdge {
    let src: Option<String> = row.get(3);
    let dst: Option<String> = row.get(6);
    FkEdge {
        constraint: row.get(0),
        src_schema: row.get(1),
        src_table: row.get(2),
        src_cols: split_cols(&src.unwrap_or_default()),
        dst_schema: row.get(4),
        dst_table: row.get(5),
        dst_cols: split_cols(&dst.unwrap_or_default()),
    }
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
        Some(r) => r.get(0),
        None => return Err(AppError::new("relation not found")),
    };
    let q = pg_edge_select("con.conrelid = $1 OR con.confrelid = $1");
    let rows = client.query(q.as_str(), &[&oid]).await?;
    let mut outbound = Vec::new();
    let mut inbound = Vec::new();
    for row in &rows {
        let e = pg_edge(row);
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

pub async fn pg_schema_relationships(client: &Client, schema: &str) -> Result<SchemaGraph, AppError> {
    let q = pg_edge_select("sn.nspname = $1 OR dn.nspname = $1");
    let edge_rows = client.query(q.as_str(), &[&schema]).await?;
    let edges: Vec<FkEdge> = edge_rows.iter().map(pg_edge).collect();

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
        let key = (r.get::<_, String>(0), r.get::<_, String>(1));
        match r.get::<_, String>(2).as_str() {
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
        let tname: String = r.get(0);
        let cname: String = r.get(1);
        if tables.last().map(|t: &ErdTable| t.name != tname).unwrap_or(true) {
            tables.push(ErdTable { schema: schema.to_string(), name: tname.clone(), columns: Vec::new() });
        }
        let k = (tname, cname.clone());
        tables.last_mut().unwrap().columns.push(ErdColumn {
            is_pk: pk.contains(&k),
            is_fk: fk.contains(&k),
            name: cname,
            data_type: r.get(2),
        });
    }
    Ok(SchemaGraph { tables, edges })
}

// ---------------- shared text-row helpers (embedded / mysql paths) ----------------

fn cell(r: &[Option<String>], i: usize) -> String {
    r.get(i).and_then(|v| v.clone()).unwrap_or_default()
}

fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

// ---------------- SQLite ----------------

type TextQuery<'a> = &'a dyn Fn(&str) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), AppError>;

/// PK column names of one table, in PK order, via pragma_table_info.
fn sqlite_pk_cols(q: TextQuery, table: &str) -> Vec<String> {
    let sql = format!("SELECT name, pk FROM pragma_table_info({}) WHERE pk > 0 ORDER BY pk", lit(table));
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
        lit(table)
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
        let e = edges.last_mut().unwrap();
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
        let fk_cols: std::collections::HashSet<String> =
            out.iter().flat_map(|e| e.src_cols.iter().cloned()).collect();
        let cols = match q(&format!("SELECT name, type, pk FROM pragma_table_info({}) ORDER BY cid", lit(&t))) {
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
        tables.push(ErdTable { schema: "main".into(), name: t, columns: cols });
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
        let e = edges.last_mut().unwrap();
        e.src_cols.push(cell(r, 3));
        e.dst_cols.push(cell(r, 6));
    }
    edges
}

const MYSQL_KCU: &str = "SELECT kcu.CONSTRAINT_NAME, kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME, \
       kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME \
     FROM information_schema.KEY_COLUMN_USAGE kcu \
     WHERE kcu.REFERENCED_TABLE_NAME IS NOT NULL";

pub fn mysql_relationship_queries(schema: &str, name: &str) -> String {
    format!(
        "{MYSQL_KCU} AND ((kcu.TABLE_SCHEMA = {s} AND kcu.TABLE_NAME = {t}) \
           OR (kcu.REFERENCED_TABLE_SCHEMA = {s} AND kcu.REFERENCED_TABLE_NAME = {t})) \
         ORDER BY kcu.CONSTRAINT_NAME, kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.ORDINAL_POSITION",
        s = lit(schema),
        t = lit(name)
    )
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

pub fn mysql_schema_edges_query(schema: &str) -> String {
    format!(
        "{MYSQL_KCU} AND (kcu.TABLE_SCHEMA = {s} OR kcu.REFERENCED_TABLE_SCHEMA = {s}) \
         ORDER BY kcu.CONSTRAINT_NAME, kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.ORDINAL_POSITION",
        s = lit(schema)
    )
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
        if tables.last().map(|x: &ErdTable| x.name != t).unwrap_or(true) {
            tables.push(ErdTable { schema: schema.to_string(), name: t.clone(), columns: Vec::new() });
        }
        let cname = cell(r, 1);
        tables.last_mut().unwrap().columns.push(ErdColumn {
            is_pk: cell(r, 3) == "PRI",
            is_fk: fk_cols.contains(&(t, cname.clone())),
            name: cname,
            data_type: cell(r, 2),
        });
    }
    SchemaGraph { tables, edges }
}

pub fn mysql_columns_query(schema: &str) -> String {
    format!(
        "SELECT table_name, column_name, data_type, column_key \
         FROM information_schema.columns WHERE table_schema = {} \
         ORDER BY table_name, ordinal_position",
        lit(schema)
    )
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
    let up = text.to_uppercase();
    let fk = up.find("FOREIGN KEY")?;
    let open = text[fk..].find('(')? + fk;
    let close = text[open..].find(')')? + open;
    let src_cols: Vec<String> = text[open + 1..close].split(',').map(|c| c.trim().trim_matches('"').to_string()).collect();
    let refp = up[close..].find("REFERENCES")? + close + "REFERENCES".len();
    let rest = text[refp..].trim_start();
    let popen = rest.find('(')?;
    let table = rest[..popen].trim().trim_matches('"').to_string();
    let pclose = rest[popen..].find(')')? + popen;
    let dst_cols: Vec<String> = rest[popen + 1..pclose].split(',').map(|c| c.trim().trim_matches('"').to_string()).collect();
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

pub const DUCK_FK_STRUCTURED: &str = "SELECT schema_name, table_name, constraint_text, referenced_table, \
       CAST(constraint_column_names AS VARCHAR), CAST(referenced_column_names AS VARCHAR) \
     FROM duckdb_constraints() WHERE constraint_type = 'FOREIGN KEY'";
pub const DUCK_FK_TEXT: &str = "SELECT schema_name, table_name, constraint_text \
     FROM duckdb_constraints() WHERE constraint_type = 'FOREIGN KEY'";
pub const DUCK_PK: &str = "SELECT schema_name, table_name, CAST(constraint_column_names AS VARCHAR) \
     FROM duckdb_constraints() WHERE constraint_type = 'PRIMARY KEY'";
