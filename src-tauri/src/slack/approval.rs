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
        self.proposals.lock().unwrap().insert(p.id.clone(), p);
    }

    /// Consume a proposal (approve/reject path).
    pub fn take(&self, id: &str) -> Option<PendingProposal> {
        self.proposals.lock().unwrap().remove(id)
    }

    /// The requester of a pending proposal, without consuming it (ownership check).
    pub fn owner(&self, id: &str) -> Option<String> {
        self.proposals.lock().unwrap().get(id).map(|p| p.user.clone())
    }

    /// Remove and return proposals older than the TTL (their cards get an "expired" update).
    pub fn expire(&self) -> Vec<PendingProposal> {
        let mut map = self.proposals.lock().unwrap();
        let dead: Vec<String> = map
            .iter()
            .filter(|(_, p)| p.created.elapsed() > PROPOSAL_TTL)
            .map(|(k, _)| k.clone())
            .collect();
        dead.into_iter().filter_map(|k| map.remove(&k)).collect()
    }

    pub fn clear(&self) {
        self.proposals.lock().unwrap().clear();
    }
}

/// A finished result kept around so its "Export as…" buttons can format it on
/// demand without re-running the query. Shared via `Arc` so neither storing it nor
/// exporting it deep-copies the (potentially 10k-row) data.
pub struct StoredResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub created: Instant,
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
    ) -> (String, Arc<StoredResult>) {
        let id = format!("res-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let stored = Arc::new(StoredResult { columns, rows, created: Instant::now() });
        let mut map = self.results.lock().unwrap();
        map.retain(|_, r| r.created.elapsed() <= RESULT_TTL);
        while map.len() >= RESULT_CAP {
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
        (id, stored)
    }

    /// Share out a stored result (None = expired/evicted/unknown) — refcount bump, no copy.
    pub fn get(&self, id: &str) -> Option<Arc<StoredResult>> {
        let map = self.results.lock().unwrap();
        let r = map.get(id)?;
        if r.created.elapsed() > RESULT_TTL {
            return None;
        }
        Some(r.clone())
    }

    pub fn clear(&self) {
        self.results.lock().unwrap().clear();
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
            created: Instant::now(),
        }
    }

    #[test]
    fn take_consumes() {
        let s = ApprovalStore::default();
        let prop = p(&s, "U1");
        let id = prop.id.clone();
        s.insert(prop);
        assert_eq!(s.owner(&id).as_deref(), Some("U1"));
        assert!(s.take(&id).is_some());
        assert!(s.take(&id).is_none());
    }

    #[test]
    fn result_store_caps_and_expires() {
        let s = ResultStore::default();
        let cols = vec!["a".to_string()];
        let row = vec![vec![Some("1".to_string())]];
        let (first, _) = s.insert(cols.clone(), row.clone());
        for _ in 0..10 {
            s.insert(cols.clone(), row.clone());
        }
        // Cap evicted the oldest entries; the most recent one is retrievable.
        assert!(s.get(&first).is_none());
        let (last, _) = s.insert(cols.clone(), row.clone());
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
        assert!(s.owner(&id).is_none());
    }
}
