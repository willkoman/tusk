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
import { autocompletion, completionKeymap, acceptCompletion } from "@codemirror/autocomplete";
import { bracketMatching } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { getDialect, type DialectId } from "./sql/dialects";
import { makeSqlCompletion, type Table } from "./sql/completion";

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
      if (ins.length !== 1 || /[\w$]/.test(ins)) return; // only on a single boundary char
      const doc = tr.newDoc;
      let start = fromB;
      while (start > 0 && /[\w$]/.test(doc.sliceString(start - 1, start))) start--;
      if (start === fromB) return;
      const word = doc.sliceString(start, fromB);
      const upper = word.toUpperCase();
      if (word === upper || !words.has(upper)) return;
      const prev = start > 0 ? doc.sliceString(start - 1, start) : "";
      if (prev === "." || prev === '"') return; // qualified / quoted identifier
      const lineStart = doc.lineAt(start).from;
      const pre = doc.sliceString(lineStart, start);
      if ((pre.match(/'/g) || []).length % 2 === 1) return; // inside a string literal
      changes.push({ from: start, to: fromB, insert: upper });
    });
    return changes.length ? [tr, { changes, sequential: true }] : tr;
  });
}

export function SqlEditor(props: {
  value: string;
  onChange: (v: string) => void;
  onRun: () => void;
  tables: Table[];
  dialect?: DialectId;
}) {
  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;

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
        highlightActiveLine(),
        placeholder("Write SQL — ⌘/Ctrl+Enter to run"),
        sql({ dialect: spec.cm, upperCaseKeywords: true }),
        autocompletion({
          override: [makeSqlCompletion(() => props.tables, spec)],
          icons: true,
          defaultKeymap: false,
        }),
        autoCapKeywords(capWords),
        keymap.of([
          { key: "Mod-Enter", preventDefault: true, run: () => (props.onRun(), true) },
          { key: "Tab", run: acceptCompletion }, // accept completion if open, else indent
          indentWithTab,
          ...completionKeymap,
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
  });

  onCleanup(() => view?.destroy());

  // Sync external value changes (e.g. clicking a table in the sidebar).
  createEffect(() => {
    const v = props.value;
    if (view && v !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
    }
  });

  return <div class="cm-host" ref={host} />;
}
