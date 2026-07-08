import { describe, expect, it } from "vitest";
import { relevantTables, formatSamples, buildSystemPrompt, foreignKeySummary, type AiCtxTable, type SampleTable, type AiContext } from "./context";
import type { FkEdge } from "../sql/fk";
import type { Skill } from "./skills";

const fk = (srcTable: string, srcCols: string[], dstTable: string, dstCols: string[], schema = "public"): FkEdge => ({
  constraint: `${srcTable}_fk`, srcSchema: schema, srcTable, srcCols, dstSchema: schema, dstTable, dstCols,
});

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
    fks: [],
    fksKnown: false,
    database: "testdb",
    skills: [],
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


describe("foreign keys in the prompt", () => {
  const base: AiContext = {
    dialect: "postgres", driverLabel: "PostgreSQL", version: "16", user: "me",
    isSuperuser: false, permissionsEnforced: false, activeSchema: null,
    tables, currentSql: "", selection: "", lastError: "", fks: [], fksKnown: false,
    database: "testdb", skills: [],
  };

  it("renders single and composite edges readably", () => {
    const out = foreignKeySummary([fk("orders", ["customer_id"], "customers", ["id"])], "");
    expect(out.trim()).toBe("orders.customer_id -> customers.id");
    const comp = foreignKeySummary([fk("a", ["x", "y"], "b", ["p", "q"])], "");
    expect(comp.trim()).toBe("a.(x, y) -> b.(p, q)");
  });

  it("qualifies non-public schemas only", () => {
    const e = { ...fk("orders", ["cid"], "customers", ["id"]), srcSchema: "sales", dstSchema: "public" };
    expect(foreignKeySummary([e], "").trim()).toBe("sales.orders.cid -> customers.id");
  });

  it("ranks edges touching the focus tables first, so the join path survives the budget", () => {
    const many = Array.from({ length: 400 }, (_, i) => fk(`t${i}`, ["a"], `u${i}`, ["id"]));
    const wanted = fk("orders", ["customer_id"], "customers", ["id"]);
    const out = foreignKeySummary([...many, wanted], "how do I join orders to customers");
    expect(out.split("\n")[0]).toBe("orders.customer_id -> customers.id");
    expect(out).toContain("more foreign keys"); // the rest were dropped, and said so
  });

  it("puts the FK graph in the prompt and tells the model it is authoritative", () => {
    const out = buildSystemPrompt({ ...base, fks: [fk("orders", ["customer_id"], "customers", ["id"])], fksKnown: true });
    expect(out).toContain("orders.customer_id -> customers.id");
    expect(out).toMatch(/JOIN on these rather than guessing/);
  });

  // The trap: an empty `fks` means EITHER "none declared" OR "we never fetched them".
  // Claiming the former when it's the latter invites confidently wrong joins.
  it("only asserts a schema has no foreign keys when the graph was actually fetched", () => {
    const unfetched = buildSystemPrompt({ ...base, fks: [], fksKnown: false });
    expect(unfetched).not.toMatch(/no foreign keys/i);

    const fetched = buildSystemPrompt({ ...base, fks: [], fksKnown: true });
    expect(fetched).toMatch(/declares no foreign keys/i);
  });
});

// The provider message list is built in AiPanel's runTurn, but the invariant it must
// uphold is testable here in isolation: NO assistant turn may be sent with empty content.
// Anthropic and Gemini reject that with a 400, which breaks every later question in the
// chat — not just the one that failed. A Stop-before-first-delta or an empty reply leaves
// exactly such a message in the display list.
describe("provider message list", () => {
  type M = { role: "user" | "assistant"; content: string };
  /** Mirrors the filter in AiPanel.runTurn. */
  const toProviderMessages = (convo: M[]) =>
    convo.filter((m) => m.role === "user" || m.content.trim()).map((m) => ({ role: m.role, content: m.content }));

  it("drops a content-less assistant turn left behind by Stop or an empty reply", () => {
    const convo: M[] = [
      { role: "user", content: "count orders" },
      { role: "assistant", content: "" }, // stopped before the first delta
      { role: "user", content: "actually, count customers" },
    ];
    const out = toProviderMessages(convo);
    expect(out).toEqual([
      { role: "user", content: "count orders" },
      { role: "user", content: "actually, count customers" },
    ]);
    expect(out.every((m) => m.content.trim())).toBe(true);
  });

  it("keeps a PARTIAL assistant reply — it is real context, unlike an empty one", () => {
    const convo: M[] = [
      { role: "user", content: "explain" },
      { role: "assistant", content: "The query scans" }, // died mid-stream
      { role: "user", content: "go on" },
    ];
    expect(toProviderMessages(convo).length).toBe(3);
  });

  it("never drops a user turn, even a whitespace-only one", () => {
    const convo: M[] = [{ role: "user", content: "  " }];
    expect(toProviderMessages(convo)).toEqual([{ role: "user", content: "  " }]);
  });
});


describe("skills in the system prompt", () => {
  const base: AiContext = {
    dialect: "postgres", driverLabel: "PostgreSQL", version: "16", user: "me",
    isSuperuser: false, permissionsEnforced: false, activeSchema: null,
    tables, currentSql: "", selection: "", lastError: "", fks: [], fksKnown: false,
    database: "pagila", skills: [],
  };
  const skill = (p: Partial<Skill> & { name: string }): Skill => ({
    id: p.name, description: "", scope: "workspace", database: "", enabled: true, body: "b", ...p,
  });

  it("puts skills BEFORE the schema — house rules are read before the data", () => {
    const out = buildSystemPrompt({ ...base, skills: [skill({ name: "Revenue", body: "exclude refunds" })] });
    expect(out).toContain("# Skills");
    expect(out).toContain("exclude refunds");
    expect(out.indexOf("# Skills")).toBeLessThan(out.indexOf("Database schema"));
  });

  it("scopes database skills to the connected database", () => {
    const skills = [
      skill({ name: "Here", scope: "database", database: "pagila", body: "applies" }),
      skill({ name: "Elsewhere", scope: "database", database: "other", body: "must not appear" }),
    ];
    const out = buildSystemPrompt({ ...base, skills });
    expect(out).toContain("applies");
    expect(out).not.toContain("must not appear");
  });

  it("emits no Skills section at all when nothing is in scope", () => {
    expect(buildSystemPrompt(base)).not.toContain("# Skills");
    const off = [skill({ name: "Off", enabled: false, body: "x" })];
    expect(buildSystemPrompt({ ...base, skills: off })).not.toContain("# Skills");
  });

  it("tells the model the safety rules outrank a skill", () => {
    const out = buildSystemPrompt({ ...base, skills: [skill({ name: "S", body: "b" })] });
    expect(out).toMatch(/safety rules win/i);
  });
});
