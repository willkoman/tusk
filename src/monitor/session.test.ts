import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitorSample, MonitorStarted } from "./model";
import { MonitorSession, NO_VIEWS, sweepStaleMonitors, tiersFor } from "./session";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// The session never touches a window here; keep the Tauri window API out of node.
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => { throw new Error("no window"); } }));

const started = (generation: number): MonitorStarted => ({
  generation,
  intervalMs: 1000,
  readOnly: false,
  server: {
    versionNum: 160004,
    version: "16.4",
    pid: 42,
    user: "me",
    database: "shop",
    superuser: false,
    readAllStats: true,
    signalBackend: false,
    startedMs: 0,
    maxConnections: 100,
    blockSize: 8192,
    inRecovery: false,
    querySize: 1024,
    walStats: true,
    statementsAvailable: false,
    statementsNote: null,
  },
  waitTypes: [],
});

const sample = (generation: number, over: Partial<MonitorSample> = {}): MonitorSample => ({
  connectionId: "conn-1",
  generation,
  seq: 1,
  monoMs: 10,
  serverMs: 1_700_000_000_000,
  latencyMs: 1,
  intervalMs: 1000,
  status: "live",
  error: null,
  reset: false,
  rates: null,
  sessions: { active: 1, idle: 0, idleInTransaction: 0, idleInTransactionAborted: 0, other: 0, hidden: 0, total: 1, maxConnections: 100 },
  load: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  oldestXactMs: null,
  blocked: 0,
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
});

const calls = (command: string) => vi.mocked(invoke).mock.calls.filter(([c]) => c === command);
const last = (command: string) => {
  const all = calls(command);
  return all[all.length - 1][1];
};
const settle = async (s: MonitorSession) => {
  // The session serializes its backend calls on a promise queue; drain it.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await (s as unknown as { queue: Promise<void> }).queue;
};

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "monitor_start") return started(7);
    if (command === "monitor_stop_all") return 0;
    return undefined;
  });
});

