import { beforeEach, describe, expect, it } from "vitest";
import { aiStore, normalizeAiConfig } from "./store";
import { defaultModel } from "./providers";

class MemoryStorage {
  data = new Map<string, string>();
  failWrite = false;
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { if (this.failWrite) throw new Error("full"); this.data.set(k, v); }
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
});

describe("AI config normalization", () => {
  it("falls malformed roots and providers back safely", () => {
    expect(normalizeAiConfig(null)).toMatchObject({ provider: "anthropic", model: defaultModel("anthropic") });
    expect(normalizeAiConfig({ provider: 42, model: {}, models: [], baseUrls: "bad" })).toMatchObject({
      provider: "anthropic",
      model: defaultModel("anthropic"),
      models: {},
      baseUrls: {},
    });
  });

  it("keeps only known-provider string maps and migrates v1 base URL", () => {
    const c = normalizeAiConfig({
      provider: "openai",
      model: "custom-model",
      models: { openai: "saved", evil: "steal", gemini: 7 },
      baseUrls: { openai: "https://example.test", evil: "https://evil.test" },
      baseUrl: "https://legacy.test",
      shareSamples: false,
    });
    expect(c).toEqual({
      provider: "openai",
      model: "custom-model",
      models: { openai: "saved" },
      baseUrls: { openai: "https://example.test" },
      shareSamples: false,
    });
  });

  it("never throws when storage is corrupt, unavailable, or full", () => {
    storage.setItem("tusk.ai.config", "{");
    expect(aiStore.load().provider).toBe("anthropic");
    storage.failWrite = true;
    expect(() => aiStore.save(normalizeAiConfig({ provider: "anthropic" }))).not.toThrow();
    storage.failWrite = false;
    storage.setItem("tusk.ai.config", " ".repeat(100_001));
    expect(aiStore.load().provider).toBe("anthropic");
  });
});
