import { describe, expect, it } from "vitest";
import { parsePg } from "./parsePg";
import { parsePgText } from "./parsePgText";
import { parseMysql } from "./parseMysql";
import { parseSqlite } from "./parseSqlite";
import { parseDuck } from "./parseDuck";
import { detectPlan, isExplainQuery } from "./detect";
import { explainSql, analyzeExecutesWrite } from "./explainSql";
import { type PlanTree } from "./types";

// ---------- Postgres JSON ----------

const PG_JSON = JSON.stringify([
  {
    Plan: {
      "Node Type": "Hash Join",
      "Join Type": "Inner",
      "Startup Cost": 1.09,
      "Total Cost": 2.21,
      "Plan Rows": 4,
      "Plan Width": 12,
      "Actual Startup Time": 0.05,
      "Actual Total Time": 0.08,
      "Actual Rows": 4,
      "Actual Loops": 1,
      "Hash Cond": "(a.id = b.a_id)",
      Plans: [
        {
          "Node Type": "Seq Scan",
          "Relation Name": "a",
          "Startup Cost": 0,
          "Total Cost": 1.04,
          "Plan Rows": 4,
          "Plan Width": 8,
          "Actual Total Time": 0.01,
          "Actual Rows": 4,
          "Actual Loops": 1,
        },
        {
          "Node Type": "Hash",
          "Startup Cost": 1.04,
          "Total Cost": 1.04,
          "Plan Rows": 4,
          "Plan Width": 8,
          "Actual Total Time": 0.02,
          "Actual Rows": 4,
          "Actual Loops": 1,
          Plans: [
            {
              "Node Type": "Seq Scan",
              "Relation Name": "b",
              "Startup Cost": 0,
              "Total Cost": 1.04,
              "Plan Rows": 4,
              "Plan Width": 8,
              "Actual Total Time": 0.01,
              "Actual Rows": 4,
              "Actual Loops": 1,
            },
          ],
        },
      ],
    },
    "Planning Time": 0.2,
    "Execution Time": 0.5,
  },
]);

describe("parsePg", () => {
  it("builds the tree with labels, objects, metrics", () => {
    const p = parsePg(PG_JSON) as PlanTree;
    expect(p.kind).toBe("tree");
    expect(p.root.label).toBe("Hash Join");
    expect(p.root.children.length).toBe(2);
    expect(p.root.children[0].object).toBe("a");
    expect(p.root.children[1].label).toBe("Hash");
    expect(p.root.children[1].children[0].object).toBe("b");
    expect(p.hasActual).toBe(true);
    expect(p.planningMs).toBe(0.2);
    expect(p.executionMs).toBe(0.5);
  });

  it("computes exclusive cost/time (clamped)", () => {
    const p = parsePg(PG_JSON) as PlanTree;
    // root selfCost = 2.21 − (1.04 + 1.04) = 0.13
    expect(p.root.selfCost).toBeCloseTo(0.13, 5);
    // Hash selfCost = 1.04 − 1.04 = 0
    expect(p.root.children[1].selfCost).toBeCloseTo(0, 5);
    // root selfTime = 0.08·1 − (0.01·1 + 0.02·1) = 0.05
    expect(p.root.selfTimeMs).toBeCloseTo(0.05, 5);
    // Hash selfTime = 0.02 − 0.01 = 0.01
    expect(p.root.children[1].selfTimeMs).toBeCloseTo(0.01, 5);
  });

  it("precomputes maxima and assigns preorder ids", () => {
    const p = parsePg(PG_JSON) as PlanTree;
    expect(p.maxSelfCost).toBeCloseTo(1.04, 5); // the seq scans
    expect(p.root.id).toBe(0);
    expect(p.root.children[0].id).toBe(1);
    expect(p.root.children[1].id).toBe(2);
    expect(p.root.children[1].children[0].id).toBe(3);
  });

  it("bails on garbage / truncated / shapeless JSON", () => {
    expect(parsePg("{ not json")).toBeNull();
    expect(parsePg(PG_JSON.slice(0, 50))).toBeNull();
    expect(parsePg('{"foo": 1}')).toBeNull();
  });
});

// ---------- Postgres text ----------

