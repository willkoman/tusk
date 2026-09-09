import { describe, expect, it } from "vitest";
import { lex, maskNonCode, selectionRunText, statementRunText, type SqlEngine } from "./lexer";

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

  it("mssql: [bracket] identifiers hold ; and quotes inertly", () => {
    expect(stmtTexts("SELECT [a;COMMIT] FROM [t]; SELECT 2", "mssql")).toEqual([
      "SELECT [a;COMMIT] FROM [t];",
      "SELECT 2",
    ]);
    expect(stmtTexts("SELECT [we]]ird]; SELECT 2", "mssql")).toEqual(["SELECT [we]]ird];", "SELECT 2"]);
    expect(kinds("SELECT [x]", "mssql")).toEqual(["code", "bracket"]);
    // Brackets stay ordinary code elsewhere (PostgreSQL array subscripts).
    expect(kinds("SELECT a[1]", "postgres")).toEqual(["code"]);
    const doc = "SELECT [col;x] FROM t";
    const { spans } = lex(doc, "mssql");
    expect(maskNonCode(doc, spans, 0, doc.length)).toBe("SELECT         FROM t");
    expect(maskNonCode(doc, spans, 0, doc.length, true)).toBe(doc);
  });

  it("mssql: block comments nest and $ is not a dollar quote", () => {
    expect(kinds("SELECT 1 /* a /* b */ ; */ + 2", "mssql")).toEqual(["code", "block-comment", "code"]);
    // Everywhere else the inner `*/` ends the comment, so the `;` splits.
    expect(stmtTexts("SELECT 1 /* a /* b */ ; */ + 2", "postgres")).toHaveLength(2);
    expect(kinds("SELECT $100, $x$ not a body $x$", "mssql")).toEqual(["code"]);
    expect(kinds("SELECT $x$ body $x$", "postgres")).toContain("dollar");
  });

  it("mssql: a lone GO line ends the batch and is never sent", () => {
    expect(stmtTexts("SELECT 1\nGO\nSELECT 2\ngo -- done\n", "mssql")).toEqual(["SELECT 1", "SELECT 2"]);
    // `go` as an alias or column name is ordinary code.
    expect(stmtTexts("SELECT 1 AS go, 2", "mssql")).toEqual(["SELECT 1 AS go, 2"]);
    expect(stmtTexts("SELECT go\nFROM t", "mssql")).toEqual(["SELECT go\nFROM t"]);
    // GO means nothing on the other engines.
    expect(stmtTexts("SELECT 1\nGO\nSELECT 2", "postgres")).toEqual(["SELECT 1\nGO\nSELECT 2"]);
  });

  it("mssql: GO followed by a block comment is still a batch separator", () => {
    expect(stmtTexts("SELECT 1\nGO /* end of batch */\nSELECT 2\n", "mssql")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
    expect(stmtTexts("SELECT 1\nGO /* x */ -- y\nSELECT 2\n", "mssql")).toEqual(["SELECT 1", "SELECT 2"]);
    // Unterminated: not a separator, so the text stays part of the statement.
    expect(stmtTexts("SELECT 1\nGO /* never closed\n", "mssql")).toHaveLength(1);
  });

  // Same fixtures as script.rs's `tsql_statement_blocks_are_not_split_at_their_own_semicolons`.
  it("mssql: a `;` inside a T-SQL block is not a statement boundary", () => {
    expect(stmtTexts("CREATE PROCEDURE dbo.p AS\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND", "mssql")).toHaveLength(1);
    expect(
      stmtTexts(
        "BEGIN TRY\n  SELECT 1;\n  IF 1=1 BEGIN SELECT 2; END\nEND TRY\nBEGIN CATCH\n  SELECT ERROR_MESSAGE();\nEND CATCH",
        "mssql",
      ),
    ).toHaveLength(1);
    // CASE … END balances within one statement, so the trailing `;` still splits.
    expect(stmtTexts("SELECT CASE WHEN a = 1 THEN 'x' ELSE 'y' END FROM t; SELECT 2", "mssql")).toHaveLength(2);
    // BEGIN TRAN[SACTION] opens a transaction, not a block.
    expect(stmtTexts("BEGIN TRANSACTION; SELECT 1; COMMIT", "mssql")).toEqual([
      "BEGIN TRANSACTION;",
      "SELECT 1;",
      "COMMIT",
    ]);
    expect(stmtTexts("BEGIN DISTRIBUTED TRAN; SELECT 1; COMMIT", "mssql")).toHaveLength(3);
    // `ended` is an identifier; BEGIN/END inside a bracket, string or comment never counts.
    expect(stmtTexts("SELECT ended FROM t; SELECT 2", "mssql")).toHaveLength(2);
    expect(stmtTexts("SELECT [begin], 'begin', /* begin */ 1 FROM t; SELECT 2", "mssql")).toHaveLength(2);
    // GO closes an unbalanced block instead of gluing the rest of the file to it.
    expect(stmtTexts("BEGIN\n SELECT 1;\nGO\nSELECT 2;", "mssql")).toHaveLength(2);
    // Other engines are untouched: BEGIN there is transaction control.
    expect(stmtTexts("BEGIN; SELECT 1; COMMIT;", "postgres")).toHaveLength(3);
  });
});

