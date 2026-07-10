// Settings → Slack: desktop-hosted Socket Mode bot configuration. Tokens go straight
// to the OS keychain via `slack_save_config` (never echoed back); the non-secret
// config lives in slack.json. The AI provider/model is mirrored from the AI panel's
// localStorage config at save time (the Rust bot can't read the WebView's storage).

import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { activeBaseUrl, aiStore, defaultModel, isKeyless, resolveBaseUrl, resolveWire } from "../ai/store";

type SlackConfig = {
  enabled: boolean;
  allowlistChannels: string[];
  allowlistUsers: string[];
  maxRowsInline: number;
  maxRowsFile: number;
  queryTimeoutSecs: number;
  chartsEnabled: boolean;
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

const DEFAULT_CONFIG: SlackConfig = {
  enabled: false,
  allowlistChannels: [],
  allowlistUsers: [],
  maxRowsInline: 20,
  maxRowsFile: 10000,
  queryTimeoutSecs: 30,
  chartsEnabled: true,
  destructivePolicy: "proposeReadonly",
  aiProvider: "",
  aiWire: "",
  aiModel: "",
  aiBaseUrl: null,
  aiMaxTokens: 2048,
  aiAllowNoKey: false,
};

const errMsg = (e: unknown): string => (e as { message?: string })?.message ?? String(e);

export function SlackPane() {
  const [cfg, setCfg] = createSignal<SlackConfig>(DEFAULT_CONFIG);
  const [hasBot, setHasBot] = createSignal(false);
  const [hasApp, setHasApp] = createSignal(false);
  const [botToken, setBotToken] = createSignal("");
  const [appToken, setAppToken] = createSignal("");
  const [status, setStatus] = createSignal<SlackStatus>({ running: false, state: "disconnected", error: null });
  const [note, setNote] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  let unlisten: UnlistenFn | undefined;
  onMount(async () => {
    try {
      const info = await invoke<SlackConfigInfo>("slack_load_config");
      setCfg({ ...DEFAULT_CONFIG, ...info.config });
      setHasBot(info.hasBotToken);
      setHasApp(info.hasAppToken);
    } catch {
      /* defaults stand */
    }
    try {
      setStatus(await invoke<SlackStatus>("slack_status"));
    } catch {
      /* ignore */
    }
    unlisten = await listen<SlackStatus>("slack:status", (e) => setStatus(e.payload));
  });
  onCleanup(() => unlisten?.());

  const patch = (p: Partial<SlackConfig>) => setCfg({ ...cfg(), ...p });
  const csv = (list: string[]) => list.join(", ");
  const parseCsv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

  // Persist config + any newly typed tokens; mirror the AI panel's provider/model.
  // `override` lets callers pin fields (notably `enabled`) independent of the signal.
  const save = async (override: Partial<SlackConfig> = {}): Promise<boolean> => {
    const ai = aiStore.load();
    const model = ai.model || defaultModel(ai.provider);
    const wire = resolveWire(ai.provider, model);
    const config: SlackConfig = {
      ...cfg(),
      ...override,
      aiProvider: ai.provider,
      // The registry lives in TS, so the bot gets the RESOLVED wire and base URL —
      // it can't look them up. Wire is per-model (OpenCode); an unsupported model
      // falls back to the provider's default wire and will surface as a bot error
      // rather than silently hitting the wrong endpoint.
      aiWire: wire ?? "",
      aiModel: model,
      // Wire-resolved: some gateways host a wire under a sub-path (Zen's gemini).
      aiBaseUrl: resolveBaseUrl(ai.provider, activeBaseUrl(ai), wire ?? undefined) || null,
      aiAllowNoKey: isKeyless(ai.provider),
    };
    try {
      await invoke("slack_save_config", {
        config,
        botToken: botToken().trim() || null,
        appToken: appToken().trim() || null,
      });
      if (botToken().trim()) setHasBot(true);
      if (appToken().trim()) setHasApp(true);
      setBotToken("");
      setAppToken("");
      setCfg(config);
      return true;
    } catch (e) {
      setNote(`Save failed: ${errMsg(e)}`);
      return false;
    }
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
        await invoke("slack_start");
        await save({ enabled: true });
        setNote("Bot started.");
      } else {
        if (!(await save({ enabled: false }))) return;
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
    try {
      if (!(await save())) return;
      const team = await invoke<string>("slack_test");
      setNote(`✅ Tokens valid — workspace “${team}”.`);
    } catch (e) {
      setNote(`❌ ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveOnly = async () => {
    setBusy(true);
    setNote("");
    if (await save()) setNote("Saved — applies to the running bot on the next question.");
    setBusy(false);
  };

  const statusDot = () => (status().state === "connected" ? "🟢" : status().state === "connecting" ? "🟡" : "🔴");

  return (
    <>
      <div class="settings-note">
        The bot runs inside Tusk (Socket Mode — no server, no public URL) while the app is open, against the
        active connection. Create your own Slack app at api.slack.com/apps (see docs/slack-setup.md), then paste
        its tokens here. Questions in Slack become SQL proposals; nothing runs without an Approve click.
      </div>

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

      <label class="settings-row">
        <span>Max rows (inline table)</span>
        <input
          type="number"
          min="1"
          max="100"
          value={cfg().maxRowsInline}
          onChange={(e) => patch({ maxRowsInline: Math.max(1, Math.min(100, Number(e.currentTarget.value) || 20)) })}
        />
      </label>
      <label class="settings-row">
        <span>Max rows (file / hard cap)</span>
        <input
          type="number"
          min="100"
          max="1000000"
          value={cfg().maxRowsFile}
          onChange={(e) => patch({ maxRowsFile: Math.max(100, Math.min(1000000, Number(e.currentTarget.value) || 10000)) })}
        />
      </label>
      <label class="settings-row">
        <span>Query timeout (seconds)</span>
        <input
          type="number"
          min="1"
          max="600"
          value={cfg().queryTimeoutSecs}
          onChange={(e) => patch({ queryTimeoutSecs: Math.max(1, Math.min(600, Number(e.currentTarget.value) || 30)) })}
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
          value={cfg().aiMaxTokens}
          onChange={(e) => patch({ aiMaxTokens: Math.max(256, Math.min(128000, Number(e.currentTarget.value) || 2048)) })}
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

      <div class="settings-note">
        AI provider: uses the same provider/model as the in-app AI panel (currently{" "}
        <b>{aiStore.load().provider} / {aiStore.load().model || "no model"}</b>) — configure it there, then Save here.
      </div>

      <Show when={note()}>
        <div class="settings-note">{note()}</div>
      </Show>
    </>
  );
}
