import { createSignal, createEffect, For, Index, Show, onMount, type Accessor } from "solid-js";
import { invoke, Channel } from "@tauri-apps/api/core";
import {
  aiStore, activeBaseUrl, defaultModel, providerModels, providerInfo, AI_PROVIDERS, isKeyless,
  resolveWire, resolveBaseUrl, modelSupported, groupByTier, modelNote,
  type AiConfig, type AiProvider, type AiEvent,
} from "./store";
import { buildSystemPrompt, relevantTables, type AiContext, type SampleTable } from "./context";
import { Markdown } from "./markdown";

/** A turn's outcome lives on the message, NOT in its `content` — an error appended to the
 *  text would be replayed to the provider as part of the conversation on the next send. */
type ChatMsg = {
  role: "user" | "assistant";
  content: string;
  /** The turn failed (provider error, dropped stream, empty reply). Retryable. */
  error?: string;
  /** The turn was stopped by the user. Retryable. */
  cancelled?: boolean;
  /** The model hit its token ceiling — the reply is cut short. */
  truncated?: boolean;
};

function errMsg(e: unknown): string {
  return e instanceof Object && "message" in e ? String((e as { message: unknown }).message) : String(e);
}

const newRequestId = () =>
  globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Automatic restarts of a turn that died mid-stream, per user turn. After these are
 *  spent the message keeps its error and the manual Retry button takes over. */
const AUTO_RETRY_BUDGET = 1;

/** AI assistant panel: provider settings (key → OS keychain) + a streaming chat that
 *  knows the connected DB's schema/dialect/permissions. Proposes SQL; never auto-runs. */
