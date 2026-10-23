//! MySQL / MariaDB source for the database monitor: the sidecar session, its fixed
//! SQL, and the mapping onto the neutral sample model the PostgreSQL source defined.
//!
//! The sidecar is its own pool (from the read-only clone of the user's config, so
//! every connection runs `SET SESSION TRANSACTION READ ONLY`) and holds ONE connection
//! for its whole life, so the session timeouts below stay applied. Every statement is
//! Tusk's own; no user text ever reaches it.
//!
//! Counters come from the global status (`performance_schema.global_status`, or
//! `information_schema.GLOBAL_STATUS` on MariaDB); sessions from the process list
//! joined to `information_schema.INNODB_TRX`, which needs the `PROCESS` privilege —
//! without it the server shows only the monitor's own account and InnoDB's view is
//! left out rather than failing the tick.

use super::pg::{self, base_probe, bucket_rows, fold_histogram, Activity, FastSample, Probe, Row};
use super::rates::Counters;
use super::views::{self, Locks};
use super::SignalAction;
use crate::db::{self, AppError, ConnectionConfig};
use crate::driver::{self, Backend};

/// MySQL 8.0 (window functions, `performance_schema` on by default).
const MIN_MYSQL: i32 = 80_000;
/// MariaDB 10.5 (window functions, `INNODB_LOCK_WAITS`).
const MIN_MARIADB: i32 = 100_500;
/// `performance_schema.processlist` arrived in MySQL 8.0.22; it reads the process
/// list without the global mutex `information_schema.PROCESSLIST` takes.
const PS_PROCESSLIST: i32 = 80_022;
/// `ER_NO_SUCH_THREAD`: KILL found no such connection (it had already gone).
const ER_NO_SUCH_THREAD: u16 = 1094;

/// Best effort, one at a time: each engine refuses the other's timeout variable, and
/// a refused setting never fails the session.
const SESSION_SETUP: [&str; 4] = [
    // MySQL: a SELECT that runs past 2 s is stopped by the server.
    "SET SESSION max_execution_time = 2000",
    // MariaDB's equivalent, in seconds.
    "SET SESSION max_statement_time = 2",
    "SET SESSION lock_wait_timeout = 1",
    "SET SESSION innodb_lock_wait_timeout = 1",
];

const PROBE_SQL: &str = "SELECT VERSION() AS version, CONNECTION_ID() AS pid, \
    SUBSTRING_INDEX(CURRENT_USER(), '@', 1) AS usr, DATABASE() AS db, @@max_connections AS max_connections, \
    @@innodb_page_size AS block_size, CAST(UNIX_TIMESTAMP(NOW(3)) * 1000 AS SIGNED) AS now_ms";

/// Where the server's numbers live; found once per session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Shape {
    pub mariadb: bool,
    pub status: &'static str,
    pub processlist: &'static str,
    /// `information_schema.INNODB_TRX` is readable (the `PROCESS` privilege).
    pub innodb: bool,
    pub lock_waits: LockWaits,
    /// MySQL's `performance_schema` replication tables are readable (MariaDB keeps
    /// replica state only behind `SHOW ALL SLAVES STATUS`).
    pub replication: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LockWaits {
    /// MySQL 8: `performance_schema.data_lock_waits` → `threads`.
    PerfSchema,
    /// MariaDB: `information_schema.INNODB_LOCK_WAITS` → `INNODB_TRX`.
    InfoSchema,
    None,
}

/// `8.0.36` → 80036; `10.11.6-MariaDB-1:10.11.6+maria~ubu2204` → 101106.
pub(crate) fn version_num(version: &str) -> i32 {
    let mut parts = version
        .split(|c: char| !c.is_ascii_digit())
        .filter(|p| !p.is_empty())
        .map(|p| p.parse::<i32>().unwrap_or(0).min(99));
    let major = parts.next().unwrap_or(0);
    let minor = parts.next().unwrap_or(0);
    let patch = parts.next().unwrap_or(0);
    major * 10_000 + minor * 100 + patch
}

/// The status names the fast tier reads, upper-cased (MariaDB's
/// `information_schema.GLOBAL_STATUS` reports them that way), and their aliases —
/// none of them a MySQL reserved word (`READS` is one).
const STATUS_NAMES: [(&str, &str); 13] = [
    ("HANDLER_COMMIT", "xact_commit"),
    ("HANDLER_ROLLBACK", "xact_rollback"),
    ("INNODB_BUFFER_POOL_READ_REQUESTS", "read_requests"),
    ("INNODB_BUFFER_POOL_READS", "pool_reads"),
    ("INNODB_ROWS_READ", "rows_read"),
    ("INNODB_ROWS_INSERTED", "rows_inserted"),
    ("INNODB_ROWS_UPDATED", "rows_updated"),
    ("INNODB_ROWS_DELETED", "rows_deleted"),
    ("INNODB_OS_LOG_WRITTEN", "log_written"),
    ("CREATED_TMP_DISK_TABLES", "tmp_disk_tables"),
    ("INNODB_BUFFER_POOL_PAGES_FLUSHED", "pages_flushed"),
    ("INNODB_DEADLOCKS", "status_deadlocks"),
    ("UPTIME", "uptime"),
];

