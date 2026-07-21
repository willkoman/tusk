//! In-memory stores backing Slack interactions: pending SQL proposals awaiting
//! approval, and recently executed results awaiting export-button clicks. Nothing
//! here is persisted — an app restart drops both (their buttons then answer
//! "expired").

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const PROPOSAL_TTL: Duration = Duration::from_secs(5 * 60);
/// How long a finished result stays exportable via its format buttons.
pub const RESULT_TTL: Duration = Duration::from_secs(15 * 60);
/// Bounded memory: keep at most this many recent results (~10k rows each max).
const RESULT_CAP: usize = 8;
const RESULT_BYTE_CAP: usize = 64 * 1024 * 1024;

pub struct PendingProposal {
    pub id: String,
    pub sql: String,
    pub explanation: String,
    /// The user explicitly asked for a chart — render with these particulars.
    pub chart: Option<super::chart::ChartSpec>,
    pub channel: String,
    /// Slack user ID who asked — the only one allowed to approve/reject.
    pub user: String,
    /// Thread to post results into.
    pub thread_ts: String,
    /// The proposal message ts (for updating its card).
    pub message_ts: String,
    /// Exact Tusk connection/database used to build the proposal context.
    pub connection_id: String,
    pub database: String,
    pub created: Instant,
}

#[derive(Default)]
pub struct ApprovalStore {
    proposals: Mutex<HashMap<String, PendingProposal>>,
    next_id: AtomicU64,
}

impl ApprovalStore {
    pub fn new_id(&self) -> String {
        format!("prop-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
    }

    pub fn insert(&self, p: PendingProposal) {
        crate::lock_sync(&self.proposals).insert(p.id.clone(), p);
    }

    /// Consume a proposal (approve/reject path).
    pub fn take(&self, id: &str) -> Option<PendingProposal> {
        crate::lock_sync(&self.proposals).remove(id)
    }

    /// Requester + channel for authorization. Expiry is enforced here, not only
    /// by the periodic UI sweep (which can be delayed by long sequential work).
    pub fn authorization(&self, id: &str) -> Option<(String, String)> {
        let mut map = crate::lock_sync(&self.proposals);
        if map.get(id).is_some_and(|p| p.created.elapsed() > PROPOSAL_TTL) {
            map.remove(id);
            return None;
        }
        map.get(id).map(|p| (p.user.clone(), p.channel.clone()))
    }

    /// Remove and return proposals older than the TTL (their cards get an "expired" update).
    pub fn expire(&self) -> Vec<PendingProposal> {
        let mut map = crate::lock_sync(&self.proposals);
        let dead: Vec<String> = map
            .iter()
            .filter(|(_, p)| p.created.elapsed() > PROPOSAL_TTL)
            .map(|(k, _)| k.clone())
            .collect();
        dead.into_iter().filter_map(|k| map.remove(&k)).collect()
    }

    pub fn clear(&self) {
        crate::lock_sync(&self.proposals).clear();
    }
}

/// A finished result kept around so its "Export as…" buttons can format it on
/// demand without re-running the query. Shared via `Arc` so neither storing it nor
/// exporting it deep-copies the (potentially 10k-row) data.
pub struct StoredResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub created: Instant,
    estimated_bytes: usize,
}

#[derive(Default)]
pub struct ResultStore {
    results: Mutex<HashMap<String, Arc<StoredResult>>>,
    next_id: AtomicU64,
}

