import { describe, expect, it } from "vitest";
import { normalizeHistory } from "./store";

describe("history normalization", () => {
  it("keeps valid entries and drops malformed shapes", () => {
    const valid = { id: "1", sql: "SELECT 1", ts: 1, durationMs: 2, status: "ok", rows: 1, error: null, schema: null };
    expect(normalizeHistory([null, { ...valid, sql: 7 }, valid, { ...valid, status: "unknown" }])).toEqual([valid]);
  });

  it("normalizes optional fields and rejects oversized SQL", () => {
    const base = { id: "1", sql: "SELECT 1", ts: 1, durationMs: -2, status: "error" };
    expect(normalizeHistory([{ ...base, rows: "many", error: 7, schema: {} }])).toEqual([
      { ...base, durationMs: 0, rows: null, error: null, schema: null },
    ]);
    expect(normalizeHistory([{ ...base, sql: "x".repeat(1_000_001) }])).toEqual([]);
  });

  it("caps aggregate retained history size", () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      id: String(i), sql: "x".repeat(900_000), ts: i, durationMs: 1,
      status: "ok" as const, rows: 1, error: null, schema: null,
    }));
    expect(normalizeHistory(entries).length).toBeLessThan(entries.length);
  });
});
