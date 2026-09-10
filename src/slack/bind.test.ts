import { describe, expect, it } from "vitest";
import { normalizeSlackConfig, slackTone, startedNote } from "./bind";

describe("Slack badge tone", () => {
  it("tells a waiting bot from a failed one", () => {
    expect(slackTone({ running: true, state: "connected", error: null })).toBe("on");
    expect(slackTone({ running: true, state: "connecting", error: null })).toBe("wait");
    expect(slackTone({ running: true, state: "error", error: "socket dropped" })).toBe("wait");
    // Stopped on purpose, autostart armed: amber, nothing lost.
    expect(slackTone({ running: false, state: "disconnected", error: "waiting for X", waiting: true })).toBe("wait");
    // Stopped by a failure: red.
    expect(slackTone({ running: false, state: "disconnected", error: "invalid_auth" })).toBe("stopped");
    // Configured and idle: grey.
    expect(slackTone({ running: false, state: "disconnected", error: null })).toBe("off");
  });

  it("does not let a stale waiting flag survive a plain stop", () => {
    expect(slackTone({ running: false, state: "disconnected", error: null, waiting: true })).toBe("wait");
  });
});

describe("Slack binding helpers", () => {
  it("phrases the start note by what autostart can do next", () => {
    expect(startedNote("c1", "p1")).toBe("Bot started.");
    expect(startedNote("c1", null)).toMatch(/Save this connection as a profile/);
    expect(startedNote(null, null)).toMatch(/bind the bot/);
  });

  it("reads a config from before bindings existed as unbound", () => {
    const legacy = normalizeSlackConfig({ enabled: true } as never);
    expect(legacy.enabled).toBe(true);
    expect(legacy.boundProfileId).toBeNull();
    expect(normalizeSlackConfig({ boundProfileId: "   " } as never).boundProfileId).toBeNull();
  });
});
