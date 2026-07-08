import { describe, expect, it } from "vitest";
import { activeSkills, formatSkills, SKILLS_BUDGET, type Skill } from "./skills";

const sk = (p: Partial<Skill> & { name: string }): Skill => ({
  id: p.name, description: "", scope: "workspace", database: "", enabled: true, body: "b", ...p,
});

describe("skill scoping", () => {
  it("applies workspace skills everywhere and database skills only on a match", () => {
    const all = [
      sk({ name: "ws" }),
      sk({ name: "db", scope: "database", database: "pagila" }),
      sk({ name: "other", scope: "database", database: "elsewhere" }),
    ];
    expect(activeSkills(all, "pagila").map((s) => s.name)).toEqual(["db", "ws"]);
    expect(activeSkills(all, "unknown").map((s) => s.name)).toEqual(["ws"]);
  });

  it("ranks database-scoped first, so the specific rule survives a budget cutoff", () => {
    const all = [sk({ name: "ws" }), sk({ name: "db", scope: "database", database: "d" })];
    expect(activeSkills(all, "d")[0].name).toBe("db");
  });

  it("never applies a disabled skill", () => {
    expect(activeSkills([sk({ name: "off", enabled: false })], "d")).toEqual([]);
  });

  it("a database-scoped skill with no database matches nothing (it would look broken)", () => {
    expect(activeSkills([sk({ name: "x", scope: "database", database: "" })], "d")).toEqual([]);
    // ...and must not accidentally match the empty database of a disconnected app.
    expect(activeSkills([sk({ name: "x", scope: "database", database: "" })], "")).toEqual([]);
  });
});

describe("skill prompt rendering", () => {
  it("renders name, description and scope", () => {
    const out = formatSkills([sk({ name: "Revenue", description: "MRR rules", scope: "database", database: "pagila", body: "exclude refunds" })]);
    expect(out).toContain("## Revenue — MRR rules (database: pagila)");
    expect(out).toContain("exclude refunds");
  });

  it("skips a body-less skill rather than emitting an empty heading", () => {
    expect(formatSkills([sk({ name: "Empty", body: "   " })]).trim()).toBe("");
  });

  it("NAMES a skill dropped for budget — a silent cut looks like the skill was ignored", () => {
    const big = sk({ name: "Huge", body: "x".repeat(SKILLS_BUDGET + 10) });
    const small = sk({ name: "Small", body: "keep me" });
    const out = formatSkills([small, big]);
    expect(out).toContain("keep me");
    expect(out).toContain("Not included, over the context budget: Huge");
  });
});
