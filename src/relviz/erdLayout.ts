// Proximity-packed cluster layout for the whole-schema ERD.
//
// Tables are first grouped into NAMING FAMILIES (token-prefix clusters:
// "product_*", "product_content_*", "purchase_order_*" …). Each multi-member
// family is laid out internally (small layered grid), then the CLUSTER GRAPH
// (families as variable-size super-nodes, FK edges aggregated) is placed by a
// GREEDY ADJACENCY PACKER: the most-connected cluster seeds the canvas, every
// subsequent cluster lands on the nearest free spot to the weighted centroid
// of its already-placed referrers (spiral candidate search, distances
// normalized by average card dimensions so X and Y are spent proportionally),
// followed by refinement sweeps that relocate a cluster when a strictly
// shorter spot near its full neighborhood exists. Tables therefore sit as
// close to their referrers as the no-overlap constraint allows, and the
// diagram grows as a compact blob instead of a left-to-right ribbon.
//
// Connected components still shelf-pack side-by-side toward a ~3:2 aspect and
// FK-less islands still form a dense grid block at the bottom behind a gutter.
//
// Deterministic by construction — no RNG, no convergence loops; every list is
// canonically sorted before any float accumulation (summation order changes
// bits), tests assert bit-equality.

export type ErdNode = { id: string; w: number; h: number };
export type ErdEdge = { from: string; to: string };

export type ErdGroup = { label: string; x: number; y: number; w: number; h: number; members: string[] };

export type ErdLayout = {
  pos: Map<string, { x: number; y: number }>;
  bbox: { x: number; y: number; w: number; h: number };
  /** Flattened per-ring id lists (cluster BFS rings, members contiguous) — test/metric introspection. */
  layers: string[][];
  /** Labeled containers behind multi-member naming families. */
  groups: ErdGroup[];
};

export const ERD_LAYOUT_MAX_NODES = 600;
export const ERD_LAYOUT_MAX_EDGES = 4_000;
const ERD_LAYOUT_MAX_ID_CHARS = 512;
const ERD_LAYOUT_MAX_DIM = 10_000;

const LAYER_GAP = 70;
const NODE_GAP = 14;
const SUBCOL_GAP = 20;
const COMPONENT_GAP = 80;
const ISLAND_GUTTER = 160;
const ISLAND_COLS = 2;
const GROUP_PAD = 12;
const GROUP_LABEL_H = 20;
const SWEEPS = 4;
const Y_PASSES = 3;
/**
 * Adaptive sub-column height budget for FAMILY INTERNALS: scale with the
 * members' total card area so a family block shapes itself roughly square-ish
 * instead of one long strip.
 */
const colBudget = (nodes: { w: number; h: number }[]) => {
  const area = nodes.reduce((a, n) => a + n.w * n.h, 0);
  return Math.min(2400, Math.max(600, Math.sqrt(area) * 1.15));
};
/** Overall diagram aspect target for component shelf-packing (w : h ≈ 3 : 2). */
const SHELF_ASPECT = 1.5;

// ---------------- naming families ----------------

/**
 * Family per table from `_`-token prefixes: the LONGEST 1- or 2-token prefix
 * shared by ≥2 tables ("product_content_block" → "product_content" when other
 * product_content_* exist, else "product"). Leading underscores ignored.
 * Tables with no shared prefix are their own singleton family.
 */
export function assignFamilies(names: string[]): Map<string, string> {
  if (names.length > ERD_LAYOUT_MAX_NODES || names.some((n) => typeof n !== "string" || n.length > ERD_LAYOUT_MAX_ID_CHARS)) return new Map();
  const tokensOf = (n: string) => n.replace(/^_+/, "").split("_").filter(Boolean);
  const count = new Map<string, number>();
  for (const n of names) {
    const t = tokensOf(n);
    if (t.length >= 1) count.set(t[0], (count.get(t[0]) ?? 0) + 1);
    if (t.length >= 2) {
      const p2 = `${t[0]}_${t[1]}`;
      count.set(p2, (count.get(p2) ?? 0) + 1);
    }
  }
  const out = new Map<string, string>();
  for (const n of names) {
    const t = tokensOf(n);
    const p2 = t.length >= 2 ? `${t[0]}_${t[1]}` : null;
    if (p2 && (count.get(p2) ?? 0) >= 2) out.set(n, p2);
    else if (t.length >= 1 && (count.get(t[0]) ?? 0) >= 2) out.set(n, t[0]);
    else out.set(n, n);
  }
  return out;
}

