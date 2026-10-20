//! The monitor's per-view tiers (plan §2.4–2.5): Locks, Replication, Tables &
//! maintenance (progress + table stats + wraparound), I/O and Statements. Each runs
//! only while its view is open, on its own cadence, and degrades to a note on a
//! server version or privilege that cannot answer instead of failing the tick.
//!
//! Pure SQL builders and parsers live here, plus the two keyed trackers that turn
//! cumulative counters into per-interval figures (`IoTracker`, `StatementTracker`).
//! `PgSession` runs them.

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::pg::{boolean, cell, clamp_u32, int, opt_int, pid_array, text, Row};
use crate::db::AppError;

/// `pg_locks.waitstart` arrived in PostgreSQL 14.
const WAITSTART_VERSION_NUM: i32 = 140_000;
/// `pg_stat_wal_receiver.sender_host` arrived in 11.
const SENDER_HOST_VERSION_NUM: i32 = 110_000;
/// `wal_status` / `safe_wal_size` on slots, `pg_stat_progress_analyze` and
/// `_basebackup` arrived in 13.
const PG13: i32 = 130_000;
/// `pg_stat_progress_create_index` and `_cluster` arrived in 12.
const PG12: i32 = 120_000;
/// `pg_stat_progress_copy` arrived in 14.
const PG14: i32 = 140_000;
/// `pg_stat_io` arrived in 16.
pub(crate) const IO_VERSION_NUM: i32 = 160_000;

/// Rows a view list returns at most (each list states how many there were).
pub(crate) const VIEW_ROWS: usize = 200;
/// Statements kept per interval (by time spent in that interval).
pub(crate) const STATEMENT_TOP: usize = 50;
/// Statement texts remembered between fetches, so the query-text file is read only
/// for statements not seen before.
const STATEMENT_TEXT_CACHE: usize = 2048;

/// Which views are open (and so which tiers run). Sent whole with every configure.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ViewSet {
    pub locks: bool,
    pub statements: bool,
    pub replication: bool,
    pub tables: bool,
    pub io: bool,
}

/// A tier and how often it runs while its view is open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Tier {
    Locks,
    Replication,
    Progress,
    Maintenance,
    Io,
    Statements,
}

impl Tier {
    pub(crate) const ALL: [Tier; 6] = [
        Tier::Locks,
        Tier::Replication,
        Tier::Progress,
        Tier::Maintenance,
        Tier::Io,
        Tier::Statements,
    ];

    pub(crate) fn every(self) -> Duration {
        Duration::from_secs(match self {
            Tier::Locks | Tier::Progress => 2,
            Tier::Replication => 5,
            Tier::Io | Tier::Statements => 10,
            Tier::Maintenance => 30,
        })
    }

    pub(crate) fn enabled(self, views: ViewSet) -> bool {
        match self {
            Tier::Locks => views.locks,
            Tier::Replication => views.replication,
            Tier::Progress | Tier::Maintenance => views.tables,
            Tier::Io => views.io,
            Tier::Statements => views.statements,
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Tier::Locks => "locks",
            Tier::Replication => "replication",
            Tier::Progress => "progress",
            Tier::Maintenance => "maintenance",
            Tier::Io => "io",
            Tier::Statements => "statements",
        }
    }
}

// ---------------------------------------------------------------- locks -------

/// Name of a lock's target, readable. A relation OID only means something in the
/// database it belongs to, so another database's relation is named by OID.
fn lock_target(alias: &str) -> String {
    let rel = format!(
        "(CASE WHEN {a}.database IN (0, (SELECT oid FROM pg_database WHERE datname = current_database())) \
               THEN {a}.relation::regclass::text \
               ELSE 'relation ' || {a}.relation || ' in another database' END)",
        a = alias
    );
    format!(
        "(CASE {a}.locktype \
            WHEN 'relation' THEN {rel} \
            WHEN 'extend' THEN {rel} || ' (extend)' \
            WHEN 'page' THEN {rel} || ' page ' || {a}.page \
            WHEN 'tuple' THEN {rel} || ' (' || {a}.page || ',' || {a}.tuple || ')' \
            WHEN 'transactionid' THEN 'transaction ' || {a}.transactionid \
            WHEN 'virtualxid' THEN 'virtual transaction ' || {a}.virtualxid \
            WHEN 'advisory' THEN 'advisory ' || {a}.classid || ':' || {a}.objid || ':' || {a}.objsubid \
            ELSE {a}.locktype || ' ' || coalesce({a}.classid::text, '') || ':' || coalesce({a}.objid::text, '') END)",
        a = alias
    )
}

/// Locks waiting to be granted, with who blocks them. `pg_blocking_pids` runs only
/// on these rows.
pub(crate) fn lock_waits_sql(version_num: i32) -> String {
    let waited = if version_num >= WAITSTART_VERSION_NUM {
        "floor(extract(epoch FROM clock_timestamp() - l.waitstart) * 1000)::bigint"
    } else {
        "NULL::bigint"
    };
    format!(
        "SELECT l.pid, a.backend_start::text AS backend_start, l.locktype, l.mode, \
    {target} AS target, \
    a.usename AS usr, a.datname AS db, a.application_name AS app, a.state, \
    {waited} AS waited_ms, \
    floor(extract(epoch FROM a.xact_start) * 1000)::bigint AS xact_ms, \
    pg_blocking_pids(l.pid)::text AS blocked_by, \
    left(a.query, 1024) AS query, \
    count(*) OVER () AS total \
  FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid \
 WHERE NOT l.granted AND l.pid IS DISTINCT FROM pg_backend_pid() \
 ORDER BY {waited} DESC NULLS LAST, l.pid \
 LIMIT {VIEW_ROWS}",
        target = lock_target("l"),
    )
}

