import { afterEach, describe, expect, it } from "vitest";
import { detectParams, substituteParams, type ParamValue } from "./params";
import { setSqlDialect } from "./ident";

afterEach(() => setSqlDialect("postgres"));

const v = (value: string, extra: Partial<ParamValue> = {}): ParamValue => ({ value, raw: false, isNull: false, ...extra });

describe("detectParams", () => {
  it("finds positional and named params, deduped, in order", () => {
    expect(detectParams("SELECT * FROM t WHERE a = $1 AND b = :name AND c = $1 AND d = $2")).toEqual([
      { name: "$1", kind: "positional" },
      { name: ":name", kind: "named" },
      { name: "$2", kind: "positional" },
    ]);
  });

  it("ignores ::casts", () => {
    expect(detectParams("SELECT a::int, b::my_type FROM t")).toEqual([]);
  });

  it("ignores params inside strings, comments, and dollar-quoted bodies", () => {
    expect(detectParams("SELECT ':x', '$1' -- :c1\n/* :c2 */ FROM t")).toEqual([]);
    expect(detectParams("DO $fn$ SELECT :inside; $fn$")).toEqual([]);
  });

  it("$tag$ delimiters are not positional params", () => {
    expect(detectParams("SELECT $body$x$body$ , $3")).toEqual([{ name: "$3", kind: "positional" }]);
  });

  it("word-adjacent colons are not named params", () => {
    expect(detectParams("SELECT a:b FROM t")).toEqual([]); // a:b — adjacency, not a param
  });
});

describe("substituteParams", () => {
  it("quotes values via lit (with escaping)", () => {
    expect(substituteParams("SELECT * FROM t WHERE n = :n", { ":n": v("o'brien") })).toBe(
      "SELECT * FROM t WHERE n = 'o''brien'",
    );
  });

  it("substitutes every occurrence of the same param", () => {
    expect(substituteParams("SELECT $1, $1, $2", { $1: v("a"), $2: v("b") })).toBe("SELECT 'a', 'a', 'b'");
  });

  it("NULL and raw modes", () => {
    expect(substituteParams("WHERE a = $1 AND b > $2", { $1: v("", { isNull: true }), $2: v("42", { raw: true }) })).toBe(
      "WHERE a = NULL AND b > 42",
    );
  });

  it("leaves params without values untouched", () => {
    expect(substituteParams("WHERE a = $1 AND b = $2", { $1: v("x") })).toBe("WHERE a = 'x' AND b = $2");
  });

  it("does not touch lookalikes inside strings", () => {
    expect(substituteParams("SELECT '$1' WHERE a = $1", { $1: v("x") })).toBe("SELECT '$1' WHERE a = 'x'");
  });
});
