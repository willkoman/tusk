import { describe, expect, it } from "vitest";
import { joinConditions } from "./joinHints";
import { buildIndex, type Table } from "./aliases";
import { type FkEdge } from "./fk";

const TABLES: Table[] = [
  { schema: "public", name: "users", columns: [{ name: "id", data_type: "int" }] },
  { schema: "public", name: "orders", columns: [{ name: "id", data_type: "int" }, { name: "user_id", data_type: "int" }] },
  { schema: "public", name: "order_items", columns: [{ name: "order_id", data_type: "int" }, { name: "line", data_type: "int" }] },
];
const IDX = buildIndex(TABLES);
const EDGES: FkEdge[] = [
  { constraint: "fk_orders_user", srcSchema: "public", srcTable: "orders", srcCols: ["user_id"], dstSchema: "public", dstTable: "users", dstCols: ["id"] },
  { constraint: "fk_items_order", srcSchema: "public", srcTable: "order_items", srcCols: ["order_id", "line"], dstSchema: "public", dstTable: "orders", dstCols: ["id", "line"] },
];

describe("joinConditions", () => {
  it("suggests the FK condition for the just-joined table (aliases)", () => {
    expect(joinConditions("SELECT * FROM users u JOIN orders o ON ", IDX, EDGES)).toEqual(["o.user_id = u.id"]);
  });

  it("works in the reverse join direction", () => {
    expect(joinConditions("SELECT * FROM orders o JOIN users u ON ", IDX, EDGES)).toEqual(["u.id = o.user_id"]);
  });

  it("AND-joins multi-column FK edges", () => {
    expect(joinConditions("SELECT * FROM orders o JOIN order_items i ON ", IDX, EDGES)).toEqual([
      "i.order_id = o.id AND i.line = o.line",
    ]);
  });

  it("uses bare table names when there is no alias", () => {
    expect(joinConditions("SELECT * FROM users JOIN orders ON ", IDX, EDGES)).toEqual(["orders.user_id = users.id"]);
  });

  it("returns nothing without a second table or matching edge", () => {
    expect(joinConditions("SELECT * FROM users u ", IDX, EDGES)).toEqual([]);
    expect(joinConditions("SELECT * FROM users u JOIN unknown_t x ON ", IDX, EDGES)).toEqual([]);
  });

  it("offers conditions to every in-scope table, not just the previous one", () => {
    const out = joinConditions("SELECT * FROM users u JOIN order_items i ON i.order_id = o.id JOIN orders o ON ", IDX, EDGES);
    expect(out).toContain("o.user_id = u.id");
    expect(out).toContain("o.id = i.order_id AND o.line = i.line");
  });
});
