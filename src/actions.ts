// Single registry of user-invocable actions — shared by the global key handler,
// the editor keymap, the Settings → Shortcuts pane, and the command palette, so
// a rebind shows up everywhere at once. Key strings use CodeMirror syntax
// ("Mod-Shift-Enter"); Mod = Cmd on macOS, Ctrl elsewhere.

export type ActionId =
  | "run"
  | "runStatement"
  | "explain"
  | "explainAnalyze"
  | "cancelQuery"
  | "format"
  | "find"
  | "toggleComment"
  | "newTab"
  | "closeTab"
  | "saveFile"
  | "saveFileAs"
  | "openFile"
  | "openSettings"
  | "openShortcuts"
  | "openHelp"
  | "openHistory"
  | "openPalette"
  | "toggleAi"
  | "toggleWrap"
  | "toggleSidebar"
  | "toggleResults"
  | "loadAllRows"
  | "exportResult";

/** What an `enabled` predicate can see (kept tiny on purpose). */
export type ActionCtx = {
  connected: boolean;
  running: boolean;
  hasResult: boolean;
  canExport: boolean;
  /** The engine has an EXPLAIN ANALYZE variant (caps.explainAnalyze). */
  canExplainAnalyze: boolean;
};

export type ActionDef = {
  id: ActionId;
  title: string;
  category: "Query" | "File" | "Tabs" | "Editor" | "View";
  /** Default binding (CodeMirror syntax) or null = unbound by default. */
  defaultKey: string | null;
  /**
   * "editor" actions are ALSO bound inside CodeMirror (they should win while the
   * editor has focus); the global handler still dispatches them when focus is
   * elsewhere (it skips events the editor already handled via defaultPrevented).
   */
  scope: "global" | "editor";
  enabled?: (ctx: ActionCtx) => boolean;
};

export const ACTIONS: readonly ActionDef[] = [
  { id: "run", title: "Run (selection or all)", category: "Query", defaultKey: "Mod-Enter", scope: "editor", enabled: (c) => c.connected },
  { id: "runStatement", title: "Run current statement", category: "Query", defaultKey: "Mod-Shift-Enter", scope: "editor", enabled: (c) => c.connected },
  { id: "explain", title: "Explain (plan)", category: "Query", defaultKey: null, scope: "global", enabled: (c) => c.connected && !c.running },
  { id: "explainAnalyze", title: "Explain Analyze (runs the statement)", category: "Query", defaultKey: null, scope: "global", enabled: (c) => c.connected && !c.running && c.canExplainAnalyze },
  { id: "cancelQuery", title: "Cancel running query", category: "Query", defaultKey: null, scope: "global", enabled: (c) => c.running },
  { id: "loadAllRows", title: "Load all rows", category: "Query", defaultKey: null, scope: "global", enabled: (c) => c.hasResult },
  { id: "exportResult", title: "Export result…", category: "Query", defaultKey: null, scope: "global", enabled: (c) => c.hasResult && c.canExport },
  { id: "format", title: "Format SQL", category: "Editor", defaultKey: "Shift-Alt-f", scope: "editor" },
  { id: "find", title: "Find & replace", category: "Editor", defaultKey: null, scope: "editor" },
  { id: "toggleComment", title: "Toggle comment", category: "Editor", defaultKey: "Mod-/", scope: "editor" },
  { id: "toggleWrap", title: "Toggle word wrap", category: "Editor", defaultKey: null, scope: "global" },
  { id: "toggleSidebar", title: "Toggle explorer sidebar", category: "View", defaultKey: "Mod-b", scope: "global", enabled: (c) => c.connected },
  { id: "toggleResults", title: "Toggle results panel", category: "View", defaultKey: "Mod-j", scope: "global", enabled: (c) => c.connected },
  { id: "newTab", title: "New tab", category: "Tabs", defaultKey: "Mod-t", scope: "global", enabled: (c) => c.connected },
  { id: "closeTab", title: "Close tab", category: "Tabs", defaultKey: "Mod-w", scope: "global", enabled: (c) => c.connected },
  { id: "openFile", title: "Open file…", category: "File", defaultKey: "Mod-o", scope: "global", enabled: (c) => c.connected },
  { id: "saveFile", title: "Save", category: "File", defaultKey: "Mod-s", scope: "global", enabled: (c) => c.connected },
  { id: "saveFileAs", title: "Save as…", category: "File", defaultKey: "Mod-Shift-s", scope: "global", enabled: (c) => c.connected },
  { id: "openSettings", title: "Open settings", category: "View", defaultKey: "Mod-,", scope: "global" },
  { id: "openShortcuts", title: "Show keyboard shortcuts", category: "View", defaultKey: null, scope: "global" },
  { id: "openHelp", title: "Open manual", category: "View", defaultKey: "F1", scope: "global" },
  { id: "openHistory", title: "Toggle query history", category: "View", defaultKey: "Mod-Shift-h", scope: "global", enabled: (c) => c.connected },
  { id: "openPalette", title: "Command palette", category: "View", defaultKey: "Mod-k", scope: "global" },
  { id: "toggleAi", title: "Toggle AI assistant", category: "View", defaultKey: null, scope: "global", enabled: (c) => c.connected },
];

