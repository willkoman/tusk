import { describe, expect, it } from "vitest";
import { createPanZoom } from "./panzoom";

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
