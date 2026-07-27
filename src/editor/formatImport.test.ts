import { describe, expect, it, vi } from "vitest";

vi.mock("sql-formatter", () => {
  throw new Error("formatter chunk unavailable");
});

import { formatSql } from "./format";

describe("formatSql import failure", () => {
  it("keeps input unchanged when formatter import rejects", async () => {
    await expect(formatSql("select 1", "postgres")).resolves.toBe("select 1");
  });
});
