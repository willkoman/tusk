/**
 * One Monitor tab's live state: the backend sampler it drives and the rings it fills.
 *
 * App keeps one session per Monitor tab (src/App.tsx `monitorSessions`), created when
 * the tab appears and disposed when it goes — however it goes: closed, its connection
 * disconnected, or the window reloading. The session outlives the tab's VIEW: an
 * inactive Monitor tab renders nothing, but its data stays for when it is shown
 * again (the rolling window lives in memory only, plan decision 5).
 *
 * Sampling runs only while it is wanted (`wantsSampling`): not paused by the user,
 * and either visible or explicitly kept sampling in the background (plan decision
 * 3). Not wanted means `monitor_configure({paused: true})` — the server is queried
 * no more — not merely that drawing stops. Every backend call is serialized on one
 * queue, and a reply or sample from a superseded generation is inert.
 */

import { createSignal, type Accessor } from "solid-js";
import { commands, errorMessage, type MonitorOptions, type MonitorViewSet } from "../commands";
import { wake } from "./frameLoop";
import {
  ClockMap,
  MOMENT_CAPACITY,
  MonitorData,
  ServerClock,
  activityMoment,
  type ActivityMoment,
  type MonitorActivity,
  type MonitorIo,
  type MonitorLocks,
  type MonitorMaintenance,
  type MonitorReplication,
  type MonitorSample,
  type MonitorStarted,
  type ProgressRow,
  type StatementSnapshot,
} from "./model";
import { prefersReducedMotion } from "./visibility";

export type MonitorView = "overview" | "activity" | "locks" | "statements" | "replication" | "tables" | "io";

export const NO_VIEWS: MonitorViewSet = { locks: false, statements: false, replication: false, tables: false, io: false };

/**
 * Which tiers a view needs. The process list feeds Overview's "Active now", the
 * Activity table and the Locks view's blocking tree; every other tier belongs to
 * exactly one view. A hidden monitor that keeps sampling runs only the fast tier
 * and the process list: enough to look back at an incident.
 */
export function tiersFor(view: MonitorView, visible: boolean): { activity: boolean; views: MonitorViewSet } {
  const activity = view === "overview" || view === "activity" || view === "locks" || !visible;
  if (!visible) return { activity, views: NO_VIEWS };
  return {
    activity,
    views: {
      locks: view === "locks",
      statements: view === "statements",
      replication: view === "replication",
      tables: view === "tables",
      io: view === "io",
    },
  };
}

const sameOptions = (a: MonitorOptions, b: MonitorOptions) =>
  a.intervalMs === b.intervalMs &&
  a.paused === b.paused &&
  a.activity === b.activity &&
  (Object.keys(NO_VIEWS) as (keyof MonitorViewSet)[]).every((k) => a.views[k] === b.views[k]);

/** A scrubbed time range, in local time. */
export type TimeRange = { t0: number; t1: number };

/** Statement snapshots kept: an hour at the 10 s cadence. */
const STATEMENT_SNAPSHOTS = 400;

export const INTERVALS = [1000, 2000, 5000, 10_000] as const;
export const WINDOWS = [60_000, 300_000, 900_000, 3_600_000] as const;
export const DEFAULT_WINDOW_MS = 300_000;

export type SamplingInputs = { userPaused: boolean; visible: boolean; keepSampling: boolean };

/** Should the sampler be querying the server right now? */
export function wantsSampling(s: SamplingInputs): boolean {
  return !s.userPaused && (s.visible || s.keepSampling);
}

export type SessionStatus =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "live" }
  | { kind: "paused" }
  | { kind: "hidden" }
  | { kind: "reconnecting"; message: string }
  | { kind: "error"; message: string };

/** The status a session shows when nothing is failing. */
export function restingStatus(s: SamplingInputs, started: boolean): SessionStatus {
  if (s.userPaused) return { kind: "paused" };
  if (!wantsSampling(s)) return { kind: "hidden" };
  return started ? { kind: "live" } : { kind: "idle" };
}

export type ActivitySnapshot = MonitorActivity & {
  /** Wall time it arrived (for "updated 2 s ago"). */
  at: number;
  error: string | null;
};

// A webview reload leaves the previous page's monitors registered and sampling
// (spike finding 4). App sweeps them on mount; every start waits for the sweep, so
// it can never kill a monitor this page just opened.
let sweep: Promise<unknown> = Promise.resolve();
export function sweepStaleMonitors(): Promise<unknown> {
  sweep = commands.monitorStopAll().catch(() => 0);
  return sweep;
}

