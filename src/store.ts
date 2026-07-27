import { createSignal } from "solid-js";
import { DEFAULT_PREFS, type EditorPrefs } from "./editor/types";
import { type KeyOverrides } from "./actions";

// Lightweight, WebView-local persistence (localStorage). Passwords and tokens never
// live here, but editor buffers contain query text and possibly literals copied from a
// database. They remain readable to this OS user's WebView profile until the connection
// state is removed. Tab documents are size-capped, and every access handles unavailable
// or quota-limited storage without destroying the previous recoverable snapshot.

const PREFS_KEY = "tusk.prefs";
const TABS_PREFIX = "tusk.tabs.";

// Docked-panel sizes (Explorer/AI/History widths + editor↔results split height)
// plus the Explorer/results collapsed flags. Global, in px; clamped on use by the
// resize handlers AND on load/window-resize, so a stale value is harmless.
const LAYOUT_KEY = "tusk.layout";
const MAX_SMALL_STORE_CHARS = 100_000;
const MAX_TABS_STORE_CHARS = 4_000_000;
export type LayoutSizes = {
  sidebarW: number;
  aiW: number;
  historyW: number;
  editorH: number;
  sidebarOpen?: boolean;
  resultsOpen?: boolean;
};

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const layoutStore = {
  load(): Partial<LayoutSizes> {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (raw && raw.length > MAX_SMALL_STORE_CHARS) return {};
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (isRecord(parsed)) {
        const out: Partial<LayoutSizes> = {};
        for (const k of ["sidebarW", "aiW", "historyW", "editorH"] as const)
          if (finite(parsed[k]) && parsed[k] > 0) out[k] = parsed[k];
        for (const k of ["sidebarOpen", "resultsOpen"] as const)
          if (typeof parsed[k] === "boolean") out[k] = parsed[k];
        return out;
      }
    } catch {
      /* ignore */
    }
    return {};
  },
  save(sizes: LayoutSizes): void {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(sizes));
    } catch {
      /* ignore */
    }
  },
};

export const prefsStore = {
  load(): EditorPrefs {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw && raw.length > MAX_SMALL_STORE_CHARS) return { ...DEFAULT_PREFS };
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (isRecord(parsed)) {
        const out = { ...DEFAULT_PREFS };
        if (finite(parsed.fontSize) && parsed.fontSize >= 8 && parsed.fontSize <= 40) out.fontSize = parsed.fontSize;
        if (finite(parsed.gridColWidth) && parsed.gridColWidth >= 48 && parsed.gridColWidth <= 900) out.gridColWidth = parsed.gridColWidth;
        for (const k of ["wordWrap", "autoFold", "serverLint", "copyHeaders", "gridZebra"] as const)
          if (typeof parsed[k] === "boolean") out[k] = parsed[k];
        if (typeof parsed.fontFamily === "string") out.fontFamily = parsed.fontFamily.slice(0, 200);
        if (typeof parsed.accent === "string" && /^#[0-9a-f]{6}$/i.test(parsed.accent)) out.accent = parsed.accent;
        if (["postgres", "mysql", "sqlite", "mssql"].includes(String(parsed.dialect))) out.dialect = parsed.dialect as EditorPrefs["dialect"];
        if (["system", "oneDark", "catppuccinMocha", "dracula", "tokyoNight", "light", "solarizedLight", "githubLight", "gruvboxLight"].includes(String(parsed.theme))) out.theme = parsed.theme as EditorPrefs["theme"];
        if (["compact", "normal"].includes(String(parsed.gridDensity))) out.gridDensity = parsed.gridDensity as EditorPrefs["gridDensity"];
        if (["null", "empty", "dash"].includes(String(parsed.gridNullStyle))) out.gridNullStyle = parsed.gridNullStyle as EditorPrefs["gridNullStyle"];
        if (["vertical", "horizontal"].includes(String(parsed.planOrientation))) out.planOrientation = parsed.planOrientation as EditorPrefs["planOrientation"];
        if (["cost", "time", "rows", "off"].includes(String(parsed.planHeat))) out.planHeat = parsed.planHeat as EditorPrefs["planHeat"];
        if (["compact", "normal"].includes(String(parsed.planDensity))) out.planDensity = parsed.planDensity as EditorPrefs["planDensity"];
        return out;
      }
    } catch {
      /* ignore */
    }
    return { ...DEFAULT_PREFS };
  },
  save(prefs: EditorPrefs): void {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
  },
};

