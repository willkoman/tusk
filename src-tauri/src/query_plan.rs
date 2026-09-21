//! Execution planning for `run_query`: everything decided about a script BEFORE the
//! backend is touched, as one pure value.
//!
//! `plan()` lexes the text with the engine's rules, preflights the transaction
//! lifecycle, applies the read-only verdict once, and picks the execution path: one
//! statement run interactively (cursorable or not), an ordinary idle script through
//! the app-owned atomic wrapper, or statement-by-statement on the owner session.
//! `exec_plan` in lib.rs then only executes. The conformance harness plans through the
//! same function the command does, so a routing rule cannot be tested against a fork.
//!
//! `failure_kind()` is the other half: what a failed command means for the tracked
//! transaction (server-unwound unit, lost session, recovery required, or nothing),
//! shared by `run_query`, `fetch_more` and the harness through
//! `ConnState::settle_failure`.

use crate::db::{AppError, TransactionState, TransactionStatus};
use crate::script::{self, Item, TransactionAction, TransactionEngine};
use crate::sqlguard;

/// How a planned script executes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Path {
    /// One SQL statement, run interactively: a transaction control, a manual-owned
    /// single, or an idle single. `cursorable` = a plain read that may stream.
    Single { cursorable: bool },
    /// An ordinary idle script with no transaction control: the app-owned atomic wrapper.
    AtomicScript,
    /// Statement by statement on the owner session (explicit control, or already owned).
    Sequence,
}

pub(crate) struct QueryPlan {
    pub items: Vec<Item>,
    pub actions: Vec<Option<TransactionAction>>,
    pub path: Path,
    /// Apply the tab's search path before running. Skipped when the script is pure
    /// transaction control, or is recovery work in a failed transaction (where any
    /// other statement would itself fail).
    pub apply_search_path: bool,
}

pub(crate) const READ_ONLY_REFUSAL: &str = "connection is read-only. Writes and DDL are blocked.";

/// True when any item would write on a read-only connection: a non-read statement, a
/// COPY, or a transaction opener that asks for write access.
pub(crate) fn requests_write(
    items: &[Item],
    actions: &[Option<TransactionAction>],
    engine: TransactionEngine,
) -> bool {
    items.iter().zip(actions).any(|(item, action)| match item {
        Item::Sql(sql) => {
            (action.is_none() && !sqlguard::is_read_only_stmt(sql.trim(), engine))
                || sqlguard::transaction_requests_write(sql, *action)
        }
        Item::Copy { .. } => true,
    })
}

/// Plan a script from its text. `Ok(None)` means there is nothing to run.
pub(crate) fn plan(
    sql: &str,
    engine: TransactionEngine,
    status: &TransactionStatus,
    read_only: bool,
) -> Result<Option<QueryPlan>, AppError> {
    let items = script::parse_for_engine(sql.trim(), engine)?;
    if items.is_empty() {
        return Ok(None);
    }
    plan_items(items, engine, status, read_only).map(Some)
}

/// Plan already-lexed items (the harness feeds `split` output straight in).
pub(crate) fn plan_items(
    items: Vec<Item>,
    engine: TransactionEngine,
    status: &TransactionStatus,
    read_only: bool,
) -> Result<QueryPlan, AppError> {
    let actions = script::preflight_transactions(&items, engine, status)?;
    if read_only && requests_write(&items, &actions, engine) {
        return Err(AppError::new(READ_ONLY_REFUSAL));
    }
    let recovery_only = status.state == TransactionState::Failed
        && actions.iter().all(|action| {
            matches!(
                action,
                Some(
                    TransactionAction::Rollback
                        | TransactionAction::RollbackTo
                        | TransactionAction::Commit
                )
            )
        });
    let control_only = actions.iter().all(Option::is_some);
    let path = match items.as_slice() {
        [Item::Sql(stmt)] => Path::Single {
            cursorable: actions[0].is_none() && sqlguard::is_cursorable(stmt.trim(), engine),
        },
        _ if actions.iter().all(Option::is_none) && !status.owns_session() => Path::AtomicScript,
        _ => Path::Sequence,
    };
    Ok(QueryPlan {
        items,
        actions,
        path,
        apply_search_path: !recovery_only && !control_only,
    })
}

/// What a failed command means for the tracked transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FailureKind {
    /// The server ended the unit over a live session (SQL Server deadlock victim /
    /// `XACT_ABORT` unwind): the transaction is over, not lost; the tab returns to Idle.
    ServerUnwound,
    /// The connection dropped, or the owned session no longer has its transaction:
    /// nothing is replayed and the outcome must be verified by the user.
    Lost,
    /// The engine keeps the transaction open in a failed state until it is rolled back.
    RecoveryRequired,
    /// The statement failed and nothing about the transaction changes.
    Plain,
}

