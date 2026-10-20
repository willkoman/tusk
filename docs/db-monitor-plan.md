# Database monitor — plan

Status: **phases 1 and 2 implemented 2026-10-20** (results in §12 and §13); phase 0 spike done (§11); decisions settled 2026-10-20 (§10); phase 3 (other engines) next. A live, first-class server dashboard in the spirit of pgAdmin's Dashboard (and AWS Performance Insights' "database load"), built to Tusk's standards: one cheap round trip per tick, a fluid canvas renderer, zero interference with the user's own session, and bounded everything.

PostgreSQL is the target for v1. MySQL and SQL Server follow through the same seams; DuckDB and SQLite are embedded and get no monitor.

---

## 1. Goals and non-goals

**Goals**

- See, at a glance and continuously, **how loaded the server is and why**: sessions, throughput, cache, WAL, waits, blocking.
- See **what is running right now** (the process list), with durations ticking live, blocking chains, and Cancel / Terminate.
- **Live and fluid**: 1 s sampling by default, charts that scroll smoothly rather than jump, a shared hover cursor across every chart.
- **Cheap**: one SQL round trip per tick on the fast tier, a few hundred microseconds of server time, under 3% of one core in the app while visible, nothing at all while hidden.
- **First class**: opened from the Explorer, the topbar and the command palette, lives in the tab strip next to the connection's SQL tabs, documented in the manual.

**Non-goals (v1)**

- Host CPU / memory / disk. PostgreSQL does not expose OS metrics; the optional `system_stats` extension (what pgAdmin uses) is a phase-3 add-on.
- Long-term retention, alerting, or a metrics database. The monitor keeps a rolling window in memory; persistence is a later, separate decision.
- Monitoring embedded engines (DuckDB, SQLite): there is no server and no other session to watch.

---

## 2. What it shows (PostgreSQL v1)

### 2.1 Headline tiles (each with a 60-second sparkline)

| Tile | Source | Notes |
|---|---|---|
| **Database load** (average active sessions) | `pg_stat_activity` where `state = 'active'`, excluding the monitor's own pid | The single most useful number: how many sessions are doing work right now. |
| **Sessions** `active / total / max` | `pg_stat_activity` count, `max_connections` | Amber at 80% of `max_connections`, red at 95%. |
| **Transactions/s** | Δ`xact_commit + xact_rollback` over Δt (`pg_stat_database`, summed) | Rollback share shown as a secondary figure. |
| **Cache hit** | Δ`blks_hit` / Δ(`blks_hit + blks_read`) | Over the tick, not lifetime — the lifetime ratio hides incidents. |
| **WAL rate** | Δ`pg_current_wal_lsn()` via `pg_wal_lsn_diff` | On a standby, replay rate from `pg_last_wal_replay_lsn()` instead. |
| **Longest transaction** | `max(now() - xact_start)` over non-idle sessions | Amber > 5 min, red > 1 h (configurable later). |
| **Blocked sessions** | count of sessions with non-empty `pg_blocking_pids(pid)` | Click jumps to Locks. |
| **Replication lag** | `pg_stat_replication.replay_lag` max (primary) / `now() - pg_last_xact_replay_timestamp()` (standby) | Hidden when there is no replication. |

### 2.2 Charts (time series, shared time axis)

1. **Database load by wait type** — stacked area of active sessions grouped by `wait_event_type` (`CPU` = active with no wait event, then `Lock`, `LWLock`, `IO`, `IPC`, `Client`, `Timeout`, `BufferPin`, `Activity`, `Extension`). This is the Performance-Insights view: the height is load, the colours say why. Hover shows the top wait events in that bucket.
2. **Sessions by state** — stacked area: active, idle in transaction, idle in transaction (aborted), idle, with `max_connections` as a ceiling line.
3. **Transactions/s** — commits and rollbacks.
4. **Tuples/s** — inserted, updated, deleted (writes) against fetched and returned (reads), two panes sharing the axis.
5. **Block I/O/s** — shared hits against reads; temp bytes/s as a thin overlay when non-zero.
6. **WAL bytes/s** — plus full-page images/s from `pg_stat_wal` (PG 14+) so a checkpoint storm is visible.
7. **Checkpoints and background writes** — `pg_stat_checkpointer` (PG 17+) or `pg_stat_bgwriter` (≤ 16), rendered as event ticks plus buffers-written/s.
8. **Deadlocks, conflicts, temp files** — event markers on the shared axis rather than a chart of mostly zeros.

