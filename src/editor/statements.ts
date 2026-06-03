import { StateField, StateEffect, RangeSetBuilder, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter } from "@codemirror/view";
import { lexState, statementAt } from "./lexer";
import { type CursorInfo } from "./types";

// Per-statement affordances: a "▶" gutter marker that runs just that statement, a
// subtle highlight on the statement under the cursor (only when there's more than
// one), and a cursor/statement readout for the status bar.

// lineNo-of-first-char → statement index, memoized per document version.
const startLineCache = new WeakMap<object, Map<number, number>>();
function startLineMap(state: EditorState): Map<number, number> {
  const key = state.doc as unknown as object;
  let map = startLineCache.get(key);
  if (!map) {
    map = new Map();
    const { stmts } = lexState(state);
    const text = state.doc.toString();
    stmts.forEach((s, i) => {
      let p = s.from;
      while (p < s.to && /\s/.test(text[p])) p++;
      map!.set(state.doc.lineAt(Math.min(p, state.doc.length)).from, i);
    });
    startLineCache.set(key, map);
  }
  return map;
}

class RunMarker extends GutterMarker {
  toDOM() {
    const e = document.createElement("span");
    e.className = "cm-run-marker";
    e.textContent = "▶";
    e.title = "Run this statement";
    return e;
  }
}
const runMarker = new RunMarker();

// A spinner shown in place of the ▶ on the statement that is currently executing.
class SpinMarker extends GutterMarker {
  toDOM() {
    const e = document.createElement("span");
    e.className = "cm-run-spinner";
    e.title = "Running…";
    return e;
  }
}
const spinMarker = new SpinMarker();

// Whether a query launched from this editor is in flight. App toggles it via
// `setRunningEffect` (through EditorApi); the gutter shows a spinner on the running
// statement instead of ▶.
export const setRunningEffect = StateEffect.define<boolean>();
const runningField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setRunningEffect)) return e.value;
    return value;
  },
});

export function statementGutter(onRun: (text: string) => void): Extension {
  return [
    runningField,
    gutter({
      class: "cm-statement-gutter",
      lineMarker: (view, line) => {
        const idx = startLineMap(view.state).get(line.from);
        if (idx == null) return null;
        if (view.state.field(runningField)) {
          const at = statementAt(lexState(view.state).stmts, view.state.selection.main.head);
          if (at && at.index === idx) return spinMarker;
        }
        return runMarker;
      },
      // Recompute markers when the running flag flips or the cursor moves to a
      // different statement (so the spinner tracks the active/running block).
      lineMarkerChange: (u) =>
        u.startState.field(runningField) !== u.state.field(runningField) ||
        !u.startState.selection.eq(u.state.selection),
      domEventHandlers: {
        mousedown(view, line) {
          const idx = startLineMap(view.state).get(line.from);
          if (idx == null) return false;
          const stmt = lexState(view.state).stmts[idx];
          if (stmt) {
            // Move the cursor into the clicked statement so the running spinner
            // lands on it (the spinner follows the active statement).
            view.dispatch({ selection: { anchor: line.from } });
            onRun(stmt.text);
          }
          return true;
        },
      },
    }),
  ];
}

function buildActive(state: EditorState): DecorationSet {
  const { stmts } = lexState(state);
  if (stmts.length <= 1) return Decoration.none;
  const at = statementAt(stmts, state.selection.main.head);
  if (!at) return Decoration.none;
  const len = state.doc.length;
  const doc = state.doc.toString();
  // A statement span starts right after the previous ';' (still on its closing line)
  // and may include leading blank lines. Trim whitespace to both ends so the highlight
  // covers only the statement's own lines.
  let from = Math.max(0, Math.min(at.stmt.from, len));
  let to = Math.max(from, Math.min(at.stmt.to, len));
  while (from < to && /\s/.test(doc[from])) from++;
  while (to > from && /\s/.test(doc[to - 1])) to--;
  if (to <= from) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  let pos = state.doc.lineAt(from).from;
  const end = state.doc.lineAt(to - 1).to;
  while (pos <= end) {
    const line = state.doc.lineAt(pos);
    builder.add(line.from, line.from, Decoration.line({ class: "cm-activeStatement" }));
    if (line.to + 1 > len) break;
    pos = line.to + 1;
  }
  return builder.finish();
}

const activeStatementField = StateField.define<DecorationSet>({
  create: buildActive,
  update(value, tr) {
    if (tr.docChanged || !tr.state.selection.eq(tr.startState.selection)) return buildActive(tr.state);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function activeStatement(): Extension {
  return activeStatementField;
}

/** Emit cursor line/col + statement index/count + selected-char count to the status bar. */
export function cursorReadout(onInfo: (info: CursorInfo) => void): Extension {
  return EditorView.updateListener.of((u) => {
    if (!u.selectionSet && !u.docChanged) return;
    const state = u.state;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const { stmts } = lexState(state);
    const at = statementAt(stmts, head);
    let selChars = 0;
    for (const r of state.selection.ranges) selChars += r.to - r.from;
    onInfo({
      line: line.number,
      col: head - line.from + 1,
      stmtIndex: at ? at.index + 1 : 0,
      stmtCount: stmts.length,
      selChars,
    });
  });
}
