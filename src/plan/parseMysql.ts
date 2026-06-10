import { type ParsedPlan, type PlanNode, finishTree, propStr } from "./types";

// MySQL `EXPLAIN FORMAT=JSON` → PlanTree. Root is { query_block: {...} };
// children hide under a zoo of wrapper keys that varies by version. Known
// wrappers recurse; unknown scalar/object keys become props. A document with
// no query_block at all → null (caller falls back). No actuals in this format
// (EXPLAIN ANALYZE is TREE text → styled-text fallback by design).

const CHILD_KEYS = [
  "query_block",
  "ordering_operation",
  "grouping_operation",
  "duplicates_removal",
  "windowing",
  "buffer_result",
  "materialized_from_subquery",
  "union_result",
  "table",
] as const;
const CHILD_LIST_KEYS = ["nested_loop", "query_specifications", "attached_subqueries", "subqueries", "optimized_away_subqueries", "select_list_subqueries"] as const;

const LABELS: Record<string, string> = {
  query_block: "Query Block",
  ordering_operation: "Sort",
  grouping_operation: "Group",
  duplicates_removal: "Distinct",
  windowing: "Window",
  buffer_result: "Buffer",
  materialized_from_subquery: "Materialize",
  union_result: "Union",
  table: "Table",
};

function costOf(obj: Record<string, unknown>): { total?: number; self?: number } {
  const ci = obj["cost_info"];
  if (!ci || typeof ci !== "object") return {};
  const c = ci as Record<string, unknown>;
  const f = (k: string) => {
    const v = c[k];
    const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(n) ? n : undefined;
  };
  const total = f("query_cost") ?? f("prefix_cost");
  const read = f("read_cost");
  const evalC = f("eval_cost");
  const self = read !== undefined || evalC !== undefined ? (read ?? 0) + (evalC ?? 0) : undefined;
  return { total, self };
}

function myNode(key: string, obj: Record<string, unknown>): PlanNode {
  const children: PlanNode[] = [];
  const props: [string, string][] = [];

  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v) && (CHILD_KEYS as readonly string[]).includes(k)) {
      children.push(myNode(k, v as Record<string, unknown>));
    } else if (Array.isArray(v) && (CHILD_LIST_KEYS as readonly string[]).includes(k)) {
      for (const item of v) {
        if (item && typeof item === "object") {
          const it = item as Record<string, unknown>;
          // list items are wrappers like {table: {...}} or {query_block: {...}}
          let wrapped = false;
          for (const ck of CHILD_KEYS) {
            if (it[ck] && typeof it[ck] === "object") {
              children.push(myNode(ck, it[ck] as Record<string, unknown>));
              wrapped = true;
            }
          }
          if (!wrapped) children.push(myNode(k, it));
        }
      }
    } else if (k !== "cost_info") {
      props.push([k, propStr(v)]);
    }
  }

  const { total, self } = costOf(obj);
  const access = typeof obj["access_type"] === "string" ? (obj["access_type"] as string) : undefined;
  const node: PlanNode = {
    id: 0,
    label: key === "table" && access ? `Access (${access})` : (LABELS[key] ?? key),
    object: typeof obj["table_name"] === "string" ? (obj["table_name"] as string) : undefined,
    props,
    totalCost: total,
    selfCost: self,
    planRows: typeof obj["rows_examined_per_scan"] === "number" ? (obj["rows_examined_per_scan"] as number) : undefined,
    children,
  };
  // Without read/eval breakdown, approximate exclusive as total − Σ children.
  if (node.selfCost === undefined && node.totalCost !== undefined) {
    let s = node.totalCost;
    for (const c of children) if (c.totalCost !== undefined) s -= c.totalCost;
    node.selfCost = Math.max(0, s);
  }
  return node;
}

export function parseMysql(jsonText: string): ParsedPlan | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const qb = (parsed as Record<string, unknown>)["query_block"];
  if (!qb || typeof qb !== "object") return null;
  const root = myNode("query_block", qb as Record<string, unknown>);
  return finishTree("mysql", root, { hasActual: false });
}
