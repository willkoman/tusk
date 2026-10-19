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

  // Same fixtures as script.rs's `sqlite_trigger_bodies_are_not_split_at_their_own_semicolons`.
  it("sqlite: a `;` inside a CREATE TRIGGER body is not a statement boundary", () => {
    expect(
      stmtTexts(
        "CREATE TRIGGER books_guard AFTER INSERT ON books BEGIN SELECT 1; UPDATE books SET n = 1; END;\nSELECT 2;",
        "sqlite",
      ),
    ).toEqual([
      "CREATE TRIGGER books_guard AFTER INSERT ON books BEGIN SELECT 1; UPDATE books SET n = 1; END;",
      "SELECT 2;",
    ]);
    // TEMP / OR REPLACE headers, and a CASE … END inside the body.
    for (const head of ["CREATE TEMP TRIGGER t", "CREATE TEMPORARY TRIGGER t", "create trigger t"]) {
      expect(
        stmtTexts(`${head} AFTER UPDATE ON x BEGIN SELECT CASE WHEN 1 THEN 2 ELSE 3 END; END; SELECT 9;`, "sqlite"),
      ).toHaveLength(2);
    }
    // A WHEN clause with its own CASE … END, before the body opens.
    expect(
      stmtTexts(
        "CREATE TRIGGER t AFTER INSERT ON x WHEN (CASE WHEN 1 THEN 1 END) = 1 BEGIN DELETE FROM y; END; SELECT 9;",
        "sqlite",
      ),
    ).toHaveLength(2);
    // BEGIN/END inside a string, quoted identifier or comment never counts.
    expect(
      stmtTexts(
        "CREATE TRIGGER t AFTER INSERT ON x BEGIN INSERT INTO y VALUES ('end;'), (\"end\"), (`end`); -- end\n END; SELECT 9;",
        "sqlite",
      ),
    ).toHaveLength(2);
    // Outside a trigger, BEGIN/END stay transaction control and `appended` is a name.
    expect(stmtTexts("BEGIN; SELECT appended FROM t; END;", "sqlite")).toEqual([
      "BEGIN;",
      "SELECT appended FROM t;",
      "END;",
    ]);
    expect(stmtTexts("CREATE TABLE t (a INT); SELECT 1;", "sqlite")).toHaveLength(2);
    // Other engines are untouched: a SQLite-shaped trigger on Postgres still splits.
    expect(stmtTexts("CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END;", "postgres")).toHaveLength(2);
  });

  // Same fixtures as script.rs's `mysql_stored_program_bodies_are_not_split_at_their_own_semicolons`.
  it("mysql: a `;` inside a stored-program body is not a statement boundary", () => {
    // A compound procedure is ONE statement.
    expect(stmtTexts("CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND;\nSELECT 3;", "mysql")).toEqual([
      "CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND;",
      "SELECT 3;",
    ]);
    // SHOW CREATE output: DEFINER, labels, every compound construct, nested blocks.
    const showCreate =
      "CREATE DEFINER=`root`@`%` PROCEDURE `tusk_loop`(IN n INT)\nBEGIN\n  DECLARE i INT DEFAULT 0;\n  lbl: LOOP\n    SET i = i + 1;\n    IF i >= n THEN LEAVE lbl; END IF;\n  END LOOP lbl;\n  WHILE i > 0 DO SET i = i - 1; END WHILE;\n  REPEAT SET i = i + 1; UNTIL i >= 2 END REPEAT;\n  CASE i WHEN 2 THEN SELECT 'two'; ELSE BEGIN SELECT 'other'; END; END CASE;\n  SELECT CASE WHEN i = 2 THEN 'x' ELSE 'y' END AS c;\nEND";
    expect(stmtTexts(`${showCreate};\nSELECT 9;`, "mysql")).toEqual([`${showCreate};`, "SELECT 9;"]);
    // Functions, triggers (with and without a block body), events, and the MariaDB
    // OR REPLACE / unquoted-definer heads.
    for (const sql of [
      "CREATE FUNCTION f(x INT) RETURNS INT DETERMINISTIC BEGIN DECLARE y INT; SET y = x * 2; RETURN y; END; SELECT f(2);",
      "CREATE DEFINER = CURRENT_USER TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN IF NEW.a < 0 THEN SET NEW.a = 0; END IF; END; SELECT 9;",
      "CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET NEW.a = 1; SELECT 9;",
      "CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO BEGIN DELETE FROM x; INSERT INTO y VALUES (1); END; SELECT 9;",
      "CREATE OR REPLACE DEFINER=root@localhost PROCEDURE p() BEGIN SELECT 1; END; SELECT 9;",
      "create procedure p() begin end; select 9;",
      "CREATE PROCEDURE p() `outer`: BEGIN SELECT 1; END `outer`; SELECT 9;",
      "CREATE PROCEDURE p() BEGIN DECLARE done INT DEFAULT 0; DECLARE c CURSOR FOR SELECT a FROM t; DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1; DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END; OPEN c; rd: LOOP FETCH c INTO x; IF done THEN LEAVE rd; END IF; END LOOP; CLOSE c; END; SELECT 9;",
      "CREATE PROCEDURE p() BEGIN FOR i IN 1..3 DO INSERT INTO t VALUES (i); END FOR; END; SELECT 9;",
    ]) {
      expect(stmtTexts(sql, "mysql"), sql).toHaveLength(2);
    }
    // BEGIN and END are not reserved in MySQL: as names they never move the depth.
    expect(
      stmtTexts(
        "CREATE PROCEDURE p(IN begin INT) BEGIN DECLARE end INT DEFAULT begin; UPDATE t SET end = begin WHERE t.end > @end; SELECT begin, end FROM t ORDER BY end; SELECT x FROM t begin WHERE begin.x > 0; SELECT CASE WHEN end > 1 THEN end ELSE 0 END FROM t; END; SELECT 9;",
        "mysql",
      ),
    ).toHaveLength(2);
    // BEGIN/END inside a string, a backtick name or a comment never counts.
    expect(
      stmtTexts(
        "CREATE PROCEDURE p() BEGIN SELECT 'end;'; -- end;\n # end;\n SELECT `end`; /* END */ END; SELECT 9;",
        "mysql",
      ),
    ).toHaveLength(2);
    // Two statements must never merge (a CASE expression's END after a non-reserved
    // column or a BEGIN read as a name closes the CASE; a block's END closes only
    // right after `;`).
    for (const name of ["event", "begin"]) {
      expect(
        stmtTexts(
          `CREATE PROCEDURE p() BEGIN SELECT CASE WHEN a THEN 1 ELSE ${name} END FROM log; END; START TRANSACTION; DELETE FROM log; SELECT 1 end;`,
          "mysql",
        ),
      ).toEqual([
        `CREATE PROCEDURE p() BEGIN SELECT CASE WHEN a THEN 1 ELSE ${name} END FROM log; END;`,
        "START TRANSACTION;",
        "DELETE FROM log;",
        "SELECT 1 end;",
      ]);
    }
    // CASE statements and expressions nest; depth-0 aliases; statement-position BEGIN.
    for (const [sql, count] of [
      ["CREATE PROCEDURE p() BEGIN CASE WHEN a THEN SELECT CASE WHEN b THEN 1 ELSE CASE WHEN c THEN 2 END END; ELSE BEGIN SELECT 3; END; END CASE; END; SELECT 9;", 2],
      ["CREATE PROCEDURE p() BEGIN IF a THEN CASE x WHEN 1 THEN SET y = CASE WHEN z THEN end ELSE begin END; END CASE; END IF; END; SELECT 9;", 2],
      ["CREATE PROCEDURE p() SELECT * FROM t begin FOR UPDATE; SELECT 9;", 2],
      ["CREATE PROCEDURE p() SELECT * FROM t begin STRAIGHT_JOIN u; SELECT 9;", 2],
      ["CREATE PROCEDURE p() SELECT * FROM t begin NATURAL JOIN u; SELECT 9;", 2],
      ["CREATE PROCEDURE p() SELECT * FROM t begin FORCE INDEX (i); SELECT 9;", 2],
      ["CREATE PROCEDURE p() SELECT * FROM t begin WINDOW w AS (); SELECT 9;", 2],
      ["CREATE PROCEDURE p() SELECT a FROM t begin EXCEPT SELECT a FROM u; SELECT 9;", 2],
      ["CREATE PROCEDURE p() BEGIN SELECT * FROM t begin FOR UPDATE; SELECT * FROM t begin JOIN u; END; SELECT 9;", 2],
      ["CREATE PROCEDURE p() BEGIN (SELECT 1) UNION (SELECT 2); END; SELECT 9;", 2],
    ] as const) {
      expect(stmtTexts(sql, "mysql"), sql).toHaveLength(count);
    }
    // Unclosed: the editor keeps the rest together (execution refuses it in Rust).
    expect(stmtTexts("CREATE PROCEDURE p() BEGIN SELECT 1; DROP TABLE t;", "mysql")).toHaveLength(1);
    // Outside a stored-program head nothing changes.
    expect(stmtTexts("BEGIN; SELECT 1; COMMIT;", "mysql")).toEqual(["BEGIN;", "SELECT 1;", "COMMIT;"]);
    for (const [sql, count] of [
      ["START TRANSACTION; SELECT 1; COMMIT;", 3],
      ["CREATE TABLE begin_end (begin INT, end INT); SELECT begin, end FROM begin_end;", 2],
      ["CREATE VIEW v AS SELECT CASE WHEN 1 THEN 2 END AS c; SELECT 1;", 2],
      ["CREATE DEFINER = root@localhost SQL SECURITY DEFINER VIEW v AS SELECT 1 AS event; SELECT 2;", 2],
      ["SELECT CASE WHEN 1 THEN 2 END; SELECT 1;", 2],
    ] as const) {
      expect(stmtTexts(sql, "mysql"), sql).toHaveLength(count);
    }
    // Other engines are untouched: a MySQL-shaped procedure on Postgres still splits.
    expect(stmtTexts("CREATE PROCEDURE p() BEGIN SELECT 1; END;", "postgres")).toHaveLength(2);
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
