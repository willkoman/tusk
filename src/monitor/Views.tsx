import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import { Icon } from "../Icons";
import { stateClass, useServerNow } from "./ActivityTable";
import {
  XID_WRAP_LIMIT,
  aggregateStatements,
  blockingTree,
  formatAgo,
  formatBytes,
  formatCompact,
  formatDuration,
  formatPercent,
  formatWindow,
  liveDuration,
  queryAgeStart,
  slotTone,
  waitLabel,
  wraparoundTone,
  type ActivityRow,
  type LockWait,
  type ProgressRow,
  type StatementTotal,
} from "./model";
import type { MonitorSession } from "./session";
import { engineProfile } from "./engines";
import { monitorThresholds } from "./thresholds";

/**
 * The phase-2 views of the Monitor tab: Locks, Statements, Replication, Tables &
 * maintenance and I/O. Each reads the session's newest data for its tier (the tier
 * runs only while its view is open) and explains itself when the server cannot
 * answer: a version, an extension, a privilege.
 */

type RowMenu = (e: MouseEvent, row: ActivityRow) => void;
type QueryMenu = (e: MouseEvent, query: string) => void;

const num = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toLocaleString());
const ms = (v: number | null | undefined) => formatDuration(v ?? null);
const ago = (startMs: number | null, nowMs: number) => formatAgo(startMs === null ? null : nowMs - startMs);

/** A lock wait as the process-list row the row menu (Cancel/Terminate…) acts on. */
export function lockWaitRow(w: LockWait): ActivityRow {
  return {
    pid: w.pid,
    backendStart: w.backendStart,
    backendStartMs: null,
    user: w.user,
    database: w.database,
    application: w.application,
    client: null,
    backendType: "client backend",
    state: w.state,
    waitType: "Lock",
    waitEvent: w.locktype,
    xactStartMs: w.xactStartMs,
    queryStartMs: null,
    stateChangeMs: null,
    blockedBy: w.blockedBy,
    query: w.query,
    queryTruncated: false,
  };
}

/** A running maintenance command as a process-list row, so it can be cancelled. */
export function progressRow(p: ProgressRow): ActivityRow | null {
  if (!p.backendStart) return null;
  return {
    pid: p.pid,
    backendStart: p.backendStart,
    backendStartMs: null,
    user: null,
    database: p.database,
    application: null,
    client: null,
    backendType: null,
    state: "active",
    waitType: null,
    waitEvent: null,
    xactStartMs: null,
    queryStartMs: p.startedMs,
    stateChangeMs: null,
    blockedBy: [],
    query: p.query,
    queryTruncated: false,
  };
}

function Section(props: { title: string; note?: string; children: JSX.Element; actions?: JSX.Element }) {
  return (
    <section class="monitor-card mv-section">
      <header class="mc-head">
        <h3>{props.title}</h3>
        <Show when={props.note}><span class="mc-sub">{props.note}</span></Show>
        <span class="spacer" />
        {props.actions}
      </header>
      {props.children}
    </section>
  );
}

function TierError(props: { session: MonitorSession; tier: string | string[] }) {
  const message = () => {
    const errors = props.session.viewErrors();
    for (const t of Array.isArray(props.tier) ? props.tier : [props.tier]) if (errors[t]) return errors[t];
    return "";
  };
  return <Show when={message()}><div class="monitor-banner warn">The server could not answer: {message()}</div></Show>;
}

function Waiting(props: { when: boolean; children: JSX.Element }) {
  return <Show when={props.when} fallback={<div class="empty-hint">Waiting for the first reading…</div>}>{props.children}</Show>;
}

const ActionsCell = (props: { label: string; onMenu: (e: MouseEvent) => void }) => (
  <td class="mv-actions">
    <button class="icon" title="Actions" aria-label={props.label} onClick={(e) => { e.stopPropagation(); props.onMenu(e); }}>
      <Icon name="more" />
    </button>
  </td>
);

// ---------------------------------------------------------------- Locks ---------

