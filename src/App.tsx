import { batch, createSignal, createMemo, createEffect, on, onMount, onCleanup, For, Show, lazy } from "solid-js";
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
import { makeTab, basename, gridViewFor, pendingCount, snapshotTabs as recoverySnapshot, type Tab, type ResultSnapshot, type GridView, type SortKey, type PendingEdits } from "./tabs";
// --- ui/customize: tab organisation + appearance tokens ---
import {
  TAB_COLORS,
  TAB_COLOR_LABELS,
  cleanTabTitle,
  clampPinSlot,
  closeManyTargets,
  normalizeTabColor,
  pinnedCount as pinnedTabCount,
  shortTabLabel,
  sortPinned,
  tabLabel,
  type CloseScope,
  type TabColor,
} from "./tabs";
import { TabSwitcher, type TabSwitcherItem } from "./TabSwitcher";
import { densityTokens, gridRowH, normalizeDensity, rootFontSize } from "./appearance";
// --- end ui/customize imports ---
import { FilterBar } from "./grid/FilterBar";
import { classResolver, conditions, emptyFilter, hasConditions, removeNode, type FilterTree } from "./grid/filterModel";
import { activeConditionCount } from "./grid/filterSql";
import { ResultGrid, type SelectionSource } from "./ResultGrid";
import { UpdateBadge } from "./UpdateBadge";
import { WhatsNew } from "./WhatsNew";
import { wrapQuery, wrappableQuery, stripTrailingSemi, hasDuplicateColumns, hasViewRules, mssqlWrappable } from "./grid/query";
import { editTarget, editPlan, type EditPlan } from "./grid/editable";
import { boolEditTokens, detectBoolCols, typeBoolCols } from "./grid/bool";
import { buildCommitScript } from "./grid/editSql";
import { planPaste, mergePaste, type RowRef } from "./grid/paste";
import { orderedRows, sortedRowOrder } from "./grid/sort";
import { interruptedResult } from "./tabs";
import { makeIndexer } from "./sql/aliases";
import { formatWithOptions } from "./formats";
import { FORMAT_EXT, type ExportOptions, type ExportScope } from "./export";
import { backupPayload, type BackupOptions, type BackupSummary, type RestoreOptions, type RestoreSummary } from "./backup";
import { type BackupTarget } from "./forms/BackupDialog";
import { type BackupFileInfo } from "./forms/RestoreDialog";
import {
  type ImportOptions,
  type ImportPreview,
  type ImportProgress,
  type ImportSummary,
  type ImportTarget,
} from "./import";
import { pickOpenPath, pickSavePath, type PickedPath, type PickerOptions } from "./filePicker";
import { Tree, type DbTree, type RelationDetail, type NodeDescriptor, nodeKey, relKey } from "./Tree";
import { ContextMenu, type MenuItem, type MenuState } from "./ContextMenu";
import { type DialogState } from "./WorkbenchDialogs";
import { type SettingsTab } from "./settings/SettingsDialog";
const HelpDialog = lazy(() => import("./help/HelpDialog"));
import { fontStack } from "./editor/theme";
import { type SqlEngine } from "./editor/lexer";
import { ACTIONS, type ActionCtx, type ActionId, type KeyOverrides, canonicalKey, displayKey, effectiveKey, normalizeKeyEvent } from "./actions";
import { measureEdges, reorder, slotOffset, startPointerDrag, type PointerDragHandle } from "./dnd";
import { exportOptionsStore, keymapStore, type RememberedExportOptions } from "./store";
import { consumeCrashRecovery } from "./CrashGuard";
import { historyStore, makeEntryId, type HistoryEntry } from "./history/store";
import { detectParams, type Param, type ParamValue } from "./sql/params";
import { type FkEdge } from "./sql/fk";
import { type Skill } from "./ai/skills";
import { ParamDialog } from "./forms/ParamDialog";
import {
  SshSection,
  emptySshForm,
  sshFormFromProfile,
  sshNeedsSecret,
  sshPayload,
  validateSshForm,
  type SshFormState,
  type SshMeta,
} from "./forms/SshSection";
import { SshHostKeyDialog, type SshHostKeyPrompt } from "./forms/SshHostKeyDialog";
import { detectPlan } from "./plan/detect";
import { explainSql, analyzeExecutesWrite, isSingleExplainStatement, explainUnsupported } from "./plan/explainSql";
import { Dialog, SqlPreview } from "./Dialog";
import { Icon } from "./Icons";
import { ident, qualify, qualifyIn, setMysqlNoBackslashEscapes, setSqlDialect, withDialect } from "./sql/ident";
import {
  DRIVERS,
  MAX_CONNECTIONS,
  connectionColor,
  connectionDot,
  connectionDotTitle,
  connectionKindOf,
  connectionLabels,
  connectionLimitError,
  driverLabel,
  driverMascot,
  findConnection,
  makeConnectionState,
  mergeRememberedIds,
  nextColorIndex,
  nextRecoverySlot,
  recoverySlotKey,
  rememberedProfileIds,
  stepConnection,
  type Capabilities,
  type ConnectionState,
  type Connected,
  type Permissions,
  type TableInfo,
} from "./connections";
import * as ddl from "./sql/ddl";
import { limitedSelect } from "./sql/ddl";
import { ddlCaps, ddlSupported } from "./sql/ddlCaps";
import { clipWrite, clipRead } from "./clipboard";
import { slackHistoryKey, type SlackExecuted } from "./slackEvents";
import { KeyedSerialQueue } from "./asyncQueue";
import {
  IDLE_TRANSACTION,
  INTERRUPTED_TRANSACTION_KEY,
  INTERRUPTED_TRANSACTION_PREFIX,
  acceptTransactionStatus,
  decodeInterruptedTransaction,
  encodeInterruptedTransaction,
  evictInterruptedMarkers,
  interruptedTransactionKey,
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
  ssh?: SshMeta | null;
  save_ssh_secret: boolean;
};
type QueryOutcome =
  | { kind: "rows"; columns: string[]; rows: (string | null)[][]; done: boolean; note?: string }
  | { kind: "exec"; message: string };
type QueryResult = QueryOutcome & { transaction: TransactionStatus };
type FetchResult = { rows: (string | null)[][]; done: boolean; interrupted?: boolean; transaction: TransactionStatus };
type ConnectReply = { connection_id: string; server_version: string; read_only: boolean; viaSsh?: boolean };
type UiOrigin = {
  connectionId: string | null;
  connectionGeneration: number;
  tabId: string | null;
  resultGeneration: number;
  resultEpoch: number;
  transactionRevision: number;
};
// Slack bot status mirrors slack::StatusInfo in Rust. `connectionId` is the ONE Tusk
// connection the bot answers against (null when it is not running / not yet bound).
type SlackStatus = { running: boolean; state: string; error: string | null; connectionId?: string | null };

const PAGE = 1000;
const MAX_LOCAL_SORT_ROWS = 250_000;
const DDL_RE = /^\s*(create|alter|drop|truncate|comment|grant|revoke)\b/i;

// Heavy, conditionally-rendered panels load as separate chunks on first open —
// keeps the startup bundle (and its parse time) lean. All are behind <Show>,
// so the chunk fetch happens only when the user actually opens the surface.
const SqlEditor = lazy(() => import("./SqlEditor").then((m) => ({ default: m.SqlEditor })));
const AiPanel = lazy(() => import("./ai/AiPanel").then((m) => ({ default: m.AiPanel })));
const ExportDialog = lazy(() => import("./forms/ExportDialog").then((m) => ({ default: m.ExportDialog })));
const BackupDialog = lazy(() => import("./forms/BackupDialog").then((m) => ({ default: m.BackupDialog })));
const RestoreDialog = lazy(() => import("./forms/RestoreDialog").then((m) => ({ default: m.RestoreDialog })));
const ExportTablesDialog = lazy(() => import("./forms/ExportTablesDialog").then((m) => ({ default: m.ExportTablesDialog })));
const ImportDialog = lazy(() => import("./forms/ImportDialog").then((m) => ({ default: m.ImportDialog })));
const WorkbenchDialogs = lazy(() => import("./WorkbenchDialogs").then((m) => ({ default: m.WorkbenchDialogs })));
const SettingsDialog = lazy(() => import("./settings/SettingsDialog").then((m) => ({ default: m.SettingsDialog })));
const ShortcutsPane = lazy(() => import("./settings/ShortcutsPane").then((m) => ({ default: m.ShortcutsPane })));
const HistoryPanel = lazy(() => import("./history/HistoryPanel").then((m) => ({ default: m.HistoryPanel })));
const CommandPalette = lazy(() => import("./CommandPalette").then((m) => ({ default: m.CommandPalette })));
const PlanView = lazy(() => import("./plan/PlanView").then((m) => ({ default: m.PlanView })));
const DdlGraphDialog = lazy(() => import("./relviz/DdlGraphDialog").then((m) => ({ default: m.DdlGraphDialog })));

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

/**
 * Per-connection bookkeeping that must NOT be reactive: monotone generation
 * counters that invalidate stale async write-backs, the single cursor owner, and
 * the metadata caches. Every one of these used to be a module-scope `let`/`Set` in
 * App — shared, they made a run on one connection cancel an in-flight fetch on
 * another and let one connection's schema refresh drop another's reply.
 *
 * A holder captures its runtime ONCE (`runtimes.get(id)`) and keeps using that
 * reference: after a disconnect the entry is dropped from the map, and the orphan's
 * mutations are inert because every write-back also checks `connectionOpen`.
 */
type ConnRuntime = {
  queryGeneration: number;
  fetchGeneration: number;
  schemaGeneration: number;
  fkGeneration: number;
  cursorGeneration: number;
  /** The one tab streaming from this connection's single server cursor. */
  cursorOwner: { tabId: string; connectionGeneration: number; resultGeneration: number; cursorGeneration: number } | null;
  activeQuery: { generation: number; connectionGeneration: number; tabId: string; transactionRevision: number } | null;
  deferredSchemaRefresh: boolean;
  transactionHistoryKey: string | null;
  /** Schemas whose FK edges were fetched SUCCESSFULLY (cleared per introspection). */
  fkFetched: Set<string>;
  fkInFlight: Set<string>;
  loadedRels: Map<string, { schema: string; name: string }>;
  detailInflight: Set<string>;
  sampleCache: Map<string, SampleTable>;
  cancelAll: boolean;
  /** False once this connection's stored recovery snapshot proved unwritable. */
  recoveryWritable: boolean;
  runTimers: Set<ReturnType<typeof setInterval>>;
};

const makeRuntime = (): ConnRuntime => ({
  queryGeneration: 0,
  fetchGeneration: 0,
  schemaGeneration: 0,
  fkGeneration: 0,
  cursorGeneration: 0,
  cursorOwner: null,
  activeQuery: null,
  deferredSchemaRefresh: false,
  transactionHistoryKey: null,
  fkFetched: new Set<string>(),
  fkInFlight: new Set<string>(),
  loadedRels: new Map<string, { schema: string; name: string }>(),
  detailInflight: new Set<string>(),
  sampleCache: new Map<string, SampleTable>(),
  cancelAll: false,
  recoveryWritable: true,
  runTimers: new Set<ReturnType<typeof setInterval>>(),
});

/**
 * One open connection in the workbench: its immutable identity, one signal holding
 * the whole reactive per-connection state, and the non-reactive runtime.
 *
 * ONE signal per connection (rather than ~20) keeps the bookkeeping honest; the
 * granularity comes back through the memoized active-connection accessors in App,
 * which dedupe by value, so the 5 Hz run timer cannot re-run consumers of `schema`.
 */
type ConnEntry = {
  conn: Connected;
  colorIndex: number;
  state: () => ConnectionState;
  patch: (patch: Partial<ConnectionState>) => void;
  runtime: ConnRuntime;
};

/** Placeholder returned by `activeTab()` when no connection is open. Never in `tabs()`. */
const NO_TAB: Tab = makeTab({ title: "—" });

// Shared empty values for the active-connection memos. Stable identities matter: a
// fresh `[]` each read would make every downstream memo recompute on every notify.
const EMPTY_TABLES: TableInfo[] = [];
const EMPTY_FUNCS: ReadonlySet<string> = new Set<string>();
const EMPTY_FK_EDGES: FkEdge[] = [];
const EMPTY_DETAILS: Record<string, RelationDetail> = {};
const EMPTY_HISTORY: HistoryEntry[] = [];

