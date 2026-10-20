import { describe, expect, it } from "vitest";
import {
  ClockMap,
  DEFAULT_ACTIVITY_FILTER,
  MonitorData,
  SeriesBuffer,
  ServerClock,
  TPS_AVERAGE_MS,
  WAIT_TYPES,
  blockedTone,
  blockingTree,
  compareRows,
  formatBytes,
  formatCompact,
  formatDuration,
  formatPercent,
  formatUptime,
  liveDuration,
  matchesFilter,
  niceCeil,
  oldestTransactionTone,
  replicationLagTone,
  rowKey,
  sessionsTone,
  tileIndex,
  waitLabel,
  type ActivityRow,
  type MonitorSample,
} from "./model";

function sample(over: Partial<MonitorSample> = {}): MonitorSample {
  return {
    connectionId: "conn-1",
    generation: 1,
    seq: 1,
    monoMs: 0,
    serverMs: 1_700_000_000_000,
    latencyMs: 1,
    intervalMs: 1000,
    status: "live",
    error: null,
    reset: false,
    rates: {
      tps: 100,
      commits: 90,
      rollbacks: 10,
      blksRead: 2,
      blksHit: 98,
      cacheHit: 0.98,
      tupReturned: 1000,
      tupFetched: 500,
      tupInserted: 5,
      tupUpdated: 4,
      tupDeleted: 3,
      tempBytes: 0,
      walBytes: 4096,
      walFpi: 1,
      buffersCheckpoint: 10,
      buffersClean: 2,
      buffersBackend: null,
      events: { checkpointsTimed: 0, checkpointsRequested: 0, deadlocks: 0, conflicts: 0, tempFiles: 0 },
    },
    sessions: { active: 3, idle: 10, idleInTransaction: 1, idleInTransactionAborted: 0, other: 0, hidden: 2, total: 16, maxConnections: 100 },
    load: [2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    oldestXactMs: 5000,
    blocked: 1,
    replicationLagMs: null,
    activity: null,
    activityError: null,
    locks: null,
    replication: null,
    progress: null,
    maintenance: null,
    io: null,
    statements: null,
    viewErrors: null,
    ...over,
  };
}

function row(pid: number, over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    pid,
    backendStart: `2026-10-20 10:00:00.${pid}+00`,
    backendStartMs: 1_792_490_400_000,
    user: "app",
    database: "shop",
    application: "api",
    client: "10.0.0.1",
    backendType: "client backend",
    state: "active",
    waitType: null,
    waitEvent: null,
    xactStartMs: 1_000,
    queryStartMs: 1_000,
    stateChangeMs: 1_000,
    blockedBy: [],
    query: `SELECT ${pid}`,
    queryTruncated: false,
    ...over,
  };
}

describe("SeriesBuffer", () => {
  it("wraps, keeps logical order and binary-searches time", () => {
    const b = new SeriesBuffer(4, 2);
    for (let i = 0; i < 6; i++) b.push(i * 10, [i, i * 2]);
    expect(b.size).toBe(4);
    expect([0, 1, 2, 3].map((i) => b.time(i))).toEqual([20, 30, 40, 50]);
    expect(b.value(0, 1)).toBe(4);
    expect(b.lastTime()).toBe(50);
    expect(b.lowerBound(35)).toBe(2);
    expect(b.lowerBound(-1)).toBe(0);
    expect(b.lowerBound(99)).toBe(4);
  });

  it("stores non-finite values and missing columns as gap cells", () => {
    const b = new SeriesBuffer(3, 3);
    b.push(0, [1, Infinity]);
    expect(b.value(0, 0)).toBe(1);
    expect(Number.isNaN(b.value(0, 1))).toBe(true);
    expect(Number.isNaN(b.value(0, 2))).toBe(true);
    b.gap(5);
    expect(Number.isNaN(b.value(1, 0))).toBe(true);
    b.clear();
    expect(b.size).toBe(0);
    expect(Number.isNaN(b.lastTime())).toBe(true);
  });

  it("answers a crosshair with the newest row at or before the time, within a gap limit", () => {
    const b = new SeriesBuffer(8, 1);
    b.push(1000, [1]);
    b.push(2000, [2]);
    b.push(3000, [3]);
    expect(b.at(2500, 1500)).toBe(1);
    expect(b.at(2000, 1500)).toBe(1);
    expect(b.at(500, 1500)).toBe(-1);
    expect(b.at(9000, 1500)).toBe(-1);
  });
});

