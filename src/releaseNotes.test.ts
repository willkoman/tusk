import { describe, expect, it } from "vitest";
import { cmpVersion, notesSince, parseChangelog } from "./releaseNotes";

const SAMPLE = `# Changelog

Intro prose.

## [Unreleased]

### Added
- unreleased thing that must not show

## [0.9.1] - 2026-07-28

### Added
- **AI reply max tokens.** Desktop control matching Slack.
- **Cancel is honest per engine.** New capability;
  continuation line folded in.

### Changed
- **Engine-aware lexer.** MySQL truths.

## [0.9.0] - 2026-07-27

### Fixed
- **Closing the window works again.** Capability grant.

## [0.8.7] - 2026-07-21

### Fixed
- old fix
`;

describe("changelog parsing", () => {
  it("parses versioned sections, skips [Unreleased], folds continuations", () => {
    const all = parseChangelog(SAMPLE);
    expect(all.map((r) => r.version)).toEqual(["0.9.1", "0.9.0", "0.8.7"]);
    expect(all[0].date).toBe("2026-07-28");
    expect(all[0].groups.map((g) => g.title)).toEqual(["Added", "Changed"]);
    expect(all[0].groups[0].items[1]).toBe("**Cancel is honest per engine.** New capability; continuation line folded in.");
    expect(JSON.stringify(all)).not.toContain("unreleased thing");
  });

  it("selects only sections newer than last seen", () => {
    const all = parseChangelog(SAMPLE);
    expect(notesSince(all, "0.9.0").map((r) => r.version)).toEqual(["0.9.1"]);
    expect(notesSince(all, "0.8.7").map((r) => r.version)).toEqual(["0.9.1", "0.9.0"]);
    expect(notesSince(all, "0.9.1")).toEqual([]);
    expect(notesSince(all, "0.0.1", 2).length).toBe(2); // cap
  });

  it("compares versions numerically, not lexically", () => {
    expect(cmpVersion("0.10.0", "0.9.1")).toBeGreaterThan(0);
    expect(cmpVersion("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(cmpVersion("0.9.1", "0.9.1")).toBe(0);
  });

  it("parses the real CHANGELOG.md and finds the current release", async () => {
    // Same bundling mechanism the WhatsNew component uses.
    const real = (await import("../CHANGELOG.md?raw")).default;
    const all = parseChangelog(real);
    expect(all.length).toBeGreaterThan(3);
    // The newest section must match the shipping version (check:versions parity).
    const pkg = (await import("../package.json")).default as { version: string };
    expect(all[0].version).toBe(pkg.version);
    expect(all[0].groups.length).toBeGreaterThan(0);
    expect(all[0].groups.every((g) => g.items.length > 0)).toBe(true);
  });
});
