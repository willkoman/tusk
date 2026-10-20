//! PostgreSQL source for the database monitor: the sidecar session, its fixed SQL,
//! and the parsers that turn text rows into the neutral sample model.
//!
//! Every statement here is Tusk's own; no user text ever reaches the sidecar, so the
//! SQL guard has nothing to classify. The session is engine-read-only
//! (`default_transaction_read_only`, from the cloned config) and identifies itself
//! as `Tusk monitor` in every other tool.

use serde::Serialize;
use tokio_postgres::error::SqlState;
use tokio_postgres::{Client, SimpleQueryMessage};

use super::rates::Counters;
use crate::db::{self, AppError, ConnectionConfig};
use crate::driver::Backend;

/// PostgreSQL 10 brought `pg_current_wal_lsn`, `backend_type` and the `pg_monitor`
/// roles the monitor is built on.
pub(crate) const MIN_VERSION_NUM: i32 = 100_000;
/// `pg_stat_wal` (full-page images) arrived in PostgreSQL 14.
const WAL_STATS_VERSION_NUM: i32 = 140_000;
/// Query text is cut here in SQL, in characters, so the process list stays small
/// however high the server's `track_activity_query_size` is set.
pub(crate) const QUERY_TEXT_CHARS: usize = 1024;
/// Rows the process list returns; `count(*) OVER ()` reports how many there were.
pub(crate) const ACTIVITY_ROWS: usize = 500;

/// Applied once per sidecar session (and again after a reconnect). The timeouts keep
/// a stuck tick from piling up behind a lock or an overloaded server.
const SESSION_SETUP: &str = "SET application_name = 'Tusk monitor'; \
     SET statement_timeout = '2s'; \
     SET lock_timeout = '250ms'; \
     SET idle_in_transaction_session_timeout = '10s'";

const VERSION_SQL: &str = "SELECT current_setting('server_version_num')::int AS version_num";

/// What the monitor needs to know once per session. Bare booleans: over the text
/// protocol they come back `t`/`f` (never cast them to text).
const PROBE_SQL: &str = "SELECT current_setting('server_version') AS version, \
    pg_backend_pid() AS pid, \
    current_user AS usr, \
    current_database() AS database, \
    coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS superuser, \
    pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS read_all_stats, \
    pg_has_role(current_user, 'pg_signal_backend', 'USAGE') AS signal_backend, \
    floor(extract(epoch FROM pg_postmaster_start_time()) * 1000)::bigint AS started_ms, \
    current_setting('max_connections')::int AS max_connections, \
    current_setting('block_size')::int AS block_size, \
    pg_is_in_recovery() AS in_recovery, \
    pg_size_bytes(current_setting('track_activity_query_size')) AS query_size";

/// Wait-event types in chart order. `CPU` is "active with no wait event"; anything
/// the server reports that is not listed here folds into `Other`. Mirrored by
/// `WAIT_TYPES` in `src/monitor/model.ts`.
pub(crate) const WAIT_TYPES: [&str; 11] = [
    "CPU",
    "Lock",
    "LWLock",
    "IO",
    "IPC",
    "Client",
    "Timeout",
    "BufferPin",
    "Activity",
    "Extension",
    "Other",
];

/// Facts about the server and the monitor's own role, read once per session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Probe {
    pub version_num: i32,
    pub version: String,
    /// The sidecar's own backend pid: excluded from every count and never signalled.
    pub pid: i32,
    pub user: String,
    pub database: String,
    pub superuser: bool,
    /// Member of `pg_read_all_stats`: other roles' query text is visible.
    pub read_all_stats: bool,
    /// Member of `pg_signal_backend`: may cancel/terminate other roles' sessions.
    pub signal_backend: bool,
    pub started_ms: Option<i64>,
    pub max_connections: u32,
    pub block_size: u32,
    pub in_recovery: bool,
    /// `track_activity_query_size` in bytes: query text at that length was cut by the server.
    pub query_size: i64,
    pub wal_stats: bool,
}

