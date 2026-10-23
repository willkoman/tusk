/**
 * Database monitor model. Pure, vitest-covered (model.test.ts).
 *
 * The backend sends one `monitor-sample` event per tick with rates already computed
 * (src-tauri/src/monitor). This module turns that stream into fixed-capacity
 * `Float64Array` rings the canvas renderer reads directly every frame — no reactive
 * state on the hot path — and holds the other pure pieces the Monitor tab needs:
 * gap rules, the TPS moving average, unit formatting, thresholds, the server clock
 * offset behind live durations, and the blocking tree.
 */

/** Wait-event types in chart order; mirrors `WAIT_TYPES` in `src-tauri/src/monitor/pg.rs`. */
export const WAIT_TYPES = ["CPU", "Lock", "LWLock", "IO", "IPC", "Client", "Timeout", "BufferPin", "Activity", "Extension", "Other"] as const;

export type ServerInfo = {
  /** Which source answered: decides the tiles, charts and views (see engines.ts). */
  engine: "postgres" | "mysql" | "mssql";
  /** What the header calls the server: PostgreSQL, MySQL, MariaDB, SQL Server. */
  product: string;
  versionNum: number;
  version: string;
  /** The monitor's own backend pid (excluded from every count, never signalled). */
  pid: number;
  user: string;
  database: string;
  superuser: boolean;
  readAllStats: boolean;
  signalBackend: boolean;
  startedMs: number | null;
  maxConnections: number;
  blockSize: number;
  inRecovery: boolean;
  querySize: number;
  walStats: boolean;
  /** `pg_stat_statements` is installed and readable here. */
  statementsAvailable: boolean;
  /** Why it is not (shown on the Statements view). */
  statementsNote: string | null;
  /** EnterpriseDB's `system_stats` is installed and runnable: host metrics arrive. */
  hostStats?: boolean;
  /** Why host metrics are missing (PostgreSQL only). */
  hostStatsNote?: string | null;
};

export type MonitorStarted = {
  generation: number;
  intervalMs: number;
  /** The user's connection is read-only: Cancel/Terminate are refused. */
  readOnly: boolean;
  server: ServerInfo;
  waitTypes: string[];
};

export type MonitorRates = {
  tps: number;
  commits: number;
  rollbacks: number;
  blksRead: number;
  blksHit: number;
  cacheHit: number | null;
  tupReturned: number;
  tupFetched: number;
  tupInserted: number;
  tupUpdated: number;
  tupDeleted: number;
  tempBytes: number;
  walBytes: number | null;
  walFpi: number | null;
  buffersCheckpoint: number;
  buffersClean: number;
  buffersBackend: number | null;
  /** Counts of discrete events in the interval. */
  events: MonitorEventCounts;
};

export type MonitorEventCounts = {
  checkpointsTimed: number;
  checkpointsRequested: number;
  deadlocks: number;
  conflicts: number;
  tempFiles: number;
};

// --- view tiers (src-tauri/src/monitor/views.rs) ------------------------------

export type LockWait = {
  pid: number;
  backendStart: string;
  locktype: string;
  mode: string;
  target: string;
  user: string | null;
  database: string | null;
  application: string | null;
  state: string | null;
  /** How long it had waited when sampled (PostgreSQL 14+). */
  waitedMs: number | null;
  xactStartMs: number | null;
  blockedBy: number[];
  query: string | null;
};
export type LockHold = { locktype: string; mode: string; target: string; count: number; pids: number[] };
export type MonitorLocks = { waiting: LockWait[]; waitingTotal: number; held: LockHold[]; heldTotal: number; heldGroups: number };

export type Replica = {
  pid: number;
  application: string | null;
  client: string | null;
  state: string | null;
  syncState: string | null;
  sentBytes: number | null;
  writeBytes: number | null;
  flushBytes: number | null;
  replayBytes: number | null;
  writeLagMs: number | null;
  flushLagMs: number | null;
  replayLagMs: number | null;
};
export type ReplicationSlot = {
  name: string;
  slotType: string | null;
  plugin: string | null;
  database: string | null;
  active: boolean;
  activePid: number | null;
  retainedBytes: number | null;
  walStatus: string | null;
  safeWalSize: number | null;
};
export type WalReceiver = {
  status: string | null;
  sender: string | null;
  replayBacklogBytes: number | null;
  lastMessageMs: number | null;
  replayPaused: boolean;
  replayAgeMs: number | null;
};
export type MonitorReplication = { standby: boolean; replicas: Replica[]; slots: ReplicationSlot[]; receiver: WalReceiver | null };

export type ProgressRow = {
  kind: string;
  pid: number;
  backendStart: string | null;
  database: string | null;
  relation: string | null;
  phase: string | null;
  done: number | null;
  total: number | null;
  unit: string;
  startedMs: number | null;
  query: string | null;
};

export type TableStat = {
  schema: string;
  name: string;
  live: number | null;
  dead: number | null;
  modified: number | null;
  lastVacuumMs: number | null;
  lastAutovacuumMs: number | null;
  lastAnalyzeMs: number | null;
  lastAutoanalyzeMs: number | null;
  vacuumCount: number | null;
  autovacuumCount: number | null;
  sizeBytes: number | null;
};
export type DatabaseAge = { database: string; xidAge: number; mxidAge: number | null };
export type MonitorMaintenance = { tables: TableStat[]; tablesTotal: number; wraparound: DatabaseAge[]; freezeMaxAge: number | null };

export type IoRow = {
  backendType: string;
  object: string;
  context: string;
  reads: number;
  writes: number;
  extends: number;
  hits: number;
  evictions: number;
  reuses: number;
  fsyncs: number;
};
export type MonitorIo = { seconds: number; rows: IoRow[] };

