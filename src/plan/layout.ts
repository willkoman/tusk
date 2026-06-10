import { type PlanNode } from "./types";

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

  const build = (n: PlanNode, depth: number): Tmp => ({
    node: n,
    depth,
    cross: 0,
    children: opts.collapsed.has(n.id) ? [] : n.children.map((c) => build(c, depth + 1)),
  });
  const t = build(root, 0);

  // Post-order: place each subtree. `next[depth]` = next free slot (cross units).
  const next: number[] = [];
  const claim = (depth: number, cross: number) => {
    next[depth] = Math.max(next[depth] ?? 0, cross + 1);
  };
  const shift = (tn: Tmp, delta: number) => {
    tn.cross += delta;
    claim(tn.depth, tn.cross);
    tn.children.forEach((c) => shift(c, delta));
  };
  const place = (tn: Tmp) => {
    tn.children.forEach(place);
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
  place(t);

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
    for (const c of tn.children) {
      edges.push({ from: tn.node.id, to: c.node.id });
      emit(c);
    }
  };
  emit(t);

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
