import { EditorState, Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { keywordCase } from "./keywordCase";

const WORDS = new Set(["SELECT", "FROM", "WHERE"]);

function typeBoundary(doc: string, at = doc.length): string {
  const state = EditorState.create({ doc, extensions: [keywordCase(WORDS)] });
  return state
    .update({
      changes: { from: at, insert: " " },
      annotations: Transaction.userEvent.of("input.type"),
    })
    .state.doc.toString();
}

describe("keywordCase", () => {
  it("uppercases a completed keyword in SQL code", () => {
    expect(typeBoundary("select")).toBe("SELECT ");
    expect(typeBoundary("t.select")).toBe("t.select ");
  });

  it("does not rewrite multiline strings or comments", () => {
    const stringSql = "select 'first line\nfrom'";
    const stringEnd = stringSql.lastIndexOf("'");
    expect(typeBoundary(stringSql, stringEnd)).toBe("select 'first line\nfrom '");

    const blockSql = "/* first line\nselect*/";
    const blockEnd = blockSql.indexOf("*/");
    expect(typeBoundary(blockSql, blockEnd)).toBe("/* first line\nselect */");

    expect(typeBoundary("-- select")).toBe("-- select ");
  });

  it("does not rewrite dollar bodies or quoted identifiers", () => {
    const dollarSql = "$body$first line\nselect$body$";
    const dollarEnd = dollarSql.lastIndexOf("$body$");
    expect(typeBoundary(dollarSql, dollarEnd)).toBe("$body$first line\nselect $body$");

    const quotedSql = 'select "first line\nfrom"';
    const quotedEnd = quotedSql.lastIndexOf('"');
    expect(typeBoundary(quotedSql, quotedEnd)).toBe('select "first line\nfrom "');
  });
});
