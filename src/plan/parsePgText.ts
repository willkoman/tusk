import {
  MAX_PLAN_DEPTH,
  MAX_PLAN_LABEL_CHARS,
  MAX_PLAN_NODES,
  MAX_PLAN_PROPS,
  boundPlanText,
  type ParsedPlan,
  type PlanNode,
  finishTree,
} from "./types";

// Best-effort parser for hand-typed text `EXPLAIN` output (one line per row).
// Strict: any line that doesn't fit the known shapes bails to null and the
// caller falls back to the styled-text view — never a half-right tree.
//
//   Hash Join  (cost=1.05..2.15 rows=10 width=8) (actual time=0.01..0.02 rows=10 loops=1)
//     Hash Cond: (a.id = b.id)
//     ->  Seq Scan on a  (cost=0.00..1.05 rows=10 width=8)
//     ->  Hash  (cost=1.04..1.04 rows=10 width=4)

const COST_RE = /\(cost=(\d+\.\d+)\.\.(\d+\.\d+) rows=(\d+) width=\d+\)/;
const ACTUAL_TIME_RE = /\(actual time=(\d+\.\d+)\.\.(\d+\.\d+) rows=(\d+(?:\.\d+)?) loops=(\d+)\)/;
const ACTUAL_ROWS_RE = /\(actual rows=(\d+(?:\.\d+)?) loops=(\d+)\)/;
const NEVER_RE = /\(never executed\)/;

type Parsed = { node: PlanNode; indent: number };

function parseNodeText(text: string): PlanNode | null {
  const costM = COST_RE.exec(text);
  if (!costM) return null;
  const head = boundPlanText(text.slice(0, costM.index).trim(), MAX_PLAN_LABEL_CHARS);
  if (!head) return null;
  const node: PlanNode = { id: 0, label: head, props: [], children: [] };
  // "Seq Scan on films f" / "Index Scan using idx on films" → object after " on ".
  const onM = /^(.*?)\s+(?:using\s+(\S+)\s+)?on\s+(\S+)(?:\s+\S+)?$/.exec(head);
  if (onM) {
    node.label = onM[1] + (onM[2] ? ` using ${onM[2]}` : "");
    node.object = onM[3];
  }
  node.totalCost = parseFloat(costM[2]);
  node.planRows = parseInt(costM[3], 10);
  const at = ACTUAL_TIME_RE.exec(text);
  const ar = ACTUAL_ROWS_RE.exec(text);
  if (at) {
    node.totalTimeMs = parseFloat(at[2]);
    node.actualRows = parseFloat(at[3]);
    node.loops = parseInt(at[4], 10);
  } else if (ar) {
    node.actualRows = parseFloat(ar[1]);
    node.loops = parseInt(ar[2], 10);
  } else if (NEVER_RE.test(text)) {
    node.actualRows = 0;
    node.loops = 0;
    node.props.push(["Executed", "never"]);
  }
  return node;
}

/** Fill selfCost/selfTimeMs bottom-up (same math as the JSON parser). */
function computeSelf(root: PlanNode) {
  const stack: { node: PlanNode; done: boolean }[] = [{ node: root, done: false }];
  while (stack.length) {
    const { node: n, done } = stack.pop()!;
    if (!done) {
      stack.push({ node: n, done: true });
      for (let i = n.children.length - 1; i >= 0; i--) stack.push({ node: n.children[i], done: false });
      continue;
    }
    if (n.totalCost !== undefined) {
      let s = n.totalCost;
      for (const c of n.children) if (c.totalCost !== undefined) s -= c.totalCost;
      n.selfCost = Math.max(0, s);
    }
    if (n.totalTimeMs !== undefined) {
      let s = n.totalTimeMs * (n.loops ?? 1);
      for (const c of n.children) if (c.totalTimeMs !== undefined) s -= c.totalTimeMs * (c.loops ?? 1);
      n.selfTimeMs = Math.max(0, s);
    }
  }
}

export function parsePgText(lines: string[]): ParsedPlan | null {
  if (!lines.length || lines.length > MAX_PLAN_NODES * (MAX_PLAN_PROPS + 1)) return null;
  let planningMs: number | undefined;
  let executionMs: number | undefined;

  const root = parseNodeText(lines[0]);
  if (!root || /^\s/.test(lines[0])) return null;
  const stack: Parsed[] = [{ node: root, indent: -1 }];
  let last: PlanNode = root;
  let nodes = 1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const t = /^\s*Planning Time:\s*([\d.]+) ms/.exec(line);
    if (t) { planningMs = parseFloat(t[1]); continue; }
    const e = /^\s*Execution Time:\s*([\d.]+) ms/.exec(line);
    if (e) { executionMs = parseFloat(e[1]); continue; }

    const arrow = /^(\s*)->\s+(.*)$/.exec(line);
    if (arrow) {
      const indent = arrow[1].length;
      const node = parseNodeText(arrow[2]);
      if (!node) return null; // an arrow line we can't parse → don't guess
      if (++nodes > MAX_PLAN_NODES) return null;
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
      stack[stack.length - 1].node.children.push(node);
      stack.push({ node, indent });
      // Same depth ceiling as the JSON parsers: a crafted result with ever-increasing
      // indents would otherwise build a tree deep enough to overflow the stack in the
      // recursive layout/render walks. Fall back to the styled-text view.
      if (stack.length > MAX_PLAN_DEPTH) return null;
      last = node;
      continue;
    }
    if (/^\s/.test(line)) {
      // Detail line ("Filter: …", "Sort Key: …", "Buckets: …") → prop on the
      // nearest node above.
      const kv = /^\s*([A-Za-z][A-Za-z0-9 _-]*):\s*(.*)$/.exec(line);
      if (last.props.length < MAX_PLAN_PROPS) {
        if (kv) last.props.push([boundPlanText(kv[1]), boundPlanText(kv[2], 4_096)]);
        else last.props.push(["", boundPlanText(line.trim(), 4_096)]);
      }
      continue;
    }
    // A second top-level node (multi-statement EXPLAIN) or anything else
    // unindented → too ambiguous for a tree.
    return null;
  }
  computeSelf(root);
  return finishTree("postgres", root, { planningMs, executionMs });
}
