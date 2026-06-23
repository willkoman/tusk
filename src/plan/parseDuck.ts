import { type ParsedPlan, type PlanNode, finishTree, propStr } from "./types";

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
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function toNum(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const n = Number(v.replace(/[, ]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

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
      props.push([k, propStr(v)]);
      if (/estimated\s*cardinality/i.test(k)) estRows = toNum(v);
      if (/^table$/i.test(k)) object = str(v);
    }
  } else if (typeof extra === "string" && extra.trim()) {
    props.push(["Info", extra.trim()]);
  }
  // Surface the remaining scalar fields (skip ones we've consumed for label/metrics).
  const SKIP = new Set([
    "children", "extra_info", "extra-info", "name", "operator_name", "operator_type",
    "operator_timing", "timing", "operator_cardinality", "cardinality", "operator_rows_scanned",
  ]);
  for (const [k, v] of Object.entries(raw)) {
    if (SKIP.has(k) || isObj(v)) continue;
    props.push([k, propStr(v)]);
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
  const opName = str(o["operator_name"]) ?? str(o["operator_type"]) ?? str(o["name"]);
  const kids = Array.isArray(o["children"]) ? (o["children"] as unknown[]).filter(isObj) : [];
  // The profiling root has no operator name; the EXPLAIN_ANALYZE op is a pure wrapper.
  if (opName === undefined || opName === "EXPLAIN_ANALYZE") return kids.flatMap(unwrapAnalyze);
  return [o];
}

export function parseDuck(jsonText: string): ParsedPlan | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

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
