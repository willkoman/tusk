import { describe, expect, it } from "vitest";
import { relevantTables, formatSamples, buildSystemPrompt, type AiCtxTable, type SampleTable, type AiContext } from "./context";

const tables: AiCtxTable[] = [
  { schema: "public", name: "orders", columns: [{ name: "id", data_type: "int" }, { name: "customer_id", data_type: "int" }] },
  { schema: "public", name: "customers", columns: [{ name: "id", data_type: "int" }, { name: "email", data_type: "text" }] },
  { schema: "public", name: "unrelated_widgets", columns: [{ name: "id", data_type: "int" }] },
];

describe("relevantTables", () => {
  it("returns tables named in the focus, most-relevant first", () => {
    // "orders" appears verbatim (score 0); "customers" shares the word `customers`
    // with the focus (score 1) — exact-word match, mirroring the schema-summary ranking.
    const r = relevantTables(tables, "join orders to customers", 5);
    expect(r.map((t) => t.name)).toEqual(["orders", "customers"]);
  });

  it("excludes unrelated tables and caps the count", () => {
    const r = relevantTables(tables, "orders please", 5);
    expect(r.map((t) => t.name)).toEqual(["orders"]);
    expect(relevantTables(tables, "orders customers widgets", 1).length).toBe(1);
  });

  it("returns nothing for an unrelated focus", () => {
    expect(relevantTables(tables, "hello there", 5)).toEqual([]);
  });
});

describe("formatSamples", () => {
  const samples: SampleTable[] = [
    { schema: "public", name: "orders", columns: ["id", "note"], rows: [["1", "hi"], ["2", null]] },
  ];

  it("renders a pipe-separated block with NULLs spelled out", () => {
    const out = formatSamples(samples);
    expect(out).toContain("public.orders (2 sample rows):");
    expect(out).toContain("id | note");
    expect(out).toContain("1 | hi");
    expect(out).toContain("2 | NULL");
  });

  it("truncates very long cells", () => {
    const out = formatSamples([{ schema: "s", name: "t", columns: ["c"], rows: [["x".repeat(200)]] }]);
    expect(out).toContain("…");
    expect(out.split("\n").some((l) => l.length > 120)).toBe(false);
  });

  it("skips empty samples", () => {
    expect(formatSamples([{ schema: "s", name: "t", columns: [], rows: [] }])).toBe("");
  });
});

describe("buildSystemPrompt with samples", () => {
  const ctx: AiContext = {
    dialect: "postgres",
    driverLabel: "PostgreSQL",
    version: "16",
    user: "me",
    isSuperuser: false,
    permissionsEnforced: false,
    activeSchema: null,
    tables,
    currentSql: "",
    selection: "",
    lastError: "",
  };

  it("includes the sample section when samples are provided", () => {
    const p = buildSystemPrompt(ctx, "orders", [
      { schema: "public", name: "orders", columns: ["id"], rows: [["1"]] },
    ]);
    expect(p).toContain("Sample rows from the most relevant tables");
    expect(p).toContain("public.orders");
  });

  it("omits the sample section when there are no samples", () => {
    const p = buildSystemPrompt(ctx, "orders", []);
    expect(p).not.toContain("Sample rows from the most relevant tables");
  });
});
