// The Slack bot's binding model, shared by Settings → Slack and the statusbar badge
// menu. Both surfaces start, stop and repoint the SAME bot and persist the SAME two
// fields (`enabled`, `boundProfileId`), so the sequences live here once: a start that
// fails can never leave `enabled: true` on disk, and a repoint always re-arms
// autostart at the connection the bot actually answers on.
//
// The persisted config also carries the mirrored AI provider/model, which only the
// settings pane can resolve (the registry lives in the WebView). So every sequence
// takes a `persist` callback: the pane passes its mirroring save, the badge menu
// passes `saveBinding`, which patches the two fields and leaves the rest as loaded.

import { invoke } from "@tauri-apps/api/core";
import { normalizeMaxTokens } from "../ai/store";
import { KeyedSerialQueue } from "../asyncQueue";

export type SlackConfig = {
  enabled: boolean;
  /**
   * The SAVED connection (profile id) the bot answers against. Autostart waits for this
   * one and no other: the bot answers against a single connection, so coming up bound to
   * whichever session opened first pointed it at a database nobody chose. Null means the
   * bot is bound to an ad-hoc connection (or nothing yet) and cannot start by itself.
   */
  boundProfileId: string | null;
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

export type SlackConfigInfo = { config: SlackConfig; hasBotToken: boolean; hasAppToken: boolean };

/** Mirrors `slack::StatusInfo` in Rust. */
export type SlackStatus = {
  running: boolean;
  state: string;
  error: string | null;
  /**
   * Stopped on purpose, nothing broken: autostart is armed and waiting for its saved
   * connection, or the bound connection was closed. `error` carries the reason. Amber
   * in the UI; a stop WITHOUT this flag but with an error is a failure, and red.
   */
  waiting?: boolean;
  /** The ONE Tusk connection the bot answers against (null when not running/bound). */
  connectionId?: string | null;
};

/** One open Tusk connection, as offered in the bot's connection picker. `profileId` is
 *  null for an ad-hoc connection — the bot can be pointed at one, but autostart cannot
 *  wait for something that was never saved. */
export type SlackConnectionOption = { id: string; label: string; mascot: string; profileId: string | null };

export const DEFAULT_CONFIG: SlackConfig = {
  enabled: false,
  boundProfileId: null,
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

/** One normalization for every AI surface — see `normalizeMaxTokens` in ai/store.ts. */
export const normalizeSlackMaxTokens = normalizeMaxTokens;

/** Normalize newly-added privacy/token fields when loading older config documents. */
export const normalizeSlackConfig = (raw?: Partial<SlackConfig> | null): SlackConfig => ({
  ...DEFAULT_CONFIG,
  ...raw,
  allowlistChannels: Array.isArray(raw?.allowlistChannels) ? raw.allowlistChannels : [],
  allowlistUsers: Array.isArray(raw?.allowlistUsers) ? raw.allowlistUsers : [],
  shareSamples: raw?.shareSamples === true,
  boundProfileId: typeof raw?.boundProfileId === "string" && raw.boundProfileId.trim() ? raw.boundProfileId : null,
  aiMaxTokens: normalizeSlackMaxTokens(raw?.aiMaxTokens ?? DEFAULT_CONFIG.aiMaxTokens),
});

export const slackConfigMatches = (expected: SlackConfig, actual: SlackConfig): boolean =>
  (Object.keys(DEFAULT_CONFIG) as (keyof SlackConfig)[]).every(
    (key) => JSON.stringify(expected[key]) === JSON.stringify(actual[key]),
  );

export const slackErrMsg = (e: unknown): string => (e as { message?: string })?.message ?? String(e);

/**
 * Every Slack config read and write, from any surface, goes through this one queue so
 * writes never interleave — a save still in flight when the settings pane unmounts is
 * ordered before the next mount's load, and a badge-menu repoint cannot race a pane
 * save for the same file.
 */
export const slackIo = new KeyedSerialQueue<"io">();

/** The binding fields a sequence persists. */
export type BindingPatch = { enabled?: boolean; boundProfileId?: string | null };

/**
 * Persist a binding patch. Resolves truthy on success. A falsy result means the save
 * failed AND the caller has already reported it (the settings pane's save sets its own
 * note); a throw carries a message the caller has not yet shown.
 */
export type Persist = (patch: BindingPatch) => Promise<unknown>;

/** Thrown when `persist` reported failure itself; callers that own the note skip it. */
export class PersistFailed extends Error {
  constructor() {
    super("Could not save Slack settings.");
    this.name = "PersistFailed";
  }
}

/**
 * Patch the two binding fields on disk and leave everything else as loaded. Read-back
 * verified, like the pane's save. Throws with the reason on failure.
 */
export const saveBinding: Persist = (patch) =>
  slackIo.run("io", async () => {
    const info = await invoke<SlackConfigInfo>("slack_load_config");
    const config: SlackConfig = { ...normalizeSlackConfig(info.config), ...patch };
    await invoke("slack_save_config", { config, botToken: null, appToken: null });
    const verified = normalizeSlackConfig((await invoke<SlackConfigInfo>("slack_load_config")).config);
    if (!slackConfigMatches(config, verified)) throw new Error("Slack settings did not reload unchanged.");
    return verified;
  });

const ensure = async (persist: Persist, patch: BindingPatch) => {
  if (!(await persist(patch))) throw new PersistFailed();
};

/** What to tell the user once the bot is up, bound to `connectionId`. */
export const startedNote = (connectionId: string | null, profileId: string | null): string =>
  profileId
    ? "Bot started."
    : connectionId
      ? "Bot started. Save this connection as a profile for autostart."
      : "Bot started. Open a connection and bind the bot to it.";

/**
 * Start the bot bound to `connectionId` (unbound when null) and arm autostart for
 * `profileId`. Persists enabled:FALSE first, then validates tokens, then starts, and
 * only persists enabled:true after a clean start — so a failed start never leaves
 * enabled:true on disk, which would autostart the bot on the next launch despite the
 * switch showing Off. Returns the note; throws with the reason otherwise.
 */
export async function startBotBound(connectionId: string | null, profileId: string | null, persist: Persist): Promise<string> {
  await ensure(persist, { enabled: false, boundProfileId: profileId });
  await invoke("slack_test");
  await invoke("slack_start", { connectionId });
  try {
    await ensure(persist, { enabled: true, boundProfileId: profileId });
  } catch {
    await invoke("slack_stop").catch(() => {});
    await persist({ enabled: false }).catch(() => {});
    throw new Error("Could not save the enabled setting. Bot stopped and disabled.");
  }
  return startedNote(connectionId, profileId);
}

/** Persist Off first, then stop, so disk never says "on" over a stopped bot. */
export async function stopBot(persist: Persist): Promise<string> {
  await ensure(persist, { enabled: false });
  await invoke("slack_stop");
  return "Bot stopped.";
}

/**
 * Point a RUNNING bot at another open connection, and re-arm autostart at that
 * connection's profile so the next launch waits for the one it actually answers on.
 */
export async function repointBot(connectionId: string, profileId: string | null, persist: Persist): Promise<string> {
  await slackIo.run("io", () => invoke("slack_set_connection", { connectionId }));
  await ensure(persist, { boundProfileId: profileId });
  return profileId
    ? "Bot repointed. Applies from the next question."
    : "Bot repointed. Save this connection as a profile for autostart.";
}

/** Bind = repoint when running, start bound when stopped. */
export const bindBot = (running: boolean, connectionId: string, profileId: string | null, persist: Persist): Promise<string> =>
  running ? repointBot(connectionId, profileId, persist) : startBotBound(connectionId, profileId, persist);

/** Badge/card tone for a status — the one place the four states are told apart. */
export type SlackTone = "on" | "wait" | "stopped" | "off";
export function slackTone(s: SlackStatus): SlackTone {
  if (s.running) return s.state === "connected" ? "on" : "wait";
  if (s.waiting) return "wait";
  return s.error ? "stopped" : "off";
}
