import { describe, expect, it } from "vitest";
import { detectParams } from "../sql/params";
import { formatSql } from "./format";

describe("formatSql", () => {
  it("preserves DB-API %s parameters", async () => {
    const out = await formatSql("select * from t where id=any(%s::int[]) or owner=%s", "postgres");
    expect(out).toMatch(/%s::int\[\]/i);
    expect(out.match(/%s/g)).toHaveLength(2);
    expect(out).not.toContain("% s");
  });

  it("does not turn escaped percents or compact modulo into parameters", async () => {
    const out = await formatSql("select %%s, a%s from t", "postgres");
    expect(out).toContain("%%s");
    expect(out).toContain("a % s");
    expect(detectParams(out)).toEqual([]);
  });
});