describe("statement run target", () => {
  it("never expands an inner CTE selection to the enclosing write", () => {
    const doc = `-- 2a. Re-link unlinked rows to good B* BNR VPs
WITH bnr AS (SELECT id FROM vendor WHERE short_name ILIKE 'BNR' AND deleted_at IS NULL),
good AS (
  SELECT DISTINCT g.master_id, g.mpn
  FROM product b
  JOIN product g ON g.sku = regexp_replace(b.sku, '^SCHLAGE-S-B', 'SCHLAGE-B') AND g.fk_brand_id = 528
  WHERE b.fk_brand_id = 528 AND b.sku LIKE 'SCHLAGE-S-B%'
)
UPDATE product_vendor_link pvl
SET unlinked_at = NULL, unlinked_reason = NULL,
    updated_at = now(), updated_by = 'William Krasnov'
FROM good g
JOIN vendor_product vp ON vp.fk_vendor_id = (SELECT id FROM bnr)
                      AND (vp.fk_brand_id = 528 OR vp.brand ILIKE 'schlage')
                      AND vp.mpn = g.mpn
WHERE pvl.fk_master_id = g.master_id
  AND pvl.fk_vendor_product_id = vp.id
  AND pvl.unlinked_at IS NOT NULL;`;
    const selected = `SELECT DISTINCT g.master_id, g.mpn
  FROM product b
  JOIN product g ON g.sku = regexp_replace(b.sku, '^SCHLAGE-S-B', 'SCHLAGE-B') AND g.fk_brand_id = 528
  WHERE b.fk_brand_id = 528 AND b.sku LIKE 'SCHLAGE-S-B%'`;
    const from = doc.indexOf(selected);
    expect(from).toBeGreaterThan(0);
    expect(statementRunText(doc, lex(doc, "postgres").stmts, from, from + selected.length)).toBe(selected);
    expect(statementRunText(doc, lex(doc, "postgres").stmts, from + selected.length, from)).toBe(selected);
  });

  it("falls back to the current semicolon-delimited statement without a selection", () => {
    const doc = "SELECT 1;\nSELECT 2;";
    const cursor = doc.indexOf("2");
    expect(statementRunText(doc, lex(doc, "postgres").stmts, cursor, cursor)).toBe("\nSELECT 2;");
  });

  it("ordinary Run ignores a blank-only selection instead of silently doing nothing", () => {
    const doc = "SELECT 1\n\n";
    expect(selectionRunText(doc, 8, 10)).toBe(doc);
    expect(selectionRunText(doc, 0, 6)).toBe("SELECT");
  });
});
