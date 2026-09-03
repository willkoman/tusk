import { beforeAll, describe, expect, it } from "vitest";
import type { SlackConfig } from "./SlackPane";

type PaneModule = typeof import("./SlackPane");
let pane: PaneModule;

beforeAll(async () => {
  // Solid registers delegated event names at module evaluation. Pure helper tests
  // need only this tiny document surface, not a browser or jsdom.
  const document = { addEventListener() {}, removeEventListener() {} };
  Object.assign(globalThis, { window: { document } });
  pane = await import("./SlackPane");
});

describe("Slack settings persistence helpers", () => {
  it("normalizes Max Tokens from live onInput text", () => {
    expect(pane.normalizeSlackMaxTokens("4096")).toBe(4096);
    expect(pane.normalizeSlackMaxTokens("300")).toBe(256);
    expect(pane.normalizeSlackMaxTokens("", 8192)).toBe(8192);
    expect(pane.normalizeSlackMaxTokens("999999")).toBe(128000);
  });

  it("detects a save-then-reload mismatch", () => {
    const saved: SlackConfig = { ...pane.DEFAULT_CONFIG, aiMaxTokens: 8192, shareSamples: true };
    expect(pane.slackConfigMatches(saved, { ...saved })).toBe(true);
    expect(pane.slackConfigMatches(saved, { ...saved, aiMaxTokens: 2048 })).toBe(false);
    expect(pane.slackConfigMatches(saved, { ...saved, shareSamples: false })).toBe(false);
  });

  it("reports whether the persisted bot AI pair matches what a save would mirror", () => {
    const ai = { provider: "openai", model: "", models: {}, baseUrls: {}, approvedOrigins: {}, enabledModels: {}, shareSamples: false, maxTokens: 2048 } as const;
    const mirrored = pane.mirroredAi(ai);
    expect(mirrored.provider).toBe("openai");
    expect(mirrored.model).not.toBe("");
    expect(pane.slackAiInSync({ ...pane.DEFAULT_CONFIG, aiProvider: "openai", aiModel: mirrored.model }, ai)).toBe(true);
    expect(pane.slackAiInSync({ ...pane.DEFAULT_CONFIG, aiProvider: "openai", aiModel: "other" }, ai)).toBe(false);
    expect(pane.slackAiInSync(pane.DEFAULT_CONFIG, ai)).toBe(false);
    expect(pane.slackAiInSync({ ...pane.DEFAULT_CONFIG, aiProvider: "openai", aiModel: "x" }, { ...ai, model: "x" })).toBe(true);
  });

  it("keeps sample sharing default-off and row cap aligned with the backend", () => {
    expect(pane.DEFAULT_CONFIG.shareSamples).toBe(false);
    expect(pane.DEFAULT_CONFIG.maxRowsFile).toBeLessThanOrEqual(100000);
  });
});
