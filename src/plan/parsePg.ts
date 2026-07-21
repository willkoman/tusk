import { type ParsedPlan, type PlanNode, finishTree, planInputWithinLimits, propStr } from "./types";

// Postgres EXPLAIN (FORMAT JSON) → PlanTree. The JSON arrives as a single text
// cell over the simple protocol (possibly pretty-printed across lines — the
// caller joins rows). Structure: [ { "Plan": {...}, "Planning Time"?, "Execution
// Time"? }, … ]; node children under "Plans".

const EXTRACTED = new Set(["Plans"]);

function pgNode(raw: Record<string, unknown>): PlanNode {
  const children = Array.isArray(raw["Plans"])
    ? (raw["Plans"] as unknown[])
      .filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v))
      .map(pgNode)
    : [];
  const num = (k: string): number | undefined => (typeof raw[k] === "number" ? (raw[k] as number) : undefined);
  const str = (k: string): string | undefined => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);

  const totalCost = num("Total Cost");
  const totalTimeMs = num("Actual Total Time");
  const loops = num("Actual Loops");

  // Exclusive cost: total − Σ(children's totals), clamped. Standard pev2-style
  // approximation — CTE scans / InitPlans can double-count; documented caveat.
  let selfCost: number | undefined;
  if (totalCost !== undefined) {
    selfCost = totalCost;
    for (const c of children) if (c.totalCost !== undefined) selfCost -= c.totalCost;
    selfCost = Math.max(0, selfCost);
  }
  // Exclusive time across all loops: time·loops − Σ(child time·loops).
  let selfTimeMs: number | undefined;
  if (totalTimeMs !== undefined) {
    selfTimeMs = totalTimeMs * (loops ?? 1);
    for (const c of children) if (c.totalTimeMs !== undefined) selfTimeMs -= c.totalTimeMs * (c.loops ?? 1);
    selfTimeMs = Math.max(0, selfTimeMs);
  }

  const props: [string, string][] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (!EXTRACTED.has(k)) props.push([k, propStr(v)]);
  }

  return {
    id: 0,
    label: str("Node Type") ?? "Plan",
    object: str("Relation Name") ?? str("Index Name") ?? str("CTE Name") ?? str("Function Name") ?? undefined,
    props,
    totalCost,
    selfCost,
    planRows: num("Plan Rows"),
    actualRows: num("Actual Rows"),
    loops,
    totalTimeMs,
    selfTimeMs,
    children,
  };
}

export function parsePg(jsonText: string): ParsedPlan | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  if (!planInputWithinLimits(arr)) return null;
  const first = arr[0] as Record<string, unknown> | undefined;
  const planRaw = first?.["Plan"];
  if (!planRaw || typeof planRaw !== "object") return null;
  const root = pgNode(planRaw as Record<string, unknown>);
  return finishTree("postgres", root, {
    planningMs: typeof first?.["Planning Time"] === "number" ? (first["Planning Time"] as number) : undefined,
    executionMs: typeof first?.["Execution Time"] === "number" ? (first["Execution Time"] as number) : undefined,
  });
}