// Crash-report consent. "unset" = never asked (first launch prompts once);
// "on" = after a crash, offer the report/email screen; "off" = recover quietly —
// prior-run reports are cleared unshown and the email action is hidden. Nothing
// is ever transmitted automatically in either mode. Reactive (a module-level
// signal) so the Settings toggle and the root CrashGuard stay in sync.
export type CrashConsent = "unset" | "on" | "off";
const CRASH_CONSENT_KEY = "tusk.crashConsent";

function loadCrashConsent(): CrashConsent {
  try {
    const raw = localStorage.getItem(CRASH_CONSENT_KEY);
    if (raw === "on" || raw === "off") return raw;
  } catch {
    /* ignore */
  }
  return "unset";
}

const [crashConsentSig, setCrashConsentSig] = createSignal<CrashConsent>(loadCrashConsent());

/** Reactive accessor for the crash-report consent state. */
export const crashConsent = crashConsentSig;

export function setCrashConsent(v: "on" | "off"): void {
  setCrashConsentSig(v);
  try {
    localStorage.setItem(CRASH_CONSENT_KEY, v);
  } catch {
    /* ignore */
  }
}

// Keyboard-shortcut overrides, keyed by ActionId. Only differences from the
// defaults are stored (null = explicitly unbound), so a future default change
// flows through to users who never touched that binding.
const KEYS_KEY = "tusk.keys";

export const keymapStore = {
  load(): KeyOverrides {
    try {
      const raw = localStorage.getItem(KEYS_KEY);
      if (raw && raw.length > MAX_SMALL_STORE_CHARS) return {};
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (isRecord(parsed)) {
        const out: KeyOverrides = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (v === null || (typeof v === "string" && v.length <= 100)) (out as Record<string, string | null>)[k] = v;
        }
        return out;
      }
    } catch {
      /* ignore */
    }
    return {};
  },
  save(overrides: KeyOverrides): void {
    try {
      localStorage.setItem(KEYS_KEY, JSON.stringify(overrides));
    } catch {
      /* ignore */
    }
  },
};

// Per-connection editor tab set. Results are ephemeral (not persisted) — only editor
// recovery state. Keyed by connKey; activeIndex (not id, which is a session counter)
// survives reloads. `dirty` is optional for source compatibility with callers and old
// documents; normalized loads always return an explicit value.
export type PersistedTab = {
  sql: string;
  filePath: string | null;
  title: string;
  searchSchema: string | null;
  dirty?: boolean;
};
export type PersistedTabs = { tabs: PersistedTab[]; activeIndex: number };
export type RestoredPersistedTab = Omit<PersistedTab, "dirty"> & { dirty: boolean };
export type RestoredPersistedTabs = { tabs: RestoredPersistedTab[]; activeIndex: number };

export type TabsPersistenceFailure = {
  operation: "load" | "save" | "remove";
  code: "invalid-key" | "invalid-data" | "too-large" | "unavailable" | "verification-failed";
  message: string;
};
export type TabsPersistenceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: TabsPersistenceFailure };

const MAX_TABS = 100;
const MAX_PATH_CHARS = 32_768;
const MAX_SCHEMA_CHARS = 1_000;
const MAX_CONNECTION_KEY_CHARS = 1_024;
let lastTabsFailure: TabsPersistenceFailure | null = null;