/// The process list joined to InnoDB's transactions, or to a row of NULLs when the
/// role cannot read them, so every expression below reads the same either way.
fn sessions_from(shape: &Shape) -> String {
    let trx = if shape.innodb {
        "information_schema.INNODB_TRX"
    } else {
        "(SELECT NULL AS trx_id, NULL AS trx_state, NULL AS trx_started, \
          NULL AS trx_mysql_thread_id) "
    };
    let on = if shape.innodb {
        "t.trx_mysql_thread_id = p.ID"
    } else {
        "FALSE"
    };
    format!(
        "{} p LEFT JOIN {trx} t ON {on} WHERE p.ID <> CONNECTION_ID()",
        shape.processlist
    )
}

/// The session's state in PostgreSQL's words: a sleeping connection with an InnoDB
/// transaction is idle in transaction.
const STATE_EXPR: &str = "CASE WHEN p.COMMAND = 'Sleep' \
         THEN IF(t.trx_id IS NULL, 'idle', 'idle in transaction') \
     WHEN p.COMMAND IN ('Daemon', 'Binlog Dump', 'Binlog Dump GTID', 'Killed', 'Connect', \
                        'Register Slave', 'Delayed insert') THEN 'other' \
     ELSE 'active' END";

/// The wait bucket (a `WAIT_TYPES` name; NULL = running on CPU) from the thread's
/// STATE and InnoDB's lock-wait flag.
const WAIT_EXPR: &str = "CASE WHEN p.COMMAND = 'Sleep' THEN 'Client' \
     WHEN t.trx_state = 'LOCK WAIT' OR p.STATE LIKE 'Waiting for%lock' \
          OR p.STATE LIKE '%lock wait%' THEN 'Lock' \
     WHEN p.STATE IN ('Sending to client', 'Writing to net', 'Reading from net', \
                      'Receiving from client') THEN 'Client' \
     WHEN p.STATE = 'User sleep' THEN 'Timeout' \
     WHEN p.STATE IN ('Opening tables', 'Opening table', 'creating table', 'Creating tmp table', \
                      'converting HEAP to ondisk', 'Copying to tmp table', \
                      'Copying to tmp table on disk', 'Creating sort index', 'removing tmp table', \
                      'waiting for handler commit', 'Waiting for handler commit') THEN 'IO' \
     WHEN p.STATE LIKE 'Waiting%' THEN 'Other' \
     ELSE NULL END";

/// The wait buckets as the Activity list names them on MySQL (`engines.ts` mirrors
/// these for the load chart).
const WAIT_LABELS: [(&str, &str); 3] = [
    ("Timeout", "Sleep"),
    ("IO", "I/O"),
    ("Other", "Other waits"),
];

/// Client connections: not the server's own threads.
const CLIENT_EXPR: &str = "IF(p.USER IN ('system user', 'event_scheduler') \
     OR p.COMMAND IN ('Daemon', 'Binlog Dump', 'Binlog Dump GTID'), 'f', 't')";

/// The fast tier's counters and scalars: one row.
pub(crate) fn status_sql(shape: &Shape) -> String {
    let picks: Vec<String> = STATUS_NAMES
        .iter()
        .map(|(name, alias)| {
            format!(
                "MAX(CASE WHEN UPPER(VARIABLE_NAME) = '{name}' THEN VARIABLE_VALUE END) AS {alias}"
            )
        })
        .collect();
    let names: Vec<String> = STATUS_NAMES.iter().map(|(n, _)| format!("'{n}'")).collect();
    let (oldest, innodb_blocked) = if shape.innodb {
        (
            "(SELECT CAST(TIMESTAMPDIFF(MICROSECOND, MIN(trx_started), NOW(6)) / 1000 AS SIGNED) \
               FROM information_schema.INNODB_TRX WHERE trx_mysql_thread_id <> CONNECTION_ID())",
            "(SELECT COUNT(*) FROM information_schema.INNODB_TRX WHERE trx_state = 'LOCK WAIT')",
        )
    } else {
        ("NULL", "0")
    };
    // MySQL keeps the deadlock count in INNODB_METRICS (on by default); MariaDB also
    // reports it as a status variable.
    let lag = if shape.replication {
        REPLICA_LAG_SQL
    } else {
        "NULL"
    };
    let metric_deadlocks = if shape.innodb && !shape.mariadb {
        "(SELECT `COUNT` FROM information_schema.INNODB_METRICS WHERE NAME = 'lock_deadlocks')"
    } else {
        "NULL"
    };
    format!(
        "SELECT s.*, CAST(UNIX_TIMESTAMP(NOW(3)) * 1000 AS SIGNED) AS server_ms, \
                @@max_connections AS max_connections, \
                {oldest} AS oldest_xact_ms, \
                {innodb_blocked} + (SELECT COUNT(*) FROM {proc} \
                     WHERE STATE LIKE 'Waiting for%lock' AND ID <> CONNECTION_ID()) AS blocked, \
                {metric_deadlocks} AS metric_deadlocks, \
                {lag} AS replication_lag_ms \
         FROM (SELECT {picks} FROM {status} WHERE UPPER(VARIABLE_NAME) IN ({names})) s",
        proc = shape.processlist,
        picks = picks.join(", "),
        status = shape.status,
        names = names.join(", "),
    )
}

