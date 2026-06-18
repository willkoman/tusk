import { createSignal, createEffect, For, Index, Show, onMount, type Accessor } from "solid-js";
import { invoke, Channel } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { aiStore, defaultModel, providerModels, providerInfo, AI_PROVIDERS, type AiConfig, type AiProvider, type AiEvent } from "./store";
import { buildSystemPrompt, relevantTables, type AiContext, type SampleTable } from "./context";
import { Markdown } from "./markdown";

type ChatMsg = { role: "user" | "assistant"; content: string };

function errMsg(e: unknown): string {
  return e instanceof Object && "message" in e ? String((e as { message: unknown }).message) : String(e);
}

/** AI assistant panel: provider settings (key → OS keychain) + a streaming chat that
 *  knows the connected DB's schema/dialect/permissions. Proposes SQL; never auto-runs. */
export function AiPanel(props: {
  ctx: Accessor<AiContext>;
  /** Fetch a few sample rows for the given relations (read-only; best-effort). */
  sampleRows: (targets: { schema: string; name: string }[]) => Promise<SampleTable[]>;
  onInsertSql: (sql: string) => void;
  onClose: () => void;
}) {
  const [cfg, setCfg] = createSignal<AiConfig>(aiStore.load());
  const [hasKey, setHasKey] = createSignal(false);
  const [keyed, setKeyed] = createSignal<AiProvider[]>([]); // providers with a saved key
  // Live model catalog per provider (fetched via the backend with the keychain key);
  // the curated list in store.ts is only the fallback when the fetch fails.
  const [liveModels, setLiveModels] = createSignal<Partial<Record<AiProvider, string[]>>>({});
  const modelsFor = (pid: AiProvider) => liveModels()[pid] ?? providerModels(pid);
  async function fetchModels(pid: AiProvider) {
    // The base override only applies to the provider it was configured for.
    const baseUrl = cfg().provider === pid ? cfg().baseUrl.trim() || null : null;
    try {
      const list = await invoke<string[]>("ai_list_models", { provider: pid, baseUrl });
      if (list.length) setLiveModels((m) => ({ ...m, [pid]: list }));
    } catch {
      /* keep the curated fallback */
    }
  }
  const [keyInput, setKeyInput] = createSignal("");
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [messages, setMessages] = createSignal<ChatMsg[]>([]);
  const [input, setInput] = createSignal("");
  const [streaming, setStreaming] = createSignal(false);
  let msgEl: HTMLDivElement | undefined;
  let inputEl: HTMLTextAreaElement | undefined;
  // Auto-grow the composer with its content, capped at ~5 lines (CSS max-height
  // does the clamping; scrollHeight keeps growing past it → scrollbar).
  const autoGrow = () => {
    if (!inputEl) return;
    inputEl.style.height = "auto";
    inputEl.style.height = `${inputEl.scrollHeight}px`;
  };

  const setConfig = (patch: Partial<AiConfig>) => {
    const next = { ...cfg(), ...patch };
    setCfg(next);
    aiStore.save(next);
  };
  const refreshKey = async () => setHasKey(await invoke<boolean>("ai_has_key", { provider: cfg().provider }).catch(() => false));
  // First-open routing happens HERE, once the async keychain check resolves: no
  // saved key anywhere → show the setup form (provider/model/key prompt); a key
  // exists → land straight in the chat. Deciding before the check (or in an
  // effect over keyed(), which starts []) wrongly flashed settings open on every
  // panel open even after setup.
  let keysChecked = false;
  const refreshKeyed = async () => {
    const checks = await Promise.all(
      AI_PROVIDERS.map((p) => invoke<boolean>("ai_has_key", { provider: p.id }).then((h) => (h ? p.id : null)).catch(() => null)),
    );
    const list = checks.filter((x): x is AiProvider => !!x);
    setKeyed(list);
    for (const p of list) if (!liveModels()[p]) void fetchModels(p);
    if (!keysChecked) {
      keysChecked = true;
      setSettingsOpen(list.length === 0);
    }
  };

  onMount(() => { void refreshKey(); void refreshKeyed(); });
  // Re-check the current provider's key when it changes.
  createEffect(() => { cfg().provider; void refreshKey(); });
  // Refetch the current provider's models when its base URL changes (debounced —
  // OpenAI-compatible/local servers expose different catalogs per base).
  let modelsTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const p = cfg().provider;
    cfg().baseUrl; // track
    if (!keyed().includes(p)) return;
    clearTimeout(modelsTimer);
    modelsTimer = setTimeout(() => void fetchModels(p), 600);
  });
  // Keep the message list pinned to the latest as it streams — but only while
  // the user is actually AT the bottom. Scrolling up to read releases the pin
  // (no more yank-down per delta); scrolling back to the bottom re-engages it.
  let pinned = true;
  const onMsgScroll = () => {
    if (msgEl) pinned = msgEl.scrollHeight - msgEl.scrollTop - msgEl.clientHeight < 48;
  };
  createEffect(() => { messages(); if (msgEl && pinned) msgEl.scrollTop = msgEl.scrollHeight; });

  async function saveKey() {
    const k = keyInput().trim();
    if (!k) return;
    await invoke("ai_save_key", { provider: cfg().provider, key: k });
    setKeyInput("");
    await Promise.all([refreshKey(), refreshKeyed()]);
    void fetchModels(cfg().provider); // new key may unlock a different catalog
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
    pinned = true; // a fresh send always follows the reply
    setMessages([...convo, { role: "assistant", content: "" }]);
    setInput("");
    queueMicrotask(autoGrow); // collapse the composer back to one line
    setStreaming(true);
    const channel = new Channel<AiEvent>();
    channel.onmessage = (ev) => {
      if (ev.type === "delta") appendAssistant(ev.text);
      else if (ev.type === "error") { appendAssistant(`\n\n⚠️ ${ev.message}`); setStreaming(false); }
      else setStreaming(false);
    };
    try {
      const c = cfg();
      const ctx = props.ctx();
      const convoText = convo.map((m) => m.content).join("\n");
      // Ground the model in real data: fetch a few sample rows of the tables most
      // relevant to the conversation (read-only, best-effort, off if the user opted out).
      let samples: SampleTable[] = [];
      if (c.shareSamples !== false) {
        const targets = relevantTables(ctx.tables, `${convoText} ${ctx.currentSql} ${ctx.selection}`, 5)
          .map((t) => ({ schema: t.schema, name: t.name }));
        if (targets.length) {
          try { samples = await props.sampleRows(targets); } catch { /* best-effort — no samples */ }
        }
      }
      await invoke("ai_chat", {
        req: {
          provider: c.provider,
          model: c.model || defaultModel(c.provider),
          baseUrl: c.baseUrl.trim() || null,
          // Conversation text steers the schema summary: mentioned tables get
          // their full columns even when the schema dump is over budget.
          system: buildSystemPrompt(ctx, convoText, samples),
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
  // can be switched freely without reopening settings. Live catalog when fetched
  // (curated fallback otherwise); the current custom model is always included.
  const headerModels = () =>
    keyed().map((pid) => {
      const models = [...modelsFor(pid)];
      if (cfg().provider === pid && cfg().model && !models.includes(cfg().model)) models.unshift(cfg().model);
      return { label: providerInfo(pid).label, pid, models };
    });
  const curModelValue = () => `${cfg().provider}|${cfg().model}`;

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
            onChange={(e) => { const [p, ...rest] = e.currentTarget.value.split("|"); setConfig({ provider: p as AiProvider, model: rest.join("|") }); }}
          >
            {/* `selected` per option (not `value` on the select): options load async from
                the live catalog, and Solid won't re-apply a select `value` when they arrive —
                so the picker would stick on whatever mounted first. */}
            <For each={headerModels()}>
              {(g) => (
                <optgroup label={g.label}>
                  <For each={g.models}>
                    {(m) => <option value={`${g.pid}|${m}`} selected={curModelValue() === `${g.pid}|${m}`}>{m}</option>}
                  </For>
                </optgroup>
              )}
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
              onChange={(e) => { const v = e.currentTarget.value; setConfig({ model: v === "__custom__" ? "" : v }); }}
            >
              {/* `selected` per option — the model list is fetched async (see header). */}
              <For each={modelsFor(cfg().provider)}>{(m) => <option value={m} selected={cfg().model === m}>{m}</option>}</For>
              <option value="__custom__" selected={!modelsFor(cfg().provider).includes(cfg().model)}>Custom…</option>
            </select>
            <Show when={!modelsFor(cfg().provider).includes(cfg().model)}>
              <input value={cfg().model} onInput={(e) => setConfig({ model: e.currentTarget.value })} placeholder="custom model id (e.g. for a local / OpenAI-compatible server)" />
            </Show>
          </label>
          <label>API base (optional)<input value={cfg().baseUrl} onInput={(e) => setConfig({ baseUrl: e.currentTarget.value })} placeholder={providerInfo(cfg().provider).baseHint} /></label>
          <label class="ai-check" title="Send a few sample rows of relevant tables so the model understands your real data. Real values leave your machine for the provider.">
            <input type="checkbox" checked={cfg().shareSamples !== false} onChange={(e) => setConfig({ shareSamples: e.currentTarget.checked })} />
            Share sample data with the model
          </label>
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

      <div class="ai-messages" ref={msgEl} onScroll={onMsgScroll}>
        <Show when={messages().length === 0}>
          <div class="ai-empty">Ask about your schema, generate a query, or explain / optimize the SQL in your editor. Proposed SQL stays read-only until you open + run it.</div>
        </Show>
        {/* Index, not For: streaming replaces the last message OBJECT per delta —
            For keys on identity and would tear down + rebuild the whole bubble's
            DOM on every chunk; Index keeps the row and patches the text. */}
        <Index each={messages()}>
          {(m) => (
            <div class="ai-msg" classList={{ user: m().role === "user", assistant: m().role === "assistant" }}>
              <Show when={m().role === "assistant"} fallback={<div class="ai-msg-body">{m().content}</div>}>
                <Show when={m().content} fallback={<div class="ai-typing"><span /><span /><span /></div>}>
                  <Markdown text={m().content} onInsertSql={props.onInsertSql} />
                </Show>
              </Show>
            </div>
          )}
        </Index>
      </div>

      <div class="ai-actions">
        <button class="ghost" disabled={streaming()} onClick={explain}>Explain</button>
        <button class="ghost" disabled={streaming()} onClick={fixError}>Fix error</button>
      </div>
      <form class="ai-input" onSubmit={(e) => { e.preventDefault(); send(input()); }}>
        <textarea
          ref={inputEl}
          rows={1}
          value={input()}
          onInput={(e) => { setInput(e.currentTarget.value); autoGrow(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input());
            }
          }}
          placeholder={streaming() ? "…streaming" : "Ask the AI… (Shift+Enter = newline)"}
          disabled={streaming()}
        />
        <button class="run" type="submit" disabled={streaming() || !input().trim()}>Send</button>
      </form>
    </div>
  );
}
