// The AI provider registry — the single place a provider is defined.
//
// The backend (`src-tauri/src/ai.rs`) speaks exactly four WIRE protocols and knows
// nothing about provider names. Each has its own path AND its own auth header:
//
//   wire        path                                  auth header
//   ─────────── ───────────────────────────────────── ──────────────────────
//   openai      {base}/v1/chat/completions            Authorization: Bearer
//   responses   {base}/v1/responses                   Authorization: Bearer
//   anthropic   {base}/v1/messages                    x-api-key
//   gemini      {base}/models/{model}:streamGenerate… x-goog-api-key
//
// Everything else — which base URL, which keychain account, which models — lives here.
// **Adding a provider is a row in this file, not a branch in ai.rs.**
//
// `baseUrl` is the prefix the wire appends to, i.e. usually the part BEFORE `/v1` —
// hence `https://api.groq.com/openai`, not `https://api.groq.com/openai/v1`. The gemini
// wire is the exception: its base carries the version segment (`…/v1beta`), because
// gateways host that shape under different version paths. `baseForWire` handles those.
//
// A gateway may serve DIFFERENT wires for different models (both OpenCodes do), which is
// why the wire is resolved per (provider, model) and rides on the request.

/** The request/response shape. Mirrors `ai.rs` `Wire`.
 *  `responses` = OpenAI's `/v1/responses` (typed SSE events, `input`/`instructions`),
 *  which is a different shape from `openai` (`/v1/chat/completions`) — not a variant. */
export type Wire = "anthropic" | "gemini" | "openai" | "responses";

/** Provider id. Doubles as the OS-keychain account name — NEVER renumber or rename an
 *  existing id, or every user's saved key for it becomes unreachable. */
export type AiProvider =
  | "anthropic"
  | "openai"
  | "gemini"
  | "opencode"
  | "opencode-zen"
  | "openrouter"
  | "groq"
  | "ollama"
  | "lmstudio"
  | "custom";

/** Conceptual buckets for the picker. Not a provider concept — purely how we group. */
export type Tier = "flagship" | "balanced" | "fast" | "legacy";

export const TIER_LABELS: Record<Tier, string> = {
  flagship: "Flagship",
  balanced: "Balanced",
  fast: "Fast & cheap",
  legacy: "Older, still widely used",
};
export const TIER_ORDER: Tier[] = ["flagship", "balanced", "fast", "legacy"];

export type ModelSpec = { id: string; tier: Tier; note?: string };

export type ProviderSpec = {
  id: AiProvider;
  label: string;
  /** Wire used for every model, unless `wireFor` overrides per model. */
  wire: Wire;
  /** Default API base (prefix before `/v1`). */
  baseUrl: string;
  /** Placeholder shown in the base-URL field. */
  baseHint: string;
  /** Where the user gets a key. Empty for keyless local servers. */
  keyUrl: string;
  /** Local servers authenticate nothing — the panel must not gate them behind a key. */
  needsKey: boolean;
  /** Curated fallback list. EMPTY = this provider is live-catalog-only (its catalog is
   *  too large, too namespaced, or too user-specific to hardcode meaningfully). */
  models: ModelSpec[];
  /** Per-model wire override. `null` = this provider serves the model on a shape we
   *  don't speak, so hide it from the picker. Only the OpenCode gateways need this. */
  wireFor?: (model: string) => Wire | null;
  /** Some gateways host a wire under a sub-path of their base (OpenCode Zen serves the
   *  Gemini shape under `{base}/v1`). Derived from the RESOLVED base, so a user's custom
   *  base override still composes. */
  baseForWire?: (base: string, wire: Wire) => string;
  note?: string;
};

