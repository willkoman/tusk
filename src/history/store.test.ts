import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { historyStore, normalizeHistory, type HistoryEntry } from "./store";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

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

  it("merges an append that lands before the first disk load resolves", async () => {
    vi.useFakeTimers();
    let resolve!: (raw: string) => void;
    vi.mocked(invoke).mockReturnValueOnce(new Promise<string>((r) => { resolve = r; }) as never);
    const key = "race-append-before-load";
    const old: HistoryEntry = { id: "old", sql: "SELECT 1", ts: 1, durationMs: 1, status: "ok", rows: 1, error: null, schema: "public" };
    const fresh: HistoryEntry = { ...old, id: "fresh", sql: "SELECT 2", ts: 2 };

    const loading = historyStore.load(key);
    historyStore.append(key, fresh);
    resolve(JSON.stringify([old]));

    expect(await loading).toEqual([fresh, old]);
  });

  it("serializes overlapping saves so the newest snapshot is durable last", async () => {
    vi.useFakeTimers();
    const key = "ordered-overlapping-saves";
    const base: HistoryEntry = { id: "base", sql: "SELECT 0", ts: 0, durationMs: 1, status: "ok", rows: 1, error: null, schema: null };
    vi.mocked(invoke).mockResolvedValueOnce("[]" as never);
    await historyStore.load(key);

    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    vi.mocked(invoke).mockReturnValueOnce(firstWrite as never).mockResolvedValueOnce(undefined as never);

    historyStore.append(key, { ...base, id: "one", sql: "SELECT 1", ts: 1 });
    await vi.advanceTimersByTimeAsync(500);
    historyStore.append(key, { ...base, id: "two", sql: "SELECT 2", ts: 2 });
    await vi.advanceTimersByTimeAsync(500);

    const savesBeforeRelease = vi.mocked(invoke).mock.calls.filter(([command]) => command === "save_history");
    expect(savesBeforeRelease).toHaveLength(1);
    releaseFirst();
    await vi.runAllTimersAsync();
    await Promise.resolve();

    const saveCalls = vi.mocked(invoke).mock.calls.filter(([command]) => command === "save_history");
    expect(saveCalls).toHaveLength(2);
    const latest = JSON.parse((saveCalls[1][1] as { json: string }).json) as HistoryEntry[];
    expect(latest.map((entry) => entry.id).slice(0, 2)).toEqual(["two", "one"]);
  });
});
