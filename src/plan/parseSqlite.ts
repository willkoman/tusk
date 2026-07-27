import { MAX_PLAN_DEPTH, MAX_PLAN_NODES, boundPlanText, type ParsedPlan, type PlanNode, finishTree } from "./types";

// SQLite `EXPLAIN QUERY PLAN` → PlanTree via the id/parent columns.
// Requires the exact EQP column signature; plain `EXPLAIN` (bytecode listing:
// addr/opcode/…) is NOT a tree — the caller keeps the grid for that.

export function parseSqlite(columns: string[], rows: (string | null)[][]): ParsedPlan | null {
  if (columns.length > 64) return null;
  const cols = columns.map((c) => c.toLowerCase());
  const idI = cols.indexOf("id");
  const parentI = cols.indexOf("parent");
  const detailI = cols.indexOf("detail");
  if (idI === -1 || parentI === -1 || detailI === -1 || !rows.length || rows.length > MAX_PLAN_NODES) return null;

  const root: PlanNode = { id: 0, label: "QUERY PLAN", props: [], children: [] };
  const byId = new Map<number, PlanNode>();
  const depthById = new Map<number, number>();

  for (const r of rows) {
    const id = parseInt(r[idI] ?? "", 10);
    const parent = parseInt(r[parentI] ?? "", 10);
    const detail = boundPlanText(r[detailI] ?? "");
    if (!Number.isFinite(id) || byId.has(id) || parent === id) return null;
    const m = /\b(?:SCAN|SEARCH)\s+(?:TABLE\s+)?([A-Za-z_][\w]*)/.exec(detail);
    const node: PlanNode = { id: 0, label: detail, object: m?.[1] ? boundPlanText(m[1]) : undefined, props: [], children: [] };
    // Resolve the parent BEFORE registering this node: a hostile row with
    // parent === id would otherwise attach the node to itself, and the self-cycle
    // spins finishTree's tree walk forever (uncatchable main-thread hang).
    const p = Number.isFinite(parent) ? byId.get(parent) : undefined;
    const depth = p ? (depthById.get(parent) ?? 0) + 1 : 0;
    if (depth > MAX_PLAN_DEPTH) return null;
    byId.set(id, node);
    depthById.set(id, depth);
    (p ?? root).children.push(node);
  }
  // Single top node → drop the synthetic wrapper.
  const top = root.children.length === 1 ? root.children[0] : root;
  return finishTree("sqlite", top, { hasActual: false });
}
