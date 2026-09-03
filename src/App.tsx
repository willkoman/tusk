import { createSignal, createMemo, createEffect, on, onMount, onCleanup, For, Show, lazy } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "./App.css";
import { isDarkTheme, normalizeTheme, type ThemeId } from "./themes";
import { type EditorApi } from "./SqlEditor";
import { driverDialect, type DialectId } from "./sql/dialects";
import { type AiContext, type SampleTable } from "./ai/context";
import { type CursorInfo, type EditorPrefs, type ServerDiag } from "./editor/types";
import { prefsStore, tabsStore, layoutStore, type PersistedTabs, type TabsPersistenceFailure } from "./store";
import { makeTab, basename, gridViewFor, pendingCount, snapshotTabs as recoverySnapshot, type Tab, type ResultSnapshot, type GridView, type SortKey, type Filter, type PendingEdits } from "./tabs";
import { ResultGrid } from "./ResultGrid";
import { UpdateBadge } from "./UpdateBadge";
import { WhatsNew } from "./WhatsNew";
import { wrapQuery, wrappableQuery, stripTrailingSemi, hasDuplicateColumns, hasViewRules } from "./grid/query";
import { editTarget, editPlan, type EditPlan } from "./grid/editable";
import { detectBoolCols, typeBoolCols } from "./grid/bool";
import { buildCommitScript } from "./grid/editSql";
import { planPaste, mergePaste, type RowRef } from "./grid/paste";
import { orderedRows, sortedRowOrder } from "./grid/sort";
import { interruptedResult } from "./tabs";
import { makeIndexer } from "./sql/aliases";
import { type Dataset, IMPORT_LIMITS, parseCSV, parseJSON, formatWithOptions } from "./formats";
import { FORMAT_EXT, type ExportOptions, type ExportScope } from "./export";
import { save, open as openDialog } from "@tauri-apps/plugin-dialog";
import { Tree, type DbTree, type RelationDetail, type NodeDescriptor, nodeKey, relKey } from "./Tree";
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
import { slackHistoryKey, type SlackExecuted } from "./slackEvents";
import { KeyedSerialQueue } from "./asyncQueue";
import {
  IDLE_TRANSACTION,
  INTERRUPTED_TRANSACTION_KEY,
  acceptTransactionStatus,
  decodeInterruptedTransaction,
  encodeInterruptedTransaction,
  transactionDatabaseAllowed,
  transactionBoundaryStaleReason,
  transactionControlAvailability,
  transactionEvent,
  transactionFromError,
  transactionHistoryScope,
  transactionHistorySql,
  transactionOpen,
  transactionOwnedBy,
  transactionProvenanceNeedsRefresh,
  transactionRecoveryAllowed,
  type TransactionEvent,
  type TransactionStatus,
} from "./transaction";

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
type QueryResult = QueryOutcome & { transaction: TransactionStatus };
type FetchResult = { rows: (string | null)[][]; done: boolean; interrupted?: boolean; transaction: TransactionStatus };
type Connected = {
  id: string;
  version: string;
  readOnly: boolean;
  driver: string;
  generation: number;
  key: string;
  target: string;
};
type UiOrigin = {
  connectionId: string | null;
  connectionGeneration: number;
  tabId: string | null;
  resultGeneration: number;
  resultEpoch: number;
  transactionRevision: number;
};
// Slack bot status mirrors slack::StatusInfo in Rust.
type SlackStatus = { running: boolean; state: string; error: string | null };

const PAGE = 1000;
const MAX_LOCAL_SORT_ROWS = 250_000;
const DDL_RE = /^\s*(create|alter|drop|truncate|comment|grant|revoke)\b/i;