describe("MonitorData.ingest", () => {
  it("pushes every series and the tile sparklines from one sample", () => {
    const d = new MonitorData(64);
    d.ingest(sample(), 1000, 8192);
    expect(d.load.size).toBe(1);
    expect(d.load.value(0, 0)).toBe(2);
    expect(d.sessions.value(0, 0)).toBe(3);
    expect(d.sessions.value(0, 4), "other + hidden").toBe(2);
    expect(d.sessions.value(0, 5), "max_connections ceiling").toBe(100);
    expect(d.tps.value(0, 0)).toBe(90);
    expect(d.tps.value(0, 2), "average of one sample").toBe(100);
    expect(d.io.value(0, 0), "hits as bytes").toBe(98 * 8192);
    expect(d.io.value(0, 1)).toBe(2 * 8192);
    expect(d.wal.value(0, 0)).toBe(4096);
    expect(d.fpi.value(0, 0)).toBe(1);
    expect(d.tiles.value(0, tileIndex("load"))).toBe(3);
    expect(d.tiles.value(0, tileIndex("sessions"))).toBe(16);
    expect(d.tiles.value(0, tileIndex("cacheHit"))).toBe(0.98);
    expect(d.tiles.value(0, tileIndex("blocked"))).toBe(1);
    expect(Number.isNaN(d.tiles.value(0, tileIndex("lag")))).toBe(true);
    expect(d.last).toBe(1000);
  });

  it("inserts a gap where a tick went missing, never interpolating across it", () => {
    const d = new MonitorData(64);
    d.ingest(sample(), 1000, 8192);
    d.ingest(sample(), 2000, 8192);
    d.ingest(sample(), 5000, 8192); // two ticks skipped
    expect(d.tps.size).toBe(4);
    expect(d.tps.time(2)).toBe(3000);
    expect(Number.isNaN(d.tps.value(2, 0))).toBe(true);
    expect(d.load.time(2)).toBe(3000);
    expect(Number.isNaN(d.load.value(2, 0))).toBe(true);
  });

  it("judges a gap against the sampler's own interval", () => {
    const d = new MonitorData(64);
    d.ingest(sample({ intervalMs: 5000 }), 1000, 8192);
    d.ingest(sample({ intervalMs: 5000 }), 6000, 8192);
    expect(d.tps.size, "a 5 s interval is not a gap at 5 s").toBe(2);
  });

  it("makes an error tick a gap everywhere", () => {
    const d = new MonitorData(64);
    d.ingest(sample(), 1000, 8192);
    d.ingest(sample({ status: "error", rates: null, sessions: null, load: null }), 2000, 8192);
    expect(Number.isNaN(d.load.value(1, 0))).toBe(true);
    expect(Number.isNaN(d.sessions.value(1, 0))).toBe(true);
    expect(Number.isNaN(d.tiles.value(1, 0))).toBe(true);
  });

  it("gaps only the rate series on a baseline or a counter reset", () => {
    const d = new MonitorData(64);
    d.ingest(sample({ rates: null }), 1000, 8192);
    expect(Number.isNaN(d.tps.value(0, 0))).toBe(true);
    expect(d.load.value(0, 0), "the gauges are still good readings").toBe(2);
    d.ingest(sample({ reset: true }), 2000, 8192);
    expect(Number.isNaN(d.tps.value(1, 0))).toBe(true);
    expect(Number.isNaN(d.wal.value(1, 0))).toBe(true);
    expect(d.sessions.value(1, 0)).toBe(3);
    expect(Number.isNaN(d.tiles.value(1, tileIndex("tps")))).toBe(true);
    expect(d.tiles.value(1, tileIndex("sessions"))).toBe(16);
  });

  it("averages TPS over the last ten seconds and restarts the average after a gap", () => {
    const d = new MonitorData(64);
    const tps = (v: number) => sample({ rates: { ...sample().rates!, tps: v } });
    d.ingest(tps(100), 1000, 8192);
    d.ingest(tps(200), 2000, 8192);
    d.ingest(tps(300), 3000, 8192);
    expect(d.tps.value(2, 2)).toBe(200);
    // Past the window the oldest drop out.
    for (let i = 4; i <= 13; i++) d.ingest(tps(1000), i * 1000, 8192);
    expect(d.tps.value(d.tps.size - 1, 2)).toBe(1000);
    expect(TPS_AVERAGE_MS).toBe(10_000);
    // A gap restarts the average instead of blending across it.
    d.ingest(tps(10), 20_000, 8192);
    expect(d.tps.value(d.tps.size - 1, 2)).toBe(10);
  });

  it("never lets time run backwards and clears", () => {
    const d = new MonitorData(64);
    d.ingest(sample(), 1000, 8192);
    d.ingest(sample(), 900, 8192);
    expect(d.load.time(1)).toBe(1000);
    d.clear();
    expect(d.load.size).toBe(0);
    expect(d.last).toBeNull();
  });

  it("keeps WAIT_TYPES in step with the backend's eleven buckets", () => {
    expect(WAIT_TYPES.length).toBe(11);
    expect(WAIT_TYPES[0]).toBe("CPU");
    expect(WAIT_TYPES[10]).toBe("Other");
  });
});