/// The fast tier: ONE statement, one row, shared-memory stats views only. Built per
/// server version at session start. `pg_stat_database` sums, one pass over
/// `pg_stat_activity` folded into a state × wait × client-backend histogram (plus
/// the oldest open transaction and the lock-blocked count from the same pass), the
/// WAL position, replication lag and the server clock. `pg_current_wal_lsn()` errors
/// during recovery, so a standby reads the replay position instead; CASE evaluates
/// only the branch it takes. `pg_blocking_pids` takes the lock manager's partition
/// locks, so it runs only for sessions already waiting on a heavyweight lock.
pub(crate) fn fast_tier_sql(version_num: i32) -> String {
    let wal_fpi = if version_num >= WAL_STATS_VERSION_NUM {
        "(SELECT wal_fpi FROM pg_stat_wal)"
    } else {
        "NULL::bigint"
    };
    format!(
        "SELECT \
    floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS server_ms, \
    d.xact_commit, d.xact_rollback, d.blks_read, d.blks_hit, \
    d.tup_returned, d.tup_fetched, d.tup_inserted, d.tup_updated, d.tup_deleted, \
    d.temp_bytes, d.stats_reset_ms, \
    (CASE WHEN pg_is_in_recovery() \
          THEN pg_wal_lsn_diff(pg_last_wal_replay_lsn(), '0/0') \
          ELSE pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0') END)::bigint AS wal_bytes, \
    {wal_fpi} AS wal_fpi, \
    current_setting('max_connections')::int AS max_connections, \
    a.hist, a.oldest_xact_ms, a.blocked, \
    (CASE WHEN pg_is_in_recovery() \
          THEN floor(extract(epoch FROM clock_timestamp() - pg_last_xact_replay_timestamp()) * 1000) \
          ELSE (SELECT floor(extract(epoch FROM max(replay_lag)) * 1000) FROM pg_stat_replication) END)::bigint \
      AS replication_lag_ms \
  FROM (SELECT sum(xact_commit)::bigint AS xact_commit, \
               sum(xact_rollback)::bigint AS xact_rollback, \
               sum(blks_read)::bigint AS blks_read, \
               sum(blks_hit)::bigint AS blks_hit, \
               sum(tup_returned)::bigint AS tup_returned, \
               sum(tup_fetched)::bigint AS tup_fetched, \
               sum(tup_inserted)::bigint AS tup_inserted, \
               sum(tup_updated)::bigint AS tup_updated, \
               sum(tup_deleted)::bigint AS tup_deleted, \
               sum(temp_bytes)::bigint AS temp_bytes, \
               floor(extract(epoch FROM max(stats_reset)) * 1000)::bigint AS stats_reset_ms \
          FROM pg_stat_database) d \
  CROSS JOIN (SELECT coalesce(json_agg(json_build_array(state, wait_event_type, client, n)), '[]') AS hist, \
                     floor(extract(epoch FROM clock_timestamp() - min(oldest_xact)) * 1000)::bigint AS oldest_xact_ms, \
                     coalesce(sum(blocked), 0)::bigint AS blocked \
                FROM (SELECT state, wait_event_type, backend_type = 'client backend' AS client, \
                             count(*) AS n, min(xact_start) AS oldest_xact, \
                             count(*) FILTER (WHERE CASE WHEN wait_event_type = 'Lock' \
                                                         THEN cardinality(pg_blocking_pids(pid)) > 0 \
                                                         ELSE false END) AS blocked \
                        FROM pg_stat_activity \
                       WHERE pid <> pg_backend_pid() \
                       GROUP BY 1, 2, 3) h) a"
    )
}

