import { type Diagnostic } from "@codemirror/lint";
import { type EditorView } from "@codemirror/view";
import { lexState } from "./lexer";
import { type ServerDiag, type ValidateFn } from "./types";

// Async linter source: round-trips the buffer to the backend `validate_sql`
// command (PREPARE-only — never executes) for parser-grade Postgres diagnostics,
// and maps each {stmtIndex, position} back to a document range.
//
// `getValidate()` returns null when disconnected or the server-lint pref is off, in
// which case this is a no-op. CodeMirror's `delay` debounces re-runs; a newer edit
// supersedes an in-flight request.

export function serverLintSource(getValidate: () => ValidateFn | null) {
  return async (view: EditorView): Promise<Diagnostic[]> => {
    const validate = getValidate();
    if (!validate) return [];
    const doc = view.state.doc.toString();
    if (!doc.trim()) return [];

    let diags: ServerDiag[];
    try {
      diags = await validate(doc);
    } catch {
      return []; // transport/connection error — stay silent, client lints still apply
    }

    const { stmts } = lexState(view.state);
    const out: Diagnostic[] = [];
    for (const d of diags) {
      const stmt = stmts[d.stmtIndex];
      if (!stmt) continue;
      // The backend prepared the whitespace-trimmed statement; account for leading
      // whitespace/comments so the 1-based position lands on the right character.
      const lead = stmt.text.length - stmt.text.replace(/^\s+/, "").length;
      // No position from the server → squiggle the first real token, not the
      // leading whitespace (a range starting on whitespace never widens and
      // renders as an invisible 1-char underline).
      let from = d.position && d.position > 0 ? stmt.from + lead + (d.position - 1) : stmt.from + lead;
      from = Math.max(stmt.from, Math.min(from, Math.max(stmt.from, stmt.to - 1))); // keep within [from, to)
      // Widen to the token under the position for a readable squiggle.
      let to = from;
      while (to < stmt.to && /[\w$]/.test(doc[to])) to++;
      while (from > stmt.from && /[\w$]/.test(doc[from - 1])) from--;
      if (to <= from) to = Math.min(from + 1, stmt.to);
      out.push({ from, to, severity: "error", message: d.message });
    }
    return out;
  };
}