export class MonitorSession {
  readonly data = new MonitorData();
  readonly serverClock = new ServerClock();
  private readonly clock = new ClockMap();
  private generation: number | null = null;
  private applied: MonitorOptions | null = null;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();

  readonly started: Accessor<MonitorStarted | null>;
  private readonly setStarted: (v: MonitorStarted | null) => void;
  readonly status: Accessor<SessionStatus>;
  private readonly setStatus: (v: SessionStatus) => void;
  /** The newest live fast-tier sample. */
  readonly latest: Accessor<MonitorSample | null>;
  private readonly setLatest: (v: MonitorSample | null) => void;
  readonly activity: Accessor<ActivitySnapshot | null>;
  private readonly setActivity: (v: ActivitySnapshot | null) => void;
  /** Bumped per sample: legends and readouts that read the rings track it. */
  readonly tick: Accessor<number>;
  private readonly setTick: (v: number) => void;
  readonly userPaused: Accessor<boolean>;
  private readonly setUserPaused: (v: boolean) => void;
  readonly keepSampling: Accessor<boolean>;
  private readonly setKeepSamplingSig: (v: boolean) => void;
  readonly intervalMs: Accessor<number>;
  private readonly setIntervalSig: (v: number) => void;
  readonly windowMs: Accessor<number>;
  private readonly setWindowSig: (v: number) => void;
  readonly view: Accessor<MonitorView>;
  private readonly setViewSig: (v: MonitorView) => void;
  // Per-view data, each the newest the backend sent for an open view.
  readonly locks: Accessor<MonitorLocks | null>;
  private readonly setLocks: (v: MonitorLocks | null) => void;
  readonly replication: Accessor<MonitorReplication | null>;
  private readonly setReplication: (v: MonitorReplication | null) => void;
  readonly progress: Accessor<{ rows: ProgressRow[]; at: number } | null>;
  private readonly setProgress: (v: { rows: ProgressRow[]; at: number } | null) => void;
  readonly maintenance: Accessor<MonitorMaintenance | null>;
  private readonly setMaintenance: (v: MonitorMaintenance | null) => void;
  readonly io: Accessor<MonitorIo | null>;
  private readonly setIo: (v: MonitorIo | null) => void;
  /** Interval snapshots of statement work, oldest first (bounded). */
  readonly statements: Accessor<readonly StatementSnapshot[]>;
  private readonly setStatements: (v: readonly StatementSnapshot[]) => void;
  /** The newest failure of each view tier, by tier name. */
  readonly viewErrors: Accessor<Record<string, string>>;
  private readonly setViewErrors: (v: Record<string, string>) => void;
  /** A frozen time range (drag on a chart); null = live. */
  readonly range: Accessor<TimeRange | null>;
  private readonly setRange: (v: TimeRange | null) => void;
  /** A drag in progress: where it started and where the pointer is. */
  readonly scrub: Accessor<{ a: number; b: number } | null>;
  private readonly setScrub: (v: { a: number; b: number } | null) => void;
  /** What each activity sample said about the longest-running sessions (for a scrub). */
  readonly moments: ActivityMoment[] = [];
  /** The shared crosshair, in local time; null = live readouts. */
  readonly hoverT: Accessor<number | null>;
  private readonly setHoverSig: (v: number | null) => void;
  readonly visible: Accessor<boolean>;
  private readonly setVisibleSig: (v: boolean) => void;

  constructor(
    readonly connectionId: string,
    opts: { paused?: boolean; view?: MonitorView } = {},
  ) {
    [this.started, this.setStarted] = createSignal<MonitorStarted | null>(null);
    [this.status, this.setStatus] = createSignal<SessionStatus>({ kind: opts.paused ? "paused" : "idle" });
    [this.latest, this.setLatest] = createSignal<MonitorSample | null>(null);
    [this.activity, this.setActivity] = createSignal<ActivitySnapshot | null>(null);
    [this.tick, this.setTick] = createSignal(0);
    [this.userPaused, this.setUserPaused] = createSignal(!!opts.paused);
    [this.keepSampling, this.setKeepSamplingSig] = createSignal(false);
    [this.intervalMs, this.setIntervalSig] = createSignal<number>(INTERVALS[0]);
    [this.windowMs, this.setWindowSig] = createSignal<number>(DEFAULT_WINDOW_MS);
    [this.view, this.setViewSig] = createSignal<MonitorView>(opts.view ?? "overview");
    [this.locks, this.setLocks] = createSignal<MonitorLocks | null>(null);
    [this.replication, this.setReplication] = createSignal<MonitorReplication | null>(null);
    [this.progress, this.setProgress] = createSignal<{ rows: ProgressRow[]; at: number } | null>(null);
    [this.maintenance, this.setMaintenance] = createSignal<MonitorMaintenance | null>(null);
    [this.io, this.setIo] = createSignal<MonitorIo | null>(null);
    [this.statements, this.setStatements] = createSignal<readonly StatementSnapshot[]>([]);
    [this.viewErrors, this.setViewErrors] = createSignal<Record<string, string>>({});
    [this.range, this.setRange] = createSignal<TimeRange | null>(null);
    [this.scrub, this.setScrub] = createSignal<{ a: number; b: number } | null>(null);
    [this.hoverT, this.setHoverSig] = createSignal<number | null>(null);
    [this.visible, this.setVisibleSig] = createSignal(false);
  }

