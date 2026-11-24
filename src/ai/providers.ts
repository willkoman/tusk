// The AI provider registry — the single place a provider is defined.
//
// The backend (`src-tauri/src/ai.rs`) speaks exactly five WIRE protocols and knows
// nothing about provider names. Each has its own path AND its own auth header:
//
//   wire        path                                  auth header
//   ─────────── ───────────────────────────────────── ──────────────────────
//   openai      {base}/v1/chat/completions            Authorization: Bearer
//   responses   {base}/v1/responses                   Authorization: Bearer
//   anthropic   {base}/v1/messages                    x-api-key
//   gemini      {base}/models/{model}:streamGenerate… x-goog-api-key
//   bedrock     {base}/model/{model}/converse-stream  Authorization: Bearer (Bedrock API key)
//
// `bedrock` is the one wire that knows its provider: a Bedrock id prefixed `mantle/` goes
// to the region's Mantle endpoint instead, on whichever of Mantle's three routes
// (chat-completions, Responses, Messages) serves it — see `MantleRoute` in ai.rs.
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
export type Wire = "anthropic" | "gemini" | "openai" | "responses" | "bedrock";

/** Provider id. Doubles as the OS-keychain account name — NEVER renumber or rename an
 *  existing id, or every user's saved key for it becomes unreachable. */
export type AiProvider =
  | "anthropic"
  | "openai"
  | "gemini"
  | "bedrock"
  | "opencode"
  | "opencode-zen"
  | "openrouter"
  | "groq"
  | "ollama"
  | "lmstudio"
  | "custom";

export type ProviderSpec = {
  id: AiProvider;
  label: string;
  /** The name under the provider's mark in the Settings grid (short enough for a tile). */
  short: string;
  /** One line under the name in the grid: what kind of provider this is. */
  kind: string;
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
  /** Curated fallback ids, in the order the picker lists them (the first is the initial
   *  default). Deliberately NO ranking, tier, or commentary: which model is "best" is the
   *  user's call, made in Settings → AI from the live catalog. EMPTY = this provider is
   *  live-catalog-only (its catalog is too large, too namespaced, or too user-specific
   *  to hardcode meaningfully). */
  models: string[];
  /** Per-model wire override. `null` = this provider serves the model on a shape we
   *  don't speak, so hide it from the picker. Only the OpenCode gateways need this. */
  wireFor?: (model: string) => Wire | null;
  /** Some gateways host a wire under a sub-path of their base (OpenCode Zen serves the
   *  Gemini shape under `{base}/v1`). Derived from the RESOLVED base, so a user's custom
   *  base override still composes. */
  baseForWire?: (base: string, wire: Wire) => string;
  /** Region-scoped providers (Bedrock): the regions offered in Settings, and the API base
   *  for one. Picking a region writes that base as the provider's override. */
  regions?: readonly string[];
  regionBase?: (region: string) => string;
  /** The region an API base points at, or null for anything else (a proxy, a VPC endpoint). */
  regionOf?: (base: string) => string | null;
  /** Origins besides the default `baseUrl`'s that the registry itself ships, so a key may
   *  be bound to them without the custom-origin approval (every Bedrock region's AWS
   *  endpoint). Mirrors `shipped_origin` in `ai.rs`. */
  isShippedOrigin?: (origin: string) => boolean;
  /** A short label for the kind of id a model is (Bedrock: which plane serves it, and
   *  through what), shown beside it in the model list. Absent = no label. */
  modelGroup?: (model: string) => string;
  note?: string;
};

/** AWS regions offered for Bedrock. Picking one only builds the endpoint URL; the backend
 *  trusts any well-formed `bedrock-runtime.<region>.amazonaws.com`, so a region missing
 *  here can still be typed into the API base field. */
export const BEDROCK_REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "ca-central-1", "ca-west-1", "mx-central-1", "sa-east-1",
  "eu-central-1", "eu-central-2", "eu-north-1", "eu-south-1", "eu-south-2",
  "eu-west-1", "eu-west-2", "eu-west-3",
  "ap-east-2", "ap-northeast-1", "ap-northeast-2", "ap-northeast-3",
  "ap-south-1", "ap-south-2", "ap-southeast-1", "ap-southeast-2", "ap-southeast-3",
  "ap-southeast-4", "ap-southeast-5", "ap-southeast-7",
  "me-central-1", "me-south-1", "il-central-1", "af-south-1",
  "us-gov-east-1", "us-gov-west-1",
] as const;

/** Regions where Bedrock's Mantle endpoint answered when probed (2026-11). Elsewhere the
 *  catalog holds runtime models only. A hint for Settings, never a gate: the backend always
 *  asks Mantle and tolerates its absence. */
export const BEDROCK_MANTLE_REGIONS: readonly string[] = ["us-east-1", "us-west-2", "us-gov-west-1"];

/** Marks a Bedrock model id as a Mantle id. Mirrors `MANTLE_PREFIX` in ai.rs. */
export const MANTLE_PREFIX = "mantle/";

const AWS_REGION = /^[a-z]+(-[a-z0-9]+)+-[0-9]+$/;

