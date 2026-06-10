import { type ParsedPlan, type PlanNode, finishTree, propStr } from "./types";

// DuckDB `EXPLAIN (FORMAT json)` / `EXPLAIN ANALYZE (FORMAT json)` → PlanTree.
// Shape varies across libduckdb versions: nodes are {name, children[], …} with
// extra info under "extra_info" (object or string) or "extra-info" (older),
// timings under "timing"/"operator_timing" (seconds) and cardinality under
// "cardinality"/"operator_cardinality". Box-drawing text EXPLAIN is handled by
// the caller as styled text.

function duckNode(raw: Record<string, unknown>): PlanNode {
  const children = Array.isArray(raw["children"])
    ? (raw["children"] as unknown[]).filter((c): c is Record<string, unknown> => !!c && typeof c === "object").map(duckNode)
    : [];
  const props: [string, string][] = [];
  const extra = raw["extra_info"] ?? raw["extra-info"];
  if (extra && typeof extra === "object") {
    for (const [k, v] of Object.entries(extra as Record<string, unknown>)) props.push([k, propStr(v)]);
  } else if (typeof extra === "string" && extra.trim()) {
    props.push(["Info", extra.trim()]);
  }
  for (const [k, v] of Object.entries(raw)) {
    if (k === "children" || k === "extra_info" || k === "extra-info" || k === "name") continue;
    if (typeof v !== "object") props.push([k, propStr(v)]);
  }
  const num = (k: string): number | undefined => {
    const v = raw[k];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const timingS = num("timing") ?? num("operator_timing");
  const card = num("cardinality") ?? num("operator_cardinality");
  return {
    id: 0,
    label: typeof raw["name"] === "string" && raw["name"] ? (raw["name"] as string) : "Operator",
    props,
    // DuckDB reports per-operator time — already exclusive.
    selfTimeMs: timingS !== undefined ? timingS * 1000 : undefined,
    actualRows: card,
    children,
  };
}

export function parseDuck(jsonText: string): ParsedPlan | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const nodes = arr.filter((n): n is Record<string, unknown> => !!n && typeof n === "object" && ("name" in n || "children" in n));
  if (!nodes.length) return null;
  const roots = nodes.map(duckNode);
  const root: PlanNode = roots.length === 1 ? roots[0] : { id: 0, label: "Plan", props: [], children: roots };
  return finishTree("duckdb", root);
}
