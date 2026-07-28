// Settings → Slack: desktop-hosted Socket Mode bot configuration. Tokens go straight
// to the OS keychain via `slack_save_config` (never echoed back); the non-secret
// config lives in slack.json. The AI provider/model is mirrored from the AI panel's
// localStorage config at save time (the Rust bot can't read the WebView's storage).

import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { activeBaseUrl, aiStore, defaultModel, isKeyless, normalizeMaxTokens, resolveBaseUrl, resolveWire, type AiConfig } from "../ai/store";

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

type SaveResult = { tokensChanged: boolean };

export function SlackPane() {
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
        const info = await invoke<SlackConfigInfo>("slack_load_config");
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

  // Persist config + any newly typed tokens; mirror the AI panel's provider/model.
  // `override` lets callers pin fields (notably `enabled`) independent of the signal.
  const save = async (override: Partial<SlackConfig> = {}): Promise<SaveResult | null> => {
    const currentAi = ai();
    const model = currentAi.model || defaultModel(currentAi.provider);
    const wire = resolveWire(currentAi.provider, model);
    const tokensChanged = Boolean(botToken().trim() || appToken().trim());
    const config: SlackConfig = {
      ...cfg(),
      ...override,
      shareSamples: cfg().shareSamples === true,
      aiMaxTokens: normalizeSlackMaxTokens(maxTokensInput(), cfg().aiMaxTokens),
      aiProvider: currentAi.provider,
      // The registry lives in TS, so the bot gets the RESOLVED wire and base URL —
      // it can't look them up. Wire is per-model (OpenCode); an unsupported model
      // falls back to the provider's default wire and will surface as a bot error
      // rather than silently hitting the wrong endpoint.
      aiWire: wire ?? "",
      aiModel: model,
      // Wire-resolved: some gateways host a wire under a sub-path (Zen's gemini).
      aiBaseUrl: resolveBaseUrl(currentAi.provider, activeBaseUrl(currentAi), wire ?? undefined) || null,
      aiAllowNoKey: isKeyless(currentAi.provider),
    };
    try {
      await invoke("slack_save_config", {
        config,
        botToken: botToken().trim() || null,
        appToken: appToken().trim() || null,
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
      setBotToken("");
      setAppToken("");
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

  const statusDot = () => (status().state === "connected" ? "🟢" : status().state === "connecting" ? "🟡" : "🔴");

  return (
    <Show when={configLoaded()} fallback={<div class="settings-note">Loading Slack settings…</div>}>
      <>
      <div class="settings-note">
        The bot runs inside Tusk (Socket Mode — no server, no public URL) while the app is open, against the
        active connection. Create your own Slack app at api.slack.com/apps (see docs/slack-setup.md), then paste
        its tokens here. Questions in Slack become SQL proposals; nothing runs without an Approve click.
      </div>

      <fieldset class="slack-fieldset" disabled={busy()}>
      <label class="settings-row">
        <span>Enable Slack bot</span>
        <input type="checkbox" checked={cfg().enabled} disabled={busy()} onChange={(e) => void applyEnabled(e.currentTarget.checked)} />
      </label>
      <label class="settings-row">
        <span>Status</span>
        <span>
          {statusDot()} {status().state}
          <Show when={status().error}> — {status().error}</Show>
        </span>
      </label>

      <label class="settings-row">
        <span>Bot token (xoxb-…)</span>
        <input
          type="password"
          placeholder={hasBot() ? "saved in keychain — type to replace" : "xoxb-…"}
          value={botToken()}
          onInput={(e) => setBotToken(e.currentTarget.value)}
        />
      </label>
      <label class="settings-row">
        <span>App-level token (xapp-…)</span>
        <input
          type="password"
          placeholder={hasApp() ? "saved in keychain — type to replace" : "xapp-… (connections:write)"}
          value={appToken()}
          onInput={(e) => setAppToken(e.currentTarget.value)}
        />
      </label>
      <div class="settings-row">
        <span />
        <span class="settings-inline">
          <button class="ghost" disabled={busy()} onClick={() => void test()}>Test connection</button>
          <button class="ghost" disabled={busy()} onClick={() => void saveOnly()}>Save</button>
        </span>
      </div>
      <Show when={status().running && (botToken().trim() || appToken().trim())}>
        <div class="settings-note">Saving replacement tokens restarts the running bot. Failed validation stops and disables it.</div>
      </Show>

      <label class="settings-row">
        <span>Max rows (inline table)</span>
        <input
          type="number"
          min="1"
          max="100"
          value={cfg().maxRowsInline}
          onChange={(e) => patch({ maxRowsInline: Math.trunc(Math.max(1, Math.min(100, Number(e.currentTarget.value) || 20))) })}
        />
      </label>
      <label class="settings-row">
        <span>Max rows (file / hard cap)</span>
        <input
          type="number"
          min="100"
          max="100000"
          value={cfg().maxRowsFile}
          onChange={(e) => patch({ maxRowsFile: Math.trunc(Math.max(100, Math.min(100000, Number(e.currentTarget.value) || 10000))) })}
        />
      </label>
      <label class="settings-row">
        <span>Query timeout (seconds)</span>
        <input
          type="number"
          min="1"
          max="600"
          value={cfg().queryTimeoutSecs}
          onChange={(e) => patch({ queryTimeoutSecs: Math.trunc(Math.max(1, Math.min(600, Number(e.currentTarget.value) || 30))) })}
        />
      </label>
      <label
        class="settings-row"
        title="Upper bound on the AI's reply length, in tokens. Too low cuts replies (and their SQL) off mid-sentence; the provider may cap it lower than this."
      >
        <span>AI reply max tokens</span>
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
            patch({ aiMaxTokens: normalized });
            setMaxTokensInput(String(normalized));
          }}
        />
      </label>

      <label class="settings-row" title="Slack channel IDs (C…/D…), comma-separated. Empty = any channel the bot is in.">
        <span>Allowed channels</span>
        <input
          type="text"
          placeholder="empty = all"
          value={csv(cfg().allowlistChannels)}
          onChange={(e) => patch({ allowlistChannels: parseCsv(e.currentTarget.value) })}
        />
      </label>
      <label class="settings-row" title="Slack user IDs (U…), comma-separated. Empty = anyone in an allowed channel.">
        <span>Allowed users</span>
        <input
          type="text"
          placeholder="empty = all"
          value={csv(cfg().allowlistUsers)}
          onChange={(e) => patch({ allowlistUsers: parseCsv(e.currentTarget.value) })}
        />
      </label>

      <label
        class="settings-row"
        title="Writes/DDL NEVER run from Slack regardless — this only picks the bot's reply: propose a read-only SELECT previewing the affected data, or refuse outright."
      >
        <span>When asked for writes/DDL</span>
        <select
          value={cfg().destructivePolicy}
          onChange={(e) => patch({ destructivePolicy: e.currentTarget.value })}
        >
          <option value="proposeReadonly">Propose read-only preview</option>
          <option value="refuse">Refuse & point to editor</option>
        </select>
      </label>

      <label
        class="settings-row"
        title="Rendered locally in Tusk (no external service). When off, date+numeric results attach as files instead; a chart the user explicitly asks for is always honored."
      >
        <span>Auto-chart date/numeric results</span>
        <input type="checkbox" checked={cfg().chartsEnabled} onChange={(e) => patch({ chartsEnabled: e.currentTarget.checked })} />
      </label>

      <label
        class="settings-row"
        title="When enabled, up to five real rows from relevant tables are sent to the configured AI provider with each Slack question. Off by default."
      >
        <span>Share sample rows with AI</span>
        <input type="checkbox" checked={cfg().shareSamples} onChange={(e) => patch({ shareSamples: e.currentTarget.checked })} />
      </label>
      </fieldset>

      <div class="settings-note">
        AI provider: uses the same provider/model as the in-app AI panel (currently{" "}
        <b>{ai().provider} / {ai().model || "no model"}</b>) — configure it there, then Save here.
      </div>

      <Show when={note()}>
        <div class="settings-note">{note()}</div>
      </Show>
      </>
    </Show>
  );
}