export type BedrockHost = { plane: "runtime" | "mantle"; fips: boolean; region: string };

/** AWS's own Bedrock inference host — the runtime
 *  `https://bedrock-runtime[-fips].<region>.amazonaws.com` or Mantle
 *  `https://bedrock-mantle.<region>.api.aws` — on the default port, else null. A VPC
 *  endpoint or proxy is not AWS's host and stays a custom origin. Mirrors `bedrock_host`
 *  in `ai.rs`. */
export function bedrockHost(value: string): BedrockHost | null {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const runtime = /^bedrock-runtime(-fips)?\.([^.]+)\.amazonaws\.com$/.exec(host);
  const mantle = /^bedrock-mantle\.([^.]+)\.api\.aws$/.exec(host);
  const region = runtime?.[2] ?? mantle?.[1];
  if (!region || region.length > 32 || !AWS_REGION.test(region)) return null;
  return runtime
    ? { plane: "runtime", fips: !!runtime[1], region }
    : { plane: "mantle", fips: false, region };
}

/** The region of AWS's own Bedrock RUNTIME endpoint, else null. */
export function bedrockRuntimeRegion(value: string): string | null {
  const h = bedrockHost(value);
  return h?.plane === "runtime" ? h.region : null;
}

/** The Mantle endpoint the backend derives from a Bedrock base (none for FIPS or a
 *  proxy). Mirrors `bedrock_mantle_base` in ai.rs. */
export function bedrockMantleBase(base: string): string | null {
  const h = bedrockHost(base);
  return h && !h.fips ? `https://bedrock-mantle.${h.region}.api.aws` : null;
}

/** The scopes a system inference profile id starts with (`us.anthropic.…`). A fixed list,
 *  because vendor prefixes look alike (`zai.glm-4.7` and `xai.grok-4.3` are models). */
const BEDROCK_PROFILE_SCOPES = ["global", "us-gov", "us", "eu", "apac", "jp", "au", "ca", "uk", "in", "kr", "mx", "sa", "me", "af"];

/** What kind of Bedrock id a model is: a Mantle id, a cross-region inference profile
 *  (`global.`, or a geography such as `us.`/`eu.`/`apac.`), an application profile or
 *  other ARN, or a model invoked in its own region. */
export function bedrockModelGroup(model: string): string {
  if (model.startsWith(MANTLE_PREFIX)) return "Mantle";
  if (model.startsWith("arn:")) return model.includes(":application-inference-profile/") ? "App profile" : "ARN";
  const scope = BEDROCK_PROFILE_SCOPES.find((x) => model.startsWith(`${x}.`));
  if (scope === "global") return "Global profile";
  if (scope) return `${scope.toUpperCase()} profile`;
  return "In-region";
}

