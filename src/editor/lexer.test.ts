import { describe, expect, it } from "vitest";
import { lex, maskNonCode, type SqlEngine } from "./lexer";

const stmtTexts = (doc: string, engine: SqlEngine) => lex(doc, engine).stmts.map((s) => s.text.trim());
const kinds = (doc: string, engine: SqlEngine) => lex(doc, engine).spans.map((s) => s.kind);

describe("engine-aware lexing (parity with script.rs split_impl)", () => {
  it("postgres: backticks are plain code, # is not a comment", () => {
    expect(new Set(kinds("SELECT `a;b`", "postgres"))).toEqual(new Set(["code"]));
    // Parity with Rust: PostgreSQL has no backtick quoting, so the ; splits.
    expect(stmtTexts("SELECT `a;b`; SELECT 2", "postgres")).toEqual(["SELECT `a;", "b`;", "SELECT 2"]);
    expect(kinds("SELECT 1 # not comment", "postgres")).toEqual(["code"]);
  });

  it("mysql: # comment runs to EOL and its semicolon does not split", () => {
    expect(stmtTexts("SELECT 1 # note; DROP TABLE t\nFROM d;", "mysql")).toEqual(["SELECT 1 # note; DROP TABLE t\nFROM d;"]);
    expect(kinds("SELECT 1 # tail", "mysql")).toContain("line-comment");
  });

  it("mysql: -- needs following whitespace (1--2 is arithmetic)", () => {
    expect(kinds("SELECT 1--2", "mysql")).toEqual(["code"]);
    expect(kinds("SELECT 1--2", "postgres")).toContain("line-comment");
    expect(kinds("SELECT 1 -- c", "mysql")).toContain("line-comment");
    // Trailing -- at end of input is a comment on MySQL too.
    expect(kinds("SELECT 1 --", "mysql")).toContain("line-comment");
  });

  it("mysql/sqlite: backtick identifiers contain ; ' and -- inertly", () => {
    for (const engine of ["mysql", "sqlite"] as const) {
      expect(stmtTexts("SELECT `a;'--b`; SELECT 2", engine)).toEqual(["SELECT `a;'--b`;", "SELECT 2"]);
      expect(kinds("SELECT `x`", engine)).toEqual(["code", "btick"]);
    }
  });

  it("mysql: backslash escapes inside strings keep the string open", () => {
    // \' does not close the string; the second ' does.
    expect(stmtTexts("SELECT 'a\\'; DROP TABLE t; --' ; SELECT 2", "mysql"))
      .toEqual(["SELECT 'a\\'; DROP TABLE t; --' ;", "SELECT 2"]);
    // On engines without backslash escapes, \' closes the string (backslash is literal).
    const pg = lex("SELECT 'a\\'", "postgres").spans.find((s) => s.kind === "string")!;
    expect(pg.to).toBe("SELECT 'a\\'".length);
  });

  it("doubled backtick escapes stay inside one identifier", () => {
    expect(stmtTexts("SELECT `a``;b`; SELECT 2", "mysql")).toEqual(["SELECT `a``;b`;", "SELECT 2"]);
  });

  it("maskNonCode masks backticks by default and keeps them with keepDquote", () => {
    const doc = "SELECT `col;x` FROM t";
    const { spans } = lex(doc, "mysql");
    expect(maskNonCode(doc, spans, 0, doc.length)).toBe("SELECT         FROM t");
    expect(maskNonCode(doc, spans, 0, doc.length, true)).toBe(doc);
  });
});
