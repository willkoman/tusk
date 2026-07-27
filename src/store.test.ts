import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "./editor/types";
import { crashConsent, keymapStore, layoutStore, prefsStore, setCrashConsent, tabsStore } from "./store";

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
});

describe("persisted state normalization", () => {
  it("rejects null/wrong layout roots and non-finite sizes", () => {
    storage.setItem("tusk.layout", "null");
    expect(layoutStore.load()).toEqual({});
    storage.setItem("tusk.layout", JSON.stringify({ sidebarW: "wide", aiW: -1, editorH: 400, sidebarOpen: "yes" }));
    expect(layoutStore.load()).toEqual({ editorH: 400 });
  });

  it("keeps only type-safe bounded preferences", () => {
    storage.setItem("tusk.prefs", JSON.stringify({ fontFamily: 7, fontSize: 1e9, gridColWidth: 240, wordWrap: "yes", accent: "red", theme: "unknown" }));
    expect(prefsStore.load()).toEqual({ ...DEFAULT_PREFS, gridColWidth: 240 });
  });

  it("drops malformed shortcut values", () => {
    storage.setItem("tusk.keys", JSON.stringify({ run: 42, format: "Mod-f", closeTab: null }));
    expect(keymapStore.load()).toEqual({ format: "Mod-f", closeTab: null });
  });

  it("filters malformed tabs and clamps active index", () => {
    storage.setItem("tusk.tabs.db", JSON.stringify({
      tabs: [null, { sql: "SELECT 1", title: "ok", filePath: 9, searchSchema: false }],
      activeIndex: -99,
    }));
    expect(tabsStore.load("db")).toEqual({
      tabs: [{ sql: "SELECT 1", title: "ok", filePath: null, searchSchema: null, dirty: false }],
      activeIndex: 0,
    });
  });

  it("restores dirty state and defaults old documents to clean", () => {
    storage.setItem("tusk.tabs.dirty", JSON.stringify({
      tabs: [{ sql: "SELECT 1", title: "query.sql", filePath: "query.sql", searchSchema: null, dirty: true }],
      activeIndex: 0,
    }));
    expect(tabsStore.load("dirty")?.tabs[0].dirty).toBe(true);

    storage.setItem("tusk.tabs.old", JSON.stringify({
      tabs: [{ sql: "SELECT 2", title: "old", filePath: null, searchSchema: null }],
      activeIndex: 0,
    }));
    expect(tabsStore.load("old")?.tabs[0].dirty).toBe(false);
  });

  it("degrades storage and JSON failures to defaults", () => {
    storage.setItem("tusk.prefs", "{");
    expect(prefsStore.load()).toEqual(DEFAULT_PREFS);
    Object.defineProperty(globalThis, "localStorage", { value: { getItem() { throw new Error("denied"); } }, configurable: true });
    expect(layoutStore.load()).toEqual({});
  });

  it("crash consent persists and stays reactive through the setter", () => {
    setCrashConsent("on");
    expect(crashConsent()).toBe("on");
    expect(storage.getItem("tusk.crashConsent")).toBe("on");
    setCrashConsent("off");
    expect(crashConsent()).toBe("off");
    expect(storage.getItem("tusk.crashConsent")).toBe("off");
  });

  it("rejects oversized localStorage documents before parsing", () => {
    storage.setItem("tusk.layout", " ".repeat(100_001));
    storage.setItem("tusk.tabs.db", " ".repeat(20_000_001));
    expect(layoutStore.load()).toEqual({});
    expect(tabsStore.load("db")).toBeNull();
  });

  it("normalizes persistence failures into detailed contracts", () => {
    storage.setItem("tusk.tabs.bad", "{");
    const invalid = tabsStore.loadResult("bad");
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error).toMatchObject({ operation: "load", code: "invalid-data" });

    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem() { return null; },
        setItem() { throw new Error("quota denied"); },
        removeItem() {},
      },
      configurable: true,
    });
    const unavailable = tabsStore.saveResult("db", {
      tabs: [{ sql: "SELECT 1", title: "q", filePath: null, searchSchema: null, dirty: true }],
      activeIndex: 0,
    });
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) {
      expect(unavailable.error).toMatchObject({ operation: "save", code: "unavailable" });
      expect(unavailable.error.message).toContain("quota denied");
      expect(tabsStore.lastFailure()).toEqual(unavailable.error);
    }
  });

  it("keeps the prior recovery snapshot when a replacement is too large", () => {
    const first = {
      tabs: [{ sql: "SELECT 1", title: "q", filePath: null, searchSchema: null, dirty: true }],
      activeIndex: 0,
    };
    expect(tabsStore.save("db", first)).toBe(true);
    const before = storage.getItem("tusk.tabs.db");
    const oversized = {
      tabs: [{ ...first.tabs[0], sql: "x".repeat(4_000_001) }],
      activeIndex: 0,
    };
    const result = tabsStore.saveForClose("db", oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("too-large");
    expect(storage.getItem("tusk.tabs.db")).toBe(before);
  });

  it("rejects oversized aggregate and escaped recovery data before replacement", () => {
    const first = {
      tabs: [{ sql: "SELECT 1", title: "q", filePath: null, searchSchema: null, dirty: true }],
      activeIndex: 0,
    };
    expect(tabsStore.save("aggregate", first)).toBe(true);
    const before = storage.getItem("tusk.tabs.aggregate");
    const many = {
      tabs: Array.from({ length: 5 }, (_, i) => ({ ...first.tabs[0], title: `q${i}`, sql: "x".repeat(900_000) })),
      activeIndex: 0,
    };
    expect(tabsStore.saveResult("aggregate", many)).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(storage.getItem("tusk.tabs.aggregate")).toBe(before);

    const escaped = { tabs: [{ ...first.tabs[0], sql: "\0".repeat(700_000) }], activeIndex: 0 };
    expect(tabsStore.saveResult("aggregate", escaped)).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(storage.getItem("tusk.tabs.aggregate")).toBe(before);
  });

  it("rejects excess tab counts instead of silently truncating recovery", () => {
    const tab = { sql: "SELECT 1", title: "q", filePath: null, searchSchema: null, dirty: true };
    expect(tabsStore.save("count", { tabs: [tab], activeIndex: 0 })).toBe(true);
    const before = storage.getItem("tusk.tabs.count");
    const excess = { tabs: Array.from({ length: 101 }, (_, i) => ({ ...tab, title: `q${i}` })), activeIndex: 100 };
    expect(tabsStore.saveResult("count", excess)).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(storage.getItem("tusk.tabs.count")).toBe(before);

    storage.setItem("tusk.tabs.excess", JSON.stringify(excess));
    expect(tabsStore.loadResult("excess")).toMatchObject({ ok: false, error: { code: "too-large" } });
  });

  it("quarantines an unreadable snapshot so fresh recovery writes succeed", () => {
    storage.setItem("tusk.tabs.hurt", "{corrupt");
    expect(tabsStore.loadResult("hurt")).toMatchObject({ ok: false, error: { code: "invalid-data" } });
    const parked = tabsStore.quarantineResult("hurt");
    expect(parked).toEqual({ ok: true, value: true });
    expect(storage.getItem("tusk.tabs.hurt")).toBeNull();
    expect(storage.getItem("tusk.tabs.hurt.corrupt")).toBe("{corrupt");
    // The key is now free: a normal save works and reads back.
    const tab = { sql: "SELECT 1", title: "q", filePath: null, searchSchema: null, dirty: true };
    expect(tabsStore.save("hurt", { tabs: [tab], activeIndex: 0 })).toBe(true);
    expect(tabsStore.load("hurt")?.tabs[0].sql).toBe("SELECT 1");
    // Nothing stored → nothing to park.
    expect(tabsStore.quarantineResult("absent")).toEqual({ ok: true, value: false });
  });

  it("close-safe writes verify and preserve dirty state", () => {
    const result = tabsStore.saveForClose("db", {
      tabs: [{ sql: "UPDATE t SET x = 1", title: "q", filePath: "q.sql", searchSchema: "public", dirty: true }],
      activeIndex: 0,
    });
    expect(result.ok).toBe(true);
    expect(tabsStore.load("db")?.tabs[0].dirty).toBe(true);
  });
});
