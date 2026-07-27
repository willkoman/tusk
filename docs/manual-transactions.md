# Manual transactions

Tusk supports user-owned transactions on PostgreSQL, DuckDB, SQLite, and MySQL. A manual transaction owns one database session and one editor tab across runs. Tusk tracks that ownership explicitly; it does not infer transaction state from editor text or silently move work to another pooled connection.

## Starting and ending a transaction

Use the topbar **Transaction** menu or run transaction-control SQL directly. Tusk recognizes these lifecycle families after leading comments and whitespace:

| Purpose | Recognized forms |
|---|---|
| Begin | `BEGIN ...`, `START TRANSACTION ...` |
| Commit | `COMMIT ...`, `END ...` |
| Roll back | `ROLLBACK ...`, `ABORT ...` |
| Savepoint | `SAVEPOINT name`, `ROLLBACK [WORK\|TRANSACTION] TO [SAVEPOINT] name`, `RELEASE [SAVEPOINT] name` |
| Characteristics | unscoped `SET TRANSACTION ...` where the engine supports it |
| MySQL autocommit | `SET [SESSION] autocommit=0\|OFF`, `SET [SESSION] autocommit=1\|ON`, and `@@session` forms |

The menu offers **Begin transaction** on every engine, **Begin read-only transaction** on PostgreSQL/MySQL, and **Turn autocommit off** on MySQL.

The connected engine still validates its exact dialect and optional clauses. Tusk rejects nested starts, prepared transactions, `COMMIT`/`ROLLBACK ... AND CHAIN` or `... RELEASE`, global/persisted autocommit changes, and scoped `SET SESSION/GLOBAL TRANSACTION`. A read-only connection permits lifecycle control but still blocks writable transaction modes, writes, and DDL.

The transaction bar shows the mode, transaction id, state, owner tab, and elapsed time. Its owner actions are:

- **Commit** and **Rollback** for an explicit transaction.
- **Commit unit** and **Rollback unit** for MySQL autocommit-off mode. These end the current unit but keep autocommit off and retain the pinned owner session.
- **Commit & enable autocommit** to run `SET autocommit=1`, which commits the current MySQL unit and releases the session.
- **Start transaction** or **Clear configuration** after a standalone MySQL `SET TRANSACTION` has configured the next unit.
- **Switch to owner** from another tab.

Commit and rollback also have rebindable actions, defaulting to `Mod-Alt-C` and `Mod-Alt-R`.

## Scripts and runs

Manual transactions work both across runs and inside one run:

```sql
-- Across runs: run each block separately from the same owner tab.
BEGIN;
```

```sql
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;
```

```sql
COMMIT;
```

```sql
-- Self-contained: run this whole script once.
BEGIN;
UPDATE jobs SET claimed_at = CURRENT_TIMESTAMP WHERE id = 42;
COMMIT;
```

Tusk parses and preflights the complete transaction lifecycle before sending the first statement. Explicit-control scripts run statement by statement on the owned session and are not put inside another app transaction.

When Tusk is idle and a multi-statement input contains no transaction control, Tusk still supplies its normal app-owned atomic wrapper. Failure rolls back prior DML. A trailing read remains inside that app-owned script and the UI returns a script summary instead of splitting the read out for streaming. MySQL DDL and nontransactional tables remain exceptions to rollback guarantees.

A single cursorable read can stream while the owner transaction is active. Starting another run closes that result stream without ending the user-owned transaction.

## Ownership and frozen work

The tab that opens or configures the transaction becomes its owner. Until the transaction ends:

- Only the owner tab can run, fetch, cancel, or apply database work on that session.
- Other tabs remain available for editing files and SQL, but their database actions are frozen. **Switch to owner** returns to the active unit.
- Session-backed background work is frozen, including schema/relation/permission refreshes, server lint, sample metadata, query-backed all-row export, import, explorer DDL, and Slack approval work. Schema refresh requested by completed DDL is deferred until the transaction ends.
- Already loaded rows may still be viewed or exported with the loaded-row path; no new database query is issued for that export.

This prevents a metadata query, another tab, or a pooled MySQL connection from accidentally observing, committing, rolling back, or replacing the owner unit.

## Grid Apply and outer Commit

