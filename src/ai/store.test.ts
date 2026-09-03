import { beforeEach, describe, expect, it } from "vitest";
import {
  activeBaseUrl,
  approvedBaseOverride,
  aiStore,
  connectionTestProbe,
  normalizeAiConfig,
  normalizeModelList,
  originApproved,
  visibleModels,
  withDefaultModel,
  withEnabledModels,
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
      enabledModels: {},
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

describe("curated model allowlists", () => {
  it("normalizes allowlists: known providers, string ids, deduped, bounded, empty dropped", () => {
    const c = normalizeAiConfig({
      provider: "anthropic",
      enabledModels: {
        anthropic: ["a", " a ", "", 7, "b", "x".repeat(501)],
        openai: [],
        bogus: ["z"],
      },
    });
    expect(c.enabledModels).toEqual({ anthropic: ["a", "b"] });
    expect(normalizeModelList(Array.from({ length: 600 }, (_, i) => `m${i}`)).length).toBe(500);
    expect(normalizeAiConfig({ provider: "anthropic", enabledModels: "nope" }).enabledModels).toEqual({});
  });

  it("presents the whole catalog without an allowlist, and filters live catalogs with one", () => {
    const base = normalizeAiConfig({ provider: "openai", model: "gpt-x", models: { openai: "gpt-x" } });
    expect(visibleModels(base, "openai", ["gpt-x", "gpt-y"], ["fallback"])).toEqual(["gpt-x", "gpt-y"]);
    expect(visibleModels(base, "openai", null, ["gpt-x", "fallback"])).toEqual(["gpt-x", "fallback"]);
    const curated = withEnabledModels(base, "openai", ["gpt-y", "gone"]);
    // Live catalog: allowlist ∩ catalog, in catalog order; remembered model re-homed and kept visible.
    expect(curated.models.openai).toBe("gpt-y");
    expect(curated.model).toBe("gpt-y");
    expect(visibleModels(curated, "openai", ["gpt-x", "gpt-y"], ["fallback"])).toEqual(["gpt-y"]);
    // No live catalog: the allowlist itself is fresher than the shipped fallback.
    expect(visibleModels(curated, "openai", null, ["fallback"])).toEqual(["gpt-y", "gone"]);
  });

  it("keeps the remembered model visible and clears an allowlist back to everything", () => {
    const base = normalizeAiConfig({ provider: "openai", model: "custom-id", models: { openai: "custom-id" } });
    const curated = withEnabledModels(base, "openai", ["custom-id", "gpt-y"]);
    expect(curated.model).toBe("custom-id");
    expect(visibleModels(curated, "openai", ["gpt-y"], [])).toEqual(["custom-id", "gpt-y"]);
    const cleared = withEnabledModels(curated, "openai", []);
    expect(cleared.enabledModels).toEqual({});
    expect(cleared.model).toBe("custom-id");
  });

  it("★ default: sets the remembered/active model and adds it to a curated allowlist", () => {
    const base = normalizeAiConfig({ provider: "openai", model: "gpt-x", models: { openai: "gpt-x" } });
    // No allowlist: only the remembered model changes.
    const plain = withDefaultModel(base, "openai", "gpt-y");
    expect(plain.model).toBe("gpt-y");
    expect(plain.enabledModels).toEqual({});
    // Allowlist lacking the new default gains it, so the default is never a hidden model.
    const curated = withEnabledModels(base, "openai", ["gpt-x"]);
    const starred = withDefaultModel(curated, "openai", "gpt-z");
    expect(starred.enabledModels.openai).toEqual(["gpt-x", "gpt-z"]);
    expect(starred.models.openai).toBe("gpt-z");
    expect(starred.model).toBe("gpt-z");
    // Inactive provider: its remembered model moves, the active model does not.
    const other = withDefaultModel(starred, "anthropic", "claude-b");
    expect(other.model).toBe("gpt-z");
    expect(other.models.anthropic).toBe("claude-b");
    // Blank ids are ignored.
    expect(withDefaultModel(starred, "openai", "  ")).toBe(starred);
  });

  it("does not touch another provider's remembered model", () => {
    const base = normalizeAiConfig({ provider: "anthropic", model: "claude-a", models: { anthropic: "claude-a", openai: "gpt-x" } });
    const curated = withEnabledModels(base, "openai", ["gpt-y"]);
    expect(curated.model).toBe("claude-a");
    expect(curated.models.openai).toBe("gpt-y");
  });

  it("round-trips allowlists through storage", () => {
    const c = withEnabledModels(normalizeAiConfig({ provider: "anthropic" }), "anthropic", ["claude-a", "claude-b"]);
    expect(aiStore.save(c)).toBe(true);
    expect(aiStore.load().enabledModels).toEqual({ anthropic: ["claude-a", "claude-b"] });
  });
});
