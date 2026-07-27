import { EditorState } from "@codemirror/state";
import { type EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { serverLintSource } from "./serverLint";
import { type ServerDiag } from "./types";

describe("serverLintSource", () => {
  it("drops diagnostics after tab identity changes", async () => {
    let resolve!: (value: ServerDiag[]) => void;
    const validate = () => new Promise<ServerDiag[]>((r) => (resolve = r));
    let identity = "tab-a";
    const state = EditorState.create({ doc: "select nope" });
    const view = { state } as EditorView;

    const pending = serverLintSource(() => validate, () => identity)(view);
    identity = "tab-b";
    resolve([{ stmtIndex: 0, position: 8, message: "bad column" }]);
    await expect(pending).resolves.toEqual([]);
  });

  it("drops diagnostics after equal-text document replacement", async () => {
    let resolve!: (value: ServerDiag[]) => void;
    const validate = () => new Promise<ServerDiag[]>((r) => (resolve = r));
    let state = EditorState.create({ doc: "select nope" });
    const view = {
      get state() {
        return state;
      },
    } as EditorView;

    const pending = serverLintSource(() => validate)(view);
    state = EditorState.create({ doc: "select nope" });
    resolve([{ stmtIndex: 0, position: 8, message: "bad column" }]);
    await expect(pending).resolves.toEqual([]);
  });
});
