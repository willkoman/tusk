import { onMount, onCleanup, createEffect } from "solid-js";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  placeholder,
} from "@codemirror/view";
import { Compartment, EditorState, Transaction, type Extension } from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment,
} from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import {
  autocompletion,
  completionKeymap,
  acceptCompletion,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { bracketMatching } from "@codemirror/language";
import { getDialect, type DialectId } from "./sql/dialects";
import { makeSqlCompletion } from "./sql/completion";
import { type Table } from "./sql/aliases";
import { DEFAULT_PREFS, type CursorInfo, type EditorPrefs, type ValidateFn } from "./editor/types";
import { lexState, statementAt } from "./editor/lexer";
import { effectiveKey, type ActionId, type KeyOverrides } from "./actions";
import { keywordCase, keywordSet } from "./editor/keywordCase";
import { themeFor } from "./editor/theme";
import { foldBasics, foldKeymap } from "./editor/foldBasics";
import { autoFold } from "./editor/autofold";
import { applyLintFix, clientLint, serverLint, lintUi } from "./editor/lint";
import { multiSelect } from "./editor/multiselect";
import { searchExtensions, searchKeymap, openSearchPanel } from "./editor/search";
import { statementGutter, activeStatement, cursorReadout, setRunningEffect } from "./editor/statements";
import { formatDoc } from "./editor/format";

export type { Table };

const EMPTY_FUNCS: ReadonlySet<string> = new Set();

/** Imperative handle exposed to the parent. */
export type EditorApi = {
  getRunText: () => string;
  /** The statement under the cursor (whole doc if it can't be isolated). */
  getCurrentStatement: () => string;
  /** How many statements the buffer holds (drives the run whole-file vs block chooser). */
  getStatementCount: () => number;
  /** Insert text at the cursor (does not clobber the buffer) and focus the editor. */
  insertAtCursor: (text: string) => void;
  focus: () => void;
  /** Current selection text ("" when nothing is selected). */
  getSelection: () => string;
  /** Replace the current selection (or insert at cursor) with text. */
  replaceSelection: (text: string) => void;
  selectAll: () => void;
  toggleComment: () => void;
  /** Pretty-print the selection (if any) or the whole buffer. */
  format: (selectionOnly?: boolean) => void;
  /** Open the find & replace panel. */
  openSearch: () => void;
  /** The full document text (folding is display-only, so this is the real query). */
  getDoc: () => string;
  /** Discard the cached per-tab editor state when a tab is closed. */
  dropTab: (id: string) => void;
};

export function SqlEditor(props: {
  value: string;
  /** The text and the id of the tab it belongs to (the active view's tab). */
  onChange: (v: string, tabId: string) => void;
  onRun: () => void;
  onRunStatement?: (text: string) => void;
  /** True while a query launched from THIS tab is in flight (drives the gutter spinner). */
  running?: boolean;
  /** Active editor tab — each tab keeps its own undo/cursor/fold state. */
  tabId: string;
  tables: Table[];
  /** Lowercase live function catalog (empty set = unknown-function lint off). */
  functions?: ReadonlySet<string>;
  /** Active schema (search_path) — tables in it are offered unqualified. */
  activeSchema?: string | null;
  dialect?: DialectId;
  prefs?: EditorPrefs;
  /** Server-side validation transport; null when disconnected / disabled. */
  validate?: ValidateFn | null;
  /** Shortcut overrides — editor-scope actions rebind live via a Compartment. */
  keys?: KeyOverrides;
  onCursorInfo?: (info: CursorInfo) => void;
  onReady?: (api: EditorApi) => void;
  onContextMenu?: (e: MouseEvent) => void;
}) {
  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  // Guards the external-value sync so a programmatic restore/file-open doesn't echo
  // back through onChange or land in the undo history.
  let applyingExternal = false;

  const curPrefs = (): EditorPrefs => props.prefs ?? DEFAULT_PREFS;
  const curDialect = (): DialectId => props.dialect ?? curPrefs().dialect;

  // --- compartments: reconfigured live, never rebuilding the editor ---
  const dialectComp = new Compartment();
  const themeComp = new Compartment();
  const foldComp = new Compartment();
  const keymapComp = new Compartment();

  const dialectExtensions = (): Extension => {
    const spec = getDialect(curDialect());
    return [
      sql({ dialect: spec.cm, upperCaseKeywords: true }),
      autocompletion({
        override: [makeSqlCompletion(() => props.tables, spec, () => props.activeSchema ?? null)],
        icons: true,
        defaultKeymap: false,
      }),
      keywordCase(keywordSet(spec)),
    ];
  };

  const getRunText = () => {
    if (!view) return props.value;
    const sel = view.state.selection.main;
    return sel.empty ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to);
  };
  const getCurrentStatement = () => {
    if (!view) return props.value;
    const { stmts } = lexState(view.state);
    const at = statementAt(stmts, view.state.selection.main.head);
    return at ? at.stmt.text : view.state.doc.toString();
  };
  const getStatementCount = () => (view ? lexState(view.state).stmts.length : 0);
  const insertAtCursor = (text: string) => {
    if (!view) return;
    const pos = view.state.selection.main.head;
    view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
    view.focus();
  };
  const focus = () => view?.focus();
  const getSelection = () => {
    if (!view) return "";
    const sel = view.state.selection.main;
    return view.state.sliceDoc(sel.from, sel.to);
  };
  const replaceSelection = (text: string) => {
    if (!view) return;
    view.dispatch(view.state.replaceSelection(text));
    view.focus();
  };
  const selectAll = () => {
    if (!view) return;
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    view.focus();
  };
  const toggle = () => {
    if (view) toggleComment(view);
  };
  const runCurrentStatement = () => {
    const s = getCurrentStatement();
    if (s.trim()) props.onRunStatement?.(s);
  };

  // Editor-scope rebindable bindings, built from the shortcut overrides. Key
  // strings are CodeMirror syntax already ("Mod-Shift-Enter", "F5").
  const userKeymap = (): Extension => {
    const o = props.keys ?? {};
    const bindings: { key: string; preventDefault: boolean; run: () => boolean }[] = [];
    const add = (id: ActionId, fn: () => void) => {
      const k = effectiveKey(id, o);
      if (k) bindings.push({ key: k, preventDefault: true, run: () => (fn(), true) });
    };
    add("run", () => props.onRun());
    add("runStatement", () => runCurrentStatement());
    add("format", () => view && formatDoc(view, true, curDialect()));
    add("find", () => view && openSearchPanel(view));
    add("toggleComment", () => view && toggleComment(view));
    return keymap.of(bindings);
  };

  // Per-tab EditorState, so undo history / cursor / fold survive tab switches.
  const stateMap = new Map<string, EditorState>();
  let curTabId: string | undefined;

  // The full extension list. `view.setState()` replaces ALL state incl. compartment
  // configs, so every per-tab state must be built here (seeded with the current
  // dialect/theme/fold) — never hand-assemble a partial state.
  const buildExtensions = (): Extension[] => {
    const p = curPrefs();
    return [
      lineNumbers(),
      foldBasics(),
      ...(props.onRunStatement ? [statementGutter((t) => props.onRunStatement!(t))] : []),
      lintUi(),
      history(),
      multiSelect(),
      highlightActiveLine(),
      bracketMatching(),
      closeBrackets(),
      foldComp.of(p.autoFold ? autoFold() : []),
      activeStatement(),
      clientLint(() => props.tables, () => props.functions ?? EMPTY_FUNCS),
      serverLint(() => props.validate ?? null),
      dialectComp.of(dialectExtensions()),
      searchExtensions(),
      themeComp.of(themeFor(p)),
      placeholder("Write SQL — ⌘/Ctrl+Enter to run (selection or all)"),
      ...(props.onCursorInfo ? [cursorReadout((i) => props.onCursorInfo!(i))] : []),
      // Rebindable editor-scope actions live in their own compartment so a
      // shortcut change reconfigures live; they sit above the static keymap so
      // they win on overlap.
      keymapComp.of(userKeymap()),
      keymap.of([
        // Tab priority: accept completion (popup open) → apply the lint
        // quick-fix under the cursor → indent. Alt+Enter / Mod-. always fix.
        { key: "Tab", run: acceptCompletion },
        { key: "Tab", run: applyLintFix },
        { key: "Alt-Enter", run: applyLintFix },
        { key: "Mod-.", run: applyLintFix },
        indentWithTab,
        ...closeBracketsKeymap,
        ...searchKeymap,
        ...foldKeymap,
        // Enter accepts a completion just like Tab. `acceptCompletion` is a no-op
        // when no popup is open, so Enter still inserts a newline normally (the
        // completionKeymap binding sits before defaultKeymap's Enter and falls
        // through on false). The old dollar-quote corruption is gone now that `$`
        // is excluded from completion tokens, so `$tag$` delimiters are never
        // offered or replaced on accept.
        ...completionKeymap,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !applyingExternal) props.onChange(u.state.doc.toString(), props.tabId);
      }),
    ];
  };
  const makeState = (doc: string) => EditorState.create({ doc, extensions: buildExtensions() });

  onMount(() => {
    view = new EditorView({ state: makeState(props.value), parent: host! });
    curTabId = props.tabId;
    stateMap.set(props.tabId, view.state);
    props.onReady?.({
      getRunText,
      getCurrentStatement,
      getStatementCount,
      insertAtCursor,
      focus,
      getSelection,
      replaceSelection,
      selectAll,
      toggleComment: toggle,
      format: (selectionOnly = true) => view && formatDoc(view, selectionOnly, curDialect()),
      openSearch: () => view && openSearchPanel(view),
      getDoc: () => view?.state.doc.toString() ?? props.value,
      dropTab: (id: string) => stateMap.delete(id),
    });
  });

  onCleanup(() => view?.destroy());

  // Swap the editor to the active tab's state (preserving the outgoing tab's).
  createEffect(() => {
    const id = props.tabId;
    if (!view || curTabId === id) return;
    if (curTabId !== undefined) stateMap.set(curTabId, view.state);
    const next = stateMap.get(id) ?? makeState(props.value);
    applyingExternal = true; // setState must not echo onChange
    view.setState(next);
    applyingExternal = false;
    curTabId = id;
    // A cached state carries the compartment values it was built with — re-apply
    // the current ones so a theme/font/dialect change made while another tab was
    // active doesn't come back stale.
    const p = curPrefs();
    view.dispatch({
      effects: [
        themeComp.reconfigure(themeFor(p)),
        foldComp.reconfigure(p.autoFold ? autoFold() : []),
        dialectComp.reconfigure(dialectExtensions()),
        keymapComp.reconfigure(userKeymap()),
      ],
    });
    view.focus();
  });

  // Reflect the App's running state into the gutter (spinner on the running statement).
  // Tracks props.tabId too: view.setState() on a tab switch resets the field, so the
  // flag must be re-applied for the now-active tab.
  createEffect(() => {
    const r = !!props.running;
    void props.tabId;
    if (view) view.dispatch({ effects: setRunningEffect.of(r) });
  });

  // Live shortcut rebinds — reconfigure the user keymap compartment.
  createEffect(() => {
    const _k = props.keys;
    void _k;
    if (view) view.dispatch({ effects: keymapComp.reconfigure(userKeymap()) });
  });

  // Live dialect switch — reconfigure highlighter + completion + keyword-case.
  createEffect(() => {
    const _d = curDialect();
    void _d;
    if (view) view.dispatch({ effects: dialectComp.reconfigure(dialectExtensions()) });
  });

  // Live prefs — theme (font/wrap) and auto-fold toggle, no rebuild.
  createEffect(() => {
    const p = curPrefs();
    if (view)
      view.dispatch({
        effects: [themeComp.reconfigure(themeFor(p)), foldComp.reconfigure(p.autoFold ? autoFold() : [])],
      });
  });

  // Sync external value changes (clicking a table, opening a file, restoring a buffer).
  // Skip during a tab switch (props.tabId !== curTabId) — the swap effect owns that,
  // and applying here could clobber the outgoing tab's state before it's saved.
  createEffect(() => {
    const v = props.value;
    if (view && props.tabId === curTabId && v !== view.state.doc.toString()) {
      applyingExternal = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: v },
        annotations: Transaction.addToHistory.of(false),
      });
      applyingExternal = false;
    }
  });

  return <div class="cm-host" ref={host} onContextMenu={(e) => props.onContextMenu?.(e)} />;
}
