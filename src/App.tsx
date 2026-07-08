import { createSignal, createMemo, createEffect, onMount, onCleanup, For, Show, lazy } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "./App.css";
import { isDarkTheme, normalizeTheme, type ThemeId } from "./themes";
import { SqlEditor, type EditorApi } from "./SqlEditor";
import { driverDialect, type DialectId } from "./sql/dialects";
import { type AiContext, type SampleTable } from "./ai/context";
import { type CursorInfo, type EditorPrefs, type ServerDiag } from "./editor/types";
import { prefsStore, tabsStore, layoutStore, type PersistedTabs } from "./store";
import { makeTab, basename, gridViewFor, pendingCount, type Tab, type ResultSnapshot, type GridView, type SortKey, type Filter, type PendingEdits } from "./tabs";
import { ResultGrid } from "./ResultGrid";
import { UpdateBadge } from "./UpdateBadge";
import { wrapQuery, wrappableQuery, stripTrailingSemi, hasDuplicateColumns, hasViewRules } from "./grid/query";
import { editTarget, editPlan, type EditPlan } from "./grid/editable";
import { detectBoolCols, typeBoolCols } from "./grid/bool";
import { buildCommitScript } from "./grid/editSql";
import { planPaste, mergePaste, type RowRef } from "./grid/paste";
import { makeIndexer } from "./sql/aliases";
import { type Dataset, parseCSV, parseJSON, formatWithOptions } from "./formats";
import { FORMAT_EXT, type ExportOptions, type ExportScope } from "./export";
import { save, open as openDialog } from "@tauri-apps/plugin-dialog";
import { Tree, type DbTree, type RelationDetail, type NodeDescriptor, nodeKey } from "./Tree";
import { ContextMenu, type MenuItem, type MenuState } from "./ContextMenu";
import { type DialogState } from "./WorkbenchDialogs";
import { type SettingsTab } from "./settings/SettingsDialog";
const HelpDialog = lazy(() => import("./help/HelpDialog"));
import { fontStack } from "./editor/theme";
import { ACTIONS, type ActionCtx, type ActionId, type KeyOverrides, canonicalKey, displayKey, effectiveKey, normalizeKeyEvent } from "./actions";
import { keymapStore } from "./store";
import { historyStore, makeEntryId, type HistoryEntry } from "./history/store";
import { detectParams, type Param, type ParamValue } from "./sql/params";
import { type FkEdge } from "./sql/fk";
import { type Skill } from "./ai/skills";
import { ParamDialog } from "./forms/ParamDialog";
import { detectPlan } from "./plan/detect";
import { explainSql, analyzeExecutesWrite } from "./plan/explainSql";
import { Dialog, SqlPreview } from "./Dialog";
import { Icon } from "./Icons";
import { ident, qualify, qualifyIn, setSqlDialect } from "./sql/ident";
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
  driver?: string | null;
  path?: string | null;
};
type QueryOutcome =
  | { kind: "rows"; columns: string[]; rows: (string | null)[][]; done: boolean; note?: string }
  | { kind: "exec"; message: string };
type FetchResult = { rows: (string | null)[][]; done: boolean };
// Slack bot events (mirrors slack::StatusInfo / the slack:executed payload in Rust).
type SlackStatus = { running: boolean; state: string; error: string | null };
type SlackExecuted = { sql: string; durationMs: number; status: string; rows?: number; error?: string; slackUser: string };

const PAGE = 1000;
const DDL_RE = /^\s*(create|alter|drop|truncate|comment|grant|revoke)\b/i;

// Heavy, conditionally-rendered panels load as separate chunks on first open —
// keeps the startup bundle (and its parse time) lean. All are behind <Show>,
// so the chunk fetch happens only when the user actually opens the surface.
const AiPanel = lazy(() => import("./ai/AiPanel").then((m) => ({ default: m.AiPanel })));
const ExportDialog = lazy(() => import("./forms/ExportDialog").then((m) => ({ default: m.ExportDialog })));
const WorkbenchDialogs = lazy(() => import("./WorkbenchDialogs").then((m) => ({ default: m.WorkbenchDialogs })));
const SettingsDialog = lazy(() => import("./settings/SettingsDialog").then((m) => ({ default: m.SettingsDialog })));
const ShortcutsPane = lazy(() => import("./settings/ShortcutsPane").then((m) => ({ default: m.ShortcutsPane })));
const HistoryPanel = lazy(() => import("./history/HistoryPanel").then((m) => ({ default: m.HistoryPanel })));
const CommandPalette = lazy(() => import("./CommandPalette").then((m) => ({ default: m.CommandPalette })));
const PlanView = lazy(() => import("./plan/PlanView").then((m) => ({ default: m.PlanView })));
const DdlGraphDialog = lazy(() => import("./relviz/DdlGraphDialog").then((m) => ({ default: m.DdlGraphDialog })));

// Supported drivers + their mascot (the brand icon adapts to the connected DB).
// `ready` drivers are connectable now; others are staged in the picker.
const DRIVERS = [
  { id: "postgres", label: "PostgreSQL", mascot: "🐘", ready: true },
  { id: "duckdb", label: "DuckDB", mascot: "🦆", ready: true },
  { id: "sqlite", label: "SQLite", mascot: "🪶", ready: true },
  { id: "mysql", label: "MySQL", mascot: "🐬", ready: true },
] as const;
const driverMascot = (id?: string | null) => DRIVERS.find((d) => d.id === id)?.mascot ?? "🐘";
const driverLabel = (id?: string | null) => DRIVERS.find((d) => d.id === id)?.label ?? "PostgreSQL";

// Per-driver feature flags from the backend `capabilities` command. The UI gates
// features (search-path, import, export) on these.
type Capabilities = {
  kind: string;
  serverCursor: boolean;
  bulkCopy: boolean;
  export: boolean;
  schemas: boolean;
  searchPath: boolean;
  transactionalDdl: boolean;
  tls: boolean;
  keychain: boolean;
  permissions: boolean;
  ddl: boolean;
  relationships: boolean;
  explainAnalyze: boolean;
};