// ---------------- family-internal layered engine ----------------

type CoreNode = { id: string; w: number; h: number };
type CoreResult = {
  pos: Map<string, { x: number; y: number }>;
  w: number;
  h: number;
  /** ids per rank/ring, in final order. */
  layers: string[][];
};

/** DFS back-edge removal (iterative, sorted order) — removed edges still draw. */
function breakCycles(ids: string[], edges: ErdEdge[]): ErdEdge[] {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) out.get(e.from)!.push(e.to);
  for (const v of out.values()) v.sort();
  const acyclic: ErdEdge[] = [];
  const state = new Map<string, 0 | 1 | 2>();
  for (const start of ids) {
    if (state.get(start)) continue;
    const stack: { id: string; i: number }[] = [{ id: start, i: 0 }];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const targets = out.get(top.id)!;
      if (top.i >= targets.length) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const next = targets[top.i++];
      const st = state.get(next) ?? 0;
      if (st === 1) continue;
      acyclic.push({ from: top.id, to: next });
      if (st === 0) {
        state.set(next, 1);
        stack.push({ id: next, i: 0 });
      }
    }
  }
  return acyclic;
}

/**
 * Small layered engine for FAMILY INTERNALS only: cycle-break → longest-path
 * layering → tighten (a node nothing references pulls right, adjacent to its
 * nearest target) → barycenter ordering → sub-column wrap → stacked y +
 * neighbor-median refinement. Families are small (2–20 tables), so the
 * left-to-right mini-flow stays compact inside its container.
 */
