import { afterEach, describe, expect, it } from "vitest";
import { ident, lit, setSqlDialect } from "./ident";

afterEach(() => setSqlDialect("postgres"));

describe("SQL quoting", () => {
  it("doubles standard quotes and identifier delimiters", () => {
    expect(lit("O'Brien")).toBe("'O''Brien'");
    expect(ident('a"b')).toBe('"a""b"');
  });

  it("encodes hostile MySQL values without quote or backslash syntax", () => {
    setSqlDialect("mysql");
    expect(lit("\\'; DROP TABLE users; --\0\n🦆")).toBe(
      "_utf8mb4 X'5c273b2044524f50205441424c452075736572733b202d2d000af09fa686'",
    );
    expect(lit("")).toBe("''");
    expect(ident("a`b")).toBe("`a``b`");
  });
});