const PG_TEXT = [
  "Hash Join  (cost=1.09..2.21 rows=4 width=12) (actual time=0.05..0.08 rows=4 loops=1)",
  "  Hash Cond: (a.id = b.a_id)",
  "  ->  Seq Scan on a  (cost=0.00..1.04 rows=4 width=8) (actual time=0.00..0.01 rows=4 loops=1)",
  "  ->  Hash  (cost=1.04..1.04 rows=4 width=8) (actual time=0.01..0.02 rows=4 loops=1)",
  "        Buckets: 1024  Batches: 1  Memory Usage: 9kB",
  "        ->  Seq Scan on b  (cost=0.00..1.04 rows=4 width=8) (actual time=0.00..0.01 rows=4 loops=1)",
  "Planning Time: 0.2 ms",
  "Execution Time: 0.5 ms",
];

describe("parsePgText", () => {
  it("parses indentation into the same tree shape", () => {
    const p = parsePgText(PG_TEXT) as PlanTree;
    expect(p.kind).toBe("tree");
    expect(p.root.label).toBe("Hash Join");
    expect(p.root.children.length).toBe(2);
    expect(p.root.children[0].object).toBe("a");
    expect(p.root.children[1].children[0].object).toBe("b");
    expect(p.root.props).toContainEqual(["Hash Cond", "(a.id = b.a_id)"]);
    expect(p.planningMs).toBe(0.2);
    expect(p.executionMs).toBe(0.5);
    expect(p.root.selfTimeMs).toBeCloseTo(0.05, 5);
  });

  it("extracts index scans with 'using'", () => {
    const p = parsePgText(["Index Scan using films_pkey on films  (cost=0.15..8.17 rows=1 width=4)"]) as PlanTree;
    expect(p.root.label).toBe("Index Scan using films_pkey");
    expect(p.root.object).toBe("films");
  });

  it("bails on non-plan text and multi-plan output", () => {
    expect(parsePgText(["not a plan at all"])).toBeNull();
    expect(parsePgText([...PG_TEXT.slice(0, 1), "Seq Scan on c  (cost=0.00..1.00 rows=1 width=4)"])).toBeNull();
    expect(parsePgText(["Hash Join  (cost=1..2 rows=4 width=12)", "  ->  ?????"])).toBeNull();
  });
});

// ---------- MySQL ----------

const MYSQL_JSON = JSON.stringify({
  query_block: {
    select_id: 1,
    cost_info: { query_cost: "2.55" },
    nested_loop: [
      {
        table: {
          table_name: "a",
          access_type: "ALL",
          rows_examined_per_scan: 4,
          cost_info: { read_cost: "0.25", eval_cost: "0.40", prefix_cost: "0.65" },
        },
      },
      {
        table: {
          table_name: "b",
          access_type: "eq_ref",
          possible_keys: ["PRIMARY"],
          key: "PRIMARY",
          rows_examined_per_scan: 1,
          cost_info: { read_cost: "1.00", eval_cost: "0.40", prefix_cost: "2.55" },
        },
      },
    ],
  },
});

describe("parseMysql", () => {
  it("recurses wrappers into a tree with costs", () => {
    const p = parseMysql(MYSQL_JSON) as PlanTree;
    expect(p.kind).toBe("tree");
    expect(p.root.label).toBe("Query Block");
    expect(p.root.totalCost).toBeCloseTo(2.55, 5);
    expect(p.root.children.length).toBe(2);
    expect(p.root.children[0].object).toBe("a");
    expect(p.root.children[0].label).toBe("Access (ALL)");
    expect(p.root.children[1].selfCost).toBeCloseTo(1.4, 5); // read 1.00 + eval 0.40
    expect(p.hasActual).toBe(false);
  });

  it("bails when there is no query_block", () => {
    expect(parseMysql('{"something_else": {}}')).toBeNull();
    expect(parseMysql("-> Nested loop inner join")).toBeNull(); // ANALYZE tree text
  });
});

// ---------- SQLite ----------

const EQP_COLS = ["id", "parent", "notused", "detail"];
const EQP_ROWS: (string | null)[][] = [
  ["4", "0", "0", "SCAN a"],
  ["8", "0", "0", "SEARCH b USING INTEGER PRIMARY KEY (rowid=?)"],
];

