import { describe, expect, it, vi } from "vitest";
import type { Connected } from "./connections";
import { createOperationRunner, refusal, type HistoryDraft, type Operation, type OperationDeps } from "./operation";
import { IDLE_TRANSACTION, type TransactionStatus } from "./transaction";

const conn = (id = "c1", generation = 1): Connected => ({
  id, version: "16", readOnly: false, driver: "postgres", generation, key: `key:${id}`, label: id,
} as unknown as Connected);

const active = (owner: string, revision = 3): TransactionStatus => ({
  state: "active", revision, id: "tx1", owner, mode: "explicit", health: "healthy",
});

type World = {
  deps: OperationDeps;
  history: { entry: HistoryDraft; key: string }[];
  released: { id: string; reason: string; keepTab: string | null }[];
  applied: unknown[];
  open: Set<string>;
  tx: Map<string, TransactionStatus>;
  clock: { now: number };
};

function world(overrides: Partial<OperationDeps> = {}): World {
  const history: World["history"] = [];
  const released: World["released"] = [];
  const applied: unknown[] = [];
  const open = new Set(["c1"]);
  const tx = new Map<string, TransactionStatus>();
  const clock = { now: 1000 };
  const deps: OperationDeps = {
    connectionOpen: (c) => open.has(c.id),
    transactionOf: (id) => tx.get(id) ?? IDLE_TRANSACTION,
    transactionHistoryKey: () => null,
    tabTitle: (id) => (id === "t-owner" ? "Owner tab" : null),
    releaseStream: (id, reason, keepTab) => released.push({ id, reason, keepTab }),
    applyTransaction: (_c, incoming) => { applied.push(incoming); tx.set("c1", incoming as TransactionStatus); return true; },
    recordHistory: (entry, key) => history.push({ entry, key }),
    transactionFromError: (e) => (e && typeof e === "object" && "transaction" in e ? (e as any).transaction : null),
    errorMessage: (e) => (e instanceof Error ? e.message : String(e)),
    now: () => clock.now,
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
    ...overrides,
  };
  return { deps, history, released, applied, open, tx, clock };
}

const op = <T>(_w: World, partial: Partial<Operation<T>> & { run: () => Promise<T> }): Operation<T> => ({
  connection: conn(),
  needs: "idle",
  release: "test released the stream",
  history: { sql: "-- [Test]" },
  ...partial,
});

describe("refusal", () => {
  it("idle work is refused while any transaction is open, with the caller's message", () => {
    const w = world();
    const o = op(w, { run: async () => 1, frozenMessage: "Backup is frozen." });
    expect(refusal(o, active("t-owner"), w.deps.tabTitle)).toEqual({ kind: "frozen", message: "Backup is frozen." });
    expect(refusal(o, IDLE_TRANSACTION, w.deps.tabTitle)).toBeNull();
  });

  it("owner work runs in the owner tab and is frozen elsewhere, naming the owner", () => {
    const w = world();
    const inOwner = op(w, { needs: "owner", tabId: "t-owner", run: async () => 1 });
    const elsewhere = op(w, { needs: "owner", tabId: "t-other", run: async () => 1 });
    expect(refusal(inOwner, active("t-owner"), w.deps.tabTitle)).toBeNull();
    expect(refusal(elsewhere, active("t-owner"), w.deps.tabTitle)?.message).toBe(
      "Database actions are frozen in this tab while Owner tab owns the transaction",
    );
  });

  it("a lost session and a failed transaction are their own refusals", () => {
    const w = world();
    const o = op(w, { needs: "owner", tabId: "t-other", sql: "select 1", run: async () => 1 });
    expect(refusal(o, { ...active("t-owner"), state: "lost", health: "lost" }, w.deps.tabTitle)?.kind).toBe("lost");
    const failed: TransactionStatus = { ...active("t-other"), state: "failed", health: "recovery_required" };
    expect(refusal(o, failed, w.deps.tabTitle)?.kind).toBe("recovery");
    expect(refusal({ ...o, sql: "ROLLBACK" }, failed, w.deps.tabTitle)).toBeNull();
  });
});

