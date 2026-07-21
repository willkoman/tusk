import { createSignal } from "solid-js";
import { DEFAULT_PREFS, type EditorPrefs } from "./editor/types";
import { type KeyOverrides } from "./actions";

// Lightweight, WebView-local persistence (localStorage). Editor prefs are global;
// the editor buffer is keyed per connection so each database keeps its own scratch
// query. No security-sensitive data lives here (passwords stay in the OS keychain,
// server-side). All access is wrapped — localStorage can throw in private modes.

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

// Per-connection editor tab set. Results are ephemeral (not persisted) — only the
// buffer, file binding, and title. Keyed by connKey; activeIndex (not id, which is a
// session counter) survives reloads.
export type PersistedTab = { sql: string; filePath: string | null; title: string; searchSchema: string | null };
export type PersistedTabs = { tabs: PersistedTab[]; activeIndex: number };

export const tabsStore = {
  load(key: string): PersistedTabs | null {
    try {
      const raw = localStorage.getItem(TABS_PREFIX + key);
      if (raw && raw.length > MAX_TABS_STORE_CHARS) return null;
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (isRecord(parsed) && Array.isArray(parsed.tabs) && Number.isInteger(parsed.activeIndex)) {
        const tabs = parsed.tabs.slice(0, 100).flatMap((v): PersistedTab[] => {
          if (!isRecord(v) || typeof v.sql !== "string" || typeof v.title !== "string") return [];
          if (v.sql.length > MAX_TABS_STORE_CHARS) return [];
          const filePath = v.filePath === null || typeof v.filePath === "string" ? v.filePath : null;
          const searchSchema = v.searchSchema === null || typeof v.searchSchema === "string" ? v.searchSchema : null;
          return [{ sql: v.sql, title: v.title.slice(0, 200), filePath, searchSchema }];
        });
        if (tabs.length) return { tabs, activeIndex: Math.max(0, Math.min(parsed.activeIndex as number, tabs.length - 1)) };
      }
    } catch {
      /* ignore */
    }
    return null;
  },
  save(key: string, data: PersistedTabs): boolean {
    try {
      const chars = data.tabs.reduce((n, t) => n + t.sql.length + t.title.length + (t.filePath?.length ?? 0), 0);
      if (chars > MAX_TABS_STORE_CHARS) return false;
      localStorage.setItem(TABS_PREFIX + key, JSON.stringify({ ...data, updatedAt: Date.now() }));
      return true;
    } catch {
      /* ignore */
      return false;
    }
  },
  remove(key: string): void {
    try { localStorage.removeItem(TABS_PREFIX + key); } catch { /* ignore */ }
  },
};