export type StatementDelta = {
  key: string;
  queryid: string;
  user: string | null;
  database: string | null;
  calls: number;
  execMs: number;
  rows: number;
  sharedHits: number;
  sharedReads: number;
  query: string | null;
};
export type MonitorStatements = { seconds: number; rows: StatementDelta[]; totalCalls: number; totalExecMs: number; tracked: number };

export type MonitorSessions = {
  active: number;
  idle: number;
  idleInTransaction: number;
  idleInTransactionAborted: number;
  other: number;
  hidden: number;
  total: number;
  maxConnections: number;
};

export type ActivityRow = {
  pid: number;
  /** `backend_start::text`: with the pid, the row's identity (a reused pid is a new row). */
  backendStart: string;
  backendStartMs: number | null;
  user: string | null;
  database: string | null;
  application: string | null;
  client: string | null;
  backendType: string | null;
  state: string | null;
  waitType: string | null;
  waitEvent: string | null;
  xactStartMs: number | null;
  queryStartMs: number | null;
  stateChangeMs: number | null;
  blockedBy: number[];
  query: string | null;
  queryTruncated: boolean;
};

export type MonitorActivity = { rows: ActivityRow[]; total: number };

export type MonitorSample = {
  connectionId: string;
  generation: number;
  seq: number;
  monoMs: number;
  serverMs: number | null;
  latencyMs: number;
  intervalMs: number;
  status: "live" | "error" | "reconnecting";
  error: string | null;
  reset: boolean;
  rates: MonitorRates | null;
  sessions: MonitorSessions | null;
  load: number[] | null;
  oldestXactMs: number | null;
  blocked: number | null;
  replicationLagMs: number | null;
  activity: MonitorActivity | null;
  activityError: string | null;
  locks: MonitorLocks | null;
  replication: MonitorReplication | null;
  progress: ProgressRow[] | null;
  maintenance: MonitorMaintenance | null;
  io: MonitorIo | null;
  statements: MonitorStatements | null;
  /** `system_stats` host metrics, every 5 s when available. */
  host?: HostSample | null;
  /** A view tier that failed this tick, by tier name. */
  viewErrors: Record<string, string> | null;
};

/** The database server's machine, from `system_stats` (src-tauri/src/monitor/host.rs). */
export type HostSample = {
  cpuBusyPct: number | null;
  cpuIowaitPct: number | null;
  memTotal: number | null;
  /** In use by processes (excluding the page cache). */
  memUsed: number | null;
  memCache: number | null;
  swapUsed: number | null;
  load1: number | null;
  diskRead: number | null;
  diskWrite: number | null;
  netRx: number | null;
  netTx: number | null;
};

/** A host reading older than this is no longer shown on the tiles. */
export const HOST_STALE_MS = 15_000;

/**
 * A ring of `capacity` rows, each a timestamp plus `width` values. NaN in a value row
 * is a gap (drawn as a break, never interpolated). Timestamps must be non-decreasing.
 */
