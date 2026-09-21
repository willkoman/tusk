// Settings → Slack: desktop-hosted Socket Mode bot configuration. Tokens go straight
// to the OS keychain via `slack_save_config` (never echoed back); the non-secret
// config lives in slack.json. The AI provider/model is mirrored from the AI panel's
// localStorage config at save time (the Rust bot can't read the WebView's storage).
//
// Layout: one status card (state + on/off switch) followed by four sections — Slack app
// tokens, Who can ask, Answers, AI — each a header plus label/hint/control rows. Every
// non-token control saves as it changes; the token section keeps explicit Save/Test.

import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { StaleGuard } from "../staleGuard";
import { activeBaseUrl, aiStore, defaultModel, isKeyless, resolveBaseUrl, resolveWire, type AiConfig, type AiProvider } from "../ai/store";
import {
  DEFAULT_CONFIG,
  PersistFailed,
  normalizeSlackConfig,
  normalizeSlackMaxTokens,
  repointBot,
  slackConfigMatches,
  slackErrMsg as errMsg,
  slackIo,
  slackTone,
  startBotBound,
  stopBot,
  type SlackConfig,
  type SlackConfigInfo,
  type SlackConnectionOption,
  type SlackStatus,
} from "../slack/bind";

// The config model and the start/stop/bind sequences live in `src/slack/bind.ts`,
// shared with the statusbar badge menu; re-exported so existing importers stand.
export { DEFAULT_CONFIG, normalizeSlackConfig, normalizeSlackMaxTokens, slackConfigMatches };
export type { SlackConfig, SlackConnectionOption, SlackStatus };

/**
 * What the bot WOULD mirror from the AI config on its next save. Pure so the pane's
 * "bot still uses X" hint and the save path can never disagree about the target.
 */
export const mirroredAi = (ai: AiConfig): { provider: AiProvider; model: string } => ({
  provider: ai.provider,
  model: ai.model || defaultModel(ai.provider),
});

/** True when the persisted bot config already points at the AI panel's provider/model. */
export const slackAiInSync = (cfg: SlackConfig, ai: AiConfig): boolean => {
  const m = mirroredAi(ai);
  return cfg.aiProvider === m.provider && cfg.aiModel === m.model;
};

type SaveResult = { tokensChanged: boolean };

const clampInt = (v: string, min: number, max: number, fallback: number) =>
  Math.trunc(Math.max(min, Math.min(max, Number(v) || fallback)));

