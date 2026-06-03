import { type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { type EditorPrefs } from "./types";

/**
 * Pure theme builder driven by prefs. Returned via a Compartment in SqlEditor so a
 * font-size / word-wrap / theme change reconfigures live — no editor rebuild, no
 * history or fold-state reset.
 */
export function themeFor(prefs: EditorPrefs): Extension {
  return [
    oneDark,
    prefs.wordWrap ? EditorView.lineWrapping : [],
    EditorView.theme({
      "&": {
        height: "100%",
        fontSize: `${prefs.fontSize}px`,
        backgroundColor: "transparent",
      },
      ".cm-scroller": {
        fontFamily: '"JetBrains Mono","SF Mono",Menlo,Consolas,monospace',
      },
    }),
  ];
}
