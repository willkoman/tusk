import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Icon } from "../Icons";
import { ActivityTable, stateClass, useServerNow } from "./ActivityTable";
import { chartColumns } from "./layout";
import {
  FPI_SERIES,
  IO_SERIES,
  SESSION_SERIES,
  TPS_SERIES,
  TUP_READ_SERIES,
  TUP_WRITE_SERIES,
  WAIT_TYPES,
  WAL_SERIES,
  blockedTone,
  formatByteRate,
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
import { INTERVALS, WINDOWS, type MonitorSession } from "./session";
import { TimeSeries, type SeriesSpec } from "./TimeSeries";

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

const intervalLabel = (ms: number) => `${ms / 1000} s`;
const windowLabel = (ms: number) => (ms >= 3_600_000 ? `${ms / 3_600_000} h` : `${ms / 60_000} min`);

type Pane = {
  buffer: (s: MonitorSession) => SeriesBuffer;
  series: SeriesSpec[];
  stacked?: boolean;
  integer?: boolean;
  format: (v: number) => string;
  height: number;
  /** Shown only when the server has the view behind it. */
  when?: (s: MonitorSession) => boolean;
};

type ChartDef = { id: string; title: string; source: string; panes: Pane[] };

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
    panes: [{ buffer: (s) => s.data.io, series: IO_SPECS, format: formatByteRate, height: 170 }],
  },
  {
    id: "wal",
    title: "WAL",
    source: "Δ pg_current_wal_lsn() per second (the replay position on a standby). Below: full-page images per second from pg_stat_wal (PostgreSQL 14+), which jump after a checkpoint.",
    panes: [
      { buffer: (s) => s.data.wal, series: WAL_SPECS, format: formatByteRate, height: 110 },
      { buffer: (s) => s.data.fpi, series: FPI_SPECS, format: formatCompact, height: 58, when: (s) => !!s.started()?.server.walStats },
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

function ChartCard(props: { session: MonitorSession; def: ChartDef }) {
  const [hidden, setHidden] = createSignal<ReadonlySet<string>>(new Set());
  // Per pane, the series the legend switched off (read by the canvas every frame).
  const hiddenByPane = createMemo(() => {
    const out: Set<number>[] = [];
    for (const key of hidden()) {
      const [p, k] = key.split(":").map(Number);
      (out[p] ??= new Set<number>()).add(k);
    }
    return out;
  });
  const panes = () => props.def.panes.filter((p) => !p.when || p.when(props.session));
  const toggle = (key: string, isolate: boolean) => {
    const all = panes().flatMap((pane, p) => pane.series.map((_, k) => `${p}:${k}`));
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
    <section class="monitor-card">
      <header class="mc-head">
        <h3>{props.def.title}</h3>
        <span class="mc-info" title={props.def.source} aria-label={`About: ${props.def.source}`}><Icon name="help" /></span>
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
            label={`${props.def.title}${panes().length > 1 ? ` (${p() + 1} of ${panes().length})` : ""}`}
          />
        )}
      </For>
      <Legend session={props.session} panes={panes()} hidden={hidden} onToggle={toggle} />
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
  isPostgres: boolean;
  production: JSX.Element | undefined;
  onRowMenu: (e: MouseEvent, row: ActivityRow) => void;
}) {
  const s = props.session;
  let host: HTMLDivElement | undefined;
  const [width, setWidth] = createSignal(1200);
  const serverNow = useServerNow(s);
  onMount(() => {
    const ro = new ResizeObserver(() => host && setWidth(host.clientWidth));
    if (host) ro.observe(host);
    onCleanup(() => ro.disconnect());
  });

  const server = () => s.started()?.server ?? null;
  const latest = () => s.latest();
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
      source: "Client backends: active / total, and max_connections (pg_stat_activity, current_setting). Amber at 80% of max_connections, red at 95%.",
      value: () => (latest()?.sessions ? `${latest()!.sessions!.active} / ${latest()!.sessions!.total}` : "–"),
      sub: () => (latest()?.sessions ? `of ${latest()!.sessions!.maxConnections} max` : ""),
      tone: () => (latest()?.sessions ? sessionsTone(latest()!.sessions!.total, latest()!.sessions!.maxConnections) : ""),
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
        const share = r.tps > 0 ? ` · ${formatPercent(r.rollbacks / r.tps)} rollback` : "";
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
      tone: () => "",
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
      source: "now() − min(xact_start) over every session (pg_stat_activity). Amber past 5 minutes, red past an hour: a long transaction holds back vacuum.",
      value: () => formatDuration(latest()?.oldestXactMs ?? null),
      sub: () => (latest() && latest()!.oldestXactMs === null ? "none open" : ""),
      tone: () => oldestTransactionTone(latest()?.oldestXactMs ?? null),
      onClick: () => s.setView("activity"),
    },
    {
      key: "blocked",
      label: "Blocked",
      source: "Sessions waiting on a heavyweight lock held by another (pg_blocking_pids is non-empty). Click for the blocking tree.",
      value: () => (latest()?.blocked != null ? String(latest()!.blocked) : "–"),
      sub: () => "waiting on locks",
      tone: () => blockedTone(latest()?.blocked ?? null),
      onClick: () => s.setView("activity"),
    },
    {
      key: "lag",
      label: "Replication lag",
      source: "Primary: max(replay_lag) over pg_stat_replication. Standby: now() − pg_last_xact_replay_timestamp(), which also grows while the primary is idle.",
      value: () => formatDuration(latest()?.replicationLagMs ?? null),
      sub: () => (server()?.inRecovery ? "since last replay" : "slowest replica"),
      tone: () => replicationLagTone(latest()?.replicationLagMs ?? null),
      when: () => latest()?.replicationLagMs != null,
    },
  ];

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
      case "error": return "Stopped";
    }
  };
  const statusTitle = () => {
    const st = status();
    if (st.kind === "error" || st.kind === "reconnecting") return st.message;
    if (st.kind === "hidden") return "Sampling pauses while this tab or the window is hidden. Turn on Keep sampling to capture an incident in the background.";
    if (st.kind === "live") {
      const l = latest();
      return l ? `Last tick ${l.latencyMs.toFixed(1)} ms round trip. The monitor holds one extra read-only connection named 'Tusk monitor'.` : "";
    }
    return "";
  };

  return (
    <div class="monitor" ref={host}>
      <Show
        when={props.isPostgres}
        fallback={<div class="monitor-empty"><p>The database monitor is PostgreSQL-only for now.</p></div>}
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
                  PostgreSQL {sv().version}
                  <Show when={sv().inRecovery}> · standby</Show>
                  <Show when={sv().startedMs !== null}> · {formatUptime(sv().startedMs, serverNow())}</Show>
                </span>
              )}
            </Show>
          </div>
          <span class="spacer" />
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
          <div class="seg" role="tablist" aria-label="Monitor views">
            <button role="tab" aria-selected={s.view() === "overview"} classList={{ active: s.view() === "overview" }} onClick={() => s.setView("overview")}>Overview</button>
            <button role="tab" aria-selected={s.view() === "activity"} classList={{ active: s.view() === "activity" }} onClick={() => s.setView("activity")}>
              Activity <Show when={s.activity()}><span class="mv-count">{activeSessions()}</span></Show>
            </button>
          </div>
          <Show when={s.userPaused() && !s.started()}>
            <span class="mv-note">Paused. Resume to start sampling; the monitor opens one extra read-only connection.</span>
          </Show>
        </div>

        <div class="monitor-body">
          <Show when={s.view() === "overview"} fallback={<ActivityTable session={s} onRowMenu={props.onRowMenu} />}>
            <div class="monitor-grid" style={{ "grid-template-columns": `repeat(${chartColumns(width())}, minmax(0, 1fr))` }}>
              <For each={CHARTS}>{(def) => <ChartCard session={s} def={def} />}</For>
            </div>
            <ActiveNow session={s} onRowMenu={props.onRowMenu} />
          </Show>
        </div>
      </Show>
    </div>
  );
}