/// How far this replica's applier is behind, in ms; NULL when it is not a replica.
/// Applying: now − the original commit time of the transaction it is applying.
/// Running and caught up: 0. Stopped (the receiver or the applier): now − the last
/// applied transaction's original commit time, so a broken replica keeps falling
/// behind on the tile instead of reading as caught up.
const REPLICA_LAG_SQL: &str = "(SELECT CASE \
       WHEN NOT EXISTS (SELECT 1 FROM performance_schema.replication_connection_status) THEN NULL \
       WHEN EXISTS (SELECT 1 FROM performance_schema.replication_connection_status \
                     WHERE SERVICE_STATE <> 'ON') \
         OR EXISTS (SELECT 1 FROM performance_schema.replication_applier_status \
                     WHERE SERVICE_STATE <> 'ON') \
       THEN (SELECT CAST(TIMESTAMPDIFF(MICROSECOND, \
                         MAX(LAST_APPLIED_TRANSACTION_ORIGINAL_COMMIT_TIMESTAMP), NOW(6)) / 1000 AS SIGNED) \
               FROM performance_schema.replication_applier_status_by_worker) \
       ELSE COALESCE((SELECT CAST(MAX(TIMESTAMPDIFF(MICROSECOND, \
                         APPLYING_TRANSACTION_ORIGINAL_COMMIT_TIMESTAMP, NOW(6))) / 1000 AS SIGNED) \
               FROM performance_schema.replication_applier_status_by_worker \
              WHERE APPLYING_TRANSACTION <> ''), 0) END)";

/// (MariaDB truncates `LOWER()` of an `information_schema` column inside a derived
/// table to two characters, so its lock type is spelled out with a CASE.)
///
/// Locks waiting to be granted: InnoDB row and table locks, plus pending metadata
/// locks (an `ALTER TABLE` queued behind an open transaction) on MySQL 8. A metadata
/// wait's blockers are the other sessions holding a granted lock on the same object.
/// MariaDB reports only InnoDB waits. `None` without `PROCESS`.
pub(crate) fn lock_waits_sql(shape: &Shape) -> Option<String> {
    let proc = shape.processlist;
    let chars = pg::QUERY_TEXT_CHARS;
    let rows = views::VIEW_ROWS;
    let inner = match shape.lock_waits {
        LockWaits::None => return None,
        LockWaits::PerfSchema => format!(
            "SELECT rt.PROCESSLIST_ID AS `pid`, CAST(rt.PROCESSLIST_ID AS CHAR) AS `backend_start`, \
                    LOWER(rl.LOCK_TYPE) AS `locktype`, rl.LOCK_MODE AS `mode`, \
                    CONCAT(rl.OBJECT_SCHEMA, '.', rl.OBJECT_NAME, \
                           IF(rl.INDEX_NAME IS NULL, '', CONCAT(' (', rl.INDEX_NAME, ')')), \
                           IF(rl.LOCK_DATA IS NULL, '', CONCAT(' ', LEFT(rl.LOCK_DATA, 200)))) AS `target`, \
                    p.USER AS `usr`, p.DB AS `db`, NULL AS `app`, 'active' AS `state`, \
                    CAST(TIMESTAMPDIFF(MICROSECOND, t.trx_wait_started, NOW(6)) / 1000 AS SIGNED) AS `waited_ms`, \
                    CAST(UNIX_TIMESTAMP(t.trx_started) * 1000 AS SIGNED) AS `xact_ms`, \
                    (SELECT CONCAT('{{', GROUP_CONCAT(DISTINCT bt.PROCESSLIST_ID ORDER BY bt.PROCESSLIST_ID), '}}') \
                       FROM performance_schema.data_lock_waits w \
                       JOIN performance_schema.threads bt ON bt.THREAD_ID = w.BLOCKING_THREAD_ID \
                      WHERE w.REQUESTING_ENGINE_LOCK_ID = rl.ENGINE_LOCK_ID) AS `blocked_by`, \
                    LEFT(p.INFO, {chars}) AS `query` \
               FROM performance_schema.data_locks rl \
               JOIN performance_schema.threads rt ON rt.THREAD_ID = rl.THREAD_ID \
               LEFT JOIN {proc} p ON p.ID = rt.PROCESSLIST_ID \
               LEFT JOIN information_schema.INNODB_TRX t ON t.trx_mysql_thread_id = rt.PROCESSLIST_ID \
              WHERE rl.LOCK_STATUS = 'WAITING' AND rt.PROCESSLIST_ID <> CONNECTION_ID() \
             UNION ALL \
             SELECT mt.PROCESSLIST_ID, CAST(mt.PROCESSLIST_ID AS CHAR), 'metadata', m.LOCK_TYPE, \
                    CONCAT(LOWER(m.OBJECT_TYPE), ' ', CONCAT_WS('.', m.OBJECT_SCHEMA, m.OBJECT_NAME)), \
                    p.USER, p.DB, NULL, 'active', mt.PROCESSLIST_TIME * 1000, \
                    CAST(UNIX_TIMESTAMP(t.trx_started) * 1000 AS SIGNED), \
                    (SELECT CONCAT('{{', GROUP_CONCAT(DISTINCT gt.PROCESSLIST_ID ORDER BY gt.PROCESSLIST_ID), '}}') \
                       FROM performance_schema.metadata_locks g \
                       JOIN performance_schema.threads gt ON gt.THREAD_ID = g.OWNER_THREAD_ID \
                      WHERE g.LOCK_STATUS = 'GRANTED' AND g.OBJECT_TYPE = m.OBJECT_TYPE \
                        AND g.OBJECT_SCHEMA <=> m.OBJECT_SCHEMA AND g.OBJECT_NAME <=> m.OBJECT_NAME \
                        AND g.OWNER_THREAD_ID <> m.OWNER_THREAD_ID AND gt.PROCESSLIST_ID IS NOT NULL), \
                    LEFT(p.INFO, {chars}) \
               FROM performance_schema.metadata_locks m \
               JOIN performance_schema.threads mt ON mt.THREAD_ID = m.OWNER_THREAD_ID \
               LEFT JOIN {proc} p ON p.ID = mt.PROCESSLIST_ID \
               LEFT JOIN information_schema.INNODB_TRX t ON t.trx_mysql_thread_id = mt.PROCESSLIST_ID \
              WHERE m.LOCK_STATUS = 'PENDING' AND mt.PROCESSLIST_ID <> CONNECTION_ID()"
        ),
        LockWaits::InfoSchema => format!(
            "SELECT t.trx_mysql_thread_id AS `pid`, CAST(t.trx_mysql_thread_id AS CHAR) AS `backend_start`, \
                    CASE l.lock_type WHEN 'RECORD' THEN 'record' WHEN 'TABLE' THEN 'table' ELSE l.lock_type END AS `locktype`, l.lock_mode AS `mode`, \
                    CONCAT(l.lock_table, IF(l.lock_index IS NULL, '', CONCAT(' (', l.lock_index, ')')), \
                           IF(l.lock_data IS NULL, '', CONCAT(' ', LEFT(l.lock_data, 200)))) AS `target`, \
                    p.USER AS `usr`, p.DB AS `db`, NULL AS `app`, 'active' AS `state`, \
                    CAST(TIMESTAMPDIFF(MICROSECOND, t.trx_wait_started, NOW(6)) / 1000 AS SIGNED) AS `waited_ms`, \
                    CAST(UNIX_TIMESTAMP(t.trx_started) * 1000 AS SIGNED) AS `xact_ms`, \
                    (SELECT CONCAT('{{', GROUP_CONCAT(DISTINCT bt.trx_mysql_thread_id ORDER BY bt.trx_mysql_thread_id), '}}') \
                       FROM information_schema.INNODB_LOCK_WAITS w \
                       JOIN information_schema.INNODB_TRX bt ON bt.trx_id = w.blocking_trx_id \
                      WHERE w.requesting_trx_id = t.trx_id) AS `blocked_by`, \
                    LEFT(p.INFO, {chars}) AS `query` \
               FROM information_schema.INNODB_TRX t \
               JOIN information_schema.INNODB_LOCKS l ON l.lock_id = t.trx_requested_lock_id \
               LEFT JOIN {proc} p ON p.ID = t.trx_mysql_thread_id \
              WHERE t.trx_state = 'LOCK WAIT' AND t.trx_mysql_thread_id <> CONNECTION_ID()"
        ),
    };
    Some(format!(
        "SELECT x.*, COUNT(*) OVER () AS `total` FROM ({inner}) x \
         ORDER BY x.`waited_ms` DESC, x.`pid` LIMIT {rows}"
    ))
}

