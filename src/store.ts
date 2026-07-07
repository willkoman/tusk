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
export type LayoutSizes = {
  sidebarW: number;
  aiW: number;
  historyW: number;
  editorH: number;
  sidebarOpen?: boolean;
  resultsOpen?: boolean;
};

export const layoutStore = {
  load(): Partial<LayoutSizes> {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (raw) return JSON.parse(raw) as Partial<LayoutSizes>;
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
      if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
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

// Keyboard-shortcut overrides, keyed by ActionId. Only differences from the
// defaults are stored (null = explicitly unbound), so a future default change
// flows through to users who never touched that binding.
const KEYS_KEY = "tusk.keys";

export const keymapStore = {
  load(): KeyOverrides {
    try {
      const raw = localStorage.getItem(KEYS_KEY);
      if (raw) return JSON.parse(raw) as KeyOverrides;
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
      if (raw) return JSON.parse(raw) as PersistedTabs;
    } catch {
      /* ignore */
    }
    return null;
  },
  save(key: string, data: PersistedTabs): void {
    try {
      localStorage.setItem(TABS_PREFIX + key, JSON.stringify({ ...data, updatedAt: Date.now() }));
    } catch {
      /* ignore */
    }
  },
};
