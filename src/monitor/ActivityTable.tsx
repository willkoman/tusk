import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Icon } from "../Icons";
import { ACTIVITY_COLUMNS, activityColumns, visibleRange, type ActivityColumn } from "./layout";
import {
  DEFAULT_ACTIVITY_FILTER,
  HIDDEN_QUERY,
  blockingTree,
  formatDuration,
  isClientBackend,
  liveDuration,
  matchesFilter,
  queryAgeStart,
  rowKey,
  waitLabel,
  type ActivityFilter,
  type ActivityNode,
  type ActivityRow,
  type ActivitySort,
} from "./model";
import type { MonitorSession } from "./session";

const ROW_H = 26;

/** The state's dot colour class: active is working, idle-in-transaction needs attention. */
export function stateClass(state: string | null): string {
  switch (state) {
    case "active": return "st-active";
    case "idle in transaction": return "st-idle-tx";
    case "idle in transaction (aborted)": return "st-aborted";
    case "idle": return "st-idle";
    default: return "st-other";
  }
}

/**
 * A ticking clock for live durations: one signal, one timer, only while a table that
 * shows durations is mounted. Durations count against the SERVER's clock (measured
 * offset), so a server whose clock is off ours still reads right.
 */
export function useServerNow(session: MonitorSession): () => number {
  const [now, setNow] = createSignal(session.serverClock.now(Date.now()));
  onMount(() => {
    const timer = setInterval(() => setNow(session.serverClock.now(Date.now())), 1000);
    onCleanup(() => clearInterval(timer));
  });
  return now;
}

/**
 * The process list: filters, live durations, sortable columns, blocked sessions
 * nested under their blocker, and a row menu (Copy / Open / Explain / Cancel /
 * Terminate) that App builds. A lightweight virtual list, not the result grid: no
 * editing and no cursor ownership.
 */