describe("clocks", () => {
  it("ClockMap spaces points by the sampler's clock, not IPC arrival", () => {
    const c = new ClockMap();
    expect(c.toLocal(0, 5000)).toBe(5000);
    expect(c.toLocal(1000, 6100), "a late arrival does not move the point").toBe(6000);
    expect(c.toLocal(2000, 6990), "an earlier arrival tightens the offset").toBe(6990);
    c.reset();
    expect(c.toLocal(0, 100)).toBe(100);
  });

  it("ServerClock keeps the least-delayed offset and ticks durations from it", () => {
    const s = new ServerClock(3);
    expect(s.now(1000), "identity before any sample").toBe(1000);
    s.observe(10_000, 1_050); // 50 ms in flight
    s.observe(11_000, 2_010); // 10 ms in flight: the better estimate
    expect(s.now(3_000)).toBe(11_990);
    s.observe(null, 9_999);
    expect(s.now(3_000), "a sample without a server time changes nothing").toBe(11_990);
    expect(liveDuration(11_000, s.now(3_000))).toBe(990);
    expect(liveDuration(20_000, 10_000), "never negative").toBe(0);
    expect(liveDuration(null, 10_000)).toBeNull();
  });
});

describe("formatting", () => {
  it("rounds axis maxima to nice values", () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(0.7)).toBe(1);
    expect(niceCeil(1.3)).toBe(2);
    expect(niceCeil(2.1)).toBe(2.5);
    expect(niceCeil(31)).toBe(50);
    expect(niceCeil(1000)).toBe(1000);
    expect(niceCeil(Number.NaN)).toBe(1);
  });

  it("formats counts, bytes, percentages and durations", async () => {
    expect(formatCompact(950)).toBe("950");
    expect(formatCompact(1234)).toBe("1.2k");
    expect(formatCompact(3_400_000)).toBe("3.4M");
    expect(formatCompact(0.25)).toBe("0.25");
    expect(formatCompact(Number.NaN)).toBe("–");
    expect(formatBytes(512)).toBe("512 B");
    const { formatBytesAxis } = await import("./model");
    expect(formatBytesAxis(5 * 1024 ** 2)).toBe("5M");
    expect(formatBytesAxis(2.5 * 1024 ** 3)).toBe("2.5G");
    expect(formatBytesAxis(512 * 1024)).toBe("512K");
    expect(formatBytesAxis(0)).toBe("0");
    const { formatAgo } = await import("./model");
    expect(formatAgo(47_900)).toBe("47 s ago");
    expect(formatAgo(13 * 60_000 + 5)).toBe("13 min ago");
    expect(formatAgo(2 * 3_600_000)).toBe("2 h ago");
    expect(formatAgo(3 * 86_400_000)).toBe("3 d ago");
    expect(formatAgo(null)).toBe("never");
    expect(formatBytes(4.1 * 1024 * 1024)).toBe("4.10 MiB");
    expect(formatBytes(150 * 1024)).toBe("150 KiB");
    expect(formatPercent(0.9961)).toBe("99.6%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(null)).toBe("–");
    expect(formatDuration(7_000)).toBe("0:07");
    expect(formatDuration(192_000)).toBe("3:12");
    expect(formatDuration(3_845_000)).toBe("1:04:05");
    expect(formatDuration(2 * 86_400_000 + 3 * 3_600_000)).toBe("2 d 3 h");
    expect(formatDuration(null)).toBe("–");
    expect(formatUptime(0, 41 * 86_400_000 + 5)).toBe("up 41 d");
    expect(formatUptime(0, 30_000)).toBe("up 1 min");
    expect(formatUptime(null, 1)).toBe("");
  });
});

