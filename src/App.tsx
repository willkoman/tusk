import { createSignal, createMemo, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { SqlEditor } from "./SqlEditor";

type ColumnInfo = { name: string; data_type: string };
type TableInfo = { schema: string; name: string; columns: ColumnInfo[] };
type Profile = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  dbname: string;
  save_password: boolean;
};
type QueryOutcome =
  | { kind: "rows"; columns: string[]; rows: (string | null)[][]; done: boolean }
  | { kind: "exec"; message: string };
type FetchResult = { rows: (string | null)[][]; done: boolean };

const ROW_H = 28;
const PAGE = 1000;
const COL_W = 180;

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as any).message);
  return String(e);
}

function App() {
  const [conn, setConn] = createSignal<{ id: string; version: string } | null>(null);

  // saved profiles + connection form
  const [profiles, setProfiles] = createSignal<Profile[]>([]);
  const [editingId, setEditingId] = createSignal("");
  const [name, setName] = createSignal("");
  const [host, setHost] = createSignal("localhost");
  const [port, setPort] = createSignal(5432);
  const [user, setUser] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [dbname, setDbname] = createSignal("postgres");
  const [savePassword, setSavePassword] = createSignal(false);
  const [connecting, setConnecting] = createSignal(false);
  const [connErr, setConnErr] = createSignal("");

  // workspace
  const [schema, setSchema] = createSignal<TableInfo[]>([]);
  const [sql, setSql] = createSignal("SELECT * FROM information_schema.tables;");
  const [columns, setColumns] = createSignal<string[]>([]);
  const [rows, setRows] = createSignal<(string | null)[][]>([]);
  const [done, setDone] = createSignal(true);
  const [running, setRunning] = createSignal(false);
  const [status, setStatus] = createSignal("");
  const [runErr, setRunErr] = createSignal("");
  const [elapsed, setElapsed] = createSignal(0);

  // virtualization
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportH, setViewportH] = createSignal(500);
  let scroller: HTMLDivElement | undefined;
  let loadingMore = false;

  onMount(loadProfiles);

  async function loadProfiles() {
    try {
      setProfiles(await invoke<Profile[]>("list_profiles"));
    } catch (e) {
      console.error(e);
    }
  }

  function newProfile() {
    setEditingId("");
    setName("");
    setHost("localhost");
    setPort(5432);
    setUser("");
    setPassword("");
    setDbname("postgres");
    setSavePassword(false);
    setConnErr("");
  }

  function editProfile(p: Profile) {
    setEditingId(p.id);
    setName(p.name);
    setHost(p.host);
    setPort(p.port);
    setUser(p.user);
    setPassword("");
    setDbname(p.dbname);
    setSavePassword(p.save_password);
    setConnErr("");
  }

  function useProfile(p: Profile) {
    if (p.save_password) connectProfile(p.id);
    else editProfile(p);
  }

  async function afterConnect(r: { connection_id: string; server_version: string }) {
    setConn({ id: r.connection_id, version: r.server_version });
    await loadSchema();
  }

  async function doConnect(e: Event) {
    e.preventDefault();
    setConnecting(true);
    setConnErr("");
    try {
      const r = await invoke<{ connection_id: string; server_version: string }>("connect", {
        config: {
          host: host(),
          port: Number(port()),
          user: user(),
          password: password(),
          dbname: dbname(),
        },
      });
      await afterConnect(r);
    } catch (e) {
      setConnErr(errMsg(e));
    } finally {
      setConnecting(false);
    }
  }

  async function connectProfile(id: string) {
    setConnecting(true);
    setConnErr("");
    try {
      await afterConnect(await invoke("connect_profile", { id }));
    } catch (e) {
      setConnErr(errMsg(e));
    } finally {
      setConnecting(false);
    }
  }

  async function saveProfile() {
    setConnErr("");
    try {
      const p = await invoke<Profile>("save_profile", {
        profile: {
          id: editingId(),
          name: name() || host(),
          host: host(),
          port: Number(port()),
          user: user(),
          dbname: dbname(),
          save_password: savePassword(),
        },
        password: savePassword() && password() ? password() : null,
      });
      setEditingId(p.id);
      await loadProfiles();
    } catch (e) {
      setConnErr(errMsg(e));
    }
  }

  async function deleteProfile(id: string) {
    try {
      await invoke("delete_profile", { id });
      if (editingId() === id) newProfile();
      await loadProfiles();
    } catch (e) {
      console.error(e);
    }
  }

  async function disconnect() {
    const c = conn();
    if (c) invoke("disconnect", { connectionId: c.id }).catch(() => {});
    setConn(null);
    setSchema([]);
    setColumns([]);
    setRows([]);
    setStatus("");
  }

  async function loadSchema() {
    const c = conn();
    if (!c) return;
    try {
      setSchema(await invoke<TableInfo[]>("list_schema", { connectionId: c.id }));
    } catch (e) {
      console.error(e);
    }
  }

  async function doRun() {
    const c = conn();
    if (!c || running()) return;
    setRunning(true);
    setRunErr("");
    setStatus("");
    const t0 = performance.now();
    try {
      const out = await invoke<QueryOutcome>("run_query", {
        connectionId: c.id,
        sql: sql(),
        pageSize: PAGE,
      });
      if (out.kind === "rows") {
        setColumns(out.columns);
        setRows(out.rows);
        setDone(out.done);
        if (scroller) scroller.scrollTop = 0;
        setScrollTop(0);
        setStatus(`${out.rows.length}${out.done ? "" : "+"} rows`);
      } else {
        setColumns([]);
        setRows([]);
        setDone(true);
        setStatus(out.message);
      }
    } catch (e) {
      setRunErr(errMsg(e));
      setColumns([]);
      setRows([]);
      setDone(true);
    } finally {
      setRunning(false);
      setElapsed(Math.round(performance.now() - t0));
    }
  }

  async function loadMore() {
    const c = conn();
    if (!c || done() || loadingMore) return;
    loadingMore = true;
    try {
      const r = await invoke<FetchResult>("fetch_more", { connectionId: c.id, pageSize: PAGE });
      if (r.rows.length) setRows((prev) => [...prev, ...r.rows]);
      setDone(r.done);
      setStatus(`${rows().length}${r.done ? "" : "+"} rows`);
    } catch (e) {
      console.error(e);
      setDone(true);
    } finally {
      loadingMore = false;
    }
  }

  function onScroll(e: Event) {
    const el = e.currentTarget as HTMLDivElement;
    setScrollTop(el.scrollTop);
    setViewportH(el.clientHeight);
    if (el.scrollTop + el.clientHeight > el.scrollHeight - ROW_H * 50) loadMore();
  }

  function mountScroller(el: HTMLDivElement) {
    scroller = el;
    requestAnimationFrame(() => setViewportH(el.clientHeight));
    new ResizeObserver(() => setViewportH(el.clientHeight)).observe(el);
  }

  const totalH = createMemo(() => rows().length * ROW_H);
  const gridW = createMemo(() => Math.max(columns().length * COL_W, COL_W));
  const visible = createMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop() / ROW_H) - 8);
    const count = Math.ceil(viewportH() / ROW_H) + 16;
    const end = Math.min(rows().length, start + count);
    return rows()
      .slice(start, end)
      .map((row, k) => ({ row, idx: start + k }));
  });

  const grouped = createMemo(() => {
    const g: Record<string, TableInfo[]> = {};
    for (const t of schema()) (g[t.schema] ??= []).push(t);
    return Object.entries(g);
  });

  function runTable(t: TableInfo) {
    setSql(`SELECT * FROM "${t.schema}"."${t.name}"`);
    doRun();
  }

  return (
    <Show
      when={conn()}
      fallback={
        <div class="connect-screen">
          <div class="connect-layout">
            <div class="profiles-panel">
              <div class="panel-title">Connections</div>
              <For each={profiles()}>
                {(p) => (
                  <div class="profile-row" classList={{ active: editingId() === p.id }}>
                    <div class="profile-main" onClick={() => useProfile(p)}>
                      <div class="profile-name">{p.name || p.host}</div>
                      <div class="profile-sub">
                        {p.user}@{p.host}:{p.port}/{p.dbname}{p.save_password ? " · 🔒" : ""}
                      </div>
                    </div>
                    <button class="icon" title="Edit" onClick={() => editProfile(p)}>✎</button>
                    <button class="icon" title="Delete" onClick={() => deleteProfile(p.id)}>🗑</button>
                  </div>
                )}
              </For>
              <Show when={profiles().length === 0}><div class="empty-hint">no saved connections</div></Show>
              <button class="ghost full" onClick={newProfile}>＋ New connection</button>
            </div>

            <form class="connect-card" onSubmit={doConnect}>
              <div class="brand">🐘 Tusk</div>
              <div class="subtitle">{editingId() ? "edit connection" : "new connection"}</div>
              <label>Name<input value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="My database" /></label>
              <label>Host<input value={host()} onInput={(e) => setHost(e.currentTarget.value)} /></label>
              <label>Port<input type="number" value={port()} onInput={(e) => setPort(Number(e.currentTarget.value))} /></label>
              <label>User<input value={user()} onInput={(e) => setUser(e.currentTarget.value)} placeholder="postgres" /></label>
              <label>Password<input type="password" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} placeholder={editingId() && savePassword() ? "•••••• (stored)" : ""} /></label>
              <label>Database<input value={dbname()} onInput={(e) => setDbname(e.currentTarget.value)} /></label>
              <label class="checkbox"><input type="checkbox" checked={savePassword()} onChange={(e) => setSavePassword(e.currentTarget.checked)} />Save password in OS keychain</label>
              <div class="form-actions">
                <button type="button" class="ghost" onClick={saveProfile}>Save</button>
                <button type="submit" disabled={connecting()}>{connecting() ? "Connecting…" : "Connect"}</button>
              </div>
              <Show when={connErr()}><div class="error">{connErr()}</div></Show>
            </form>
          </div>
        </div>
      }
    >
      <div class="workspace">
        <header class="topbar">
          <span class="brand-sm">🐘 Tusk</span>
          <span class="meta">PostgreSQL {conn()!.version}</span>
          <span class="spacer" />
          <button class="ghost" onClick={disconnect}>Disconnect</button>
        </header>

        <div class="body">
          <aside class="sidebar">
            <For each={grouped()}>
              {([schemaName, tables]) => (
                <div class="schema-group">
                  <div class="schema-name">{schemaName}</div>
                  <For each={tables}>
                    {(t) => (
                      <div class="table-item" title={`${t.columns.length} columns`} onClick={() => runTable(t)}>
                        {t.name}
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
            <Show when={schema().length === 0}><div class="empty-hint">no tables</div></Show>
          </aside>

          <main class="main">
            <div class="editor-pane">
              <SqlEditor value={sql()} onChange={setSql} onRun={doRun} tables={schema()} />
              <div class="toolbar">
                <button class="run" onClick={doRun} disabled={running()}>{running() ? "Running…" : "Run ▶"}</button>
                <span class="hint">⌘/Ctrl+Enter</span>
              </div>
            </div>

            <div class="result">
              <Show when={runErr()}><div class="error result-error">{runErr()}</div></Show>
              <Show when={columns().length > 0} fallback={<div class="result-empty">{status() || "no results"}</div>}>
                <div class="grid-scroll" ref={mountScroller} onScroll={onScroll}>
                  <div class="grid-header" style={{ width: `${gridW()}px` }}>
                    <For each={columns()}>
                      {(c) => <div class="cell head" style={{ width: `${COL_W}px` }}>{c}</div>}
                    </For>
                  </div>
                  <div class="grid-body" style={{ height: `${totalH()}px`, width: `${gridW()}px` }}>
                    <For each={visible()}>
                      {(item) => (
                        <div class="grid-row" style={{ top: `${item.idx * ROW_H}px`, width: `${gridW()}px` }}>
                          <For each={item.row}>
                            {(cell) => (
                              <div class="cell" style={{ width: `${COL_W}px` }}>
                                {cell === null ? <span class="null">NULL</span> : cell}
                              </div>
                            )}
                          </For>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </div>

            <footer class="statusbar">
              <span>{status()}</span>
              <span class="spacer" />
              <Show when={!done()}><span class="streaming">streaming…</span></Show>
              <span>{elapsed()} ms</span>
            </footer>
          </main>
        </div>
      </div>
    </Show>
  );
}

export default App;
