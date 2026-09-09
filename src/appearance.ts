/**
 * Appearance tokens: UI density and UI scale.
 *
 * Density is a CSS-variable set stamped on `<html data-density>`; "comfortable"
 * repeats the sizes the workbench already shipped, so the default look is
 * unchanged. Everything that reads a token (tab strip, tree rows, control
 * heights) follows automatically. The result grid is virtualized and needs the
 * row height as a number, so `gridRowH` is the one place that mapping lives.
 *
 * Scale multiplies the root font size; UI boxes sized in `rem` follow it, and
 * the editor's own font-size pref is deliberately untouched.
 *
 * Pure and covered by appearance.test.ts — keep it that way.
 */

export type Density = "comfortable" | "compact";

export const DENSITIES: { id: Density; label: string }[] = [
  { id: "comfortable", label: "Comfortable" },
  { id: "compact", label: "Compact" },
];

/** Root font size, in px, that "100 %" means. Matches the :root rule in App.css. */
export const BASE_FONT_PX = 13;

export const MIN_SCALE = 90;
export const MAX_SCALE = 125;
export const SCALE_STEP = 5;

export const MIN_LINE_HEIGHT = 1.1;
export const MAX_LINE_HEIGHT = 2;
export const DEFAULT_LINE_HEIGHT = 1.4;

/** Snap to the nearest step and clamp into range; non-finite input → 100 %. */
export function clampScale(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 100;
  const snapped = Math.round(n / SCALE_STEP) * SCALE_STEP;
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, snapped));
}

/** Every selectable scale, low to high. */
export function scaleSteps(): number[] {
  const out: number[] = [];
  for (let v = MIN_SCALE; v <= MAX_SCALE; v += SCALE_STEP) out.push(v);
  return out;
}

/** Root `font-size` for a scale, rounded to 0.1 px so text never lands off-pixel. */
export function rootFontSize(scale: number): string {
  const px = (BASE_FONT_PX * clampScale(scale)) / 100;
  return `${Math.round(px * 10) / 10}px`;
}

export function clampLineHeight(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : DEFAULT_LINE_HEIGHT;
  const snapped = Math.round(n * 10) / 10;
  return Math.max(MIN_LINE_HEIGHT, Math.min(MAX_LINE_HEIGHT, snapped));
}

export function normalizeDensity(v: unknown): Density {
  return v === "compact" ? "compact" : "comfortable";
}

/**
 * The density token set. "comfortable" holds the values the workbench used
 * before density existed, so switching to it is a no-op visually.
 */
const TOKENS: Record<Density, Record<string, string>> = {
  comfortable: {
    "--row-h": "28px",
    "--control-h": "28px",
    "--control-h-sm": "24px",
    "--tab-h": "26px",
    "--tree-row-h": "25px",
    "--pad-y": "6px",
    "--pad-x": "12px",
    "--gap": "8px",
  },
  compact: {
    "--row-h": "24px",
    "--control-h": "24px",
    "--control-h-sm": "22px",
    "--tab-h": "22px",
    "--tree-row-h": "21px",
    "--pad-y": "3px",
    "--pad-x": "9px",
    "--gap": "5px",
  },
};

export function densityTokens(d: Density): Record<string, string> {
  return { ...TOKENS[normalizeDensity(d)] };
}

/**
 * Result-grid row height in px. The grid keeps its own density pref (it is the
 * one surface where a user routinely wants tighter rows than the rest of the
 * app), so the two combine rather than one overriding the other.
 */
export function gridRowH(d: Density, grid: "compact" | "normal"): number {
  const base = normalizeDensity(d) === "compact" ? 24 : 28;
  return grid === "compact" ? base - 6 : base;
}
