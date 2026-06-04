// AI provider config (non-secret) — persisted in localStorage. The API key is NOT here;
// it lives in the OS keychain via the backend `ai_save_key`/`ai_has_key` commands.

export type AiProvider = "anthropic" | "openai" | "gemini";

export type AiConfig = {
  provider: AiProvider;
  model: string;
  /** Override the API base — OpenAI-compatible / OpenCode / local / proxy. Blank = default. */
  baseUrl: string;
};

// Curated current models per provider (first = default). `Custom…` in the picker still
// lets you type any id — needed for OpenAI-compatible / OpenCode / local servers, and so
// the list never goes stale-locked. Refreshed from provider docs (2026).
export const AI_PROVIDERS: { id: AiProvider; label: string; models: string[]; baseHint: string; keyUrl: string }[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-sonnet-4-5"],
    baseHint: "https://api.anthropic.com",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "openai",
    label: "OpenAI / compatible",
    models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
    baseHint: "https://api.openai.com (or OpenCode / local)",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    models: ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
    baseHint: "https://generativelanguage.googleapis.com",
    keyUrl: "https://aistudio.google.com/apikey",
  },
];

export const providerInfo = (p: AiProvider) => AI_PROVIDERS.find((x) => x.id === p) ?? AI_PROVIDERS[0];
export const providerModels = (p: AiProvider) => providerInfo(p).models;
export const defaultModel = (p: AiProvider) => providerModels(p)[0] ?? "";

const KEY = "tusk.ai.config";

export const aiStore = {
  load(): AiConfig {
    try {
      const r = JSON.parse(localStorage.getItem(KEY) || "");
      if (r && r.provider) return { baseUrl: "", ...r };
    } catch {
      /* ignore */
    }
    return { provider: "anthropic", model: defaultModel("anthropic"), baseUrl: "" };
  },
  save(c: AiConfig) {
    localStorage.setItem(KEY, JSON.stringify(c));
  },
};

// One streamed event from the backend `ai_chat` channel (mirrors ai.rs AiEvent).
export type AiEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };
