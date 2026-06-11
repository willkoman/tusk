import { describe, it, expect } from "vitest";
import { isBoolType, boolWord, detectBoolCols, typeBoolCols } from "./bool";
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
});
