//! Counter deltas → per-second rates. Pure, so the reset and skipped-tick rules are
//! unit-tested without a server.
//!
//! Every counter the fast tier reads is cumulative. A rate is the delta over the
//! monotonic time between two samples; a counter that goes BACKWARDS (a stats reset,
//! a server restart, a failover, a dropped database leaving the sums) is not a
//! negative spike but a new baseline, reported as `Ingest::Reset` so the chart draws
//! a break instead of a cliff. `stats_reset` moving is a reset too, even when the
//! activity since then has already carried every sum back above the old value.

use serde::Serialize;
use std::time::Duration;

/// One fast-tier reading of the cumulative counters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct Counters {
    pub xact_commit: i64,
    pub xact_rollback: i64,
    pub blks_read: i64,
    pub blks_hit: i64,
    pub tup_returned: i64,
    pub tup_fetched: i64,
    pub tup_inserted: i64,
    pub tup_updated: i64,
    pub tup_deleted: i64,
    pub temp_bytes: i64,
    /// Bytes since `0/0`: the write position on a primary, the replay position on a
    /// standby. `None` when the server reports no position (a standby before replay).
    pub wal_bytes: Option<i64>,
    /// Full-page images written (`pg_stat_wal.wal_fpi`, PostgreSQL 14+).
    pub wal_fpi: Option<i64>,
    /// The newest `pg_stat_database.stats_reset`, in epoch milliseconds.
    pub stats_reset_ms: Option<i64>,
}

impl Counters {
    fn fields(&self) -> [i64; 10] {
        [
            self.xact_commit,
            self.xact_rollback,
            self.blks_read,
            self.blks_hit,
            self.tup_returned,
            self.tup_fetched,
            self.tup_inserted,
            self.tup_updated,
            self.tup_deleted,
            self.temp_bytes,
        ]
    }