function App() {
  // --- open connections -----------------------------------------------------
  const [connections, setConnections] = createSignal<ConnEntry[]>([]);
  const [activeConnectionId, setActiveConnectionId] = createSignal<string | null>(null);
  const runtimes = new Map<string, ConnRuntime>();
  /** Last tab focused on each connection, so switching back lands where you left. */
  const lastTabByConn = new Map<string, string>();
  const [transactionNow, setTransactionNow] = createSignal(Date.now());
  let connectionGeneration = 0;
  let resultGeneration = 0;

  const activeEntry = createMemo(() => findConnection(connections(), activeConnectionId()));
  const activeState = createMemo(() => activeEntry()?.state() ?? null);
  const entryOf = (id: string | null | undefined) => findConnection(connections(), id ?? null);
  const stateOf = (id: string | null | undefined) => entryOf(id)?.state() ?? null;
  /** Patch one connection's reactive state BY ID — never "whatever is active now". */
  const patchConn = (id: string, patch: Partial<ConnectionState>) => entryOf(id)?.patch(patch);
  /** True while `c` is still the same live session (same id AND same generation). */
  const connectionOpen = (c: Pick<Connected, "id" | "generation">) =>
    entryOf(c.id)?.conn.generation === c.generation;

  // Active-connection accessors. These are MEMOS, not plain functions: `activeState`
  // notifies on every field of the active connection (including the run timer), and
  // memoizing dedupes each field by value so downstream memos keep today's
  // granularity. Every existing read site (`caps()`, `schema()`, …) is unchanged and
  // now means "the active connection's".
  const conn = createMemo(() => activeEntry()?.conn ?? null);
  const caps = createMemo(() => activeState()?.caps ?? null);
  const connectionKind = createMemo(() => connectionKindOf(activeState()));
  const perms = createMemo(() => activeState()?.perms ?? null);
  const transaction = createMemo<TransactionStatus>(() => activeState()?.transaction ?? IDLE_TRANSACTION);
  const transactionStartedAt = createMemo(() => activeState()?.transactionStartedAt ?? null);
  const transactionWarning = createMemo(() => activeState()?.transactionWarning ?? "");
  const running = createMemo(() => activeState()?.running ?? false);
  const runningTabId = createMemo(() => activeState()?.runningTabId ?? null);
  const runMs = createMemo(() => activeState()?.runMs ?? 0);
  const cancelling = createMemo(() => activeState()?.cancelling ?? false);
  const fetchingMore = createMemo(() => activeState()?.fetchingMore ?? false);
  const loadingAll = createMemo(() => activeState()?.loadingAll ?? false);
  const schemaLoading = createMemo(() => activeState()?.schemaLoading ?? false);

  // saved profiles + connection form
  const [profiles, setProfiles] = createSignal<Profile[]>([]);
  const [editingId, setEditingId] = createSignal("");
  const [name, setName] = createSignal("");
  const [driver, setDriver] = createSignal("postgres");
  const [path, setPath] = createSignal(""); // DuckDB/SQLite file (empty = :memory:)
  /** True = the connect screen is raised as a modal over an open workspace. */
  const [connectOpen, setConnectOpen] = createSignal(false);
  /**
   * Saved-profile ids that were open when the workspace was last used. Offered as
   * "Reopen last session" and never reconnected on its own: passwords come from the
   * keychain and a silent multi-connect on launch is a surprise, not a convenience.
   */
  const [reopenable, setReopenable] = createSignal<string[]>([]);
  const [aiOpen, setAiOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal<SettingsTab | null>(null); // non-null = open on that tab
  const [historyOpen, setHistoryOpen] = createSignal(false);
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
    fksKnown: caps()?.relationships !== false
      && [...aiFkSchemas()].every((schemaName) => !!activeRuntime()?.fkFetched.has(schemaName)),
    currentSql: editorApi()?.getDoc() ?? activeTab().sql,
    selection: editorApi()?.getSelection() ?? "",
    lastError: activeTab().result.runErr,
  });
  // Sample-data fetcher for the AI assistant: a few read-only rows per relevant table,
  // cached for the session (cleared on schema reload) and run without disturbing any
  // in-flight stream. Best-effort — a table that can't be sampled is just skipped.
  // relKey now lives in Tree.tsx — the tree reads the same cache, and a key drift
  // between writer and reader showed every expanded table as "loading…" forever.
  async function aiSampleRows(targets: { schema: string; name: string }[]): Promise<SampleTable[]> {
    const c = conn();
    const rt = c ? runtimes.get(c.id) : null;
    if (!c || !rt || metadataFrozen()) return [];
    const transactionRevision = transaction().revision;
    const results = await Promise.all(
      targets.map(async (t): Promise<SampleTable | null> => {
        const key = relKey(t.schema, t.name);
        const hit = rt.sampleCache.get(key);
        if (hit) return hit;
        try {
          const r = await invoke<{ columns: string[]; rows: (string | null)[][] }>("sample_rows", {
            connectionId: c.id, schema: t.schema, name: t.name, limit: 5,
          });
          if (!connectionOpen(c) || (stateOf(c.id)?.transaction.revision ?? -1) !== transactionRevision || frozenFor(c.id)) return null;
          const s: SampleTable = { schema: t.schema, name: t.name, columns: r.columns, rows: r.rows };
          rt.sampleCache.set(key, s);
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
  const canInsert = (s: string, t: string) => ownsTable(s, t) || !!tablePriv(s, t)?.insert;
  // Per-engine DDL capabilities. ONE table (sql/ddlCaps.ts) answers "can this engine do
  // X?" for both the SQL builders and this menu, so opening an engine up is a row there
  // rather than a new check at every call site.
  const dcaps = () => ddlCaps(connectionKind());
  // Merge into a MenuItem: read-only wins, then the manual-transaction freeze, then the
  // privilege. Every gate() call site is a mutating DDL item.
  const gate = (allowed: boolean, reason: string): { disabled?: boolean; title?: string } => {
    if (metadataFrozen()) return { disabled: true, title: "Explorer actions are frozen during a manual transaction" };
    if (conn()?.readOnly) return { disabled: true, title: "Connection is read-only" };
    // An engine with no row in sql/ddlCaps.ts (SQL Server today) would otherwise fall
    // back to the PostgreSQL builders and emit syntax the server rejects.
    if (!ddlSupported(connectionKind())) return { disabled: true, title: `DDL editing isn't supported for ${driverLabel(connectionKind())} yet` };
    return allowed ? {} : { disabled: true, title: reason };
  };
  // Same read-only / transaction-freeze / privilege gate for the file-import items,
  // but with import's own engine support (import.rs refuses SQL Server) — `gate()`'s
  // DDL-builder reason is the wrong explanation for an import action.
  const importGate = (allowed: boolean, reason: string): { disabled?: boolean; title?: string } => {
    if (metadataFrozen()) return { disabled: true, title: "Explorer actions are frozen during a manual transaction" };
    if (conn()?.readOnly) return { disabled: true, title: "Connection is read-only" };
    if (connectionKind() === "mssql")
      return { disabled: true, title: `File import isn't supported for ${driverLabel("mssql")} yet. Use the SQL editor instead.` };
    return allowed ? {} : { disabled: true, title: reason };
  };
  /**
   * The same gate for the sidebar header's Import button, which used to be disabled
   * by the transaction freeze alone — a read-only or SQL Server connection let the
   * user walk the whole wizard before the backend refused. Read from JSX attributes,
   * so it must stay a plain accessor (a spread would not track).
   */
  const sidebarImportGate = () =>
    importGate(
      !pEnforced() || canCreateSchema() || schema().length > 0,
      "Requires CREATE somewhere in this database",
    );
  // Disable an item this engine cannot express (constraint ALTERs on DuckDB, CREATE
  // DATABASE on SQLite, renaming a constraint anywhere but Postgres, …). Spread AFTER
  // gate(); `what` completes "<engine> can't <what>".
  //
  // It is spread last, so it re-checks the STRONGER reasons itself: a read-only or
  // transaction-frozen item must keep saying so rather than being relabelled with the
  // weaker engine message (both stay disabled either way).
  const engineCan = (supported: boolean, what: string): { disabled?: boolean; title?: string } => {
    if (supported) return {};
    const stronger = gate(true, "");
    return stronger.disabled ? stronger : { disabled: true, title: `${dcaps().label} can't ${what}` };
  };
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
  // SSH tunnel section of the connect form + the first-contact host-key prompt.
  const [ssh, setSshState] = createSignal<SshFormState>(emptySshForm());
  const patchSsh = (patch: Partial<SshFormState>) => setSshState((s) => ({ ...s, ...patch }));
  // True while editing a profile that already has an SSH secret in the keychain — drives
  // the masked "(stored)" placeholder, exactly like the database password.
  const [sshSecretStored, setSshSecretStored] = createSignal(false);
  // Set when a connect attempt failed on an unknown host key. `retry` re-runs the exact
  // attempt that failed, so Trust never redirects to a different destination.
  const [sshPrompt, setSshPrompt] = createSignal<{ prompt: SshHostKeyPrompt; retry: () => Promise<void> } | null>(null);
  /** The structured unknown-host payload, when a rejection carries one. */
  const sshHostKeyOf = (e: unknown): SshHostKeyPrompt | null => {
    if (!e || typeof e !== "object" || !("sshHostKey" in e)) return null;
    const p = (e as { sshHostKey?: unknown }).sshHostKey;
    if (!p || typeof p !== "object") return null;
    const { host, port, algorithm, fingerprint } = p as Record<string, unknown>;
    if (typeof host !== "string" || typeof port !== "number") return null;
    if (typeof algorithm !== "string" || typeof fingerprint !== "string") return null;
    return { host, port, algorithm, fingerprint };
  };
  /**
   * Run a connect attempt, and on an unknown host key offer Trust + the same retry.
   *
   * There is one prompt slot, and "Reopen last session" keeps iterating profiles
   * while it is up (the rejection is swallowed here, so `connecting()` goes false).
   * A second unknown host key must therefore NOT overwrite the first: the user is
   * looking at a fingerprint and about to decide on it. The later prompt is dropped
   * — its profile stays in the reopen offer, so it can be retried by hand.
   */
  async function connectWithHostKeyPrompt(attempt: () => Promise<void>) {
    try {
      await attempt();
    } catch (e) {
      const prompt = sshHostKeyOf(e);
      if (!prompt) throw e;
      if (sshPrompt()) return;
      setSshPrompt({ prompt, retry: attempt });
    }
  }

  // workspace
  // Docked-panel sizes — restored from localStorage, persisted on resize-end.
  const savedLayout = layoutStore.load();
  const [sidebarW, setSidebarW] = createSignal(savedLayout.sidebarW ?? 270);
  const [aiW, setAiW] = createSignal(savedLayout.aiW ?? 360);
  const [historyW, setHistoryW] = createSignal(savedLayout.historyW ?? 340);
  // Collapsed panels (Explorer + results). Sizes are remembered separately, so a
  // toggle restores the previous width/height instead of a default.
  const [sidebarOpen, setSidebarOpen] = createSignal(savedLayout.sidebarOpen ?? true);
  const [resultsOpen, setResultsOpen] = createSignal(savedLayout.resultsOpen ?? true);
  // Per-connection metadata, read off the ACTIVE connection. Autocomplete's
  // table/column list comes from `list_schema` (one query, all tables+columns),
  // decoupled from the lazy object tree which no longer carries columns; `funcs` is
  // the lowercase function/procedure catalog for the unknown-function lint;
  // `fkEdges` the live JOIN…ON edges (active schema + public, merged); `details` the
  // lazily expanded per-relation detail.
  const tree = createMemo(() => activeState()?.tree ?? null);
  const schema = createMemo<TableInfo[]>(() => activeState()?.schema ?? EMPTY_TABLES);
  const funcs = createMemo<ReadonlySet<string>>(() => activeState()?.funcs ?? EMPTY_FUNCS);
  const fkEdges = createMemo<FkEdge[]>(() => activeState()?.fkEdges ?? EMPTY_FK_EDGES);
  const details = createMemo<Record<string, RelationDetail>>(() => activeState()?.details ?? EMPTY_DETAILS);
  const history = createMemo<HistoryEntry[]>(() => activeState()?.history ?? EMPTY_HISTORY);
  const activeRuntime = () => (activeConnectionId() ? runtimes.get(activeConnectionId()!) ?? null : null);
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
  // Editor tabs — each owns a SQL buffer, a snapshot of its last result grid, and the
  // id of the connection it runs against. The strip shows every open connection's
  // tabs; focusing one focuses its connection.
  const [tabs, setTabs] = createSignal<Tab[]>([]);
  const [activeTabId, setActiveTabId] = createSignal("");
  const activeTab = createMemo(() => tabs().find((t) => t.id === activeTabId()) ?? NO_TAB);
  const tabsOf = (connectionId: string) => tabs().filter((t) => t.connectionId === connectionId);
  const aiFkSchemas = () => new Set([activeTab().searchSchema ?? "public", "public"]);
  const [persistenceWarning, setPersistenceWarning] = createSignal("");

  const patchTab = (id: string, patch: Partial<Tab>) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  /**
   * Release ONE connection's server cursor because `reason` is about to (or did)
   * close it underneath its owner tab. The owner's snapshot is frozen as an
   * explicitly INCOMPLETE result — status, toolbar badge, local-sort/export gating —
   * instead of being silently presented as the full set. No-op when that connection
   * is not streaming.
   *
   * The cursor is per connection, so the reason must be scoped to one too: a run or a
   * metadata read on connection A must never mark connection B's live stream
   * interrupted. Callers that act on a specific connection pass its id; the default
   * is the active one.
   */
  function interruptStream(reason: string, connectionId = activeConnectionId()) {
    const rt = connectionId ? runtimes.get(connectionId) : null;
    const owner = rt?.cursorOwner;
    if (!rt || !owner) return;
    rt.cursorOwner = null;
    rt.cursorGeneration++;
    const t = tabs().find((x) => x.id === owner.tabId);
    if (!t || t.result.generation !== owner.resultGeneration) return;
    const patch = interruptedResult(t.result, reason);
    if (patch) patchResult(owner.tabId, patch);
  }
  const patchResult = (id: string, patch: Partial<ResultSnapshot>) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, result: { ...t.result, ...patch } } : t)));

  // --- focus + strip -------------------------------------------------------
  /** Persistence key each connection's tabs live under (may differ from conn.key
   *  when a legacy snapshot could not be migrated). */
  const recoveryKeys = new Map<string, string>();

  /**
   * Focus one connection, and one of its tabs. The active tab ALWAYS belongs to the
   * active connection — that single invariant is what lets every "active X" accessor
   * (caps, schema, transaction, permissions, dialect) keep meaning one connection.
   */
  function focusConnection(connectionId: string, tabId?: string) {
    const owned = tabsOf(connectionId);
    const target = tabId && owned.some((t) => t.id === tabId)
      ? tabId
      : (owned.some((t) => t.id === lastTabByConn.get(connectionId)) ? lastTabByConn.get(connectionId) : undefined) ?? owned[0]?.id;
    // A connection with no tab of its own would leave the active tab pointing at
    // another connection — the one state every "active X" accessor assumes cannot
    // happen. Give it one rather than publishing the broken pairing.
    const fallback: Tab | null = target || !entryOf(connectionId) ? null : makeTab({ connectionId });
    // Batched: see switchTab. The intermediate state is observable and harmful.
    batch(() => {
      if (fallback) setTabs((ts) => [...ts, fallback]);
      setActiveConnectionId(connectionId);
      const landing = target ?? fallback?.id;
      if (landing) {
        setActiveTabId(landing);
        lastTabByConn.set(connectionId, landing);
      }
    });
  }

  /**
   * Chip labels, disambiguated when two sessions report the same database name.
   *
   * Two memos on purpose. Reading every connection's whole state tracks the run
   * timer, which ticks 5×/s during any query; a Map returned from that would never
   * dedupe by reference, so every dependent — including the window-title effect,
   * which calls into the OS — would re-run at 5 Hz. The key memo absorbs the ticks
   * (it returns a string, so it dedupes), and `on()` keeps the map's own reads
   * untracked.
   */
  const connectionLabelKey = createMemo(() =>
    connections().map((e) => `${e.conn.id}\u0000${e.state().tree?.database ?? ""}\u0000${e.conn.target}`).join("\u0001"));
  const connectionLabelMap = createMemo(
    on(connectionLabelKey, () => connectionLabels(connections().map((e) => e.state()))),
  );
  const labelOf = (connectionId: string) =>
    connectionLabelMap().get(connectionId) ?? entryOf(connectionId)?.conn.target ?? "";
  const kindOf = (connectionId: string) => connectionKindOf(stateOf(connectionId));
  /** The first connection holding an open manual transaction (window close scans all). */
  const anyTransactionOpen = () => connections().find((e) => transactionOpen(e.state().transaction)) ?? null;

  /** Remember which saved profiles were open, for the connect screen's "Reopen last session". */
  const rememberOpenConnections = () => persistLayout();

  const ownerTab = () => tabs().find((t) => t.id === transaction().owner);
  const ownerPendingCount = () => pendingCount(ownerTab()?.pending);
  const activeOwnsTransaction = () => transactionOwnedBy(transaction(), activeTabId());
  const activeDatabaseAllowed = () => transactionDatabaseAllowed(transaction(), activeTabId());
  const metadataFrozen = () => transactionOpen(transaction());

  /**
   * Read (and consume) the interrupted-transaction breadcrumb for ONE destination.
   * Markers are per connection key now; the single legacy slot is still honoured once,
   * for the connection it actually named, and removed on the way through.
   */
  function takeInterruptedMarker(connectionKey: string) {
    try {
      const own = decodeInterruptedTransaction(localStorage.getItem(interruptedTransactionKey(connectionKey)));
      if (own) return own;
      const legacy = decodeInterruptedTransaction(localStorage.getItem(INTERRUPTED_TRANSACTION_KEY));
      if (legacy && legacy.connectionKey === connectionKey.slice(0, 2048)) {
        localStorage.removeItem(INTERRUPTED_TRANSACTION_KEY);
        return legacy;
      }
    } catch {
      /* Advisory recovery warning only. */
    }
    return null;
  }

  function removeInterruptedMarker(connectionKey: string) {
    try {
      localStorage.removeItem(interruptedTransactionKey(connectionKey));
      const legacy = decodeInterruptedTransaction(localStorage.getItem(INTERRUPTED_TRANSACTION_KEY));
      if (!legacy || legacy.connectionKey === connectionKey.slice(0, 2048)) localStorage.removeItem(INTERRUPTED_TRANSACTION_KEY);
    } catch {
      /* Recovery marker is advisory; storage failure must not affect transaction control. */
    }
  }

  /** Keep the per-connection marker slots bounded by the open-connection ceiling. */
  function pruneInterruptedMarkers() {
    try {
      const entries: { key: string; startedAt: number }[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(INTERRUPTED_TRANSACTION_PREFIX)) continue;
        entries.push({ key, startedAt: decodeInterruptedTransaction(localStorage.getItem(key))?.startedAt ?? 0 });
      }
      for (const key of evictInterruptedMarkers(entries, MAX_CONNECTIONS)) localStorage.removeItem(key);
    } catch {
      /* Advisory marker only. */
    }
  }

  function persistInterruptedMarker(c: Connected, status: TransactionStatus, startedAt: number | null) {
    if (startedAt === null) return;
    const raw = encodeInterruptedTransaction(c.key, c.target, status, startedAt);
    if (!raw) return;
    try {
      localStorage.setItem(interruptedTransactionKey(c.key), raw);
      pruneInterruptedMarkers();
    } catch {
      /* Advisory marker only. */
    }
  }

  /**
   * Apply transaction state before result-origin checks; stale UI payloads cannot
   * suppress it. `target` names the connection this status belongs to — never "the
   * active one": a command finishing on a background connection must land on its own
   * transaction bar, and must not touch another connection's tabs or results.
   */
  function applyAuthoritativeTransaction(
    target: Connected,
    incoming: unknown,
    event: TransactionEvent = "statement",
    eventBaseline?: TransactionStatus,
  ): boolean {
    const entry = entryOf(target.id);
    const rt = runtimes.get(target.id);
    if (!entry || !rt || entry.conn.generation !== target.generation) return false;
    const previous = entry.state().transaction;
    const accepted = acceptTransactionStatus(previous, incoming, target.generation, entry.conn.generation);
    if (!accepted.accepted) return false;
    const next = accepted.status;
    const opening = !transactionOpen(previous) && transactionOpen(next);
    const newIdentity = transactionOpen(next) && previous.id !== next.id;
    let startedAt = entry.state().transactionStartedAt;
    if (opening || newIdentity) {
      startedAt = Date.now();
      entry.patch({ transactionStartedAt: startedAt });
      setTransactionNow(startedAt);
      rt.transactionHistoryKey = next.id ? `${next.id}@${startedAt.toString(36)}` : null;
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
        // Only this connection's tabs: another connection's results were never
        // produced inside this transaction and must not be marked stale by it.
        if (tab.connectionId !== target.id) return tab;
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

    entry.patch({ transaction: next });
    if (transactionOpen(next)) {
      persistInterruptedMarker(target, next, startedAt);
      // Surfaces that could act on the wrong state close only when the transaction
      // belongs to the connection the user is looking at — a transaction opening on a
      // background connection must not dismiss the dialog you are filling in here.
      if (activeConnectionId() === target.id) {
        setMenuState(null);
        setDdlGraph(null);
        setActiveDialog(null);
        // Backup/restore need an idle session; an opened transaction has taken it.
        closeBackup();
        closeRestore();
        if (importOpen() && !importBusy()) {
          setImportOpen(null);
          importOrigin = null;
        }
        if (exportTables() && !exportTablesBusy()) setExportTables(null);
      }
      if (next.state === "lost") {
        entry.patch({ transactionWarning: `Transaction ${next.id ?? "session"} was lost. Disconnect and reconnect, then verify its outcome.` });
      }
    } else {
      entry.patch({ transactionStartedAt: null });
      rt.transactionHistoryKey = null;
      removeInterruptedMarker(target.key);
      queueMicrotask(() => {
        if (rt.deferredSchemaRefresh && connectionOpen(target) && !transactionOpen(stateOf(target.id)?.transaction ?? IDLE_TRANSACTION)) {
          rt.deferredSchemaRefresh = false;
          void loadSchema(target);
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
  // Connection-scoped surfaces close when the focus moves to another connection:
  // their live SQL preview is rendered with the ACTIVE dialect, and their Run is
  // pinned to the origin connection, so leaving one up would only show a lie.
  createEffect(on(activeConnectionId, (id, previous) => {
    if (previous === undefined || id === previous) return;
    setMenuState(null);
    setActiveDialog(null);
    setDdlGraph(null);
    setCellView(null);
    setRunChoice(null);
    setSelected(null);
    setCommitView(null);
    closeBackup();
    closeRestore();
    // These are frozen against one connection's result; after a switch their Run
    // silently fails the origin check, which reads as a dead button. A run already
    // in flight is the exception — it owns its progress and Cancel.
    if (!exportBusy()) setExportSrc(null);
    if (!exportTablesBusy()) { setExportTables(null); setExportTablesProgress(null); }
    if (!importBusy()) { setImportOpen(null); importOrigin = null; }
  }, { defer: true }));

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
    filters: FilterTree,
    action = "sort/filter",
  ): string | null => {
    try {
      // The wrap is quoted for the TAB's connection. `withDialect` also covers the
      // identifier quoting inside the filter renderer, which reads the module dialect.
      const dialect = kindOf(tab.connectionId);
      return withDialect(dialect, () =>
        wrapQuery(tab.result.baseQuery, sorts, filters, tab.result.columns, dialect, filterClassOf()));
    } catch (e) {
      patchResult(tab.id, { status: `${action} rejected: ${errMsg(e)}` });
      return null;
    }
  };
  // Distinct schema names for the active-schema (search_path) selector.
  const schemaNames = createMemo(() => [...new Set(schema().map((t) => t.schema))].sort());

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
  // Re-applied on EVERY active-connection switch (the memo changes with it), so the
  // module-level dialect always belongs to the connection on screen. SQL built for a
  // tab/dialog on another connection must pin its own dialect - see `withDialect`.
  createEffect(() => setSqlDialect(conn() ? connectionKind() : activeDialect()));
  // MySQL string literals in generated DDL (COMMENT text) must escape backslashes the
  // way the SERVER's sql_mode reads them back; the backend reports it at connect.
  createEffect(() => setMysqlNoBackslashEscapes(!!conn() && caps()?.noBackslashEscapes === true));
  const [cursorInfo, setCursorInfo] = createSignal<CursorInfo | null>(null);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let restoring = false;

  const updatePrefs = (patch: Partial<EditorPrefs>) => {
    const next = { ...prefs(), ...patch };
    setPrefs(next);
    // Loud like the AI/Slack panes: a silently unsaved pref "works" until restart.
    if (!prefsStore.save(next))
      setPersistenceWarning("Editor settings could not be saved. They apply now and reset when Tusk restarts.");
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

  // --- ui/customize: density / UI scale / Explorer side ---
  // Density stamps <html data-density> AND writes its token set inline, so the
  // tokens exist even before the CSS block that declares them is reached.
  // Scale sets the root font size; rem-sized UI follows, the editor does not.
  createEffect(() => {
    const el = document.documentElement;
    const d = normalizeDensity(prefs().density);
    el.dataset.density = d;
    for (const [k, v] of Object.entries(densityTokens(d))) el.style.setProperty(k, v);
  });
  createEffect(() => {
    document.documentElement.style.fontSize = rootFontSize(prefs().uiScale);
  });
  createEffect(() => {
    document.documentElement.dataset.sidebar = prefs().sidebarSide === "right" ? "right" : "left";
  });
  // --- end ui/customize appearance effects ---

  // --- keyboard shortcuts: persisted overrides + a canonical-key → action map ---
  const [keys, setKeys] = createSignal<KeyOverrides>(keymapStore.load());
  const updateKeys = (patch: KeyOverrides) => {
    const next = { ...keys(), ...patch };
    // `undefined` in a patch means "back to default" — drop the override entirely
    // (vs null, which is persisted as "explicitly unbound").
    for (const k of Object.keys(next) as ActionId[]) if (next[k] === undefined) delete next[k];
    setKeys(next);
    if (!keymapStore.save(next))
      setPersistenceWarning("Shortcut changes could not be saved. They apply now and reset when Tusk restarts.");
  };
  const resetKeys = () => {
    setKeys({});
    if (!keymapStore.save({}))
      setPersistenceWarning("Shortcut reset could not be saved. Defaults apply now and overrides may return on restart.");
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
    canFilter: canFilter(),
    connectionCount: connections().length,
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
    if (!c || running() || activeRuntime()?.cursorOwner != null || metadataFrozen() || !prefs().serverLint) return [];
    try {
      const diagnostics = await invoke<ServerDiag[]>("validate_sql", { connectionId: c.id, sql: sqlText, searchPath: activeTab().searchSchema });
      return connectionOpen(c) && originCurrent(origin) ? diagnostics : [];
    } catch {
      return [];
    }
  };

  // --- tab management + file flow ---
  const [confirmClose, setConfirmClose] = createSignal<{ tabId: string; dirty: boolean; pending: number } | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = createSignal<{ connectionId: string; count: number } | null>(null);
  const [confirmWindowClose, setConfirmWindowClose] = createSignal<number | null>(null);
  // A resolution intent names the connection whose transaction must end first: with
  // several open, "the transaction" is not a global fact.
  type TransactionResolution =
    | { kind: "close-tab"; tabId: string; connectionId: string }
    | { kind: "disconnect"; connectionId: string }
    | { kind: "window-close"; connectionId: string };
  const [transactionResolution, setTransactionResolution] = createSignal<TransactionResolution | null>(null);
  const [transactionResolutionBusy, setTransactionResolutionBusy] = createSignal(false);
  let allowNativeClose = false;
  let nativeCloseUnlisten: UnlistenFn | null = null;
  // Snapshot of the result being exported, frozen when the dialog opens so a tab
  // switch while it's open can't redirect the export to a different tab.
  /** Live grid selection, registered by ResultGrid (Export → Selection scope). Cleared
   *  on grid unmount; the snapshot carries the tab + result generation it came from, so
   *  a stale getter can never feed a different result of the same width. */
  let gridSelection: (() => SelectionSource | null) | null = null;
  const [exportSrc, setExportSrc] = createSignal<
    {
      columns: string[];
      rows: (string | null)[][];
      /** Frozen copy of the grid selection when the dialog opened (scope=selection). */
      selectionRows: (string | null)[][];
      query: string;
      table: string;
      searchSchema: string | null;
      /** Source relation for "Include CREATE TABLE" (absent = not a plain table). */
      ddl?: { schema: string; name: string; kind: string };
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
      const wrapped = tryWrapQuery(tab, tab.gridView.sorts, emptyFilter(), "export query");
      if (wrapped === null) return;
      query = wrapped;
    }
    const selection = gridSelection?.() ?? null;
    const selectionCurrent =
      !!selection &&
      selection.tabId === activeTabId() &&
      selection.generation === tab.result.generation &&
      selection.columns.length === columns().length;
    // "Include CREATE TABLE" needs a plain source table; reuse the grid's own
    // single-table resolver rather than re-parsing the query here.
    const resolved = editTarget(tab.result.baseQuery, editIndexer(schema()), tab.searchSchema, kindOf(tab.connectionId));
    const ddlTarget = resolved.ok ? resolved.table : null;
    setExportSrc({
      columns: columns(),
      rows: orderedRows(rows(), order),
      selectionRows: selectionCurrent ? selection!.rows : [],
      incomplete: tab.result.incomplete,
      ddl: ddlTarget && caps()?.ddl !== false
        ? { schema: ddlTarget.schema, name: ddlTarget.name, kind: "table" }
        : undefined,
      query,
      table: tableNameFromSql(query),
      searchSchema: tab.searchSchema,
      boolCols: [...boolCols()],
      origin: captureOrigin(),
      connectionId: c.id,
      dialect: connectionKind(),
    });
  };

  /**
   * Focus a tab — and, with it, the connection that tab belongs to.
   *
   * BATCHED, and that is load-bearing: Solid flushes effects after every write, so
   * setting the tab and the connection separately would publish an intermediate state
   * pairing one connection's tab with another connection's schema/details/perms. The
   * editability effect and the FK-prefetch effect both act on that pairing, and would
   * fetch (and cache) one connection's relation against the other — closing its result
   * stream on the way. Never split these two writes.
   */
  function switchTab(id: string) {
    const t = tabs().find((x) => x.id === id);
    if (!t || id === activeTabId()) return;
    batch(() => {
      setActiveTabId(id); // ResultGrid restores its own scroll/selection on the tab change
      lastTabByConn.set(t.connectionId, id);
      if (t.connectionId !== activeConnectionId()) setActiveConnectionId(t.connectionId);
    });
  }

  /** New tabs always open on the connection currently in focus. */
  function openNewTab() {
    const id = activeConnectionId();
    if (!id) return;
    const t = makeTab({ connectionId: id });
    setTabs((ts) => [...ts, t]);
    switchTab(t.id);
  }

  // Open generated SQL in a fresh tab (never clobber the current one), with the
  // console's active schema set so the generated unqualified names resolve. Not
  // marked dirty — it's regenerable and becomes dirty once the user edits it.
  function openGeneratedTab(sqlText: string, schema: string | null, title?: string) {
    const id = activeConnectionId();
    if (!id) return;
    const t = makeTab({ connectionId: id, sql: sqlText, searchSchema: schema, title });
    setTabs((ts) => [...ts, t]);
    switchTab(t.id);
  }

  // --- tab QoL: rename / close-many / drag-reorder ---
  // Pointer reorder state (src/dnd.ts). `dragTabId` dims the source in place;
  // `tabDropSlot` positions the insertion bar. Neither touches the tab model —
  // `tabs()` only changes on the drop, so a cancelled drag needs no restore and a
  // running query, the cursor owner, recovery snapshots and each tab's connection
  // binding are all untouched (they key on tab id, never on strip position).
  const [dragTabId, setDragTabId] = createSignal<string | null>(null);
  const [tabDropSlot, setTabDropSlot] = createSignal<number | null>(null);
  let stripEl: HTMLDivElement | undefined;
  let tabDrag: PointerDragHandle | null = null;
  /** Set when a press turned into a drag, so the trailing click doesn't switch tabs. */
  let tabClickBlocked = false;

  /** Item boundaries of the rendered tabs, in the strip's content coordinates. */
  const tabEdges = () =>
    stripEl ? measureEdges(Array.from(stripEl.querySelectorAll<HTMLElement>(".tab")), stripEl) : [];

  /**
   * Commit a strip reorder: move the tab at `from` into insertion slot `slot`,
   * clamped so a pinned tab stays inside the pinned group and an unpinned one
   * stays out of it (`clampPinSlot`).
   */
  function moveTabSlot(from: number, slot: number) {
    setTabs((ts) => reorder(ts, from, clampPinSlot(ts, from, slot)) as Tab[]);
  }

  function startTabDrag(e: PointerEvent, index: number, el: HTMLElement) {
    tabDrag?.cancel();
    tabDrag = startPointerDrag({
      event: e,
      from: index,
      source: el,
      scroller: stripEl!,
      edges: tabEdges,
      onStart: () => {
        tabClickBlocked = true;
        setDragTabId(tabs()[index]?.id ?? null);
      },
      onSlot: setTabDropSlot,
      onDrop: moveTabSlot,
      onEnd: () => {
        tabDrag = null;
        setDragTabId(null);
      },
    });
  }

  /** Alt+Shift+←/→: move the active tab one slot along the strip and keep it in view. */
  function moveActiveTab(delta: 1 | -1) {
    const id = activeTabId();
    setTabs((ts) => {
      const from = ts.findIndex((t) => t.id === id);
      if (from < 0) return ts;
      return reorder(ts, from, clampPinSlot(ts, from, from + (delta === 1 ? 2 : -1))) as Tab[];
    });
    queueMicrotask(() => stripEl?.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  }

  /** Close every tab matching the predicate, skipping dirty ones (reported). */
  /** Is a query in flight on THIS tab? Asked of the tab's OWN connection: another
   *  connection running a query says nothing about whether this tab can close. */
  const tabIsRunning = (tabId: string) => {
    const st = stateOf(tabs().find((t) => t.id === tabId)?.connectionId);
    return !!st?.running && st.runningTabId === tabId;
  };

  /**
   * Close many tabs of ONE connection. Scoped to a connection because the strip is
   * shared: "Close others" from a tab must not reach into another connection's tabs.
   *
   * `closeManyTargets` picks the candidates (pinned tabs are never candidates); each
   * one still has to pass the same guards a single close does — unsaved buffer,
   * pending grid edits, a query running on ITS OWN connection, and ownership of a
   * manual transaction. A tab that refuses is skipped, never forced, and the counts
   * are reported.
   */
  function closeTabsScoped(connectionId: string, anchorId: string, scope: CloseScope) {
    const targets = closeManyTargets(tabsOf(connectionId), anchorId, scope);
    const refuses = (t: Tab) => {
      const st = stateOf(t.connectionId);
      if (st?.running && st.runningTabId === t.id) return true;
      const owner = entryOf(t.connectionId);
      if (owner && transactionOwnedBy(owner.state().transaction, t.id)) return true;
      return t.dirty || pendingCount(t.pending) > 0;
    };
    let closed = 0;
    let kept = 0;
    for (const t of targets) {
      if (refuses(t)) kept++;
      else {
        removeTab(t.id);
        closed++;
      }
    }
    const plural = (n: number) => `${n} tab${n === 1 ? "" : "s"}`;
    if (!closed && !kept) setStatus("No tabs to close");
    else if (kept) setStatus(`Closed ${plural(closed)}; kept ${plural(kept)} with unsaved, pending, running, or transaction work`);
    else setStatus(`Closed ${plural(closed)}`);
  }

  // --- ui/customize: rename, pin, colour tag ---
  /** Tab being renamed inline in the strip, plus the text typed so far. */
  const [inlineRename, setInlineRename] = createSignal<{ id: string; text: string } | null>(null);

  function beginRename(id: string) {
    const t = tabs().find((x) => x.id === id);
    if (!t) return;
    setInlineRename({ id, text: t.customTitle || t.title });
  }

  /** Commit the inline rename. A blank title clears the custom one (auto title returns). */
  function commitRename() {
    const r = inlineRename();
    setInlineRename(null);
    if (!r) return;
    if (!tabs().some((t) => t.id === r.id)) return;
    patchTab(r.id, { customTitle: cleanTabTitle(r.text) });
  }

  function togglePin(id: string) {
    setTabs((ts) => {
      const next = ts.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t));
      return sortPinned(next) as Tab[];
    });
    queueMicrotask(() => stripEl?.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  }

  const setTabColor = (id: string, color: TabColor) => patchTab(id, { color });

  /** The "All tabs" popover (⌄ in the strip, or the showAllTabs action). */
  const [allTabsOpen, setAllTabsOpen] = createSignal(false);
  const tabSwitcherItems = (): TabSwitcherItem[] =>
    tabs().map((t) => ({
      id: t.id,
      label: tabLabel(t),
      detail: t.filePath ?? "",
      connectionId: t.connectionId,
      connectionLabel: labelOf(t.connectionId),
      mascot: driverMascot(kindOf(t.connectionId)),
      dirty: t.dirty,
      pinned: t.pinned,
      color: t.color,
      active: t.id === activeTabId(),
    }));
  // --- end ui/customize tab operations ---

  function removeTab(id: string) {
    if (tabIsRunning(id)) {
      patchResult(id, { status: "Cancel or wait for this query before closing its owner tab" });
      return;
    }
    const owningEntry = entryOf(tabs().find((t) => t.id === id)?.connectionId);
    if (owningEntry && transactionOwnedBy(owningEntry.state().transaction, id)) {
      raiseTransactionResolution(owningEntry, { kind: "close-tab", tabId: id });
      return;
    }
    const closing = tabs().find((t) => t.id === id);
    const owningConnection = closing?.connectionId ?? "";
    const rt = runtimes.get(owningConnection);
    if (rt?.cursorOwner?.tabId === id) {
      rt.cursorOwner = null;
      rt.cursorGeneration++;
    }
    saveOperations.delete(id);
    editorApi()?.dropTab(id);
    const siblings = tabsOf(owningConnection);
    const idx = siblings.findIndex((t) => t.id === id);
    const next = tabs().filter((t) => t.id !== id);
    // A connection always keeps at least one tab: closing its last one opens a fresh
    // tab ON THAT CONNECTION rather than leaving it unreachable in the strip.
    if (owningConnection && siblings.length === 1 && entryOf(owningConnection)) {
      const fresh = makeTab({ connectionId: owningConnection });
      setTabs([...next, fresh]);
      if (activeTabId() === id) focusConnection(owningConnection, fresh.id);
      else lastTabByConn.set(owningConnection, fresh.id);
      return;
    }
    setTabs(next);
    if (activeTabId() === id) {
      const remaining = next.filter((t) => t.connectionId === owningConnection);
      const neighbor = remaining[Math.min(idx, remaining.length - 1)] ?? next[0];
      if (neighbor) switchTab(neighbor.id);
    }
  }

  function closeTab(id: string) {
    const t = tabs().find((x) => x.id === id);
    if (!t) return;
    if (tabIsRunning(id)) {
      patchResult(id, { status: "Cancel or wait for this query before closing its owner tab" });
      return;
    }
    const owner = entryOf(t.connectionId);
    if (owner && transactionOwnedBy(owner.state().transaction, id)) {
      raiseTransactionResolution(owner, { kind: "close-tab", tabId: id });
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
      const path = await chooseOpenPath({ filters: [{ name: "SQL", extensions: ["sql", "txt"] }] });
      if (!originCurrent(origin)) return;
      if (!path) return;
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
      const owner = activeConnectionId();
      if (!owner) return;
      const t = makeTab({ connectionId: owner, sql: contents, filePath: path, title: basename(path), dirty: false });
      setTabs((ts) => [...ts, t]);
      switchTab(t.id);
    } catch (e) {
      if (origin.tabId && originCurrent(origin)) patchResult(origin.tabId, { runErr: errMsg(e) });
    }
  }

  /**
   * Every native picker in the workbench funnels through here. `filePicker` reports a
   * destination as UNVERIFIED when the dialog resolved without ever taking focus — the
   * failure a smoke run hit on Windows/WebView2, where `save()` handed back a default
   * path in Downloads and no window was ever shown. A path Tusk cannot prove the user
   * chose is confirmed, never written to on its own.
   */
  const [confirmPickedPath, setConfirmPickedPath] = createSignal<
    { path: string; resolve: (ok: boolean) => void } | null
  >(null);
  const settlePickedPath = (ok: boolean) => {
    const pending = confirmPickedPath();
    setConfirmPickedPath(null);
    pending?.resolve(ok);
  };
  async function confirmedPath(picked: PickedPath): Promise<string | null> {
    if (!picked.path) return null;
    if (picked.verified) return picked.path;
    const path = picked.path;
    const ok = await new Promise<boolean>((resolve) => setConfirmPickedPath({ path, resolve }));
    return ok ? path : null;
  }
  const chooseSavePath = async (options: PickerOptions) => confirmedPath(await pickSavePath(options));
  const chooseOpenPath = async (options: PickerOptions) => confirmedPath(await pickOpenPath(options));

  const saveOperations = new Map<string, number>();
  const fileWrites = new KeyedSerialQueue<string>();
  async function saveTab(tabId: string, saveAs: boolean): Promise<boolean> {
    let t = tabs().find((x) => x.id === tabId);
    if (!t) return false;
    try {
      let filePath = t.filePath;
      if (saveAs || !filePath) {
        filePath = await chooseSavePath({ defaultPath: t.filePath ?? `${t.title}.sql`, filters: [{ name: "SQL", extensions: ["sql"] }] });
        if (!filePath) return false;
      }
      t = tabs().find((x) => x.id === tabId);
      if (!t) return false;
      if (tabs().some((x) => x.id !== tabId && x.filePath === filePath))
        throw new Error("That file is already open in another tab");
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
      patchResult(tabId, { status: unchanged ? `Saved ${filePath}` : `Saved ${filePath}. Newer edits remain unsaved.` });
      return unchanged;
    } catch (e) {
      if (tabs().some((x) => x.id === tabId)) patchResult(tabId, { runErr: errMsg(e) });
      return false;
    }
  }

  const saveActiveTab = () => saveTab(activeTabId(), false);
  const saveAsActiveTab = () => saveTab(activeTabId(), true);

  // import dialog — multi-step; the backend streams the file from disk, so no file
  // bytes cross the IPC boundary and progress arrives as `import-progress` events.
  /**
   * The dialog stays mounted while a run is in flight, so its catalog is FROZEN at
   * open time the way `exportSrc` freezes a result: reading `tree()`/`schema()`/
   * `connectionKind()` live would repaint the other connection's tables under a
   * failed import that still offers **Back**, while `runImport` keeps sending the
   * bound connection's id.
   */
  const [importOpen, setImportOpen] = createSignal<{
    target: { schema: string; name: string } | null;
    dialect: string;
    supportsSchemas: boolean;
    schemas: string[];
    tables: { schema: string; name: string }[];
    defaultSchema: string;
  } | null>(null);
  const [importBusy, setImportBusy] = createSignal(false);
  const [importProgress, setImportProgress] = createSignal<ImportProgress | null>(null);
  let importOrigin: { origin: UiOrigin; connection: Connected } | null = null;

  // Explorer multi-table export.
  const [exportTables, setExportTables] = createSignal<
    { title: string; tables: { schema: string; name: string }[]; selection: { schema: string; name: string }[]; connectionId: string } | null
  >(null);
  const [exportTablesBusy, setExportTablesBusy] = createSignal(false);
  /**
   * A single-result export is running (native save dialog open, or the backend
   * streaming an all-rows re-run). Like `exportTablesBusy` and `importBusy` it keeps
   * the dialog mounted across an active-connection switch: the dialog owns the run's
   * progress and its Cancel, and unmounting it mid-run loses both. The snapshot it
   * works from is frozen, so staying open cannot retarget another connection.
   */
  const [exportBusy, setExportBusy] = createSignal(false);
  const [exportTablesProgress, setExportTablesProgress] = createSignal<
    { index: number; total: number; table: string; rows: number; done: boolean } | null
  >(null);
  const [rememberedExport, setRememberedExport] = createSignal<RememberedExportOptions>(exportOptionsStore.load());
  const rememberExportOptions = (format: string, values: Record<string, unknown>) => {
    const next = { ...rememberedExport(), [format]: values };
    setRememberedExport(next);
    exportOptionsStore.save(next);
  };

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
  // Whether this DuckDB build accepts PG-style `EXPLAIN (FORMAT json)` — probed once
  // per connection at connect time (a probe mid-session could disturb the pager), so
  // it is a per-connection fact, not a module flag: two DuckDB builds can differ.
  const duckJsonExplain = () => activeState()?.duckJsonExplain ?? false;

  function runExplain(analyze: boolean) {
    if (!activeDatabaseAllowed()) {
      setStatus(`Switch to ${ownerTab()?.title ?? "the transaction owner"} to run database actions`);
      return;
    }
    const unsupported = explainUnsupported(connectionKind());
    if (unsupported) {
      setStatus(unsupported);
      return;
    }
    const api = editorApi();
    if (!api) return;
    const stmt = api.getSelection().trim() || api.getCurrentStatement();
    if (!stmt.trim()) return;
    if (!isSingleExplainStatement(stmt, connectionKind())) {
      setStatus("Explain needs one statement. Select a single statement and run again.");
      return;
    }
    const wrapped = explainSql(connectionKind(), analyze, stmt, duckJsonExplain());
    if (analyze && analyzeExecutesWrite(stmt, connectionKind())) {
      setConfirmAnalyze({ sql: wrapped, origin: captureOrigin() });
      return;
    }
    runParameterized(wrapped, (substituted) => void executeQuery(substituted, "", "base", false, wrapped));
  }

  // result grid: per-tab view + sort/filter re-run, Load-all
  const gridView = () => activeTab().gridView;
  const setGridView = (patch: Partial<GridView>) => patchTab(activeTabId(), { gridView: { ...activeTab().gridView, ...patch } });
  const canServerSortFilter = () =>
    wrappableQuery(activeTab().result.baseQuery, connectionKind()) &&
    // MySQL (error 1060) and SQL Server (error 8156) both refuse duplicate column
    // names inside a derived table, so the sort/filter wrap can't work on such results.
    !(["mysql", "mssql"].includes(connectionKind()) && hasDuplicateColumns(activeTab().result.columns));
  const localSortEligible = () => {
    const tab = activeTab();
    // An interrupted stream holds only part of the result: sorting it in memory would
    // order a subset while looking like the whole. Fall through to the server path.
    return tab.result.done && !tab.result.incomplete && tab.result.rowsAreBase && !hasConditions(tab.gridView.filters) && tab.result.rows.length <= MAX_LOCAL_SORT_ROWS;
  };
  /** Why a header click can't sort right now (empty when it can). Shown as status feedback. */
  const sortUnavailable = () => {
    if (running()) return "Sorting is unavailable while a query is running";
    if (!activeDatabaseAllowed())
      return transaction().state === "lost" ? "Transaction session lost. Disconnect and reconnect to sort." : "Sorting is frozen while another tab owns the transaction";
    if (!canServerSortFilter()) {
      if (activeTab().result.incomplete) return "This result is incomplete. Re-run the query to sort it.";
      if (!activeTab().result.done) return "Load all rows to sort this result.";
      // SQL Server can't wrap a CTE-led statement, or one whose ordering the wrap can't
      // hoist, as a derived table. Say that instead of blaming the in-memory sort limit —
      // and never tell the user to add the ORDER BY that disabled the button.
      if (connectionKind() === "mssql" && !mssqlWrappable(activeTab().result.baseQuery))
        return "SQL Server can't sort this result: the statement can't be re-run as a derived table.";
      return "This result can't be sorted: it isn't a single re-runnable SELECT and exceeds the in-memory sort limit.";
    }
    return "";
  };
  const canSort = () => !running() && (localSortEligible() || (activeDatabaseAllowed() && canServerSortFilter()));
  const canFilter = () => !running() && activeDatabaseAllowed() && canServerSortFilter();
  const localSortRows = createMemo(() => activeTab().result.rows);
  const localSorts = createMemo(() => activeTab().gridView.sorts);
  const localSortDone = createMemo(() => activeTab().result.done && !activeTab().result.incomplete);
  const localSortBase = createMemo(() => activeTab().result.rowsAreBase);
  const localSortHasFilters = createMemo(() => hasConditions(activeTab().gridView.filters));
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
    if (running()) return { editable: false, reason: "A query is running", plan: null };
    if (c.readOnly) return { editable: false, reason: "Connection is read-only", plan: null };
    const tx = transaction();
    const result = activeTab().result;
    if (result.transactionStale) return { editable: false, reason: result.transactionStale, plan: null };
    if (activeTab().pending?.stale) return { editable: false, reason: activeTab().pending!.stale!, plan: null };
    if (transactionOpen(tx)) {
      if (tx.state === "lost") return { editable: false, reason: "Transaction session was lost", plan: null };
      if (tx.state === "failed") return { editable: false, reason: "Transaction failed; roll it back first", plan: null };
      if (tx.owner !== activeTabId()) return { editable: false, reason: `Transaction is owned by ${ownerTab()?.title ?? tx.owner ?? "another tab"}`, plan: null };
      if (result.transactionId !== tx.id) return { editable: false, reason: "Result predates the active transaction; rerun it before editing", plan: null };
    } else if (result.transactionId !== null) {
      return { editable: false, reason: "Transaction ended; rerun before editing", plan: null };
    } else if (result.generation > 0 && result.transactionRevision !== tx.revision) {
      return { editable: false, reason: "Transaction state changed; rerun before editing", plan: null };
    }
    // The tab's active schema pins the session search_path, so bare-name
    // resolution inside editTarget may use the same active→public chain the
    // server applies; without one, ambiguous names stay uneditable.
    const tgt = editTarget(editBaseQ(), editIndexer(schema()), activeTab().searchSchema, kindOf(activeTab().connectionId));
    if (!tgt.ok) return { editable: false, reason: tgt.reason, plan: null };
    // PG permission model: no write privilege at all → don't offer editing
    // (partial privileges still commit — the server enforces per statement).
    if (perms()?.enforced && !isSuper()) {
      const tp = tablePriv(tgt.table.schema, tgt.table.name);
      if (tp && !tp.isOwner && !tp.update && !tp.insert && !tp.delete)
        return { editable: false, reason: `No write privilege on ${tgt.table.name}`, plan: null };
    }
    const det = details()[relKey(tgt.table.schema, tgt.table.name)];
    if (!det) {
      // The detail read rolls back the server cursor, so it must never run while
      // this result is still streaming (executeQuery prefetches it before the run;
      // this is the fallback when that missed, e.g. metadata was frozen).
      if (metadataFrozen())
        return { editable: false, reason: "Table info can't load during a manual transaction; expand the table in the Explorer first", plan: null };
      if (!result.done)
        return { editable: false, reason: "Table info loads once the result finishes streaming (Load all)", plan: null };
      return { editable: false, reason: "Loading table info…", plan: null, want: { schema: tgt.table.schema, name: tgt.table.name } };
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
    if (det) return typeBoolCols(editCols(), det.columns, connectionKind());
    return detectBoolCols(editCols(), editRows());
  });
  /**
   * Column name → driver type for the active result, when its source relation's
   * detail happens to be loaded (the editability path already fetches it). Drives
   * the filter builder's type badges/operator menus and the numeric/boolean
   * literal choice in the generated WHERE; absent metadata is not an error —
   * every column then behaves as the conservative "other" class.
   */
  const filterColumnTypes = (): Record<string, string> | undefined => {
    const det = editDetail();
    if (!det) return undefined;
    return Object.fromEntries(det.columns.map((c) => [c.name, c.data_type]));
  };
  const filterClassOf = () => classResolver(filterColumnTypes());
  /** Dropdown editor info for a bool column; tokens match the driver's textual booleans. */
  const boolEditInfo = (oi: number): { trueVal: string; falseVal: string; nullable: boolean } | null => {
    const det = editDetail();
    if (!det || !editCtx().editable || !boolCols().has(oi)) return null;
    const name = editCols()[oi]?.toLowerCase();
    const col = det.columns.find((c) => c.name.toLowerCase() === name);
    if (!col) return null;
    return { ...boolEditTokens(connectionKind()), nullable: col.nullable };
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
      setStatus("Nothing to paste. This result has no editable columns.");
      return;
    }
    const np = mergePaste(p, plan, t.result.rows);
    setPendingFor(t.id, isPendingEmpty(np) ? undefined : np);
    const added = plan.inserts.length;
    setStatus(
      plan.mode === "mapped"
        ? `Pasted ${plan.rowCount} row${plan.rowCount === 1 ? "" : "s"} (mapped by header)`
        : `Pasted ${plan.rowCount}×${plan.colCount}${added ? ` (+${added} new row${added === 1 ? "" : "s"})` : ""}`,
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
      dialect: kindOf(t.connectionId),
    });
    if (!script.length) {
      // Shouldn't happen (non-table cells can't be edited) — but never open a dialog
      // that would run an empty script.
      setStatus("No changes to commit");
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
    const beforeHistoryKey = runtimes.get(c.id)?.transactionHistoryKey ?? null;
    try {
      // Fully-qualified statements — no search_path dependence. Multi-statement
      // scripts run in one transaction (rolled back wholesale on failure).
      const sqlText = cv.script.map((s) => s + ";").join("\n");
      const out = await invoke<QueryResult>("run_query", { connectionId: c.id, ownerId: tabId, sql: sqlText, pageSize: PAGE, searchPath: null });
      const accepted = applyAuthoritativeTransaction(c, out.transaction, "grid_apply", before);
      const source = tabs().find((tab) => tab.id === tabId);
      if (!accepted || transaction().revision !== out.transaction.revision || !connectionOpen(c) ||
          source?.result.generation !== cv.origin.resultGeneration || source.result.epoch !== cv.origin.resultEpoch) return;
      setPendingFor(tabId, undefined);
      setCommitView(null);
      patchResult(tabId, { status: transactionOpen(out.transaction)
        ? `${cv.script.length} change${cv.script.length === 1 ? "" : "s"} applied inside transaction; commit the outer transaction separately`
        : `${cv.script.length} change${cv.script.length === 1 ? "" : "s"} applied` });
      recordHistory({
        sql: historySqlForTransaction(c.id, sqlText, before, out.transaction, "grid_apply", beforeHistoryKey),
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
        const sqlToRun = hasViewRules(v.sorts, v.filters, t.result.columns) ? tryWrapQuery(t, v.sorts, v.filters) : base;
        if (sqlToRun === null) return;
        void executeQuery(sqlToRun, base, "wrapped");
      }
    } catch (e) {
      const embedded = transactionFromError(e);
      if (embedded) applyAuthoritativeTransaction(c, embedded, "grid_apply", before);
      const source = tabs().find((tab) => tab.id === tabId);
      if (connectionOpen(c) && source?.result.generation === cv.origin.resultGeneration && source.result.epoch === cv.origin.resultEpoch) {
        const message = errMsg(e);
        setCommitErr(message);
        recordHistory({
          sql: historySqlForTransaction(c.id, cv.script.map((s) => s + ";").join("\n"), before, embedded ?? transaction(), "grid_apply", beforeHistoryKey),
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
  /** Pending grid edits on ONE connection — what a per-connection prompt may discard. */
  const pendingCountFor = (connectionId: string | null) =>
    connectionId ? tabsOf(connectionId).reduce((total, tab) => total + pendingCount(tab.pending), 0) : 0;
  /** A database operation is in flight on ANY open connection (window-close gate). */
  const anyConnectionBusy = () =>
    connections().some((e) => {
      const st = e.state();
      return st.running || st.fetchingMore || st.loadingAll;
    });
  const closeOperationBusy = () =>
    anyConnectionBusy() || commitBusy() || importBusy() || exportBusy() || exportTablesBusy() || backupBusy() || restoreBusy();

  const [slackStatus, setSlackStatus] = createSignal<SlackStatus>({ running: false, state: "disconnected", error: null });
  /**
   * Why a running bot stopped, shown in the workbench. The badge used to be hidden
   * for `state === "disconnected"`, so the one case that matters most — the bot's
   * bound connection was closed, which stops it — made the badge VANISH and left the
   * reason readable only by opening Settings → Slack.
   */
  const slackStopped = () => (!slackStatus().running && slackStatus().error ? slackStatus().error! : "");
  /** The stop reason in the statusbar text, until the user clicks the badge. */
  const [slackNotice, setSlackNotice] = createSignal("");
  const slackUnlisten: UnlistenFn[] = [];
  const slackHistoryKeys = new Map<string, string>();
  let slackStatusRevision = 0;
  /**
   * Slack autostart, scoped to ONE SAVED connection. The bot answers against a single
   * connection, so it used to be armed as a bare `enabled` flag and bound to whichever
   * session opened first — a database chosen by nobody — and disconnecting that session
   * rewrote the user's settings to disarm it. Instead the bound profile id is persisted:
   * the backend comes up armed-but-stopped, and the bot starts only when THAT saved
   * connection opens. An ad-hoc connection has no profile, so it can be bound by hand
   * but never autostarted.
   */
  const [slackAutostart, setSlackAutostart] = createSignal<{ enabled: boolean; profileId: string | null }>({
    enabled: false,
    profileId: null,
  });
  async function refreshSlackAutostart() {
    try {
      const info = await invoke<{ config: { enabled?: boolean; boundProfileId?: string | null } }>("slack_load_config");
      setSlackAutostart({
        enabled: info.config?.enabled === true,
        profileId: info.config?.boundProfileId || null,
      });
    } catch {
      // Settings → Slack surfaces config failures; autostart just stays off here.
    }
  }
  /** Start (or bind) the Slack bot when the connection it is armed for opens. */
  async function slackAutostartFor(connectionId: string, profileId: string | null) {
    const auto = slackAutostart();
    if (!auto.enabled || !auto.profileId || !profileId || auto.profileId !== profileId) return;
    const status = slackStatus();
    if (status.running) {
      if (!status.connectionId) await invoke("slack_set_connection", { connectionId }).catch(() => {});
      return;
    }
    // Failures publish their reason through `slack:status`; the badge and Settings show it.
    await invoke("slack_start", { connectionId }).catch(() => {});
  }
  /** Connections offered as the Slack bot's target (Settings → Slack picker). */
  const slackConnectionOptions = () =>
    connections().map((e) => ({
      id: e.conn.id,
      label: labelOf(e.conn.id),
      mascot: driverMascot(kindOf(e.conn.id)),
      profileId: e.conn.profileId,
    }));

  const preventNativeContextMenu = (e: Event) => e.preventDefault();
  const showPersistenceFailure = (failure: TabsPersistenceFailure) => {
    const consequence = failure.operation === "remove"
      ? "Old recovery data could not be cleaned up."
      : "Unsaved tabs may not survive closing.";
    setPersistenceWarning(`Editor recovery ${failure.operation} failed (${failure.message}). ${consequence}`);
  };
  /**
   * `clearOnSuccess` exists because the warning banner is global while saves are
   * per connection: inside `persistAllRecovery`'s loop, a success on connection B
   * must not erase the failure just reported for connection A — `onBeforeUnload`
   * would then block the close with nothing on screen explaining why. The loop
   * clears the banner itself, once, only when every connection saved.
   */
  const persistRecoveryTo = (
    rt: ConnRuntime,
    key: string,
    data: PersistedTabs,
    forClose = false,
    clearOnSuccess = true,
  ) => {
    if (!rt.recoveryWritable) {
      const error: TabsPersistenceFailure = {
        operation: "save",
        code: "invalid-data",
        message: "Existing recovery snapshot could not be loaded",
      };
      showPersistenceFailure(error);
      return { ok: false as const, error };
    }
    const result = forClose ? tabsStore.saveForClose(key, data) : tabsStore.saveResult(key, data);
    if (result.ok) {
      if (clearOnSuccess) setPersistenceWarning("");
    } else showPersistenceFailure(result.error);
    return result;
  };
  /**
   * Persist EVERY open connection's tabs and report whether any dirty buffer failed
   * to save. Closing the window must not lose an unsaved buffer just because it
   * belonged to a connection that was not focused.
   */
  const persistAllRecovery = (forClose = false): { unsafeDirty: boolean } => {
    let unsafeDirty = false;
    let allSaved = true;
    for (const entry of connections()) {
      const snapshot = snapshotConnection(entry);
      const saved = persistRecoveryTo(
        entry.runtime,
        recoveryKeys.get(entry.conn.id) ?? entry.conn.key,
        snapshot,
        forClose,
        false,
      );
      if (!saved.ok) {
        allSaved = false;
        if (snapshot.tabs.some((tab) => tab.dirty)) unsafeDirty = true;
      }
    }
    if (allSaved) setPersistenceWarning("");
    return { unsafeDirty };
  };
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    persistLayout(); // records which profiles were open, for "Reopen last session"
    const { unsafeDirty } = persistAllRecovery(true);
    if (allowNativeClose || (!anyTransactionOpen() && !unsafeDirty && totalPendingCount() === 0)) return;
    e.preventDefault();
    e.returnValue = "";
  };
  /** Re-poll every open connection: a session can end underneath any of them. */
  const refreshTransactionStatus = async () => {
    for (const entry of connections()) {
      const c = entry.conn;
      const s = entry.state();
      if (s.running || s.fetchingMore) continue;
      // Import and grid Commit run their own statements, but only ever on ONE
      // connection. Testing the global busy signals stopped polling everywhere, so a
      // session lost on another connection went unnoticed until its next command.
      if (importBusy() && importOrigin?.connection.id === c.id) continue;
      if (commitBusy() && commitView()?.origin.connectionId === c.id) continue;
      try {
        const status = await invoke<TransactionStatus>("transaction_status", { connectionId: c.id });
        if (connectionOpen(c)) applyAuthoritativeTransaction(c, status);
      } catch {
        /* The next transaction-aware command will surface a connection failure. */
      }
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
        const open = anyTransactionOpen();
        if (open) {
          event.preventDefault();
          raiseTransactionResolution(open, { kind: "window-close" });
          return;
        }
        persistLayout(); // records which profiles were open, for "Reopen last session"
        if (persistAllRecovery(true).unsafeDirty) {
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
    // Bulk import/export progress. Best-effort: a rejected listen must never break
    // the app, and a stale event only paints a progress bar.
    try {
      const importUnlisten = await listen<ImportProgress>("import-progress", (e) => {
        if (importBusy()) setImportProgress(e.payload);
      });
      if (!appMounted) importUnlisten(); else slackUnlisten.push(importUnlisten);
      const tablesUnlisten = await listen<{ index: number; total: number; table: string; rows: number; done: boolean }>(
        "export-tables-progress",
        (e) => { if (exportTables()) setExportTablesProgress(e.payload); },
      );
      if (!appMounted) tablesUnlisten(); else slackUnlisten.push(tablesUnlisten);
    } catch {
      /* progress events unavailable; the dialogs still report their result */
    }
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
    // Before any auto-connect: `afterConnect` consults this to decide whether the
    // opening connection is the one Slack autostart is armed for.
    await refreshSlackAutostart();
    // Offer (never perform) a session restore; a default-connect profile still wins.
    const remembered = (savedLayout.openConnections ?? []).filter((id) => profiles().some((p) => p.id === id));
    const def = profiles().find((p) => p.default_connect);
    setReopenable(remembered.filter((id) => id !== def?.id));
    // "Try to continue" after a crash remounts the app, which re-runs this. Recovering
    // from an error must never open a database session by itself — offer the profile in
    // the reopen list instead of connecting to it.
    const recovered = consumeCrashRecovery();
    if (recovered && def) setReopenable(remembered.includes(def.id) ? remembered : [def.id, ...remembered]);
    if (def && !recovered) connectProfile(def.id);
    // Slack bot status (statusbar badge) + audit trail: every Slack-approved query
    // lands in the normal per-connection history with a [Slack] marker comment.
    // Best-effort — a failed listen must never break the app.
    try {
      const statusUnlisten = await listen<SlackStatus>("slack:status", (e) => {
        slackStatusRevision++;
        setSlackStatus(e.payload);
        // A bot that stopped on its own (its bound connection went away) must say so
        // where the user is looking, not only in Settings → Slack.
        setSlackNotice(!e.payload.running && e.payload.error ? e.payload.error : "");
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
        if (!appMounted || slackStatusRevision !== statusRevision) return;
        setSlackStatus(current);
        // The armed-but-waiting status is published during Rust setup, BEFORE this
        // listener exists, so the snapshot is the only place it can reach the
        // statusbar — otherwise autostart waits in silence until Settings is opened.
        setSlackNotice(!current.running && current.error ? current.error : "");
      })
      .catch(() => {});
  });
  onCleanup(() => {
    appMounted = false;
    skillsGeneration++;
    tabDrag?.cancel();
    tabDrag = null;
    document.removeEventListener("contextmenu", preventNativeContextMenu);
    window.removeEventListener("keydown", onWindowKey);
    window.removeEventListener("resize", clampPanels);
    window.removeEventListener("focus", onWindowFocus);
    window.removeEventListener("beforeunload", onBeforeUnload);
    for (const u of slackUnlisten) u();
    clearTimeout(saveTimer);
    if (transactionTimer) clearInterval(transactionTimer);
    nativeCloseUnlisten?.();
    for (const rt of runtimes.values()) {
      for (const timer of rt.runTimers) clearInterval(timer);
      rt.runTimers.clear();
    }
    for (const cleanup of [...interactionCleanups]) cleanup();
  });

  // Central dispatcher — every action callable from a shortcut, the palette, or
  // the Shortcuts pane goes through here.
  function runAction(id: ActionId) {
    switch (id) {
      case "run": void doRun(); break;
      case "runStatement": {
        const s = editorApi()?.getStatementRunText();
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
      case "moveTabLeft": moveActiveTab(-1); break;
      case "moveTabRight": moveActiveTab(1); break;
      case "renameTab": beginRename(activeTabId()); break;
      case "pinTab": togglePin(activeTabId()); break;
      case "showAllTabs": setAllTabsOpen(true); break;
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
      case "openFilterBuilder": openFilterBuilder(); break;
      case "nextConnection": case "prevConnection": {
        const next = stepConnection(connections(), activeConnectionId(), id === "nextConnection" ? 1 : -1);
        if (next) focusConnection(next);
        break;
      }
      case "newConnection": openConnectScreen(); break;
    }
  }

  function onWindowKey(e: KeyboardEvent) {
    // The editor keymap (and any other in-place handler) marks what it consumed.
    if (e.defaultPrevented) return;
    if (paletteOpen()) return; // the palette owns the keyboard while open
    if (allTabsOpen()) return; // so does the "All tabs" list (Escape closes it)
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
      setConnErr(`Could not load saved profiles: ${errMsg(e)}`);
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
    setSshState(emptySshForm());
    setSshSecretStored(false);
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
    // Metadata round-trips; the secret stays in the keychain and the field stays blank.
    setSshState(sshFormFromProfile(p.ssh, p.save_ssh_secret));
    setSshSecretStored(!!p.ssh && p.save_ssh_secret && sshNeedsSecret(p.ssh.auth));
    setConnErr("");
  }

  /** Raise the connect screen. Refuses past the open-connection cap with the reason. */
  function openConnectScreen() {
    const limit = connectionLimitError(connections());
    if (limit) {
      setStatus(limit);
      return;
    }
    newProfile();
    setConnectOpen(true);
  }

  /** The remembered profiles that are not already open — what the offer actually is. */
  const pendingReopen = () =>
    reopenable().filter((id) => !connections().some((e) => e.conn.profileId === id));

  /**
   * Reconnect the saved profiles that were open last time, in their original order.
   * Profiles that no longer exist, or whose password is not in the keychain, are
   * reported rather than silently skipped — an incomplete restore that looks complete
   * is worse than none.
   *
   * Outcomes are accumulated PER PROFILE: `connectProfile` clears `connErr` on entry,
   * so relying on that shared signal meant profile #2 succeeding erased why #1 failed
   * and the restore was presented as complete. Anything that did not open stays in the
   * offer so it can be retried.
   */
  async function reopenLastSession() {
    const wanted = pendingReopen();
    if (!wanted.length || connecting()) return;
    const failures: string[] = [];
    const unopened: string[] = [];
    for (const [index, id] of wanted.entries()) {
      if (connections().length >= MAX_CONNECTIONS) {
        unopened.push(...wanted.slice(index));
        failures.push(`Connection limit (${MAX_CONNECTIONS}) reached`);
        break;
      }
      const profile = profiles().find((x) => x.id === id);
      if (!profile) {
        failures.push(`${id}: that saved connection no longer exists`);
        continue;
      }
      const before = connections().length;
      const error = await connectProfile(id);
      // A host-key prompt resolves without an error and without a connection: it is
      // still waiting on the user, so keep it in the offer rather than declaring it done.
      if (connections().length > before) continue;
      unopened.push(id);
      failures.push(`${profile.name || id}: ${error || "waiting for confirmation"}`);
    }
    setReopenable((ids) => ids.filter((id) => !wanted.includes(id) || unopened.includes(id)));
    setConnErr(failures.length ? `Could not reopen: ${failures.join("; ")}` : "");
    persistLayout();
  }

  const isEmbeddedDriver = (d?: string | null) => d === "duckdb" || d === "sqlite";

  /** A tunnel that authenticates with a password or key passphrase can only connect
   *  unattended when that secret is in the keychain; otherwise the form must ask. */
  const sshSecretMissing = (p: Profile) =>
    !!p.ssh && sshNeedsSecret(p.ssh.auth) && !p.save_ssh_secret;

  function useProfile(p: Profile) {
    // Embedded profiles need no password; saved-password profiles connect directly.
    if (isEmbeddedDriver(p.driver)) connectProfile(p.id);
    else if (p.save_password && !sshSecretMissing(p)) connectProfile(p.id);
    else editProfile(p);
  }

  /**
   * `connect`/`connect_profile` register the session in the Rust registry BEFORE the
   * workbench sets it up. If setup throws before the entry reaches `connections()`
   * there is no chip and no ✕ for it, so it would hold one of the 16 backend slots
   * until restart — close it, and release the workbench bookkeeping it did claim.
   */
  async function afterConnect(
    r: ConnectReply,
    meta: { key: string; legacyKey: string | null; target: string; driver: string; profileId: string | null },
  ) {
    try {
      await registerConnection(r, meta);
    } catch (e) {
      if (!entryOf(r.connection_id)) {
        runtimes.delete(r.connection_id);
        recoveryKeys.delete(r.connection_id);
        slackHistoryKeys.delete(r.connection_id);
        lastTabByConn.delete(r.connection_id);
        void invoke("disconnect", { connectionId: r.connection_id }).catch(() => {});
      }
      throw e;
    }
  }

  /**
   * Register a freshly opened session as a new connection entry, restore its tab set
   * and history, and focus it. Existing connections are untouched: their tabs stay in
   * the strip, their streams keep streaming, their transaction bars keep running.
   */
  async function registerConnection(
    r: ConnectReply,
    meta: { key: string; legacyKey: string | null; target: string; driver: string; profileId: string | null },
  ) {
    const connected: Connected = {
      id: r.connection_id,
      version: r.server_version,
      readOnly: r.read_only,
      viaSsh: !!r.viaSsh,
      driver: meta.driver,
      generation: ++connectionGeneration,
      key: meta.key,
      target: meta.target,
      profileId: meta.profileId,
    };
    const runtime = makeRuntime();
    runtimes.set(connected.id, runtime);
    const [state, setState] = createSignal<ConnectionState>(
      makeConnectionState(connected, nextColorIndex(connections())),
    );
    const entry: ConnEntry = {
      conn: connected,
      colorIndex: state().colorIndex,
      state,
      patch: (patch) => setState((s) => ({ ...s, ...patch })),
      runtime,
    };
    setPersistenceWarning("");
    slackHistoryKeys.set(connected.id, connected.key);
    if (slackHistoryKeys.size > 100) slackHistoryKeys.delete(slackHistoryKeys.keys().next().value!);
    const interrupted = takeInterruptedMarker(meta.key);
    if (interrupted) {
      entry.patch({ transactionWarning: `Previous ${interrupted.mode === "autocommit_off" ? "autocommit-off unit" : "manual transaction"} ${interrupted.transactionId} was interrupted. Verify its outcome.` });
    }

    // Restore this connection's tabs BEFORE it becomes active, so the workbench never
    // renders a connection with no tab of its own.
    //
    // The snapshot slot is per SESSION, not per destination: opening the same profile
    // twice must not give both sessions the same `tusk.tabs.<key>` entry, or the second
    // restores the first's tabs (every file open twice) and then overwrites its unsaved
    // buffers on the next persist. Slot 0 is the bare key, so a single session — and the
    // legacy migration below — behave exactly as before.
    const slot = nextRecoverySlot(recoveryKeys.values(), meta.key);
    const slotKey = recoverySlotKey(meta.key, slot);
    let restoredTabs: Tab[] = [];
    let restoredActive = 0;
    let recoveryKey = slotKey;
    if (meta.key) {
      const current = tabsStore.loadResult(slotKey);
      let saved = current.ok ? current.value : null;
      if (!current.ok) {
        showPersistenceFailure(current.error);
        // An unreadable existing snapshot is not a failed write: park it aside so
        // this session can persist recovery normally (and disconnect/close aren't
        // blocked forever). Only when even the backup fails do writes stay off.
        const parked = tabsStore.quarantineResult(slotKey);
        if (!parked.ok) {
          runtime.recoveryWritable = false;
          showPersistenceFailure(parked.error);
        }
      }
      // A legacy fallback is valid only when the new key is genuinely absent, and only
      // for slot 0 — a second concurrent session must not adopt the first's history. A
      // load failure must not resurrect stale data over an unreadable current snapshot.
      if (slot === 0 && current.ok && current.value === null && meta.legacyKey) {
        const legacy = tabsStore.loadResult(meta.legacyKey);
        if (!legacy.ok) showPersistenceFailure(legacy.error);
        else if (legacy.value) {
          saved = legacy.value;
          const migrated = persistRecoveryTo(runtime, slotKey, legacy.value);
          if (migrated.ok) {
            const removed = tabsStore.removeResult(meta.legacyKey);
            if (!removed.ok) showPersistenceFailure(removed.error);
          } else {
            recoveryKey = meta.legacyKey;
          }
        }
      }
      if (saved && saved.tabs.length) {
        // The active tab is restored BY ID below, so re-sorting pinned tabs to the
        // head of the group cannot select the wrong buffer.
        const mapped = saved.tabs.map((pt) =>
          makeTab({
            connectionId: connected.id,
            sql: pt.sql,
            filePath: pt.filePath,
            title: pt.title,
            customTitle: pt.customTitle,
            pinned: pt.pinned,
            color: normalizeTabColor(pt.color),
            searchSchema: pt.searchSchema ?? null,
            dirty: pt.dirty,
          }),
        );
        const activeId = mapped[Math.max(0, Math.min(saved.activeIndex, mapped.length - 1))]?.id;
        restoredTabs = sortPinned(mapped) as Tab[];
        restoredActive = Math.max(0, restoredTabs.findIndex((t) => t.id === activeId));
      } else {
        restoredTabs = [makeTab({ connectionId: connected.id })];
      }
    } else {
      restoredTabs = [makeTab({ connectionId: connected.id })];
    }
    recoveryKeys.set(connected.id, recoveryKey);

    restoring = true;
    try {
      setConnections((cs) => [...cs, entry]);
      setTabs((ts) => [...ts, ...restoredTabs]);
      focusConnection(connected.id, restoredTabs[restoredActive]?.id);
    } finally {
      restoring = false;
    }
    void invoke("set_active_connection", { connectionId: connected.id }).catch(() => {});
    // Slack starts here, not at launch: it is armed for one saved connection and this is
    // the moment that connection exists. Never "whichever connection opened first".
    void slackAutostartFor(connected.id, meta.profileId);

    try {
      const status = await invoke<TransactionStatus>("transaction_status", { connectionId: r.connection_id });
      if (!connectionOpen(connected)) return;
      applyAuthoritativeTransaction(connected, status);
    } catch {
      if (!connectionOpen(connected)) return;
    }
    try {
      const next = await invoke<Capabilities>("capabilities", { connectionId: r.connection_id });
      if (!connectionOpen(connected)) return;
      patchConn(connected.id, { caps: next });
    } catch {
      if (!connectionOpen(connected)) return;
      patchConn(connected.id, { caps: null });
    }
    // DuckDB: probe PG-style EXPLAIN options once, at connect (safe — nothing
    // is streaming yet). Drives the Explain action's wrapping.
    if (connectionKindOf(stateOf(connected.id)) === "duckdb") {
      try {
        const probe = await invoke<QueryResult>("run_query", { connectionId: r.connection_id, ownerId: restoredTabs[restoredActive]?.id ?? restoredTabs[0].id, sql: "EXPLAIN (FORMAT json) SELECT 1", pageSize: PAGE, searchPath: null });
        applyAuthoritativeTransaction(connected, probe.transaction);
        if (!connectionOpen(connected)) return;
        patchConn(connected.id, { duckJsonExplain: true });
      } catch (e) {
        const embedded = transactionFromError(e);
        if (embedded) applyAuthoritativeTransaction(connected, embedded);
        if (!connectionOpen(connected)) return;
        patchConn(connected.id, { duckJsonExplain: false });
      }
    }
    const loaded = meta.legacyKey
      ? await historyStore.migrate(meta.legacyKey, meta.key)
      : await historyStore.load(meta.key);
    if (!connectionOpen(connected)) return;
    patchConn(connected.id, { history: loaded });
    rememberOpenConnections();
    setConnectOpen(false);
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
        throw new Error("Port must be a whole number between 1 and 65535");
      }
      // Tunnel settings are frozen with the rest of the submission, so a Trust-and-retry
      // can only ever re-run the attempt the user actually made.
      const submittedSsh = isFile ? null : ssh();
      if (submittedSsh) {
        const problem = validateSshForm(submittedSsh);
        if (problem) throw new Error(problem);
      }
      const sshConfig = submittedSsh ? sshPayload(submittedSsh, true) : null;
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
            ssh: sshConfig,
          };
      const submittedLegacyKey = isFile
        ? `adhoc:${submittedDriver}:${submittedPath || ":memory:"}`
        : `adhoc:${submittedHost}:${networkPort}:${submittedDatabase}:${submittedUser}`;
      // A tunnelled connection is a different destination than the same host/port
      // reached directly, so it gets its own key. The suffix is appended only when a
      // tunnel is in play, which leaves every existing key byte-identical.
      const submittedKey = `adhoc:${JSON.stringify(isFile
        ? [submittedDriver, submittedPath || ":memory:"]
        : sshConfig
          ? [submittedDriver, submittedHost, networkPort, submittedDatabase, submittedUser, "ssh", sshConfig.host, sshConfig.port, sshConfig.user]
          : [submittedDriver, submittedHost, networkPort, submittedDatabase, submittedUser])}`;
      const submittedTarget = isFile
        ? basename(submittedPath || ":memory:")
        : submittedDatabase || submittedHost;
      await connectWithHostKeyPrompt(async () => {
        const r = await invoke<ConnectReply>("connect", { config });
        await afterConnect(r, { key: submittedKey, legacyKey: submittedLegacyKey, target: submittedTarget, driver: submittedDriver, profileId: null });
      });
    } catch (e) {
      setConnErr(errMsg(e));
    } finally {
      setConnecting(false);
    }
  }

  // Pick an existing DuckDB/SQLite database file (a new file can also be typed).
  async function browseDbFile() {
    try {
      const p = await chooseOpenPath({
        filters: [{ name: "Database", extensions: ["duckdb", "ddb", "db", "sqlite", "sqlite3"] }],
      });
      if (p) setPath(p);
    } catch (e) {
      setConnErr(errMsg(e));
    }
  }

  /** Connect a saved profile. Returns "" on success, else the failure message — the
   *  shared `connErr` signal cannot report a batch, since every call clears it. */
  async function connectProfile(id: string): Promise<string> {
    if (connecting()) return "Another connection attempt is already in progress";
    setConnecting(true);
    setConnErr("");
    try {
      const profile = profiles().find((p) => p.id === id);
      const target = profile
        ? isEmbeddedDriver(profile.driver) ? basename(profile.path || ":memory:") : profile.dbname || profile.host
        : id;
      await connectWithHostKeyPrompt(async () => {
        const r = await invoke<ConnectReply>("connect_profile", { id });
        await afterConnect(r, { key: `profile:${id}`, legacyKey: null, target, driver: profile?.driver ?? "postgres", profileId: id });
      });
      return "";
    } catch (e) {
      const message = errMsg(e);
      setConnErr(message);
      return message;
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
        throw new Error("Port must be a whole number between 1 and 65535");
      }
      const sshState = embedded ? null : ssh();
      if (sshState) {
        const problem = validateSshForm(sshState);
        if (problem) throw new Error(problem);
      }
      const saveSshSecret = !!sshState?.enabled && sshState.saveSecret && sshNeedsSecret(sshState.auth);
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
          // Metadata only — the secret travels in `sshSecret` and lands in the keychain.
          ssh: sshState ? sshPayload(sshState, false) : null,
          save_ssh_secret: saveSshSecret,
        },
        password: !embedded && savePassword() && password() ? password() : null,
        sshSecret: saveSshSecret && sshState?.secret ? sshState.secret : null,
      });
      setEditingId(p.id);
      setSshSecretStored(!!p.ssh && p.save_ssh_secret && sshNeedsSecret(p.ssh.auth));
      await loadProfiles();
    } catch (e) {
      setConnErr(errMsg(e));
    }
  }

  /**
   * Deleting a saved connection also drops its keychain password and cannot be undone,
   * so the trash icon and the context-menu item only ASK — `deleteProfile` is what the
   * confirmation runs. Rendered in the shared tail, because the profile list lives on
   * the connect screen as well as in the "Open another connection" modal.
   */
  const [confirmDeleteProfile, setConfirmDeleteProfile] = createSignal<Profile | null>(null);
  const askDeleteProfile = (p: Profile) => {
    setMenu(null);
    setConfirmDeleteProfile(p);
  };

  async function deleteProfile(id: string) {
    setConfirmDeleteProfile(null);
    try {
      await invoke("delete_profile", { id });
      if (editingId() === id) newProfile();
      await loadProfiles();
    } catch (e) {
      console.error(e);
      setConnErr(errMsg(e));
    }
  }

  /**
   * Snapshot ONE connection's tab set for persistence. The live CodeMirror document
   * is the source of truth only for the globally-active tab, so it is handed over
   * only when that tab belongs to this connection — otherwise a background
   * connection's snapshot would inherit the focused connection's buffer.
   */
  function snapshotConnection(entry: ConnEntry): PersistedTabs {
    const owned = tabsOf(entry.conn.id);
    const focused = owned.some((t) => t.id === activeTabId());
    const active = focused
      ? activeTabId()
      : (owned.some((t) => t.id === lastTabByConn.get(entry.conn.id)) ? lastTabByConn.get(entry.conn.id)! : owned[0]?.id ?? "");
    return recoverySnapshot(owned, active, focused ? editorApi()?.getDoc() : undefined);
  }

  /**
   * Close ONE connection. Everything torn down here is scoped to that connection:
   * its runtime generations, its tabs, its caches, its transaction. The other open
   * connections keep streaming, keep their transaction bars, and keep their tabs.
   */
  async function disconnectConnection(
    connectionId: string,
    force = false,
    transactionResolved = false,
  ): Promise<boolean> {
    const entry = entryOf(connectionId);
    if (!entry) return true;
    const c = entry.conn;
    const rt = entry.runtime;
    const busy = entry.state();
    // The ✕ on a background chip is one mis-click away from server-cancelling a
    // long-running query (`disconnect` cancels the armed operation), so refuse while
    // one is in flight — the same rule window close already applies globally. Cancel
    // it (the chip's running dot does that) or let it finish first.
    if (busy.running || busy.fetchingMore || busy.loadingAll) {
      const message = `Cancel or wait for the ${busy.loadingAll ? "Load all" : busy.fetchingMore ? "page fetch" : "query"} on ${labelOf(connectionId)} before disconnecting it`;
      const tabId = busy.runningTabId ?? tabsOf(connectionId)[0]?.id;
      if (tabId) patchResult(tabId, { status: message });
      setStatus(message);
      return false;
    }
    const status = entry.state().transaction;
    if (transactionOpen(status) && !transactionResolved) {
      raiseTransactionResolution(entry, { kind: "disconnect" });
      return false;
    }
    const pending = tabsOf(connectionId).reduce((total, tab) => total + pendingCount(tab.pending), 0);
    if (pending && !force) {
      setConfirmDisconnect({ connectionId, count: pending });
      return false;
    }
    setConfirmDisconnect(null);
    const snapshot = snapshotConnection(entry);
    const saved = persistRecoveryTo(rt, recoveryKeys.get(connectionId) ?? c.key, snapshot, true);
    // Dirty buffers are recoverable only after a verified write. Keep the connection
    // open on failure; users can save files or retry once storage is available.
    if (!saved.ok && snapshot.tabs.some((tab) => tab.dirty)) return false;
    try {
      await invoke("disconnect", { connectionId });
    } catch (e) {
      const embedded = transactionFromError(e);
      if (embedded) applyAuthoritativeTransaction(c, embedded);
      patchConn(connectionId, { transactionWarning: `Disconnect failed: ${errMsg(e)}` });
      return false;
    }
    if (status.state !== "lost") removeInterruptedMarker(c.key);
    // Invalidate every in-flight async write-back for THIS connection only.
    rt.queryGeneration++;
    rt.fetchGeneration++;
    rt.schemaGeneration++;
    rt.fkGeneration++;
    rt.cursorGeneration++;
    rt.activeQuery = null;
    rt.cursorOwner = null;
    rt.deferredSchemaRefresh = false;
    rt.transactionHistoryKey = null;
    rt.sampleCache.clear();
    rt.loadedRels.clear();
    rt.detailInflight.clear();
    rt.fkInFlight.clear();
    rt.fkFetched.clear();
    for (const timer of rt.runTimers) clearInterval(timer);
    rt.runTimers.clear();
    runtimes.delete(connectionId);
    recoveryKeys.delete(connectionId);
    lastTabByConn.delete(connectionId);
    slackHistoryKeys.delete(connectionId);

    const remaining = connections().filter((e) => e.conn.id !== connectionId);
    setConnections(remaining);
    for (const t of tabsOf(connectionId)) editorApi()?.dropTab(t.id);
    for (const t of tabsOf(connectionId)) saveOperations.delete(t.id);
    setTabs((ts) => ts.filter((t) => t.connectionId !== connectionId));
    // Surfaces bound to the closing connection must go; ones belonging to another
    // connection stay exactly as they were.
    closeSurfacesFor(connectionId);
    if (activeConnectionId() === connectionId) {
      const next = remaining[0];
      if (next) focusConnection(next.conn.id);
      else {
        setActiveConnectionId(null);
        setActiveTabId("");
      }
    }
    // ACCUMULATE the closed profile: closing A, then B, then C must remember all three,
    // exactly as closing the window with three open does. Reseeding only from the last
    // one made the remembered session decay to whichever was closed last.
    if (entry.conn.profileId) {
      const closed = entry.conn.profileId;
      setReopenable((ids) => (ids.includes(closed) ? ids : [...ids, closed].slice(0, MAX_CONNECTIONS)));
    }
    if (!remaining.length) {
      setHistoryOpen(false);
      setSelected(null);
      setPersistenceWarning("");
    }
    rememberOpenConnections();
    return true;
  }

  /** Dismiss every modal/menu/dialog that was scoped to `connectionId`. */
  function closeSurfacesFor(connectionId: string) {
    setMenu(null);
    setCellView(null);
    setConfirmClose(null);
    setConfirmCancelConn(null);
    setConfirmDisconnect(null);
    setConfirmWindowClose(null);
    setTransactionResolution(null);
    setTransactionResolutionBusy(false);
    setConfirmAnalyze(null);
    setConfirmDiscard(null);
    setRunChoice(null);
    setParamPrompt(null);
    setInlineRename(null);
    setAllTabsOpen(false);
    setCommitView(null);
    transactionResolutionAfterApply = null;
    if (dialogBinding()?.origin.connectionId === connectionId) setActiveDialog(null);
    if (ddlGraph()?.connectionId === connectionId) setDdlGraph(null);
    if (exportSrc()?.connectionId === connectionId) setExportSrc(null);
    if (exportTables()?.connectionId === connectionId) {
      setExportTables(null);
      setExportTablesProgress(null);
    }
    if (importOrigin?.connection.id === connectionId) {
      setImportBusy(false);
      setImportProgress(null);
      setImportOpen(null);
      importOrigin = null;
    }
    // Backup/restore are bound to a connection generation of their own; close them
    // through their helpers so the binding is cleared with the dialog.
    if (backupConnection?.id === connectionId) closeBackup();
    if (restoreConnection?.id === connectionId) closeRestore();
  }

  /** Close the connection the workbench is focused on (topbar Disconnect). */
  const disconnect = (force = false, transactionResolved = false) => {
    const id = activeConnectionId();
    return id ? disconnectConnection(id, force, transactionResolved) : Promise.resolve(true);
  };

  // Reflect the focused database in the OS window title (mascot + driver), naming the
  // connection itself once more than one is open.
  createEffect(() => {
    const c = conn();
    const kind = connectionKind();
    const many = connections().length > 1;
    const title = c
      ? `${driverMascot(kind)} Tusk — ${many ? labelOf(c.id) : driverLabel(kind)}`
      : "Tusk";
    void getCurrentWindow().setTitle(title).catch(() => {
      /* not in a Tauri window (e.g. preview) */
    });
  });

  // Tell the backend which connection the workbench has focused: it is the default a
  // Slack bot binds to, and the fallback for anything not already pinned to an id.
  createEffect(() => {
    const id = activeConnectionId();
    if (id) void invoke("set_active_connection", { connectionId: id }).catch(() => {});
  });


  // Debounced tab-set save as buffers/structure change. EVERY open connection is
  // persisted, not just the focused one: a background connection's unsaved buffer is
  // no less recoverable than the one on screen.
  createEffect(() => {
    void tabs();
    void activeTabId();
    if (restoring || !connections().length) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persistAllRecovery(), 800);
  });

  // --- per-connection introspection ----------------------------------------
  // Every loader below takes the connection it belongs to and captures that
  // connection's runtime ONCE. Generations, the cursor owner and the metadata caches
  // are per connection, so a refresh on one connection can neither invalidate an
  // in-flight reply on another nor mark another connection's live stream interrupted.
  /** Whether THAT connection is inside a manual transaction (not the focused one). */
  const frozenFor = (id: string) => transactionOpen(stateOf(id)?.transaction ?? IDLE_TRANSACTION);

  async function loadSchema(target = conn()) {
    const c = target;
    const rt = c ? runtimes.get(c.id) : null;
    if (!c || !rt || !connectionOpen(c)) return;
    if (frozenFor(c.id)) {
      rt.deferredSchemaRefresh = true;
      return;
    }
    rt.deferredSchemaRefresh = false;
    const transactionRevision = stateOf(c.id)!.transaction.revision;
    const operation = ++rt.schemaGeneration;
    const isCurrent = () => connectionOpen(c) && rt.schemaGeneration === operation
      && (stateOf(c.id)?.transaction.revision ?? -1) === transactionRevision && !frozenFor(c.id);
    rt.fkGeneration++;
    rt.fkFetched.clear();
    patchConn(c.id, { fkEdges: [] });
    if (activeConnectionId() === c.id) setMenuState(null);
    interruptStream("Schema refresh closed the result stream", c.id);
    patchConn(c.id, { schemaLoading: true });
    rt.sampleCache.clear(); // schema (and likely data) may have changed - drop stale AI samples
    try {
      const t = await invoke<DbTree>("db_tree", { connectionId: c.id });
      if (!isCurrent()) return;
      patchConn(c.id, { tree: t });
      // Prune cached detail for relations that no longer exist (dropped / renamed),
      // so refreshLoadedDetails doesn't keep re-fetching dead keys.
      const live = new Set<string>();
      for (const s of t.schemas) for (const r of [...s.tables, ...s.views]) live.add(relKey(s.name, r.name));
      for (const k of [...rt.loadedRels.keys()]) if (!live.has(k)) rt.loadedRels.delete(k);
      const prev = stateOf(c.id)?.details ?? {};
      const kept: Record<string, RelationDetail> = {};
      for (const k of Object.keys(prev)) if (live.has(k)) kept[k] = prev[k];
      patchConn(c.id, { details: kept });
      void loadTables(c, operation);
      void refreshLoadedDetails(c, operation);
      // Refresh effective privileges alongside the tree (grants/ownership can change).
      invoke<Permissions>("permissions", { connectionId: c.id })
        .then((p) => { if (isCurrent()) patchConn(c.id, { perms: p }); })
        .catch(() => { if (isCurrent()) patchConn(c.id, { perms: null }); });
    } catch (e) {
      console.error(e);
    } finally {
      if (isCurrent()) patchConn(c.id, { schemaLoading: false });
    }
  }

  // Full table+column list for autocomplete (decoupled from the lazy tree),
  // plus the live function catalog feeding the unknown-function lint (empty
  // set = engine can't enumerate -> that lint stays off).
  async function loadTables(target: Connected | null, schemaOperation?: number) {
    const c = target;
    const rt = c ? runtimes.get(c.id) : null;
    if (!c || !rt || frozenFor(c.id)) return;
    const operation = schemaOperation ?? rt.schemaGeneration;
    const transactionRevision = stateOf(c.id)!.transaction.revision;
    const isCurrent = () => connectionOpen(c) && rt.schemaGeneration === operation
      && (stateOf(c.id)?.transaction.revision ?? -1) === transactionRevision && !frozenFor(c.id);
    try {
      const tables = await invoke<TableInfo[]>("list_schema", { connectionId: c.id });
      if (!isCurrent()) return;
      patchConn(c.id, { schema: tables });
    } catch (e) {
      if (!isCurrent()) return;
      console.error(e);
    }
    try {
      const names = await invoke<string[]>("list_functions", { connectionId: c.id });
      if (!isCurrent()) return;
      patchConn(c.id, { funcs: new Set(names.map((n) => n.toLowerCase())) });
    } catch {
      if (!isCurrent()) return;
      patchConn(c.id, { funcs: new Set<string>() });
    }
    // FK catalog for JOIN completion. Which schema matters is decided by THIS
    // connection's focused tab, not by whichever tab happens to be on screen.
    const focused = tabsOf(c.id).find((t) => t.id === lastTabByConn.get(c.id)) ?? tabsOf(c.id)[0];
    const activeSchema = focused?.searchSchema ?? "public";
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

  /** Fetch one schema's FK edges into that connection's fkEdges (deduped; best-effort). */
  async function fetchFkSchema(schemaName: string, target = conn()) {
    const c = target;
    const rt = c ? runtimes.get(c.id) : null;
    if (!c || !rt || frozenFor(c.id) || stateOf(c.id)?.caps?.relationships === false || rt.fkFetched.has(schemaName)) return;
    // A best-effort completion hint must never roll back a live result stream; the
    // next keystroke/tab switch retries once THIS connection's stream has drained.
    if (rt.cursorOwner !== null) return;
    const generation = rt.fkGeneration;
    const transactionRevision = stateOf(c.id)!.transaction.revision;
    const inflightKey = `${c.id}:${generation}:${schemaName}`;
    if (rt.fkInFlight.has(inflightKey)) return;
    rt.fkInFlight.add(inflightKey);
    try {
      const g = await invoke<{ tables: unknown[]; edges: FkEdge[] }>("schema_relationships", { connectionId: c.id, schema: schemaName });
      if (!connectionOpen(c) || rt.fkGeneration !== generation
        || (stateOf(c.id)?.transaction.revision ?? -1) !== transactionRevision || frozenFor(c.id)) return;
      // Mark fetched ONLY on success. `fksKnown` (which gates the AI prompt's "this schema
      // declares no foreign keys" claim) is derived from this set - marking before the
      // await meant a FAILED fetch asserted the schema had no FKs, the exact lie the
      // tri-state exists to prevent. A failure stays unmarked so the next send retries.
      rt.fkFetched.add(schemaName);
      const prev = stateOf(c.id)?.fkEdges ?? [];
      const key = (e: FkEdge) => JSON.stringify([e.constraint, e.srcSchema, e.srcTable]);
      const seen = new Set(prev.map(key));
      patchConn(c.id, { fkEdges: [...prev, ...g.edges.filter((e) => !seen.has(key(e)))] });
    } catch {
      /* best-effort - completion just has fewer hints, and the prompt stays silent on FKs */
    } finally {
      rt.fkInFlight.delete(inflightKey);
    }
  }

  // Lazy-load one relation's detail on expand; cached unless `force`.
  async function loadDetail(schemaName: string, name: string, force = false, target = conn()) {
    const c = target;
    const rt = c ? runtimes.get(c.id) : null;
    if (!c || !rt || frozenFor(c.id)) return;
    const generation = rt.schemaGeneration;
    const transactionRevision = stateOf(c.id)!.transaction.revision;
    const key = relKey(schemaName, name);
    const inflightKey = `${c.id}:${generation}:${key}`;
    const detailsOf = () => stateOf(c.id)?.details ?? {};
    if (!force && (detailsOf()[key] || rt.detailInflight.has(inflightKey))) return;
    rt.detailInflight.add(inflightKey);
    interruptStream("Expanding a relation closed the result stream", c.id);
    try {
      const d = await invoke<RelationDetail>("table_detail", {
        connectionId: c.id,
        schema: schemaName,
        name,
      });
      if (!connectionOpen(c) || rt.schemaGeneration !== generation
        || (stateOf(c.id)?.transaction.revision ?? -1) !== transactionRevision || frozenFor(c.id)) return;
      rt.loadedRels.set(key, { schema: schemaName, name });
      patchConn(c.id, { details: { ...detailsOf(), [key]: d } });
    } catch (e) {
      console.error(e);
    } finally {
      rt.detailInflight.delete(inflightKey);
      // A schema refresh can supersede the first detail request before it ever
      // reaches the cache. Retry under the new generation so an expanded row or
      // editability probe cannot remain stuck on "loading table info...".
      if (connectionOpen(c) && !frozenFor(c.id) && rt.schemaGeneration !== generation && !detailsOf()[key])
        void loadDetail(schemaName, name, force, c);
    }
  }

  // Re-fetch detail for every already-expanded relation (after refresh / DDL).
  async function refreshLoadedDetails(target: Connected | null, schemaOperation?: number) {
    const rt = target ? runtimes.get(target.id) : null;
    if (!target || !rt) return;
    const operation = schemaOperation ?? rt.schemaGeneration;
    for (const { schema, name } of [...rt.loadedRels.values()]) {
      if (rt.schemaGeneration !== operation) return;
      await loadDetail(schema, name, true, target);
    }
  }

  const sameColumns = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

  // Record a finished user-issued run into the per-connection history (never a
  // grid sort/filter re-run, never blocks the query path on storage failures).
  // History is keyed by DESTINATION, so an entry lands on the connection that ran it
  // even when the user has since switched to another one.
  const recordHistory = (e: Omit<HistoryEntry, "id" | "ts">, key: string) => {
    const ts = Date.now();
    const next = historyStore.append(key, { id: makeEntryId(ts), ts, ...e });
    for (const entry of connections()) if (entry.conn.key === key) entry.patch({ history: next });
  };

  const historySqlForTransaction = (
    connectionId: string,
    sqlText: string,
    before: TransactionStatus,
    after: TransactionStatus,
    event: TransactionEvent,
    priorHistoryKey?: string | null,
  ) => {
    const current = runtimes.get(connectionId)?.transactionHistoryKey ?? null;
    const key = transactionHistoryScope(before, after, event, current, priorHistoryKey ?? current);
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
    const runTabId = activeTabId();
    const runTab = tabs().find((t) => t.id === runTabId);
    if (!runTab) return false;
    // The RUN TAB decides the connection, not "whichever is active": a run must
    // execute (and be quoted) against the connection its tab belongs to.
    const entry = entryOf(runTab.connectionId);
    const c = entry?.conn ?? null;
    const rt = entry?.runtime ?? null;
    if (!c || !rt || entry!.state().running || !sqlToRun.trim()) return false;
    // Classify with the RUN TAB's engine, not the module dialect: MySQL `#` comments,
    // backticks and T-SQL brackets change where statements and comments end, and this
    // is the classification that decides commit/rollback boundary staling.
    const runEngine = connectionKindOf(entry!.state()) as SqlEngine;
    const event = transactionEvent(sqlToRun, runEngine);
    // Read the RUN TAB's connection transaction, not `transaction()`. They are the
    // same by the active-tab/active-connection invariant, but naming the connection
    // keeps this correct if a future path ever runs a non-focused tab.
    const runTx = () => entry!.state().transaction;
    if (!transactionDatabaseAllowed(runTx(), runTabId)) {
      patchResult(runTabId, { status: runTx().state === "lost"
        ? "Transaction session lost; disconnect and reconnect"
        : `Database actions are frozen in this tab while ${tabs().find((t) => t.id === runTx().owner)?.title ?? runTx().owner ?? "another tab"} owns the transaction` });
      return false;
    }
    if (!transactionRecoveryAllowed(runTx(), sqlToRun, runEngine)) {
      patchResult(runTabId, { status: "Transaction failed. Roll it back before any other database action." });
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
    // Only THIS connection's cursor is freed: a run here must never interrupt a live
    // stream on another connection, which has a server cursor of its own.
    if (rt.cursorOwner && rt.cursorOwner.tabId !== runTabId)
      interruptStream(`"${runTab.title}" ran a query and closed the stream`, c.id);
    rt.cursorOwner = null;
    rt.cursorGeneration++;
    rt.fetchGeneration++;
    patchConn(c.id, { fetchingMore: false });
    setMenuState(null);
    patchResult(runTabId, { runErr: "", status: "" });
    patchTab(runTabId, { resultView: undefined }); // a new run resets the Plan/Grid choice
    const runGeneration = ++rt.queryGeneration;
    const txOf = () => stateOf(c.id)?.transaction ?? IDLE_TRANSACTION;
    const before = txOf();
    const beforeHistoryKey = rt.transactionHistoryKey;
    let expectedTransactionRevision = before.revision;
    rt.activeQuery = { generation: runGeneration, connectionGeneration: c.generation, tabId: runTabId, transactionRevision: before.revision };
    const originCurrentForRun = () =>
      rt.activeQuery?.generation === runGeneration &&
      rt.activeQuery.connectionGeneration === c.generation &&
      rt.activeQuery.tabId === runTabId &&
      connectionOpen(c) &&
      tabs().some((t) => t.id === runTabId);
    const isCurrent = () => originCurrentForRun() && txOf().revision === expectedTransactionRevision;
    patchConn(c.id, { running: true, runningTabId: runTabId, runMs: 0 });
    const t0 = performance.now();
    const timer = setInterval(() => {
      if (isCurrent()) patchConn(c.id, { runMs: performance.now() - t0 });
    }, 200);
    rt.runTimers.add(timer);
    let completed = false;
    try {
      // In-grid editing needs the target table's detail (PK/columns). Fetching it AFTER
      // the run would roll back the result's cursor and truncate the stream, so resolve
      // the target from the (pre-execution) base query and load it now, while no
      // stream is open and `running` already excludes a concurrent run. Best-effort:
      // a failure just leaves the grid read-only.
      if (mode === "base" && base && !transactionOpen(txOf())) {
        try {
          const tgt = editTarget(base, editIndexer(stateOf(c.id)?.schema ?? []), runTab.searchSchema, connectionKindOf(stateOf(c.id)));
          if (tgt.ok && !(stateOf(c.id)?.details ?? {})[relKey(tgt.table.schema, tgt.table.name)])
            await loadDetail(tgt.table.schema, tgt.table.name, false, c);
        } catch { /* read-only grid until the detail loads later */ }
        if (!isCurrent()) return false;
      }
      const out = await invoke<QueryResult>("run_query", { connectionId: c.id, ownerId: runTabId, sql: sqlToRun, pageSize: PAGE, searchPath: runSchema });
      expectedTransactionRevision = out.transaction.revision;
      const accepted = applyAuthoritativeTransaction(c, out.transaction, event, before);
      if (!accepted || !isCurrent()) return false;
      const runTabNow = tabs().find((t) => t.id === runTabId);
      const epoch = (runTabNow?.result.epoch ?? 0) + 1;
      const loadedGeneration = ++resultGeneration;
      if (out.kind === "rows") {
        const prevCols = runTabNow?.result.columns ?? [];
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
              ? { ...(runTabNow?.gridView ?? gridViewFor(out.columns.length)), sorts: [], filters: emptyFilter() }
              : { ...gridViewFor(out.columns.length), filterRowOpen: runTabNow?.gridView.filterRowOpen ?? false },
          });
        }
        if (!out.done) {
          rt.cursorOwner = {
            tabId: runTabId,
            connectionGeneration: c.generation,
            resultGeneration: loadedGeneration,
            cursorGeneration: ++rt.cursorGeneration,
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
          sql: historySqlForTransaction(c.id, historySql, before, out.transaction, event, beforeHistoryKey),
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
        if (!applyAuthoritativeTransaction(c, embedded, event, before)) return false;
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
        transactionId: transactionOpen(txOf()) ? txOf().id : null,
        transactionRevision: txOf().revision,
        transactionStale: txOf().state === "lost" ? "Transaction session lost; this result may no longer match the database" : "",
      };
      // A user cancel surfaces as Postgres' "canceling statement due to user request" —
      // present it as a calm status, not a red error banner.
      if (/cancel/i.test(msg)) patchResult(runTabId, { ...failedResult, runErr: "", status: "Query cancelled", columns: [], rows: [], done: true });
      else patchResult(runTabId, { ...failedResult, runErr: msg, columns: [], rows: [], done: true });
      if (mode === "base") {
        recordHistory({
          sql: historySqlForTransaction(c.id, historySql, before, embedded ?? txOf(), event, beforeHistoryKey),
          durationMs: Math.round(performance.now() - t0),
          status: /cancel/i.test(msg) ? "cancelled" : "error",
          rows: null,
          error: msg.split("\n")[0],
          schema: runSchema,
        }, c.key);
      }
    } finally {
      clearInterval(timer);
      rt.runTimers.delete(timer);
      if (rt.activeQuery?.generation === runGeneration) {
        rt.activeQuery = null;
        patchConn(c.id, { running: false, runningTabId: null, cancelling: false });
        if (connectionOpen(c) && tabs().some((t) => t.id === runTabId))
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
      { label: "Begin transaction", icon: "play", onClick: () => void runTransactionControl(connectionKind() === "mssql" ? "BEGIN TRANSACTION" : "BEGIN") },
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
    const open = anyTransactionOpen();
    if (open) {
      raiseTransactionResolution(open, { kind: "window-close" });
      return false;
    }
    persistLayout(); // records which profiles were open, for "Reopen last session"
    if (persistAllRecovery(true).unsafeDirty) return false;
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

  /**
   * Raise the "resolve this transaction first" dialog for ONE connection, focusing it
   * and its owner tab. Window close walks every open connection this way, one at a
   * time, so a transaction on a background connection cannot be closed past silently.
   */
  function raiseTransactionResolution(entry: ConnEntry, intent: { kind: "close-tab"; tabId: string } | { kind: "disconnect" } | { kind: "window-close" }) {
    const owner = entry.state().transaction.owner;
    focusConnection(entry.conn.id, owner ?? undefined);
    setTransactionResolution({ ...intent, connectionId: entry.conn.id } as TransactionResolution);
  }

  function continueAfterTransactionResolution(intent: TransactionResolution) {
    if (intent.kind === "close-tab") closeTab(intent.tabId);
    else if (intent.kind === "disconnect") void disconnectConnection(intent.connectionId);
    else void closeNativeWindow();
  }

  async function resolveTransaction(action: "commit" | "rollback") {
    const intent = transactionResolution();
    if (!intent) return;
    const entry = entryOf(intent.connectionId);
    if (!entry) {
      setTransactionResolution(null);
      return;
    }
    if (activeConnectionId() !== intent.connectionId) focusConnection(intent.connectionId);
    const tx = entry.state().transaction;
    if (transactionResolutionBusy() || transactionControlBusy() || tx.state === "lost" || ownerPendingCount()) return;
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
    const entry = entryOf(intent.connectionId);
    if (!entry) {
      setTransactionResolution(null);
      return;
    }
    setTransactionResolutionBusy(true);
    const warning = entry.state().transactionWarning || "Transaction session was lost; reconnect and verify its outcome.";
    try {
      const disconnected = await disconnectConnection(intent.connectionId, true, true);
      if (!disconnected) return;
      setConnErr(warning);
      setPersistenceWarning(warning);
      // NOT forced: the lost connection's own tabs (and their pending edits) are gone
      // with it, so what `totalPendingCount()` still sees belongs to OTHER connections
      // and deserves its own confirmation rather than being discarded silently.
      if (intent.kind === "window-close") await closeNativeWindow();
    } finally {
      if (entryOf(intent.connectionId)) setTransactionResolutionBusy(false);
    }
  }

  // Cancel the in-flight query (re-clicking Run): fire a Postgres CancelRequest; the
  // run_query call then errors out and unwinds through executeQuery's finally.
  function cancelQuery() {
    cancelQueryOn(activeConnectionId(), runningTabId() ?? activeTabId());
  }

  /**
   * Cancel the query running on ANY connection, focused or not. The connection strip's
   * running dot is a cancel button (behind a confirmation), so a long query started on
   * a background connection does not have to be switched to first.
   */
  function cancelQueryOn(connectionId: string | null, fallbackTabId?: string) {
    const entry = entryOf(connectionId);
    const s = entry?.state();
    if (!entry || !s || !s.running || s.cancelling) return;
    const tabId = s.runningTabId ?? fallbackTabId ?? tabsOf(entry.conn.id)[0]?.id;
    if (s.caps?.cancelQuery === false) {
      const message = "This engine cannot cancel a running query. Wait for it to finish.";
      if (tabId) patchResult(tabId, { status: message });
      setStatus(message);
      return;
    }
    if (!tabId) return;
    patchConn(entry.conn.id, { cancelling: true });
    void cancelOperation(entry.conn.id, tabId);
  }

  /** Confirmation for cancelling a query from a connection chip (never a bare click). */
  const [confirmCancelConn, setConfirmCancelConn] = createSignal<string | null>(null);

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
      hasViewRules(at.gridView.sorts, at.gridView.filters, at.result.columns)
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
  // The view is written ONLY once the run is committed to: persisting chips or a
  // sort glyph for a rule that never reached the server would leave the grid
  // claiming a filter the rows don't reflect — and the next plain Run would then
  // silently wrap with it.
  function onSortFilter(sorts: SortKey[], filters: FilterTree, kind: "sort" | "filter") {
    const tab = activeTab();
    if (running()) {
      patchResult(tab.id, { status: `${kind} is unavailable while a query is running` });
      return;
    }
    if (kind === "sort" && localSortEligible() && !hasConditions(filters)) {
      setGridView({ sorts, filters });
      patchResult(tab.id, { epoch: tab.result.epoch + 1 });
      return;
    }
    const base = tab.result.baseQuery;
    if (!activeDatabaseAllowed() || !canServerSortFilter()) {
      patchResult(tab.id, {
        status: `${kind} rejected: ${sortUnavailable() || "This result can't be re-run with a server-side sort or filter"}`,
      });
      return;
    }
    const sqlToRun = hasViewRules(sorts, filters, tab.result.columns) ? tryWrapQuery(tab, sorts, filters) : base;
    // Wrap refused (unwrappable base, duplicate filter names) — tryWrapQuery has
    // already reported why; leave the previous view in place.
    if (sqlToRun === null) return;
    setGridView({ sorts, filters });
    void executeQuery(sqlToRun, base, "wrapped");
  }

  /**
   * Open the visual filter builder over the active result. `columns`/`types` may
   * be supplied by the Explorer, which knows the relation before its generated
   * `SELECT *` has finished streaming; otherwise the loaded result's own columns
   * (and whatever table detail the editability path already fetched) are used.
   */
  function openFilterBuilder(prefill?: string, columns?: string[], types?: Record<string, string>) {
    const origin = captureOrigin();
    const cols = columns ?? activeTab().result.columns;
    if (!cols.length) {
      setStatus("Run a query first. The filter builder needs a loaded result.");
      return;
    }
    setActiveDialog({
      kind: "filter",
      columns: cols,
      types: types ?? filterColumnTypes(),
      dialect: connectionKind(),
      initial: activeTab().gridView.filters,
      prefill,
      // Every callback re-checks the origin: the dialog outlives a tab switch or
      // a new result only as long as it still targets the tab it was opened on.
      // The RESULT generation is deliberately NOT part of that check — the
      // Explorer's "Filter rows…" opens the builder while its generated SELECT is
      // still in flight, so the result the filter lands on is always a later one
      // than the dialog was opened over. Instead of binding to a generation the
      // flow cannot satisfy, every apply is re-validated against the LIVE result's
      // columns and refused when a rule no longer resolves — a stale rule must
      // never be silently dropped from the WHERE clause.
      onApply: (tree) => {
        if (!originCurrent(origin)) return;
        const tab = activeTab();
        const live = tab.result.columns;
        if (activeConditionCount(tree, live) !== conditions(tree).length) {
          patchResult(tab.id, {
            status: "Filter rejected: some conditions name columns this result no longer has",
          });
          return;
        }
        onSortFilter(tab.gridView.sorts, tree, "filter");
      },
      onOpenQuery: (tree) => {
        if (!originCurrent(origin)) return;
        const tab = activeTab();
        const sqlText = tryWrapQuery(tab, tab.gridView.sorts, tree, "filter query");
        if (sqlText !== null) openGeneratedTab(sqlText, tab.searchSchema, "Filtered");
      },
      onCopyWhere: (where) => copyText(where ? `WHERE ${where}` : "", "Copied WHERE clause", origin),
    }, origin);
  }

  // Page the ACTIVE tab's stream. Everything is resolved from that tab's connection:
  // its cursor owner, its fetch generation, its transaction.
  async function loadMore() {
    const id = activeTabId();
    const tab = tabs().find((t) => t.id === id);
    const entry = entryOf(tab?.connectionId);
    const c = entry?.conn ?? null;
    const rt = entry?.runtime ?? null;
    if (!c || !rt || !tab) return;
    const txOf = () => stateOf(c.id)?.transaction ?? IDLE_TRANSACTION;
    if (tab.result.done || entry!.state().fetchingMore || !transactionDatabaseAllowed(txOf(), id)) return;
    const owner = rt.cursorOwner;
    if (!owner || owner.tabId !== id || owner.connectionGeneration !== c.generation || tab.result.generation !== owner.resultGeneration) return;
    const operation = ++rt.fetchGeneration;
    const before = txOf();
    let expectedTransactionRevision = before.revision;
    const isCurrent = () =>
      rt.fetchGeneration === operation &&
      connectionOpen(c) &&
      rt.cursorOwner?.cursorGeneration === owner.cursorGeneration &&
      rt.cursorOwner.resultGeneration === owner.resultGeneration &&
      tabs().find((t) => t.id === id)?.result.generation === owner.resultGeneration &&
      txOf().revision === expectedTransactionRevision;
    patchConn(c.id, { fetchingMore: true });
    try {
      const r = await invoke<FetchResult>("fetch_more", { connectionId: c.id, ownerId: id, pageSize: PAGE });
      expectedTransactionRevision = r.transaction.revision;
      if (!applyAuthoritativeTransaction(c, r.transaction, "statement", before) || !isCurrent()) return;
      // Read the captured tab's rows (the user may have switched tabs during the fetch).
      const prev = tabs().find((t) => t.id === id)?.result.rows ?? [];
      const merged = r.rows.length ? [...prev, ...r.rows] : prev;
      if (r.interrupted) {
        // The backend found our cursor already closed by an intervening command
        // (metadata read, Explorer DDL, export, import) that the frontend didn't
        // intercept. Never present the partial rows as the full result.
        patchResult(id, { rows: merged, ...interruptedResult({ rows: merged, done: false }, "Another database action closed the result stream") });
      } else {
        patchResult(id, { rows: merged, done: r.done, status: `${merged.length}${r.done ? "" : "+"} rows` });
      }
      if (r.done) {
        rt.cursorOwner = null;
        rt.cursorGeneration++;
      }
    } catch (e) {
      const embedded = transactionFromError(e);
      if (embedded) {
        expectedTransactionRevision = embedded.revision;
        if (!applyAuthoritativeTransaction(c, embedded, "statement", before)) return;
      }
      if (!isCurrent()) return;
      // Streaming broke (e.g. connection dropped mid-fetch). Surface it instead of
      // silently marking the result complete — show the error banner over the rows
      // fetched so far, and stop paging so we don't hammer a dead cursor.
      const msg = errMsg(e);
      patchResult(id, { runErr: msg, status: `Streaming stopped: ${msg}`, done: true, incomplete: `Streaming stopped: ${msg}` });
      rt.cursorOwner = null;
      rt.cursorGeneration++;
    } finally {
      if (rt.fetchGeneration === operation) patchConn(c.id, { fetchingMore: false });
    }
  }

  // Drain the active tab's cursor to completion (or cancel). Yields between pages to
  // stay responsive. The loop is bound to one connection's runtime, so another
  // connection's paging is neither cancelled by nor waits on this one.
  async function loadAll() {
    const id = activeTabId();
    const entry = entryOf(tabs().find((t) => t.id === id)?.connectionId);
    const c = entry?.conn ?? null;
    const rt = entry?.runtime ?? null;
    if (!c || !rt) return;
    if (entry!.state().loadingAll) { rt.cancelAll = true; return; }
    const ownerGeneration = rt.cursorOwner?.cursorGeneration;
    patchConn(c.id, { loadingAll: true });
    rt.cancelAll = false;
    while (
      !rt.cancelAll &&
      !tabs().find((t) => t.id === id)?.result.done &&
      rt.cursorOwner?.tabId === id &&
      rt.cursorOwner.cursorGeneration === ownerGeneration &&
      activeTabId() === id
    ) {
      await loadMore();
      await new Promise((r) => setTimeout(r));
    }
    patchConn(c.id, { loadingAll: false });
  }

  function tableNameFromSql(s: string): string {
    const m = /from\s+(?:"?[\w]+"?\.)?"?([\w]+)"?/i.exec(s);
    return m ? m[1] : "export";
  }

  async function exportToFile(opts: ExportOptions, scope: ExportScope): Promise<boolean> {
    setExportBusy(true);
    try {
      return await runExportToFile(opts, scope);
    } finally {
      setExportBusy(false);
    }
  }

  async function runExportToFile(opts: ExportOptions, scope: ExportScope): Promise<boolean> {
    const src = exportSrc();
    if (!src || !originCurrent(src.origin, true)) return false;
    if (scope === "all" && transactionOpen(transaction())) {
      throw new Error("All-rows export is frozen during a manual transaction. Export loaded rows instead.");
    }
    const table = opts.sql.table || src.table;
    const path = await chooseSavePath({
      defaultPath: `${table}.${FORMAT_EXT[opts.format]}`,
      filters: [{ name: opts.format.toUpperCase(), extensions: [FORMAT_EXT[opts.format]] }],
    });
    if (!path) return false;
    if (!originCurrent(src.origin, true)) return false;
    if (src.origin.tabId) patchResult(src.origin.tabId, { status: "Exporting…" });
    const inline = scope === "selection" ? src.selectionRows : src.rows;
    const args =
      scope === "all"
        ? { connectionId: src.connectionId, sql: src.query, options: opts, path, searchPath: src.searchSchema }
        : { connectionId: src.connectionId, columns: src.columns, rows: inline, options: opts, path };
    const t0 = performance.now();
    // A scope=all export RE-RUNS the query server-side — that belongs in history
    // like every other server execution (Slack runs and Explorer DDL are recorded).
    const exportHistory = (status: "ok" | "error", rows: number | null, error: string | null) => {
      if (scope !== "all") return;
      // Keyed by DESTINATION, like every other history write: an export that finishes
      // after the user moved to another connection still belongs to the one that ran it.
      const key = entryOf(src.connectionId)?.conn.key;
      if (key) recordHistory({
        sql: `-- [Export] ${opts.format} → ${path}\n${src.query}`,
        durationMs: Math.round(performance.now() - t0),
        status,
        rows,
        error,
        schema: src.searchSchema ?? null,
      }, key);
    };
    if (scope === "all") interruptStream("All-rows export closed the result stream", src.connectionId);
    try {
      const n = await invoke<number>("export_to_file", args);
      exportHistory("ok", n, null);
      if (originCurrent(src.origin, true) && src.origin.tabId) patchResult(src.origin.tabId, { status: `Exported ${n} rows to ${path}` });
      return true;
    } catch (e) {
      exportHistory("error", null, errMsg(e).split("\n")[0]);
      if (originCurrent(src.origin, true) && src.origin.tabId)
        patchResult(src.origin.tabId, { status: `Export rejected: ${errMsg(e)}` });
      throw e;
    }
  }

  // --- backup / restore ---
  // Both are whole-connection operations: they need an idle session, so the single
  // result stream is released first (the established `interruptStream` contract) and
  // the run is recorded in history like every other server execution.
  const [backupTarget, setBackupTarget] = createSignal<BackupTarget | null>(null);
  const [restoreOpen, setRestoreOpen] = createSignal(false);
  // Both dialogs target a whole CONNECTION, not a tab, so they are bound to the
  // connection generation they were opened on (the way `exportSrc` is): a
  // disconnect/reconnect underneath an open dialog must never let its Run button
  // rewrite a different database.
  let backupConnection: { id: string; generation: number } | null = null;
  let restoreConnection: { id: string; generation: number } | null = null;
  // Both dialogs own a long backend operation with its own Cancel and progress. They
  // must survive a connection switch or a transaction opening elsewhere: unmounting
  // one mid-run drops its progress listener and its Cancel while the backend keeps
  // writing. They also gate window close, like an import does.
  const [backupBusy, setBackupBusy] = createSignal(false);
  const [restoreBusy, setRestoreBusy] = createSignal(false);
  const boundToCurrentConnection = (b: { id: string; generation: number } | null) => {
    const c = conn();
    return !!c && !!b && c.id === b.id && c.generation === b.generation;
  };
  const closeBackup = () => {
    if (backupBusy()) return;
    backupConnection = null;
    setBackupTarget(null);
  };
  const closeRestore = () => {
    if (restoreBusy()) return;
    restoreConnection = null;
    setRestoreOpen(false);
  };
  function openRestore() {
    const c = conn();
    if (!c) return;
    restoreConnection = { id: c.id, generation: c.generation };
    setRestoreOpen(true);
  }

  const backupCatalog = () =>
    (tree()?.schemas ?? []).map((s) => ({ name: s.name, tables: s.tables.map((t) => t.name) }));

  function openBackup(target: BackupTarget) {
    if (rejectFrozenExplorer()) return;
    setMenu(null);
    const c = conn();
    if (!c) return;
    backupConnection = { id: c.id, generation: c.generation };
    setBackupTarget(target);
  }

  const pickBackupPath = (suggested: string) =>
    chooseSavePath({
      defaultPath: `${suggested || "backup"}.sql`,
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });

  async function runBackup(opts: BackupOptions, path: string): Promise<BackupSummary> {
    const c = conn();
    if (!c) throw new Error("not connected");
    if (!boundToCurrentConnection(backupConnection))
      throw new Error("The connection changed. Close this dialog and start the backup again.");
    // The backend refuses a backup while a manual transaction owns the session.
    // Check that FIRST: `interruptStream` condemns a healthy cursor, and it must
    // not be spent on a call that is going to be rejected anyway.
    if (metadataFrozen())
      throw new Error("Backup is frozen during a manual transaction. Commit or roll it back first.");
    interruptStream("Backup closed the result stream", c.id);
    const t0 = performance.now();
    setBackupBusy(true);
    try {
      const summary = await invoke<BackupSummary>("backup_to_file", backupPayload(c.id, path, opts));
      recordHistory({
        sql: `-- [Backup] ${opts.scope}/${opts.content} → ${path}`,
        durationMs: Math.round(performance.now() - t0),
        status: "ok",
        rows: summary.rows,
        error: null,
        schema: null,
      }, c.key);
      return summary;
    } catch (e) {
      recordHistory({
        sql: `-- [Backup] ${opts.scope}/${opts.content} → ${path}`,
        durationMs: Math.round(performance.now() - t0),
        status: /cancel/i.test(errMsg(e)) ? "cancelled" : "error",
        rows: null,
        error: errMsg(e).split("\n")[0],
        schema: null,
      }, c.key);
      throw e;
    } finally {
      setBackupBusy(false);
    }
  }

  async function pickRestoreFile(): Promise<BackupFileInfo | null> {
    const path = await chooseOpenPath({ filters: [{ name: "SQL", extensions: ["sql"] }] });
    if (!path) return null;
    return invoke<BackupFileInfo>("read_backup_header", { path });
  }

  async function runRestore(path: string, opts: RestoreOptions): Promise<RestoreSummary> {
    const c = conn();
    if (!c) throw new Error("not connected");
    if (!boundToCurrentConnection(restoreConnection))
      throw new Error("The connection changed. Close this dialog and start the restore again.");
    if (metadataFrozen())
      throw new Error("Restore is frozen during a manual transaction. Commit or roll it back first.");
    interruptStream("Restore closed the result stream", c.id);
    const t0 = performance.now();
    const entry = (status: HistoryEntry["status"], rows: number | null, error: string | null) =>
      recordHistory({
        sql: `-- [Restore] ${path}`,
        durationMs: Math.round(performance.now() - t0),
        status,
        rows,
        error,
        schema: null,
      }, c.key);
    setRestoreBusy(true);
    try {
      const summary = await invoke<RestoreSummary>("restore_from_file", { connectionId: c.id, path, options: opts });
      entry(
        summary.cancelled ? "cancelled" : summary.statementsFailed ? "error" : "ok",
        summary.rowsCopied,
        summary.firstError ? summary.firstError.message.split("\n")[0] : null,
      );
      // The database changed underneath the sidebar/autocomplete — refetch. Pass `c`:
      // a restore can run for minutes, and the default target is whichever connection
      // is focused when it finishes, which would refresh the wrong tree AND interrupt
      // an unrelated connection's live stream.
      if (connectionOpen(c)) await loadSchema(c);
      return summary;
    } catch (e) {
      entry(/cancel/i.test(errMsg(e)) ? "cancelled" : "error", null, errMsg(e).split("\n")[0]);
      if (connectionOpen(c)) await loadSchema(c);
      throw e;
    } finally {
      setRestoreBusy(false);
    }
  }

  // Immediately cancel + roll back the in-flight query/export/import on ONE
  // connection. The id is required (never "the active one"): a cancel must reach the
  // connection that armed the operation even after the user switched away.
  async function cancelOperation(connectionId = activeConnectionId(), ownerId = activeTabId()) {
    const entry = entryOf(connectionId);
    if (!connectionId || !entry) return;
    const c = entry.conn;
    try {
      const status = await invoke<TransactionStatus>("cancel_operation", { connectionId, ownerId });
      applyAuthoritativeTransaction(c, status);
    } catch (e) {
      // A rejected cancel means no unwind will ever reset the Cancelling… state or
      // report why — do both here (the error may still carry authoritative state).
      const embedded = transactionFromError(e);
      if (embedded) applyAuthoritativeTransaction(c, embedded);
      patchConn(c.id, { cancelling: false });
      patchResult(ownerId, { status: `Cancel failed: ${errMsg(e)}` });
    }
  }

  async function exportToClipboard(opts: ExportOptions, scope: ExportScope = "loaded"): Promise<boolean> {
    const src = exportSrc();
    if (!src || !originCurrent(src.origin, true)) return false;
    const source = scope === "selection" ? src.selectionRows : src.rows;
    const cells = source.length * src.columns.length;
    if (cells > 1_000_000) {
      const message = `Result too large to copy (${cells.toLocaleString()} cells). Export to a file instead.`;
      if (src.origin.tabId) patchResult(src.origin.tabId, { status: message });
      throw new Error(message);
    }
    let chars = src.columns.reduce((n, col) => n + col.length, 0);
    outer: for (const row of source) {
      for (const value of row) {
        chars += value?.length ?? 0;
        if (chars > 8 * 1024 * 1024) break outer;
      }
    }
    if (chars > 8 * 1024 * 1024) {
      const message = `Result too large to copy (${chars.toLocaleString()}+ characters). Export to a file instead.`;
      if (src.origin.tabId) patchResult(src.origin.tabId, { status: message });
      throw new Error(message);
    }
    let text: string;
    try {
      text = formatWithOptions({ columns: src.columns, rows: source }, opts, src.dialect);
    } catch (e) {
      if (src.origin.tabId) patchResult(src.origin.tabId, { status: `Format rejected: ${errMsg(e)}` });
      throw e;
    }
    const ok = await clipWrite(text);
    if (originCurrent(src.origin, true) && src.origin.tabId)
      patchResult(src.origin.tabId, { status: ok ? `Copied ${source.length} rows` : "Clipboard unavailable" });
    if (!ok) throw new Error("Clipboard unavailable");
    return true;
  }

  function openImport(target: { schema: string; name: string } | null = null) {
    const c = conn();
    if (!c || metadataFrozen() || running() || fetchingMore() || commitBusy()) {
      setStatus(metadataFrozen()
        ? "Import is frozen during a manual transaction"
        : "Wait for the current database operation before importing");
      return;
    }
    importOrigin = { origin: captureOrigin(), connection: c };
    setImportProgress(null);
    setImportBusy(false);
    setImportOpen({
      target,
      dialect: connectionKind(),
      supportsSchemas: caps()?.schemas !== false,
      schemas: tree()?.schemas.map((sc) => sc.name) ?? [],
      tables: schema().map((t) => ({ schema: t.schema, name: t.name })),
      defaultSchema:
        activeTab().searchSchema
        ?? tree()?.schemas.find((sc) => sc.name === "public")?.name
        ?? tree()?.schemas[0]?.name
        ?? "public",
    });
  }

  /** Parse the head of a file in Rust. No connection is involved. */
  function previewImport(path: string, options: ImportOptions): Promise<ImportPreview> {
    return invoke<ImportPreview>("import_preview", { path, options });
  }

  /** Target-table columns for the mapping step (cached tree detail where possible). */
  async function importTargetColumns(schemaName: string, table: string) {
    // The BOUND connection, not the active one: the dialog stays mounted across a
    // connection switch while a run is in flight, and a same-named table on the
    // newly focused connection would otherwise hand back its columns.
    const c = importOrigin?.connection;
    if (!c || !connectionOpen(c) || !table) return [];
    // `stateOf(c.id)`, not `details()`: after the await the focused connection may be
    // a different one, and a same-named table there would hand back its columns.
    const detailsOf = () => stateOf(c.id)?.details ?? {};
    const cached = detailsOf()[relKey(schemaName, table)];
    if (cached) return cached.columns.map((col) => ({ name: col.name, data_type: col.data_type }));
    await loadDetail(schemaName, table, false, c);
    const loaded = detailsOf()[relKey(schemaName, table)];
    return loaded ? loaded.columns.map((col) => ({ name: col.name, data_type: col.data_type })) : [];
  }

  /**
   * Stream a file into the database. Like every other server-executing path this
   * records history (`-- [Import] …`) and frees the shared cursor first; the whole
   * load is one transaction, so a failure or cancel leaves nothing behind.
   */
  async function runImport(
    path: string,
    options: ImportOptions,
    target: ImportTarget,
  ): Promise<ImportSummary> {
    const binding = importOrigin;
    const c = binding?.connection;
    // `frozenFor(c.id)`, not `metadataFrozen()`: the freeze that matters belongs to
    // the BOUND connection, and the active one may have moved on.
    if (!binding || !c || !connectionOpen(c) || frozenFor(c.id)) {
      throw new Error("The connection changed. Reopen the import dialog.");
    }
    const label = `${target.schema ? `${target.schema}.` : ""}${target.table}`;
    const t0 = performance.now();
    setImportBusy(true);
    setImportProgress(null);
    interruptStream("Import closed the result stream", c.id);
    try {
      const summary = await invoke<ImportSummary>("import_from_file", {
        connectionId: c.id,
        path,
        options,
        target,
      });
      recordHistory({
        sql: `-- [Import] ${path} → ${label} (${summary.rowsInserted} rows)`,
        durationMs: Math.round(performance.now() - t0),
        status: "ok",
        rows: summary.rowsInserted,
        error: null,
        schema: target.schema || null,
      }, c.key);
      if (connectionOpen(c) && !frozenFor(c.id)) await loadSchema(c);
      return summary;
    } catch (e) {
      const message = errMsg(e);
      recordHistory({
        sql: `-- [Import] ${path} → ${label}`,
        durationMs: Math.round(performance.now() - t0),
        status: "error",
        rows: null,
        error: message.split("\n")[0],
        schema: target.schema || null,
      }, c.key);
      throw new Error(/cancel/i.test(message) ? "Import cancelled. Changes were rolled back." : message);
    } finally {
      setImportBusy(false);
      setImportProgress(null);
    }
  }

  function closeImport() {
    if (importBusy()) return;
    setImportOpen(null);
    importOrigin = null;
  }

  // --- Explorer table export ---

  /** Export one relation's full contents through the ordinary safe query path. */
  async function openTableExport(schemaName: string, name: string, kind = "table") {
    const c = conn();
    if (!c || rejectFrozenExplorer()) return;
    const origin = captureOrigin();
    // The dialog's column list comes from the relation detail — fetch it BEFORE the
    // export opens, never while a stream is live (it rolls the shared cursor back).
    interruptStream("Reading table columns closed the result stream", c.id);
    await loadDetail(schemaName, name, false, c);
    if (!connectionOpen(c) || !originCurrent(origin)) return;
    const detail = details()[relKey(schemaName, name)];
    const query = withDialect(connectionKindOf(stateOf(c.id)), () => `SELECT * FROM ${qualifyIn(schemaName, name, schemaName)}`);
    setExportSrc({
      columns: detail?.columns.map((col) => col.name) ?? [],
      rows: [],
      selectionRows: [],
      incomplete: "",
      query,
      table: name,
      searchSchema: caps()?.searchPath ? schemaName : null,
      boolCols: [],
      origin,
      connectionId: c.id,
      dialect: connectionKind(),
      // Only a real table's reconstruction is a runnable CREATE ahead of INSERTs: a view
      // would emit `CREATE VIEW v AS SELECT …` followed by `INSERT INTO v`. Views fall
      // back to the synthetic all-`text` CREATE, with the dialog's note saying so.
      ddl: caps()?.ddl !== false && kind === "table" ? { schema: schemaName, name, kind } : undefined,
    });
  }

  function openTablesExport(schemaName: string | null) {
    const c = conn();
    if (!c || rejectFrozenExplorer()) return;
    const all = schema().map((t) => ({ schema: t.schema, name: t.name }));
    if (!all.length) {
      setStatus("No tables to export");
      return;
    }
    setExportTablesProgress(null);
    setExportTables({
      title: schemaName ? `Export tables in ${schemaName}` : "Export tables",
      tables: all,
      selection: schemaName ? all.filter((t) => t.schema === schemaName) : all,
      connectionId: c.id,
    });
  }

  async function runTablesExport(
    tables: { schema: string; name: string }[],
    options: ExportOptions,
    directory: string,
  ) {
    const src = exportTables();
    const c = conn();
    if (!src || !c || c.id !== src.connectionId) throw new Error("connection changed");
    interruptStream("Table export closed the result stream", c.id);
    const t0 = performance.now();
    setExportTablesBusy(true);
    try {
      const results = await invoke<{ schema: string; name: string; path: string; rows: number; error: string }[]>(
        "export_tables",
        { connectionId: src.connectionId, tables, options, directory },
      );
      const ok = results.filter((r) => !r.error).length;
      recordHistory({
        sql: `-- [Export] ${options.format} → ${directory} (${ok}/${results.length} tables)`,
        durationMs: Math.round(performance.now() - t0),
        status: ok === results.length ? "ok" : "error",
        rows: results.reduce((n, r) => n + r.rows, 0),
        error: results.find((r) => r.error)?.error ?? null,
        schema: null,
      }, c.key);
      return results;
    } finally {
      setExportTablesBusy(false);
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
    setStatus("Explorer actions are frozen until the transaction ends");
    return true;
  }

  function runTable(schemaName: string, name: string) {
    if (rejectFrozenExplorer()) return;
    const q = withDialect(connectionKind(), () => `SELECT * FROM ${qualifyIn(schemaName, name, schemaName)}`);
    openGeneratedTab(q, schemaName, name);
    doRun(q);
  }

  function runTableLimit(schemaName: string, name: string, limit: number) {
    if (rejectFrozenExplorer()) return;
    // T-SQL has no LIMIT — `limitedSelect` emits `SELECT TOP (n)` on SQL Server.
    const q = withDialect(connectionKind(), () => limitedSelect("*", qualifyIn(schemaName, name, schemaName), limit));
    openGeneratedTab(q, schemaName, name);
    doRun(q);
  }

  /**
   * Open a table in a new tab, run it, and raise the visual filter builder over
   * it. The relation's detail supplies the builder's columns and type badges
   * before the generated `SELECT *` has finished streaming; the per-column quick
   * filter row is left showing as well, so dismissing the builder still lands on
   * the lighter surface.
   */
  async function filterTable(schemaName: string, name: string) {
    const owner = activeConnectionId();
    if (!owner || rejectFrozenExplorer()) return;
    const q = withDialect(connectionKind(), () => `SELECT * FROM ${qualifyIn(schemaName, name, schemaName)}`);
    const t = makeTab({ connectionId: owner, sql: q, searchSchema: schemaName, title: name });
    t.gridView = { ...t.gridView, filterRowOpen: true };
    setTabs((ts) => [...ts, t]);
    switchTab(t.id);
    // Detail rolls the shared cursor back, so fetch it BEFORE the run, never after.
    const key = relKey(schemaName, name);
    if (!details()[key] && !metadataFrozen()) await loadDetail(schemaName, name);
    const det = details()[key];
    if (activeTabId() !== t.id) return;
    doRun(q);
    if (det)
      openFilterBuilder(
        undefined,
        det.columns.map((c) => c.name),
        Object.fromEntries(det.columns.map((c) => [c.name, c.data_type])),
      );
  }

  // Run a DDL statement built by a form/confirm dialog, then refresh the tree.
  // Returns ok/error so the dialog can stay open and show failures inline.
  // Explorer DDL is a real database mutation: it lands in history like every other
  // run path (audit trail — Slack SELECTs are recorded; a right-click DROP must be
  // too), and its status/error surface reopens a collapsed results panel.
  async function runDDL(sqlText: string, origin = captureOrigin()): Promise<{ ok: boolean; error?: string }> {
    const c = conn();
    if (!c || !originCurrent(origin)) return { ok: false, error: "Connection or tab changed" };
    if (metadataFrozen()) return { ok: false, error: "Explorer actions are frozen during a manual transaction" };
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
    interruptStream("Explorer action closed the result stream", c.id);
    // A SQLite table rebuild DROPs the original, and DROP performs an implicit
    // `DELETE FROM` that a referencing child row turns into "FOREIGN KEY constraint
    // failed". `PRAGMA foreign_keys` is a silent no-op inside a transaction and the
    // rebuild script runs in the app-owned one, so the toggle has to be its own IDLE
    // statement on either side of it.
    const fkGuard = ddl.isSqliteRebuild(sqlText);
    const foreignKeys = async (on: boolean): Promise<string | null> => {
      try {
        await invoke("run_query", {
          connectionId: c.id,
          ownerId: origin.tabId ?? activeTabId(),
          sql: `PRAGMA foreign_keys=${on ? "ON" : "OFF"}`,
          pageSize: PAGE,
          searchPath: null,
        });
        return null;
      } catch (e) {
        return errMsg(e);
      }
    };
    if (fkGuard) {
      const failed = await foreignKeys(false);
      if (failed) {
        ddlHistory("error", failed.split("\n")[0]);
        return { ok: false, error: `Could not suspend foreign-key enforcement: ${failed}` };
      }
    }
    try {
      const out = await invoke<QueryResult>("run_query", { connectionId: c.id, ownerId: origin.tabId ?? activeTabId(), sql: sqlText, pageSize: PAGE, searchPath: null });
      ddlHistory("ok", null);
      if (!applyAuthoritativeTransaction(c, out.transaction, "statement", before)) return { ok: false, error: "Stale transaction response" };
      if (!connectionOpen(c) || !originCurrent(origin)) return { ok: false, error: "Connection or tab changed" };
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
      if (embedded) applyAuthoritativeTransaction(c, embedded, "statement", before);
      // The dialog stays open with the message, but the status bar still carried the
      // PREVIOUS action's `OK` — a failed edit must never read as a successful one.
      if (origin.tabId && originCurrent(origin)) patchResult(origin.tabId, { status: "failed" });
      return { ok: false, error: message };
    } finally {
      if (fkGuard) {
        const failed = await foreignKeys(true);
        if (failed && origin.tabId && originCurrent(origin))
          patchResult(origin.tabId, { runErr: `Foreign-key enforcement is still off on this connection: ${failed}` });
      }
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
      if (origin.tabId && originAlive(origin)) patchResult(origin.tabId, { status: `Value too large to copy (${text.length.toLocaleString()} characters)` });
      return;
    }
    void clipWrite(text).then((ok) => {
      if (origin.tabId && originAlive(origin)) patchResult(origin.tabId, { status: ok ? msg ?? `copied ${text}` : "Clipboard unavailable" });
    });
  }

  // Reconstruct an object's DDL on the backend, then copy or scaffold it.
  async function copyDDL(n: NodeDescriptor, toEditor: boolean) {
    const c = conn();
    if (!c || rejectFrozenExplorer()) return;
    const origin = captureOrigin();
    interruptStream("Reading object DDL closed the result stream", c.id);
    try {
      const dd = await invoke<string>("object_ddl", {
        connectionId: c.id,
        kind: n.kind,
        schema: n.schema ?? "",
        name: n.name,
      });
      if (!connectionOpen(c) || !originAlive(origin) || !origin.tabId) return;
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
    if (!connectionOpen(c) || !originCurrent(origin)) return;
    const d = details()[relKey(n.schema!, n.name)];
    const cols = d?.columns.map((c) => c.name) ?? [];
    const pks = d?.columns.filter((c) => c.is_pk).map((c) => c.name) ?? [];
    const schema = n.schema!;
    const text = withDialect(connectionKindOf(stateOf(c.id)), () =>
      kind === "select"
        ? ddl.genSelect(schema, n.name, cols, schema)
        : kind === "insert"
          ? ddl.genInsert(schema, n.name, cols, schema)
          : ddl.genUpdate(schema, n.name, cols, pks, schema));
    openGeneratedTab(text.trim() + ";", schema, n.name);
  }

  /** The kind of one existing constraint, from the cached relation detail. MySQL drops
   *  each kind with a different ALTER action, so the drop builder needs it. */
  function constraintKindOf(schemaName: string, table: string, name: string): string | undefined {
    return details()[relKey(schemaName, table)]?.constraints.find((c) => c.name === name)?.kind;
  }

  /** Lazy referenced-column detail for the foreign-key picker: key columns are marked
   *  and sorted first. `list_schema` knows the names but not which columns are keys, so
   *  this fetches `table_detail` for the ONE table the user picked. */
  async function loadRefColumns(schemaName: string, table: string) {
    const c = conn();
    if (!c || metadataFrozen()) return null;
    await loadDetail(schemaName, table, false, c);
    if (!connectionOpen(c)) return null;
    // `connectionOpen` means "still the same live session", not "still focused", so
    // the detail must come from `c`'s own cache rather than the active connection's.
    const d = (stateOf(c.id)?.details ?? {})[relKey(schemaName, table)];
    if (!d) return null;
    // Key columns come from each index's COLUMN LIST, never from its rendered `def`:
    // "UNIQUE INDEX `uq` (`user_id`)" contains the substrings "id" and "user", so a
    // def scan marked unrelated columns unique and floated them to the top of the picker.
    const unique = new Set(ddl.uniqueIndexColumns(d.indexes));
    return d.columns.map((col) => ({
      name: col.name,
      data_type: col.data_type,
      isKey: col.is_pk || unique.has(col.name),
      keyLabel: col.is_pk ? "pk" : unique.has(col.name) ? "unique" : undefined,
    }));
  }

  // Index/constraint dialogs need the relation's column list (and FK targets).
  async function openIndexDialog(n: NodeDescriptor) {
    const c = conn();
    if (!c || rejectFrozenExplorer()) return;
    const origin = captureOrigin();
    await loadDetail(n.schema!, n.name, false, c);
    if (!connectionOpen(c) || !originCurrent(origin)) return;
    const d = details()[relKey(n.schema!, n.name)];
    setActiveDialog({ kind: "addIndex", ctx: n, columns: d?.columns.map((c) => c.name) ?? [] }, origin);
  }
  async function openConstraintDialog(n: NodeDescriptor) {
    const c = conn();
    if (!c || rejectFrozenExplorer()) return;
    const origin = captureOrigin();
    await loadDetail(n.schema!, n.name, false, c);
    if (!connectionOpen(c) || !originCurrent(origin)) return;
    const d = details()[relKey(n.schema!, n.name)];
    setActiveDialog({
      kind: "addConstraint",
      ctx: n,
      columns: d?.columns.map((c) => c.name) ?? [],
      columnTypes: Object.fromEntries((d?.columns ?? []).map((c) => [c.name, c.data_type])),
      tables: schema(),
    }, origin);
  }
  async function openModify(n: NodeDescriptor) {
    const c = conn();
    if (!c || rejectFrozenExplorer()) return;
    const origin = captureOrigin();
    await loadDetail(n.schema!, n.name, false, c);
    if (!connectionOpen(c) || !originCurrent(origin)) return;
    const d = details()[relKey(n.schema!, n.name)];
    if (d)
      setActiveDialog(
        { kind: "modifyTable", ctx: n, detail: d, schemas: tree()?.schemas.map((x) => x.name) ?? [], tables: schema() },
        origin,
      );
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
        { label: `New constraint on ${tableCtx.name}…`, icon: "link", ...gate(ownsTable(tableCtx.schema!, tableCtx.name), `Requires ownership of ${tableCtx.name}`), ...engineCan(dcaps().addConstraint, "add constraints with ALTER TABLE; define them in CREATE TABLE"), onClick: () => openConstraintDialog(tableCtx) },
        { sep: true },
      );
    }
    if (schemaName)
      items.push({ label: `New table in ${schemaName}…`, icon: "copy", ...gate(canCreateInSchema(schemaName), `Requires CREATE on schema ${schemaName}`), onClick: () => setActiveDialog({ kind: "createTable", schema: schemaName, tables: schema() }) });
    items.push(
      { label: "New schema…", icon: "folder", ...gate(canCreateSchema(), "Requires CREATE on the database"), ...engineCan(dcaps().createSchema, "create a schema"), onClick: () => setActiveDialog({ kind: "createSchema" }) },
      { label: "New database…", icon: "database", ...gate(canCreateDatabase(), "Requires the CREATEDB role attribute"), ...engineCan(dcaps().createDatabase, "create a database from here"), onClick: () => setActiveDialog({ kind: "createDatabase" }) },
    );
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  function openMenu(e: MouseEvent, node: NodeDescriptor) {
    e.preventDefault();
    if (metadataFrozen()) {
      const items: MenuItem[] = [{ label: "Explorer actions are frozen during a manual transaction", disabled: true, onClick: () => {} }];
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
          { label: "Filter rows…", icon: "search", onClick: () => void filterTable(s!, n.name) },
          { sep: true },
          { label: "Export table…", icon: "download", onClick: () => void openTableExport(s!, n.name) },
          { label: "Import data into table…", icon: "download", ...importGate(canInsert(s!, n.name), `Requires INSERT on ${n.name}`), onClick: () => openImport({ schema: s!, name: n.name }) },
          { sep: true },
          { label: "Modify table…", icon: "edit", ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), onClick: () => openModify(n) },
          { label: "Add column…", icon: "plus", ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), onClick: () => setActiveDialog({ kind: "addColumn", ctx: n }) },
          { label: "Add index…", icon: "index", ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), onClick: () => openIndexDialog(n) },
          { label: "Add constraint…", icon: "link", ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), ...engineCan(dcaps().addConstraint, "add constraints with ALTER TABLE; define them in CREATE TABLE"), onClick: () => openConstraintDialog(n) },
          { sep: true },
          { label: "Rename…", icon: "edit", ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), onClick: () => setActiveDialog({ kind: "rename", title: `Rename table ${n.name}`, current: n.name, build: (nn) => ddl.renameRelation("table", s!, n.name, nn) }) },
          { label: "Duplicate…", icon: "duplicate", ...gate(canCreateInSchema(s!), `Requires CREATE on schema ${s}`), onClick: () => setActiveDialog({ kind: "duplicate", title: `Duplicate ${n.name}`, defaultName: `${n.name}_copy`, build: (nn, wd) => ddl.duplicateTable(s!, n.name, nn, wd) }) },
          { label: "Edit comment…", icon: "comment", ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), ...engineCan(dcaps().comments !== "none", "comment on a table"), onClick: () => setActiveDialog({ kind: "comment", title: `Comment on ${n.name}`, current: n.detail?.comment ?? "", build: (t) => ddl.commentOnTable(s!, n.name, t) }) },
          { sep: true },
          { label: dcaps().truncate ? "Truncate…" : "Delete all rows…", icon: "eraser", danger: true, ...gate(canTruncate(s!, n.name), `Requires TRUNCATE or ownership of ${n.name}`), onClick: () => setActiveDialog({ kind: "confirm", title: dcaps().truncate ? `Truncate ${n.name}` : `Delete all rows from ${n.name}`, primaryLabel: dcaps().truncate ? "Truncate" : "Delete all rows", showCascade: dcaps().truncateOptions, showRestartIdentity: dcaps().truncateOptions, build: (o) => ddl.truncate(s!, n.name, o) }) },
          { label: "Drop…", icon: "trash", danger: true, ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), onClick: () => setActiveDialog({ kind: "confirm", title: `Drop table ${n.name}`, primaryLabel: "Drop table", showCascade: true, build: (o) => ddl.dropRelation("table", s!, n.name, o.cascade) }) },
          { sep: true },
          { label: "Backup table…", icon: "download", onClick: () => openBackup({ scope: "tables", schemas: [], tables: [{ schema: s!, name: n.name }], suggestedName: n.name }) },
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
          { label: "Filter rows…", icon: "search", onClick: () => void filterTable(s!, n.name) },
          { label: "Export…", icon: "download", onClick: () => void openTableExport(s!, n.name, kw) },
        );
        if (kw === "matview")
          items.push(
            { label: "Refresh", icon: "refresh", ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), onClick: () => runDDLToast(ddl.refreshMatview(s!, n.name, false)) },
            { label: "Refresh concurrently", icon: "refresh", ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), onClick: () => runDDLToast(ddl.refreshMatview(s!, n.name, true)) },
          );
        items.push(
          { sep: true },
          { label: "Rename…", icon: "edit", ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), onClick: () => setActiveDialog({ kind: "rename", title: `Rename ${n.name}`, current: n.name, build: (nn) => ddl.renameRelation(kw, s!, n.name, nn) }) },
          { label: "Edit comment…", icon: "comment", ...gate(ownsTable(s!, n.name), `Requires ownership of ${n.name}`), ...engineCan(dcaps().comments === "standard", "comment on a view"), onClick: () => setActiveDialog({ kind: "comment", title: `Comment on ${n.name}`, current: n.detail?.comment ?? "", build: (t) => ddl.comment(`${kw === "matview" ? "MATERIALIZED VIEW" : "VIEW"} ${qual}`, t) }) },
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
          // MySQL has no COMMENT ON: a column comment there restates the whole column
          // definition, so the builder needs the column as the catalog reports it.
          { label: "Edit comment…", icon: "comment", ...gate(ownsTable(s!, n.table!), `Requires ownership of ${n.table}`), ...engineCan(dcaps().comments !== "none", "comment on a column"), onClick: () => setActiveDialog({ kind: "comment", title: `Comment on ${n.name}`, current: c.comment ?? "", build: (t) => ddl.commentOnColumn(s!, n.table!, { name: c.name, type: c.data_type, nullable: c.nullable, default: c.default ?? "", identity: c.identity }, t) }) },
          { sep: true },
          { label: "Drop column…", icon: "trash", danger: true, ...gate(ownsTable(s!, n.table!), `Requires ownership of ${n.table}`), onClick: () => setActiveDialog({ kind: "confirm", title: `Drop column ${n.name}`, primaryLabel: "Drop column", showCascade: true, build: (o) => ddl.dropColumn(s!, n.table!, n.name, o.cascade) }) },
          { sep: true },
          copyName,
        );
        break;
      }
      case "schema": {
        // On MySQL a schema IS a database: dropping this node destroys a whole
        // database, so it is labelled, confirmed and guarded as a database drop —
        // including the "can't drop the one you're connected to" guard.
        const dropsDatabase = dcaps().dropSchema === "database";
        const droppingCurrentDb = dropsDatabase && tree()?.database === n.name;
        items.push(
          ...(caps()?.relationships !== false
            ? [{ label: "Schema diagram…", icon: "link" as const, onClick: () => openDdlGraph(n.name, null, "table") }, { sep: true as const }]
            : []),
          { label: "Create table…", icon: "plus", ...gate(canCreateInSchema(n.name), `Requires CREATE on schema ${n.name}`), onClick: () => setActiveDialog({ kind: "createTable", schema: n.name, tables: schema() }) },
          { label: "Import file as new table…", icon: "download", ...importGate(canCreateInSchema(n.name), `Requires CREATE on schema ${n.name}`), onClick: () => openImport({ schema: n.name, name: "" }) },
          { label: "Export tables…", icon: "download", onClick: () => openTablesExport(n.name) },
          { label: "Rename…", icon: "edit", ...gate(ownsSchema(n.name), `Requires ownership of schema ${n.name}`), ...engineCan(dcaps().renameSchema, "rename a schema"), onClick: () => setActiveDialog({ kind: "rename", title: `Rename schema ${n.name}`, current: n.name, build: (nn) => ddl.renameSchema(n.name, nn) }) },
          { sep: true },
          {
            label: dropsDatabase ? (droppingCurrentDb ? "Drop database… (connected)" : "Drop database…") : "Drop…",
            icon: "trash",
            danger: true,
            ...gate(ownsSchema(n.name), `Requires ownership of schema ${n.name}`),
            ...engineCan(dcaps().dropSchema !== false, dropsDatabase ? "drop a database from here" : "drop a schema"),
            ...(droppingCurrentDb ? { disabled: true, title: "Can't drop the connected database" } : {}),
            onClick: () =>
              setActiveDialog({
                kind: "confirm",
                title: dropsDatabase ? `Drop database ${n.name}` : `Drop schema ${n.name}`,
                primaryLabel: dropsDatabase ? "Drop database" : "Drop schema",
                showCascade: !dropsDatabase && dcaps().cascade,
                build: (o) => (dropsDatabase ? ddl.dropDatabase(n.name) : ddl.dropSchema(n.name, o.cascade)),
              }),
          },
          { sep: true },
          { label: "Backup schema…", icon: "download", onClick: () => openBackup({ scope: "schemas", schemas: [n.name], tables: [], suggestedName: n.name }) },
          { sep: true },
          copyName,
        );
        break;
      }
      case "database": {
        const cur = tree()?.database === n.name;
        items.push(
          { label: "Create schema…", icon: "plus", ...gate(canCreateSchema(), "Requires CREATE on the database"), ...engineCan(dcaps().createSchema, "create a schema"), onClick: () => setActiveDialog({ kind: "createSchema" }) },
          { label: "Import file as new table…", icon: "download", ...importGate(!pEnforced() || canCreateSchema() || schema().length > 0, "Requires CREATE somewhere in this database"), onClick: () => openImport(null) },
          { label: "Export tables…", icon: "download", onClick: () => openTablesExport(null) },

          // Same gate() as every other Explorer DDL item (manual-transaction freeze,
          // read-only, driver support) — DROP DATABASE least of all may skip the freeze.
          { label: cur ? "Drop… (connected)" : "Drop…", icon: "trash", danger: true, ...gate(!pEnforced() || isSuper(), "Requires database ownership (or superuser)"), ...engineCan(dcaps().dropDatabase, "drop a database from here"), ...(cur ? { disabled: true, title: "Can't drop the connected database" } : {}), onClick: () => setActiveDialog({ kind: "confirm", title: `Drop database ${n.name}`, primaryLabel: "Drop database", build: () => ddl.dropDatabase(n.name) }) },
          { sep: true },
          // Backup/restore run against the CONNECTED database — offer them only there.
          { label: "Backup database…", icon: "download", disabled: !cur, title: cur ? undefined : "Connect to this database to back it up", onClick: () => openBackup({ scope: "database", schemas: [], tables: [], suggestedName: n.name }) },
          { label: "Restore from file…", icon: "fileCode", disabled: !cur || !!conn()?.readOnly, title: !cur ? "Connect to this database to restore into it" : conn()?.readOnly ? "Connection is read-only" : undefined, onClick: () => { setMenu(null); if (!rejectFrozenExplorer()) openRestore(); } },
          { sep: true },
          copyName,
        );
        break;
      }
      case "index":
        items.push(
          { label: "Rename…", icon: "edit", ...gate(true, ""), ...engineCan(dcaps().renameIndex, "rename an index"), onClick: () => setActiveDialog({ kind: "rename", title: `Rename index ${n.name}`, current: n.name, build: (nn) => ddl.renameIndex(s!, n.name, nn, n.table) }) },
          { label: "Drop…", icon: "trash", danger: true, ...gate(true, ""), onClick: () => setActiveDialog({ kind: "confirm", title: `Drop index ${n.name}`, primaryLabel: "Drop index", showCascade: true, build: (o) => ddl.dropIndex(s!, n.name, o.cascade, n.table) }) },
          { sep: true },
          copyName,
        );
        break;
      case "constraint":
        items.push(
          { label: "Rename…", icon: "edit", ...gate(true, ""), ...engineCan(dcaps().renameConstraint, "rename a constraint"), onClick: () => setActiveDialog({ kind: "rename", title: `Rename constraint ${n.name}`, current: n.name, build: (nn) => ddl.renameConstraint(s!, n.table!, n.name, nn) }) },
          { label: "Drop…", icon: "trash", danger: true, ...gate(true, ""), ...engineCan(dcaps().dropConstraint !== "none", "drop a constraint with ALTER TABLE"), onClick: () => setActiveDialog({ kind: "confirm", title: `Drop constraint ${n.name}`, primaryLabel: "Drop constraint", showCascade: true, build: (o) => ddl.dropConstraint(s!, n.table!, n.name, o.cascade, constraintKindOf(s!, n.table!, n.name)) }) },
          { sep: true },
          copyName,
        );
        break;
      case "sequence":
        items.push(
          { label: "Restart… (edit value)", icon: "refresh", ...gate(true, ""), ...engineCan(dcaps().alterSequence, "restart a sequence"), onClick: () => editAsSql(ddl.alterSequenceRestart(s!, n.name, "1")) },
          { label: "Rename…", icon: "edit", ...gate(true, ""), ...engineCan(dcaps().renameSequence, "rename a sequence"), onClick: () => setActiveDialog({ kind: "rename", title: `Rename sequence ${n.name}`, current: n.name, build: (nn) => ddl.renameSequence(s!, n.name, nn) }) },
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
          else if (origin.tabId) patchResult(origin.tabId, { runErr: "Clipboard read blocked. Use ⌘/Ctrl+V." });
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
      label: "Explain Analyze (runs the statement)",
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
        { label: "Backup…", icon: "download", onClick: () => openBackup({ scope: "database", schemas: [], tables: [], suggestedName: tree()?.database || "backup" }) },
        { label: "Restore from file…", icon: "fileCode", disabled: !!conn()?.readOnly, title: conn()?.readOnly ? "Connection is read-only" : undefined, onClick: () => { setMenu(null); if (!rejectFrozenExplorer()) openRestore(); } },
        { sep: true },
        ...explainMenuItems(),
      ],
    });
  }

  // --- connect-screen profile menu ---
  function connString(p: Profile) {
    if (isEmbeddedDriver(p.driver)) return p.path || ":memory:";
    const scheme = p.driver === "mysql" ? "mysql" : p.driver === "mssql" ? "sqlserver" : "postgresql";
    const base = `${scheme}://${p.user}@${p.host}:${p.port}/${p.dbname}`;
    return p.sslmode && p.sslmode !== "prefer" ? `${base}?sslmode=${p.sslmode}` : base;
  }
  async function duplicateProfile(p: Profile) {
    try {
      await invoke("save_profile", {
        profile: { id: "", name: `${p.name} copy`, host: p.host, port: p.port, user: p.user, dbname: p.dbname, save_password: false, sslmode: p.sslmode, read_only: p.read_only, default_connect: false, driver: p.driver ?? "postgres", path: p.path ?? null, ssh: p.ssh ?? null, save_ssh_secret: false },
        password: null,
        sshSecret: null,
      });
      await loadProfiles();
    } catch (e) {
      setConnErr(errMsg(e));
    }
  }
  async function setProfileDefault(p: Profile, val: boolean) {
    try {
      await invoke("save_profile", { profile: { ...p, default_connect: val }, password: null, sshSecret: null });
      await loadProfiles();
    } catch (e) {
      setConnErr(errMsg(e));
    }
  }
  // --- sidebar background (empty space) menu ---
  function openSidebarMenu(e: MouseEvent) {
    e.preventDefault();
    if (metadataFrozen()) {
      setMenu({ x: e.clientX, y: e.clientY, items: [{ label: "Explorer actions are frozen during a manual transaction", disabled: true, onClick: () => {} }] });
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
        { label: "Copy connection string", icon: "copy", onClick: () => copyText(connString(p), "Copied connection string") },
        { sep: true },
        { label: "Delete…", icon: "trash", danger: true, onClick: () => askDeleteProfile(p) },
      ],
    });
  }

  // Persist all docked-panel sizes (called on resize-end, not per frame).
  const persistLayout = () =>
    layoutStore.save({
      sidebarW: sidebarW(), aiW: aiW(), historyW: historyW(), editorH: editorH(),
      sidebarOpen: sidebarOpen(), resultsOpen: resultsOpen(),
      // Profile ids only: an ad-hoc session's credentials were typed, never stored,
      // so offering to reopen one could only fail or prompt.
      //
      // Open AND still-pending, merged. Writing only the open set meant the first
      // connect of a session (a default-connect profile, or one click on the connect
      // screen) erased every other profile from the remembered list before the user
      // could accept the offer — the feature destroyed its own data.
      openConnections: mergeRememberedIds(rememberedProfileIds(connections()), reopenable()),
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

  /**
   * The connect screen. It is the whole window when nothing is open, and a modal over
   * the workbench when an existing session opens another connection ("+" in the
   * strip), so connecting never costs you the workspace you are already in.
   *
   * The reopen offer lives INSIDE the panel, so it is reachable from the "+" modal
   * too: the moment one profile connects the fallback branch is gone, and the offer
   * used to become unreachable while the rest of the session was still pending.
   */
  const connectPanel = () => (
          <>
          <Show when={pendingReopen().length > 0}>
            <div class="reopen-bar">
              <span>{pendingReopen().length} saved connection{pendingReopen().length === 1 ? "" : "s"} from your last session {pendingReopen().length === 1 ? "is" : "are"} not open.</span>
              <button class="ghost" disabled={connecting()} onClick={() => void reopenLastSession()}>Reopen last session</button>
              <button class="icon" title="Forget" onClick={() => { setReopenable([]); persistLayout(); }}>&#10005;</button>
            </div>
          </Show>
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
                              <Show when={p.ssh}>{(t) => <span class="chip-ssh" title={`Tunnelled through ${t().user}@${t().host}:${t().port}`}>SSH</span>}</Show>
                              <Show when={p.save_password}><Icon name="lock" /></Show>
                            </div>
                          </div>
                          <span class="profile-go"><Icon name="play" /></span>
                        </div>
                        <button class="icon" title="Edit" onClick={() => editProfile(p)}><Icon name="edit" /></button>
                        <button class="icon" title="Delete saved connection" onClick={() => askDeleteProfile(p)}><Icon name="trash" /></button>
                      </div>
                    )}
                  </For>
                  <Show when={profiles().length === 0}>
                    <div class="profiles-empty">
                      <span class="profiles-empty-mark">🐘</span>
                      <div>No saved connections yet.</div>
                      <div class="profiles-empty-sub">Fill the form and <b>Save</b>, or <b>Connect</b> without saving.</div>
                    </div>
                  </Show>
                </div>
                <button class="ghost full" onClick={newProfile}>＋ New connection</button>
                <div class="connect-foot">Right-click a connection for more actions. <kbd class="kb-kbd">F1</kbd> opens the manual.</div>
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
                            const previous = driver();
                            setDriver(d.id);
                            // Move the port only while it still holds SOME driver's default;
                            // a port the user typed is never overwritten. Comparing against
                            // the previous driver's default alone left the field at 5432
                            // when switching from a path-based driver (SQLite/DuckDB have no
                            // default port, so that comparison was against `undefined`).
                            const defaults: Record<string, number> = { postgres: 5432, mysql: 3306, mssql: 1433 };
                            const untouched =
                              port() === defaults[previous] || Object.values(defaults).includes(port());
                            if (defaults[d.id] && untouched) setPort(defaults[d.id]);
                            if (d.id !== "postgres" && dbname() === "postgres") setDbname("");
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
                      <label>User<input value={user()} onInput={(e) => setUser(e.currentTarget.value)} placeholder={driver() === "mysql" ? "root" : driver() === "mssql" ? "sa" : "postgres"} /></label>
                      <label>Password<input type="password" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} placeholder={editingId() && savePassword() ? "•••••• (stored)" : ""} /></label>
                      <div class="field-row halves">
                        <label>Database<input value={dbname()} onInput={(e) => setDbname(e.currentTarget.value)} placeholder={driver() === "postgres" ? "postgres" : "(optional)"} /></label>
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
                      <input value={path()} onInput={(e) => setPath(e.currentTarget.value)} placeholder={`/path/to/db.${driver() === "sqlite" ? "sqlite" : "duckdb"} (blank = in-memory)`} />
                      <button type="button" class="ghost" onClick={browseDbFile}>Browse…</button>
                    </div>
                  </label>
                  <div class="empty-hint">Leave blank for an in-memory database.</div>
                </Show>
                <Show when={!isEmbeddedDriver(driver())}>
                  <SshSection
                    state={ssh()}
                    onChange={patchSsh}
                    hasStoredSecret={sshSecretStored()}
                    onError={setConnErr}
                  />
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
          </>
  );

  return (
    <>
    <Show
      when={connections().length > 0}
      fallback={
        <div class="connect-screen">
          <div class="connect-utils">
            <button class="icon" title="Manual (F1)" onClick={() => setHelpOpen(true)}><Icon name="help" /></button>
            <button class="icon" title="Settings" onClick={() => setSettingsOpen("editor")}><Icon name="gear" /></button>
          </div>
          {connectPanel()}
        </div>
      }
    >
      <div class="workspace">
        <header class="topbar">
          <span class="brand-sm">{driverMascot(connectionKind())} Tusk</span>
          {/* Connection strip: one chip per open session. With a single connection it
              renders exactly the old topbar chip, so nothing changes visually until a
              second connection actually exists. */}
          <div class="conn-strip" role="tablist" aria-label="Open connections">
            <For each={connections()}>
              {(entry) => {
                const id = entry.conn.id;
                const active = () => activeConnectionId() === id;
                const dot = () => connectionDot(entry.state());
                return (
                  <span
                    class="conn-chip"
                    role="tab"
                    aria-selected={active()}
                    classList={{ active: active(), multi: connections().length > 1 }}
                    style={connections().length > 1 ? { "--conn-color": connectionColor(entry.colorIndex) } : undefined}
                    title={`${labelOf(id)} (${driverLabel(kindOf(id))}${entry.conn.viaSsh ? ", over SSH" : ""}): ${connectionDotTitle(dot())}`}
                    onClick={() => focusConnection(id)}
                  >
                    <Show when={connections().length > 1}>
                      <span class="conn-mascot">{driverMascot(kindOf(id))}</span>
                    </Show>
                    {/* The dot is the only place a background connection's state shows,
                        so when a query is running there it is also the way to cancel it
                        — behind a confirmation, since it sits inside a click target. */}
                    <Show
                      when={dot() === "running" && entry.state().running && !entry.state().cancelling}
                      fallback={<span class="conn-dot" classList={{ [dot()]: true }} />}
                    >
                      <button
                        class="conn-dot cancellable"
                        classList={{ [dot()]: true }}
                        title={`Cancel the query running on ${labelOf(id)}`}
                        aria-label={`Cancel the query running on ${labelOf(id)}`}
                        onClick={(e) => { e.stopPropagation(); setConfirmCancelConn(id); }}
                      />
                    </Show>
                    <span class="conn-name">{labelOf(id)}</span>
                    <Show when={entry.conn.viaSsh}>
                      <span class="conn-ssh" title="Connected over an SSH tunnel">SSH</span>
                    </Show>
                    <Show when={connections().length > 1}>
                      <button
                        class="conn-close"
                        title={`Disconnect ${labelOf(id)}`}
                        onClick={(e) => { e.stopPropagation(); void disconnectConnection(id); }}
                      >&#215;</button>
                    </Show>
                  </span>
                );
              }}
            </For>
            <button
              class="conn-add"
              title={connectionLimitError(connections()) || `Open another connection (${displayKey(effectiveKey("newConnection", keys()))})`}
              disabled={!!connectionLimitError(connections())}
              onClick={() => openConnectScreen()}
            >&#65291;</button>
          </div>
          <span class="meta">{driverLabel(connectionKind())} {conn()?.version ?? ""}</span>
          <Show when={conn()?.readOnly}>
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
          <button class="ghost" title={connections().length > 1 ? `Disconnect ${labelOf(activeConnectionId() ?? "")}` : undefined} onClick={() => void disconnect()}>Disconnect</button>
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
                        title="Commits the current MySQL transaction unit"
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
              <button class="btn-danger" onClick={() => { const e = activeEntry(); if (e) raiseTransactionResolution(e, { kind: "disconnect" }); }}>Disconnect / reconnect</button>
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
                {/* Same gate as the Explorer's three import items: read-only, the
                    manual-transaction freeze, and import's own engine support —
                    walking the whole wizard only to be refused by the backend is
                    worse than a disabled button that names the reason. */}
                <button
                  class="icon"
                  title={sidebarImportGate().title ?? "Import data"}
                  disabled={!!sidebarImportGate().disabled}
                  onClick={() => openImport(null)}
                ><Icon name="download" /></button>
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
              <Show when={tree()} fallback={<div class="empty-hint">No objects</div>}>
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
              {/* ui/customize: the strip scrolls; the ⌄ button beside it does not. */}
              <div class="tab-bar">
              <div
                class="tab-strip"
                ref={(el) => (stripEl = el)}
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
                  {(t, i) => (
                    <div
                      class="tab"
                      classList={{
                        active: t.id === activeTabId(),
                        pinned: t.pinned,
                        // Last pinned tab: the strip draws the group's right edge here.
                        "pin-edge": t.pinned && i() === pinnedTabCount(tabs()) - 1,
                        "tx-owner": stateOf(t.connectionId)?.transaction.owner === t.id,
                        frozen: transactionOpen(stateOf(t.connectionId)?.transaction ?? IDLE_TRANSACTION) && stateOf(t.connectionId)?.transaction.owner !== t.id,
                        "other-conn": connections().length > 1 && t.connectionId !== activeConnectionId(),
                        "dnd-source": dragTabId() === t.id,
                        renaming: inlineRename()?.id === t.id,
                      }}
                      style={connections().length > 1 ? { "--conn-color": connectionColor(entryOf(t.connectionId)?.colorIndex ?? 0) } : undefined}
                      title={`${t.filePath ?? tabLabel(t)}${connections().length > 1 ? ` (${labelOf(t.connectionId)})` : ""}`}
                      // Press-and-move reorder (src/dnd.ts): the press switches tabs,
                      // and travel past the threshold turns it into a drag whose
                      // trailing click must not switch back.
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        if ((e.target as HTMLElement).closest(".tab-close, .tab-rename")) return;
                        tabClickBlocked = false;
                        switchTab(t.id);
                        startTabDrag(e, i(), e.currentTarget);
                      }}
                      // Cancel the native selection Chromium starts on press, on
                      // mousedown rather than pointerdown so the ×'s click survives.
                      onMouseDown={(e) => {
                        if (e.button === 0 && !(e.target as HTMLElement).closest(".tab-close, .tab-rename")) e.preventDefault();
                      }}
                      onClick={() => {
                        if (tabClickBlocked) { tabClickBlocked = false; return; }
                        switchTab(t.id);
                      }}
                      onDblClick={(e) => {
                        if ((e.target as HTMLElement).closest(".tab-close, .tab-rename")) return;
                        beginRename(t.id);
                      }}
                      onAuxClick={(e) => { if (e.button === 1) closeTab(t.id); }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        const scoped = (label: string) => (connections().length > 1 ? `${label} on this connection` : label);
                        setMenu({
                          x: e.clientX,
                          y: e.clientY,
                          items: [
                            { label: "Rename…", icon: "edit", onClick: () => beginRename(t.id) },
                            { label: t.pinned ? "Unpin tab" : "Pin tab", icon: "star", onClick: () => togglePin(t.id) },
                            {
                              // One level down rather than a hover submenu: ContextMenu
                              // has no nesting, and re-opening in place keeps the
                              // keyboard path (Arrow/Enter) identical.
                              label: t.color ? `Colour: ${TAB_COLOR_LABELS[t.color]}` : "Colour…",
                              icon: "dot",
                              onClick: () =>
                                setMenu({
                                  x: e.clientX,
                                  y: e.clientY,
                                  items: [
                                    { label: "None", onClick: () => setTabColor(t.id, "") },
                                    ...TAB_COLORS.map((c) => ({
                                      label: TAB_COLOR_LABELS[c],
                                      onClick: () => setTabColor(t.id, c),
                                    })),
                                  ],
                                }),
                            },
                            ...(t.filePath ? [{ label: "Copy path", icon: "copy" as const, onClick: () => copyText(t.filePath!, "copied path") }] : []),
                            { sep: true },
                            { label: "Close", icon: "close", onClick: () => closeTab(t.id) },
                            { label: scoped("Close others"), icon: "close", onClick: () => closeTabsScoped(t.connectionId, t.id, "others") },
                            { label: scoped("Close tabs to the right"), icon: "close", onClick: () => closeTabsScoped(t.connectionId, t.id, "right") },
                            { label: scoped("Close saved tabs"), icon: "close", onClick: () => closeTabsScoped(t.connectionId, t.id, "saved") },
                            { sep: true },
                            { label: "Show all tabs…", icon: "search", onClick: () => setAllTabsOpen(true) },
                          ],
                        });
                      }}
                    >
                      <Show when={t.color}><span class="tab-tag" data-color={t.color} title={`Colour: ${TAB_COLOR_LABELS[t.color as Exclude<TabColor, "">]}`} /></Show>
                      <Show when={connections().length > 1 || t.pinned}>
                        <span class="tab-conn" title={labelOf(t.connectionId)}>{driverMascot(kindOf(t.connectionId))}</span>
                      </Show>
                      <Show
                        when={inlineRename()?.id === t.id}
                        fallback={<span class="tab-title">{t.pinned ? shortTabLabel(tabLabel(t)) : tabLabel(t)}</span>}
                      >
                        <input
                          class="tab-rename"
                          aria-label="Tab title"
                          value={inlineRename()!.text}
                          ref={(el) => queueMicrotask(() => { if (el.isConnected) { el.focus(); el.select(); } })}
                          onInput={(e) => setInlineRename({ id: t.id, text: e.currentTarget.value })}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                            else if (e.key === "Escape") { e.preventDefault(); setInlineRename(null); }
                          }}
                        />
                      </Show>
                      <Show when={stateOf(t.connectionId)?.running && stateOf(t.connectionId)?.runningTabId === t.id}><span class="spinner-sm tab-spin" title="Query running" /></Show>
                      <Show when={stateOf(t.connectionId)?.transaction.owner === t.id}><span class="tab-tx" title={`Owns ${stateOf(t.connectionId)?.transaction.id ?? "manual transaction"}`}>TX</span></Show>
                      <Show when={t.dirty}><span class="tab-dot" title="Unsaved changes">●</span></Show>
                      <Show when={!t.pinned}>
                        <button class="tab-close" title="Close (⌘/Ctrl+W)" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>×</button>
                      </Show>
                    </div>
                  )}
                </For>
                <button class="tab-new" title="New tab (⌘/Ctrl+T)" onClick={openNewTab}>＋</button>
                {/* Insertion bar: placed with translateX so it slides between slots
                    (`.dnd-bar`, 120 ms, disabled under prefers-reduced-motion). The
                    slot is pin-clamped so the bar only ever promises a legal drop. */}
                <Show when={tabDropSlot() != null}>
                  <div
                    class="tab-drop dnd-bar"
                    style={{
                      transform: `translateX(${slotOffset(tabEdges(), clampPinSlot(tabs(), tabs().findIndex((x) => x.id === dragTabId()), tabDropSlot()!)) - 1}px)`,
                    }}
                  />
                </Show>
              </div>
              {/* "All tabs": the strip scrolls and hides tabs, this list never does. */}
              <button
                class="tab-overflow"
                title={`Show all tabs (${displayKey(effectiveKey("showAllTabs", keys()))})`}
                aria-label="Show all tabs"
                onClick={() => setAllTabsOpen(true)}
              >⌄</button>
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
                  title="Query plan for the current statement"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu({ x: r.left, y: r.bottom + 4, items: explainMenuItems() });
                  }}
                >
                  Explain ▾
                </button>
                <button class="ghost tb-more" title="More actions" onClick={openToolbarOverflow}>⋯</button>
                <span class="hint">{displayKey(effectiveKey("run", keys())) || "unbound"} runs selection or all</span>
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
                onMoveTab={moveActiveTab}
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
                      <Show when={fetchingMore() || loadingAll()} fallback={<><span class="stream-dot" />Idle</>}>
                        <span class="spinner-sm" />Streaming…
                      </Show>
                    </span>
                    <span class="sb-sep" />
                  </Show>
                  <Show when={editCtx().editable || pendingCount(tabPending()) > 0}>
                    <Show when={pendingCount(tabPending()) > 0}>
                      <span class="sb-pending" title="Uncommitted grid changes">✎ {pendingCount(tabPending())} change{pendingCount(tabPending()) === 1 ? "" : "s"}</span>
                      <button class="ghost export-btn sb-commit" onClick={openCommit} disabled={!editCtx().editable || running()} title={editCtx().editable ? "Preview & run the change script" : editCtx().reason}>{activeOwnsTransaction() ? "Apply…" : "Commit…"}</button>
                      <button class="ghost export-btn" onClick={discardPending}>Discard</button>
                    </Show>
                    <Show when={editCtx().editable}>
                      <button class="ghost export-btn" title="Add a row, committed as INSERT" onClick={onAddRow}>+ Row</button>
                    </Show>
                    <span class="sb-sep" />
                  </Show>
                  <Show when={columns().length > 0}>
                    <label class="checkbox sb-copyhdr" title="Include a header row when copying">
                      <input type="checkbox" checked={prefs().copyHeaders} onChange={(e) => updatePrefs({ copyHeaders: e.currentTarget.checked })} />
                      Copy w/ column names
                    </label>
                  </Show>
                  <Show when={activeTab().result.incomplete}>
                    <span class="result-incomplete" title={`${activeTab().result.incomplete}. Re-run the query for the full result.`}>Incomplete result</span>
                  </Show>
                  <Show when={activeTab().result.transactionStale}>
                    <span class="transaction-result-stale" title={activeTab().result.transactionStale}>Stale transaction result</span>
                  </Show>
                  <Show when={columns().length > 0}>
                    <span class="sb-sep" />
                    <button
                      class="ghost export-btn"
                      classList={{ "filter-active": hasConditions(gridView().filters) }}
                      disabled={!canFilter()}
                      title={canFilter() ? "Build a result filter" : sortUnavailable() || "This result can't be filtered"}
                      onClick={() => openFilterBuilder()}
                    >
                      <Icon name="search" /> Filter
                    </button>
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
              <Show when={!(planMemo() && resultView() === "plan") && columns().length > 0}>
                <FilterBar
                  tree={() => gridView().filters}
                  rowText={() => `${rows().length.toLocaleString()}${done() ? "" : "+"} row${rows().length === 1 && done() ? "" : "s"}`}
                  disabled={() => !canFilter()}
                  onEdit={() => openFilterBuilder()}
                  onRemove={(id) => onSortFilter(gridView().sorts, removeNode(gridView().filters, id), "filter")}
                  onClear={() => onSortFilter(gridView().sorts, emptyFilter(), "filter")}
                />
              </Show>
              <Show when={!(planMemo() && resultView() === "plan") && columns().length > 0} fallback={
                <Show when={!planMemo() && columns().length === 0}><div class="result-empty">{status() || "No results"}</div></Show>
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
                  onOpenFilter={(column) => openFilterBuilder(column)}
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
                  registerSelectionSource={(get) => { gridSelection = get; }}
                  onPaste={onPaste}
                  copyHeaders={() => prefs().copyHeaders}
                  gridStyle={() => ({
                    rowH: gridRowH(prefs().density, prefs().gridDensity),
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
              {/* The run status (row counts included) keeps its own slot: a Slack notice
                  used to occupy it, so `N rows` vanished until the notice was cleared —
                  and it could only be cleared from the small badge further along. */}
              <span title={persistenceWarning() || transactionWarning() || undefined}>{persistenceWarning() || transactionWarning() || status()}</span>
              <Show when={slackNotice()}>
                <button
                  class="status-notice"
                  title="Dismiss this notice"
                  aria-label={`Dismiss Slack notice: ${slackNotice()}`}
                  onClick={() => setSlackNotice("")}
                >
                  <span class="status-notice-text">{slackNotice()}</span>
                  <span class="status-notice-x" aria-hidden="true">✕</span>
                </button>
              </Show>
              <Show when={slackStatus().running || slackStopped()}>
                <span
                  class="slack-badge"
                  classList={{ stopped: !!slackStopped() }}
                  title={slackStopped()
                    ? `Slack: ${slackStopped()}`
                    : slackStatus().error ? `Slack ${slackStatus().state}: ${slackStatus().error}` : `Slack bot ${slackStatus().state}`}
                >
                  {slackStatus().running ? (slackStatus().state === "connected" ? "🟢" : "🟡") : "🔴"} Slack
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
              // Identity, not just id: a reconnect to the same destination is a
              // different session with a different schema snapshot.
              connectionToken={() => (conn() ? `${conn()!.id}#${conn()!.generation}` : "")}
              connectionName={() => (conn() ? labelOf(conn()!.id) : "no connection")}
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
                const c = conn();
                if (!c) return;
                historyStore.clear(c.key);
                for (const entry of connections()) if (entry.conn.key === c.key) entry.patch({ history: [] });
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
              onBeforeMetadata={() => interruptStream("Opening the DDL viewer closed the result stream", g().connectionId)}
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
                // switchTab, not setActiveTabId: the run must land with the tab's OWN
                // connection focused, or executeQuery would resolve the wrong dialect
                // and the wrong runtime for it.
                switchTab(prompt.tabId);
                setParamPrompt(null);
                prompt.onRun(substituted);
              }}
              onClose={() => setParamPrompt(null)}
            />
          )}
        </Show>

        {/* ui/customize: renaming is inline in the strip; this is the "All tabs" list. */}
        <Show when={allTabsOpen()}>
          <TabSwitcher items={tabSwitcherItems()} onPick={switchTab} onClose={() => setAllTabsOpen(false)} />
        </Show>

        <Show when={confirmAnalyze()}>
          <Dialog title="Explain Analyze" size="sm" noAutoFocus onClose={() => setConfirmAnalyze(null)}>
            <div class="confirm-note">
              EXPLAIN ANALYZE <b>executes</b> the statement, and this statement modifies data.
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
          {(open) => (
            <ImportDialog
              dialect={open().dialect}
              supportsSchemas={open().supportsSchemas}
              schemas={open().schemas}
              tables={open().tables}
              defaultSchema={open().defaultSchema}
              initialTarget={open().target}
              onPickFile={async () => {
                return await chooseOpenPath({
                  filters: [{ name: "Data files", extensions: ["csv", "tsv", "txt", "json", "ndjson", "jsonl", "xlsx"] }],
                });
              }}
              onPreview={previewImport}
              onTargetColumns={importTargetColumns}
              onRun={runImport}
              onCancelRun={() => void cancelOperation(importOrigin?.connection.id, importOrigin?.origin.tabId ?? activeTabId())}
              progress={importProgress}
              onClose={closeImport}
            />
          )}
        </Show>

        <Show when={exportTables()}>
          {(src) => (
            <ExportTablesDialog
              title={src().title}
              tables={src().tables}
              supportsSchemas={caps()?.schemas !== false}
              initialSelection={src().selection}
              remembered={rememberedExport()}
              onRememberOptions={rememberExportOptions}
              onPickDirectory={async () => {
                return await chooseOpenPath({ directory: true });
              }}
              onRun={runTablesExport}
              onCancelRun={() => void cancelOperation(src().connectionId, activeTabId())}
              progress={exportTablesProgress}
              onClose={() => setExportTables(null)}
            />
          )}
        </Show>

        <Show when={activeDialog()}>
          <WorkbenchDialogs
            state={activeDialog()}
            onClose={() => setActiveDialog(null)}
            onRun={(sql) => {
              const binding = dialogBinding();
              return binding ? runDDL(sql, binding.origin) : Promise.resolve({ ok: false, error: "Dialog is stale" });
            }}
            onEditAsSql={(sql) => {
              const binding = dialogBinding();
              if (binding) editAsSql(sql, binding.origin);
            }}
            onLoadColumns={loadRefColumns}
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
              selection={src().selectionRows.length ? { columns: src().columns, rows: src().selectionRows } : null}
              remembered={rememberedExport()}
              onRememberOptions={rememberExportOptions}
              onFetchCreateSql={src().ddl
                ? async () => {
                  const d = src().ddl!;
                  if (metadataFrozen()) return "";
                  interruptStream("Reading object DDL closed the result stream", src().connectionId);
                  return await invoke<string>("object_ddl", { connectionId: src().connectionId, kind: d.kind, schema: d.schema, name: d.name });
                }
                : undefined}
              onClose={() => setExportSrc(null)}
              onExportFile={exportToFile}
              onExportClipboard={exportToClipboard}
              onCancel={() => cancelOperation(src().connectionId, src().origin.tabId ?? activeTabId())}
            />
          )}
        </Show>
        <Show when={backupTarget()}>
          {(target) => (
            <BackupDialog
              driverKind={caps()?.kind ?? "postgres"}
              database={tree()?.database ?? ""}
              catalog={backupCatalog()}
              target={target()}
              onClose={closeBackup}
              onPickPath={pickBackupPath}
              onRun={runBackup}
              onCancel={() => void cancelOperation(backupConnection?.id, activeTabId())}
            />
          )}
        </Show>
        <Show when={restoreOpen()}>
          <RestoreDialog
            driverKind={caps()?.kind ?? "postgres"}
            database={tree()?.database ?? ""}
            onClose={closeRestore}
            onPickFile={pickRestoreFile}
            onRun={runRestore}
            onCancel={() => void cancelOperation(restoreConnection?.id, activeTabId())}
          />
        </Show>
        <Show when={commitView()}>
          {(cv) => (
            <Dialog
              title={activeOwnsTransaction() ? "Apply changes" : "Commit changes"}
              size="lg"
              noAutoFocus
              onClose={closeCommit}
              dismissable={!commitBusy()}
              footer={
                <>
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
                </>
              }
            >
              <p class="confirm-text">
                {activeOwnsTransaction()
                  ? `${cv().script.length} statement${cv().script.length === 1 ? "" : "s"} will run inside ${transaction().id}. The outer transaction remains open.`
                  : `${cv().script.length} statement${cv().script.length === 1 ? "" : "s"} will run in one transaction. A failure rolls back all of them.`}
              </p>
            </Dialog>
          )}
        </Show>
        <Show when={confirmDiscard()}>
          {(cd) => (
            <Dialog title="Discard pending changes?" size="sm" noAutoFocus onClose={() => setConfirmDiscard(null)}>
              <p class="confirm-text">
                Discards {cd().count} uncommitted change{cd().count === 1 ? "" : "s"} in the result grid.
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
            <Dialog title="Uncommitted changes" size="sm" noAutoFocus onClose={() => setConfirmClose(null)}>
              <p class="confirm-text">
                “{tabs().find((t) => t.id === cc().tabId)?.title}” has
                {cc().dirty ? " unsaved editor changes" : ""}
                {cc().dirty && cc().pending ? " and" : ""}
                {cc().pending ? ` ${cc().pending} uncommitted grid change${cc().pending === 1 ? "" : "s"}` : ""}.
                {cc().pending ? " Grid changes are discarded when this tab closes." : ""}
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
        <Show when={!!confirmCancelConn() && !!entryOf(confirmCancelConn())?.state().running}>
          <Dialog title="Cancel running query?" size="sm" noAutoFocus onClose={() => setConfirmCancelConn(null)}>
            <p class="confirm-text">
              Cancel the query running on <b>{labelOf(confirmCancelConn()!)}</b>? Loaded rows stay on screen, marked incomplete.
            </p>
            <div class="form-actions">
              <button class="ghost" onClick={() => setConfirmCancelConn(null)}>Keep running</button>
              <button class="btn-danger" onClick={() => { cancelQueryOn(confirmCancelConn()); setConfirmCancelConn(null); }}>Cancel query</button>
            </div>
          </Dialog>
        </Show>
        <Show when={confirmDisconnect()}>
          {(target) => (
            <Dialog title="Disconnect with pending changes?" size="sm" noAutoFocus onClose={() => setConfirmDisconnect(null)}>
              <p class="confirm-text">
                Disconnecting <b>{labelOf(target().connectionId)}</b> discards {target().count} uncommitted grid change{target().count === 1 ? "" : "s"}. Editor buffers stay saved in this workspace.
              </p>
              <div class="form-actions">
                <button class="ghost" onClick={() => setConfirmDisconnect(null)}>Stay connected</button>
                <button class="btn-danger" onClick={() => void disconnectConnection(target().connectionId, true)}>Discard &amp; disconnect</button>
              </div>
            </Dialog>
          )}
        </Show>
        <Show when={confirmWindowClose()}>
          {(count) => (
            <Dialog title="Close with pending changes?" size="sm" noAutoFocus onClose={() => setConfirmWindowClose(null)}>
              <p class="confirm-text">
                Closing Tusk discards {count()} uncommitted grid change{count() === 1 ? "" : "s"}. Editor buffers are saved to workspace recovery.
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
              size="md"
              noAutoFocus
            >
              <p class="confirm-text">
                <Show
                  when={transaction().state !== "lost"}
                  fallback={<>The database session for <b>{transaction().id}</b> was lost. Disconnect, reconnect, and verify the outcome before retrying.</>}
                >
                  <b>{ownerTab()?.title ?? transaction().owner}</b> owns {transaction().id}.
                  {transaction().state === "configured" ? " Clear the pending MySQL transaction configuration before" : " Commit or roll it back before"}
                  {intent().kind === "close-tab" ? " closing its tab" : intent().kind === "disconnect" ? " disconnecting" : " closing Tusk"}.
                </Show>
              </p>
              {/* Scoped to the connection being disconnected: another connection's
                  pending edits are not discarded here, and get their own prompt. */}
              <Show when={transaction().state === "lost" && pendingCountFor(intent().connectionId) > 0}>
                <div class="transaction-resolution-note">
                  Disconnecting will discard {pendingCountFor(intent().connectionId)} pending grid change{pendingCountFor(intent().connectionId) === 1 ? "" : "s"} on this connection.
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

      {/* The connect screen as a modal, so opening another connection never costs you
          the workspace you are already in. */}
      <Show when={connectOpen() && connections().length > 0}>
        <Dialog title="Open another connection" size="xl" onClose={() => setConnectOpen(false)}>
          {connectPanel()}
        </Dialog>
      </Show>

      {/* Update pill renders in both screens (connect + workspace). */}
      <UpdateBadge />
      <WhatsNew requestShow={whatsNewRequest} />

      {/* First contact with an SSH host key. Rendered outside the connect screen's own
          tree so it survives whichever screen raised it, and Trust re-runs the exact
          attempt that failed rather than rebuilding the payload. */}
      <Show when={sshPrompt()}>
        {(p) => (
          <SshHostKeyDialog
            prompt={p().prompt}
            onCancel={() => {
              setSshPrompt(null);
              setConnErr("Connection cancelled. The SSH host key was not trusted.");
            }}
            onTrust={async () => {
              const { prompt, retry } = p();
              try {
                await invoke("ssh_trust_host", {
                  host: prompt.host,
                  port: prompt.port,
                  fingerprint: prompt.fingerprint,
                });
              } catch (e) {
                setSshPrompt(null);
                setConnErr(errMsg(e));
                return;
              }
              setSshPrompt(null);
              setConnErr("");
              setConnecting(true);
              try {
                // A second unknown-host failure would mean the key changed again
                // mid-flight; surface it rather than re-prompting in a loop.
                await retry();
              } catch (e) {
                setConnErr(errMsg(e));
              } finally {
                setConnecting(false);
              }
            }}
          />
        )}
      </Show>

      {/* A picker result Tusk could not prove the user saw. `filePicker` flags a dialog
          that resolved without ever taking focus — the Windows/WebView2 failure where
          `save()` returned a default path in Downloads and no window appeared. Confirm
          the destination rather than writing to it. */}
      <Show when={confirmPickedPath()}>
        {(p) => (
          <Dialog title="Use this file?" size="md" noAutoFocus onClose={() => settlePickedPath(false)}>
            <p class="confirm-text">
              Tusk could not confirm the file picker opened. Check this path before
              continuing:
            </p>
            <p class="confirm-text"><b>{p().path}</b></p>
            <div class="form-actions">
              <button class="ghost" onClick={() => settlePickedPath(false)}>Cancel</button>
              <button class="run" onClick={() => settlePickedPath(true)}>Use this path</button>
            </div>
          </Dialog>
        )}
      </Show>

      {/* Deleting a saved connection is permanent and takes its keychain password with
          it, so it is always confirmed. Shared tail: the profile list appears on the
          connect screen AND inside the "Open another connection" modal. */}
      <Show when={confirmDeleteProfile()}>
        {(p) => (
          <Dialog title="Delete saved connection?" size="sm" noAutoFocus onClose={() => setConfirmDeleteProfile(null)}>
            <p class="confirm-text">
              Delete <b>{p().name || p().dbname || p().host}</b> from your saved connections?
              {p().save_password ? " Its password is removed from the OS keychain too." : ""} This
              can't be undone.
            </p>
            <div class="form-actions">
              <button class="ghost" onClick={() => setConfirmDeleteProfile(null)}>Keep it</button>
              <button class="btn-danger" onClick={() => void deleteProfile(p().id)}>Delete connection</button>
            </div>
          </Dialog>
        )}
      </Show>

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
          onClose={() => { setSettingsOpen(null); void refreshSkills(); void refreshSlackAutostart(); }}
          initialTab={settingsOpen()!}
          connected={!!conn()}
          database={tree()?.database ?? ""}
          connections={slackConnectionOptions}
          activeConnectionId={activeConnectionId}
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
              <div class="run-chooser-hint">↑↓ choose, Enter run, Esc cancel</div>
            </div>
          </>
        )}
      </Show>
      <Show when={cellView()}>
        {(cv) => (
          <Dialog title="Value" subtitle={cv().col} size="md" noAutoFocus onClose={() => setCellView(null)}>
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