  private inputs(): SamplingInputs {
    return { userPaused: this.userPaused(), visible: this.visible(), keepSampling: this.keepSampling() };
  }

  /** The charts stop scrolling: paused by the user, or showing a scrubbed range. */
  frozen(): boolean {
    return this.userPaused() || this.range() !== null;
  }

  /** Open a view; its tier starts on the next tick and the others stop. */
  setView(view: MonitorView): void {
    if (view === this.view()) return;
    this.setViewSig(view);
    this.sync();
  }

  // --- scrub and freeze -------------------------------------------------------

  beginScrub(t: number): void {
    this.setScrub({ a: t, b: t });
    wake();
  }

  moveScrub(t: number): void {
    const s = this.scrub();
    if (!s) return;
    this.setScrub({ a: s.a, b: t });
    wake();
  }

  /** Finish a drag: wider than `minMs` freezes every chart on it, else it was a click. */
  endScrub(minMs: number): void {
    const s = this.scrub();
    this.setScrub(null);
    if (s && Math.abs(s.b - s.a) >= minMs) {
      this.setRange({ t0: Math.min(s.a, s.b), t1: Math.max(s.a, s.b) });
    }
    wake();
  }

  backToLive(): void {
    this.setScrub(null);
    this.setRange(null);
    wake();
  }

  setVisible(on: boolean): void {
    if (on === this.visible()) return;
    this.setVisibleSig(on);
    this.sync();
  }

  pause(): void {
    this.setUserPaused(true);
    this.sync();
    wake();
  }

  resume(): void {
    this.setUserPaused(false);
    this.sync();
    wake();
  }

  setKeepSampling(on: boolean): void {
    this.setKeepSamplingSig(on);
    this.sync();
  }

  setInterval(ms: number): void {
    this.setIntervalSig(ms);
    this.sync();
  }

  /** The charts' time window: only what is drawn changes, so repaint now. */
  setWindowMs(ms: number): void {
    this.setWindowSig(ms);
    wake();
  }

  /**
   * Start over: after a failed start or a stopped sampler, or when ticks keep
   * failing. A sampler that is still running is stopped first, so a retry never
   * leaves two sidecars behind.
   */
  retry(): void {
    const generation = this.generation;
    this.generation = null;
    this.applied = null;
    if (generation !== null) void commands.monitorStop(this.connectionId, generation).catch(() => {});
    this.sync();
  }

  /** A backend sampler exists for this session (running or paused). */
  hasSampler(): boolean {
    return this.generation !== null;
  }

  setHover(t: number | null): void {
    if (t === this.hoverT()) return;
    this.setHoverSig(t);
    wake();
  }

  /** Bring the backend in line with what is wanted. Serialized; safe to call often. */
  sync(): void {
    this.queue = this.queue.then(() => this.apply()).catch(() => {});
  }

