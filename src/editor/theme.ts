import { type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { lightTheme } from "./lightTheme";
import { cmThemes } from "./cmThemes";
import { type EditorPrefs } from "./types";
import { clampLineHeight } from "../appearance";

export const DEFAULT_FONT_STACK = '"JetBrains Mono","SF Mono",Menlo,Consolas,monospace';

/** The monospace stack honoring the user's font pref ("" = built-in stack). */
export function fontStack(fontFamily: string): string {
  const f = fontFamily.trim();
  if (!f) return DEFAULT_FONT_STACK;
  // Quote a bare family name (the user may also type a full stack with commas).
  const head = f.includes(",") ? f : /^["']/.test(f) ? f : `"${f}"`;
  return `${head},${DEFAULT_FONT_STACK}`;
}

/**
 * Pure theme builder driven by prefs. Returned via a Compartment in SqlEditor so a
 * font-size / word-wrap / theme / font-family change reconfigures live — no editor
 * rebuild, no history or fold-state reset. `prefs.theme` arrives already resolved
 * ("system" is mapped to a concrete theme by App before it gets here); unknown
 * ids fall back to One Dark.
 */
/**
 * The palette half of a theme — chrome + syntax highlighting, no sizing. Used on
 * its own by the single-line SqlField, which needs the colours but none of the
 * editor's font/wrap prefs. `theme` arrives already resolved; unknown ids fall
 * back to One Dark.
 */
export function paletteFor(theme: string): Extension {
  return theme === "light" ? lightTheme : theme === "oneDark" ? oneDark : cmThemes[theme] ?? oneDark;
}

export function themeFor(prefs: EditorPrefs): Extension {
  return [
    paletteFor(prefs.theme),
    prefs.wordWrap ? EditorView.lineWrapping : [],
    EditorView.theme({
      "&": {
        height: "100%",
        fontSize: `${prefs.fontSize}px`,
        backgroundColor: "transparent",
      },
      ".cm-scroller": {
        fontFamily: fontStack(prefs.fontFamily),
        lineHeight: String(clampLineHeight(prefs.lineHeight)),
      },
    }),
  ];
}