function layeredCore(nodes: CoreNode[], edgesIn: ErdEdge[], budget = 1000): CoreResult {
  const ids = nodes.map((n) => n.id).sort();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const idSet = new Set(ids);
  const pairKey = (e: ErdEdge) => JSON.stringify([e.from, e.to]);
  const edges = [...new Map(
    edgesIn.filter((e) => idSet.has(e.from) && idSet.has(e.to) && e.from !== e.to).map((e) => [pairKey(e), e]),
  ).values()].sort((a, b) => (pairKey(a) < pairKey(b) ? -1 : 1));

  const acyclic = breakCycles(ids, edges);
  const layerOf = new Map<string, number>(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const e of acyclic) {
      const want = layerOf.get(e.from)! + 1;
      if (want > layerOf.get(e.to)!) {
        layerOf.set(e.to, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Tighten: unconstrained nodes pull right next to their nearest target.
  const hasIn = new Set(acyclic.map((e) => e.to));
  const outOf = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of acyclic) outOf.get(e.from)!.push(e.to);
  for (const id of ids) {
    if (hasIn.has(id)) continue;
    const targets = outOf.get(id)!;
    if (!targets.length) continue;
    const want = Math.min(...targets.map((t) => layerOf.get(t)!)) - 1;
    if (want > layerOf.get(id)!) layerOf.set(id, want);
  }
  const used = [...new Set([...layerOf.values()])].sort((a, b) => a - b);
  const remap = new Map(used.map((l, i) => [l, i]));
  for (const [id, l] of layerOf) layerOf.set(id, remap.get(l)!);

  const nLayers = Math.max(0, ...layerOf.values()) + 1;
  const layers: string[][] = Array.from({ length: nLayers }, () => []);
  for (const id of ids) layers[layerOf.get(id)!].push(id);

  // Barycenter ordering (fixed sweeps; sorted neighbor lists keep float sums stable).
  const neighbors = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    neighbors.get(e.from)!.push(e.to);
    neighbors.get(e.to)!.push(e.from);
  }
  for (const v of neighbors.values()) v.sort();
  const indexIn = (layer: string[]) => new Map(layer.map((id, i) => [id, i]));
  for (let s = 0; s < SWEEPS; s++) {
    const down = s % 2 === 0;
    const order = down ? [...layers.keys()] : [...layers.keys()].reverse();
    for (const li of order) {
      const adjLayer = layers[li + (down ? -1 : 1)];
      if (!adjLayer) continue;
      const idx = indexIn(adjLayer);
      const score = new Map<string, number>();
      for (const id of layers[li]) {
        const ns = neighbors.get(id)!.filter((n) => idx.has(n));
        score.set(id, ns.length ? ns.reduce((a, n) => a + idx.get(n)!, 0) / ns.length : Number.MAX_SAFE_INTEGER);
      }
      layers[li] = [...layers[li]].sort((a, b) => {
        const d = score.get(a)! - score.get(b)!;
        return d !== 0 ? d : a < b ? -1 : 1;
      });
    }
  }

  // Sub-column wrap: HEIGHT-balanced (barycenter order preserved → neighbors
  // stay adjacent). Each layer's total stack height is split into roughly
  // equal columns under a budget.
  const subCols: string[][][] = layers.map((l) => {
    const totalH = l.reduce((a, id) => a + byId.get(id)!.h, 0) + Math.max(0, l.length - 1) * NODE_GAP;
    const tallest = Math.max(0, ...l.map((id) => byId.get(id)!.h));
    const nCols = Math.max(1, Math.ceil(totalH / budget));
    const target = Math.max(tallest, totalH / nCols);
    const out2: string[][] = [[]];
    let curH = 0;
    for (const id of l) {
      const h = byId.get(id)!.h;
      if (out2[out2.length - 1].length && curH + NODE_GAP + h > target + 1) {
        out2.push([]);
        curH = 0;
      }
      out2[out2.length - 1].push(id);
      curH += (out2[out2.length - 1].length > 1 ? NODE_GAP : 0) + h;
    }
    return out2;
  });

  // X: each sub-column is exactly as wide as ITS widest member.
  const subX = new Map<string, number>();
  let x = 0;
  for (let i = 0; i < layers.length; i++) {
    let colX = x;
    for (const col of subCols[i]) {
      const colW = Math.max(0, ...col.map((id) => byId.get(id)!.w));
      for (const id of col) subX.set(id, colX);
      colX += colW + SUBCOL_GAP;
    }
    const blockW = Math.max(0, colX - SUBCOL_GAP - x);
    x += blockW + LAYER_GAP;
  }

  const y = new Map<string, number>();
  for (const cols of subCols) {
    for (const col of cols) {
      let cur = 0;
      for (const id of col) {
        y.set(id, cur);
        cur += byId.get(id)!.h + NODE_GAP;
      }
    }
  }
  for (let p = 0; p < Y_PASSES; p++) {
    for (const cols of subCols) {
      for (const col of cols) {
        const desired = col.map((id) => {
          const ns = neighbors.get(id)!.filter((n) => y.has(n));
          if (!ns.length) return y.get(id)!;
          const mean = ns.reduce((a, n) => a + y.get(n)! + byId.get(n)!.h / 2, 0) / ns.length;
          return mean - byId.get(id)!.h / 2;
        });
        let prevBottom = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < col.length; i++) {
          const fy = prevBottom === Number.NEGATIVE_INFINITY ? desired[i] : Math.max(desired[i], prevBottom + NODE_GAP);
          y.set(col[i], fy);
          prevBottom = fy + byId.get(col[i])!.h;
        }
      }
    }
  }

  if (!ids.length) return { pos: new Map(), w: 0, h: 0, layers: [] };
  const minY = Math.min(...ids.map((id) => y.get(id)!));
  const pos = new Map<string, { x: number; y: number }>();
  let w = 0;
  let h = 0;
  for (const id of ids) {
    const p = { x: subX.get(id)!, y: y.get(id)! - minY };
    pos.set(id, p);
    w = Math.max(w, p.x + byId.get(id)!.w);
    h = Math.max(h, p.y + byId.get(id)!.h);
  }
  return { pos, w, h, layers };
}

// ---------------- proximity packer (top-level cluster placement) ----------------

