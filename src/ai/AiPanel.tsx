import { createSignal, createEffect, createMemo, For, Index, Show, onCleanup, onMount, type Accessor } from "solid-js";
import { Icon } from "../Icons";
import { invoke, Channel } from "@tauri-apps/api/core";
import {
  aiStore, activeBaseUrl, approvedBaseOverride, defaultModel, normalizeAiConfig,
  providerModels, providerInfo, AI_PROVIDERS, isKeyless, resolveWire, resolveBaseUrl,
  modelSupported, originApproved,
  type AiConfig, type AiProvider, type AiEvent,
  visibleModels,
} from "./store";
import { buildSystemPrompt, relevantTables, type AiContext, type SampleTable } from "./context";
import { Markdown } from "./markdown";
import { ModelPicker } from "./ModelPicker";
import { KeyedStaleGuard, StaleGuard } from "../staleGuard";

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
  /**
   * Identity of the connection `ctx()` describes — `id#generation`, "" when none.
   * The panel is docked, not modal, so the connection strip stays clickable while a
   * conversation is open. Without this the schema, skills and dialect in the system
   * prompt swapped mid-thread on a chip click, and **Open in editor** dropped SQL
   * written for one engine into a tab that runs on another.
   */
  connectionToken: Accessor<string>;
  /** Display name of that connection, for the mismatch banner. */
  connectionName: Accessor<string>;
  /** Open Settings → AI (provider cards, keys, skills). */
  onOpenSettings: () => void;
  /** Docked panel width in px (resizable by the splitter on its left edge). */
  width: number;
  onInsertSql: (sql: string) => void;
  onClose: () => void;
}) {
  const [cfg, setCfg] = createSignal<AiConfig>(aiStore.load());
  const [configError, setConfigError] = createSignal("");
  const [hasKey, setHasKey] = createSignal(false);
  const [keyed, setKeyed] = createSignal<AiProvider[]>([]); // providers with a saved key
  // Live model catalog per provider (fetched via the backend with the keychain key);
  // the curated list in store.ts is only the fallback when the fetch fails.
  const [liveModels, setLiveModels] = createSignal<Partial<Record<AiProvider, string[]>>>({});
  /** Live catalog when we have one, else the registry's curated fallback — minus any
   *  model this provider serves on a wire we don't speak (`wireFor` → null). Both
   *  OpenCode gateways are fully covered today, so nothing is filtered in practice. */
  const modelsFor = (pid: AiProvider) =>
    visibleModels(cfg(), pid, liveModels()[pid], providerModels(pid)).filter((m) => modelSupported(pid, m));
  const modelFetchGuard = new KeyedStaleGuard<AiProvider>();
  const keyGuard = new StaleGuard();
  const keyedGuard = new StaleGuard();
  async function fetchModels(pid: AiProvider) {
    const token = modelFetchGuard.mint(pid);
    const config = cfg();
    // The base override only applies to the provider it was configured for; every other
    // provider is fetched at its registry default.
    if (!originApproved(config, pid)) return;
    const override = approvedBaseOverride(config, pid);
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
      if (modelFetchGuard.current(pid, token) && list.length)
        setLiveModels((m) => ({ ...m, [pid]: list }));
    } catch {
      /* keep the curated fallback */
    }
  }
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  /**
   * The connection this conversation is about, captured when it started. Everything
   * in the thread — the schema summary, the skills in scope, the SQL dialect the
   * model was told to write — belongs to it, so a later chip click must not quietly
   * re-aim the thread; it tags it instead, and **New chat** re-binds.
   */
  const [threadConn, setThreadConn] = createSignal<{ token: string; name: string } | null>(null);
  /** The workbench moved to another connection since this conversation started. */
  const connMismatch = () => {
    const bound = threadConn();
    return !!bound && bound.token !== props.connectionToken();
  };
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
    const next = normalizeAiConfig({ ...cfg(), ...patch });
    if (!aiStore.save(next)) {
      setCfg({ ...next, shareSamples: false });
      setConfigError("Could not save AI settings. Sample sharing stays off.");
      return false;
    }
    // aiStore synchronously publishes its canonical value (including models[provider]);
    // do not overwrite that subscriber update with the pre-normalized input.
    setConfigError("");
    return true;
  };
  // A keyless local server is always "ready" — never gate it behind the key prompt.
  const providerReady = async (p: AiProvider, config = cfg()) => {
    if (!originApproved(config, p)) return false;
    if (isKeyless(p)) return true;
    const baseUrl = resolveBaseUrl(p, approvedBaseOverride(config, p));
    return !!baseUrl && await invoke<boolean>("ai_has_key", { provider: p, baseUrl }).catch(() => false);
  };
  const refreshKey = async () => {
    const token = keyGuard.mint();
    const config = cfg();
    const ready = await providerReady(config.provider, config);
    if (keyGuard.current(token) && cfg() === config) setHasKey(ready);
  };
  // First-open routing happens HERE, once the async keychain check resolves: no
  // saved key anywhere → show the setup form (provider/model/key prompt); a key
  // exists → land straight in the chat. Deciding before the check (or in an
  // effect over keyed(), which starts []) wrongly flashed settings open on every
  // panel open even after setup.
  const refreshKeyed = async () => {
    const token = keyedGuard.mint();
    const config = cfg();
    const checks = await Promise.all(
      AI_PROVIDERS.map((p) => providerReady(p.id, config).then((ok) => (ok ? p.id : null))),
    );
    if (!keyedGuard.current(token) || cfg() !== config) return;
    const list = checks.filter((x): x is AiProvider => !!x);
    setKeyed(list);
    // Keyless providers are "ready" but may have no server running — fetching their
    // catalog is what actually tells us, and a failure just leaves them empty.
    for (const p of list) if (!liveModels()[p]) void fetchModels(p);
    // First-run routing: with no provider set up, the header shows "✨ Set up a model →"
    // which opens Settings → AI. No drawer to flash open.
  };

  let unsubscribeConfig = () => {};
  onMount(() => {
    unsubscribeConfig = aiStore.subscribe((next) => {
      const previous = cfg();
      const changedBases = AI_PROVIDERS
        .map((provider) => provider.id)
        .filter((provider) =>
          (previous.baseUrls[provider] ?? "") !== (next.baseUrls[provider] ?? "") ||
          previous.approvedOrigins[provider] !== next.approvedOrigins[provider]);
      if (changedBases.length) {
        for (const provider of changedBases) modelFetchGuard.invalidate(provider);
        setLiveModels((models) => {
          const updated = { ...models };
          for (const provider of changedBases) delete updated[provider];
          return updated;
        });
      }
      setCfg(next);
      setConfigError("");
      void refreshKeyed();
    });
    void refreshKey();
    void refreshKeyed();
  });
  // Re-check the current provider's key when it changes.
  const readinessKey = createMemo(() => {
    const c = cfg();
    return JSON.stringify([c.provider, c.baseUrls[c.provider] ?? "", c.approvedOrigins[c.provider] ?? ""]);
  });
  createEffect(() => {
    readinessKey();
    setHasKey(false);
    void refreshKey();
  });
  // Refetch the current provider's models when its base URL changes (debounced —
  // OpenAI-compatible/local servers expose different catalogs per base).
  let modelsTimer: ReturnType<typeof setTimeout> | undefined;
  const modelSourceKey = createMemo(() => {
    const p = cfg().provider;
    return JSON.stringify([p, cfg().baseUrls[p] ?? "", cfg().approvedOrigins[p] ?? ""]);
  });
  createEffect(() => {
    modelSourceKey();
    const p = cfg().provider;
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
  let pendingDelta = "";
  let pendingDeltaId: string | null = null;
  let deltaTimer: ReturnType<typeof setTimeout> | undefined;
  const flushDelta = (id: string) => {
    if (pendingDeltaId !== id || !pendingDelta) return;
    clearTimeout(deltaTimer);
    deltaTimer = undefined;
    const text = pendingDelta;
    pendingDelta = "";
    appendAssistant(text);
  };
  const queueDelta = (id: string, text: string) => {
    if (pendingDeltaId !== id) {
      pendingDelta = "";
      pendingDeltaId = id;
    }
    pendingDelta += text;
    if (pendingDelta.length >= 4096) flushDelta(id);
    else if (!deltaTimer) deltaTimer = setTimeout(() => flushDelta(id), 32);
  };
  // Automatic restarts left for the current user turn. Reset on every fresh send, so a
  // conversation can't accumulate retries and a dying provider can't loop forever.
  let autoRetries = AUTO_RETRY_BUDGET;

  /** End the active turn exactly once, stamping its outcome on the assistant message.
   *  A turn that died AFTER painting text can't be replayed by the backend (that would
   *  duplicate what's on screen), so it lands here as an error — restart it once. */
  function finishTurn(id: string, patch: Pick<ChatMsg, "error" | "cancelled" | "truncated">) {
    if (curReq !== id) return; // already ended (or superseded)
    flushDelta(id);
    curReq = null;
    pendingDeltaId = null;
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
    if (connMismatch()) return; // the banner offers New chat; never re-aim a live thread
    // A conversation binds to the connection it starts on and stays there.
    const boundToken = threadConn()?.token ?? props.connectionToken();
    if (!threadConn()) setThreadConn({ token: boundToken, name: props.connectionName() });
    pinned = true; // a fresh send always follows the reply
    setMessages([...convo, { role: "assistant", content: "" }]);
    setStreaming(true);
    const id = newRequestId();
    curReq = id;
    pendingDelta = "";
    pendingDeltaId = id;

    const channel = new Channel<AiEvent>();
    channel.onmessage = (ev) => {
      if (curReq !== id) return; // stale stream — cancelled or superseded
      if (ev.type === "delta") queueDelta(id, ev.text);
      else if (ev.type === "error") finishTurn(id, { error: ev.message });
      else if (ev.type === "cancelled") finishTurn(id, { cancelled: true });
      else finishTurn(id, { truncated: ev.truncated });
    };
    try {
      const c = cfg();
      const model = c.model || defaultModel(c.provider);
      if (!model) {
        finishTurn(id, { error: `No model selected for ${providerInfo(c.provider).label}. Pick one in AI settings.` });
        return;
      }
      if (!originApproved(c, c.provider)) {
        finishTurn(id, { error: `Approve the custom API origin for ${providerInfo(c.provider).label} in AI settings.` });
        return;
      }
      const wire = resolveWire(c.provider, model);
      if (!wire) {
        finishTurn(id, { error: `${providerInfo(c.provider).label} does not serve ${model} on a supported API shape.` });
        return;
      }
      const baseUrl = resolveBaseUrl(c.provider, activeBaseUrl(c), wire);
      if (!baseUrl) {
        finishTurn(id, { error: `Set an API base URL for ${providerInfo(c.provider).label} in AI settings.` });
        return;
      }
      // Prime the join graph BEFORE snapshotting ctx — `fks`/`fksKnown` are read off it.
      await props.ensureFks?.().catch(() => { /* best-effort — prompt omits the FK section */ });
      // `ctx()` is read AFTER that await, so a chip click during it would swap the
      // whole snapshot (schema, dialect, skills) under a thread already about another
      // database. Refuse rather than send the wrong context.
      if (props.connectionToken() !== boundToken) {
        finishTurn(id, { error: "The active connection changed while preparing the request. Switch back, or start a new chat." });
        return;
      }
      const ctx = props.ctx();
      const convoText = convo.map((m) => m.content).join("\n");
      // Ground the model in real data: fetch a few sample rows of the tables most
      // relevant to the conversation (read-only, best-effort, off if the user opted out).
      let samples: SampleTable[] = [];
      if (c.shareSamples) {
        const targets = relevantTables(ctx.tables, `${convoText} ${ctx.currentSql} ${ctx.selection}`, 5)
          .map((t) => ({ schema: t.schema, name: t.name }));
        if (targets.length) {
          try { samples = await props.sampleRows(targets); } catch { /* best-effort — no samples */ }
        }
      }
      // Settings can remain open beside the mounted panel. If sharing was turned off
      // while samples were loading, discard them before constructing the request.
      if (!cfg().shareSamples) samples = [];
      // Stop pressed while sampling: the stream was never registered, so `ai_cancel`
      // has nothing to interrupt — just don't start it.
      if (curReq !== id) return;
      // Provider settings can change while FK/sample reads are pending. Revalidate
      // the exact destination immediately before sending schema or row context;
      // revoking an origin must take effect before the network request starts.
      const latest = cfg();
      const latestModel = latest.model || defaultModel(latest.provider);
      const latestWire = latestModel ? resolveWire(latest.provider, latestModel) : null;
      const latestBase = latestWire && originApproved(latest, latest.provider)
        ? resolveBaseUrl(latest.provider, activeBaseUrl(latest), latestWire)
        : "";
      if (latest.provider !== c.provider || latestModel !== model || latestWire !== wire || latestBase !== baseUrl) {
        finishTurn(id, { error: "AI provider settings changed while preparing the request. Send again to use the new destination." });
        return;
      }
      // Sample rows are fetched against whatever connection is active; a switch during
      // that await would attach another database's real values to this prompt.
      if (props.connectionToken() !== boundToken) {
        finishTurn(id, { error: "The active connection changed while preparing the request. Switch back, or start a new chat." });
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
          // User-configured ceiling (Settings → AI), same knob the Slack bot honors.
          maxTokens: latest.maxTokens,
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
    if (!text.trim() || streaming() || connMismatch()) return;
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
    setThreadConn(null); // the next question re-binds to whatever is in focus then
  }

  // Quick actions seed the chat; the schema/SQL/error already ride in the system prompt.
  const explain = () => send("Explain what the SQL in my editor does, step by step.");
  /**
   * Opening prompts, scoped to the schema in front of the user. The empty panel
   * used to be one grey paragraph over 750px of void.
   */
  const starters = () => {
    const t = props.ctx().tables?.[0];
    const name = t ? (t.schema && t.schema !== "public" ? `${t.schema}.${t.name}` : t.name) : "";
    return [
      "Summarise this schema",
      name ? `Show me 20 recent rows from ${name}` : "Write a query against this database",
      "Explain the SQL in my editor",
    ];
  };

  const fixError = () => send("My last query errored (see the error in context). Diagnose it and give a corrected query.");
  /** The last message, when it's a finished assistant turn that the user can retry. */
  const failedLast = () => {
    const last = messages()[messages().length - 1];
    return !streaming() && last?.role === "assistant" && (last.error || last.cancelled) ? last : undefined;
  };

  onCleanup(() => {
    keyGuard.dispose();
    keyedGuard.dispose();
    modelFetchGuard.dispose();
    unsubscribeConfig();
    clearTimeout(modelsTimer);
    clearTimeout(deltaTimer);
    const id = curReq;
    curReq = null;
    pendingDelta = "";
    pendingDeltaId = null;
    if (id) void invoke("ai_cancel", { requestId: id }).catch(() => {});
  });


  return (
    <div class="ai-panel" style={{ width: `${props.width}px` }}>
      <div class="ai-head">
        <Icon name="sparkle" />
        <span class="ai-title">Assistant</span>
        <Show
          when={keyed().length > 0}
          fallback={<button class="ai-setup" onClick={() => props.onOpenSettings()}>Set up a model</button>}
        >
          <ModelPicker
            providers={keyed()}
            modelsFor={modelsFor}
            current={{ provider: cfg().provider, model: cfg().model }}
            onPick={(c) => setConfig({ provider: c.provider, model: c.model })}
          />
        </Show>
        <span class="spacer" />
        <button class="icon" title="New chat" disabled={messages().length === 0} onClick={newChat}><Icon name="plus" /></button>
        <button class="icon" title="Settings" classList={{ active: settingsOpen() }} onClick={() => setSettingsOpen((v) => !v)}><Icon name="gear" /></button>
        <button class="icon" title="Close" onClick={props.onClose}><Icon name="close" /></button>
      </div>

      <Show when={settingsOpen()}>
        <div class="ai-settings">
          <Show when={configError()}><div class="ai-msg-error">{configError()}</div></Show>
          {/* Provider/model/key management lives in Settings → AI now (provider cards,
              Test connection, skills). This drawer keeps only the one control that is a
              per-conversation privacy decision rather than configuration. */}
          <label class="ai-check" title="Send sample rows to the provider">
            <input
              type="checkbox"
              checked={cfg().shareSamples}
              onChange={(e) => {
                if (!setConfig({ shareSamples: e.currentTarget.checked })) {
                  e.currentTarget.checked = cfg().shareSamples;
                }
              }}
            />
            Share sample rows with the model
          </label>
          <div class="ai-settings-actions">
            <button class="ghost" onClick={() => { setSettingsOpen(false); props.onOpenSettings(); }}>
              Manage providers &amp; skills…
            </button>
          </div>
          <div class="ai-note">Keys are stored in your OS keychain.</div>
        </div>
      </Show>

      <div class="ai-messages" ref={msgEl} onScroll={onMsgScroll}>
        <Show when={messages().length === 0}>
          <div class="ai-empty">
            <div class="ai-empty-head">Ask about {props.connectionName()}</div>
            <div class="ai-empty-hint">Questions carry this database's schema and your enabled skills.</div>
            <div class="ai-examples">
              <For each={starters()}>
                {(q) => <button class="ai-example" disabled={connMismatch()} onClick={() => send(q)}>{q}</button>}
              </For>
            </div>
          </div>
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
                    {/* Open in editor binds the new tab to the ACTIVE connection, so
                        inserting an answer written for another database would quote and
                        run it under the wrong engine's rules. */}
                    <Markdown
                      text={m().content}
                      onInsertSql={props.onInsertSql}
                      insertDisabledReason={connMismatch()
                        ? `Written for ${threadConn()!.name}. Switch back to open it.`
                        : ""}
                    />
                  </Show>
                </Show>
                <Show when={m().truncated}>
                  <div class="ai-msg-note">Cut off at the token limit. Ask it to continue.</div>
                </Show>
                <Show when={m().cancelled}>
                  <div class="ai-msg-note">Stopped.</div>
                </Show>
                <Show when={m().error}>
                  {(err) => <div class="ai-msg-error">{err()}</div>}
                </Show>
              </Show>
            </div>
          )}
        </Index>
        {/* Retry re-runs the last user message, discarding the dead reply. */}
        <Show when={failedLast()}>
          <div class="ai-retry-row">
            <button class="ghost" onClick={retry}>Retry</button>
          </div>
        </Show>
      </div>

      {/* The thread is about another connection than the one in focus. Tag it rather
          than silently re-aiming it: the answers above describe a different schema and
          dialect, so they must not be extended or inserted here. */}
      <Show when={connMismatch()}>
        <div class="ai-conn-mismatch">
          <span>
            This chat is about <b>{threadConn()!.name}</b>; the workbench is on <b>{props.connectionName()}</b>.
            Switch back, or start a new chat.
          </span>
          <button class="ghost" onClick={newChat}>New chat</button>
        </div>
      </Show>
      <div class="ai-actions">
        <button class="ghost" disabled={streaming() || connMismatch()} onClick={explain}>Explain</button>
        <button
          class="ghost"
          disabled={streaming() || connMismatch() || !props.ctx().lastError.trim()}
          title={props.ctx().lastError.trim() ? "Diagnose the last query error" : "No query has failed yet"}
          onClick={fixError}
        >Fix error</button>
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
          placeholder={streaming() ? "Streaming… Esc to stop" : "Ask about this database"}
        />
        {/* Send doubles as Stop while streaming — one button, never both. `run cancel` is
            the app's existing cancel-while-busy style (solid --danger); don't invent one. */}
        <Show
          when={streaming()}
          fallback={
            <button
              class="run"
              type="submit"
              disabled={!input().trim() || connMismatch()}
              title={connMismatch() ? `Start a new chat to ask about ${props.connectionName()}` : undefined}
            >Send</button>
          }
        >
          <button class="run cancel" type="button" title="Stop generating (Esc)" onClick={cancel}>Stop</button>
        </Show>
      </form>
    </div>
  );
}