/// Granted InnoDB locks grouped by target and mode (MariaDB: only the locks someone
/// is waiting on, which is all it lists). Metadata locks are left out: every open
/// table holds one, and the waiting list already names the holders that matter.
pub(crate) fn lock_holds_sql(shape: &Shape) -> Option<String> {
    let rows = views::VIEW_ROWS;
    let inner = match shape.lock_waits {
        LockWaits::None => return None,
        LockWaits::PerfSchema => "SELECT LOWER(l.LOCK_TYPE) AS `locktype`, l.LOCK_MODE AS `mode`, \
                    CONCAT(l.OBJECT_SCHEMA, '.', l.OBJECT_NAME, \
                           IF(l.INDEX_NAME IS NULL, '', CONCAT(' (', l.INDEX_NAME, ')'))) AS `target`, \
                    COUNT(*) AS `n`, \
                    CONCAT('{', SUBSTRING_INDEX(GROUP_CONCAT(DISTINCT t.PROCESSLIST_ID \
                           ORDER BY t.PROCESSLIST_ID), ',', 10), '}') AS `pids` \
               FROM performance_schema.data_locks l \
               JOIN performance_schema.threads t ON t.THREAD_ID = l.THREAD_ID \
              WHERE l.LOCK_STATUS = 'GRANTED' AND t.PROCESSLIST_ID <> CONNECTION_ID() \
              GROUP BY `locktype`, `mode`, `target`",
        LockWaits::InfoSchema => "SELECT CASE l.lock_type WHEN 'RECORD' THEN 'record' WHEN 'TABLE' THEN 'table' ELSE l.lock_type END AS `locktype`, l.lock_mode AS `mode`, \
                    CONCAT(l.lock_table, IF(l.lock_index IS NULL, '', CONCAT(' (', l.lock_index, ')'))) AS `target`, \
                    COUNT(*) AS `n`, \
                    CONCAT('{', SUBSTRING_INDEX(GROUP_CONCAT(DISTINCT t.trx_mysql_thread_id \
                           ORDER BY t.trx_mysql_thread_id), ',', 10), '}') AS `pids` \
               FROM information_schema.INNODB_LOCKS l \
               JOIN information_schema.INNODB_TRX t ON t.trx_id = l.lock_trx_id \
              WHERE l.lock_id IN (SELECT blocking_lock_id FROM information_schema.INNODB_LOCK_WAITS) \
              GROUP BY `locktype`, `mode`, `target`",
    };
    Some(format!(
        "SELECT g.*, SUM(g.`n`) OVER () AS `total`, COUNT(*) OVER () AS `groups` FROM ({inner}) g \
         ORDER BY g.`n` DESC, g.`locktype`, g.`mode` LIMIT {rows}"
    ))
}

/// The session histogram: rows of state × wait × client.
pub(crate) fn histogram_sql(shape: &Shape) -> String {
    format!(
        "SELECT state, wait, client, COUNT(*) AS n FROM (\
           SELECT {STATE_EXPR} AS state, {WAIT_EXPR} AS wait, {CLIENT_EXPR} AS client \
           FROM {from}) x GROUP BY state, wait, client",
        from = sessions_from(shape),
    )
}

/// The process list, shaped like PostgreSQL's activity rows so one parser reads it.
/// A connection id is never reused while the server runs, so it alone identifies a
/// session (`backend_start` repeats it).
pub(crate) fn activity_sql(shape: &Shape) -> String {
    let chars = pg::QUERY_TEXT_CHARS;
    let blocked_by = match shape.lock_waits {
        LockWaits::PerfSchema => {
            "CASE WHEN t.trx_state = 'LOCK WAIT' THEN (\
               SELECT CONCAT('{', GROUP_CONCAT(DISTINCT bt.PROCESSLIST_ID), '}') \
               FROM performance_schema.data_lock_waits w \
               JOIN performance_schema.threads rt ON rt.THREAD_ID = w.REQUESTING_THREAD_ID \
               JOIN performance_schema.threads bt ON bt.THREAD_ID = w.BLOCKING_THREAD_ID \
               WHERE rt.PROCESSLIST_ID = p.ID) END"
        }
        LockWaits::InfoSchema => {
            "CASE WHEN t.trx_state = 'LOCK WAIT' THEN (\
               SELECT CONCAT('{', GROUP_CONCAT(DISTINCT bt.trx_mysql_thread_id), '}') \
               FROM information_schema.INNODB_LOCK_WAITS w \
               JOIN information_schema.INNODB_TRX bt ON bt.trx_id = w.blocking_trx_id \
               WHERE w.requesting_trx_id = t.trx_id) END"
        }
        LockWaits::None => "NULL",
    };
    format!(
        "SELECT p.ID AS pid, CAST(p.ID AS CHAR) AS backend_start, NULL AS backend_start_ms, \
                p.USER AS usr, p.DB AS db, NULL AS app, p.HOST AS client, \
                IF({CLIENT_EXPR} = 't', 'client backend', 'background') AS backend_type, \
                {STATE_EXPR} AS state, \
                {WAIT_EXPR} AS wait_event_type, p.STATE AS wait_event, \
                CAST(UNIX_TIMESTAMP(t.trx_started) * 1000 AS SIGNED) AS xact_ms, \
                CASE WHEN p.COMMAND <> 'Sleep' \
                     THEN CAST((UNIX_TIMESTAMP(NOW(3)) - p.TIME) * 1000 AS SIGNED) END AS query_ms, \
                CAST((UNIX_TIMESTAMP(NOW(3)) - p.TIME) * 1000 AS SIGNED) AS state_ms, \
                {blocked_by} AS blocked_by, \
                LEFT(p.INFO, {chars}) AS query, \
                IF(CHAR_LENGTH(p.INFO) > {chars}, 't', 'f') AS query_truncated, \
                COUNT(*) OVER () AS total \
         FROM {from} \
         ORDER BY p.COMMAND = 'Sleep', p.TIME DESC, p.ID \
         LIMIT {rows}",
        from = sessions_from(shape),
        rows = pg::ACTIVITY_ROWS,
    )
}

/// The monitor's own MySQL session.
pub(crate) struct MySqlSession {
    backend: Backend,
    conn: Option<mysql_async::Conn>,
    pub probe: Probe,
    status: String,
    histogram: String,
    activity: String,
    lock_waits: Option<String>,
    lock_holds: Option<String>,
}

impl MySqlSession {
    /// Dial the sidecar (its own pool, SSH tunnel and TLS through the usual driver
    /// path), take its connection and read its facts.
    pub(crate) async fn open(config: &ConnectionConfig) -> Result<Self, AppError> {
        let (backend, _version) = driver::connect(config).await?;
        let mut session = Self {
            backend,
            conn: None,
            probe: base_probe("mysql", "MySQL"),
            status: String::new(),
            histogram: String::new(),
            activity: String::new(),
            lock_waits: None,
            lock_holds: None,
        };
        session.setup().await?;
        Ok(session)
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.conn.is_none()
    }

    /// Re-dial after the connection dropped (a fresh pool, through a re-verified
    /// tunnel). Never replays anything: the next tick is the retry.
    pub(crate) async fn reopen(&mut self) -> Result<(), AppError> {
        self.conn = None;
        self.backend.reopen().await?;
        self.setup().await
    }

    async fn query(&mut self, sql: &str) -> Result<(Vec<String>, Vec<Row>), AppError> {
        let conn = self
            .conn
            .as_mut()
            .ok_or_else(|| AppError::new("the monitor connection is closed"))?;
        match driver::mysql_monitor_query(conn, sql, db::MONITOR_TEXT_LIMITS).await {
            Ok(rows) => Ok(rows),
            Err(e) => {
                if e.lost {
                    self.conn = None;
                }
                Err(e.error)
            }
        }
    }

