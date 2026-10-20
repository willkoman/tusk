//! SQL Server source for the database monitor: the sidecar session, its fixed SQL,
//! and the mapping onto the neutral sample model the PostgreSQL source defined.
//!
//! The sidecar is its own TDS session (dialled from the user's config through the
//! usual driver path, SSH tunnel and TLS included). SQL Server has no session
//! read-only mode, which is harmless here: the sidecar runs only the fixed reads
//! below and `KILL`. Every number comes from the DMVs, which need `VIEW SERVER STATE`
//! (SQL Server 2022: `VIEW SERVER PERFORMANCE STATE`); the probe refuses to start
//! without it rather than showing a monitor that sees only itself.

use super::pg::{self, base_probe, bucket_rows, fold_histogram, Activity, FastSample, Probe, Row};
use super::rates::Counters;
use super::SignalAction;
use crate::db::{self, AppError, ConnectionConfig};
use crate::driver::{self, Backend};

/// SQL Server 2016 (`DATEDIFF_BIG`, `dm_exec_sessions.open_transaction_count`).
const MIN_VERSION_NUM: i32 = 130_000;

/// Applied once per session: a stuck tick gives up on a lock rather than waiting, and
/// the monitor is always the one a deadlock picks.
const SESSION_SETUP: &str = "SET LOCK_TIMEOUT 250; SET DEADLOCK_PRIORITY LOW; \
     SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED";

const PROBE_SQL: &str = "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version, \
    @@SPID AS pid, SUSER_SNAME() AS usr, DB_NAME() AS db, \
    CASE WHEN IS_SRVROLEMEMBER('sysadmin') = 1 THEN 't' ELSE 'f' END AS superuser, \
    CASE WHEN HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE') = 1 \
           OR HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER PERFORMANCE STATE') = 1 \
         THEN 't' ELSE 'f' END AS read_all_stats, \
    CASE WHEN HAS_PERMS_BY_NAME(NULL, NULL, 'ALTER ANY CONNECTION') = 1 THEN 't' ELSE 'f' END AS signal_backend, \
    @@MAX_CONNECTIONS AS max_connections";

/// Read separately, after the permission check: `dm_os_sys_info` itself needs it.
const STARTED_SQL: &str = "SELECT DATEDIFF_BIG(ms, '19700101', SYSUTCDATETIME()) \
       - DATEDIFF_BIG(ms, sqlserver_start_time, SYSDATETIME()) AS started_ms \
    FROM sys.dm_os_sys_info";

/// `16.0.4135.4` → 160000 (major and minor; the build is not a version gate).
pub(crate) fn version_num(version: &str) -> i32 {
    let mut parts = version
        .split('.')
        .map(|p| p.parse::<i32>().unwrap_or(0).min(99));
    let major = parts.next().unwrap_or(0);
    let minor = parts.next().unwrap_or(0);
    major * 10_000 + minor * 100
}

/// `(alias, object suffix, counter, instance)`: cumulative `*/sec` counters from
/// `dm_os_performance_counters` (the raw value of a per-second counter is a running
/// total; the rate is its difference). Objects are prefixed `SQLServer:` or
/// `MSSQL$<instance>:`, and the nchar columns are blank-padded, hence RTRIM.
const COUNTERS: [(&str, &str, &str, &str); 8] = [
    ("xact_commit", ":Databases", "Transactions/sec", "_Total"),
    ("lookups", ":Buffer Manager", "Page lookups/sec", ""),
    ("reads", ":Buffer Manager", "Page reads/sec", ""),
    (
        "log_flushed",
        ":Databases",
        "Log Bytes Flushed/sec",
        "_Total",
    ),
    ("deadlocks", ":Locks", "Number of Deadlocks/sec", "_Total"),
    (
        "checkpoint_pages",
        ":Buffer Manager",
        "Checkpoint pages/sec",
        "",
    ),
    ("lazy_writes", ":Buffer Manager", "Lazy writes/sec", ""),
    ("workfiles", ":Access Methods", "Workfiles Created/sec", ""),
];

