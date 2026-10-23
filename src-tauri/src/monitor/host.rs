//! Host metrics for a PostgreSQL server through EnterpriseDB's `system_stats`
//! extension (what pgAdmin uses): CPU, memory, load, disk and network of the machine
//! (or container) PostgreSQL runs on. PostgreSQL itself exposes none of this.
//!
//! The extension is optional and is found once per session (its schema, and whether
//! the monitor's role may execute it). `pg_sys_cpu_usage_info()` samples the CPU for
//! about 150 ms inside the call, so host metrics are their own tier every 5 seconds
//! rather than part of the per-tick fast tier. Disk and network counters are
//! cumulative; `HostTracker` turns them into per-second rates.

use std::time::Duration;

use serde::Serialize;

use super::pg::{self, Row};
use crate::db::{self, AppError};

/// Finds the extension and whether this role may run it. A bare bool (`t`/`f`).
pub(crate) const PROBE_SQL: &str = "SELECT n.nspname AS schema, \
       has_function_privilege(p.oid, 'EXECUTE') AS can_run \
  FROM pg_extension e \
  JOIN pg_namespace n ON n.oid = e.extnamespace \
  JOIN pg_proc p ON p.proname = 'pg_sys_cpu_usage_info' AND p.pronamespace = e.extnamespace \
 WHERE e.extname = 'system_stats' \
 LIMIT 1";

pub(crate) const NOT_INSTALLED: &str = "Host CPU, memory, disk and network come from the \
system_stats extension (EnterpriseDB), which is not installed in this database.";
pub(crate) const NOT_PERMITTED: &str = "system_stats is installed, but this role may not run \
it: grant it monitor_system_stats (or connect as a superuser).";

/// One row: CPU busy and I/O-wait shares, memory, the 1-minute load, and cumulative
/// bytes read/written by physical disks and received/sent by non-loopback
/// interfaces. Partitions, RAM disks, loop, device-mapper and md devices are left out
/// so no byte is counted twice. On Windows hosts the extension reports
/// `processor_time_percent` instead of an idle share.
pub(crate) fn host_sql(schema: &str) -> String {
    let s = db::ident(schema);
    format!(
        "SELECT c.cpu_busy, c.iowait, m.total_memory, m.used_memory, m.cache_total, m.swap_used, \
                l.load1, d.read_bytes, d.write_bytes, n.rx_bytes, n.tx_bytes \
           FROM (SELECT coalesce(100 - idle_mode_percent, processor_time_percent) AS cpu_busy, \
                        io_completion_percent AS iowait \
                   FROM {s}.pg_sys_cpu_usage_info()) c, \
                (SELECT total_memory, used_memory, cache_total, swap_used \
                   FROM {s}.pg_sys_memory_info()) m, \
                (SELECT load_avg_one_minute AS load1 FROM {s}.pg_sys_load_avg_info()) l, \
                (SELECT sum(read_bytes) AS read_bytes, sum(write_bytes) AS write_bytes \
                   FROM {s}.pg_sys_io_analysis_info() \
                  WHERE device_name !~ '^(ram|loop|dm-|md|sr|zram)' \
                    AND device_name !~ '^(sd|vd|xvd|hd)[a-z]+[0-9]+$' \
                    AND device_name !~ '^(nvme[0-9]+n[0-9]+|mmcblk[0-9]+)p[0-9]+$') d, \
                (SELECT sum(rx_bytes) AS rx_bytes, sum(tx_bytes) AS tx_bytes \
                   FROM {s}.pg_sys_network_info() WHERE interface_name <> 'lo') n"
    )
}

/// What the Overview's host tiles and chart draw.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Host {
    /// Share of CPU time not idle, 0–100.
    pub cpu_busy_pct: Option<f64>,
    /// Share spent waiting on I/O, 0–100 (Linux).
    pub cpu_iowait_pct: Option<f64>,
    pub mem_total: Option<i64>,
    /// In use by processes: used minus the page cache.
    pub mem_used: Option<i64>,
    pub mem_cache: Option<i64>,
    pub swap_used: Option<i64>,
    pub load1: Option<f64>,
    /// Bytes per second; `None` on the first reading or after a counter reset.
    pub disk_read: Option<f64>,
    pub disk_write: Option<f64>,
    pub net_rx: Option<f64>,
    pub net_tx: Option<f64>,
}

