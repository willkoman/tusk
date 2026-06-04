// AI provider config (non-secret) — persisted in localStorage. The API key is NOT here;
// it lives in the OS keychain via the backend `ai_save_key`/`ai_has_key` commands.

export type AiProvider = "anthropic" | "openai" | "gemini";

export type AiConfig = {
  provider: AiProvider;
  model: string;
  /** Override the API base — OpenAI-compatible / OpenCode / local / proxy. Blank = default. */
  baseUrl: string;
};

export const AI_PROVIDERS: { id: AiProvider; label: string; defaultModel: string; baseHint: string }[] = [
  { id: "anthropic", label: "Anthropic", defaultModel: "claude-sonnet-4-5", baseHint: "https://api.anthropic.com" },
  { id: "openai", label: "OpenAI / compatible", defaultModel: "gpt-4o", baseHint: "https://api.openai.com (or OpenCode / local)" },
  { id: "gemini", label: "Google Gemini", defaultModel: "gemini-2.0-flash", baseHint: "https://generativelanguage.googleapis.com" },
];

export const defaultModel = (p: AiProvider) => AI_PROVIDERS.find((x) => x.id === p)?.defaultModel ?? "";

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