describe("createOperationRunner", () => {
  it("a refused run never releases the stream, never invokes, never records history", async () => {
    const w = world();
    w.tx.set("c1", active("t-owner"));
    const run = vi.fn(async () => 1);
    const out = await createOperationRunner(w.deps).run(op(w, { run }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refused?.kind).toBe("frozen");
    expect(run).not.toHaveBeenCalled();
    expect(w.released).toEqual([]);
    expect(w.history).toEqual([]);
  });

  it("releases the stream with the reason, keeping the run tab's own stream silent", async () => {
    const w = world();
    await createOperationRunner(w.deps).run(op(w, { needs: "owner", tabId: "t1", release: "run replaced it", run: async () => 1 }));
    expect(w.released).toEqual([{ id: "c1", reason: "run replaced it", keepTab: "t1" }]);
  });

  it("release: null leaves the stream alone", async () => {
    const w = world();
    await createOperationRunner(w.deps).run(op(w, { release: null, run: async () => 1 }));
    expect(w.released).toEqual([]);
  });

  it("records history exactly once on success, keyed by destination, with duration and rows", async () => {
    const w = world();
    const runner = createOperationRunner(w.deps);
    const out = await runner.run(op(w, {
      history: { sql: (o) => (o.ok ? `-- [Import] ${(o.value as { n: number }).n} rows` : "-- [Import]"), rows: (v) => (v as { n: number }).n, schema: "public" },
      run: async () => { w.clock.now += 42; return { n: 7 }; },
    }));
    expect(out.ok).toBe(true);
    expect(w.history).toEqual([{ key: "key:c1", entry: { sql: "-- [Import] 7 rows", durationMs: 42, status: "ok", rows: 7, error: null, schema: "public" } }]);
  });

  it("a cancel is recorded as cancelled, an error as error with its first line", async () => {
    const w = world();
    const runner = createOperationRunner(w.deps);
    const cancelled = await runner.run(op(w, { run: async () => { throw new Error("canceling statement due to user request"); } }));
    const failed = await runner.run(op(w, { run: async () => { throw new Error("syntax error\nLINE 1"); } }));
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.cancelled).toBe(true);
    if (!failed.ok) expect(failed.cancelled).toBe(false);
    expect(w.history.map((h) => [h.entry.status, h.entry.error])).toEqual([["cancelled", "canceling statement due to user request"], ["error", "syntax error"]]);
  });

  it("history: null records nothing", async () => {
    const w = world();
    await createOperationRunner(w.deps).run(op(w, { history: null, run: async () => 1 }));
    await createOperationRunner(w.deps).run(op(w, { history: null, run: async () => { throw new Error("x"); } }));
    expect(w.history).toEqual([]);
  });

  it("a status verdict from the value overrides ok (a restore with failed statements)", async () => {
    const w = world();
    await createOperationRunner(w.deps).run(op(w, {
      history: { sql: "-- [Restore]", status: (v) => ((v as { failed: number }).failed ? { status: "error", error: "stmt 3 failed" } : null) },
      run: async () => ({ failed: 1 }),
    }));
    expect(w.history[0].entry).toMatchObject({ status: "error", error: "stmt 3 failed" });
  });

  it("applies a transaction carried by the reply against the pre-call baseline, and history is scoped by it", async () => {
    const w = world();
    let keyCalls = 0;
    w.deps.transactionHistoryKey = () => (keyCalls++ ? "tx1@abc" : null);
    const reply = { rows: [], transaction: active("t1", 4) };
    const out = await createOperationRunner(w.deps).run(op(w, {
      needs: "owner", tabId: "t1", event: "begin",
      history: { sql: "BEGIN", transactionScoped: true },
      run: async () => reply,
    }));
    expect(w.applied).toEqual([reply.transaction]);
    expect(out.ok && out.transaction).toEqual(reply.transaction);
    expect(w.history[0].entry.sql).toBe("-- [Transaction tx1@abc; revision 4; begin]\nBEGIN");
  });

  it("applies a transaction embedded in an error before the caller sees the outcome", async () => {
    const w = world();
    const embedded = { ...active("t1", 5), state: "failed" as const, health: "recovery_required" as const };
    const out = await createOperationRunner(w.deps).run(op(w, {
      needs: "owner", tabId: "t1",
      run: async () => { throw Object.assign(new Error("division by zero"), { transaction: embedded }); },
    }));
    expect(w.applied).toEqual([embedded]);
    expect(!out.ok && out.transaction).toEqual(embedded);
    expect(out.current).toBe(true);
  });

  it("current is false when the connection closed, the caller's predicate says so, or the transaction moved on", async () => {
    const w = world();
    const runner = createOperationRunner(w.deps);
    const closed = await runner.run(op(w, { history: null, run: async () => { w.open.delete("c1"); return 1; } }));
    expect(closed.ok && closed.current).toBe(false);
    w.open.add("c1");
    let superseded = false;
    const stale = await runner.run(op(w, { history: null, current: () => !superseded, run: async () => { superseded = true; return 1; } }));
    expect(stale.ok && stale.current).toBe(false);
    const moved = await runner.run(op(w, { history: null, run: async () => { w.tx.set("c1", { ...IDLE_TRANSACTION, revision: 9 }); return 1; } }));
    expect(moved.ok && moved.current).toBe(false);
    const fresh = await runner.run(op(w, { history: null, run: async () => 1 }));
    expect(fresh.ok && fresh.current).toBe(true);
  });

  it("a rejected transaction application makes the outcome stale", async () => {
    const w = world({ applyTransaction: () => false });
    const out = await createOperationRunner(w.deps).run(op(w, { needs: "owner", tabId: "t1", history: null, run: async () => ({ transaction: active("t1", 4) }) }));
    expect(out.ok && out.current).toBe(false);
  });

  it("busy wraps the call and clears on failure; the tick timer runs only while in flight", async () => {
    vi.useFakeTimers();
    try {
      const w = world({ setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>) });
      const busy: boolean[] = [];
      const ticks: number[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const pending = createOperationRunner(w.deps).run(op(w, {
        history: null, busy: (on) => busy.push(on), tick: (ms) => ticks.push(ms),
        run: async () => { await gate; throw new Error("late"); },
      }));
      expect(busy).toEqual([true]);
      w.clock.now += 200; await vi.advanceTimersByTimeAsync(200);
      w.clock.now += 200; await vi.advanceTimersByTimeAsync(200);
      expect(ticks).toEqual([200, 400]);
      release();
      await pending;
      expect(busy).toEqual([true, false]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(ticks).toEqual([200, 400]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("needs: none is never frozen", async () => {
    const w = world();
    w.tx.set("c1", active("t-owner"));
    const out = await createOperationRunner(w.deps).run(op(w, { needs: "none", history: null, run: async () => 1 }));
    expect(out.ok).toBe(true);
  });

  it("prepare runs after the release and before the call; a throw there is stage prepare, recorded in history", async () => {
    const w = world();
    const order: string[] = [];
    const run = vi.fn(async () => 1);
    const out = await createOperationRunner(w.deps).run(op(w, {
      prepare: async () => { order.push(`prepare:${w.released.length}`); throw new Error("PRAGMA failed\ndetail"); },
      run,
    }));
    expect(order).toEqual(["prepare:1"]);
    expect(run).not.toHaveBeenCalled();
    expect(!out.ok && out.stage).toBe("prepare");
    expect(!out.ok && out.error).toBe("PRAGMA failed\ndetail");
    expect(w.history[0].entry).toMatchObject({ status: "error", error: "PRAGMA failed" });
  });

  it("a run superseded while preparing never reaches the server and records nothing", async () => {
    const w = world();
    let superseded = false;
    const run = vi.fn(async () => 1);
    const busy: boolean[] = [];
    const out = await createOperationRunner(w.deps).run(op(w, {
      current: () => !superseded,
      busy: (on) => busy.push(on),
      prepare: async () => { superseded = true; },
      run,
    }));
    expect(run).not.toHaveBeenCalled();
    expect(!out.ok && out.refused?.kind).toBe("stale");
    expect(w.history).toEqual([]);
    expect(busy).toEqual([true, false]);
  });

  it("a failure in the call itself is stage run", async () => {
    const w = world();
    const out = await createOperationRunner(w.deps).run(op(w, { history: null, prepare: async () => {}, run: async () => { throw new Error("boom"); } }));
    expect(!out.ok && out.stage).toBe("run");
  });
});