function failure(
  operation: TabsPersistenceFailure["operation"],
  code: TabsPersistenceFailure["code"],
  cause?: unknown,
): TabsPersistenceFailure {
  let detail = "";
  if (cause instanceof Error) detail = cause.message || cause.name;
  else if (typeof cause === "string") detail = cause;
  const label = code.replace(/-/g, " ");
  return { operation, code, message: detail ? `${label}: ${detail.slice(0, 300)}` : label };
}

function storageKey(key: string, operation: TabsPersistenceFailure["operation"]): TabsPersistenceResult<string> {
  if (!key || key.length > MAX_CONNECTION_KEY_CHARS) {
    return { ok: false, error: failure(operation, "invalid-key") };
  }
  return { ok: true, value: TABS_PREFIX + key };
}

function normalizeTabs(value: unknown): RestoredPersistedTabs | null {
  if (!isRecord(value) || !Array.isArray(value.tabs) || !Number.isInteger(value.activeIndex)) return null;
  const tabs = value.tabs.flatMap((v): RestoredPersistedTab[] => {
    if (!isRecord(v) || typeof v.sql !== "string" || typeof v.title !== "string") return [];
    if (v.sql.length > MAX_TABS_STORE_CHARS) return [];
    const filePath = v.filePath === null || typeof v.filePath === "string" && v.filePath.length <= MAX_PATH_CHARS
      ? v.filePath
      : null;
    const searchSchema = v.searchSchema === null || typeof v.searchSchema === "string" && v.searchSchema.length <= MAX_SCHEMA_CHARS
      ? v.searchSchema
      : null;
    const dirty = typeof v.dirty === "boolean" ? v.dirty : false;
    return [{ sql: v.sql, title: v.title.slice(0, 200), filePath, searchSchema, dirty }];
  });
  if (!tabs.length) return null;
  return {
    tabs,
    activeIndex: Math.max(0, Math.min(value.activeIndex as number, tabs.length - 1)),
  };
}

/** Exact-enough JSON string size without materializing a potentially huge document. */
function jsonStringChars(value: string): number {
  let chars = 2; // surrounding quotes
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) chars += 2;
    else if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff && !(code <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff))) chars += 6;
    else {
      chars++;
      if (code >= 0xd800 && code <= 0xdbff) { chars++; i++; }
    }
    if (chars > MAX_TABS_STORE_CHARS) return chars;
  }
  return chars;
}

function loadTabs(key: string): TabsPersistenceResult<RestoredPersistedTabs | null> {
  const fullKey = storageKey(key, "load");
  if (!fullKey.ok) return fullKey;
  try {
    const raw = localStorage.getItem(fullKey.value);
    if (raw === null) return { ok: true, value: null };
    if (raw.length > MAX_TABS_STORE_CHARS) {
      return { ok: false, error: failure("load", "too-large") };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      return { ok: false, error: failure("load", "invalid-data", cause) };
    }
    if (isRecord(parsed) && Array.isArray(parsed.tabs) && parsed.tabs.length > MAX_TABS)
      return { ok: false, error: failure("load", "too-large") };
    const normalized = normalizeTabs(parsed);
    return normalized
      ? { ok: true, value: normalized }
      : { ok: false, error: failure("load", "invalid-data") };
  } catch (cause) {
    return { ok: false, error: failure("load", "unavailable", cause) };
  }
}

