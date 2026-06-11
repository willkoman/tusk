import { describe, expect, it } from "vitest";
import { assignFamilies, layoutErd, meanEdgeLength, type ErdEdge, type ErdNode } from "./erdLayout";

const node = (id: string, h = 80): ErdNode => ({ id, w: 200, h });
const E = (from: string, to: string): ErdEdge => ({ from, to });

/** Every pair of placed cards keeps clear air between them. */
function expectNoOverlaps(nodes: ErdNode[], l: ReturnType<typeof layoutErd>) {
  const rects = nodes
    .filter((n) => l.pos.has(n.id))
    .map((n) => ({ id: n.id, ...l.pos.get(n.id)!, w: n.w, h: n.h }));
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const apart = a.x + a.w <= b.x + 0.01 || b.x + b.w <= a.x + 0.01 || a.y + a.h <= b.y + 0.01 || b.y + b.h <= a.y + 0.01;
      expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
    }
  }
}

const center = (l: ReturnType<typeof layoutErd>, nodes: ErdNode[], id: string) => {
  const n = nodes.find((x) => x.id === id)!;
  const p = l.pos.get(id)!;
  return { x: p.x + n.w / 2, y: p.y + n.h / 2 };
};
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe("layoutErd", () => {
  it("is deterministic — identical output across runs and input orderings", () => {
    const nodes = [node("c"), node("a"), node("b"), node("d")];
    const edges = [E("a", "b"), E("c", "b"), E("d", "c")];
    const l1 = layoutErd(nodes, edges);
    const l2 = layoutErd([...nodes].reverse(), [...edges].reverse());
    expect(l1.pos).toEqual(l2.pos);
    expect(l1.layers).toEqual(l2.layers);
  });

  it("survives cycles without hanging and still places every node", () => {
    const l = layoutErd([node("a"), node("b"), node("x")], [E("a", "b"), E("b", "a"), E("x", "a")]);
    expect(l.pos.size).toBe(3);
    expect(l.pos.get("a")).not.toEqual(l.pos.get("b"));
  });

  it("never overlaps cards (uneven heights, dense star)", () => {
    const leaves = Array.from({ length: 14 }, (_, i) => node(`t${String(i).padStart(2, "0")}`, 50 + (i % 5) * 40));
    const nodes = [node("hub", 120), ...leaves];
    const l = layoutErd(nodes, leaves.map((n) => E(n.id, "hub")));
    expectNoOverlaps(nodes, l);
  });

  // --- proximity: the core objective ---

  it("star-schema leaves hug their hub (every leaf within ~2 card-units)", () => {
    const leaves = Array.from({ length: 12 }, (_, i) => `t${String(i).padStart(2, "0")}`);
    const nodes = [node("hub"), ...leaves.map((l) => node(l))];
    const edges = leaves.map((l) => E(l, "hub"));
    const l = layoutErd(nodes, edges);
    const hub = center(l, nodes, "hub");
    for (const leaf of leaves) {
      expect(dist(center(l, nodes, leaf), hub), `${leaf} drifted from hub`).toBeLessThan(620);
    }
    expect(meanEdgeLength(l, nodes, edges)).toBeLessThan(420);
  });

  it("two-hub chain — every spoke sits closer to its own hub than to the other", () => {
    const nodes = [node("hubA"), node("hubB"), node("u1"), node("u2"), node("u3"), node("v1"), node("v2"), node("v3")];
    const edges = [E("u1", "hubA"), E("u2", "hubA"), E("u3", "hubA"), E("hubA", "hubB"), E("v1", "hubB"), E("v2", "hubB"), E("v3", "hubB")];
    const l = layoutErd(nodes, edges);
    const a = center(l, nodes, "hubA");
    const b = center(l, nodes, "hubB");
    for (const u of ["u1", "u2", "u3"]) expect(dist(center(l, nodes, u), a)).toBeLessThan(dist(center(l, nodes, u), b));
    for (const v of ["v1", "v2", "v3"]) expect(dist(center(l, nodes, v), b)).toBeLessThan(dist(center(l, nodes, v), a));
  });

  it("a chain coils into a compact blob instead of a ribbon", () => {
    const chain = Array.from({ length: 8 }, (_, i) => `c${i}`);
    const nodes = chain.map((c) => node(c, 90));
    const l = layoutErd(nodes, chain.slice(1).map((c, i) => E(c, `c${i}`)));
    const ratio = l.bbox.w / l.bbox.h;
    expect(ratio).toBeLessThan(6);
    expect(ratio).toBeGreaterThan(1 / 6);
    expectNoOverlaps(nodes, l);
  });

  // --- component separation ---

  it("disconnected webs pack as a matrix without overlapping", () => {
    const nodes = [node("a"), node("b"), node("c"), node("d")];
    const l = layoutErd(nodes, [E("a", "b"), E("c", "d")]);
    const box = (ids: string[]) => {
      const xs = ids.map((i) => l.pos.get(i)!.x);
      const ys = ids.map((i) => l.pos.get(i)!.y);
      return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs) + 200, y2: Math.max(...ys) + 80 };
    };
    const A = box(["a", "b"]);
    const B = box(["c", "d"]);
    const disjoint = A.x2 <= B.x1 || B.x2 <= A.x1 || A.y2 <= B.y1 || B.y2 <= A.y1;
    expect(disjoint).toBe(true);
  });

  it("FK-less islands form a dense grid block BELOW the webs, behind a gutter", () => {
    const nodes = [node("a"), node("b"), node("i1", 50), node("i2", 50), node("i3", 50), node("i4", 50), node("i5", 50), node("i6", 50)];
    const l = layoutErd(nodes, [E("a", "b")]);
    const webBottom = Math.max(l.pos.get("a")!.y + 80, l.pos.get("b")!.y + 80);
    const islandTop = Math.min(...["i1", "i2", "i3", "i4", "i5", "i6"].map((i) => l.pos.get(i)!.y));
    expect(islandTop - webBottom).toBeGreaterThanOrEqual(140); // clear gutter
    // grid: first row shares y across ≥2 columns, later islands wrap down
    expect(l.pos.get("i1")!.y).toBe(l.pos.get("i2")!.y);
    expect(l.pos.get("i1")!.x).toBeLessThan(l.pos.get("i2")!.x);
    expect(Math.max(...["i5", "i6"].map((i) => l.pos.get(i)!.y))).toBeGreaterThan(l.pos.get("i1")!.y);
  });

  // --- naming families ---

  it("family detection: two-token prefixes split from one-token families", () => {
    const fams = assignFamilies(["product", "product_a", "product_content_x", "product_content_y", "purchase_order_a", "purchase_order_b", "lonely_table"]);
    expect(fams.get("product")).toBe("product");
    expect(fams.get("product_a")).toBe("product");
    expect(fams.get("product_content_x")).toBe("product_content");
    expect(fams.get("product_content_y")).toBe("product_content");
    expect(fams.get("purchase_order_a")).toBe("purchase_order");
    expect(fams.get("lonely_table")).toBe("lonely_table");
  });

  it("group containers hold connected members; FK-less family members stay islands", () => {
    const nodes = [node("hub"), node("amazon_a"), node("amazon_b"), node("amazon_c")];
    const edges = [E("amazon_a", "hub"), E("amazon_b", "hub")]; // amazon_c has NO relationships
    const l = layoutErd(nodes, edges);
    const g = l.groups.find((x) => x.label === "amazon")!;
    expect(g).toBeTruthy();
    expect(g.members.sort()).toEqual(["amazon_a", "amazon_b"]);
    for (const m of g.members) {
      const p = l.pos.get(m)!;
      expect(p.x).toBeGreaterThanOrEqual(g.x);
      expect(p.y).toBeGreaterThanOrEqual(g.y);
      expect(p.x + 200).toBeLessThanOrEqual(g.x + g.w + 0.001);
      expect(p.y + 80).toBeLessThanOrEqual(g.y + g.h + 0.001);
    }
    // amazon_c lives with the disconnected tables, below the web
    const webBottom = Math.max(...["hub", "amazon_a", "amazon_b"].map((id) => l.pos.get(id)!.y + 80));
    expect(l.pos.get("amazon_c")!.y).toBeGreaterThanOrEqual(webBottom + 140);
  });

  it("naming families stay contiguous within a ring", () => {
    const nodes = [node("p1"), node("p2"), node("amazon_a"), node("zebra_x"), node("amazon_b"), node("zebra_y"), node("amazon_c")];
    const edges = [E("amazon_a", "p1"), E("zebra_x", "p1"), E("amazon_b", "p2"), E("zebra_y", "p2"), E("amazon_c", "p1")];
    const l = layoutErd(nodes, edges);
    const layer = l.layers.find((ly) => ly.includes("amazon_a"))!;
    const span = (prefix: string) => {
      const idxs = layer.map((id, i) => ({ id, i })).filter((x) => x.id.startsWith(prefix)).map((x) => x.i);
      return Math.max(...idxs) - Math.min(...idxs) + 1 === idxs.length;
    };
    expect(span("amazon")).toBe(true);
    expect(span("zebra")).toBe(true);
  });

  it("mixed sizes: a big family block and small singletons pack without overlap, smalls still adjacent", () => {
    const nodes = [node("hub"), { id: "bigblock", w: 600, h: 900 }, node("sa", 60), node("sb", 60)];
    const edges = [E("bigblock", "hub"), E("sa", "hub"), E("sb", "hub")];
    const l = layoutErd(nodes, edges);
    expectNoOverlaps(nodes, l);
    const hub = center(l, nodes, "hub");
    expect(dist(center(l, nodes, "sa"), hub)).toBeLessThan(900);
    expect(dist(center(l, nodes, "sb"), hub)).toBeLessThan(900);
  });

  // --- the headline fix: compactness on a realistic schema ---

  it("realistic 40-table hub schema: short edges, balanced aspect, deterministic", () => {
    // Django-ish: auth_user + content_type hubs, 30 leaf tables referencing
    // one or both, a session/log cluster, and 5 FK-less islands.
    const leaves = Array.from({ length: 30 }, (_, i) => `app_t${String(i).padStart(2, "0")}`);
    const nodes = [
      node("auth_user"), node("content_type"),
      ...leaves.map((l) => node(l)),
      node("log_a"), node("log_b"),
      ...["s1", "s2", "s3", "s4", "s5"].map((s) => node(s, 50)),
    ];
    const edges: ErdEdge[] = [
      ...leaves.map((l, i) => E(l, i % 2 ? "auth_user" : "content_type")),
      ...leaves.filter((_, i) => i % 3 === 0).map((l) => E(l, "auth_user")),
      E("auth_user", "content_type"),
      E("log_a", "log_b"),
    ];
    const l = layoutErd(nodes, edges);
    expectNoOverlaps(nodes, l);
    // islands below everything, behind the gutter
    const webIds = ["auth_user", ...leaves, "log_a", "log_b"];
    const webBottom = Math.max(...webIds.map((id) => l.pos.get(id)!.y + 80));
    const islandTop = Math.min(...["s1", "s2", "s3", "s4", "s5"].map((id) => l.pos.get(id)!.y));
    expect(islandTop).toBeGreaterThanOrEqual(webBottom + 140);
    // matrix aspect: neither a ribbon nor a tower
    const ratio = l.bbox.w / l.bbox.h;
    expect(ratio).toBeGreaterThan(0.25);
    expect(ratio).toBeLessThan(4);
    // determinism on the big case too
    const l2 = layoutErd([...nodes].reverse(), [...edges].reverse());
    expect(l2.pos).toEqual(l.pos);
  });

  it("12-table shop schema (no families): proximity beats the old ribbon layout", () => {
    const names = ["users", "orders", "order_items", "products", "categories", "reviews", "addresses", "payments", "shipments", "coupons", "carts", "cart_items"];
    const nodes = names.map((x) => node(x, 100));
    const edges = [
      E("orders", "users"), E("order_items", "orders"), E("order_items", "products"),
      E("products", "categories"), E("reviews", "users"), E("reviews", "products"),
      E("addresses", "users"), E("payments", "orders"), E("shipments", "orders"),
      E("orders", "coupons"), E("carts", "users"), E("cart_items", "carts"), E("cart_items", "products"),
    ];
    const l = layoutErd(nodes, edges);
    expectNoOverlaps(nodes, l);
    expect(meanEdgeLength(l, nodes, edges)).toBeLessThan(350); // old engine: ~354, layered ribbon
    const ratio = l.bbox.w / l.bbox.h;
    expect(ratio).toBeLessThan(3.5);
    expect(ratio).toBeGreaterThan(0.3);
  });
});