/** Saved overrides: absent = default binding, null = explicitly unbound. */
export type KeyOverrides = Partial<Record<ActionId, string | null>>;

const isMac = /mac/i.test(navigator.platform);

/** Canonical form: Mod-Alt-Shift-<Key> (dedupes modifier order for map lookups). */
export function canonicalKey(key: string): string {
  const parts = key.split("-");
  const k = parts.pop() ?? "";
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  // Treat Cmd/Ctrl/Meta spellings as Mod.
  const hasMod = mods.has("mod") || mods.has("cmd") || mods.has("meta") || mods.has("ctrl");
  return (
    (hasMod ? "Mod-" : "") +
    (mods.has("alt") ? "Alt-" : "") +
    (mods.has("shift") ? "Shift-" : "") +
    (k.length === 1 ? k.toLowerCase() : k)
  );
}

export function effectiveKey(id: ActionId, overrides: KeyOverrides): string | null {
  if (id in overrides) return overrides[id] ?? null;
  return ACTIONS.find((a) => a.id === id)?.defaultKey ?? null;
}

/**
 * Canonical key string for a keydown, or null when it's not a bindable chord
 * (bare modifier, or an unmodified printable key — those must stay typeable).
 */
export function normalizeKeyEvent(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k === "Control" || k === "Meta" || k === "Alt" || k === "Shift") return null;
  const mod = e.metaKey || e.ctrlKey;
  // Unmodified printable keys (letters, digits, punctuation) can't be bindings.
  if (!mod && !e.altKey && k.length === 1) return null;
  const name = k.length === 1 ? k.toLowerCase() : k === " " ? "Space" : k;
  return (mod ? "Mod-" : "") + (e.altKey ? "Alt-" : "") + (e.shiftKey ? "Shift-" : "") + name;
}

/** Which action already owns `key` (one flat namespace across both scopes). */
export function findConflict(key: string, exceptId: ActionId | null, overrides: KeyOverrides): ActionId | null {
  const want = canonicalKey(key);
  for (const a of ACTIONS) {
    if (a.id === exceptId) continue;
    const k = effectiveKey(a.id, overrides);
    if (k && canonicalKey(k) === want) return a.id;
  }
  return null;
}

/** Human-readable chord for chips/palette (⌘⇧K on mac, Ctrl+Shift+K elsewhere). */
export function displayKey(key: string | null): string {
  if (!key) return "";
  const parts = canonicalKey(key).split("-");
  const k = parts.pop() ?? "";
  const label = k.length === 1 ? k.toUpperCase() : k;
  if (isMac) {
    return (parts.includes("Mod") ? "⌘" : "") + (parts.includes("Alt") ? "⌥" : "") + (parts.includes("Shift") ? "⇧" : "") + label;
  }
  return [parts.includes("Mod") ? "Ctrl" : "", parts.includes("Alt") ? "Alt" : "", parts.includes("Shift") ? "Shift" : "", label]
    .filter(Boolean)
    .join("+");
}
