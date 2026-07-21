use crate::db::{collect_rows, AppError};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use tokio_postgres::Client;

#[derive(Serialize, Clone)]
pub struct Column {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_pk: bool,
    pub is_fk: bool,
    pub default: Option<String>,
    pub comment: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct Index {
    pub name: String,
    pub unique: bool,
    pub primary: bool,
    pub def: String,
}

#[derive(Serialize, Clone)]
pub struct Constraint {
    pub name: String,
    pub kind: String, // primary_key | foreign_key | unique | check
    pub def: String,
}

#[derive(Serialize, Clone)]
pub struct Func {
    pub name: String,
    pub args: String,
    pub returns: String,
}

/// Lightweight relation entry for the shallow tree — no columns/indexes/constraints
/// (those are fetched lazily per-table via `table_detail`).
#[derive(Serialize)]
pub struct RelStub {
    pub name: String,
    pub kind: String, // table | view | matview
    pub comment: Option<String>,
    /// Planner row estimate (`reltuples`); `None` when never analyzed (<0) or non-PG.
    pub rows: Option<i64>,
    /// Pretty total relation size — tables/matviews only.
    pub size: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct Trigger {
    pub name: String,
    pub def: String,
}

/// Full per-relation detail, fetched on expand.
#[derive(Serialize)]
pub struct RelationDetail {
    pub name: String,
    pub kind: String,
    pub comment: Option<String>,
    pub columns: Vec<Column>,
    pub indexes: Vec<Index>,
    pub constraints: Vec<Constraint>,
    pub triggers: Vec<Trigger>,
}

#[derive(Serialize)]
pub struct Schema {
    pub name: String,
    pub tables: Vec<RelStub>,
    pub views: Vec<RelStub>,
    pub sequences: Vec<String>,
    pub functions: Vec<Func>,
}

#[derive(Serialize)]
pub struct DbTree {
    pub database: String,
    pub databases: Vec<String>,
    pub schemas: Vec<Schema>,
}

/// Flat schema/table/column list that feeds frontend autocomplete (decoupled from the
/// lazy tree). Driver-agnostic — built from `(schema, table, column, data_type)` rows.
#[derive(Serialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
}

#[derive(Serialize)]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
    pub columns: Vec<ColumnInfo>,
}

/// Group consecutive `(schema, table, column, data_type)` rows into `TableInfo`s
/// (rows must be ordered by schema, table, ordinal).
pub fn tables_from_rows(rows: Vec<Vec<Option<String>>>) -> Vec<TableInfo> {
    let mut tables: Vec<TableInfo> = Vec::new();
    for r in rows {
        let schema = cell(&r, 0);
        let name = cell(&r, 1);
        let col = ColumnInfo {
            name: cell(&r, 2),
            data_type: cell(&r, 3),
        };
        match tables.last_mut() {
            Some(t) if t.schema == schema && t.name == name => t.columns.push(col),
            _ => tables.push(TableInfo {
                schema,
                name,
                columns: vec![col],
            }),
        }
    }
    tables
}

fn cell(r: &[Option<String>], i: usize) -> String {
    r.get(i).and_then(|v| v.clone()).unwrap_or_default()
}

async fn query(client: &Client, sql: &str) -> Result<Vec<Vec<Option<String>>>, AppError> {
    let msgs = client.simple_query(sql).await?;
    Ok(collect_rows(&msgs).1)
}

const NS: &str = "n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast_temp%'";

