// "What's new" data layer — pure + vitest-covered. The popup (WhatsNew.tsx)
// bundles CHANGELOG.md at build time (vite `?raw`), so the notes always match
// the exact shipped build, work offline, and need no network capability.
//
// Contract with CHANGELOG.md (also what the release workflow publishes as the
// GitHub release body): `## [x.y.z] - date` sections, `### Added/Changed/Fixed`
// groups, `- **Lead.** detail` bullets. Keep entries user-facing — what changed
// and why — because they ARE the release notes users see, in-app and on GitHub.

export type ReleaseGroup = { title: string; items: string[] };
export type ReleaseNotes = { version: string; date: string; groups: ReleaseGroup[] };

const MAX_CHANGELOG_CHARS = 2_000_000;
const MAX_RELEASES = 50;
const MAX_ITEM_CHARS = 4_000;

const RELEASE_HEAD = /^## \[(\d+\.\d+\.\d+)\](?: - (.+))?\s*$/;
const GROUP_HEAD = /^### (.+?)\s*$/;

/** Numeric x.y.z comparison; malformed parts compare as 0. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Parse versioned sections (skips `[Unreleased]`), newest first as authored. */
export function parseChangelog(text: string): ReleaseNotes[] {
  if (text.length > MAX_CHANGELOG_CHARS) return [];
  const releases: ReleaseNotes[] = [];
  let release: ReleaseNotes | null = null;
  let group: ReleaseGroup | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const head = RELEASE_HEAD.exec(line);
    if (head) {
      if (releases.length >= MAX_RELEASES) break;
      release = { version: head[1], date: head[2] ?? "", groups: [] };
      releases.push(release);
      group = null;
      continue;
    }
    if (line.startsWith("## ")) {
      // [Unreleased] or anything non-versioned: stop collecting into the previous release.
      release = null;
      group = null;
      continue;
    }
    if (!release) continue;
    const g = GROUP_HEAD.exec(line);
    if (g) {
      group = { title: g[1], items: [] };
      release.groups.push(group);
      continue;
    }
    if (line.startsWith("- ")) {
      if (group) group.items.push(line.slice(2).slice(0, MAX_ITEM_CHARS));
      continue;
    }
    // Continuation line of the previous bullet (indented or plain prose).
    if (group && group.items.length && line.trim()) {
      const last = group.items.length - 1;
      group.items[last] = `${group.items[last]} ${line.trim()}`.slice(0, MAX_ITEM_CHARS);
    }
  }
  return releases;
}

/** Sections strictly newer than `lastSeen`, capped, newest first. */
export function notesSince(all: ReleaseNotes[], lastSeen: string, cap = 5): ReleaseNotes[] {
  return all.filter((r) => cmpVersion(r.version, lastSeen) > 0).slice(0, cap);
}
