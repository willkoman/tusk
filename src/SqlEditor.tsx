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
import { keywordCase, keywordSet } from "./editor/keywordCase";
import { themeFor } from "./editor/theme";
import { foldBasics, foldKeymap } from "./editor/foldBasics";
import { autoFold } from "./editor/autofold";
import { clientLint, serverLint, lintUi } from "./editor/lint";
import { multiSelect } from "./editor/multiselect";
import { searchExtensions, searchKeymap, openSearchPanel } from "./editor/search";
import { statementGutter, activeStatement, cursorReadout } from "./editor/statements";
import { formatDoc } from "./editor/format";

export type { Table };

/** Imperative handle exposed to the parent. */
export type EditorApi = {
  getRunText: () => string;
  /** The statement under the cursor (whole doc if it can't be isolated). */
  getCurrentStatement: () => string;
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
  /** Active editor tab — each tab keeps its own undo/cursor/fold state. */
  tabId: string;
  tables: Table[];
  /** Active schema (search_path) — tables in it are offered unqualified. */
  activeSchema?: string | null;
  dialect?: DialectId;
  prefs?: EditorPrefs;
  /** Server-side validation transport; null when disconnected / disabled. */
  validate?: ValidateFn | null;
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
      clientLint(() => props.tables),
      serverLint(() => props.validate ?? null),
      dialectComp.of(dialectExtensions()),
      searchExtensions(),
      themeComp.of(themeFor(p)),
      placeholder("Write SQL — ⌘/Ctrl+Enter to run (selection or all)"),
      ...(props.onCursorInfo ? [cursorReadout((i) => props.onCursorInfo!(i))] : []),
      keymap.of([
        { key: "Mod-Enter", preventDefault: true, run: () => (props.onRun(), true) },
        { key: "Mod-Shift-Enter", preventDefault: true, run: () => (runCurrentStatement(), true) },
        { key: "Shift-Alt-f", preventDefault: true, run: () => (view && formatDoc(view, true, curDialect()), true) },
        { key: "Tab", run: acceptCompletion },
        indentWithTab,
        ...closeBracketsKeymap,
        ...searchKeymap,
        ...foldKeymap,
        // Enter must insert a newline, never silently accept a completion
        // (that corrupts e.g. dollar-quoted bodies). Accept is Tab-only.
        ...completionKeymap.filter((b) => b.key !== "Enter"),
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
    view.focus();
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
