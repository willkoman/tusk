/**
 * The one protocol for running something against a connection.
 *
 * Every server-executing path in the workbench (editor run, paging, Explorer DDL,
 * grid Apply, export, backup, restore, import, DDL reads) used to hand-assemble the
 * same lifecycle: check the transaction freeze, release the connection's single result
 * stream, start a timer, invoke, apply the authoritative transaction status the
 * reply carries, record history once, classify a cancel as a cancel, clear the busy
 * flag. The copies differed by omission. This module owns the protocol; a path
 * supplies an `Operation` descriptor and interprets the `Outcome`.
 *
 * Ordering rules that live here so no caller can get them wrong:
 * - The freeze verdict comes BEFORE the stream is released: `releaseStream` condemns a
 *   healthy cursor and must not be spent on a call the backend will refuse anyway.
 * - The freeze is judged on the operation's OWN connection, never "the active one".
 * - History is written exactly once per run, keyed by the destination, whether the
 *   run succeeded, failed, or was cancelled, and only when the descriptor asks for it.
 * - A transaction status embedded in a reply or an error is applied before the
 *   caller sees the outcome, against the baseline captured before the call.
 * - `current` is false once the connection closed or the caller's own staleness
 *   predicate says so; callers gate UI writes on it, never on their own re-checks.
 */
import type { Connected } from "./connections";
import type { HistoryEntry } from "./history/store";
import {
  transactionDatabaseAllowed,
  transactionHistoryScope,
  transactionHistorySql,
  transactionOpen,
  transactionRecoveryAllowed,
  type TransactionEvent,
  type TransactionStatus,
} from "./transaction";
import type { SqlEngine } from "./editor/lexer";

export type HistoryDraft = Omit<HistoryEntry, "id" | "ts">;

