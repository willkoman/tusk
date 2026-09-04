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
