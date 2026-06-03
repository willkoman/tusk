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

#[derive(Serialize)]
pub struct Relation {
    pub name: String,
    pub kind: String, // table | view | matview
    pub columns: Vec<Column>,
    pub indexes: Vec<Index>,
    pub constraints: Vec<Constraint>,
}

#[derive(Serialize, Clone)]
pub struct Func {
    pub name: String,
    pub args: String,
    pub returns: String,
}

#[derive(Serialize)]
pub struct Schema {
    pub name: String,
    pub tables: Vec<Relation>,
    pub views: Vec<Relation>,
    pub sequences: Vec<String>,
    pub functions: Vec<Func>,
}

#[derive(Serialize)]
pub struct DbTree {
    pub database: String,
    pub databases: Vec<String>,
    pub schemas: Vec<Schema>,
}

fn cell(r: &[Option<String>], i: usize) -> String {
    r.get(i).and_then(|v| v.clone()).unwrap_or_default()
}

async fn query(client: &Client, sql: &str) -> Result<Vec<Vec<Option<String>>>, AppError> {
    let msgs = client.simple_query(sql).await?;
    Ok(collect_rows(&msgs).1)
}

const NS: &str = "n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast_temp%'";

pub async fn build(client: &Client) -> Result<DbTree, AppError> {
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

    let rel_rows = query(client, &format!(
        "SELECT n.nspname, c.relname, c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace \
         WHERE c.relkind IN ('r','p','v','m','S') AND {NS} ORDER BY n.nspname, c.relname")).await?;

    let col_rows = query(client, &format!(
        "SELECT n.nspname, c.relname, a.attname, format_type(a.atttypid,a.atttypmod), (NOT a.attnotnull)::text, pg_get_expr(d.adbin,d.adrelid) \
         FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace \
         LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum \
         WHERE a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m') AND {NS} \
         ORDER BY n.nspname, c.relname, a.attnum")).await?;

    let pk_rows = query(client, &format!(
        "SELECT n.nspname, c.relname, a.attname FROM pg_constraint con \
         JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace \
         JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=ANY(con.conkey) \
         WHERE con.contype='p' AND {NS}")).await?;

    let fk_rows = query(client, &format!(
        "SELECT n.nspname, c.relname, a.attname FROM pg_constraint con \
         JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace \
         JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=ANY(con.conkey) \
         WHERE con.contype='f' AND {NS}")).await?;

    let idx_rows = query(client, &format!(
        "SELECT n.nspname, c.relname, ic.relname, i.indisunique::text, i.indisprimary::text, pg_get_indexdef(i.indexrelid) \
         FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_class ic ON ic.oid=i.indexrelid \
         JOIN pg_namespace n ON n.oid=c.relnamespace WHERE {NS} ORDER BY n.nspname, c.relname, ic.relname")).await?;

    let con_rows = query(client, &format!(
        "SELECT n.nspname, c.relname, con.conname, con.contype::text, pg_get_constraintdef(con.oid) \
         FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace \
         WHERE con.contype IN ('p','f','u','c') AND {NS} ORDER BY n.nspname, c.relname, con.contype, con.conname")).await?;

    let fn_rows = query(client, &format!(
        "SELECT n.nspname, p.proname, pg_get_function_arguments(p.oid), pg_get_function_result(p.oid) \
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE {NS} ORDER BY n.nspname, p.proname")).await?;

    let key3 = |r: &Vec<Option<String>>| (cell(r, 0), cell(r, 1), cell(r, 2));
    let pk: HashSet<(String, String, String)> = pk_rows.iter().map(key3).collect();
    let fk: HashSet<(String, String, String)> = fk_rows.iter().map(key3).collect();

    let mut cols: HashMap<(String, String), Vec<Column>> = HashMap::new();
    for r in &col_rows {
        let (s, t, name) = (cell(r, 0), cell(r, 1), cell(r, 2));
        let is_pk = pk.contains(&(s.clone(), t.clone(), name.clone()));
        let is_fk = fk.contains(&(s.clone(), t.clone(), name.clone()));
        cols.entry((s, t)).or_default().push(Column {
            name,
            data_type: cell(r, 3),
            nullable: cell(r, 4) == "t",
            is_pk,
            is_fk,
            default: r.get(5).and_then(|v| v.clone()),
        });
    }

    let mut idxs: HashMap<(String, String), Vec<Index>> = HashMap::new();
    for r in &idx_rows {
        idxs.entry((cell(r, 0), cell(r, 1))).or_default().push(Index {
            name: cell(r, 2),
            unique: cell(r, 3) == "t",
            primary: cell(r, 4) == "t",
            def: cell(r, 5),
        });
    }

    let kind_of = |c: &str| match c {
        "p" => "primary_key",
        "f" => "foreign_key",
        "u" => "unique",
        "c" => "check",
        _ => "other",
    }
    .to_string();
    let mut cons: HashMap<(String, String), Vec<Constraint>> = HashMap::new();
    for r in &con_rows {
        cons.entry((cell(r, 0), cell(r, 1))).or_default().push(Constraint {
            name: cell(r, 2),
            kind: kind_of(&cell(r, 3)),
            def: cell(r, 4),
        });
    }

    let mut funcs: HashMap<String, Vec<Func>> = HashMap::new();
    for r in &fn_rows {
        funcs.entry(cell(r, 0)).or_default().push(Func {
            name: cell(r, 1),
            args: cell(r, 2),
            returns: cell(r, 3),
        });
    }

    let mut schema_names: BTreeSet<String> = BTreeSet::new();
    let mut rels: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for r in &rel_rows {
        let s = cell(r, 0);
        schema_names.insert(s.clone());
        rels.entry(s).or_default().push((cell(r, 1), cell(r, 2)));
    }
    for k in funcs.keys() {
        schema_names.insert(k.clone());
    }

    let mut schemas = Vec::new();
    for s in schema_names {
        let mut tables = Vec::new();
        let mut views = Vec::new();
        let mut sequences = Vec::new();
        if let Some(list) = rels.get(&s) {
            for (name, kind) in list {
                let key = (s.clone(), name.clone());
                match kind.as_str() {
                    "r" | "p" => tables.push(Relation {
                        name: name.clone(),
                        kind: "table".into(),
                        columns: cols.get(&key).cloned().unwrap_or_default(),
                        indexes: idxs.get(&key).cloned().unwrap_or_default(),
                        constraints: cons.get(&key).cloned().unwrap_or_default(),
                    }),
                    "v" | "m" => views.push(Relation {
                        name: name.clone(),
                        kind: if kind == "m" { "matview".into() } else { "view".into() },
                        columns: cols.get(&key).cloned().unwrap_or_default(),
                        indexes: Vec::new(),
                        constraints: Vec::new(),
                    }),
                    "S" => sequences.push(name.clone()),
                    _ => {}
                }
            }
        }
        schemas.push(Schema {
            name: s.clone(),
            tables,
            views,
            sequences,
            functions: funcs.get(&s).cloned().unwrap_or_default(),
        });
    }

    Ok(DbTree {
        database,
        databases,
        schemas,
    })
}
