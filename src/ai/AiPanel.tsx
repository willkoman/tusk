import { createSignal, createEffect, For, Show, onMount, type Accessor } from "solid-js";
import { invoke, Channel } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { aiStore, defaultModel, providerModels, providerInfo, AI_PROVIDERS, type AiConfig, type AiProvider, type AiEvent } from "./store";
import { buildSystemPrompt, type AiContext } from "./context";
import { Markdown } from "./markdown";

type ChatMsg = { role: "user" | "assistant"; content: string };

function errMsg(e: unknown): string {
  return e instanceof Object && "message" in e ? String((e as { message: unknown }).message) : String(e);
}

/** AI assistant panel: provider settings (key → OS keychain) + a streaming chat that
 *  knows the connected DB's schema/dialect/permissions. Proposes SQL; never auto-runs. */
export function AiPanel(props: {
  ctx: Accessor<AiContext>;
  onInsertSql: (sql: string) => void;
  onClose: () => void;
}) {
  const [cfg, setCfg] = createSignal<AiConfig>(aiStore.load());
  const [hasKey, setHasKey] = createSignal(false);
  const [keyed, setKeyed] = createSignal<AiProvider[]>([]); // providers with a saved key
  const [keyInput, setKeyInput] = createSignal("");
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [messages, setMessages] = createSignal<ChatMsg[]>([]);
  const [input, setInput] = createSignal("");
  const [streaming, setStreaming] = createSignal(false);
  let msgEl: HTMLDivElement | undefined;

  const setConfig = (patch: Partial<AiConfig>) => {
    const next = { ...cfg(), ...patch };
    setCfg(next);
    aiStore.save(next);
  };
  const refreshKey = async () => setHasKey(await invoke<boolean>("ai_has_key", { provider: cfg().provider }).catch(() => false));
  const refreshKeyed = async () => {
    const checks = await Promise.all(
      AI_PROVIDERS.map((p) => invoke<boolean>("ai_has_key", { provider: p.id }).then((h) => (h ? p.id : null)).catch(() => null)),
    );
    setKeyed(checks.filter((x): x is AiProvider => !!x));
  };

  onMount(() => { void refreshKey(); void refreshKeyed(); });
  // Re-check the current provider's key when it changes; open settings if none keyed yet.
  createEffect(() => { cfg().provider; void refreshKey(); });
  createEffect(() => { if (keyed().length === 0) setSettingsOpen(true); });
  // Keep the message list pinned to the latest as it streams.
  createEffect(() => { messages(); if (msgEl) msgEl.scrollTop = msgEl.scrollHeight; });

  async function saveKey() {
    const k = keyInput().trim();
    if (!k) return;
    await invoke("ai_save_key", { provider: cfg().provider, key: k });
    setKeyInput("");
    await Promise.all([refreshKey(), refreshKeyed()]);
    setSettingsOpen(false);
  }
  async function clearKey() {
    await invoke("ai_clear_key", { provider: cfg().provider });
    await Promise.all([refreshKey(), refreshKeyed()]);
  }

  function appendAssistant(text: string) {
    setMessages((ms) => {
      const next = [...ms];
      const last = next[next.length - 1];
      if (last && last.role === "assistant") next[next.length - 1] = { ...last, content: last.content + text };
      return next;
    });
  }

  async function send(text: string) {
    if (!text.trim() || streaming()) return;
    if (!hasKey()) { setSettingsOpen(true); return; }
    const convo: ChatMsg[] = [...messages(), { role: "user", content: text }];
    setMessages([...convo, { role: "assistant", content: "" }]);
    setInput("");
    setStreaming(true);
    const channel = new Channel<AiEvent>();
    channel.onmessage = (ev) => {
      if (ev.type === "delta") appendAssistant(ev.text);
      else if (ev.type === "error") { appendAssistant(`\n\n⚠️ ${ev.message}`); setStreaming(false); }
      else setStreaming(false);
    };
    try {
      const c = cfg();
      await invoke("ai_chat", {
        req: {
          provider: c.provider,
          model: c.model || defaultModel(c.provider),
          baseUrl: c.baseUrl.trim() || null,
          system: buildSystemPrompt(props.ctx()),
          messages: convo.map((m) => ({ role: m.role, content: m.content })),
          maxTokens: 2048,
        },
        onEvent: channel,
      });
    } catch (e) {
      appendAssistant(`\n\n⚠️ ${errMsg(e)}`);
      setStreaming(false);
    }
  }

  // Quick actions seed the chat; the schema/SQL/error already ride in the system prompt.
  const explain = () => send("Explain what the SQL in my editor does, step by step.");
  const fixError = () => send("My last query errored (see the error in context). Diagnose it and give a corrected query.");

  // Header model picker: every model of every provider that has a key saved, so the model
  // can be switched freely without reopening settings. Current custom model included.
  const headerModels = () =>
    keyed().map((pid) => {
      const info = providerInfo(pid);
      const models = [...info.models];
      if (cfg().provider === pid && cfg().model && !models.includes(cfg().model)) models.unshift(cfg().model);
      return { label: info.label, pid, models };
    });

  return (
    <div class="ai-panel">
      <div class="ai-head">
        <Show
          when={keyed().length > 0}
          fallback={<button class="ai-setup" onClick={() => setSettingsOpen(true)}>✨ Set up a model →</button>}
        >
          <select
            class="ai-model-select"
            title="Model (providers with a saved key)"
            value={`${cfg().provider}|${cfg().model}`}
            onChange={(e) => { const [p, ...rest] = e.currentTarget.value.split("|"); setConfig({ provider: p as AiProvider, model: rest.join("|") }); }}
          >
            <For each={headerModels()}>
              {(g) => <optgroup label={g.label}><For each={g.models}>{(m) => <option value={`${g.pid}|${m}`}>{m}</option>}</For></optgroup>}
            </For>
          </select>
        </Show>
        <span class="spacer" />
        <button class="icon" title="New chat" disabled={messages().length === 0} onClick={() => { setMessages([]); setStreaming(false); }}>✚</button>
        <button class="icon" title="Settings" classList={{ active: settingsOpen() }} onClick={() => setSettingsOpen((v) => !v)}>⚙</button>
        <button class="icon" title="Close" onClick={props.onClose}>✕</button>
      </div>

      <Show when={settingsOpen()}>
        <div class="ai-settings">
          <label>Provider
            <select value={cfg().provider} onChange={(e) => setConfig({ provider: e.currentTarget.value as AiProvider, model: defaultModel(e.currentTarget.value as AiProvider) })}>
              <For each={AI_PROVIDERS}>{(p) => <option value={p.id}>{p.label}</option>}</For>
            </select>
          </label>
          <label>Model
            <select
              value={providerModels(cfg().provider).includes(cfg().model) ? cfg().model : "__custom__"}
              onChange={(e) => { const v = e.currentTarget.value; setConfig({ model: v === "__custom__" ? "" : v }); }}
            >
              <For each={providerModels(cfg().provider)}>{(m) => <option value={m}>{m}</option>}</For>
              <option value="__custom__">Custom…</option>
            </select>
            <Show when={!providerModels(cfg().provider).includes(cfg().model)}>
              <input value={cfg().model} onInput={(e) => setConfig({ model: e.currentTarget.value })} placeholder="custom model id (e.g. for a local / OpenAI-compatible server)" />
            </Show>
          </label>
          <label>API base (optional)<input value={cfg().baseUrl} onInput={(e) => setConfig({ baseUrl: e.currentTarget.value })} placeholder={providerInfo(cfg().provider).baseHint} /></label>
          <label>API key {hasKey() ? <span class="ai-key-ok">saved ✓</span> : <span class="ai-key-missing">not set</span>}
            <input type="password" value={keyInput()} onInput={(e) => setKeyInput(e.currentTarget.value)} placeholder={hasKey() ? "•••••• (stored in keychain)" : "paste key"} />
            <button type="button" class="ai-key-link" onClick={() => void openUrl(providerInfo(cfg().provider).keyUrl)}>Get an API key ↗</button>
          </label>
          <div class="ai-settings-actions">
            <Show when={hasKey()}><button class="ghost" onClick={clearKey}>Clear key</button></Show>
            <span class="spacer" />
            <button class="run" disabled={!keyInput().trim()} onClick={saveKey}>Save key</button>
          </div>
          <div class="ai-note">The key is stored in your OS keychain and used only by the backend — it never reaches the web view.</div>
        </div>
      </Show>

      <div class="ai-messages" ref={msgEl}>
        <Show when={messages().length === 0}>
          <div class="ai-empty">Ask about your schema, generate a query, or explain / optimize the SQL in your editor. Proposed SQL stays read-only until you open + run it.</div>
        </Show>
        <For each={messages()}>
          {(m) => (
            <div class="ai-msg" classList={{ user: m.role === "user", assistant: m.role === "assistant" }}>
              <Show when={m.role === "assistant"} fallback={<div class="ai-msg-body">{m.content}</div>}>
                <Show when={m.content} fallback={<div class="ai-typing"><span /><span /><span /></div>}>
                  <Markdown text={m.content} onInsertSql={props.onInsertSql} />
                </Show>
              </Show>
            </div>
          )}
        </For>
      </div>

      <div class="ai-actions">
        <button class="ghost" disabled={streaming()} onClick={explain}>Explain</button>
        <button class="ghost" disabled={streaming()} onClick={fixError}>Fix error</button>
      </div>
      <form class="ai-input" onSubmit={(e) => { e.preventDefault(); send(input()); }}>
        <input value={input()} onInput={(e) => setInput(e.currentTarget.value)} placeholder={streaming() ? "…streaming" : "Ask the AI…"} disabled={streaming()} />
        <button class="run" type="submit" disabled={streaming() || !input().trim()}>Send</button>
      </form>
    </div>
  );
}