    /// True when `sql` runs here (a capability probe); a lost connection still fails.
    async fn readable(&mut self, sql: &str) -> Result<bool, AppError> {
        match self.query(sql).await {
            Ok(_) => Ok(true),
            Err(e) if self.conn.is_none() => Err(e),
            Err(_) => Ok(false),
        }
    }

    /// True when `sql` runs here AND returns a row. MariaDB with `performance_schema`
    /// off still has its tables, empty, so readability alone would pick them.
    async fn has_rows(&mut self, sql: &str) -> Result<bool, AppError> {
        match self.query(sql).await {
            Ok((_, rows)) => Ok(!rows.is_empty()),
            Err(e) if self.conn.is_none() => Err(e),
            Err(_) => Ok(false),
        }
    }

    async fn setup(&mut self) -> Result<(), AppError> {
        let conn = self.backend.mysql_conn()?.monitor_checkout().await?;
        self.conn = Some(conn);
        for sql in SESSION_SETUP {
            let _ = self.readable(sql).await?;
        }
        let (c, rows) = self.query(PROBE_SQL).await?;
        let row = rows
            .first()
            .ok_or_else(|| AppError::new("monitor probe returned no row"))?;
        let version = pg::text(&c, row, "version").unwrap_or_default();
        let mariadb = version.to_ascii_lowercase().contains("mariadb");
        let v = version_num(&version);
        let floor = if mariadb { MIN_MARIADB } else { MIN_MYSQL };
        if v < floor {
            return Err(AppError::new(format!(
                "the database monitor needs {} or later (this server reports {version})",
                if mariadb { "MariaDB 10.5" } else { "MySQL 8.0" }
            )));
        }
        let status = if self
            .has_rows("SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Uptime'")
            .await?
        {
            "performance_schema.global_status"
        } else if self
            .has_rows("SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'UPTIME'")
            .await?
        {
            "information_schema.GLOBAL_STATUS"
        } else {
            return Err(AppError::new(
                "the database monitor reads the server's status counters from performance_schema; \
                 it is disabled on this server",
            ));
        };
        let processlist = if !mariadb
            && v >= PS_PROCESSLIST
            && self
                .readable("SELECT COUNT(*) FROM performance_schema.processlist")
                .await?
        {
            "performance_schema.processlist"
        } else {
            "information_schema.PROCESSLIST"
        };
        let innodb = self
            .readable("SELECT COUNT(*) FROM information_schema.INNODB_TRX")
            .await?;
        let lock_waits = if !innodb {
            LockWaits::None
        } else if !mariadb
            && self
                .readable("SELECT COUNT(*) FROM performance_schema.data_lock_waits")
                .await?
        {
            LockWaits::PerfSchema
        } else if mariadb
            && self
                .readable("SELECT COUNT(*) FROM information_schema.INNODB_LOCK_WAITS")
                .await?
        {
            LockWaits::InfoSchema
        } else {
            LockWaits::None
        };
        let replication = !mariadb
            && self
                .readable(
                    "SELECT COUNT(*) FROM performance_schema.replication_connection_status, \
                     performance_schema.replication_applier_status_by_worker",
                )
                .await?;
        let shape = Shape {
            mariadb,
            status,
            processlist,
            innodb,
            lock_waits,
            replication,
        };
        let grants = self.grants().await;
        let has = |p: &str| grants.iter().any(|g| g == p || g == "ALL PRIVILEGES");
        let now_ms = pg::opt_int(&c, row, "now_ms")?;
        let mut probe = base_probe("mysql", if mariadb { "MariaDB" } else { "MySQL" });
        probe.version_num = v;
        probe.version = version.split('-').next().unwrap_or(&version).to_string();
        probe.pid = pg::int(&c, row, "pid")?.clamp(0, i64::from(i32::MAX)) as i32;
        probe.user = pg::text(&c, row, "usr").unwrap_or_default();
        probe.database = pg::text(&c, row, "db").unwrap_or_default();
        probe.superuser = has("SUPER");
        // PROCESS shows every account's threads; without it only the monitor's own.
        probe.read_all_stats = innodb || has("PROCESS");
        probe.signal_backend = has("SUPER") || has("CONNECTION_ADMIN");
        probe.max_connections = pg::clamp_u32(pg::int(&c, row, "max_connections")?);
        probe.block_size = pg::clamp_u32(pg::int(&c, row, "block_size")?).max(1);
        probe.query_size = pg::QUERY_TEXT_CHARS as i64;
        probe.statements_note = Some("Statements are PostgreSQL-only for now.".into());
        self.status = status_sql(&shape);
        self.histogram = histogram_sql(&shape);
        self.activity = activity_sql(&shape);
        self.lock_waits = lock_waits_sql(&shape);
        self.lock_holds = lock_holds_sql(&shape);
        let (sc, srows) = self.query(&self.status.clone()).await?;
        if let (Some(now), Some(srow)) = (now_ms, srows.first()) {
            if let Some(uptime) = pg::opt_int(&sc, srow, "uptime")? {
                probe.started_ms = Some(now - uptime * 1000);
            }
        }
        self.probe = probe;
        Ok(())
    }