// The connected role's effective privileges (from the `permissions` command). `enforced`
// is false for drivers without a permission model (embedded / MySQL) — the UI then gates
// nothing extra. Mirrors src-tauri/src/perms.rs.
type TablePriv = { schema: string; name: string; select: boolean; insert: boolean; update: boolean; delete: boolean; truncate: boolean; references: boolean; trigger: boolean; isOwner: boolean };
type SchemaPriv = { name: string; create: boolean; usage: boolean; isOwner: boolean };
type Permissions = {
  enforced: boolean;
  currentUser: string;
  isSuperuser: boolean;
  canCreateDb: boolean;
  canCreateRole: boolean;
  createInCurrentDb: boolean;
  schemas: SchemaPriv[];
  tables: TablePriv[];
};

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
  const [driver, setDriver] = createSignal("postgres");
  const [path, setPath] = createSignal(""); // DuckDB/SQLite file (empty = :memory:)
  const [caps, setCaps] = createSignal<Capabilities | null>(null);
  const [perms, setPerms] = createSignal<Permissions | null>(null);
  const [aiOpen, setAiOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal<SettingsTab | null>(null); // non-null = open on that tab
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const [history, setHistory] = createSignal<HistoryEntry[]>([]);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [helpOpen, setHelpOpen] = createSignal(false);
  // "DDL & relationships" viewer (read-only — standalone signal, not DialogState).
  // name=null = opened from a schema node, straight into the whole-schema ERD.
  const [ddlGraph, setDdlGraph] = createSignal<{ schema: string; name: string | null; kind: string } | null>(null);
  // Context handed to the AI: connected DB dialect/version, schema summary, the role's
  // privileges, the active schema, and the current editor SQL/selection/last error.
  const aiContext = (): AiContext => ({
    dialect: caps()?.kind ?? "postgres",
    driverLabel: driverLabel(caps()?.kind),
    version: conn()?.version ?? "",
    user: perms()?.currentUser ?? "",
    isSuperuser: !!perms()?.isSuperuser,
    permissionsEnforced: !!perms()?.enforced,
    activeSchema: activeTab().searchSchema,
    tables: schema(),
    database: tree()?.database ?? "",
    skills: skills(),
    fks: fkEdges(),
    // Only true once a fetch actually landed for some schema and the driver supports it.
    fksKnown: caps()?.relationships !== false && fkFetched.size > 0,
    currentSql: editorApi()?.getDoc() ?? activeTab().sql,
    selection: editorApi()?.getSelection() ?? "",
    lastError: activeTab().result.runErr,
  });
  // Sample-data fetcher for the AI assistant: a few read-only rows per relevant table,
  // cached for the session (cleared on schema reload) and run without disturbing any
  // in-flight stream. Best-effort — a table that can't be sampled is just skipped.
  const sampleCache = new Map<string, SampleTable>();
  async function aiSampleRows(targets: { schema: string; name: string }[]): Promise<SampleTable[]> {
    const c = conn();
    if (!c) return [];
    const results = await Promise.all(
      targets.map(async (t): Promise<SampleTable | null> => {
        const key = `${t.schema}/${t.name}`;
        const hit = sampleCache.get(key);
        if (hit) return hit;
        try {
          const r = await invoke<{ columns: string[]; rows: (string | null)[][] }>("sample_rows", {
            connectionId: c.id, schema: t.schema, name: t.name, limit: 5,
          });
          const s: SampleTable = { schema: t.schema, name: t.name, columns: r.columns, rows: r.rows };
          sampleCache.set(key, s);
          return s;
        } catch {
          return null;
        }
      }),
    );
    return results.filter((x): x is SampleTable => x !== null);
  }
  // --- permission gating (Postgres; `enforced:false` elsewhere → no extra gating) ---
  const pEnforced = () => perms()?.enforced ?? false;
  const isSuper = () => !pEnforced() || !!perms()?.isSuperuser;
  const tablePriv = (s: string, t: string) => perms()?.tables.find((x) => x.schema === s && x.name === t);
  const schemaPriv = (s: string) => perms()?.schemas.find((x) => x.name === s);
  const ownsTable = (s: string, t: string) => isSuper() || !!tablePriv(s, t)?.isOwner;
  const ownsSchema = (s: string) => isSuper() || !!schemaPriv(s)?.isOwner;
  const canCreateInSchema = (s: string) => isSuper() || !!schemaPriv(s)?.create;
  const canCreateSchema = () => !pEnforced() || !!perms()?.createInCurrentDb;
  const canCreateDatabase = () => !pEnforced() || !!perms()?.canCreateDb;
  const canTruncate = (s: string, t: string) => ownsTable(s, t) || !!tablePriv(s, t)?.truncate;
  // Merge into a MenuItem: read-only wins, then driver support (the sidebar DDL
  // builders in sql/ddl.ts emit Postgres syntax — offering them on MySQL/SQLite/
  // DuckDB produced SQL errors at apply time), then the privilege. Every gate()
  // call site is a mutating DDL item, so the driver check belongs here centrally.
  // Drivers with sidebar DDL builders. Postgres is full; DuckDB covers everything its
  // engine supports (the `sql/ddl.ts` builders emit DuckDB-compatible syntax) — the few
  // operations DuckDB can't do via ALTER are gated per-action with `noDuck`. MySQL/SQLite
  // still route to PG-syntax builders, so they stay off.
  const ddlDriver = () => caps()?.kind === "postgres" || caps()?.kind === "duckdb";
  const gate = (allowed: boolean, reason: string): { disabled?: boolean; title?: string } => {
    if (conn()?.readOnly) return { disabled: true, title: "Connection is read-only" };
    if (caps() && !ddlDriver())
      return { disabled: true, title: `DDL editing isn't supported for ${driverLabel(caps()!.kind)} yet` };
    return allowed ? {} : { disabled: true, title: reason };
  };
  // Disable an item that DuckDB's engine can't do (constraint ALTERs, rename index/
  // sequence/constraint, ALTER SEQUENCE RESTART, CREATE DATABASE). Spread AFTER gate().
  const noDuck = (reason: string): { disabled?: boolean; title?: string } =>
    caps()?.kind === "duckdb" ? { disabled: true, title: reason } : {};
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
  // Docked-panel sizes — restored from localStorage, persisted on resize-end.
  const savedLayout = layoutStore.load();
  const [sidebarW, setSidebarW] = createSignal(savedLayout.sidebarW ?? 270);
  const [aiW, setAiW] = createSignal(savedLayout.aiW ?? 360);
  const [historyW, setHistoryW] = createSignal(savedLayout.historyW ?? 340);
  // Collapsed panels (Explorer + results). Sizes are remembered separately, so a
  // toggle restores the previous width/height instead of a default.
  const [sidebarOpen, setSidebarOpen] = createSignal(savedLayout.sidebarOpen ?? true);
  const [resultsOpen, setResultsOpen] = createSignal(savedLayout.resultsOpen ?? true);
  // Autocomplete table/column list — sourced from `list_schema` (one query, all
  // tables+columns), decoupled from the lazy object tree which no longer carries columns.
  const [schema, setSchema] = createSignal<TableInfo[]>([]);
  // Lowercase function/procedure catalog for the unknown-function lint.
  const [funcs, setFuncs] = createSignal<ReadonlySet<string>>(new Set<string>());
  // Live FK edges for the JOIN…ON completion (active schema + public, merged).
  const [fkEdges, setFkEdges] = createSignal<FkEdge[]>([]);
  // User-authored AI skills (stored on disk by Rust). Reloaded whenever Settings closes,
  // since that's the only place they're created/edited/imported/removed.
  const [skills, setSkills] = createSignal<Skill[]>([]);
  const refreshSkills = () => invoke<Skill[]>("skills_list").then(setSkills).catch(() => setSkills([]));
  const fkFetched = new Set<string>(); // schemas fetched SUCCESSFULLY (cleared per introspection)
  const fkInFlight = new Set<string>(); // dedupe concurrent fetches of the same schema
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
  // Editor tabs — each owns a SQL buffer + a snapshot of its last result grid.
  const [tabs, setTabs] = createSignal<Tab[]>([makeTab({ sql: "SELECT * FROM information_schema.tables;" })]);
  const [activeTabId, setActiveTabId] = createSignal(tabs()[0].id);
  const activeTab = createMemo(() => tabs().find((t) => t.id === activeTabId()) ?? tabs()[0]);
  let cursorOwnerTabId: string | null = null; // tab that owns the single backend cursor

  const patchTab = (id: string, patch: Partial<Tab>) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const patchResult = (id: string, patch: Partial<ResultSnapshot>) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, result: { ...t.result, ...patch } } : t)));

  // Active-tab accessors so the existing editor + result-grid JSX stays unchanged.
  const sql = () => activeTab().sql;
  const setSql = (v: string) => patchTab(activeTabId(), { sql: v });
  const columns = () => activeTab().result.columns;
  const rows = () => activeTab().result.rows;
  const done = () => activeTab().result.done;
  const status = () => activeTab().result.status;
  const runErr = () => activeTab().result.runErr;
  const elapsed = () => activeTab().result.elapsed;
  const lastQuery = () => activeTab().result.lastQuery;
  const setStatus = (s: string) => patchResult(activeTabId(), { status: s });
  const setRunErr = (s: string) => patchResult(activeTabId(), { runErr: s });
  // Distinct schema names for the active-schema (search_path) selector.
  const schemaNames = createMemo(() => [...new Set(schema().map((t) => t.schema))].sort());

  const [running, setRunning] = createSignal(false);
  const [runningTabId, setRunningTabId] = createSignal<string | null>(null); // tab whose query is in flight
  const [runMs, setRunMs] = createSignal(0); // live elapsed while a query runs
  const [cancelling, setCancelling] = createSignal(false); // cancel request sent, awaiting unwind
  const [editorApi, setEditorApi] = createSignal<EditorApi | null>(null);
  // Persisted editor↔results split height, clamped to the current window (a value saved
  // on a taller window must not push the results pane off a shorter one).
  const editorHDefault = Math.max(300, Math.round((window.innerHeight - 120) * 0.6));
  const [editorH, setEditorH] = createSignal(
    Math.max(80, Math.min(savedLayout.editorH ?? editorHDefault, window.innerHeight - 160)),
  );

  // editor prefs (persisted) + cursor readout + per-connection buffer key
  const [prefs, setPrefs] = createSignal<EditorPrefs>(prefsStore.load());
  // Editor dialect follows the connected driver (DuckDB → Postgres dialect); falls back
  // to the saved pref when disconnected. Drives highlighting, keyword/function/type
  // autocomplete, and identifier quoting (`setSqlDialect` → backticks on MySQL).
  const activeDialect = createMemo<DialectId>(() => (conn() ? driverDialect(caps()?.kind) : prefs().dialect));
  // ident/DDL quoting uses the REAL driver kind (not the editor dialect, which maps
  // DuckDB→postgres for highlighting). Quoting is identical for pg/duckdb/sqlite (double
  // quotes; only MySQL backticks), but the DDL builders branch on the true driver so they
  // can emit DuckDB-compatible syntax. Falls back to the editor dialect when disconnected.
  createEffect(() => setSqlDialect(conn() ? (caps()?.kind ?? "postgres") : activeDialect()));
  const [cursorInfo, setCursorInfo] = createSignal<CursorInfo | null>(null);
  let connKey: string | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let restoring = false;

  const updatePrefs = (patch: Partial<EditorPrefs>) => {
    const next = { ...prefs(), ...patch };
    setPrefs(next);
    prefsStore.save(next);
  };

  // Resolve the theme pref ("system" follows the OS) and flip the CSS-variable
  // palette via <html data-theme>; the editor gets the resolved value through
  // its prefs prop (themeFor never sees "system").
  const prefersLight = window.matchMedia("(prefers-color-scheme: light)");
  const [osLight, setOsLight] = createSignal(prefersLight.matches);
  const onSchemeChange = (e: MediaQueryListEvent) => setOsLight(e.matches);
  prefersLight.addEventListener("change", onSchemeChange);
  onCleanup(() => prefersLight.removeEventListener("change", onSchemeChange));
  const resolvedTheme = createMemo<ThemeId>(() => {
    const t = prefs().theme;
    return t === "system" ? (osLight() ? "light" : "oneDark") : normalizeTheme(t);
  });
  createEffect(() => {
    // data-theme picks the palette block; data-mode keys the dark/light-level
    // CSS fixes shared by every theme of that polarity.
    document.documentElement.dataset.theme = resolvedTheme();
    document.documentElement.dataset.mode = isDarkTheme(resolvedTheme()) ? "dark" : "light";
  });

  // Lazily fetch FK edges when a tab switches to a not-yet-fetched schema.
  createEffect(() => {
    const s = activeTab().searchSchema;
    if (s && conn()) void fetchFkSchema(s);
  });

  // Font pref → --mono (editor gets it via themeFor; grid/code via CSS).
  createEffect(() => {
    document.documentElement.style.setProperty("--mono", fontStack(prefs().fontFamily));
  });

  // Accent pref → --accent + --accent-rgb (inline on <html>, wins over both
  // theme blocks; every accent tint derives from the rgb triplet).
  createEffect(() => {
    const hex = prefs().accent;
    const el = document.documentElement;
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return;
    const n = parseInt(m[1], 16);
    el.style.setProperty("--accent", `#${m[1]}`);
    el.style.setProperty("--accent-rgb", `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`);
  });

  // --- keyboard shortcuts: persisted overrides + a canonical-key → action map ---
  const [keys, setKeys] = createSignal<KeyOverrides>(keymapStore.load());
  const updateKeys = (patch: KeyOverrides) => {
    const next = { ...keys(), ...patch };
    // `undefined` in a patch means "back to default" — drop the override entirely
    // (vs null, which is persisted as "explicitly unbound").
    for (const k of Object.keys(next) as ActionId[]) if (next[k] === undefined) delete next[k];
    setKeys(next);
    keymapStore.save(next);
  };
  const resetKeys = () => {
    setKeys({});
    keymapStore.save({});
  };
  const globalBindings = createMemo(() => {
    const m = new Map<string, ActionId>();
    for (const a of ACTIONS) {
      const k = effectiveKey(a.id, keys());
      if (k) m.set(canonicalKey(k), a.id);
    }
    return m;
  });
  const actionCtx = (): ActionCtx => ({
    connected: !!conn(),
    running: running(),
    hasResult: columns().length > 0,
    canExport: caps()?.export !== false,
    canExplainAnalyze: caps()?.explainAnalyze !== false,
  });

  // Validate the buffer against Postgres for parser-grade diagnostics (PREPARE-only,
  // never executes). Skipped while a query is running (shares the connection lock)
  // or when the server-lint pref is off.
  const validate = async (sqlText: string): Promise<ServerDiag[]> => {
    const c = conn();
    // Skip while a query is running (shared connection lock) AND while any streaming
    // cursor is open: validate_sql rolls back the open cursor to PREPARE in autocommit,
    // which would truncate a live stream. (Double-clicking a table sets the editor doc,
    // which fires this lint ~600ms later — it must not kill the stream it just opened.)
    if (!c || running() || cursorOwnerTabId !== null || !prefs().serverLint) return [];
    try {
      return await invoke<ServerDiag[]>("validate_sql", { connectionId: c.id, sql: sqlText, searchPath: activeTab().searchSchema });
    } catch {
      return [];
    }
  };

  // --- tab management + file flow ---
  const [confirmClose, setConfirmClose] = createSignal<string | null>(null);
  // Snapshot of the result being exported, frozen when the dialog opens so a tab
  // switch while it's open can't redirect the export to a different tab.
  const [exportSrc, setExportSrc] = createSignal<
    { columns: string[]; rows: (string | null)[][]; query: string; table: string; searchSchema: string | null } | null
  >(null);
  const openExport = () =>
    setExportSrc({
      columns: columns(),
      rows: rows(),
      query: lastQuery(),
      table: tableNameFromSql(lastQuery()),
      searchSchema: activeTab().searchSchema,
    });

  function switchTab(id: string) {
    if (id === activeTabId()) return;
    setActiveTabId(id); // ResultGrid restores its own scroll/selection on the tab change
  }

  function openNewTab() {
    const t = makeTab();
    setTabs((ts) => [...ts, t]);
    switchTab(t.id);
  }

  // Open generated SQL in a fresh tab (never clobber the current one), with the
  // console's active schema set so the generated unqualified names resolve. Not
  // marked dirty — it's regenerable and becomes dirty once the user edits it.
  function openGeneratedTab(sqlText: string, schema: string | null, title?: string) {
    const t = makeTab({ sql: sqlText, searchSchema: schema, title });
    setTabs((ts) => [...ts, t]);
    switchTab(t.id);
  }

  // --- tab QoL: rename / close-many / drag-reorder ---
  const [renameTab, setRenameTab] = createSignal<{ id: string; title: string } | null>(null);
  let dragTabId: string | null = null;

  function moveTabTo(dragId: string, targetId: string, before: boolean) {
    setTabs((ts) => {
      const from = ts.findIndex((t) => t.id === dragId);
      let to = ts.findIndex((t) => t.id === targetId);
      if (from < 0 || to < 0 || from === to) return ts;
      const next = ts.slice();
      const [moved] = next.splice(from, 1);
      to = next.findIndex((t) => t.id === targetId);
      next.splice(before ? to : to + 1, 0, moved);
      return next;
    });
  }

  /** Close every tab matching the predicate, skipping dirty ones (reported). */
  function closeTabsWhere(pred: (t: Tab, i: number, arr: Tab[]) => boolean) {
    const all = tabs();
    const targets = all.filter((t, i) => pred(t, i, all));
    const kept = targets.filter((t) => t.dirty);
    for (const t of targets) {
      if (!t.dirty) removeTab(t.id);
    }
    if (kept.length) setStatus(`kept ${kept.length} unsaved tab${kept.length > 1 ? "s" : ""}`);
  }

  function removeTab(id: string) {
    if (cursorOwnerTabId === id) cursorOwnerTabId = null;
    editorApi()?.dropTab(id);
    const idx = tabs().findIndex((t) => t.id === id);
    const next = tabs().filter((t) => t.id !== id);
    if (next.length === 0) {
      const fresh = makeTab();
      setTabs([fresh]);
      setActiveTabId(fresh.id);
      return;
    }
    setTabs(next);
    if (activeTabId() === id) {
      const neighbor = next[Math.min(idx, next.length - 1)];
      switchTab(neighbor.id);
    }
  }

  function closeTab(id: string) {
    const t = tabs().find((x) => x.id === id);
    if (!t) return;
    if (t.dirty) {
      setConfirmClose(id);
      return;
    }
    removeTab(id);
  }

  async function openFileDialog() {
    const path = await openDialog({ multiple: false, filters: [{ name: "SQL", extensions: ["sql", "txt"] }] });
    if (typeof path !== "string") return;
    const existing = tabs().find((t) => t.filePath === path);
    if (existing) {
      switchTab(existing.id);
      return;
    }
    try {
      const contents = await invoke<string>("read_text_file", { path });
      const t = makeTab({ sql: contents, filePath: path, title: basename(path), dirty: false });
      setTabs((ts) => [...ts, t]);
      switchTab(t.id);
    } catch (e) {
      setRunErr(errMsg(e));
    }
  }

  async function saveActiveTab() {
    const t = activeTab();
    const text = editorApi()?.getDoc() ?? t.sql;
    if (!t.filePath) return saveAsActiveTab();
    try {
      await invoke("write_text_file", { path: t.filePath, contents: text });
      patchTab(t.id, { dirty: false, sql: text });
      setStatus(`saved → ${t.filePath}`);
    } catch (e) {
      setRunErr(errMsg(e));
    }
  }

  async function saveAsActiveTab() {
    const t = activeTab();
    const text = editorApi()?.getDoc() ?? t.sql;
    const path = await save({ defaultPath: t.filePath ?? `${t.title}.sql`, filters: [{ name: "SQL", extensions: ["sql"] }] });
    if (!path) return;
    try {
      await invoke("write_text_file", { path, contents: text });
      patchTab(t.id, { filePath: path, title: basename(path), dirty: false, sql: text });
      setStatus(`saved → ${path}`);
    } catch (e) {
      setRunErr(errMsg(e));
    }
  }

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

  // Lazy EXPLAIN detection: null for normal results (the leading-keyword gate
  // makes this free), a ParsedPlan when the active tab's result is a plan.
  const planMemo = createMemo(() => {
    const t = activeTab();
    if (!conn() || !t.result.columns.length) return null;
    return detectPlan(caps()?.kind, {
      lastQuery: t.result.lastQuery,
      columns: t.result.columns,
      rows: t.result.rows,
    });
  });
  const resultView = () => (planMemo() ? activeTab().resultView ?? "plan" : "grid");
  // EXPLAIN ANALYZE on a mutating statement → explicit confirm (it executes).
  const [confirmAnalyze, setConfirmAnalyze] = createSignal<string | null>(null);
  // Whether this DuckDB build accepts PG-style `EXPLAIN (FORMAT json)` —
  // probed once at connect time (a probe mid-session could disturb the pager).
  let duckJsonExplain = false;

  function runExplain(analyze: boolean) {
    const api = editorApi();
    if (!api) return;
    const stmt = api.getSelection().trim() || api.getCurrentStatement();
    if (!stmt.trim()) return;
    const wrapped = explainSql(caps()?.kind, analyze, stmt, duckJsonExplain);
    if (analyze && analyzeExecutesWrite(stmt)) {
      setConfirmAnalyze(wrapped);
      return;
    }
    void executeQuery(wrapped, "", "base");
  }

  // result grid: per-tab view + sort/filter re-run, Load-all
  const gridView = () => activeTab().gridView;
  const setGridView = (patch: Partial<GridView>) => patchTab(activeTabId(), { gridView: { ...activeTab().gridView, ...patch } });
  const canSortFilter = () =>
    wrappableQuery(activeTab().result.baseQuery) &&
    // MySQL refuses duplicate column names inside a derived table (error 1060),
    // so the sort/filter wrap can't work on such results there.
    !(caps()?.kind === "mysql" && hasDuplicateColumns(activeTab().result.columns));
  // --- in-grid data editing ---
  // Editability of the active tab's result: single-table SELECT + loaded detail
  // with a PK fully present in the result. `want` asks the effect below to fetch
  // the missing table detail (the memo recomputes when `details()` updates).
  type EditCtx = {
    editable: boolean;
    reason: string;
    plan: Extract<EditPlan, { ok: true }> | null;
    want?: { schema: string; name: string };
  };
  const editIndexer = makeIndexer();
  // Narrow dedupe memos: `activeTab()` gets a new identity on EVERY patchTab
  // (each keystroke, each pending edit) — these notify downstream only when the
  // actual value/reference changes, so editTarget's lex doesn't rerun per keystroke.
  const editBaseQ = createMemo(() => activeTab().result.baseQuery);
  const editCols = createMemo(() => activeTab().result.columns);
  const editCtx = createMemo<EditCtx>(() => {
    const c = conn();
    const cols = editCols();
    if (!c || !cols.length) return { editable: false, reason: "", plan: null };
    if (c.readOnly) return { editable: false, reason: "connection is read-only", plan: null };
    const tgt = editTarget(editBaseQ(), editIndexer(schema()));
    if (!tgt.ok) return { editable: false, reason: tgt.reason, plan: null };
    // PG permission model: no write privilege at all → don't offer editing
    // (partial privileges still commit — the server enforces per statement).
    if (perms()?.enforced && !isSuper()) {
      const tp = tablePriv(tgt.table.schema, tgt.table.name);
      if (tp && !tp.isOwner && !tp.update && !tp.insert && !tp.delete)
        return { editable: false, reason: `no write privilege on ${tgt.table.name}`, plan: null };
    }
    const det = details()[`${tgt.table.schema}.${tgt.table.name}`];
    if (!det)
      return { editable: false, reason: "loading table info…", plan: null, want: { schema: tgt.table.schema, name: tgt.table.name } };
    const p = editPlan(det, cols, tgt.table);
    if (!p.ok) return { editable: false, reason: p.reason, plan: null };
    return { editable: true, reason: "", plan: p };
  });
  // Fetch the missing relation detail (cached + inflight-guarded in loadDetail).
  createEffect(() => {
    const w = editCtx().want;
    if (w) void loadDetail(w.schema, w.name);
  });

  // --- boolean columns (TRUE/FALSE badges + dropdown editor) ---
  // Type-based when the edit target's detail is loaded (exact — covers SQLite's
  // numeric 0/1 booleans); value heuristic over the loaded rows otherwise
  // (t/f/true/false only — never 0/1, which would catch integer columns).
  const editRows = createMemo(() => activeTab().result.rows);
  const editDetail = () => {
    const p = editCtx().plan;
    return p ? details()[`${p.schema}.${p.table}`] : undefined;
  };
  const boolCols = createMemo<Set<number>>(() => {
    const det = editDetail();
    if (det) return typeBoolCols(editCols(), det.columns);
    return detectBoolCols(editCols(), editRows());
  });
  /** Dropdown editor info for a bool column; tokens match the driver's textual booleans. */
  const boolEditInfo = (oi: number): { trueVal: string; falseVal: string; nullable: boolean } | null => {
    const det = editDetail();
    if (!det || !editCtx().editable || !boolCols().has(oi)) return null;
    const name = editCols()[oi]?.toLowerCase();
    const col = det.columns.find((c) => c.name.toLowerCase() === name);
    if (!col) return null;
    // SQLite stores booleans as 0/1 (no native bool); PG/DuckDB accept true/false.
    const numeric = caps()?.kind === "sqlite" || caps()?.kind === "mysql";
    return { trueVal: numeric ? "1" : "true", falseVal: numeric ? "0" : "false", nullable: col.nullable };
  };

  // Memo (not a plain accessor): activeTab()'s identity changes on every patchTab
  // (each editor keystroke) — the memo dedupes by the pending object's reference,
  // so the grid's overlay memos only recompute on actual edits.
  const tabPending = createMemo(() => activeTab().pending);
  const setPendingFor = (tabId: string, p: PendingEdits | undefined) => patchTab(tabId, { pending: p });
  const isPendingEmpty = (p: PendingEdits) => !Object.keys(p.cells).length && !p.deletes.length && !p.inserts.length;
  const ensurePending = (): PendingEdits => tabPending() ?? { cells: {}, deletes: [], inserts: [] };

  // val: string = new value, null = SQL NULL, undefined = revert (drop the entry).
  // `ref` is the stable row identity from the grid (loaded snapshot row vs pending
  // insert row) — App never reasons about virtual grid positions.
  function onEditCell(ref: RowRef, c: number, val: string | null | undefined) {
    // Defense-in-depth (the grid already gates): never record an edit on a column
    // the commit script wouldn't write, and never while not editable.
    const ec = editCtx();
    if (!ec.editable || !(ec.plan?.isTableCol[c] ?? false)) return;
    const t = activeTab();
    const p = ensurePending();
    if (ref.kind === "insert") {
      const i = ref.i;
      if (!p.inserts[i]) return;
      const inserts = p.inserts.map((x, k) => (k === i ? { ...x } : x));
      if (val === undefined) delete inserts[i][c];
      else inserts[i][c] = val;
      setPendingFor(t.id, { ...p, inserts });
      return;
    }
    const r = ref.i;
    const orig = t.result.rows[r]?.[c] ?? null;
    const cells = { ...p.cells };
    const rowEdits = { ...(cells[r] ?? {}) };
    if (val === undefined || val === orig) delete rowEdits[c]; // editing back to the original is not a change
    else rowEdits[c] = val;
    if (Object.keys(rowEdits).length) cells[r] = rowEdits;
    else delete cells[r];
    const np = { ...p, cells };
    setPendingFor(t.id, isPendingEmpty(np) ? undefined : np);
  }

  /** Toggle delete-marks on loaded rows; insert rows are removed outright. */
  function onMarkDelete(refs: RowRef[]) {
    if (!editCtx().editable || !refs.length) return;
    const t = activeTab();
    const p = ensurePending();
    const rmIns = new Set(refs.filter((r) => r.kind === "insert").map((r) => r.i));
    const inserts = rmIns.size ? p.inserts.filter((_, i) => !rmIns.has(i)) : p.inserts;
    const loaded = refs.filter((r) => r.kind === "loaded").map((r) => r.i);
    const cur = new Set(p.deletes);
    const allMarked = loaded.length > 0 && loaded.every((r) => cur.has(r));
    for (const r of loaded) allMarked ? cur.delete(r) : cur.add(r);
    const np = { ...p, deletes: [...cur].sort((a, b) => a - b), inserts };
    setPendingFor(t.id, isPendingEmpty(np) ? undefined : np);
  }

  /** Paste a clipboard grid (header-mapped or positional) into pending edits. */
  function onPaste(anchor: RowRef, anchorDisplayIdx: number, displayOrigCols: number[], table: string[][]) {
    const ec = editCtx();
    if (!ec.editable || !ec.plan || !table.length) return;
    const t = activeTab();
    const p = ensurePending();
    const plan = planPaste({
      table,
      resultColumns: t.result.columns,
      isTableCol: ec.plan.isTableCol,
      displayOrigCols,
      anchorDisplayIdx,
      anchor,
      nLoaded: t.result.rows.length,
      nInsExisting: p.inserts.length,
    });
    if (!plan.updates.length && !plan.inserts.length) {
      setStatus("nothing to paste (no editable columns)");
      return;
    }
    const np = mergePaste(p, plan, t.result.rows);
    setPendingFor(t.id, isPendingEmpty(np) ? undefined : np);
    const added = plan.inserts.length;
    setStatus(
      plan.mode === "mapped"
        ? `pasted ${plan.rowCount} row${plan.rowCount === 1 ? "" : "s"} (mapped by header)`
        : `pasted ${plan.rowCount}×${plan.colCount}${added ? ` (+${added} new row${added === 1 ? "" : "s"})` : ""}`,
    );
  }

  function onAddRow() {
    if (!editCtx().editable) return;
    const p = ensurePending();
    setPendingFor(activeTabId(), { ...p, inserts: [...p.inserts, {}] });
  }

  // Commit dialog: preview the generated script, run it as one transactional
  // script (run_query → script::run), then clear pending + refresh the grid.
  const [commitView, setCommitView] = createSignal<{ script: string[] } | null>(null);
  const [commitBusy, setCommitBusy] = createSignal(false);
  const [commitErr, setCommitErr] = createSignal("");
  const [confirmDiscard, setConfirmDiscard] = createSignal<{ count: number; run: () => void } | null>(null);

  function openCommit() {
    const ec = editCtx();
    const t = activeTab();
    if (!ec.editable || !ec.plan || !t.pending || running()) return;
    const script = buildCommitScript({
      schema: ec.plan.schema,
      table: ec.plan.table,
      columns: t.result.columns,
      isTableCol: ec.plan.isTableCol,
      pkIdx: ec.plan.pkIdx,
      rows: t.result.rows,
      pending: t.pending,
      dialect: caps()?.kind,
    });
    if (!script.length) {
      // Shouldn't happen (non-table cells can't be edited) — but never open a dialog
      // that would run an empty script.
      setStatus("no committable changes");
      return;
    }
    setCommitErr("");
    setCommitView({ script });
  }

  async function doCommit() {
    const cv = commitView();
    const c = conn();
    if (!cv || !c || commitBusy() || running()) return;
    const tabId = activeTabId();
    setCommitBusy(true);
    setCommitErr("");
    try {
      // Fully-qualified statements — no search_path dependence. Multi-statement
      // scripts run in one transaction (rolled back wholesale on failure).
      const sqlText = cv.script.map((s) => s + ";").join("\n");
      await invoke<QueryOutcome>("run_query", { connectionId: c.id, sql: sqlText, pageSize: PAGE, searchPath: null });
      setPendingFor(tabId, undefined);
      setCommitView(null);
      setStatus(`${cv.script.length} change${cv.script.length === 1 ? "" : "s"} applied`);
      // Refresh the grid in place, keeping the current sort/filter view.
      const t = tabs().find((x) => x.id === tabId);
      if (t) {
        const v = t.gridView;
        const base = t.result.baseQuery;
        const sqlToRun = v.sorts.length || v.filters.length ? wrapQuery(base, v.sorts, v.filters, t.result.columns, caps()?.kind) : base;
        void executeQuery(sqlToRun, base, "wrapped");
      }
    } catch (e) {
      setCommitErr(errMsg(e)); // pending kept — the transaction rolled back
    } finally {
      setCommitBusy(false);
    }
  }

  function discardPending() {
    const n = pendingCount(tabPending());
    if (!n) return;
    setConfirmDiscard({ count: n, run: () => setPendingFor(activeTabId(), undefined) });
  }

  const [loadingAll, setLoadingAll] = createSignal(false);
  const [schemaLoading, setSchemaLoading] = createSignal(false);
  let cancelAll = false;
  let importFileInput: HTMLInputElement | undefined;
  // Reactive so the "streaming…" spinner spins only during an actual in-flight fetch
  // (not merely while more rows remain, i.e. !done()).
  const [fetchingMore, setFetchingMore] = createSignal(false);
  let runTimer: ReturnType<typeof setInterval> | undefined;

  const [slackStatus, setSlackStatus] = createSignal<SlackStatus>({ running: false, state: "disconnected", error: null });
  const slackUnlisten: UnlistenFn[] = [];

  onMount(async () => {
    void refreshSkills();
    // Suppress the WebView's native right-click menu app-wide; the sidebar shows
    // its own context menu, and the editor uses keyboard shortcuts for copy/paste.
    document.addEventListener("contextmenu", (e) => e.preventDefault());
    // Window-level editor/tab shortcuts (the in-editor keymap owns Mod-Enter/Shift-Alt-f/
    // Mod-f/Tab — no overlap with T/W/S/O). preventDefault so Cmd-W closes the tab, not the window.
    window.addEventListener("keydown", onWindowKey);
    // Shrinking the window re-clamps every docked panel (see clampPanels).
    window.addEventListener("resize", clampPanels);
    clampPanels();
    // Load profiles + auto-connect FIRST — the core startup path must not depend on
    // the Slack event bridge (a rejected listen() would otherwise abort onMount and
    // leave the connect screen empty).
    await loadProfiles();
    const def = profiles().find((p) => p.default_connect);
    if (def) connectProfile(def.id);
    // Slack bot status (statusbar badge) + audit trail: every Slack-approved query
    // lands in the normal per-connection history with a [Slack] marker comment.
    // Best-effort — a failed listen must never break the app.
    try {
      invoke<SlackStatus>("slack_status").then(setSlackStatus).catch(() => {});
      slackUnlisten.push(await listen<SlackStatus>("slack:status", (e) => setSlackStatus(e.payload)));
      slackUnlisten.push(
        await listen<SlackExecuted>("slack:executed", (e) => {
          const p = e.payload;
          recordHistory({
            sql: `-- [Slack] asked by ${p.slackUser}\n${p.sql}`,
            durationMs: p.durationMs,
            status: p.status === "ok" ? "ok" : "error",
            rows: p.rows ?? null,
            error: p.error ? p.error.split("\n")[0] : null,
            schema: null,
          });
        }),
      );
    } catch {
      /* Slack event bridge unavailable — badge + audit degrade silently */
    }
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onWindowKey);
    window.removeEventListener("resize", clampPanels);
    for (const u of slackUnlisten) u();
  });

  // Central dispatcher — every action callable from a shortcut, the palette, or
  // the Shortcuts pane goes through here.
  function runAction(id: ActionId) {
    switch (id) {
      case "run": void doRun(); break;
      case "runStatement": {
        const s = editorApi()?.getCurrentStatement();
        if (s?.trim()) void doRun(s);
        break;
      }
      case "explain": runExplain(false); break;
      case "explainAnalyze": runExplain(true); break;
      case "cancelQuery": if (running()) void cancelQuery(); break;
      case "format": editorApi()?.format(); break;
      case "find": editorApi()?.openSearch(); break;
      case "toggleComment": editorApi()?.toggleComment(); break;
      case "toggleWrap": updatePrefs({ wordWrap: !prefs().wordWrap }); break;
      case "toggleSidebar": toggleSidebar(); break;
      case "toggleResults": toggleResults(); break;
      case "newTab": openNewTab(); break;
      case "closeTab": closeTab(activeTabId()); break;
      case "openFile": void openFileDialog(); break;
      case "saveFile": void saveActiveTab(); break;
      case "saveFileAs": void saveAsActiveTab(); break;
      case "openSettings": setSettingsOpen("editor"); break;
      case "openShortcuts": setSettingsOpen("shortcuts"); break;
      case "openHelp": setHelpOpen(true); break;
      case "openHistory": setHistoryOpen((v) => !v); break;
      case "openPalette": setPaletteOpen(true); break;
      case "toggleAi": setAiOpen((v) => !v); break;
      case "loadAllRows": if (!done()) void loadAll(); break;
      case "exportResult": openExport(); break;
    }
  }

  function onWindowKey(e: KeyboardEvent) {
    // The editor keymap (and any other in-place handler) marks what it consumed.
    if (e.defaultPrevented) return;
    if (paletteOpen()) return; // the palette owns the keyboard while open
    const k = normalizeKeyEvent(e);
    if (!k) return;
    const id = globalBindings().get(k);
    if (!id) return;
    // On the connect screen only screen-independent actions fire (manual, settings).
    if (!conn() && id !== "openHelp" && id !== "openSettings") return;
    // Chords without Mod/Alt (F5, plain Enter, Shift-X…) must not fire while
    // typing in an input/textarea or the editor.
    if (!/^Mod-|^Alt-/.test(k)) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || t.closest?.(".cm-editor"))) return;
    }
    const def = ACTIONS.find((a) => a.id === id)!;
    if (def.enabled && !def.enabled(actionCtx())) return;
    e.preventDefault();
    runAction(id);
  }

  async function loadProfiles() {
    try {
      setProfiles(await invoke<Profile[]>("list_profiles"));
    } catch (e) {
      console.error(e);
    }
  }

  function newProfile() {
    setEditingId("");
    setDriver("postgres");
    setName("");
    setHost("localhost");
    setPort(5432);
    setUser("");
    setPassword("");
    setDbname("postgres");
    setPath("");
    setSavePassword(false);
    setSslmode("prefer");
    setReadOnly(false);
    setDefaultConnect(false);
    setConnErr("");
  }

  function editProfile(p: Profile) {
    setEditingId(p.id);
    setDriver((p.driver as (typeof DRIVERS)[number]["id"]) ?? "postgres");
    setName(p.name);
    setHost(p.host);
    setPort(p.port);
    setUser(p.user);
    setPassword("");
    setDbname(p.dbname);
    setPath(p.path ?? "");
    setSavePassword(p.save_password);
    setSslmode(p.sslmode ?? "prefer");
    setReadOnly(p.read_only);
    setDefaultConnect(p.default_connect);
    setConnErr("");
  }

  const isEmbeddedDriver = (d?: string | null) => d === "duckdb" || d === "sqlite";

  function useProfile(p: Profile) {
    // Embedded profiles need no password; saved-password profiles connect directly.
    if (isEmbeddedDriver(p.driver) || p.save_password) connectProfile(p.id);
    else editProfile(p);
  }

  async function afterConnect(r: { connection_id: string; server_version: string; read_only: boolean }) {
    setConn({ id: r.connection_id, version: r.server_version, readOnly: r.read_only });
    try {
      setCaps(await invoke<Capabilities>("capabilities", { connectionId: r.connection_id }));
    } catch {
      setCaps(null);
    }
    // DuckDB: probe PG-style EXPLAIN options once, at connect (safe — nothing
    // is streaming yet). Drives the Explain action's wrapping.
    duckJsonExplain = false;
    if (caps()?.kind === "duckdb") {
      try {
        await invoke<QueryOutcome>("run_query", { connectionId: r.connection_id, sql: "EXPLAIN (FORMAT json) SELECT 1", pageSize: 1, searchPath: null });
        duckJsonExplain = true;
      } catch {
        duckJsonExplain = false;
      }
    }
    // Restore this connection's tab set (buffers/paths only — results are ephemeral).
    if (connKey) {
      const saved = tabsStore.load(connKey);
      restoring = true;
      if (saved && saved.tabs.length) {
        const restored = saved.tabs.map((pt) =>
          makeTab({ sql: pt.sql, filePath: pt.filePath, title: pt.title, searchSchema: pt.searchSchema ?? null, dirty: false }),
        );
        setTabs(restored);
        setActiveTabId(restored[Math.min(saved.activeIndex, restored.length - 1)].id);
      } else {
        const fresh = makeTab();
        setTabs([fresh]);
        setActiveTabId(fresh.id);
      }
      restoring = false;
    }
    setHistory(connKey ? await historyStore.load(connKey) : []);
    await loadSchema();
  }

  async function doConnect(e: Event) {
    e.preventDefault();
    setConnecting(true);
    setConnErr("");
    try {
      const isFile = driver() === "duckdb" || driver() === "sqlite";
      const config = isFile
        ? { driver: driver(), path: path(), read_only: readOnly() }
        : {
            driver: driver(),
            host: host(),
            port: Number(port()),
            user: user(),
            password: password(),
            dbname: dbname(),
            sslmode: sslmode(),
            read_only: readOnly(),
          };
      const r = await invoke<{ connection_id: string; server_version: string; read_only: boolean }>("connect", { config });
      connKey = isFile ? `adhoc:${driver()}:${path() || ":memory:"}` : `adhoc:${host()}:${port()}:${dbname()}:${user()}`;
      await afterConnect(r);
    } catch (e) {
      setConnErr(errMsg(e));
    } finally {
      setConnecting(false);
    }
  }

  // Pick an existing DuckDB/SQLite database file (a new file can also be typed).
  async function browseDbFile() {
    const p = await openDialog({
      multiple: false,
      filters: [{ name: "Database", extensions: ["duckdb", "ddb", "db", "sqlite", "sqlite3"] }],
    });
    if (typeof p === "string") setPath(p);
  }

  async function connectProfile(id: string) {
    setConnecting(true);
    setConnErr("");
    try {
      const r = await invoke<{ connection_id: string; server_version: string; read_only: boolean }>(
        "connect_profile",
        { id },
      );
      connKey = `profile:${id}`;
      await afterConnect(r);
    } catch (e) {
      setConnErr(errMsg(e));
    } finally {
      setConnecting(false);
    }
  }

  async function saveProfile() {
    setConnErr("");
    try {
      const embedded = isEmbeddedDriver(driver());
      const p = await invoke<Profile>("save_profile", {
        profile: {
          id: editingId(),
          name: name() || (embedded ? basename(path() || ":memory:") : host()),
          host: host(),
          port: Number(port()),
          user: user(),
          dbname: dbname(),
          save_password: !embedded && savePassword(),
          sslmode: sslmode(),
          read_only: readOnly(),
          default_connect: defaultConnect(),
          driver: driver(),
          path: embedded ? path() || null : null,
        },
        password: !embedded && savePassword() && password() ? password() : null,
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

  // Snapshot the tab set for persistence — capture the active tab's live editor doc
  // (the editor, not tab.sql, is the source of truth while a tab is active).
  function snapshotTabs(): PersistedTabs {
    const liveDoc = editorApi()?.getDoc();
    const list = tabs();
    return {
      tabs: list.map((t) => ({
        sql: t.id === activeTabId() && liveDoc != null ? liveDoc : t.sql,
        filePath: t.filePath,
        title: t.title,
        searchSchema: t.searchSchema,
      })),
      activeIndex: Math.max(0, list.findIndex((t) => t.id === activeTabId())),
    };
  }

  async function disconnect() {
    const c = conn();
    if (connKey) tabsStore.save(connKey, snapshotTabs());
    if (c) invoke("disconnect", { connectionId: c.id }).catch(() => {});
    connKey = null;
    setConn(null);
    setCaps(null);
    setHistory([]);
    setHistoryOpen(false);
    setPerms(null);
    setTree(null);
    setSchema([]);
    setFuncs(new Set<string>());
    setDetails({});
    loadedRels.clear();
    cursorOwnerTabId = null;
    const fresh = makeTab();
    setTabs([fresh]);
    setActiveTabId(fresh.id);
  }

  // Reflect the connected database in the OS window title (mascot + driver).
  createEffect(() => {
    const c = conn();
    const kind = caps()?.kind;
    const title = c ? `${driverMascot(kind)} Tusk — ${driverLabel(kind)}` : "Tusk";
    try {
      void getCurrentWindow().setTitle(title);
    } catch {
      /* not in a Tauri window (e.g. preview) */
    }
  });

  // Label for the connected target shown in the topbar chip: the database name for
  // server drivers, or the file basename (":memory:" when blank) for embedded ones.
  const connTarget = () => {
    const k = caps()?.kind;
    if (k === "duckdb" || k === "sqlite") {
      const p = path().trim();
      return p ? p.split(/[\\/]/).pop() || p : ":memory:";
    }
    return dbname() || host();
  };

  // Debounced per-connection tab-set save as buffers/structure change.
  createEffect(() => {
    const data: PersistedTabs = {
      tabs: tabs().map((t) => ({ sql: t.sql, filePath: t.filePath, title: t.title, searchSchema: t.searchSchema })),
      activeIndex: Math.max(0, tabs().findIndex((t) => t.id === activeTabId())),
    };
    if (restoring || !connKey) return;
    const key = connKey;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => tabsStore.save(key, data), 800);
  });

  async function loadSchema() {
    const c = conn();
    if (!c) return;
    setSchemaLoading(true);
    sampleCache.clear(); // schema (and likely data) may have changed — drop stale AI samples
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
      // Refresh effective privileges alongside the tree (grants/ownership can change).
      invoke<Permissions>("permissions", { connectionId: c.id }).then(setPerms).catch(() => setPerms(null));
    } catch (e) {
      console.error(e);
    } finally {
      setSchemaLoading(false);
    }
  }

  // Full table+column list for autocomplete (decoupled from the lazy tree),
  // plus the live function catalog feeding the unknown-function lint (empty
  // set = engine can't enumerate → that lint stays off).
  async function loadTables() {
    const c = conn();
    if (!c) return;
    try {
      setSchema(await invoke<TableInfo[]>("list_schema", { connectionId: c.id }));
    } catch (e) {
      console.error(e);
    }
    try {
      const names = await invoke<string[]>("list_functions", { connectionId: c.id });
      setFuncs(new Set(names.map((n) => n.toLowerCase())));
    } catch {
      setFuncs(new Set<string>());
    }
    // FK catalog for JOIN completion: active schema + public, merged.
    fkFetched.clear();
    setFkEdges([]);
    await fetchFkSchema(activeTab().searchSchema ?? "public");
    if ((activeTab().searchSchema ?? "public") !== "public") await fetchFkSchema("public");
  }

  /** Make sure the AI's join graph is loaded before a send: the same schemas autocomplete
   *  primes (active + public). Without this the panel would ship an empty `fks` on the
   *  first question of a session and the model would guess joins. */
  async function ensureAiFks() {
    const names = new Set([activeTab().searchSchema ?? "public", "public"]);
    await Promise.all([...names].map((n) => fetchFkSchema(n)));
  }

  /** Fetch one schema's FK edges into fkEdges (deduped; best-effort). */
  async function fetchFkSchema(schemaName: string) {
    const c = conn();
    if (!c || caps()?.relationships === false || fkFetched.has(schemaName) || fkInFlight.has(schemaName)) return;
    fkInFlight.add(schemaName);
    try {
      const g = await invoke<{ tables: unknown[]; edges: FkEdge[] }>("schema_relationships", { connectionId: c.id, schema: schemaName });
      // Mark fetched ONLY on success. `fksKnown` (which gates the AI prompt's "this schema
      // declares no foreign keys" claim) is derived from this set — marking before the
      // await meant a FAILED fetch asserted the schema had no FKs, the exact lie the
      // tri-state exists to prevent. A failure stays unmarked so the next send retries.
      fkFetched.add(schemaName);
      setFkEdges((prev) => {
        const key = (e: FkEdge) => `${e.constraint}|${e.srcSchema}.${e.srcTable}`;
        const seen = new Set(prev.map(key));
        return [...prev, ...g.edges.filter((e) => !seen.has(key(e)))];
      });
    } catch {
      /* best-effort — completion just has fewer hints, and the prompt stays silent on FKs */
    } finally {
      fkInFlight.delete(schemaName);
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

  const sameColumns = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

  // Record a finished user-issued run into the per-connection history (never a
  // grid sort/filter re-run, never blocks the query path on storage failures).
  const recordHistory = (e: Omit<HistoryEntry, "id" | "ts">) => {
    if (!connKey) return;
    const ts = Date.now();
    setHistory(historyStore.append(connKey, { id: makeEntryId(ts), ts, ...e }));
  };

  // Shared query executor. `mode:"base"` = a user-issued query (resets sorts/filters,
  // fresh grid view if the column set changed); `mode:"wrapped"` = a sort/filter re-run
  // (keep the grid view — its sorts/filters drive the wrap).
  async function executeQuery(sqlToRun: string, base: string, mode: "base" | "wrapped", force = false) {
    const c = conn();
    if (!c || running() || !sqlToRun.trim()) return;
    const runTabId = activeTabId();
    // Re-running replaces the rows the pending edits index into — confirm first.
    const pcount = pendingCount(tabs().find((t) => t.id === runTabId)?.pending);
    if (pcount && !force) {
      setConfirmDiscard({ count: pcount, run: () => void executeQuery(sqlToRun, base, mode, true) });
      return;
    }
    if (pcount) patchTab(runTabId, { pending: undefined });
    // Running with the results panel collapsed would hide the output — reopen it.
    if (!resultsOpen()) { setResultsOpen(true); persistLayout(); }
    const runSchema = activeTab().searchSchema;
    if (cursorOwnerTabId && cursorOwnerTabId !== runTabId) patchResult(cursorOwnerTabId, { done: true });
    cursorOwnerTabId = null;
    patchResult(runTabId, { runErr: "", status: "" });
    patchTab(runTabId, { resultView: undefined }); // a new run resets the Plan/Grid choice
    setRunning(true);
    setRunningTabId(runTabId);
    const t0 = performance.now();
    setRunMs(0);
    runTimer = setInterval(() => setRunMs(performance.now() - t0), 200);
    try {
      const out = await invoke<QueryOutcome>("run_query", { connectionId: c.id, sql: sqlToRun, pageSize: PAGE, searchPath: runSchema });
      const rt = tabs().find((t) => t.id === runTabId);
      const epoch = (rt?.result.epoch ?? 0) + 1;
      if (out.kind === "rows") {
        const prevCols = rt?.result.columns ?? [];
        patchResult(runTabId, {
          columns: out.columns, rows: out.rows, done: out.done, lastQuery: sqlToRun, baseQuery: base, epoch,
          status: `${out.rows.length}${out.done ? "" : "+"} rows${out.note ? ` · ${out.note}` : ""}`,
        });
        if (mode === "base") {
          // A fresh result resets sort/filter, but the filter-row VISIBILITY is a UI
          // preference (e.g. "Filter rows…" from the sidebar) — keep it across the reset.
          patchTab(runTabId, {
            gridView: sameColumns(prevCols, out.columns)
              ? { ...(rt?.gridView ?? gridViewFor(out.columns.length)), sorts: [], filters: [] }
              : { ...gridViewFor(out.columns.length), filterRowOpen: rt?.gridView.filterRowOpen ?? false },
          });
        }
        if (!out.done) cursorOwnerTabId = runTabId;
      } else {
        patchResult(runTabId, { columns: [], rows: [], done: true, lastQuery: sqlToRun, baseQuery: base, epoch, status: out.message });
        if (mode === "base") patchTab(runTabId, { gridView: gridViewFor(0) });
      }
      if (out.kind === "exec" || DDL_RE.test(sqlToRun)) void loadSchema();
      if (mode === "base") {
        recordHistory({
          sql: sqlToRun,
          durationMs: Math.round(performance.now() - t0),
          status: "ok",
          rows: out.kind === "rows" ? out.rows.length : null,
          error: null,
          schema: runSchema,
        });
      }
    } catch (e) {
      const msg = errMsg(e);
      // A user cancel surfaces as Postgres' "canceling statement due to user request" —
      // present it as a calm status, not a red error banner.
      if (/cancel/i.test(msg)) patchResult(runTabId, { runErr: "", status: "Query cancelled", columns: [], rows: [], done: true });
      else patchResult(runTabId, { runErr: msg, columns: [], rows: [], done: true });
      if (mode === "base") {
        recordHistory({
          sql: sqlToRun,
          durationMs: Math.round(performance.now() - t0),
          status: /cancel/i.test(msg) ? "cancelled" : "error",
          rows: null,
          error: msg.split("\n")[0],
          schema: runSchema,
        });
      }
    } finally {
      if (runTimer) clearInterval(runTimer);
      setRunning(false);
      setRunningTabId(null);
      setCancelling(false);
      patchResult(runTabId, { elapsed: Math.round(performance.now() - t0) });
    }
  }

  // Cancel the in-flight query (re-clicking Run): fire a Postgres CancelRequest; the
  // run_query call then errors out and unwinds through executeQuery's finally.
  function cancelQuery() {
    if (!running() || cancelling()) return;
    setCancelling(true);
    void cancelOperation();
  }

  // Run-target chooser: when Run is hit with the cursor inside one of several statements
  // (and nothing selected), ask whether to run the whole file or just that block.
  const [runChoice, setRunChoice] = createSignal<{ x: number; y: number } | null>(null);
  let runBtnRef: HTMLButtonElement | undefined;

  // Pre-run parameter prompt state: every run path (Run button, gutter ▶,
  // selection, history re-run, Explain) funnels through runText, so detection
  // lives here once.
  const [paramPrompt, setParamPrompt] = createSignal<{ text: string; params: Param[] } | null>(null);

  function runText(t: string) {
    const params = detectParams(t);
    if (params.length) {
      setParamPrompt({ text: t, params });
      return;
    }
    runTextNow(t);
  }

  function runTextNow(t: string) {
    // A multi-statement run streams only the *last* statement's result, and we don't have
    // an isolated single SELECT to re-wrap — so store a non-wrappable base (disabling grid
    // sort/filter). Conservative: any inner `;` counts as multi (never wrongly wrappable).
    const inner = stripTrailingSemi(t);
    const base = inner.includes(";") ? "" : inner;
    const at = activeTab();
    // Re-running the SAME query text (no edits) while the grid has active sort/filter
    // rules carries them over: re-stream the wrapped query instead of resetting to the
    // raw result. Any edit to the query text breaks the match → fresh result (rules reset).
    if (
      base !== "" &&
      base === stripTrailingSemi(at.result.baseQuery) &&
      wrappableQuery(base) &&
      hasViewRules(at.gridView.sorts, at.gridView.filters)
    ) {
      const gv = at.gridView;
      void executeQuery(wrapQuery(base, gv.sorts, gv.filters, at.result.columns, caps()?.kind), base, "wrapped");
      return;
    }
    void executeQuery(t, base, "base");
  }

  function doRun(override?: string) {
    // Explicit text (statement-gutter / run-current-statement) runs as-is, no prompt.
    if (override !== undefined) {
      runText(override);
      return;
    }
    const api = editorApi();
    // A selection runs exactly what's selected, no prompt.
    if (api && api.getSelection().trim()) {
      runText(api.getRunText());
      return;
    }
    // Multiple statements + cursor inside one → ask: whole file, or just this block.
    if (api && api.getStatementCount() > 1) {
      const r = runBtnRef?.getBoundingClientRect();
      setRunChoice(r ? { x: r.left, y: r.bottom + 6 } : { x: 16, y: 84 });
      return;
    }
    // Single statement (or no editor) → run the whole buffer.
    runText(api?.getRunText() ?? sql());
  }

  function chooseRun(which: "block" | "file") {
    setRunChoice(null);
    const api = editorApi();
    if (!api) return;
    runText(which === "block" ? api.getCurrentStatement() : api.getDoc());
  }

  // Re-stream the active tab's result sorted/filtered (server ORDER BY / WHERE).
  function onSortFilter(sorts: SortKey[], filters: Filter[]) {
    setGridView({ sorts, filters });
    const base = activeTab().result.baseQuery;
    if (!wrappableQuery(base)) return;
    void executeQuery(wrapQuery(base, sorts, filters, activeTab().result.columns, caps()?.kind), base, "wrapped");
  }

  async function loadMore() {
    const c = conn();
    const id = activeTabId();
    if (!c || done() || fetchingMore()) return;
    if (cursorOwnerTabId !== id) return; // this tab doesn't own the live cursor
    setFetchingMore(true);
    try {
      const r = await invoke<FetchResult>("fetch_more", { connectionId: c.id, pageSize: PAGE });
      // Read the captured tab's rows (the user may have switched tabs during the fetch).
      const prev = tabs().find((t) => t.id === id)?.result.rows ?? [];
      const merged = r.rows.length ? [...prev, ...r.rows] : prev;
      patchResult(id, { rows: merged, done: r.done, status: `${merged.length}${r.done ? "" : "+"} rows` });
      if (r.done) cursorOwnerTabId = null;
    } catch (e) {
      // Streaming broke (e.g. connection dropped mid-fetch). Surface it instead of
      // silently marking the result complete — show the error banner over the rows
      // fetched so far, and stop paging so we don't hammer a dead cursor.
      const msg = errMsg(e);
      patchResult(id, { runErr: msg, status: `streaming stopped — ${msg}`, done: true });
      cursorOwnerTabId = null;
    } finally {
      setFetchingMore(false);
    }
  }

  // Drain the cursor to completion (or cancel). Yields between pages to stay responsive.
  async function loadAll() {
    if (loadingAll()) { cancelAll = true; return; }
    const id = activeTabId();
    setLoadingAll(true);
    cancelAll = false;
    while (!cancelAll && !done() && cursorOwnerTabId === id && activeTabId() === id) {
      await loadMore();
      await new Promise((r) => setTimeout(r));
    }
    setLoadingAll(false);
  }

  function tableNameFromSql(s: string): string {
    const m = /from\s+(?:"?[\w]+"?\.)?"?([\w]+)"?/i.exec(s);
    return m ? m[1] : "export";
  }

  async function exportToFile(opts: ExportOptions, scope: ExportScope) {
    const src = exportSrc();
    if (!src) return;
    const c = conn();
    const table = opts.sql.table || src.table;
    const path = await save({
      defaultPath: `${table}.${FORMAT_EXT[opts.format]}`,
      filters: [{ name: opts.format.toUpperCase(), extensions: [FORMAT_EXT[opts.format]] }],
    });
    if (!path) return;
    setStatus("exporting…");
    const args =
      scope === "all"
        ? { connectionId: c?.id, sql: src.query, options: opts, path, searchPath: src.searchSchema }
        : { columns: src.columns, rows: src.rows, options: opts, path };
    const n = await invoke<number>("export_to_file", args);
    setStatus(`exported ${n} rows → ${path}`);
  }

  // Immediately cancel + roll back the in-flight export/import on this connection.
  async function cancelOperation() {
    const c = conn();
    if (!c) return;
    try {
      await invoke("cancel_operation", { connectionId: c.id });
    } catch (e) {
      console.error(e);
    }
  }

  async function exportToClipboard(opts: ExportOptions) {
    const src = exportSrc();
    if (!src) return;
    const text = formatWithOptions({ columns: src.columns, rows: src.rows }, opts);
    const ok = await clipWrite(text);
    setStatus(ok ? `copied ${src.rows.length} rows` : "clipboard unavailable");
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
      const m = errMsg(e);
      setImportMsg(/cancel/i.test(m) ? "Import cancelled — rolled back." : m);
    } finally {
      setImportBusy(false);
    }
  }

  function startResize(e: MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = editorH();
    const onMove = (ev: MouseEvent) =>
      setEditorH(Math.max(80, Math.min(startH + (ev.clientY - startY), maxEditorH())));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      persistLayout();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
  }

  function runTable(schemaName: string, name: string) {
    const q = `SELECT * FROM ${qualifyIn(schemaName, name, schemaName)}`;
    openGeneratedTab(q, schemaName, name);
    doRun(q);
  }

  function runTableLimit(schemaName: string, name: string, limit: number) {
    const q = `SELECT * FROM ${qualifyIn(schemaName, name, schemaName)} LIMIT ${limit}`;
    openGeneratedTab(q, schemaName, name);
    doRun(q);
  }

  /** Open a table in a new tab and run it with the per-column filter row already showing. */
  function filterTable(schemaName: string, name: string) {
    const q = `SELECT * FROM ${qualifyIn(schemaName, name, schemaName)}`;
    const t = makeTab({ sql: q, searchSchema: schemaName, title: name });
    t.gridView = { ...t.gridView, filterRowOpen: true };
    setTabs((ts) => [...ts, t]);
    switchTab(t.id);
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
    else setSql((sql() ? sql().replace(/\s*$/, "\n\n") : "") + body);
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

  // Generate a SELECT/INSERT/UPDATE scaffold from a relation's columns into a NEW
  // tab whose schema is the relation's, so the generated query stays unqualified
  // and resolves (rather than clobbering the current tab).
  async function generate(n: NodeDescriptor, kind: "select" | "insert" | "update") {
    await loadDetail(n.schema!, n.name, false);
    const d = details()[`${n.schema}.${n.name}`];
    const cols = d?.columns.map((c) => c.name) ?? [];
    const pks = d?.columns.filter((c) => c.is_pk).map((c) => c.name) ?? [];
    const schema = n.schema!;
    const text =
      kind === "select"
        ? ddl.genSelect(schema, n.name, cols, schema)
        : kind === "insert"
          ? ddl.genInsert(schema, n.name, cols, schema)
          : ddl.genUpdate(schema, n.name, cols, pks, schema);
    openGeneratedTab(text.trim() + ";", schema, n.name);
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
        { label: `New column in ${tableCtx.name}…`, icon: "plus", ...gate(ownsTable(tableCtx.schema!, tableCtx.name), `Requires ownership of ${tableCtx.name}`), onClick: () => setActiveDialog({ kind: "addColumn", ctx: tableCtx }) },
        { label: `New index on ${tableCtx.name}…`, icon: "index", ...gate(ownsTable(tableCtx.schema!, tableCtx.name), `Requires ownership of ${tableCtx.name}`), onClick: () => openIndexDialog(tableCtx) },
        { label: `New constraint on ${tableCtx.name}…`, icon: "link", ...gate(ownsTable(tableCtx.schema!, tableCtx.name), `Requires ownership of ${tableCtx.name}`), ...noDuck("DuckDB can't add constraints via ALTER — define them in CREATE TABLE"), onClick: () => openConstraintDialog(tableCtx) },
        { sep: true },
      );
    }
    if (schemaName)
      items.push({ label: `New table in ${schemaName}…`, icon: "copy", ...gate(canCreateInSchema(schemaName), `Requires CREATE on schema ${schemaName}`), onClick: () => setActiveDialog({ kind: "createTable", schema: schemaName }) });
    items.push(
      { label: "New schema…", icon: "folder", ...gate(canCreateSchema(), "Requires CREATE on the database"), onClick: () => setActiveDialog({ kind: "createSchema" }) },
      { label: "New database…", icon: "database", ...gate(canCreateDatabase(), "Requires the CREATEDB role attribute"), ...noDuck("DuckDB attaches database files rather than CREATE DATABASE"), onClick: () => setActiveDialog({ kind: "createDatabase" }) },
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

  // Per-node-kind action menu. Mutating items are disabled on read-only
  // connections and on drivers without PG-syntax DDL support (see gate()).
  function menuItems(n: NodeDescriptor): MenuItem[] {
    const s = n.schema;
    const qual = s ? qualify(s, n.name) : ident(n.name);
    const copyName: MenuItem = { label: "Copy name", icon: "copy", onClick: () => copyText(n.name, `copied ${n.name}`) };
    const copyQual: MenuItem = { label: "Copy qualified name", icon: "copy", onClick: () => copyText(qual, "copied name") };
    const copyDdl: MenuItem[] = [
      { label: "Copy DDL", icon: "fileCode", onClick: () => copyDDL(n, false) },
      { label: "Copy DDL → editor", icon: "fileCode", onClick: () => copyDDL(n, true) },
    ];
    const items: MenuItem[] = [];

    switch (n.kind) {
      case "table":
        items.push(
          { label: "Select 100 rows", icon: "play", onClick: () => runTableLimit(s!, n.name, 100) },
          { label: "Select all rows", icon: "play", onClick: () => runTable(s!, n.name) },
          { label: "Filter rows…", icon: "search", onClick: () => filterTable(s!, n.name) },
          { sep: true },
          { label: "Modify table…", icon: "edit", ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), onClick: () => openModify(n) },
          { label: "Add column…", icon: "plus", ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), onClick: () => setActiveDialog({ kind: "addColumn", ctx: n }) },
          { label: "Add index…", icon: "index", ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), onClick: () => openIndexDialog(n) },
          { label: "Add constraint…", icon: "link", ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), ...noDuck("DuckDB can't add constraints via ALTER — define them in CREATE TABLE"), onClick: () => openConstraintDialog(n) },
          { sep: true },
          { label: "Rename…", icon: "edit", ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), onClick: () => setActiveDialog({ kind: "rename", title: `Rename table ${n.name}`, current: n.name, build: (nn) => ddl.renameRelation("table", s!, n.name, nn) }) },
          { label: "Duplicate…", icon: "duplicate", ...gate(canCreateInSchema(s!), `Requires CREATE on schema ${s}`), onClick: () => setActiveDialog({ kind: "duplicate", title: `Duplicate ${n.name}`, defaultName: `${n.name}_copy`, build: (nn, wd) => ddl.duplicateTable(s!, n.name, nn, wd) }) },
          { label: "Edit comment…", icon: "comment", ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), onClick: () => setActiveDialog({ kind: "comment", title: `Comment on ${n.name}`, current: n.detail?.comment ?? "", build: (t) => ddl.comment(`TABLE ${qual}`, t) }) },
          { sep: true },
          { label: "Truncate…", icon: "eraser", danger: true, ...gate(canTruncate(s!, n.name), `Requires TRUNCATE or ownership of ${n.name}`), onClick: () => setActiveDialog({ kind: "confirm", title: `Truncate ${n.name}`, primaryLabel: "Truncate", showCascade: true, showRestartIdentity: true, build: (o) => ddl.truncate(s!, n.name, o) }) },
          { label: "Drop…", icon: "trash", danger: true, ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), onClick: () => setActiveDialog({ kind: "confirm", title: `Drop table ${n.name}`, primaryLabel: "Drop table", showCascade: true, build: (o) => ddl.dropRelation("table", s!, n.name, o.cascade) }) },
          { sep: true },
          { label: "Generate SELECT", icon: "code", onClick: () => generate(n, "select") },
          { label: "Generate INSERT", icon: "code", onClick: () => generate(n, "insert") },
          { label: "Generate UPDATE", icon: "code", onClick: () => generate(n, "update") },
          { sep: true },
          ...(caps()?.ddl !== false || caps()?.relationships !== false
            ? [{ label: "DDL & relationships…", icon: "fileCode" as const, onClick: () => setDdlGraph({ schema: s!, name: n.name, kind: "table" }) }]
            : []),
          ...copyDdl,
          copyName,
          copyQual,
        );
        break;
      case "view":
      case "matview": {
        const kw = n.kind;
        items.push(
          { label: "Select all rows", icon: "play", onClick: () => runTable(s!, n.name) },
          { label: "Filter rows…", icon: "search", onClick: () => filterTable(s!, n.name) },
        );
        if (kw === "matview")
          items.push(
            { label: "Refresh", icon: "refresh", ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), onClick: () => runDDLToast(ddl.refreshMatview(s!, n.name, false)) },
            { label: "Refresh concurrently", icon: "refresh", ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), onClick: () => runDDLToast(ddl.refreshMatview(s!, n.name, true)) },
          );
        items.push(
          { sep: true },
          { label: "Rename…", icon: "edit", ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), onClick: () => setActiveDialog({ kind: "rename", title: `Rename ${n.name}`, current: n.name, build: (nn) => ddl.renameRelation(kw, s!, n.name, nn) }) },
          { label: "Edit comment…", icon: "comment", ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), onClick: () => setActiveDialog({ kind: "comment", title: `Comment on ${n.name}`, current: n.detail?.comment ?? "", build: (t) => ddl.comment(`${kw === "matview" ? "MATERIALIZED VIEW" : "VIEW"} ${qual}`, t) }) },
          { label: "Drop…", icon: "trash", danger: true, ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), onClick: () => setActiveDialog({ kind: "confirm", title: `Drop ${n.name}`, primaryLabel: "Drop", showCascade: true, build: (o) => ddl.dropRelation(kw, s!, n.name, o.cascade) }) },
          { sep: true },
          ...(caps()?.ddl !== false || caps()?.relationships !== false
            ? [{ label: "DDL & relationships…", icon: "fileCode" as const, onClick: () => setDdlGraph({ schema: s!, name: n.name, kind: kw }) }]
            : []),
          ...copyDdl,
          copyName,
          copyQual,
        );
        break;
      }
      case "column": {
        const c = n.column!;
        items.push(
          { label: "Edit column…", icon: "edit", ...gate(ownsTable(s!, n.table!), `Requires ownership of ${n.table}`), onClick: () => setActiveDialog({ kind: "editColumn", ctx: n }) },
          { label: "Rename…", icon: "edit", ...gate(ownsTable(s!, n.table!), `Requires ownership of ${n.table}`), onClick: () => setActiveDialog({ kind: "rename", title: `Rename column ${n.name}`, current: n.name, build: (nn) => ddl.renameColumn(s!, n.table!, n.name, nn) }) },
          { label: "Edit comment…", icon: "comment", ...gate(ownsTable(s!, n.table!), `Requires ownership of ${n.table}`), onClick: () => setActiveDialog({ kind: "comment", title: `Comment on ${n.name}`, current: c.comment ?? "", build: (t) => ddl.comment(`COLUMN ${qualify(s!, n.table!)}.${ident(n.name)}`, t) }) },
          { sep: true },
          { label: "Drop column…", icon: "trash", danger: true, ...gate(ownsTable(s!, n.table!), `Requires ownership of ${n.table}`), onClick: () => setActiveDialog({ kind: "confirm", title: `Drop column ${n.name}`, primaryLabel: "Drop column", showCascade: true, build: (o) => ddl.dropColumn(s!, n.table!, n.name, o.cascade) }) },
          { sep: true },
          copyName,
        );
        break;
      }
      case "schema":
        items.push(
          ...(caps()?.relationships !== false
            ? [{ label: "Schema diagram…", icon: "link" as const, onClick: () => setDdlGraph({ schema: n.name, name: null, kind: "table" }) }, { sep: true as const }]
            : []),
          { label: "Create table…", icon: "plus", ...gate(canCreateInSchema(n.name), `Requires CREATE on schema ${n.name}`), onClick: () => setActiveDialog({ kind: "createTable", schema: n.name }) },
          { label: "Rename…", icon: "edit", ...gate(ownsSchema(n.name), `Requires ownership of schema ${n.name}`), onClick: () => setActiveDialog({ kind: "rename", title: `Rename schema ${n.name}`, current: n.name, build: (nn) => ddl.renameSchema(n.name, nn) }) },
          { sep: true },
          { label: "Drop…", icon: "trash", danger: true, ...gate(ownsSchema(n.name), `Requires ownership of schema ${n.name}`), onClick: () => setActiveDialog({ kind: "confirm", title: `Drop schema ${n.name}`, primaryLabel: "Drop schema", showCascade: true, build: (o) => ddl.dropSchema(n.name, o.cascade) }) },
          { sep: true },
          copyName,
        );
        break;
      case "database": {
        const cur = tree()?.database === n.name;
        items.push(
          { label: "Create schema…", icon: "plus", ...gate(canCreateSchema(), "Requires CREATE on the database"), onClick: () => setActiveDialog({ kind: "createSchema" }) },
          { label: cur ? "Drop… (connected)" : "Drop…", icon: "trash", danger: true, disabled: cur || conn()?.readOnly || (pEnforced() && !isSuper()), title: cur ? "Can't drop the connected database" : (pEnforced() && !isSuper()) ? "Requires database ownership (or superuser)" : undefined, onClick: () => setActiveDialog({ kind: "confirm", title: `Drop database ${n.name}`, primaryLabel: "Drop database", build: () => ddl.dropDatabase(n.name) }) },
          { sep: true },
          copyName,
        );
        break;
      }
      case "index":
        items.push(
          { label: "Rename…", icon: "edit", ...gate(true, ""), ...noDuck("DuckDB can't rename an index"), onClick: () => setActiveDialog({ kind: "rename", title: `Rename index ${n.name}`, current: n.name, build: (nn) => ddl.renameIndex(s!, n.name, nn) }) },
          { label: "Drop…", icon: "trash", danger: true, ...gate(true, ""), onClick: () => setActiveDialog({ kind: "confirm", title: `Drop index ${n.name}`, primaryLabel: "Drop index", showCascade: true, build: (o) => ddl.dropIndex(s!, n.name, o.cascade) }) },
          { sep: true },
          copyName,
        );
        break;
      case "constraint":
        items.push(
          { label: "Rename…", icon: "edit", ...gate(true, ""), ...noDuck("DuckDB can't rename a constraint"), onClick: () => setActiveDialog({ kind: "rename", title: `Rename constraint ${n.name}`, current: n.name, build: (nn) => ddl.renameConstraint(s!, n.table!, n.name, nn) }) },
          { label: "Drop…", icon: "trash", danger: true, ...gate(true, ""), ...noDuck("DuckDB can't drop a constraint via ALTER"), onClick: () => setActiveDialog({ kind: "confirm", title: `Drop constraint ${n.name}`, primaryLabel: "Drop constraint", showCascade: true, build: (o) => ddl.dropConstraint(s!, n.table!, n.name, o.cascade) }) },
          { sep: true },
          copyName,
        );
        break;
      case "sequence":
        items.push(
          { label: "Restart… (edit value)", icon: "refresh", ...gate(true, ""), ...noDuck("DuckDB can't restart a sequence via ALTER"), onClick: () => editAsSql(ddl.alterSequenceRestart(s!, n.name, "1")) },
          { label: "Rename…", icon: "edit", ...gate(true, ""), ...noDuck("DuckDB can't rename a sequence"), onClick: () => setActiveDialog({ kind: "rename", title: `Rename sequence ${n.name}`, current: n.name, build: (nn) => ddl.renameSequence(s!, n.name, nn) }) },
          { label: "Drop…", icon: "trash", danger: true, ...gate(true, ""), onClick: () => setActiveDialog({ kind: "confirm", title: `Drop sequence ${n.name}`, primaryLabel: "Drop sequence", showCascade: true, build: (o) => ddl.dropSequence(s!, n.name, o.cascade) }) },
          { sep: true },
          ...copyDdl,
          copyName,
        );
        break;
      case "function":
        items.push(
          { label: "Drop…", icon: "trash", danger: true, ...gate(true, ""), onClick: () => setActiveDialog({ kind: "confirm", title: `Drop function ${n.name}`, primaryLabel: "Drop function", showCascade: true, build: (o) => ddl.dropFunction(s!, n.name, o.cascade) }) },
          { sep: true },
          ...copyDdl,
          copyName,
        );
        break;
      case "trigger": {
        // The trigger def rides along on the node (pg_get_triggerdef) — no backend roundtrip.
        const def = n.trigger?.def ?? "";
        items.push(
          { label: "Copy DDL", icon: "fileCode", onClick: () => copyText(def.endsWith(";") ? def : def + ";", "copied DDL") },
          { label: "Copy DDL → editor", icon: "fileCode", onClick: () => editAsSql(def) },
          { label: "Drop…", icon: "trash", danger: true, ...gate(true, ""), onClick: () => setActiveDialog({ kind: "confirm", title: `Drop trigger ${n.name}`, primaryLabel: "Drop trigger", showCascade: true, build: (o) => ddl.dropTrigger(s!, n.table!, n.name, o.cascade) }) },
          { sep: true },
          copyName,
        );
        break;
      }
      default:
        items.push(copyName);
        if (s) items.push(copyQual);
    }
    return items;
  }

  // (Result-grid cell/header menus + copy now live in ResultGrid.tsx.)

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
        { label: "Cut", icon: "scissors", disabled: !hasSel, onClick: async () => { const s = api.getSelection(); if (await clipWrite(s)) api.replaceSelection(""); } },
        { label: "Copy", icon: "copy", disabled: !hasSel, onClick: () => copyText(api.getSelection(), "copied selection") },
        { label: "Paste", icon: "download", onClick: async () => { const t = await clipRead(); if (t != null) api.replaceSelection(t); else setRunErr("clipboard read blocked — use ⌘/Ctrl+V"); } },
        { sep: true },
        { label: "Select all", icon: "table", onClick: () => api.selectAll() },
        { label: "Toggle comment", icon: "slash", onClick: () => api.toggleComment() },
        { sep: true },
        { label: hasSel ? "Run selection" : "Run all", icon: "play", onClick: () => runText(hasSel ? api.getRunText() : api.getDoc()) },
      ],
    });
  }

  const explainMenuItems = (): MenuItem[] => [
    { label: "Explain", icon: "eye", onClick: () => runAction("explain") },
    {
      label: "Explain Analyze (runs the query)",
      icon: "play",
      disabled: caps()?.explainAnalyze === false,
      title: caps()?.explainAnalyze === false ? "Not supported by this engine" : undefined,
      onClick: () => runAction("explainAnalyze"),
    },
  ];
  /** Narrow-toolbar ⋯ menu: the text actions that container queries hide. */
  function openToolbarOverflow(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        { label: "Open…", icon: "fileCode", onClick: openFileDialog },
        { label: "Save", icon: "download", onClick: () => void saveActiveTab() },
        { label: "Save As…", icon: "download", onClick: () => void saveAsActiveTab() },
        { sep: true },
        { label: "Format", icon: "edit", onClick: () => editorApi()?.format() },
        { label: "Find", icon: "search", onClick: () => editorApi()?.openSearch() },
        { sep: true },
        ...explainMenuItems(),
      ],
    });
  }

  // --- connect-screen profile menu ---
  function connString(p: Profile) {
    if (isEmbeddedDriver(p.driver)) return p.path || ":memory:";
    const scheme = p.driver === "mysql" ? "mysql" : "postgresql";
    const base = `${scheme}://${p.user}@${p.host}:${p.port}/${p.dbname}`;
    return p.sslmode && p.sslmode !== "prefer" ? `${base}?sslmode=${p.sslmode}` : base;
  }
  async function duplicateProfile(p: Profile) {
    try {
      await invoke("save_profile", {
        profile: { id: "", name: `${p.name} copy`, host: p.host, port: p.port, user: p.user, dbname: p.dbname, save_password: false, sslmode: p.sslmode, read_only: p.read_only, default_connect: false, driver: p.driver ?? "postgres", path: p.path ?? null },
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
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "New…", icon: "plus", ...gate(true, ""), onClick: () => openPlusMenu(e) },
        { sep: true },
        { label: "Refresh", icon: "refresh", onClick: () => loadSchema() },
        { label: "Clear filter", icon: "eraser", disabled: !treeFilter(), onClick: () => setTreeFilter("") },
      ],
    });
  }

  function openProfileMenu(e: MouseEvent, p: Profile) {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Connect", icon: "play", onClick: () => connectProfile(p.id) },
        { label: "Edit", icon: "edit", onClick: () => editProfile(p) },
        { label: "Duplicate", icon: "duplicate", onClick: () => duplicateProfile(p) },
        { label: p.default_connect ? "Unset default" : "Set as default", icon: "star", onClick: () => setProfileDefault(p, !p.default_connect) },
        { sep: true },
        { label: "Copy connection string", icon: "copy", onClick: () => copyText(connString(p), "copied connection string") },
        { sep: true },
        { label: "Delete", icon: "trash", danger: true, onClick: () => deleteProfile(p.id) },
      ],
    });
  }

  // Persist all docked-panel sizes (called on resize-end, not per frame).
  const persistLayout = () =>
    layoutStore.save({
      sidebarW: sidebarW(), aiW: aiW(), historyW: historyW(), editorH: editorH(),
      sidebarOpen: sidebarOpen(), resultsOpen: resultsOpen(),
    });

  // Hard safety bounds: no side panel may grow past the point where the editor/main
  // column disappears, and the editor↔results split always leaves the results pane
  // reachable. Re-applied on window resize, so shrinking the window can never leave
  // a panel covering everything (a size saved on a big monitor stays harmless).
  const maxSidebarW = () => Math.max(180, Math.min(560, window.innerWidth - 420));
  const maxSideDockW = (cap: number) => Math.max(240, Math.min(cap, window.innerWidth - 480));
  const maxEditorH = () => Math.max(80, window.innerHeight - 160);
  function clampPanels() {
    setSidebarW(Math.min(sidebarW(), maxSidebarW()));
    setAiW(Math.min(aiW(), maxSideDockW(760)));
    setHistoryW(Math.min(historyW(), maxSideDockW(700)));
    setEditorH(Math.min(editorH(), maxEditorH()));
  }

  function toggleSidebar() {
    setSidebarOpen((v) => !v);
    persistLayout();
  }
  function toggleResults() {
    setResultsOpen((v) => !v);
    persistLayout();
  }

  // Horizontal panel resize. `dir` = +1 for a LEFT-docked panel (the splitter sits on
  // its right edge, so dragging right grows it), -1 for a RIGHT-docked panel (splitter
  // on its left edge, dragging left grows it).
  function startResizeH(
    e: MouseEvent,
    getW: () => number,
    setW: (n: number) => void,
    dir: 1 | -1,
    min: number,
    max: number,
  ) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = getW();
    const onMove = (ev: MouseEvent) =>
      setW(Math.max(min, Math.min(startW + dir * (ev.clientX - startX), max)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      persistLayout();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
  }
  const startResizeSidebar = (e: MouseEvent) => startResizeH(e, sidebarW, setSidebarW, 1, 180, maxSidebarW());
  const startResizeAi = (e: MouseEvent) => startResizeH(e, aiW, setAiW, -1, 280, maxSideDockW(760));
  const startResizeHistory = (e: MouseEvent) => startResizeH(e, historyW, setHistoryW, -1, 240, maxSideDockW(700));

  return (
    <>
    <Show
      when={conn()}
      fallback={
        <div class="connect-screen">
          <div class="connect-utils">
            <button class="icon" title="Manual (F1)" onClick={() => setHelpOpen(true)}><Icon name="help" /></button>
            <button class="icon" title="Settings" onClick={() => setSettingsOpen("editor")}><Icon name="gear" /></button>
          </div>
          <div class="connect-layout">
            <div class="profiles-panel">
              <div class="panel-title">Connections</div>
              <div class="profiles-list">
                <For each={profiles()}>
                  {(p) => (
                    <div class="profile-row" classList={{ active: editingId() === p.id }} onContextMenu={(e) => openProfileMenu(e, p)}>
                      <div class="profile-main" onClick={() => useProfile(p)}>
                        <span class="profile-avatar">{driverMascot(p.driver)}</span>
                        <div class="profile-text">
                          <div class="profile-name">
                            <span class="profile-name-text">{p.name || (isEmbeddedDriver(p.driver) ? basename(p.path || ":memory:") : p.host)}</span>
                            <Show when={p.default_connect}><span class="profile-star" title="Connects on startup"><Icon name="star" /></span></Show>
                            <Show when={p.read_only}><span class="chip-ro" title="Read-only connection">RO</span></Show>
                          </div>
                          <div class="profile-sub">
                            <span>{isEmbeddedDriver(p.driver) ? (p.path || ":memory:") : `${p.user}@${p.host}:${p.port}/${p.dbname}`}</span>
                            <Show when={p.save_password}><Icon name="lock" /></Show>
                          </div>
                        </div>
                        <span class="profile-go"><Icon name="play" /></span>
                      </div>
                      <button class="icon" title="Edit" onClick={() => editProfile(p)}><Icon name="edit" /></button>
                      <button class="icon" title="Delete" onClick={() => deleteProfile(p.id)}><Icon name="trash" /></button>
                    </div>
                  )}
                </For>
                <Show when={profiles().length === 0}>
                  <div class="profiles-empty">
                    <span class="profiles-empty-mark">🐘</span>
                    <div>No saved connections yet.</div>
                    <div class="profiles-empty-sub">Fill the form and hit <b>Save</b> — or just <b>Connect</b> without saving.</div>
                  </div>
                </Show>
              </div>
              <button class="ghost full" onClick={newProfile}>＋ New connection</button>
              <div class="connect-foot">Right-click a connection for more · <kbd class="kb-kbd">F1</kbd> manual</div>
            </div>

            <form class="connect-card" onSubmit={doConnect}>
              <div class="brand-row">
                <span class="brand-mark">{driverMascot(driver())}</span>
                <div>
                  <div class="brand">Tusk</div>
                  <div class="subtitle">{editingId() ? "Edit connection" : "New connection"}</div>
                </div>
              </div>
              <label>Name<input value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="My database" /></label>
              <label>Driver
                <div class="driver-tiles" role="radiogroup" aria-label="Driver">
                  <For each={DRIVERS}>
                    {(d) => (
                      <button
                        type="button"
                        class="driver-tile"
                        role="radio"
                        aria-checked={driver() === d.id}
                        classList={{ active: driver() === d.id }}
                        disabled={!d.ready}
                        title={d.ready ? d.label : `${d.label} (soon)`}
                        onClick={() => {
                          setDriver(d.id);
                          if (d.id === "mysql" && port() === 5432) setPort(3306);
                          if (d.id === "postgres" && port() === 3306) setPort(5432);
                          if (d.id === "mysql" && dbname() === "postgres") setDbname("");
                          if (d.id === "postgres" && dbname() === "") setDbname("postgres");
                        }}
                      >
                        <span class="dt-mascot">{d.mascot}</span>
                        <span class="dt-label">{d.label}</span>
                      </button>
                    )}
                  </For>
                </div>
              </label>
              <Show
                when={driver() === "duckdb" || driver() === "sqlite"}
                fallback={
                  <>
                    <div class="field-row host-port">
                      <label>Host<input value={host()} onInput={(e) => setHost(e.currentTarget.value)} /></label>
                      <label>Port<input type="number" value={port()} onInput={(e) => setPort(Number(e.currentTarget.value))} /></label>
                    </div>
                    <label>User<input value={user()} onInput={(e) => setUser(e.currentTarget.value)} placeholder={driver() === "mysql" ? "root" : "postgres"} /></label>
                    <label>Password<input type="password" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} placeholder={editingId() && savePassword() ? "•••••• (stored)" : ""} /></label>
                    <div class="field-row halves">
                      <label>Database<input value={dbname()} onInput={(e) => setDbname(e.currentTarget.value)} placeholder={driver() === "mysql" ? "(optional)" : "postgres"} /></label>
                      <label>SSL Mode
                        <select value={sslmode()} onChange={(e) => setSslmode(e.currentTarget.value)}>
                          <option value="disable">disable</option>
                          <option value="prefer">prefer</option>
                          <option value="require">require</option>
                          <option value="verify-full">verify-full</option>
                        </select>
                      </label>
                    </div>
                  </>
                }
              >
                <label>Database file
                  <div class="file-row">
                    <input value={path()} onInput={(e) => setPath(e.currentTarget.value)} placeholder={`/path/to/db.${driver() === "sqlite" ? "sqlite" : "duckdb"} — blank = in-memory`} />
                    <button type="button" class="ghost" onClick={browseDbFile}>Browse…</button>
                  </div>
                </label>
                <div class="empty-hint">Leave blank for a scratch in-memory database.</div>
              </Show>
              <label class="checkbox"><input type="checkbox" checked={readOnly()} onChange={(e) => setReadOnly(e.currentTarget.checked)} />Read-only (block writes &amp; DDL)</label>
              <Show when={!isEmbeddedDriver(driver())}>
                <label class="checkbox"><input type="checkbox" checked={savePassword()} onChange={(e) => setSavePassword(e.currentTarget.checked)} />Save password</label>
              </Show>
              <label class="checkbox"><input type="checkbox" checked={defaultConnect()} onChange={(e) => setDefaultConnect(e.currentTarget.checked)} />Connect on startup</label>
              <div class="form-actions">
                <button type="button" class="ghost" onClick={saveProfile}>Save</button>
                <button type="submit" disabled={connecting()}>{connecting() ? <><span class="spinner-sm" />Connecting…</> : "Connect"}</button>
              </div>
              <Show when={connErr()}><div class="error">{connErr()}</div></Show>
            </form>
          </div>
        </div>
      }
    >
      <div class="workspace">
        <header class="topbar">
          <span class="brand-sm">{driverMascot(caps()?.kind)} Tusk</span>
          <span class="conn-chip" title={connTarget()}>
            <span class="conn-dot" />
            <span class="conn-name">{connTarget()}</span>
          </span>
          <span class="meta">{driverLabel(caps()?.kind)} {conn()!.version}</span>
          <Show when={conn()!.readOnly}>
            <span class="badge badge-ro" title="Writes & DDL are blocked"><Icon name="lock" /> Read-only</span>
          </Show>
          <span class="spacer" />
          <button class="icon" classList={{ active: sidebarOpen() }} title={`${sidebarOpen() ? "Hide" : "Show"} explorer (${displayKey(effectiveKey("toggleSidebar", keys()))})`} onClick={toggleSidebar}><Icon name="panelLeft" /></button>
          <button class="icon" classList={{ active: resultsOpen() }} title={`${resultsOpen() ? "Hide" : "Show"} results (${displayKey(effectiveKey("toggleResults", keys()))})`} onClick={toggleResults}><Icon name="panelBottom" /></button>
          <span class="topbar-sep" />
          <button class="ghost" classList={{ active: aiOpen() }} onClick={() => setAiOpen((v) => !v)} title="AI assistant"><Icon name="sparkle" /> AI</button>
          <button class="icon" classList={{ active: historyOpen() }} title="Query history" onClick={() => setHistoryOpen((v) => !v)}><Icon name="clock" /></button>
          <button class="icon" classList={{ active: helpOpen() }} title="Manual" onClick={() => setHelpOpen(true)}><Icon name="help" /></button>
          <button class="icon" title="Settings" onClick={() => setSettingsOpen("editor")}><Icon name="gear" /></button>
          <button class="ghost" onClick={disconnect}>Disconnect</button>
        </header>

        <div class="body">
          <Show when={sidebarOpen()}>
          <aside class="sidebar" style={{ width: `${sidebarW()}px` }}>
            <div class="sidebar-head">
              <span class="panel-title2">Explorer</span>
              <div class="head-actions">
                <button class="icon" title="New… (based on selection)" onClick={(e) => openPlusMenu(e)}><Icon name="plus" /></button>
                <Show when={caps()?.bulkCopy !== false}>
                  <button class="icon" title="Import data" onClick={openImport}><Icon name="download" /></button>
                </Show>
                <button class="icon" title="Refresh" disabled={schemaLoading()} onClick={() => loadSchema()}>{schemaLoading() ? <span class="spinner-sm" /> : <Icon name="refresh" />}</button>
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
          </Show>

          <main class="main">
            <div class="editor-pane" classList={{ full: !resultsOpen() }} style={resultsOpen() ? { height: `${editorH()}px` } : undefined}>
              <div
                class="tab-strip"
                onWheel={(e) => {
                  // Vertical wheel scrolls the horizontal strip when it overflows.
                  const el = e.currentTarget;
                  if (el.scrollWidth <= el.clientWidth) return;
                  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                    el.scrollLeft += e.deltaY;
                    e.preventDefault();
                  }
                }}
              >
                <For each={tabs()}>
                  {(t) => (
                    <div
                      class="tab"
                      classList={{ active: t.id === activeTabId() }}
                      title={t.filePath ?? t.title}
                      draggable={true}
                      onDragStart={() => (dragTabId = t.id)}
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (!dragTabId || dragTabId === t.id) return;
                        const rect = e.currentTarget.getBoundingClientRect();
                        const before = e.clientX < rect.left + rect.width / 2;
                        moveTabTo(dragTabId, t.id, before);
                      }}
                      onDragEnd={() => (dragTabId = null)}
                      onClick={() => switchTab(t.id)}
                      onAuxClick={(e) => { if (e.button === 1) closeTab(t.id); }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({
                          x: e.clientX,
                          y: e.clientY,
                          items: [
                            { label: "Rename…", icon: "edit", onClick: () => setRenameTab({ id: t.id, title: t.title }) },
                            { sep: true },
                            { label: "Close", icon: "close", onClick: () => closeTab(t.id) },
                            { label: "Close others", icon: "close", onClick: () => closeTabsWhere((x) => x.id !== t.id) },
                            { label: "Close tabs to the right", icon: "close", onClick: () => closeTabsWhere((_x, i, arr) => i > arr.findIndex((y) => y.id === t.id)) },
                          ],
                        });
                      }}
                    >
                      <span class="tab-title">{t.title}</span>
                      <Show when={running() && runningTabId() === t.id}><span class="spinner-sm tab-spin" title="Query running" /></Show>
                      <Show when={t.dirty}><span class="tab-dot" title="Unsaved changes">●</span></Show>
                      <button class="tab-close" title="Close (⌘/Ctrl+W)" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>×</button>
                    </div>
                  )}
                </For>
                <button class="tab-new" title="New tab (⌘/Ctrl+T)" onClick={openNewTab}>＋</button>
              </div>
              <div class="toolbar">
                <button
                  ref={(el) => (runBtnRef = el)}
                  class="run"
                  classList={{ cancel: running() }}
                  onClick={() => (running() ? cancelQuery() : doRun())}
                  disabled={cancelling()}
                  title={running() ? "Cancel running query" : "Run selection or all"}
                >
                  {running()
                    ? (cancelling() ? <><span class="spinner-sm" />Cancelling…</> : <>✕ Cancel {fmtDur(runMs())}</>)
                    : "Run ▶"}
                </button>
                <button class="ghost tb-text" onClick={openFileDialog}>Open</button>
                <button class="ghost tb-text" onClick={() => void saveActiveTab()}>Save</button>
                <button class="ghost tb-text" onClick={() => void saveAsActiveTab()}>Save As</button>
                <button class="ghost tb-text" onClick={() => editorApi()?.format()}>Format</button>
                <button class="ghost tb-text" onClick={() => editorApi()?.openSearch()}>Find</button>
                <button
                  class="ghost tb-text"
                  title="Visualize the query plan for the current statement"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu({ x: r.left, y: r.bottom + 4, items: explainMenuItems() });
                  }}
                >
                  Explain ▾
                </button>
                <button class="ghost tb-more" title="More actions" onClick={openToolbarOverflow}>⋯</button>
                <span class="hint">{displayKey(effectiveKey("run", keys())) || "unbound"} · runs selection or all</span>
                <span class="spacer" />
                <Show when={caps()?.searchPath !== false}>
                  <select
                    class="export-select"
                    title="Active schema (search_path)"
                    value={activeTab().searchSchema ?? ""}
                    onChange={(e) => patchTab(activeTabId(), { searchSchema: e.currentTarget.value || null })}
                  >
                    <option value="">(default schema)</option>
                    <For each={schemaNames()}>{(s) => <option value={s}>{s}</option>}</For>
                  </select>
                </Show>
                <button class="icon font-btn" title="Decrease font size" onClick={() => updatePrefs({ fontSize: Math.max(9, prefs().fontSize - 1) })}><span class="az-sm">A</span></button>
                <button class="icon font-btn" title="Increase font size" onClick={() => updatePrefs({ fontSize: Math.min(24, prefs().fontSize + 1) })}><span class="az-lg">A</span></button>
                <button class="icon font-btn" title="Toggle word wrap" classList={{ active: prefs().wordWrap }} onClick={() => updatePrefs({ wordWrap: !prefs().wordWrap })}><Icon name="wrap" /></button>
              </div>
              <SqlEditor
                value={sql()}
                onChange={(t, id) => patchTab(id, { sql: t, dirty: true })}
                onRun={() => doRun()}
                onRunStatement={(t) => doRun(t)}
                running={running() && runningTabId() === activeTabId()}
                tabId={activeTabId()}
                tables={schema()}
                functions={funcs()}
                fkEdges={fkEdges()}
                activeSchema={activeTab().searchSchema}
                dialect={activeDialect()}
                prefs={{ ...prefs(), theme: resolvedTheme() }}
                keys={keys()}
                validate={conn() ? validate : null}
                onCursorInfo={setCursorInfo}
                onReady={setEditorApi}
                onContextMenu={openEditorMenu}
              />
            </div>

            <Show when={resultsOpen()}>
            <div class="splitter" onMouseDown={startResize} />

            <div class="result">
              <Show when={columns().length > 0 || planMemo() || !done() || pendingCount(tabPending()) > 0}>
                <div class="result-toolbar">
                  <Show when={planMemo()}>
                    <div class="result-viewtoggle">
                      <button classList={{ active: resultView() === "plan" }} onClick={() => patchTab(activeTabId(), { resultView: "plan" })}>Plan</button>
                      <button classList={{ active: resultView() === "grid" }} onClick={() => patchTab(activeTabId(), { resultView: "grid" })}>Grid</button>
                    </div>
                  </Show>
                  <span class="spacer" />
                  <Show when={!done()}>
                    <button class="ghost export-btn" onClick={loadAll}>{loadingAll() ? <><span class="spinner-sm" />Cancel</> : "Load all"}</button>
                    <span class="streaming" classList={{ idle: !(fetchingMore() || loadingAll()) }}>
                      <Show when={fetchingMore() || loadingAll()} fallback={<><span class="stream-dot" />idle</>}>
                        <span class="spinner-sm" />streaming…
                      </Show>
                    </span>
                    <span class="sb-sep" />
                  </Show>
                  <Show when={editCtx().editable || pendingCount(tabPending()) > 0}>
                    <Show when={pendingCount(tabPending()) > 0}>
                      <span class="sb-pending" title="Uncommitted in-grid changes">✎ {pendingCount(tabPending())} change{pendingCount(tabPending()) === 1 ? "" : "s"}</span>
                      <button class="ghost export-btn sb-commit" onClick={openCommit} disabled={!editCtx().editable || running()} title={editCtx().editable ? "Preview & run the change script" : editCtx().reason}>Commit…</button>
                      <button class="ghost export-btn" onClick={discardPending}>Discard</button>
                    </Show>
                    <Show when={editCtx().editable}>
                      <button class="ghost export-btn" title="Add a new row (committed as INSERT)" onClick={onAddRow}>+ Row</button>
                    </Show>
                    <span class="sb-sep" />
                  </Show>
                  <Show when={columns().length > 0}>
                    <label class="checkbox sb-copyhdr" title="Include column names as a header row when copying from the results grid (default: off)">
                      <input type="checkbox" checked={prefs().copyHeaders} onChange={(e) => updatePrefs({ copyHeaders: e.currentTarget.checked })} />
                      Copy w/ column names
                    </label>
                  </Show>
                  <Show when={(lastQuery() || columns().length > 0) && caps()?.export !== false}>
                    <span class="sb-sep" />
                    <button class="ghost export-btn" onClick={openExport}>Export…</button>
                  </Show>
                  <span class="sb-sep" />
                  <span class="status-elapsed"><Icon name="clock" /> {elapsed()} ms</span>
                </div>
              </Show>
              <Show when={runErr()}><div class="error result-error">{runErr()}</div></Show>
              <Show when={planMemo() && resultView() === "plan"}>
                <PlanView
                  plan={() => planMemo()!}
                  prefs={prefs}
                  fitKey={() => `${activeTabId()}:${activeTab().result.epoch}`}
                />
              </Show>
              <Show when={!(planMemo() && resultView() === "plan") && columns().length > 0} fallback={
                <Show when={!planMemo() && columns().length === 0}><div class="result-empty">{status() || "no results"}</div></Show>
              }>
                <ResultGrid
                  columns={columns}
                  rows={rows}
                  done={done}
                  view={gridView}
                  setView={setGridView}
                  activeTabId={activeTabId}
                  epoch={() => activeTab().result.epoch}
                  onLoadMore={loadMore}
                  onSortFilter={onSortFilter}
                  onMenu={(x, y, items) => setMenu({ x, y, items })}
                  onViewValue={(col, val) => setCellView({ col, val })}
                  onStatus={setStatus}
                  canSortFilter={canSortFilter}
                  editable={() => editCtx().editable}
                  editReason={() => editCtx().reason}
                  canEditCol={(oi) => editCtx().plan?.isTableCol[oi] ?? false}
                  isBoolCol={(oi) => boolCols().has(oi)}
                  boolEdit={boolEditInfo}
                  pending={tabPending}
                  onEditCell={onEditCell}
                  onMarkDelete={onMarkDelete}
                  onAddRow={onAddRow}
                  onPaste={onPaste}
                  copyHeaders={() => prefs().copyHeaders}
                  gridStyle={() => ({
                    rowH: prefs().gridDensity === "compact" ? 22 : 28,
                    font: `12px ${fontStack(prefs().fontFamily)}`,
                    zebra: prefs().gridZebra,
                    nullStyle: prefs().gridNullStyle,
                    defaultColW: prefs().gridColWidth,
                  })}
                />
              </Show>
              <Show when={running()}>
                <div class="result-spinner"><div class="spinner" /></div>
              </Show>
            </div>
            </Show>

            <footer class="statusbar">
              <span>{status()}</span>
              <Show when={slackStatus().state !== "disconnected"}>
                <span
                  class="slack-badge"
                  title={slackStatus().error ? `Slack: ${slackStatus().state} — ${slackStatus().error}` : `Slack bot ${slackStatus().state}`}
                >
                  {slackStatus().state === "connected" ? "🟢" : "🟡"} Slack
                </span>
              </Show>
              <span class="spacer" />
              <Show when={cursorInfo()}>
                {(ci) => (
                  <span class="cursor-info">
                    Ln {ci().line}, Col {ci().col}
                    <Show when={ci().stmtCount > 1}> · Stmt {ci().stmtIndex}/{ci().stmtCount}</Show>
                    <Show when={ci().selChars > 0}> · {ci().selChars} sel</Show>
                  </span>
                )}
              </Show>
            </footer>
          </main>
          <Show when={aiOpen()}>
            <div class="splitter-v" onMouseDown={startResizeAi} />
            <AiPanel
              ctx={aiContext}
              sampleRows={aiSampleRows}
              ensureFks={ensureAiFks}
              onOpenSettings={() => setSettingsOpen("ai")}
              width={aiW()}
              onInsertSql={(sql) => openGeneratedTab(sql, activeTab().searchSchema, "AI query")}
              onClose={() => setAiOpen(false)}
            />
          </Show>
          <Show when={historyOpen()}>
            <div class="splitter-v" onMouseDown={startResizeHistory} />
            <HistoryPanel
              entries={history}
              width={historyW()}
              onInsert={(sql) => editorApi()?.insertAtCursor(sql)}
              onOpenTab={(sql, schema) => openGeneratedTab(sql, schema, "History")}
              onRerun={(sql) => runText(sql)}
              onClear={() => { if (connKey) { historyStore.clear(connKey); setHistory([]); } }}
              onClose={() => setHistoryOpen(false)}
            />
          </Show>
        </div>

        <Show when={paletteOpen()}>
          <CommandPalette keys={keys()} ctx={actionCtx()} onRun={runAction} onClose={() => setPaletteOpen(false)} />
        </Show>

        <Show when={ddlGraph()}>
          {(g) => (
            <DdlGraphDialog
              connectionId={conn()!.id}
              schema={g().schema}
              name={g().name}
              kind={g().kind}
              onOpenSql={(sql) => { setDdlGraph(null); openGeneratedTab(sql, g().schema, g().name ?? undefined); }}
              onCopy={copyText}
              onClose={() => setDdlGraph(null)}
            />
          )}
        </Show>

        <Show when={paramPrompt()}>
          {(pp) => (
            <ParamDialog
              sql={pp().text}
              params={pp().params}
              initial={activeTab().paramValues}
              onRun={(values: Record<string, ParamValue>, substituted: string) => {
                patchTab(activeTabId(), { paramValues: { ...activeTab().paramValues, ...values } });
                setParamPrompt(null);
                runTextNow(substituted);
              }}
              onClose={() => setParamPrompt(null)}
            />
          )}
        </Show>

        <Show when={renameTab()}>
          {(rt) => (
            <Dialog title="Rename tab" width={380} onClose={() => setRenameTab(null)}>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const title = rt().title.trim();
                  if (title) patchTab(rt().id, { title });
                  setRenameTab(null);
                }}
              >
                <label>
                  Title
                  <input
                    value={rt().title}
                    ref={(el) => setTimeout(() => { el.focus(); el.select(); })}
                    onInput={(e) => setRenameTab({ id: rt().id, title: e.currentTarget.value })}
                  />
                </label>
                <div class="form-actions">
                  <button type="button" class="ghost" onClick={() => setRenameTab(null)}>Cancel</button>
                  <button type="submit" class="run">Rename</button>
                </div>
              </form>
            </Dialog>
          )}
        </Show>

        <Show when={confirmAnalyze()}>
          <Dialog title="Explain Analyze" width={440} onClose={() => setConfirmAnalyze(null)}>
            <div class="confirm-note">
              EXPLAIN ANALYZE <b>executes</b> the statement to measure it — and this statement modifies data. Run it?
            </div>
            <div class="form-actions">
              <button class="ghost" onClick={() => setConfirmAnalyze(null)}>Cancel</button>
              <button class="btn-danger" onClick={() => { const w = confirmAnalyze()!; setConfirmAnalyze(null); void executeQuery(w, "", "base"); }}>
                Run it
              </button>
            </div>
          </Dialog>
        </Show>

        <Show when={importOpen()}>
          <div class="modal-overlay" onClick={() => !importBusy() && setImportOpen(false)}>
            <div class="modal" onClick={(e) => e.stopPropagation()}>
              <div class="modal-head">Import data<span class="spacer" /><button class="icon modal-x" disabled={importBusy()} onClick={() => setImportOpen(false)}><Icon name="close" /></button></div>
              {/* All configuration controls disable while an import is running. */}
              <fieldset class="import-fieldset" disabled={importBusy()}>
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
                    </>
                  )}
                </Show>
              </fieldset>
              <Show when={importData()}>
                <Show
                  when={importBusy()}
                  fallback={<button class="run full" onClick={doImport}>Import</button>}
                >
                  <div class="import-busy"><span class="spinner-sm" />Importing…</div>
                  <button class="ghost full" onClick={() => void cancelOperation()}>Cancel &amp; roll back</button>
                </Show>
              </Show>
              <Show when={importMsg()}><div class="import-msg">{importMsg()}</div></Show>
            </div>
          </div>
        </Show>

        <Show when={activeDialog()}>
          <WorkbenchDialogs
            state={activeDialog()}
            onClose={() => setActiveDialog(null)}
            onRun={runDDL}
            onEditAsSql={editAsSql}
          />
        </Show>
        <Show when={exportSrc()}>
          {(src) => (
            <ExportDialog
              columns={src().columns}
              loadedRows={src().rows}
              defaultTable={src().table}
              onClose={() => setExportSrc(null)}
              onExportFile={exportToFile}
              onExportClipboard={exportToClipboard}
              onCancel={cancelOperation}
            />
          )}
        </Show>
        <Show when={commitView()}>
          {(cv) => (
            <Dialog title="Commit changes" width={620} onClose={() => setCommitView(null)} dismissable={!commitBusy()}>
              <p class="confirm-text">
                {cv().script.length} statement{cv().script.length === 1 ? "" : "s"} will run in one transaction (rolled back wholesale on failure).
              </p>
              <SqlPreview sql={cv().script.map((s) => s + ";").join("\n")} />
              <Show when={commitErr()}>
                <div class="error">{commitErr()}</div>
              </Show>
              <div class="form-actions">
                <button class="ghost" disabled={commitBusy()} onClick={() => setCommitView(null)}>Cancel</button>
                <button class="run" disabled={commitBusy()} onClick={() => void doCommit()}>
                  {commitBusy() ? "Committing…" : "Commit"}
                </button>
              </div>
            </Dialog>
          )}
        </Show>
        <Show when={confirmDiscard()}>
          {(cd) => (
            <Dialog title="Discard pending changes?" width={420} onClose={() => setConfirmDiscard(null)}>
              <p class="confirm-text">
                This discards {cd().count} uncommitted change{cd().count === 1 ? "" : "s"} in the result grid.
              </p>
              <div class="form-actions">
                <button class="ghost" onClick={() => setConfirmDiscard(null)}>Keep changes</button>
                <button class="btn-danger" onClick={() => { const r = cd().run; setConfirmDiscard(null); r(); }}>Discard</button>
              </div>
            </Dialog>
          )}
        </Show>
        <Show when={confirmClose()}>
          {(id) => (
            <Dialog title="Unsaved changes" onClose={() => setConfirmClose(null)} width={420}>
              <p class="confirm-text">
                “{tabs().find((t) => t.id === id())?.title}” has unsaved changes. Save before closing?
              </p>
              <div class="form-actions">
                <button class="ghost" onClick={() => setConfirmClose(null)}>Cancel</button>
                <button class="btn-danger" onClick={() => { removeTab(id()); setConfirmClose(null); }}>Don't save</button>
                <button
                  class="run"
                  onClick={async () => {
                    const tid = id();
                    setActiveTabId(tid);
                    await saveActiveTab();
                    if (!tabs().find((t) => t.id === tid)?.dirty) {
                      removeTab(tid);
                      setConfirmClose(null);
                    }
                  }}
                >
                  Save
                </button>
              </div>
            </Dialog>
          )}
        </Show>
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

      {/* Update pill renders in both screens (connect + workspace). */}
      <UpdateBadge />

      {/* Manual + Settings work on both screens (connect screen has its own buttons). */}
      <Show when={helpOpen()}>
        <HelpDialog keys={keys()} onClose={() => setHelpOpen(false)} />
      </Show>
      <Show when={settingsOpen()}>
        <SettingsDialog
          prefs={prefs}
          update={updatePrefs}
          // Skills live on disk and are only mutated from Settings → AI, so a reload on
          // close is enough to keep `aiContext().skills` fresh without polling.
          onClose={() => { setSettingsOpen(null); void refreshSkills(); }}
          initialTab={settingsOpen()!}
          connected={!!conn()}
          database={tree()?.database ?? ""}
          shortcutsPane={() => <ShortcutsPane keys={keys} update={updateKeys} resetAll={resetKeys} />}
        />
      </Show>

      {/* Context menu + value viewer render above everything, in both screens. */}
      <Show when={menu()}>
        {(m) => <ContextMenu x={m().x} y={m().y} items={m().items} onClose={() => setMenu(null)} />}
      </Show>
      <Show when={runChoice()}>
        {(rc) => (
          <>
            <div class="run-chooser-overlay" onMouseDown={() => setRunChoice(null)} />
            <div
              class="run-chooser"
              style={{ left: `${rc().x}px`, top: `${rc().y}px` }}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setRunChoice(null); return; }
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const btns = [...e.currentTarget.querySelectorAll("button")] as HTMLButtonElement[];
                  const i = btns.indexOf(document.activeElement as HTMLButtonElement);
                  btns[(i + (e.key === "ArrowDown" ? 1 : btns.length - 1) + btns.length) % btns.length]?.focus();
                }
              }}
            >
              <div class="run-chooser-title">Run…</div>
              <button ref={(el) => queueMicrotask(() => el.focus())} onClick={() => chooseRun("block")}>Current block</button>
              <button onClick={() => chooseRun("file")}>Entire file</button>
              <div class="run-chooser-hint">↑↓ choose · Enter run · Esc cancel</div>
            </div>
          </>
        )}
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
