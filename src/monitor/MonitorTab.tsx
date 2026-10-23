import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Icon } from "../Icons";
import { ActivityTable, stateClass, useServerNow } from "./ActivityTable";
import { chartColumns } from "./layout";
import {
  EVENT_LABELS,
  FPI_SERIES,
  WRITES_SERIES,
  eventTotals,
  formatWindow,
  summarizeRange,
  type EventKind,
  IO_SERIES,
  SESSION_SERIES,
  TPS_SERIES,
  TUP_READ_SERIES,
  TUP_WRITE_SERIES,
  WAIT_TYPES,
  WAL_SERIES,
  blockedTone,
  cacheHitTone,
  formatByteRate,
  formatBytes,
  HOST_CPU_SERIES,
  HOST_IO_SERIES,
  HOST_STALE_MS,
  formatBytesAxis,
  formatCompact,
  formatDuration,
  formatPercent,
  formatUptime,
  latestValue,
  liveDuration,
  oldestTransactionTone,
  replicationLagTone,
  sessionsTone,
  tileIndex,
  waitLabel,
  windowMean,
  type ActivityRow,
  type SeriesBuffer,
  type TileKey,
  type Tone,
} from "./model";
import { INTERVALS, WINDOWS, type MonitorSession, type MonitorView } from "./session";
import { EVENT_COLORS, TimeSeries, type SeriesSpec } from "./TimeSeries";
import { IoView, LocksView, ReplicationView, StatementsView, TablesView } from "./Views";
import { monitorThresholds } from "./thresholds";
import { chartCsv, composeChartPng, type ChartExport, type CsvColumn } from "./export";
import { engineProfile, isMonitorEngine, omitted, seriesLabel, viewFor, type ChartId, type EngineProfile } from "./engines";

const WAIT_COLORS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6", "--chart-7", "--chart-8", "--chart-9", "--chart-10", "--muted"];

const LOAD_SERIES: SeriesSpec[] = WAIT_TYPES.map((label, i) => ({ label, color: WAIT_COLORS[i], kind: "area" }));
const SESSIONS_SERIES: SeriesSpec[] = [
  { label: SESSION_SERIES[0], color: "--chart-4", kind: "area" },
  { label: SESSION_SERIES[1], color: "--warn", kind: "area" },
  { label: SESSION_SERIES[2], color: "--danger", kind: "area" },
  { label: SESSION_SERIES[3], color: "--muted", kind: "area" },
  { label: SESSION_SERIES[4], color: "--chart-7", kind: "area" },
  { label: "max_connections", color: "--muted", kind: "ceiling" },
];
const TPS_SPECS: SeriesSpec[] = [
  { label: TPS_SERIES[0], color: "--chart-4", kind: "line" },
  { label: TPS_SERIES[1], color: "--chart-9", kind: "line" },
  { label: TPS_SERIES[2], color: "--chart-5", kind: "line", dashed: true },
];
const WRITE_SPECS: SeriesSpec[] = [
  { label: TUP_WRITE_SERIES[0], color: "--chart-1", kind: "line" },
  { label: TUP_WRITE_SERIES[1], color: "--chart-2", kind: "line" },
  { label: TUP_WRITE_SERIES[2], color: "--chart-9", kind: "line" },
];
const READ_SPECS: SeriesSpec[] = [
  { label: TUP_READ_SERIES[0], color: "--chart-4", kind: "line" },
  { label: TUP_READ_SERIES[1], color: "--chart-5", kind: "line" },
];
const IO_SPECS: SeriesSpec[] = [
  { label: IO_SERIES[0], color: "--chart-4", kind: "line" },
  { label: IO_SERIES[1], color: "--chart-2", kind: "line" },
  { label: IO_SERIES[2], color: "--chart-3", kind: "line" },
];
const WAL_SPECS: SeriesSpec[] = [{ label: WAL_SERIES[0], color: "--chart-5", kind: "line" }];
const FPI_SPECS: SeriesSpec[] = [{ label: FPI_SERIES[0], color: "--chart-3", kind: "line" }];
const HOST_CPU_SPECS: SeriesSpec[] = [
  { label: HOST_CPU_SERIES[0], color: "--chart-4", kind: "line" },
  { label: HOST_CPU_SERIES[1], color: "--chart-2", kind: "line" },
];
const HOST_IO_SPECS: SeriesSpec[] = [
  { label: HOST_IO_SERIES[0], color: "--chart-1", kind: "line" },
  { label: HOST_IO_SERIES[1], color: "--chart-9", kind: "line" },
  { label: HOST_IO_SERIES[2], color: "--chart-5", kind: "line" },
  { label: HOST_IO_SERIES[3], color: "--chart-7", kind: "line" },
];
const formatPct = (v: number) => (Number.isFinite(v) ? `${v < 10 ? v.toFixed(1) : Math.round(v)}%` : "–");
const WRITES_SPECS: SeriesSpec[] = [
  { label: WRITES_SERIES[0], color: "--chart-7", kind: "line" },
  { label: WRITES_SERIES[1], color: "--chart-5", kind: "line" },
  { label: WRITES_SERIES[2], color: "--chart-9", kind: "line" },
];
const CHECKPOINTS: EventKind[] = ["checkpoint", "checkpoint-requested"];

