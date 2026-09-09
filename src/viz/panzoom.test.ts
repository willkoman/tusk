import { describe, expect, it } from "vitest";
import { createPanZoom, fitTransform, MIN_K, READABLE_FIT } from "./panzoom";

describe("createPanZoom", () => {
  it("keeps cursor-anchored zoom and fit behavior", () => {
    const pz = createPanZoom();
    pz.zoomBy(2, 100, 50);
    expect(pz.transform()).toEqual({ x: -100, y: -50, k: 2 });
    pz.fit({ x: 0, y: 0, w: 200, h: 100 }, 400, 300);
    expect(pz.transform()).toEqual({ x: 100, y: 100, k: 1 });
  });

  it("ignores invalid zoom input and safely resets invalid fit bounds", () => {
    const pz = createPanZoom();
    pz.zoomBy(Number.NaN, 10, 10);
    expect(pz.transform()).toEqual({ x: 0, y: 0, k: 1 });
    pz.fit({ x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 10 }, 100, 100);
    expect(pz.transform()).toEqual({ x: 32, y: 32, k: 1 });
    pz.zoomBy(2, Number.POSITIVE_INFINITY, 0);
    expect(pz.transform()).toEqual({ x: 32, y: 32, k: 1 });
  });
});

describe("fitTransform", () => {
  it("never zooms out past the readable floor — the canvas pans instead", () => {
    // A 3-table neighborhood diagram used to fit at ~35%: 7px card text.
    const wide = { x: 0, y: 0, w: 1200, h: 400 };
    expect(fitTransform(wide, 600, 700).k).toBe(READABLE_FIT);
    // Content stays centred, so the focal card is what the viewport lands on.
    expect(fitTransform(wide, 600, 700)).toEqual({ x: -300, y: 150, k: 1 });
    // An overview that asks to keep shrinking still does.
    expect(fitTransform(wide, 600, 700, MIN_K).k).toBeCloseTo((600 - 64) / 1200, 5);
  });

  it("fits smaller content without magnifying it", () => {
    expect(fitTransform({ x: 0, y: 0, w: 200, h: 100 }, 400, 300)).toEqual({ x: 100, y: 100, k: 1 });
  });

  it("clamps a nonsense floor and falls back on invalid geometry", () => {
    expect(fitTransform({ x: 0, y: 0, w: 1200, h: 400 }, 600, 700, 9).k).toBe(1);
    expect(fitTransform({ x: 0, y: 0, w: 1200, h: 400 }, 600, 700, Number.NaN)).toEqual({ x: 32, y: 32, k: 1 });
    expect(fitTransform({ x: 0, y: 0, w: 0, h: 400 }, 600, 700)).toEqual({ x: 32, y: 32, k: 1 });
  });
});