/// The session's state in PostgreSQL's words.
const STATE_EXPR: &str = "CASE WHEN r.session_id IS NOT NULL THEN 'active' \
     WHEN s.open_transaction_count > 0 THEN 'idle in transaction' \
     WHEN s.status IN ('sleeping', 'dormant') THEN 'idle' \
     ELSE 'other' END";

/// The wait bucket (a `WAIT_TYPES` name; NULL = running on CPU).
const WAIT_EXPR: &str = "CASE WHEN r.session_id IS NULL THEN 'Client' \
     WHEN r.wait_type IS NULL OR r.wait_type = 'SOS_SCHEDULER_YIELD' THEN NULL \
     WHEN r.wait_type LIKE 'LCK[_]%' THEN 'Lock' \
     WHEN r.wait_type LIKE 'PAGELATCH[_]%' OR r.wait_type LIKE 'LATCH[_]%' THEN 'LWLock' \
     WHEN r.wait_type LIKE 'PAGEIOLATCH[_]%' OR r.wait_type IN ('WRITELOG', 'IO_COMPLETION', \
          'ASYNC_IO_COMPLETION', 'BACKUPIO', 'LOGBUFFER') THEN 'IO' \
     WHEN r.wait_type LIKE 'CX%' OR r.wait_type = 'EXCHANGE' THEN 'IPC' \
     WHEN r.wait_type = 'ASYNC_NETWORK_IO' THEN 'Client' \
     WHEN r.wait_type = 'WAITFOR' THEN 'Timeout' \
     ELSE 'Other' END";

/// User sessions other than the monitor's own, with their running request if any.
const SESSIONS_FROM: &str = "sys.dm_exec_sessions s \
     LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id \
     WHERE s.is_user_process = 1 AND s.session_id <> @@SPID";

/// The fast tier's counters and scalars: one row.
pub(crate) fn status_sql() -> String {
    let picks: Vec<String> = COUNTERS
        .iter()
        .map(|(alias, object, counter, instance)| {
            format!(
                "MAX(CASE WHEN RTRIM(object_name) LIKE N'%{object}' AND counter_name = N'{counter}' \
                     AND instance_name = N'{instance}' THEN cntr_value END) AS {alias}"
            )
        })
        .collect();
    let names: Vec<String> = COUNTERS.iter().map(|c| format!("N'{}'", c.2)).collect();
    format!(
        "SELECT p.*, DATEDIFF_BIG(ms, '19700101', SYSUTCDATETIME()) AS server_ms, \
                @@MAX_CONNECTIONS AS max_connections, \
                (SELECT DATEDIFF_BIG(ms, MIN(at.transaction_begin_time), SYSDATETIME()) \
                   FROM sys.dm_tran_session_transactions st \
                   JOIN sys.dm_tran_active_transactions at ON at.transaction_id = st.transaction_id \
                  WHERE st.session_id <> @@SPID) AS oldest_xact_ms, \
                (SELECT COUNT(*) FROM sys.dm_exec_requests \
                  WHERE blocking_session_id > 0 AND session_id <> @@SPID) AS blocked \
         FROM (SELECT {picks} FROM sys.dm_os_performance_counters \
               WHERE counter_name IN ({names})) p",
        picks = picks.join(", "),
        names = names.join(", "),
    )
}

/// The session histogram: rows of state × wait × client.
pub(crate) fn histogram_sql() -> String {
    format!(
        "SELECT state, wait, client, COUNT(*) AS n FROM (\
           SELECT {STATE_EXPR} AS state, {WAIT_EXPR} AS wait, 't' AS client \
           FROM {SESSIONS_FROM}) x GROUP BY state, wait, client"
    )
}