export function LocksView(props: { session: MonitorSession; onRowMenu: RowMenu }) {
  const s = props.session;
  const locks = () => s.locks();
  const text = () => engineProfile(s.started()?.server.engine ?? "postgres").locks;
  // The blocking chains, from the process list (who waits on whom, beyond locks the
  // list is capped at).
  const chains = createMemo(() => {
    const rows = s.activity()?.rows ?? [];
    const blockers = new Set(rows.flatMap((r) => r.blockedBy));
    return blockingTree(rows, (r) => r.blockedBy.length > 0 || blockers.has(r.pid), null);
  });
  const serverNow = useServerNow(s);
  return (
    <div class="mv-stack">
      <TierError session={s} tier="locks" />
      <Waiting when={!!locks()}>
        <div class="mv-summary">
          <span classList={{ warn: (locks()?.waitingTotal ?? 0) > 0 }}><b>{num(locks()?.waitingTotal)}</b> waiting</span>
          <span><b>{num(locks()?.heldTotal)}</b> granted locks in {num(locks()?.heldGroups)} groups</span>
          <span class="mc-sub">{text().summary}</span>
        </div>
        <Section title="Waiting" note={text().waiting}>
          <Show when={locks()!.waiting.length} fallback={<div class="empty-hint">No session is waiting on a lock.</div>}>
            <table class="mv-table">
              <thead><tr><th>PID</th><th>User</th><th>Mode</th><th>On</th><th class="num">Waiting</th><th>Blocked by</th><th>Query</th><th /></tr></thead>
              <tbody>
                <For each={locks()!.waiting}>
                  {(w) => (
                    <tr onContextMenu={(e) => { e.preventDefault(); props.onRowMenu(e, lockWaitRow(w)); }}>
                      <td class="mono">{w.pid}</td>
                      <td>{w.user ?? "–"}</td>
                      <td>{w.mode}</td>
                      <td class="mono">{w.target}</td>
                      <td class="num">{w.waitedMs === null ? "–" : ms(w.waitedMs)}</td>
                      <td class="mono warn-text">{w.blockedBy.join(", ")}</td>
                      <td class="mv-query" title={w.query ?? ""}>{w.query ?? ""}</td>
                      <ActionsCell label={`Actions for session ${w.pid}`} onMenu={(e) => props.onRowMenu(e, lockWaitRow(w))} />
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
            <Show when={locks()!.waitingTotal > locks()!.waiting.length}>
              <div class="mc-sub">First {locks()!.waiting.length} of {num(locks()!.waitingTotal)}.</div>
            </Show>
          </Show>
        </Section>
        <Section title="Blocking chains" note="from the process list">
          <Show when={chains().length} fallback={<div class="empty-hint">No blocking chains right now.</div>}>
            <div class="mv-chain">
              <For each={chains()}>
                {(n) => (
                  <div
                    class="mv-chain-row"
                    classList={{ "root-blocker": n.rootBlocker, cycle: n.cycle }}
                    style={{ "padding-left": `${8 + Math.min(n.depth, 8) * 16}px` }}
                    onContextMenu={(e) => { e.preventDefault(); props.onRowMenu(e, n.row); }}
                  >
                    <Show when={n.depth > 0}><span class="ma-nest">└</span></Show>
                    <span class="mono">{n.row.pid}</span>
                    <span>{n.row.user ?? "–"}</span>
                    <span class="ma-state"><span class={`ma-dot ${stateClass(n.row.state)}`} />{n.row.state ?? "–"}</span>
                    <span>{waitLabel(n.row) || "–"}</span>
                    <span class="mono">{formatDuration(liveDuration(queryAgeStart(n.row), serverNow()))}</span>
                    <span class="mv-query" title={n.row.query ?? ""}>{n.row.query ?? ""}</span>
                    <Show when={n.rootBlocker}><span class="mv-tag warn">blocks {n.blocks}</span></Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Section>
        <Section title="Granted locks by target" note="most locks first">
          <Show when={locks()!.held.length} fallback={<div class="empty-hint">{text().heldEmpty}</div>}>
            <table class="mv-table">
              <thead><tr><th>On</th><th>Mode</th><th>Type</th><th class="num">Locks</th><th>Held by</th></tr></thead>
              <tbody>
                <For each={locks()!.held}>
                  {(h) => (
                    <tr>
                      <td class="mono">{h.target}</td>
                      <td>{h.mode}</td>
                      <td>{h.locktype}</td>
                      <td class="num">{num(h.count)}</td>
                      <td class="mono">{h.pids.join(", ")}{h.count > h.pids.length ? " …" : ""}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Section>
      </Waiting>
    </div>
  );
}

// ---------------------------------------------------------------- Statements ----

type StatementSort = "execMs" | "calls" | "mean" | "rows" | "hit";

export function StatementsView(props: { session: MonitorSession; onQueryMenu: QueryMenu }) {
  const s = props.session;
  const [sort, setSort] = createSignal<StatementSort>("execMs");
  const server = () => s.started()?.server ?? null;
  // Over the charts' window, or the scrubbed range when one is frozen.
  const sums = createMemo(() => {
    void s.tick();
    const range = s.range();
    const last = s.data.last ?? performance.now();
    return range ? aggregateStatements(s.statements(), range.t0, range.t1) : aggregateStatements(s.statements(), last - s.windowMs());
  });
  const mean = (r: StatementTotal) => (r.calls > 0 ? r.execMs / r.calls : NaN);
  const hit = (r: StatementTotal) => (r.sharedHits + r.sharedReads > 0 ? r.sharedHits / (r.sharedHits + r.sharedReads) : NaN);
  const sorted = createMemo(() => {
    const key = sort();
    const val = (r: StatementTotal) =>
      key === "execMs" ? r.execMs : key === "calls" ? r.calls : key === "mean" ? mean(r) : key === "rows" ? (r.calls ? r.rows / r.calls : 0) : hit(r);
    return [...sums().rows].sort((a, b) => (val(b) || 0) - (val(a) || 0)).slice(0, 50);
  });
  const head = (key: StatementSort, label: string) => (
    <th class="num">
      <button class="mv-sort" classList={{ active: sort() === key }} onClick={() => setSort(key)}>{label}</button>
    </th>
  );
  return (
    <div class="mv-stack">
      <Show
        when={server()?.statementsAvailable}
        fallback={
          <Section title="Statements" note="pg_stat_statements">
            <div class="monitor-banner">
              {server()?.statementsNote ?? "Waiting for the monitor to start."}
            </div>
            <p class="mv-help">
              To see which queries take the server's time, add <code>pg_stat_statements</code> to <code>shared_preload_libraries</code>, restart
              PostgreSQL, and run <code>CREATE EXTENSION pg_stat_statements;</code> in this database.
            </p>
          </Section>
        }
      >
        <TierError session={s} tier="statements" />
        <Section
          title="Top statements"
          note={s.range() ? "in the selected range" : `over the last ${formatWindow(s.windowMs())}`}
        >
          <Show
            when={sorted().length}
            fallback={<div class="empty-hint">{s.statements().length ? "No statement ran in this window." : "Collecting: figures need two readings, 10 seconds apart."}</div>}
          >
            <table class="mv-table">
              <thead>
                <tr>
                  <th>Query</th>
                  {head("execMs", "Total time")}
                  <th class="num">Share</th>
                  {head("calls", "Calls")}
                  <th class="num">Calls/s</th>
                  {head("mean", "Mean")}
                  {head("rows", "Rows/call")}
                  {head("hit", "Cache hit")}
                  <th />
                </tr>
              </thead>
              <tbody>
                <For each={sorted()}>
                  {(r) => (
                    <tr onContextMenu={(e) => { e.preventDefault(); if (r.query) props.onQueryMenu(e, r.query); }}>
                      <td class="mv-query" title={[r.query ?? `queryid ${r.queryid}`, r.user ? `role ${r.user}` : "", r.database ? `database ${r.database}` : ""].filter(Boolean).join("\n")}>
                        {r.query ?? <span class="mc-sub">queryid {r.queryid}</span>}
                      </td>
                      <td class="num">{r.execMs >= 1000 ? `${(r.execMs / 1000).toFixed(1)} s` : `${r.execMs.toFixed(0)} ms`}</td>
                      <td class="num">{formatPercent(sums().totalExecMs > 0 ? r.execMs / sums().totalExecMs : null)}</td>
                      <td class="num">{formatCompact(r.calls)}</td>
                      <td class="num">{formatCompact(sums().seconds > 0 ? r.calls / sums().seconds : NaN)}</td>
                      <td class="num">{Number.isFinite(mean(r)) ? `${mean(r) >= 100 ? mean(r).toFixed(0) : mean(r).toFixed(2)} ms` : "–"}</td>
                      <td class="num">{r.calls ? formatCompact(r.rows / r.calls) : "–"}</td>
                      <td class="num">{formatPercent(Number.isFinite(hit(r)) ? hit(r) : null)}</td>
                      <Show when={r.query} fallback={<td />}>
                        <ActionsCell label="Statement actions" onMenu={(e) => props.onQueryMenu(e, r.query!)} />
                      </Show>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
            <div class="mc-sub">
              Each 10-second interval's top {50} statements by time, summed. {formatCompact(sums().totalCalls)} calls and{" "}
              {(sums().totalExecMs / 1000).toFixed(1)} s of execution across every statement in the window.
            </div>
          </Show>
        </Section>
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------- Replication ---

export function ReplicationView(props: { session: MonitorSession }) {
  const s = props.session;
  const rep = () => s.replication();
  return (
    <div class="mv-stack">
      <TierError session={s} tier="replication" />
      <Waiting when={!!rep()}>
        <div class="mv-summary">
          <span><b>{rep()!.standby ? "Standby" : "Primary"}</b></span>
          <span>{rep()!.replicas.length} replica{rep()!.replicas.length === 1 ? "" : "s"}</span>
          <span>{rep()!.slots.length} slot{rep()!.slots.length === 1 ? "" : "s"}</span>
        </div>
        <Show when={rep()!.receiver}>
          {(r) => (
            <Section title="This standby" note="pg_stat_wal_receiver">
              <div class="mv-facts">
                <span>Receiver</span><b>{r().status ?? "not running"}</b>
                <span>Primary</span><b>{r().sender ?? "–"}</b>
                <span>Replay backlog</span><b>{r().replayBacklogBytes === null ? "–" : formatBytes(r().replayBacklogBytes!)}</b>
                <span>Last message</span><b>{formatAgo(r().lastMessageMs)}</b>
                <span>Last replayed transaction</span><b>{formatAgo(r().replayAgeMs)}</b>
                <span>Replay</span><b classList={{ "warn-text": r().replayPaused }}>{r().replayPaused ? "paused" : "running"}</b>
              </div>
            </Section>
          )}
        </Show>
        <Section title="Replicas" note="pg_stat_replication">
          <Show when={rep()!.replicas.length} fallback={<div class="empty-hint">No replica is connected.</div>}>
            <table class="mv-table">
              <thead>
                <tr><th>Application</th><th>Client</th><th>State</th><th>Sync</th><th class="num">Write lag</th><th class="num">Flush lag</th><th class="num">Replay lag</th><th class="num">Replay behind</th></tr>
              </thead>
              <tbody>
                <For each={rep()!.replicas}>
                  {(r) => (
                    <tr>
                      <td>{r.application || "–"}</td>
                      <td class="mono">{r.client ?? "–"}</td>
                      <td>{r.state ?? "–"}</td>
                      <td>{r.syncState ?? "–"}</td>
                      <td class="num">{ms(r.writeLagMs)}</td>
                      <td class="num">{ms(r.flushLagMs)}</td>
                      <td class="num" classList={{ "warn-text": (r.replayLagMs ?? 0) > 60_000 }}>{ms(r.replayLagMs)}</td>
                      <td class="num">{r.replayBytes === null ? "–" : formatBytes(r.replayBytes)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Section>
        <Section title="Replication slots" note="pg_replication_slots">
          <Show when={rep()!.slots.length} fallback={<div class="empty-hint">No replication slots.</div>}>
            <table class="mv-table">
              <thead><tr><th>Slot</th><th>Type</th><th>Database</th><th>Active</th><th class="num">WAL retained</th><th>WAL status</th></tr></thead>
              <tbody>
                <For each={rep()!.slots}>
                  {(sl) => (
                    <tr class={`tone-${slotTone(sl, monitorThresholds()) || "none"}`}>
                      <td class="mono">{sl.name}</td>
                      <td>{sl.slotType ?? "–"}{sl.plugin ? ` (${sl.plugin})` : ""}</td>
                      <td>{sl.database ?? "–"}</td>
                      <td>{sl.active ? `yes${sl.activePid ? ` (pid ${sl.activePid})` : ""}` : "no"}</td>
                      <td class="num">{sl.retainedBytes === null ? "–" : formatBytes(sl.retainedBytes)}</td>
                      <td>{sl.walStatus ?? "–"}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
            <div class="mc-sub">An inactive slot keeps every WAL file since it was last read: amber past 1 GiB, red once its WAL is lost.</div>
          </Show>
        </Section>
      </Waiting>
    </div>
  );
}

// ---------------------------------------------------------------- Tables --------

export function TablesView(props: { session: MonitorSession; onRowMenu: RowMenu }) {
  const s = props.session;
  const serverNow = useServerNow(s);
  const progress = () => s.progress();
  const m = () => s.maintenance();
  const fraction = (p: ProgressRow) => (p.total && p.done !== null ? Math.min(1, p.done / p.total) : null);
  const vacuumed = (lastManual: number | null, lastAuto: number | null) =>
    lastManual === null && lastAuto === null ? null : Math.max(lastManual ?? 0, lastAuto ?? 0);
  return (
    <div class="mv-stack">
      <TierError session={s} tier={["progress", "maintenance"]} />
      <Section title="Running maintenance" note="pg_stat_progress_*">
        <Waiting when={!!progress()}>
          <Show when={progress()!.rows.length} fallback={<div class="empty-hint">No vacuum, analyze, index build, cluster, COPY or base backup is running.</div>}>
            <div class="mv-progress">
              <For each={progress()!.rows}>
                {(p) => (
                  <div
                    class="mv-progress-row"
                    title={p.query ?? ""}
                    onContextMenu={(e) => { const row = progressRow(p); if (row) { e.preventDefault(); props.onRowMenu(e, row); } }}
                  >
                    <span class="mv-tag">{p.kind}</span>
                    <span class="mono">{p.relation ?? p.database ?? "–"}</span>
                    <span class="mc-sub">{p.phase ?? ""}</span>
                    <span class="spacer" />
                    <span class="mono">{formatDuration(liveDuration(p.startedMs, serverNow()))}</span>
                    <div class="mv-bar" classList={{ unknown: fraction(p) === null }}>
                      <i style={{ width: `${(fraction(p) ?? 1) * 100}%` }} />
                    </div>
                    <span class="num mono">
                      {fraction(p) === null ? `${num(p.done)} ${p.unit}` : formatPercent(fraction(p))}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Waiting>
      </Section>
      <Section title="Tables with the most dead tuples" note="this database · every 30 s">
        <Waiting when={!!m()}>
          <Show when={m()!.tables.length} fallback={<div class="empty-hint">No user tables.</div>}>
            <table class="mv-table">
              <thead>
                <tr><th>Table</th><th class="num">Dead</th><th class="num">Live</th><th class="num">Dead %</th><th class="num">Changed since analyze</th><th>Last vacuum</th><th>Last analyze</th><th class="num">Size</th></tr>
              </thead>
              <tbody>
                <For each={m()!.tables}>
                  {(t) => {
                    const ratio = () => ((t.dead ?? 0) + (t.live ?? 0) > 0 ? (t.dead ?? 0) / ((t.dead ?? 0) + (t.live ?? 0)) : null);
                    return (
                      <tr>
                        <td class="mono">{t.schema}.{t.name}</td>
                        <td class="num" classList={{ "warn-text": (ratio() ?? 0) > 0.2 && (t.dead ?? 0) > 10_000 }}>{num(t.dead)}</td>
                        <td class="num">{num(t.live)}</td>
                        <td class="num">{formatPercent(ratio())}</td>
                        <td class="num">{num(t.modified)}</td>
                        <td title={`manual: ${ago(t.lastVacuumMs, serverNow())}\nautovacuum: ${ago(t.lastAutovacuumMs, serverNow())}`}>
                          {ago(vacuumed(t.lastVacuumMs, t.lastAutovacuumMs), serverNow())}
                        </td>
                        <td title={`manual: ${ago(t.lastAnalyzeMs, serverNow())}\nautoanalyze: ${ago(t.lastAutoanalyzeMs, serverNow())}`}>
                          {ago(vacuumed(t.lastAnalyzeMs, t.lastAutoanalyzeMs), serverNow())}
                        </td>
                        <td class="num">{t.sizeBytes === null ? "–" : formatBytes(t.sizeBytes)}</td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
            <Show when={m()!.tablesTotal > m()!.tables.length}>
              <div class="mc-sub">Top {m()!.tables.length} of {num(m()!.tablesTotal)} tables.</div>
            </Show>
          </Show>
        </Waiting>
      </Section>
      <Section title="Transaction-ID wraparound" note="age(datfrozenxid) per database">
        <Waiting when={!!m()}>
          <div class="mv-progress">
            <For each={m()!.wraparound}>
              {(d) => {
                const tone = () => wraparoundTone(d.xidAge, m()!.freezeMaxAge, monitorThresholds());
                return (
                  <div class={`mv-progress-row tone-${tone() || "none"}`}>
                    <span class="mono">{d.database}</span>
                    <span class="spacer" />
                    <span class="mc-sub">{formatCompact(XID_WRAP_LIMIT - d.xidAge)} transactions of headroom</span>
                    <div class="mv-bar">
                      <i style={{ width: `${Math.min(100, (d.xidAge / XID_WRAP_LIMIT) * 100)}%` }} />
                    </div>
                    <span class="num mono">{formatCompact(d.xidAge)}</span>
                  </div>
                );
              }}
            </For>
          </div>
          <div class="mc-sub">
            Autovacuum forces a freeze past autovacuum_freeze_max_age ({formatCompact(m()!.freezeMaxAge ?? NaN)}): amber beyond it, red within{" "}
            {formatCompact(monitorThresholds().wraparoundDangerHeadroomM * 1_000_000)} of the 2^31 limit.
          </div>
        </Waiting>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------- I/O -----------

export function IoView(props: { session: MonitorSession }) {
  const s = props.session;
  const [showIdle, setShowIdle] = createSignal(false);
  const supported = () => (s.started()?.server.versionNum ?? 0) >= 160_000;
  const rows = createMemo(() => {
    const all = s.io()?.rows ?? [];
    return showIdle() ? all : all.filter((r) => r.reads + r.writes + r.extends + r.hits + r.evictions + r.fsyncs > 0);
  });
  const rate = (v: number) => formatCompact(v);
  return (
    <div class="mv-stack">
      <Show
        when={supported()}
        fallback={<Section title="I/O" note="pg_stat_io"><div class="monitor-banner">pg_stat_io needs PostgreSQL 16 or later.</div></Section>}
      >
        <TierError session={s} tier="io" />
        <Section
          title="I/O by backend type and context"
          note={s.io() ? `operations per second, averaged over ${s.io()!.seconds.toFixed(0)} s` : "pg_stat_io"}
          actions={
            <label class="checkbox mv-toggle">
              <input type="checkbox" checked={showIdle()} onChange={(e) => setShowIdle(e.currentTarget.checked)} />
              Show idle rows
            </label>
          }
        >
          <Show when={s.io()} fallback={<div class="empty-hint">Collecting: rates need two readings, 10 seconds apart.</div>}>
            <Show when={rows().length} fallback={<div class="empty-hint">No I/O in the last interval.</div>}>
              <table class="mv-table">
                <thead>
                  <tr><th>Backend</th><th>Object</th><th>Context</th><th class="num">Reads</th><th class="num">Hits</th><th class="num">Writes</th><th class="num">Extends</th><th class="num">Evictions</th><th class="num">Fsyncs</th></tr>
                </thead>
                <tbody>
                  <For each={rows()}>
                    {(r) => (
                      <tr>
                        <td>{r.backendType}</td>
                        <td>{r.object}</td>
                        <td>{r.context}</td>
                        <td class="num">{rate(r.reads)}</td>
                        <td class="num">{rate(r.hits)}</td>
                        <td class="num">{rate(r.writes)}</td>
                        <td class="num">{rate(r.extends)}</td>
                        <td class="num">{rate(r.evictions)}</td>
                        <td class="num">{rate(r.fsyncs)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </Show>
        </Section>
      </Show>
    </div>
  );
}