const PACK_RING_STEP = 0.25; // candidate ring spacing, in normalized card units
const PACK_RING_OVERSHOOT = 1.5; // keep scanning this far past the first free ring
const PACK_CENTROID_PULL = 0.18; // gentle pull toward the blob center (curls chains, rounds the blob)
const PACK_REFINE_PASSES = 2;
const PACK_RMAX = 240; // normalized-unit search ceiling (absurdly large fallback)
const PACK_MAX_WORK = 2_000_000;

type Rect = { x: number; y: number; w: number; h: number };

/** Two rects must keep `gap` clear air between them (0.5px slack for float noise). */
const rectsClash = (a: Rect, b: Rect, gap: number) =>
  a.x < b.x + b.w + gap - 0.5 && b.x < a.x + a.w + gap - 0.5 && a.y < b.y + b.h + gap - 0.5 && b.y < a.y + a.h + gap - 0.5;

/** Coarse spatial hash so candidate-overlap checks stay flat on big schemas. */
class Occupancy {
  private cell = 384;
  private map = new Map<string, Rect[]>();
  private keysOf(r: Rect, pad: number): string[] {
    const x0 = Math.floor((r.x - pad) / this.cell);
    const x1 = Math.floor((r.x + r.w + pad) / this.cell);
    const y0 = Math.floor((r.y - pad) / this.cell);
    const y1 = Math.floor((r.y + r.h + pad) / this.cell);
    const keys: string[] = [];
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) keys.push(`${cx},${cy}`);
    return keys;
  }
  insert(r: Rect) {
    for (const k of this.keysOf(r, 0)) (this.map.get(k) ?? this.map.set(k, []).get(k)!).push(r);
  }
  remove(r: Rect) {
    for (const k of this.keysOf(r, 0)) {
      const list = this.map.get(k);
      if (list) this.map.set(k, list.filter((x) => x !== r));
    }
  }
  collides(r: Rect, gap: number): boolean {
    for (const k of this.keysOf(r, gap)) {
      const list = this.map.get(k);
      if (!list) continue;
      for (const other of list) if (rectsClash(r, other, gap)) return true;
    }
    return false;
  }
}

/**
 * Greedy adjacency packer: seed = most-connected node; each next node (picked
 * by strongest connection to the already-placed set) lands on the nearest
 * free spot to the weighted centroid of its placed neighbors. Distances are
 * normalized by average card dimensions, so the blob spends X and Y in
 * proportion to what a card costs on each axis. A small centroid pull keeps
 * chains curling into the blob instead of ribboning off. Refinement sweeps
 * then relocate any node that has a strictly cheaper free spot near its FULL
 * neighborhood. Zero overlap and determinism hold by construction.
 */
