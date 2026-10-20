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
import { commands, errorMessage, type MonitorOptions } from "../commands";
import { wake } from "./frameLoop";
import { ClockMap, MonitorData, ServerClock, type MonitorActivity, type MonitorSample, type MonitorStarted } from "./model";
import { prefersReducedMotion } from "./visibility";

export type MonitorView = "overview" | "activity";

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
  readonly setView: (v: MonitorView) => void;
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
    [this.view, this.setView] = createSignal<MonitorView>(opts.view ?? "overview");
    [this.hoverT, this.setHoverSig] = createSignal<number | null>(null);
    [this.visible, this.setVisibleSig] = createSignal(false);
  }

  private inputs(): SamplingInputs {
    return { userPaused: this.userPaused(), visible: this.visible(), keepSampling: this.keepSampling() };
  }

  /** The renderer freezes on the last sample while the user has paused. */
  frozen(): boolean {
    return this.userPaused();
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
      const options: MonitorOptions = { intervalMs: this.intervalMs(), paused: false, activity: true };
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
    const options: MonitorOptions = { intervalMs: this.intervalMs(), paused: !want, activity: true };
    if (
      !this.applied ||
      this.applied.paused !== options.paused ||
      this.applied.intervalMs !== options.intervalMs ||
      this.applied.activity !== options.activity
    ) {
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
    if (sample.activity) this.setActivity({ ...sample.activity, at: Date.now(), error: null });
    else if (sample.activityError) {
      const prev = this.activity();
      this.setActivity(prev ? { ...prev, error: sample.activityError } : { rows: [], total: 0, at: Date.now(), error: sample.activityError });
    }
    this.setTick(this.tick() + 1);
    // A stepping chart only moves when a sample lands; a gliding one is on its own pace.
    if (prefersReducedMotion() || this.frozen()) wake();
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