describe("thresholds", () => {
  it("colours sessions at 80% and 95% of max_connections", () => {
    expect(sessionsTone(79, 100)).toBe("");
    expect(sessionsTone(80, 100)).toBe("warn");
    expect(sessionsTone(95, 100)).toBe("danger");
    expect(sessionsTone(5, 0)).toBe("");
  });

  it("colours the oldest transaction past 5 minutes and 1 hour", () => {
    expect(oldestTransactionTone(null)).toBe("");
    expect(oldestTransactionTone(299_000)).toBe("");
    expect(oldestTransactionTone(301_000)).toBe("warn");
    expect(oldestTransactionTone(3_600_001)).toBe("danger");
  });

  it("flags blocked sessions and replication lag as needing attention, never as errors", () => {
    expect(blockedTone(0)).toBe("");
    expect(blockedTone(2)).toBe("warn");
    expect(replicationLagTone(10_000)).toBe("");
    expect(replicationLagTone(61_000)).toBe("warn");
  });
});

describe("process list", () => {
  const me = { user: "app", database: "shop" };

  it("filters idle, background, database, user and text", () => {
    const f = DEFAULT_ACTIVITY_FILTER;
    expect(matchesFilter(row(1), f, me)).toBe(true);
    expect(matchesFilter(row(2, { state: "idle" }), f, me)).toBe(false);
    expect(matchesFilter(row(2, { state: "idle in transaction" }), f, me), "idle in transaction is not idle").toBe(true);
    expect(matchesFilter(row(3, { backendType: "autovacuum worker" }), f, me)).toBe(false);
    expect(matchesFilter(row(3, { backendType: "autovacuum worker" }), { ...f, hideBackground: false }, me)).toBe(true);
    expect(matchesFilter(row(4, { database: "other" }), { ...f, thisDatabase: true }, me)).toBe(false);
    expect(matchesFilter(row(5, { user: "bob" }), { ...f, myUser: true }, me)).toBe(false);
    expect(matchesFilter(row(6, { query: "UPDATE orders SET x = 1" }), { ...f, text: "orders" }, me)).toBe(true);
    expect(matchesFilter(row(6), { ...f, text: "orders" }, me)).toBe(false);
    expect(matchesFilter(row(6), { ...f, text: "6" }, me), "pid is searchable").toBe(true);
  });

  it("sorts active first then the longest query by default, and by any column", () => {
    const a = row(1, { state: "idle", stateChangeMs: 100 });
    const b = row(2, { queryStartMs: 500 });
    const c = row(3, { queryStartMs: 200 });
    expect([a, b, c].sort((x, y) => compareRows(x, y, null)).map((r) => r.pid)).toEqual([3, 2, 1]);
    expect([b, c, a].sort((x, y) => compareRows(x, y, { key: "pid", dir: "desc" })).map((r) => r.pid)).toEqual([3, 2, 1]);
    // Query age descending = longest first = earliest start first.
    expect([b, c].sort((x, y) => compareRows(x, y, { key: "query", dir: "desc" })).map((r) => r.pid)).toEqual([3, 2]);
    expect([b, c].sort((x, y) => compareRows(x, y, { key: "query", dir: "asc" })).map((r) => r.pid)).toEqual([2, 3]);
    expect(waitLabel(row(9, { waitType: "Lock", waitEvent: "transactionid" }))).toBe("Lock: transactionid");
    expect(waitLabel(row(9))).toBe("");
    expect(rowKey(row(9))).toBe("9@2026-10-20 10:00:00.9+00");
  });

  it("nests blocked sessions under their blocker and marks the root", () => {
    const rows = [
      row(10, { state: "idle in transaction", queryStartMs: 100 }),
      row(11, { blockedBy: [10], waitType: "Lock", queryStartMs: 300 }),
      row(12, { blockedBy: [11], waitType: "Lock", queryStartMs: 400 }),
      row(13, { blockedBy: [10], waitType: "Lock", queryStartMs: 200 }),
      row(14, { queryStartMs: 50 }),
    ];
    const tree = blockingTree(rows, () => true, null);
    expect(tree.map((n) => [n.row.pid, n.depth])).toEqual([
      [14, 0],
      [10, 0],
      [13, 1],
      [11, 1],
      [12, 2],
    ]);
    const root = tree.find((n) => n.row.pid === 10)!;
    expect(root.rootBlocker).toBe(true);
    expect(root.blocks).toBe(2);
    expect(tree.find((n) => n.row.pid === 11)!.rootBlocker, "a blocker that is itself blocked is not the root").toBe(false);
    expect(tree.find((n) => n.row.pid === 14)!.rootBlocker).toBe(false);
  });

  it("keeps a filtered-out blocker as context instead of hiding the cause", () => {
    const rows = [
      row(20, { state: "idle in transaction", user: "batch" }),
      row(21, { blockedBy: [20], waitType: "Lock" }),
      row(22, { user: "batch" }),
    ];
    const tree = blockingTree(rows, (r) => r.user !== "batch", null);
    expect(tree.map((n) => n.row.pid)).toEqual([20, 21]);
    expect(tree[0].context).toBe(true);
    expect(tree[1].context).toBe(false);
  });

  it("nests under the first blocker that is listed and shows the rest top level", () => {
    const rows = [row(30, { blockedBy: [99, 31] }), row(31)];
    const tree = blockingTree(rows, () => true, null);
    expect(tree.map((n) => [n.row.pid, n.depth])).toEqual([
      [31, 0],
      [30, 1],
    ]);
    const lone = blockingTree([row(40, { blockedBy: [99] })], () => true, null);
    expect(lone.map((n) => [n.row.pid, n.depth])).toEqual([[40, 0]]);
  });

  it("survives a wait cycle without recursing", () => {
    const rows = [row(50, { blockedBy: [51] }), row(51, { blockedBy: [50] }), row(52)];
    const tree = blockingTree(rows, () => true, null);
    expect(tree.length).toBe(3);
    expect(new Set(tree.map((n) => n.row.pid))).toEqual(new Set([50, 51, 52]));
    expect(tree.filter((n) => n.cycle).length).toBe(2);
    expect(tree.find((n) => n.row.pid === 52)!.cycle).toBe(false);
  });

  it("drops duplicate pids rather than emitting them twice", () => {
    const tree = blockingTree([row(60), row(60, { backendStart: "later" })], () => true, null);
    expect(tree.length).toBe(1);
  });
});