/** What the runner needs from the workbench. App supplies the live adapter; tests supply fakes. */
export type OperationDeps = {
  connectionOpen(c: Connected): boolean;
  transactionOf(connectionId: string): TransactionStatus;
  /** The transaction-scoped history key the workbench keeps per connection. */
  transactionHistoryKey(connectionId: string): string | null;
  /** Title of a tab, for the "frozen while X owns the transaction" message. */
  tabTitle(tabId: string): string | null;
  /**
   * Free the connection's single result stream. `keepTab` names a tab whose own
   * stream a run is about to replace: freeing it is silent rather than an interruption.
   */
  releaseStream(connectionId: string, reason: string, keepTab: string | null): void;
  /** Apply an authoritative transaction status; false when it was stale or the connection is gone. */
  applyTransaction(target: Connected, incoming: unknown, event: TransactionEvent, baseline: TransactionStatus): boolean;
  recordHistory(entry: HistoryDraft, key: string): void;
  /** Extract a transaction status embedded in a backend error, if any. */
  transactionFromError(error: unknown): TransactionStatus | null;
  errorMessage(error: unknown): string;
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

export type HistorySpec = {
  /** The SQL (or `-- [Marker]` line) recorded; a function sees the value on success. */
  sql: string | ((outcome: { ok: true; value: unknown } | { ok: false }) => string);
  /** Scope the SQL by transaction identity, as editor runs and grid Apply do. */
  transactionScoped?: boolean;
  rows?: (value: unknown) => number | null;
  schema?: string | null;
  /** Override the ok/error verdict from the value (a restore reports failures in its summary). */
  status?: (value: unknown) => { status: HistoryEntry["status"]; error: string | null } | null;
};

export type Operation<T> = {
  connection: Connected;
  /**
   * `idle`: refused while any manual transaction owns the session (metadata, DDL,
   * backup, restore, import, all-rows export). `owner`: allowed only in the tab that
   * owns the transaction, or in any tab when none is open (editor runs, paging, Apply).
   * `none`: never frozen (work that does not touch the session, like writing loaded rows).
   */
  needs: "idle" | "owner" | "none";
  /** The tab acting; required for `owner`, and the tab a run replaces the stream of. */
  tabId?: string | null;
  /** Statement text, for the failed-transaction recovery rule (`owner` only). */
  sql?: string;
  engine?: SqlEngine;
  /** What the run refuses with when frozen; a default is derived from `needs`. */
  frozenMessage?: string;
  /** Reason the stream is released with; null leaves the stream alone (paging). */
  release: string | null;
  event?: TransactionEvent;
  history: HistorySpec | null;
  busy?: (on: boolean) => void;
  /** Called every 200 ms with elapsed ms while the call is in flight. */
  tick?: (ms: number) => void;
  /** Caller-side staleness (a superseding run, a replaced result). */
  current?: () => boolean;
  /**
   * Work that must happen after the stream is released and before the call: the
   * editability prefetch (fetching table detail AFTER the run would truncate the new
   * stream), a PRAGMA toggle the statement needs. A throw here fails the operation
   * at stage "prepare"; a run superseded while preparing never reaches the server.
   */
  prepare?: () => Promise<void>;
  run: () => Promise<T>;
};

export type Refusal = { kind: "frozen" | "lost" | "recovery" | "stale"; message: string };

export type Outcome<T> =
  | { ok: true; value: T; current: boolean; durationMs: number; transaction: TransactionStatus }
  | {
      ok: false;
      error: string;
      cancelled: boolean;
      current: boolean;
      durationMs: number;
      transaction: TransactionStatus;
      /** Set when the run never reached the backend. */
      refused: Refusal | null;
      /** Which phase threw; `prepare` failures never reached the backend either. */
      stage: "prepare" | "run" | null;
    };

export const isCancelMessage = (message: string): boolean => /cancel/i.test(message);

const TICK_MS = 200;

const firstLine = (s: string) => s.split("\n")[0];

function statusIn(value: unknown): TransactionStatus | null {
  if (value && typeof value === "object" && "transaction" in value) {
    const t = (value as { transaction: unknown }).transaction;
    if (t && typeof t === "object" && "revision" in t) return t as TransactionStatus;
  }
  return null;
}

/** Why an operation is refused before it reaches the backend, or null when it may run. */
export function refusal(
  op: Pick<Operation<unknown>, "needs" | "tabId" | "sql" | "engine" | "frozenMessage">,
  tx: TransactionStatus,
  tabTitle: (id: string) => string | null,
): Refusal | null {
  if (op.needs === "none") return null;
  if (op.needs === "idle") {
    if (!transactionOpen(tx)) return null;
    return { kind: "frozen", message: op.frozenMessage ?? "Frozen during a manual transaction. Commit or roll it back first." };
  }
  const tabId = op.tabId ?? "";
  if (!transactionDatabaseAllowed(tx, tabId)) {
    if (tx.state === "lost") return { kind: "lost", message: "Transaction session lost; disconnect and reconnect" };
    const owner = tx.owner ? tabTitle(tx.owner) ?? tx.owner : "another tab";
    return { kind: "frozen", message: op.frozenMessage ?? `Database actions are frozen in this tab while ${owner} owns the transaction` };
  }
  if (op.sql !== undefined && !transactionRecoveryAllowed(tx, op.sql, op.engine)) {
    return { kind: "recovery", message: "Transaction failed. Roll it back before any other database action." };
  }
  return null;
}

export function createOperationRunner(deps: OperationDeps) {
  async function run<T>(op: Operation<T>): Promise<Outcome<T>> {
    const c = op.connection;
    const event = op.event ?? "statement";
    const before = deps.transactionOf(c.id);
    const beforeHistoryKey = deps.transactionHistoryKey(c.id);
    const refused = refusal(op, before, deps.tabTitle);
    if (refused) {
      return { ok: false, error: refused.message, cancelled: false, current: deps.connectionOpen(c), durationMs: 0, transaction: before, refused, stage: null };
    }
    if (op.release !== null) deps.releaseStream(c.id, op.release, op.tabId ?? null);

    const t0 = deps.now();
    const elapsed = () => Math.round(deps.now() - t0);
    let expectedRevision = before.revision;
    const current = () =>
      deps.connectionOpen(c) &&
      (op.current?.() ?? true) &&
      deps.transactionOf(c.id).revision === expectedRevision;

    const historySql = (after: TransactionStatus, outcome: { ok: true; value: T } | { ok: false }) => {
      const spec = op.history!;
      const text = typeof spec.sql === "function" ? spec.sql(outcome) : spec.sql;
      if (!spec.transactionScoped) return text;
      const currentKey = deps.transactionHistoryKey(c.id);
      const key = transactionHistoryScope(before, after, event, currentKey, beforeHistoryKey ?? currentKey);
      return transactionHistorySql(text, key, after.revision, event);
    };

    op.busy?.(true);
    const timer = op.tick
      ? deps.setInterval(() => { if (current()) op.tick!(elapsed()); }, TICK_MS)
      : null;
    let stage: "prepare" | "run" = "prepare";
    try {
      if (op.prepare) {
        await op.prepare();
        if (!current()) {
          const stale: Refusal = { kind: "stale", message: "Superseded while preparing" };
          return { ok: false, error: stale.message, cancelled: false, current: false, durationMs: elapsed(), transaction: deps.transactionOf(c.id), refused: stale, stage: null };
        }
      }
      stage = "run";
      const value = await op.run();
      const embedded = statusIn(value);
      let accepted = true;
      if (embedded) {
        expectedRevision = embedded.revision;
        accepted = deps.applyTransaction(c, embedded, event, before);
      }
      const after = embedded ?? deps.transactionOf(c.id);
      if (op.history) {
        const verdict = op.history.status?.(value) ?? { status: "ok" as const, error: null };
        deps.recordHistory({
          sql: historySql(after, { ok: true, value }),
          durationMs: elapsed(),
          status: verdict.status,
          rows: op.history.rows?.(value) ?? null,
          error: verdict.error,
          schema: op.history.schema ?? null,
        }, c.key);
      }
      return { ok: true, value, current: accepted && current(), durationMs: elapsed(), transaction: after };
    } catch (e) {
      const embedded = deps.transactionFromError(e);
      let accepted = true;
      if (embedded) {
        expectedRevision = embedded.revision;
        accepted = deps.applyTransaction(c, embedded, event, before);
      }
      const message = deps.errorMessage(e);
      const cancelled = isCancelMessage(message);
      const after = embedded ?? deps.transactionOf(c.id);
      if (op.history) {
        deps.recordHistory({
          sql: historySql(after, { ok: false }),
          durationMs: elapsed(),
          status: cancelled ? "cancelled" : "error",
          rows: null,
          error: firstLine(message),
          schema: op.history.schema ?? null,
        }, c.key);
      }
      return { ok: false, error: message, cancelled, current: accepted && current(), durationMs: elapsed(), transaction: after, refused: null, stage };
    } finally {
      if (timer !== null) deps.clearInterval(timer);
      op.busy?.(false);
    }
  }
  return { run };
}

export type OperationRunner = ReturnType<typeof createOperationRunner>;
