import { describe, expect, it } from "vitest";
import {
  IDLE_TRANSACTION,
  acceptTransactionStatus,
  decodeInterruptedTransaction,
  encodeInterruptedTransaction,
  transactionDatabaseAllowed,
  transactionBoundaryStaleReason,
  transactionControlAvailability,
  transactionEvent,
  transactionFromError,
  transactionHistoryScope,
  transactionHistorySql,
  transactionProvenanceNeedsRefresh,
  transactionRecoveryAllowed,
  transactionStaleReason,
  type TransactionStatus,
} from "./transaction";

const active = (revision = 1): TransactionStatus => ({
  state: "active",
  revision,
  id: "tx-1",
  owner: "tab-a",
  mode: "explicit",
  health: "healthy",
});

describe("transaction state", () => {
  it("accepts authoritative revisions only from the current connection generation", () => {
    expect(acceptTransactionStatus(IDLE_TRANSACTION, active(), 7, 7)).toEqual({ accepted: true, status: active() });
    expect(acceptTransactionStatus(active(3), active(2), 7, 7)).toEqual({ accepted: false, status: active(3) });
    expect(acceptTransactionStatus(active(3), { ...active(3), state: "failed" }, 7, 7).accepted).toBe(false);
    expect(acceptTransactionStatus(active(3), { ...active(3), revision: 4 }, 6, 7).accepted).toBe(false);
  });

  it("extracts embedded error status and freezes non-owners/lost owners", () => {
    expect(transactionFromError({ message: "aborted", transaction: { ...active(), state: "failed", health: "recovery_required" } })?.state).toBe("failed");
    expect(transactionDatabaseAllowed(active(), "tab-a")).toBe(true);
    expect(transactionDatabaseAllowed(active(), "tab-b")).toBe(false);
    expect(transactionDatabaseAllowed({ ...active(), state: "lost", health: "lost" }, "tab-a")).toBe(false);
  });

  it("classifies raw controls and records transaction identity in history", () => {
    expect(transactionEvent("-- control\nROLLBACK TO SAVEPOINT before_import")).toBe("rollback_to");
    expect(transactionEvent("SET autocommit = 0")).toBe("configure");
    expect(transactionEvent("/* control */ END WORK")).toBe("commit");
    expect(transactionEvent("ABORT")).toBe("rollback");
    expect(transactionEvent("SET SESSION autocommit = ON")).toBe("commit");
    expect(transactionEvent("SET @@session.autocommit 0")).toBe("configure");
    expect(transactionEvent("UPDATE items SET n = n + 1; COMMIT")).toBe("commit");
    expect(transactionHistorySql("COMMIT", "tx-1@abc", 4, "commit")).toContain("tx-1@abc; revision 4; commit");
    expect(transactionStaleReason("rollback", IDLE_TRANSACTION)).toMatch(/rolled back/);
    expect(transactionBoundaryStaleReason(active(), IDLE_TRANSACTION, "commit")).toMatch(/unit ended/);
    expect(transactionBoundaryStaleReason(active(), { ...active(), revision: 2 }, "savepoint")).toBeNull();
    expect(transactionBoundaryStaleReason(active(), { ...active(), revision: 2 }, "commit")).toMatch(/unit ended/);
    expect(transactionBoundaryStaleReason(active(), active(), "commit")).toBeNull();
    expect(transactionBoundaryStaleReason(IDLE_TRANSACTION, { ...IDLE_TRANSACTION, revision: 2 }, "commit")).toMatch(/unit ended/);
    expect(transactionHistoryScope(IDLE_TRANSACTION, { ...IDLE_TRANSACTION, revision: 2 }, "commit", null, null)).toBe("completed@revision-2");
    expect(transactionHistoryScope(IDLE_TRANSACTION, active(3), "commit", "tx-1@now", null)).toBe("transition@revision-3");
    expect(transactionHistoryScope(active(3), IDLE_TRANSACTION, "commit", null, "tx-1@before")).toBe("tx-1@before");
  });

  it("allows only recovery-first scripts after failure", () => {
    const failed = { ...active(3), state: "failed", health: "recovery_required" } as const;
    expect(transactionRecoveryAllowed(failed, "/* recover */ ABORT")).toBe(true);
    expect(transactionRecoveryAllowed(failed, "ROLLBACK WORK TO SAVEPOINT before_import; SELECT 1")).toBe(true);
    expect(transactionRecoveryAllowed(failed, "SELECT 1; ROLLBACK")).toBe(false);
  });

  it("exposes valid controls for MySQL configured, active, failed, and lost states", () => {
    const configured = { ...active(), state: "configured", mode: "explicit" } as const;
    expect(transactionControlAvailability(configured, "tab-a", 0, false)).toEqual({
      start: true, commit: false, rollback: false, clearConfiguration: true,
    });
    expect(transactionControlAvailability(active(), "tab-a", 0, false).commit).toBe(true);
    expect(transactionControlAvailability({ ...active(), state: "failed", health: "recovery_required" }, "tab-a", 0, false).rollback).toBe(true);
    expect(transactionControlAvailability({ ...active(), state: "lost", health: "lost" }, "tab-a", 0, false)).toEqual({
      start: false, commit: false, rollback: false, clearConfiguration: false,
    });
    expect(transactionControlAvailability(active(), "tab-b", 0, false).commit).toBe(false);
    expect(transactionControlAvailability(active(), "tab-a", 1, false).rollback).toBe(false);
    expect(transactionControlAvailability(active(), "tab-a", 0, true).commit).toBe(false);
  });

  it("invalidates transaction and pre-transaction snapshot provenance only on an advanced boundary", () => {
    const committed = { ...IDLE_TRANSACTION, revision: 2 };
    expect(transactionProvenanceNeedsRefresh("tx-1", 1, active(), committed)).toBe(true);
    expect(transactionProvenanceNeedsRefresh(null, 0, active(), committed)).toBe(true);
    expect(transactionProvenanceNeedsRefresh(null, 2, active(), committed)).toBe(false);
    expect(transactionProvenanceNeedsRefresh("tx-1", 1, active(), active())).toBe(false);
    expect(transactionProvenanceNeedsRefresh(null, 0, IDLE_TRANSACTION, committed)).toBe(true);
    expect(transactionProvenanceNeedsRefresh(null, 2, IDLE_TRANSACTION, committed)).toBe(false);
  });

  it("persists a bounded warning marker, never an active status snapshot", () => {
    const raw = encodeInterruptedTransaction("profile:main", "orders", active(), 1234)!;
    expect(raw.length).toBeLessThan(4096);
    expect(decodeInterruptedTransaction(raw)).toEqual({
      connectionKey: "profile:main",
      target: "orders",
      transactionId: "tx-1",
      mode: "explicit",
      state: "active",
      startedAt: 1234,
    });
    expect(decodeInterruptedTransaction(JSON.stringify({ ...active(), connectionKey: "profile:main" }))).toBeNull();
    expect(decodeInterruptedTransaction("x".repeat(4097))).toBeNull();
  });
});