// Model lists are CURATED FALLBACKS, shown only when the live `/models` fetch fails.
// Rules: (1) never list a model with a known near-term shutdown — the live catalog will
// surface it anyway, and a stale fallback silently steers users onto a dying id;
// (2) exact API id strings only, never marketing names.
export const AI_PROVIDERS: ProviderSpec[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    wire: "anthropic",
    baseUrl: "https://api.anthropic.com",
    baseHint: "https://api.anthropic.com",
    keyUrl: "https://console.anthropic.com/settings/keys",
    needsKey: true,
    models: [
      { id: "claude-opus-4-8", tier: "flagship", note: "Most capable Opus; long-horizon agentic work" },
      { id: "claude-fable-5", tier: "flagship", note: "Most capable overall; premium pricing" },
      { id: "claude-sonnet-5", tier: "balanced", note: "Near-Opus quality at Sonnet cost" },
      { id: "claude-haiku-4-5", tier: "fast", note: "Fastest and cheapest" },
      { id: "claude-opus-4-7", tier: "legacy" },
      { id: "claude-sonnet-4-6", tier: "legacy" },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    wire: "openai",
    baseUrl: "https://api.openai.com",
    baseHint: "https://api.openai.com",
    keyUrl: "https://platform.openai.com/api-keys",
    needsKey: true,
    // The base stays editable: users who reached a compatible endpoint by overriding
    // this provider's base (the only way, before the registry) keep working untouched —
    // same keychain account, same config. New setups should use "custom" instead.
    models: [
      { id: "gpt-5.5", tier: "flagship", note: "Hardest coding + professional work" },
      { id: "gpt-5.5-pro", tier: "flagship", note: "Max effort, price-insensitive" },
      { id: "gpt-5.4", tier: "balanced", note: "Frontier work at half the price" },
      { id: "gpt-5.3-codex", tier: "balanced", note: "Agentic coding" },
      { id: "gpt-5.4-mini", tier: "fast" },
      { id: "gpt-5.4-nano", tier: "fast", note: "Classification, extraction, ranking" },
      { id: "gpt-4.1", tier: "legacy", note: "Smartest non-reasoning; 1M context" },
      { id: "gpt-4o", tier: "legacy" },
    ],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    wire: "gemini",
    // Includes the version segment: the gemini wire builds `{base}/models/{model}:…`,
    // and OpenCode Zen hosts the same shape under a different version path.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    baseHint: "https://generativelanguage.googleapis.com/v1beta",
    keyUrl: "https://aistudio.google.com/apikey",
    needsKey: true,
    // Gemini also exposes an OpenAI-compatible layer at /v1beta/openai/, but the native
    // wire is already implemented and streams identically — no reason to switch.
    // Auth is the `x-goog-api-key` header (Google accepts it; Zen requires it).
    models: [
      { id: "gemini-3.5-flash", tier: "flagship", note: "Google's most intelligent listed model" },
      { id: "gemini-3.1-pro-preview", tier: "flagship", note: "Advanced reasoning (preview)" },
      { id: "gemini-3-flash-preview", tier: "balanced" },
      { id: "gemini-3.1-flash-lite", tier: "fast", note: "Cheapest frontier-class" },
      { id: "gemini-2.5-pro", tier: "legacy", note: "Retires 2026-10-16" },
      { id: "gemini-2.5-flash", tier: "legacy", note: "Retires 2026-10-16" },
    ],
  },
  {
    // OpenCode **Go** (https://opencode.ai/docs/go/) — a flat-rate subscription serving
    // open-source coding models only. The wider **Zen** gateway is a separate row below
    // (separate keychain account): Go and Zen route the same vendor differently — Go
    // serves MiniMax on /messages, Zen on /chat/completions — so they cannot share a
    // `wireFor`. Every model Go offers, Tusk can reach; nothing is hidden.
    id: "opencode", // keychain account — unchanged, so an existing OpenCode key still resolves
    label: "OpenCode Go",
    wire: "openai",
    // Go serves BOTH shapes off one base: /zen/go/v1/chat/completions and /zen/go/v1/messages.
    baseUrl: "https://opencode.ai/zen/go",
    baseHint: "https://opencode.ai/zen/go",
    keyUrl: "https://opencode.ai/auth",
    needsKey: true,
    // Ids verified against a live `GET /zen/go/v1/models` (2026-07). The live catalog wins
    // when the fetch succeeds; note it serves 20 ids while the docs page lists only 14.
    models: [
      { id: "deepseek-v4-pro", tier: "flagship", note: "Hardest reasoning/agentic; 1M context" },
      { id: "qwen3.7-max", tier: "flagship" },
      { id: "minimax-m3", tier: "flagship" },
      { id: "glm-5.2", tier: "balanced" },
      { id: "kimi-k2.7-code", tier: "balanced", note: "Coding" },
      { id: "qwen3.7-plus", tier: "balanced" },
      { id: "mimo-v2.5-pro", tier: "balanced" },
      { id: "deepseek-v4-flash", tier: "fast", note: "Cheap, high-volume" },
      { id: "minimax-m2.5", tier: "fast" },
      { id: "glm-5.1", tier: "legacy" },
      { id: "kimi-k2.6", tier: "legacy" },
    ],
    // Go routes each family to a different endpoint, and `/v1/models` is a bare OpenAI list
    // (`{id, object, created, owned_by:"opencode"}`) with NO endpoint or vendor field — so
    // the id prefix is the only dispatch signal that exists. Ids are bare (`glm-5.2`, not
    // `zhipu/glm-5.2`). `providers.test.ts` pins the partition against the live catalog.
    // NB Go's routing differs from Zen's: Go serves MiniMax on /messages, Zen on /chat/completions.
    wireFor: (model) => {
      const bare = bareModel(model);
      // /v1/messages — Anthropic-shaped (reads x-api-key, like Anthropic proper).
      if (bare.startsWith("minimax") || bare.startsWith("qwen")) return "anthropic";
      // /v1/chat/completions — OpenAI-shaped (reads Authorization: Bearer).
      return "openai"; // glm, kimi, deepseek, mimo, hy3, …
    },
    note: "Flat-rate access to open-source coding models. For frontier models through OpenCode, use OpenCode Zen.",
  },
  {
    // OpenCode **Zen** (https://opencode.ai/docs/zen/) — the full gateway: frontier labs
    // AND open models, on ONE key. Every family is reachable because Tusk speaks all four
    // shapes Zen serves. Each endpoint authenticates differently (probed 2026-07):
    //   /v1/chat/completions  Bearer          openai wire
    //   /v1/responses         Bearer          responses wire   (GPT lives only here)
    //   /v1/messages          x-api-key       anthropic wire
    //   /v1/models/{m}:…      x-goog-api-key  gemini wire, hosted under {base}/v1
    id: "opencode-zen",
    label: "OpenCode Zen",
    wire: "openai", // default + the wire used for the /v1/models catalog
    baseUrl: "https://opencode.ai/zen",
    baseHint: "https://opencode.ai/zen",
    keyUrl: "https://opencode.ai/auth",
    needsKey: true,
    // A curated cross-section; the live 50-model catalog wins when the fetch succeeds.
    models: [
      { id: "claude-opus-4-8", tier: "flagship" },
      { id: "claude-fable-5", tier: "flagship", note: "Most capable; premium pricing" },
      { id: "gpt-5.5", tier: "flagship", note: "Served on /responses" },
      { id: "gemini-3.5-flash", tier: "flagship" },
      { id: "deepseek-v4-pro", tier: "flagship", note: "1M context" },
      { id: "claude-sonnet-5", tier: "balanced" },
      { id: "gpt-5.4", tier: "balanced" },
      { id: "glm-5.2", tier: "balanced" },
      { id: "kimi-k2.7-code", tier: "balanced", note: "Coding" },
      { id: "grok-build-0.1", tier: "balanced", note: "Agentic software engineering" },
      { id: "claude-haiku-4-5", tier: "fast" },
      { id: "gpt-5.4-nano", tier: "fast" },
      { id: "deepseek-v4-flash", tier: "fast" },
    ],
    // Zen's `/v1/models` is a bare OpenAI list (`{id, object, created, owned_by}`) with no
    // endpoint or vendor field, so the id prefix is the only dispatch signal that exists.
    // Ids are bare (`claude-sonnet-5`, not `anthropic/…`). `providers.test.ts` pins the
    // partition against the real 50-model catalog. NB Zen routes MiniMax to
    // /chat/completions; OpenCode **Go** routes it to /messages. Do not merge these.
    wireFor: (model) => {
      const bare = bareModel(model);
      if (bare.startsWith("claude") || bare.startsWith("qwen")) return "anthropic";
      if (bare.startsWith("gpt")) return "responses";
      if (bare.startsWith("gemini")) return "gemini";
      return "openai"; // deepseek, glm, kimi, grok, minimax, mimo, nemotron, big-pickle, …
    },
    // Zen hosts the Gemini shape one segment deeper: {base}/v1/models/{model}:…
    baseForWire: (base, wire) => (wire === "gemini" ? `${base}/v1` : base),
    note: "One key for frontier and open models. Tusk speaks all four API shapes Zen serves, so every model in your plan is available.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    wire: "openai",
    baseUrl: "https://openrouter.ai/api",
    baseHint: "https://openrouter.ai/api",
    keyUrl: "https://openrouter.ai/keys",
    needsKey: true,
    models: [], // hundreds of vendor-namespaced ids — the live catalog is the only sane source
    note: "One key, most models. Ids are vendor-namespaced (anthropic/…, openai/…).",
  },
  {
    id: "groq",
    label: "Groq",
    wire: "openai",
    // Note the /openai infix: it's part of the base, not the path.
    baseUrl: "https://api.groq.com/openai",
    baseHint: "https://api.groq.com/openai",
    keyUrl: "https://console.groq.com/keys",
    needsKey: true,
    models: [
      { id: "openai/gpt-oss-120b", tier: "flagship", note: "Groq's de-facto default" },
      { id: "openai/gpt-oss-20b", tier: "fast", note: "Cheap reasoning, high throughput" },
      { id: "qwen/qwen3.6-27b", tier: "balanced", note: "Agentic coding (preview)" },
    ],
    // Groq's Llama line (llama-3.3-70b-versatile, llama-3.1-8b-instant) shuts down
    // 2026-08-16 — deliberately absent from this fallback. See the rules above.
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    wire: "openai",
    baseUrl: "http://localhost:11434",
    baseHint: "http://localhost:11434",
    keyUrl: "",
    needsKey: false,
    models: [], // whatever the user has `ollama pull`ed
    note: "Runs on your machine — no key, and nothing leaves the box.",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    wire: "openai",
    baseUrl: "http://localhost:1234",
    baseHint: "http://localhost:1234 (port is configurable)",
    keyUrl: "",
    needsKey: false,
    models: [],
    note: "Runs on your machine — no key, and nothing leaves the box.",
  },
  {
    id: "custom",
    label: "OpenAI-compatible (custom)",
    wire: "openai",
    baseUrl: "",
    baseHint: "https://your-proxy.example.com  (prefix before /v1)",
    keyUrl: "",
    needsKey: true,
    models: [],
    note: "Any server exposing /v1/chat/completions. Enter the prefix before /v1.",
  },
];

