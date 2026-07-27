import {
  MAX_PLAN_JSON_CHARS,
  MAX_PLAN_PROPS,
  boundPlanText,
  type ParsedPlan,
  type PlanNode,
  finishTree,
  planInputWithinLimits,
  propStr,
} from "./types";

// DuckDB has TWO JSON plan shapes:
//   • `EXPLAIN (FORMAT json)` — array of `{name, children[], extra_info:{…}}`.
//     No timings/costs; estimated rows live as a STRING under
//     extra_info["Estimated Cardinality"].
//   • `EXPLAIN (ANALYZE, FORMAT json)` — a single profiling OBJECT (latency,
//     cumulative_*, no operator name) wrapping an `EXPLAIN_ANALYZE` operator,
//     under which the real tree uses `operator_name`/`operator_type`,
//     `operator_timing` (seconds), `operator_cardinality`, `operator_rows_scanned`.
// Box-drawing text EXPLAIN is handled by the caller as styled text.

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? boundPlanText(v.trim()) : undefined;
}
function toNum(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const n = Number(v.replace(/[, ]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function duckNode(raw: Record<string, unknown>): PlanNode {
  const children = Array.isArray(raw["children"])
    ? (raw["children"] as unknown[]).filter(isObj).map(duckNode)
    : [];

  // Label: plain EXPLAIN uses `name`; ANALYZE uses `operator_name`/`operator_type`.
  const label = str(raw["name"]) ?? str(raw["operator_name"]) ?? str(raw["operator_type"]) ?? "Operator";

  const props: [string, string][] = [];
  let estRows: number | undefined; // estimated cardinality (plain EXPLAIN)
  let object: string | undefined;
  const extra = raw["extra_info"] ?? raw["extra-info"];
  if (isObj(extra)) {
    for (const [k, v] of Object.entries(extra)) {
      if (props.length < MAX_PLAN_PROPS) props.push([boundPlanText(k), propStr(v)]);
      if (/estimated\s*cardinality/i.test(k)) estRows = toNum(v);
      if (/^table$/i.test(k)) object = str(v);
    }
  } else if (typeof extra === "string" && extra.trim()) {
    props.push(["Info", propStr(extra.trim())]);
  }
  // Surface the remaining scalar fields (skip ones we've consumed for label/metrics).
  const SKIP = new Set([
    "children", "extra_info", "extra-info", "name", "operator_name", "operator_type",
    "operator_timing", "timing", "operator_cardinality", "cardinality", "operator_rows_scanned",
  ]);
  for (const [k, v] of Object.entries(raw)) {
    if (SKIP.has(k) || isObj(v)) continue;
    if (props.length < MAX_PLAN_PROPS) props.push([boundPlanText(k), propStr(v)]);
  }

  const timingS = toNum(raw["timing"]) ?? toNum(raw["operator_timing"]);
  const actualRows = toNum(raw["cardinality"]) ?? toNum(raw["operator_cardinality"]);

  return {
    id: 0,
    label,
    object,
    props,
    // DuckDB reports per-operator time — already exclusive.
    selfTimeMs: timingS !== undefined ? timingS * 1000 : undefined,
    actualRows,
    planRows: estRows,
    children,
  };
}

/** Unwrap the ANALYZE profiling root + the `EXPLAIN_ANALYZE` operator down to the
 *  real operator subtree(s) — those wrappers carry no useful node data. */
function unwrapAnalyze(o: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const stack = [o];
  while (stack.length) {
    const cur = stack.pop()!;
    const opName = str(cur["operator_name"]) ?? str(cur["operator_type"]) ?? str(cur["name"]);
    if (opName !== undefined && opName !== "EXPLAIN_ANALYZE") {
      out.push(cur);
      continue;
    }
    const kids = Array.isArray(cur["children"]) ? (cur["children"] as unknown[]).filter(isObj) : [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

export function parseDuck(jsonText: string): ParsedPlan | null {
  if (jsonText.length > MAX_PLAN_JSON_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!planInputWithinLimits(parsed)) return null;

  let nodes: Record<string, unknown>[];
  let executionMs: number | undefined;
  if (Array.isArray(parsed)) {
    // Plain EXPLAIN (FORMAT json).
    nodes = parsed.filter(isObj).filter((n) => "name" in n || "children" in n);
  } else if (isObj(parsed)) {
    // ANALYZE profiling object — capture total latency, unwrap to the real tree.
    const lat = toNum(parsed["latency"]);
    if (lat !== undefined) executionMs = lat * 1000;
    nodes = unwrapAnalyze(parsed);
  } else {
    return null;
  }
  if (!nodes.length) return null;

  const roots = nodes.map(duckNode);
  const root: PlanNode = roots.length === 1 ? roots[0] : { id: 0, label: "Plan", props: [], children: roots };
  return finishTree("duckdb", root, { executionMs });
}
