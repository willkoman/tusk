// Normalized query-plan model. Every engine parser maps its native EXPLAIN
// output into this shape; the PlanView renders only this. Parsers are pure and
// total: they return null ("not a parseable tree — caller decides grid/text"),
// never throw.

export type EngineKind = "postgres" | "mysql" | "sqlite" | "duckdb";

export type PlanNode = {
  /** Stable preorder index — collapse keys + details-panel identity. */
  id: number;
  /** Operator label ("Seq Scan", "Hash Join", "SEARCH", "HASH_JOIN", …). */
  label: string;
  /** Relation / index / CTE the operator touches, when known. */
  object?: string;
  /** Full flattened raw properties, render-ready for the details panel. */
  props: [string, string][];
  /** Inclusive cost (engine units). */
  totalCost?: number;
  /** Exclusive cost = total − Σ children (clamped ≥ 0) — drives heat. */
  selfCost?: number;
  planRows?: number;
  actualRows?: number;
  loops?: number;
  /** Inclusive actual time in ms (per loop, as reported). */
  totalTimeMs?: number;
  /** Exclusive actual time in ms across all loops (pev2-style approximation). */
  selfTimeMs?: number;
  children: PlanNode[];
};

export type PlanTree = {
  kind: "tree";
  engine: EngineKind;
  root: PlanNode;
  /** True when the plan carries actual (ANALYZE) measurements. */
  hasActual: boolean;
  planningMs?: number;
  executionMs?: number;
  // Maxima precomputed at parse time → O(1) heat per node.
  maxSelfCost: number;
  maxSelfTimeMs: number;
  maxRows: number;
};

export type ParsedPlan = PlanTree | { kind: "text"; text: string };

export const MAX_PLAN_DEPTH = 256;
export const MAX_PLAN_NODES = 2_000;
export const MAX_PLAN_JSON_CHARS = 5_000_000;
export const MAX_PLAN_PROPS = 256;
export const MAX_PLAN_LABEL_CHARS = 512;
export const MAX_PLAN_PROP_CHARS = 4_096;
const MAX_PLAN_VALUES = 50_000;

/** Bound provider/database-controlled JSON before recursive engine normalization. */
export function planInputWithinLimits(root: unknown): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  const seen = new WeakSet<object>();
  let count = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++count > MAX_PLAN_VALUES || depth > MAX_PLAN_DEPTH) return false;
    if (!value || typeof value !== "object") continue;
    if (seen.has(value)) return false;
    seen.add(value);
    const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    for (const child of children) stack.push({ value: child, depth: depth + 1 });
  }
  return true;
}

/** Preorder-number a tree, compute maxima, and wrap it. */
export function finishTree(
  engine: EngineKind,
  root: PlanNode,
  extra?: { hasActual?: boolean; planningMs?: number; executionMs?: number },
): PlanTree | null {
  let id = 0;
  let maxSelfCost = 0;
  let maxSelfTimeMs = 0;
  let maxRows = 0;
  let hasActual = extra?.hasActual ?? false;
  const seen = new Set<PlanNode>();
  const stack = [{ node: root, depth: 0 }];
  while (stack.length) {
    const { node: n, depth } = stack.pop()!;
    if (
      !n || typeof n !== "object" || !Array.isArray(n.children) || seen.has(n) || id >= MAX_PLAN_NODES ||
      depth > MAX_PLAN_DEPTH || n.children.length > MAX_PLAN_NODES - seen.size - stack.length - 1
    ) return null;
    const metrics = [n.totalCost, n.selfCost, n.planRows, n.actualRows, n.loops, n.totalTimeMs, n.selfTimeMs];
    if (metrics.some((value) => value !== undefined && !Number.isFinite(value))) return null;
    seen.add(n);
    n.id = id++;
    if (n.selfCost !== undefined && Number.isFinite(n.selfCost)) maxSelfCost = Math.max(maxSelfCost, n.selfCost);
    if (n.selfTimeMs !== undefined && Number.isFinite(n.selfTimeMs)) maxSelfTimeMs = Math.max(maxSelfTimeMs, n.selfTimeMs);
    const r = n.actualRows ?? n.planRows;
    if (r !== undefined && Number.isFinite(r)) maxRows = Math.max(maxRows, r);
    if (n.actualRows !== undefined || n.totalTimeMs !== undefined) hasActual = true;
    for (let i = n.children.length - 1; i >= 0; i--) stack.push({ node: n.children[i], depth: depth + 1 });
  }
  return {
    kind: "tree",
    engine,
    root,
    hasActual,
    planningMs: extra?.planningMs !== undefined && Number.isFinite(extra.planningMs) ? extra.planningMs : undefined,
    executionMs: extra?.executionMs !== undefined && Number.isFinite(extra.executionMs) ? extra.executionMs : undefined,
    maxSelfCost,
    maxSelfTimeMs,
    maxRows,
  };
}

/** Render any value as a props-table string (arrays/objects → compact JSON). */
export function propStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  let out: string;
  if (typeof v === "string") out = v;
  else if (typeof v === "number" || typeof v === "boolean") out = String(v);
  else {
    try {
      out = JSON.stringify(v) ?? "";
    } catch {
      out = "[unserializable]";
    }
  }
  return boundPlanText(out, MAX_PLAN_PROP_CHARS);
}

export function boundPlanText(value: string, max = MAX_PLAN_LABEL_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}
