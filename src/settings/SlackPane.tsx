// Settings → Slack: desktop-hosted Socket Mode bot configuration. Tokens go straight
// to the OS keychain via `slack_save_config` (never echoed back); the non-secret
// config lives in slack.json. The AI provider/model is mirrored from the AI panel's
// localStorage config at save time (the Rust bot can't read the WebView's storage).
//
// Layout: one status card (state + on/off switch) followed by four sections — Slack app
// tokens, Who can ask, Answers, AI — each a header plus label/hint/control rows. Every
// non-token control saves as it changes; the token section keeps explicit Save/Test.

import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { activeBaseUrl, aiStore, defaultModel, isKeyless, normalizeMaxTokens, resolveBaseUrl, resolveWire, type AiConfig, type AiProvider } from "../ai/store";
import { KeyedSerialQueue } from "../asyncQueue";

export type SlackConfig = {
  enabled: boolean;
  allowlistChannels: string[];
  allowlistUsers: string[];
  maxRowsInline: number;
  maxRowsFile: number;
  queryTimeoutSecs: number;
  chartsEnabled: boolean;
  shareSamples: boolean;
  destructivePolicy: string;
  aiProvider: string;
  /** Wire protocol, resolved from the TS provider registry at save time. */
  aiWire: string;
  aiModel: string;
  aiBaseUrl: string | null;
  aiMaxTokens: number;
  aiAllowNoKey: boolean;
};

type SlackConfigInfo = { config: SlackConfig; hasBotToken: boolean; hasAppToken: boolean };
export type SlackStatus = { running: boolean; state: string; error: string | null };

export const DEFAULT_CONFIG: SlackConfig = {
  enabled: false,
  allowlistChannels: [],
  allowlistUsers: [],
  maxRowsInline: 20,
  maxRowsFile: 10000,
  queryTimeoutSecs: 30,
  chartsEnabled: true,
  shareSamples: false,
  destructivePolicy: "proposeReadonly",
  aiProvider: "",
  aiWire: "",
  aiModel: "",
  aiBaseUrl: null,
  aiMaxTokens: 2048,
  aiAllowNoKey: false,
};

const errMsg = (e: unknown): string => (e as { message?: string })?.message ?? String(e);

/** One normalization for every AI surface — see `normalizeMaxTokens` in ai/store.ts. */
export const normalizeSlackMaxTokens = normalizeMaxTokens;

/** Normalize newly-added privacy/token fields when loading older config documents. */
export const normalizeSlackConfig = (raw?: Partial<SlackConfig> | null): SlackConfig => ({
  ...DEFAULT_CONFIG,
  ...raw,
  allowlistChannels: Array.isArray(raw?.allowlistChannels) ? raw.allowlistChannels : [],
  allowlistUsers: Array.isArray(raw?.allowlistUsers) ? raw.allowlistUsers : [],
  shareSamples: raw?.shareSamples === true,
  aiMaxTokens: normalizeSlackMaxTokens(raw?.aiMaxTokens ?? DEFAULT_CONFIG.aiMaxTokens),
});

export const slackConfigMatches = (expected: SlackConfig, actual: SlackConfig): boolean =>
  (Object.keys(DEFAULT_CONFIG) as (keyof SlackConfig)[]).every(
    (key) => JSON.stringify(expected[key]) === JSON.stringify(actual[key]),
  );

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

// Module-level so a save still in flight when the pane unmounts (settings tab switch
// remounts panes) is ordered before the next mount's load — the fresh pane can never
// read the pre-save file.
const slackIo = new KeyedSerialQueue<"io">();

const clampInt = (v: string, min: number, max: number, fallback: number) =>
  Math.trunc(Math.max(min, Math.min(max, Number(v) || fallback)));

