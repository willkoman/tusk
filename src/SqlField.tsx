import { onMount, onCleanup, createEffect } from "solid-js";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import {
  autocompletion,
  completionKeymap,
  acceptCompletion,
  type Completion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { oneDark } from "@codemirror/theme-one-dark";
import { getDialect } from "./sql/dialects";

const SPEC = getDialect("postgres");

/**
 * Single-line SQL input with Postgres syntax highlighting and context-appropriate
 * autocomplete (types, and — unless `typesOnly` — functions + provided columns).
 * Used for type / default / expression fields in the create & modify dialogs.
 */
export function SqlField(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  columns?: string[];
  typesOnly?: boolean;
}) {
  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;

  const options = (): Completion[] => {
    const types: Completion[] = SPEC.types.map((label) => ({ label, type: "type" }));
    if (props.typesOnly) return types;
    return [
      ...types,
      ...SPEC.functions.map((fn) => ({ label: `${fn}()`, apply: fn, type: "function" }) as Completion),
      ...(props.columns ?? []).map((label) => ({ label, type: "property" }) as Completion),
    ];
  };

  const source: CompletionSource = (ctx) => {
    const w = ctx.matchBefore(/[\w]+$/);
    if (!w || (w.from === w.to && !ctx.explicit)) return null;
    return { from: w.from, options: options(), validFor: /^\w*$/ };
  };

  onMount(() => {
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        history(),
        sql({ dialect: SPEC.cm, upperCaseKeywords: false }),
        autocompletion({ override: [source], defaultKeymap: false, icons: true }),
        keymap.of([
          { key: "Tab", run: acceptCompletion },
          { key: "Enter", run: () => true }, // single-line — swallow newline
          ...completionKeymap.filter((b) => b.key !== "Enter"),
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        placeholder(props.placeholder ?? ""),
        oneDark,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) props.onChange(u.state.doc.toString().replace(/\n/g, " "));
        }),
        EditorView.theme({
          "&": { fontSize: "12px", backgroundColor: "transparent" },
          ".cm-content": {
            padding: "5px 8px",
            fontFamily: '"JetBrains Mono","SF Mono",Menlo,Consolas,monospace',
          },
          ".cm-scroller": { overflowX: "auto" },
          "&.cm-focused": { outline: "none" },
        }),
      ],
    });
    view = new EditorView({ state, parent: host! });
  });
  onCleanup(() => view?.destroy());

  createEffect(() => {
    const v = props.value;
    if (view && v !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
    }
  });

  return <div class="sql-field" ref={host} />;
}
