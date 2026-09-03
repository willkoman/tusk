import { describe, expect, it } from "vitest";
import {
  AI_PROVIDERS,
  defaultModel,
  modelSupported,
  providerInfo,
  resolveBaseUrl,
  resolveWire,
  type AiProvider,
} from "./providers";

/** How `ai.rs` builds each URL from `baseUrl`. Mirrors `build_request` / `ai_list_models`.
 *  The gemini wire is the odd one: its base carries the version segment, so it appends
 *  `/models/{m}:…` rather than `/v1/…`. */
const chatUrl = (p: AiProvider) => `${resolveBaseUrl(p, "", "openai")}/v1/chat/completions`;
const messagesUrl = (p: AiProvider) => `${resolveBaseUrl(p, "", "anthropic")}/v1/messages`;
const responsesUrl = (p: AiProvider) => `${resolveBaseUrl(p, "", "responses")}/v1/responses`;
const geminiUrl = (p: AiProvider, m: string) =>
  `${resolveBaseUrl(p, "", "gemini")}/models/${m}:streamGenerateContent?alt=sse`;
/** The catalog always lives at the provider's own base — no wire. */
const modelsUrl = (p: AiProvider) => `${resolveBaseUrl(p, "")}/v1/models`;

describe("provider registry", () => {
  it("every provider id is unique (ids are keychain accounts — a collision leaks keys across providers)", () => {
    const ids = AI_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("baseUrl is the prefix BEFORE /v1, so the wire builders produce the documented URLs", () => {
    expect(chatUrl("openai")).toBe("https://api.openai.com/v1/chat/completions");
    // The /openai infix is part of Groq's base, not the path.
    expect(chatUrl("groq")).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(chatUrl("openrouter")).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(chatUrl("ollama")).toBe("http://localhost:11434/v1/chat/completions");
    expect(chatUrl("lmstudio")).toBe("http://localhost:1234/v1/chat/completions");
    expect(messagesUrl("anthropic")).toBe("https://api.anthropic.com/v1/messages");
    expect(responsesUrl("openai")).toBe("https://api.openai.com/v1/responses");
    expect(modelsUrl("openrouter")).toBe("https://openrouter.ai/api/v1/models");
    // Gemini's base carries the version segment; the wire appends `/models/{m}:…`.
    expect(geminiUrl("gemini", "gemini-3.5-flash")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
    );
  });

  it("a stored base override wins over the registry default", () => {
    expect(resolveBaseUrl("openai", "https://proxy.internal")).toBe("https://proxy.internal");
    expect(resolveBaseUrl("openai", "  ")).toBe("https://api.openai.com"); // whitespace ≠ override
  });

  it("keyless providers are exactly the local ones", () => {
    const keyless = AI_PROVIDERS.filter((p) => !p.needsKey).map((p) => p.id);
    expect(keyless.sort()).toEqual(["lmstudio", "ollama"]);
  });

  it("curated fallback lists carry no model with a known near-term shutdown", () => {
    // Regression guard: a stale fallback silently steers users onto a dying id when the
    // live catalog fetch fails. See providers.ts rules.
    const dead = ["deepseek-chat", "deepseek-reasoner", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
    for (const p of AI_PROVIDERS) {
      for (const m of p.models) expect(dead).not.toContain(m);
    }
  });
});

describe("OpenCode Go per-model wire dispatch", () => {
  // Go serves both shapes off ONE base. These are the URLs its docs publish.
  it("serves both shapes off the same base", () => {
    expect(chatUrl("opencode")).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(messagesUrl("opencode")).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(modelsUrl("opencode")).toBe("https://opencode.ai/zen/go/v1/models");
  });

  // The real `GET https://opencode.ai/zen/go/v1/models` response (2026-07), verbatim and
  // in catalog order. Go returns a bare OpenAI list — no endpoint/vendor field — so the id
  // prefix is the ONLY dispatch signal available. This fixture pins the full partition:
  // change `wireFor` and this test names exactly which models you rerouted.
  const GO_CATALOG = [
    "minimax-m3", "minimax-m2.7", "minimax-m2.5",
    "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5",
    "glm-5.2", "glm-5.1", "glm-5",
    "deepseek-v4-pro", "deepseek-v4-flash",
    "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.5-plus",
    "mimo-v2-pro", "mimo-v2-omni", "mimo-v2.5-pro", "mimo-v2.5",
    "hy3-preview",
  ];

  it("partitions the live Go catalog exactly as documented", () => {
    const by = (w: ReturnType<typeof resolveWire>) => GO_CATALOG.filter((m) => resolveWire("opencode", m) === w);

    // /v1/messages — Anthropic-shaped. Go routes MiniMax here; Zen routes it to
    // /chat/completions. Same vendor, different product, different endpoint.
    expect(by("anthropic")).toEqual([
      "minimax-m3", "minimax-m2.7", "minimax-m2.5",
      "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.5-plus",
    ]);

    // /v1/chat/completions — everything else, including `hy3-preview` and the mimo-v2-*
    // ids the docs page never lists. OpenAI-shaped is the right default for a new family.
    expect(by("openai")).toEqual([
      "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5",
      "glm-5.2", "glm-5.1", "glm-5",
      "deepseek-v4-pro", "deepseek-v4-flash",
      "mimo-v2-pro", "mimo-v2-omni", "mimo-v2.5-pro", "mimo-v2.5",
      "hy3-preview",
    ]);

    // Go serves no GPT/Gemini, so unlike Zen nothing is hidden — every model is reachable.
    expect(by(null)).toEqual([]);
    expect(by("anthropic").length + by("openai").length).toBe(GO_CATALOG.length);
  });

  it("every curated OpenCode model exists in the live catalog", () => {
    for (const m of providerInfo("opencode").models) {
      expect(GO_CATALOG).toContain(m);
      expect(modelSupported("opencode", m)).toBe(true);
    }
  });

  it("matches the family case-insensitively and after a vendor namespace", () => {
    expect(resolveWire("opencode", "QWEN3.7-MAX")).toBe("anthropic");
    expect(resolveWire("opencode", "zhipu/glm-5.2")).toBe("openai");
  });

  it("Go and Zen are separate providers and must not be merged", () => {
    // Same vendor, different product, DIFFERENT endpoint: Go serves MiniMax on the
    // Anthropic-shaped /messages; Zen serves it on /chat/completions. A shared `wireFor`
    // would silently send half these requests to the wrong endpoint.
    expect(resolveWire("opencode", "minimax-m3")).toBe("anthropic");
    expect(resolveWire("opencode-zen", "minimax-m3")).toBe("openai");
    // Distinct keychain accounts, so a Go key and a Zen key coexist.
    expect(providerInfo("opencode").id).not.toBe(providerInfo("opencode-zen").id);
  });

  it("providers without a wireFor use their single wire for every model", () => {
    expect(resolveWire("groq", "openai/gpt-oss-120b")).toBe("openai"); // NOT hidden as a gpt-*
    expect(resolveWire("openrouter", "anthropic/claude-opus-4.8")).toBe("openai");
    expect(resolveWire("anthropic", "claude-opus-4-8")).toBe("anthropic");
    expect(resolveWire("gemini", "gemini-3.5-flash")).toBe("gemini");
  });
});

describe("OpenCode Zen — all four wires, nothing hidden", () => {
  it("composes each of Zen's four endpoints off one base", () => {
    expect(chatUrl("opencode-zen")).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(messagesUrl("opencode-zen")).toBe("https://opencode.ai/zen/v1/messages");
    expect(responsesUrl("opencode-zen")).toBe("https://opencode.ai/zen/v1/responses");
    expect(modelsUrl("opencode-zen")).toBe("https://opencode.ai/zen/v1/models");
    // Zen hosts the Gemini shape one segment deeper — `baseForWire` adds it.
    expect(geminiUrl("opencode-zen", "gemini-3.5-flash")).toBe(
      "https://opencode.ai/zen/v1/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
    );
  });

  it("baseForWire composes with a user's custom base override", () => {
    expect(resolveBaseUrl("opencode-zen", "https://zen.proxy.internal", "gemini")).toBe("https://zen.proxy.internal/v1");
    expect(resolveBaseUrl("opencode-zen", "https://zen.proxy.internal", "openai")).toBe("https://zen.proxy.internal");
  });

  // The real `GET https://opencode.ai/zen/v1/models` response (2026-07), verbatim.
  const ZEN_CATALOG = [
    "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
    "claude-opus-4-5", "claude-opus-4-1", "claude-sonnet-5", "claude-sonnet-4-6",
    "claude-sonnet-4-5", "claude-sonnet-4", "claude-haiku-4-5",
    "gemini-3.5-flash", "gemini-3.1-pro", "gemini-3-flash",
    "gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini", "gpt-5.4-nano",
    "gpt-5.3-codex-spark", "gpt-5.3-codex", "gpt-5.2", "gpt-5.2-codex", "gpt-5.1",
    "gpt-5.1-codex-max", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5", "gpt-5-codex",
    "gpt-5-nano",
    "grok-build-0.1", "deepseek-v4-pro", "deepseek-v4-flash",
    "glm-5.2", "glm-5.1", "glm-5",
    "minimax-m3", "minimax-m2.7", "minimax-m2.5",
    "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5",
    "qwen3.6-plus", "qwen3.5-plus",
    "big-pickle", "deepseek-v4-flash-free", "mimo-v2.5-free", "hy3-free",
    "nemotron-3-ultra-free", "north-mini-code-free",
  ];

  it("routes every model in the live Zen catalog to a wire Tusk speaks", () => {
    const by = (w: ReturnType<typeof resolveWire>) => ZEN_CATALOG.filter((m) => resolveWire("opencode-zen", m) === w);

    expect(by("anthropic")).toEqual([ // /v1/messages, x-api-key
      "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
      "claude-opus-4-5", "claude-opus-4-1", "claude-sonnet-5", "claude-sonnet-4-6",
      "claude-sonnet-4-5", "claude-sonnet-4", "claude-haiku-4-5",
      "qwen3.6-plus", "qwen3.5-plus",
    ]);
    expect(by("gemini")).toEqual(["gemini-3.5-flash", "gemini-3.1-pro", "gemini-3-flash"]);
    expect(by("responses")).toEqual([ // /v1/responses — GPT is served nowhere else
      "gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini", "gpt-5.4-nano",
      "gpt-5.3-codex-spark", "gpt-5.3-codex", "gpt-5.2", "gpt-5.2-codex", "gpt-5.1",
      "gpt-5.1-codex-max", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5", "gpt-5-codex",
      "gpt-5-nano",
    ]);
    expect(by("openai")).toEqual([ // /v1/chat/completions
      "grok-build-0.1", "deepseek-v4-pro", "deepseek-v4-flash",
      "glm-5.2", "glm-5.1", "glm-5",
      "minimax-m3", "minimax-m2.7", "minimax-m2.5",
      "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5",
      "big-pickle", "deepseek-v4-flash-free", "mimo-v2.5-free", "hy3-free",
      "nemotron-3-ultra-free", "north-mini-code-free",
    ]);

    // THE POINT: nothing is hidden. Every one of Zen's 50 models is reachable.
    expect(by(null)).toEqual([]);
    expect(ZEN_CATALOG.every((m) => modelSupported("opencode-zen", m))).toBe(true);
    expect(by("anthropic").length + by("gemini").length + by("responses").length + by("openai").length)
      .toBe(ZEN_CATALOG.length);
  });

  it("every curated Zen model exists in the live catalog", () => {
    for (const m of providerInfo("opencode-zen").models) expect(ZEN_CATALOG).toContain(m);
  });
});

describe("fallback model lists", () => {
  it("are flat id lists — no tiers, no ranking, no per-model commentary", () => {
    for (const p of AI_PROVIDERS) {
      for (const m of p.models) expect(typeof m).toBe("string");
      expect(new Set(p.models).size).toBe(p.models.length);
    }
  });

  it("defaultModel picks the first curated model; live-catalog-only providers have none", () => {
    expect(defaultModel("anthropic")).toBe("claude-opus-4-8");
    expect(defaultModel("openrouter")).toBe("");
    expect(providerInfo("ollama").models).toEqual([]);
  });
});