### 2.3 Activity (the process list)

Live table from `pg_stat_activity`, one row per backend:

`pid · user · database · application · client · backend type · state · wait (type: event) · transaction age · query age · blocked by · query`

- **Durations tick every frame on the client** from `query_start` / `xact_start` plus a measured server-clock offset, so they move smoothly between 2 s activity samples.
- **Filters**: hide idle (default on), hide background workers (default on), this database only, my user only, text search over query/application.
- **Sort** by any column; default is "active first, then longest query".
- **Blocking tree**: a blocked row nests under its blocker (`pg_blocking_pids`), with the root blocker highlighted. One click shows the chain.
- **Row actions**: Copy query, Open query in new tab (opens clean, like any generated tab), Explain in new tab, **Cancel query** (`pg_cancel_backend`), **Terminate session** (`pg_terminate_backend`). Both confirm, name the pid, user and query, carry the production badge on a prod-tagged connection, and are refused on read-only connections and for the monitor's own pid.
- Query text arrives truncated to the server's `track_activity_query_size` (1 KiB default); the tooltip says so when a query ends at that length.

### 2.4 Locks (v1 if time allows, otherwise phase 2)

`pg_locks` joined to `pg_stat_activity`: granted vs waiting by mode and relation, and the blocking graph. Sampled only while the Locks view is visible (lock-table scans are the one non-trivial cost here).

### 2.5 Later views (phase 2)

- **Statements** — `pg_stat_statements` when installed (detected, never assumed): top queries by Δ`total_exec_time` over the visible window, calls/s, mean time, rows, shared-block hits/reads. Explain-in-tab from a row.
- **Replication** — per-replica write/flush/replay lag, slots and retained WAL (`pg_replication_slots`, `pg_wal_lsn_diff`), standby status.
- **Tables and maintenance** — `pg_stat_user_tables` top dead tuples, last (auto)vacuum/analyze, live `pg_stat_progress_vacuum` / `_create_index` / `_analyze` / `_copy` progress bars, transaction-ID wraparound headroom (`age(datfrozenxid)`).
- **I/O** — `pg_stat_io` (PG 16+) by backend type and context.

### 2.6 Version gates

Chosen once at monitor start from `server_version_num`; every gated query degrades to "not available on PostgreSQL N" rather than failing a tick.

| Feature | Minimum |
|---|---|
| `pg_monitor` / `pg_read_all_stats` roles, `pg_blocking_pids` | 10 |
| `pg_stat_progress_analyze` | 13 |
| `pg_stat_wal`, `pg_stat_activity.query_id`, `pg_stat_database.sessions*`, `pg_stat_progress_copy` | 14 |
| `pg_stat_io` | 16 |
| `pg_stat_checkpointer` (checkpoint columns leave `pg_stat_bgwriter`) | 17 |

### 2.7 Privileges

Without `pg_read_all_stats` (or superuser), `pg_stat_activity` hides other roles' query text and `pg_stat_statements` hides other users' statements. The monitor still works and says so once, in a quiet banner: *"Other users' queries are hidden. Grant `pg_monitor` to see them."* Cancel/Terminate are enabled only for the user's own sessions unless the role is superuser or has `pg_signal_backend`; the backend re-checks, the server re-checks again.

---

## 3. Experience

### 3.1 Where it lives

