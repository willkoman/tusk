//! In-memory stores backing Slack interactions: pending SQL proposals awaiting
//! approval, and recently executed results awaiting export-button clicks. Nothing
//! here is persisted — an app restart drops both (their buttons then answer
//! "expired").

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const PROPOSAL_TTL: Duration = Duration::from_secs(5 * 60);
/// How long a finished result stays exportable via its format buttons.
pub const RESULT_TTL: Duration = Duration::from_secs(15 * 60);
/// Bounded memory: keep at most this many recent results (~10k rows each max).
const RESULT_CAP: usize = 8;
const RESULT_BYTE_CAP: usize = 64 * 1024 * 1024;
const PROPOSAL_CAP: usize = 64;
const PROPOSAL_BYTE_CAP: usize = 4 * 1024 * 1024;
const PROPOSAL_ITEM_BYTE_CAP: usize = 512 * 1024;

/// 128-bit OS-random capability. Rustls' ring provider is already a direct runtime
/// dependency and exposes its CSPRNG without another crate.
fn random_id(prefix: &str) -> Result<String, crate::db::AppError> {
    let mut random = [0u8; 16];
    rustls::crypto::ring::default_provider()
        .secure_random
        .fill(&mut random)
        .map_err(|_| {
            crate::db::AppError::new("secure randomness unavailable for Slack action id")
        })?;
    let mut id = String::with_capacity(prefix.len() + 1 + random.len() * 2);
    id.push_str(prefix);
    id.push('-');
    for byte in random {
        use std::fmt::Write;
        write!(&mut id, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(id)
}

pub struct PendingProposal {
    pub id: String,
    pub sql: String,
    pub explanation: String,
    /// The user explicitly asked for a chart — render with these particulars.
    pub chart: Option<super::chart::ChartSpec>,
    /// Slack workspace/team id. Channel ids are only unique inside a workspace.
    pub workspace: String,
    pub channel: String,
    /// Slack user ID who asked — the only one allowed to approve/reject.
    pub user: String,
    /// Thread to post results into.
    pub thread_ts: String,
    /// The proposal message ts (for updating its card).
    pub message_ts: String,
    /// Original user message that caused this proposal.
    pub request_message_ts: String,
    /// Exact Tusk connection/database used to build the proposal context.
    pub connection_id: String,
    pub database: String,
    pub dialect: String,
    pub created: Instant,
}

pub struct ApprovalStore {
    proposals: Mutex<HashMap<String, PendingProposal>>,
}

impl Default for ApprovalStore {
    fn default() -> Self {
        Self {
            proposals: Mutex::new(HashMap::new()),
        }
    }
}

pub enum ProposalTake {
    Found(Box<PendingProposal>),
    Missing,
    Unauthorized,
    SourceMismatch,
}

impl ApprovalStore {
    pub fn new_id(&self) -> Result<String, crate::db::AppError> {
        random_id("prop")
    }

    pub fn insert(&self, p: PendingProposal) -> Result<(), crate::db::AppError> {
        let bytes = proposal_bytes(&p);
        if bytes > PROPOSAL_ITEM_BYTE_CAP {
            return Err(crate::db::AppError::new(
                "Slack proposal exceeds the 512 KiB pending-item limit",
            ));
        }
        let mut map = crate::lock_sync(&self.proposals);
        let current_bytes = map
            .values()
            .fold(0usize, |n, old| n.saturating_add(proposal_bytes(old)));
        if map.len() >= PROPOSAL_CAP || current_bytes.saturating_add(bytes) > PROPOSAL_BYTE_CAP {
            return Err(crate::db::AppError::new(
                "too many Slack proposals are awaiting approval; approve/reject one or wait for expiry",
            ));
        }
        map.insert(p.id.clone(), p);
        Ok(())
    }

    /// Consume a proposal (approve/reject path).
    pub fn take(&self, id: &str) -> Option<PendingProposal> {
        crate::lock_sync(&self.proposals).remove(id)
    }

    /// Validate every Slack source coordinate and consume atomically. Expiry is
    /// enforced here, not only by the periodic UI sweep.
    pub fn take_for_interaction(
        &self,
        id: &str,
        workspace: &str,
        channel: &str,
        thread_ts: &str,
        message_ts: &str,
        user: &str,
    ) -> ProposalTake {
        let mut map = crate::lock_sync(&self.proposals);
        if map
            .get(id)
            .is_some_and(|p| p.created.elapsed() > PROPOSAL_TTL)
        {
            map.remove(id);
            return ProposalTake::Missing;
        }
        let Some(p) = map.get(id) else {
            return ProposalTake::Missing;
        };
        if p.user != user {
            return ProposalTake::Unauthorized;
        }
        if p.workspace != workspace
            || p.channel != channel
            || p.thread_ts != thread_ts
            || p.message_ts != message_ts
        {
            return ProposalTake::SourceMismatch;
        }
        ProposalTake::Found(Box::new(map.remove(id).expect("proposal checked above")))
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

fn proposal_bytes(p: &PendingProposal) -> usize {
    let strings = [
        &p.id,
        &p.sql,
        &p.explanation,
        &p.workspace,
        &p.channel,
        &p.user,
        &p.thread_ts,
        &p.message_ts,
        &p.request_message_ts,
        &p.connection_id,
        &p.database,
        &p.dialect,
    ]
    .into_iter()
    .fold(std::mem::size_of::<PendingProposal>(), |n, s| {
        n.saturating_add(s.len())
    });
    p.chart.as_ref().map_or(strings, |chart| {
        let fields = chart.kind.len()
            + chart.x.as_ref().map_or(0, String::len)
            + chart.series.iter().map(String::len).sum::<usize>()
            + chart.title.as_ref().map_or(0, String::len)
            + chart.x_label.as_ref().map_or(0, String::len)
            + chart.y_label.as_ref().map_or(0, String::len)
            + serde_json::to_vec(&chart.extra).map_or(0, |v| v.len());
        strings.saturating_add(fields)
    })
}

/// A finished result kept around so its "Export as…" buttons can format it on
/// demand without re-running the query. Shared via `Arc` so neither storing it nor
/// exporting it deep-copies the (potentially 10k-row) data.
pub struct StoredResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub dialect: String,
    pub label: String,
    pub created: Instant,
    estimated_bytes: usize,
    workspace: String,
    channel: String,
    thread_ts: String,
    requester: String,
    source_messages: Mutex<HashSet<String>>,
}

pub struct ResultStore {
    results: Mutex<HashMap<String, Arc<StoredResult>>>,
}

impl Default for ResultStore {
    fn default() -> Self {
        Self {
            results: Mutex::new(HashMap::new()),
        }
    }
}

pub struct ResultBinding {
    pub workspace: String,
    pub channel: String,
    pub thread_ts: String,
    pub requester: String,
    pub dialect: String,
    /// Sanitized filename stem for export attachments (first queried table, or "result").
    pub label: String,
}

pub enum ResultAccess {
    Found(Arc<StoredResult>),
    Missing,
    Unauthorized,
    SourceMismatch,
}

impl ResultStore {
    /// Store a result; evicts expired entries and, beyond the cap, the oldest.
    /// Returns the id AND the shared handle (so the caller reads the data back
    /// without a second copy — the columns/rows were moved in).
    pub fn insert(
        &self,
        binding: ResultBinding,
        columns: Vec<String>,
        rows: Vec<Vec<Option<String>>>,
    ) -> Option<(String, Arc<StoredResult>)> {
        let id = random_id("res").ok()?;
        let estimated_bytes = columns
            .iter()
            .map(|s| s.len())
            .sum::<usize>()
            .saturating_add(binding.workspace.len())
            .saturating_add(binding.channel.len())
            .saturating_add(binding.thread_ts.len())
            .saturating_add(binding.requester.len())
            .saturating_add(binding.dialect.len())
            .saturating_add(binding.label.len())
            .saturating_add(
                rows.len()
                    .saturating_mul(std::mem::size_of::<Vec<Option<String>>>()),
            );
        let estimated_bytes = rows.iter().flatten().fold(estimated_bytes, |n, cell| {
            n.saturating_add(std::mem::size_of::<Option<String>>())
                .saturating_add(cell.as_ref().map_or(0, String::len))
        });
        if estimated_bytes > RESULT_BYTE_CAP {
            return None;
        }
        let stored = Arc::new(StoredResult {
            columns,
            rows,
            dialect: binding.dialect,
            label: binding.label,
            created: Instant::now(),
            estimated_bytes,
            workspace: binding.workspace,
            channel: binding.channel,
            thread_ts: binding.thread_ts,
            requester: binding.requester,
            source_messages: Mutex::new(HashSet::new()),
        });
        let mut map = crate::lock_sync(&self.results);
        map.retain(|_, r| r.created.elapsed() <= RESULT_TTL);
        while map.len() >= RESULT_CAP
            || map
                .values()
                .map(|r| r.estimated_bytes)
                .sum::<usize>()
                .saturating_add(estimated_bytes)
                > RESULT_BYTE_CAP
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

    /// Register the exact Slack message containing export buttons.
    pub fn bind_message(&self, id: &str, message_ts: &str) -> bool {
        if message_ts.is_empty() {
            return false;
        }
        let map = crate::lock_sync(&self.results);
        let Some(r) = map.get(id) else { return false };
        crate::lock_sync(&r.source_messages).insert(message_ts.to_string());
        true
    }

    pub fn access(
        &self,
        id: &str,
        workspace: &str,
        channel: &str,
        thread_ts: &str,
        message_ts: &str,
        user: &str,
    ) -> ResultAccess {
        let mut map = crate::lock_sync(&self.results);
        if map
            .get(id)
            .is_some_and(|r| r.created.elapsed() > RESULT_TTL)
        {
            map.remove(id);
            return ResultAccess::Missing;
        }
        let Some(r) = map.get(id) else {
            return ResultAccess::Missing;
        };
        if r.requester != user {
            return ResultAccess::Unauthorized;
        }
        if r.workspace != workspace
            || r.channel != channel
            || r.thread_ts != thread_ts
            || !crate::lock_sync(&r.source_messages).contains(message_ts)
        {
            return ResultAccess::SourceMismatch;
        }
        ResultAccess::Found(r.clone())
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
            id: store.new_id().unwrap(),
            sql: "SELECT 1".into(),
            explanation: "e".into(),
            chart: None,
            workspace: "T1".into(),
            channel: "C1".into(),
            user: user.into(),
            thread_ts: "1.0".into(),
            message_ts: "1.1".into(),
            request_message_ts: "1.0".into(),
            connection_id: "conn-1".into(),
            database: "db".into(),
            dialect: "postgres".into(),
            created: Instant::now(),
        }
    }

    #[test]
    fn take_consumes() {
        let s = ApprovalStore::default();
        let prop = p(&s, "U1");
        let id = prop.id.clone();
        s.insert(prop).unwrap();
        assert!(matches!(
            s.take_for_interaction(&id, "T1", "C1", "1.0", "1.1", "U1"),
            ProposalTake::Found(_)
        ));
        assert!(s.take(&id).is_none());
    }

    #[test]
    fn authorization_enforces_ttl_without_waiting_for_sweep() {
        let s = ApprovalStore::default();
        let mut prop = p(&s, "U1");
        let id = prop.id.clone();
        prop.created = Instant::now() - PROPOSAL_TTL - Duration::from_secs(1);
        s.insert(prop).unwrap();
        assert!(matches!(
            s.take_for_interaction(&id, "T1", "C1", "1.0", "1.1", "U1"),
            ProposalTake::Missing
        ));
        assert!(s.take(&id).is_none());
    }

    #[test]
    fn result_store_caps_and_expires() {
        let s = ResultStore::default();
        let cols = vec!["a".to_string()];
        let row = vec![vec![Some("1".to_string())]];
        let binding = || ResultBinding {
            workspace: "T1".into(),
            channel: "C1".into(),
            thread_ts: "1.0".into(),
            requester: "U1".into(),
            dialect: "postgres".into(),
            label: "orders".into(),
        };
        let (first, _) = s.insert(binding(), cols.clone(), row.clone()).unwrap();
        for _ in 0..10 {
            s.insert(binding(), cols.clone(), row.clone());
        }
        // Cap evicted the oldest entries; the most recent one is retrievable.
        assert!(matches!(
            s.access(&first, "T1", "C1", "1.0", "2.0", "U1"),
            ResultAccess::Missing
        ));
        let (last, _) = s.insert(binding(), cols.clone(), row.clone()).unwrap();
        assert!(s.bind_message(&last, "2.0"));
        assert!(matches!(
            s.access(&last, "T1", "C1", "1.0", "2.0", "U1"),
            ResultAccess::Found(_)
        ));
        assert!(matches!(
            s.access(&last, "T1", "C1", "1.0", "2.0", "U2"),
            ResultAccess::Unauthorized
        ));
        assert!(matches!(
            s.access(&last, "T1", "C1", "1.0", "other-message", "U1"),
            ResultAccess::SourceMismatch
        ));
        assert!(matches!(
            s.access(&last, "OTHER", "C1", "1.0", "2.0", "U1"),
            ResultAccess::SourceMismatch
        ));
        assert!(matches!(
            s.access("res-nope", "T1", "C1", "1.0", "2.0", "U1"),
            ResultAccess::Missing
        ));
    }

    #[test]
    fn expire_removes_old() {
        let s = ApprovalStore::default();
        let mut prop = p(&s, "U1");
        prop.created = Instant::now() - PROPOSAL_TTL - Duration::from_secs(1);
        let id = prop.id.clone();
        s.insert(prop).unwrap();
        s.insert(p(&s, "U2")).unwrap(); // fresh one stays
        let dead = s.expire();
        assert_eq!(dead.len(), 1);
        assert_eq!(dead[0].id, id);
        assert!(matches!(
            s.take_for_interaction(&id, "T1", "C1", "1.0", "1.1", "U1"),
            ProposalTake::Missing
        ));
    }

    #[test]
    fn capability_ids_are_opaque_and_unique() {
        let s = ApprovalStore::default();
        let a = s.new_id().unwrap();
        let b = s.new_id().unwrap();
        assert_ne!(a, b);
        assert_eq!(a.len(), "prop-".len() + 32);
        assert!(!a.ends_with("0000000000000000"));
    }

    #[test]
    fn proposal_interaction_binds_every_source_coordinate() {
        let s = ApprovalStore::default();
        let prop = p(&s, "U1");
        let id = prop.id.clone();
        s.insert(prop).unwrap();
        assert!(matches!(
            s.take_for_interaction(&id, "OTHER", "C1", "1.0", "1.1", "U1"),
            ProposalTake::SourceMismatch
        ));
        assert!(matches!(
            s.take_for_interaction(&id, "T1", "C1", "1.0", "1.1", "U2"),
            ProposalTake::Unauthorized
        ));
        assert!(matches!(
            s.take_for_interaction(&id, "T1", "C1", "1.0", "1.1", "U1"),
            ProposalTake::Found(_)
        ));
    }

    #[test]
    fn pending_proposals_are_count_and_byte_bounded() {
        let s = ApprovalStore::default();
        for _ in 0..PROPOSAL_CAP {
            s.insert(p(&s, "U1")).unwrap();
        }
        assert!(s.insert(p(&s, "U1")).is_err());

        let s = ApprovalStore::default();
        let mut huge = p(&s, "U1");
        huge.sql = "x".repeat(PROPOSAL_ITEM_BYTE_CAP + 1);
        assert!(s.insert(huge).is_err());
    }
}
