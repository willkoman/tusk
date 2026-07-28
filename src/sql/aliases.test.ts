import { describe, expect, it } from "vitest";
import { aliasMap, buildIndex, currentStatement, tableByRef, type Table } from "./aliases";

const tables: Table[] = [
  { schema: "public", name: "Users", columns: [] },
  { schema: "odd.schema", name: "order.items", columns: [] },
];

describe("SQL reference identity", () => {
  it("resolves MySQL backticks and doubled delimiters", () => {
    const idx = buildIndex(tables);
    expect(tableByRef(idx, "`public`.`Users`")).toBe(tables[0]);
    expect(tableByRef(idx, '"odd.schema"."order.items"')).toBe(tables[1]);
    expect(aliasMap("SELECT * FROM `public`.`Users` AS `U`").get("u")).toBe("`public`.`Users`");
  });

  it("does not choose arbitrarily between case-colliding tables", () => {
    const idx = buildIndex([...tables, { schema: "public", name: "users", columns: [] }]);
    expect(tableByRef(idx, "public.users")).toBeUndefined();
    expect(tableByRef(idx, '"public"."Users"')).toBe(tables[0]);
  });

  it("does not capture trailing query clauses as aliases", () => {
    expect(aliasMap("SELECT * FROM users FOR UPDATE").has("for")).toBe(false);
    expect(aliasMap("SELECT * FROM users FETCH FIRST 1 ROW ONLY").has("fetch")).toBe(false);
  });
});

describe("currentStatement", () => {
  it("uses shared lexer boundaries, not semicolons inside values", () => {
    const doc = "SELECT 'a;b', $$c;d$$;\nSELECT user";
    expect(currentStatement(doc, doc.length)).toEqual({ text: "\nSELECT user", start: 22 });
    expect(currentStatement(doc, 10)).toEqual({ text: "SELECT 'a;b', $$c;d$$", start: 0 });
  });

  it("ignores semicolons inside comments and starts after a real terminator", () => {
    const doc = "SELECT 1 /* ; */; -- ;\nSEL";
    expect(currentStatement(doc, doc.length)).toEqual({ text: " -- ;\nSEL", start: 17 });
    expect(currentStatement("SELECT 1;   ", 12)).toEqual({ text: "   ", start: 9 });
  });
});

describe("tableByRef active-schema preference", () => {
  const dup: Table[] = [
    { schema: "public", name: "orders", columns: [{ name: "id", data_type: "int" }] },
    { schema: "sales", name: "orders", columns: [{ name: "total", data_type: "int" }] },
    { schema: "audit", name: "events", columns: [] },
  ];
  const idx = buildIndex(dup);

  it("resolves bare ambiguity via active schema, then public — like search_path", () => {
    expect(tableByRef(idx, "orders", "sales")?.schema).toBe("sales");
    expect(tableByRef(idx, "orders", null)?.schema).toBe("public");
    expect(tableByRef(idx, "orders", "audit")?.schema).toBe("public");
    expect(tableByRef(idx, "events")?.schema).toBe("audit"); // unique bare needs no preference
  });

  it("qualified refs stay exact regardless of active schema", () => {
    expect(tableByRef(idx, "sales.orders", "public")?.schema).toBe("sales");
    expect(tableByRef(idx, "public.orders", "sales")?.schema).toBe("public");
  });
});
