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

/** Preorder-number a tree, compute maxima, and wrap it. */
export function finishTree(
  engine: EngineKind,
  root: PlanNode,
  extra?: { hasActual?: boolean; planningMs?: number; executionMs?: number },
): PlanTree {
  let id = 0;
  let maxSelfCost = 0;
  let maxSelfTimeMs = 0;
  let maxRows = 0;
  let hasActual = extra?.hasActual ?? false;
  const walk = (n: PlanNode) => {
    n.id = id++;
    if (n.selfCost !== undefined) maxSelfCost = Math.max(maxSelfCost, n.selfCost);
    if (n.selfTimeMs !== undefined) maxSelfTimeMs = Math.max(maxSelfTimeMs, n.selfTimeMs);
    const r = n.actualRows ?? n.planRows;
    if (r !== undefined) maxRows = Math.max(maxRows, r);
    if (n.actualRows !== undefined || n.totalTimeMs !== undefined) hasActual = true;
    n.children.forEach(walk);
  };
  walk(root);
  return {
    kind: "tree",
    engine,
    root,
    hasActual,
    planningMs: extra?.planningMs,
    executionMs: extra?.executionMs,
    maxSelfCost,
    maxSelfTimeMs,
    maxRows,
  };
}

/** Render any value as a props-table string (arrays/objects → compact JSON). */
export function propStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}