    /// True when this reading cannot be diffed against `earlier`: a counter went
    /// down, or the server says its statistics were reset in between.
    fn discontinuous(&self, earlier: &Counters) -> bool {
        let back = |now: Option<i64>, then: Option<i64>| matches!((now, then), (Some(n), Some(t)) if n < t);
        back(self.wal_bytes, earlier.wal_bytes)
            || back(self.wal_fpi, earlier.wal_fpi)
            || self.stats_reset_ms != earlier.stats_reset_ms
            || self
                .fields()
                .iter()
                .zip(earlier.fields())
                .any(|(now, then)| *now < then)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Rates {
    /// Commits + rollbacks per second.
    pub tps: f64,
    pub commits: f64,
    pub rollbacks: f64,
    pub blks_read: f64,
    pub blks_hit: f64,
    /// Hit share over THIS interval (not lifetime, which hides incidents); `None`
    /// when no block was touched.
    pub cache_hit: Option<f64>,
    pub tup_returned: f64,
    pub tup_fetched: f64,
    pub tup_inserted: f64,
    pub tup_updated: f64,
    pub tup_deleted: f64,
    pub temp_bytes: f64,
    pub wal_bytes: Option<f64>,
    pub wal_fpi: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Ingest {
    /// The first reading after start, a resume or a reconnect: nothing to diff yet.
    Baseline,
    /// The counters are discontinuous; this reading is the new baseline.
    Reset,
    Rates(Rates),
}

#[derive(Default)]
pub(crate) struct RateTracker {
    last: Option<(Counters, Duration)>,
}

impl RateTracker {
    /// Diff `counters`, read at monotonic time `at`, against the previous reading.
    pub(crate) fn ingest(&mut self, counters: Counters, at: Duration) -> Ingest {
        let previous = self.last.replace((counters, at));
        let Some((then, then_at)) = previous else {
            return Ingest::Baseline;
        };
        if counters.discontinuous(&then) {
            return Ingest::Reset;
        }
        let dt = at.saturating_sub(then_at).as_secs_f64();
        if dt <= 0.0 {
            // Two readings at the same instant carry no rate; keep the older baseline
            // so the next interval is measured from it.
            self.last = Some((then, then_at));
            return Ingest::Baseline;
        }
        let per = |now: i64, before: i64| (now - before) as f64 / dt;
        let per_opt = |now: Option<i64>, before: Option<i64>| match (now, before) {
            (Some(n), Some(b)) => Some((n - b) as f64 / dt),
            _ => None,
        };
        let commits = per(counters.xact_commit, then.xact_commit);
        let rollbacks = per(counters.xact_rollback, then.xact_rollback);
        let d_hit = counters.blks_hit - then.blks_hit;
        let d_read = counters.blks_read - then.blks_read;
        let touched = d_hit + d_read;
        Ingest::Rates(Rates {
            tps: commits + rollbacks,
            commits,
            rollbacks,
            blks_read: d_read as f64 / dt,
            blks_hit: d_hit as f64 / dt,
            cache_hit: (touched > 0).then(|| d_hit as f64 / touched as f64),
            tup_returned: per(counters.tup_returned, then.tup_returned),
            tup_fetched: per(counters.tup_fetched, then.tup_fetched),
            tup_inserted: per(counters.tup_inserted, then.tup_inserted),
            tup_updated: per(counters.tup_updated, then.tup_updated),
            tup_deleted: per(counters.tup_deleted, then.tup_deleted),
            temp_bytes: per(counters.temp_bytes, then.temp_bytes),
            wal_bytes: per_opt(counters.wal_bytes, then.wal_bytes),
            wal_fpi: per_opt(counters.wal_fpi, then.wal_fpi),
        })
    }

    /// Forget the baseline (after a reconnect or a pause: the next reading must not
    /// be diffed across a stretch nobody sampled).
    pub(crate) fn clear(&mut self) {
        self.last = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ms: u64) -> Duration {
        Duration::from_millis(ms)
    }

    fn counters(commit: i64, hit: i64, read: i64, wal: Option<i64>) -> Counters {
        Counters {
            xact_commit: commit,
            blks_hit: hit,
            blks_read: read,
            wal_bytes: wal,
            ..Counters::default()
        }
    }

    fn rates(ingest: Ingest) -> Rates {
        match ingest {
            Ingest::Rates(r) => r,
            other => panic!("expected rates, got {other:?}"),
        }
    }

    #[test]
    fn first_reading_is_a_baseline() {
        let mut t = RateTracker::default();
        assert_eq!(t.ingest(counters(10, 0, 0, None), at(0)), Ingest::Baseline);
    }

    #[test]
    fn rates_are_deltas_over_elapsed_time() {
        let mut t = RateTracker::default();
        t.ingest(counters(100, 1_000, 0, Some(5_000)), at(0));
        let r = rates(t.ingest(counters(300, 1_900, 100, Some(9_000)), at(2_000)));
        assert_eq!(r.commits, 100.0);
        assert_eq!(r.tps, 100.0);
        assert_eq!(r.blks_hit, 450.0);
        assert_eq!(r.blks_read, 50.0);
        assert_eq!(r.cache_hit, Some(0.9));
        assert_eq!(r.wal_bytes, Some(2_000.0));
        assert_eq!(r.wal_fpi, None, "no pg_stat_wal before PostgreSQL 14");
    }

    #[test]
    fn every_counter_gets_its_own_rate() {
        let mut t = RateTracker::default();
        let base = Counters {
            xact_commit: 10,
            xact_rollback: 2,
            tup_returned: 100,
            tup_fetched: 50,
            tup_inserted: 5,
            tup_updated: 4,
            tup_deleted: 3,
            temp_bytes: 1_000,
            wal_fpi: Some(7),
            ..Counters::default()
        };
        t.ingest(base, at(0));
        let next = Counters {
            xact_commit: 20,
            xact_rollback: 4,
            tup_returned: 300,
            tup_fetched: 150,
            tup_inserted: 15,
            tup_updated: 8,
            tup_deleted: 13,
            temp_bytes: 9_000,
            wal_fpi: Some(17),
            ..base
        };
        let r = rates(t.ingest(next, at(500)));
        assert_eq!(r.commits, 20.0);
        assert_eq!(r.rollbacks, 4.0);
        assert_eq!(r.tps, 24.0);
        assert_eq!(r.tup_returned, 400.0);
        assert_eq!(r.tup_fetched, 200.0);
        assert_eq!(r.tup_inserted, 20.0);
        assert_eq!(r.tup_updated, 8.0);
        assert_eq!(r.tup_deleted, 20.0);
        assert_eq!(r.temp_bytes, 16_000.0);
        assert_eq!(r.wal_fpi, Some(20.0));
    }

    #[test]
    fn a_skipped_tick_divides_by_the_real_interval() {
        // MissedTickBehavior::Skip means the next reading can be 3 s after the last:
        // the rate must be per real second, not per tick.
        let mut t = RateTracker::default();
        t.ingest(counters(0, 0, 0, None), at(1_000));
        let r = rates(t.ingest(counters(60, 0, 0, None), at(4_000)));
        assert_eq!(r.tps, 20.0);
        assert_eq!(r.cache_hit, None, "no block touched → no ratio");
        assert_eq!(r.wal_bytes, None);
    }

    #[test]
    fn a_counter_going_backwards_rebaselines_instead_of_spiking() {
        let mut t = RateTracker::default();
        t.ingest(counters(1_000, 0, 0, Some(10)), at(0));
        assert_eq!(
            t.ingest(counters(5, 0, 0, Some(10)), at(1_000)),
            Ingest::Reset
        );
        // The reset reading is the new baseline.
        let r = rates(t.ingest(counters(15, 0, 0, Some(10)), at(2_000)));
        assert_eq!(r.tps, 10.0);
        // WAL moving backwards (failover to a server behind us) is a reset too.
        assert_eq!(
            t.ingest(counters(20, 0, 0, Some(1)), at(3_000)),
            Ingest::Reset
        );
        // And so is a full-page-image counter reset (pg_stat_reset_shared('wal')).
        let mut t = RateTracker::default();
        t.ingest(
            Counters {
                wal_fpi: Some(50),
                ..Counters::default()
            },
            at(0),
        );
        assert_eq!(
            t.ingest(
                Counters {
                    wal_fpi: Some(2),
                    ..Counters::default()
                },
                at(1_000)
            ),
            Ingest::Reset
        );
    }

    #[test]
    fn a_stats_reset_timestamp_change_rebaselines_even_when_sums_grew() {
        // pg_stat_reset() zeroed one database, then a burst carried the sum past the
        // old value before the next tick: only stats_reset tells the truth.
        let mut t = RateTracker::default();
        let before = Counters {
            xact_commit: 1_000,
            stats_reset_ms: None,
            ..Counters::default()
        };
        t.ingest(before, at(0));
        let after = Counters {
            xact_commit: 1_200,
            stats_reset_ms: Some(1_700_000_000_000),
            ..Counters::default()
        };
        assert_eq!(t.ingest(after, at(1_000)), Ingest::Reset);
        let later = Counters {
            xact_commit: 1_300,
            ..after
        };
        assert_eq!(rates(t.ingest(later, at(2_000))).tps, 100.0);
        let reset_again = Counters {
            stats_reset_ms: Some(1_700_000_005_000),
            ..later
        };
        assert_eq!(t.ingest(reset_again, at(3_000)), Ingest::Reset);
    }

    #[test]
    fn clear_drops_the_baseline() {
        let mut t = RateTracker::default();
        t.ingest(counters(1, 0, 0, None), at(0));
        t.clear();
        assert_eq!(
            t.ingest(counters(9, 0, 0, None), at(1_000)),
            Ingest::Baseline
        );
    }

    #[test]
    fn zero_elapsed_time_keeps_the_older_baseline() {
        let mut t = RateTracker::default();
        t.ingest(counters(0, 0, 0, None), at(1_000));
        assert_eq!(
            t.ingest(counters(5, 0, 0, None), at(1_000)),
            Ingest::Baseline
        );
        let r = rates(t.ingest(counters(10, 0, 0, None), at(2_000)));
        assert_eq!(r.tps, 10.0);
    }
}