describe("MonitorSession", () => {
  it("does nothing until someone is looking, then starts once", async () => {
    await sweepStaleMonitors();
    const s = new MonitorSession("conn-1");
    s.sync();
    await settle(s);
    expect(calls("monitor_start")).toHaveLength(0);
    expect(s.status()).toEqual({ kind: "hidden" });
    s.setVisible(true);
    await settle(s);
    expect(calls("monitor_start")).toHaveLength(1);
    expect(calls("monitor_start")[0][1]).toEqual({ connectionId: "conn-1", options: { intervalMs: 1000, paused: false, activity: true, views: NO_VIEWS } });
    expect(s.status()).toEqual({ kind: "live" });
    expect(s.hasSampler()).toBe(true);
  });

  it("pauses the sampler, not just the drawing, when hidden or paused", async () => {
    const s = new MonitorSession("conn-1");
    s.setVisible(true);
    await settle(s);
    s.setVisible(false);
    await settle(s);
    expect(last("monitor_configure")).toEqual({ connectionId: "conn-1", generation: 7, options: { intervalMs: 1000, paused: true, activity: true, views: NO_VIEWS } });
    expect(s.status()).toEqual({ kind: "hidden" });
    s.setKeepSampling(true);
    await settle(s);
    expect(last("monitor_configure")).toMatchObject({ options: { paused: false } });
    s.pause();
    await settle(s);
    expect(last("monitor_configure")).toMatchObject({ options: { paused: true } });
    expect(s.status()).toEqual({ kind: "paused" });
    expect(s.frozen()).toBe(true);
  });

  it("starts a restored tab paused, with no sidecar until resumed", async () => {
    const s = new MonitorSession("conn-1", { paused: true });
    s.setVisible(true);
    await settle(s);
    expect(calls("monitor_start")).toHaveLength(0);
    expect(s.status()).toEqual({ kind: "paused" });
    s.resume();
    await settle(s);
    expect(calls("monitor_start")).toHaveLength(1);
  });

  it("ignores samples from another generation and reflects tick failures", async () => {
    const s = new MonitorSession("conn-1");
    s.setVisible(true);
    await settle(s);
    s.ingest(sample(6));
    expect(s.latest()).toBeNull();
    expect(s.data.load.size).toBe(0);
    s.ingest(sample(7));
    expect(s.latest()?.generation).toBe(7);
    expect(s.data.load.size).toBe(1);
    s.ingest(sample(7, { seq: 2, monoMs: 1010, status: "reconnecting", error: "connection refused" }));
    expect(s.status()).toEqual({ kind: "reconnecting", message: "connection refused" });
    s.ingest(sample(7, { seq: 3, monoMs: 2010 }));
    expect(s.status()).toEqual({ kind: "live" });
  });

  it("keeps a failed start visible and retries without leaving a sampler behind", async () => {
    vi.mocked(invoke).mockImplementationOnce(async () => {
      throw { message: "the database monitor needs PostgreSQL 10 or later" };
    });
    const s = new MonitorSession("conn-1");
    s.setVisible(true);
    await settle(s);
    expect(s.status()).toEqual({ kind: "error", message: "the database monitor needs PostgreSQL 10 or later" });
    expect(s.hasSampler()).toBe(false);
    s.retry();
    await settle(s);
    expect(s.status()).toEqual({ kind: "live" });
    s.retry();
    await settle(s);
    expect(last("monitor_stop")).toEqual({ connectionId: "conn-1", generation: 7 });
    expect(calls("monitor_start")).toHaveLength(3);
  });

  it("stops its sampler on dispose and refuses to signal without one", async () => {
    const s = new MonitorSession("conn-1");
    await expect(s.signal(9, "x", "cancel")).rejects.toThrow(/not running/);
    s.setVisible(true);
    await settle(s);
    s.dispose();
    expect(last("monitor_stop")).toEqual({ connectionId: "conn-1", generation: 7 });
    expect(s.isDisposed).toBe(true);
    s.ingest(sample(7));
    expect(s.data.load.size).toBe(0);
  });

  it("runs only the tiers the open view needs", async () => {
    const s = new MonitorSession("conn-1");
    s.setVisible(true);
    await settle(s);
    s.setView("statements");
    await settle(s);
    expect(last("monitor_configure")).toMatchObject({ options: { activity: false, views: { ...NO_VIEWS, statements: true } } });
    s.setView("locks");
    await settle(s);
    expect(last("monitor_configure")).toMatchObject({ options: { activity: true, views: { ...NO_VIEWS, locks: true } } });
    s.setVisible(false);
    s.setKeepSampling(true);
    await settle(s);
    expect(last("monitor_configure")).toMatchObject({ options: { paused: false, activity: true, views: NO_VIEWS } });
  });

  it("freezes on a dragged range and returns to live", () => {
    const s = new MonitorSession("conn-1");
    s.beginScrub(5000);
    s.moveScrub(1000);
    s.endScrub(500);
    expect(s.range()).toEqual({ t0: 1000, t1: 5000 });
    expect(s.frozen()).toBe(true);
    s.backToLive();
    expect(s.range()).toBeNull();
    s.beginScrub(5000);
    s.moveScrub(5100);
    s.endScrub(500);
    expect(s.range(), "a click is not a range").toBeNull();
  });

  it("keeps per-view data, statement snapshots and tier errors", async () => {
    const s = new MonitorSession("conn-1");
    s.setVisible(true);
    await settle(s);
    const statements = { seconds: 10, rows: [], totalCalls: 5, totalExecMs: 2, tracked: 3 };
    s.ingest(sample(7, { statements, viewErrors: { locks: "permission denied" } }));
    expect(s.statements()).toHaveLength(1);
    expect(s.viewErrors()).toEqual({ locks: "permission denied" });
    const locks = { waiting: [], waitingTotal: 0, held: [], heldTotal: 0, heldGroups: 0 };
    s.ingest(sample(7, { seq: 2, monoMs: 1010, locks }));
    expect(s.locks()).toEqual(locks);
    expect(s.viewErrors(), "an answer clears the tier's error").toEqual({});
  });
});

describe("tiersFor", () => {
  it("maps each view to its tiers", () => {
    expect(tiersFor("overview", true)).toEqual({ activity: true, views: NO_VIEWS });
    expect(tiersFor("io", true)).toEqual({ activity: false, views: { ...NO_VIEWS, io: true } });
    expect(tiersFor("tables", true).views.tables).toBe(true);
    expect(tiersFor("tables", false), "hidden: fast tier and process list only").toEqual({ activity: true, views: NO_VIEWS });
  });
});