/** Strip a vendor namespace: `anthropic/claude-opus-4.8` → `claude-opus-4.8`. */
function bareModel(model: string): string {
  const i = model.lastIndexOf("/");
  const bare = i >= 0 ? model.slice(i + 1) : model;
  return bare.toLowerCase();
}

export const providerInfo = (p: AiProvider): ProviderSpec =>
  AI_PROVIDERS.find((x) => x.id === p) ?? AI_PROVIDERS[0];

/** The wire to use for this provider+model. `null` = the provider can't serve it here. */
export const resolveWire = (p: AiProvider, model: string): Wire | null => {
  const spec = providerInfo(p);
  return spec.wireFor ? spec.wireFor(model) : spec.wire;
};

/** A model the provider serves on a shape we speak. */
export const modelSupported = (p: AiProvider, model: string): boolean =>
  !!model && resolveWire(p, model) !== null;

/** The concrete base URL: the user's override, else the registry default, adjusted for
 *  the wire when the provider hosts that wire under a sub-path. Pass `wire` for a chat
 *  request; omit it for the model catalog (which always lives at the provider's base). */
export const resolveBaseUrl = (p: AiProvider, override: string, wire?: Wire): string => {
  const spec = providerInfo(p);
  const base = override.trim() || spec.baseUrl;
  return wire && spec.baseForWire ? spec.baseForWire(base, wire) : base;
};

