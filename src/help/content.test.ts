import { describe, expect, it } from "vitest";
import { ACTIONS } from "../actions";
import { TOPICS } from "./content";
import { GROUPS, flatOrder } from "./nav";

// The manual degrades quietly where it can (unknown keys rows are filtered, unknown
// topic links render as text), which is exactly why drift needs a test: a renamed
// action or topic would otherwise vanish from the manual without anyone noticing.

const ids = new Set(TOPICS.map((t) => t.id));
const actions = new Set<string>(ACTIONS.map((a) => a.id));

function texts(): string[] {
  const out: string[] = [];
  for (const t of TOPICS) {
    for (const b of t.blocks) {
      if (b.k === "p" || b.k === "tip") out.push(b.md);
      else if (b.k === "list") out.push(...b.items);
      else if (b.k === "table") out.push(...b.rows.flat());
    }
  }
  return out;
}

describe("manual integrity", () => {
  it("navigates every topic exactly once", () => {
    const order = flatOrder();
    expect(new Set(order).size).toBe(order.length);
    for (const id of order) expect(ids.has(id), `nav names unknown topic ${id}`).toBe(true);
    for (const t of TOPICS) expect(order.includes(t.id), `topic ${t.id} is not in any nav group`).toBe(true);
    expect(GROUPS.every((g) => g.ids.length > 0)).toBe(true);
  });

  it("only lists keys for registered actions", () => {
    for (const t of TOPICS) {
      for (const b of t.blocks) {
        if (b.k !== "keys") continue;
        for (const row of b.rows) if (row.action) expect(actions.has(row.action), `${t.id}: ${row.action}`).toBe(true);
      }
    }
  });

  it("links only to topics that exist", () => {
    for (const md of texts()) {
      for (const m of md.matchAll(/\[\[topic:([a-z0-9-]+)\|/g)) expect(ids.has(m[1]), `link to ${m[1]}`).toBe(true);
    }
  });

  it("documents the database monitor and its shortcut", () => {
    const monitor = TOPICS.find((t) => t.id === "monitor");
    expect(monitor).toBeTruthy();
    const keyed = TOPICS.filter((t) => t.blocks.some((b) => b.k === "keys" && b.rows.some((r) => r.action === "openMonitor")));
    expect(keyed.map((t) => t.id)).toEqual(expect.arrayContaining(["monitor", "shortcuts", "workspace"]));
  });
});
