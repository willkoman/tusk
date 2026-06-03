import { DEFAULT_PREFS, type EditorPrefs } from "./editor/types";

// Lightweight, WebView-local persistence (localStorage). Editor prefs are global;
// the editor buffer is keyed per connection so each database keeps its own scratch
// query. No security-sensitive data lives here (passwords stay in the OS keychain,
// server-side). All access is wrapped — localStorage can throw in private modes.

const PREFS_KEY = "tusk.prefs";
const TABS_PREFIX = "tusk.tabs.";

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