  private async apply(): Promise<void> {
    if (this.disposed) return;
    const inputs = this.inputs();
    const want = wantsSampling(inputs);
    if (this.generation === null) {
      if (!want) {
        const current = this.status();
        if (current.kind !== "error") this.setStatus(restingStatus(inputs, false));
        return;
      }
      this.setStatus({ kind: "starting" });
      await sweep;
      const options: MonitorOptions = { intervalMs: this.intervalMs(), paused: false, ...tiersFor(this.view(), inputs.visible) };
      let started: MonitorStarted;
      try {
        started = await commands.monitorStart(this.connectionId, options);
      } catch (e) {
        if (!this.disposed) this.setStatus({ kind: "error", message: errorMessage(e) });
        return;
      }
      if (this.disposed) {
        void commands.monitorStop(this.connectionId, started.generation).catch(() => {});
        return;
      }
      // A new generation's monotonic clock starts at zero again.
      this.clock.reset();
      this.generation = started.generation;
      this.applied = options;
      this.setStarted(started);
      this.setStatus({ kind: "live" });
      // Inputs may have moved while the start was in flight: settle them now.
      return this.apply();
    }
    const options: MonitorOptions = { intervalMs: this.intervalMs(), paused: !want, ...tiersFor(this.view(), inputs.visible) };
    if (!this.applied || !sameOptions(this.applied, options)) {
      try {
        await commands.monitorConfigure(this.connectionId, this.generation, options);
        this.applied = options;
      } catch (e) {
        if (this.disposed) return;
        // The sampler is gone (stopped elsewhere): say so and let Retry start a new one.
        this.generation = null;
        this.applied = null;
        this.setStatus({ kind: "error", message: errorMessage(e) });
        return;
      }
    }
    const current = this.status();
    if (!want || current.kind === "starting" || current.kind === "paused" || current.kind === "hidden" || current.kind === "idle") {
      this.setStatus(restingStatus(inputs, true));
    }
  }

  /** One `monitor-sample` event for this session's connection. */
  ingest(sample: MonitorSample): void {
    if (this.disposed || this.generation === null || sample.generation !== this.generation) return;
    const t = this.clock.toLocal(sample.monoMs, performance.now());
    this.data.ingest(sample, t, this.started()?.server.blockSize ?? 8192);
    this.serverClock.observe(sample.serverMs, Date.now());
    if (sample.status === "live") {
      this.setLatest(sample);
      const s = this.status();
      if (s.kind === "reconnecting" || s.kind === "error" || s.kind === "starting") this.setStatus({ kind: "live" });
    } else {
      this.setStatus({ kind: sample.status === "reconnecting" ? "reconnecting" : "error", message: sample.error ?? "" });
    }
    if (sample.activity) {
      this.setActivity({ ...sample.activity, at: Date.now(), error: null });
      this.moments.push(activityMoment(sample.activity.rows, t, sample.serverMs));
      if (this.moments.length > MOMENT_CAPACITY) this.moments.splice(0, this.moments.length - MOMENT_CAPACITY);
    } else if (sample.activityError) {
      const prev = this.activity();
      this.setActivity(prev ? { ...prev, error: sample.activityError } : { rows: [], total: 0, at: Date.now(), error: sample.activityError });
    }
    this.ingestViews(sample, t);
    this.setTick(this.tick() + 1);
    // A stepping chart only moves when a sample lands; a gliding one is on its own pace.
    if (prefersReducedMotion() || this.frozen()) wake();
  }

  private ingestViews(sample: MonitorSample, t: number): void {
    if (sample.locks) this.setLocks(sample.locks);
    if (sample.replication) this.setReplication(sample.replication);
    if (sample.progress) this.setProgress({ rows: sample.progress, at: Date.now() });
    if (sample.maintenance) this.setMaintenance(sample.maintenance);
    if (sample.io) this.setIo(sample.io);
    if (sample.statements) {
      const next = [...this.statements(), { ...sample.statements, t }];
      this.setStatements(next.length > STATEMENT_SNAPSHOTS ? next.slice(next.length - STATEMENT_SNAPSHOTS) : next);
    }
    // A tier that answered this tick clears its old error; a failing one records it.
    const answered = { locks: sample.locks, replication: sample.replication, progress: sample.progress, maintenance: sample.maintenance, io: sample.io, statements: sample.statements };
    const errors = { ...this.viewErrors() };
    let changed = false;
    for (const [tier, value] of Object.entries(answered)) {
      if (value && tier in errors) {
        delete errors[tier];
        changed = true;
      }
    }
    for (const [tier, message] of Object.entries(sample.viewErrors ?? {})) {
      if (errors[tier] !== message) {
        errors[tier] = message;
        changed = true;
      }
    }
    if (changed) this.setViewErrors(errors);
  }

  /** Cancel or terminate a backend through this session's sidecar. */
  async signal(pid: number, backendStart: string, action: "cancel" | "terminate"): Promise<boolean> {
    if (this.generation === null) throw new Error("The monitor is not running. Resume it first.");
    return commands.monitorSignal(this.connectionId, this.generation, pid, backendStart, action);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const generation = this.generation;
    this.generation = null;
    if (generation !== null) void commands.monitorStop(this.connectionId, generation).catch(() => {});
    this.data.clear();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}