// Model lists are CURATED FALLBACKS, shown only when the live `/models` fetch fails.
// Rules: (1) never list a model with a known near-term shutdown — the live catalog will
// surface it anyway, and a stale fallback silently steers users onto a dying id;
// (2) exact API id strings only, never marketing names.
export const AI_PROVIDERS: ProviderSpec[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    short: "Anthropic",
    kind: "Claude, direct",
    wire: "anthropic",
    baseUrl: "https://api.anthropic.com",
    baseHint: "https://api.anthropic.com",
    keyUrl: "https://console.anthropic.com/settings/keys",
    needsKey: true,
    models: [
      "claude-opus-4-8",
      "claude-fable-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    short: "OpenAI",
    kind: "GPT, direct",
    wire: "openai",
    baseUrl: "https://api.openai.com",
    baseHint: "https://api.openai.com",
    keyUrl: "https://platform.openai.com/api-keys",
    needsKey: true,
    // The base stays editable: users who reached a compatible endpoint by overriding
    // this provider's base (the only way, before the registry) keep working untouched —
    // same keychain account, same config. New setups should use "custom" instead.
    models: [
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-4.1", // Smartest non-reasoning; 1M context
      "gpt-4o",
    ],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    short: "Gemini",
    kind: "Google AI Studio",
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
      "gemini-3.5-flash",
      "gemini-3.1-pro-preview",
      "gemini-3-flash-preview",
      "gemini-3.1-flash-lite",
      "gemini-2.5-pro", // Retires 2026-10-16
      "gemini-2.5-flash", // Retires 2026-10-16
    ],
  },
  {
    // Amazon Bedrock, natively, on BOTH of its inference planes with ONE Bedrock API key
    // (Bearer) and one region:
    //   runtime  bedrock-runtime.<region>.amazonaws.com — Converse. Every model Bedrock
    //            hosts, by Bedrock's own ids: a system inference profile (`us.anthropic.…`,
    //            `global.…`), a foundation model id, or an application-profile ARN.
    //            Listed from the control plane (ListInferenceProfiles + ListFoundationModels).
    //   Mantle   bedrock-mantle.<region>.api.aws — Bedrock's OpenAI/Anthropic-compatible
    //            engine, with its own unversioned ids and `/v1/models`. Tusk lists those as
    //            `mantle/<id>`, and the backend picks the route (chat-completions, the
    //            partner Responses route, or Anthropic Messages) per model.
    // Both catalogs reflect the region and account, hence no hardcoded fallback.
    id: "bedrock",
    label: "Amazon Bedrock",
    short: "Bedrock",
    kind: "AWS, all models",
    wire: "bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    baseHint: "https://bedrock-runtime.us-east-1.amazonaws.com",
    keyUrl: "https://console.aws.amazon.com/bedrock/home#/api-keys",
    needsKey: true,
    models: [],
    regions: BEDROCK_REGIONS,
    regionBase: (region) => `https://bedrock-runtime.${region}.amazonaws.com`,
    regionOf: (base) => bedrockRuntimeRegion(base),
    isShippedOrigin: (origin) => bedrockHost(origin) !== null,
    modelGroup: bedrockModelGroup,
    note: "One Bedrock API key reaches both of the region's inference planes: the runtime and Mantle.",
  },
  {
    // OpenCode **Go** (https://opencode.ai/docs/go/) — a flat-rate subscription serving
    // open-source coding models only. The wider **Zen** gateway is a separate row below
    // (separate keychain account): Go and Zen route the same vendor differently — Go
    // serves MiniMax on /messages, Zen on /chat/completions — so they cannot share a
    // `wireFor`. Every model Go offers, Tusk can reach; nothing is hidden.
    id: "opencode", // keychain account — unchanged, so an existing OpenCode key still resolves
    label: "OpenCode Go",
    short: "OpenCode Go",
    kind: "Open models",
    wire: "openai",
    // Go serves BOTH shapes off one base: /zen/go/v1/chat/completions and /zen/go/v1/messages.
    baseUrl: "https://opencode.ai/zen/go",
    baseHint: "https://opencode.ai/zen/go",
    keyUrl: "https://opencode.ai/auth",
    needsKey: true,
    // Ids verified against a live `GET /zen/go/v1/models` (2026-07). The live catalog wins
    // when the fetch succeeds; note it serves 20 ids while the docs page lists only 14.
    models: [
      "deepseek-v4-pro", // Hardest reasoning/agentic; 1M context
      "qwen3.7-max",
      "minimax-m3",
      "glm-5.2",
      "kimi-k2.7-code",
      "qwen3.7-plus",
      "mimo-v2.5-pro",
      "deepseek-v4-flash",
      "minimax-m2.5",
      "glm-5.1",
      "kimi-k2.6",
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
    note: "Flat-rate access to open-source coding models. Frontier models are in OpenCode Zen.",
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
    short: "OpenCode Zen",
    kind: "One-key gateway",
    wire: "openai", // default + the wire used for the /v1/models catalog
    baseUrl: "https://opencode.ai/zen",
    baseHint: "https://opencode.ai/zen",
    keyUrl: "https://opencode.ai/auth",
    needsKey: true,
    // A curated cross-section; the live 50-model catalog wins when the fetch succeeds.
    models: [
      "claude-opus-4-8",
      "claude-fable-5",
      "gpt-5.5", // Served on /responses
      "gemini-3.5-flash",
      "deepseek-v4-pro", // 1M context
      "claude-sonnet-5",
      "gpt-5.4",
      "glm-5.2",
      "kimi-k2.7-code",
      "grok-build-0.1",
      "claude-haiku-4-5",
      "gpt-5.4-nano",
      "deepseek-v4-flash",
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
    note: "One key for frontier and open models.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    short: "OpenRouter",
    kind: "Model router",
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
    short: "Groq",
    kind: "Fast inference",
    wire: "openai",
    // Note the /openai infix: it's part of the base, not the path.
    baseUrl: "https://api.groq.com/openai",
    baseHint: "https://api.groq.com/openai",
    keyUrl: "https://console.groq.com/keys",
    needsKey: true,
    models: [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "qwen/qwen3.6-27b",
    ],
    // Groq's Llama line (llama-3.3-70b-versatile, llama-3.1-8b-instant) shuts down
    // 2026-08-16 — deliberately absent from this fallback. See the rules above.
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    short: "Ollama",
    kind: "Runs locally",
    wire: "openai",
    baseUrl: "http://localhost:11434",
    baseHint: "http://localhost:11434",
    keyUrl: "",
    needsKey: false,
    models: [], // whatever the user has `ollama pull`ed
    note: "Runs on your machine. No key needed.",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    short: "LM Studio",
    kind: "Runs locally",
    wire: "openai",
    baseUrl: "http://localhost:1234",
    baseHint: "http://localhost:1234",
    keyUrl: "",
    needsKey: false,
    models: [],
    note: "Runs on your machine. No key needed.",
  },
  {
    id: "custom",
    label: "OpenAI-compatible (custom)",
    short: "Custom",
    kind: "Any /v1 server",
    wire: "openai",
    baseUrl: "",
    baseHint: "https://your-proxy.example.com",
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

export const providerModels = (p: AiProvider): string[] => [...providerInfo(p).models];

export const defaultModel = (p: AiProvider): string => providerModels(p)[0] ?? "";
