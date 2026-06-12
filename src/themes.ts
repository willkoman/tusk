// Theme registry — single source of truth for the selectable UI themes.
//
// Each theme = a CSS-variable palette block in App.css keyed by
// `:root[data-theme="<id>"]` (the dark default lives on bare `:root`, so
// "oneDark" needs no block) + a CodeMirror editor theme (editor/cmThemes.ts).
// App sets BOTH attributes on <html>: `data-theme` (which palette) and
// `data-mode` ("dark" | "light") — mode-level CSS fixes (lint squiggle colors,
// grid edit tints, syntax-token defaults) key on data-mode so every light
// theme inherits them without per-theme duplication.

export type ThemeId =
  | "oneDark"
  | "catppuccinMocha"
  | "dracula"
  | "tokyoNight"
  | "light"
  | "solarizedLight"
  | "githubLight"
  | "gruvboxLight";

export const THEMES: { id: ThemeId; label: string; dark: boolean }[] = [
  { id: "oneDark", label: "One Dark", dark: true },
  { id: "catppuccinMocha", label: "Catppuccin Mocha", dark: true },
  { id: "dracula", label: "Dracula", dark: true },
  { id: "tokyoNight", label: "Tokyo Night", dark: true },
  { id: "light", label: "One Light", dark: false },
  { id: "solarizedLight", label: "Solarized Light", dark: false },
  { id: "githubLight", label: "GitHub Light", dark: false },
  { id: "gruvboxLight", label: "Gruvbox Light", dark: false },
];

const DARK = new Set(THEMES.filter((t) => t.dark).map((t) => t.id));

export const isDarkTheme = (id: ThemeId): boolean => DARK.has(id);

/** Old prefs may hold an id we no longer know — fall back to the dark default. */
export const normalizeTheme = (id: string): ThemeId =>
  THEMES.some((t) => t.id === id) ? (id as ThemeId) : "oneDark";