Grid edits remain a local overlay until their preview dialog runs the generated `UPDATE`/`DELETE`/`INSERT` script.

- With no manual transaction, the dialog says **Commit** and the generated multi-statement script uses Tusk's app-owned atomic transaction.
- In the owner tab of a manual transaction, the dialog says **Apply**. Apply writes into the existing outer transaction, clears the local pending overlay on success, and refreshes the grid inside that same unit. It does not commit the outer transaction.
- **Commit** on the transaction bar makes applied changes durable. **Rollback** discards them. Apply failure keeps pending edits; PostgreSQL may then require rollback recovery.
- Pending grid edits must be applied or discarded before the outer transaction can end, the owner tab can close, the connection can disconnect, or Tusk can close.

## Result provenance

Every result and pending-edit set records the authoritative transaction id and revision that produced it.

- A result loaded before `BEGIN` must be rerun inside the transaction before it can be edited.
- Only the owner can edit a result produced by the current healthy transaction.
- Commit, rollback, rollback-to-savepoint, autocommit-unit boundaries, and lost-session detection mark affected snapshots or pending edits stale. Rows remain visible, but must be rerun before editing.
- Savepoint creation or release alone does not end the unit.
- Query history records transaction control and grid Apply work with transaction identity/revision markers, so commands from separate units are not conflated.

The provenance checks are conservative. For example, rollback to a savepoint invalidates affected transaction snapshots rather than trying to prove which rows were read before or after that savepoint.

## Failure and loss recovery

PostgreSQL aborts a transaction after a statement error or cancellation. Tusk marks the unit **Recovery required** and permits recovery-first work only:

- `ROLLBACK` or `ABORT` ends the unit.
- `ROLLBACK TO [SAVEPOINT] name` can restore a healthy active unit when the savepoint exists. A script may continue with later statements after that recovery command.
- `COMMIT` is not accepted as recovery for a failed transaction.

Other engines may keep a transaction usable after a statement error; Tusk follows the engine state. MySQL probes the pinned connection after work and marks the unit lost if the transaction or autocommit state changed unexpectedly.

If the connection drops, the database ends the transaction unexpectedly, or Tusk can no longer prove the pinned session, the bar changes to **Lost**. Tusk does not reconnect the transaction and never replays an in-flight statement, even when it looked read-only. The outcome may be unknown: disconnect, reconnect, and verify database state before retrying. A local interrupted-transaction marker warns on the next matching connection, but no transaction state is restored.

## Close and disconnect

Closing the owner tab, disconnecting, or closing Tusk opens **Resolve transaction first**. Finish in-flight work, then apply or discard pending grid edits before choosing Commit or Rollback. A configured-but-not-started MySQL unit can only be cleared. A lost unit cannot be committed or rolled back through Tusk; the dialog offers disconnect/reconnect.

The backend performs a best-effort same-session rollback during disconnect cleanup. Process failure or connection loss can prevent an acknowledgement, so recovery still relies on reconnecting and verifying state, not on assumed rollback.

## Capability matrix

| Capability | PostgreSQL | DuckDB | SQLite | MySQL |
|---|---|---|---|---|
| Explicit manual transaction | yes | yes | yes | yes, pinned connection |
| Savepoint / rollback-to / release | yes | no | yes | yes |
| `SET TRANSACTION` | yes, active and before work | no | no | yes, before `START TRANSACTION` |
| Persistent autocommit-off mode | no | no | no | yes, pinned connection |
| Transactional DDL | yes | yes | yes | no; implicit commits |

Engine caveats:

- **DuckDB:** no savepoints and no `SET TRANSACTION`. These are rejected before any statement in the submitted script runs.
- **SQLite:** savepoints work; `SET TRANSACTION` does not. Use SQLite's supported `BEGIN` mode instead.
- **MySQL:** explicit and autocommit-off modes use one pinned physical connection. Recognized implicit-commit DDL and transaction-changing `CALL`/`EXECUTE`/`XA` forms are blocked while Tusk tracks a manual transaction. DDL outside that unit can still auto-commit, and writes to nontransactional tables cannot be rolled back.
- **PostgreSQL:** `SET TRANSACTION` must be the first transaction work. A statement error or cancellation normally requires `ROLLBACK` or `ROLLBACK TO` before more work.