const VIEWS: { id: MonitorView; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "activity", label: "Activity" },
  { id: "locks", label: "Locks" },
  { id: "statements", label: "Statements" },
  { id: "replication", label: "Replication" },
  { id: "tables", label: "Tables" },
  { id: "io", label: "I/O" },
];

const intervalLabel = (ms: number) => `${ms / 1000} s`;
const windowLabel = formatWindow;

type Pane = {
  buffer: (s: MonitorSession) => SeriesBuffer;
  series: SeriesSpec[];
  stacked?: boolean;
  integer?: boolean;
  format: (v: number) => string;
  height: number;
  /** Shown only when the server has the view behind it. */
  when?: (s: MonitorSession) => boolean;
  /** Event kinds marked over the series. */
  markers?: EventKind[];
  /** Byte series: binary steps and short axis labels. */
  bytes?: boolean;
  /** Series this engine has no counter for: never drawn, listed or exported. */
  omit?: ReadonlySet<number>;
};

type ChartDef = { id: ChartId; title: string; source: string; panes: Pane[]; when?: (s: MonitorSession) => boolean };

/** A chart as this engine names it, or null when the engine has nothing to draw. */
function localize(def: ChartDef, profile: EngineProfile): ChartDef | null {
  const text = profile.charts[def.id];
  if (text?.hidden) return null;
  const relabel = def.id === "load" ? profile.waitLabels : null;
  return {
    ...def,
    title: text?.title ?? def.title,
    source: text?.source ?? def.source,
    panes: def.panes.map((pane, p) => ({
      ...pane,
      omit: omitted(text, p),
      series: pane.series.map((spec, k) => ({ ...spec, label: seriesLabel(text, p, k, relabel?.[k] ?? spec.label) })),
    })),
  };
}

const CHARTS: ChartDef[] = [
  {
    id: "load",
    title: "Database load by wait type",
    source: "pg_stat_activity: sessions with state = 'active' (every backend type, never the monitor), grouped by wait_event_type. CPU = active with no wait event. The height is load; the colours say why.",
    panes: [{ buffer: (s) => s.data.load, series: LOAD_SERIES, stacked: true, integer: true, format: formatCompact, height: 170 }],
  },
  {
    id: "sessions",
    title: "Sessions by state",
    source: "pg_stat_activity: client backends by state, against max_connections (the dashed line, drawn once the sessions reach half of it). Other includes sessions this role may not see.",
    panes: [{ buffer: (s) => s.data.sessions, series: SESSIONS_SERIES, stacked: true, integer: true, format: formatCompact, height: 170 }],
  },
  {
    id: "tps",
    title: "Transactions per second",
    source: "pg_stat_database: Δ(xact_commit) and Δ(xact_rollback) over Δt, summed over every database. The dashed line is the 10-second average: one-second TPS swings widely because backends flush their statistics about once a second.",
    panes: [{ buffer: (s) => s.data.tps, series: TPS_SPECS, format: formatCompact, height: 170 }],
  },
  {
    id: "tuples",
    title: "Tuples per second",
    source: "pg_stat_database: writes (Δ tup_inserted, tup_updated, tup_deleted) above, reads (Δ tup_fetched, tup_returned) below, per second.",
    panes: [
      { buffer: (s) => s.data.tupWrite, series: WRITE_SPECS, format: formatCompact, height: 84 },
      { buffer: (s) => s.data.tupRead, series: READ_SPECS, format: formatCompact, height: 84 },
    ],
  },
  {
    id: "io",
    title: "Block I/O",
    source: "pg_stat_database: shared-buffer hits and reads (Δ blks_hit, blks_read × block_size) and temporary-file bytes (Δ temp_bytes), per second.",
    panes: [{ buffer: (s) => s.data.io, series: IO_SPECS, format: formatByteRate, height: 170, bytes: true }],
  },
  {
    id: "wal",
    title: "WAL",
    source: "Δ pg_current_wal_lsn() per second (the replay position on a standby). Below: full-page images per second from pg_stat_wal (PostgreSQL 14+), which jump after a checkpoint.",
    panes: [
      { buffer: (s) => s.data.wal, series: WAL_SPECS, format: formatByteRate, height: 110, markers: CHECKPOINTS, bytes: true },
      { buffer: (s) => s.data.fpi, series: FPI_SPECS, format: formatCompact, height: 58, when: (s) => !!s.started()?.server.walStats },
    ],
  },
  {
    id: "writes",
    title: "Checkpoints and background writes",
    source: "Buffers written per second, as bytes: by checkpoints (pg_stat_checkpointer on PostgreSQL 17+, pg_stat_bgwriter before), by the background writer, and by backends themselves (16 and earlier). Markers: checkpoints, dashed amber when requested rather than timed — frequent requested checkpoints mean max_wal_size is too small.",
    panes: [{ buffer: (s) => s.data.writes, series: WRITES_SPECS, format: formatByteRate, height: 170, markers: CHECKPOINTS, bytes: true }],
  },
  {
    id: "host",
    title: "Host",
    source: "The database server's machine (or container), from the system_stats extension every 5 seconds: CPU busy and I/O-wait shares above; bytes per second read and written by physical disks and received and sent by network interfaces (loopback excluded) below.",
    when: (s) => !!s.started()?.server.hostStats,
    panes: [
      { buffer: (s) => s.data.hostCpu, series: HOST_CPU_SPECS, format: formatPct, height: 84 },
      { buffer: (s) => s.data.hostIo, series: HOST_IO_SPECS, format: formatByteRate, height: 84, bytes: true },
    ],
  },
];

