//! Postgres permission model. The UI gates sidebar actions on the *effective* privileges
//! of the connected role (membership + PUBLIC + ownership all accounted for, via
//! `has_*_privilege`). Computed on connect + refreshed on every introspection reload.
//!
//! Bare booleans from `has_*_privilege(...)` come back as `"t"`/`"f"` over the text
//! protocol — do NOT `::text`-cast them (that yields `"true"`/`"false"`); compare to `"t"`.

use crate::db::{collect_rows, AppError};
use serde::Serialize;
use tokio_postgres::Client;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TablePriv {
    pub schema: String,
    pub name: String,
    pub select: bool,
    pub insert: bool,
    pub update: bool,
    pub delete: bool,
    pub truncate: bool,
    pub references: bool,
    pub trigger: bool,
    pub is_owner: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SchemaPriv {
    pub name: String,
    pub create: bool,
    pub usage: bool,
    pub is_owner: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    /// Whether the driver has a permission model the UI should gate on. False for
    /// embedded/MySQL (the UI then imposes no extra restrictions).
    pub enforced: bool,
    pub current_user: String,
    pub is_superuser: bool,
    pub can_create_db: bool,
    pub can_create_role: bool,
    pub create_in_current_db: bool,
    pub schemas: Vec<SchemaPriv>,
    pub tables: Vec<TablePriv>,
}

impl Permissions {
    /// Permissive default for drivers without a permission model — the UI gates nothing.
    pub fn unrestricted() -> Self {
        Self {
            enforced: false,
            current_user: String::new(),
            is_superuser: true,
            can_create_db: true,
            can_create_role: true,
            create_in_current_db: true,
            schemas: vec![],
            tables: vec![],
        }
    }
}

fn b(r: &[Option<String>], i: usize) -> bool {
    r.get(i).and_then(|v| v.as_deref()) == Some("t")
}
fn s(r: &[Option<String>], i: usize) -> String {
    r.get(i).and_then(|v| v.clone()).unwrap_or_default()
}

async fn query(client: &Client, sql: &str) -> Result<Vec<Vec<Option<String>>>, AppError> {
    Ok(collect_rows(&client.simple_query(sql).await?)?.1)
}

const NS: &str = "n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') \
                  AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast_temp%'";

/// Compute the connected role's effective privileges (Postgres).
pub async fn collect(client: &Client) -> Result<Permissions, AppError> {
    // role attributes
    let role = query(
        client,
        "SELECT current_user, rolsuper, rolcreatedb, rolcreaterole \
         FROM pg_roles WHERE rolname = current_user",
    )
    .await?;
    let r0 = role.first().cloned().unwrap_or_default();
    let current_user = s(&r0, 0);
    let is_superuser = b(&r0, 1);
    let can_create_db = b(&r0, 2);
    let can_create_role = b(&r0, 3);

    let dbc = query(
        client,
        "SELECT has_database_privilege(current_database(), 'CREATE')",
    )
    .await?;
    let create_in_current_db = b(&dbc.first().cloned().unwrap_or_default(), 0);

    // per-schema CREATE/USAGE + ownership
    let schema_rows = query(
        client,
        &format!(
            "SELECT n.nspname, \
                has_schema_privilege(n.oid,'CREATE'), \
                has_schema_privilege(n.oid,'USAGE'), \
                (pg_catalog.pg_get_userbyid(n.nspowner) = current_user) \
             FROM pg_namespace n WHERE {NS} ORDER BY n.nspname"
        ),
    )
    .await?;
    let schemas = schema_rows
        .iter()
        .map(|r| SchemaPriv {
            name: s(r, 0),
            create: b(r, 1),
            usage: b(r, 2),
            is_owner: b(r, 3),
        })
        .collect();

    // per-relation privileges + ownership, one catalog scan (tables/views/matviews/parts)
    let table_rows = query(
        client,
        &format!(
            "SELECT n.nspname, c.relname, \
                has_table_privilege(c.oid,'SELECT'), \
                has_table_privilege(c.oid,'INSERT'), \
                has_table_privilege(c.oid,'UPDATE'), \
                has_table_privilege(c.oid,'DELETE'), \
                has_table_privilege(c.oid,'TRUNCATE'), \
                has_table_privilege(c.oid,'REFERENCES'), \
                has_table_privilege(c.oid,'TRIGGER'), \
                (pg_catalog.pg_get_userbyid(c.relowner) = current_user) \
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind IN ('r','v','m','p') AND {NS} \
             ORDER BY n.nspname, c.relname"
        ),
    )
    .await?;
    let tables = table_rows
        .iter()
        .map(|r| TablePriv {
            schema: s(r, 0),
            name: s(r, 1),
            select: b(r, 2),
            insert: b(r, 3),
            update: b(r, 4),
            delete: b(r, 5),
            truncate: b(r, 6),
            references: b(r, 7),
            trigger: b(r, 8),
            is_owner: b(r, 9),
        })
        .collect();

    Ok(Permissions {
        enforced: true,
        current_user,
        is_superuser,
        can_create_db,
        can_create_role,
        create_in_current_db,
        schemas,
        tables,
    })
}
