import { describe, expect, it } from "vitest";
import { effectiveMetric, heatLegend, heatOf } from "./heat";
import { planSummary } from "./summary";
import type { PlanNode, PlanTree } from "./types";

const node = (id: number, over: Partial<PlanNode> = {}): PlanNode => ({
  id,
  label: `n${id}`,
  props: [],
  children: [],
  ...over,
});

/** Root cost 200: one scan owns 150 of it, the other 50, the root itself 0. */
function costPlan(): PlanTree {
  const a = node(1, { selfCost: 150, totalCost: 150 });
  const b = node(2, { selfCost: 50, totalCost: 50 });
  const root = node(0, { selfCost: 0, totalCost: 200, children: [a, b] });
  return { kind: "tree", engine: "postgres", root, hasActual: false, maxSelfCost: 150, maxSelfTimeMs: 0, maxRows: 0 };
}

describe("plan heat", () => {
  it("reads a node as its share of the plan's total cost", () => {
    const p = costPlan();
    expect(heatOf(p.root.children[0], p, "cost")).toBeCloseTo(0.75, 5);
    expect(heatOf(p.root.children[1], p, "cost")).toBeCloseTo(0.25, 5);
    expect(heatOf(p.root, p, "cost")).toBe(0);
    // The old max-normalized sqrt ramp put the cheap node at 0.577 — all hot.
    expect(heatOf(p.root.children[1], p, "cost")).toBeLessThan(0.5);
  });

  it("falls back to the plan's hottest node when the root reports no total", () => {
    const p = costPlan();
    p.root.totalCost = undefined;
    expect(heatOf(p.root.children[0], p, "cost")).toBeCloseTo(1, 5);
    expect(heatOf(p.root.children[1], p, "cost")).toBeCloseTo(50 / 150, 5);
  });

  it("uses execution time for the time metric and the widest node for rows", () => {
    const p = costPlan();
    p.executionMs = 40;
    p.root.children[0].selfTimeMs = 30;
    p.maxSelfTimeMs = 30;
    expect(heatOf(p.root.children[0], p, "time")).toBeCloseTo(0.75, 5);
    p.maxRows = 5000;
    p.root.children[0].actualRows = 1000;
    expect(heatOf(p.root.children[0], p, "rows")).toBeCloseTo(0.2, 5);
  });

  it("is zero when heat is off, when nothing is measured, and never exceeds 1", () => {
    const p = costPlan();
    expect(heatOf(p.root.children[0], p, "off")).toBe(0);
    const empty: PlanTree = { ...p, root: node(0), maxSelfCost: 0, maxSelfTimeMs: 0, maxRows: 0 };
    expect(heatOf(empty.root, empty, "cost")).toBe(0);
    p.root.totalCost = 10; // a child costing more than the root still clamps
    expect(heatOf(p.root.children[0], p, "cost")).toBe(1);
  });

  it("degrades cost → time → rows on engines without costs", () => {
    const p = costPlan();
    const noCost: PlanTree = { ...p, maxSelfCost: 0, maxSelfTimeMs: 12 };
    expect(effectiveMetric(noCost, "cost")).toBe("time");
    expect(effectiveMetric({ ...noCost, maxSelfTimeMs: 0 }, "cost")).toBe("rows");
    expect(heatLegend(p, "cost")).toBe("heat: share of total cost");
    expect(heatLegend(p, "off")).toBe("");
  });
});

describe("planSummary", () => {
  it("counts nodes and states the plan total instead of a row count", () => {
    // The status bar used to read "1 rows" for a whole plan.
    expect(planSummary(costPlan())).toBe("3 nodes, total cost 200");
  });

  it("prefers measured time, and copes with a plan that reports neither", () => {
    const p = costPlan();
    p.hasActual = true;
    p.executionMs = 12.5;
    expect(planSummary(p)).toBe("3 nodes, 12.5 ms");
    const bare = costPlan();
    bare.root.totalCost = undefined;
    expect(planSummary(bare)).toBe("3 nodes");
    expect(planSummary({ kind: "text", text: "Seq Scan" })).toBe("Plan");
  });

  it("says one node without the plural", () => {
    const solo: PlanTree = { ...costPlan(), root: node(0, { totalCost: 4 }) };
    expect(planSummary(solo)).toBe("1 node, total cost 4");
  });
});