/// Classify a failure. The flag getters are closures because `session_ended` may only
/// be consulted while the transaction owns the session, and `unit_ended` only over a
/// live connection: evaluation order is part of the contract.
pub(crate) fn failure_kind(
    closed: bool,
    owns_session: bool,
    unit_ended: impl FnOnce() -> bool,
    session_ended: impl FnOnce() -> bool,
    errors_require_recovery: impl FnOnce() -> bool,
) -> FailureKind {
    if !closed && owns_session && unit_ended() {
        FailureKind::ServerUnwound
    } else if closed || (owns_session && session_ended()) {
        FailureKind::Lost
    } else if errors_require_recovery() {
        FailureKind::RecoveryRequired
    } else {
        FailureKind::Plain
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{TransactionHealth, TransactionMode};

    const PG: TransactionEngine = TransactionEngine::Postgres;

    fn idle() -> TransactionStatus {
        TransactionStatus::default()
    }

    fn active() -> TransactionStatus {
        TransactionStatus {
            state: TransactionState::Active,
            revision: 3,
            id: Some("tx1".into()),
            owner: Some("tab".into()),
            mode: TransactionMode::Explicit,
            health: TransactionHealth::Healthy,
        }
    }

    fn failed() -> TransactionStatus {
        TransactionStatus {
            state: TransactionState::Failed,
            health: TransactionHealth::RecoveryRequired,
            ..active()
        }
    }

    fn path(sql: &str, status: &TransactionStatus) -> Path {
        plan(sql, PG, status, false).unwrap().unwrap().path
    }

    #[test]
    fn nothing_to_run_is_none() {
        assert!(plan("", PG, &idle(), false).unwrap().is_none());
        // A comment-only script is still one item; the backend skips it, and it never streams.
        assert_eq!(
            path("-- only a comment", &idle()),
            Path::Single { cursorable: false }
        );
    }

    #[test]
    fn one_read_streams_one_write_does_not() {
        assert_eq!(path("SELECT 1", &idle()), Path::Single { cursorable: true });
        assert_eq!(
            path("INSERT INTO t VALUES (1)", &idle()),
            Path::Single { cursorable: false }
        );
        // A control statement is a single that never streams.
        assert_eq!(path("BEGIN", &idle()), Path::Single { cursorable: false });
        // Engine rules decide cursorability: FROM-first streams on DuckDB only.
        let duck = plan("FROM events", TransactionEngine::DuckDb, &idle(), false)
            .unwrap()
            .unwrap();
        assert_eq!(duck.path, Path::Single { cursorable: true });
    }

    #[test]
    fn idle_scripts_are_atomic_and_owned_or_controlled_scripts_are_sequences() {
        assert_eq!(
            path(
                "INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)",
                &idle()
            ),
            Path::AtomicScript
        );
        assert_eq!(
            path("BEGIN; INSERT INTO t VALUES (1); COMMIT", &idle()),
            Path::Sequence
        );
        // Inside an owned transaction even a plain script runs statement by statement.
        assert_eq!(
            path(
                "INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)",
                &active()
            ),
            Path::Sequence
        );
    }

    #[test]
    fn search_path_is_skipped_for_control_and_recovery_work() {
        assert!(
            plan("SELECT 1", PG, &idle(), false)
                .unwrap()
                .unwrap()
                .apply_search_path
        );
        assert!(
            !plan("BEGIN", PG, &idle(), false)
                .unwrap()
                .unwrap()
                .apply_search_path
        );
        assert!(
            !plan("ROLLBACK", PG, &failed(), false)
                .unwrap()
                .unwrap()
                .apply_search_path
        );
        assert!(
            !plan("ROLLBACK", PG, &active(), false)
                .unwrap()
                .unwrap()
                .apply_search_path
        );
    }

    #[test]
    fn read_only_refuses_writes_copies_and_write_openers_once() {
        for sql in [
            "INSERT INTO t VALUES (1)",
            "SELECT 1; DROP TABLE t",
            "BEGIN READ WRITE",
            "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
            "COPY t FROM stdin;\n1\n\\.\n",
        ] {
            let err = plan(sql, PG, &idle(), true)
                .err()
                .unwrap_or_else(|| panic!("read-only accepted {sql}"));
            assert_eq!(err.message, READ_ONLY_REFUSAL, "{sql}");
        }
        for sql in ["SELECT 1", "BEGIN", "BEGIN READ ONLY", "EXPLAIN SELECT 1"] {
            assert!(
                plan(sql, PG, &idle(), true).is_ok(),
                "read-only refused {sql}"
            );
        }
        // The verdict is engine-aware: a bracket identifier is a name on SQL Server.
        assert!(plan(
            "SELECT [delete] FROM t",
            TransactionEngine::MsSql,
            &idle(),
            true
        )
        .is_ok());
    }

    #[test]
    fn failure_classification_orders_its_questions() {
        use FailureKind::*;
        // A unit that ended over a live owned session is unwound, never lost.
        assert_eq!(
            failure_kind(false, true, || true, || panic!("not asked"), || true),
            ServerUnwound
        );
        // A closed connection is lost without asking anything else.
        assert_eq!(
            failure_kind(
                true,
                true,
                || panic!("not asked"),
                || panic!("not asked"),
                || true
            ),
            Lost
        );
        // An owned session whose transaction vanished is lost.
        assert_eq!(failure_kind(false, true, || false, || true, || true), Lost);
        // `session_ended` is never consulted outside an owned session.
        assert_eq!(
            failure_kind(false, false, || false, || panic!("not asked"), || true),
            RecoveryRequired
        );
        assert_eq!(
            failure_kind(false, false, || false, || false, || false),
            Plain
        );
        assert_eq!(
            failure_kind(false, true, || false, || false, || false),
            Plain
        );
    }
}
