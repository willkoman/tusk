import { beforeEach, describe, expect, it } from "vitest";
import {
  activeBaseUrl,
  approvedBaseOverride,
  aiStore,
  connectionTestProbe,
  normalizeAiConfig,
  originApproved,
  withProviderModel,
} from "./store";
import { defaultModel } from "./providers";

class MemoryStorage {
  data = new Map<string, string>();
  failWrite = false;
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { if (this.failWrite) throw new Error("full"); this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
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
      approvedOrigins: {},
      shareSamples: false,
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
      approvedOrigins: {},
      shareSamples: false,
      maxTokens: 2048,
    });
  });

  it("normalizes maxTokens like the Slack pane (clamp + 256 snap, fallback on junk)", () => {
    expect(normalizeAiConfig({ provider: "openai", maxTokens: 4096 }).maxTokens).toBe(4096);
    expect(normalizeAiConfig({ provider: "openai", maxTokens: 300 }).maxTokens).toBe(256);
    expect(normalizeAiConfig({ provider: "openai", maxTokens: 999999 }).maxTokens).toBe(128000);
    expect(normalizeAiConfig({ provider: "openai", maxTokens: "junk" }).maxTokens).toBe(2048);
    expect(normalizeAiConfig({ provider: "openai" }).maxTokens).toBe(2048);
  });

  it("never throws when storage is corrupt, unavailable, or full", () => {
    storage.setItem("tusk.ai.config", "{");
    expect(aiStore.load()).toMatchObject({ provider: "anthropic", shareSamples: false });
    storage.failWrite = true;
    expect(() => aiStore.save(normalizeAiConfig({ provider: "anthropic" }))).not.toThrow();
    storage.failWrite = false;
    storage.setItem("tusk.ai.config", " ".repeat(100_001));
    expect(aiStore.load()).toMatchObject({ provider: "anthropic", shareSamples: false });
  });

  it("enables sample sharing only from an explicit valid stored true", () => {
    expect(normalizeAiConfig({ provider: "openai" }).shareSamples).toBe(false);
    expect(normalizeAiConfig({ provider: "openai", shareSamples: "true" }).shareSamples).toBe(false);
    expect(normalizeAiConfig({ provider: "openai", shareSamples: true }).shareSamples).toBe(true);
  });

  it("pins official providers until the override origin is explicitly approved", () => {
    const base = normalizeAiConfig({
      provider: "openai",
      model: "gpt-5.5",
      baseUrls: { openai: "https://proxy.example/api" },
    });
    expect(originApproved(base, "openai")).toBe(false);
    expect(approvedBaseOverride(base, "openai")).toBe("");
    expect(activeBaseUrl(base)).toBe("https://proxy.example/api");

    const approved = normalizeAiConfig({
      ...base,
      approvedOrigins: { openai: "https://proxy.example" },
    });
    expect(originApproved(approved, "openai")).toBe(true);
    expect(activeBaseUrl(approved)).toBe("https://proxy.example/api");

    const sameOrigin = normalizeAiConfig({
      ...base,
      baseUrls: { openai: "https://api.openai.com/proxy" },
    });
    expect(originApproved(sameOrigin, "openai")).toBe(true);
  });

  it("persists a changed default as the active provider model", () => {
    const before = normalizeAiConfig({ provider: "openai", model: "old", models: { openai: "old" } });
    const after = withProviderModel(before, "openai", "new");
    expect(after.model).toBe("new");
    expect(after.models.openai).toBe("new");

    const other = withProviderModel(after, "gemini", "gemini-new");
    expect(other.model).toBe("new");
    expect(other.models.gemini).toBe("gemini-new");
  });

  it("requires keyed Test actions to probe the resolved completion endpoint", () => {
    const go = normalizeAiConfig({ provider: "opencode", model: "minimax-m3" });
    expect(connectionTestProbe(go, "opencode")).toEqual({
      wire: "anthropic",
      model: "minimax-m3",
      baseUrl: "https://opencode.ai/zen/go",
    });
    expect(connectionTestProbe(go, "ollama")).toBeNull();
  });

  it("synchronizes durable saves and fail-closes mounted consumers after write failure", () => {
    const seen: { model: string; share: boolean }[] = [];
    const unsubscribe = aiStore.subscribe((c) => seen.push({ model: c.model, share: c.shareSamples }));
    const config = normalizeAiConfig({ provider: "openai", model: "saved", shareSamples: true });
    expect(aiStore.save(config)).toBe(true);
    storage.failWrite = true;
    expect(aiStore.save({ ...config, model: "lost", shareSamples: true })).toBe(false);
    expect(aiStore.load()).toMatchObject({ model: "lost", shareSamples: false });
    unsubscribe();
    expect(seen).toEqual([
      { model: "saved", share: true },
      { model: "lost", share: false },
    ]);
  });

  it("broadcasts keychain-only changes to mounted consumers", () => {
    const seen: string[] = [];
    const unsubscribe = aiStore.subscribe((c) => seen.push(c.provider));
    aiStore.broadcast(normalizeAiConfig({ provider: "gemini" }));
    unsubscribe();
    expect(seen).toEqual(["gemini"]);
  });
});