/// Sessions shaped like PostgreSQL's activity rows so one parser reads them. Times
/// are local `datetime`s, shifted to UTC by the server's current offset; the login
/// time, as text, re-identifies the session for `KILL`.
pub(crate) fn activity_sql() -> String {
    let chars = pg::QUERY_TEXT_CHARS;
    format!(
        "SELECT TOP ({rows}) s.session_id AS pid, \
                CONVERT(varchar(23), s.login_time, 121) AS backend_start, \
                DATEDIFF_BIG(ms, '19700101', s.login_time) + o.utc_off AS backend_start_ms, \
                s.login_name AS usr, DB_NAME(s.database_id) AS db, s.program_name AS app, \
                COALESCE(c.client_net_address, s.host_name) AS client, \
                'client backend' AS backend_type, {STATE_EXPR} AS state, \
                {WAIT_EXPR} AS wait_event_type, r.wait_type AS wait_event, \
                x.begin_ms + o.utc_off AS xact_ms, \
                DATEDIFF_BIG(ms, '19700101', r.start_time) + o.utc_off AS query_ms, \
                DATEDIFF_BIG(ms, '19700101', COALESCE(r.start_time, s.last_request_end_time)) \
                    + o.utc_off AS state_ms, \
                CASE WHEN r.blocking_session_id > 0 \
                     THEN CONCAT('{{', r.blocking_session_id, '}}') END AS blocked_by, \
                LEFT(q.query, {chars}) AS query, \
                CASE WHEN LEN(q.query) > {chars} THEN 't' ELSE 'f' END AS query_truncated, \
                COUNT(*) OVER () AS total \
         FROM sys.dm_exec_sessions s \
         CROSS JOIN (SELECT DATEDIFF_BIG(ms, SYSDATETIME(), SYSUTCDATETIME()) AS utc_off) o \
         LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id \
         LEFT JOIN sys.dm_exec_connections c \
                ON c.session_id = s.session_id AND c.parent_connection_id IS NULL \
         OUTER APPLY (SELECT DATEDIFF_BIG(ms, '19700101', MIN(at.transaction_begin_time)) AS begin_ms \
                        FROM sys.dm_tran_session_transactions st \
                        JOIN sys.dm_tran_active_transactions at \
                          ON at.transaction_id = st.transaction_id \
                       WHERE st.session_id = s.session_id) x \
         OUTER APPLY sys.dm_exec_sql_text(COALESCE(r.sql_handle, c.most_recent_sql_handle)) t \
         OUTER APPLY (SELECT CASE WHEN r.sql_handle IS NOT NULL AND r.statement_start_offset >= 0 \
                         THEN SUBSTRING(t.text, r.statement_start_offset / 2 + 1, \
                              (CASE WHEN r.statement_end_offset = -1 THEN DATALENGTH(t.text) \
                                    ELSE r.statement_end_offset END - r.statement_start_offset) / 2 + 1) \
                         ELSE t.text END AS query) q \
         WHERE s.is_user_process = 1 AND s.session_id <> @@SPID \
         ORDER BY CASE WHEN r.session_id IS NULL THEN 1 ELSE 0 END, r.start_time, s.session_id",
        rows = pg::ACTIVITY_ROWS,
    )
}

/// `login_time` as `CONVERT(varchar(23), …, 121)` prints it: digits and `-: .` only,
/// so it can go into the `KILL` batch as a literal.
pub(crate) fn login_time_ok(text: &str) -> bool {
    (19..=23).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'-' | b':' | b' ' | b'.'))
}

/// Terminate `pid` only if it is still the session that logged in at `login_time`.
/// SQL Server has no query-only cancel: `KILL` ends the session and rolls back its
/// open transaction.
pub(crate) fn kill_sql(pid: i32, login_time: &str) -> String {
    format!(
        "IF EXISTS (SELECT 1 FROM sys.dm_exec_sessions WHERE session_id = {pid} \
                    AND CONVERT(varchar(23), login_time, 121) = '{login_time}') \
         BEGIN KILL {pid}; SELECT 't' AS signalled; END \
         ELSE SELECT 'f' AS signalled"
    )
}

/// The monitor's own SQL Server session.
pub(crate) struct MsSqlSession {
    backend: Backend,
    pub probe: Probe,
    status: String,
    histogram: String,
    activity: String,
}

impl MsSqlSession {
    pub(crate) async fn open(config: &ConnectionConfig) -> Result<Self, AppError> {
        let (backend, _version) = driver::connect(config).await?;
        let mut session = Self {
            backend,
            probe: base_probe("mssql", "SQL Server"),
            status: status_sql(),
            histogram: histogram_sql(),
            activity: activity_sql(),
        };
        session.setup().await?;
        Ok(session)
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.backend.is_closed()
    }