fn num(columns: &[String], row: &[Option<String>], name: &str) -> Option<f64> {
    pg::cell(columns, row, name)
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite())
}

/// Cumulative disk and network counters → per-second rates.
#[derive(Default)]
pub(crate) struct HostTracker {
    last: Option<([Option<f64>; 4], Duration)>,
}

impl HostTracker {
    pub(crate) fn clear(&mut self) {
        self.last = None;
    }

    pub(crate) fn ingest(
        &mut self,
        columns: &[String],
        rows: &[Row],
        at: Duration,
    ) -> Result<Host, AppError> {
        let [row] = rows else {
            return Err(AppError::new("system_stats returned no row"));
        };
        let n = |name: &str| num(columns, row, name);
        let counters = [
            n("read_bytes"),
            n("write_bytes"),
            n("rx_bytes"),
            n("tx_bytes"),
        ];
        let mut rates = [None; 4];
        if let Some((prev, then)) = self.last {
            let dt = at.saturating_sub(then).as_secs_f64();
            if dt > 0.0 {
                for (i, rate) in rates.iter_mut().enumerate() {
                    if let (Some(now), Some(before)) = (counters[i], prev[i]) {
                        // A counter going down (device gone, host rebooted) is no rate.
                        if now >= before {
                            *rate = Some((now - before) / dt);
                        }
                    }
                }
            }
        }
        self.last = Some((counters, at));
        let int = |name: &str| n(name).map(|v| v as i64);
        let used = int("used_memory");
        let cache = int("cache_total");
        Ok(Host {
            cpu_busy_pct: n("cpu_busy").map(|v| v.clamp(0.0, 100.0)),
            cpu_iowait_pct: n("iowait").map(|v| v.clamp(0.0, 100.0)),
            mem_total: int("total_memory"),
            mem_used: used.map(|u| (u - cache.unwrap_or(0)).max(0)),
            mem_cache: cache,
            swap_used: int("swap_used"),
            load1: n("load1"),
            disk_read: rates[0],
            disk_write: rates[1],
            net_rx: rates[2],
            net_tx: rates[3],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::script::{parse_for_engine, TransactionEngine};

    fn cols() -> Vec<String> {
        [
            "cpu_busy",
            "iowait",
            "total_memory",
            "used_memory",
            "cache_total",
            "swap_used",
            "load1",
            "read_bytes",
            "write_bytes",
            "rx_bytes",
            "tx_bytes",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    fn row(read: i64, rx: i64) -> Row {
        [
            "37.5",
            "2",
            "1000",
            "600",
            "250",
            "0",
            "1.25",
            &read.to_string(),
            "0",
            &rx.to_string(),
            "10",
        ]
        .iter()
        .map(|s| Some(s.to_string()))
        .collect()
    }

    #[test]
    fn the_host_query_is_one_statement_with_a_quoted_schema() {
        let sql = host_sql("my schema");
        assert!(sql.contains("\"my schema\".pg_sys_cpu_usage_info()"));
        assert_eq!(
            parse_for_engine(&sql, TransactionEngine::Postgres)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            parse_for_engine(PROBE_SQL, TransactionEngine::Postgres)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn counters_become_rates_and_memory_excludes_the_cache() {
        let mut t = HostTracker::default();
        let first = t
            .ingest(&cols(), &[row(1000, 500)], Duration::from_secs(5))
            .unwrap();
        assert_eq!(first.disk_read, None, "the first reading is a baseline");
        assert_eq!(first.cpu_busy_pct, Some(37.5));
        assert_eq!(first.mem_used, Some(350), "used minus cache");
        assert_eq!(first.load1, Some(1.25));
        let next = t
            .ingest(&cols(), &[row(6000, 1500)], Duration::from_secs(10))
            .unwrap();
        assert_eq!(next.disk_read, Some(1000.0));
        assert_eq!(next.net_rx, Some(200.0));
        assert_eq!(next.net_tx, Some(0.0));
        let reset = t
            .ingest(&cols(), &[row(10, 1600)], Duration::from_secs(15))
            .unwrap();
        assert_eq!(reset.disk_read, None, "a counter going down is no rate");
        assert_eq!(reset.net_rx, Some(20.0));
        t.clear();
        let after = t
            .ingest(&cols(), &[row(20, 1700)], Duration::from_secs(20))
            .unwrap();
        assert_eq!(after.net_rx, None);
        assert!(t.ingest(&cols(), &[], Duration::from_secs(25)).is_err());
    }
}
