import { describe, expect, it } from "vitest";

/**
 * The monitor's chart colours are design tokens (App.css section 1). They are
 * ALIASES onto roles every theme block retunes (`--conn-N`, `--tag-*`), which is
 * what lets eight palettes each get their own chart colours without eight copies of
 * ten literals. These checks keep it that way: no literal sneaks into `:root`, no
 * theme block forks a chart token, and every token the charts name exists.
 */

// @ts-expect-error node builtin; this project ships no @types/node
const { readFileSync } = await import("node:fs");
const read = (rel: string): string =>
  readFileSync(decodeURIComponent(new URL(rel, import.meta.url).pathname).replace(/^\/(\w:)/, "$1"), "utf8");
const CSS = read("../App.css");
const TAB = read("./MonitorTab.tsx");

const rootBlock = () => {
  const at = CSS.indexOf(":root {");
  return CSS.slice(at, CSS.indexOf("\n}", at));
};

describe("chart tokens", () => {
  it("are aliases onto per-theme roles, never literals", () => {
    const chart = [...rootBlock().matchAll(/--chart-(\d+):\s*([^;]+);/g)];
    expect(chart.length).toBe(10);
    for (const [, n, value] of chart) {
      expect(value.trim(), `--chart-${n}`).toMatch(/^var\(--(conn-\d|tag-[a-z]+)\)$/);
    }
  });

  it("are not redefined by any theme block", () => {
    const outsideRoot = CSS.replace(rootBlock(), "");
    expect(outsideRoot).not.toMatch(/--chart-\d+:/);
  });

  it("cover every colour the monitor's charts name", () => {
    const defined = new Set([...CSS.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
    const used = new Set([...TAB.matchAll(/"(--[a-z0-9-]+)"/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(5);
    for (const token of used) expect(defined.has(token), token).toBe(true);
  });
});