impl ResultStore {
    /// Store a result; evicts expired entries and, beyond the cap, the oldest.
    /// Returns the id AND the shared handle (so the caller reads the data back
    /// without a second copy — the columns/rows were moved in).
    pub fn insert(
        &self,
        columns: Vec<String>,
        rows: Vec<Vec<Option<String>>>,
    ) -> Option<(String, Arc<StoredResult>)> {
        let id = format!("res-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let estimated_bytes = columns.iter().map(|s| s.len()).sum::<usize>()
            .saturating_add(rows.len().saturating_mul(std::mem::size_of::<Vec<Option<String>>>()));
        let estimated_bytes = rows.iter().flatten().fold(estimated_bytes, |n, cell| {
            n.saturating_add(std::mem::size_of::<Option<String>>())
                .saturating_add(cell.as_ref().map_or(0, String::len))
        });
        if estimated_bytes > RESULT_BYTE_CAP {
            return None;
        }
        let stored = Arc::new(StoredResult { columns, rows, created: Instant::now(), estimated_bytes });
        let mut map = crate::lock_sync(&self.results);
        map.retain(|_, r| r.created.elapsed() <= RESULT_TTL);
        while map.len() >= RESULT_CAP
            || map.values().map(|r| r.estimated_bytes).sum::<usize>().saturating_add(estimated_bytes) > RESULT_BYTE_CAP
        {
            let oldest = map
                .iter()
                .max_by_key(|(_, r)| r.created.elapsed())
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => map.remove(&k),
                None => break,
            };
        }
        map.insert(id.clone(), stored.clone());
        Some((id, stored))
    }

    /// Share out a stored result (None = expired/evicted/unknown) — refcount bump, no copy.
    pub fn get(&self, id: &str) -> Option<Arc<StoredResult>> {
        let map = crate::lock_sync(&self.results);
        let r = map.get(id)?;
        if r.created.elapsed() > RESULT_TTL {
            return None;
        }
        Some(r.clone())
    }

    pub fn clear(&self) {
        crate::lock_sync(&self.results).clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(store: &ApprovalStore, user: &str) -> PendingProposal {
        PendingProposal {
            id: store.new_id(),
            sql: "SELECT 1".into(),
            explanation: "e".into(),
            chart: None,
            channel: "C1".into(),
            user: user.into(),
            thread_ts: "1.0".into(),
            message_ts: "1.1".into(),
            connection_id: "conn-1".into(),
            database: "db".into(),
            created: Instant::now(),
        }
    }

    #[test]
    fn take_consumes() {
        let s = ApprovalStore::default();
        let prop = p(&s, "U1");
        let id = prop.id.clone();
        s.insert(prop);
        assert_eq!(s.authorization(&id), Some(("U1".into(), "C1".into())));
        assert!(s.take(&id).is_some());
        assert!(s.take(&id).is_none());
    }

    #[test]
    fn authorization_enforces_ttl_without_waiting_for_sweep() {
        let s = ApprovalStore::default();
        let mut prop = p(&s, "U1");
        let id = prop.id.clone();
        prop.created = Instant::now() - PROPOSAL_TTL - Duration::from_secs(1);
        s.insert(prop);
        assert!(s.authorization(&id).is_none());
        assert!(s.take(&id).is_none());
    }

    #[test]
    fn result_store_caps_and_expires() {
        let s = ResultStore::default();
        let cols = vec!["a".to_string()];
        let row = vec![vec![Some("1".to_string())]];
        let (first, _) = s.insert(cols.clone(), row.clone()).unwrap();
        for _ in 0..10 {
            s.insert(cols.clone(), row.clone());
        }
        // Cap evicted the oldest entries; the most recent one is retrievable.
        assert!(s.get(&first).is_none());
        let (last, _) = s.insert(cols.clone(), row.clone()).unwrap();
        assert!(s.get(&last).is_some());
        assert!(s.get("res-nope").is_none());
    }

    #[test]
    fn expire_removes_old() {
        let s = ApprovalStore::default();
        let mut prop = p(&s, "U1");
        prop.created = Instant::now() - PROPOSAL_TTL - Duration::from_secs(1);
        let id = prop.id.clone();
        s.insert(prop);
        s.insert(p(&s, "U2")); // fresh one stays
        let dead = s.expire();
        assert_eq!(dead.len(), 1);
        assert_eq!(dead[0].id, id);
        assert!(s.authorization(&id).is_none());
    }
}