export function ActivityTable(props: {
  session: MonitorSession;
  onRowMenu: (e: MouseEvent, row: ActivityRow) => void;
}) {
  const s = props.session;
  const [filter, setFilter] = createSignal<ActivityFilter>(DEFAULT_ACTIVITY_FILTER);
  const [sort, setSort] = createSignal<ActivitySort>(null);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [width, setWidth] = createSignal(1200);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewport, setViewport] = createSignal(400);
  const serverNow = useServerNow(s);
  let body: HTMLDivElement | undefined;
  let host: HTMLDivElement | undefined;

  const me = () => ({ user: s.started()?.server.user ?? "", database: s.started()?.server.database ?? "" });
  const rows = () => s.activity()?.rows ?? [];
  const nodes = createMemo(() => blockingTree(rows(), (r) => matchesFilter(r, filter(), me()), sort()));
  const columns = createMemo(() => activityColumns(width()));
  const range = createMemo(() => visibleRange(scrollTop(), viewport(), ROW_H, nodes().length));
  const windowed = createMemo(() => nodes().slice(range().start, range().end));
  const hiddenText = () => !!s.started() && !s.started()!.server.readAllStats && !s.started()!.server.superuser;

  onMount(() => {
    const ro = new ResizeObserver(() => {
      if (host) setWidth(host.clientWidth);
      if (body) setViewport(body.clientHeight);
    });
    if (host) ro.observe(host);
    if (body) ro.observe(body);
    onCleanup(() => ro.disconnect());
  });

  const patch = (p: Partial<ActivityFilter>) => setFilter((f) => ({ ...f, ...p }));
  const toggleSort = (key: ActivityColumn) => {
    const cur = sort();
    // asc → desc → default: the default order ("what is hurting now") is one click away.
    if (!cur || cur.key !== key) setSort({ key, dir: key === "xact" || key === "query" ? "desc" : "asc" });
    else if (cur.dir === (key === "xact" || key === "query" ? "desc" : "asc")) setSort({ key, dir: cur.dir === "asc" ? "desc" : "asc" });
    else setSort(null);
  };
  const shown = () => nodes().length;
  const listed = () => s.activity()?.total ?? 0;

  const cell = (col: ActivityColumn, n: ActivityNode) => {
    const r = n.row;
    switch (col) {
      case "pid":
        return (
          <span class="ma-pid" style={{ "padding-left": `${Math.min(n.depth, 8) * 14}px` }}>
            <Show when={n.depth > 0}><span class="ma-nest" aria-hidden="true">└</span></Show>
            {r.pid}
          </span>
        );
      case "user": return r.user ?? "–";
      case "database": return r.database ?? "–";
      case "application": return r.application || "–";
      case "client": return r.client ?? "–";
      case "backendType": return r.backendType ?? "–";
      case "state":
        return (
          <span class="ma-state">
            <span class={`ma-dot ${stateClass(r.state)}`} />
            {r.state ?? (isClientBackend(r) ? "hidden" : "–")}
          </span>
        );
      case "wait": return waitLabel(r) || "–";
      case "xact": return formatDuration(liveDuration(r.xactStartMs, serverNow()));
      case "query": return formatDuration(liveDuration(queryAgeStart(r), serverNow()));
      case "blockedBy": return r.blockedBy.length ? r.blockedBy.join(", ") : "";
      case "text": return r.query ?? "";
    }
  };

  const queryTitle = (r: ActivityRow) => {
    if (!r.query) return "";
    if (r.query === HIDDEN_QUERY) return "Another role's query. Grant pg_monitor (or pg_read_all_stats) to see it.";
    return r.queryTruncated ? `${r.query}\n\n(Truncated: the server keeps track_activity_query_size bytes, Tusk shows 1,024 characters.)` : r.query;
  };

  return (
    <div class="monitor-activity" ref={host}>
      <div class="ma-filters">
        <label class="checkbox"><input type="checkbox" checked={filter().hideIdle} onChange={(e) => patch({ hideIdle: e.currentTarget.checked })} />Hide idle</label>
        <label class="checkbox"><input type="checkbox" checked={filter().hideBackground} onChange={(e) => patch({ hideBackground: e.currentTarget.checked })} />Hide background workers</label>
        <label class="checkbox"><input type="checkbox" checked={filter().thisDatabase} onChange={(e) => patch({ thisDatabase: e.currentTarget.checked })} />This database only</label>
        <label class="checkbox"><input type="checkbox" checked={filter().myUser} onChange={(e) => patch({ myUser: e.currentTarget.checked })} />My user only</label>
        <div class="filter-wrap ma-search">
          <span class="filter-search"><Icon name="search" /></span>
          <input
            class="tree-filter"
            placeholder="Search query, application, user…"
            value={filter().text}
            onInput={(e) => patch({ text: e.currentTarget.value })}
            aria-label="Search the process list"
          />
        </div>
        <span class="spacer" />
        <span class="ma-count" title="Rows shown after filters, of the sessions the server listed">
          {shown().toLocaleString()} shown
          <Show when={listed() > rows().length}>
            {" "}· first {rows().length.toLocaleString()} of {listed().toLocaleString()}
          </Show>
        </span>
      </div>
      <Show when={hiddenText()}>
        <div class="monitor-banner">Other users' queries are hidden. Grant <code>pg_monitor</code> to see them.</div>
      </Show>
      <Show when={s.activity()?.error}>
        {(err) => <div class="monitor-banner warn">Process list unavailable: {err()}</div>}
      </Show>
      <div class="ma-table" role="table" aria-label="Server sessions" aria-rowcount={shown()}>
        <div class="ma-row ma-head" role="row">
          <For each={columns()}>
            {(col) => {
              const def = ACTIVITY_COLUMNS.find((c) => c.id === col)!;
              const active = () => sort()?.key === col;
              return (
                <button
                  class={`ma-cell ma-col-${col}`}
                  classList={{ sorted: active() }}
                  role="columnheader"
                  aria-sort={active() ? (sort()!.dir === "asc" ? "ascending" : "descending") : "none"}
                  title={`Sort by ${def.label.toLowerCase()}`}
                  onClick={() => toggleSort(col)}
                >
                  {def.label}
                  <Show when={active()}><Icon name={sort()!.dir === "asc" ? "sortAsc" : "sortDesc"} /></Show>
                </button>
              );
            }}
          </For>
          <span class="ma-cell ma-col-actions" />
        </div>
        <div class="ma-body" ref={body} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
          <Show
            when={shown() > 0}
            fallback={
              <div class="empty-hint">
                {s.activity() ? "No sessions match these filters." : s.status().kind === "live" ? "Loading the process list…" : "Resume the monitor to see the process list."}
              </div>
            }
          >
            <div class="ma-spacer" style={{ height: `${shown() * ROW_H}px` }}>
              <For each={windowed()}>
                {(n, i) => {
                  const key = rowKey(n.row);
                  return (
                    <div
                      class="ma-row"
                      role="row"
                      classList={{
                        selected: selected() === key,
                        "root-blocker": n.rootBlocker,
                        blocked: n.row.blockedBy.length > 0,
                        context: n.context,
                        cycle: n.cycle,
                      }}
                      style={{ transform: `translateY(${(range().start + i()) * ROW_H}px)` }}
                      onClick={() => setSelected(key)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setSelected(key);
                        props.onRowMenu(e, n.row);
                      }}
                      title={n.rootBlocker ? `Blocks ${n.blocks} session${n.blocks === 1 ? "" : "s"}` : n.context ? "Shown because a listed session waits on it" : undefined}
                    >
                      <For each={columns()}>
                        {(col) => (
                          <span class={`ma-cell ma-col-${col}`} title={col === "text" ? queryTitle(n.row) : undefined} role="cell">
                            {cell(col, n)}
                          </span>
                        )}
                      </For>
                      <span class="ma-cell ma-col-actions">
                        <button
                          class="icon"
                          title="Session actions"
                          aria-label={`Actions for session ${n.row.pid}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected(key);
                            props.onRowMenu(e, n.row);
                          }}
                        >
                          <Icon name="more" />
                        </button>
                      </span>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
