import { createSignal, createMemo, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { SqlEditor, type EditorApi } from "./SqlEditor";
import { type Dataset, parseCSV, parseJSON, EXPORT_EXT } from "./formats";
import { save } from "@tauri-apps/plugin-dialog";
import { Tree, type DbTree } from "./Tree";

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
  sslmode?: string | null;
  read_only: boolean;
};
type QueryOutcome =
  | { kind: "rows"; columns: string[]; rows: (string | null)[][]; done: boolean }
  | { kind: "exec"; message: string };
type FetchResult = { rows: (string | null)[][]; done: boolean };

const ROW_H = 28;
const PAGE = 1000;
const COL_W = 180;
const DDL_RE = /^\s*(create|alter|drop|truncate|comment|grant|revoke)\b/i;

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
  const [sslmode, setSslmode] = createSignal("prefer");
  const [readOnly, setReadOnly] = createSignal(false);
  const [connecting, setConnecting] = createSignal(false);
  const [connErr, setConnErr] = createSignal("");

  // workspace
  const [tree, setTree] = createSignal<DbTree | null>(null);
  const [sidebarW, setSidebarW] = createSignal(270);
  const schema = createMemo<TableInfo[]>(() => {
    const t = tree();
    if (!t) return [];
    const out: TableInfo[] = [];
    for (const s of t.schemas)
      for (const rel of [...s.tables, ...s.views])
        out.push({
          schema: s.name,
          name: rel.name,
          columns: rel.columns.map((c) => ({ name: c.name, data_type: c.data_type })),
        });
    return out;
  });
  const [sql, setSql] = createSignal("SELECT * FROM information_schema.tables;");
  const [columns, setColumns] = createSignal<string[]>([]);
  const [rows, setRows] = createSignal<(string | null)[][]>([]);
  const [done, setDone] = createSignal(true);
  const [running, setRunning] = createSignal(false);
  const [status, setStatus] = createSignal("");
  const [runErr, setRunErr] = createSignal("");
  const [elapsed, setElapsed] = createSignal(0);
  const [editorApi, setEditorApi] = createSignal<EditorApi | null>(null);
  const [editorH, setEditorH] = createSignal(Math.max(300, Math.round((window.innerHeight - 120) * 0.6)));
  const [lastQuery, setLastQuery] = createSignal("");

  // import dialog
  const [importOpen, setImportOpen] = createSignal(false);
  const [importData, setImportData] = createSignal<Dataset | null>(null);
  const [importRaw, setImportRaw] = createSignal<{ text: string; name: string } | null>(null);
  const [importHasHeader, setImportHasHeader] = createSignal(true);
  const [importMode, setImportMode] = createSignal<"existing" | "new">("existing");
  const [importTarget, setImportTarget] = createSignal("");
  const [importNewName, setImportNewName] = createSignal("");
  const [importBusy, setImportBusy] = createSignal(false);
  const [importMsg, setImportMsg] = createSignal("");

  // virtualization
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportH, setViewportH] = createSignal(500);
  let scroller: HTMLDivElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  let importFileInput: HTMLInputElement | undefined;
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
    setSslmode("prefer");
    setReadOnly(false);
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
    setSslmode(p.sslmode ?? "prefer");
    setReadOnly(p.read_only);
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
          sslmode: sslmode(),
          read_only: readOnly(),
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
          sslmode: sslmode(),
          read_only: readOnly(),
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
    setTree(null);
    setColumns([]);
    setRows([]);
    setStatus("");
  }

  async function loadSchema() {
    const c = conn();
    if (!c) return;
    try {
      setTree(await invoke<DbTree>("db_tree", { connectionId: c.id }));
    } catch (e) {
      console.error(e);
    }
  }

  async function doRun(override?: string) {
    const c = conn();
    if (!c || running()) return;
    const runText = override ?? editorApi()?.getRunText() ?? sql();
    if (!runText.trim()) return;
    setLastQuery(runText);
    setRunning(true);
    setRunErr("");
    setStatus("");
    const t0 = performance.now();
    try {
      const out = await invoke<QueryOutcome>("run_query", {
        connectionId: c.id,
        sql: runText,
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
      if (out.kind === "exec" || DDL_RE.test(runText)) void loadSchema(); // refresh after scripts/DDL
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

  // --- open / save .sql (webview-native, no plugins) ---
  function openFile() {
    fileInput?.click();
  }
  async function onFileChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    if (f) setSql(await f.text());
    input.value = "";
  }
  function saveFile() {
    const blob = new Blob([sql()], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "query.sql";
    a.click();
    URL.revokeObjectURL(url);
  }

  function tableNameFromSql(s: string): string {
    const m = /from\s+(?:"?[\w]+"?\.)?"?([\w]+)"?/i.exec(s);
    return m ? m[1] : "export";
  }

  async function exportAs(fmt: string) {
    const c = conn();
    const q = lastQuery();
    if (!c || !q || !fmt) return;
    const ext = EXPORT_EXT[fmt] ?? "txt";
    const table = tableNameFromSql(q);
    try {
      const path = await save({
        defaultPath: `${table}.${ext}`,
        filters: [{ name: fmt.toUpperCase(), extensions: [ext] }],
      });
      if (!path) return;
      setStatus("exporting…");
      const n = await invoke<number>("export_to_file", {
        connectionId: c.id,
        sql: q,
        format: fmt,
        table,
        path,
      });
      setStatus(`exported ${n} rows → ${path}`);
    } catch (e) {
      setRunErr(errMsg(e));
    }
  }

  function openImport() {
    setImportData(null);
    setImportRaw(null);
    setImportMsg("");
    setImportMode(schema().length ? "existing" : "new");
    setImportTarget(schema().length ? `${schema()[0].schema}.${schema()[0].name}` : "");
    setImportNewName("");
    setImportOpen(true);
  }

  function reparseImport() {
    const raw = importRaw();
    if (!raw) return;
    const d = raw.name.toLowerCase().endsWith(".json")
      ? parseJSON(raw.text)
      : parseCSV(raw.text, importHasHeader());
    setImportData(d);
    if (!importNewName()) setImportNewName(raw.name.replace(/\.[^.]+$/, "").replace(/[^\w]/g, "_"));
  }

  async function onImportFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = "";
    if (!f) return;
    try {
      setImportRaw({ text: await f.text(), name: f.name });
      setImportMsg("");
      reparseImport();
    } catch (err) {
      setImportMsg(errMsg(err));
    }
  }

  async function doImport() {
    const c = conn();
    const d = importData();
    if (!c || !d || !d.columns.length) return;
    let schemaName = "public";
    let table = "";
    let create = false;
    if (importMode() === "existing") {
      [schemaName, table] = importTarget().split(".");
    } else {
      table = importNewName();
      create = true;
    }
    if (!table) {
      setImportMsg("choose a target table");
      return;
    }
    setImportBusy(true);
    setImportMsg("");
    try {
      const n = await invoke<number>("import_rows", {
        connectionId: c.id,
        schema: schemaName,
        table,
        columns: d.columns,
        rows: d.rows,
        create,
      });
      setImportMsg(`imported ${n} rows`);
      await loadSchema();
      setTimeout(() => setImportOpen(false), 900);
    } catch (e) {
      setImportMsg(errMsg(e));
    } finally {
      setImportBusy(false);
    }
  }

  function startResize(e: MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = editorH();
    const onMove = (ev: MouseEvent) =>
      setEditorH(Math.max(80, Math.min(startH + (ev.clientY - startY), window.innerHeight - 160)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
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

  function runTable(schemaName: string, name: string) {
    const q = `SELECT * FROM "${schemaName}"."${name}"`;
    setSql(q);
    doRun(q);
  }

  function startResizeSidebar(e: MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarW();
    const onMove = (ev: MouseEvent) =>
      setSidebarW(Math.max(180, Math.min(startW + (ev.clientX - startX), 560)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
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
              <label>SSL Mode
                <select value={sslmode()} onChange={(e) => setSslmode(e.currentTarget.value)}>
                  <option value="disable">disable</option>
                  <option value="prefer">prefer</option>
                  <option value="require">require</option>
                  <option value="verify-full">verify-full</option>
                </select>
              </label>
              <label class="checkbox"><input type="checkbox" checked={readOnly()} onChange={(e) => setReadOnly(e.currentTarget.checked)} />Read-only (block writes &amp; DDL)</label>
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
          <aside class="sidebar" style={{ width: `${sidebarW()}px` }}>
            <div class="sidebar-head">
              <span class="panel-title2">Explorer</span>
              <div class="head-actions">
                <button class="icon" title="Import data" onClick={openImport}>⤓</button>
                <button class="icon" title="Refresh" onClick={() => loadSchema()}>↻</button>
              </div>
            </div>
            <div class="sidebar-body">
              <Show when={tree()} fallback={<div class="empty-hint">no objects</div>}>
                {(t) => <Tree tree={t()} onRunTable={runTable} />}
              </Show>
            </div>
          </aside>
          <div class="splitter-v" onMouseDown={startResizeSidebar} />

          <main class="main">
            <div class="editor-pane" style={{ height: `${editorH()}px` }}>
              <SqlEditor
                value={sql()}
                onChange={setSql}
                onRun={() => doRun()}
                tables={schema()}
                onReady={setEditorApi}
              />
              <div class="toolbar">
                <button class="run" onClick={() => doRun()} disabled={running()}>{running() ? "Running…" : "Run ▶"}</button>
                <button class="ghost" onClick={openFile}>Open</button>
                <button class="ghost" onClick={saveFile}>Save</button>
                <span class="hint">⌘/Ctrl+Enter · runs selection or all</span>
                <input ref={fileInput} type="file" accept=".sql,.txt" style={{ display: "none" }} onChange={onFileChange} />
              </div>
            </div>

            <div class="splitter" onMouseDown={startResize} />

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
              <Show when={lastQuery()}>
                <select class="export-select" onChange={(e) => { exportAs(e.currentTarget.value); e.currentTarget.value = ""; }}>
                  <option value="">Export…</option>
                  <option value="csv">CSV</option>
                  <option value="tsv">TSV</option>
                  <option value="json">JSON</option>
                  <option value="sql">SQL inserts</option>
                  <option value="markdown">Markdown</option>
                </select>
              </Show>
              <span>{elapsed()} ms</span>
            </footer>
          </main>
        </div>

        <Show when={importOpen()}>
          <div class="modal-overlay" onClick={() => setImportOpen(false)}>
            <div class="modal" onClick={(e) => e.stopPropagation()}>
              <div class="modal-head">Import data<span class="spacer" /><button class="icon" onClick={() => setImportOpen(false)}>✕</button></div>
              <input ref={importFileInput} type="file" accept=".csv,.tsv,.json,.txt" style={{ display: "none" }} onChange={onImportFile} />
              <button class="ghost full" onClick={() => importFileInput?.click()}>Choose file…</button>
              <Show when={importRaw()}>
                <label class="checkbox"><input type="checkbox" checked={importHasHeader()} onChange={(e) => { setImportHasHeader(e.currentTarget.checked); reparseImport(); }} />First row is header (CSV)</label>
              </Show>
              <Show when={importData()}>
                {(d) => (
                  <>
                    <div class="import-info">{d().columns.length} cols · {d().rows.length} rows · {d().columns.slice(0, 6).join(", ")}{d().columns.length > 6 ? "…" : ""}</div>
                    <div class="seg">
                      <button classList={{ active: importMode() === "existing" }} onClick={() => setImportMode("existing")}>Existing table</button>
                      <button classList={{ active: importMode() === "new" }} onClick={() => setImportMode("new")}>New table</button>
                    </div>
                    <Show
                      when={importMode() === "existing"}
                      fallback={<label>New table name<input value={importNewName()} onInput={(e) => setImportNewName(e.currentTarget.value)} placeholder="table_name" /></label>}
                    >
                      <label>Target table
                        <select value={importTarget()} onChange={(e) => setImportTarget(e.currentTarget.value)}>
                          <For each={schema()}>{(t) => <option value={`${t.schema}.${t.name}`}>{t.schema}.{t.name}</option>}</For>
                        </select>
                      </label>
                    </Show>
                    <button class="run full" onClick={doImport} disabled={importBusy()}>{importBusy() ? "Importing…" : "Import"}</button>
                  </>
                )}
              </Show>
              <Show when={importMsg()}><div class="import-msg">{importMsg()}</div></Show>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  );
}

export default App;