/** A legend that doubles as the crosshair readout: values at the hovered instant, else the newest. */
function Legend(props: { session: MonitorSession; panes: Pane[]; hidden: () => ReadonlySet<string>; onToggle: (key: string, isolate: boolean) => void }) {
  const s = props.session;
  const valueOf = (pane: Pane, k: number) => {
    void s.tick();
    const buf = pane.buffer(s);
    const t = s.hoverT();
    if (t === null) return latestValue(buf, k);
    const i = buf.at(t, s.intervalMs() * 1.5);
    return i < 0 ? NaN : buf.value(i, k);
  };
  return (
    <div class="mc-legend">
      <For each={props.panes.filter((p) => !p.when || p.when(s))}>
        {(pane, p) => (
          <For each={pane.series}>
            {(spec, k) => {
              const key = `${p()}:${k()}`;
              if (pane.omit?.has(k())) return null;
              return (
                <button
                  class="mc-key"
                  classList={{ off: props.hidden().has(key) }}
                  title="Click to show or hide; double-click to show only this series"
                  onClick={(e) => props.onToggle(key, e.detail > 1)}
                >
                  <i style={{ background: `var(${spec.color})` }} classList={{ dashed: spec.kind === "ceiling" || !!spec.dashed }} />
                  <span class="mc-key-label">{spec.label}</span>
                  <span class="mc-key-value">{pane.format(valueOf(pane, k()))}</span>
                </button>
              );
            }}
          </For>
        )}
      </For>
    </div>
  );
}

const NONE: ReadonlySet<number> = new Set();

/** The range a chart export covers: the frozen range, else the whole visible window. */
function exportRange(s: MonitorSession): { t0: number; t1: number } {
  const r = s.range();
  if (r) return r;
  const now = performance.now();
  return { t0: now - s.windowMs(), t1: now };
}

const toWall = (t: number) => Date.now() - performance.now() + t;

function csvColumns(s: MonitorSession, def: ChartDef): CsvColumn[] {
  const out: CsvColumn[] = [];
  for (const pane of def.panes) {
    if (pane.when && !pane.when(s)) continue;
    const buffer = pane.buffer(s);
    pane.series.forEach((spec, k) => {
      if (pane.omit?.has(k)) return;
      const unit = pane.bytes ? " (B/s)" : "";
      const prefix = def.panes.length > 1 || def.id === "load" || def.id === "sessions" ? `${def.title}: ` : "";
      out.push({ buffer, series: k, label: `${prefix}${spec.label}${unit}` });
    });
  }
  return out;
}

