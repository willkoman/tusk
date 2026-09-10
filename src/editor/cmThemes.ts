import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

// Generated CodeMirror themes for the non-built-in palettes ("oneDark" uses the
// @codemirror/theme-one-dark bundle, "light" the hand-rolled One Light in
// lightTheme.ts). One factory, one palette spec per theme — chrome + syntax
// colors come from each theme's canonical palette so the editor matches the
// surrounding CSS-variable UI.

type CmPalette = {
  dark: boolean;
  text: string;
  caret: string;
  selection: string;
  activeLine: string;
  gutter: string;
  tooltipBg: string;
  tooltipBorder: string;
  matchOutline: string;
  searchMatch: string;
  searchSelected: string;
  kw: string; // keywords
  str: string; // strings
  num: string; // numbers / bools / null
  com: string; // comments
  type: string; // type names
  fn: string; // function calls
  atom: string; // constants / atoms
  invalid: string;
};

function makeCmTheme(p: CmPalette): Extension {
  const chrome = EditorView.theme(
    {
      "&": { color: p.text },
      ".cm-content": { caretColor: p.caret },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: p.caret },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
        { backgroundColor: p.selection },
      ".cm-activeLine": { backgroundColor: p.activeLine },
      ".cm-activeLineGutter": { backgroundColor: p.activeLine, color: p.text },
      ".cm-gutters": { backgroundColor: "transparent", color: p.gutter, border: "none" },
      ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
        backgroundColor: p.activeLine,
        outline: `1px solid ${p.matchOutline}`,
      },
      ".cm-nonmatchingBracket": { color: p.invalid },
      ".cm-tooltip": { background: p.tooltipBg, border: `1px solid ${p.tooltipBorder}`, color: p.text },
      ".cm-tooltip-autocomplete ul li[aria-selected]": { background: p.selection, color: p.text },
      ".cm-panels": { background: p.tooltipBg, color: p.text },
      ".cm-searchMatch": { backgroundColor: p.searchMatch },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: p.searchSelected },
    },
    { dark: p.dark },
  );
  const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.modifier], color: p.kw },
    { tag: [t.string, t.special(t.string)], color: p.str },
    { tag: [t.number, t.bool, t.null], color: p.num },
    { tag: t.comment, color: p.com, fontStyle: "italic" },
    { tag: [t.typeName, t.className], color: p.type },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: p.fn },
    { tag: [t.variableName, t.propertyName, t.attributeName], color: p.text },
    { tag: [t.operator, t.punctuation, t.separator], color: p.text },
    { tag: t.labelName, color: p.fn },
    { tag: [t.atom, t.constant(t.name)], color: p.atom },
    { tag: t.invalid, color: p.invalid },
  ]);
  return [chrome, syntaxHighlighting(highlight)];
}

/**
 * Every generated palette, exported so `contrast.test.ts` can hold the light
 * themes to 4.5:1 against the `--bg` each one paints on in App.css.
 */
export const CM_PALETTES: Record<string, CmPalette> = {
  catppuccinMocha: {
    dark: true,
    text: "#cdd6f4", caret: "#f5e0dc", selection: "#45475a", activeLine: "rgba(205, 214, 244, 0.05)",
    gutter: "#6c7086", tooltipBg: "#181825", tooltipBorder: "#313244",
    matchOutline: "rgba(137, 180, 250, 0.5)", searchMatch: "rgba(249, 226, 175, 0.25)", searchSelected: "rgba(250, 179, 135, 0.4)",
    kw: "#cba6f7", str: "#a6e3a1", num: "#fab387", com: "#6c7086", type: "#f9e2af", fn: "#89b4fa", atom: "#94e2d5", invalid: "#f38ba8",
  },
  dracula: {
    dark: true,
    text: "#f8f8f2", caret: "#f8f8f2", selection: "#44475a", activeLine: "rgba(248, 248, 242, 0.045)",
    gutter: "#6272a4", tooltipBg: "#21222c", tooltipBorder: "#44475a",
    matchOutline: "rgba(139, 233, 253, 0.5)", searchMatch: "rgba(241, 250, 140, 0.25)", searchSelected: "rgba(255, 184, 108, 0.4)",
    kw: "#ff79c6", str: "#f1fa8c", num: "#bd93f9", com: "#6272a4", type: "#8be9fd", fn: "#50fa7b", atom: "#bd93f9", invalid: "#ff5555",
  },
  tokyoNight: {
    dark: true,
    text: "#c0caf5", caret: "#c0caf5", selection: "#283457", activeLine: "rgba(192, 202, 245, 0.05)",
    gutter: "#565f89", tooltipBg: "#16161e", tooltipBorder: "#292e42",
    matchOutline: "rgba(122, 162, 247, 0.5)", searchMatch: "rgba(224, 175, 104, 0.25)", searchSelected: "rgba(255, 158, 100, 0.4)",
    kw: "#bb9af7", str: "#9ece6a", num: "#ff9e64", com: "#565f89", type: "#2ac3de", fn: "#7aa2f7", atom: "#73daca", invalid: "#f7768e",
  },
  solarizedLight: {
    dark: false,
    text: "#586e75", caret: "#268bd2", selection: "#d9d2c2", activeLine: "rgba(88, 110, 117, 0.06)",
    gutter: "#657373", tooltipBg: "#eee8d5", tooltipBorder: "#d6cfb6",
    matchOutline: "rgba(38, 139, 210, 0.4)", searchMatch: "rgba(181, 137, 0, 0.3)", searchSelected: "rgba(203, 75, 22, 0.35)",
    kw: "#687800", str: "#217d76", num: "#cd2d7b", com: "#657373", type: "#8e6b00", fn: "#2075b2", atom: "#6368c0", invalid: "#d82824",
  },
  githubLight: {
    dark: false,
    text: "#1f2328", caret: "#0969da", selection: "#add6ff", activeLine: "rgba(31, 35, 40, 0.04)",
    gutter: "#6a727c", tooltipBg: "#ffffff", tooltipBorder: "#d0d7de",
    matchOutline: "rgba(9, 105, 218, 0.4)", searchMatch: "rgba(255, 223, 93, 0.45)", searchSelected: "rgba(255, 158, 100, 0.45)",
    kw: "#cf222e", str: "#0a3069", num: "#0550ae", com: "#6a727c", type: "#953800", fn: "#8250df", atom: "#0550ae", invalid: "#cf222e",
  },
  gruvboxLight: {
    dark: false,
    text: "#3c3836", caret: "#af3a03", selection: "#d5c4a1", activeLine: "rgba(60, 56, 54, 0.06)",
    gutter: "#786b5e", tooltipBg: "#f2e5bc", tooltipBorder: "#d5c4a1",
    matchOutline: "rgba(7, 102, 120, 0.45)", searchMatch: "rgba(181, 118, 20, 0.3)", searchSelected: "rgba(175, 58, 3, 0.35)",
    kw: "#9d0006", str: "#74700d", num: "#8f3f71", com: "#786b5e", type: "#966211", fn: "#076678", atom: "#8f3f71", invalid: "#cc241d",
  },
};

export const cmThemes: Record<string, Extension> = Object.fromEntries(
  Object.entries(CM_PALETTES).map(([id, p]) => [id, makeCmTheme(p)]),
);
