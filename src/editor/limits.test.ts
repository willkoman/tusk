import { EditorState } from "@codemirror/state";
import { type EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { detectFoldCandidates } from "./autofold";
import { heuristicLintSource } from "./heuristicLint";
import {
  FOLD_CANDIDATE_LIMIT,
  LINT_DIAGNOSTIC_LIMIT,
  LIVE_ANALYSIS_MAX_CHARS,
} from "./limits";
import { serverLintSource } from "./serverLint";
import { buildActiveStatementDecorations } from "./statements";
import { highlightSql, MAX_HIGHLIGHT_CHARS } from "../ai/sqlHighlight";

const viewOf = (state: EditorState) => ({ state }) as EditorView;

describe("editor work limits", () => {
  it("disables live lint, fold, and active-statement work above document cutoff", async () => {
    const state = EditorState.create({ doc: "x".repeat(LIVE_ANALYSIS_MAX_CHARS + 1) });
    const validate = vi.fn(async () => []);

    expect(heuristicLintSource()(viewOf(state))).toEqual([]);
    expect(detectFoldCandidates(state)).toEqual([]);
    expect(buildActiveStatementDecorations(state).size).toBe(0);
    await expect(serverLintSource(() => validate)(viewOf(state))).resolves.toEqual([]);
    expect(validate).not.toHaveBeenCalled();
  });

  it("caps client diagnostics", () => {
    const state = EditorState.create({ doc: ")".repeat(LINT_DIAGNOSTIC_LIMIT + 50) });
    expect(heuristicLintSource()(viewOf(state))).toHaveLength(LINT_DIAGNOSTIC_LIMIT);
  });

  it("caps automatic fold candidates", () => {
    const literal = `'${"x".repeat(210)}'`;
    const state = EditorState.create({ doc: Array(FOLD_CANDIDATE_LIMIT + 50).fill(literal).join(",") });
    expect(detectFoldCandidates(state)).toHaveLength(FOLD_CANDIDATE_LIMIT);
  });

  it("renders oversized SQL without creating a token span per word", () => {
    const sql = "x".repeat(MAX_HIGHLIGHT_CHARS + 1);
    expect(highlightSql(sql)).toEqual([{ text: sql, cls: "" }]);
  });
});