describe("parseSqlite", () => {
  it("builds parent-id tree, extracts objects", () => {
    const p = parseSqlite(EQP_COLS, EQP_ROWS) as PlanTree;
    expect(p.kind).toBe("tree");
    expect(p.root.label).toBe("QUERY PLAN");
    expect(p.root.children.length).toBe(2);
    expect(p.root.children[0].object).toBe("a");
    expect(p.root.children[1].object).toBe("b");
  });

  it("nests via parent ids", () => {
    const rows: (string | null)[][] = [
      ["1", "0", "0", "CO-ROUTINE sub"],
      ["3", "1", "0", "SCAN t1"],
      ["10", "0", "0", "SCAN sub"],
    ];
    const p = parseSqlite(EQP_COLS, rows) as PlanTree;
    expect(p.root.children[0].label).toBe("CO-ROUTINE sub");
    expect(p.root.children[0].children[0].object).toBe("t1");
  });

  it("rejects the bytecode listing signature", () => {
    expect(parseSqlite(["addr", "opcode", "p1", "p2", "p3", "p4", "p5", "comment"], [["0", "Init", "0", "1", "0", null, "0", null]])).toBeNull();
  });
});

// ---------- DuckDB ----------

const DUCK_JSON = JSON.stringify([
  {
    name: "PROJECTION",
    children: [
      {
        name: "HASH_JOIN",
        extra_info: { "Join Type": "INNER", Conditions: "id = a_id" },
        children: [
          { name: "SEQ_SCAN", extra_info: { Table: "a" }, children: [] },
          { name: "SEQ_SCAN", extra_info: { Table: "b" }, children: [] },
        ],
      },
    ],
  },
]);