/// Shallow object tree: databases, schemas, and each schema's object names + kinds.
/// Fast on connect (~4 catalog queries, no per-table column/index/constraint scan).
pub async fn build_shallow(client: &Client) -> Result<DbTree, AppError> {
    let database = query(client, "SELECT current_database()")
        .await?
        .into_iter()
        .next()
        .and_then(|r| r.into_iter().next().flatten())
        .unwrap_or_default();

    let databases: Vec<String> = query(
        client,
        "SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname",
    )
    .await?
    .into_iter()
    .filter_map(|r| r.into_iter().next().flatten())
    .collect();

    // All non-system schemas — so empty schemas still show (needed for "create object here").
    let ns_rows = query(
        client,
        &format!("SELECT n.nspname FROM pg_namespace n WHERE {NS} ORDER BY n.nspname"),
    )
    .await?;

    let rel_rows = query(client, &format!(
        "SELECT n.nspname, c.relname, c.relkind::text, obj_description(c.oid,'pg_class'), \
         c.reltuples::bigint, \
         CASE WHEN c.relkind IN ('r','p','m') THEN pg_size_pretty(pg_total_relation_size(c.oid)) END \
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace \
         WHERE c.relkind IN ('r','p','v','m','S') AND {NS} ORDER BY n.nspname, c.relname")).await?;

    let fn_rows = query(client, &format!(
        "SELECT n.nspname, p.proname, pg_get_function_arguments(p.oid), pg_get_function_result(p.oid) \
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE {NS} ORDER BY n.nspname, p.proname")).await?;

    let mut schema_names: BTreeSet<String> = BTreeSet::new();
    for r in &ns_rows {
        schema_names.insert(cell(r, 0));
    }

    let mut tables: HashMap<String, Vec<RelStub>> = HashMap::new();
    let mut views: HashMap<String, Vec<RelStub>> = HashMap::new();
    let mut seqs: HashMap<String, Vec<String>> = HashMap::new();
    for r in &rel_rows {
        let s = cell(r, 0);
        let name = cell(r, 1);
        let kind = cell(r, 2);
        let comment = r.get(3).and_then(|v| v.clone());
        // reltuples is -1 (never analyzed) → no estimate to show.
        let rows = r
            .get(4)
            .and_then(|v| v.as_deref())
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|n| *n >= 0);
        let size = r.get(5).and_then(|v| v.clone());
        schema_names.insert(s.clone());
        match kind.as_str() {
            "r" | "p" => tables.entry(s).or_default().push(RelStub {
                name,
                kind: "table".into(),
                comment,
                rows,
                size,
            }),
            "v" => views.entry(s).or_default().push(RelStub {
                name,
                kind: "view".into(),
                comment,
                rows: None,
                size: None,
            }),
            "m" => views.entry(s).or_default().push(RelStub {
                name,
                kind: "matview".into(),
                comment,
                rows,
                size,
            }),
            "S" => seqs.entry(s).or_default().push(name),
            _ => {}
        }
    }

    let mut funcs: HashMap<String, Vec<Func>> = HashMap::new();
    for r in &fn_rows {
        funcs.entry(cell(r, 0)).or_default().push(Func {
            name: cell(r, 1),
            args: cell(r, 2),
            returns: cell(r, 3),
        });
    }
    for k in funcs.keys() {
        schema_names.insert(k.clone());
    }

    let mut schemas = Vec::new();
    for s in schema_names {
        schemas.push(Schema {
            tables: tables.remove(&s).unwrap_or_default(),
            views: views.remove(&s).unwrap_or_default(),
            sequences: seqs.remove(&s).unwrap_or_default(),
            functions: funcs.remove(&s).unwrap_or_default(),
            name: s,
        });
    }

    Ok(DbTree {
        database,
        databases,
        schemas,
    })
}

