// AI provider config (non-secret) — persisted in localStorage. The API key is NOT here;
// it lives in the OS keychain via the backend `ai_save_key`/`ai_has_key` commands, keyed
// by provider id. The provider *registry* (labels, wires, base URLs, models) lives in
// `providers.ts`; this file is only persistence + the streamed-event type.

import {
  AI_PROVIDERS,
  defaultModel,
  providerInfo,
  resolveBaseUrl,
  resolveWire,
  type AiProvider,
  type Wire,
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
  /** Origins explicitly approved for provider overrides. The backend independently binds
   *  each key to its approved origin; this map keeps official providers pinned in the UI. */
  approvedOrigins: Partial<Record<AiProvider, string>>;
  /** Send a few sample rows of relevant tables to the model (real values leave your machine). */
  shareSamples: boolean;
  /** Response-token ceiling per AI turn. One knob for every AI surface — the Slack pane
   *  reuses the same normalization so desktop and bot can't drift apart. */
  maxTokens: number;
};

/** Canonical max-tokens normalization for ALL AI surfaces (desktop panel + Slack bot):
 *  positive finite numbers clamp to [256, 128000] and snap to 256-token steps;
 *  anything else takes the fallback. */
export const normalizeMaxTokens = (raw: string | number, fallback = 2048): number => {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  const finite = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.round(Math.max(256, Math.min(128000, finite)) / 256) * 256;
};

/** Canonical HTTP(S) origin, or null for invalid/credential-bearing URLs. */
export function endpointOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function originNeedsConsent(provider: AiProvider, override: string): boolean {
  if (!override.trim()) return false;
  const requested = endpointOrigin(override);
  const shipped = endpointOrigin(providerInfo(provider).baseUrl);
  return !requested || !shipped || requested !== shipped;
}

export function originApproved(c: AiConfig, provider: AiProvider): boolean {
  const override = c.baseUrls[provider] ?? "";
  if (!originNeedsConsent(provider, override)) return true;
  const origin = endpointOrigin(override);
  return !!origin && c.approvedOrigins[provider] === origin;
}

/** Approved override only. Blank pins the provider to its registry default. */
export const approvedBaseOverride = (c: AiConfig, provider: AiProvider): string =>
  originApproved(c, provider) ? c.baseUrls[provider] ?? "" : "";

/** The active provider's requested override. An unapproved value is deliberately kept
 *  here so backend consumers such as Slack fail closed on origin binding instead of
 *  silently rerouting a legacy proxy key and database context to the registry default. */
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
  const approvedOrigins = stringMap(obj.approvedOrigins, 500);
  if (model && models[provider] === undefined) models[provider] = model;
  if (typeof obj.baseUrl === "string" && baseUrls[provider] === undefined) baseUrls[provider] = obj.baseUrl.slice(0, 2_000);
  // Real row values leave the machine. Missing, malformed, and pre-setting values all
  // fail closed; only an explicit persisted `true` enables sharing.
  return {
    provider,
    model,
    models,
    baseUrls,
    approvedOrigins,
    shareSamples: known && obj.shareSamples === true,
    maxTokens: normalizeMaxTokens(
      typeof obj.maxTokens === "number" || typeof obj.maxTokens === "string" ? obj.maxTokens : 2048,
    ),
  };
}

const fallbackConfig = (): AiConfig => ({
  provider: "anthropic",
  model: defaultModel("anthropic"),
  models: {},
  baseUrls: {},
  approvedOrigins: {},
  shareSamples: false,
  maxTokens: 2048,
});

const subscribers = new Set<(config: AiConfig) => void>();
let volatileConfig: AiConfig | null = null;
let volatileStorage: Storage | null = null;
const notify = (config: AiConfig) => {
  for (const listener of subscribers) {
    try { listener(config); } catch { /* one mounted consumer must not poison persistence */ }
  }
};

export const aiStore = {
  load(): AiConfig {
    try {
      if (volatileConfig && volatileStorage === localStorage) return normalizeAiConfig(volatileConfig);
      if (volatileConfig && volatileStorage !== localStorage) {
        volatileConfig = null;
        volatileStorage = null;
      }
      const raw = localStorage.getItem(KEY);
      if (raw === null) return fallbackConfig();
      if (raw.length > MAX_CONFIG_CHARS) throw new Error("AI config is too large");
      const r = JSON.parse(raw);
      if (r && r.provider) return normalizeAiConfig(r);
    } catch {
      // Storage denial/corruption must not silently re-enable sample sharing.
    }
    return fallbackConfig();
  },
  save(c: AiConfig): boolean {
    // Keep the per-provider memory in step with the active selection.
    const next = normalizeAiConfig({ ...c, models: { ...c.models, [c.provider]: c.model } });
    try {
      const json = JSON.stringify(next);
      if (json.length > MAX_CONFIG_CHARS) {
        const safe = { ...next, shareSamples: false };
        volatileConfig = safe;
        volatileStorage = localStorage;
        notify(safe);
        return false;
      }
      localStorage.setItem(KEY, json);
      volatileConfig = null;
      volatileStorage = null;
      notify(next);
      return true;
    } catch {
      // Persistence is unavailable/full. Mounted consumers still receive a fail-closed
      // in-memory config so a stale `true` cannot keep sending real sample values.
      const safe = { ...next, shareSamples: false };
      volatileConfig = safe;
      try {
        volatileStorage = localStorage;
        // Quota failures can leave an older shareSamples:true snapshot behind.
        // Removing it is fail-safe across restart; the in-memory override covers
        // storage backends that reject both operations.
        try { localStorage.removeItem(KEY); } catch { /* in-memory fail-closed state remains */ }
      } catch {
        volatileStorage = null;
      }
      notify(safe);
      return false;
    }
  },
  subscribe(listener: (config: AiConfig) => void): () => void {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  },
  /** Notify mounted AI surfaces after keychain-only changes, which do not write config. */
  broadcast(c: AiConfig): void {
    notify(normalizeAiConfig(c));
  },
};

/** Update one provider's remembered model and its active model when applicable. */
export function withProviderModel(c: AiConfig, provider: AiProvider, model: string): AiConfig {
  return {
    ...c,
    model: c.provider === provider ? model : c.model,
    models: { ...c.models, [provider]: model },
  };
}

export type AiConnectionProbe = { wire: Wire; model: string; baseUrl: string };

/** Keyed connection tests must hit a completion endpoint: some `/models` catalogs are
 *  public and therefore cannot prove that the stored credential works. */
export function connectionTestProbe(c: AiConfig, provider: AiProvider): AiConnectionProbe | null {
  const spec = providerInfo(provider);
  if (!spec.needsKey) return null;
  const model = c.models[provider] ?? defaultModel(provider);
  const wire = resolveWire(provider, model) ?? spec.wire;
  return {
    wire,
    model,
    baseUrl: resolveBaseUrl(provider, approvedBaseOverride(c, provider), wire),
  };
}

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