describe("parseDuck", () => {
  it("parses name/children/extra_info", () => {
    const p = parseDuck(DUCK_JSON) as PlanTree;
    expect(p.kind).toBe("tree");
    expect(p.root.label).toBe("PROJECTION");
    expect(p.root.children[0].label).toBe("HASH_JOIN");
    expect(p.root.children[0].children.length).toBe(2);
    expect(p.root.children[0].props).toContainEqual(["Join Type", "INNER"]);
  });

  it("accepts older extra-info string form + timings", () => {
    const p = parseDuck(JSON.stringify([{ name: "SCAN", "extra-info": "t1\n[INFOSEPARATOR]", timing: 0.002, cardinality: 42, children: [] }])) as PlanTree;
    expect(p.root.props[0][0]).toBe("Info");
    expect(p.root.selfTimeMs).toBeCloseTo(2, 5);
    expect(p.root.actualRows).toBe(42);
    expect(p.hasActual).toBe(true);
  });

  it("bails on non-plan JSON", () => {
    expect(parseDuck('"just a string"')).toBeNull();
    expect(parseDuck("[1, 2, 3]")).toBeNull();
  });

  // Real DuckDB shapes (captured from libduckdb 1.4.x).
  it("plain EXPLAIN: lifts 'Estimated Cardinality' to planRows (+ object) so rows heat works", () => {
    const json = JSON.stringify([
      {
        name: "SEQ_SCAN ",
        children: [],
        extra_info: { Table: "t", Type: "Sequential Scan", Filters: "id>10", "Estimated Cardinality": "200" },
      },
    ]);
    const p = parseDuck(json) as PlanTree;
    expect(p.root.label).toBe("SEQ_SCAN");
    expect(p.root.object).toBe("t");
    expect(p.root.planRows).toBe(200);
    expect(p.maxRows).toBe(200); // heat has a metric to scale by
  });

  it("ANALYZE: unwraps profiling root + EXPLAIN_ANALYZE, reads operator_name/timing/cardinality", () => {
    const json = JSON.stringify({
      latency: 0.5,
      rows_returned: 1,
      children: [
        {
          operator_name: "EXPLAIN_ANALYZE",
          operator_type: "EXPLAIN_ANALYZE",
          operator_timing: 5e-7,
          children: [
            {
              operator_name: "UNGROUPED_AGGREGATE",
              operator_cardinality: 1,
              operator_timing: 0.0000175,
              extra_info: { Aggregates: "count_star()" },
              children: [
                {
                  operator_name: "SEQ_SCAN ",
                  operator_type: "TABLE_SCAN",
                  operator_cardinality: 989,
                  operator_timing: 0.0000472,
                  extra_info: { Table: "t", Filters: "id>10", "Estimated Cardinality": "200" },
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    });
    const p = parseDuck(json) as PlanTree;
    // Real root is the aggregate (profiling + EXPLAIN_ANALYZE wrappers dropped).
    expect(p.root.label).toBe("UNGROUPED_AGGREGATE");
    expect(p.root.actualRows).toBe(1);
    const scan = p.root.children[0];
    expect(scan.label).toBe("SEQ_SCAN");
    expect(scan.actualRows).toBe(989); // operator_cardinality → drives rows heat
    expect(scan.selfTimeMs).toBeCloseTo(0.0472, 3); // operator_timing*1000 → time heat
    expect(scan.planRows).toBe(200); // estimated cardinality still surfaced
    expect(p.hasActual).toBe(true);
    expect(p.executionMs).toBeCloseTo(500, 1); // latency*1000
    expect(p.maxSelfTimeMs).toBeGreaterThan(0);
    expect(p.maxRows).toBe(989);
  });
});

// ---------- detect ----------

describe("detectPlan", () => {
  it("ignores non-EXPLAIN results entirely", () => {
    expect(detectPlan("postgres", { lastQuery: "SELECT 1", columns: ["?column?"], rows: [["1"]] })).toBeNull();
  });

  it("sees through leading comments", () => {
    expect(isExplainQuery("-- check\n/* x */ EXPLAIN SELECT 1")).toBe(true);
    expect(isExplainQuery("-- explain in a comment\nSELECT 1")).toBe(false);
  });

  it("routes PG JSON, PG text, and unparseable to the right kinds", () => {
    const q = "EXPLAIN (FORMAT JSON) SELECT 1";
    const tree = detectPlan("postgres", { lastQuery: q, columns: ["QUERY PLAN"], rows: [[PG_JSON]] });
    expect(tree?.kind).toBe("tree");
    const text = detectPlan("postgres", { lastQuery: "EXPLAIN SELECT 1", columns: ["QUERY PLAN"], rows: PG_TEXT.map((l) => [l]) });
    expect(text?.kind).toBe("tree"); // indentation parser handles it
    const weird = detectPlan("postgres", { lastQuery: "EXPLAIN (COSTS OFF) SELECT 1", columns: ["QUERY PLAN"], rows: [["Seq Scan on a"]] });
    expect(weird?.kind).toBe("text"); // no cost groups → styled text, never broken
  });

  it("handles PG JSON split across multiple rows of one column", () => {
    // PG pretty-prints the JSON; the simple protocol can deliver it as one row
    // per line — detect joins the column with newlines.
    const lines = JSON.stringify(JSON.parse(PG_JSON), null, 2).split("\n");
    expect(lines.length).toBeGreaterThan(10);
    const tree = detectPlan("postgres", { lastQuery: "EXPLAIN (FORMAT JSON) SELECT 1", columns: ["QUERY PLAN"], rows: lines.map((l) => [l]) });
    expect(tree?.kind).toBe("tree");
  });

  it("SQLite: EQP → tree, bytecode → null (grid)", () => {
    expect(detectPlan("sqlite", { lastQuery: "EXPLAIN QUERY PLAN SELECT 1", columns: EQP_COLS, rows: EQP_ROWS })?.kind).toBe("tree");
    expect(
      detectPlan("sqlite", { lastQuery: "EXPLAIN SELECT 1", columns: ["addr", "opcode", "p1", "p2", "p3", "p4", "p5", "comment"], rows: [["0", "Init", "0", "0", "0", null, "0", null]] }),
    ).toBeNull();
  });

  it("MySQL: JSON → tree, tabular → null, ANALYZE text → text", () => {
    expect(detectPlan("mysql", { lastQuery: "EXPLAIN FORMAT=JSON SELECT 1", columns: ["EXPLAIN"], rows: [[MYSQL_JSON]] })?.kind).toBe("tree");
    expect(detectPlan("mysql", { lastQuery: "EXPLAIN SELECT 1", columns: ["id", "select_type", "table", "type", "rows"], rows: [["1", "SIMPLE", "a", "ALL", "4"]] })).toBeNull();
    expect(detectPlan("mysql", { lastQuery: "EXPLAIN ANALYZE SELECT 1", columns: ["EXPLAIN"], rows: [["-> Table scan on a (cost=0.65)"]] })?.kind).toBe("text");
  });

  it("DuckDB: JSON → tree, box-art → text from last column", () => {
    expect(detectPlan("duckdb", { lastQuery: "EXPLAIN (FORMAT json) SELECT 1", columns: ["explain_key", "explain_value"], rows: [["physical_plan", DUCK_JSON]] })?.kind).toBe("tree");
    const art = detectPlan("duckdb", { lastQuery: "EXPLAIN SELECT 1", columns: ["explain_key", "explain_value"], rows: [["physical_plan", "┌─────┐\n│SCAN │\n└─────┘"]] });
    expect(art?.kind).toBe("text");
    expect((art as { text: string }).text).toContain("SCAN");
  });
});

describe("plan parser adversarial totality", () => {
  it("ignores malformed children instead of throwing", () => {
    const pg = JSON.stringify([{ Plan: { "Node Type": "Root", Plans: [null, 1, "bad", { "Node Type": "Leaf" }] } }]);
    expect(() => parsePg(pg)).not.toThrow();
    expect((parsePg(pg) as PlanTree).root.children).toHaveLength(1);
  });

  it("rejects excessively deep provider trees before recursive normalization", () => {
    let pgNode: Record<string, unknown> = { "Node Type": "Leaf" };
    let duckNode: Record<string, unknown> = { name: "Leaf", children: [] };
    let mysqlNode: Record<string, unknown> = { table_name: "leaf" };
    for (let i = 0; i < 300; i++) {
      pgNode = { "Node Type": "Node", Plans: [pgNode] };
      duckNode = { name: "Node", children: [duckNode] };
      mysqlNode = { ordering_operation: mysqlNode };
    }
    expect(parsePg(JSON.stringify([{ Plan: pgNode }]))).toBeNull();
    expect(parseDuck(JSON.stringify([duckNode]))).toBeNull();
    expect(parseMysql(JSON.stringify({ query_block: mysqlNode }))).toBeNull();
  });

  it("never throws for a deterministic malformed corpus", () => {
    const corpus = ["", "null", "[]", "{}", "[null]", '{"Plan":{"Plans":[null]}}', "{", "🦆", "[1,2,3]"];
    for (const value of corpus) {
      expect(() => parsePg(value), `pg: ${value}`).not.toThrow();
      expect(() => parseDuck(value), `duck: ${value}`).not.toThrow();
      expect(() => parseMysql(value), `mysql: ${value}`).not.toThrow();
      expect(() => detectPlan("postgres", { lastQuery: "EXPLAIN SELECT 1", columns: ["plan"], rows: [[value]] })).not.toThrow();
    }
  });

  it("bounds oversized plan input and text fallback", () => {
    const out = detectPlan("postgres", {
      lastQuery: "EXPLAIN SELECT 1",
      columns: ["plan"],
      rows: [["x".repeat(5_000_001)]],
    });
    expect(out?.kind).toBe("text");
    expect(out?.kind === "text" ? out.text.length : Infinity).toBeLessThan(1_000_100);
  });
});

// ---------- explainSql ----------

describe("explainSql", () => {
  it("wraps per engine and strips trailing semicolons", () => {
    expect(explainSql("postgres", false, "SELECT 1;", false)).toBe("EXPLAIN (FORMAT JSON) SELECT 1");
    expect(explainSql("postgres", true, "SELECT 1", false)).toBe("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1");
    expect(explainSql("mysql", false, "SELECT 1", false)).toBe("EXPLAIN FORMAT=JSON SELECT 1");
    expect(explainSql("mysql", true, "SELECT 1", false)).toBe("EXPLAIN ANALYZE SELECT 1");
    expect(explainSql("sqlite", false, "SELECT 1", false)).toBe("EXPLAIN QUERY PLAN SELECT 1");
    expect(explainSql("duckdb", false, "SELECT 1", true)).toBe("EXPLAIN (FORMAT json) SELECT 1");
    expect(explainSql("duckdb", false, "SELECT 1", false)).toBe("EXPLAIN SELECT 1");
    expect(explainSql("duckdb", true, "SELECT 1", true)).toBe("EXPLAIN (ANALYZE, FORMAT json) SELECT 1");
  });

  it("flags writes for the ANALYZE confirm", () => {
    expect(analyzeExecutesWrite("SELECT * FROM t")).toBe(false);
    expect(analyzeExecutesWrite("-- c\nWITH x AS (SELECT 1) SELECT * FROM x")).toBe(false);
    expect(analyzeExecutesWrite("DELETE FROM t")).toBe(true);
    expect(analyzeExecutesWrite("UPDATE t SET a=1")).toBe(true);
  });
});