function ChartCard(props: { session: MonitorSession; def: ChartDef; onExport: (e: MouseEvent, chart: ChartExport) => void }) {
  let card!: HTMLElement;
  const [hidden, setHidden] = createSignal<ReadonlySet<string>>(new Set());
  const panes = () => props.def.panes.filter((p) => !p.when || p.when(props.session));
  // Per pane, the series the legend switched off and those the engine has no counter
  // for (read by the canvas every frame).
  const hiddenByPane = createMemo(() => {
    const out: Set<number>[] = panes().map((pane) => new Set(pane.omit ?? []));
    for (const key of hidden()) {
      const [p, k] = key.split(":").map(Number);
      (out[p] ??= new Set<number>()).add(k);
    }
    return out;
  });
  const chartExport = (): ChartExport => ({
    title: props.def.title,
    csv: () => {
      const r = exportRange(props.session);
      return chartCsv(csvColumns(props.session, props.def), r.t0, r.t1, toWall);
    },
    png: async () => {
      // A canvas scrolled out of view is not drawn: bring the card in and give the
      // frame loop a moment, so the image is never a blank plot.
      card.scrollIntoView({ block: "nearest" });
      await new Promise((r) => setTimeout(r, 250));
      const s = props.session;
      const r = s.range();
      const cs = getComputedStyle(card);
      const legend = panes().flatMap((pane, p) =>
        pane.series
          .map((spec, k) => ({ spec, k }))
          .filter(({ k }) => !hidden().has(`${p}:${k}`) && !pane.omit?.has(k))
          .map(({ spec, k }) => {
            const buf = pane.buffer(s);
            const v = r ? NaN : latestValue(buf, k);
            return { label: spec.label, color: cs.getPropertyValue(spec.color).trim() || "#888", value: Number.isFinite(v) ? pane.format(v) : "" };
          }),
      );
      const when = r ? `${new Date(toWall(r.t0)).toLocaleString()} – ${new Date(toWall(r.t1)).toLocaleTimeString()}` : new Date().toLocaleString();
      return composeChartPng(card, props.def.title, when, legend);
    },
  });
  const toggle = (key: string, isolate: boolean) => {
    const all = panes().flatMap((pane, p) => pane.series.flatMap((_, k) => (pane.omit?.has(k) ? [] : [`${p}:${k}`])));
    if (isolate) {
      const others = all.filter((x) => x !== key);
      const already = others.every((x) => hidden().has(x)) && !hidden().has(key);
      setHidden(already ? new Set<string>() : new Set(others));
      return;
    }
    const next = new Set(hidden());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setHidden(next);
  };
  return (
    <section class="monitor-card" ref={card}>
      <header class="mc-head">
        <h3>{props.def.title}</h3>
        <span class="mc-info" title={props.def.source} aria-label={`About: ${props.def.source}`}><Icon name="help" /></span>
        <button
          class="icon mc-export"
          title="Export this chart"
          aria-label={`Export ${props.def.title}`}
          onClick={(e) => props.onExport(e, chartExport())}
        >
          <Icon name="more" />
        </button>
      </header>
      <For each={panes()}>
        {(pane, p) => (
          <TimeSeries
            session={props.session}
            buffer={pane.buffer(props.session)}
            series={pane.series}
            stacked={pane.stacked}
            integer={pane.integer}
            format={pane.format}
            height={pane.height}
            hidden={() => hiddenByPane()[p()] ?? NONE}
            markers={pane.markers}
            binary={pane.bytes}
            axisFormat={pane.bytes ? formatBytesAxis : undefined}
            label={`${props.def.title}${panes().length > 1 ? ` (${p() + 1} of ${panes().length})` : ""}`}
          />
        )}
      </For>
      <Legend session={props.session} panes={panes()} hidden={hidden} onToggle={toggle} />
    </section>
  );
}

/** Chart 8: checkpoints, deadlocks, conflicts, temp files and resets on the shared axis. */
function EventsCard(props: { session: MonitorSession; profile: EngineProfile }) {
  const s = props.session;
  const totals = createMemo(() => {
    void s.tick();
    const range = s.range();
    const last = s.data.last ?? performance.now();
    return eventTotals(range ? s.data.events.between(range.t0, range.t1) : s.data.events.between(last - s.windowMs(), Infinity));
  });
  return (
    <section class="monitor-card monitor-events">
      <header class="mc-head">
        <h3>Events</h3>
        <span
          class="mc-info"
          title={props.profile.eventsSource}
        >
          <Icon name="help" />
        </span>
      </header>
      <TimeSeries session={s} buffer={s.data.writes} series={[]} lane height={64} label="Events on the shared time axis" />
      <div class="mc-legend">
        <For each={[...props.profile.events]}>
          {(kind) => (
            <span class="mc-key static">
              <i style={{ background: `var(${EVENT_COLORS[kind]})` }} />
              <span class="mc-key-label">{props.profile.eventLabels[kind] ?? EVENT_LABELS[kind]}</span>
              <span class="mc-key-value">{totals()[kind]}</span>
            </span>
          )}
        </For>
      </div>
    </section>
  );
}

type TileDef = {
  key: TileKey;
  label: string;
  source: string;
  value: () => string;
  sub: () => string;
  tone: () => Tone;
  onClick?: () => void;
  when?: () => boolean;
};