/// Granted locks grouped by target and mode. A transaction's own `virtualxid` and
/// `transactionid` locks (every transaction holds them) are left out as noise.
pub(crate) fn lock_holds_sql() -> String {
    format!(
        "SELECT g.locktype, g.mode, {target} AS target, g.n, g.pids::text AS pids, \
    sum(g.n) OVER () AS total, count(*) OVER () AS groups \
  FROM (SELECT l.locktype, l.mode, l.database, l.relation, l.page, l.tuple, \
               NULL::text AS transactionid, NULL::text AS virtualxid, l.classid, l.objid, l.objsubid, \
               count(*) AS n, (array_agg(DISTINCT l.pid ORDER BY l.pid))[1:10] AS pids \
          FROM pg_locks l \
         WHERE l.granted AND l.pid IS DISTINCT FROM pg_backend_pid() \
           AND l.locktype NOT IN ('virtualxid', 'transactionid') \
         GROUP BY l.locktype, l.mode, l.database, l.relation, l.page, l.tuple, \
                  l.classid, l.objid, l.objsubid) g \
 ORDER BY g.n DESC, g.locktype, g.mode \
 LIMIT {VIEW_ROWS}",
        target = lock_target("g"),
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LockWait {
    pub pid: i32,
    pub backend_start: String,
    pub locktype: String,
    pub mode: String,
    pub target: String,
    pub user: Option<String>,
    pub database: Option<String>,
    pub application: Option<String>,
    pub state: Option<String>,
    /// How long it has waited (`waitstart`, PostgreSQL 14+).
    pub waited_ms: Option<i64>,
    pub xact_start_ms: Option<i64>,
    pub blocked_by: Vec<i32>,
    pub query: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LockHold {
    pub locktype: String,
    pub mode: String,
    pub target: String,
    pub count: u32,
    /// Up to ten holding pids.
    pub pids: Vec<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Locks {
    pub waiting: Vec<LockWait>,
    pub waiting_total: u32,
    pub held: Vec<LockHold>,
    /// Granted locks counted in `held` (the noise types excluded), and their groups.
    pub held_total: u32,
    pub held_groups: u32,
}

pub(crate) fn parse_locks(
    wait_cols: &[String],
    wait_rows: &[Row],
    hold_cols: &[String],
    hold_rows: &[Row],
) -> Result<Locks, AppError> {
    let mut waiting = Vec::with_capacity(wait_rows.len());
    let mut waiting_total = 0;
    for r in wait_rows {
        let Ok(pid) = i32::try_from(int(wait_cols, r, "pid")?) else {
            continue;
        };
        waiting_total = clamp_u32(int(wait_cols, r, "total")?).max(waiting_total);
        waiting.push(LockWait {
            pid,
            backend_start: text(wait_cols, r, "backend_start").unwrap_or_default(),
            locktype: text(wait_cols, r, "locktype").unwrap_or_default(),
            mode: text(wait_cols, r, "mode").unwrap_or_default(),
            target: text(wait_cols, r, "target").unwrap_or_default(),
            user: text(wait_cols, r, "usr"),
            database: text(wait_cols, r, "db"),
            application: text(wait_cols, r, "app"),
            state: text(wait_cols, r, "state"),
            waited_ms: opt_int(wait_cols, r, "waited_ms")?.map(|v| v.max(0)),
            xact_start_ms: opt_int(wait_cols, r, "xact_ms")?,
            blocked_by: pid_array(cell(wait_cols, r, "blocked_by")),
            query: text(wait_cols, r, "query"),
        });
    }
    let mut held = Vec::with_capacity(hold_rows.len());
    let mut held_total = 0;
    let mut held_groups = 0;
    for r in hold_rows {
        held_total = clamp_u32(int(hold_cols, r, "total")?).max(held_total);
        held_groups = clamp_u32(int(hold_cols, r, "groups")?).max(held_groups);
        held.push(LockHold {
            locktype: text(hold_cols, r, "locktype").unwrap_or_default(),
            mode: text(hold_cols, r, "mode").unwrap_or_default(),
            target: text(hold_cols, r, "target").unwrap_or_default(),
            count: clamp_u32(int(hold_cols, r, "n")?),
            pids: pid_array(cell(hold_cols, r, "pids")),
        });
    }
    Ok(Locks {
        waiting_total: waiting_total.max(waiting.len() as u32),
        waiting,
        held_total,
        held_groups: held_groups.max(held.len() as u32),
        held,
    })
}

// ---------------------------------------------------------------- replication -

/// Current WAL position: written on a primary, received on a (cascading) standby.
const CURRENT_LSN: &str =
    "(CASE WHEN pg_is_in_recovery() THEN pg_last_wal_receive_lsn() ELSE pg_current_wal_lsn() END)";

pub(crate) fn replicas_sql() -> String {
    format!(
        "SELECT pid, application_name AS app, coalesce(host(client_addr), 'local') AS client, \
    state, sync_state, \
    pg_wal_lsn_diff({CURRENT_LSN}, sent_lsn)::bigint AS sent_bytes, \
    pg_wal_lsn_diff({CURRENT_LSN}, write_lsn)::bigint AS write_bytes, \
    pg_wal_lsn_diff({CURRENT_LSN}, flush_lsn)::bigint AS flush_bytes, \
    pg_wal_lsn_diff({CURRENT_LSN}, replay_lsn)::bigint AS replay_bytes, \
    floor(extract(epoch FROM write_lag) * 1000)::bigint AS write_lag_ms, \
    floor(extract(epoch FROM flush_lag) * 1000)::bigint AS flush_lag_ms, \
    floor(extract(epoch FROM replay_lag) * 1000)::bigint AS replay_lag_ms \
  FROM pg_stat_replication \
 ORDER BY application_name, pid \
 LIMIT {VIEW_ROWS}"
    )
}

pub(crate) fn slots_sql(version_num: i32) -> String {
    let (wal_status, safe) = if version_num >= PG13 {
        ("wal_status", "safe_wal_size")
    } else {
        ("NULL::text", "NULL::bigint")
    };
    format!(
        "SELECT slot_name, slot_type, plugin, database, active, active_pid, \
    pg_wal_lsn_diff({CURRENT_LSN}, restart_lsn)::bigint AS retained_bytes, \
    {wal_status} AS wal_status, {safe} AS safe_wal_size \
  FROM pg_replication_slots \
 ORDER BY slot_name \
 LIMIT {VIEW_ROWS}"
    )
}

/// The standby's view of itself. Every recovery-only function sits behind a CASE.
pub(crate) fn receiver_sql(version_num: i32) -> String {
    let sender = if version_num >= SENDER_HOST_VERSION_NUM {
        "(SELECT sender_host FROM pg_stat_wal_receiver)"
    } else {
        "NULL::text"
    };
    format!(
        "SELECT pg_is_in_recovery() AS in_recovery, \
    (SELECT status FROM pg_stat_wal_receiver) AS status, \
    {sender} AS sender, \
    (CASE WHEN pg_is_in_recovery() \
          THEN pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()) END)::bigint AS replay_backlog_bytes, \
    floor(extract(epoch FROM clock_timestamp() - (SELECT last_msg_receipt_time FROM pg_stat_wal_receiver)) * 1000)::bigint \
      AS last_message_ms, \
    (CASE WHEN pg_is_in_recovery() THEN pg_is_wal_replay_paused() END) AS replay_paused, \
    (CASE WHEN pg_is_in_recovery() \
          THEN floor(extract(epoch FROM clock_timestamp() - pg_last_xact_replay_timestamp()) * 1000) END)::bigint \
      AS replay_age_ms"
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Replica {
    pub pid: i32,
    pub application: Option<String>,
    pub client: Option<String>,
    pub state: Option<String>,
    pub sync_state: Option<String>,
    pub sent_bytes: Option<i64>,
    pub write_bytes: Option<i64>,
    pub flush_bytes: Option<i64>,
    pub replay_bytes: Option<i64>,
    pub write_lag_ms: Option<i64>,
    pub flush_lag_ms: Option<i64>,
    pub replay_lag_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Slot {
    pub name: String,
    pub slot_type: Option<String>,
    pub plugin: Option<String>,
    pub database: Option<String>,
    pub active: bool,
    pub active_pid: Option<i64>,
    /// WAL the server keeps for this slot.
    pub retained_bytes: Option<i64>,
    /// `reserved` / `extended` / `unreserved` / `lost` (PostgreSQL 13+).
    pub wal_status: Option<String>,
    pub safe_wal_size: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receiver {
    pub status: Option<String>,
    pub sender: Option<String>,
    /// Received but not yet replayed.
    pub replay_backlog_bytes: Option<i64>,
    pub last_message_ms: Option<i64>,
    pub replay_paused: bool,
    /// Since the last replayed transaction; also grows while the primary is idle.
    pub replay_age_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Replication {
    pub standby: bool,
    pub replicas: Vec<Replica>,
    pub slots: Vec<Slot>,
    pub receiver: Option<Receiver>,
}

pub(crate) fn parse_replication(
    rep: (&[String], &[Row]),
    slots: (&[String], &[Row]),
    recv: (&[String], &[Row]),
) -> Result<Replication, AppError> {
    let (c, rows) = rep;
    let mut replicas = Vec::with_capacity(rows.len());
    for r in rows {
        let Ok(pid) = i32::try_from(int(c, r, "pid")?) else {
            continue;
        };
        replicas.push(Replica {
            pid,
            application: text(c, r, "app"),
            client: text(c, r, "client"),
            state: text(c, r, "state"),
            sync_state: text(c, r, "sync_state"),
            sent_bytes: opt_int(c, r, "sent_bytes")?,
            write_bytes: opt_int(c, r, "write_bytes")?,
            flush_bytes: opt_int(c, r, "flush_bytes")?,
            replay_bytes: opt_int(c, r, "replay_bytes")?,
            write_lag_ms: opt_int(c, r, "write_lag_ms")?,
            flush_lag_ms: opt_int(c, r, "flush_lag_ms")?,
            replay_lag_ms: opt_int(c, r, "replay_lag_ms")?,
        });
    }
    let (c, rows) = slots;
    let mut out_slots = Vec::with_capacity(rows.len());
    for r in rows {
        out_slots.push(Slot {
            name: text(c, r, "slot_name").unwrap_or_default(),
            slot_type: text(c, r, "slot_type"),
            plugin: text(c, r, "plugin"),
            database: text(c, r, "database"),
            active: boolean(c, r, "active"),
            active_pid: opt_int(c, r, "active_pid")?,
            retained_bytes: opt_int(c, r, "retained_bytes")?,
            wal_status: text(c, r, "wal_status"),
            safe_wal_size: opt_int(c, r, "safe_wal_size")?,
        });
    }
    let (c, rows) = recv;
    let row = rows.first();
    let standby = row.is_some_and(|r| boolean(c, r, "in_recovery"));
    let receiver = match row {
        Some(r) if standby => Some(Receiver {
            status: text(c, r, "status"),
            sender: text(c, r, "sender"),
            replay_backlog_bytes: opt_int(c, r, "replay_backlog_bytes")?,
            last_message_ms: opt_int(c, r, "last_message_ms")?,
            replay_paused: boolean(c, r, "replay_paused"),
            replay_age_ms: opt_int(c, r, "replay_age_ms")?,
        }),
        _ => None,
    };
    Ok(Replication {
        standby,
        replicas,
        slots: out_slots,
        receiver,
    })
}

// ---------------------------------------------------------------- progress ----

/// A relation in a progress view, readable when it is in this database.
fn progress_rel(alias: &str) -> String {
    format!(
        "(CASE WHEN {a}.datid = (SELECT oid FROM pg_database WHERE datname = current_database()) \
               THEN {a}.relid::regclass::text ELSE 'relation ' || {a}.relid END)",
        a = alias
    )
}

/// Every long-running maintenance command the server reports progress for, one
/// UNION ALL branch per `pg_stat_progress_*` view the version has.
pub(crate) fn progress_sql(version_num: i32) -> String {
    let rel = progress_rel("p");
    let mut parts = vec![format!(
        "SELECT 'vacuum' AS kind, p.pid, p.datname AS db, {rel} AS rel, p.phase::text AS phase, \
                p.heap_blks_scanned::bigint AS done, p.heap_blks_total::bigint AS total, 'blocks' AS unit \
           FROM pg_stat_progress_vacuum p"
    )];
    if version_num >= PG12 {
        parts.push(format!(
            "SELECT 'create index', p.pid, p.datname, {rel}, p.phase::text, \
                    (CASE WHEN p.blocks_total > 0 THEN p.blocks_done ELSE p.tuples_done END)::bigint, \
                    (CASE WHEN p.blocks_total > 0 THEN p.blocks_total ELSE p.tuples_total END)::bigint, \
                    CASE WHEN p.blocks_total > 0 THEN 'blocks' ELSE 'tuples' END \
               FROM pg_stat_progress_create_index p"
        ));
        parts.push(format!(
            "SELECT lower(p.command), p.pid, p.datname, {rel}, p.phase::text, \
                    p.heap_blks_scanned::bigint, p.heap_blks_total::bigint, 'blocks' \
               FROM pg_stat_progress_cluster p"
        ));
    }
    if version_num >= PG13 {
        parts.push(format!(
            "SELECT 'analyze', p.pid, p.datname, {rel}, p.phase::text, \
                    p.sample_blks_scanned::bigint, p.sample_blks_total::bigint, 'blocks' \
               FROM pg_stat_progress_analyze p"
        ));
        parts.push(
            "SELECT 'base backup', p.pid, NULL::name, NULL::text, p.phase::text, \
                    p.backup_streamed::bigint, nullif(p.backup_total, 0)::bigint, 'bytes' \
               FROM pg_stat_progress_basebackup p"
                .to_string(),
        );
    }
    if version_num >= PG14 {
        parts.push(format!(
            "SELECT lower(p.command), p.pid, p.datname, \
                    CASE WHEN p.relid = 0 THEN NULL ELSE {rel} END, p.type::text, \
                    (CASE WHEN p.bytes_total > 0 THEN p.bytes_processed ELSE p.tuples_processed END)::bigint, \
                    nullif(p.bytes_total, 0)::bigint, \
                    CASE WHEN p.bytes_total > 0 THEN 'bytes' ELSE 'tuples' END \
               FROM pg_stat_progress_copy p"
        ));
    }
    format!(
        "SELECT q.kind, q.pid, q.db, q.rel, q.phase, q.done, q.total, q.unit, \
    a.backend_start::text AS backend_start, \
    floor(extract(epoch FROM a.query_start) * 1000)::bigint AS started_ms, \
    left(a.query, 1024) AS query \
  FROM ({}) q LEFT JOIN pg_stat_activity a ON a.pid = q.pid \
 WHERE q.pid IS DISTINCT FROM pg_backend_pid() \
 ORDER BY a.query_start NULLS LAST, q.pid \
 LIMIT {VIEW_ROWS}",
        parts.join(" UNION ALL ")
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    pub kind: String,
    pub pid: i32,
    pub backend_start: Option<String>,
    pub database: Option<String>,
    pub relation: Option<String>,
    pub phase: Option<String>,
    pub done: Option<i64>,
    /// None when the server cannot say how much there is.
    pub total: Option<i64>,
    pub unit: String,
    pub started_ms: Option<i64>,
    pub query: Option<String>,
}

pub(crate) fn parse_progress(c: &[String], rows: &[Row]) -> Result<Vec<Progress>, AppError> {
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let Ok(pid) = i32::try_from(int(c, r, "pid")?) else {
            continue;
        };
        out.push(Progress {
            kind: text(c, r, "kind").unwrap_or_default(),
            pid,
            backend_start: text(c, r, "backend_start"),
            database: text(c, r, "db"),
            relation: text(c, r, "rel"),
            phase: text(c, r, "phase"),
            done: opt_int(c, r, "done")?,
            total: opt_int(c, r, "total")?.filter(|t| *t > 0),
            unit: text(c, r, "unit").unwrap_or_default(),
            started_ms: opt_int(c, r, "started_ms")?,
            query: text(c, r, "query"),
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------- maintenance -

/// The tables that most need a vacuum (dead tuples) in this database.
pub(crate) const TABLES_SQL: &str =
    "SELECT schemaname AS schema, relname AS name, n_live_tup AS live, n_dead_tup AS dead, \
    n_mod_since_analyze AS modified, \
    floor(extract(epoch FROM last_vacuum) * 1000)::bigint AS last_vacuum_ms, \
    floor(extract(epoch FROM last_autovacuum) * 1000)::bigint AS last_autovacuum_ms, \
    floor(extract(epoch FROM last_analyze) * 1000)::bigint AS last_analyze_ms, \
    floor(extract(epoch FROM last_autoanalyze) * 1000)::bigint AS last_autoanalyze_ms, \
    vacuum_count, autovacuum_count, \
    pg_total_relation_size(relid) AS size_bytes, \
    count(*) OVER () AS total \
  FROM pg_stat_user_tables \
 ORDER BY n_dead_tup DESC NULLS LAST, schemaname, relname \
 LIMIT 50";

/// Transaction-ID headroom per database: how far each is from wraparound.
pub(crate) const WRAPAROUND_SQL: &str =
    "SELECT datname AS db, age(datfrozenxid)::bigint AS xid_age, \
    mxid_age(datminmxid)::bigint AS mxid_age, \
    current_setting('autovacuum_freeze_max_age')::bigint AS freeze_max_age \
  FROM pg_database \
 WHERE datallowconn \
 ORDER BY age(datfrozenxid) DESC \
 LIMIT 50";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TableStat {
    pub schema: String,
    pub name: String,
    pub live: Option<i64>,
    pub dead: Option<i64>,
    pub modified: Option<i64>,
    pub last_vacuum_ms: Option<i64>,
    pub last_autovacuum_ms: Option<i64>,
    pub last_analyze_ms: Option<i64>,
    pub last_autoanalyze_ms: Option<i64>,
    pub vacuum_count: Option<i64>,
    pub autovacuum_count: Option<i64>,
    pub size_bytes: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DatabaseAge {
    pub database: String,
    pub xid_age: i64,
    pub mxid_age: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Maintenance {
    pub tables: Vec<TableStat>,
    pub tables_total: u32,
    pub wraparound: Vec<DatabaseAge>,
    /// `autovacuum_freeze_max_age`: past it autovacuum forces a freeze.
    pub freeze_max_age: Option<i64>,
}

pub(crate) fn parse_maintenance(
    tables: (&[String], &[Row]),
    ages: (&[String], &[Row]),
) -> Result<Maintenance, AppError> {
    let (c, rows) = tables;
    let mut out = Vec::with_capacity(rows.len());
    let mut total = 0;
    for r in rows {
        total = clamp_u32(int(c, r, "total")?).max(total);
        out.push(TableStat {
            schema: text(c, r, "schema").unwrap_or_default(),
            name: text(c, r, "name").unwrap_or_default(),
            live: opt_int(c, r, "live")?,
            dead: opt_int(c, r, "dead")?,
            modified: opt_int(c, r, "modified")?,
            last_vacuum_ms: opt_int(c, r, "last_vacuum_ms")?,
            last_autovacuum_ms: opt_int(c, r, "last_autovacuum_ms")?,
            last_analyze_ms: opt_int(c, r, "last_analyze_ms")?,
            last_autoanalyze_ms: opt_int(c, r, "last_autoanalyze_ms")?,
            vacuum_count: opt_int(c, r, "vacuum_count")?,
            autovacuum_count: opt_int(c, r, "autovacuum_count")?,
            size_bytes: opt_int(c, r, "size_bytes")?,
        });
    }
    let (c, rows) = ages;
    let mut wraparound = Vec::with_capacity(rows.len());
    let mut freeze_max_age = None;
    for r in rows {
        freeze_max_age = opt_int(c, r, "freeze_max_age")?.or(freeze_max_age);
        wraparound.push(DatabaseAge {
            database: text(c, r, "db").unwrap_or_default(),
            xid_age: int(c, r, "xid_age")?,
            mxid_age: opt_int(c, r, "mxid_age")?,
        });
    }
    Ok(Maintenance {
        tables_total: total.max(out.len() as u32),
        tables: out,
        wraparound,
        freeze_max_age,
    })
}

// ---------------------------------------------------------------- I/O ---------

/// `pg_stat_io` (PostgreSQL 16+): operation counts by backend type, object and
/// context. Counts only — the byte columns changed shape in 18.
pub(crate) const IO_SQL: &str = "SELECT backend_type, object, context, \
    coalesce(reads, 0)::bigint AS reads, coalesce(writes, 0)::bigint AS writes, \
    coalesce(extends, 0)::bigint AS extends, coalesce(hits, 0)::bigint AS hits, \
    coalesce(evictions, 0)::bigint AS evictions, coalesce(reuses, 0)::bigint AS reuses, \
    coalesce(fsyncs, 0)::bigint AS fsyncs, \
    floor(extract(epoch FROM stats_reset) * 1000)::bigint AS stats_reset_ms \
  FROM pg_stat_io \
 LIMIT 500";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct IoCounters {
    reads: i64,
    writes: i64,
    extends: i64,
    hits: i64,
    evictions: i64,
    reuses: i64,
    fsyncs: i64,
    reset: Option<i64>,
}

impl IoCounters {
    fn fields(&self) -> [i64; 7] {
        [
            self.reads,
            self.writes,
            self.extends,
            self.hits,
            self.evictions,
            self.reuses,
            self.fsyncs,
        ]
    }
}

/// Operations per second for one backend type × object × context.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IoRow {
    pub backend_type: String,
    pub object: String,
    pub context: String,
    pub reads: f64,
    pub writes: f64,
    pub extends: f64,
    pub hits: f64,
    pub evictions: f64,
    pub reuses: f64,
    pub fsyncs: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Io {
    /// Seconds the rates are averaged over.
    pub seconds: f64,
    pub rows: Vec<IoRow>,
}

/// Turns successive `pg_stat_io` readings into rates, key by key. A key that goes
/// backwards (a `pg_stat_reset_shared('io')`) is a new baseline, not a negative rate.
#[derive(Default)]
pub(crate) struct IoTracker {
    last: HashMap<(String, String, String), IoCounters>,
    at: Option<Duration>,
}

impl IoTracker {
    pub(crate) fn clear(&mut self) {
        self.last.clear();
        self.at = None;
    }

    /// `None` for the first reading (nothing to diff yet).
    pub(crate) fn ingest(
        &mut self,
        c: &[String],
        rows: &[Row],
        at: Duration,
    ) -> Result<Option<Io>, AppError> {
        let mut now = HashMap::with_capacity(rows.len());
        for r in rows {
            let key = (
                text(c, r, "backend_type").unwrap_or_default(),
                text(c, r, "object").unwrap_or_default(),
                text(c, r, "context").unwrap_or_default(),
            );
            now.insert(
                key,
                IoCounters {
                    reads: int(c, r, "reads")?,
                    writes: int(c, r, "writes")?,
                    extends: int(c, r, "extends")?,
                    hits: int(c, r, "hits")?,
                    evictions: int(c, r, "evictions")?,
                    reuses: int(c, r, "reuses")?,
                    fsyncs: int(c, r, "fsyncs")?,
                    reset: opt_int(c, r, "stats_reset_ms")?,
                },
            );
        }
        let previous = std::mem::replace(&mut self.last, now);
        let before = self.at.replace(at);
        let Some(before) = before else {
            return Ok(None);
        };
        let dt = at.saturating_sub(before).as_secs_f64();
        if dt <= 0.0 {
            return Ok(None);
        }
        let mut out = Vec::new();
        for (key, cur) in &self.last {
            let Some(prev) = previous.get(key) else {
                continue;
            };
            if cur.reset != prev.reset
                || cur.fields().iter().zip(prev.fields()).any(|(n, p)| *n < p)
            {
                continue;
            }
            let per = |n: i64, p: i64| (n - p) as f64 / dt;
            out.push(IoRow {
                backend_type: key.0.clone(),
                object: key.1.clone(),
                context: key.2.clone(),
                reads: per(cur.reads, prev.reads),
                writes: per(cur.writes, prev.writes),
                extends: per(cur.extends, prev.extends),
                hits: per(cur.hits, prev.hits),
                evictions: per(cur.evictions, prev.evictions),
                reuses: per(cur.reuses, prev.reuses),
                fsyncs: per(cur.fsyncs, prev.fsyncs),
            });
        }
        let weight = |r: &IoRow| r.reads + r.writes + r.extends + r.hits + r.evictions;
        out.sort_by(|a, b| {
            weight(b)
                .total_cmp(&weight(a))
                .then_with(|| a.backend_type.cmp(&b.backend_type))
        });
        Ok(Some(Io {
            seconds: dt,
            rows: out,
        }))
    }
}

// ---------------------------------------------------------------- statements --

/// Where `pg_stat_statements` lives and which time column it has, when usable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StatementsSource {
    /// Quoted schema of the extension.
    pub schema: String,
    /// `total_exec_time` (extension 1.8+, PostgreSQL 13+) or `total_time`.
    pub time_column: &'static str,
}

pub(crate) const STATEMENTS_PROBE_SQL: &str = "SELECT n.nspname AS schema, \
    EXISTS (SELECT 1 FROM pg_attribute a \
             WHERE a.attrelid = (quote_ident(n.nspname) || '.pg_stat_statements')::regclass \
               AND a.attname = 'total_exec_time' AND NOT a.attisdropped) AS exec_time \
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace \
 WHERE e.extname = 'pg_stat_statements'";

/// Cumulative numbers for every statement (no text: reading the query-text file is
/// the expensive part), summed over top-level and nested entries.
pub(crate) fn statements_sql(src: &StatementsSource) -> String {
    format!(
        "SELECT s.queryid::text AS queryid, s.userid::text AS userid, s.dbid::text AS dbid, \
    sum(s.calls)::bigint AS calls, sum(s.{time})::float8 AS exec_ms, sum(s.rows)::bigint AS rows, \
    sum(s.shared_blks_hit)::bigint AS hits, sum(s.shared_blks_read)::bigint AS reads, \
    count(*) OVER () AS total \
  FROM {schema}.pg_stat_statements(false) s \
 WHERE s.queryid IS NOT NULL \
 GROUP BY s.queryid, s.userid, s.dbid \
 ORDER BY sum(s.{time}) DESC \
 LIMIT {limit}",
        time = src.time_column,
        schema = src.schema,
        limit = crate::db::MONITOR_STATEMENT_LIMITS.max_rows,
    )
}

/// Text, role and database for the statements a fetch is about to show. `keys` are
/// parsed integers, so the IN list is Tusk's own text.
pub(crate) fn statement_texts_sql(src: &StatementsSource, queryids: &[i64]) -> String {
    let list = queryids
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SELECT s.queryid::text AS queryid, s.userid::text AS userid, s.dbid::text AS dbid, \
    left(s.query, 1024) AS query, r.rolname AS usr, d.datname AS db \
  FROM {schema}.pg_stat_statements(true) s \
  LEFT JOIN pg_roles r ON r.oid = s.userid \
  LEFT JOIN pg_database d ON d.oid = s.dbid \
 WHERE s.queryid IN ({list})",
        schema = src.schema,
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
struct StatementCum {
    calls: i64,
    exec_ms: f64,
    rows: i64,
    hits: i64,
    reads: i64,
}

/// One statement's work over one interval.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StatementDelta {
    /// `queryid:userid:dbid` — stable across fetches.
    pub key: String,
    pub queryid: String,
    pub user: Option<String>,
    pub database: Option<String>,
    pub calls: f64,
    pub exec_ms: f64,
    pub rows: f64,
    pub shared_hits: f64,
    pub shared_reads: f64,
    pub query: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Statements {
    pub seconds: f64,
    /// The top statements by time spent in this interval.
    pub rows: Vec<StatementDelta>,
    /// Totals over every statement read (not only the top ones), for shares.
    pub total_calls: f64,
    pub total_exec_ms: f64,
    /// Statements the extension tracks (the fetch is capped).
    pub tracked: u32,
}

type StatementKey = (String, String, String);
/// A statement's text, role and database.
type StatementText = (Option<String>, Option<String>, Option<String>);

#[derive(Default)]
pub(crate) struct StatementTracker {
    last: HashMap<StatementKey, StatementCum>,
    last_complete: bool,
    at: Option<Duration>,
    texts: HashMap<StatementKey, StatementText>,
}

impl StatementTracker {
    pub(crate) fn clear(&mut self) {
        self.last.clear();
        self.at = None;
        self.last_complete = false;
    }

    /// Diff one cumulative reading against the previous. Returns the interval's
    /// figures (None for the first reading) and the keys whose text is not known yet.
    pub(crate) fn ingest(
        &mut self,
        c: &[String],
        rows: &[Row],
        at: Duration,
    ) -> Result<Option<(Statements, Vec<i64>)>, AppError> {
        let mut now = HashMap::with_capacity(rows.len());
        let mut tracked = 0;
        for r in rows {
            tracked = clamp_u32(int(c, r, "total")?).max(tracked);
            let key = (
                text(c, r, "queryid").unwrap_or_default(),
                text(c, r, "userid").unwrap_or_default(),
                text(c, r, "dbid").unwrap_or_default(),
            );
            now.insert(
                key,
                StatementCum {
                    calls: int(c, r, "calls")?,
                    exec_ms: cell(c, r, "exec_ms")
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0.0),
                    rows: int(c, r, "rows")?,
                    hits: int(c, r, "hits")?,
                    reads: int(c, r, "reads")?,
                },
            );
        }
        let complete = (tracked as usize) <= rows.len();
        let previous = std::mem::replace(&mut self.last, now);
        let previous_complete = std::mem::replace(&mut self.last_complete, complete);
        let before = self.at.replace(at);
        let Some(before) = before else {
            return Ok(None);
        };
        let dt = at.saturating_sub(before).as_secs_f64();
        if dt <= 0.0 {
            return Ok(None);
        }
        let mut deltas = Vec::new();
        let (mut total_calls, mut total_exec) = (0.0, 0.0);
        for (key, cur) in &self.last {
            let prev = match previous.get(key) {
                Some(p) => *p,
                // A statement the last (complete) reading did not have is new: all of
                // its work happened in this interval. After a capped reading it may just
                // have been below the cap, so it waits for the next interval.
                None if previous_complete => StatementCum::default(),
                None => continue,
            };
            if cur.calls < prev.calls || cur.exec_ms < prev.exec_ms {
                continue; // reset or evicted and re-added: a new baseline
            }
            let calls = (cur.calls - prev.calls) as f64;
            let exec = cur.exec_ms - prev.exec_ms;
            if calls <= 0.0 && exec <= 0.0 {
                continue;
            }
            total_calls += calls;
            total_exec += exec;
            deltas.push((
                key.clone(),
                calls,
                exec,
                (cur.rows - prev.rows) as f64,
                (cur.hits - prev.hits) as f64,
                (cur.reads - prev.reads) as f64,
            ));
        }
        deltas.sort_by(|a, b| b.2.total_cmp(&a.2).then_with(|| b.1.total_cmp(&a.1)));
        deltas.truncate(STATEMENT_TOP);
        let mut missing: Vec<i64> = deltas
            .iter()
            .filter(|d| !self.texts.contains_key(&d.0))
            .filter_map(|d| d.0 .0.parse().ok())
            .collect();
        missing.sort_unstable();
        missing.dedup();
        let rows = deltas
            .into_iter()
            .map(|(key, calls, exec, rows, hits, reads)| {
                let (query, user, database) =
                    self.texts.get(&key).cloned().unwrap_or((None, None, None));
                StatementDelta {
                    key: format!("{}:{}:{}", key.0, key.1, key.2),
                    queryid: key.0,
                    user,
                    database,
                    calls,
                    exec_ms: exec,
                    rows,
                    shared_hits: hits,
                    shared_reads: reads,
                    query,
                }
            })
            .collect();
        Ok(Some((
            Statements {
                seconds: dt,
                rows,
                total_calls,
                total_exec_ms: total_exec,
                tracked,
            },
            missing,
        )))
    }

    /// Remember fetched texts and fill them into `stmts`.
    pub(crate) fn fill_texts(&mut self, c: &[String], rows: &[Row], stmts: &mut Statements) {
        if self.texts.len() + rows.len() > STATEMENT_TEXT_CACHE {
            self.texts.clear();
        }
        for r in rows {
            let key = (
                text(c, r, "queryid").unwrap_or_default(),
                text(c, r, "userid").unwrap_or_default(),
                text(c, r, "dbid").unwrap_or_default(),
            );
            self.texts.insert(
                key,
                (text(c, r, "query"), text(c, r, "usr"), text(c, r, "db")),
            );
        }
        for s in &mut stmts.rows {
            if s.query.is_some() {
                continue;
            }
            let mut parts = s.key.splitn(3, ':');
            let key = (
                parts.next().unwrap_or_default().to_string(),
                parts.next().unwrap_or_default().to_string(),
                parts.next().unwrap_or_default().to_string(),
            );
            if let Some((query, user, db)) = self.texts.get(&key) {
                s.query = query.clone();
                s.user = user.clone();
                s.database = db.clone();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::script::{parse_for_engine, TransactionEngine};

    fn cols(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn row(values: &[&str]) -> Row {
        values
            .iter()
            .map(|v| {
                if *v == "∅" {
                    None
                } else {
                    Some(v.to_string())
                }
            })
            .collect()
    }

    fn one_statement(sql: &str) {
        let items = parse_for_engine(sql, TransactionEngine::Postgres).unwrap();
        assert_eq!(items.len(), 1, "{sql}");
    }

    #[test]
    fn every_view_statement_is_one_statement_on_every_version() {
        let src = StatementsSource {
            schema: "\"public\"".into(),
            time_column: "total_exec_time",
        };
        for v in [100_000, 120_000, 130_000, 140_000, 160_000, 170_000] {
            one_statement(&lock_waits_sql(v));
            one_statement(&slots_sql(v));
            one_statement(&receiver_sql(v));
            one_statement(&progress_sql(v));
        }
        for sql in [
            lock_holds_sql(),
            replicas_sql(),
            TABLES_SQL.to_string(),
            WRAPAROUND_SQL.to_string(),
            IO_SQL.to_string(),
            STATEMENTS_PROBE_SQL.to_string(),
            statements_sql(&src),
            statement_texts_sql(&src, &[1, -2]),
        ] {
            one_statement(&sql);
        }
    }

    #[test]
    fn view_sql_is_version_gated() {
        assert!(lock_waits_sql(140_000).contains("l.waitstart"));
        assert!(!lock_waits_sql(130_000).contains("waitstart"));
        assert!(slots_sql(130_000).contains("wal_status AS wal_status"));
        assert!(slots_sql(120_000).contains("NULL::text AS wal_status"));
        assert!(!receiver_sql(100_000).contains("sender_host"));
        let p10 = progress_sql(100_000);
        assert!(p10.contains("pg_stat_progress_vacuum") && !p10.contains("create_index"));
        let p14 = progress_sql(140_000);
        for v in [
            "create_index",
            "cluster",
            "analyze",
            "basebackup",
            "progress_copy",
        ] {
            assert!(p14.contains(v), "{v}");
        }
        assert!(!progress_sql(130_000).contains("progress_copy"));
        let old = StatementsSource {
            schema: "\"ext\"".into(),
            time_column: "total_time",
        };
        assert!(statements_sql(&old).contains("sum(s.total_time)"));
        assert!(statements_sql(&old).contains("\"ext\".pg_stat_statements(false)"));
        assert!(statement_texts_sql(&old, &[5, -7]).contains("IN (5, -7)"));
    }

    #[test]
    fn locks_parse_waits_and_holds() {
        let wc = cols(&[
            "pid",
            "backend_start",
            "locktype",
            "mode",
            "target",
            "usr",
            "db",
            "app",
            "state",
            "waited_ms",
            "xact_ms",
            "blocked_by",
            "query",
            "total",
        ]);
        let w = vec![row(&[
            "12",
            "t0",
            "relation",
            "AccessExclusiveLock",
            "public.t",
            "u",
            "d",
            "psql",
            "active",
            "-4",
            "1000",
            "{11}",
            "ALTER TABLE t",
            "3",
        ])];
        let hc = cols(&["locktype", "mode", "target", "n", "pids", "total", "groups"]);
        let h = vec![
            row(&[
                "relation",
                "AccessShareLock",
                "public.t",
                "4",
                "{1,2,3,4}",
                "9",
                "2",
            ]),
            row(&[
                "advisory",
                "ExclusiveLock",
                "advisory 1:2:1",
                "5",
                "{9}",
                "9",
                "2",
            ]),
        ];
        let l = parse_locks(&wc, &w, &hc, &h).unwrap();
        assert_eq!(
            l.waiting_total, 3,
            "the server listed more than the capped rows"
        );
        assert_eq!(l.waiting[0].blocked_by, vec![11]);
        assert_eq!(
            l.waiting[0].waited_ms,
            Some(0),
            "clock skew never yields a negative wait"
        );
        assert_eq!(l.held_total, 9);
        assert_eq!(l.held_groups, 2);
        assert_eq!(l.held[0].pids, vec![1, 2, 3, 4]);
        assert_eq!(l.held[1].count, 5);
    }

    #[test]
    fn replication_parses_primary_and_standby() {
        let rc = cols(&[
            "pid",
            "app",
            "client",
            "state",
            "sync_state",
            "sent_bytes",
            "write_bytes",
            "flush_bytes",
            "replay_bytes",
            "write_lag_ms",
            "flush_lag_ms",
            "replay_lag_ms",
        ]);
        let rr = vec![row(&[
            "77",
            "replica1",
            "10.0.0.2",
            "streaming",
            "async",
            "0",
            "10",
            "20",
            "4096",
            "1",
            "2",
            "35",
        ])];
        let sc = cols(&[
            "slot_name",
            "slot_type",
            "plugin",
            "database",
            "active",
            "active_pid",
            "retained_bytes",
            "wal_status",
            "safe_wal_size",
        ]);
        let sr = vec![row(&[
            "s1", "physical", "∅", "∅", "f", "∅", "999", "reserved", "∅",
        ])];
        let vc = cols(&[
            "in_recovery",
            "status",
            "sender",
            "replay_backlog_bytes",
            "last_message_ms",
            "replay_paused",
            "replay_age_ms",
        ]);
        let primary = parse_replication(
            (&rc, &rr),
            (&sc, &sr),
            (&vc, &[row(&["f", "∅", "∅", "∅", "∅", "∅", "∅"])]),
        )
        .unwrap();
        assert!(!primary.standby);
        assert!(primary.receiver.is_none());
        assert_eq!(primary.replicas[0].replay_bytes, Some(4096));
        assert_eq!(primary.slots[0].retained_bytes, Some(999));
        assert!(!primary.slots[0].active);
        let standby = parse_replication(
            (&rc, &[]),
            (&sc, &[]),
            (
                &vc,
                &[row(&[
                    "t",
                    "streaming",
                    "primary.local",
                    "512",
                    "800",
                    "f",
                    "2500",
                ])],
            ),
        )
        .unwrap();
        assert!(standby.standby);
        let r = standby.receiver.unwrap();
        assert_eq!(r.replay_backlog_bytes, Some(512));
        assert!(!r.replay_paused);
    }

    #[test]
    fn progress_drops_an_unknown_total() {
        let c = cols(&[
            "kind",
            "pid",
            "db",
            "rel",
            "phase",
            "done",
            "total",
            "unit",
            "backend_start",
            "started_ms",
            "query",
        ]);
        let rows = vec![
            row(&[
                "vacuum",
                "5",
                "shop",
                "public.orders",
                "scanning heap",
                "40",
                "100",
                "blocks",
                "t",
                "1",
                "VACUUM orders",
            ]),
            row(&[
                "copy from",
                "6",
                "shop",
                "public.t",
                "FILE",
                "1200",
                "0",
                "tuples",
                "t",
                "2",
                "COPY t FROM '/x'",
            ]),
        ];
        let p = parse_progress(&c, &rows).unwrap();
        assert_eq!(p[0].total, Some(100));
        assert_eq!(
            p[1].total, None,
            "a zero total means unknown, never a full bar"
        );
    }

    #[test]
    fn io_rates_by_key_with_resets_as_baselines() {
        let c = cols(&[
            "backend_type",
            "object",
            "context",
            "reads",
            "writes",
            "extends",
            "hits",
            "evictions",
            "reuses",
            "fsyncs",
            "stats_reset_ms",
        ]);
        let mut t = IoTracker::default();
        let first = vec![
            row(&[
                "client backend",
                "relation",
                "normal",
                "100",
                "10",
                "0",
                "1000",
                "0",
                "0",
                "0",
                "1",
            ]),
            row(&[
                "checkpointer",
                "relation",
                "normal",
                "0",
                "50",
                "0",
                "0",
                "0",
                "0",
                "5",
                "1",
            ]),
        ];
        assert!(
            t.ingest(&c, &first, Duration::from_secs(10))
                .unwrap()
                .is_none(),
            "first reading is a baseline"
        );
        let second = vec![
            row(&[
                "client backend",
                "relation",
                "normal",
                "300",
                "10",
                "0",
                "3000",
                "0",
                "0",
                "0",
                "1",
            ]),
            row(&[
                "checkpointer",
                "relation",
                "normal",
                "0",
                "10",
                "0",
                "0",
                "0",
                "0",
                "5",
                "1",
            ]),
        ];
        let io = t
            .ingest(&c, &second, Duration::from_secs(20))
            .unwrap()
            .unwrap();
        assert_eq!(io.seconds, 10.0);
        assert_eq!(
            io.rows.len(),
            1,
            "the checkpointer's counters went backwards: no rate"
        );
        assert_eq!(io.rows[0].reads, 20.0);
        assert_eq!(io.rows[0].hits, 200.0);
        t.clear();
        assert!(t
            .ingest(&c, &second, Duration::from_secs(30))
            .unwrap()
            .is_none());
    }

    #[test]
    fn statements_diff_rank_and_wait_for_text() {
        let c = cols(&[
            "queryid", "userid", "dbid", "calls", "exec_ms", "rows", "hits", "reads", "total",
        ]);
        let mut t = StatementTracker::default();
        let first = vec![
            row(&["1", "10", "5", "100", "50.0", "100", "900", "100", "2"]),
            row(&["2", "10", "5", "10", "500.0", "10", "10", "0", "2"]),
        ];
        assert!(t
            .ingest(&c, &first, Duration::from_secs(0))
            .unwrap()
            .is_none());
        let second = vec![
            row(&["1", "10", "5", "300", "90.0", "300", "2900", "100", "3"]),
            row(&["2", "10", "5", "10", "500.0", "10", "10", "0", "3"]),
            row(&["3", "11", "5", "4", "200.0", "4", "0", "8", "3"]),
        ];
        let (s, missing) = t
            .ingest(&c, &second, Duration::from_secs(10))
            .unwrap()
            .unwrap();
        assert_eq!(s.seconds, 10.0);
        assert_eq!(s.rows.len(), 2, "an idle statement is not listed");
        assert_eq!(
            s.rows[0].key, "3:11:5",
            "ranked by time spent in the interval; a new statement counts whole"
        );
        assert_eq!(s.rows[0].exec_ms, 200.0);
        assert_eq!(s.rows[1].calls, 200.0);
        assert_eq!(s.total_calls, 204.0);
        assert_eq!(s.total_exec_ms, 240.0);
        assert_eq!(missing, vec![1, 3]);
        let tc = cols(&["queryid", "userid", "dbid", "query", "usr", "db"]);
        let mut s = s;
        t.fill_texts(
            &tc,
            &[row(&["3", "11", "5", "SELECT pg_sleep($1)", "app", "shop"])],
            &mut s,
        );
        assert_eq!(s.rows[0].query.as_deref(), Some("SELECT pg_sleep($1)"));
        assert_eq!(s.rows[0].user.as_deref(), Some("app"));
        assert_eq!(s.rows[1].query, None);
        // A reset (counters fell) is a new baseline for that statement.
        let third = vec![
            row(&["1", "10", "5", "5", "1.0", "5", "5", "0", "3"]),
            row(&["3", "11", "5", "6", "300.0", "6", "0", "8", "3"]),
        ];
        let (s, missing) = t
            .ingest(&c, &third, Duration::from_secs(20))
            .unwrap()
            .unwrap();
        assert_eq!(s.rows.len(), 1);
        assert_eq!(
            s.rows[0].query.as_deref(),
            Some("SELECT pg_sleep($1)"),
            "known text is reused"
        );
        assert!(missing.is_empty());
    }

    #[test]
    fn a_new_statement_after_a_capped_reading_waits_a_turn() {
        let c = cols(&[
            "queryid", "userid", "dbid", "calls", "exec_ms", "rows", "hits", "reads", "total",
        ]);
        let mut t = StatementTracker::default();
        // The extension tracked 5 but only 1 came back (capped).
        t.ingest(
            &c,
            &[row(&["1", "1", "1", "1", "1.0", "1", "0", "0", "5"])],
            Duration::from_secs(0),
        )
        .unwrap();
        let (s, _) = t
            .ingest(
                &c,
                &[
                    row(&["1", "1", "1", "1", "1.0", "1", "0", "0", "5"]),
                    row(&["9", "1", "1", "50", "999.0", "1", "0", "0", "5"]),
                ],
                Duration::from_secs(10),
            )
            .unwrap()
            .unwrap();
        assert!(s.rows.is_empty(), "it may have been below the cap, not new");
    }

    #[test]
    fn tiers_follow_their_views() {
        let none = ViewSet::default();
        assert!(Tier::ALL.iter().all(|t| !t.enabled(none)));
        let tables = ViewSet {
            tables: true,
            ..none
        };
        assert!(Tier::Progress.enabled(tables) && Tier::Maintenance.enabled(tables));
        assert!(!Tier::Locks.enabled(tables));
        assert!(Tier::Progress.every() < Tier::Maintenance.every());
        let v: ViewSet = serde_json::from_str(r#"{"locks":true}"#).unwrap();
        assert!(v.locks && !v.io, "absent views are off");
    }
}
