import { forEachDiagnostic, linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { type Extension } from "@codemirror/state";
import { type EditorView } from "@codemirror/view";
import { type Table } from "../sql/aliases";
import { type ValidateFn } from "./types";
import { heuristicLintSource } from "./heuristicLint";
import { schemaLintSource } from "./schemaLint";
import { serverLintSource } from "./serverLint";

// Two linter instances, not one merged source:
//   • client (sync, 300ms) — heuristics + schema check; both share the lexer pass
//     and stay snappy.
//   • server (async, 600ms) — Postgres validation; longer debounce, inert when
//     disconnected. CodeMirror merges diagnostics from multiple linters for us.

export function clientLint(getSchema: () => Table[], getFuncs: () => ReadonlySet<string>): Extension {
  const heuristic = heuristicLintSource();
  const schema = schemaLintSource(getSchema, getFuncs);
  const combined = (view: EditorView): Diagnostic[] => [...heuristic(view), ...schema(view)];
  return linter(combined, { delay: 300 });
}

export function serverLint(getValidate: () => ValidateFn | null): Extension {
  return linter(serverLintSource(getValidate), { delay: 600 });
}

export function lintUi(): Extension {
  return lintGutter();
}

/**
 * Apply the first quick-fix of the diagnostic under (or touching) the cursor.
 * Bound to Tab (after completion-accept, before indent) and Alt+Enter / Mod-.
 * so fixes don't depend on catching the hover tooltip with the mouse.
 */
export function applyLintFix(view: EditorView): boolean {
  const pos = view.state.selection.main.head;
  let done = false;
  forEachDiagnostic(view.state, (d, from, to) => {
    if (done || !d.actions?.length) return;
    if (pos >= from && pos <= to) {
      d.actions[0].apply(view, from, to);
      done = true;
    }
  });
  return done;
}
