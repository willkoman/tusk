import { createSignal, createMemo, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { SqlEditor, type EditorApi } from "./SqlEditor";
import { type Dataset, parseCSV, parseJSON, EXPORT_EXT } from "./formats";
import { save } from "@tauri-apps/plugin-dialog";
import { Tree, type DbTree, type RelationDetail, type NodeDescriptor, nodeKey } from "./Tree";
import { ContextMenu, type MenuItem, type MenuState } from "./ContextMenu";
import { WorkbenchDialogs, type DialogState } from "./WorkbenchDialogs";
import { Dialog } from "./Dialog";
import { Icon } from "./Icons";
import { ident, qualify } from "./sql/ident";
import * as ddl from "./sql/ddl";
import { clipWrite, clipRead } from "./clipboard";

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
  default_connect: boolean;
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

/** Duration as m:ss, or h:mm:ss past an hour. */
function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

function App() {
  const [conn, setConn] = createSignal<{ id: string; version: string; readOnly: boolean } | null>(null);

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
  const [defaultConnect, setDefaultConnect] = createSignal(false);
  const [connecting, setConnecting] = createSignal(false);
  const [connErr, setConnErr] = createSignal("");

  // workspace
  const [tree, setTree] = createSignal<DbTree | null>(null);
  const [sidebarW, setSidebarW] = createSignal(270);
  // Autocomplete table/column list — sourced from `list_schema` (one query, all
  // tables+columns), decoupled from the lazy object tree which no longer carries columns.
  const [schema, setSchema] = createSignal<TableInfo[]>([]);
  // Per-table detail (columns/indexes/constraints), fetched lazily on expand and cached.
  const [details, setDetails] = createSignal<Record<string, RelationDetail>>({});
  const loadedRels = new Map<string, { schema: string; name: string }>();
  const detailInflight = new Set<string>();
  // Sidebar context menu + active workbench dialog.
  const [menu, setMenu] = createSignal<MenuState>(null);
  const [activeDialog, setActiveDialog] = createSignal<DialogState | null>(null);
  const [treeFilter, setTreeFilter] = createSignal("");
  // Currently-selected sidebar node (drives the context-aware "+" menu).
  const [selected, setSelected] = createSignal<NodeDescriptor | null>(null);
  // "View value" modal for a result-grid cell.
  const [cellView, setCellView] = createSignal<{ col: string; val: string | null } | null>(null);
  const [sql, setSql] = createSignal("SELECT * FROM information_schema.tables;");
  const [columns, setColumns] = createSignal<string[]>([]);
  const [rows, setRows] = createSignal<(string | null)[][]>([]);
  const [done, setDone] = createSignal(true);
  const [running, setRunning] = createSignal(false);
  const [status, setStatus] = createSignal("");
  const [runErr, setRunErr] = createSignal("");
  const [elapsed, setElapsed] = createSignal(0);
  const [runMs, setRunMs] = createSignal(0); // live elapsed while a query runs
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
  let runTimer: ReturnType<typeof setInterval> | undefined;

  onMount(async () => {
    // Suppress the WebView's native right-click menu app-wide; the sidebar shows
    // its own context menu, and the editor uses keyboard shortcuts for copy/paste.
    document.addEventListener("contextmenu", (e) => e.preventDefault());
    await loadProfiles();
    // Auto-connect to the default profile, if one is set.
    const def = profiles().find((p) => p.default_connect);
    if (def) connectProfile(def.id);
  });

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
    setDefaultConnect(false);
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
    setDefaultConnect(p.default_connect);
    setConnErr("");
  }

  function useProfile(p: Profile) {
    if (p.save_password) connectProfile(p.id);
    else editProfile(p);
  }

  async function afterConnect(r: { connection_id: string; server_version: string; read_only: boolean }) {
    setConn({ id: r.connection_id, version: r.server_version, readOnly: r.read_only });
    await loadSchema();
  }

  async function doConnect(e: Event) {
    e.preventDefault();
    setConnecting(true);
    setConnErr("");
    try {
      const r = await invoke<{ connection_id: string; server_version: string; read_only: boolean }>("connect", {
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
      await afterConnect(
        await invoke<{ connection_id: string; server_version: string; read_only: boolean }>("connect_profile", { id }),
      );
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
          default_connect: defaultConnect(),
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
    setSchema([]);
    setDetails({});
    loadedRels.clear();
    setColumns([]);
    setRows([]);
    setStatus("");
  }

  async function loadSchema() {
    const c = conn();
    if (!c) return;
    try {
      const t = await invoke<DbTree>("db_tree", { connectionId: c.id });
      setTree(t);
      // Prune cached detail for relations that no longer exist (dropped / renamed),
      // so refreshLoadedDetails doesn't keep re-fetching dead keys.
      const live = new Set<string>();
      for (const s of t.schemas) for (const r of [...s.tables, ...s.views]) live.add(`${s.name}.${r.name}`);
      for (const k of [...loadedRels.keys()]) if (!live.has(k)) loadedRels.delete(k);
      setDetails((prev) => {
        const next: Record<string, RelationDetail> = {};
        for (const k of Object.keys(prev)) if (live.has(k)) next[k] = prev[k];
        return next;
      });
      void loadTables();
      void refreshLoadedDetails();
    } catch (e) {
      console.error(e);
    }
  }

  // Full table+column list for autocomplete (decoupled from the lazy tree).
  async function loadTables() {
    const c = conn();
    if (!c) return;
    try {
      setSchema(await invoke<TableInfo[]>("list_schema", { connectionId: c.id }));
    } catch (e) {
      console.error(e);
    }
  }

  // Lazy-load one relation's detail on expand; cached unless `force`.
  async function loadDetail(schemaName: string, name: string, force = false) {
    const c = conn();
    if (!c) return;
    const key = `${schemaName}.${name}`;
    if (!force && (details()[key] || detailInflight.has(key))) return;
    detailInflight.add(key);
    try {
      const d = await invoke<RelationDetail>("table_detail", {
        connectionId: c.id,
        schema: schemaName,
        name,
      });
      loadedRels.set(key, { schema: schemaName, name });
      setDetails((prev) => ({ ...prev, [key]: d }));
    } catch (e) {
      console.error(e);
    } finally {
      detailInflight.delete(key);
    }
  }

  // Re-fetch detail for every already-expanded relation (after refresh / DDL).
  async function refreshLoadedDetails() {
    for (const { schema, name } of loadedRels.values()) await loadDetail(schema, name, true);
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
    setRunMs(0);
    runTimer = setInterval(() => setRunMs(performance.now() - t0), 200);
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
      if (runTimer) clearInterval(runTimer);
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
    const q = `SELECT * FROM ${qualify(schemaName, name)}`;
    setSql(q);
    doRun(q);
  }

  function runTableLimit(schemaName: string, name: string, limit: number) {
    const q = `SELECT * FROM ${qualify(schemaName, name)} LIMIT ${limit}`;
    setSql(q);
    doRun(q);
  }

  // Run a DDL statement built by a form/confirm dialog, then refresh the tree.
  // Returns ok/error so the dialog can stay open and show failures inline.
  async function runDDL(sqlText: string): Promise<{ ok: boolean; error?: string }> {
    const c = conn();
    if (!c) return { ok: false, error: "not connected" };
    setRunErr("");
    try {
      const out = await invoke<QueryOutcome>("run_query", { connectionId: c.id, sql: sqlText, pageSize: PAGE });
      setStatus(out.kind === "exec" ? out.message : `${out.rows.length}${out.done ? "" : "+"} rows`);
      await loadSchema();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }

  // Fire-and-forget DDL (menu actions with no dialog), surfacing errors.
  function runDDLToast(sqlText: string) {
    void runDDL(sqlText).then((r) => {
      if (!r.ok) setRunErr(r.error ?? "failed");
    });
  }

  // Insert text into the editor at the cursor (never clobbers the buffer).
  function scaffoldEditor(text: string) {
    const body = text.endsWith("\n") ? text : text + "\n";
    const api = editorApi();
    if (api) api.insertAtCursor(body);
    else setSql((p) => (p ? p.replace(/\s*$/, "\n\n") : "") + body);
  }

  // "Edit as SQL" from a dialog: scaffold the single statement, close the dialog.
  function editAsSql(sqlText: string) {
    const t = sqlText.trim();
    scaffoldEditor(t.endsWith(";") ? t : t + ";");
    setActiveDialog(null);
  }

  function copyText(text: string, msg?: string) {
    void clipWrite(text).then((ok) => setStatus(ok ? msg ?? `copied ${text}` : "clipboard unavailable"));
  }

  // Reconstruct an object's DDL on the backend, then copy or scaffold it.
  async function copyDDL(n: NodeDescriptor, toEditor: boolean) {
    const c = conn();
    if (!c) return;
    try {
      const dd = await invoke<string>("object_ddl", {
        connectionId: c.id,
        kind: n.kind,
        schema: n.schema ?? "",
        name: n.name,
      });
      if (toEditor) scaffoldEditor(dd);
      else copyText(dd, "copied DDL");
    } catch (e) {
      setRunErr(errMsg(e));
    }
  }

  // Generate a SELECT/INSERT/UPDATE scaffold from a relation's columns.
  async function generate(n: NodeDescriptor, kind: "select" | "insert" | "update") {
    await loadDetail(n.schema!, n.name, false);
    const d = details()[`${n.schema}.${n.name}`];
    const cols = d?.columns.map((c) => c.name) ?? [];
    const pks = d?.columns.filter((c) => c.is_pk).map((c) => c.name) ?? [];
    const text =
      kind === "select"
        ? ddl.genSelect(n.schema!, n.name, cols)
        : kind === "insert"
          ? ddl.genInsert(n.schema!, n.name, cols)
          : ddl.genUpdate(n.schema!, n.name, cols, pks);
    scaffoldEditor(text.trim() + ";");
  }

  // Index/constraint dialogs need the relation's column list (and FK targets).
  async function openIndexDialog(n: NodeDescriptor) {
    await loadDetail(n.schema!, n.name, false);
    const d = details()[`${n.schema}.${n.name}`];
    setActiveDialog({ kind: "addIndex", ctx: n, columns: d?.columns.map((c) => c.name) ?? [] });
  }
  async function openConstraintDialog(n: NodeDescriptor) {
    await loadDetail(n.schema!, n.name, false);
    const d = details()[`${n.schema}.${n.name}`];
    setActiveDialog({
      kind: "addConstraint",
      ctx: n,
      columns: d?.columns.map((c) => c.name) ?? [],
      tables: schema(),
    });
  }
  async function openModify(n: NodeDescriptor) {
    await loadDetail(n.schema!, n.name, false);
    const d = details()[`${n.schema}.${n.name}`];
    if (d) setActiveDialog({ kind: "modifyTable", ctx: n, detail: d });
  }

  // Context-aware "+" menu — offers creates relevant to the sidebar selection.
  function openPlusMenu(e: MouseEvent) {
    e.preventDefault();
    const ro = conn()?.readOnly ?? false;
    const sel = selected();
    const items: MenuItem[] = [];
    // Resolve the owning table for column/index/constraint selections.
    const tableCtx: NodeDescriptor | null =
      sel?.kind === "table"
        ? sel
        : sel && (sel.kind === "column" || sel.kind === "index" || sel.kind === "constraint")
          ? { kind: "table", schema: sel.schema, name: sel.table! }
          : null;
    const schemaName =
      sel?.schema ?? (tree()?.schemas.some((s) => s.name === "public") ? "public" : tree()?.schemas[0]?.name);

    if (tableCtx) {
      items.push(
        { label: `New column in ${tableCtx.name}…`, icon: "＋", disabled: ro, onClick: () => setActiveDialog({ kind: "addColumn", ctx: tableCtx }) },
        { label: `New index on ${tableCtx.name}…`, icon: "📑", disabled: ro, onClick: () => openIndexDialog(tableCtx) },
        { label: `New constraint on ${tableCtx.name}…`, icon: "🔗", disabled: ro, onClick: () => openConstraintDialog(tableCtx) },
        { sep: true },
      );
    }
    if (schemaName)
      items.push({ label: `New table in ${schemaName}…`, icon: "📋", disabled: ro, onClick: () => setActiveDialog({ kind: "createTable", schema: schemaName }) });
    items.push(
      { label: "New schema…", icon: "📂", disabled: ro, onClick: () => setActiveDialog({ kind: "createSchema" }) },
      { label: "New database…", icon: "🗄️", disabled: ro, onClick: () => setActiveDialog({ kind: "createDatabase" }) },
    );
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  function openMenu(e: MouseEvent, node: NodeDescriptor) {
    e.preventDefault();
    const items = menuItems(node);
    if (!items.length) return;
    // ContextMenu clamps itself to the viewport after measuring its real size.
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  // Per-node-kind action menu. Mutating items are disabled on read-only connections.
  function menuItems(n: NodeDescriptor): MenuItem[] {
    const ro = conn()?.readOnly ?? false;
    const s = n.schema;
    const qual = s ? qualify(s, n.name) : ident(n.name);
    const copyName: MenuItem = { label: "Copy name", icon: "📋", onClick: () => copyText(n.name, `copied ${n.name}`) };
    const copyQual: MenuItem = { label: "Copy qualified name", icon: "📋", onClick: () => copyText(qual, "copied name") };
    const copyDdl: MenuItem[] = [
      { label: "Copy DDL", icon: "📄", onClick: () => copyDDL(n, false) },
      { label: "Copy DDL → editor", icon: "📝", onClick: () => copyDDL(n, true) },
    ];
    const items: MenuItem[] = [];

    switch (n.kind) {
      case "table":
        items.push(
          { label: "Select 100 rows", icon: "▶", onClick: () => runTableLimit(s!, n.name, 100) },
          { label: "Select all rows", icon: "▶", onClick: () => runTable(s!, n.name) },
          { sep: true },
          { label: "Modify table…", icon: "✏️", disabled: ro, onClick: () => openModify(n) },
          { label: "Add column…", icon: "＋", disabled: ro, onClick: () => setActiveDialog({ kind: "addColumn", ctx: n }) },
          { label: "Add index…", icon: "📑", disabled: ro, onClick: () => openIndexDialog(n) },
          { label: "Add constraint…", icon: "🔗", disabled: ro, onClick: () => openConstraintDialog(n) },
          { sep: true },
          { label: "Rename…", icon: "✎", disabled: ro, onClick: () => setActiveDialog({ kind: "rename", title: `Rename table ${n.name}`, current: n.name, build: (nn) => ddl.renameRelation("table", s!, n.name, nn) }) },
          { label: "Duplicate…", icon: "⧉", disabled: ro, onClick: () => setActiveDialog({ kind: "duplicate", title: `Duplicate ${n.name}`, defaultName: `${n.name}_copy`, build: (nn, wd) => ddl.duplicateTable(s!, n.name, nn, wd) }) },
          { label: "Edit comment…", icon: "💬", disabled: ro, onClick: () => setActiveDialog({ kind: "comment", title: `Comment on ${n.name}`, current: n.detail?.comment ?? "", build: (t) => ddl.comment(`TABLE ${qual}`, t) }) },
          { sep: true },
          { label: "Truncate…", icon: "🧹", danger: true, disabled: ro, onClick: () => setActiveDialog({ kind: "confirm", title: `Truncate ${n.name}`, primaryLabel: "Truncate", showCascade: true, showRestartIdentity: true, build: (o) => ddl.truncate(s!, n.name, o) }) },
          { label: "Drop…", icon: "🗑", danger: true, disabled: ro, onClick: () => setActiveDialog({ kind: "confirm", title: `Drop table ${n.name}`, primaryLabel: "Drop table", showCascade: true, build: (o) => ddl.dropRelation("table", s!, n.name, o.cascade) }) },
          { sep: true },
          { label: "Generate SELECT", icon: "≣", onClick: () => generate(n, "select") },
          { label: "Generate INSERT", icon: "≣", onClick: () => generate(n, "insert") },
          { label: "Generate UPDATE", icon: "≣", onClick: () => generate(n, "update") },
          { sep: true },
          ...copyDdl,
          copyName,
          copyQual,
        );
        break;
      case "view":
      case "matview": {
        const kw = n.kind;
        items.push({ label: "Select all rows", icon: "▶", onClick: () => runTable(s!, n.name) });
        if (kw === "matview")
          items.push(
            { label: "Refresh", icon: "↻", disabled: ro, onClick: () => runDDLToast(ddl.refreshMatview(s!, n.name, false)) },
            { label: "Refresh concurrently", icon: "↻", disabled: ro, onClick: () => runDDLToast(ddl.refreshMatview(s!, n.name, true)) },
          );
        items.push(
          { sep: true },
          { label: "Rename…", icon: "✎", disabled: ro, onClick: () => setActiveDialog({ kind: "rename", title: `Rename ${n.name}`, current: n.name, build: (nn) => ddl.renameRelation(kw, s!, n.name, nn) }) },
          { label: "Edit comment…", icon: "💬", disabled: ro, onClick: () => setActiveDialog({ kind: "comment", title: `Comment on ${n.name}`, current: n.detail?.comment ?? "", build: (t) => ddl.comment(`${kw === "matview" ? "MATERIALIZED VIEW" : "VIEW"} ${qual}`, t) }) },
          { label: "Drop…", icon: "🗑", danger: true, disabled: ro, onClick: () => setActiveDialog({ kind: "confirm", title: `Drop ${n.name}`, primaryLabel: "Drop", showCascade: true, build: (o) => ddl.dropRelation(kw, s!, n.name, o.cascade) }) },
          { sep: true },
          ...copyDdl,
          copyName,
          copyQual,
        );
        break;
      }
      case "column": {
        const c = n.column!;
        items.push(
          { label: "Edit column…", icon: "✎", disabled: ro, onClick: () => setActiveDialog({ kind: "editColumn", ctx: n }) },
          { label: "Rename…", icon: "✎", disabled: ro, onClick: () => setActiveDialog({ kind: "rename", title: `Rename column ${n.name}`, current: n.name, build: (nn) => ddl.renameColumn(s!, n.table!, n.name, nn) }) },
          { label: "Edit comment…", icon: "💬", disabled: ro, onClick: () => setActiveDialog({ kind: "comment", title: `Comment on ${n.name}`, current: c.comment ?? "", build: (t) => ddl.comment(`COLUMN ${qualify(s!, n.table!)}.${ident(n.name)}`, t) }) },
          { sep: true },
          { label: "Drop column…", icon: "🗑", danger: true, disabled: ro, onClick: () => setActiveDialog({ kind: "confirm", title: `Drop column ${n.name}`, primaryLabel: "Drop column", showCascade: true, build: (o) => ddl.dropColumn(s!, n.table!, n.name, o.cascade) }) },
          { sep: true },
          copyName,
        );
        break;
      }
      case "schema":
        items.push(
          { label: "Create table…", icon: "＋", disabled: ro, onClick: () => setActiveDialog({ kind: "createTable", schema: n.name }) },
          { label: "Rename…", icon: "✎", disabled: ro, onClick: () => setActiveDialog({ kind: "rename", title: `Rename schema ${n.name}`, current: n.name, build: (nn) => ddl.renameSchema(n.name, nn) }) },
          { sep: true },
          { label: "Drop…", icon: "🗑", danger: true, disabled: ro, onClick: () => setActiveDialog({ kind: "confirm", title: `Drop schema ${n.name}`, primaryLabel: "Drop schema", showCascade: true, build: (o) => ddl.dropSchema(n.name, o.cascade) }) },
          { sep: true },
          copyName,
        );
        break;
      case "database": {
        const cur = tree()?.database === n.name;
        items.push(
          { label: "Create schema…", icon: "＋", disabled: ro, onClick: () => setActiveDialog({ kind: "createSchema" }) },
          { label: cur ? "Drop… (connected)" : "Drop…", icon: "🗑", danger: true, disabled: ro || cur, onClick: () => setActiveDialog({ kind: "confirm", title: `Drop database ${n.name}`, primaryLabel: "Drop database", build: () => ddl.dropDatabase(n.name) }) },
          { sep: true },
          copyName,
        );
        break;
      }
      case "index":
        items.push(
          { label: "Rename…", icon: "✎", disabled: ro, onClick: () => setActiveDialog({ kind: "rename", title: `Rename index ${n.name}`, current: n.name, build: (nn) => ddl.renameIndex(s!, n.name, nn) }) },
          { label: "Drop…", icon: "🗑", danger: true, disabled: ro, onClick: () => setActiveDialog({ kind: "confirm", title: `Drop index ${n.name}`, primaryLabel: "Drop index", showCascade: true, build: (o) => ddl.dropIndex(s!, n.name, o.cascade) }) },
          { sep: true },
          copyName,
        );
        break;
      case "constraint":
        items.push(
          { label: "Rename…", icon: "✎", disabled: ro, onClick: () => setActiveDialog({ kind: "rename", title: `Rename constraint ${n.name}`, current: n.name, build: (nn) => ddl.renameConstraint(s!, n.table!, n.name, nn) }) },
          { label: "Drop…", icon: "🗑", danger: true, disabled: ro, onClick: () => setActiveDialog({ kind: "confirm", title: `Drop constraint ${n.name}`, primaryLabel: "Drop constraint", showCascade: true, build: (o) => ddl.dropConstraint(s!, n.table!, n.name, o.cascade) }) },
          { sep: true },
          copyName,
        );
        break;
      case "sequence":
        items.push(
          { label: "Restart… (edit value)", icon: "↺", disabled: ro, onClick: () => editAsSql(ddl.alterSequenceRestart(s!, n.name, "1")) },
          { label: "Rename…", icon: "✎", disabled: ro, onClick: () => setActiveDialog({ kind: "rename", title: `Rename sequence ${n.name}`, current: n.name, build: (nn) => ddl.renameSequence(s!, n.name, nn) }) },
          { label: "Drop…", icon: "🗑", danger: true, disabled: ro, onClick: () => setActiveDialog({ kind: "confirm", title: `Drop sequence ${n.name}`, primaryLabel: "Drop sequence", showCascade: true, build: (o) => ddl.dropSequence(s!, n.name, o.cascade) }) },
          { sep: true },
          ...copyDdl,
          copyName,
        );
        break;
      case "function":
        items.push(
          { label: "Drop…", icon: "🗑", danger: true, disabled: ro, onClick: () => setActiveDialog({ kind: "confirm", title: `Drop function ${n.name}`, primaryLabel: "Drop function", showCascade: true, build: (o) => ddl.dropFunction(s!, n.name, o.cascade) }) },
          { sep: true },
          ...copyDdl,
          copyName,
        );
        break;
      default:
        items.push(copyName);
        if (s) items.push(copyQual);
    }
    return items;
  }

  // --- result grid menus ---
  const rowJSON = (row: (string | null)[]) =>
    JSON.stringify(Object.fromEntries(columns().map((c, i) => [c, row[i]])));
  const columnValues = (ci: number) => rows().map((r) => r[ci] ?? "").join("\n");
  const columnJSON = (ci: number) => JSON.stringify(rows().map((r) => r[ci]));
  const allRowsTSV = () =>
    [columns().join("\t"), ...rows().map((r) => r.map((x) => x ?? "").join("\t"))].join("\n");
  const allRowsJSON = () =>
    JSON.stringify(rows().map((r) => Object.fromEntries(columns().map((c, i) => [c, r[i]]))));

  function openCellMenu(e: MouseEvent, row: (string | null)[], ci: number, val: string | null) {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: val === null ? "Copy value (NULL)" : "Copy value", icon: "📋", onClick: () => copyText(val ?? "", "copied cell") },
        { label: "Copy row (TSV)", icon: "📋", onClick: () => copyText(row.map((x) => x ?? "").join("\t"), "copied row") },
        { label: "Copy row (JSON)", icon: "📋", onClick: () => copyText(rowJSON(row), "copied row") },
        { sep: true },
        { label: "Copy column", icon: "📋", onClick: () => copyText(columnValues(ci), "copied column") },
        { label: "Copy column (JSON)", icon: "📋", onClick: () => copyText(columnJSON(ci), "copied column") },
        { sep: true },
        { label: "View value…", icon: "🔍", onClick: () => setCellView({ col: columns()[ci], val }) },
        { label: "Copy column name", icon: "📋", onClick: () => copyText(columns()[ci], "copied name") },
      ],
    });
  }

  function openHeaderMenu(e: MouseEvent, ci: number, colName: string) {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Copy column name", icon: "📋", onClick: () => copyText(colName, "copied name") },
        { label: "Copy column", icon: "📋", onClick: () => copyText(columnValues(ci), "copied column") },
        { label: "Copy column (JSON)", icon: "📋", onClick: () => copyText(columnJSON(ci), "copied column") },
        { sep: true },
        { label: `Copy all rows (TSV)`, icon: "📋", onClick: () => copyText(allRowsTSV(), `copied ${rows().length} rows`) },
        { label: "Copy all rows (JSON)", icon: "📋", onClick: () => copyText(allRowsJSON(), `copied ${rows().length} rows`) },
      ],
    });
  }

  // --- SQL editor menu ---
  function openEditorMenu(e: MouseEvent) {
    e.preventDefault();
    const api = editorApi();
    if (!api) return;
    const hasSel = api.getSelection() !== "";
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Cut", icon: "✂", disabled: !hasSel, onClick: async () => { const s = api.getSelection(); if (await clipWrite(s)) api.replaceSelection(""); } },
        { label: "Copy", icon: "📋", disabled: !hasSel, onClick: () => copyText(api.getSelection(), "copied selection") },
        { label: "Paste", icon: "📥", onClick: async () => { const t = await clipRead(); if (t != null) api.replaceSelection(t); else setRunErr("clipboard read blocked — use ⌘/Ctrl+V"); } },
        { sep: true },
        { label: "Select all", icon: "▤", onClick: () => api.selectAll() },
        { label: "Toggle comment", icon: "//", onClick: () => api.toggleComment() },
        { sep: true },
        { label: hasSel ? "Run selection" : "Run all", icon: "▶", onClick: () => doRun() },
      ],
    });
  }

  // --- connect-screen profile menu ---
  function connString(p: Profile) {
    const base = `postgresql://${p.user}@${p.host}:${p.port}/${p.dbname}`;
    return p.sslmode && p.sslmode !== "prefer" ? `${base}?sslmode=${p.sslmode}` : base;
  }
  async function duplicateProfile(p: Profile) {
    try {
      await invoke("save_profile", {
        profile: { id: "", name: `${p.name} copy`, host: p.host, port: p.port, user: p.user, dbname: p.dbname, save_password: false, sslmode: p.sslmode, read_only: p.read_only, default_connect: false },
        password: null,
      });
      await loadProfiles();
    } catch (e) {
      setConnErr(errMsg(e));
    }
  }
  async function setProfileDefault(p: Profile, val: boolean) {
    try {
      await invoke("save_profile", { profile: { ...p, default_connect: val }, password: null });
      await loadProfiles();
    } catch (e) {
      setConnErr(errMsg(e));
    }
  }
  // --- sidebar background (empty space) menu ---
  function openSidebarMenu(e: MouseEvent) {
    e.preventDefault();
    const ro = conn()?.readOnly ?? false;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "New…", icon: "＋", disabled: ro, onClick: () => openPlusMenu(e) },
        { sep: true },
        { label: "Refresh", icon: "↻", onClick: () => loadSchema() },
        { label: "Clear filter", icon: "⌫", disabled: !treeFilter(), onClick: () => setTreeFilter("") },
      ],
    });
  }

  function openProfileMenu(e: MouseEvent, p: Profile) {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Connect", icon: "▶", onClick: () => connectProfile(p.id) },
        { label: "Edit", icon: "✎", onClick: () => editProfile(p) },
        { label: "Duplicate", icon: "⧉", onClick: () => duplicateProfile(p) },
        { label: p.default_connect ? "Unset default" : "Set as default", icon: "★", onClick: () => setProfileDefault(p, !p.default_connect) },
        { sep: true },
        { label: "Copy connection string", icon: "📋", onClick: () => copyText(connString(p), "copied connection string") },
        { sep: true },
        { label: "Delete", icon: "🗑", danger: true, onClick: () => deleteProfile(p.id) },
      ],
    });
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
    <>
    <Show
      when={conn()}
      fallback={
        <div class="connect-screen">
          <div class="connect-layout">
            <div class="profiles-panel">
              <div class="panel-title">Connections</div>
              <For each={profiles()}>
                {(p) => (
                  <div class="profile-row" classList={{ active: editingId() === p.id }} onContextMenu={(e) => openProfileMenu(e, p)}>
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
              <label class="checkbox"><input type="checkbox" checked={savePassword()} onChange={(e) => setSavePassword(e.currentTarget.checked)} />Save password</label>
              <label class="checkbox"><input type="checkbox" checked={defaultConnect()} onChange={(e) => setDefaultConnect(e.currentTarget.checked)} />Connect on startup</label>
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
                <button class="icon" title="New… (based on selection)" onClick={(e) => openPlusMenu(e)}><Icon name="plus" /></button>
                <button class="icon" title="Import data" onClick={openImport}><Icon name="download" /></button>
                <button class="icon" title="Refresh" onClick={() => loadSchema()}><Icon name="refresh" /></button>
              </div>
            </div>
            <div class="sidebar-filter">
              <div class="filter-wrap">
                <span class="filter-search"><Icon name="search" /></span>
                <input
                  class="tree-filter"
                  value={treeFilter()}
                  onInput={(e) => setTreeFilter(e.currentTarget.value)}
                  placeholder="Filter objects…"
                />
              </div>
              <Show when={treeFilter()}>
                <button class="icon" title="Clear" onClick={() => setTreeFilter("")}>✕</button>
              </Show>
            </div>
            <div class="sidebar-body" onContextMenu={openSidebarMenu}>
              <Show when={tree()} fallback={<div class="empty-hint">no objects</div>}>
                {(t) => (
                  <Tree
                    tree={t()}
                    details={details()}
                    filter={treeFilter()}
                    selectedKey={selected() ? nodeKey(selected()!) : undefined}
                    onRunTable={runTable}
                    onExpandTable={loadDetail}
                    onContext={openMenu}
                    onSelect={setSelected}
                  />
                )}
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
                onContextMenu={openEditorMenu}
              />
              <div class="toolbar">
                <button class="run" onClick={() => doRun()} disabled={running()}>{running() ? `Running… ${fmtDur(runMs())}` : "Run ▶"}</button>
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
                      {(c, i) => (
                        <div class="cell head" style={{ width: `${COL_W}px` }} onContextMenu={(e) => openHeaderMenu(e, i(), c)}>{c}</div>
                      )}
                    </For>
                  </div>
                  <div class="grid-body" style={{ height: `${totalH()}px`, width: `${gridW()}px` }}>
                    <For each={visible()}>
                      {(item) => (
                        <div class="grid-row" style={{ top: `${item.idx * ROW_H}px`, width: `${gridW()}px` }}>
                          <For each={item.row}>
                            {(cell, i) => (
                              <div
                                class="cell"
                                style={{ width: `${COL_W}px` }}
                                onContextMenu={(e) => openCellMenu(e, item.row, i(), cell)}
                              >
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

        <WorkbenchDialogs
          state={activeDialog()}
          onClose={() => setActiveDialog(null)}
          onRun={runDDL}
          onEditAsSql={editAsSql}
        />
        <datalist id="pg-types">
          <For
            each={[
              "text", "varchar(255)", "char(1)", "integer", "bigint", "smallint", "serial",
              "bigserial", "boolean", "numeric", "numeric(12,2)", "real", "double precision",
              "date", "timestamptz", "timestamp", "time", "interval", "uuid", "jsonb", "json",
              "bytea", "inet", "text[]", "integer[]",
            ]}
          >
            {(t) => <option value={t} />}
          </For>
        </datalist>
      </div>
    </Show>

      {/* Context menu + value viewer render above everything, in both screens. */}
      <Show when={menu()}>
        {(m) => <ContextMenu x={m().x} y={m().y} items={m().items} onClose={() => setMenu(null)} />}
      </Show>
      <Show when={cellView()}>
        {(cv) => (
          <Dialog title={`Value · ${cv().col}`} onClose={() => setCellView(null)} width={520}>
            <Show when={cv().val !== null} fallback={<div class="null" style={{ padding: "8px 0" }}>NULL</div>}>
              <pre class="value-view">{cv().val}</pre>
            </Show>
            <div class="form-actions">
              <button class="ghost" onClick={() => setCellView(null)}>Close</button>
              <button class="run" disabled={cv().val === null} onClick={() => copyText(cv().val ?? "", "copied value")}>Copy</button>
            </div>
          </Dialog>
        )}
      </Show>
    </>
  );
}

export default App;