/// The activity tier: the bounded process list, active sessions first. Times are
/// epoch milliseconds so the client can tick durations against a measured server
/// clock offset; `backend_start::text` is the row's identity (a reused pid is a new
/// row) and what a cancel/terminate re-checks before it signals.
pub(crate) fn activity_sql(query_size: i64) -> String {
    format!(
        "SELECT pid, backend_start::text AS backend_start, \
    floor(extract(epoch FROM backend_start) * 1000)::bigint AS backend_start_ms, \
    usename AS usr, datname AS db, application_name AS app, \
    coalesce(host(client_addr), CASE WHEN client_port = -1 THEN 'local' END) AS client, \
    backend_type, state, wait_event_type, wait_event, \
    floor(extract(epoch FROM xact_start) * 1000)::bigint AS xact_ms, \
    floor(extract(epoch FROM query_start) * 1000)::bigint AS query_ms, \
    floor(extract(epoch FROM state_change) * 1000)::bigint AS state_ms, \
    CASE WHEN wait_event_type = 'Lock' THEN pg_blocking_pids(pid)::text END AS blocked_by, \
    left(query, {QUERY_TEXT_CHARS}) AS query, \
    (octet_length(query) >= {cut} OR char_length(query) > {QUERY_TEXT_CHARS}) AS query_truncated, \
    count(*) OVER () AS total \
  FROM pg_stat_activity \
 WHERE pid <> pg_backend_pid() \
 ORDER BY (state = 'active') DESC NULLS LAST, query_start NULLS LAST, pid \
 LIMIT {ACTIVITY_ROWS}",
        // The server stores at most track_activity_query_size - 1 bytes of a query.
        cut = query_size.saturating_sub(1).max(1),
    )
}