/// Columns + indexes + constraints + comments for one relation, fetched on expand.
/// The user-supplied `schema`/`name` are bound as parameters (no string interpolation);
/// the resolved OID is a trusted integer, reused in the detail queries.
pub async fn table_detail(
    client: &Client,
    schema: &str,
    name: &str,
) -> Result<RelationDetail, AppError> {
    let rows = client
        .query(
            "SELECT c.oid, c.relkind::text FROM pg_class c \
             JOIN pg_namespace n ON n.oid=c.relnamespace \
             WHERE n.nspname=$1 AND c.relname=$2",
            &[&schema, &name],
        )
        .await?;
    let row = rows.first().ok_or_else(|| AppError::new("relation not found"))?;
    // try_get: typed `get` panics on a type mismatch, which a PG-wire-compatible
    // server (CockroachDB, proxies) can produce where real Postgres never would.
    let oid: u32 = row.try_get(0).map_err(|e| AppError::new(format!("unexpected catalog shape: {e}")))?;
    let relkind: String = row.try_get(1).map_err(|e| AppError::new(format!("unexpected catalog shape: {e}")))?;
    let kind = match relkind.as_str() {
        "v" => "view",
        "m" => "matview",
        _ => "table",
    }
    .to_string();

    // NOTE: do NOT cast booleans to ::text — `bool::text` yields 'true'/'false',
    // but the text protocol returns 't'/'f' for a bare bool (which `== "t"` expects).
    let col_rows = query(client, &format!(
        "SELECT a.attname, format_type(a.atttypid,a.atttypmod), (NOT a.attnotnull), \
         pg_get_expr(d.adbin,d.adrelid), col_description(a.attrelid,a.attnum) \
         FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum \
         WHERE a.attrelid={oid} AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum")).await?;

    let pk_rows = query(client, &format!(
        "SELECT a.attname FROM pg_constraint con \
         JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=ANY(con.conkey) \
         WHERE con.conrelid={oid} AND con.contype='p'")).await?;
    let fk_rows = query(client, &format!(
        "SELECT a.attname FROM pg_constraint con \
         JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=ANY(con.conkey) \
         WHERE con.conrelid={oid} AND con.contype='f'")).await?;
    let pk: HashSet<String> = pk_rows.iter().map(|r| cell(r, 0)).collect();
    let fk: HashSet<String> = fk_rows.iter().map(|r| cell(r, 0)).collect();

    let columns = col_rows
        .iter()
        .map(|r| {
            let nm = cell(r, 0);
            Column {
                is_pk: pk.contains(&nm),
                is_fk: fk.contains(&nm),
                name: nm,
                data_type: cell(r, 1),
                nullable: cell(r, 2) == "t",
                default: r.get(3).and_then(|v| v.clone()),
                comment: r.get(4).and_then(|v| v.clone()),
            }
        })
        .collect();

    // Indexes — fetched for tables and materialized views (both can have them).
    let idx_rows = query(client, &format!(
        "SELECT ic.relname, i.indisunique, i.indisprimary, pg_get_indexdef(i.indexrelid) \
         FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid \
         WHERE i.indrelid={oid} ORDER BY ic.relname")).await?;
    let indexes = idx_rows
        .iter()
        .map(|r| Index {
            name: cell(r, 0),
            unique: cell(r, 1) == "t",
            primary: cell(r, 2) == "t",
            def: cell(r, 3),
        })
        .collect();

    let con_rows = query(client, &format!(
        "SELECT con.conname, con.contype::text, pg_get_constraintdef(con.oid) FROM pg_constraint con \
         WHERE con.conrelid={oid} AND con.contype IN ('p','f','u','c') ORDER BY con.contype, con.conname")).await?;
    let kind_of = |c: &str| match c {
        "p" => "primary_key",
        "f" => "foreign_key",
        "u" => "unique",
        "c" => "check",
        _ => "other",
    }
    .to_string();
    let constraints = con_rows
        .iter()
        .map(|r| Constraint {
            name: cell(r, 0),
            kind: kind_of(&cell(r, 1)),
            def: cell(r, 2),
        })
        .collect();

    // User triggers only — FK-internal triggers are noise (tgisinternal).
    let trg_rows = query(client, &format!(
        "SELECT t.tgname, pg_get_triggerdef(t.oid) FROM pg_trigger t \
         WHERE t.tgrelid={oid} AND NOT t.tgisinternal ORDER BY t.tgname")).await?;
    let triggers = trg_rows
        .iter()
        .map(|r| Trigger {
            name: cell(r, 0),
            def: cell(r, 1),
        })
        .collect();

    let comment = query(client, &format!("SELECT obj_description({oid},'pg_class')"))
        .await?
        .into_iter()
        .next()
        .and_then(|r| r.into_iter().next().flatten());

    Ok(RelationDetail {
        name: name.to_string(),
        kind,
        comment,
        columns,
        indexes,
        constraints,
        triggers,
    })
}
