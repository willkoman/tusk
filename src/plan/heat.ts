import type { EditorPrefs } from "../editor/types";
import type { PlanNode, PlanTree } from "./types";

// How hot a plan node reads.
//
// The rule is ROOT-RELATIVE: a node's heat is its own share of the plan's total —
// self cost over the root's total cost, self time over total execution time. So
// the ramp answers "how much of this query is this node?", every node's heat sums
// to about 1, and only a node that really dominates the plan reaches the hot end.
//
// The previous scale normalized against the hottest node and then took a square
// root, which pushed a 57-cost scan to two thirds of the way up beside a 201-cost
// one: every node in a small plan came out hot, and a heat map where everything
// is hot says nothing.
//
// Rows have no root total to divide by (a LIMIT root reports fewer rows than the
// scan under it), so the row metric stays relative to the plan's widest node.

export type HeatMetric = EditorPrefs["planHeat"];

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const positive = (n: number | undefined): number | undefined =>
  n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;

/** Inclusive time of a node across its loops, as the cards report it. */
const inclusiveTime = (n: PlanNode): number | undefined =>
  n.totalTimeMs !== undefined ? n.totalTimeMs * (n.loops ?? 1) : n.selfTimeMs;

/**
 * The metric actually used: cost falls back to time, then rows, on engines that
 * report no costs (DuckDB gives per-operator time; plain EXPLAIN only rows).
 */
export function effectiveMetric(plan: PlanTree, metric: HeatMetric): HeatMetric {
  if (metric !== "cost" || plan.maxSelfCost > 0) return metric;
  return plan.maxSelfTimeMs > 0 ? "time" : "rows";
}

/** 0..1 heat for one node under the chosen metric. */
export function heatOf(n: PlanNode, plan: PlanTree, metric: HeatMetric): number {
  const m = effectiveMetric(plan, metric);
  if (m === "off") return 0;
  if (m === "cost") {
    const total = positive(plan.root.totalCost) ?? positive(plan.maxSelfCost);
    return total ? clamp01((n.selfCost ?? 0) / total) : 0;
  }
  if (m === "time") {
    const total = positive(plan.executionMs) ?? positive(inclusiveTime(plan.root)) ?? positive(plan.maxSelfTimeMs);
    return total ? clamp01((n.selfTimeMs ?? 0) / total) : 0;
  }
  const max = positive(plan.maxRows);
  return max ? clamp01((n.actualRows ?? n.planRows ?? 0) / max) : 0;
}

/** What the colour means, for the plan header. */
export function heatLegend(plan: PlanTree, metric: HeatMetric): string {
  const m = effectiveMetric(plan, metric);
  if (m === "off") return "";
  if (m === "rows") return "heat: rows against the widest node";
  return m === "cost" ? "heat: share of total cost" : "heat: share of total time";
}
