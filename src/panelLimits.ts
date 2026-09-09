/**
 * Hard bounds for the docked panels, as pure functions of the live viewport.
 *
 * No side panel may grow past the point where the editor column disappears, and
 * the editor↔results split always leaves the results pane reachable. A width
 * saved on a wide monitor must stay harmless on a narrow one, so these are
 * re-applied whenever the viewport changes — not only at mount.
 */

export type PanelSizes = { sidebarW: number; aiW: number; historyW: number; editorH: number };

/** Widest the Explorer may be: the editor keeps at least 420px. */
export const maxSidebarWidth = (vw: number): number => Math.max(180, Math.min(560, vw - 420));

/** Widest a right-hand dock (AI, history) may be, under its own tier cap. */
export const maxSideDockWidth = (vw: number, cap: number): number => Math.max(240, Math.min(cap, vw - 480));

/** Tallest the editor may be before the results pane stops being reachable. */
export const maxEditorHeight = (vh: number): number => Math.max(80, vh - 160);

/** Height the editor takes on a first run, before a split has been saved. */
export const defaultEditorHeight = (vh: number): number => Math.max(300, Math.round((vh - 120) * 0.6));

export const AI_DOCK_CAP = 760;
export const HISTORY_DOCK_CAP = 700;

/** Every docked size clamped to one viewport. */
export function clampPanelSizes(sizes: PanelSizes, vw: number, vh: number): PanelSizes {
  return {
    sidebarW: Math.min(sizes.sidebarW, maxSidebarWidth(vw)),
    aiW: Math.min(sizes.aiW, maxSideDockWidth(vw, AI_DOCK_CAP)),
    historyW: Math.min(sizes.historyW, maxSideDockWidth(vw, HISTORY_DOCK_CAP)),
    editorH: Math.max(80, Math.min(sizes.editorH, maxEditorHeight(vh))),
  };
}
