import { EditorState } from "@codemirror/state";
import { type EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { detectParams } from "../sql/params";
import { formatDoc, formatSql } from "./format";
import { FORMAT_MAX_CHARS } from "./limits";

describe("formatSql", () => {
  it("preserves DB-API %s parameters", async () => {
    const out = await formatSql("select * from t where id=any(%s::int[]) or owner=%s", "postgres");
    expect(out).toMatch(/%s::int\[\]/i);
    expect(out.match(/%s/g)).toHaveLength(2);
    expect(out).not.toContain("% s");
  });

  it("does not turn escaped percents or compact modulo into parameters", async () => {
    const out = await formatSql("select %%s, a%s from t", "postgres");
    expect(out).toContain("%%s");
    expect(out).toContain("a % s");
    expect(detectParams(out)).toEqual([]);
  });

  it("restores dollar bodies without colliding with user marker-like text", async () => {
    const body = "$body$\nselect '__TUSK_DQ_0__'; -- keep from lowercase\n$body$";
    const input = `select '__TUSK_FORMAT_DQ_0__', '__TUSK_DQ_0__', ${body}`;
    const out = await formatSql(input, "postgres");
    expect(out).toContain("'__TUSK_FORMAT_DQ_0__'");
    expect(out).toContain("'__TUSK_DQ_0__'");
    expect(out).toContain(body);
  });

  it("restores anonymous $$ bodies verbatim ($$ is a replacement pattern in String.replace)", async () => {
    const body = "$$ SELECT 1; -- $& $' $` inside $$";
    const out = await formatSql(`select ${body} as f`, "postgres");
    expect(out).toContain(body);
  });

  it("drops stale async output when tab identity changes", async () => {
    const state = EditorState.create({ doc: "select 1" });
    let identity = "tab-a";
    const dispatch = vi.fn();
    const view = {
      state,
      dispatch,
      focus: vi.fn(),
    } as unknown as EditorView;

    const pending = formatDoc(view, false, "postgres", () => identity);
    identity = "tab-b";
    await pending;
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("drops stale async output when document identity changes with equal text", async () => {
    let state = EditorState.create({ doc: "select 1" });
    const dispatch = vi.fn();
    const view = {
      get state() {
        return state;
      },
      dispatch,
      focus: vi.fn(),
    } as unknown as EditorView;

    const pending = formatDoc(view, false, "postgres", () => "tab-a");
    state = EditorState.create({ doc: "select 1" });
    await pending;
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("leaves oversized input unchanged", async () => {
    const input = "x".repeat(FORMAT_MAX_CHARS + 1);
    await expect(formatSql(input, "postgres")).resolves.toBe(input);
  });
});
