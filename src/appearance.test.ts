import { describe, expect, it } from "vitest";
import {
  BASE_FONT_PX,
  DEFAULT_LINE_HEIGHT,
  MAX_SCALE,
  MIN_SCALE,
  clampLineHeight,
  clampScale,
  densityTokens,
  gridRowH,
  normalizeDensity,
  rootFontSize,
  scaleSteps,
} from "./appearance";

describe("UI scale", () => {
  it("snaps to a step and clamps into range", () => {
    expect(clampScale(100)).toBe(100);
    expect(clampScale(102)).toBe(100);
    expect(clampScale(103)).toBe(105);
    expect(clampScale(10)).toBe(MIN_SCALE);
    expect(clampScale(400)).toBe(MAX_SCALE);
  });

  it("falls back to 100 % for anything that is not a finite number", () => {
    expect(clampScale(NaN)).toBe(100);
    expect(clampScale(undefined)).toBe(100);
    expect(clampScale("120")).toBe(100);
  });

  it("offers every step, low to high, with no gaps", () => {
    const steps = scaleSteps();
    expect(steps[0]).toBe(MIN_SCALE);
    expect(steps[steps.length - 1]).toBe(MAX_SCALE);
    expect(steps.every((v) => v === clampScale(v))).toBe(true);
  });

  it("maps a scale to a root font size around the 13 px base", () => {
    expect(rootFontSize(100)).toBe(`${BASE_FONT_PX}px`);
    expect(rootFontSize(90)).toBe("11.7px");
    expect(rootFontSize(125)).toBe("16.3px");
    // Out-of-range input is clamped before it can produce a silly size.
    expect(rootFontSize(1000)).toBe(rootFontSize(MAX_SCALE));
  });
});

describe("editor line height", () => {
  it("clamps and rounds to one decimal", () => {
    expect(clampLineHeight(1.45)).toBe(1.5);
    expect(clampLineHeight(0.2)).toBe(1.1);
    expect(clampLineHeight(9)).toBe(2);
    expect(clampLineHeight("x")).toBe(DEFAULT_LINE_HEIGHT);
  });
});

describe("density tokens", () => {
  it("treats anything but 'compact' as comfortable", () => {
    expect(normalizeDensity("compact")).toBe("compact");
    expect(normalizeDensity("comfortable")).toBe("comfortable");
    expect(normalizeDensity("cosy")).toBe("comfortable");
    expect(normalizeDensity(undefined)).toBe("comfortable");
  });

  it("keeps the shipped sizes as 'comfortable' so the default look is unchanged", () => {
    expect(densityTokens("comfortable")).toMatchObject({
      "--row-h": "28px",
      "--tab-h": "26px",
      "--tree-row-h": "25px",
    });
  });

  it("declares the same token names in both sets, all tighter under compact", () => {
    const roomy = densityTokens("comfortable");
    const tight = densityTokens("compact");
    expect(Object.keys(tight).sort()).toEqual(Object.keys(roomy).sort());
    for (const k of Object.keys(roomy)) {
      expect(parseFloat(tight[k])).toBeLessThan(parseFloat(roomy[k]));
    }
  });

  it("hands back a copy, so a caller cannot mutate the table", () => {
    const a = densityTokens("compact");
    a["--row-h"] = "999px";
    expect(densityTokens("compact")["--row-h"]).toBe("24px");
  });
});

describe("grid row height", () => {
  it("combines the app density with the grid's own density pref", () => {
    // The pre-density values are preserved at "comfortable".
    expect(gridRowH("comfortable", "normal")).toBe(28);
    expect(gridRowH("comfortable", "compact")).toBe(22);
    expect(gridRowH("compact", "normal")).toBe(24);
    expect(gridRowH("compact", "compact")).toBe(18);
  });

  it("matches the --row-h token at the grid's normal density", () => {
    for (const d of ["comfortable", "compact"] as const) {
      expect(`${gridRowH(d, "normal")}px`).toBe(densityTokens(d)["--row-h"]);
    }
  });
});