export function SlackPane(props: { onOpenAi?: () => void }) {
  const [cfg, setCfg] = createSignal<SlackConfig>(DEFAULT_CONFIG);
  const [configLoaded, setConfigLoaded] = createSignal(false);
  const [ai, setAi] = createSignal<AiConfig>(aiStore.load());
  const [hasBot, setHasBot] = createSignal(false);
  const [hasApp, setHasApp] = createSignal(false);
  const [botToken, setBotToken] = createSignal("");
  const [appToken, setAppToken] = createSignal("");
  const [status, setStatus] = createSignal<SlackStatus>({ running: false, state: "disconnected", error: null });
  const [note, setNote] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [maxTokensInput, setMaxTokensInput] = createSignal(String(DEFAULT_CONFIG.aiMaxTokens));

  let unlisten: UnlistenFn | undefined;
  let unsubscribeAi = () => {};
  let mounted = true;
  let statusRevision = 0;
  onMount(() => {
    unsubscribeAi = aiStore.subscribe(setAi);
    void (async () => {
      try {
        const info = await slackIo.run("io", () => invoke<SlackConfigInfo>("slack_load_config"));
        if (!mounted) return;
        const loaded = normalizeSlackConfig(info.config);
        setCfg(loaded);
        setMaxTokensInput(String(loaded.aiMaxTokens));
        setHasBot(info.hasBotToken);
        setHasApp(info.hasAppToken);
      } catch {
        /* defaults stand */
      } finally {
        if (mounted) setConfigLoaded(true);
      }
    })();
    void (async () => {
      try {
        const stop = await listen<SlackStatus>("slack:status", (e) => {
          statusRevision++;
          setStatus(e.payload);
        });
        if (!mounted) {
          stop();
          return;
        }
        unlisten = stop;
      } catch {
        /* status events unavailable */
      }
      const revision = statusRevision;
      try {
        const current = await invoke<SlackStatus>("slack_status");
        if (mounted && statusRevision === revision) setStatus(current);
      } catch {
        /* ignore */
      }
    })();
  });
  onCleanup(() => {
    mounted = false;
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
        if (!mounted) return;
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
        throw new Error("Slack settings verification failed: saved values did not reload unchanged");
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
      : `${message} Disabling could not be verified; the bot is stopped, but the startup setting may still be enabled.`);
  };

  const applyEnabled = async (enabled: boolean) => {
    patch({ enabled });
    setBusy(true);
    setNote("");
    try {
      if (enabled) {
        // Persist enabled:FALSE first, then start; only persist enabled:true after a
        // clean start. So a failed start never leaves enabled:true on disk (which
        // would autostart the bot on the next launch despite the toggle showing off).
        if (!(await save({ enabled: false }))) {
          patch({ enabled: false });
          return;
        }
        await invoke("slack_test");
        await invoke("slack_start");
        if (!(await save({ enabled: true }))) {
          await disableAfterRestartFailure("Bot started, but enabling could not be persisted. Bot stopped and remains disabled.");
          return;
        }
        setNote("Bot started.");
      } else {
        if (!(await save({ enabled: false }))) {
          patch({ enabled: true });
          return;
        }
        await invoke("slack_stop");
        setNote("Bot stopped.");
      }
    } catch (e) {
      setNote(errMsg(e));
      patch({ enabled: false });
      await save({ enabled: false }).catch(() => {}); // ensure disk = disabled
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
        await invoke("slack_start");
        setNote(`✅ Tokens valid — workspace “${team}”. Bot restarted with the replacement tokens.`);
      } else {
        setNote(`✅ Tokens valid — workspace “${team}”.`);
      }
    } catch (e) {
      if (wasRunning && saved?.tokensChanged) {
        await disableAfterRestartFailure(tokensValidated
          ? `❌ ${errMsg(e)} Tokens validated, but the bot could not restart; it was stopped and disabled.`
          : `❌ ${errMsg(e)} Bot stopped because replacement tokens could not be validated.`);
      } else {
        setNote(`❌ ${errMsg(e)}`);
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
          await invoke("slack_start");
          setNote("Saved and validated. Bot restarted with the replacement tokens.");
        } catch (e) {
          await disableAfterRestartFailure(`Saved, but token restart failed: ${errMsg(e)} Bot stopped and was disabled.`);
        }
      } else {
        setNote("Saved — non-token changes apply to the running bot on the next question.");
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
      return { cls: "on", title: "Bot running", sub: error || "Answering questions in Slack against the active connection." };
    }
    if (s.state === "connecting") {
      return { cls: "wait", title: error ? "Reconnecting…" : "Connecting…", sub: error || "Opening the Socket Mode connection." };
    }
    if (s.running) {
      return { cls: "wait", title: s.state, sub: error };
    }
    if (error) return { cls: "err", title: "Bot off", sub: error };
    if (!tokensReady()) return { cls: "off", title: "Bot off", sub: "Add both Slack app tokens below, then switch it on." };
    if (cfg().enabled) return { cls: "off", title: "Bot off", sub: "Starts with Tusk on the next launch." };
    return { cls: "off", title: "Bot off", sub: "Switch on to start answering questions in Slack." };
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
            title={tokensReady() ? (cfg().enabled ? "Stop the bot" : "Validate the tokens and start the bot") : "Both tokens are required before the bot can start"}
          >
            <span>{cfg().enabled ? "On" : "Off"}</span>
            <input
              type="checkbox"
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

        <fieldset class="slack-fieldset" disabled={busy()}>
          {/* ------------------------------------------------ tokens */}
          <section class="settings-section">
            <header class="settings-section-head">
              <h3 class="settings-section-title">Slack app tokens</h3>
              <span class="settings-section-sub">stored in your OS keychain, never shown again</span>
            </header>
            <div class="settings-note">
              Create your own Slack app from the manifest in <code>docs/slack-setup.md</code> (Socket Mode — no server,
              no public URL), then paste its two tokens here. Questions in Slack become SQL proposals; nothing runs
              without an Approve click.
            </div>
            <label class="settings-row">
              <span class="settings-label">
                <span>Bot token <Show when={hasBot()}><span class="ai-chip ok">saved</span></Show></span>
                <small>Starts with <code>xoxb-</code>. OAuth &amp; Permissions → Install to Workspace.</small>
              </span>
              <input
                type="password"
                autocomplete="off"
                placeholder={hasBot() ? "type to replace" : "xoxb-…"}
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
                placeholder={hasApp() ? "type to replace" : "xapp-…"}
                value={appToken()}
                onInput={(e) => setAppToken(e.currentTarget.value)}
              />
            </label>
            <div class="settings-actions">
              <Show when={status().running && typedTokens()}>
                <span class="settings-hint">Saving replacement tokens restarts the running bot; failed validation stops and disables it.</span>
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
              <span class="settings-section-sub">both lists empty = anyone in any channel the bot is in</span>
            </header>
            <label class="settings-row">
              <span class="settings-label">
                <span>Allowed channels</span>
                <small>Channel or DM IDs (<code>C…</code> / <code>D…</code>), comma-separated.</small>
              </span>
              <input
                type="text"
                placeholder="any channel"
                value={csv(cfg().allowlistChannels)}
                onChange={(e) => applyPatch({ allowlistChannels: parseCsv(e.currentTarget.value) })}
              />
            </label>
            <label class="settings-row">
              <span class="settings-label">
                <span>Allowed users</span>
                <small>Slack member IDs (<code>U…</code>), comma-separated.</small>
              </span>
              <input
                type="text"
                placeholder="anyone"
                value={csv(cfg().allowlistUsers)}
                onChange={(e) => applyPatch({ allowlistUsers: parseCsv(e.currentTarget.value) })}
              />
            </label>
          </section>

          {/* ------------------------------------------------ answers */}
          <section class="settings-section">
            <header class="settings-section-head">
              <h3 class="settings-section-title">Answers</h3>
              <span class="settings-section-sub">how results come back to Slack</span>
            </header>
            <label class="settings-row">
              <span class="settings-label">
                <span>Rows shown inline</span>
                <small>Up to this many rows post as a text table (1–100); larger results attach as a file.</small>
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
                <small>Hard limit for any answer, including file attachments (100–100,000). Results past it are truncated and say so.</small>
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
                <small>Seconds before the bot gives up (1–600). Postgres queries are cancelled server-side.</small>
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
                <small>Rendered locally, nothing extra leaves your machine. A chart someone explicitly asks for is always drawn.</small>
              </span>
              <input type="checkbox" checked={cfg().chartsEnabled} onChange={(e) => applyPatch({ chartsEnabled: e.currentTarget.checked })} />
            </label>
            <label class="settings-row">
              <span class="settings-label">
                <span>When asked for a write or DDL</span>
                <small>Writes never run from Slack. This only picks the reply.</small>
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
              <span class="settings-section-sub">the bot uses the provider and model chosen in Settings → AI</span>
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
                      fallback={<>Settings → AI now selects <b>{mirrored().provider} / {mirrored().model}</b>. The bot still uses the pair on the right until updated.</>}
                    >
                      Matches Settings → AI. Change it there and the bot follows on the next save.
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
                <small>Ceiling for a reply and its SQL (256–128,000, snapped to 256). Too low cuts answers off mid-sentence.</small>
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
                <small>Sends up to five real rows from relevant tables to the provider with each question. Off by default.</small>
              </span>
              <input type="checkbox" checked={cfg().shareSamples} onChange={(e) => applyPatch({ shareSamples: e.currentTarget.checked })} />
            </label>
          </section>
        </fieldset>
      </div>
    </Show>
  );
}
