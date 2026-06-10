import { describe, expect, it } from "vitest";
import { assignFamilies, countCrossings, layoutErd, meanEdgeSpan, type ErdEdge, type ErdNode } from "./erdLayout";

const node = (id: string, h = 80): ErdNode => ({ id, w: 200, h });
const E = (from: string, to: string): ErdEdge => ({ from, to });

describe("layoutErd", () => {
  it("is deterministic — identical output across runs and input orderings", () => {
    const nodes = [node("c"), node("a"), node("b"), node("d")];
    const edges = [E("a", "b"), E("c", "b"), E("d", "c")];
    const l1 = layoutErd(nodes, edges);
    const l2 = layoutErd([...nodes].reverse(), [...edges].reverse());
    expect(l1.pos).toEqual(l2.pos);
    expect(l1.layers).toEqual(l2.layers);
  });

  it("layers follow FK direction (parents right of children)", () => {
    const l = layoutErd([node("c"), node("o"), node("i")], [E("o", "c"), E("i", "o")]);
    expect(l.pos.get("i")!.x).toBeLessThan(l.pos.get("o")!.x);
    expect(l.pos.get("o")!.x).toBeLessThan(l.pos.get("c")!.x);
  });

  it("survives cycles without hanging and still places every node", () => {
    const l = layoutErd([node("a"), node("b"), node("x")], [E("a", "b"), E("b", "a"), E("x", "a")]);
    expect(l.pos.size).toBe(3);
    expect(l.pos.get("a")).not.toEqual(l.pos.get("b"));
  });

  it("no overlaps within a layer (real card heights respected)", () => {
    const nodes = [node("p"), node("a", 60), node("b", 120), node("c", 90)];
    const l = layoutErd(nodes, [E("a", "p"), E("b", "p"), E("c", "p")]);
    const lefts = ["a", "b", "c"].map((id) => ({ id, y: l.pos.get(id)!.y }));
    lefts.sort((x, y) => x.y - y.y);
    const h: Record<string, number> = { a: 60, b: 120, c: 90 };
    for (let i = 1; i < lefts.length; i++) {
      expect(lefts[i].y).toBeGreaterThanOrEqual(lefts[i - 1].y + h[lefts[i - 1].id]);
    }
  });

  it("barycenter reduces crossings (single component)", () => {
    // a1 → z1+z2, a2 → z1: orderable to zero crossings.
    const nodes = [node("a1"), node("a2"), node("z1"), node("z2")];
    const edges = [E("a1", "z2"), E("a2", "z1"), E("a1", "z1")];
    const l = layoutErd(nodes, edges);
    expect(countCrossings(l, edges)).toBe(0);
  });

  // --- hub-schema readability (the "everything wired from the left" fix) ---

  it("tighten: star-schema leaves sit ADJACENT to their hub (span 1)", () => {
    const leaves = Array.from({ length: 12 }, (_, i) => `t${String(i).padStart(2, "0")}`);
    const nodes = [node("hub"), ...leaves.map((l) => node(l))];
    const edges = leaves.map((l) => E(l, "hub"));
    const l = layoutErd(nodes, edges);
    expect(meanEdgeSpan(l, edges)).toBe(1);
  });

  it("tighten: two-hub chain — each spoke group hugs its own hub", () => {
    // u* → hubA → hubB ← v*. Longest-path alone leaves v* at layer 0 while
    // hubB sits at layer 2 (span 2 for every v-edge). Tighten pulls v* right.
    const nodes = [node("hubA"), node("hubB"), node("u1"), node("u2"), node("u3"), node("v1"), node("v2"), node("v3")];
    const edges = [E("u1", "hubA"), E("u2", "hubA"), E("u3", "hubA"), E("hubA", "hubB"), E("v1", "hubB"), E("v2", "hubB"), E("v3", "hubB")];
    const l = layoutErd(nodes, edges);
    expect(meanEdgeSpan(l, edges)).toBe(1);
  });

  it("y-refinement: a child sits vertically near its parent, not at the layer top", () => {
    // Two parents far apart in the right layer; each child should drift toward
    // its own parent's vertical band.
    const nodes = [node("p1", 60), node("p2", 60), node("f1", 600), node("c1", 60), node("c2", 60)];
    // f1 is a tall spacer card between the parents (forces vertical distance);
    // connect it so everything is one component.
    const edges = [E("c1", "p1"), E("c2", "p2"), E("f1", "p1"), E("f1", "p2")];
    const l = layoutErd(nodes, edges);
    const center = (id: string, h: number) => l.pos.get(id)!.y + h / 2;
    const d11 = Math.abs(center("c1", 60) - center("p1", 60));
    const d12 = Math.abs(center("c1", 60) - center("p2", 60));
    const d22 = Math.abs(center("c2", 60) - center("p2", 60));
    const d21 = Math.abs(center("c2", 60) - center("p1", 60));
    expect(d11).toBeLessThan(d12);
    expect(d22).toBeLessThan(d21);
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

  it("naming families stay contiguous within a layer", () => {
    // Two parents pull the families apart by barycenter; the family block must
    // hold together anyway (grouped barycenter), interleaving forbidden.
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

  it("over-tall layers wrap into height-balanced sub-columns", () => {
    const leaves = Array.from({ length: 18 }, (_, i) => `t${String(i).padStart(2, "0")}`);
    const l = layoutErd([node("hub"), ...leaves.map((x) => node(x))], leaves.map((x) => E(x, "hub")));
    const xs = new Set(leaves.map((x) => l.pos.get(x)!.x));
    expect(xs.size).toBeGreaterThan(1); // wrapped into multiple sub-columns
    // columns are height-balanced: no column more than ~one card taller than another
    const byX = new Map<number, number>();
    for (const x of leaves) {
      const p = l.pos.get(x)!;
      byX.set(p.x, Math.max(byX.get(p.x) ?? 0, p.y + 80));
    }
    const colHeights = [...byX.values()];
    expect(Math.max(...colHeights) - Math.min(...colHeights)).toBeLessThanOrEqual(80 + 14 + 1);
  });

  it("mixed-size ranks: a small node's column is not inflated to a big block's width", () => {
    // bigblock (600 wide) and two small nodes share a rank below the hub; the
    // smalls must sit in a narrow column adjacent to the block, not 600px away.
    const nodes = [node("hub"), { id: "bigblock", w: 600, h: 900 }, node("sa", 60), node("sb", 60)];
    const edges = [E("bigblock", "hub"), E("sa", "hub"), E("sb", "hub")];
    const l = layoutErd(nodes, edges);
    const xs = [l.pos.get("bigblock")!.x, l.pos.get("sa")!.x, l.pos.get("sb")!.x].sort((a, b) => a - b);
    // the second column starts right after the first column's OWN width
    const gap = xs[xs.length - 1] - xs[0];
    expect(gap).toBeLessThanOrEqual(600 + 20 + 1); // big col + SUBCOL_GAP, no layer-wide slot
  });

  it("realistic 40-table hub schema: short edges, no mega-column of unrelated tables", () => {
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
    expect(meanEdgeSpan(l, edges)).toBeLessThanOrEqual(1.5);
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
});