function saveTabs(key: string, data: PersistedTabs): TabsPersistenceResult<void> {
  const fullKey = storageKey(key, "save");
  if (!fullKey.ok) return fullKey;
  if (Array.isArray(data.tabs) && data.tabs.length > MAX_TABS)
    return { ok: false, error: failure("save", "too-large") };
  if (Array.isArray(data.tabs)) {
    // Preflight aggregate *serialized* size before JSON.stringify. A hundred
    // individually valid multi-megabyte tabs otherwise allocate hundreds of MiB.
    let chars = 128;
    for (const tab of data.tabs) {
      if (!tab || typeof tab.sql !== "string" || typeof tab.title !== "string") continue;
      chars += jsonStringChars(tab.sql) + jsonStringChars(tab.title) + 96;
      if (typeof tab.filePath === "string") chars += jsonStringChars(tab.filePath);
      if (typeof tab.searchSchema === "string") chars += jsonStringChars(tab.searchSchema);
      if (chars > MAX_TABS_STORE_CHARS) return { ok: false, error: failure("save", "too-large") };
    }
  }
  const normalized = normalizeTabs(data);
  if (!normalized) return { ok: false, error: failure("save", "invalid-data") };
  let raw: string;
  try {
    raw = JSON.stringify({ ...normalized, updatedAt: Date.now() });
  } catch (cause) {
    return { ok: false, error: failure("save", "invalid-data", cause) };
  }
  if (raw.length > MAX_TABS_STORE_CHARS) {
    return { ok: false, error: failure("save", "too-large") };
  }
  try {
    localStorage.setItem(fullKey.value, raw);
    if (localStorage.getItem(fullKey.value) !== raw) {
      return { ok: false, error: failure("save", "verification-failed") };
    }
    return { ok: true, value: undefined };
  } catch (cause) {
    return { ok: false, error: failure("save", "unavailable", cause) };
  }
}

function remember<T>(result: TabsPersistenceResult<T>): TabsPersistenceResult<T> {
  lastTabsFailure = result.ok ? null : result.error;
  return result;
}

export const tabsStore = {
  loadResult(key: string): TabsPersistenceResult<RestoredPersistedTabs | null> {
    return remember(loadTabs(key));
  },
  load(key: string): RestoredPersistedTabs | null {
    const result = remember(loadTabs(key));
    return result.ok ? result.value : null;
  },
  saveResult(key: string, data: PersistedTabs): TabsPersistenceResult<void> {
    return remember(saveTabs(key, data));
  },
  save(key: string, data: PersistedTabs): boolean {
    return remember(saveTabs(key, data)).ok;
  },
  /** Synchronous, verified write suitable for `beforeunload`/window-close handling. */
  saveForClose(key: string, data: PersistedTabs): TabsPersistenceResult<void> {
    return remember(saveTabs(key, data));
  },
  /** Move an unreadable snapshot aside (`<key>.corrupt`) so a fresh one can be
   * written without destroying data that might still be hand-salvageable. If the
   * backup copy itself fails (storage quota/unavailable), the original stays put
   * and an error returns — the caller should then keep recovery writes disabled. */
  quarantineResult(key: string): TabsPersistenceResult<boolean> {
    const fullKey = storageKey(key, "remove");
    if (!fullKey.ok) return remember(fullKey);
    try {
      const raw = localStorage.getItem(fullKey.value);
      if (raw === null) return { ok: true, value: false };
      try {
        localStorage.setItem(`${fullKey.value}.corrupt`, raw);
      } catch (cause) {
        return remember({ ok: false, error: failure("remove", "unavailable", cause) });
      }
      localStorage.removeItem(fullKey.value);
      return { ok: true, value: true };
    } catch (cause) {
      return remember({ ok: false, error: failure("remove", "unavailable", cause) });
    }
  },
  removeResult(key: string): TabsPersistenceResult<void> {
    const fullKey = storageKey(key, "remove");
    if (!fullKey.ok) return remember(fullKey);
    try {
      localStorage.removeItem(fullKey.value);
      return remember({ ok: true, value: undefined });
    } catch (cause) {
      return remember({ ok: false, error: failure("remove", "unavailable", cause) });
    }
  },
  remove(key: string): void {
    const fullKey = storageKey(key, "remove");
    if (!fullKey.ok) {
      remember(fullKey);
      return;
    }
    try {
      localStorage.removeItem(fullKey.value);
      remember({ ok: true, value: undefined });
    } catch (cause) {
      remember({ ok: false, error: failure("remove", "unavailable", cause) });
    }
  },
  lastFailure(): TabsPersistenceFailure | null {
    return lastTabsFailure;
  },
};
