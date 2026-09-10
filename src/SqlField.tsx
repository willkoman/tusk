import { onMount, onCleanup, createEffect, Show } from "solid-js";
import { EditorView, keymap, placeholder, tooltips } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import {
  autocompletion,
  completionKeymap,
  acceptCompletion,
  closeCompletion,
  startCompletion,
  type Completion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { Icon } from "./Icons";
import { paletteFor } from "./editor/theme";
import { fieldTheme } from "./editor/fieldTheme";
import { driverDialect, getDialect } from "./sql/dialects";
import { sqlDialect } from "./sql/ident";

// The type/function/keyword lists follow the CONNECTED driver, so a MySQL column
// editor offers MySQL types. Read per-mount: dialogs mount inside one connection.
const spec = () => getDialect(driverDialect(sqlDialect()));

/**
 * Single-line SQL input with Postgres syntax highlighting and context-appropriate
 * autocomplete (types, and — unless `typesOnly` — functions + provided columns).
 * Used for type / default / expression fields in the create & modify dialogs.
 *
 * The palette follows the app theme through `fieldTheme` and a Compartment, the
 * same way SqlEditor follows `prefs.theme`: hard-coding One Dark painted a dark
 * syntax palette on every light theme's surface.
 */
export function SqlField(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  columns?: string[];
  /** Offer only type names — and show the caret that lists them. */
  typesOnly?: boolean;
}) {
  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  const themeComp = new Compartment();

  const options = (): Completion[] => {
    const s = spec();
    const types: Completion[] = s.types.map((label) => ({ label, type: "type" }));
    if (props.typesOnly) return types;
    return [
      ...types,
      ...s.functions.map((fn) => ({ label: `${fn}()`, apply: fn, type: "function" }) as Completion),
      ...(props.columns ?? []).map((label) => ({ label, type: "property" }) as Completion),
    ];
  };

  const source: CompletionSource = (ctx) => {
    const w = ctx.matchBefore(/[\w]+$/);
    // An explicit request (the caret button, Ctrl-Space, focusing an empty type
    // field) lists everything; typing still filters from the word under the cursor.
    if (!w) return ctx.explicit ? { from: ctx.pos, options: options(), validFor: /^\w*$/ } : null;
    if (w.from === w.to && !ctx.explicit) return null;
    return { from: w.from, options: options(), validFor: /^\w*$/ };
  };

  /** Open the completion list from the caret button or an empty focused field. */
  const showOptions = () => {
    if (!view) return;
    view.focus();
    startCompletion(view);
  };

  // The tooltip is parented at <body> (below), so a scrolling dialog moves the
  // field out from under an open popup and leaves it pinned over the app chrome.
  // Close it whenever anything OUTSIDE this editor scrolls; the field's own
  // horizontal scroller must not, or typing a long value would dismiss the list.
  const onOutsideScroll = (e: Event) => {
    if (!view) return;
    const t = e.target;
    if (t instanceof Node && view.dom.contains(t)) return;
    closeCompletion(view);
  };

  onMount(() => {
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        history(),
        sql({ dialect: spec().cm, upperCaseKeywords: false }),
        autocompletion({ override: [source], defaultKeymap: false, icons: true }),
        // The field lives inside a modal that scrolls and clips its own overflow, so a
        // tooltip anchored in that stacking context is cut off or painted under the next
        // row. Anchor it to the document instead (`.cm-tooltip` sits above `.modal`).
        tooltips({ parent: document.body, position: "fixed" }),
        keymap.of([
          { key: "Tab", run: acceptCompletion },
          { key: "Enter", run: () => true }, // single-line — swallow newline
          ...completionKeymap.filter((b) => b.key !== "Enter"),
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        placeholder(props.placeholder ?? ""),
        themeComp.of(paletteFor(fieldTheme())),
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
    document.addEventListener("scroll", onOutsideScroll, true);
  });
  onCleanup(() => {
    document.removeEventListener("scroll", onOutsideScroll, true);
    view?.destroy();
  });

  // Live theme reconfigure — no rebuild, so the field keeps its history and cursor.
  createEffect(() => {
    const palette = paletteFor(fieldTheme());
    view?.dispatch({ effects: themeComp.reconfigure(palette) });
  });

  createEffect(() => {
    const v = props.value;
    if (view && v !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
    }
  });

  return (
    <div class="sql-field" classList={{ "has-options": !!props.typesOnly }}>
      <div
        class="sql-field-cm"
        ref={host}
        onFocusIn={() => {
          // A constrained field opens its list when there is nothing to filter by,
          // so it reads as a picker rather than as free text.
          if (props.typesOnly && view && view.state.doc.length === 0) startCompletion(view);
        }}
      />
      <Show when={props.typesOnly}>
        <button
          type="button"
          class="sql-field-caret"
          tabindex={-1}
          title="Show types"
          aria-label="Show types"
          onMouseDown={(e) => e.preventDefault()}
          onClick={showOptions}
        >
          <Icon name="chevronDown" />
        </button>
      </Show>
    </div>
  );
}
