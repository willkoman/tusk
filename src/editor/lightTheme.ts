import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

// Hand-rolled light editor theme (One Light-ish palette) — mirrors what the
// `oneDark` bundle provides (chrome theme + syntax highlight style) without
// pulling in another dependency. The surrounding UI flips via the
// `:root[data-theme="light"]` CSS-variable block in App.css.
//
// Every syntax colour is darkened from upstream One Light until it clears 4.5:1
// on this theme's `--bg` (#f4f6f9) — the editor and the dialogs' SqlFields paint
// straight onto it, and upstream's golds and greens came in under 3:1 there.
// `contrast.test.ts` holds the whole set to that bar.

const lightChrome = EditorView.theme(
  {
    "&": { color: "#383a42" },
    ".cm-content": { caretColor: "#526fff" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#526fff" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
      { backgroundColor: "#d2dcf5" },
    ".cm-activeLine": { backgroundColor: "rgba(56, 58, 66, 0.05)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(56, 58, 66, 0.07)", color: "#383a42" },
    ".cm-gutters": { backgroundColor: "transparent", color: "#6f7077", border: "none" },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "rgba(64, 120, 242, 0.15)",
      outline: "1px solid rgba(64, 120, 242, 0.4)",
    },
    ".cm-nonmatchingBracket": { color: "#d52f20" },
    ".cm-tooltip": { background: "#f4f5f7", border: "1px solid #d4d6da", color: "#383a42" },
    ".cm-tooltip-autocomplete ul li[aria-selected]": { background: "#d2dcf5", color: "#383a42" },
    ".cm-panels": { background: "#f4f5f7", color: "#383a42" },
    ".cm-searchMatch": { backgroundColor: "rgba(255, 196, 0, 0.35)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(255, 152, 0, 0.5)" },
  },
  { dark: false },
);

/** One Light's palette, darkened to AA on `--bg`. Exported for contrast.test.ts. */
export const LIGHT_PALETTE = {
  text: "#383a42",
  kw: "#a626a4",
  str: "#3e7e3e",
  num: "#a35a00",
  com: "#6f7077",
  type: "#856800",
  fn: "#2766f0",
  atom: "#0177aa",
  invalid: "#d52f20",
  gutter: "#6f7077",
};

const lightHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: LIGHT_PALETTE.kw },
  { tag: [t.string, t.special(t.string)], color: LIGHT_PALETTE.str },
  { tag: [t.number, t.bool, t.null], color: LIGHT_PALETTE.num },
  { tag: t.comment, color: LIGHT_PALETTE.com, fontStyle: "italic" },
  { tag: [t.typeName, t.className], color: LIGHT_PALETTE.type },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: LIGHT_PALETTE.fn },
  { tag: [t.variableName, t.propertyName, t.attributeName], color: LIGHT_PALETTE.text },
  { tag: [t.operator, t.punctuation, t.separator], color: LIGHT_PALETTE.text },
  { tag: t.labelName, color: LIGHT_PALETTE.fn },
  { tag: [t.atom, t.constant(t.name)], color: LIGHT_PALETTE.atom },
  { tag: t.invalid, color: LIGHT_PALETTE.invalid },
]);

export const lightTheme: Extension = [lightChrome, syntaxHighlighting(lightHighlight)];