function proximityPack(nodes: CoreNode[], edgesIn: ErdEdge[]): CoreResult {
  const ids = nodes.map((n) => n.id).sort();
  if (!ids.length) return { pos: new Map(), w: 0, h: 0, layers: [] };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const idSet = new Set(ids);

  // Undirected pair weights (A→B and B→A collapse into weight 2).
  const wKey = (a: string, b: string) => (a < b ? `${a}\x1f${b}` : `${b}\x1f${a}`);
  const weight = new Map<string, number>();
  for (const e of edgesIn) {
    if (!idSet.has(e.from) || !idSet.has(e.to) || e.from === e.to) continue;
    const k = wKey(e.from, e.to);
    weight.set(k, (weight.get(k) ?? 0) + 1);
  }
  const neighbors = new Map<string, { id: string; w: number }[]>(ids.map((id) => [id, []]));
  for (const [k, w] of [...weight.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const [a, b] = k.split("\x1f");
    neighbors.get(a)!.push({ id: b, w });
    neighbors.get(b)!.push({ id: a, w });
  }
  const degree = new Map(ids.map((id) => [id, neighbors.get(id)!.reduce((a, n) => a + n.w, 0)]));

  // Normalization: one "unit" ≈ one card + gap on that axis.
  const ax = ids.reduce((a, id) => a + byId.get(id)!.w, 0) / ids.length + NODE_GAP;
  const ay = ids.reduce((a, id) => a + byId.get(id)!.h, 0) / ids.length + NODE_GAP;
  const ndist = (x1: number, y1: number, x2: number, y2: number) => Math.hypot((x1 - x2) / ax, (y1 - y2) / ay);

  const rects = new Map<string, Rect>(); // top-left space
  const centerOf = (id: string) => {
    const r = rects.get(id)!;
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  };
  const occ = new Occupancy();
  let work = 0;

  type Spot = { rect: Rect; cost: number };
  const findSpot = (
    w: number,
    h: number,
    target: { x: number; y: number },
    nbs: { id: string; w: number }[],
    centroid: { x: number; y: number },
  ): Spot | null => {
    let best: Spot | null = null;
    let foundR = Number.POSITIVE_INFINITY;
    for (let r = 0; r <= PACK_RMAX; r += PACK_RING_STEP) {
      if (r > foundR + PACK_RING_OVERSHOOT) break;
      // m is forced to a multiple of 4 so the cardinal directions are always
      // sampled — adjacent-card spots sit exactly on them; a diagonal-only
      // ring clashes on both axes and would force horizontal ribboning.
      const m = r === 0 ? 1 : Math.ceil(Math.max(8, Math.ceil((2 * Math.PI * r) / PACK_RING_STEP)) / 4) * 4;
      for (let k = 0; k < m; k++) {
        if (++work > PACK_MAX_WORK) return best;
        const th = (2 * Math.PI * k) / m;
        const cx = target.x + Math.cos(th) * r * ax;
        const cy = target.y + Math.sin(th) * r * ay;
        const rect = { x: cx - w / 2, y: cy - h / 2, w, h };
        if (occ.collides(rect, NODE_GAP)) continue;
        if (foundR === Number.POSITIVE_INFINITY) foundR = r;
        let cost = PACK_CENTROID_PULL * ndist(cx, cy, centroid.x, centroid.y);
        for (const nb of nbs) {
          if (++work > PACK_MAX_WORK) return best;
          const c = centerOf(nb.id);
          cost += nb.w * ndist(cx, cy, c.x, c.y);
        }
        if (!best || cost < best.cost - 1e-9) best = { rect, cost };
      }
    }
    return best;
  };

  // Placement order: strongest link to the placed set, then degree, then id.
  const placed = new Set<string>();
  const placedW = new Map(ids.map((id) => [id, 0]));
  const order: string[] = [];
  let sumX = 0;
  let sumY = 0;
  for (let step = 0; step < ids.length; step++) {
    let pick: string | null = null;
    for (const id of ids) {
      if (placed.has(id)) continue;
      if (
        pick === null ||
        placedW.get(id)! > placedW.get(pick)! ||
        (placedW.get(id) === placedW.get(pick) &&
          (degree.get(id)! > degree.get(pick)! || (degree.get(id) === degree.get(pick) && id < pick)))
      )
        pick = id;
    }
    const id = pick!;
    const n = byId.get(id)!;
    const nbs = neighbors.get(id)!.filter((nb) => placed.has(nb.id));
    const centroid = placed.size ? { x: sumX / placed.size, y: sumY / placed.size } : { x: 0, y: 0 };
    let target = centroid;
    if (nbs.length) {
      let tw = 0;
      let tx = 0;
      let ty = 0;
      for (const nb of nbs) {
        const c = centerOf(nb.id);
        tx += c.x * nb.w;
        ty += c.y * nb.w;
        tw += nb.w;
      }
      target = { x: tx / tw, y: ty / tw };
    }
    const found = placed.size ? findSpot(n.w, n.h, target, nbs, centroid) : null;
    // Work-budget/search-ceiling fallback: append to the right of all placed
    // rects. This preserves a usable, overlap-free diagram without more search.
    const fallbackX = Math.max(0, ...[...rects.values()].map((r) => r.x + r.w)) + NODE_GAP;
    const spot = placed.size
      ? found ?? { rect: { x: fallbackX, y: centroid.y - n.h / 2, w: n.w, h: n.h }, cost: Number.POSITIVE_INFINITY }
      : { rect: { x: -n.w / 2, y: -n.h / 2, w: n.w, h: n.h }, cost: 0 };
    rects.set(id, spot.rect);
    occ.insert(spot.rect);
    placed.add(id);
    order.push(id);
    sumX += spot.rect.x + n.w / 2;
    sumY += spot.rect.y + n.h / 2;
    for (const nb of neighbors.get(id)!) placedW.set(nb.id, placedW.get(nb.id)! + nb.w);
  }

  // Refinement: relocate when a strictly cheaper free spot exists near the
  // FULL neighborhood (placement only saw earlier nodes). Centroid snapshots
  // per pass keep float order canonical.
  for (let pass = 0; pass < PACK_REFINE_PASSES; pass++) {
    let cSumX = 0;
    let cSumY = 0;
    for (const id of ids) {
      const c = centerOf(id);
      cSumX += c.x;
      cSumY += c.y;
    }
    const centroid = { x: cSumX / ids.length, y: cSumY / ids.length };
    for (const id of order) {
      const nbs = neighbors.get(id)!;
      if (!nbs.length) continue;
      const cur = rects.get(id)!;
      let tw = 0;
      let tx = 0;
      let ty = 0;
      for (const nb of nbs) {
        const c = centerOf(nb.id);
        tx += c.x * nb.w;
        ty += c.y * nb.w;
        tw += nb.w;
      }
      const target = { x: tx / tw, y: ty / tw };
      const cc = { x: cur.x + cur.w / 2, y: cur.y + cur.h / 2 };
      let curCost = PACK_CENTROID_PULL * ndist(cc.x, cc.y, centroid.x, centroid.y);
      for (const nb of nbs) {
        const c = centerOf(nb.id);
        curCost += nb.w * ndist(cc.x, cc.y, c.x, c.y);
      }
      occ.remove(cur);
      const spot = findSpot(cur.w, cur.h, target, nbs, centroid);
      if (spot && spot.cost < curCost - 1e-6) {
        rects.set(id, spot.rect);
        occ.insert(spot.rect);
      } else {
        occ.insert(cur);
      }
    }
  }

  // BFS rings from the seed (sorted neighbor order) — the `layers` introspection.
  const ring = new Map<string, number>([[order[0], 0]]);
  const queue = [order[0]];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nb of neighbors.get(cur)!) {
      if (!ring.has(nb.id)) {
        ring.set(nb.id, ring.get(cur)! + 1);
        queue.push(nb.id);
      }
    }
  }
  const nRings = Math.max(0, ...ring.values()) + 1;
  const layers: string[][] = Array.from({ length: nRings }, () => []);
  for (const id of ids) layers[ring.get(id) ?? 0].push(id);

  const minX = Math.min(...ids.map((id) => rects.get(id)!.x));
  const minY = Math.min(...ids.map((id) => rects.get(id)!.y));
  const pos = new Map<string, { x: number; y: number }>();
  let w = 0;
  let h = 0;
  for (const id of ids) {
    const r = rects.get(id)!;
    const p = { x: r.x - minX, y: r.y - minY };
    pos.set(id, p);
    w = Math.max(w, p.x + r.w);
    h = Math.max(h, p.y + r.h);
  }
  return { pos, w, h, layers };
}

