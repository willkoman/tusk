// AI provider config (non-secret) — persisted in localStorage. The API key is NOT here;
// it lives in the OS keychain via the backend `ai_save_key`/`ai_has_key` commands, keyed
// by provider id. The provider *registry* (labels, wires, base URLs, models) lives in
// `providers.ts`; this file is only persistence + the streamed-event type.

import {
  AI_PROVIDERS,
  defaultModel,
  providerInfo,
  type AiProvider,
} from "./providers";

export type { AiProvider, Wire, Tier, ModelSpec, ProviderSpec } from "./providers";
export {
  AI_PROVIDERS,
  providerInfo,
  providerModels,
  defaultModel,
  resolveWire,
  resolveBaseUrl,
  modelSupported,
  groupByTier,
  tierOf,
  modelNote,
} from "./providers";

export type AiConfig = {
  /** The provider a chat runs against right now. */
  provider: AiProvider;
  /** The model for the active provider. Mirrored into `models[provider]` on every change. */
  model: string;
  /** Remembered model per provider, so switching provider doesn't lose your choice. */
  models: Partial<Record<AiProvider, string>>;
  /** Base-URL override per provider. Blank/absent = the registry default. Keyed per
   *  provider because a single `baseUrl` leaked across a provider switch: point OpenAI at
   *  a local server, switch to Gemini, and Gemini inherited the local server's URL. */
  baseUrls: Partial<Record<AiProvider, string>>;
  /** Send a few sample rows of relevant tables to the model (real values leave your machine). Default on. */
  shareSamples: boolean;
};

/** The active provider's base-URL override ("" = use the registry default). */
export const activeBaseUrl = (c: AiConfig): string => c.baseUrls[c.provider] ?? "";

const KEY = "tusk.ai.config";
const MAX_CONFIG_CHARS = 100_000;

/** Configs written before the provider registry existed used the ids "anthropic",
 *  "openai", and "gemini" — all three are still registry ids with the same keychain
 *  account and the same wire, so a stored config loads unchanged and the saved key is
 *  still found. In particular, an "openai" config with a custom `baseUrl` (the only way
 *  to reach a compatible endpoint before the registry) keeps working exactly as before:
 *  `openai` is still an openai-wire provider with an editable base. Nothing to migrate —
 *  the only guard needed is against a provider id this build doesn't know. */
export function normalizeAiConfig(raw: unknown): AiConfig {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const known = typeof obj.provider === "string" && AI_PROVIDERS.some((p) => p.id === obj.provider);
  const provider = (known ? obj.provider : "anthropic") as AiProvider;
  // A model saved for a provider we fell back off of is meaningless; otherwise the user's
  // model (including a custom id the registry doesn't list) is preserved.
  const model = known && typeof obj.model === "string" ? obj.model.slice(0, 500) : defaultModel(provider);
  // v1 → v2: a single global `baseUrl`/`model` becomes per-provider maps, attributed to
  // the provider that was active when they were saved. Nothing is lost and no key moves.
  const stringMap = (value: unknown, max: number): Partial<Record<AiProvider, string>> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Partial<Record<AiProvider, string>> = {};
    for (const [k, v] of Object.entries(value))
      if (AI_PROVIDERS.some((p) => p.id === k) && typeof v === "string") out[k as AiProvider] = v.slice(0, max);
    return out;
  };
  const models = stringMap(obj.models, 500);
  const baseUrls = stringMap(obj.baseUrls, 2_000);
  if (model && models[provider] === undefined) models[provider] = model;
  if (typeof obj.baseUrl === "string" && baseUrls[provider] === undefined) baseUrls[provider] = obj.baseUrl.slice(0, 2_000);
  return { provider, model, models, baseUrls, shareSamples: obj.shareSamples !== false };
}

export const aiStore = {
  load(): AiConfig {
    try {
      const raw = localStorage.getItem(KEY) || "";
      if (raw.length > MAX_CONFIG_CHARS) throw new Error("AI config is too large");
      const r = JSON.parse(raw);
      if (r && r.provider) return normalizeAiConfig(r);
    } catch {
      /* ignore */
    }
    return { provider: "anthropic", model: defaultModel("anthropic"), models: {}, baseUrls: {}, shareSamples: true };
  },
  save(c: AiConfig): boolean {
    // Keep the per-provider memory in step with the active selection.
    const next = normalizeAiConfig({ ...c, models: { ...c.models, [c.provider]: c.model } });
    try {
      const json = JSON.stringify(next);
      if (json.length > MAX_CONFIG_CHARS) return false;
      localStorage.setItem(KEY, json);
      return true;
    } catch {
      /* localStorage unavailable/full — keep live config in memory */
      return false;
    }
  },
};

/** Whether this provider can be used without an API key (local model servers). */
export const isKeyless = (p: AiProvider) => !providerInfo(p).needsKey;

// One streamed event from the backend `ai_chat` channel (mirrors ai.rs AiEvent).
// `done.truncated` = the model hit its token ceiling mid-reply. `cancelled` = the user
// pressed Stop (`ai_cancel`) — not an error. Exactly one of done/cancelled/error ends a turn.
export type AiEvent =
  | { type: "delta"; text: string }
  | { type: "done"; truncated: boolean }
  | { type: "cancelled" }
  | { type: "error"; message: string };
