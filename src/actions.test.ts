import { describe, expect, it } from "vitest";
import { canonicalKey, normalizeKeyEvent } from "./actions";

const ev = (init: Record<string, unknown>) => init as unknown as KeyboardEvent;

describe("normalizeKeyEvent", () => {
  it("ignores a keydown that carries no key name instead of throwing", () => {
    // Seen in a 0.10.0 crash report from Windows/WebView2: the window keydown handler
    // read `.length` off an undefined `key` and took the whole workbench down.
    expect(normalizeKeyEvent(ev({ key: undefined, ctrlKey: true }))).toBeNull();
    expect(normalizeKeyEvent(ev({ key: "", ctrlKey: true }))).toBeNull();
  });

  it("skips bare modifiers and unmodified printable keys", () => {
    expect(normalizeKeyEvent(ev({ key: "Control", ctrlKey: true }))).toBeNull();
    expect(normalizeKeyEvent(ev({ key: "a" }))).toBeNull();
    expect(normalizeKeyEvent(ev({ key: "F5" }))).toBe("F5");
  });

  it("canonicalises modifiers and single characters", () => {
    expect(normalizeKeyEvent(ev({ key: "A", ctrlKey: true, shiftKey: true, altKey: true }))).toBe("Mod-Alt-Shift-a");
    expect(normalizeKeyEvent(ev({ key: "Escape", altKey: true }))).toBe("Alt-Escape");
    expect(canonicalKey("ctrl-shift-K")).toBe("Mod-Shift-k");
  });
});