describe("readouts and permissions", () => {
  it("averages a column over a time window and finds the newest value", async () => {
    const { windowMean, latestValue } = await import("./model");
    const b = new SeriesBuffer(8, 1);
    b.push(0, [1]);
    b.push(1000, [3]);
    b.gap(2000);
    b.push(3000, [5]);
    expect(windowMean(b, 0, 1000)).toBe(4);
    expect(Number.isNaN(windowMean(b, 0, 9000))).toBe(true);
    expect(latestValue(b, 0)).toBe(5);
    b.gap(4000);
    expect(latestValue(b, 0), "a trailing gap reads through to the last value").toBe(5);
    expect(Number.isNaN(latestValue(new SeriesBuffer(2, 1), 0))).toBe(true);
  });

  it("offers Cancel/Terminate only where the server would allow it", async () => {
    const { signalRefusal } = await import("./model");
    const server = { pid: 7, user: "me", superuser: false, signalBackend: false };
    const live = { readOnly: false, running: true, server };
    expect(signalRefusal({ pid: 9, user: "me" }, live)).toBe("");
    expect(signalRefusal({ pid: 9, user: "other" }, live)).toMatch(/pg_signal_backend/);
    expect(signalRefusal({ pid: 9, user: "other" }, { ...live, server: { ...server, signalBackend: true } })).toBe("");
    expect(signalRefusal({ pid: 9, user: null }, { ...live, server: { ...server, superuser: true } })).toBe("");
    expect(signalRefusal({ pid: 7, user: "me" }, live)).toMatch(/own session/);
    expect(signalRefusal({ pid: 9, user: "me" }, { ...live, readOnly: true })).toMatch(/read-only/);
    expect(signalRefusal({ pid: 9, user: "me" }, { ...live, running: false })).toMatch(/Resume/);
  });

  it("decides when the sampler should query the server", async () => {
    const { wantsSampling, restingStatus } = await import("./session");
    expect(wantsSampling({ userPaused: false, visible: true, keepSampling: false })).toBe(true);
    expect(wantsSampling({ userPaused: false, visible: false, keepSampling: false })).toBe(false);
    expect(wantsSampling({ userPaused: false, visible: false, keepSampling: true })).toBe(true);
    expect(wantsSampling({ userPaused: true, visible: true, keepSampling: true })).toBe(false);
    expect(restingStatus({ userPaused: true, visible: true, keepSampling: false }, true)).toEqual({ kind: "paused" });
    expect(restingStatus({ userPaused: false, visible: false, keepSampling: false }, true)).toEqual({ kind: "hidden" });
    expect(restingStatus({ userPaused: false, visible: true, keepSampling: false }, true)).toEqual({ kind: "live" });
    expect(restingStatus({ userPaused: false, visible: true, keepSampling: false }, false)).toEqual({ kind: "idle" });
  });
});

