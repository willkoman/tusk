import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { makeSqlCompletion, type Table } from "./completion";
import { getDialect } from "./dialects";
import { LIVE_ANALYSIS_MAX_CHARS } from "../editor/limits";

const tables: Table[] = [{
  schema: "public",
  name: "users",
  columns: [{ name: "email", data_type: "text" }],
}];

function complete(doc: string, funcs: ReadonlySet<string> = new Set()) {
  const state = EditorState.create({ doc });
  const source = makeSqlCompletion(() => tables, getDialect("postgres"), () => null, () => [], () => funcs);
  return source(new CompletionContext(state, doc.length, true));
}

describe("completion statement boundaries", () => {
  it("keeps semicolons inside strings in the current statement", () => {
    const result = complete("SELECT ';' FROM users WHERE em");
    expect(result?.options.find((option) => option.label === "email")?.boost).toBe(80);
  });

  it("does not inherit clause context from the prior real statement", () => {
    const result = complete("CALL old_proc; pr", new Set(["proc_one"]));
    expect(result?.options.find((option) => option.label === "proc_one")).toBeUndefined();
    expect(result?.options.some((option) => option.label === "SELECT")).toBe(true);
  });

  it("disables completion above the live-analysis document limit", () => {
    expect(complete("x".repeat(LIVE_ANALYSIS_MAX_CHARS + 1))).toBeNull();
  });
});
