import { onMount, onCleanup, createEffect } from "solid-js";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  placeholder,
} from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import {
  autocompletion,
  completionKeymap,
  acceptCompletion,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { bracketMatching, syntaxTree } from "@codemirror/language";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";
import { getDialect, type DialectId } from "./sql/dialects";
import { makeSqlCompletion, type Table } from "./sql/completion";

/** Imperative handle exposed to the parent. */
export type EditorApi = { getRunText: () => string };

/**
 * Live auto-capitalization of SQL keywords. When a word boundary is typed right
 * after a recognized keyword, rewrite it uppercase — skipping strings and
 * qualified names (`t.select`, `"select"`).
 */
function autoCapKeywords(words: Set<string>): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !tr.isUserEvent("input.type")) return tr;
    const changes: { from: number; to: number; insert: string }[] = [];
    tr.changes.iterChanges((_fa, _ta, fromB, _toB, inserted) => {
      const ins = inserted.toString();
      if (ins.length !== 1 || /[\w$]/.test(ins)) return;
      const doc = tr.newDoc;
      let start = fromB;
      while (start > 0 && /[\w$]/.test(doc.sliceString(start - 1, start))) start--;
      if (start === fromB) return;
      const word = doc.sliceString(start, fromB);
      const upper = word.toUpperCase();
      if (word === upper || !words.has(upper)) return;
      const prev = start > 0 ? doc.sliceString(start - 1, start) : "";
      if (prev === "." || prev === '"') return;
      const lineStart = doc.lineAt(start).from;
      const pre = doc.sliceString(lineStart, start);
      if ((pre.match(/'/g) || []).length % 2 === 1) return;
      changes.push({ from: start, to: fromB, insert: upper });
    });
    return changes.length ? [tr, { changes, sequential: true }] : tr;
  });
}

/** Highlight SQL syntax errors using the Lezer parser's error nodes. */
const sqlLinter = linter(
  (view) => {
    const diags: Diagnostic[] = [];
    const len = view.state.doc.length;
    syntaxTree(view.state)
      .cursor()
      .iterate((node) => {
        if (node.type.isError) {
          const from = node.from;
          const to = node.to > from ? node.to : Math.min(from + 1, len);
          if (to > from) diags.push({ from, to, severity: "error", message: "Syntax error" });
        }
      });
    return diags;
  },
  { delay: 300 },
);

export function SqlEditor(props: {
  value: string;
  onChange: (v: string) => void;
  onRun: () => void;
  tables: Table[];
  dialect?: DialectId;
  onReady?: (api: EditorApi) => void;
}) {
  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;

  const getRunText = () => {
    if (!view) return props.value;
    const sel = view.state.selection.main;
    return sel.empty ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to);
  };

  onMount(() => {
    const spec = getDialect(props.dialect ?? "postgres");
    const capWords = new Set(
      [...spec.keywords, ...spec.statementKeywords]
        .flatMap((k) => k.split(/\s+/))
        .map((w) => w.toUpperCase()),
    );

    const state = EditorState.create({
      doc: props.value,
      extensions: [
        lineNumbers(),
        history(),
        bracketMatching(),
        closeBrackets(),
        sqlLinter,
        lintGutter(),
        highlightActiveLine(),
        placeholder("Write SQL — ⌘/Ctrl+Enter to run (selection or all)"),
        sql({ dialect: spec.cm, upperCaseKeywords: true }),
        autocompletion({
          override: [makeSqlCompletion(() => props.tables, spec)],
          icons: true,
          defaultKeymap: false,
        }),
        autoCapKeywords(capWords),
        keymap.of([
          { key: "Mod-Enter", preventDefault: true, run: () => (props.onRun(), true) },
          { key: "Tab", run: acceptCompletion },
          indentWithTab,
          ...closeBracketsKeymap,
          // Enter must insert a newline, never silently accept a completion
          // (that corrupts e.g. dollar-quoted bodies). Accept is Tab-only.
          ...completionKeymap.filter((b) => b.key !== "Enter"),
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        oneDark,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) props.onChange(u.state.doc.toString());
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent" },
          ".cm-scroller": {
            fontFamily: '"JetBrains Mono","SF Mono",Menlo,Consolas,monospace',
          },
        }),
      ],
    });
    view = new EditorView({ state, parent: host! });
    props.onReady?.({ getRunText });
  });

  onCleanup(() => view?.destroy());

  // Sync external value changes (e.g. clicking a table, opening a file).
  createEffect(() => {
    const v = props.value;
    if (view && v !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
    }
  });

  return <div class="cm-host" ref={host} />;
}
