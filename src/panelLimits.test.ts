import { describe, expect, it } from "vitest";
import {
  AI_DOCK_CAP,
  HISTORY_DOCK_CAP,
  clampPanelSizes,
  defaultEditorHeight,
  maxEditorHeight,
  maxSideDockWidth,
  maxSidebarWidth,
} from "./panelLimits";
import { changed, sizeOf } from "./viewport";

describe("panel bounds", () => {
  it("always leaves the editor column room next to the Explorer", () => {
    expect(maxSidebarWidth(1200)).toBe(560);
    expect(maxSidebarWidth(900)).toBe(480);
    // Below the point where 420px would be left, the floor takes over.
    expect(maxSidebarWidth(500)).toBe(180);
    expect(maxSidebarWidth(0)).toBe(180);
  });

  it("caps a right-hand dock by its tier and by the window", () => {
    expect(maxSideDockWidth(2000, AI_DOCK_CAP)).toBe(AI_DOCK_CAP);
    expect(maxSideDockWidth(1000, AI_DOCK_CAP)).toBe(520);
    expect(maxSideDockWidth(1000, HISTORY_DOCK_CAP)).toBe(520);
    expect(maxSideDockWidth(600, AI_DOCK_CAP)).toBe(240);
  });

  it("keeps the results pane reachable under the editor", () => {
    expect(maxEditorHeight(820)).toBe(660);
    expect(maxEditorHeight(200)).toBe(80);
  });

  it("splits a fresh window 60/40 but never below 300px of editor", () => {
    expect(defaultEditorHeight(820)).toBe(420);
    expect(defaultEditorHeight(600)).toBe(300);
  });
});

describe("clampPanelSizes", () => {
  const saved = { sidebarW: 520, aiW: 700, historyW: 640, editorH: 900 };

  it("leaves sizes that already fit alone", () => {
    const fits = { sidebarW: 260, aiW: 320, historyW: 300, editorH: 400 };
    expect(clampPanelSizes(fits, 1600, 1000)).toEqual(fits);
  });

  it("shrinks every panel a smaller window cannot hold", () => {
    expect(clampPanelSizes(saved, 1000, 700)).toEqual({
      sidebarW: 520,
      aiW: 520,
      historyW: 520,
      editorH: 540,
    });
  });

  it("never returns an editor height below the floor", () => {
    expect(clampPanelSizes(saved, 400, 120).editorH).toBe(80);
  });

  it("is idempotent — re-clamping a clamped layout changes nothing", () => {
    const once = clampPanelSizes(saved, 900, 640);
    expect(clampPanelSizes(once, 900, 640)).toEqual(once);
  });
});

describe("viewport reads", () => {
  it("falls back when there is no window", () => {
    expect(sizeOf(undefined)).toEqual({ w: 1280, h: 800 });
  });

  it("prefers innerWidth/innerHeight, then the document element's client box", () => {
    const withInner = { innerWidth: 1200, innerHeight: 820, document: { documentElement: { clientWidth: 5, clientHeight: 5 } } };
    expect(sizeOf(withInner as never)).toEqual({ w: 1200, h: 820 });
    // A WebView that reports 0 before it is shown must not be believed.
    const preShow = { innerWidth: 0, innerHeight: 0, document: { documentElement: { clientWidth: 800, clientHeight: 600 } } };
    expect(sizeOf(preShow as never)).toEqual({ w: 800, h: 600 });
  });

  it("only reports a real change", () => {
    expect(changed({ w: 10, h: 10 }, { w: 10, h: 10 })).toBe(false);
    expect(changed({ w: 10, h: 10 }, { w: 11, h: 10 })).toBe(true);
    expect(changed({ w: 10, h: 10 }, { w: 10, h: 11 })).toBe(true);
  });
});
