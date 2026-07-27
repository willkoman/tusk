import { describe, expect, it } from "vitest";
import { layoutTree } from "./layout";
import { MAX_PLAN_DEPTH, MAX_PLAN_NODES, type PlanNode } from "./types";

const N = (id: number, ...children: PlanNode[]): PlanNode => ({
  id,
  label: `n${id}`,
  props: [],
  children,
});

const OPTS = { orientation: "vertical" as const, nodeW: 100, nodeH: 50, gapMain: 40, gapCross: 20, collapsed: new Set<number>() };

describe("layoutTree", () => {
  it("is deterministic and centers parents over children", () => {
    const tree = N(0, N(1), N(2, N(3), N(4)));
    const a = layoutTree(tree, OPTS);
    const b = layoutTree(tree, OPTS);
    expect(a.pos).toEqual(b.pos);
    const p2 = a.pos.get(2)!;
    const p3 = a.pos.get(3)!;
    const p4 = a.pos.get(4)!;
    expect(p2.x).toBeCloseTo((p3.x + p4.x) / 2, 5);
    // depth = y in vertical orientation
    expect(a.pos.get(0)!.y).toBe(0);
    expect(p3.y).toBe(2 * (50 + 40));
  });

  it("never overlaps siblings at the same depth", () => {
    // Two bushy subtrees whose parents would collide without subtree shifting.
    const tree = N(0, N(1, N(2), N(3), N(4)), N(5, N(6), N(7), N(8)));
    const l = layoutTree(tree, OPTS);
    const byDepth = new Map<number, number[]>();
    for (const n of l.visible) {
      const p = l.pos.get(n.id)!;
      const arr = byDepth.get(p.y) ?? [];
      arr.push(p.x);
      byDepth.set(p.y, arr);
    }
    for (const xs of byDepth.values()) {
      const sorted = [...xs].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(100 + 20);
      }
    }
  });

  it("collapse hides subtrees and shrinks the bbox", () => {
    const tree = N(0, N(1, N(2), N(3)), N(4));
    const full = layoutTree(tree, OPTS);
    const collapsed = layoutTree(tree, { ...OPTS, collapsed: new Set([1]) });
    expect(full.visible.length).toBe(5);
    expect(collapsed.visible.length).toBe(3);
    expect(collapsed.bbox.h).toBeLessThan(full.bbox.h);
    expect(collapsed.edges.find((e) => e.to === 2)).toBeUndefined();
  });

  it("a shifted subtree's deep leaves are visible to later siblings (no overlap)", () => {
    // A is a leaf at depth 1, so B's children-center (0.5) is left of B's
    // minimum slot (1) → B's subtree shifts right. C's leaf must then land
    // RIGHT of B's shifted leaves, not in their pre-shift slots.
    const tree = N(0, N(1), N(2, N(3), N(4)), N(5, N(6)));
    const l = layoutTree(tree, OPTS);
    const xs = [l.pos.get(3)!.x, l.pos.get(4)!.x, l.pos.get(6)!.x].sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(100 + 20);
    }
  });

  it("horizontal orientation swaps axes", () => {
    const tree = N(0, N(1), N(2));
    const l = layoutTree(tree, { ...OPTS, orientation: "horizontal" });
    expect(l.pos.get(0)!.x).toBe(0);
    expect(l.pos.get(1)!.x).toBe(100 + 40);
    expect(l.pos.get(1)!.y).not.toBe(l.pos.get(2)!.y);
  });

  it("falls back without recursion overflow for cyclic or over-deep trees", () => {
    const cyclic = N(0);
    cyclic.children.push(cyclic);
    const cycleLayout = layoutTree(cyclic, OPTS);
    expect(cycleLayout.visible).toEqual([cyclic]);
    expect(cycleLayout.edges).toEqual([]);

    let deep = N(MAX_PLAN_DEPTH + 2);
    for (let i = MAX_PLAN_DEPTH + 1; i >= 0; i--) deep = N(i, deep);
    const deepLayout = layoutTree(deep, OPTS);
    expect(deepLayout.visible).toEqual([deep]);
    expect(deepLayout.bbox).toEqual({ x: 0, y: 0, w: OPTS.nodeW, h: OPTS.nodeH });

    const wide = N(0);
    wide.children = Array.from({ length: MAX_PLAN_NODES + 1 }, (_, i) => N(i + 1));
    expect(layoutTree(wide, OPTS).visible).toEqual([wide]);
  });
});
