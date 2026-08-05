import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { heuristicLintSource } from "./heuristicLint";

// The source reads only view.state (doc + selection) — a bare state wrapper is
// enough, no DOM or real EditorView needed.
const lint = (doc: string) => {
  const state = EditorState.create({ doc });
  return heuristicLintSource()({ state } as unknown as EditorView);
};
const messages = (doc: string) => lint(doc).map((d) => d.message);

describe("WHERE-clause comma detection", () => {
  it("flags top-level commas in WHERE (the AND/OR typo) in every position", () => {
    const bad = "SELECT master_id FROM product WHERE is_active = true, block_from_webstore = false, bigcommerce_status = 'listed';";
    const found = lint(bad).filter((d) => /between conditions/.test(d.message));
    expect(found.length).toBe(2);
    expect(found[0].severity).toBe("error");
    // Positions point at the actual commas.
    for (const d of found) expect(bad[d.from]).toBe(",");
  });

  it("flags HAVING commas too", () => {
    expect(messages("SELECT a, count(*) FROM t GROUP BY a HAVING count(*) > 1, a > 2")).toContain(
      "',' is not valid between conditions — join them with AND or OR",
    );
  });

  it("does not flag legitimate commas", () => {
    for (const ok of [
      "SELECT a, b FROM t WHERE a = 1 AND b = 2",
      "SELECT * FROM t WHERE a IN (1, 2, 3)",
      "SELECT * FROM t WHERE (a, b) = (1, 2)",
      "SELECT * FROM t WHERE coalesce(a, b) = 1",
      "UPDATE t SET a = 1, b = 2 WHERE id = 3",
      "SELECT * FROM t WHERE id = 1 GROUP BY a, b ORDER BY a, b",
      "SELECT * FROM t WHERE x IN (SELECT id FROM u WHERE y = 1) AND z = 2",
      "SELECT * FROM t WHERE a = 1 RETURNING a, b",
      "SELECT * FROM t WHERE s = 'a, b'",
    ]) {
      expect(lint(ok).filter((d) => /between conditions/.test(d.message))).toEqual([]);
    }
  });

  it("tracks nested subquery WHERE regions independently", () => {
    // Inner WHERE comma flagged; outer legit commas untouched.
    const doc = "SELECT a, b FROM t WHERE x IN (SELECT id FROM u WHERE p = 1, q = 2)";
    const found = lint(doc).filter((d) => /between conditions/.test(d.message));
    expect(found.length).toBe(1);
    expect(doc[found[0].from]).toBe(",");
    // After the subquery closes, the OUTER region is active again.
    const outer = "SELECT * FROM t WHERE x IN (SELECT id FROM u), y = 2";
    expect(lint(outer).filter((d) => /between conditions/.test(d.message)).length).toBe(1);
  });

  it("keeps existing checks intact", () => {
    expect(messages("SELCT 1")).toEqual(expect.arrayContaining([expect.stringContaining("unknown statement")]));
    expect(messages("DELETE FROM t")).toEqual(expect.arrayContaining([expect.stringContaining("without WHERE")]));
  });
});

describe("paste-artifact detection", () => {
  it("flags NBSP indentation (the web-paste syntax-error class) and points at each char", () => {
    const doc = "SELECT DISTINCT" + String.fromCharCode(10) + " NBSP NBSPp.master_id FROM product p".split("NBSP").join(String.fromCharCode(0xa0));
    const found = lint(doc).filter((d) => /non-breaking space/.test(d.message));
    expect(found.length).toBe(2);
    for (const d of found) expect(doc.charCodeAt(d.from)).toBe(0xa0);
    expect(found[0].severity).toBe("error");
    expect(found[0].actions?.[0]?.name).toBe("fix all in document");
  });

  it("flags zero-width and curly-quote artifacts with their code points", () => {
    const zw = "SELECT id" + String.fromCharCode(0x200b) + " FROM t";
    expect(messages(zw)).toEqual(expect.arrayContaining([expect.stringContaining("U+200B")]));
    const cq = "SELECT " + String.fromCharCode(0x2018) + "x" + String.fromCharCode(0x2019) + " FROM t";
    expect(messages(cq)).toEqual(expect.arrayContaining([expect.stringContaining("straight quotes")]));
  });

  it("ignores artifacts inside string literals and comments (they are data)", () => {
    const doc = "SELECT 'a" + String.fromCharCode(0xa0) + "b' FROM t -- note" + String.fromCharCode(0xa0) + "here";
    expect(lint(doc).filter((d) => /non-breaking space/.test(d.message))).toEqual([]);
  });

  it("fix-all replaces every code artifact and leaves string data untouched", () => {
    const NB = String.fromCharCode(0xa0);
    const doc = "SELECT" + NB + "a, 'x" + NB + "y'" + String.fromCharCode(0x200b) + " FROM t";
    const state = EditorState.create({ doc });
    let applied: string | null = null;
    const view = {
      state,
      dispatch: (tr: { changes: { from: number; to: number; insert: string }[] }) => {
        applied = state.update({ changes: tr.changes }).state.doc.toString();
      },
    } as unknown as EditorView;
    const diag = heuristicLintSource()(view).find((d) => d.actions?.length);
    expect(diag).toBeTruthy();
    diag!.actions![0].apply(view, diag!.from, diag!.to);
    expect(applied).toBe("SELECT a, 'x" + NB + "y' FROM t");
  });
});