A **Monitor tab**: a second tab kind in the existing strip, bound to its connection exactly like SQL tabs (focusing it focuses the connection, the connection's colour rail applies, closing the connection closes it). Opened by:

- the Explorer's database node → **Open monitor**, and a monitor icon on the connection chip,
- a topbar **Monitor** button beside **AI**,
- the command palette and a rebindable shortcut (`openMonitor`, default `Mod-Shift-M`),
- the statusbar: clicking the session count opens the monitor on Activity.

One monitor tab per connection; opening it again focuses the existing one. It is pinnable and survives a restart as a tab (it reopens paused until the connection is live).

*Alternative considered:* a full-window view toggled from the topbar. Rejected: a tab keeps the "the active tab belongs to the active connection" invariant, gives multi-connection users one monitor per server for free, and costs no new navigation model.

### 3.2 Layout

```
┌ Monitor · prod-db · PostgreSQL 16.4 · up 41 d ─────── ● Live 1 s ▾  Window 5 m ▾  ❚❚ ┐
│ [Load 3.2 ▁▂▅▃] [Sessions 41/200] [TPS 1.2k] [Cache 99.6%] [WAL 4.1 MB/s] [Oldest tx 3m] │
│ Overview │ Activity 41 │ Locks │ Statements │ Replication │ Tables                        │
├──────────────────────────────────────────────┬─────────────────────────────────────────┤
│ Database load by wait type (stacked)         │ Sessions by state (stacked, max line)   │
├──────────────────────────────────────────────┼─────────────────────────────────────────┤
│ Transactions/s                               │ Tuples/s  (writes ▲ / reads ▼)          │
├──────────────────────────────────────────────┼─────────────────────────────────────────┤
│ Block I/O/s                                  │ WAL bytes/s  · checkpoint ticks         │
├──────────────────────────────────────────────┴─────────────────────────────────────────┤
│ Active now (top 8 by duration) ── pid · user · wait · 00:03:12 · SELECT … ── [View all] │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

Responsive: two chart columns above ~1100 px, one below; tiles wrap; the Activity table drops low-value columns (client, backend type) first. It follows the design system (tokens only, all eight themes) and respects `prefers-reduced-motion`.

### 3.3 Interaction details

- **Shared crosshair**: hovering any chart draws the same time cursor on all of them; the tooltip lists every series' value at that instant. Moving off returns to live.
- **Scrub and freeze**: drag on a chart to select a time range → every chart and the Activity "at that time" summary freeze on it, with a **Back to live** pill. (The activity at a past instant comes from the per-tick summary the sampler already keeps — top N sessions per tick — not from re-querying.)
- **Pause** stops sampling server-side, not just painting.
- **Interval**: 1 s / 2 s / 5 s / 10 s. **Window**: 1 m / 5 m / 15 m / 1 h.
- **Series legend** toggles series; double-click isolates one.
- **Thresholds** colour tiles amber/red using the app's existing meaning (amber = needs attention, red = trouble; green only for a completed outcome, never "healthy").
- Every number has a tooltip naming its source view and formula — trust comes from showing the arithmetic.

---

## 4. Architecture

### 4.1 Backend (`src-tauri/src/monitor/`)

**A dedicated monitor session per monitored connection.** The monitor never touches the user's session: Tusk has one result cursor per connection, every metadata command rolls it back, and a manual transaction freezes the session. So, like Slack's approval path, the monitor clones the connection's server-side `ConnectionConfig` and opens its own `Backend` with:

- `read_only = true` (engine-enforced `default_transaction_read_only`),
- `application_name = 'Tusk monitor'` (so it is identifiable in every other tool),
- `statement_timeout = 2s`, `lock_timeout = 250ms`, `idle_in_transaction_session_timeout` on,
- its own SSH tunnel through the existing `ssh::ensure` / `ssh::dial_config` path and the same TLS-host rule (`ssh::tls_host`), so `verify-full` keeps verifying the real host.

**Config snapshot outside the connection mutex.** Today the config is read through `lock_conn`, which waits behind a running query — exactly when someone opens a monitor. The registry entry gains an immutable `Arc<ConnectionConfig>` snapshot (written at connect/reconnect) so `monitor_start` never waits on the user's work. It does not count against `MAX_OPEN_CONNECTIONS` (it is a sidecar, capped separately at one per connection) but does count as a server connection, which the monitor states in its header tooltip.

**Sampler task.** One tokio task per monitor:

- `tokio::time::interval` with `MissedTickBehavior::Skip` — a slow tick is skipped, never queued.
- **Fast tier** (every tick): ONE statement returning one row — `pg_stat_database` sums, the `pg_stat_activity` state × wait-type histogram, `pg_current_wal_lsn()`, `pg_stat_wal`, checkpointer counters, `clock_timestamp()`. Built per server version at start.
- **Activity tier** (every 2 s, only while Activity or the Overview "Active now" card is visible): the bounded process list.
- **Slow tier** (every 30 s, only while its view is visible): sizes, replication slots, `pg_stat_statements`, table stats, progress views.
- Rates are computed **in Rust** from counter deltas over a monotonic `Instant`; a counter that goes backwards (stats reset, restart, failover) re-baselines and emits a `reset` marker instead of a negative spike. `stats_reset` changes are detected the same way.
- The sample goes out as one Tauri event, `monitor-sample`, carrying `{connectionId, monitorGeneration, seq, serverTime, latencyMs, rates…, histogram…, activity?}`. Typical fast-tier payload is about 1 KiB; activity is capped at 500 rows × 1 KiB query text.

**Bounds** reuse the one accountant (`db::TextLimits`): a `MONITOR_TEXT_LIMITS` row via `..CATALOG_TEXT_LIMITS` (500 rows, 2 KiB cells, small total). No other limit constants.

**Lifecycle.** Start/stop are explicit commands; the monitor also stops when its connection disconnects (the `disconnect` path drops it before the backend) and when the window closes. A dropped monitor session reconnects with backoff (1 s → 30 s) and reports `reconnecting` in its status — it never retries a statement that may have reached the server (there are none worth retrying; the next tick is the retry).

**Commands** (all in `commands.ts`, the only frontend module that imports `invoke`):

| Command | Purpose |
|---|---|
| `monitor_start(connectionId, {intervalMs, views})` | Opens the sidecar session, returns capabilities (version gates, privileges, engine) and a generation. |
| `monitor_configure(connectionId, generation, {intervalMs, views, paused})` | Changes cadence and which tiers run; pausing stops querying. |
| `monitor_stop(connectionId, generation)` | Closes the sidecar and its tunnel. |
| `monitor_signal(connectionId, generation, pid, "cancel" | "terminate")` | Runs on the sidecar; refused for read-only connections and for its own pid; returns the server's boolean. |
| `monitor_detail(connectionId, generation, view)` | One-shot fetch for slow views opened mid-interval. |

**Engines** sit behind a `MonitorSource` trait (`pg.rs`, later `mysql.rs`, `mssql.rs`) that returns the same neutral sample model, so the frontend never branches on engine for rendering — only on the capability list for which tiles/charts exist.

### 4.2 Frontend (`src/monitor/`)

- **`model.ts`** (pure, vitest): ring buffers as `Float64Array` per series (window ÷ interval points, max 3,600), sample ingestion keyed by `seq`, gap insertion when a tick is skipped (a gap is drawn as a gap, never interpolated), unit formatting, threshold classification, blocking-tree construction, server-clock offset.
- **`TimeSeries.tsx`**: one `<canvas>` per chart, sized by `ResizeObserver`, drawn at `devicePixelRatio`. **One shared `requestAnimationFrame` loop** for all visible charts, stopped when the tab or window is hidden.
  - *Smooth scroll*: the x-axis maps `now - t`, and `now` advances every frame, so the chart glides left continuously instead of stepping once per sample; the newest segment eases in. With `prefers-reduced-motion`, it steps per sample.
  - *Stable axes*: the y-domain animates toward its new "nice" maximum over ~250 ms and only shrinks after a hold, so axes never jitter.
  - *Decimation*: at most one min/max pair per pixel column, so a 1-hour window costs the same as a 1-minute one.
  - *Theme*: colours read from CSS tokens once per theme change (new `--chart-1..8` roles, added to all eight theme blocks per the design-system rule), never hard-coded.
  - *Budget*: under 2 ms of script per frame for all charts together on a mid laptop; frames are skipped when nothing moved (paused and not hovered).
- **`ActivityTable.tsx`**: a lightweight virtualized table (not the result grid: no editing, no cursor ownership), row identity by `pid + backend_start` so a reused pid is a new row, rows animate in/out only by opacity.
- **`MonitorTab.tsx`**: the tab body — header, tiles, view switcher, charts, tables, the cancel/terminate confirm (a `Surface` bound to the connection).
- **Tab kind**: `Tab.kind: "sql" | "monitor"`. Run, Explain, Save, Format and the editor are absent on a monitor tab; `executeQuery`, `loadMore`, export and persistence guard on the kind. The tab is never dirty and never asks to be saved.
- Event subscription filters on `connectionId` + `monitorGeneration` via `StaleGuard`, so a late sample from a stopped monitor is inert.

### 4.3 Why not a chart library

Two candidates were weighed: **uPlot** (~45 KB, canvas, excellent at large series) and an in-house canvas renderer (~600 lines). The recommendation is **in-house**: Tusk's charts are a fixed, small set of shapes (line, stacked area, event ticks, sparkline), the smooth-scroll and shared-crosshair behaviour is the product, and theming must follow the token system. uPlot remains the fallback if the renderer spike misses the frame budget.

---

## 5. Performance budget

| Where | Budget | How |
|---|---|---|
| Server, fast tier | < 1 ms per tick | Shared-memory stats views only; one statement; no `pg_locks` or sizes on the fast tier. |
| Server, activity tier | < 5 ms per 2 s | Bounded rows; only while visible. |
| Network | ~1 KiB/s fast tier | One row per tick. |
| IPC | one event per tick | Rust computes rates; no per-series events. |
| App CPU while visible | < 3% of one core | Shared rAF loop, decimation, skip idle frames. |
| App CPU while hidden | ~0 | Sampling pauses when the tab or window is hidden (configurable "keep sampling in background" for capturing an incident). |
| Memory | < 5 MiB per monitor | 3,600 points × ~40 series × 8 bytes ≈ 1.2 MiB, plus activity summaries. |

---

## 6. Safety

- The sidecar is **read-only at the engine** and runs only Tusk's own fixed SQL; no user text ever reaches it, so the SQL guard has nothing to classify.
- **Cancel/Terminate** are the only state-changing actions. They are refused on read-only connections, confirmed with the target named, carry the production badge, are permission-checked in the UI, the backend and the server, and are recorded in history as `-- [Monitor] SELECT pg_terminate_backend(1234)`.
- A monitor on a production-tagged connection shows the prod rail like every other tab.
- Payloads are bounded at the boundary, like every other IPC path (`docs/adversarial-hardening.md` gains a monitor row).

---

## 7. Other engines (phase 3)

| | PostgreSQL | MySQL / MariaDB | SQL Server | DuckDB / SQLite |
|---|---|---|---|---|
| Throughput | `pg_stat_database` | `SHOW GLOBAL STATUS` (`Questions`, `Com_*`, `Handler_*`) | `sys.dm_os_performance_counters` (`Batch Requests/sec`, `Transactions/sec`) | — |
| Sessions | `pg_stat_activity` | `performance_schema.processlist` (8.0.22+), else `information_schema.PROCESSLIST` | `sys.dm_exec_sessions` + `sys.dm_exec_requests` | — |
| Load by wait | `wait_event_type` | `performance_schema.events_waits_current` (if enabled) | `sys.dm_exec_requests.wait_type` / `sys.dm_os_wait_stats` Δ | — |
| Cache | `blks_hit/read` | `Innodb_buffer_pool_read_requests/reads` | `Buffer cache hit ratio`, `Page life expectancy` | — |
| Cancel / kill | `pg_cancel_backend` / `pg_terminate_backend` | `KILL QUERY id` / `KILL id` | `KILL spid` (no query-only cancel) | — |
| Privilege | `pg_monitor` | `PROCESS` | `VIEW SERVER STATE` (2022: `VIEW SERVER PERFORMANCE STATE`) | — |

Embedded engines get no Monitor entry; the button is hidden with a tooltip-free absence rather than a disabled control.

---

## 8. Testing and verification

- **Rust unit tests**: delta/rate math including counter resets and skipped ticks; version-gated SQL selection per major version; payload bounds; refusal of signal on read-only and on the monitor's own pid.
- **Conformance**: a `monitor_battery` in `driver_conformance.rs` run by `scripts/conformance.sh` against the Docker PostgreSQL (and, when added, MySQL and SQL Server): start, three ticks, every fast-tier field present and finite, activity contains the conformance session, cancel of a `pg_sleep` session returns true, stop leaves no `Tusk monitor` backend behind. Ideally two PostgreSQL majors (one ≤ 16, one ≥ 17) because of the checkpointer split.
- **Vitest**: `model.ts` (ring buffer wrap, gaps, decimation, nice-ticks, blocking tree, clock offset) and the canvas layout maths (pure functions; drawing itself stays thin).
- **Live smoke** (the CDP recipe): a throwaway PostgreSQL with `pgbench -c 16 -T 120` plus a deliberate lock wait; screenshots of every view; `performance.now()` frame timings over 30 s to prove the budget; app CPU from the OS while visible and hidden.

---

## 9. Phases

| Phase | Scope | Done when |
|---|---|---|
| **0 · Spike** (½–1 day) | Sidecar session + fast-tier query + event + one smooth-scrolling canvas chart. | Frame and CPU budgets measured on a real server; go/no-go on the in-house renderer. |
| **1 · PostgreSQL MVP** | Monitor tab kind and entry points; tiles; charts 1–6; Activity with filters, live durations, blocking nesting, Cancel/Terminate; pause/interval/window; shared crosshair; help topic, changelog, What's-new digest. | Conformance + vitest + smoke green; the manual documents it. |
| **2 · Depth** | Locks view; Statements (`pg_stat_statements`); Replication; Tables & maintenance with progress bars; scrub-and-freeze; checkpoint/event markers; `pg_stat_io`. | Same gates; each view degrades cleanly on older versions and without privileges. |
| **3 · Breadth** | MySQL and SQL Server sources; optional `system_stats` host metrics; export a window as CSV/PNG; configurable thresholds. | Conformance for each engine. |

---

## 10. Decisions (settled 2026-10-20)

All six were taken as recommended:

1. **Placement: a Monitor tab** — a second tab kind in the existing strip, one per connection, following its focus and colour rail and closing with it (§3.1).
2. **Cancel/Terminate on read-only connections: refused, both.** Read-only means Tusk changes nothing on the server; the actions are disabled with an explanation (§6).
3. **Background sampling: pause when hidden, opt-in "keep sampling".** Hidden means the Monitor tab is not active, the window is minimized, or the page is hidden. The spike showed WebView2 keeps `visibilityState: "visible"` while minimized, so all three are checked, and the sampler itself pauses (`monitor_configure`), not just the drawing (§11 finding 3).
4. **Engines: PostgreSQL only until phase 3**, then MySQL and SQL Server (§7).
5. **Retention: in-memory rolling window only** for v1 (5 min default, up to 1 h), gone when the tab closes.
6. **Scroll redraw rate: about 6 per second for the 1-minute window** (2 px steps, ~2% of one core measured under load). Longer windows redraw less often on their own.

---

## 11. Spike results (phase 0, 2026-10-19)

**Verdict: GO on the in-house canvas renderer; uPlot is not needed.** Drawing is 5 to 20 times under its script budget. What costs CPU is WebView2 compositing each redraw, and uPlot would pay that the same way. The 3% CPU budget holds only if a 1-minute window redraws about 6 times a second or less (decision 6 above). The fast-tier query costs about 0.4 ms of server time per tick, under its 1 ms budget.

### What was built

Throwaway quality, hidden: palette action *Database monitor (experimental)*, dev builds only, or `localStorage["tusk.experimental"] = "monitor"`.

- `src-tauri/src/monitor/`: a read-only sidecar `Backend` cloned from a new lock-free `Arc<ConnectionConfig>` snapshot on the registry entry (`RegisteredConn::config`), so `monitor_start` never waits behind a running user query. The session runs `application_name 'Tusk monitor'`, `statement_timeout 2s`, `lock_timeout 250ms` and `idle_in_transaction_session_timeout 10s`. A tokio sampler (`MissedTickBehavior::Skip`, 1 s) runs one fast-tier statement per tick. Rates are computed in Rust, and a counter that goes backwards re-baselines. The sampler emits one `monitor-sample` event per tick and reconnects with 1 s to 30 s backoff without retrying statements. `monitor_start` and `monitor_stop` are registered commands, and `disconnect` stops the sidecar. The fast-tier row is bounded by `db::MONITOR_TEXT_LIMITS`.
- `src/monitor/`: `model.ts` (Float64Array rings, gap rows, monotonic clock mapping, nice ceilings; vitest), `frameLoop.ts` (one shared loop), `TimeSeries.tsx` (canvas, devicePixelRatio, colours from tokens, absolute-time decimation, eased y-axis), and the `MonitorSpike.tsx` panel (stacked *Database load by wait type* and a TPS line).

### Method

- **Machine and build:** Windows 11 with WebView2 155, `npm run tauri dev` (debug Rust, Vite dev frontend) at devicePixelRatio 1. The panel is 760 px wide with two canvases (160 px and 110 px, plot area about 700 px).
- **Server:** `postgres:16-alpine` (16.14) under Docker Desktop on host port 55499, `pgbench -i -s 20`, then `pgbench -c 16 -j 4 -T 120`, run five times. pgbench reached 74 to 96 tps with 16 active sessions, mostly Lock, LWLock and IO waits (Docker-on-Windows I/O bound).
- **App CPU:** the change in `TotalProcessorTime` across `tusk.exe` and its WebView2 child processes over 26 to 30 s, as a percentage of one core. Other containers were running on the machine, so identical runs differ by about ±1.5 points.
- **Frame time:** `performance.now()` around every chart's draw in a frame. WebView2 rounds this clock to 0.1 ms.
- **Server time:** `pg_stat_statements` with `track_planning = on`.

### Numbers (under pgbench unless marked idle)

| Configuration | Redraws/s | Script per frame (p50 / p95 / max) | App CPU, % of one core |
|---|---|---|---|
| 1 m window, every vsync (no pacing) | 60 | 0.1 / 0.2 / 0.4 ms | 12.4 (11.5 idle) |
| 1 m window, 0.5 px steps | 20–21 | 0.1 / 0.2 / 0.5 ms | 4.6–7.9 (7.1 idle) |
| 1 m window, 1 px steps (committed spike default) | 10–13 | 0.1 / 0.2 / 1.9 ms | 3.2–5.4 (3.5 idle) |
| 1 m window, 2 px steps | 6 | 0.1 / 0.2 / 0.5 ms | 2.3 (1.8 idle) |
| 5 m window, 1 px steps | 3 | 0.1 / 0.2 / 0.2 ms | 1.7 |
| 1 h window, 3,600 synthetic rows × 11 series, decimated | 1 (one per sample) | 0.4 / 0.5 / 0.6 ms | 1.5 |
| Window minimized (drawing suspended, sampler still running) | 0 | — | 0.5 |
| Monitor closed | 0 | — | 0.06 |

- **Fast tier, server side:** across 121–122 calls per 120 s run, execution averaged 0.141–0.148 ms (max 0.35–0.99) and planning 0.25–0.28 ms (max 2.4 ms, the cold first plan). That makes about 0.4 ms per tick, with no shared-buffer reads.
- **Round trip seen by the app** (debug build, through Docker's NAT): p50 1.7–1.9 ms, p95 2.1–3.6 ms, max 5 ms. All of about 460 measured ticks succeeded.
- **Lifecycle:** closing the panel, a frontend Disconnect, and a raw backend `disconnect` all left no `Tusk monitor` backend on the server. A remount after a hot reload replaced the old sidecar with a new one.

### Findings that change phase 1

1. **Redraw rate drives CPU; drawing does not.** Each redraw costs about 0.3% of a core in WebView2's renderer and GPU processes. One canvas or two at the same rate measured the same within noise (4.3% and 3.8%). Pace by distance scrolled, as `frameLoop.ts` does, rather than by vsync: a chart returns when it next needs a frame, and the loop sleeps on a timer in between. Longer windows then cost almost nothing.
2. **Draw all charts on one clock.** Two charts that drifted a few milliseconds apart made 25 redraws/s where one made 20. The spike draws everything due within 20 ms in the same frame. Phase 1 should give all charts one shared schedule.
3. **A minimized window does not hide the page.** Under Tauri, WebView2 kept `visibilityState: "visible"` and kept drawing at 20 fps while the window was minimized. The spike suspends drawing from Tauri `onResized` plus `isMinimized()`, which brought CPU to 0.5%. Phase 1 must combine window state, page visibility and whether the Monitor tab is active, and should also pause the sampler (`monitor_configure`).
4. **A page reload leaks monitor sidecars.** A webview reload, such as a full HMR reload in dev, leaves earlier backend connections registered (existing behaviour), and their sidecars kept sampling. Phase 1 needs a `monitor_stop_all` on mount, or a lease the frontend must renew.
5. **Planning costs twice what execution does.** Under the simple query protocol the fast tier is re-planned every tick. A prepared statement on the sidecar would save about 0.25 ms per tick; the budget does not require it.
6. **TPS at 1 s swings about ±40% around pgbench's average.** Part of that is real, since pgbench's latency standard deviation was 108 ms on a 190 ms mean. Part may come from PostgreSQL 15+ backends flushing their stats at most once a second. Consider showing a short moving average beside the raw line.

### Not covered

- **Release build:** not measured. `tusk.exe` itself stayed at or below 0.2% even in debug, and the cost that matters sits in WebView2, so the conclusions should hold.
- **HiDPI:** not measured. Only devicePixelRatio 1 was tested, and a ratio of 2 rasterizes four times the pixels; phase 1 should measure it on a laptop panel.
- **macOS and Linux:** WKWebView and WebKitGTK were not tested.
- **Left out of the spike:** crosshair, reduced motion, per-series min/max decimation for line charts, and `monitor_configure`.

---

## 12. Phase 1 results (2026-10-20)

Built as planned in §4, on current master rather than the spike branch: the sidecar, the lock-free config snapshot, Rust-side rates, the paced frame loop and the rings carried over; everything else was rewritten to production quality. Locks, Statements and the other phase-2 views are not in it.

### Measured (live smoke)

`npm run tauri dev` (debug), WebView2, devicePixelRatio 1, a 1200 × 820 window with the Overview in one column, `postgres:16-alpine` under `pgbench -c 16 -j 4`.

| Configuration | Redraws/s | Script per frame (p50 / p99) | App CPU, % of one core |
|---|---|---|---|
| Overview, 5-min window (the default) | 2.9 | 0.2 / 1.0 ms | ~2.1 |
| Overview, 1-min window | 7.1 | 0.2 / 0.9 ms | ~3.1 |
| Overview, 1-hour window | 1.3 | 0.1 / 3.2 ms | — |
| Activity view | — | — | ~2.3 |
| Emulated devicePixelRatio 2, 1-min window | 7.6 | 0.4 / 0.8 ms | — |
| Minimized (sampler paused server-side) | 0 | — | 0.08 |
| Minimized with Keep sampling | 0 | — | 1.4 |

- Three changes were needed to get there, all about compositing, not drawing: an endless CSS pulse on the *Live* dot cost ~10% of a core by itself (removed); a tile's tone effect re-read the theme and forced a full redraw on every sample (memoized); and charts scrolled out of view were still redrawn (now skipped, which halved the 1-minute cost). Axis easing animates at 40 ms frames instead of every vsync, and sparklines snap.
- With every chart on screen at once (a tall or two-column window) the 1-minute window costs more, in proportion to the canvas area composited; the 5-minute default stays near 2%.
- Lifecycle: a webview reload's `monitor_stop_all` sweep left no `Tusk monitor` backend; closing the tab, disconnecting, and pausing all stopped the queries (the sidecar reported idle on the server).
- The conformance monitor battery passed on PostgreSQL 10, 13, 16 and 17.

### Not covered

- Release build, a physical HiDPI panel (only emulated DPR 2), macOS and Linux.

---

## 13. Phase 2 results (2026-10-20)

Built as planned in §2.4–2.5 and §3.3: Locks, Statements, Replication, Tables & maintenance and I/O views, charts 7 and 8 (writes with checkpoint markers; an events lane), and scrub-and-freeze. Two choices differ from the plan's wording:

- **No separate `monitor_detail` command.** Opening a view sends its tier in `monitor_configure`, and the sampler runs a newly opened tier on its next tick, which is what the one-shot fetch was for.
- **Statements are ranked from interval snapshots.** The backend reads `pg_stat_statements` numbers-only every 10 s, diffs each statement, and sends the interval's top 50 by time with their text (fetched once per statement). The view sums those snapshots over the chart window or a frozen range. A statement outside an interval's top 50 contributes nothing for that interval, so the ranking is of what dominated, which is what the view is for.

Cadences: Locks and progress 2 s, Replication 5 s, I/O and Statements 10 s, table statistics and wraparound 30 s, each only while its view is open. "Active in the selected range" reads compact summaries (the ten longest-running active client sessions per process-list sample, an hour's worth) rather than re-querying.

### Measured

Live smoke on `postgres:16-alpine` with `pg_stat_statements` preloaded, under `pgbench -c 12`: every view populated (lock waits on tuples and transaction IDs with nested blocking chains; statements ranked with pgbench's updates on top; an inactive slot retaining 421 MiB; a throttled `VACUUM` showing live progress; `pg_stat_io` rates by backend type), checkpoint markers and the events lane recorded a requested checkpoint and temporary files, and a drag froze every chart with the range summary below. App CPU on the Overview, now seven charts plus the events lane: about 1.8% of a core on the 5-minute window and 3.75% on the 1-minute window (±1.5 points of noise; off-screen charts are not drawn). The views battery passed on PostgreSQL 10, 13, 16 and 17.

