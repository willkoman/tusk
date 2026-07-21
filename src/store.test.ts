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
      tabs: [{ sql: "SELECT 1", title: "ok", filePath: null, searchSchema: null }],
      activeIndex: 0,
    });
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
});