export const providerModels = (p: AiProvider): string[] => providerInfo(p).models.map((m) => m.id);

export const defaultModel = (p: AiProvider): string => providerModels(p)[0] ?? "";

/** Tier of a known model; `undefined` for anything only the live catalog knows about. */
export const tierOf = (p: AiProvider, model: string): Tier | undefined =>
  providerInfo(p).models.find((m) => m.id === model)?.tier;

export const modelNote = (p: AiProvider, model: string): string | undefined =>
  providerInfo(p).models.find((m) => m.id === model)?.note;

/** Group a model list into tier buckets for the picker. Models the registry doesn't
 *  know (live-catalog ids) fall into a trailing "Other" group, preserving input order. */
export function groupByTier(
  p: AiProvider,
  models: string[],
): { label: string; models: string[] }[] {
  const buckets = new Map<string, string[]>();
  const other: string[] = [];
  for (const id of models) {
    const t = tierOf(p, id);
    if (!t) {
      other.push(id);
      continue;
    }
    const list = buckets.get(t) ?? [];
    list.push(id);
    buckets.set(t, list);
  }
  const out = TIER_ORDER.filter((t) => buckets.get(t)?.length).map((t) => ({
    label: TIER_LABELS[t],
    models: buckets.get(t)!,
  }));
  // A provider with no curated tiers (routers, local) renders as one flat group.
  if (other.length) out.push({ label: out.length ? "Other" : "Models", models: other });
  return out;
}