export function AiPanel(props: {
  ctx: Accessor<AiContext>;
  /** Fetch a few sample rows for the given relations (read-only; best-effort). */
  sampleRows: (targets: { schema: string; name: string }[]) => Promise<SampleTable[]>;
  /** Prime the FK graph before the first send (best-effort; the prompt stays silent
   *  about foreign keys if it never lands, rather than claiming there are none). */
  ensureFks?: () => Promise<void>;
  /** Open Settings → AI (provider cards, keys, skills). */
  onOpenSettings: () => void;
  /** Docked panel width in px (resizable by the splitter on its left edge). */
  width: number;
  onInsertSql: (sql: string) => void;
  onClose: () => void;
}) {
  const [cfg, setCfg] = createSignal<AiConfig>(aiStore.load());
  const [hasKey, setHasKey] = createSignal(false);
  const [keyed, setKeyed] = createSignal<AiProvider[]>([]); // providers with a saved key
  // Live model catalog per provider (fetched via the backend with the keychain key);
  // the curated list in store.ts is only the fallback when the fetch fails.
  const [liveModels, setLiveModels] = createSignal<Partial<Record<AiProvider, string[]>>>({});
  /** Live catalog when we have one, else the registry's curated fallback — minus any
   *  model this provider serves on a wire we don't speak (`wireFor` → null). Both
   *  OpenCode gateways are fully covered today, so nothing is filtered in practice. */
  const modelsFor = (pid: AiProvider) =>
    (liveModels()[pid] ?? providerModels(pid)).filter((m) => modelSupported(pid, m));
  async function fetchModels(pid: AiProvider) {
    // The base override only applies to the provider it was configured for; every other
    // provider is fetched at its registry default.
    const override = cfg().baseUrls[pid] ?? "";
    const spec = providerInfo(pid);
    const baseUrl = resolveBaseUrl(pid, override);
    if (!baseUrl) return; // no default, no override — never let the backend guess (see runTurn)
    try {
      const list = await invoke<string[]>("ai_list_models", {
        provider: pid,
        wire: spec.wire,
        baseUrl,
        allowNoKey: !spec.needsKey,
      });
      if (list.length) setLiveModels((m) => ({ ...m, [pid]: list }));
    } catch {
      /* keep the curated fallback */
    }
  }
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
  // A keyless local server is always "ready" — never gate it behind the key prompt.
  const providerReady = async (p: AiProvider) =>
    isKeyless(p) || (await invoke<boolean>("ai_has_key", { provider: p }).catch(() => false));
  const refreshKey = async () => setHasKey(await providerReady(cfg().provider));
  // First-open routing happens HERE, once the async keychain check resolves: no
  // saved key anywhere → show the setup form (provider/model/key prompt); a key
  // exists → land straight in the chat. Deciding before the check (or in an
  // effect over keyed(), which starts []) wrongly flashed settings open on every
  // panel open even after setup.
  const refreshKeyed = async () => {
    const checks = await Promise.all(
      AI_PROVIDERS.map((p) => providerReady(p.id).then((ok) => (ok ? p.id : null))),
    );
    const list = checks.filter((x): x is AiProvider => !!x);
    setKeyed(list);
    // Keyless providers are "ready" but may have no server running — fetching their
    // catalog is what actually tells us, and a failure just leaves them empty.
    for (const p of list) if (!liveModels()[p]) void fetchModels(p);
    // First-run routing: with no provider set up, the header shows "✨ Set up a model →"
    // which opens Settings → AI. No drawer to flash open.
  };

  onMount(() => { void refreshKey(); void refreshKeyed(); });
  // Re-check the current provider's key when it changes.
  createEffect(() => { cfg().provider; void refreshKey(); });
  // Refetch the current provider's models when its base URL changes (debounced —
  // OpenAI-compatible/local servers expose different catalogs per base).
  let modelsTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const p = cfg().provider;
    cfg().baseUrls[p]; // track
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

  function appendAssistant(text: string) {
    setMessages((ms) => {
      const next = [...ms];
      const last = next[next.length - 1];
      if (last && last.role === "assistant") next[next.length - 1] = { ...last, content: last.content + text };
      return next;
    });
  }

  // The in-flight turn's request id. Every event is checked against it, so a cancelled
  // or superseded stream can never write into the message list after the fact.
  let curReq: string | null = null;
  // Automatic restarts left for the current user turn. Reset on every fresh send, so a
  // conversation can't accumulate retries and a dying provider can't loop forever.
  let autoRetries = AUTO_RETRY_BUDGET;

  /** End the active turn exactly once, stamping its outcome on the assistant message.
   *  A turn that died AFTER painting text can't be replayed by the backend (that would
   *  duplicate what's on screen), so it lands here as an error — restart it once. */
  function finishTurn(id: string, patch: Pick<ChatMsg, "error" | "cancelled" | "truncated">) {
    if (curReq !== id) return; // already ended (or superseded)
    curReq = null;
    setStreaming(false);
    let diedMidStream = false;
    setMessages((ms) => {
      const next = [...ms];
      const last = next[next.length - 1];
      if (!last || last.role !== "assistant") return ms;
      // A clean finish with nothing to show is a failure the user can retry — this is
      // what a silently-dropped provider error used to look like.
      const empty = !last.content.trim();
      const error = patch.error ?? (empty && !patch.cancelled ? "The model returned an empty response." : undefined);
      // Only a partial reply means the stream genuinely died in flight. An empty one
      // already exhausted the backend's own replay budget — restarting it just burns
      // another round trip against the same fatal condition (bad key, bad model).
      diedMidStream = !!patch.error && !patch.cancelled && !empty;
      next[next.length - 1] = { ...last, ...patch, error };
      return next;
    });
    if (diedMidStream && autoRetries > 0) {
      autoRetries--;
      // Let the state settle before restarting; `retry()` re-reads messages().
      queueMicrotask(() => retry());
    }
  }

  /** Stream one assistant reply for `convo` (which must end with a user message). */
  async function runTurn(convo: ChatMsg[]) {
    if (streaming()) return;
    if (!hasKey()) { props.onOpenSettings(); return; }
    pinned = true; // a fresh send always follows the reply
    setMessages([...convo, { role: "assistant", content: "" }]);
    setStreaming(true);
    const id = newRequestId();
    curReq = id;

    const channel = new Channel<AiEvent>();
    channel.onmessage = (ev) => {
      if (curReq !== id) return; // stale stream — cancelled or superseded
      if (ev.type === "delta") appendAssistant(ev.text);
      else if (ev.type === "error") finishTurn(id, { error: ev.message });
      else if (ev.type === "cancelled") finishTurn(id, { cancelled: true });
      else finishTurn(id, { truncated: ev.truncated });
    };
    try {
      const c = cfg();
      // Prime the join graph BEFORE snapshotting ctx — `fks`/`fksKnown` are read off it.
      await props.ensureFks?.().catch(() => { /* best-effort — prompt omits the FK section */ });
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
      // Stop pressed while sampling: the stream was never registered, so `ai_cancel`
      // has nothing to interrupt — just don't start it.
      if (curReq !== id) return;
      const model = c.model || defaultModel(c.provider);
      // Live-catalog-only providers (routers, local servers) have no curated default,
      // so an unreachable server or an unset model must say so, not 404 at the provider.
      if (!model) {
        finishTurn(id, { error: `No model selected for ${providerInfo(c.provider).label}. Pick one in AI settings.` });
        return;
      }
      // OpenCode serves each family on a different endpoint; the wire is per MODEL,
      // not per provider. `null` = a shape we don't speak (should be unreachable —
      // modelsFor already filters those out of the picker).
      const wire = resolveWire(c.provider, model);
      if (!wire) {
        finishTurn(id, { error: `${providerInfo(c.provider).label} doesn't serve ${model} on an API shape Tusk supports.` });
        return;
      }
      // A provider with no registry default and no override resolves to "". Sending null
      // would make the backend fall back to api.openai.com — quietly shipping the schema,
      // FK graph, sample rows and the user's key to a third party. Refuse instead.
      const baseUrl = resolveBaseUrl(c.provider, activeBaseUrl(c), wire);
      if (!baseUrl) {
        finishTurn(id, { error: `Set an API base URL for ${providerInfo(c.provider).label} in AI settings.` });
        return;
      }
      await invoke("ai_chat", {
        req: {
          provider: c.provider,
          wire,
          model,
          baseUrl,
          // Conversation text steers the schema summary: mentioned tables get
          // their full columns even when the schema dump is over budget.
          system: buildSystemPrompt(ctx, convoText, samples),
          // Only the text is replayed — a prior turn's error/cancel never becomes context.
          // Content-less assistant turns (Stop before the first delta, empty reply) stay
          // in the DISPLAY list but must never be sent: Anthropic and Gemini reject an
          // empty assistant message with a 400, which would break every later question
          // in this chat, not just the failed one.
          messages: convo
            .filter((m) => m.role === "user" || m.content.trim())
            .map((m) => ({ role: m.role, content: m.content })),
          maxTokens: 2048,
          requestId: id,
          allowNoKey: isKeyless(c.provider),
        },
        onEvent: channel,
      });
      // `ai_chat` resolves after its terminal event, so finishTurn has normally already
      // run. This only fires if the command returned without one (it shouldn't).
      finishTurn(id, { error: "The stream ended unexpectedly." });
    } catch (e) {
      finishTurn(id, { error: errMsg(e) });
    }
  }

  function send(text: string) {
    if (!text.trim() || streaming()) return;
    // Bail BEFORE clearing the composer — otherwise the no-key path eats the question.
    if (!hasKey()) { props.onOpenSettings(); return; }
    autoRetries = AUTO_RETRY_BUDGET; // a fresh question gets a fresh restart budget
    setInput("");
    queueMicrotask(autoGrow); // collapse the composer back to one line
    void runTurn([...messages(), { role: "user", content: text }]);
  }

  /** Stop the in-flight stream. The backend keeps the partial text on screen. */
  function cancel() {
    const id = curReq;
    if (!id) return;
    finishTurn(id, { cancelled: true }); // ends the turn even if the backend never answers
    void invoke("ai_cancel", { requestId: id }).catch(() => { /* already finished */ });
  }

  /** Re-run the failed/cancelled last turn, dropping its dead assistant message. Used by
   *  the Retry button and by the one automatic restart after a mid-stream death. */
  function retry() {
    const ms = messages();
    const last = ms[ms.length - 1];
    if (streaming() || !last || last.role !== "assistant") return;
    void runTurn(ms.slice(0, -1));
  }

  function newChat() {
    cancel();
    setMessages([]);
  }

  // Quick actions seed the chat; the schema/SQL/error already ride in the system prompt.
  const explain = () => send("Explain what the SQL in my editor does, step by step.");
  const fixError = () => send("My last query errored (see the error in context). Diagnose it and give a corrected query.");
  /** The last message, when it's a finished assistant turn that the user can retry. */
  const failedLast = () => {
    const last = messages()[messages().length - 1];
    return !streaming() && last?.role === "assistant" && (last.error || last.cancelled) ? last : undefined;
  };

  // Header model picker: every model of every ready provider, so the model can be
  // switched freely without reopening settings. Live catalog when fetched (curated
  // fallback otherwise); the current custom model is always included. Providers whose
  // catalog we know are sub-grouped by tier (Flagship / Balanced / Fast / Older);
  // routers and local servers render as one flat "Models" group.
  const headerGroups = () =>
    keyed().flatMap((pid) => {
      const models = [...modelsFor(pid)];
      if (cfg().provider === pid && cfg().model && !models.includes(cfg().model)) models.unshift(cfg().model);
      if (!models.length) return [];
      const label = providerInfo(pid).label;
      return groupByTier(pid, models).map((g) => ({
        // "Anthropic · Flagship" — one <optgroup> per (provider, tier).
        label: `${label} · ${g.label}`,
        pid,
        models: g.models,
      }));
    });
  const curModelValue = () => `${cfg().provider}|${cfg().model}`;
  const curModelNote = () => modelNote(cfg().provider, cfg().model);

  return (
    <div class="ai-panel" style={{ width: `${props.width}px` }}>
      <div class="ai-head">
        <Show
          when={keyed().length > 0}
          fallback={<button class="ai-setup" onClick={() => props.onOpenSettings()}>✨ Set up a model →</button>}
        >
          <select
            class="ai-model-select"
            title={curModelNote() ?? "Model (providers that are set up)"}
            onChange={(e) => { const [p, ...rest] = e.currentTarget.value.split("|"); setConfig({ provider: p as AiProvider, model: rest.join("|") }); }}
          >
            {/* `selected` per option (not `value` on the select): options load async from
                the live catalog, and Solid won't re-apply a select `value` when they arrive —
                so the picker would stick on whatever mounted first. */}
            <For each={headerGroups()}>
              {(g) => (
                <optgroup label={g.label}>
                  <For each={g.models}>
                    {(m) => (
                      <option value={`${g.pid}|${m}`} selected={curModelValue() === `${g.pid}|${m}`} title={modelNote(g.pid, m)}>
                        {m}
                      </option>
                    )}
                  </For>
                </optgroup>
              )}
            </For>
          </select>
        </Show>
        <span class="spacer" />
        <button class="icon" title="New chat" disabled={messages().length === 0} onClick={newChat}>✚</button>
        <button class="icon" title="Settings" classList={{ active: settingsOpen() }} onClick={() => setSettingsOpen((v) => !v)}>⚙</button>
        <button class="icon" title="Close" onClick={props.onClose}>✕</button>
      </div>

      <Show when={settingsOpen()}>
        <div class="ai-settings">
          {/* Provider/model/key management lives in Settings → AI now (provider cards,
              Test connection, skills). This drawer keeps only the one control that is a
              per-conversation privacy decision rather than configuration. */}
          <label class="ai-check" title="Send a few sample rows of relevant tables so the model understands your real data. Real values leave your machine for the provider.">
            <input type="checkbox" checked={cfg().shareSamples !== false} onChange={(e) => setConfig({ shareSamples: e.currentTarget.checked })} />
            Share sample data with the model
          </label>
          <div class="ai-settings-actions">
            <button class="ghost" onClick={() => { setSettingsOpen(false); props.onOpenSettings(); }}>
              Manage providers &amp; skills…
            </button>
          </div>
          <div class="ai-note">Keys are stored in your OS keychain and used only by the backend — they never reach the web view.</div>
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
                {/* Typing dots only while a reply is genuinely still pending — an empty
                    message that already failed must not spin forever. */}
                <Show when={m().content || m().error || m().cancelled} fallback={<div class="ai-typing"><span /><span /><span /></div>}>
                  <Show when={m().content}>
                    <Markdown text={m().content} onInsertSql={props.onInsertSql} />
                  </Show>
                </Show>
                <Show when={m().truncated}>
                  <div class="ai-msg-note">✂️ Cut off at the token limit — ask for a shorter answer, or ask it to continue.</div>
                </Show>
                <Show when={m().cancelled}>
                  <div class="ai-msg-note">⏹ Stopped.</div>
                </Show>
                <Show when={m().error}>
                  {(err) => <div class="ai-msg-error">⚠️ {err()}</div>}
                </Show>
              </Show>
            </div>
          )}
        </Index>
        {/* Retry re-runs the last user message, discarding the dead reply. */}
        <Show when={failedLast()}>
          <div class="ai-retry-row">
            <button class="ghost" onClick={retry}>↻ Retry</button>
          </div>
        </Show>
      </div>

      <div class="ai-actions">
        <button class="ghost" disabled={streaming()} onClick={explain}>Explain</button>
        <button class="ghost" disabled={streaming()} onClick={fixError}>Fix error</button>
      </div>
      <form class="ai-input" onSubmit={(e) => { e.preventDefault(); send(input()); }}>
        {/* Deliberately NOT `disabled` while streaming: a disabled control receives no
            keydown, so Esc-to-stop silently never fired. Drafting the next question
            meanwhile is fine — `send` already no-ops while a turn is in flight. */}
        <textarea
          ref={inputEl}
          rows={1}
          value={input()}
          onInput={(e) => { setInput(e.currentTarget.value); autoGrow(); }}
          onKeyDown={(e) => {
            // `send` no-ops while streaming; Enter must still not insert a newline.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input());
            }
            if (e.key === "Escape" && streaming()) cancel();
          }}
          placeholder={streaming() ? "…streaming (Esc to stop)" : "Ask the AI… (Shift+Enter = newline)"}
        />
        {/* Send doubles as Stop while streaming — one button, never both. `run cancel` is
            the app's existing cancel-while-busy style (solid --danger); don't invent one. */}
        <Show
          when={streaming()}
          fallback={<button class="run" type="submit" disabled={!input().trim()}>Send</button>}
        >
          <button class="run cancel" type="button" title="Stop generating (Esc)" onClick={cancel}>⏹ Stop</button>
        </Show>
      </form>
    </div>
  );
}
