import { describe, it, expect } from "vitest";
import { changed, shouldNudge, sizeOf, nudgeWindowLayout } from "./viewport";

describe("sizeOf", () => {
  it("falls back without a window", () => {
    expect(sizeOf(undefined)).toEqual({ w: 1280, h: 800 });
  });
});

describe("changed", () => {
  it("compares both axes", () => {
    expect(changed({ w: 1, h: 2 }, { w: 1, h: 2 })).toBe(false);
    expect(changed({ w: 1, h: 2 }, { w: 1, h: 3 })).toBe(true);
    expect(changed({ w: 1, h: 2 }, { w: 2, h: 2 })).toBe(true);
  });
});

describe("shouldNudge", () => {
  it("runs once on a normal window", () => {
    expect(shouldNudge({ maximized: false, done: false })).toBe(true);
  });
  it("never runs twice", () => {
    expect(shouldNudge({ maximized: false, done: true })).toBe(false);
  });
  it("leaves a maximized or full-screen window alone", () => {
    expect(shouldNudge({ maximized: true, done: false })).toBe(false);
    expect(shouldNudge({ maximized: false, fullscreen: true, done: false })).toBe(false);
  });
});

describe("nudgeWindowLayout", () => {
  it("resolves without a Tauri window", async () => {
    await expect(nudgeWindowLayout()).resolves.toBeUndefined();
  });
});
