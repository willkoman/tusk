// Cluster-first layered layout for the whole-schema ERD.
//
// Tables are first grouped into NAMING FAMILIES (token-prefix clusters:
// "product_*", "product_content_*", "purchase_order_*" …). Each multi-member
// family is laid out internally, then the CLUSTER GRAPH (families as
// variable-size super-nodes, FK edges aggregated) is laid out with the same
// layered engine — so families form visible blocks and placement between
// blocks still follows the FK structure. Multi-member families also get a
// labeled background container (`groups` in the result).
//
// Geometry is horizontal-focused: connected components pack side-by-side,
// over-tall layers wrap into sub-columns, FK-less islands form a block on the
// FAR LEFT behind a wide gutter.
//
// Deterministic by construction — every list is canonically sorted before any
// float accumulation (summation order changes bits), tests assert bit-equality.

export type ErdNode = { id: string; w: number; h: number };
export type ErdEdge = { from: string; to: string };

export type ErdGroup = { label: string; x: number; y: number; w: number; h: number; members: string[] };

export type ErdLayout = {
  pos: Map<string, { x: number; y: number }>;
  bbox: { x: number; y: number; w: number; h: number };
  /** Flattened per-rank id lists (cluster ranks, members contiguous) — test/metric introspection. */
  layers: string[][];
  /** Labeled containers behind multi-member naming families. */
  groups: ErdGroup[];
};

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
 * Adaptive sub-column height budget: scale with the content's total card area
 * so every layout (a 6-table family or a 90-cluster component) shapes itself
 * roughly square-ish instead of one long strip — grid/matrix use of both axes.
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

// ---------------- shared layered engine ----------------

type CoreNode = { id: string; w: number; h: number };
type CoreResult = {
  pos: Map<string, { x: number; y: number }>;
  w: number;
  h: number;
  /** ids per rank, in final order. */
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
 * The layered engine: cycle-break → longest-path layering → tighten (a node
 * nothing references pulls right, adjacent to its nearest target) → barycenter
 * ordering → sub-column wrap → stacked y + neighbor-median refinement.
 * Used twice: members inside a family, and family super-nodes in a component.
 */
function layeredCore(nodes: CoreNode[], edgesIn: ErdEdge[], budget = 1000): CoreResult {
  const ids = nodes.map((n) => n.id).sort();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const idSet = new Set(ids);
  const pairKey = (e: ErdEdge) => `${e.from}${e.to}`;
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
  // equal columns under a budget — a rank with one tall family block and many
  // small singletons becomes a compact rectangle, not a ragged strip.
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

  // X: each sub-column is exactly as wide as ITS widest member — a giant
  // family block never inflates the slots of neighboring singleton columns.
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
  const ids = nodes.map((n) => n.id).sort();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const idSet = new Set(ids);
  const clean = edges.filter((e) => idSet.has(e.from) && idSet.has(e.to) && e.from !== e.to);
  const pairKey = (e: ErdEdge) => `${e.from}${e.to}`;
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

  // Each web component is laid out first (cluster-first, below), producing a
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

    // 3) Cluster graph: aggregated FK edges between families.
    const clusterEdges: ErdEdge[] = comp.edges
      .map((e) => ({ from: family.get(e.from)!, to: family.get(e.to)! }))
      .filter((e) => e.from !== e.to);
    const top = layeredCore(clusterNodes, clusterEdges, colBudget(clusterNodes));

    // Flattened rank lists: each cluster rank, members contiguous per cluster.
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

export function countCrossings(layout: ErdLayout, edges: ErdEdge[]): number {
  const layerIdx = new Map<string, { layer: number; idx: number }>();
  layout.layers.forEach((l, li) => l.forEach((id, i) => layerIdx.set(id, { layer: li, idx: i })));
  let crossings = 0;
  const between: { a: number; b: number }[][] = [];
  for (const e of edges) {
    const f = layerIdx.get(e.from);
    const t = layerIdx.get(e.to);
    if (!f || !t || Math.abs(f.layer - t.layer) !== 1) continue;
    const li = Math.min(f.layer, t.layer);
    const a = f.layer === li ? f.idx : t.idx;
    const b = f.layer === li ? t.idx : f.idx;
    (between[li] ??= []).push({ a, b });
  }
  for (const list of between) {
    if (!list) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const e1 = list[i];
        const e2 = list[j];
        if ((e1.a - e2.a) * (e1.b - e2.b) < 0) crossings++;
      }
    }
  }
  return crossings;
}

export function meanEdgeSpan(layout: ErdLayout, edges: ErdEdge[]): number {
  const layerOf = new Map<string, number>();
  layout.layers.forEach((l, li) => l.forEach((id) => layerOf.set(id, li)));
  let total = 0;
  let n = 0;
  for (const e of edges) {
    const f = layerOf.get(e.from);
    const t = layerOf.get(e.to);
    if (f === undefined || t === undefined) continue;
    total += Math.abs(t - f);
    n++;
  }
  return n ? total / n : 0;
}