export function SlackPane(props: {
  onOpenAi?: () => void;
  /** Open connections, so the bot can be pointed at one of them. */
  connections?: () => SlackConnectionOption[];
  /** The connection the workbench has focused — the default a fresh start binds to. */
  activeConnectionId?: () => string | null;
}) {
  const [cfg, setCfg] = createSignal<SlackConfig>(DEFAULT_CONFIG);
  const [configLoaded, setConfigLoaded] = createSignal(false);
  const [ai, setAi] = createSignal<AiConfig>(aiStore.load());
  const [hasBot, setHasBot] = createSignal(false);
  const [hasApp, setHasApp] = createSignal(false);
  const [botToken, setBotToken] = createSignal("");
  const [appToken, setAppToken] = createSignal("");
  const [status, setStatus] = createSignal<SlackStatus>({ running: false, state: "disconnected", error: null, connectionId: null });
  const openConnections = () => props.connections?.() ?? [];
  const boundConnection = () => openConnections().find((c) => c.id === status().connectionId) ?? null;
  /** The saved connection behind an open connection id — what autostart is armed for. */
  const profileOf = (connectionId: string | null | undefined) =>
    (connectionId && openConnections().find((c) => c.id === connectionId)?.profileId) || null;
  const [note, setNote] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [maxTokensInput, setMaxTokensInput] = createSignal(String(DEFAULT_CONFIG.aiMaxTokens));

  let unlisten: UnlistenFn | undefined;
  let unsubscribeAi = () => {};
  const statusGuard = new StaleGuard();
  onMount(() => {
    unsubscribeAi = aiStore.subscribe(setAi);
    void (async () => {
      try {
        const info = await slackIo.run("io", () => invoke<SlackConfigInfo>("slack_load_config"));
        if (!statusGuard.alive) return;
        const loaded = normalizeSlackConfig(info.config);
        setCfg(loaded);
        setMaxTokensInput(String(loaded.aiMaxTokens));
        setHasBot(info.hasBotToken);
        setHasApp(info.hasAppToken);
      } catch {
        /* defaults stand */
      } finally {
        if (statusGuard.alive) setConfigLoaded(true);
      }
    })();
    void (async () => {
      try {
        const stop = await listen<SlackStatus>("slack:status", (e) => {
          statusGuard.invalidate();
          setStatus(e.payload);
          // A bot that FAILED is off, and the switch must say so. A bot that is merely
          // waiting (its bound connection closed, autostart still armed) keeps
          // `enabled: true` on disk, so the switch stays On over it — honestly.
          if (!e.payload.running && e.payload.error && !e.payload.waiting && cfg().enabled) setCfg({ ...cfg(), enabled: false });
        });
        if (!statusGuard.alive) {
          stop();
          return;
        }
        unlisten = stop;
      } catch {
        /* status events unavailable */
      }
      const token = statusGuard.mint();
      try {
        const current = await invoke<SlackStatus>("slack_status");
        if (statusGuard.current(token)) setStatus(current);
      } catch {
        /* ignore */
      }
    })();
  });
  onCleanup(() => {
    statusGuard.dispose();
    unsubscribeAi();
    unlisten?.();
  });

  const patch = (p: Partial<SlackConfig>) => setCfg({ ...cfg(), ...p });
  const csv = (list: string[]) => list.join(", ");
  const parseCsv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

  // Non-token controls apply live like every other Settings tab — a tab switch remounts
  // this pane from disk, so an edit that waited for an explicit Save was silently lost.
  // Success is quiet (save() read-back verifies); failure reloads the persisted config
  // so a control never keeps showing a value that is not actually on disk.
  const applyPatch = (p: Partial<SlackConfig>) => {
    patch(p);
    void save({}, false).then(async (saved) => {
      if (saved) {
        setNote("");
        return;
      }
      try {
        const info = await slackIo.run("io", () => invoke<SlackConfigInfo>("slack_load_config"));
        if (!statusGuard.alive) return;
        const loaded = normalizeSlackConfig(info.config);
        setCfg(loaded);
        setMaxTokensInput(String(loaded.aiMaxTokens));
      } catch {
        /* keep current UI state; the failure note stands */
      }
    });
  };

  // Persist config + any newly typed tokens; mirror the AI panel's provider/model.
  // `override` lets callers pin fields (notably `enabled`) independent of the signal.
  // All saves and the mount load serialize through `slackIo`, so writes never interleave.
  const save = (override: Partial<SlackConfig> = {}, includeTokens = true): Promise<SaveResult | null> =>
    slackIo.run("io", () => doSave(override, includeTokens));

  const doSave = async (override: Partial<SlackConfig>, includeTokens: boolean): Promise<SaveResult | null> => {
    const currentAi = ai();
    const { provider, model } = mirroredAi(currentAi);
    const wire = resolveWire(provider, model);
    const tokensChanged = includeTokens && Boolean(botToken().trim() || appToken().trim());
    const config: SlackConfig = {
      ...cfg(),
      ...override,
      shareSamples: cfg().shareSamples === true,
      aiMaxTokens: normalizeSlackMaxTokens(maxTokensInput(), cfg().aiMaxTokens),
      aiProvider: provider,
      // The registry lives in TS, so the bot gets the RESOLVED wire and base URL —
      // it can't look them up. Wire is per-model (OpenCode); an unsupported model
      // falls back to the provider's default wire and will surface as a bot error
      // rather than silently hitting the wrong endpoint.
      aiWire: wire ?? "",
      aiModel: model,
      // Wire-resolved: some gateways host a wire under a sub-path (Zen's gemini).
      aiBaseUrl: resolveBaseUrl(provider, activeBaseUrl(currentAi), wire ?? undefined) || null,
      aiAllowNoKey: isKeyless(provider),
    };
    try {
      await invoke("slack_save_config", {
        config,
        botToken: (includeTokens && botToken().trim()) || null,
        appToken: (includeTokens && appToken().trim()) || null,
      });
      // Read-after-write catches stale controlled-input values and serialization/
      // persistence failures before the UI claims success.
      const verified = await invoke<SlackConfigInfo>("slack_load_config");
      const persisted = normalizeSlackConfig(verified.config);
      if (!slackConfigMatches(config, persisted)) {
        throw new Error("Slack settings did not reload unchanged.");
      }
      setHasBot(verified.hasBotToken);
      setHasApp(verified.hasAppToken);
      if (includeTokens) {
        setBotToken("");
        setAppToken("");
      }
      setCfg(persisted);
      setMaxTokensInput(String(persisted.aiMaxTokens));
      return { tokensChanged };
    } catch (e) {
      setNote(`Save failed: ${errMsg(e)}`);
      return null;
    }
  };

  const disableAfterRestartFailure = async (message: string) => {
    await invoke("slack_stop").catch(() => {});
    patch({ enabled: false });
    const disabled = await save({ enabled: false });
    setNote(disabled
      ? message
      : `${message} The bot is stopped, but autostart may still be on.`);
  };

  /** The pane's persist for the shared sequences: mirrors AI and saves typed tokens. */
  const persist = (p: Partial<SlackConfig>) => save(p);

  /**
   * Switch the bot on or off. On binds it to `target` — the picker's choice, else the
   * connection the workbench has focused — and arms autostart for that connection's
   * saved profile. The sequence itself is shared with the statusbar badge menu.
   */
  const applyEnabled = async (enabled: boolean, target: string | null = props.activeConnectionId?.() ?? null) => {
    patch({ enabled });
    setBusy(true);
    setNote("");
    try {
      if (enabled) {
        setNote(await startBotBound(target, profileOf(target), persist));
      } else {
        setNote(await stopBot(persist));
      }
    } catch (e) {
      if (e instanceof PersistFailed) {
        // The save reported itself; the switch just goes back to what disk says.
        patch({ enabled: !enabled });
        return;
      }
      setNote(errMsg(e));
      patch({ enabled: false });
      await save({ enabled: false }).catch(() => {}); // ensure disk = disabled
    } finally {
      setBusy(false);
    }
  };

  /** Point the bot at `id`: repoint while running, start bound to it while stopped. */
  const bindTo = async (id: string) => {
    if (!status().running) {
      await applyEnabled(true, id);
      return;
    }
    setBusy(true);
    setNote("");
    try {
      setNote(await repointBot(id, profileOf(id), persist));
    } catch (e) {
      // A failed save already reported itself; don't claim success over it.
      if (!(e instanceof PersistFailed)) setNote(`Repoint failed: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setNote("");
    const wasRunning = status().running;
    let saved: SaveResult | null = null;
    let tokensValidated = false;
    try {
      saved = await save();
      if (!saved) return;
      const team = await invoke<string>("slack_test");
      tokensValidated = true;
      if (wasRunning && saved.tokensChanged) {
        await invoke("slack_start", { connectionId: status().connectionId ?? props.activeConnectionId?.() ?? null });
        setNote(`Tokens valid for workspace “${team}”. Bot restarted.`);
      } else {
        setNote(`Tokens valid for workspace “${team}”.`);
      }
    } catch (e) {
      if (wasRunning && saved?.tokensChanged) {
        await disableAfterRestartFailure(tokensValidated
          ? `❌ ${errMsg(e)} Tokens validated, but the bot could not restart; it was stopped and disabled.`
          : `❌ ${errMsg(e)} Bot stopped because replacement tokens could not be validated.`);
      } else {
        setNote(`Test failed: ${errMsg(e)}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const saveOnly = async () => {
    setBusy(true);
    setNote("");
    const wasRunning = status().running;
    const saved = await save();
    if (saved) {
      if (wasRunning && saved.tokensChanged) {
        try {
          await invoke("slack_test");
          await invoke("slack_start", { connectionId: status().connectionId ?? props.activeConnectionId?.() ?? null });
          setNote("Saved and validated. Bot restarted.");
        } catch (e) {
          await disableAfterRestartFailure(`Saved, but the restart failed: ${errMsg(e)} Bot stopped and disabled.`);
        }
      } else {
        setNote("Saved. Changes apply from the next question.");
      }
    }
    setBusy(false);
  };

  // ---- derived presentation ------------------------------------------------------
  const typedTokens = () => Boolean(botToken().trim() || appToken().trim());
  /** Both tokens are either already in the keychain or typed into the fields. */
  const tokensReady = () => (hasBot() || Boolean(botToken().trim())) && (hasApp() || Boolean(appToken().trim()));
  const noteIsError = () => /^(❌|Save failed|Saved, but)/.test(note()) || /could not|failed/i.test(note());

  const statusView = createMemo(() => {
    const s = status();
    const error = s.error ?? "";
    if (s.state === "connected") {
      const bound = boundConnection();
      return {
        cls: "on",
        title: "Bot running",
        sub: error || (bound
          ? `Answering questions in Slack against ${bound.label}.`
          : s.connectionId
            ? "Its connection is closed. Pick another below."
            : "Waiting for a connection to answer against."),
      };
    }
    if (s.state === "connecting") {
      return { cls: "wait", title: error ? "Reconnecting…" : "Connecting…", sub: error || "Opening the Socket Mode connection." };
    }
    if (s.running) {
      return { cls: "wait", title: s.state, sub: error };
    }
    if (error && slackTone(s) === "wait") return { cls: "wait", title: "Bot waiting", sub: error };
    if (error) return { cls: "err", title: "Bot off", sub: error };
    if (!tokensReady()) return { cls: "off", title: "Bot off", sub: "Add both Slack app tokens below, then switch on." };
    if (cfg().enabled)
      return {
        cls: "off",
        title: "Bot off",
        // Autostart is scoped to one saved connection, so say which — "starts on the
        // next launch" was a promise the bot could only keep by binding to anything.
        sub: cfg().boundProfileId
          ? "Starts when its saved connection is open."
          : "Autostart is on with no saved connection. Bind the bot to one below.",
      };
    return { cls: "off", title: "Bot off", sub: "Switch on to answer questions in Slack." };
  });

  const mirrored = () => mirroredAi(ai());
  const aiSynced = () => slackAiInSync(cfg(), ai());

  return (
    <Show when={configLoaded()} fallback={<div class="settings-note">Loading Slack settings…</div>}>
      <div class="slack-pane">
        {/* ------------------------------------------------ status + switch */}
        <div class="slack-status" classList={{ [statusView().cls]: true }}>
          <span class="slack-dot" aria-hidden="true" />
          <div class="slack-status-text">
            <b>{statusView().title}</b>
            <small>{statusView().sub}</small>
          </div>
          <label
            class="slack-switch"
            title={tokensReady() ? (cfg().enabled ? "Stop the bot" : "Start the bot") : "Both tokens are required"}
          >
            <span>{cfg().enabled ? "On" : "Off"}</span>
            <input
              type="checkbox"
              class="switch"
              role="switch"
              checked={cfg().enabled}
              disabled={busy() || (!cfg().enabled && !tokensReady())}
              onChange={(e) => void applyEnabled(e.currentTarget.checked)}
            />
          </label>
        </div>
        <Show when={note()}>
          <div class="slack-note" classList={{ error: noteIsError() }}>{note()}</div>
        </Show>

        {/* Which Tusk connection the bot answers against. Several can be open, so this
            is an explicit binding rather than "whichever tab you happen to be on":
            a question asked in Slack must not change database because you switched
            tabs in the app. While the bot is stopped the same picker STARTS it bound
            to the choice — it used to appear only for a running bot, which left an
            armed-but-unbound bot (a config from before bindings existed) with no way
            in except switching Off and On again. */}
        <Show when={openConnections().length > 0 && (status().running
          ? openConnections().length > 1 || (!!status().connectionId && !boundConnection())
          : tokensReady())}>
          <div class="settings-label slack-conn-row">
            <div>
              <label for="slack-conn">{status().running ? "Answers against" : "Bind to"}</label>
              <small>
                {status().running
                  ? boundConnection()
                    ? "Proposals are pinned to this connection."
                    : "The bot's connection is closed. Pick another."
                  : "Starts the bot against this connection. A saved connection also arms autostart."}
              </small>
            </div>
            <select
              id="slack-conn"
              value={(status().running && status().connectionId) || ""}
              disabled={busy()}
              onChange={(e) => {
                const id = e.currentTarget.value;
                if (id) void bindTo(id);
              }}
            >
              <Show when={!status().running || !boundConnection()}>
                <option value="">{status().running ? "(connection closed)" : "Choose a connection…"}</option>
              </Show>
              <For each={openConnections()}>
                {(c) => <option value={c.id}>{c.mascot} {c.label}</option>}
              </For>
            </select>
          </div>
        </Show>

        <fieldset class="slack-fieldset" disabled={busy()}>
          {/* ------------------------------------------------ tokens */}
          <section class="settings-section">
            <header class="settings-section-head">
              <h3 class="settings-section-title">Slack app tokens</h3>
            </header>
            <div class="settings-note">
              Create a Slack app from the manifest in <code>docs/slack-setup.md</code>, then paste its two
              tokens here. Questions become SQL proposals; nothing runs without an Approve click.
            </div>
            {/* `display: contents` form: a bare password input outside one makes
                every Chromium build log a DOM warning. */}
            <form class="subform" onSubmit={(e) => e.preventDefault()}>
            <label class="settings-row">
              <span class="settings-label">
                <span>Bot token <Show when={hasBot()}><span class="ai-chip ok">saved</span></Show></span>
                <small>Starts with <code>xoxb-</code>. OAuth &amp; Permissions → Install to Workspace.</small>
              </span>
              <input
                type="password"
                autocomplete="off"
                placeholder={hasBot() ? "Type to replace" : "xoxb-…"}
                value={botToken()}
                onInput={(e) => setBotToken(e.currentTarget.value)}
              />
            </label>
            <label class="settings-row">
              <span class="settings-label">
                <span>App-level token <Show when={hasApp()}><span class="ai-chip ok">saved</span></Show></span>
                <small>Starts with <code>xapp-</code>, scope <code>connections:write</code>. Basic Information → App-Level Tokens.</small>
              </span>
              <input
                type="password"
                autocomplete="off"
                placeholder={hasApp() ? "Type to replace" : "xapp-…"}
                value={appToken()}
                onInput={(e) => setAppToken(e.currentTarget.value)}
              />
            </label>
            </form>
            <div class="settings-actions">
              <Show when={status().running && typedTokens()}>
                <span class="settings-hint">Saving replacement tokens restarts the bot; failed validation stops it.</span>
              </Show>
              <span class="spacer" />
              <button class="ghost" disabled={busy() || !tokensReady()} onClick={() => void test()}>Test connection</button>
              <button class="run" disabled={busy() || !typedTokens()} onClick={() => void saveOnly()}>Save tokens</button>
            </div>
          </section>

          {/* ------------------------------------------------ access */}
          <section class="settings-section">
            <header class="settings-section-head">
              <h3 class="settings-section-title">Who can ask</h3>
            </header>
            <div class="settings-note">An empty list allows anyone in the bot's channels.</div>
            <label class="settings-row">
              <span class="settings-label">
                <span>Allowed channels</span>
                <small>Comma-separated channel or DM IDs. They start with <code>C</code> or <code>D</code>.</small>
              </span>
              <input
                type="text"
                placeholder="Any channel"
                value={csv(cfg().allowlistChannels)}
                onChange={(e) => applyPatch({ allowlistChannels: parseCsv(e.currentTarget.value) })}
              />
            </label>
            <label class="settings-row">
              <span class="settings-label">
                <span>Allowed users</span>
                <small>Comma-separated Slack member IDs. They start with <code>U</code>.</small>
              </span>
              <input
                type="text"
                placeholder="Anyone"
                value={csv(cfg().allowlistUsers)}
                onChange={(e) => applyPatch({ allowlistUsers: parseCsv(e.currentTarget.value) })}
              />
            </label>
          </section>

          {/* ------------------------------------------------ answers */}
          <section class="settings-section">
            <header class="settings-section-head">
              <h3 class="settings-section-title">Answers</h3>
            </header>
            <label class="settings-row">
              <span class="settings-label">
                <span>Rows shown inline</span>
                <small>Rows posted as a text table (1–100); larger results attach as a file.</small>
              </span>
              <input
                type="number"
                min="1"
                max="100"
                value={cfg().maxRowsInline}
                onChange={(e) => applyPatch({ maxRowsInline: clampInt(e.currentTarget.value, 1, 100, 20) })}
              />
            </label>
            <label class="settings-row">
              <span class="settings-label">
                <span>Row cap</span>
                <small>Maximum rows in any answer, files included (100–100,000).</small>
              </span>
              <input
                type="number"
                min="100"
                max="100000"
                value={cfg().maxRowsFile}
                onChange={(e) => applyPatch({ maxRowsFile: clampInt(e.currentTarget.value, 100, 100000, 10000) })}
              />
            </label>
            <label class="settings-row">
              <span class="settings-label">
                <span>Query timeout</span>
                <small>Seconds before the bot gives up (1–600).</small>
              </span>
              <input
                type="number"
                min="1"
                max="600"
                value={cfg().queryTimeoutSecs}
                onChange={(e) => applyPatch({ queryTimeoutSecs: clampInt(e.currentTarget.value, 1, 600, 30) })}
              />
            </label>
            <label class="settings-row">
              <span class="settings-label">
                <span>Auto-chart date/numeric results</span>
                <small>Charts render locally; a requested chart is always drawn.</small>
              </span>
              <input type="checkbox" checked={cfg().chartsEnabled} onChange={(e) => applyPatch({ chartsEnabled: e.currentTarget.checked })} />
            </label>
            <label class="settings-row">
              <span class="settings-label">
                <span>When asked for a write or DDL</span>
                <small>Writes never run from Slack.</small>
              </span>
              <select
                value={cfg().destructivePolicy}
                onChange={(e) => applyPatch({ destructivePolicy: e.currentTarget.value })}
              >
                <option value="proposeReadonly">Propose a read-only preview</option>
                <option value="refuse">Refuse and point to the editor</option>
              </select>
            </label>
          </section>

          {/* ------------------------------------------------ AI */}
          <section class="settings-section">
            <header class="settings-section-head">
              <h3 class="settings-section-title">AI</h3>
              <Show when={props.onOpenAi}>
                <div class="settings-section-actions">
                  <button class="ghost" onClick={() => props.onOpenAi?.()}>Open AI settings</button>
                </div>
              </Show>
            </header>
            <div class="settings-row">
              <span class="settings-label">
                <span>Provider / model</span>
                <small>
                  <Show
                    when={cfg().aiProvider}
                    fallback={<>Copied from Settings → AI the first time these settings save.</>}
                  >
                    <Show
                      when={aiSynced()}
                      fallback={<>Settings → AI now selects <b>{mirrored().provider} / {mirrored().model}</b>. Select Update bot to switch.</>}
                    >
                      Matches Settings → AI.
                    </Show>
                  </Show>
                </small>
              </span>
              <span class="settings-inline">
                <code class="slack-model">
                  {cfg().aiProvider ? `${cfg().aiProvider} / ${cfg().aiModel || "no model"}` : `${mirrored().provider} / ${mirrored().model}`}
                </code>
                <Show when={cfg().aiProvider && !aiSynced()}>
                  <button class="run" disabled={busy()} onClick={() => applyPatch({})}>Update bot</button>
                </Show>
              </span>
            </div>
            <label class="settings-row">
              <span class="settings-label">
                <span>AI reply max tokens</span>
                <small>Longest reply the model may return (256–128,000, snapped to 256).</small>
              </span>
              <input
                type="number"
                min="256"
                max="128000"
                step="256"
                value={maxTokensInput()}
                onInput={(e) => {
                  setMaxTokensInput(e.currentTarget.value);
                  if (e.currentTarget.value.trim()) patch({ aiMaxTokens: normalizeSlackMaxTokens(e.currentTarget.value, cfg().aiMaxTokens) });
                }}
                onBlur={() => {
                  const normalized = normalizeSlackMaxTokens(maxTokensInput(), cfg().aiMaxTokens);
                  setMaxTokensInput(String(normalized));
                  applyPatch({ aiMaxTokens: normalized });
                }}
              />
            </label>
            <label class="settings-row">
              <span class="settings-label">
                <span>Share sample rows with AI</span>
                <small>Sends up to five real rows from relevant tables to the provider. Off by default.</small>
              </span>
              <input type="checkbox" checked={cfg().shareSamples} onChange={(e) => applyPatch({ shareSamples: e.currentTarget.checked })} />
            </label>
          </section>
        </fieldset>
      </div>
    </Show>
  );
}