export class SeriesBuffer {
  readonly t: Float64Array;
  readonly v: Float64Array;
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number, readonly width: number) {
    this.t = new Float64Array(capacity);
    this.v = new Float64Array(capacity * width);
  }

  get size(): number {
    return this.count;
  }

  /** Physical row of logical index `i` (0 = oldest). */
  row(i: number): number {
    return (this.head - this.count + i + this.capacity) % this.capacity;
  }

  time(i: number): number {
    return this.t[this.row(i)];
  }

  value(i: number, series: number): number {
    return this.v[this.row(i) * this.width + series];
  }

  /** The newest row's time, or NaN when empty. */
  lastTime(): number {
    return this.count ? this.time(this.count - 1) : NaN;
  }

  push(t: number, values: ArrayLike<number>): void {
    const r = this.head;
    this.t[r] = t;
    const base = r * this.width;
    for (let k = 0; k < this.width; k++) {
      const x = k < values.length ? values[k] : NaN;
      // Only finite numbers are data; anything else is a gap cell.
      this.v[base + k] = Number.isFinite(x) ? x : NaN;
    }
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** A gap row: every series NaN at `t`. */
  gap(t: number): void {
    this.push(t, []);
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  /** First logical index with time >= `t` (binary search; `size` when none). */
  lowerBound(t: number): number {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.time(mid) < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * The row a crosshair at `t` reads: the newest row at or before `t`, unless that
   * is more than `maxGap` older (then nothing — the pointer is over a gap or before
   * the data). -1 when no row qualifies.
   */
  at(t: number, maxGap: number): number {
    const i = this.lowerBound(t + 1e-6) - 1;
    if (i < 0) return -1;
    return t - this.time(i) <= maxGap ? i : -1;
  }
}

/**
 * Maps the backend's monotonic `monoMs` onto `performance.now()`. The offset is the
 * smallest `arrival - monoMs` seen, so IPC jitter only ever delays arrival and never
 * moves points: their spacing is the sampler's, not the event loop's. One map per
 * monitor generation — a new generation's clock starts again at zero.
 */
export class ClockMap {
  private offset = Infinity;
  toLocal(monoMs: number, arrival: number): number {
    const candidate = arrival - monoMs;
    if (candidate < this.offset) this.offset = candidate;
    return monoMs + this.offset;
  }
  reset(): void {
    this.offset = Infinity;
  }
}

/**
 * The server's wall clock as seen from here, for durations that tick between activity
 * samples. Each sample carries the server's `clock_timestamp()`; `serverMs - arrival`
 * underestimates the offset by however long the reply took to arrive, so the largest
 * of the recent candidates is the best one. A server whose clock is minutes off ours
 * still shows a query that started two seconds ago as two seconds old.
 */
export class ServerClock {
  private readonly ring: number[] = [];
  private offset = 0;
  private known = false;

  constructor(private readonly keep = 30) {}

  observe(serverMs: number | null, arrivalWallMs: number): void {
    if (serverMs === null || !Number.isFinite(serverMs)) return;
    this.ring.push(serverMs - arrivalWallMs);
    if (this.ring.length > this.keep) this.ring.shift();
    this.offset = Math.max(...this.ring);
    this.known = true;
  }

  /** The server's time now, given our wall clock (identity until a sample arrives). */
  now(wallMs: number): number {
    return wallMs + (this.known ? this.offset : 0);
  }
}

/** Live duration from a server-side start time; never negative. */
export function liveDuration(startMs: number | null, serverNowMs: number): number | null {
  if (startMs === null || !Number.isFinite(startMs)) return null;
  return Math.max(0, serverNowMs - startMs);
}

// --- series layout -----------------------------------------------------------

export const SESSION_SERIES = ["Active", "Idle in transaction", "Idle in transaction (aborted)", "Idle", "Other"] as const;
export const TPS_SERIES = ["Commits", "Rollbacks", "Average (10 s)"] as const;
export const TUP_WRITE_SERIES = ["Inserted", "Updated", "Deleted"] as const;
export const TUP_READ_SERIES = ["Fetched", "Returned"] as const;
export const IO_SERIES = ["Hit", "Read", "Temp files"] as const;
export const WAL_SERIES = ["WAL"] as const;
export const FPI_SERIES = ["Full-page images"] as const;
export const WRITES_SERIES = ["Checkpointer", "Background writer", "Backends"] as const;
export const HOST_CPU_SERIES = ["Busy", "I/O wait"] as const;
export const HOST_IO_SERIES = ["Disk read", "Disk write", "Network in", "Network out"] as const;
/** Tile sparkline sources, one column each. */
export const TILE_KEYS = ["load", "sessions", "tps", "cacheHit", "wal", "oldestXact", "blocked", "lag", "hostCpu", "hostMem"] as const;
export type TileKey = (typeof TILE_KEYS)[number];
export const tileIndex = (key: TileKey) => TILE_KEYS.indexOf(key);

/** Rows each ring keeps: a full hour at 1 s plus room for gap rows. */
export const CAPACITY = 4096;
/** The moving average shown beside raw TPS (spike finding 6: 1 s TPS swings ±40%). */
export const TPS_AVERAGE_MS = 10_000;

/**
 * Every ring one monitor draws from. `sessions` carries the max_connections ceiling
 * as its last column; it is drawn as a line, never stacked.
 */
export class MonitorData {
  readonly load: SeriesBuffer;
  readonly sessions: SeriesBuffer;
  readonly tps: SeriesBuffer;
  readonly tupWrite: SeriesBuffer;
  readonly tupRead: SeriesBuffer;
  readonly io: SeriesBuffer;
  readonly wal: SeriesBuffer;
  readonly fpi: SeriesBuffer;
  /** Buffers written per second by the checkpointer, the bgwriter and backends, as bytes. */
  readonly writes: SeriesBuffer;
  /** Host CPU busy / I/O wait (%) and disk / network bytes per second, every 5 s. */
  readonly hostCpu: SeriesBuffer;
  readonly hostIo: SeriesBuffer;
  /** The newest host reading and when it arrived. */
  lastHost: { t: number; host: HostSample } | null = null;
  readonly events = new EventRing(EVENT_CAPACITY);
  readonly tiles: SeriesBuffer;
  private lastT: number | null = null;
  private readonly avg: { t: number; tps: number }[] = [];

  constructor(readonly capacity = CAPACITY) {
    this.load = new SeriesBuffer(capacity, WAIT_TYPES.length);
    this.sessions = new SeriesBuffer(capacity, SESSION_SERIES.length + 1);
    this.tps = new SeriesBuffer(capacity, TPS_SERIES.length);
    this.tupWrite = new SeriesBuffer(capacity, TUP_WRITE_SERIES.length);
    this.tupRead = new SeriesBuffer(capacity, TUP_READ_SERIES.length);
    this.io = new SeriesBuffer(capacity, IO_SERIES.length);
    this.wal = new SeriesBuffer(capacity, WAL_SERIES.length);
    this.fpi = new SeriesBuffer(capacity, FPI_SERIES.length);
    this.writes = new SeriesBuffer(capacity, WRITES_SERIES.length);
    this.tiles = new SeriesBuffer(capacity, TILE_KEYS.length);
    this.hostCpu = new SeriesBuffer(capacity, HOST_CPU_SERIES.length);
    this.hostIo = new SeriesBuffer(capacity, HOST_IO_SERIES.length);
  }

  private all(): SeriesBuffer[] {
    return [this.load, this.sessions, this.tps, this.tupWrite, this.tupRead, this.io, this.wal, this.fpi, this.writes, this.tiles, this.hostCpu, this.hostIo];
  }

  private rateBuffers(): SeriesBuffer[] {
    return [this.tps, this.tupWrite, this.tupRead, this.io, this.wal, this.fpi, this.writes];
  }

  /** The newest sample's local time, or null before the first. */
  get last(): number | null {
    return this.lastT;
  }

  clear(): void {
    for (const b of this.all()) b.clear();
    this.events.clear();
    this.lastT = null;
    this.lastHost = null;
    this.avg.length = 0;
  }

  /**
   * Feed one sample read at local time `t` (ms, performance.now() domain).
   *
   * - A tick the sampler skipped, or a pause, shows up as a jump beyond 1.5 intervals
   *   and becomes a gap row first, so the break is drawn where the data stopped.
   * - An error or reconnecting tick is a gap everywhere.
   * - A baseline (no rates yet) or a counter reset is a gap in the rate series only;
   *   the session and load gauges are still good readings.
   */
  ingest(sample: MonitorSample, t: number, blockSize: number): void {
    if (this.lastT !== null && t < this.lastT) t = this.lastT;
    const interval = Math.max(1, sample.intervalMs);
    if (this.lastT !== null && t - this.lastT > interval * 1.5) {
      const at = this.lastT + interval;
      for (const b of this.all()) b.gap(at);
      this.avg.length = 0;
    }
    this.lastT = t;
    if (sample.status !== "live") {
      for (const b of this.all()) b.gap(t);
      this.avg.length = 0;
      return;
    }
    const s = sample.sessions;
    const load = sample.load;
    load ? this.load.push(t, load) : this.load.gap(t);
    s
      ? this.sessions.push(t, [s.active, s.idleInTransaction, s.idleInTransactionAborted, s.idle, s.other + s.hidden, s.maxConnections])
      : this.sessions.gap(t);
    if (sample.reset) this.events.push(t, "reset", 1);
    const r = sample.reset ? null : sample.rates;
    if (r) {
      this.avg.push({ t, tps: r.tps });
      while (this.avg.length && this.avg[0].t <= t - TPS_AVERAGE_MS) this.avg.shift();
      const mean = this.avg.reduce((a, x) => a + x.tps, 0) / this.avg.length;
      this.tps.push(t, [r.commits, r.rollbacks, mean]);
      this.tupWrite.push(t, [r.tupInserted, r.tupUpdated, r.tupDeleted]);
      this.tupRead.push(t, [r.tupFetched, r.tupReturned]);
      this.io.push(t, [r.blksHit * blockSize, r.blksRead * blockSize, r.tempBytes]);
      this.wal.push(t, [r.walBytes ?? NaN]);
      this.fpi.push(t, [r.walFpi ?? NaN]);
      this.writes.push(t, [r.buffersCheckpoint * blockSize, r.buffersClean * blockSize, r.buffersBackend === null ? NaN : r.buffersBackend * blockSize]);
      const ev = r.events;
      if (ev.checkpointsTimed) this.events.push(t, "checkpoint", ev.checkpointsTimed);
      if (ev.checkpointsRequested) this.events.push(t, "checkpoint-requested", ev.checkpointsRequested);
      if (ev.deadlocks) this.events.push(t, "deadlock", ev.deadlocks);
      if (ev.conflicts) this.events.push(t, "conflict", ev.conflicts);
      if (ev.tempFiles) this.events.push(t, "temp-file", ev.tempFiles);
    } else {
      for (const b of this.rateBuffers()) b.gap(t);
      this.avg.length = 0;
    }
    // Host readings come every few ticks; only those ticks add a point.
    const h = sample.host;
    if (h) {
      const n = (v: number | null) => (v === null ? NaN : v);
      this.hostCpu.push(t, [n(h.cpuBusyPct), n(h.cpuIowaitPct)]);
      this.hostIo.push(t, [n(h.diskRead), n(h.diskWrite), n(h.netRx), n(h.netTx)]);
      this.lastHost = { t, host: h };
    }
    const fresh = this.lastHost && t - this.lastHost.t <= HOST_STALE_MS ? this.lastHost.host : null;
    const loadSum = load ? load.reduce((a, x) => a + x, 0) : NaN;
    this.tiles.push(t, [
      loadSum,
      s ? s.total : NaN,
      r ? r.tps : NaN,
      r?.cacheHit ?? NaN,
      r?.walBytes ?? NaN,
      sample.oldestXactMs ?? NaN,
      sample.blocked ?? NaN,
      sample.replicationLagMs ?? NaN,
      fresh?.cpuBusyPct ?? NaN,
      fresh && fresh.memUsed !== null && fresh.memTotal ? (fresh.memUsed / fresh.memTotal) * 100 : NaN,
    ]);
  }
}

// --- events ----------------------------------------------------------------------

/** Discrete things that happened, drawn as markers on the shared time axis. */
export const EVENT_KINDS = ["checkpoint", "checkpoint-requested", "deadlock", "conflict", "temp-file", "reset"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const EVENT_LABELS: Record<EventKind, string> = {
  checkpoint: "Checkpoint",
  "checkpoint-requested": "Requested checkpoint",
  deadlock: "Deadlock",
  conflict: "Recovery conflict",
  "temp-file": "Temp files",
  reset: "Statistics reset",
};
export const EVENT_CAPACITY = 2048;

/** A ring of (time, kind, count) markers, oldest first. */
export class EventRing {
  private readonly t: Float64Array;
  private readonly kind: Uint8Array;
  private readonly count: Uint32Array;
  private head = 0;
  private n = 0;

  constructor(readonly capacity: number) {
    this.t = new Float64Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.count = new Uint32Array(capacity);
  }

  get size(): number {
    return this.n;
  }

  push(t: number, kind: EventKind, count: number): void {
    this.t[this.head] = t;
    this.kind[this.head] = EVENT_KINDS.indexOf(kind);
    this.count[this.head] = Math.max(1, Math.min(count, 0xffffffff));
    this.head = (this.head + 1) % this.capacity;
    if (this.n < this.capacity) this.n++;
  }

  clear(): void {
    this.head = 0;
    this.n = 0;
  }

  /** Every marker in [from, to], oldest first. */
  between(from: number, to: number): { t: number; kind: EventKind; count: number }[] {
    const out: { t: number; kind: EventKind; count: number }[] = [];
    for (let i = 0; i < this.n; i++) {
      const r = (this.head - this.n + i + this.capacity) % this.capacity;
      const t = this.t[r];
      if (t < from || t > to) continue;
      out.push({ t, kind: EVENT_KINDS[this.kind[r]], count: this.count[r] });
    }
    return out;
  }
}

/** Marker totals per kind over a list of events. */
export function eventTotals(events: { kind: EventKind; count: number }[]): Record<EventKind, number> {
  const out = Object.fromEntries(EVENT_KINDS.map((k) => [k, 0])) as Record<EventKind, number>;
  for (const e of events) out[e.kind] += e.count;
  return out;
}

// --- statements over a window ---------------------------------------------------

export type StatementSnapshot = MonitorStatements & { t: number };

export type StatementTotal = {
  key: string;
  queryid: string;
  query: string | null;
  user: string | null;
  database: string | null;
  calls: number;
  execMs: number;
  rows: number;
  sharedHits: number;
  sharedReads: number;
};

export type StatementWindow = {
  rows: StatementTotal[];
  /** Seconds the snapshots in the window cover. */
  seconds: number;
  totalCalls: number;
  totalExecMs: number;
};

/**
 * Sum every interval snapshot at or after `fromT` per statement, newest text
 * winning, ordered by total time. A statement outside one interval's top list
 * contributes nothing for that interval, so this ranks what dominated, not every
 * call.
 */
export function aggregateStatements(snapshots: readonly StatementSnapshot[], fromT: number, toT = Infinity): StatementWindow {
  const by = new Map<string, StatementTotal>();
  let seconds = 0;
  let totalCalls = 0;
  let totalExecMs = 0;
  for (const snap of snapshots) {
    if (snap.t < fromT || snap.t > toT) continue;
    seconds += snap.seconds;
    totalCalls += snap.totalCalls;
    totalExecMs += snap.totalExecMs;
    for (const r of snap.rows) {
      const cur = by.get(r.key);
      if (!cur) {
        by.set(r.key, {
          key: r.key,
          queryid: r.queryid,
          query: r.query,
          user: r.user,
          database: r.database,
          calls: r.calls,
          execMs: r.execMs,
          rows: r.rows,
          sharedHits: r.sharedHits,
          sharedReads: r.sharedReads,
        });
        continue;
      }
      cur.calls += r.calls;
      cur.execMs += r.execMs;
      cur.rows += r.rows;
      cur.sharedHits += r.sharedHits;
      cur.sharedReads += r.sharedReads;
      if (r.query) cur.query = r.query;
      if (r.user) cur.user = r.user;
      if (r.database) cur.database = r.database;
    }
  }
  const rows = [...by.values()].sort((a, b) => b.execMs - a.execMs || b.calls - a.calls);
  return { rows, seconds, totalCalls, totalExecMs };
}

// --- activity at a past instant (scrub-and-freeze) -------------------------------

/** What one activity sample said about one active session, kept for scrubbing. */
export type ActiveSighting = {
  key: string;
  pid: number;
  user: string | null;
  database: string | null;
  waitType: string | null;
  waitEvent: string | null;
  /** Query age when sampled. */
  ageMs: number | null;
  query: string | null;
};
export type ActivityMoment = { t: number; rows: ActiveSighting[] };

/** Sessions kept per activity sample: the longest-running active client queries. */
export const MOMENT_TOP = 10;
export const MOMENT_CAPACITY = 1800;

/** The compact record a scrub can look back at, from one activity sample. */
export function activityMoment(rows: readonly ActivityRow[], t: number, serverMs: number | null): ActivityMoment {
  const active = rows
    .filter((r) => r.state === "active" && isClientBackend(r))
    .sort((a, b) => (a.queryStartMs ?? Infinity) - (b.queryStartMs ?? Infinity))
    .slice(0, MOMENT_TOP)
    .map((r) => ({
      key: rowKey(r),
      pid: r.pid,
      user: r.user,
      database: r.database,
      waitType: r.waitType,
      waitEvent: r.waitEvent,
      ageMs: serverMs !== null && r.queryStartMs !== null ? Math.max(0, serverMs - r.queryStartMs) : null,
      query: r.query && r.query.length > 300 ? `${r.query.slice(0, 300)}…` : r.query,
    }));
  return { t, rows: active };
}

export type RangeSession = {
  key: string;
  pid: number;
  user: string | null;
  database: string | null;
  query: string | null;
  /** Activity samples it was active in. */
  seen: number;
  /** The longest query age observed. */
  longestMs: number | null;
  /** Wait labels observed, most frequent first. */
  waits: string[];
};

/** The sessions that were active during [from, to], longest-running first. */
export function summarizeRange(moments: readonly ActivityMoment[], from: number, to: number): { sessions: RangeSession[]; samples: number } {
  const by = new Map<string, RangeSession & { waitCounts: Map<string, number> }>();
  let samples = 0;
  for (const m of moments) {
    if (m.t < from || m.t > to) continue;
    samples++;
    for (const r of m.rows) {
      let cur = by.get(r.key);
      if (!cur) {
        cur = { key: r.key, pid: r.pid, user: r.user, database: r.database, query: r.query, seen: 0, longestMs: null, waits: [], waitCounts: new Map() };
        by.set(r.key, cur);
      }
      cur.seen++;
      if (r.ageMs !== null) cur.longestMs = Math.max(cur.longestMs ?? 0, r.ageMs);
      if (r.query) cur.query = r.query;
      const w = waitLabel(r) || "CPU";
      cur.waitCounts.set(w, (cur.waitCounts.get(w) ?? 0) + 1);
    }
  }
  const sessions = [...by.values()]
    .map(({ waitCounts, ...rest }) => ({ ...rest, waits: [...waitCounts.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w) }))
    .sort((a, b) => (b.longestMs ?? -1) - (a.longestMs ?? -1) || b.seen - a.seen);
  return { sessions, samples };
}

/** Transaction-ID wraparound: the server stops at 2^31 - 3,000,000; warn well before. */
export const XID_WRAP_LIMIT = 2 ** 31;
export function wraparoundTone(xidAge: number, freezeMaxAge: number | null, t: MonitorThresholds = DEFAULT_THRESHOLDS): Tone {
  if (XID_WRAP_LIMIT - xidAge < t.wraparoundDangerHeadroomM * 1_000_000) return "danger";
  if (freezeMaxAge !== null && xidAge > freezeMaxAge) return "warn";
  return "";
}

/** A replication slot that holds WAL nobody consumes, or has lost it. */
export function slotTone(slot: Pick<ReplicationSlot, "active" | "walStatus" | "retainedBytes">, t: MonitorThresholds = DEFAULT_THRESHOLDS): Tone {
  if (slot.walStatus === "lost") return "danger";
  if (slot.walStatus === "unreserved" || slot.walStatus === "extended") return "warn";
  if (!slot.active && t.slotRetainedWarnGiB > 0 && (slot.retainedBytes ?? 0) > t.slotRetainedWarnGiB * 1024 ** 3) return "warn";
  return "";
}

// --- formatting ----------------------------------------------------------------

/** The smallest 1/2/2.5/5 × 10^k at or above `v` (1 for non-positive input). */
export function niceCeil(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * base >= v * (1 - 1e-9)) return m * base;
  }
  return 10 * base;
}

/** Compact counts: 950, 1.2k, 3.4M. */
export function formatCompact(v: number): string {
  if (!Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(a >= 1e10 ? 0 : 1)}G`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  if (a >= 10 || Number.isInteger(v)) return v.toFixed(0);
  if (a >= 1) return v.toFixed(1);
  return String(Number(v.toFixed(2)));
}

/** Binary byte sizes: 512 B, 4.1 MiB. */
export function formatBytes(v: number): string {
  if (!Number.isFinite(v)) return "–";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let x = Math.abs(v);
  let u = 0;
  while (x >= 1024 && u < units.length - 1) {
    x /= 1024;
    u++;
  }
  const n = u === 0 || x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
  return `${v < 0 ? "-" : ""}${n} ${units[u]}`;
}

/** Bytes for an axis label: short enough for the gutter, units in the title. 5M, 512K, 1.5G. */
export function formatBytesAxis(v: number): string {
  if (!Number.isFinite(v)) return "–";
  const units = ["", "K", "M", "G", "T"];
  let x = Math.abs(v);
  let u = 0;
  while (x >= 1024 && u < units.length - 1) {
    x /= 1024;
    u++;
  }
  const n = x >= 10 || Number.isInteger(x) ? x.toFixed(0) : x.toFixed(1);
  return `${v < 0 ? "-" : ""}${n}${units[u]}`;
}

export const formatRate = (v: number) => (Number.isFinite(v) ? `${formatCompact(v)}/s` : "–");
export const formatByteRate = (v: number) => (Number.isFinite(v) ? `${formatBytes(v)}/s` : "–");

export function formatPercent(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return "–";
  const p = ratio * 100;
  return `${p >= 99.95 || p === 0 ? p.toFixed(0) : p >= 10 ? p.toFixed(1) : p.toFixed(2)}%`;
}

/** A duration for a table cell or tile: 0:07, 3:12, 1:04:05, 2 d 3 h. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "–";
  const s = Math.floor(Math.max(0, ms) / 1000);
  const d = Math.floor(s / 86_400);
  if (d >= 1) return `${d} d ${Math.floor((s % 86_400) / 3600)} h`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

/** How long ago, in words: "47 s ago", "13 min ago", "2 h ago", "3 d ago". */
export function formatAgo(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "never";
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${Math.floor(s)} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** A window length for labels: "1 min", "5 min", "1 h". */
export function formatWindow(ms: number): string {
  return ms >= 3_600_000 ? `${ms / 3_600_000} h` : `${Math.round(ms / 60_000)} min`;
}

/** Uptime for the header: "up 41 d", "up 3 h", "up 12 min". */
export function formatUptime(startedMs: number | null, serverNowMs: number): string {
  if (startedMs === null) return "";
  const s = Math.max(0, (serverNowMs - startedMs) / 1000);
  if (s >= 86_400) return `up ${Math.floor(s / 86_400)} d`;
  if (s >= 3600) return `up ${Math.floor(s / 3600)} h`;
  return `up ${Math.max(1, Math.floor(s / 60))} min`;
}

// --- thresholds ------------------------------------------------------------------

/** Amber = needs attention, red = trouble. Green is never "healthy" in this app. */
export type Tone = "" | "warn" | "danger";

/**
 * Where the tiles and lists turn amber or red. Set in Settings → Monitor and shared
 * by every Monitor tab; 0 switches an optional one off.
 */
export type MonitorThresholds = {
  /** Share of max_connections in use. */
  sessionsWarnPct: number;
  sessionsDangerPct: number;
  /** Age of the oldest open transaction, minutes. */
  oldestXactWarnMin: number;
  oldestXactDangerMin: number;
  /** Blocked sessions at or above this count (0 = off). */
  blockedWarn: number;
  /** Replication lag, seconds (0 = off). */
  lagWarnSec: number;
  /** Cache hit below this percentage (0 = off). */
  cacheHitWarnPct: number;
  /** WAL an inactive replication slot retains, GiB (0 = off). */
  slotRetainedWarnGiB: number;
  /** Transaction-ID headroom left before wraparound, millions of transactions. */
  wraparoundDangerHeadroomM: number;
};

export const DEFAULT_THRESHOLDS: MonitorThresholds = {
  sessionsWarnPct: 80,
  sessionsDangerPct: 95,
  oldestXactWarnMin: 5,
  oldestXactDangerMin: 60,
  blockedWarn: 1,
  lagWarnSec: 60,
  cacheHitWarnPct: 0,
  slotRetainedWarnGiB: 1,
  wraparoundDangerHeadroomM: 500,
};

/** Accept only sane numbers (persisted or typed); a warning never sits above its danger level. */
export function normalizeThresholds(v: unknown): MonitorThresholds {
  const src = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const pick = (key: keyof MonitorThresholds, min: number, max: number) => {
    const x = src[key];
    return typeof x === "number" && Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : DEFAULT_THRESHOLDS[key];
  };
  const out: MonitorThresholds = {
    sessionsWarnPct: pick("sessionsWarnPct", 1, 100),
    sessionsDangerPct: pick("sessionsDangerPct", 1, 100),
    oldestXactWarnMin: pick("oldestXactWarnMin", 0.1, 10_080),
    oldestXactDangerMin: pick("oldestXactDangerMin", 0.1, 10_080),
    blockedWarn: Math.round(pick("blockedWarn", 0, 100_000)),
    lagWarnSec: pick("lagWarnSec", 0, 86_400),
    cacheHitWarnPct: pick("cacheHitWarnPct", 0, 100),
    slotRetainedWarnGiB: pick("slotRetainedWarnGiB", 0, 100_000),
    wraparoundDangerHeadroomM: pick("wraparoundDangerHeadroomM", 1, 2_000),
  };
  if (out.sessionsWarnPct > out.sessionsDangerPct) out.sessionsWarnPct = out.sessionsDangerPct;
  if (out.oldestXactWarnMin > out.oldestXactDangerMin) out.oldestXactWarnMin = out.oldestXactDangerMin;
  return out;
}

export function sessionsTone(total: number, max: number, t: MonitorThresholds = DEFAULT_THRESHOLDS): Tone {
  if (!(max > 0)) return "";
  const share = (total / max) * 100;
  return share >= t.sessionsDangerPct ? "danger" : share >= t.sessionsWarnPct ? "warn" : "";
}

export function oldestTransactionTone(ms: number | null, t: MonitorThresholds = DEFAULT_THRESHOLDS): Tone {
  if (ms === null) return "";
  return ms > t.oldestXactDangerMin * 60_000 ? "danger" : ms > t.oldestXactWarnMin * 60_000 ? "warn" : "";
}

export function blockedTone(n: number | null, t: MonitorThresholds = DEFAULT_THRESHOLDS): Tone {
  return n !== null && t.blockedWarn > 0 && n >= t.blockedWarn ? "warn" : "";
}

export function replicationLagTone(ms: number | null, t: MonitorThresholds = DEFAULT_THRESHOLDS): Tone {
  return ms !== null && t.lagWarnSec > 0 && ms > t.lagWarnSec * 1000 ? "warn" : "";
}

export function cacheHitTone(ratio: number | null, t: MonitorThresholds = DEFAULT_THRESHOLDS): Tone {
  return ratio !== null && t.cacheHitWarnPct > 0 && ratio * 100 < t.cacheHitWarnPct ? "warn" : "";
}

// --- the process list -------------------------------------------------------------

/** A row's identity: a pid the server reused for a new session is a new row. */
export const rowKey = (r: Pick<ActivityRow, "pid" | "backendStart">) => `${r.pid}@${r.backendStart}`;

export const isClientBackend = (r: ActivityRow) => r.backendType === null || r.backendType === "client backend";

/** What a row's text shows when this role may not see another role's query. */
export const HIDDEN_QUERY = "<insufficient privilege>";

export type ActivityFilter = {
  hideIdle: boolean;
  hideBackground: boolean;
  thisDatabase: boolean;
  myUser: boolean;
  text: string;
};

export const DEFAULT_ACTIVITY_FILTER: ActivityFilter = {
  hideIdle: true,
  hideBackground: true,
  thisDatabase: false,
  myUser: false,
  text: "",
};

export function matchesFilter(r: ActivityRow, f: ActivityFilter, me: { user: string; database: string }): boolean {
  if (f.hideIdle && r.state === "idle") return false;
  if (f.hideBackground && !isClientBackend(r)) return false;
  if (f.thisDatabase && r.database !== me.database) return false;
  if (f.myUser && r.user !== me.user) return false;
  const q = f.text.trim().toLowerCase();
  if (q) {
    const hay = `${r.pid} ${r.query ?? ""} ${r.application ?? ""} ${r.user ?? ""} ${r.database ?? ""} ${r.client ?? ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export type SortKey = "pid" | "user" | "database" | "application" | "client" | "backendType" | "state" | "wait" | "xact" | "query" | "blockedBy" | "text";
export type ActivitySort = { key: SortKey; dir: "asc" | "desc" } | null;

/** The time a row's "query age" counts from: an active query's start, else its last state change. */
export const queryAgeStart = (r: ActivityRow) => (r.state === "active" ? r.queryStartMs : r.stateChangeMs ?? r.queryStartMs);

/**
 * Row order. `null` is the default — active first, then the longest-running query —
 * which is what "what is hurting right now" means. Ages compare by START time
 * (earlier = longer), so the order is stable between ticks of the live clock.
 */
export function compareRows(a: ActivityRow, b: ActivityRow, sort: ActivitySort): number {
  if (!sort) {
    const aa = a.state === "active" ? 0 : 1;
    const ba = b.state === "active" ? 0 : 1;
    if (aa !== ba) return aa - ba;
    return startAsc(queryAgeStart(a), queryAgeStart(b)) || a.pid - b.pid;
  }
  const dir = sort.dir === "asc" ? 1 : -1;
  const text = (x: string | null) => (x ?? "").toLowerCase();
  let c = 0;
  switch (sort.key) {
    case "pid": c = a.pid - b.pid; break;
    case "user": c = text(a.user).localeCompare(text(b.user)); break;
    case "database": c = text(a.database).localeCompare(text(b.database)); break;
    case "application": c = text(a.application).localeCompare(text(b.application)); break;
    case "client": c = text(a.client).localeCompare(text(b.client)); break;
    case "backendType": c = text(a.backendType).localeCompare(text(b.backendType)); break;
    case "state": c = text(a.state).localeCompare(text(b.state)); break;
    case "wait": c = text(waitLabel(a)).localeCompare(text(waitLabel(b))); break;
    // Ages: ascending = shortest first = LATEST start first.
    case "xact": return -startAsc(a.xactStartMs, b.xactStartMs) * dir || a.pid - b.pid;
    case "query": return -startAsc(queryAgeStart(a), queryAgeStart(b)) * dir || a.pid - b.pid;
    case "blockedBy": c = a.blockedBy.length - b.blockedBy.length; break;
    case "text": c = text(a.query).localeCompare(text(b.query)); break;
  }
  return c * dir || a.pid - b.pid;
}

/** Earlier start first; a missing start sorts last in either direction of the caller's flip. */
function startAsc(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

export function waitLabel(r: Pick<ActivityRow, "waitType" | "waitEvent">): string {
  if (!r.waitType) return "";
  return r.waitEvent ? `${r.waitType}: ${r.waitEvent}` : r.waitType;
}

export type ActivityNode = {
  row: ActivityRow;
  /** Nesting under its blocker (0 = top level). */
  depth: number;
  /** Sessions directly waiting on this one. */
  blocks: number;
  /** Blocks others while waiting on nobody visible: where a chain starts. */
  rootBlocker: boolean;
  /** Part of a wait cycle (a deadlock the server has not broken yet). */
  cycle: boolean;
  /** Shown only because a visible row waits on it; the filter alone would hide it. */
  context: boolean;
};

/**
 * The rows to show, nested by who blocks whom. A blocked row sits under the first of
 * its blockers that is in the list; everything else is top level, ordered by
 * `sort`, with children ordered the same way. A blocker the filter would hide is kept
 * (marked `context`) when a visible row waits on it — hiding the cause of a lock
 * wait would make the tree lie. Wait cycles never recurse: the first member reached
 * becomes a top-level row and the cycle is flagged.
 */
export function blockingTree(
  rows: readonly ActivityRow[],
  keep: (r: ActivityRow) => boolean,
  sort: ActivitySort,
): ActivityNode[] {
  const byPid = new Map<number, ActivityRow>();
  for (const r of rows) if (!byPid.has(r.pid)) byPid.set(r.pid, r);
  const parentOf = (r: ActivityRow): number | null => {
    for (const p of r.blockedBy) if (p !== r.pid && byPid.has(p)) return p;
    return null;
  };

  // Visible = passes the filter, plus every blocker up the chain of a visible row.
  const visible = new Set<number>();
  const context = new Set<number>();
  for (const r of byPid.values()) {
    if (!keep(r)) continue;
    visible.add(r.pid);
    let p = parentOf(r);
    let guard = 0;
    while (p !== null && guard++ < byPid.size) {
      if (!visible.has(p)) {
        visible.add(p);
        if (!keep(byPid.get(p)!)) context.add(p);
      }
      p = parentOf(byPid.get(p)!);
    }
  }

  const children = new Map<number, ActivityRow[]>();
  const tops: ActivityRow[] = [];
  for (const pid of visible) {
    const r = byPid.get(pid)!;
    const p = parentOf(r);
    if (p !== null && visible.has(p)) {
      const list = children.get(p);
      if (list) list.push(r);
      else children.set(p, [r]);
    } else tops.push(r);
  }
  const order = (a: ActivityRow, b: ActivityRow) => compareRows(a, b, sort);
  for (const list of children.values()) list.sort(order);
  tops.sort(order);

  const out: ActivityNode[] = [];
  const placed = new Set<number>();
  const emit = (top: ActivityRow, cycle: boolean) => {
    const stack: { row: ActivityRow; depth: number }[] = [{ row: top, depth: 0 }];
    while (stack.length) {
      const { row, depth } = stack.pop()!;
      if (placed.has(row.pid)) continue;
      placed.add(row.pid);
      const kids = children.get(row.pid) ?? [];
      out.push({
        row,
        depth,
        blocks: kids.length,
        rootBlocker: kids.length > 0 && (depth === 0 || cycle),
        cycle,
        context: context.has(row.pid),
      });
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ row: kids[i], depth: depth + 1 });
    }
  };
  for (const r of tops) emit(r, false);
  // Rows still unplaced sit on a wait cycle (each has a visible parent).
  const rest = [...visible].filter((pid) => !placed.has(pid)).map((pid) => byPid.get(pid)!).sort(order);
  for (const r of rest) if (!placed.has(r.pid)) emit(r, true);
  return out;
}

/** Mean of a column's finite values at or after `fromT` (NaN when there are none). */
export function windowMean(buffer: SeriesBuffer, col: number, fromT: number): number {
  let sum = 0;
  let n = 0;
  for (let i = buffer.lowerBound(fromT); i < buffer.size; i++) {
    const v = buffer.value(i, col);
    if (v === v) {
      sum += v;
      n++;
    }
  }
  return n ? sum / n : NaN;
}

/** The newest finite value of a column (NaN when the ring holds none). */
export function latestValue(buffer: SeriesBuffer, col: number): number {
  for (let i = buffer.size - 1; i >= 0; i--) {
    const v = buffer.value(i, col);
    if (v === v) return v;
  }
  return NaN;
}

/**
 * Why Cancel/Terminate is unavailable for a row, or "" when it is offered. The
 * backend and the server check again; this only keeps a button from promising what
 * will be refused. Read-only connections never signal (plan decision 2).
 */
export function signalRefusal(
  row: Pick<ActivityRow, "pid" | "user">,
  ctx: { readOnly: boolean; running: boolean; server: Pick<ServerInfo, "pid" | "user" | "superuser" | "signalBackend"> & { engine?: ServerInfo["engine"] } | null },
): string {
  if (ctx.readOnly) return "This connection is read-only: Tusk does not cancel or terminate sessions on it.";
  if (!ctx.server || !ctx.running) return "Resume the monitor to cancel or terminate sessions.";
  if (row.pid === ctx.server.pid) return "That is the monitor's own session.";
  if (ctx.server.superuser || ctx.server.signalBackend) return "";
  // SQL Server's KILL needs ALTER ANY CONNECTION even for the login's own sessions.
  if (ctx.server.engine === "mssql") return "KILL needs the ALTER ANY CONNECTION permission.";
  if (row.user === ctx.server.user) return "";
  return ctx.server.engine === "mysql"
    ? "Only your own sessions: another account's needs CONNECTION_ADMIN (or SUPER)."
    : "Only your own sessions: another role's needs superuser or membership in pg_signal_backend.";
}