    /// The global privileges `SHOW GRANTS` lists for the current account (best effort:
    /// they only decide which notes the tab shows).
    async fn grants(&mut self) -> Vec<String> {
        let Ok((_c, rows)) = self.query("SHOW GRANTS").await else {
            return Vec::new();
        };
        rows.iter()
            .filter_map(|r| r.first().cloned().flatten())
            .filter(|g| g.contains(" ON *.* "))
            .flat_map(|g| {
                let list = g
                    .strip_prefix("GRANT ")
                    .and_then(|rest| rest.split(" ON *.* ").next())
                    .unwrap_or("")
                    .to_string();
                list.split(',')
                    .map(|p| p.trim().to_ascii_uppercase())
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    pub(crate) async fn sample(&mut self) -> Result<FastSample, AppError> {
        let status = self.status.clone();
        let (c, rows) = self.query(&status).await?;
        let [row] = rows.as_slice() else {
            return Err(AppError::new("monitor fast tier returned no row"));
        };
        let histogram = self.histogram.clone();
        let (hc, hrows) = self.query(&histogram).await?;
        parse_sample(&c, row, &hc, &hrows)
    }

    pub(crate) async fn activity(&mut self) -> Result<Activity, AppError> {
        let sql = self.activity.clone();
        let (c, rows) = self.query(&sql).await?;
        let mut activity = pg::parse_activity(&c, &rows)?;
        pg::relabel_waits(&mut activity, &WAIT_LABELS);
        Ok(activity)
    }

    /// The Locks view: waiting and granted locks, shaped like PostgreSQL's.
    pub(crate) async fn locks(&mut self) -> Result<Locks, AppError> {
        let (Some(waits), Some(holds)) = (self.lock_waits.clone(), self.lock_holds.clone()) else {
            return Err(AppError::new(
                "the Locks view reads InnoDB's lock tables, which need the PROCESS privilege",
            ));
        };
        let (wc, wr) = self.query(&waits).await?;
        let (hc, hr) = self.query(&holds).await?;
        views::parse_locks(&wc, &wr, &hc, &hr)
    }

    /// `KILL QUERY` or `KILL CONNECTION`. A connection id is never reused while the
    /// server runs, so it alone names the session; `Ok(false)` when it had gone.
    pub(crate) async fn signal(
        &mut self,
        pid: i32,
        backend_start: &str,
        action: SignalAction,
    ) -> Result<bool, AppError> {
        if pid <= 0 || backend_start != pid.to_string() {
            return Err(AppError::new("that session cannot be identified"));
        }
        let conn = self
            .conn
            .as_mut()
            .ok_or_else(|| AppError::new("the monitor connection is closed"))?;
        match driver::mysql_monitor_query(conn, &kill_sql(pid, action), db::MONITOR_TEXT_LIMITS)
            .await
        {
            Ok(_) => Ok(true),
            Err(e) if e.code == Some(ER_NO_SUCH_THREAD) => Ok(false),
            Err(e) => {
                if e.lost {
                    self.conn = None;
                }
                Err(e.error)
            }
        }
    }
}

pub(crate) fn kill_sql(pid: i32, action: SignalAction) -> String {
    match action {
        SignalAction::Cancel => format!("KILL QUERY {pid}"),
        SignalAction::Terminate => format!("KILL CONNECTION {pid}"),
    }
}

/// Map the status row and the histogram onto the neutral sample. InnoDB's logical
/// reads include the physical ones, so hits are the difference.
pub(crate) fn parse_sample(
    columns: &[String],
    row: &[Option<String>],
    hist_columns: &[String],
    hist_rows: &[Row],
) -> Result<FastSample, AppError> {
    let i = |name: &str| pg::int(columns, row, name);
    let reads = i("pool_reads")?;
    let deadlocks = match pg::opt_int(columns, row, "metric_deadlocks")? {
        Some(n) => n,
        None => i("status_deadlocks")?,
    };
    let counters = Counters {
        xact_commit: i("xact_commit")?,
        xact_rollback: i("xact_rollback")?,
        blks_read: reads,
        blks_hit: (i("read_requests")? - reads).max(0),
        tup_returned: i("rows_read")?,
        tup_fetched: 0,
        tup_inserted: i("rows_inserted")?,
        tup_updated: i("rows_updated")?,
        tup_deleted: i("rows_deleted")?,
        temp_bytes: 0,
        temp_files: i("tmp_disk_tables")?,
        deadlocks,
        conflicts: 0,
        checkpoints_timed: 0,
        checkpoints_requested: 0,
        buffers_checkpoint: i("pages_flushed")?,
        buffers_clean: 0,
        buffers_backend: None,
        wal_bytes: pg::opt_int(columns, row, "log_written")?,
        wal_fpi: None,
        stats_reset_ms: None,
    };
    let max_connections = pg::clamp_u32(i("max_connections")?);
    let (sessions, load) = fold_histogram(bucket_rows(hist_columns, hist_rows)?, max_connections);
    Ok(FastSample {
        server_ms: pg::opt_int(columns, row, "server_ms")?,
        counters,
        sessions,
        load,
        oldest_xact_ms: pg::opt_int(columns, row, "oldest_xact_ms")?.map(|v| v.max(0)),
        blocked: pg::clamp_u32(i("blocked")?),
        replication_lag_ms: pg::opt_int(columns, row, "replication_lag_ms")?.map(|v| v.max(0)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::script::{parse_for_engine, Item, TransactionEngine};

    fn cols(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn shapes() -> Vec<Shape> {
        let mut out = Vec::new();
        for mariadb in [false, true] {
            for innodb in [false, true] {
                for lock_waits in [
                    LockWaits::PerfSchema,
                    LockWaits::InfoSchema,
                    LockWaits::None,
                ] {
                    out.push(Shape {
                        mariadb,
                        status: if mariadb {
                            "information_schema.GLOBAL_STATUS"
                        } else {
                            "performance_schema.global_status"
                        },
                        processlist: "information_schema.PROCESSLIST",
                        innodb,
                        lock_waits,
                        replication: !mariadb,
                    });
                }
            }
        }
        out
    }

    #[test]
    fn versions_read_mysql_and_mariadb_forms() {
        assert_eq!(version_num("8.0.36"), 80036);
        assert_eq!(version_num("8.4.2-commercial"), 80402);
        assert_eq!(
            version_num("10.11.6-MariaDB-1:10.11.6+maria~ubu2204"),
            101106
        );
        assert_eq!(version_num("9.1.0"), 90100);
        assert_eq!(version_num("garbage"), 0);
    }

    #[test]
    fn every_statement_is_one_mysql_statement_for_every_shape() {
        for shape in shapes() {
            let mut all = vec![
                status_sql(&shape),
                histogram_sql(&shape),
                activity_sql(&shape),
            ];
            all.extend(lock_waits_sql(&shape));
            all.extend(lock_holds_sql(&shape));
            assert_eq!(
                lock_waits_sql(&shape).is_some(),
                shape.lock_waits != LockWaits::None
            );
            for sql in all {
                let items = parse_for_engine(&sql, TransactionEngine::MySql)
                    .unwrap_or_else(|e| panic!("{sql}: {}", e.message));
                assert!(
                    matches!(items.as_slice(), [Item::Sql(_)]),
                    "one statement: {sql}"
                );
                assert!(!sql.contains(';'), "no semicolon reaches the server: {sql}");
            }
        }
        assert_eq!(kill_sql(42, SignalAction::Cancel), "KILL QUERY 42");
        assert_eq!(kill_sql(42, SignalAction::Terminate), "KILL CONNECTION 42");
    }

    #[test]
    fn innodb_parts_drop_out_without_the_process_privilege() {
        let mut shape = shapes().remove(0);
        shape.innodb = false;
        assert!(!status_sql(&shape).contains("INNODB_TRX"));
        assert!(!histogram_sql(&shape).contains("INNODB_TRX"));
        shape.innodb = true;
        assert!(status_sql(&shape).contains("INNODB_TRX"));
        assert!(histogram_sql(&shape).contains("information_schema.INNODB_TRX t"));
    }

    #[test]
    fn the_sample_maps_status_onto_the_neutral_counters() {
        let c = cols(&[
            "xact_commit",
            "xact_rollback",
            "read_requests",
            "pool_reads",
            "rows_read",
            "rows_inserted",
            "rows_updated",
            "rows_deleted",
            "log_written",
            "tmp_disk_tables",
            "pages_flushed",
            "status_deadlocks",
            "uptime",
            "server_ms",
            "max_connections",
            "oldest_xact_ms",
            "blocked",
            "metric_deadlocks",
        ]);
        let v = |s: &str| Some(s.to_string());
        let row = vec![
            v("100"),
            v("3"),
            v("1000"),
            v("40"),
            v("500"),
            v("7"),
            v("8"),
            v("9"),
            v("123456"),
            v("2"),
            v("11"),
            None,
            v("3600"),
            v("1729400000000"),
            v("151"),
            v("-5"),
            v("2"),
            v("4"),
        ];
        let hc = cols(&["state", "wait", "client", "n"]);
        let hr = vec![
            vec![v("active"), None, v("t"), v("2")],
            vec![v("active"), v("Lock"), v("t"), v("1")],
            vec![v("idle"), v("Client"), v("t"), v("5")],
            vec![v("idle in transaction"), v("Client"), v("t"), v("1")],
            vec![v("other"), v("Other"), v("f"), v("3")],
            vec![v("active"), v("IO"), v("f"), v("1")],
        ];
        let s = parse_sample(&c, &row, &hc, &hr).unwrap();
        assert_eq!(s.counters.xact_commit, 100);
        assert_eq!(s.counters.blks_read, 40);
        assert_eq!(
            s.counters.blks_hit, 960,
            "hits = logical reads − physical reads"
        );
        assert_eq!(s.counters.tup_returned, 500);
        assert_eq!(s.counters.wal_bytes, Some(123_456));
        assert_eq!(s.counters.deadlocks, 4, "INNODB_METRICS wins when present");
        assert_eq!(s.counters.buffers_checkpoint, 11);
        assert_eq!(s.oldest_xact_ms, Some(0), "clock skew clamps to zero");
        assert_eq!(s.blocked, 2);
        assert_eq!(s.sessions.total, 9, "client threads only");
        assert_eq!(s.sessions.active, 3);
        assert_eq!(s.sessions.idle, 5);
        assert_eq!(s.sessions.idle_in_transaction, 1);
        assert_eq!(s.sessions.max_connections, 151);
        assert_eq!(s.load[0], 2, "running = CPU");
        assert_eq!(s.load[1], 1, "Lock");
        assert_eq!(s.load[3], 1, "a server thread doing I/O is load");
    }
}