    /// Re-dial after the session dropped. Never replays anything.
    pub(crate) async fn reopen(&mut self) -> Result<(), AppError> {
        self.backend.reopen().await?;
        self.setup().await
    }

    async fn query(&self, sql: &str) -> Result<(Vec<String>, Vec<Row>), AppError> {
        self.backend
            .mssql_conn()?
            .monitor_query(sql, db::MONITOR_TEXT_LIMITS)
            .await
    }

    async fn setup(&mut self) -> Result<(), AppError> {
        self.query(SESSION_SETUP).await?;
        let (c, rows) = self.query(PROBE_SQL).await?;
        let row = rows
            .first()
            .ok_or_else(|| AppError::new("monitor probe returned no row"))?;
        let version = pg::text(&c, row, "version").unwrap_or_default();
        let v = version_num(&version);
        if v < MIN_VERSION_NUM {
            return Err(AppError::new(format!(
                "the database monitor needs SQL Server 2016 or later (this server reports {version})"
            )));
        }
        if !pg::boolean(&c, row, "read_all_stats") {
            return Err(AppError::new(
                "the database monitor needs the VIEW SERVER STATE permission on SQL Server \
                 (VIEW SERVER PERFORMANCE STATE on SQL Server 2022)",
            ));
        }
        let mut probe = base_probe("mssql", "SQL Server");
        probe.version_num = v;
        probe.version = version;
        probe.pid = pg::int(&c, row, "pid")?.clamp(0, i64::from(i32::MAX)) as i32;
        probe.user = pg::text(&c, row, "usr").unwrap_or_default();
        probe.database = pg::text(&c, row, "db").unwrap_or_default();
        probe.superuser = pg::boolean(&c, row, "superuser");
        probe.read_all_stats = true;
        probe.signal_backend = pg::boolean(&c, row, "signal_backend");
        probe.max_connections = pg::clamp_u32(pg::int(&c, row, "max_connections")?);
        probe.query_size = pg::QUERY_TEXT_CHARS as i64;
        probe.statements_note = Some("Statements are PostgreSQL-only for now.".into());
        if let Ok((sc, srows)) = self.query(STARTED_SQL).await {
            if let Some(srow) = srows.first() {
                probe.started_ms = pg::opt_int(&sc, srow, "started_ms")?;
            }
        }
        self.probe = probe;
        Ok(())
    }

    pub(crate) async fn sample(&mut self) -> Result<FastSample, AppError> {
        let (c, rows) = self.query(&self.status).await?;
        let [row] = rows.as_slice() else {
            return Err(AppError::new("monitor fast tier returned no row"));
        };
        let (hc, hrows) = self.query(&self.histogram).await?;
        parse_sample(&c, row, &hc, &hrows)
    }

    pub(crate) async fn activity(&mut self) -> Result<Activity, AppError> {
        let (c, rows) = self.query(&self.activity).await?;
        pg::parse_activity(&c, &rows)
    }

    /// `KILL`, re-identified by login time. `Ok(false)` when the session had gone.
    pub(crate) async fn signal(
        &mut self,
        pid: i32,
        backend_start: &str,
        action: SignalAction,
    ) -> Result<bool, AppError> {
        if action == SignalAction::Cancel {
            return Err(AppError::new(
                "SQL Server cannot cancel only a session's running query; Terminate (KILL) ends \
                 the session and rolls back its open transaction",
            ));
        }
        if pid <= 0 || !login_time_ok(backend_start) {
            return Err(AppError::new("that session cannot be identified"));
        }
        let (c, rows) = self.query(&kill_sql(pid, backend_start)).await?;
        Ok(rows
            .first()
            .is_some_and(|row| pg::cell(&c, row, "signalled") == Some("t")))
    }
}

