import { describe, expect, it } from "vitest";
import { DIALOG_WIDTHS, dialogWidth } from "./dialogWidths";

describe("dialogWidth", () => {
  it("returns the tier width on a roomy viewport", () => {
    expect(dialogWidth("sm", 1920)).toBe(DIALOG_WIDTHS.sm);
    expect(dialogWidth("md", 1920)).toBe(DIALOG_WIDTHS.md);
    expect(dialogWidth("lg", 1920)).toBe(DIALOG_WIDTHS.lg);
    expect(dialogWidth("xl", 1920)).toBe(DIALOG_WIDTHS.xl);
  });

  it("orders the tiers", () => {
    const w = DIALOG_WIDTHS;
    expect(w.sm).toBeLessThan(w.md);
    expect(w.md).toBeLessThan(w.lg);
    expect(w.lg).toBeLessThan(w.xl);
  });

  it("clamps to the viewport with a gutter, so a wide tier never reaches the edge", () => {
    expect(dialogWidth("xl", 900)).toBe(900 - 64);
    expect(dialogWidth("lg", 600)).toBe(600 - 64);
    // A tier that already fits is left alone.
    expect(dialogWidth("sm", 900)).toBe(DIALOG_WIDTHS.sm);
  });

  it("never goes below a readable minimum", () => {
    expect(dialogWidth("xl", 200)).toBe(280);
    expect(dialogWidth("sm", 300)).toBe(280);
  });

  it("falls back to the tier width when the viewport is unusable", () => {
    expect(dialogWidth("md", 0)).toBe(DIALOG_WIDTHS.md);
    expect(dialogWidth("md", Number.NaN)).toBe(DIALOG_WIDTHS.md);
  });
});
