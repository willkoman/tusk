import { describe, expect, it } from "vitest";
import { CM_PALETTES } from "./cmThemes";
import { LIGHT_PALETTE } from "./lightTheme";
import { THEMES } from "../themes";

/**
 * The editor and every dialog SqlField paint a theme's syntax palette straight
 * onto that theme's `--bg`. `SqlField` used to hard-code One Dark, so a light
 * theme rendered type names at 1.6:1; the fix is only real if the light palettes
 * themselves clear AA. App.css is read here so a `--bg` change is caught too.
 */

// The stylesheet itself is the source of truth for `--bg`, so it is read from
// disk: vitest stubs CSS module imports to "" and a copy of the values here
// would be exactly the thing that drifts.
// @ts-expect-error node builtin; this project ships no @types/node
const { readFileSync } = await import("node:fs");
const cssPath = decodeURIComponent(new URL("../App.css", import.meta.url).pathname).replace(/^\/(\w:)/, "$1");
const CSS: string = readFileSync(cssPath, "utf8");

/** `--bg` declared inside `:root[data-theme="<id>"]`, or the bare `:root` block. */
function background(theme: string): string {
  const head = theme === "oneDark" ? ":root {" : `:root[data-theme="${theme}"] {`;
  const at = CSS.indexOf(head);
  expect(at, `no token block for ${theme}`).toBeGreaterThan(-1);
  const block = CSS.slice(at, CSS.indexOf("\n}", at));
  const m = /--bg:\s*(#[0-9a-f]{6})/i.exec(block);
  expect(m, `no --bg for ${theme}`).toBeTruthy();
  return m![1];
}

function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The colours a SqlField can actually paint, per theme id. */
const paletteOf = (theme: string): Record<string, string> =>
  theme === "light"
    ? LIGHT_PALETTE
    : (() => {
        const p = CM_PALETTES[theme];
        expect(p, `no palette for ${theme}`).toBeTruthy();
        const { text, kw, str, num, com, type, fn, atom, invalid, gutter } = p;
        return { text, kw, str, num, com, type, fn, atom, invalid, gutter };
      })();

const LIGHT = THEMES.filter((t) => !t.dark).map((t) => t.id);
const DARK = THEMES.filter((t) => t.dark).map((t) => t.id);

describe("editor palettes are readable on their own surface", () => {
  it("covers every bundled theme", () => {
    expect(LIGHT).toEqual(["light", "solarizedLight", "githubLight", "gruvboxLight"]);
    expect(DARK.length).toBeGreaterThan(0);
  });

  it.each(LIGHT)("%s clears WCAG AA (4.5:1) on its own --bg", (theme) => {
    const bg = background(theme);
    for (const [token, color] of Object.entries(paletteOf(theme))) {
      expect(contrastRatio(color, bg), `${theme}.${token} (${color} on ${bg})`).toBeGreaterThanOrEqual(4.5);
    }
  });

  // Parity, not a raise: the dark palettes are untouched, and every token except
  // the deliberately quiet comment already clears the same bar.
  it.each(DARK)("%s keeps its syntax tokens above 4.5:1 (comments excepted)", (theme) => {
    const bg = background(theme);
    if (theme === "oneDark") return; // bundled @codemirror/theme-one-dark, no palette record here
    for (const [token, color] of Object.entries(paletteOf(theme))) {
      if (token === "com" || token === "gutter") continue;
      expect(contrastRatio(color, bg), `${theme}.${token} (${color} on ${bg})`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
