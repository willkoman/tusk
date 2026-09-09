import { MAX_PLAN_NODES, type ParsedPlan, type PlanNode } from "./types";

// What the status bar says while the result panel shows a plan. A plan is one
// row over the wire, so the row-count slot used to read "1 rows" — true of the
// transport, useless about the plan. This states the plan instead.

function countNodes(root: PlanNode): number {
  let n = 0;
  const stack = [root];
  const seen = new Set<PlanNode>();
  while (stack.length && n < MAX_PLAN_NODES) {
    const x = stack.pop()!;
    if (seen.has(x)) continue;
    seen.add(x);
    n++;
    for (const c of x.children) stack.push(c);
  }
  return n;
}

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2));

/** `12 nodes, total cost 174` — or the measured time once the plan has one. */
export function planSummary(plan: ParsedPlan): string {
  if (plan.kind !== "tree") return "Plan";
  const nodes = countNodes(plan.root);
  const head = `${nodes.toLocaleString()} node${nodes === 1 ? "" : "s"}`;
  const ms = plan.executionMs;
  if (plan.hasActual && ms !== undefined && Number.isFinite(ms)) {
    return `${head}, ${ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(ms < 1 ? 3 : 1)} ms`}`;
  }
  const cost = plan.root.totalCost;
  return cost !== undefined && Number.isFinite(cost) ? `${head}, total cost ${fmt(cost)}` : head;
}