// ---------------- components ----------------

type Comp = { ids: string[]; edges: ErdEdge[] };

function components(ids: string[], edges: ErdEdge[]): Comp[] {
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    adj.get(e.from)!.push(e.to);
    adj.get(e.to)!.push(e.from);
  }
  const seen = new Set<string>();
  const comps: Comp[] = [];
  for (const start of ids) {
    if (seen.has(start)) continue;
    const member = new Set<string>([start]);
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const n = queue.shift()!;
      for (const m of adj.get(n)!) {
        if (!seen.has(m)) {
          seen.add(m);
          member.add(m);
          queue.push(m);
        }
      }
    }
    const cids = [...member].sort();
    comps.push({ ids: cids, edges: edges.filter((e) => member.has(e.from) && member.has(e.to)) });
  }
  comps.sort((a, b) => b.ids.length - a.ids.length || (a.ids[0] < b.ids[0] ? -1 : 1));
  return comps;
}

// ---------------- top-level ----------------

export function layoutErd(nodes: ErdNode[], edges: ErdEdge[]): ErdLayout {
  const empty = (): ErdLayout => ({ pos: new Map(), bbox: { x: 0, y: 0, w: 0, h: 0 }, layers: [], groups: [] });
  if (nodes.length > ERD_LAYOUT_MAX_NODES || edges.length > ERD_LAYOUT_MAX_EDGES) return empty();
  const rawIds = new Set<string>();
  for (const n of nodes) {
    if (
      !n || typeof n.id !== "string" || n.id.length > ERD_LAYOUT_MAX_ID_CHARS || rawIds.has(n.id) ||
      !Number.isFinite(n.w) || !Number.isFinite(n.h) || n.w <= 0 || n.h <= 0 || n.w > ERD_LAYOUT_MAX_DIM || n.h > ERD_LAYOUT_MAX_DIM
    ) return empty();
    rawIds.add(n.id);
  }
  for (const e of edges) {
    if (!e || typeof e.from !== "string" || typeof e.to !== "string" || e.from.length > ERD_LAYOUT_MAX_ID_CHARS || e.to.length > ERD_LAYOUT_MAX_ID_CHARS) return empty();
  }
  const ids = nodes.map((n) => n.id).sort();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const idSet = new Set(ids);
  const clean = edges.filter((e) => idSet.has(e.from) && idSet.has(e.to) && e.from !== e.to);
  const pairKey = (e: ErdEdge) => JSON.stringify([e.from, e.to]);
  const uniq = [...new Map(clean.map((e) => [pairKey(e), e])).values()].sort((a, b) =>
    pairKey(a) < pairKey(b) ? -1 : 1,
  );

  // Families are GLOBAL (consistent counts), clusters are per-component.
  // Tables with NO relationships at all stay in the island block even when
  // their naming family lives in the web — a family group only contains
  // tables that participate in the relationship story.
  const family = assignFamilies(ids);
  const comps = components(ids, uniq);
  const webs = comps.filter((c) => c.ids.length > 1);
  const islands = comps.filter((c) => c.ids.length === 1).map((c) => c.ids[0]);

  const pos = new Map<string, { x: number; y: number }>();
  const allLayers: string[][] = [];
  const groups: ErdGroup[] = [];

  // Each web component is packed first (cluster-first, below), producing a
  // sized block; blocks are then SHELF-PACKED in two dimensions toward a
  // ~3:2 overall aspect — a matrix of clusters, not one endless ribbon.
  type Block = {
    w: number;
    h: number;
    emit: (ox: number, oy: number) => void; // writes absolute positions
  };
  const blocks: Block[] = [];

  for (const comp of webs) {
    // 1) Family clusters inside this component (global family map; singleton
    //    families = the table itself).
    const clusters = new Map<string, string[]>();
    for (const id of comp.ids) {
      const f = family.get(id)!;
      (clusters.get(f) ?? clusters.set(f, []).get(f)!).push(id);
    }

    // 2) Lay out each multi-member family internally (intra-family edges only).
    const inner = new Map<string, CoreResult>();
    const clusterNodes: CoreNode[] = [];
    for (const [f, members] of [...clusters].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (members.length === 1) {
        const n = byId.get(members[0])!;
        clusterNodes.push({ id: f, w: n.w, h: n.h });
        continue;
      }
      const memberSet = new Set(members);
      const intra = comp.edges.filter((e) => memberSet.has(e.from) && memberSet.has(e.to));
      const memberNodes = members.map((m) => byId.get(m)!);
      const r = layeredCore(memberNodes, intra, colBudget(memberNodes));
      inner.set(f, r);
      clusterNodes.push({ id: f, w: r.w + GROUP_PAD * 2, h: r.h + GROUP_PAD * 2 + GROUP_LABEL_H });
    }

    // 3) Cluster graph: aggregated FK edges between families, placed by the
    //    proximity packer (each family block lands next to its referrers).
    const clusterEdges: ErdEdge[] = comp.edges
      .map((e) => ({ from: family.get(e.from)!, to: family.get(e.to)! }))
      .filter((e) => e.from !== e.to);
    const top = proximityPack(clusterNodes, clusterEdges);

    // Flattened ring lists: each cluster ring, members contiguous per cluster.
    for (const rank of top.layers) {
      allLayers.push(rank.flatMap((f) => {
        const members = clusters.get(f)!;
        return members.length === 1 ? members : inner.get(f)!.layers.flat();
      }));
    }

    // 4) Defer absolute placement to the shelf-packer.
    blocks.push({
      w: top.w,
      h: top.h,
      emit: (ox, oy) => {
        for (const [f, members] of clusters) {
          const cp = top.pos.get(f)!;
          if (members.length === 1) {
            pos.set(members[0], { x: ox + cp.x, y: oy + cp.y });
          } else {
            const r = inner.get(f)!;
            const gx = ox + cp.x;
            groups.push({ label: f, x: gx, y: oy + cp.y, w: r.w + GROUP_PAD * 2, h: r.h + GROUP_PAD * 2 + GROUP_LABEL_H, members: [...members] });
            for (const m of members) {
              const mp = r.pos.get(m)!;
              pos.set(m, { x: gx + GROUP_PAD + mp.x, y: oy + cp.y + GROUP_LABEL_H + GROUP_PAD + mp.y });
            }
          }
        }
      },
    });
  }

  // Shelf-pack the component blocks toward a ~3:2 overall aspect: rows of
  // blocks, wrapping once the row passes the width target. Big components
  // first (deterministic comp order) — small clusters fill in beside them.
  const packArea = blocks.reduce((a, b) => a + (b.w + COMPONENT_GAP) * (b.h + COMPONENT_GAP), 0);
  const targetW = Math.max(Math.max(0, ...blocks.map((b) => b.w)), Math.sqrt(packArea * SHELF_ASPECT));
  let shelfX = 0;
  let shelfY = 0;
  let shelfH = 0;
  let maxW = 0;
  let maxH = 0;
  for (const b of blocks) {
    if (shelfX > 0 && shelfX + b.w > targetW) {
      shelfY += shelfH + COMPONENT_GAP;
      shelfX = 0;
      shelfH = 0;
    }
    b.emit(shelfX, shelfY);
    shelfX += b.w + COMPONENT_GAP;
    shelfH = Math.max(shelfH, b.h);
    maxW = Math.max(maxW, shelfX - COMPONENT_GAP);
    maxH = Math.max(maxH, shelfY + b.h);
  }

  // True islands (no FKs, no family in the web): dense grid block at the
  // bottom, clearly separated by the gutter, width-bounded by the diagram.
  if (islands.length) {
    const islandY = maxH + (maxH > 0 ? ISLAND_GUTTER : 0);
    const colW = Math.max(0, ...islands.map((id) => byId.get(id)!.w)) + 30;
    const cols = Math.max(ISLAND_COLS, Math.floor(Math.max(targetW, colW) / colW));
    let col = 0;
    let rowH = 0;
    let rowY = islandY;
    for (const id of islands) {
      const n = byId.get(id)!;
      pos.set(id, { x: col * colW, y: rowY });
      maxW = Math.max(maxW, col * colW + n.w);
      rowH = Math.max(rowH, n.h);
      col++;
      if (col >= cols) {
        col = 0;
        rowY += rowH + NODE_GAP;
        rowH = 0;
      }
    }
    maxH = Math.max(maxH, rowY + rowH);
    allLayers.push(islands);
  }

  return { pos, bbox: { x: 0, y: 0, w: maxW, h: maxH }, layers: allLayers, groups };
}

// ---------------- test metrics ----------------

/** Mean FK edge length in px (table centers) — the proximity objective. */
export function meanEdgeLength(layout: ErdLayout, nodes: ErdNode[], edges: ErdEdge[]): number {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let total = 0;
  let n = 0;
  for (const e of edges) {
    const a = layout.pos.get(e.from);
    const b = layout.pos.get(e.to);
    const an = byId.get(e.from);
    const bn = byId.get(e.to);
    if (!a || !b || !an || !bn) continue;
    total += Math.hypot(a.x + an.w / 2 - (b.x + bn.w / 2), a.y + an.h / 2 - (b.y + bn.h / 2));
    n++;
  }
  return n ? total / n : 0;
}
