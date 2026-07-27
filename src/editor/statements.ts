import { StateField, StateEffect, RangeSetBuilder, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter } from "@codemirror/view";
import { docString, lexState, statementAt } from "./lexer";
import { type CursorInfo } from "./types";
import { ACTIVE_STATEMENT_LINE_LIMIT, LINT_STATEMENT_LIMIT, LIVE_ANALYSIS_MAX_CHARS } from "./limits";

// Per-statement affordances: a "▶" gutter marker that runs just that statement, a
// subtle highlight on the statement under the cursor (only when there's more than
// one), and a cursor/statement readout for the status bar.

// lineNo-of-first-char → statement index, memoized per document version.
const startLineCache = new WeakMap<object, Map<number, number>>();
const noStartLines = new Map<number, number>();
function startLineMap(state: EditorState): Map<number, number> {
  if (state.doc.length > LIVE_ANALYSIS_MAX_CHARS) return noStartLines;
  const key = state.doc as unknown as object;
  let map = startLineCache.get(key);
  if (!map) {
    map = new Map();
    const { stmts } = lexState(state);
    const text = docString(state);
    stmts.slice(0, LINT_STATEMENT_LIMIT).forEach((s, i) => {
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
// statement instead of ▶. The field stores the ANCHOR POSITION captured when the
// run started (mapped through edits) — not the live cursor — so clicking around
// other statements while a query runs doesn't drag the spinner with it.
export const setRunningEffect = StateEffect.define<boolean>();
const runningField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    let v = value;
    if (v != null && tr.docChanged) v = tr.changes.mapPos(v);
    for (const e of tr.effects) if (e.is(setRunningEffect)) v = e.value ? tr.state.selection.main.head : null;
    return v;
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
        const runPos = view.state.field(runningField);
        if (runPos != null) {
          const at = statementAt(lexState(view.state).stmts, runPos);
          if (at && at.index === idx) return spinMarker;
        }
        return runMarker;
      },
      // Recompute markers when the pinned running anchor changes (run start/stop
      // or a doc edit remapping it) — cursor moves alone don't repaint.
      lineMarkerChange: (u) => u.startState.field(runningField) !== u.state.field(runningField),
      domEventHandlers: {
        mousedown(view, line) {
          const idx = startLineMap(view.state).get(line.from);
          if (idx == null) return false;
          const stmt = lexState(view.state).stmts[idx];
          if (stmt) {
            // Move the cursor into the clicked statement BEFORE launching, so
            // the run-start anchor (captured from the selection) pins the
            // spinner to this statement.
            view.dispatch({ selection: { anchor: line.from } });
            onRun(stmt.text);
          }
          return true;
        },
      },
    }),
  ];
}

export function buildActiveStatementDecorations(state: EditorState): DecorationSet {
  if (state.doc.length > LIVE_ANALYSIS_MAX_CHARS) return Decoration.none;
  const { stmts } = lexState(state);
  if (stmts.length <= 1) return Decoration.none;
  const at = statementAt(stmts, state.selection.main.head);
  if (!at) return Decoration.none;
  const len = state.doc.length;
  const doc = docString(state);
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
  let lineCount = 0;
  while (pos <= end) {
    if (++lineCount > ACTIVE_STATEMENT_LINE_LIMIT) return Decoration.none;
    const line = state.doc.lineAt(pos);
    builder.add(line.from, line.from, Decoration.line({ class: "cm-activeStatement" }));
    if (line.to + 1 > len) break;
    pos = line.to + 1;
  }
  return builder.finish();
}

const activeStatementField = StateField.define<DecorationSet>({
  create: buildActiveStatementDecorations,
  update(value, tr) {
    if (tr.docChanged || !tr.state.selection.eq(tr.startState.selection)) return buildActiveStatementDecorations(tr.state);
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
    const withinLimit = state.doc.length <= LIVE_ANALYSIS_MAX_CHARS;
    const stmts = withinLimit ? lexState(state).stmts : [];
    const at = withinLimit ? statementAt(stmts, head) : null;
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