/// The cancel/terminate statement. The target is re-identified by pid AND backend
/// start inside the same statement, so a pid the server reused for another session
/// between the user's click and the confirmation is never signalled (NULL comes back).
pub(crate) fn signal_sql(action: SignalAction) -> &'static str {
    match action {
        SignalAction::Cancel => {
            "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_stat_activity \
                                      WHERE pid = $1::int4 AND backend_start::text = $2::text) \
                         THEN pg_cancel_backend($1::int4) END AS signalled"
        }
        SignalAction::Terminate => {
            "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_stat_activity \
                                      WHERE pid = $1::int4 AND backend_start::text = $2::text) \
                         THEN pg_terminate_backend($1::int4) END AS signalled"
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SignalAction {
    Cancel,
    Terminate,
}

impl SignalAction {
    #[cfg(test)]
    pub(crate) fn function(self) -> &'static str {
        match self {
            SignalAction::Cancel => "pg_cancel_backend",
            SignalAction::Terminate => "pg_terminate_backend",
        }
    }
}

/// Client-backend session counts by state, against `max_connections`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sessions {
    pub active: u32,
    pub idle: u32,
    pub idle_in_transaction: u32,
    pub idle_in_transaction_aborted: u32,
    /// fastpath function call, disabled.
    pub other: u32,
    /// Other roles' sessions whose state this role may not see.
    pub hidden: u32,
    pub total: u32,
    pub max_connections: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FastSample {
    pub server_ms: Option<i64>,
    pub counters: Counters,
    pub sessions: Sessions,
    /// Active sessions (any backend type) per `WAIT_TYPES` entry, same order.
    pub load: [u32; 11],
    pub oldest_xact_ms: Option<i64>,
    pub blocked: u32,
    pub replication_lag_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityRow {
    pub pid: i32,
    pub backend_start: String,
    pub backend_start_ms: Option<i64>,
    pub user: Option<String>,
    pub database: Option<String>,
    pub application: Option<String>,
    pub client: Option<String>,
    pub backend_type: Option<String>,
    pub state: Option<String>,
    pub wait_type: Option<String>,
    pub wait_event: Option<String>,
    pub xact_start_ms: Option<i64>,
    pub query_start_ms: Option<i64>,
    pub state_change_ms: Option<i64>,
    /// `pg_blocking_pids`, read only for sessions waiting on a lock.
    pub blocked_by: Vec<i32>,
    pub query: Option<String>,
    pub query_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Activity {
    pub rows: Vec<ActivityRow>,
    /// Backends the server listed; more than `rows.len()` when the list was capped.
    pub total: u32,
}

/// One of the session's fixed statements, run as `EXECUTE name` once prepared.
/// Planning cost twice what execution did in the spike (simple protocol re-plans
/// every tick), and a parameterless prepared statement is planned once. Behind a
/// transaction-pooling proxy a prepared statement can vanish between ticks; the
/// statement then falls back to its plain text for the rest of the session.
struct Statement {
    name: &'static str,
    sql: String,
    prepared: bool,
}

impl Statement {
    fn new(name: &'static str, sql: String) -> Self {
        Self {
            name,
            sql,
            prepared: false,
        }
    }

    fn text(&self) -> String {
        if self.prepared {
            format!("EXECUTE {}", self.name)
        } else {
            self.sql.clone()
        }
    }

    async fn prepare(&mut self, client: &Client) {
        self.prepared = client
            .batch_execute(&format!("PREPARE {} AS {}", self.name, self.sql))
            .await
            .is_ok();
    }

    async fn run(&mut self, client: &Client) -> Result<Vec<SimpleQueryMessage>, AppError> {
        match client.simple_query(&self.text()).await {
            Ok(messages) => Ok(messages),
            Err(e) => {
                if self.prepared && e.code() == Some(&SqlState::INVALID_SQL_STATEMENT_NAME) {
                    self.prepared = false;
                }
                Err(e.into())
            }
        }
    }
}

/// The monitor's own PostgreSQL session.
pub(crate) struct PgSession {
    backend: Backend,
    pub probe: Probe,
    fast: Statement,
    activity: Statement,
}

impl PgSession {
    /// Dial the sidecar (its own SSH tunnel and TLS through the usual driver path),
    /// set it up and read its facts. `config` is already the read-only clone.
    pub(crate) async fn open(config: &ConnectionConfig) -> Result<Self, AppError> {
        let (backend, _version) = crate::driver::connect(config).await?;
        let mut session = Self {
            backend,
            probe: placeholder_probe(),
            fast: Statement::new("tusk_monitor_fast", String::new()),
            activity: Statement::new("tusk_monitor_activity", String::new()),
        };
        session.setup().await?;
        Ok(session)
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.backend.is_closed()
    }

    /// Re-dial after the session dropped. Never replays anything: the caller's next
    /// tick is the retry.
    pub(crate) async fn reopen(&mut self) -> Result<(), AppError> {
        self.backend.reopen().await?;
        self.setup().await
    }

    async fn setup(&mut self) -> Result<(), AppError> {
        let client = self.backend.pg()?;
        client.batch_execute(SESSION_SETUP).await?;
        let version_num = one_row(client, VERSION_SQL)
            .await
            .and_then(|(c, r)| int(&c, &r, "version_num"))?;
        if version_num < i64::from(MIN_VERSION_NUM) {
            return Err(AppError::new(format!(
                "the database monitor needs PostgreSQL 10 or later (this server reports {})",
                version_num / 10_000
            )));
        }
        let (columns, row) = one_row(client, PROBE_SQL).await?;
        let probe = parse_probe(version_num as i32, &columns, &row)?;
        self.fast = Statement::new("tusk_monitor_fast", fast_tier_sql(probe.version_num));
        self.activity = Statement::new("tusk_monitor_activity", activity_sql(probe.query_size));
        // DEALLOCATE ALL is not needed: a fresh or reopened session has none.
        self.fast.prepare(client).await;
        self.activity.prepare(client).await;
        self.probe = probe;
        Ok(())
    }

    pub(crate) async fn sample(&mut self) -> Result<FastSample, AppError> {
        let client = self.backend.pg()?;
        let messages = self.fast.run(client).await?;
        let (columns, rows) = db::collect_rows_limited(&messages, db::MONITOR_TEXT_LIMITS)?;
        let [row] = rows.as_slice() else {
            return Err(AppError::new("monitor fast tier returned no row"));
        };
        parse_fast(&columns, row)
    }

    pub(crate) async fn activity(&mut self) -> Result<Activity, AppError> {
        let client = self.backend.pg()?;
        let messages = self.activity.run(client).await?;
        let (columns, rows) = db::collect_rows_limited(&messages, db::MONITOR_TEXT_LIMITS)?;
        parse_activity(&columns, &rows)
    }

    /// Cancel or terminate `pid`, re-identified by `backend_start`. `Ok(true)` when
    /// the server signalled it, `Ok(false)` when it refused without an error (the
    /// process had already gone), and an error naming the reason otherwise.
    pub(crate) async fn signal(
        &mut self,
        pid: i32,
        backend_start: &str,
        action: SignalAction,
    ) -> Result<bool, AppError> {
        let client = self.backend.pg()?;
        let row = client
            .query_one(signal_sql(action), &[&pid, &backend_start])
            .await?;
        match row.try_get::<_, Option<bool>>(0) {
            Ok(Some(done)) => Ok(done),
            Ok(None) => Err(AppError::new(format!(
                "session {pid} has already ended (or its pid now belongs to another session); nothing was signalled"
            ))),
            Err(e) => Err(AppError::new(format!("unexpected signal result: {e}"))),
        }
    }
}

fn placeholder_probe() -> Probe {
    Probe {
        version_num: 0,
        version: String::new(),
        pid: 0,
        user: String::new(),
        database: String::new(),
        superuser: false,
        read_all_stats: false,
        signal_backend: false,
        started_ms: None,
        max_connections: 0,
        block_size: 8192,
        in_recovery: false,
        query_size: 1024,
        wal_stats: false,
    }
}

type Row = Vec<Option<String>>;

async fn one_row(client: &Client, sql: &str) -> Result<(Vec<String>, Row), AppError> {
    let messages = client.simple_query(sql).await?;
    let (columns, mut rows) = db::collect_rows_limited(&messages, db::MONITOR_TEXT_LIMITS)?;
    match rows.len() {
        1 => Ok((columns, rows.remove(0))),
        _ => Err(AppError::new("monitor probe returned no row")),
    }
}

fn cell<'a>(columns: &[String], row: &'a [Option<String>], name: &str) -> Option<&'a str> {
    columns
        .iter()
        .position(|c| c == name)
        .and_then(|i| row.get(i))
        .and_then(|v| v.as_deref())
}

/// An integer column; NULL reads as zero (a sum over an empty view is NULL).
fn int(columns: &[String], row: &[Option<String>], name: &str) -> Result<i64, AppError> {
    opt_int(columns, row, name).map(|v| v.unwrap_or(0))
}

fn opt_int(
    columns: &[String],
    row: &[Option<String>],
    name: &str,
) -> Result<Option<i64>, AppError> {
    match cell(columns, row, name) {
        None => Ok(None),
        Some(v) => v
            .parse::<i64>()
            .map(Some)
            .map_err(|_| AppError::new(format!("monitor: {name} is not an integer"))),
    }
}

fn boolean(columns: &[String], row: &[Option<String>], name: &str) -> bool {
    cell(columns, row, name) == Some("t")
}

fn text(columns: &[String], row: &[Option<String>], name: &str) -> Option<String> {
    cell(columns, row, name).map(str::to_string)
}

fn clamp_u32(v: i64) -> u32 {
    v.clamp(0, i64::from(u32::MAX)) as u32
}

fn parse_probe(
    version_num: i32,
    columns: &[String],
    row: &[Option<String>],
) -> Result<Probe, AppError> {
    Ok(Probe {
        version_num,
        version: text(columns, row, "version").unwrap_or_default(),
        pid: int(columns, row, "pid")?.clamp(0, i64::from(i32::MAX)) as i32,
        user: text(columns, row, "usr").unwrap_or_default(),
        database: text(columns, row, "database").unwrap_or_default(),
        superuser: boolean(columns, row, "superuser"),
        read_all_stats: boolean(columns, row, "read_all_stats"),
        signal_backend: boolean(columns, row, "signal_backend"),
        started_ms: opt_int(columns, row, "started_ms")?,
        max_connections: clamp_u32(int(columns, row, "max_connections")?),
        block_size: clamp_u32(int(columns, row, "block_size")?).max(1),
        in_recovery: boolean(columns, row, "in_recovery"),
        query_size: int(columns, row, "query_size")?.max(1),
        wal_stats: version_num >= WAL_STATS_VERSION_NUM,
    })
}

pub(crate) fn parse_fast(
    columns: &[String],
    row: &[Option<String>],
) -> Result<FastSample, AppError> {
    let i = |name: &str| int(columns, row, name);
    let counters = Counters {
        xact_commit: i("xact_commit")?,
        xact_rollback: i("xact_rollback")?,
        blks_read: i("blks_read")?,
        blks_hit: i("blks_hit")?,
        tup_returned: i("tup_returned")?,
        tup_fetched: i("tup_fetched")?,
        tup_inserted: i("tup_inserted")?,
        tup_updated: i("tup_updated")?,
        tup_deleted: i("tup_deleted")?,
        temp_bytes: i("temp_bytes")?,
        wal_bytes: opt_int(columns, row, "wal_bytes")?,
        wal_fpi: opt_int(columns, row, "wal_fpi")?,
        stats_reset_ms: opt_int(columns, row, "stats_reset_ms")?,
    };
    let max_connections = clamp_u32(i("max_connections")?);
    let (sessions, load) = histogram(cell(columns, row, "hist").unwrap_or("[]"), max_connections)?;
    Ok(FastSample {
        server_ms: opt_int(columns, row, "server_ms")?,
        counters,
        sessions,
        load,
        // Negative only through clock skew between the two clock reads; clamp.
        oldest_xact_ms: opt_int(columns, row, "oldest_xact_ms")?.map(|v| v.max(0)),
        blocked: clamp_u32(i("blocked")?),
        replication_lag_ms: opt_int(columns, row, "replication_lag_ms")?.map(|v| v.max(0)),
    })
}

/// Fold the `[[state, wait_event_type, client_backend, n], …]` histogram into
/// client-session counts by state and active-session load by wait type.
pub(crate) fn histogram(
    json: &str,
    max_connections: u32,
) -> Result<(Sessions, [u32; 11]), AppError> {
    type Bucket = (Option<String>, Option<String>, Option<bool>, i64);
    let buckets: Vec<Bucket> = serde_json::from_str(json)
        .map_err(|e| AppError::new(format!("monitor: unreadable session histogram: {e}")))?;
    let mut sessions = Sessions {
        max_connections,
        ..Sessions::default()
    };
    let mut load = [0u32; 11];
    for (state, wait, client, n) in buckets {
        let n = clamp_u32(n);
        // Load is every backend doing work (autovacuum and parallel workers too):
        // that is what competes for the server.
        if state.as_deref() == Some("active") {
            let slot = match wait.as_deref() {
                None => 0,
                Some(w) => WAIT_TYPES[..10].iter().position(|t| *t == w).unwrap_or(10),
            };
            load[slot] = load[slot].saturating_add(n);
        }
        // Sessions are client backends: the ones max_connections limits.
        if client != Some(true) {
            continue;
        }
        sessions.total = sessions.total.saturating_add(n);
        let slot = match state.as_deref() {
            Some("active") => &mut sessions.active,
            Some("idle") => &mut sessions.idle,
            Some("idle in transaction") => &mut sessions.idle_in_transaction,
            Some("idle in transaction (aborted)") => &mut sessions.idle_in_transaction_aborted,
            None => &mut sessions.hidden,
            _ => &mut sessions.other,
        };
        *slot = slot.saturating_add(n);
    }
    Ok((sessions, load))
}

/// `{1,2}` (an int[] as text) → pids. Anything unreadable is dropped, never guessed.
fn pid_array(text: Option<&str>) -> Vec<i32> {
    let Some(t) = text else { return Vec::new() };
    t.trim_matches(|c| c == '{' || c == '}')
        .split(',')
        .filter_map(|p| p.trim().parse::<i32>().ok())
        .collect()
}

pub(crate) fn parse_activity(columns: &[String], rows: &[Row]) -> Result<Activity, AppError> {
    let mut total = 0u32;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let pid = int(columns, row, "pid")?;
        let Ok(pid) = i32::try_from(pid) else {
            continue;
        };
        total = total.max(clamp_u32(int(columns, row, "total")?));
        out.push(ActivityRow {
            pid,
            backend_start: text(columns, row, "backend_start").unwrap_or_default(),
            backend_start_ms: opt_int(columns, row, "backend_start_ms")?,
            user: text(columns, row, "usr"),
            database: text(columns, row, "db"),
            application: text(columns, row, "app"),
            client: text(columns, row, "client"),
            backend_type: text(columns, row, "backend_type"),
            state: text(columns, row, "state"),
            wait_type: text(columns, row, "wait_event_type"),
            wait_event: text(columns, row, "wait_event"),
            xact_start_ms: opt_int(columns, row, "xact_ms")?,
            query_start_ms: opt_int(columns, row, "query_ms")?,
            state_change_ms: opt_int(columns, row, "state_ms")?,
            blocked_by: pid_array(cell(columns, row, "blocked_by")),
            query: text(columns, row, "query"),
            query_truncated: boolean(columns, row, "query_truncated"),
        });
    }
    Ok(Activity {
        total: total.max(out.len() as u32),
        rows: out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::script::{parse_for_engine, TransactionEngine};

    fn cols(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn histogram_folds_states_waits_and_client_backends() {
        let json = r#"[["active",null,true,3],["active","Lock",true,2],["active","Mystery",true,1],
                       ["idle","Client",true,7],["idle in transaction","Client",true,1],
                       ["idle in transaction (aborted)","Client",true,1],["fastpath function call",null,true,1],
                       [null,null,true,4],
                       ["active","IO",false,2],[null,"Activity",false,5]]"#;
        let (s, load) = histogram(json, 100).unwrap();
        assert_eq!(s.active, 6);
        assert_eq!(s.idle, 7);
        assert_eq!(s.idle_in_transaction, 1);
        assert_eq!(s.idle_in_transaction_aborted, 1);
        assert_eq!(s.other, 1);
        assert_eq!(s.hidden, 4, "other roles' sessions without a visible state");
        assert_eq!(s.total, 20, "client backends only");
        assert_eq!(s.max_connections, 100);
        assert_eq!(load[0], 3, "no wait event = CPU");
        assert_eq!(load[1], 2, "Lock");
        assert_eq!(
            load[3], 2,
            "an active background worker is load, not a session"
        );
        assert_eq!(load[10], 1, "unknown wait type folds into Other");
        assert_eq!(load.iter().sum::<u32>(), 8);
        assert!(histogram("not json", 1).is_err());
    }

    #[test]
    fn parse_fast_reads_counters_and_tolerates_null_sums() {
        let columns = cols(&[
            "server_ms",
            "xact_commit",
            "xact_rollback",
            "blks_read",
            "blks_hit",
            "tup_returned",
            "tup_fetched",
            "tup_inserted",
            "tup_updated",
            "tup_deleted",
            "temp_bytes",
            "stats_reset_ms",
            "wal_bytes",
            "wal_fpi",
            "max_connections",
            "hist",
            "oldest_xact_ms",
            "blocked",
            "replication_lag_ms",
        ]);
        let mut row: Vec<Option<String>> = vec![
            Some("1700000000000".into()),
            Some("10".into()),
            Some("1".into()),
            Some("5".into()),
            Some("95".into()),
            None,
            None,
            None,
            None,
            None,
            Some("4096".into()),
            None,
            None,
            None,
            Some("200".into()),
            Some("[]".into()),
            Some("-3".into()),
            Some("2".into()),
            None,
        ];
        let s = parse_fast(&columns, &row).unwrap();
        assert_eq!(s.server_ms, Some(1_700_000_000_000));
        assert_eq!(s.counters.xact_commit, 10);
        assert_eq!(s.counters.tup_returned, 0);
        assert_eq!(s.counters.temp_bytes, 4096);
        assert_eq!(s.counters.wal_bytes, None);
        assert_eq!(s.counters.wal_fpi, None);
        assert_eq!(s.sessions.max_connections, 200);
        assert_eq!(
            s.oldest_xact_ms,
            Some(0),
            "clock skew never yields a negative age"
        );
        assert_eq!(s.blocked, 2);
        assert_eq!(s.replication_lag_ms, None);
        row[1] = Some("ten".into());
        assert!(parse_fast(&columns, &row).is_err());
    }

    #[test]
    fn parse_activity_reads_rows_identity_and_blockers() {
        let columns = cols(&[
            "pid",
            "backend_start",
            "backend_start_ms",
            "usr",
            "db",
            "app",
            "client",
            "backend_type",
            "state",
            "wait_event_type",
            "wait_event",
            "xact_ms",
            "query_ms",
            "state_ms",
            "blocked_by",
            "query",
            "query_truncated",
            "total",
        ]);
        let row = |pid: &str, blocked: Option<&str>| -> Row {
            vec![
                Some(pid.into()),
                Some("2026-10-20 10:00:00.123456+00".into()),
                Some("1792490400123".into()),
                Some("app_user".into()),
                Some("shop".into()),
                Some("psql".into()),
                Some("10.0.0.5".into()),
                Some("client backend".into()),
                Some("active".into()),
                blocked.map(|_| "Lock".to_string()),
                blocked.map(|_| "transactionid".to_string()),
                Some("1792490401000".into()),
                Some("1792490402000".into()),
                Some("1792490402000".into()),
                blocked.map(str::to_string),
                Some("UPDATE t SET x = 1".into()),
                Some("f".into()),
                Some("742".into()),
            ]
        };
        let activity = parse_activity(
            &columns,
            &[
                row("101", None),
                row("102", Some("{101,99}")),
                row("x", None),
            ],
        )
        .unwrap_err();
        assert!(activity.message.contains("pid"));
        let activity =
            parse_activity(&columns, &[row("101", None), row("102", Some("{101,99}"))]).unwrap();
        assert_eq!(
            activity.total, 742,
            "the server listed more than the capped rows"
        );
        assert_eq!(activity.rows.len(), 2);
        assert!(activity.rows[0].blocked_by.is_empty());
        assert_eq!(activity.rows[1].blocked_by, vec![101, 99]);
        assert_eq!(activity.rows[1].wait_type.as_deref(), Some("Lock"));
        assert_eq!(
            activity.rows[0].backend_start,
            "2026-10-20 10:00:00.123456+00"
        );
        assert!(!activity.rows[0].query_truncated);
        assert_eq!(pid_array(Some("{}")), Vec::<i32>::new());
        assert_eq!(pid_array(Some("{7, x ,8}")), vec![7, 8]);
    }

    #[test]
    fn every_statement_is_one_statement_excluding_its_own_session() {
        for version in [100_000, 130_000, 140_000, 170_000] {
            for sql in [fast_tier_sql(version), activity_sql(1024)] {
                let items = parse_for_engine(&sql, TransactionEngine::Postgres).unwrap();
                assert_eq!(items.len(), 1, "{sql}");
                assert!(sql.contains("pid <> pg_backend_pid()"));
            }
        }
        for action in [SignalAction::Cancel, SignalAction::Terminate] {
            let items = parse_for_engine(signal_sql(action), TransactionEngine::Postgres).unwrap();
            assert_eq!(items.len(), 1);
            assert!(signal_sql(action).contains(action.function()));
            assert!(signal_sql(action).contains("backend_start::text = $2"));
        }
    }

    #[test]
    fn fast_tier_is_version_gated() {
        assert!(fast_tier_sql(130_000).contains("NULL::bigint AS wal_fpi"));
        assert!(!fast_tier_sql(130_000).contains("pg_stat_wal"));
        assert!(fast_tier_sql(140_000).contains("FROM pg_stat_wal"));
        assert!(fast_tier_sql(170_000).contains("FROM pg_stat_wal"));
    }

    #[test]
    fn activity_marks_text_cut_by_the_server_or_by_tusk() {
        let sql = activity_sql(1024);
        assert!(sql.contains("octet_length(query) >= 1023"));
        assert!(sql.contains(&format!("left(query, {QUERY_TEXT_CHARS})")));
        assert!(sql.contains(&format!("LIMIT {ACTIVITY_ROWS}")));
        // A nonsensical setting never produces `>= -1` (which would mark everything).
        assert!(activity_sql(0).contains("octet_length(query) >= 1"));
    }

    #[test]
    fn probe_reads_bare_booleans_and_gates_wal_stats() {
        let columns = cols(&[
            "version",
            "pid",
            "usr",
            "database",
            "superuser",
            "read_all_stats",
            "signal_backend",
            "started_ms",
            "max_connections",
            "block_size",
            "in_recovery",
            "query_size",
        ]);
        let row: Row = [
            "16.4",
            "4242",
            "monitor",
            "shop",
            "f",
            "t",
            "f",
            "1700000000000",
            "100",
            "8192",
            "f",
            "1024",
        ]
        .iter()
        .map(|s| Some(s.to_string()))
        .collect();
        let p = parse_probe(160_004, &columns, &row).unwrap();
        assert_eq!(p.pid, 4242);
        assert!(!p.superuser);
        assert!(p.read_all_stats);
        assert!(!p.signal_backend);
        assert!(p.wal_stats);
        assert_eq!(p.query_size, 1024);
        assert!(!parse_probe(130_000, &columns, &row).unwrap().wal_stats);
    }
}
