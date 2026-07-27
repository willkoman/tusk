import { MAX_PLAN_DEPTH, MAX_PLAN_NODES, type PlanNode } from "./types";

// Tidy-tree layout for fixed-size node cards: post-order pass slots leaves
// left-to-right and centers parents over their children; when a parent's
// center would collide with its level's next free slot, its whole subtree is
// shifted right EAGERLY (updating every touched depth's next-slot tracker —
// a deferred-mod scheme leaves deep descendants invisible to later siblings
// and overlaps them). O(n·depth) worst case; plan trees are small.

export type LayoutOpts = {
  orientation: "vertical" | "horizontal"; // vertical = root on top
  nodeW: number;
  nodeH: number;
  gapMain: number; // between depth levels
  gapCross: number; // between siblings
  collapsed: ReadonlySet<number>;
};

export type Layout = {
  pos: Map<number, { x: number; y: number }>;
  /** Parent→child pairs among VISIBLE nodes. */
  edges: { from: number; to: number }[];
  visible: PlanNode[];
  bbox: { x: number; y: number; w: number; h: number };
};

type Tmp = { node: PlanNode; depth: number; cross: number; children: Tmp[] };

export function layoutTree(root: PlanNode, opts: LayoutOpts): Layout {
  const stepCross = opts.orientation === "vertical" ? opts.nodeW + opts.gapCross : opts.nodeH + opts.gapCross;
  const stepMain = opts.orientation === "vertical" ? opts.nodeH + opts.gapMain : opts.nodeW + opts.gapMain;

  const rootOnly = (): Layout => ({
    pos: new Map([[root.id, { x: 0, y: 0 }]]),
    edges: [],
    visible: [root],
    bbox: { x: 0, y: 0, w: opts.nodeW, h: opts.nodeH },
  });

  // Build iteratively and reject cycles/shared nodes/deep spoofed trees. Engine
  // parsers enforce the same limits; this guard protects direct runtime callers.
  const t: Tmp = { node: root, depth: 0, cross: 0, children: [] };
  const seenNodes = new Set<PlanNode>();
  const seenIds = new Set<number>();
  const buildStack = [{ node: root, tmp: t, depth: 0 }];
  while (buildStack.length) {
    const { node, tmp, depth } = buildStack.pop()!;
    if (
      !node || typeof node !== "object" || !Array.isArray(node.children) ||
      seenNodes.has(node) || seenIds.has(node.id) || seenNodes.size >= MAX_PLAN_NODES || depth > MAX_PLAN_DEPTH ||
      node.children.length > MAX_PLAN_NODES - seenNodes.size - buildStack.length - 1
    ) return rootOnly();
    seenNodes.add(node);
    seenIds.add(node.id);
    if (opts.collapsed.has(node.id)) continue;
    tmp.children = node.children.map((child) => ({ node: child, depth: depth + 1, cross: 0, children: [] }));
    for (let i = tmp.children.length - 1; i >= 0; i--) {
      buildStack.push({ node: node.children[i], tmp: tmp.children[i], depth: depth + 1 });
    }
  }

  // Post-order: place each subtree. `next[depth]` = next free slot (cross units).
  const next: number[] = [];
  const claim = (depth: number, cross: number) => {
    next[depth] = Math.max(next[depth] ?? 0, cross + 1);
  };
  const shift = (tn: Tmp, delta: number) => {
    const stack = [tn];
    while (stack.length) {
      const cur = stack.pop()!;
      cur.cross += delta;
      claim(cur.depth, cur.cross);
      for (let i = cur.children.length - 1; i >= 0; i--) stack.push(cur.children[i]);
    }
  };
  const place = (tn: Tmp) => {
    const min = next[tn.depth] ?? 0;
    if (tn.children.length === 0) {
      tn.cross = min;
    } else {
      const want = (tn.children[0].cross + tn.children[tn.children.length - 1].cross) / 2;
      if (want < min) {
        // Shift the children's subtrees right so the parent sits at `min` and
        // stays centered — eagerly, so deeper slots are claimed for later siblings.
        const delta = min - want;
        tn.children.forEach((c) => shift(c, delta));
        tn.cross = min;
      } else {
        tn.cross = want;
      }
    }
    claim(tn.depth, tn.cross);
  };
  const placeStack: { node: Tmp; done: boolean }[] = [{ node: t, done: false }];
  while (placeStack.length) {
    const { node, done } = placeStack.pop()!;
    if (done) {
      place(node);
      continue;
    }
    placeStack.push({ node, done: true });
    for (let i = node.children.length - 1; i >= 0; i--) placeStack.push({ node: node.children[i], done: false });
  }

  // Pre-order emit.
  const pos = new Map<number, { x: number; y: number }>();
  const edges: { from: number; to: number }[] = [];
  const visible: PlanNode[] = [];
  let maxCross = 0;
  let maxDepth = 0;
  const emit = (tn: Tmp) => {
    const cross = tn.cross * stepCross;
    const main = tn.depth * stepMain;
    pos.set(tn.node.id, opts.orientation === "vertical" ? { x: cross, y: main } : { x: main, y: cross });
    visible.push(tn.node);
    maxCross = Math.max(maxCross, cross);
    maxDepth = Math.max(maxDepth, main);
  };
  const emitStack: { node: Tmp; parent?: number }[] = [{ node: t }];
  while (emitStack.length) {
    const { node, parent } = emitStack.pop()!;
    if (parent !== undefined) edges.push({ from: parent, to: node.node.id });
    emit(node);
    for (let i = node.children.length - 1; i >= 0; i--) emitStack.push({ node: node.children[i], parent: node.node.id });
  }

  const w = opts.orientation === "vertical" ? maxCross + opts.nodeW : maxDepth + opts.nodeW;
  const h = opts.orientation === "vertical" ? maxDepth + opts.nodeH : maxCross + opts.nodeH;
  return { pos, edges, visible, bbox: { x: 0, y: 0, w, h } };
}

/** Card-anchor bézier between two laid-out nodes. */
export function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: { orientation: "vertical" | "horizontal"; nodeW: number; nodeH: number },
): string {
  if (opts.orientation === "vertical") {
    const x1 = from.x + opts.nodeW / 2;
    const y1 = from.y + opts.nodeH;
    const x2 = to.x + opts.nodeW / 2;
    const y2 = to.y;
    const my = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
  }
  const x1 = from.x + opts.nodeW;
  const y1 = from.y + opts.nodeH / 2;
  const x2 = to.x;
  const y2 = to.y + opts.nodeH / 2;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}
