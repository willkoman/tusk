// One width scale for every modal. Dialogs pick a TIER, never a pixel count, so a
// confirm and a preview of the same weight are the same width everywhere.

export type DialogSize = "sm" | "md" | "lg" | "xl";

/** sm: confirms and one-field forms. md: short forms. lg: forms with a preview or a
 *  file/options body. xl: table builders and the connect panel. */
export const DIALOG_WIDTHS: Record<DialogSize, number> = {
  sm: 400,
  md: 560,
  lg: 760,
  xl: 1100,
};

/** Never let a dialog reach the window edge, and never squeeze it below readable. */
const GUTTER = 64;
const MIN_WIDTH = 280;

/**
 * The tier's width, clamped to the live viewport. A width saved for a wide window
 * must not spill off a narrow one, so this is re-read at render time.
 */
export function dialogWidth(size: DialogSize, viewport: number): number {
  const base = DIALOG_WIDTHS[size];
  if (!Number.isFinite(viewport) || viewport <= 0) return base;
  return Math.max(MIN_WIDTH, Math.min(base, Math.round(viewport) - GUTTER));
}
