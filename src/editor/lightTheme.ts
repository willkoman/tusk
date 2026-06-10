import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

// Hand-rolled light editor theme (One Light-ish palette) — mirrors what the
// `oneDark` bundle provides (chrome theme + syntax highlight style) without
// pulling in another dependency. The surrounding UI flips via the
// `:root[data-theme="light"]` CSS-variable block in App.css.

const lightChrome = EditorView.theme(
  {
    "&": { color: "#383a42" },
    ".cm-content": { caretColor: "#526fff" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#526fff" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
      { backgroundColor: "#d2dcf5" },
    ".cm-activeLine": { backgroundColor: "rgba(56, 58, 66, 0.05)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(56, 58, 66, 0.07)", color: "#383a42" },
    ".cm-gutters": { backgroundColor: "transparent", color: "#9d9d9f", border: "none" },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "rgba(64, 120, 242, 0.15)",
      outline: "1px solid rgba(64, 120, 242, 0.4)",
    },
    ".cm-nonmatchingBracket": { color: "#e45649" },
    ".cm-tooltip": { background: "#f4f5f7", border: "1px solid #d4d6da", color: "#383a42" },
    ".cm-tooltip-autocomplete ul li[aria-selected]": { background: "#d2dcf5", color: "#383a42" },
    ".cm-panels": { background: "#f4f5f7", color: "#383a42" },
    ".cm-searchMatch": { backgroundColor: "rgba(255, 196, 0, 0.35)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(255, 152, 0, 0.5)" },
  },
  { dark: false },
);

const lightHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "#a626a4" },
  { tag: [t.string, t.special(t.string)], color: "#50a14f" },
  { tag: [t.number, t.bool, t.null], color: "#986801" },
  { tag: t.comment, color: "#a0a1a7", fontStyle: "italic" },
  { tag: [t.typeName, t.className], color: "#c18401" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#4078f2" },
  { tag: [t.variableName, t.propertyName, t.attributeName], color: "#383a42" },
  { tag: [t.operator, t.punctuation, t.separator], color: "#383a42" },
  { tag: t.labelName, color: "#4078f2" },
  { tag: [t.atom, t.constant(t.name)], color: "#0184bc" },
  { tag: t.invalid, color: "#e45649" },
]);

export const lightTheme: Extension = [lightChrome, syntaxHighlighting(lightHighlight)];