/// Map the counter row and the histogram onto the neutral sample. A page lookup
/// includes the page reads it caused, so hits are the difference.
pub(crate) fn parse_sample(
    columns: &[String],
    row: &[Option<String>],
    hist_columns: &[String],
    hist_rows: &[Row],
) -> Result<FastSample, AppError> {
    let i = |name: &str| pg::int(columns, row, name);
    let reads = i("reads")?;
    let counters = Counters {
        xact_commit: i("xact_commit")?,
        xact_rollback: 0,
        blks_read: reads,
        blks_hit: (i("lookups")? - reads).max(0),
        tup_returned: 0,
        tup_fetched: 0,
        tup_inserted: 0,
        tup_updated: 0,
        tup_deleted: 0,
        temp_bytes: 0,
        temp_files: i("workfiles")?,
        deadlocks: i("deadlocks")?,
        conflicts: 0,
        checkpoints_timed: 0,
        checkpoints_requested: 0,
        buffers_checkpoint: i("checkpoint_pages")?,
        buffers_clean: i("lazy_writes")?,
        buffers_backend: None,
        wal_bytes: pg::opt_int(columns, row, "log_flushed")?,
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
        replication_lag_ms: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::script::{parse_for_engine, Item, TransactionEngine};

    fn cols(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn versions_read_the_major_and_minor() {
        assert_eq!(version_num("16.0.4135.4"), 160_000);
        assert_eq!(version_num("13.0.5026.0"), 130_000);
        assert_eq!(version_num(""), 0);
    }

    #[test]
    fn every_read_is_one_tsql_statement() {
        for sql in [
            status_sql(),
            histogram_sql(),
            activity_sql(),
            PROBE_SQL.to_string(),
        ] {
            let items = parse_for_engine(&sql, TransactionEngine::MsSql)
                .unwrap_or_else(|e| panic!("{sql}: {}", e.message));
            assert!(matches!(items.as_slice(), [Item::Sql(_)]), "{sql}");
        }
        assert!(activity_sql().contains("CONCAT('{', r.blocking_session_id, '}')"));
    }

    #[test]
    fn kill_names_the_session_by_spid_and_login_time() {
        assert!(login_time_ok("2026-10-20 12:34:56.789"));
        assert!(login_time_ok("2026-10-20 12:34:56"));
        assert!(!login_time_ok("2026-10-20'; DROP TABLE x--"));
        assert!(!login_time_ok(""));
        let sql = kill_sql(57, "2026-10-20 12:34:56.789");
        assert!(sql.contains("session_id = 57"));
        assert!(sql.contains("KILL 57;"));
        assert!(sql.contains("= '2026-10-20 12:34:56.789'"));
    }

    #[test]
    fn the_sample_maps_counters_onto_the_neutral_model() {
        let c = cols(&[
            "xact_commit",
            "lookups",
            "reads",
            "log_flushed",
            "deadlocks",
            "checkpoint_pages",
            "lazy_writes",
            "workfiles",
            "server_ms",
            "max_connections",
            "oldest_xact_ms",
            "blocked",
        ]);
        let v = |s: &str| Some(s.to_string());
        let row = vec![
            v("500"),
            v("10000"),
            v("100"),
            v("65536"),
            v("1"),
            v("20"),
            v("3"),
            v("4"),
            v("1729400000000"),
            v("32767"),
            None,
            v("1"),
        ];
        let hc = cols(&["state", "wait", "client", "n"]);
        let hr = vec![
            vec![v("active"), None, v("t"), v("1")],
            vec![v("active"), v("Lock"), v("t"), v("1")],
            vec![v("idle"), v("Client"), v("t"), v("6")],
        ];
        let s = parse_sample(&c, &row, &hc, &hr).unwrap();
        assert_eq!(s.counters.xact_commit, 500);
        assert_eq!(s.counters.blks_hit, 9900);
        assert_eq!(s.counters.blks_read, 100);
        assert_eq!(s.counters.wal_bytes, Some(65_536));
        assert_eq!(s.counters.buffers_clean, 3);
        assert_eq!(s.oldest_xact_ms, None);
        assert_eq!(s.sessions.total, 8);
        assert_eq!(s.sessions.active, 2);
        assert_eq!(s.load[0], 1);
        assert_eq!(s.load[1], 1);
        assert_eq!(s.sessions.max_connections, 32_767);
    }
}