describe("phase-2 model", () => {
  it("records events and write rates from the fast tier", async () => {
    const { eventTotals, WRITES_SERIES } = await import("./model");
    const d = new MonitorData(64);
    const base = sample();
    d.ingest(sample({ rates: { ...base.rates!, buffersBackend: 3, events: { checkpointsTimed: 1, checkpointsRequested: 0, deadlocks: 2, conflicts: 0, tempFiles: 1 } } }), 1000, 8192);
    expect(WRITES_SERIES).toHaveLength(3);
    expect(d.writes.value(0, 0)).toBe(10 * 8192);
    expect(d.writes.value(0, 2)).toBe(3 * 8192);
    const ev = d.events.between(0, 2000);
    expect(ev.map((e) => e.kind)).toEqual(["checkpoint", "deadlock", "temp-file"]);
    expect(eventTotals(ev).deadlock).toBe(2);
    d.ingest(sample({ reset: true }), 2000, 8192);
    expect(d.events.between(1500, 2500).map((e) => e.kind)).toEqual(["reset"]);
    expect(Number.isNaN(d.writes.value(1, 0))).toBe(true);
    // PostgreSQL 17 has no backend writes: a gap cell, never a zero.
    d.ingest(sample(), 3000, 8192);
    expect(Number.isNaN(d.writes.value(2, 2))).toBe(true);
  });

  it("keeps a bounded ring of events", async () => {
    const { EventRing } = await import("./model");
    const r = new EventRing(3);
    for (let i = 0; i < 5; i++) r.push(i, "deadlock", 1);
    expect(r.size).toBe(3);
    expect(r.between(-1, 10).map((e) => e.t)).toEqual([2, 3, 4]);
    r.clear();
    expect(r.size).toBe(0);
  });

  it("sums statement work over the window, newest text winning", async () => {
    const { aggregateStatements } = await import("./model");
    const row = (key: string, calls: number, execMs: number, query: string | null) => ({ key, queryid: key, user: null, database: null, calls, execMs, rows: calls, sharedHits: 0, sharedReads: 0, query });
    const snaps = [
      { t: 0, seconds: 10, totalCalls: 100, totalExecMs: 50, tracked: 2, rows: [row("a", 100, 50, null)] },
      { t: 10_000, seconds: 10, totalCalls: 30, totalExecMs: 400, tracked: 2, rows: [row("a", 20, 10, "SELECT a"), row("b", 10, 390, "SELECT b")] },
      { t: 20_000, seconds: 10, totalCalls: 5, totalExecMs: 5, tracked: 2, rows: [row("a", 5, 5, null)] },
    ];
    const all = aggregateStatements(snaps, 0);
    expect(all.seconds).toBe(30);
    expect(all.totalCalls).toBe(135);
    expect(all.rows.map((r) => r.key)).toEqual(["b", "a"]);
    expect(all.rows[1]).toMatchObject({ calls: 125, execMs: 65, query: "SELECT a" });
    const recent = aggregateStatements(snaps, 15_000);
    expect(recent.rows.map((r) => r.key)).toEqual(["a"]);
    expect(recent.seconds).toBe(10);
    expect(aggregateStatements(snaps, 5_000, 15_000).rows.map((r) => r.key)).toEqual(["b", "a"]);
  });

  it("remembers the longest-running active sessions per sample and summarizes a range", async () => {
    const { activityMoment, summarizeRange, MOMENT_TOP } = await import("./model");
    const rows = [
      row(1, { queryStartMs: 1_000 }),
      row(2, { queryStartMs: 5_000, waitType: "Lock", waitEvent: "transactionid" }),
      row(3, { state: "idle" }),
      row(4, { backendType: "autovacuum worker" }),
    ];
    const m1 = activityMoment(rows, 100, 9_000);
    expect(m1.rows.map((r) => r.pid)).toEqual([1, 2]);
    expect(m1.rows[0].ageMs).toBe(8_000);
    const m2 = activityMoment([row(2, { queryStartMs: 5_000 })], 200, 12_000);
    const sum = summarizeRange([m1, m2, { t: 999, rows: [] }], 50, 250);
    expect(sum.samples).toBe(2);
    expect(sum.sessions.map((s) => s.pid)).toEqual([1, 2]);
    const two = sum.sessions.find((s) => s.pid === 2)!;
    expect(two.seen).toBe(2);
    expect(two.longestMs).toBe(7_000);
    expect(two.waits).toEqual(expect.arrayContaining(["Lock: transactionid", "CPU"]));
    expect(MOMENT_TOP).toBe(10);
    const long = activityMoment([row(9, { query: "x".repeat(400) })], 0, 2_000);
    expect(long.rows[0].query!.length).toBe(301);
  });

  it("colours wraparound and slots by what needs attention", async () => {
    const { wraparoundTone, slotTone } = await import("./model");
    expect(wraparoundTone(100_000_000, 200_000_000)).toBe("");
    expect(wraparoundTone(250_000_000, 200_000_000)).toBe("warn");
    expect(wraparoundTone(1_700_000_000, 200_000_000)).toBe("danger");
    expect(slotTone({ active: true, walStatus: "reserved", retainedBytes: 10 })).toBe("");
    expect(slotTone({ active: false, walStatus: null, retainedBytes: 2 * 1024 ** 3 })).toBe("warn");
    expect(slotTone({ active: true, walStatus: "extended", retainedBytes: 0 })).toBe("warn");
    expect(slotTone({ active: false, walStatus: "lost", retainedBytes: null })).toBe("danger");
  });

  it("thresholds: normalize, clamp, order, and drive every tone", async () => {
    const m = await import("./model");
    const d = m.DEFAULT_THRESHOLDS;
    expect(m.normalizeThresholds(null)).toEqual(d);
    expect(m.normalizeThresholds({ sessionsWarnPct: "80", lagWarnSec: Number.NaN, blockedWarn: Infinity })).toEqual(d);
    // Out of range clamps; a warning never sits above its danger level.
    const n = m.normalizeThresholds({ sessionsWarnPct: 99, sessionsDangerPct: 120, oldestXactWarnMin: 90, oldestXactDangerMin: 30, blockedWarn: 2.6 });
    expect(n.sessionsDangerPct).toBe(100);
    expect(n.sessionsWarnPct).toBe(99);
    expect(n.oldestXactWarnMin).toBe(30);
    expect(n.blockedWarn).toBe(3);
    const t = { ...d, sessionsWarnPct: 50, sessionsDangerPct: 70, oldestXactWarnMin: 1, oldestXactDangerMin: 2, blockedWarn: 3, lagWarnSec: 0, cacheHitWarnPct: 90, slotRetainedWarnGiB: 0, wraparoundDangerHeadroomM: 1000 };
    expect(m.sessionsTone(50, 100, t)).toBe("warn");
    expect(m.sessionsTone(70, 100, t)).toBe("danger");
    expect(m.oldestTransactionTone(61_000, t)).toBe("warn");
    expect(m.oldestTransactionTone(121_000, t)).toBe("danger");
    expect(m.blockedTone(2, t)).toBe("");
    expect(m.blockedTone(3, t)).toBe("warn");
    expect(m.blockedTone(5, { ...t, blockedWarn: 0 })).toBe("");
    expect(m.replicationLagTone(10 ** 9, t)).toBe("");
    expect(m.cacheHitTone(0.89, t)).toBe("warn");
    expect(m.cacheHitTone(0.95, t)).toBe("");
    expect(m.cacheHitTone(0.1, d)).toBe("");
    expect(m.cacheHitTone(null, t)).toBe("");
    expect(m.slotTone({ active: false, walStatus: null, retainedBytes: 10 * 1024 ** 3 }, t)).toBe("");
    expect(m.wraparoundTone(1_200_000_000, 200_000_000, t)).toBe("danger");
    expect(m.wraparoundTone(1_200_000_000, 200_000_000, d)).toBe("warn");
  });
});
