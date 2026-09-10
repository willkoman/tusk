import { describe, it, expect } from "vitest";
import { isBoolType, boolWord, boolEditTokens, boolPasteValue, detectBoolCols, typeBoolCols } from "./bool";
import type { Column } from "../Tree";

const col = (name: string, data_type: string, nullable = true): Column => ({
  name,
  data_type,
  nullable,
  is_pk: false,
  is_fk: false,
  default: null,
  comment: null,
});

describe("isBoolType", () => {
  it("matches bool/boolean any case", () => {
    expect(isBoolType("boolean")).toBe(true);
    expect(isBoolType("BOOLEAN")).toBe(true);
    expect(isBoolType("bool")).toBe(true);
    expect(isBoolType(" Bool ")).toBe(true);
  });
  it("rejects non-bool types", () => {
    expect(isBoolType("tinyint")).toBe(false);
    expect(isBoolType("text")).toBe(false);
    expect(isBoolType("boolean[]")).toBe(false);
  });
  it("matches SQL Server's bit, and only on SQL Server", () => {
    expect(isBoolType("bit", "mssql")).toBe(true);
    expect(isBoolType("BIT", "mssql")).toBe(true);
    expect(isBoolType(" bit ", "mssql")).toBe(true);
    // PostgreSQL `bit`/`bit varying` are bit STRINGS, not booleans.
    expect(isBoolType("bit", "postgres")).toBe(false);
    expect(isBoolType("bit", "duckdb")).toBe(false);
    expect(isBoolType("bit", "sqlite")).toBe(false);
    expect(isBoolType("bit varying", "mssql")).toBe(false);
  });
  it("does not match boolean on SQL Server, which has no such type", () => {
    expect(isBoolType("boolean", "mssql")).toBe(false);
  });
});

describe("boolWord", () => {
  it("maps driver tokens", () => {
    expect(boolWord("t")).toBe("TRUE");
    expect(boolWord("f")).toBe("FALSE");
    expect(boolWord("true")).toBe("TRUE");
    expect(boolWord("false")).toBe("FALSE");
    expect(boolWord("1")).toBe("TRUE");
    expect(boolWord("0")).toBe("FALSE");
  });
  it("rejects everything else", () => {
    expect(boolWord("yes")).toBeNull();
    expect(boolWord("T")).toBeNull();
    expect(boolWord("")).toBeNull();
    expect(boolWord("2")).toBeNull();
  });
});

describe("detectBoolCols", () => {
  it("detects t/f and true/false columns, NULLs allowed", () => {
    const rows = [
      ["t", "true", "x"],
      [null, "false", "f"],
      ["f", null, "t"],
    ];
    const got = detectBoolCols(["a", "b", "c"], rows);
    expect(got.has(0)).toBe(true);
    expect(got.has(1)).toBe(true);
    expect(got.has(2)).toBe(false); // "x" breaks it
  });
  it("never detects 0/1 columns (integers)", () => {
    const got = detectBoolCols(["n"], [["0"], ["1"], ["1"]]);
    expect(got.size).toBe(0);
  });
  it("requires at least one non-NULL value", () => {
    expect(detectBoolCols(["a"], [[null], [null]]).size).toBe(0);
    expect(detectBoolCols(["a"], []).size).toBe(0);
  });
  it("a single repeated token still counts", () => {
    expect(detectBoolCols(["a"], [["f"], ["f"]]).has(0)).toBe(true);
  });
});

describe("typeBoolCols", () => {
  it("matches result columns to bool-typed table columns case-insensitively", () => {
    const cols = [col("Active", "boolean"), col("name", "text"), col("flag", "BOOL")];
    const got = typeBoolCols(["active", "name", "flag"], cols);
    expect(got.has(0)).toBe(true);
    expect(got.has(1)).toBe(false);
    expect(got.has(2)).toBe(true);
  });
  it("unknown result columns are not boolean", () => {
    expect(typeBoolCols(["other"], [col("a", "boolean")]).size).toBe(0);
  });
  it("picks up SQL Server bit columns under the mssql dialect", () => {
    const cols = [col("Ok", "bit"), col("n", "int")];
    expect(typeBoolCols(["ok", "n"], cols, "mssql").has(0)).toBe(true);
    expect(typeBoolCols(["ok", "n"], cols, "mssql").has(1)).toBe(false);
    // The same metadata under any other dialect is not boolean.
    expect(typeBoolCols(["ok", "n"], cols, "postgres").size).toBe(0);
  });
});

describe("boolEditTokens", () => {
  it("commits 1/0 on the engines with no boolean literal", () => {
    for (const k of ["sqlite", "mysql", "mssql"]) {
      expect(boolEditTokens(k)).toEqual({ trueVal: "1", falseVal: "0" });
    }
  });
  it("commits true/false on PostgreSQL and DuckDB", () => {
    for (const k of ["postgres", "duckdb"]) {
      expect(boolEditTokens(k)).toEqual({ trueVal: "true", falseVal: "false" });
    }
  });
  it("both tokens round-trip through boolWord", () => {
    expect(boolWord("1")).toBe("TRUE");
    expect(boolWord("0")).toBe("FALSE");
    expect(boolWord("true")).toBe("TRUE");
    expect(boolWord("false")).toBe("FALSE");
  });
});

describe("boolPasteValue", () => {
  it("maps any boolean word or token to the engine's edit token", () => {
    const pg = boolEditTokens("postgres");
    const lite = boolEditTokens("sqlite");
    expect(boolPasteValue("TRUE", pg)).toBe("true");
    expect(boolPasteValue("t", lite)).toBe("1");
    expect(boolPasteValue(" false ", lite)).toBe("0");
    expect(boolPasteValue("0", pg)).toBe("false");
  });

  it("leaves NULL and non-boolean text for the server to judge", () => {
    const pg = boolEditTokens("postgres");
    expect(boolPasteValue(null, pg)).toBeNull();
    expect(boolPasteValue("maybe", pg)).toBe("maybe");
    expect(boolPasteValue("", pg)).toBe("");
  });
});