// Heavy, conditionally-rendered panels load as separate chunks on first open —
// keeps the startup bundle (and its parse time) lean. All are behind <Show>,
// so the chunk fetch happens only when the user actually opens the surface.
const SqlEditor = lazy(() => import("./SqlEditor").then((m) => ({ default: m.SqlEditor })));
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
  cancelQuery: boolean;
  manualTransactions: boolean;
  transactionSavepoints: boolean;
  setTransaction: boolean;
  autocommitMode: boolean;
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
  const [conn, setConn] = createSignal<Connected | null>(null);
  const [transaction, setTransaction] = createSignal<TransactionStatus>({ ...IDLE_TRANSACTION });
  const [transactionStartedAt, setTransactionStartedAt] = createSignal<number | null>(null);
  const [transactionNow, setTransactionNow] = createSignal(Date.now());
  const [transactionWarning, setTransactionWarning] = createSignal("");
  let transactionHistoryKey: string | null = null;
  let deferredSchemaRefresh = false;
  let connectionGeneration = 0;
  let resultGeneration = 0;
  let queryGeneration = 0;
  let fetchGeneration = 0;
  let schemaGeneration = 0;
  let fkGeneration = 0;

  // saved profiles + connection form
  const [profiles, setProfiles] = createSignal<Profile[]>([]);
  const [editingId, setEditingId] = createSignal("");
  const [name, setName] = createSignal("");
  const [driver, setDriver] = createSignal("postgres");
  const [path, setPath] = createSignal(""); // DuckDB/SQLite file (empty = :memory:)
  const [caps, setCaps] = createSignal<Capabilities | null>(null);
  const connectionKind = () => caps()?.kind ?? conn()?.driver ?? "postgres";
  const [perms, setPerms] = createSignal<Permissions | null>(null);
  const [aiOpen, setAiOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal<SettingsTab | null>(null); // non-null = open on that tab
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const [history, setHistory] = createSignal<HistoryEntry[]>([]);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  // Incremented to summon the What's-new panel on demand (command palette).
  const [whatsNewRequest, setWhatsNewRequest] = createSignal(0);
  const [helpOpen, setHelpOpen] = createSignal(false);
  // "DDL & relationships" viewer (read-only — standalone signal, not DialogState).
  // name=null = opened from a schema node, straight into the whole-schema ERD.
  const [ddlGraph, setDdlGraph] = createSignal<{ schema: string; name: string | null; kind: string; connectionId: string; origin: UiOrigin } | null>(null);
  // Context handed to the AI: connected DB dialect/version, schema summary, the role's
  // privileges, the active schema, and the current editor SQL/selection/last error.
  const aiContext = (): AiContext => ({
    dialect: connectionKind(),
    driverLabel: driverLabel(connectionKind()),
    version: conn()?.version ?? "",
    user: perms()?.currentUser ?? "",
    isSuperuser: !!perms()?.isSuperuser,
    permissionsEnforced: !!perms()?.enforced,
    activeSchema: activeTab().searchSchema,
    tables: schema(),
    database: tree()?.database ?? "",
    skills: skills(),
    fks: fkEdges(),
    // True only when every schema this prompt relies on (active + public) fetched
    // successfully; one successful schema must not mask another failed lookup.
    fksKnown: caps()?.relationships !== false && [...aiFkSchemas()].every((schemaName) => fkFetched.has(schemaName)),
    currentSql: editorApi()?.getDoc() ?? activeTab().sql,
    selection: editorApi()?.getSelection() ?? "",
    lastError: activeTab().result.runErr,
  });
  // Sample-data fetcher for the AI assistant: a few read-only rows per relevant table,
  // cached for the session (cleared on schema reload) and run without disturbing any
  // in-flight stream. Best-effort — a table that can't be sampled is just skipped.
  const sampleCache = new Map<string, SampleTable>();
  // relKey now lives in Tree.tsx — the tree reads the same cache, and a key drift
  // between writer and reader showed every expanded table as "loading…" forever.
  async function aiSampleRows(targets: { schema: string; name: string }[]): Promise<SampleTable[]> {
    const c = conn();
    if (!c || metadataFrozen()) return [];
    const transactionRevision = transaction().revision;
    const results = await Promise.all(
      targets.map(async (t): Promise<SampleTable | null> => {
        const key = relKey(t.schema, t.name);
        const hit = sampleCache.get(key);
        if (hit) return hit;
        try {
          const r = await invoke<{ columns: string[]; rows: (string | null)[][] }>("sample_rows", {
            connectionId: c.id, schema: t.schema, name: t.name, limit: 5,
          });
          if (!connectionCurrent(c) || transaction().revision !== transactionRevision || metadataFrozen()) return null;
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
  const ddlDriver = () => connectionKind() === "postgres" || connectionKind() === "duckdb";
  const gate = (allowed: boolean, reason: string): { disabled?: boolean; title?: string } => {
    if (metadataFrozen()) return { disabled: true, title: "Explorer database actions are frozen during a manual transaction" };
    if (conn()?.readOnly) return { disabled: true, title: "Connection is read-only" };
    if (conn() && !ddlDriver())
      return { disabled: true, title: `DDL editing isn't supported for ${driverLabel(connectionKind())} yet` };
    return allowed ? {} : { disabled: true, title: reason };
  };
  // Disable an item that DuckDB's engine can't do (constraint ALTERs, rename index/
  // sequence/constraint, ALTER SEQUENCE RESTART, CREATE DATABASE). Spread AFTER gate().
  const noDuck = (reason: string): { disabled?: boolean; title?: string } =>
    connectionKind() === "duckdb" ? { disabled: true, title: reason } : {};
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
  let skillsGeneration = 0;
  const refreshSkills = async () => {
    const generation = ++skillsGeneration;
    try {
      const next = await invoke<Skill[]>("skills_list");
      if (skillsGeneration === generation) setSkills(next);
    } catch {
      if (skillsGeneration === generation) setSkills([]);
    }
  };
  const fkFetched = new Set<string>(); // schemas fetched SUCCESSFULLY (cleared per introspection)
  const fkInFlight = new Set<string>(); // dedupe concurrent fetches of the same schema
  // Per-table detail (columns/indexes/constraints), fetched lazily on expand and cached.
  const [details, setDetails] = createSignal<Record<string, RelationDetail>>({});
  const loadedRels = new Map<string, { schema: string; name: string }>();
  const detailInflight = new Set<string>();
  // Sidebar context menu + active workbench dialog.
  const [menuState, setMenuState] = createSignal<MenuState>(null);
  const menu = menuState;
  const [dialogBinding, setDialogBinding] = createSignal<{ state: DialogState; origin: UiOrigin } | null>(null);
  const activeDialog = () => dialogBinding()?.state ?? null;
  const [treeFilter, setTreeFilter] = createSignal("");
  // Currently-selected sidebar node (drives the context-aware "+" menu).
  const [selected, setSelected] = createSignal<NodeDescriptor | null>(null);
  // "View value" modal for a result-grid cell.
  const [cellView, setCellView] = createSignal<{ col: string; val: string | null; origin: UiOrigin } | null>(null);
  // Editor tabs — each owns a SQL buffer + a snapshot of its last result grid.
  const [tabs, setTabs] = createSignal<Tab[]>([makeTab({ sql: "SELECT * FROM information_schema.tables;" })]);
  const [activeTabId, setActiveTabId] = createSignal(tabs()[0].id);
  const activeTab = createMemo(() => tabs().find((t) => t.id === activeTabId()) ?? tabs()[0]);
  const aiFkSchemas = () => new Set([activeTab().searchSchema ?? "public", "public"]);
  const [persistenceWarning, setPersistenceWarning] = createSignal("");
  let cursorOwner: { tabId: string; connectionGeneration: number; resultGeneration: number; cursorGeneration: number } | null = null;
  let cursorGeneration = 0;
  let activeQuery: { generation: number; connectionGeneration: number; tabId: string; transactionRevision: number } | null = null;

  const patchTab = (id: string, patch: Partial<Tab>) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  /**
   * Release the single server cursor because `reason` is about to (or did) close it
   * underneath its owner tab. The owner's snapshot is frozen as an explicitly
   * INCOMPLETE result — status, toolbar badge, local-sort/export gating — instead of
   * being silently presented as the full set. No-op when nothing is streaming.
   */
  function interruptStream(reason: string) {
    const owner = cursorOwner;
    if (!owner) return;
    cursorOwner = null;
    cursorGeneration++;
    const t = tabs().find((x) => x.id === owner.tabId);
    if (!t || t.result.generation !== owner.resultGeneration) return;
    const patch = interruptedResult(t.result, reason);
    if (patch) patchResult(owner.tabId, patch);
  }
  const patchResult = (id: string, patch: Partial<ResultSnapshot>) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, result: { ...t.result, ...patch } } : t)));

  const ownerTab = () => tabs().find((t) => t.id === transaction().owner);
  const ownerPendingCount = () => pendingCount(ownerTab()?.pending);
  const activeOwnsTransaction = () => transactionOwnedBy(transaction(), activeTabId());
  const activeDatabaseAllowed = () => transactionDatabaseAllowed(transaction(), activeTabId());
  const metadataFrozen = () => transactionOpen(transaction());

  function removeInterruptedMarker(connectionKey: string) {
    try {
      const marker = decodeInterruptedTransaction(localStorage.getItem(INTERRUPTED_TRANSACTION_KEY));
      if (!marker || marker.connectionKey === connectionKey.slice(0, 2048)) localStorage.removeItem(INTERRUPTED_TRANSACTION_KEY);
    } catch {
      /* Recovery marker is advisory; storage failure must not affect transaction control. */
    }
  }

  function persistInterruptedMarker(status: TransactionStatus) {
    const c = conn();
    const startedAt = transactionStartedAt();
    if (!c || startedAt === null) return;
    const raw = encodeInterruptedTransaction(c.key, c.target, status, startedAt);
    if (!raw) return;
    try {
      localStorage.setItem(INTERRUPTED_TRANSACTION_KEY, raw);
    } catch {
      /* Advisory marker only. */
    }
  }

  /** Apply transaction state before result-origin checks; stale UI payloads cannot suppress it. */
  function applyAuthoritativeTransaction(
    incoming: unknown,
    sourceGeneration: number,
    event: TransactionEvent = "statement",
    eventBaseline?: TransactionStatus,
  ): boolean {
    const c = conn();
    if (!c) return false;
    const accepted = acceptTransactionStatus(transaction(), incoming, sourceGeneration, c.generation);
    if (!accepted.accepted) return false;
    const previous = transaction();
    const next = accepted.status;
    const opening = !transactionOpen(previous) && transactionOpen(next);
    const newIdentity = transactionOpen(next) && previous.id !== next.id;
    if (opening || newIdentity) {
      const startedAt = Date.now();
      setTransactionStartedAt(startedAt);
      setTransactionNow(startedAt);
      transactionHistoryKey = next.id ? `${next.id}@${startedAt.toString(36)}` : null;
    }

    // A status poll can observe a new revision before the command response arrives.
    // Use the command's captured baseline for boundary provenance, while still applying
    // state monotonically against the latest current status above.
    const boundaryPrevious = eventBaseline && eventBaseline.revision <= next.revision
      ? eventBaseline
      : previous;
    const stale = transactionBoundaryStaleReason(boundaryPrevious, next, event);
    if (stale) {
      setTabs((all) => all.map((tab) => {
        const resultMatches = tab.result.generation > 0 && transactionProvenanceNeedsRefresh(
          tab.result.transactionId,
          tab.result.transactionRevision,
          boundaryPrevious,
          next,
        );
        const pendingMatches = !!tab.pending && transactionProvenanceNeedsRefresh(
          tab.pending.transactionId,
          tab.pending.transactionRevision,
          boundaryPrevious,
          next,
        );
        return {
          ...tab,
          ...(pendingMatches ? { pending: { ...tab.pending!, stale } } : {}),
          ...(resultMatches ? { result: { ...tab.result, transactionStale: stale } } : {}),
        };
      }));
    }

    setTransaction(next);
    if (transactionOpen(next)) {
      persistInterruptedMarker(next);
      setMenuState(null);
      setDdlGraph(null);
      setActiveDialog(null);
      if (importOpen() && !importBusy()) {
        importReadGeneration++;
        setImportOpen(false);
        importOrigin = null;
      }
      if (next.state === "lost") {
        setTransactionWarning(`Transaction ${next.id ?? "session"} was lost. Its outcome may be unknown; disconnect and reconnect before continuing.`);
      }
    } else {
      setTransactionStartedAt(null);
      transactionHistoryKey = null;
      removeInterruptedMarker(c.key);
      queueMicrotask(() => {
        if (deferredSchemaRefresh && conn()?.generation === sourceGeneration && !transactionOpen(transaction())) {
          deferredSchemaRefresh = false;
          void loadSchema(c);
        }
      });
    }
    return true;
  }

  const captureOrigin = (): UiOrigin => {
    const c = conn();
    const t = tabs().find((x) => x.id === activeTabId());
    return {
      connectionId: c?.id ?? null,
      connectionGeneration: c?.generation ?? connectionGeneration,
      tabId: t?.id ?? null,
      resultGeneration: t?.result.generation ?? 0,
      resultEpoch: t?.result.epoch ?? 0,
      transactionRevision: transaction().revision,
    };
  };
  const originAlive = (o: UiOrigin, includeResult = false) => {
    const c = conn();
    if (o.connectionId !== (c?.id ?? null) || o.connectionGeneration !== (c?.generation ?? connectionGeneration)) return false;
    const t = tabs().find((x) => x.id === o.tabId);
    if (!t) return false;
    if (o.transactionRevision !== transaction().revision) return false;
    return !includeResult || (t.result.generation === o.resultGeneration && t.result.epoch === o.resultEpoch);
  };
  const originCurrent = (o: UiOrigin, includeResult = false) => o.tabId === activeTabId() && originAlive(o, includeResult);
  const originKey = (o: UiOrigin) => JSON.stringify([o.connectionId, o.connectionGeneration, o.tabId, o.resultGeneration, o.resultEpoch, o.transactionRevision]);
  const connectionCurrent = (c: Connected) => conn()?.id === c.id && conn()?.generation === c.generation;
  const setMenu = (next: MenuState) => {
    if (!next) {
      setMenuState(null);
      return;
    }
    const origin = captureOrigin();
    const valid = () => originCurrent(origin, true);
    setMenuState({
      ...next,
      scope: originKey(origin),
      items: next.items.map((item) => {
        if ("sep" in item) return item;
        const itemValid = item.valid;
        return { ...item, valid: () => valid() && (itemValid?.() ?? true) };
      }),
    });
  };
  const setActiveDialog = (state: DialogState | null, origin = captureOrigin()) =>
    setDialogBinding(state ? { state, origin } : null);

  const menuScope = createMemo(() => originKey(captureOrigin()));
  createEffect(on(menuScope, () => setMenuState(null), { defer: true }));

  // Active-tab accessors so the existing editor + result-grid JSX stays unchanged.
  const sql = () => activeTab().sql;
  const columns = () => activeTab().result.columns;
  const rows = () => activeTab().result.rows;
  const done = () => activeTab().result.done;
  const status = () => activeTab().result.status;
  const runErr = () => activeTab().result.runErr;
  const elapsed = () => activeTab().result.elapsed;
  const lastQuery = () => activeTab().result.lastQuery;
  const setStatus = (s: string) => patchResult(activeTabId(), { status: s });
  const tryWrapQuery = (
    tab: Tab,
    sorts: SortKey[],
    filters: Filter[],
    action = "sort/filter",
  ): string | null => {
    try {
      return wrapQuery(tab.result.baseQuery, sorts, filters, tab.result.columns, connectionKind());
    } catch (e) {
      patchResult(tab.id, { status: `${action} rejected: ${errMsg(e)}` });
      return null;
    }
  };
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
  const activeDialect = createMemo<DialectId>(() => (conn() ? driverDialect(connectionKind()) : prefs().dialect));
  // ident/DDL quoting uses the REAL driver kind (not the editor dialect, which maps
  // DuckDB→postgres for highlighting). Quoting is identical for pg/duckdb/sqlite (double
  // quotes; only MySQL backticks), but the DDL builders branch on the true driver so they
  // can emit DuckDB-compatible syntax. Falls back to the editor dialect when disconnected.
  createEffect(() => setSqlDialect(conn() ? connectionKind() : activeDialect()));
  const [cursorInfo, setCursorInfo] = createSignal<CursorInfo | null>(null);
  let tabsConnKey: string | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let restoring = false;
  let tabsRecoveryWritable = true;

  const updatePrefs = (patch: Partial<EditorPrefs>) => {
    const next = { ...prefs(), ...patch };
    setPrefs(next);
    // Loud like the AI/Slack panes: a silently unsaved pref "works" until restart.
    if (!prefsStore.save(next))
      setPersistenceWarning("Editor settings could not be saved — they apply now but will reset on restart (storage unavailable or full).");
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
    if (!keymapStore.save(next))
      setPersistenceWarning("Shortcut changes could not be saved — they apply now but will reset on restart (storage unavailable or full).");
  };
  const resetKeys = () => {
    setKeys({});
    if (!keymapStore.save({}))
      setPersistenceWarning("Shortcut reset could not be saved — defaults apply now but overrides may return on restart.");
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
    canRunDatabase: activeDatabaseAllowed(),
    canExplainAnalyze: caps()?.explainAnalyze !== false,
    canCommitTransaction: transactionControls().commit,
    canRollbackTransaction: transactionControls().rollback,
  });

  // Validate the buffer against Postgres for parser-grade diagnostics (PREPARE-only,
  // never executes). Skipped while a query is running (shares the connection lock)
  // or when the server-lint pref is off.
  const validate = async (sqlText: string): Promise<ServerDiag[]> => {
    const c = conn();
    const origin = captureOrigin();
    // Skip while a query is running (shared connection lock) AND while any streaming
    // cursor is open: validate_sql rolls back the open cursor to PREPARE in autocommit,
    // which would truncate a live stream. (Double-clicking a table sets the editor doc,
    // which fires this lint ~600ms later — it must not kill the stream it just opened.)
    if (!c || running() || cursorOwner !== null || metadataFrozen() || !prefs().serverLint) return [];
    try {
      const diagnostics = await invoke<ServerDiag[]>("validate_sql", { connectionId: c.id, sql: sqlText, searchPath: activeTab().searchSchema });
      return connectionCurrent(c) && originCurrent(origin) ? diagnostics : [];
    } catch {
      return [];
    }
  };

  // --- tab management + file flow ---
  const [confirmClose, setConfirmClose] = createSignal<{ tabId: string; dirty: boolean; pending: number } | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = createSignal<number | null>(null);
  const [confirmWindowClose, setConfirmWindowClose] = createSignal<number | null>(null);
  type TransactionResolution = { kind: "close-tab"; tabId: string } | { kind: "disconnect" } | { kind: "window-close" };
  const [transactionResolution, setTransactionResolution] = createSignal<TransactionResolution | null>(null);
  const [transactionResolutionBusy, setTransactionResolutionBusy] = createSignal(false);
  let allowNativeClose = false;
  let nativeCloseUnlisten: UnlistenFn | null = null;
  // Snapshot of the result being exported, frozen when the dialog opens so a tab
  // switch while it's open can't redirect the export to a different tab.
  const [exportSrc, setExportSrc] = createSignal<
    {
      columns: string[];
      rows: (string | null)[][];
      query: string;
      table: string;
      searchSchema: string | null;
      /** The grid's bool-column set (source indices) frozen with the snapshot — export shows what the grid shows. */
      boolCols: number[];
      /** Non-empty when the loaded rows are a partial result (stream interrupted). */
      incomplete: string;
      origin: UiOrigin;
      connectionId: string;
      dialect: string;
    } | null
  >(null);
  const openExport = () => {
    const tab = activeTab();
    const c = conn();
    if (!c) return;
    const order = localRowOrder();
    let query = lastQuery();
    if (order && tab.gridView.sorts.length && canServerSortFilter()) {
      const wrapped = tryWrapQuery(tab, tab.gridView.sorts, [], "export query");
      if (wrapped === null) return;
      query = wrapped;
    }
    setExportSrc({
      columns: columns(),
      rows: orderedRows(rows(), order),
      incomplete: tab.result.incomplete,
      query,
      table: tableNameFromSql(query),
      searchSchema: tab.searchSchema,
      boolCols: [...boolCols()],
      origin: captureOrigin(),
      connectionId: c.id,
      dialect: connectionKind(),
    });
  };

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
    const kept = targets.filter((t) => t.dirty || pendingCount(t.pending) > 0 || (running() && runningTabId() === t.id));
    for (const t of targets) {
      if (!t.dirty && !pendingCount(t.pending) && (!running() || runningTabId() !== t.id)) removeTab(t.id);
    }
    if (kept.length) setStatus(`kept ${kept.length} tab${kept.length > 1 ? "s" : ""} with unsaved, pending, or running work`);
  }

  function removeTab(id: string) {
    if (running() && runningTabId() === id) {
      patchResult(id, { status: "Cancel or wait for this query before closing its owner tab" });
      return;
    }
    if (transactionOwnedBy(transaction(), id)) {
      switchTab(id);
      setTransactionResolution({ kind: "close-tab", tabId: id });
      return;
    }
    if (cursorOwner?.tabId === id) {
      cursorOwner = null;
      cursorGeneration++;
    }
    saveOperations.delete(id);
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
    if (running() && runningTabId() === id) {
      patchResult(id, { status: "Cancel or wait for this query before closing its owner tab" });
      return;
    }
    if (transactionOwnedBy(transaction(), id)) {
      switchTab(id);
      setTransactionResolution({ kind: "close-tab", tabId: id });
      return;
    }
    const pending = pendingCount(t.pending);
    if (t.dirty || pending) {
      setConfirmClose({ tabId: id, dirty: t.dirty, pending });
      return;
    }
    removeTab(id);
  }

  async function openFileDialog() {
    const origin = captureOrigin();
    try {
      const path = await openDialog({ multiple: false, filters: [{ name: "SQL", extensions: ["sql", "txt"] }] });
      if (!originCurrent(origin)) return;
      if (typeof path !== "string") return;
      const existing = tabs().find((t) => t.filePath === path);
      if (existing) {
        switchTab(existing.id);
        return;
      }
      const contents = await invoke<string>("read_text_file", { path });
      if (!originCurrent(origin)) return;
      const openedWhileReading = tabs().find((t) => t.filePath === path);
      if (openedWhileReading) {
        switchTab(openedWhileReading.id);
        return;
      }
      const t = makeTab({ sql: contents, filePath: path, title: basename(path), dirty: false });
      setTabs((ts) => [...ts, t]);
      switchTab(t.id);
    } catch (e) {
      if (origin.tabId && originCurrent(origin)) patchResult(origin.tabId, { runErr: errMsg(e) });
    }
  }

  const saveOperations = new Map<string, number>();
  const fileWrites = new KeyedSerialQueue<string>();
  async function saveTab(tabId: string, saveAs: boolean): Promise<boolean> {
    let t = tabs().find((x) => x.id === tabId);
    if (!t) return false;
    try {
      let filePath = t.filePath;
      if (saveAs || !filePath) {
        filePath = await save({ defaultPath: t.filePath ?? `${t.title}.sql`, filters: [{ name: "SQL", extensions: ["sql"] }] });
        if (!filePath) return false;
      }
      t = tabs().find((x) => x.id === tabId);
      if (!t) return false;
      if (tabs().some((x) => x.id !== tabId && x.filePath === filePath))
        throw new Error("that file is already open in another tab");
      const live = tabId === activeTabId() ? editorApi()?.getDoc() : undefined;
      const text = live ?? t.sql;
      let revision = t.revision;
      if (text !== t.sql) {
        revision++;
        patchTab(tabId, { sql: text, dirty: true, revision });
      }
      const operation = (saveOperations.get(tabId) ?? 0) + 1;
      saveOperations.set(tabId, operation);
      // Atomic writes still race with each other. Serialize by destination so an
      // older save can never finish after, and overwrite, a newer invocation.
      await fileWrites.run(filePath, () => invoke("write_text_file", { path: filePath, contents: text }));
      if (saveOperations.get(tabId) !== operation) return false;
      const current = tabs().find((x) => x.id === tabId);
      if (!current) return false;
      const unchanged = current.revision === revision && current.sql === text;
      patchTab(tabId, {
        filePath,
        title: basename(filePath),
        ...(unchanged ? { dirty: false } : {}),
      });
      patchResult(tabId, { status: unchanged ? `saved → ${filePath}` : `saved revision → ${filePath}; newer edits remain unsaved` });
      return unchanged;
    } catch (e) {
      if (tabs().some((x) => x.id === tabId)) patchResult(tabId, { runErr: errMsg(e) });
      return false;
    }
  }

  const saveActiveTab = () => saveTab(activeTabId(), false);
  const saveAsActiveTab = () => saveTab(activeTabId(), true);

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
  let importReadGeneration = 0;
  let importCloseTimer: ReturnType<typeof setTimeout> | undefined;
  let importOrigin: { origin: UiOrigin; connection: Connected } | null = null;

  // Lazy EXPLAIN detection: null for normal results (the leading-keyword gate
  // makes this free), a ParsedPlan when the active tab's result is a plan.
  const planMemo = createMemo(() => {
    const t = activeTab();
    if (!conn() || !t.result.columns.length) return null;
    return detectPlan(connectionKind(), {
      lastQuery: t.result.lastQuery,
      columns: t.result.columns,
      rows: t.result.rows,
    });
  });
  const resultView = () => (planMemo() ? activeTab().resultView ?? "plan" : "grid");
  // EXPLAIN ANALYZE on a mutating statement → explicit confirm (it executes).
  const [confirmAnalyze, setConfirmAnalyze] = createSignal<{ sql: string; origin: UiOrigin } | null>(null);
  // Whether this DuckDB build accepts PG-style `EXPLAIN (FORMAT json)` —
  // probed once at connect time (a probe mid-session could disturb the pager).
  let duckJsonExplain = false;

  function runExplain(analyze: boolean) {
    if (!activeDatabaseAllowed()) {
      setStatus(`Switch to ${ownerTab()?.title ?? "the transaction owner"} to run database actions`);
      return;
    }
    const api = editorApi();
    if (!api) return;
    const stmt = api.getSelection().trim() || api.getCurrentStatement();
    if (!stmt.trim()) return;
    const wrapped = explainSql(connectionKind(), analyze, stmt, duckJsonExplain);
    if (analyze && analyzeExecutesWrite(stmt)) {
      setConfirmAnalyze({ sql: wrapped, origin: captureOrigin() });
      return;
    }
    runParameterized(wrapped, (substituted) => void executeQuery(substituted, "", "base", false, wrapped));
  }

  // result grid: per-tab view + sort/filter re-run, Load-all
  const gridView = () => activeTab().gridView;
  const setGridView = (patch: Partial<GridView>) => patchTab(activeTabId(), { gridView: { ...activeTab().gridView, ...patch } });
  const canServerSortFilter = () =>
    wrappableQuery(activeTab().result.baseQuery) &&
    // MySQL refuses duplicate column names inside a derived table (error 1060),
    // so the sort/filter wrap can't work on such results there.
    !(connectionKind() === "mysql" && hasDuplicateColumns(activeTab().result.columns));
  const localSortEligible = () => {
    const tab = activeTab();
    // An interrupted stream holds only part of the result: sorting it in memory would
    // order a subset while looking like the whole. Fall through to the server path.
    return tab.result.done && !tab.result.incomplete && tab.result.rowsAreBase && tab.gridView.filters.length === 0 && tab.result.rows.length <= MAX_LOCAL_SORT_ROWS;
  };
  /** Why a header click can't sort right now (empty when it can). Shown as status feedback. */
  const sortUnavailable = () => {
    if (running()) return "sorting is unavailable while a query is running";
    if (!activeDatabaseAllowed())
      return transaction().state === "lost" ? "sorting is unavailable: the transaction session was lost — disconnect and reconnect" : "sorting is frozen while another tab owns the transaction";
    if (!canServerSortFilter()) {
      if (activeTab().result.incomplete) return "this result is incomplete and its query can't be re-run with ORDER BY — re-run it to sort";
      if (!activeTab().result.done) return "this query can't be re-run with ORDER BY — load all rows first to sort in memory";
      return "this result can't be sorted: the query isn't a single re-runnable SELECT and it exceeds the in-memory sort limit";
    }
    return "";
  };
  const canSort = () => !running() && (localSortEligible() || (activeDatabaseAllowed() && canServerSortFilter()));
  const canFilter = () => !running() && activeDatabaseAllowed() && canServerSortFilter();
  const localSortRows = createMemo(() => activeTab().result.rows);
  const localSorts = createMemo(() => activeTab().gridView.sorts);
  const localSortDone = createMemo(() => activeTab().result.done && !activeTab().result.incomplete);
  const localSortBase = createMemo(() => activeTab().result.rowsAreBase);
  const localSortHasFilters = createMemo(() => activeTab().gridView.filters.length > 0);
  const localRowOrder = createMemo(() => {
    const sorts = localSorts();
    return localSortDone() && localSortBase() && !localSortHasFilters() && localSortRows().length <= MAX_LOCAL_SORT_ROWS && sorts.length
      ? sortedRowOrder(localSortRows(), sorts, connectionKind())
      : null;
  });
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
    if (running()) return { editable: false, reason: "a query is running", plan: null };
    if (c.readOnly) return { editable: false, reason: "connection is read-only", plan: null };
    const tx = transaction();
    const result = activeTab().result;
    if (result.transactionStale) return { editable: false, reason: result.transactionStale, plan: null };
    if (activeTab().pending?.stale) return { editable: false, reason: activeTab().pending!.stale!, plan: null };
    if (transactionOpen(tx)) {
      if (tx.state === "lost") return { editable: false, reason: "transaction session was lost", plan: null };
      if (tx.state === "failed") return { editable: false, reason: "transaction failed; roll it back before applying more changes", plan: null };
      if (tx.owner !== activeTabId()) return { editable: false, reason: `transaction is owned by ${ownerTab()?.title ?? tx.owner ?? "another tab"}`, plan: null };
      if (result.transactionId !== tx.id) return { editable: false, reason: "result predates the active transaction; rerun it before editing", plan: null };
    } else if (result.transactionId !== null) {
      return { editable: false, reason: "transaction ended; rerun before editing", plan: null };
    } else if (result.generation > 0 && result.transactionRevision !== tx.revision) {
      return { editable: false, reason: "transaction state changed; rerun before editing", plan: null };
    }
    // The tab's active schema pins the session search_path, so bare-name
    // resolution inside editTarget may use the same active→public chain the
    // server applies; without one, ambiguous names stay uneditable.
    const tgt = editTarget(editBaseQ(), editIndexer(schema()), activeTab().searchSchema);
    if (!tgt.ok) return { editable: false, reason: tgt.reason, plan: null };
    // PG permission model: no write privilege at all → don't offer editing
    // (partial privileges still commit — the server enforces per statement).
    if (perms()?.enforced && !isSuper()) {
      const tp = tablePriv(tgt.table.schema, tgt.table.name);
      if (tp && !tp.isOwner && !tp.update && !tp.insert && !tp.delete)
        return { editable: false, reason: `no write privilege on ${tgt.table.name}`, plan: null };
    }
    const det = details()[relKey(tgt.table.schema, tgt.table.name)];
    if (!det) {
      // The detail read rolls back the server cursor, so it must never run while
      // this result is still streaming (executeQuery prefetches it before the run;
      // this is the fallback when that missed, e.g. metadata was frozen).
      if (metadataFrozen())
        return { editable: false, reason: "table info can't load during a manual transaction — expand the table in the Explorer before BEGIN", plan: null };
      if (!result.done)
        return { editable: false, reason: "table info loads once the result finishes streaming (Load all)", plan: null };
      return { editable: false, reason: "loading table info…", plan: null, want: { schema: tgt.table.schema, name: tgt.table.name } };
    }
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
    return p ? details()[relKey(p.schema, p.table)] : undefined;
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
    const numeric = connectionKind() === "sqlite" || connectionKind() === "mysql";
    return { trueVal: numeric ? "1" : "true", falseVal: numeric ? "0" : "false", nullable: col.nullable };
  };

  // Memo (not a plain accessor): activeTab()'s identity changes on every patchTab
  // (each editor keystroke) — the memo dedupes by the pending object's reference,
  // so the grid's overlay memos only recompute on actual edits.
  const tabPending = createMemo(() => activeTab().pending);
  const setPendingFor = (tabId: string, p: PendingEdits | undefined) => patchTab(tabId, { pending: p });
  const isPendingEmpty = (p: PendingEdits) => !Object.keys(p.cells).length && !p.deletes.length && !p.inserts.length;
  const ensurePending = (): PendingEdits => tabPending() ?? {
    cells: {},
    deletes: [],
    inserts: [],
    transactionId: activeTab().result.transactionId,
    transactionRevision: activeTab().result.transactionRevision,
  };

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
      loadedOrder: localRowOrder() ?? undefined,
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

  // Apply dialog: preview the generated script, run it atomically in autocommit or
  // inside the owner's existing outer transaction, then refresh the grid.
  const [commitView, setCommitView] = createSignal<{ script: string[]; origin: UiOrigin } | null>(null);
  const [commitBusy, setCommitBusy] = createSignal(false);
  const [commitErr, setCommitErr] = createSignal("");
  let transactionResolutionAfterApply: TransactionResolution | null = null;
  const [confirmDiscard, setConfirmDiscard] = createSignal<{ count: number; origin: UiOrigin; run: () => void } | null>(null);

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
      dialect: connectionKind(),
    });
    if (!script.length) {
      // Shouldn't happen (non-table cells can't be edited) — but never open a dialog
      // that would run an empty script.
      setStatus("no committable changes");
      return;
    }
    setCommitErr("");
    setCommitView({ script, origin: captureOrigin() });
  }

  function closeCommit() {
    const resume = transactionResolutionAfterApply;
    transactionResolutionAfterApply = null;
    setCommitView(null);
    if (resume) setTransactionResolution(resume);
  }

  function applyPendingBeforeTransactionResolution() {
    const intent = transactionResolution();
    const owner = transaction().owner;
    if (!intent || !owner) return;
    switchTab(owner);
    transactionResolutionAfterApply = intent;
    setTransactionResolution(null);
    queueMicrotask(() => {
      openCommit();
      if (!commitView()) {
        transactionResolutionAfterApply = null;
        setTransactionResolution(intent);
      }
    });
  }

  async function doCommit() {
    const cv = commitView();
    const c = conn();
    if (!cv || !c || commitBusy() || running() || !originCurrent(cv.origin, true)) return;
    const tabId = cv.origin.tabId;
    if (!tabId) return;
    setCommitBusy(true);
    setCommitErr("");
    const t0 = performance.now();
    const before = transaction();
    const beforeHistoryKey = transactionHistoryKey;
    try {
      // Fully-qualified statements — no search_path dependence. Multi-statement
      // scripts run in one transaction (rolled back wholesale on failure).
      const sqlText = cv.script.map((s) => s + ";").join("\n");
      const out = await invoke<QueryResult>("run_query", { connectionId: c.id, ownerId: tabId, sql: sqlText, pageSize: PAGE, searchPath: null });
      const accepted = applyAuthoritativeTransaction(out.transaction, c.generation, "grid_apply", before);
      const source = tabs().find((tab) => tab.id === tabId);
      if (!accepted || transaction().revision !== out.transaction.revision || !connectionCurrent(c) ||
          source?.result.generation !== cv.origin.resultGeneration || source.result.epoch !== cv.origin.resultEpoch) return;
      setPendingFor(tabId, undefined);
      setCommitView(null);
      patchResult(tabId, { status: transactionOpen(out.transaction)
        ? `${cv.script.length} change${cv.script.length === 1 ? "" : "s"} applied inside transaction; commit the outer transaction separately`
        : `${cv.script.length} change${cv.script.length === 1 ? "" : "s"} applied` });
      recordHistory({
        sql: historySqlForTransaction(sqlText, before, out.transaction, "grid_apply", beforeHistoryKey),
        durationMs: Math.round(performance.now() - t0),
        status: "ok",
        rows: null,
        error: null,
        schema: null,
      }, c.key);
      if (transactionResolutionAfterApply) {
        setTransactionResolution(transactionResolutionAfterApply);
        transactionResolutionAfterApply = null;
        return;
      }
      // Refresh the grid in place, keeping the current sort/filter view.
      const t = tabs().find((x) => x.id === tabId);
      if (t) {
        const v = t.gridView;
        const base = t.result.baseQuery;
        const sqlToRun = v.sorts.length || v.filters.length ? tryWrapQuery(t, v.sorts, v.filters) : base;
        if (sqlToRun === null) return;
        void executeQuery(sqlToRun, base, "wrapped");
      }
    } catch (e) {
      const embedded = transactionFromError(e);
      if (embedded) applyAuthoritativeTransaction(embedded, c.generation, "grid_apply", before);
      const source = tabs().find((tab) => tab.id === tabId);
      if (connectionCurrent(c) && source?.result.generation === cv.origin.resultGeneration && source.result.epoch === cv.origin.resultEpoch) {
        const message = errMsg(e);
        setCommitErr(message);
        recordHistory({
          sql: historySqlForTransaction(cv.script.map((s) => s + ";").join("\n"), before, embedded ?? transaction(), "grid_apply", beforeHistoryKey),
          durationMs: Math.round(performance.now() - t0),
          status: "error",
          rows: null,
          error: message.split("\n")[0],
          schema: null,
        }, c.key);
      }
    } finally {
      setCommitBusy(false);
    }
  }

  function discardPending() {
    const n = pendingCount(tabPending());
    if (!n) return;
    const origin = captureOrigin();
    setConfirmDiscard({
      count: n,
      origin,
      run: () => { if (originCurrent(origin, true) && origin.tabId) setPendingFor(origin.tabId, undefined); },
    });
  }

  const [loadingAll, setLoadingAll] = createSignal(false);
  const [schemaLoading, setSchemaLoading] = createSignal(false);
  let cancelAll = false;
  let importFileInput: HTMLInputElement | undefined;
  // Reactive so the "streaming…" spinner spins only during an actual in-flight fetch
  // (not merely while more rows remain, i.e. !done()).
  const [fetchingMore, setFetchingMore] = createSignal(false);
  const runTimers = new Set<ReturnType<typeof setInterval>>();
  let transactionTimer: ReturnType<typeof setInterval> | undefined;
  const interactionCleanups = new Set<() => void>();

  function transactionControlBusy(): boolean {
    return running() || fetchingMore() || loadingAll() || commitBusy();
  }

  function transactionControls() {
    return transactionControlAvailability(
      transaction(),
      activeTabId(),
      ownerPendingCount(),
      transactionControlBusy(),
    );
  }

  const totalPendingCount = () => tabs().reduce((total, tab) => total + pendingCount(tab.pending), 0);
  const closeOperationBusy = () => transactionControlBusy() || importBusy();

  const [slackStatus, setSlackStatus] = createSignal<SlackStatus>({ running: false, state: "disconnected", error: null });
  const slackUnlisten: UnlistenFn[] = [];
  const slackHistoryKeys = new Map<string, string>();
  let slackStatusRevision = 0;

  const preventNativeContextMenu = (e: Event) => e.preventDefault();
  const showPersistenceFailure = (failure: TabsPersistenceFailure) => {
    const consequence = failure.operation === "remove"
      ? "Old recovery data could not be cleaned up."
      : "Unsaved tabs may not survive closing.";
    setPersistenceWarning(`Editor recovery ${failure.operation} failed (${failure.message}). ${consequence}`);
  };
  const persistRecovery = (key: string, data: PersistedTabs, forClose = false) => {
    if (!tabsRecoveryWritable && key === tabsConnKey) {
      const error: TabsPersistenceFailure = {
        operation: "save",
        code: "invalid-data",
        message: "existing recovery snapshot could not be loaded",
      };
      showPersistenceFailure(error);
      return { ok: false as const, error };
    }
    const result = forClose ? tabsStore.saveForClose(key, data) : tabsStore.saveResult(key, data);
    if (result.ok) setPersistenceWarning("");
    else showPersistenceFailure(result.error);
    return result;
  };
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    const snapshot = snapshotTabs();
    const saved = tabsConnKey ? persistRecovery(tabsConnKey, snapshot, true) : null;
    const unsafeDirty = saved?.ok === false && snapshot.tabs.some((tab) => tab.dirty);
    if (allowNativeClose || (!transactionOpen(transaction()) && !unsafeDirty && totalPendingCount() === 0)) return;
    e.preventDefault();
    e.returnValue = "";
  };
  const refreshTransactionStatus = async () => {
    const c = conn();
    if (!c || running() || fetchingMore() || importBusy() || commitBusy()) return;
    try {
      const status = await invoke<TransactionStatus>("transaction_status", { connectionId: c.id });
      if (connectionCurrent(c)) applyAuthoritativeTransaction(status, c.generation);
    } catch {
      /* The next transaction-aware command will surface a connection failure. */
    }
  };
  const onWindowFocus = () => void refreshTransactionStatus();
  let appMounted = true;
  onMount(async () => {
    transactionTimer = setInterval(() => {
      if (transactionOpen(transaction())) setTransactionNow(Date.now());
    }, 1000);
    try {
      const unlistenClose = await getCurrentWindow().onCloseRequested((event) => {
        if (allowNativeClose) return;
        if (closeOperationBusy()) {
          event.preventDefault();
          const tabId = runningTabId() ?? activeTabId();
          patchResult(tabId, { status: "Cancel or wait for the database operation before closing Tusk" });
          return;
        }
        if (transactionOpen(transaction())) {
          event.preventDefault();
          const owner = transaction().owner;
          if (owner && tabs().some((tab) => tab.id === owner)) switchTab(owner);
          setTransactionResolution({ kind: "window-close" });
          return;
        }
        const snapshot = snapshotTabs();
        const saved = tabsConnKey ? persistRecovery(tabsConnKey, snapshot, true) : null;
        if (saved?.ok === false && snapshot.tabs.some((tab) => tab.dirty)) {
          event.preventDefault();
          return;
        }
        const pending = totalPendingCount();
        if (pending > 0) {
          event.preventDefault();
          setConfirmWindowClose(pending);
        }
      });
      if (!appMounted) unlistenClose(); else nativeCloseUnlisten = unlistenClose;
    } catch {
      /* Browser preview has no native close event; beforeunload remains the fallback. */
    }
    void refreshSkills();
    // Suppress the WebView's native right-click menu app-wide; the sidebar shows
    // its own context menu, and the editor uses keyboard shortcuts for copy/paste.
    document.addEventListener("contextmenu", preventNativeContextMenu);
    // Window-level editor/tab shortcuts (the in-editor keymap owns Mod-Enter/Shift-Alt-f/
    // Mod-f/Tab — no overlap with T/W/S/O). preventDefault so Cmd-W closes the tab, not the window.
    window.addEventListener("keydown", onWindowKey);
    // Shrinking the window re-clamps every docked panel (see clampPanels).
    window.addEventListener("resize", clampPanels);
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("beforeunload", onBeforeUnload);
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
      const statusUnlisten = await listen<SlackStatus>("slack:status", (e) => {
        slackStatusRevision++;
        setSlackStatus(e.payload);
      });
      if (!appMounted) statusUnlisten(); else slackUnlisten.push(statusUnlisten);
    } catch {
      /* status events unavailable; the snapshot below still initializes the badge */
    }
    try {
      const executedUnlisten = await listen<SlackExecuted>("slack:executed", (e) => {
        const p = e.payload;
        const historyKey = slackHistoryKey(p, slackHistoryKeys);
        if (!historyKey) return;
        recordHistory({
          sql: `-- [Slack] asked by ${p.slackUser}\n${p.sql}`,
          durationMs: p.durationMs,
          status: p.status === "ok" ? "ok" : "error",
          rows: p.rows ?? null,
          error: p.error ? p.error.split("\n")[0] : null,
          schema: null,
        }, historyKey);
      });
      if (!appMounted) executedUnlisten(); else slackUnlisten.push(executedUnlisten);
    } catch {
      /* Slack audit events unavailable */
    }
    const statusRevision = slackStatusRevision;
    void invoke<SlackStatus>("slack_status")
      .then((current) => {
        if (appMounted && slackStatusRevision === statusRevision) setSlackStatus(current);
      })
      .catch(() => {});
  });
  onCleanup(() => {
    appMounted = false;
    skillsGeneration++;
    document.removeEventListener("contextmenu", preventNativeContextMenu);
    window.removeEventListener("keydown", onWindowKey);
    window.removeEventListener("resize", clampPanels);
    window.removeEventListener("focus", onWindowFocus);
    window.removeEventListener("beforeunload", onBeforeUnload);
    for (const u of slackUnlisten) u();
    clearTimeout(importCloseTimer);
    clearTimeout(saveTimer);
    if (transactionTimer) clearInterval(transactionTimer);
    nativeCloseUnlisten?.();
    for (const timer of runTimers) clearInterval(timer);
    runTimers.clear();
    for (const cleanup of [...interactionCleanups]) cleanup();
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
      case "commitTransaction": void runTransactionControl("COMMIT"); break;
      case "rollbackTransaction": void runTransactionControl("ROLLBACK"); break;
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
      case "openHelp": setHelpOpen((v) => !v); break;
      case "showWhatsNew": setWhatsNewRequest((n) => n + 1); break;
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
    if (paramPrompt()) return; // the parameter modal owns input; never replace its live state
    if (runChoice()) return;
    const k = normalizeKeyEvent(e);
    if (!k) return;
    const id = globalBindings().get(k);
    if (!id) return;
    // Modal surfaces own all keyboard input. In particular, Mod+W/S/Enter must not
    // close, save, or run the editor hidden behind a confirmation/form dialog.
    // A short allowlist stays reachable: F1 must close the manual it opened, and a
    // running query must stay cancellable while any dialog is up.
    if (
      id !== "openHelp" &&
      id !== "cancelQuery" &&
      document.querySelector("[data-blocking-dialog='true'], .modal-overlay")
    ) return;
    // On the connect screen only screen-independent actions fire (manual, settings).
    // Shortcuts/What's-new render in the shared tail like Settings — usable disconnected.
    if (!conn() && id !== "openHelp" && id !== "openSettings" && id !== "openShortcuts" && id !== "showWhatsNew") return;
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
      setProfiles([]);
      setConnErr(`could not load saved profiles: ${errMsg(e)}`);
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

  async function afterConnect(
    r: { connection_id: string; server_version: string; read_only: boolean },
    meta: { key: string; legacyKey: string | null; target: string; driver: string },
  ) {
    const connected: Connected = {
      id: r.connection_id,
      version: r.server_version,
      readOnly: r.read_only,
      driver: meta.driver,
      generation: ++connectionGeneration,
      key: meta.key,
      target: meta.target,
    };
    tabsConnKey = meta.key;
    tabsRecoveryWritable = true;
    setPersistenceWarning("");
    slackHistoryKeys.set(connected.id, connected.key);
    if (slackHistoryKeys.size > 100) slackHistoryKeys.delete(slackHistoryKeys.keys().next().value!);
    setTransaction({ ...IDLE_TRANSACTION });
    setTransactionStartedAt(null);
    transactionHistoryKey = null;
    deferredSchemaRefresh = false;
    setTransactionWarning("");
    try {
      const interrupted = decodeInterruptedTransaction(localStorage.getItem(INTERRUPTED_TRANSACTION_KEY));
      if (interrupted?.connectionKey === meta.key.slice(0, 2048)) {
        setTransactionWarning(`Previous ${interrupted.mode === "autocommit_off" ? "autocommit-off unit" : "manual transaction"} ${interrupted.transactionId} was interrupted. No active state was restored; verify its outcome.`);
      }
    } catch {
      /* Advisory recovery warning only. */
    }
    setConn(connected);
    sampleCache.clear();
    try {
      const status = await invoke<TransactionStatus>("transaction_status", { connectionId: r.connection_id });
      if (!connectionCurrent(connected)) return;
      applyAuthoritativeTransaction(status, connected.generation);
    } catch {
      if (!connectionCurrent(connected)) return;
    }
    try {
      const next = await invoke<Capabilities>("capabilities", { connectionId: r.connection_id });
      if (!connectionCurrent(connected)) return;
      setCaps(next);
    } catch {
      if (!connectionCurrent(connected)) return;
      setCaps(null);
    }
    // DuckDB: probe PG-style EXPLAIN options once, at connect (safe — nothing
    // is streaming yet). Drives the Explain action's wrapping.
    duckJsonExplain = false;
    if (connectionKind() === "duckdb") {
      try {
        const probe = await invoke<QueryResult>("run_query", { connectionId: r.connection_id, ownerId: activeTabId(), sql: "EXPLAIN (FORMAT json) SELECT 1", pageSize: PAGE, searchPath: null });
        applyAuthoritativeTransaction(probe.transaction, connected.generation);
        if (!connectionCurrent(connected)) return;
        duckJsonExplain = true;
      } catch (e) {
        const embedded = transactionFromError(e);
        if (embedded) applyAuthoritativeTransaction(embedded, connected.generation);
        if (!connectionCurrent(connected)) return;
        duckJsonExplain = false;
      }
    }
    // Restore this connection's tab set (buffers/paths only — results are ephemeral).
    if (meta.key) {
      const current = tabsStore.loadResult(meta.key);
      let saved = current.ok ? current.value : null;
      if (!current.ok) {
        showPersistenceFailure(current.error);
        // An unreadable existing snapshot is not a failed write: park it aside so
        // this session can persist recovery normally (and disconnect/close aren't
        // blocked forever). Only when even the backup fails do writes stay off.
        const parked = tabsStore.quarantineResult(meta.key);
        if (!parked.ok) {
          tabsRecoveryWritable = false;
          showPersistenceFailure(parked.error);
        }
      }
      // A legacy fallback is valid only when the new key is genuinely absent. A load
      // failure must not resurrect stale data over an unreadable current snapshot.
      if (current.ok && current.value === null && meta.legacyKey) {
        const legacy = tabsStore.loadResult(meta.legacyKey);
        if (!legacy.ok) showPersistenceFailure(legacy.error);
        else if (legacy.value) {
          saved = legacy.value;
          const migrated = persistRecovery(meta.key, legacy.value);
          if (migrated.ok) {
            const removed = tabsStore.removeResult(meta.legacyKey);
            if (!removed.ok) showPersistenceFailure(removed.error);
          } else {
            tabsConnKey = meta.legacyKey;
          }
        }
      }
      restoring = true;
      if (saved && saved.tabs.length) {
        const restored = saved.tabs.map((pt) =>
          makeTab({ sql: pt.sql, filePath: pt.filePath, title: pt.title, searchSchema: pt.searchSchema ?? null, dirty: pt.dirty }),
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
    const history = meta.legacyKey
      ? await historyStore.migrate(meta.legacyKey, meta.key)
      : await historyStore.load(meta.key);
    if (!connectionCurrent(connected)) return;
    setHistory(history);
    await loadSchema(connected);
  }

  async function doConnect(e: Event) {
    e.preventDefault();
    if (connecting()) return;
    setConnecting(true);
    setConnErr("");
    try {
      const submittedDriver = driver();
      const submittedPath = path();
      const submittedHost = host();
      const submittedUser = user();
      const submittedDatabase = dbname();
      const isFile = submittedDriver === "duckdb" || submittedDriver === "sqlite";
      const networkPort = Number(port());
      if (!isFile && (!Number.isInteger(networkPort) || networkPort < 1 || networkPort > 65535)) {
        throw new Error("port must be a whole number between 1 and 65535");
      }
      const config = isFile
        ? { driver: submittedDriver, path: submittedPath, read_only: readOnly() }
        : {
            driver: submittedDriver,
            host: submittedHost,
            port: networkPort,
            user: submittedUser,
            password: password(),
            dbname: submittedDatabase,
            sslmode: sslmode(),
            read_only: readOnly(),
          };
      const submittedLegacyKey = isFile
        ? `adhoc:${submittedDriver}:${submittedPath || ":memory:"}`
        : `adhoc:${submittedHost}:${networkPort}:${submittedDatabase}:${submittedUser}`;
      const submittedKey = `adhoc:${JSON.stringify(isFile
        ? [submittedDriver, submittedPath || ":memory:"]
        : [submittedDriver, submittedHost, networkPort, submittedDatabase, submittedUser])}`;
      const r = await invoke<{ connection_id: string; server_version: string; read_only: boolean }>("connect", { config });
      const submittedTarget = isFile
        ? basename(submittedPath || ":memory:")
        : submittedDatabase || submittedHost;
      await afterConnect(r, { key: submittedKey, legacyKey: submittedLegacyKey, target: submittedTarget, driver: submittedDriver });
    } catch (e) {
      setConnErr(errMsg(e));
    } finally {
      setConnecting(false);
    }
  }

  // Pick an existing DuckDB/SQLite database file (a new file can also be typed).
  async function browseDbFile() {
    try {
      const p = await openDialog({
        multiple: false,
        filters: [{ name: "Database", extensions: ["duckdb", "ddb", "db", "sqlite", "sqlite3"] }],
      });
      if (typeof p === "string") setPath(p);
    } catch (e) {
      setConnErr(errMsg(e));
    }
  }

  async function connectProfile(id: string) {
    if (connecting()) return;
    setConnecting(true);
    setConnErr("");
    try {
      const profile = profiles().find((p) => p.id === id);
      const r = await invoke<{ connection_id: string; server_version: string; read_only: boolean }>(
        "connect_profile",
        { id },
      );
      const target = profile
        ? isEmbeddedDriver(profile.driver) ? basename(profile.path || ":memory:") : profile.dbname || profile.host
        : id;
      await afterConnect(r, { key: `profile:${id}`, legacyKey: null, target, driver: profile?.driver ?? "postgres" });
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
      const networkPort = Number(port());
      if (!embedded && (!Number.isInteger(networkPort) || networkPort < 1 || networkPort > 65535)) {
        throw new Error("port must be a whole number between 1 and 65535");
      }
      const p = await invoke<Profile>("save_profile", {
        profile: {
          id: editingId(),
          name: name() || (embedded ? basename(path() || ":memory:") : host()),
          host: host(),
          port: networkPort,
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
    return recoverySnapshot(tabs(), activeTabId(), editorApi()?.getDoc());
  }

  async function disconnect(force = false, transactionResolved = false): Promise<boolean> {
    if (transactionOpen(transaction()) && !transactionResolved) {
      const owner = transaction().owner;
      if (owner && tabs().some((tab) => tab.id === owner)) switchTab(owner);
      setTransactionResolution({ kind: "disconnect" });
      return false;
    }
    const pending = totalPendingCount();
    if (pending && !force) {
      setConfirmDisconnect(pending);
      return false;
    }
    setConfirmDisconnect(null);
    const c = conn();
    clearTimeout(saveTimer);
    if (tabsConnKey) {
      const snapshot = snapshotTabs();
      const saved = persistRecovery(tabsConnKey, snapshot, true);
      // Dirty buffers are recoverable only after a verified write. Keep the workspace
      // open on failure; users can save files or retry once storage is available.
      if (!saved.ok && snapshot.tabs.some((tab) => tab.dirty)) return false;
    }
    if (c) {
      try {
        await invoke("disconnect", { connectionId: c.id });
      } catch (e) {
        const embedded = transactionFromError(e);
        if (embedded) applyAuthoritativeTransaction(embedded, c.generation);
        setTransactionWarning(`Disconnect failed: ${errMsg(e)}`);
        return false;
      }
    }
    if (c && transaction().state !== "lost") removeInterruptedMarker(c.key);
    connectionGeneration++;
    queryGeneration++;
    fetchGeneration++;
    schemaGeneration++;
    fkGeneration++;
    activeQuery = null;
    setRunning(false);
    setRunningTabId(null);
    setFetchingMore(false);
    setLoadingAll(false);
    setCancelling(false);
    for (const timer of runTimers) clearInterval(timer);
    runTimers.clear();
    tabsConnKey = null;
    tabsRecoveryWritable = true;
    setConn(null);
    setTransaction({ ...IDLE_TRANSACTION });
    setTransactionStartedAt(null);
    transactionHistoryKey = null;
    setCaps(null);
    setHistory([]);
    setHistoryOpen(false);
    setMenu(null);
    setActiveDialog(null);
    setCellView(null);
    setConfirmClose(null);
    setConfirmDisconnect(null);
    setConfirmWindowClose(null);
    setTransactionResolution(null);
    setTransactionResolutionBusy(false);
    setExportSrc(null);
    importReadGeneration++;
    clearTimeout(importCloseTimer);
    setImportBusy(false);
    setImportOpen(false);
    importOrigin = null;
    setImportData(null);
    setImportRaw(null);
    setConfirmAnalyze(null);
    setCommitView(null);
    transactionResolutionAfterApply = null;
    setConfirmDiscard(null);
    setRunChoice(null);
    setParamPrompt(null);
    setDdlGraph(null);
    setRenameTab(null);
    setPerms(null);
    setTree(null);
    setSelected(null);
    setSchemaLoading(false);
    setSchema([]);
    sampleCache.clear();
    setFuncs(new Set<string>());
    setDetails({});
    loadedRels.clear();
    detailInflight.clear();
    fkInFlight.clear();
    fkFetched.clear();
    setFkEdges([]);
    cursorOwner = null;
    cursorGeneration++;
    const fresh = makeTab();
    setTabs([fresh]);
    setActiveTabId(fresh.id);
    return true;
  }

  // Reflect the connected database in the OS window title (mascot + driver).
  createEffect(() => {
    const c = conn();
    const kind = connectionKind();
    const title = c ? `${driverMascot(kind)} Tusk — ${driverLabel(kind)}` : "Tusk";
    void getCurrentWindow().setTitle(title).catch(() => {
      /* not in a Tauri window (e.g. preview) */
    });
  });

  // Label for the connected target shown in the topbar chip: the database name for
  // server drivers, or the file basename (":memory:" when blank) for embedded ones.
  const connTarget = () => conn()?.target ?? "";

  // Debounced per-connection tab-set save as buffers/structure change.
  createEffect(() => {
    const data: PersistedTabs = {
      tabs: tabs().map((t) => ({ sql: t.sql, filePath: t.filePath, title: t.title, searchSchema: t.searchSchema, dirty: t.dirty })),
      activeIndex: Math.max(0, tabs().findIndex((t) => t.id === activeTabId())),
    };
    if (restoring || !tabsConnKey) return;
    const key = tabsConnKey;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persistRecovery(key, data), 800);
  });

  async function loadSchema(target = conn()) {
    const c = target;
    if (!c) return;
    if (!connectionCurrent(c)) return;
    if (metadataFrozen()) {
      deferredSchemaRefresh = true;
      return;
    }
    deferredSchemaRefresh = false;
    const transactionRevision = transaction().revision;
    const operation = ++schemaGeneration;
    const isCurrent = () => connectionCurrent(c) && schemaGeneration === operation && transaction().revision === transactionRevision && !metadataFrozen();
    fkGeneration++;
    fkFetched.clear();
    setFkEdges([]);
    setMenuState(null);
    interruptStream("a schema refresh closed the result stream");
    setSchemaLoading(true);
    sampleCache.clear(); // schema (and likely data) may have changed — drop stale AI samples
    try {
      const t = await invoke<DbTree>("db_tree", { connectionId: c.id });
      if (!isCurrent()) return;
      setTree(t);
      // Prune cached detail for relations that no longer exist (dropped / renamed),
      // so refreshLoadedDetails doesn't keep re-fetching dead keys.
      const live = new Set<string>();
      for (const s of t.schemas) for (const r of [...s.tables, ...s.views]) live.add(relKey(s.name, r.name));
      for (const k of [...loadedRels.keys()]) if (!live.has(k)) loadedRels.delete(k);
      setDetails((prev) => {
        const next: Record<string, RelationDetail> = {};
        for (const k of Object.keys(prev)) if (live.has(k)) next[k] = prev[k];
        return next;
      });
      void loadTables(c, operation);
      void refreshLoadedDetails(c, operation);
      // Refresh effective privileges alongside the tree (grants/ownership can change).
      invoke<Permissions>("permissions", { connectionId: c.id })
        .then((p) => { if (isCurrent()) setPerms(p); })
        .catch(() => { if (isCurrent()) setPerms(null); });
    } catch (e) {
      console.error(e);
    } finally {
      if (isCurrent()) setSchemaLoading(false);
    }
  }

  // Full table+column list for autocomplete (decoupled from the lazy tree),
  // plus the live function catalog feeding the unknown-function lint (empty
  // set = engine can't enumerate → that lint stays off).
  async function loadTables(target = conn(), schemaOperation = schemaGeneration) {
    const c = target;
    if (!c || metadataFrozen()) return;
    const transactionRevision = transaction().revision;
    const isCurrent = () => connectionCurrent(c) && schemaGeneration === schemaOperation && transaction().revision === transactionRevision && !metadataFrozen();
    try {
      const tables = await invoke<TableInfo[]>("list_schema", { connectionId: c.id });
      if (!isCurrent()) return;
      setSchema(tables);
    } catch (e) {
      if (!isCurrent()) return;
      console.error(e);
    }
    try {
      const names = await invoke<string[]>("list_functions", { connectionId: c.id });
      if (!isCurrent()) return;
      setFuncs(new Set(names.map((n) => n.toLowerCase())));
    } catch {
      if (!isCurrent()) return;
      setFuncs(new Set<string>());
    }
    // FK catalog for JOIN completion: active schema + public, merged.
    const activeSchema = activeTab().searchSchema ?? "public";
    await fetchFkSchema(activeSchema, c);
    if (activeSchema !== "public") await fetchFkSchema("public", c);
  }

  /** Make sure the AI's join graph is loaded before a send: the same schemas autocomplete
   *  primes (active + public). Without this the panel would ship an empty `fks` on the
   *  first question of a session and the model would guess joins. */
  async function ensureAiFks() {
    const c = conn();
    if (!c || metadataFrozen()) return;
    await Promise.all([...aiFkSchemas()].map((n) => fetchFkSchema(n, c)));
  }

  /** Fetch one schema's FK edges into fkEdges (deduped; best-effort). */
  async function fetchFkSchema(schemaName: string, target = conn()) {
    const c = target;
    if (!c || metadataFrozen() || caps()?.relationships === false || fkFetched.has(schemaName)) return;
    // A best-effort completion hint must never roll back a live result stream; the
    // next keystroke/tab switch retries once the stream has drained.
    if (cursorOwner !== null) return;
    const generation = fkGeneration;
    const transactionRevision = transaction().revision;
    const inflightKey = `${c.id}:${generation}:${schemaName}`;
    if (fkInFlight.has(inflightKey)) return;
    fkInFlight.add(inflightKey);
    try {
      const g = await invoke<{ tables: unknown[]; edges: FkEdge[] }>("schema_relationships", { connectionId: c.id, schema: schemaName });
      if (!connectionCurrent(c) || fkGeneration !== generation || transaction().revision !== transactionRevision || metadataFrozen()) return;
      // Mark fetched ONLY on success. `fksKnown` (which gates the AI prompt's "this schema
      // declares no foreign keys" claim) is derived from this set — marking before the
      // await meant a FAILED fetch asserted the schema had no FKs, the exact lie the
      // tri-state exists to prevent. A failure stays unmarked so the next send retries.
      fkFetched.add(schemaName);
      setFkEdges((prev) => {
        const key = (e: FkEdge) => JSON.stringify([e.constraint, e.srcSchema, e.srcTable]);
        const seen = new Set(prev.map(key));
        return [...prev, ...g.edges.filter((e) => !seen.has(key(e)))];
      });
    } catch {
      /* best-effort — completion just has fewer hints, and the prompt stays silent on FKs */
    } finally {
      fkInFlight.delete(inflightKey);
    }
  }

  // Lazy-load one relation's detail on expand; cached unless `force`.
  async function loadDetail(schemaName: string, name: string, force = false, target = conn()) {
    const c = target;
    if (!c || metadataFrozen()) return;
    const generation = schemaGeneration;
    const transactionRevision = transaction().revision;
    const key = relKey(schemaName, name);
    const inflightKey = `${c.id}:${generation}:${key}`;
    if (!force && (details()[key] || detailInflight.has(inflightKey))) return;
    detailInflight.add(inflightKey);
    interruptStream("expanding a relation in the Explorer closed the result stream");
    try {
      const d = await invoke<RelationDetail>("table_detail", {
        connectionId: c.id,
        schema: schemaName,
        name,
      });
      if (!connectionCurrent(c) || schemaGeneration !== generation || transaction().revision !== transactionRevision || metadataFrozen()) return;
      loadedRels.set(key, { schema: schemaName, name });
      setDetails((prev) => ({ ...prev, [key]: d }));
    } catch (e) {
      console.error(e);
    } finally {
      detailInflight.delete(inflightKey);
      // A schema refresh can supersede the first detail request before it ever
      // reaches the cache. Retry under the new generation so an expanded row or
      // editability probe cannot remain stuck on "loading table info...".
      if (connectionCurrent(c) && !metadataFrozen() && schemaGeneration !== generation && !details()[key])
        void loadDetail(schemaName, name, force, c);
    }
  }

  // Re-fetch detail for every already-expanded relation (after refresh / DDL).
  async function refreshLoadedDetails(target = conn(), schemaOperation = schemaGeneration) {
    for (const { schema, name } of loadedRels.values()) {
      if (schemaGeneration !== schemaOperation) return;
      await loadDetail(schema, name, true, target);
    }
  }

  const sameColumns = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

  // Record a finished user-issued run into the per-connection history (never a
  // grid sort/filter re-run, never blocks the query path on storage failures).
  const recordHistory = (e: Omit<HistoryEntry, "id" | "ts">, key: string) => {
    const ts = Date.now();
    const next = historyStore.append(key, { id: makeEntryId(ts), ts, ...e });
    if (conn()?.key === key) setHistory(next);
  };

  const historySqlForTransaction = (
    sqlText: string,
    before: TransactionStatus,
    after: TransactionStatus,
    event: TransactionEvent,
    priorHistoryKey: string | null = transactionHistoryKey,
  ) => {
    const key = transactionHistoryScope(before, after, event, transactionHistoryKey, priorHistoryKey);
    return transactionHistorySql(sqlText, key, after.revision, event);
  };

  // Shared query executor. `mode:"base"` = a user-issued query (resets sorts/filters,
  // fresh grid view if the column set changed); `mode:"wrapped"` = a sort/filter re-run
  // (keep the grid view — its sorts/filters drive the wrap).
  async function executeQuery(
    sqlToRun: string,
    base: string,
    mode: "base" | "wrapped",
    force = false,
    historySql = sqlToRun,
  ): Promise<boolean> {
    const c = conn();
    if (!c || running() || !sqlToRun.trim()) return false;
    const runTabId = activeTabId();
    const runTab = tabs().find((t) => t.id === runTabId);
    if (!runTab) return false;
    const event = transactionEvent(sqlToRun);
    if (!transactionDatabaseAllowed(transaction(), runTabId)) {
      patchResult(runTabId, { status: transaction().state === "lost"
        ? "Transaction session lost; disconnect and reconnect"
        : `Database actions are frozen in this tab while ${ownerTab()?.title ?? transaction().owner ?? "another tab"} owns the transaction` });
      return false;
    }
    if (!transactionRecoveryAllowed(transaction(), sqlToRun)) {
      patchResult(runTabId, { status: "Transaction failed; ROLLBACK is required before any other database action" });
      return false;
    }
    // Re-running replaces the rows the pending edits index into — confirm first.
    const pcount = pendingCount(runTab.pending);
    if (pcount && !force) {
      const origin = captureOrigin();
      setConfirmDiscard({
        count: pcount,
        origin,
        run: () => { if (originCurrent(origin, true)) void executeQuery(sqlToRun, base, mode, true, historySql); },
      });
      return false;
    }
    if (pcount) patchTab(runTabId, { pending: undefined });
    // Running with the results panel collapsed would hide the output — reopen it.
    if (!resultsOpen()) { setResultsOpen(true); persistLayout(); }
    const runSchema = runTab.searchSchema;
    if (cursorOwner && cursorOwner.tabId !== runTabId) interruptStream(`stream closed when "${runTab.title}" ran a query`);
    cursorOwner = null;
    cursorGeneration++;
    fetchGeneration++;
    setFetchingMore(false);
    setMenuState(null);
    patchResult(runTabId, { runErr: "", status: "" });
    patchTab(runTabId, { resultView: undefined }); // a new run resets the Plan/Grid choice
    const runGeneration = ++queryGeneration;
    const before = transaction();
    const beforeHistoryKey = transactionHistoryKey;
    let expectedTransactionRevision = before.revision;
    activeQuery = { generation: runGeneration, connectionGeneration: c.generation, tabId: runTabId, transactionRevision: before.revision };
    const originCurrentForRun = () =>
      activeQuery?.generation === runGeneration &&
      activeQuery.connectionGeneration === c.generation &&
      activeQuery.tabId === runTabId &&
      connectionCurrent(c) &&
      tabs().some((t) => t.id === runTabId);
    const isCurrent = () => originCurrentForRun() && transaction().revision === expectedTransactionRevision;
    setRunning(true);
    setRunningTabId(runTabId);
    const t0 = performance.now();
    setRunMs(0);
    const timer = setInterval(() => {
      if (isCurrent()) setRunMs(performance.now() - t0);
    }, 200);
    runTimers.add(timer);
    let completed = false;
    try {
      // In-grid editing needs the target table's detail (PK/columns). Fetching it AFTER
      // the run would roll back the result's cursor and truncate the stream, so resolve
      // the target from the (pre-execution) base query and load it now, while no
      // stream is open and `running` already excludes a concurrent run. Best-effort:
      // a failure just leaves the grid read-only.
      if (mode === "base" && base && !transactionOpen(transaction())) {
        try {
          const tgt = editTarget(base, editIndexer(schema()), runTab.searchSchema);
          if (tgt.ok && !details()[relKey(tgt.table.schema, tgt.table.name)]) await loadDetail(tgt.table.schema, tgt.table.name);
        } catch { /* read-only grid until the detail loads later */ }
        if (!isCurrent()) return false;
      }
      const out = await invoke<QueryResult>("run_query", { connectionId: c.id, ownerId: runTabId, sql: sqlToRun, pageSize: PAGE, searchPath: runSchema });
      expectedTransactionRevision = out.transaction.revision;
      const accepted = applyAuthoritativeTransaction(out.transaction, c.generation, event, before);
      if (!accepted || !isCurrent()) return false;
      const rt = tabs().find((t) => t.id === runTabId);
      const epoch = (rt?.result.epoch ?? 0) + 1;
      const loadedGeneration = ++resultGeneration;
      if (out.kind === "rows") {
        const prevCols = rt?.result.columns ?? [];
        patchResult(runTabId, {
          columns: out.columns, rows: out.rows, done: out.done, lastQuery: sqlToRun, baseQuery: base, epoch, generation: loadedGeneration,
          incomplete: "",
          rowsAreBase: mode === "base" || sqlToRun === base,
          status: `${out.rows.length}${out.done ? "" : "+"} rows${out.note ? ` · ${out.note}` : ""}`,
          transactionId: transactionOpen(out.transaction) ? out.transaction.id : null,
          transactionRevision: out.transaction.revision,
          transactionStale: "",
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
        if (!out.done) {
          cursorOwner = {
            tabId: runTabId,
            connectionGeneration: c.generation,
            resultGeneration: loadedGeneration,
            cursorGeneration: ++cursorGeneration,
          };
        }
      } else {
        patchResult(runTabId, {
          columns: [], rows: [], done: true, incomplete: "", lastQuery: sqlToRun, baseQuery: base, rowsAreBase: false, epoch, generation: loadedGeneration, status: out.message,
          transactionId: transactionOpen(out.transaction) ? out.transaction.id : null,
          transactionRevision: out.transaction.revision,
          transactionStale: "",
        });
        if (mode === "base") patchTab(runTabId, { gridView: gridViewFor(0) });
      }
      if (out.kind === "exec" || DDL_RE.test(sqlToRun)) void loadSchema(c);
      if (mode === "base") {
        recordHistory({
          sql: historySqlForTransaction(historySql, before, out.transaction, event, beforeHistoryKey),
          durationMs: Math.round(performance.now() - t0),
          status: "ok",
          rows: out.kind === "rows" ? out.rows.length : null,
          error: null,
          schema: runSchema,
        }, c.key);
      }
      completed = true;
    } catch (e) {
      const embedded = transactionFromError(e);
      if (embedded) {
        expectedTransactionRevision = embedded.revision;
        if (!applyAuthoritativeTransaction(embedded, c.generation, event, before)) return false;
      }
      if (!isCurrent()) return false;
      const msg = errMsg(e);
      const failed = tabs().find((t) => t.id === runTabId);
      const failedResult = {
        epoch: (failed?.result.epoch ?? 0) + 1,
        generation: ++resultGeneration,
        lastQuery: sqlToRun,
        baseQuery: base,
        incomplete: "",
        transactionId: transactionOpen(transaction()) ? transaction().id : null,
        transactionRevision: transaction().revision,
        transactionStale: transaction().state === "lost" ? "transaction session lost; result provenance is no longer trustworthy" : "",
      };
      // A user cancel surfaces as Postgres' "canceling statement due to user request" —
      // present it as a calm status, not a red error banner.
      if (/cancel/i.test(msg)) patchResult(runTabId, { ...failedResult, runErr: "", status: "Query cancelled", columns: [], rows: [], done: true });
      else patchResult(runTabId, { ...failedResult, runErr: msg, columns: [], rows: [], done: true });
      if (mode === "base") {
        recordHistory({
          sql: historySqlForTransaction(historySql, before, embedded ?? transaction(), event, beforeHistoryKey),
          durationMs: Math.round(performance.now() - t0),
          status: /cancel/i.test(msg) ? "cancelled" : "error",
          rows: null,
          error: msg.split("\n")[0],
          schema: runSchema,
        }, c.key);
      }
    } finally {
      clearInterval(timer);
      runTimers.delete(timer);
      if (activeQuery?.generation === runGeneration) {
        activeQuery = null;
        setRunning(false);
        setRunningTabId(null);
        setCancelling(false);
        if (connectionCurrent(c) && tabs().some((t) => t.id === runTabId))
          patchResult(runTabId, { elapsed: Math.round(performance.now() - t0) });
      }
    }
    return completed;
  }

  async function runTransactionControl(sqlText: string): Promise<boolean> {
    const tx = transaction();
    if (transactionControlBusy()) return false;
    if (transactionOpen(tx)) {
      if (tx.state === "lost") {
        setStatus("Transaction session lost; disconnect and reconnect");
        return false;
      }
      if (tx.owner !== activeTabId()) {
        setStatus(`Switch to ${ownerTab()?.title ?? "the transaction owner"} first`);
        return false;
      }
      if (ownerPendingCount()) {
        setStatus("Apply or discard pending grid changes before ending the transaction");
        return false;
      }
    }
    return executeQuery(sqlText, "", "base", false, sqlText);
  }

  function openTransactionStartMenu(e: MouseEvent) {
    if (running() || transactionOpen(transaction())) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = [
      { label: "Begin transaction", icon: "play", onClick: () => void runTransactionControl("BEGIN") },
    ];
    if (caps()?.setTransaction) {
      items.push({
        label: "Begin read-only transaction",
        icon: "lock",
        onClick: () => void runTransactionControl(connectionKind() === "mysql" ? "START TRANSACTION READ ONLY" : "BEGIN READ ONLY"),
      });
    }
    if (caps()?.autocommitMode) {
      items.push({ sep: true }, { label: "Turn autocommit off", icon: "edit", onClick: () => void runTransactionControl("SET autocommit=0") });
    }
    setMenu({ x: rect.left, y: rect.bottom + 4, items });
  }

  async function closeNativeWindow(forcePending = false): Promise<boolean> {
    if (closeOperationBusy()) {
      patchResult(runningTabId() ?? activeTabId(), { status: "Cancel or wait for the database operation before closing Tusk" });
      return false;
    }
    if (transactionOpen(transaction())) {
      const owner = transaction().owner;
      if (owner && tabs().some((tab) => tab.id === owner)) switchTab(owner);
      setTransactionResolution({ kind: "window-close" });
      return false;
    }
    if (tabsConnKey) {
      const snapshot = snapshotTabs();
      const saved = persistRecovery(tabsConnKey, snapshot, true);
      if (!saved.ok && snapshot.tabs.some((tab) => tab.dirty)) return false;
    }
    const pending = totalPendingCount();
    if (pending > 0 && !forcePending) {
      setConfirmWindowClose(pending);
      return false;
    }
    setConfirmWindowClose(null);
    allowNativeClose = true;
    try {
      await getCurrentWindow().close();
      return true;
    } catch {
      allowNativeClose = false;
      return false;
    }
  }

  function continueAfterTransactionResolution(intent: TransactionResolution) {
    if (intent.kind === "close-tab") closeTab(intent.tabId);
    else if (intent.kind === "disconnect") void disconnect();
    else void closeNativeWindow();
  }

  async function resolveTransaction(action: "commit" | "rollback") {
    const intent = transactionResolution();
    const tx = transaction();
    if (!intent || transactionResolutionBusy() || transactionControlBusy() || tx.state === "lost" || ownerPendingCount()) return;
    const owner = tx.owner;
    if (!owner || !tabs().some((tab) => tab.id === owner)) return;
    if (tx.state === "configured" && action === "commit") return;
    switchTab(owner);
    setTransactionResolutionBusy(true);
    const command = tx.state === "configured"
      ? "START TRANSACTION; ROLLBACK"
      : tx.mode === "autocommit_off"
      ? `${action === "commit" ? "COMMIT" : "ROLLBACK"}; SET autocommit=1`
      : action === "commit" ? "COMMIT" : "ROLLBACK";
    try {
      const ok = await runTransactionControl(command);
      if (ok && !transactionOpen(transaction())) {
        setTransactionResolution(null);
        continueAfterTransactionResolution(intent);
      }
    } finally {
      setTransactionResolutionBusy(false);
    }
  }

  async function disconnectLostTransaction() {
    const intent = transactionResolution();
    if (!intent || transactionResolutionBusy()) return;
    setTransactionResolutionBusy(true);
    const warning = transactionWarning() || "Transaction session was lost; reconnect and verify its outcome.";
    try {
      const disconnected = await disconnect(true, true);
      if (!disconnected) return;
      setConnErr(warning);
      if (intent.kind === "window-close") await closeNativeWindow(true);
    } finally {
      if (conn()) setTransactionResolutionBusy(false);
    }
  }

  // Cancel the in-flight query (re-clicking Run): fire a Postgres CancelRequest; the
  // run_query call then errors out and unwinds through executeQuery's finally.
  function cancelQuery() {
    if (!running() || cancelling()) return;
    if (caps()?.cancelQuery === false) {
      patchResult(runningTabId() ?? activeTabId(), { status: "This engine cannot cancel a running query — wait for it to finish" });
      return;
    }
    setCancelling(true);
    void cancelOperation(conn()?.id, runningTabId() ?? activeTabId());
  }

  // Run-target chooser: when Run is hit with the cursor inside one of several statements
  // (and nothing selected), ask whether to run the whole file or just that block.
  const [runChoice, setRunChoice] = createSignal<{ x: number; y: number; origin: UiOrigin } | null>(null);
  let runBtnRef: HTMLButtonElement | undefined;

  // Pre-run parameter prompt state: every run path (Run button, gutter ▶,
  // selection, history re-run, Explain) funnels through runText, so detection
  // lives here once.
  const [paramPrompt, setParamPrompt] = createSignal<{
    text: string;
    params: Param[];
    tabId: string;
    origin: UiOrigin;
    onRun: (substituted: string) => void;
  } | null>(null);

  function runParameterized(t: string, onRun: (substituted: string) => void) {
    const params = detectParams(t);
    if (!params.length) {
      onRun(t);
      return;
    }
    // Global shortcuts are blocked while this is open. Keep this guard too for
    // programmatic paths so a second run cannot swap props under a live dialog.
    if (paramPrompt()) return;
    setParamPrompt({ text: t, params, tabId: activeTabId(), origin: captureOrigin(), onRun });
  }

  function runText(t: string) {
    runParameterized(t, (substituted) => runTextNow(substituted, t));
  }

  function runTextNow(t: string, historySql = t) {
    // A multi-statement run is one atomic script and returns only its summary, so there is
    // no isolated SELECT to re-wrap. Store a non-wrappable base and disable grid rules.
    // Conservative: any inner `;` counts as multi (never wrongly wrappable).
    const inner = stripTrailingSemi(t);
    const base = inner.includes(";") ? "" : inner;
    const at = activeTab();
    // Re-running the SAME query text (no edits) while the grid has active sort/filter
    // rules carries them over: re-stream the wrapped query instead of resetting to the
    // raw result. Any edit to the query text breaks the match → fresh result (rules reset).
    if (
      !transactionOpen(transaction()) &&
      base !== "" &&
      base === stripTrailingSemi(at.result.baseQuery) &&
      wrappableQuery(base) &&
      hasViewRules(at.gridView.sorts, at.gridView.filters)
    ) {
      const gv = at.gridView;
      const wrapped = tryWrapQuery(at, gv.sorts, gv.filters);
      if (wrapped !== null) void executeQuery(wrapped, base, "wrapped");
      return;
    }
    void executeQuery(t, base, "base", false, historySql);
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
      setRunChoice(r
        ? { x: r.left, y: r.bottom + 6, origin: captureOrigin() }
        : { x: 16, y: 84, origin: captureOrigin() });
      return;
    }
    // Single statement (or no editor) → run the whole buffer.
    runText(api?.getRunText() ?? sql());
  }

  function chooseRun(which: "block" | "file") {
    const choice = runChoice();
    setRunChoice(null);
    if (!choice || !originCurrent(choice.origin)) return;
    const api = editorApi();
    if (!api) return;
    runText(which === "block" ? api.getCurrentStatement() : api.getDoc());
  }

  // Re-stream the active tab's result sorted/filtered (server ORDER BY / WHERE).
  function onSortFilter(sorts: SortKey[], filters: Filter[], kind: "sort" | "filter") {
    const prior = { sorts: activeTab().gridView.sorts, filters: activeTab().gridView.filters };
    setGridView({ sorts, filters });
    const tab = activeTab();
    if (kind === "sort" && localSortEligible() && filters.length === 0) {
      patchResult(tab.id, { epoch: tab.result.epoch + 1 });
      return;
    }
    const base = tab.result.baseQuery;
    if (!activeDatabaseAllowed() || !canServerSortFilter()) return;
    const sqlToRun = hasViewRules(sorts, filters) ? tryWrapQuery(tab, sorts, filters) : base;
    if (sqlToRun === null) {
      // Wrap refused (unwrappable base, duplicate filter names) — no query will
      // run, so don't leave a sort glyph/filter chip pretending it applied.
      setGridView(prior);
      return;
    }
    void executeQuery(sqlToRun, base, "wrapped");
  }

  async function loadMore() {
    const c = conn();
    const id = activeTabId();
    if (!c || done() || fetchingMore() || !transactionDatabaseAllowed(transaction(), id)) return;
    const owner = cursorOwner;
    const tab = tabs().find((t) => t.id === id);
    if (!owner || owner.tabId !== id || owner.connectionGeneration !== c.generation || tab?.result.generation !== owner.resultGeneration) return;
    const operation = ++fetchGeneration;
    const before = transaction();
    let expectedTransactionRevision = before.revision;
    const isCurrent = () =>
      fetchGeneration === operation &&
      connectionCurrent(c) &&
      cursorOwner?.cursorGeneration === owner.cursorGeneration &&
      cursorOwner.resultGeneration === owner.resultGeneration &&
      tabs().find((t) => t.id === id)?.result.generation === owner.resultGeneration &&
      transaction().revision === expectedTransactionRevision;
    setFetchingMore(true);
    try {
      const r = await invoke<FetchResult>("fetch_more", { connectionId: c.id, ownerId: id, pageSize: PAGE });
      expectedTransactionRevision = r.transaction.revision;
      if (!applyAuthoritativeTransaction(r.transaction, c.generation, "statement", before) || !isCurrent()) return;
      // Read the captured tab's rows (the user may have switched tabs during the fetch).
      const prev = tabs().find((t) => t.id === id)?.result.rows ?? [];
      const merged = r.rows.length ? [...prev, ...r.rows] : prev;
      if (r.interrupted) {
        // The backend found our cursor already closed by an intervening command
        // (metadata read, Explorer DDL, export, import) that the frontend didn't
        // intercept. Never present the partial rows as the full result.
        patchResult(id, { rows: merged, ...interruptedResult({ rows: merged, done: false }, "the result stream was closed by another database action") });
      } else {
        patchResult(id, { rows: merged, done: r.done, status: `${merged.length}${r.done ? "" : "+"} rows` });
      }
      if (r.done) {
        cursorOwner = null;
        cursorGeneration++;
      }
    } catch (e) {
      const embedded = transactionFromError(e);
      if (embedded) {
        expectedTransactionRevision = embedded.revision;
        if (!applyAuthoritativeTransaction(embedded, c.generation, "statement", before)) return;
      }
      if (!isCurrent()) return;
      // Streaming broke (e.g. connection dropped mid-fetch). Surface it instead of
      // silently marking the result complete — show the error banner over the rows
      // fetched so far, and stop paging so we don't hammer a dead cursor.
      const msg = errMsg(e);
      patchResult(id, { runErr: msg, status: `streaming stopped — ${msg}`, done: true, incomplete: `streaming stopped — ${msg}` });
      cursorOwner = null;
      cursorGeneration++;
    } finally {
      if (fetchGeneration === operation) setFetchingMore(false);
    }
  }

  // Drain the cursor to completion (or cancel). Yields between pages to stay responsive.
  async function loadAll() {
    if (loadingAll()) { cancelAll = true; return; }
    const id = activeTabId();
    const ownerGeneration = cursorOwner?.cursorGeneration;
    setLoadingAll(true);
    cancelAll = false;
    while (
      !cancelAll &&
      !tabs().find((t) => t.id === id)?.result.done &&
      cursorOwner?.tabId === id &&
      cursorOwner.cursorGeneration === ownerGeneration &&
      activeTabId() === id
    ) {
      await loadMore();
      await new Promise((r) => setTimeout(r));
    }
    setLoadingAll(false);
  }

  function tableNameFromSql(s: string): string {
    const m = /from\s+(?:"?[\w]+"?\.)?"?([\w]+)"?/i.exec(s);
    return m ? m[1] : "export";
  }

  async function exportToFile(opts: ExportOptions, scope: ExportScope): Promise<boolean> {
    const src = exportSrc();
    if (!src || !originCurrent(src.origin, true)) return false;
    if (scope === "all" && transactionOpen(transaction())) {
      throw new Error("All-rows query export is frozen during a manual transaction; export loaded rows instead");
    }
    const table = opts.sql.table || src.table;
    const path = await save({
      defaultPath: `${table}.${FORMAT_EXT[opts.format]}`,
      filters: [{ name: opts.format.toUpperCase(), extensions: [FORMAT_EXT[opts.format]] }],
    });
    if (!path) return false;
    if (!originCurrent(src.origin, true)) return false;
    if (src.origin.tabId) patchResult(src.origin.tabId, { status: "exporting…" });
    const args =
      scope === "all"
        ? { connectionId: src.connectionId, sql: src.query, options: opts, path, searchPath: src.searchSchema }
        : { connectionId: src.connectionId, columns: src.columns, rows: src.rows, options: opts, path };
    const t0 = performance.now();
    // A scope=all export RE-RUNS the query server-side — that belongs in history
    // like every other server execution (Slack runs and Explorer DDL are recorded).
    const exportHistory = (status: "ok" | "error", rows: number | null, error: string | null) => {
      if (scope !== "all") return;
      const key = conn()?.key;
      if (key && conn()?.id === src.connectionId) recordHistory({
        sql: `-- [Export] ${opts.format} → ${path}\n${src.query}`,
        durationMs: Math.round(performance.now() - t0),
        status,
        rows,
        error,
        schema: src.searchSchema ?? null,
      }, key);
    };
    if (scope === "all") interruptStream("an all-rows export closed the result stream");
    try {
      const n = await invoke<number>("export_to_file", args);
      exportHistory("ok", n, null);
      if (originCurrent(src.origin, true) && src.origin.tabId) patchResult(src.origin.tabId, { status: `exported ${n} rows → ${path}` });
      return true;
    } catch (e) {
      exportHistory("error", null, errMsg(e).split("\n")[0]);
      if (originCurrent(src.origin, true) && src.origin.tabId)
        patchResult(src.origin.tabId, { status: `export rejected: ${errMsg(e)}` });
      throw e;
    }
  }

  // Immediately cancel + roll back the in-flight export/import on this connection.
  async function cancelOperation(connectionId = conn()?.id, ownerId = activeTabId()) {
    const c = conn();
    if (!connectionId || !c || c.id !== connectionId) return;
    try {
      const status = await invoke<TransactionStatus>("cancel_operation", { connectionId, ownerId });
      applyAuthoritativeTransaction(status, c.generation);
    } catch (e) {
      // A rejected cancel means no unwind will ever reset the Cancelling… state or
      // report why — do both here (the error may still carry authoritative state).
      const embedded = transactionFromError(e);
      if (embedded) applyAuthoritativeTransaction(embedded, c.generation);
      setCancelling(false);
      patchResult(ownerId, { status: `cancel failed: ${errMsg(e)}` });
    }
  }

  async function exportToClipboard(opts: ExportOptions): Promise<boolean> {
    const src = exportSrc();
    if (!src || !originCurrent(src.origin, true)) return false;
    const cells = src.rows.length * src.columns.length;
    if (cells > 1_000_000) {
      const message = `result too large for clipboard (${cells.toLocaleString()} cells) - export to a file instead`;
      if (src.origin.tabId) patchResult(src.origin.tabId, { status: message });
      throw new Error(message);
    }
    let chars = src.columns.reduce((n, col) => n + col.length, 0);
    outer: for (const row of src.rows) {
      for (const value of row) {
        chars += value?.length ?? 0;
        if (chars > 8 * 1024 * 1024) break outer;
      }
    }
    if (chars > 8 * 1024 * 1024) {
      const message = `result too large for clipboard (${chars.toLocaleString()}+ characters) - export to a file instead`;
      if (src.origin.tabId) patchResult(src.origin.tabId, { status: message });
      throw new Error(message);
    }
    let text: string;
    try {
      text = formatWithOptions({ columns: src.columns, rows: src.rows }, opts, src.dialect);
    } catch (e) {
      if (src.origin.tabId) patchResult(src.origin.tabId, { status: `format rejected: ${errMsg(e)}` });
      throw e;
    }
    const ok = await clipWrite(text);
    if (originCurrent(src.origin, true) && src.origin.tabId)
      patchResult(src.origin.tabId, { status: ok ? `copied ${src.rows.length} rows` : "clipboard unavailable" });
    if (!ok) throw new Error("clipboard unavailable");
    return true;
  }

  function openImport() {
    const c = conn();
    if (!c || metadataFrozen() || running() || fetchingMore() || commitBusy()) {
      setStatus(metadataFrozen()
        ? "Import is frozen during a manual transaction"
        : "Wait for the current database operation before importing");
      return;
    }
    importOrigin = { origin: captureOrigin(), connection: c };
    importReadGeneration++;
    clearTimeout(importCloseTimer);
    setImportData(null);
    setImportRaw(null);
    setImportMsg("");
    setImportMode(schema().length ? "existing" : "new");
    setImportTarget(schema().length ? relKey(schema()[0].schema, schema()[0].name) : "");
    setImportNewName("");
    setImportOpen(true);
  }

  function reparseImport() {
    const raw = importRaw();
    if (!raw) return;
    setImportData(null);
    try {
      const lower = raw.name.toLowerCase();
      const d = lower.endsWith(".json")
        ? parseJSON(raw.text)
        : parseCSV(raw.text, importHasHeader(), lower.endsWith(".tsv") ? "\t" : ",");
      setImportData(d);
      setImportMsg("");
      if (!importNewName()) setImportNewName(raw.name.replace(/\.[^.]+$/, "").replace(/[^\w]/g, "_"));
    } catch (err) {
      setImportMsg(errMsg(err));
    }
  }

  async function onImportFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = "";
    if (!f) return;
    const generation = ++importReadGeneration;
    setImportData(null);
    setImportRaw(null);
    if (f.size > IMPORT_LIMITS.bytes) {
      setImportMsg(`import is too large: file exceeds ${IMPORT_LIMITS.bytes.toLocaleString()} bytes`);
      return;
    }
    try {
      const text = await f.text();
      if (generation !== importReadGeneration || !importOpen()) return;
      setImportRaw({ text, name: f.name });
      setImportMsg("");
      reparseImport();
    } catch (err) {
      if (generation !== importReadGeneration || !importOpen()) return;
      setImportMsg(errMsg(err));
    }
  }

  async function doImport() {
    const binding = importOrigin;
    const c = binding?.connection;
    const d = importData();
    if (!binding || !c || metadataFrozen() || !connectionCurrent(c) || !originCurrent(binding.origin) || !d || !d.columns.length) return;
    let schemaName = "public";
    let table = "";
    let create = false;
    if (importMode() === "existing") {
      const target = schema().find((t) => relKey(t.schema, t.name) === importTarget());
      if (!target) {
        setImportMsg("choose a valid target table");
        return;
      }
      schemaName = target.schema;
      table = target.name;
    } else {
      table = importNewName();
      create = true;
    }
    if (!table) {
      setImportMsg("choose a target table");
      return;
    }
    const generation = importReadGeneration;
    const connectionId = c.id;
    const stillCurrent = () => generation === importReadGeneration && connectionCurrent(c) && originCurrent(binding.origin);
    const operationCurrent = () => generation === importReadGeneration && importOrigin === binding;
    setImportBusy(true);
    setImportMsg("");
    interruptStream("an import closed the result stream");
    try {
      const n = await invoke<number>("import_rows", {
        connectionId,
        schema: schemaName,
        table,
        columns: d.columns,
        rows: d.rows,
        create,
      });
      if (!stillCurrent()) return;
      await loadSchema(c);
      if (!stillCurrent()) return;
      setImportMsg(`imported ${n} rows`);
      importCloseTimer = setTimeout(() => {
        if (generation === importReadGeneration) setImportOpen(false);
      }, 900);
    } catch (e) {
      if (!stillCurrent()) return;
      const m = errMsg(e);
      setImportMsg(/cancel/i.test(m) ? "Import cancelled — rolled back." : m);
    } finally {
      if (operationCurrent()) {
        setImportBusy(false);
        if (metadataFrozen()) {
          setImportOpen(false);
          importOrigin = null;
        }
      }
    }
  }

  function startResize(e: MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = editorH();
    const onMove = (ev: MouseEvent) =>
      setEditorH(Math.max(80, Math.min(startH + (ev.clientY - startY), maxEditorH())));
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      interactionCleanups.delete(cleanup);
    };
    const onUp = () => {
      cleanup();
      persistLayout();
    };
    interactionCleanups.add(cleanup);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
  }

  function rejectFrozenExplorer(): boolean {
    if (!metadataFrozen()) return false;
    setStatus("Explorer database actions are frozen until the manual transaction ends");
    return true;
  }

  function runTable(schemaName: string, name: string) {
    if (rejectFrozenExplorer()) return;
    const q = `SELECT * FROM ${qualifyIn(schemaName, name, schemaName)}`;
    openGeneratedTab(q, schemaName, name);
    doRun(q);
  }

  function runTableLimit(schemaName: string, name: string, limit: number) {
    if (rejectFrozenExplorer()) return;
    const q = `SELECT * FROM ${qualifyIn(schemaName, name, schemaName)} LIMIT ${limit}`;
    openGeneratedTab(q, schemaName, name);
    doRun(q);
  }

  /** Open a table in a new tab and run it with the per-column filter row already showing. */
  function filterTable(schemaName: string, name: string) {
    if (rejectFrozenExplorer()) return;
    const q = `SELECT * FROM ${qualifyIn(schemaName, name, schemaName)}`;
    const t = makeTab({ sql: q, searchSchema: schemaName, title: name });
    t.gridView = { ...t.gridView, filterRowOpen: true };
    setTabs((ts) => [...ts, t]);
    switchTab(t.id);
    doRun(q);
  }

  // Run a DDL statement built by a form/confirm dialog, then refresh the tree.
  // Returns ok/error so the dialog can stay open and show failures inline.
  // Explorer DDL is a real database mutation: it lands in history like every other
  // run path (audit trail — Slack SELECTs are recorded; a right-click DROP must be
  // too), and its status/error surface reopens a collapsed results panel.
  async function runDDL(sqlText: string, origin = captureOrigin()): Promise<{ ok: boolean; error?: string }> {
    const c = conn();
    if (!c || !originCurrent(origin)) return { ok: false, error: "connection or tab changed" };
    if (metadataFrozen()) return { ok: false, error: "Explorer database actions are frozen during a manual transaction" };
    const before = transaction();
    const t0 = performance.now();
    const ddlHistory = (status: "ok" | "error", error: string | null) => recordHistory({
      sql: `-- [Explorer]\n${sqlText}`,
      durationMs: Math.round(performance.now() - t0),
      status,
      rows: null,
      error,
      schema: null,
    }, c.key);
    if (origin.tabId) patchResult(origin.tabId, { runErr: "" });
    interruptStream("an Explorer action closed the result stream");
    try {
      const out = await invoke<QueryResult>("run_query", { connectionId: c.id, ownerId: origin.tabId ?? activeTabId(), sql: sqlText, pageSize: PAGE, searchPath: null });
      ddlHistory("ok", null);
      if (!applyAuthoritativeTransaction(out.transaction, c.generation, "statement", before)) return { ok: false, error: "stale transaction response" };
      if (!connectionCurrent(c) || !originCurrent(origin)) return { ok: false, error: "connection or tab changed" };
      if (origin.tabId) {
        if (!resultsOpen()) { setResultsOpen(true); persistLayout(); }
        patchResult(origin.tabId, { status: out.kind === "exec" ? out.message : `${out.rows.length}${out.done ? "" : "+"} rows` });
      }
      await loadSchema(c);
      return { ok: true };
    } catch (e) {
      const message = errMsg(e);
      ddlHistory("error", message.split("\n")[0]);
      const embedded = transactionFromError(e);
      if (embedded) applyAuthoritativeTransaction(embedded, c.generation, "statement", before);
      return { ok: false, error: message };
    }
  }

  // Fire-and-forget DDL (menu actions with no dialog), surfacing errors.
  function runDDLToast(sqlText: string) {
    const origin = captureOrigin();
    void runDDL(sqlText, origin).then((r) => {
      if (!r.ok && origin.tabId && originCurrent(origin)) {
        if (!resultsOpen()) { setResultsOpen(true); persistLayout(); }
        patchResult(origin.tabId, { runErr: r.error ?? "failed" });
      }
    });
  }

  // Insert text into the editor at the cursor (never clobbers the buffer).
  function scaffoldEditor(text: string, tabId = activeTabId()) {
    const body = text.endsWith("\n") ? text : text + "\n";
    const api = editorApi();
    if (api && tabId === activeTabId()) api.insertAtCursor(body);
    else {
      const t = tabs().find((x) => x.id === tabId);
      if (t) patchTab(tabId, {
        sql: (t.sql ? t.sql.replace(/\s*$/, "\n\n") : "") + body,
        dirty: true,
        revision: t.revision + 1,
      });
    }
  }

  // "Edit as SQL" from a dialog: scaffold the single statement, close the dialog.
  function editAsSql(sqlText: string, origin = dialogBinding()?.origin ?? captureOrigin()) {
    if (!originCurrent(origin) || !origin.tabId) return;
    const t = sqlText.trim();
    scaffoldEditor(t.endsWith(";") ? t : t + ";", origin.tabId);
    setActiveDialog(null);
  }

  function copyText(text: string, msg?: string, origin = captureOrigin()) {
    if (text.length > 8 * 1024 * 1024) {
      if (origin.tabId && originAlive(origin)) patchResult(origin.tabId, { status: `value too large to copy (${text.length.toLocaleString()} characters)` });
      return;
    }
    void clipWrite(text).then((ok) => {
      if (origin.tabId && originAlive(origin)) patchResult(origin.tabId, { status: ok ? msg ?? `copied ${text}` : "clipboard unavailable" });
    });
  }

  // Reconstruct an object's DDL on the backend, then copy or scaffold it.
  async function copyDDL(n: NodeDescriptor, toEditor: boolean) {
    const c = conn();
    if (!c || rejectFrozenExplorer()) return;
    const origin = captureOrigin();
    interruptStream("reading object DDL closed the result stream");
    try {
      const dd = await invoke<string>("object_ddl", {
        connectionId: c.id,
        kind: n.kind,
        schema: n.schema ?? "",
        name: n.name,
      });
      if (!connectionCurrent(c) || !originAlive(origin) || !origin.tabId) return;
      if (toEditor) scaffoldEditor(dd, origin.tabId);
      else copyText(dd, "copied DDL", origin);
    } catch (e) {
      if (origin.tabId && originAlive(origin)) patchResult(origin.tabId, { runErr: errMsg(e) });
    }
  }

  // Generate a SELECT/INSERT/UPDATE scaffold from a relation's columns into a NEW
  // tab whose schema is the relation's, so the generated query stays unqualified
  // and resolves (rather than clobbering the current tab).
  async function generate(n: NodeDescriptor, kind: "select" | "insert" | "update") {
    const c = conn();
    if (!c || rejectFrozenExplorer()) return;
    const origin = captureOrigin();
    await loadDetail(n.schema!, n.name, false, c);
    if (!connectionCurrent(c) || !originCurrent(origin)) return;
    const d = details()[relKey(n.schema!, n.name)];
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
    const c = conn();
    if (!c || rejectFrozenExplorer()) return;
    const origin = captureOrigin();
    await loadDetail(n.schema!, n.name, false, c);
    if (!connectionCurrent(c) || !originCurrent(origin)) return;
    const d = details()[relKey(n.schema!, n.name)];
    setActiveDialog({ kind: "addIndex", ctx: n, columns: d?.columns.map((c) => c.name) ?? [] }, origin);
  }
  async function openConstraintDialog(n: NodeDescriptor) {
    const c = conn();
    if (!c || rejectFrozenExplorer()) return;
    const origin = captureOrigin();
    await loadDetail(n.schema!, n.name, false, c);
    if (!connectionCurrent(c) || !originCurrent(origin)) return;
    const d = details()[relKey(n.schema!, n.name)];
    setActiveDialog({
      kind: "addConstraint",
      ctx: n,
      columns: d?.columns.map((c) => c.name) ?? [],
      tables: schema(),
    }, origin);
  }
  async function openModify(n: NodeDescriptor) {
    const c = conn();
    if (!c || rejectFrozenExplorer()) return;
    const origin = captureOrigin();
    await loadDetail(n.schema!, n.name, false, c);
    if (!connectionCurrent(c) || !originCurrent(origin)) return;
    const d = details()[relKey(n.schema!, n.name)];
    if (d) setActiveDialog({ kind: "modifyTable", ctx: n, detail: d }, origin);
  }

  // Context-aware "+" menu — offers creates relevant to the sidebar selection.
  function openPlusMenu(e: MouseEvent) {
    e.preventDefault();
    if (rejectFrozenExplorer()) return;
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
    if (metadataFrozen()) {
      const items: MenuItem[] = [{ label: "Explorer frozen during manual transaction", disabled: true, onClick: () => {} }];
      if (!activeOwnsTransaction() && transaction().owner) {
        items.push({ label: `Switch to ${ownerTab()?.title ?? "transaction owner"}`, icon: "play", onClick: () => switchTab(transaction().owner!) });
      }
      setMenu({ x: e.clientX, y: e.clientY, items });
      return;
    }
    const items = menuItems(node);
    if (!items.length) return;
    // ContextMenu clamps itself to the viewport after measuring its real size.
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  function openDdlGraph(schemaName: string, name: string | null, kind: string) {
    const c = conn();
    if (!c || rejectFrozenExplorer()) return;
    setDdlGraph({ schema: schemaName, name, kind, connectionId: c.id, origin: captureOrigin() });
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
            ? [{ label: "DDL & relationships…", icon: "fileCode" as const, onClick: () => openDdlGraph(s!, n.name, "table") }]
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
            ? [{ label: "DDL & relationships…", icon: "fileCode" as const, onClick: () => openDdlGraph(s!, n.name, kw) }]
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
            ? [{ label: "Schema diagram…", icon: "link" as const, onClick: () => openDdlGraph(n.name, null, "table") }, { sep: true as const }]
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
          // Same gate() as every other Explorer DDL item (manual-transaction freeze,
          // read-only, driver support) — DROP DATABASE least of all may skip the freeze.
          { label: cur ? "Drop… (connected)" : "Drop…", icon: "trash", danger: true, ...gate(!pEnforced() || isSuper(), "Requires database ownership (or superuser)"), ...noDuck("DuckDB has no DROP DATABASE"), ...(cur ? { disabled: true, title: "Can't drop the connected database" } : {}), onClick: () => setActiveDialog({ kind: "confirm", title: `Drop database ${n.name}`, primaryLabel: "Drop database", build: () => ddl.dropDatabase(n.name) }) },
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
        { label: "Cut", icon: "scissors", disabled: !hasSel, onClick: async () => {
          const origin = captureOrigin();
          const selection = api.captureSelection();
          if (await clipWrite(selection.text) && originCurrent(origin)) api.replaceCapturedSelection(selection, "");
        } },
        { label: "Copy", icon: "copy", disabled: !hasSel, onClick: () => copyText(api.getSelection(), "copied selection") },
        { label: "Paste", icon: "download", onClick: async () => {
          const origin = captureOrigin();
          const selection = api.captureSelection();
          const text = await clipRead();
          if (!originCurrent(origin)) return;
          if (text !== null) api.replaceCapturedSelection(selection, text);
          else if (origin.tabId) patchResult(origin.tabId, { runErr: "clipboard read blocked — use ⌘/Ctrl+V" });
        } },
        { sep: true },
        { label: "Select all", icon: "table", onClick: () => api.selectAll() },
        { label: "Toggle comment", icon: "slash", onClick: () => api.toggleComment() },
        { sep: true },
        {
          label: hasSel ? "Run selection" : "Run all",
          icon: "play",
          disabled: !activeDatabaseAllowed(),
          title: activeDatabaseAllowed() ? undefined : "This tab is frozen while another tab owns the transaction",
          onClick: () => runText(hasSel ? api.getRunText() : api.getDoc()),
        },
      ],
    });
  }

  const explainMenuItems = (): MenuItem[] => [
    { label: "Explain", icon: "eye", disabled: !activeDatabaseAllowed(), onClick: () => runAction("explain") },
    {
      label: "Explain Analyze (runs the query)",
      icon: "play",
      disabled: caps()?.explainAnalyze === false || conn()?.readOnly || !activeDatabaseAllowed(),
      title: caps()?.explainAnalyze === false ? "Not supported by this engine"
        : conn()?.readOnly ? "Connection is read-only (EXPLAIN ANALYZE executes the statement)"
        : !activeDatabaseAllowed() ? "This tab does not own the transaction" : undefined,
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
    if (metadataFrozen()) {
      setMenu({ x: e.clientX, y: e.clientY, items: [{ label: "Explorer frozen during manual transaction", disabled: true, onClick: () => {} }] });
      return;
    }
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
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      interactionCleanups.delete(cleanup);
    };
    const onUp = () => {
      cleanup();
      persistLayout();
    };
    interactionCleanups.add(cleanup);
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
                      <label>Port<input type="number" min="1" max="65535" step="1" value={port()} onInput={(e) => setPort(Number(e.currentTarget.value))} /></label>
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
          <span class="brand-sm">{driverMascot(connectionKind())} Tusk</span>
          <span class="conn-chip" title={connTarget()}>
            <span class="conn-dot" />
            <span class="conn-name">{connTarget()}</span>
          </span>
          <span class="meta">{driverLabel(connectionKind())} {conn()!.version}</span>
          <Show when={conn()!.readOnly}>
            <span class="badge badge-ro" title="Writes & DDL are blocked"><Icon name="lock" /> Read-only</span>
          </Show>
          <Show when={caps()?.manualTransactions !== false && !transactionOpen(transaction())}>
            <button class="ghost tx-start" disabled={running()} onClick={openTransactionStartMenu} title="Begin or configure a manual transaction">Transaction ▾</button>
          </Show>
          <span class="spacer" />
          <button class="icon" classList={{ active: sidebarOpen() }} title={`${sidebarOpen() ? "Hide" : "Show"} explorer (${displayKey(effectiveKey("toggleSidebar", keys()))})`} onClick={toggleSidebar}><Icon name="panelLeft" /></button>
          <button class="icon" classList={{ active: resultsOpen() }} title={`${resultsOpen() ? "Hide" : "Show"} results (${displayKey(effectiveKey("toggleResults", keys()))})`} onClick={toggleResults}><Icon name="panelBottom" /></button>
          <span class="topbar-sep" />
          <button class="ghost" classList={{ active: aiOpen() }} onClick={() => setAiOpen((v) => !v)} title="AI assistant"><Icon name="sparkle" /> AI</button>
          <button class="icon" classList={{ active: historyOpen() }} title="Query history" onClick={() => setHistoryOpen((v) => !v)}><Icon name="clock" /></button>
          <button class="icon" classList={{ active: helpOpen() }} title="Manual" onClick={() => setHelpOpen(true)}><Icon name="help" /></button>
          <button class="icon" title="Settings" onClick={() => setSettingsOpen("editor")}><Icon name="gear" /></button>
          <button class="ghost" onClick={() => void disconnect()}>Disconnect</button>
        </header>

        <Show when={transactionOpen(transaction())}>
          <div class="transaction-bar" classList={{ failed: transaction().state === "failed", lost: transaction().state === "lost" }}>
            <span class="transaction-pulse" />
            <span class="transaction-mode">
              {transaction().mode === "autocommit_off"
                ? "Autocommit off"
                : transaction().state === "configured" ? "Next transaction configured" : "Manual transaction"}
            </span>
            <code>{transaction().id ?? "unknown"}</code>
            <span class="transaction-detail">
              {transaction().state.replace("_", " ")} · {ownerTab()?.title ?? transaction().owner ?? "unknown owner"} · {fmtDur(Math.max(0, transactionNow() - (transactionStartedAt() ?? transactionNow())))}
            </span>
            <Show when={transaction().state === "failed"}><span class="transaction-alert">Recovery required</span></Show>
            <Show when={transaction().state === "lost"}><span class="transaction-alert">Outcome may be unknown</span></Show>
            <span class="spacer" />
            <Show when={!activeOwnsTransaction() && transaction().owner}>
              <button class="ghost" onClick={() => switchTab(transaction().owner!)}>Switch to owner</button>
            </Show>
            <Show when={activeOwnsTransaction() && transaction().state !== "lost"}>
              <Show when={ownerPendingCount() > 0}>
                <span class="transaction-pending">Apply or discard {ownerPendingCount()} grid change{ownerPendingCount() === 1 ? "" : "s"} first</span>
              </Show>
              <Show
                when={transaction().state === "configured"}
                fallback={
                  <>
                    <button
                      class="ghost"
                      disabled={!transactionControls().commit}
                      onClick={() => void runTransactionControl("COMMIT")}
                    >{transaction().mode === "autocommit_off" ? "Commit unit" : "Commit"}</button>
                    <button
                      class="ghost tx-rollback"
                      disabled={!transactionControls().rollback}
                      onClick={() => void runTransactionControl("ROLLBACK")}
                    >{transaction().mode === "autocommit_off" ? "Rollback unit" : "Rollback"}</button>
                    <Show when={transaction().mode === "autocommit_off"}>
                      <button
                        class="ghost"
                        disabled={!transactionControls().commit}
                        title="SET autocommit=1 commits the current MySQL transaction unit"
                        onClick={() => void runTransactionControl("SET autocommit=1")}
                      >Commit &amp; enable autocommit</button>
                    </Show>
                  </>
                }
              >
                <button class="ghost" disabled={!transactionControls().start} onClick={() => void runTransactionControl("START TRANSACTION")}>Start transaction</button>
                <button class="ghost tx-rollback" disabled={!transactionControls().clearConfiguration} onClick={() => void runTransactionControl("START TRANSACTION; ROLLBACK")}>Clear configuration</button>
              </Show>
            </Show>
            <Show when={transaction().state === "lost"}>
              <button class="btn-danger" onClick={() => { setTransactionResolution({ kind: "disconnect" }); }}>Disconnect / reconnect</button>
            </Show>
          </div>
        </Show>

        <div class="body">
          <Show when={sidebarOpen()}>
          <aside class="sidebar" style={{ width: `${sidebarW()}px` }}>
            <div class="sidebar-head">
              <span class="panel-title2">Explorer</span>
              <div class="head-actions">
                <button class="icon" title="New… (based on selection)" disabled={metadataFrozen()} onClick={(e) => openPlusMenu(e)}><Icon name="plus" /></button>
                <Show when={caps()?.bulkCopy !== false}>
                  <button class="icon" title="Import data" disabled={metadataFrozen()} onClick={openImport}><Icon name="download" /></button>
                </Show>
                <button class="icon" title={metadataFrozen() ? "Refresh deferred until transaction ends" : "Refresh"} disabled={schemaLoading() || metadataFrozen()} onClick={() => loadSchema()}>{schemaLoading() ? <span class="spinner-sm" /> : <Icon name="refresh" />}</button>
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
            <div
              class="sidebar-body"
              onContextMenu={openSidebarMenu}
              // Tree rows are user-select:none, but Chromium still starts a selection
              // on mousedown and paints it once the drag crosses selectable content
              // (row labels in WebView2, the editor/grid beyond the pane). Cancel the
              // default on a plain left press; clicks/dblclicks/context still fire.
              onMouseDown={(e) => {
                if (e.button === 0 && !(e.target instanceof HTMLInputElement)) e.preventDefault();
              }}
            >
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
                      classList={{ active: t.id === activeTabId(), "tx-owner": transaction().owner === t.id, frozen: transactionOpen(transaction()) && transaction().owner !== t.id }}
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
                      <Show when={transaction().owner === t.id}><span class="tab-tx" title={`Owns ${transaction().id ?? "manual transaction"}`}>TX</span></Show>
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
                  onClick={() => {
                    if (running()) cancelQuery();
                    else if (!activeDatabaseAllowed()) {
                      const owner = transaction().owner;
                      if (owner) switchTab(owner);
                    } else doRun();
                  }}
                  disabled={cancelling() || transaction().state === "lost" || (running() && caps()?.cancelQuery === false)}
                  title={running()
                    ? (caps()?.cancelQuery === false ? "This engine cannot cancel a running query" : "Cancel running query")
                    : activeDatabaseAllowed() ? "Run selection or all" : "Switch to the transaction owner"}
                >
                  {running()
                    ? (cancelling() ? <><span class="spinner-sm" />Cancelling…</>
                      : caps()?.cancelQuery === false ? <><span class="spinner-sm" />Running {fmtDur(runMs())}</>
                      : <>✕ Cancel {fmtDur(runMs())}</>)
                    : transaction().state === "lost" ? "Reconnect required" : !activeDatabaseAllowed() ? "Go to transaction" : "Run ▶"}
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
                onChange={(text, id) => {
                  const tab = tabs().find((t) => t.id === id);
                  if (tab && text !== tab.sql) patchTab(id, { sql: text, dirty: true, revision: tab.revision + 1 });
                }}
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
                    <button class="ghost export-btn" disabled={!activeDatabaseAllowed()} onClick={loadAll}>{loadingAll() ? <><span class="spinner-sm" />Cancel</> : "Load all"}</button>
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
                      <button class="ghost export-btn sb-commit" onClick={openCommit} disabled={!editCtx().editable || running()} title={editCtx().editable ? "Preview & run the change script" : editCtx().reason}>{activeOwnsTransaction() ? "Apply…" : "Commit…"}</button>
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
                  <Show when={activeTab().result.incomplete}>
                    <span class="result-incomplete" title={`${activeTab().result.incomplete} — the rows below are only part of the result; re-run the query for the full set`}>Incomplete result</span>
                  </Show>
                  <Show when={activeTab().result.transactionStale}>
                    <span class="transaction-result-stale" title={activeTab().result.transactionStale}>Stale transaction result</span>
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
                  rowOrder={localRowOrder}
                  view={gridView}
                  setView={setGridView}
                  activeTabId={activeTabId}
                  epoch={() => activeTab().result.epoch}
                  resultGeneration={() => activeTab().result.generation}
                  onLoadMore={loadMore}
                  onSortFilter={onSortFilter}
                  sortUnavailable={sortUnavailable}
                  onMenu={(x, y, items) => setMenu({ x, y, items })}
                  onViewValue={(col, val) => setCellView({ col, val, origin: captureOrigin() })}
                  onStatus={(text, tabId, generation) => {
                    const tab = tabs().find((t) => t.id === tabId);
                    if (tab?.result.generation === generation) patchResult(tabId, { status: text });
                  }}
                  canSort={canSort}
                  canFilter={canFilter}
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
              <span title={persistenceWarning() || transactionWarning() || undefined}>{persistenceWarning() || transactionWarning() || status()}</span>
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
              onRerun={(sql, recordedSchema) => {
                const tabId = activeTabId();
                patchTab(tabId, { searchSchema: recordedSchema });
                runText(sql);
              }}
              onClear={() => {
                const key = conn()?.key;
                if (key) { historyStore.clear(key); if (conn()?.key === key) setHistory([]); }
              }}
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
              connectionId={g().connectionId}
              onBeforeMetadata={() => interruptStream("the ERD/DDL viewer closed the result stream")}
              schema={g().schema}
              name={g().name}
              kind={g().kind}
              onOpenSql={(sql) => {
                const binding = g();
                setDdlGraph(null);
                if (originCurrent(binding.origin)) openGeneratedTab(sql, binding.schema, binding.name ?? undefined);
              }}
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
              initial={tabs().find((t) => t.id === pp().tabId)?.paramValues}
               onRun={(values: Record<string, ParamValue>, substituted: string) => {
                 const prompt = pp();
                 if (!originCurrent(prompt.origin)) {
                   setParamPrompt(null);
                   return;
                 }
                 const source = tabs().find((t) => t.id === prompt.tabId);
                patchTab(prompt.tabId, { paramValues: { ...source?.paramValues, ...values } });
                setActiveTabId(prompt.tabId);
                setParamPrompt(null);
                prompt.onRun(substituted);
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
                    ref={(el) => queueMicrotask(() => { if (el.isConnected) { el.focus(); el.select(); } })}
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
              <button class="btn-danger" onClick={() => {
                const binding = confirmAnalyze()!;
                setConfirmAnalyze(null);
                if (!originCurrent(binding.origin)) return;
                runParameterized(binding.sql, (substituted) => void executeQuery(substituted, "", "base", false, binding.sql));
              }}>
                Run it
              </button>
            </div>
          </Dialog>
        </Show>

        <Show when={importOpen()}>
          <Dialog title="Import data" onClose={() => setImportOpen(false)} dismissable={!importBusy()}>
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
                          <For each={schema()}>{(t) => <option value={relKey(t.schema, t.name)}>{t.schema}.{t.name}</option>}</For>
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
                <button class="ghost full" onClick={() => void cancelOperation(importOrigin?.connection.id, importOrigin?.origin.tabId ?? activeTabId())}>Cancel &amp; roll back</button>
              </Show>
            </Show>
            <Show when={importMsg()}><div class="import-msg">{importMsg()}</div></Show>
          </Dialog>
        </Show>

        <Show when={activeDialog()}>
          <WorkbenchDialogs
            state={activeDialog()}
            onClose={() => setActiveDialog(null)}
            onRun={(sql) => {
              const binding = dialogBinding();
              return binding ? runDDL(sql, binding.origin) : Promise.resolve({ ok: false, error: "dialog is stale" });
            }}
            onEditAsSql={(sql) => {
              const binding = dialogBinding();
              if (binding) editAsSql(sql, binding.origin);
            }}
          />
        </Show>
        <Show when={exportSrc()}>
          {(src) => (
            <ExportDialog
              columns={src().columns}
              loadedRows={src().rows}
              loadedIncomplete={src().incomplete}
              defaultTable={src().table}
              dialect={src().dialect}
              boolCols={src().boolCols}
              allowAllRows={!transactionOpen(transaction())}
              onClose={() => setExportSrc(null)}
              onExportFile={exportToFile}
              onExportClipboard={exportToClipboard}
              onCancel={() => cancelOperation(src().connectionId, src().origin.tabId ?? activeTabId())}
            />
          )}
        </Show>
        <Show when={commitView()}>
          {(cv) => (
            <Dialog title={activeOwnsTransaction() ? "Apply changes" : "Commit changes"} width={620} onClose={closeCommit} dismissable={!commitBusy()}>
              <p class="confirm-text">
                {activeOwnsTransaction()
                  ? `${cv().script.length} statement${cv().script.length === 1 ? "" : "s"} will run inside ${transaction().id}. The outer transaction remains open.`
                  : `${cv().script.length} statement${cv().script.length === 1 ? "" : "s"} will run in one transaction (rolled back wholesale on failure).`}
              </p>
              <SqlPreview sql={cv().script.map((s) => s + ";").join("\n")} />
              <Show when={commitErr()}>
                <div class="error">{commitErr()}</div>
              </Show>
              <div class="form-actions">
                <button class="ghost" disabled={commitBusy()} onClick={closeCommit}>Cancel</button>
                <button class="run" disabled={commitBusy()} onClick={() => void doCommit()}>
                  {commitBusy() ? "Applying…" : activeOwnsTransaction() ? "Apply" : "Commit"}
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
                <button class="btn-danger" onClick={() => {
                  const binding = cd();
                  setConfirmDiscard(null);
                  if (originCurrent(binding.origin, true)) binding.run();
                }}>Discard</button>
              </div>
            </Dialog>
          )}
        </Show>
        <Show when={confirmClose()}>
          {(cc) => (
            <Dialog title="Uncommitted changes" onClose={() => setConfirmClose(null)} width={460}>
              <p class="confirm-text">
                “{tabs().find((t) => t.id === cc().tabId)?.title}” has
                {cc().dirty ? " unsaved editor changes" : ""}
                {cc().dirty && cc().pending ? " and" : ""}
                {cc().pending ? ` ${cc().pending} uncommitted grid change${cc().pending === 1 ? "" : "s"}` : ""}.
                {cc().pending ? " Grid changes cannot be saved to the SQL file and will be discarded if this tab closes." : ""}
              </p>
              <div class="form-actions">
                <button class="ghost" onClick={() => setConfirmClose(null)}>Cancel</button>
                <button class="btn-danger" onClick={() => { removeTab(cc().tabId); setConfirmClose(null); }}>Discard &amp; close</button>
                <Show when={cc().dirty}>
                  <button
                    class="run"
                     onClick={async () => {
                       const tid = cc().tabId;
                       if (await saveTab(tid, false) && confirmClose()?.tabId === tid) {
                         removeTab(tid);
                         setConfirmClose(null);
                      }
                    }}
                  >
                    {cc().pending ? "Save file, discard grid & close" : "Save & close"}
                  </button>
                </Show>
              </div>
            </Dialog>
          )}
        </Show>
        <Show when={confirmDisconnect()}>
          {(count) => (
            <Dialog title="Disconnect with pending changes?" onClose={() => setConfirmDisconnect(null)} width={460}>
              <p class="confirm-text">
                Disconnecting discards {count()} uncommitted grid change{count() === 1 ? "" : "s"}. Editor buffers remain saved in this workspace.
              </p>
              <div class="form-actions">
                <button class="ghost" onClick={() => setConfirmDisconnect(null)}>Stay connected</button>
                <button class="btn-danger" onClick={() => void disconnect(true)}>Discard &amp; disconnect</button>
              </div>
            </Dialog>
          )}
        </Show>
        <Show when={confirmWindowClose()}>
          {(count) => (
            <Dialog title="Close with pending changes?" onClose={() => setConfirmWindowClose(null)} width={460}>
              <p class="confirm-text">
                Closing Tusk discards {count()} uncommitted grid change{count() === 1 ? "" : "s"}. Editor buffers have been saved to workspace recovery.
              </p>
              <div class="form-actions">
                <button class="ghost" onClick={() => setConfirmWindowClose(null)}>Keep Tusk open</button>
                <button class="btn-danger" onClick={() => void closeNativeWindow(true)}>Discard &amp; close Tusk</button>
              </div>
            </Dialog>
          )}
        </Show>
        <Show when={transactionResolution()}>
          {(intent) => (
            <Dialog
              title={transaction().state === "lost" ? "Transaction session lost" : "Resolve transaction first"}
              onClose={() => setTransactionResolution(null)}
              dismissable={!transactionResolutionBusy()}
              width={520}
            >
              <p class="confirm-text">
                <Show
                  when={transaction().state !== "lost"}
                  fallback={<>The database session for <b>{transaction().id}</b> was lost. Commit state cannot be proven. Disconnect, reconnect, and verify the outcome before retrying.</>}
                >
                  <b>{ownerTab()?.title ?? transaction().owner}</b> owns {transaction().id}.
                  {transaction().state === "configured" ? " Clear the pending MySQL transaction configuration before" : " Commit or roll it back before"}
                  {intent().kind === "close-tab" ? " closing its tab" : intent().kind === "disconnect" ? " disconnecting" : " closing Tusk"}.
                </Show>
              </p>
              <Show when={transaction().state === "lost" && totalPendingCount() > 0}>
                <div class="transaction-resolution-note">
                  Disconnecting will discard {totalPendingCount()} pending grid change{totalPendingCount() === 1 ? "" : "s"}.
                </div>
              </Show>
              <Show when={transaction().state !== "lost" && ownerPendingCount() > 0}>
                <div class="transaction-resolution-note">
                  {ownerPendingCount()} pending grid change{ownerPendingCount() === 1 ? "" : "s"} must be applied or discarded before the outer transaction can end.
                </div>
              </Show>
              <div class="form-actions">
                <button class="ghost" disabled={transactionResolutionBusy()} onClick={() => setTransactionResolution(null)}>Cancel</button>
                <Show when={transaction().state === "lost"}>
                  <button class="btn-danger" disabled={transactionResolutionBusy()} onClick={() => void disconnectLostTransaction()}>
                    {transactionResolutionBusy() ? "Disconnecting…" : "Disconnect and reconnect"}
                  </button>
                </Show>
                <Show when={transaction().state !== "lost" && ownerPendingCount() > 0}>
                  <button class="ghost" disabled={!editCtx().editable || transactionResolutionBusy() || transactionControlBusy()} onClick={applyPendingBeforeTransactionResolution}>Apply changes…</button>
                  <button class="btn-danger" disabled={transactionResolutionBusy() || transactionControlBusy()} onClick={() => {
                    const owner = transaction().owner;
                    if (owner) setPendingFor(owner, undefined);
                  }}>Discard grid changes</button>
                </Show>
                <Show when={transaction().state !== "lost" && ownerPendingCount() === 0}>
                  <Show
                    when={transaction().state === "configured"}
                    fallback={
                      <>
                        <button
                          class="ghost"
                          disabled={transactionResolutionBusy() || !transactionControls().commit}
                          onClick={() => void resolveTransaction("commit")}
                        >{transactionResolutionBusy() ? "Resolving…" : transaction().mode === "autocommit_off" ? "Commit & return to autocommit" : "Commit"}</button>
                        <button class="btn-danger" disabled={transactionResolutionBusy() || !transactionControls().rollback} onClick={() => void resolveTransaction("rollback")}>
                          {transaction().mode === "autocommit_off" ? "Rollback & return to autocommit" : "Rollback"}
                        </button>
                      </>
                    }
                  >
                    <button class="btn-danger" disabled={transactionResolutionBusy() || !transactionControls().clearConfiguration} onClick={() => void resolveTransaction("rollback")}>
                      {transactionResolutionBusy() ? "Clearing…" : "Clear configuration & continue"}
                    </button>
                  </Show>
                </Show>
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
      <WhatsNew requestShow={whatsNewRequest} />

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
              <button class="run" disabled={cv().val === null || !originCurrent(cv().origin, true)} onClick={() => copyText(cv().val ?? "", "copied value", cv().origin)}>Copy</button>
            </div>
          </Dialog>
        )}
      </Show>
    </>
  );
}

export default App;