function Tile(props: { session: MonitorSession; def: TileDef }) {
  const color = () => (props.def.tone() === "danger" ? "--danger" : props.def.tone() === "warn" ? "--warn" : "--accent");
  const body: JSX.Element = (
    <>
      <span class="mt-label">{props.def.label}</span>
      <span class="mt-value">{props.def.value()}</span>
      <span class="mt-sub">{props.def.sub()}</span>
      <TimeSeries
        session={props.session}
        buffer={props.session.data.tiles}
        series={[]}
        spark={{ series: tileIndex(props.def.key), color }}
        height={26}
        label={`${props.def.label}, last minute`}
      />
    </>
  );
  return (
    <Show
      when={props.def.onClick}
      fallback={<div class={`monitor-tile ${props.def.tone()}`} title={props.def.source}>{body}</div>}
    >
      <button class={`monitor-tile ${props.def.tone()}`} title={props.def.source} onClick={() => props.def.onClick?.()}>{body}</button>
    </Show>
  );
}

/** The Overview's "Active now": the eight longest-running active queries. */
/** While a range is frozen: who was active then, from the per-sample summaries. */
function ActiveInRange(props: { session: MonitorSession }) {
  const s = props.session;
  const sum = createMemo(() => {
    const r = s.range()!;
    void s.tick();
    return summarizeRange(s.moments, r.t0, r.t1);
  });
  return (
    <section class="monitor-card monitor-active">
      <header class="mc-head">
        <h3>Active in the selected range</h3>
        <span class="mc-sub">{sum().samples} process-list samples · longest-running first</span>
      </header>
      <Show when={sum().sessions.length} fallback={<div class="empty-hint">{sum().samples ? "No client session was active then." : "No process list was sampled in this range."}</div>}>
        <div class="mn-list">
          <For each={sum().sessions.slice(0, 15)}>
            {(r) => (
              <div class="mn-row">
                <span class="mn-pid">{r.pid}</span>
                <span class="mn-user">{r.user ?? "–"}</span>
                <span class="mn-wait" title={r.waits.join(", ")}>{r.waits[0] ?? "CPU"}{r.waits.length > 1 ? ` +${r.waits.length - 1}` : ""}</span>
                <span class="mn-age" title={`seen in ${r.seen} sample${r.seen === 1 ? "" : "s"}`}>{formatDuration(r.longestMs)}</span>
                <span class="mn-query" title={r.query ?? ""}>{r.query ?? ""}</span>
                <span />
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}

function ActiveNow(props: { session: MonitorSession; onRowMenu: (e: MouseEvent, row: ActivityRow) => void }) {
  const s = props.session;
  const serverNow = useServerNow(s);
  const top = createMemo(() =>
    (s.activity()?.rows ?? [])
      .filter((r) => r.state === "active" && (r.backendType === null || r.backendType === "client backend"))
      .sort((a, b) => (a.queryStartMs ?? Infinity) - (b.queryStartMs ?? Infinity))
      .slice(0, 8),
  );
  return (
    <section class="monitor-card monitor-active">
      <header class="mc-head">
        <h3>Active now</h3>
        <span class="mc-sub">longest running first</span>
        <span class="spacer" />
        <button class="ghost" onClick={() => s.setView("activity")}>View all</button>
      </header>
      <Show when={top().length} fallback={<div class="empty-hint">{s.activity() ? "No active client sessions." : "Waiting for the process list…"}</div>}>
        <div class="mn-list">
          <For each={top()}>
            {(r) => (
              <div class="mn-row" onContextMenu={(e) => { e.preventDefault(); props.onRowMenu(e, r); }}>
                <span class="mn-pid">{r.pid}</span>
                <span class="mn-user">{r.user ?? "–"}</span>
                <span class="mn-wait"><span class={`ma-dot ${stateClass(r.state)}`} />{waitLabel(r) || "CPU"}</span>
                <span class="mn-age">{formatDuration(liveDuration(r.queryStartMs, serverNow()))}</span>
                <span class="mn-query" title={r.query ?? ""}>{r.query ?? ""}</span>
                <button class="icon" title="Session actions" aria-label={`Actions for session ${r.pid}`} onClick={(e) => props.onRowMenu(e, r)}><Icon name="more" /></button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}

/**
 * The Monitor tab's body: header (server, uptime, status, interval, window, keep
 * sampling, pause), headline tiles with sparklines, and the Overview / Activity
 * views. Everything server-facing goes through the session; row actions go to App.
 */
export default function MonitorTab(props: {
  session: MonitorSession;
  connectionLabel: string;
  /** The connection's driver kind; the monitor watches postgres, mysql and mssql. */
  engine: string;
  production: JSX.Element | undefined;
  onRowMenu: (e: MouseEvent, row: ActivityRow) => void;
  onQueryMenu: (e: MouseEvent, query: string) => void;
  onOpenSettings: () => void;
  onChartExport: (e: MouseEvent, chart: ChartExport) => void;
}) {
  const s = props.session;
  // A tab's connection never changes engine, so the profile is read once.
  const supported = isMonitorEngine(props.engine);
  const profile = engineProfile(isMonitorEngine(props.engine) ? props.engine : "postgres");
  const views = VIEWS.filter((v) => profile.views.includes(v.id));
  const charts = CHARTS.map((def) => localize(def, profile)).filter((d): d is ChartDef => d !== null);
  const view = () => viewFor(profile, s.view());
  // A view this engine lacks (restored from another tab's habit) falls back to Overview.
  if (view() !== s.view()) s.setView(view());
  let host: HTMLDivElement | undefined;
  const [width, setWidth] = createSignal(1200);
  const serverNow = useServerNow(s);
  onMount(() => {
    const ro = new ResizeObserver(() => host && setWidth(host.clientWidth));
    if (host) ro.observe(host);
    // Escape leaves a frozen range (or abandons a drag) and returns to live.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (!s.range() && !s.scrub()) return;
      if (document.querySelector("[data-blocking-dialog='true'], .modal-overlay, .ctx-menu")) return;
      e.preventDefault();
      s.backToLive();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      ro.disconnect();
      window.removeEventListener("keydown", onKey);
    });
  });
  const wallTime = (t: number) =>
    new Date(Date.now() - performance.now() + t).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const server = () => s.started()?.server ?? null;
  const latest = () => s.latest();
  /** The newest host reading, while it is recent enough to show. */
  const freshHost = () => {
    void s.tick();
    const h = s.data.lastHost;
    return h && (s.data.last ?? h.t) - h.t <= HOST_STALE_MS ? h.host : null;
  };
  /** Every Overview chart's samples in the export range, joined on time. */
  const allCsv = () => {
    const r = exportRange(s);
    return chartCsv(charts.filter((def) => !def.when || def.when(s)).flatMap((def) => csvColumns(s, def).map((c) => ({ ...c, label: c.label.startsWith(`${def.title}: `) ? c.label : `${def.title}: ${c.label}` }))), r.t0, r.t1, toWall);
  };
  const tileMean = (key: TileKey) => {
    void s.tick();
    return windowMean(s.data.tiles, tileIndex(key), (s.data.last ?? 0) - 60_000);
  };
  const activeSessions = () => (s.activity()?.rows ?? []).filter((r) => r.state && r.state !== "idle" && (r.backendType === null || r.backendType === "client backend")).length;

  const tiles: TileDef[] = [
    {
      key: "load",
      label: "Load",
      source: "Average active sessions over the last minute (pg_stat_activity, state = 'active', every backend type, excluding the monitor).",
      value: () => (latest()?.load ? tileMean("load").toFixed(1) : "–"),
      sub: () => (latest()?.load ? `${latest()!.load!.reduce((a, x) => a + x, 0)} active now` : ""),
      tone: () => "",
    },
    {
      key: "sessions",
      label: "Sessions",
      source: "Client backends: active / total, and max_connections (pg_stat_activity, current_setting). Amber and red at the shares of max_connections set in Settings → Monitor.",
      value: () => (latest()?.sessions ? `${latest()!.sessions!.active} / ${latest()!.sessions!.total}` : "–"),
      sub: () => (latest()?.sessions ? `of ${latest()!.sessions!.maxConnections} max` : ""),
      tone: () => (latest()?.sessions ? sessionsTone(latest()!.sessions!.total, latest()!.sessions!.maxConnections, monitorThresholds()) : ""),
      onClick: () => s.setView("activity"),
    },
    {
      key: "tps",
      label: "Transactions/s",
      source: "Δ(xact_commit + xact_rollback) / Δt over every database (pg_stat_database). Below: the 10-second average and the rollback share.",
      value: () => (latest()?.rates ? formatCompact(latest()!.rates!.tps) : "–"),
      sub: () => {
        const r = latest()?.rates;
        if (!r) return "";
        void s.tick();
        const avg = latestValue(s.data.tps, 2);
        const share = profile.rollbacks && r.tps > 0 ? ` · ${formatPercent(r.rollbacks / r.tps)} rollback` : "";
        return `avg ${formatCompact(avg)}${share}`;
      },
      tone: () => "",
    },
    {
      key: "cacheHit",
      label: "Cache hit",
      source: "Δ blks_hit / Δ(blks_hit + blks_read) over the last tick (pg_stat_database) — not the lifetime ratio, which hides incidents.",
      value: () => formatPercent(latest()?.rates?.cacheHit ?? null),
      sub: () => "last tick",
      tone: () => cacheHitTone(latest()?.rates?.cacheHit ?? null, monitorThresholds()),
    },
    {
      key: "wal",
      label: "WAL",
      source: "Δ pg_current_wal_lsn() per second (on a standby, the replay position).",
      value: () => (latest()?.rates?.walBytes != null ? formatByteRate(latest()!.rates!.walBytes!) : "–"),
      sub: () => (server()?.inRecovery ? "replayed" : "written"),
      tone: () => "",
    },
    {
      key: "oldestXact",
      label: "Oldest transaction",
      source: "now() − min(xact_start) over every session (pg_stat_activity). A long transaction holds back vacuum; amber and red ages are set in Settings → Monitor.",
      value: () => formatDuration(latest()?.oldestXactMs ?? null),
      sub: () => (latest() && latest()!.oldestXactMs === null ? "none open" : ""),
      tone: () => oldestTransactionTone(latest()?.oldestXactMs ?? null, monitorThresholds()),
      onClick: () => s.setView("activity"),
    },
    {
      key: "blocked",
      label: "Blocked",
      source: "Sessions waiting on a heavyweight lock held by another (pg_blocking_pids is non-empty). Click for Locks.",
      value: () => (latest()?.blocked != null ? String(latest()!.blocked) : "–"),
      sub: () => "waiting on locks",
      tone: () => blockedTone(latest()?.blocked ?? null, monitorThresholds()),
      onClick: () => s.setView(viewFor(profile, "locks") === "locks" ? "locks" : "activity"),
    },
    {
      key: "lag",
      label: "Replication lag",
      source: "Primary: max(replay_lag) over pg_stat_replication. Standby: now() − pg_last_xact_replay_timestamp(), which also grows while the primary is idle.",
      value: () => formatDuration(latest()?.replicationLagMs ?? null),
      sub: () => (server()?.inRecovery ? "since last replay" : "slowest replica"),
      tone: () => replicationLagTone(latest()?.replicationLagMs ?? null, monitorThresholds()),
      when: () => latest()?.replicationLagMs != null,
    },
    {
      key: "hostCpu",
      label: "Host CPU",
      source: "Share of the database server's CPU not idle, from the system_stats extension (every 5 seconds); below, the 1-minute load average.",
      value: () => formatPct(freshHost()?.cpuBusyPct ?? NaN),
      sub: () => (freshHost()?.load1 != null ? `load ${freshHost()!.load1!.toFixed(2)}` : ""),
      tone: () => "",
      when: () => !!server()?.hostStats,
    },
    {
      key: "hostMem",
      label: "Host memory",
      source: "Memory in use by processes on the database server (total minus free minus the page cache), from the system_stats extension.",
      value: () => (freshHost()?.memUsed != null ? formatBytes(freshHost()!.memUsed!) : "–"),
      sub: () => (freshHost()?.memTotal ? `of ${formatBytes(freshHost()!.memTotal!)}` : ""),
      tone: () => "",
      when: () => !!server()?.hostStats,
    },
  ];

  for (const tile of tiles) {
    const o = profile.tiles[tile.key];
    if (o) {
      tile.source = o.source;
      if (o.label) tile.label = o.label;
    }
  }

  const status = () => s.status();
  const statusText = () => {
    const st = status();
    switch (st.kind) {
      case "live": return `Live · ${intervalLabel(s.intervalMs())}`;
      case "starting": return "Starting…";
      case "paused": return "Paused";
      case "hidden": return "Paused while hidden";
      case "idle": return "Not started";
      case "reconnecting": return "Reconnecting…";
      // A failing tick leaves the sampler running (the next tick retries); a failed
      // start or a vanished sampler does not.
      case "error": return s.hasSampler() ? "Sampling failed" : "Stopped";
    }
  };
  const statusTitle = () => {
    const st = status();
    if (st.kind === "error" || st.kind === "reconnecting") return st.message;
    if (st.kind === "hidden") return "Sampling pauses while this tab or the window is hidden. Turn on Keep sampling to capture an incident in the background.";
    if (st.kind === "live") {
      const l = latest();
      const sidecar = profile.engine === "postgres" ? "one extra read-only connection named 'Tusk monitor'" : "one extra connection of its own";
      return l ? `Last tick ${l.latencyMs.toFixed(1)} ms round trip. The monitor holds ${sidecar}.` : "";
    }
    return "";
  };

  return (
    <div class="monitor" ref={host}>
      <Show
        when={supported}
        fallback={<div class="monitor-empty"><p>The database monitor watches PostgreSQL, MySQL / MariaDB and SQL Server. An embedded database has no server to watch.</p></div>}
      >
        <header class="monitor-head">
          <div class="mh-title">
            <Icon name="activity" />
            <strong>Monitor</strong>
            <span class="mh-conn">{props.connectionLabel}</span>
            {props.production}
            <Show when={server()}>
              {(sv) => (
                <span class="mh-meta" title={`${sv().user}@${sv().database}`}>
                  {sv().product} {sv().version}
                  <Show when={sv().inRecovery}> · standby</Show>
                  <Show when={sv().startedMs !== null}> · {formatUptime(sv().startedMs, serverNow())}</Show>
                </span>
              )}
            </Show>
            <button class="icon mh-gear" title="Monitor thresholds (Settings → Monitor)" aria-label="Monitor thresholds" onClick={() => props.onOpenSettings()}><Icon name="gear" /></button>
          </div>
          <span class="spacer" />
          <Show when={s.range()}>
            {(r) => (
              <button class="mh-live" title="Return every chart to live (Esc)" onClick={() => s.backToLive()}>
                <Icon name="close" /> {wallTime(r().t0)}–{wallTime(r().t1)} · Live
              </button>
            )}
          </Show>
          <span class={`mh-status st-${status().kind}`} title={statusTitle()}>
            <span class="mh-led" aria-hidden="true" />
            {statusText()}
          </span>
          <Show when={status().kind === "error"}>
            <button class="ghost" onClick={() => s.retry()}>Retry</button>
          </Show>
          <label class="mh-field" title="How often the monitor samples the server">
            Interval
            <select value={s.intervalMs()} onChange={(e) => s.setInterval(Number(e.currentTarget.value))}>
              <For each={INTERVALS}>{(ms) => <option value={ms}>{intervalLabel(ms)}</option>}</For>
            </select>
          </label>
          <label class="mh-field" title="How much history the charts show (kept in memory while this tab is open)">
            Window
            <select value={s.windowMs()} onChange={(e) => s.setWindowMs(Number(e.currentTarget.value))}>
              <For each={WINDOWS}>{(ms) => <option value={ms}>{windowLabel(ms)}</option>}</For>
            </select>
          </label>
          <label class="checkbox mh-keep" title="Keep sampling while this tab or the window is hidden, to capture an incident. Drawing still stops.">
            <input type="checkbox" checked={s.keepSampling()} onChange={(e) => s.setKeepSampling(e.currentTarget.checked)} />
            Keep sampling
          </label>
          <Show
            when={s.userPaused()}
            fallback={<button class="ghost" title="Stop sampling the server" onClick={() => s.pause()}><Icon name="pause" /> Pause</button>}
          >
            <button class="run" title="Start sampling the server" onClick={() => s.resume()}><Icon name="play" /> Resume</button>
          </Show>
        </header>

        <div class="monitor-tiles">
          <For each={tiles}>
            {(def) => (
              <Show when={!def.when || def.when()}>
                <Tile session={s} def={def} />
              </Show>
            )}
          </For>
        </div>

        <div class="monitor-views">
          <div class="seg mv-views" role="tablist" aria-label="Monitor views">
            <For each={views}>
              {(v) => (
                <button role="tab" aria-selected={view() === v.id} classList={{ active: view() === v.id }} onClick={() => s.setView(v.id)}>
                  {v.label}
                  <Show when={v.id === "activity" && s.activity()}><span class="mv-count">{activeSessions()}</span></Show>
                  <Show when={v.id === "locks" && (latest()?.blocked ?? 0) > 0}><span class="mv-count warn">{latest()!.blocked}</span></Show>
                </button>
              )}
            </For>
          </div>
          <Show when={!s.range() && view() === "overview"}>
            <span class="mv-note">Drag across a chart to freeze every chart on that range.</span>
          </Show>
          <Show when={s.userPaused() && !s.started()}>
            <span class="mv-note">Paused. Resume to start sampling; the monitor opens one extra read-only connection.</span>
          </Show>
        </div>

        <div class="monitor-body">
          <Switch>
            <Match when={view() === "overview"}>
              <div class="monitor-grid" style={{ "grid-template-columns": `repeat(${chartColumns(width())}, minmax(0, 1fr))` }}>
                <For each={charts}>
                  {(def) => (
                    <Show when={!def.when || def.when(s)}>
                      <ChartCard session={s} def={def} onExport={(e, chart) => props.onChartExport(e, { ...chart, allCsv })} />
                    </Show>
                  )}
                </For>
              </div>
              <Show when={profile.engine === "postgres" && server()?.hostStatsNote}>
                {(note) => <div class="mv-note mv-host-note">Host CPU, memory, disk and network: {note()}</div>}
              </Show>
              <EventsCard session={s} profile={profile} />
              <Show when={s.range()} fallback={<ActiveNow session={s} onRowMenu={props.onRowMenu} />}>
                <ActiveInRange session={s} />
              </Show>
            </Match>
            <Match when={view() === "activity"}><ActivityTable session={s} onRowMenu={props.onRowMenu} /></Match>
            <Match when={view() === "locks"}><LocksView session={s} onRowMenu={props.onRowMenu} /></Match>
            <Match when={view() === "statements"}><StatementsView session={s} onQueryMenu={props.onQueryMenu} /></Match>
            <Match when={view() === "replication"}><ReplicationView session={s} /></Match>
            <Match when={view() === "tables"}><TablesView session={s} onRowMenu={props.onRowMenu} /></Match>
            <Match when={view() === "io"}><IoView session={s} /></Match>
          </Switch>
        </div>
      </Show>
    </div>
  );
}
