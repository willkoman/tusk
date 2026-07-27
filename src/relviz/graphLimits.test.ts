import { describe, expect, it } from "vitest";
import {
  ERD_MAX_EDGES,
  ERD_MAX_TABLES,
  GRAPH_MAX_EDGE_LABEL_CHARS,
  GRAPH_MAX_VALUE_CHARS,
  HOOD_MAX_EDGES,
  edgeDisplayLabel,
  graphError,
  readRelationships,
  readSchemaGraph,
  schemaGraphFallback,
  type FkEdge,
} from "./graphLimits";

const edge = (i = 0): FkEdge => ({
  constraint: `fk_${i}`,
  srcSchema: "public",
  srcTable: `child_${i}`,
  srcCols: ["parent_id"],
  dstSchema: "public",
  dstTable: "parent",
  dstCols: ["id"],
});

describe("relationship graph limits", () => {
  it("validates normal schema and neighborhood payloads", () => {
    const graph = readSchemaGraph({
      tables: [
        { schema: "public", name: "child", columns: [{ name: "parent_id", dataType: "integer", isPk: false, isFk: true }] },
        { schema: "public", name: "parent", columns: [{ name: "id", dataType: "integer", isPk: true, isFk: false }] },
      ],
      edges: [{ ...edge(), srcTable: "child" }],
    });
    expect(graph.kind).toBe("ok");
    expect(readRelationships({ outbound: [edge()], inbound: [] }).kind).toBe("ok");
  });

  it("rejects spoofed shapes and oversized values before layout/render", () => {
    expect(readSchemaGraph({ tables: {}, edges: [] }).kind).toBe("error");
    expect(readSchemaGraph({ tables: [{ schema: "public", name: "x", columns: [[]] }], edges: [] }).kind).toBe("error");
    expect(readSchemaGraph({ tables: [{ schema: "public", name: "x".repeat(GRAPH_MAX_VALUE_CHARS + 1), columns: [] }], edges: [] }).kind).toBe("error");
    expect(readRelationships({ outbound: Array.from({ length: HOOD_MAX_EDGES + 1 }, (_, i) => edge(i)), inbound: [] }).kind).toBe("error");
    expect(readSchemaGraph({ tables: [], edges: Array.from({ length: ERD_MAX_EDGES + 1 }, (_, i) => edge(i)) }).kind).toBe("error");
  });

  it("short-circuits excessive table counts without walking table values", () => {
    const tables = Array.from({ length: ERD_MAX_TABLES + 1 }, () => null);
    expect(readSchemaGraph({ tables, edges: [] })).toEqual({ kind: "too-large", tableCount: ERD_MAX_TABLES + 1 });
  });

  it("surfaces fetch errors instead of claiming an empty schema", () => {
    const load = { kind: "error", message: "permission denied" } as const;
    expect(schemaGraphFallback(load, "public")).toBe("permission denied");
    expect(schemaGraphFallback({ kind: "ok", graph: { tables: [], edges: [] } }, "public")).toContain("No tables found");
    expect(schemaGraphFallback({ kind: "ok", graph: { tables: [{ schema: "public", name: "t", columns: [] }], edges: [] } }, "public")).toContain("could not be laid out safely");
  });

  it("bounds edge labels and error values", () => {
    const long = "x".repeat(GRAPH_MAX_VALUE_CHARS);
    const label = edgeDisplayLabel({ ...edge(), srcCols: [long], dstCols: [long] });
    expect(label.length).toBeLessThanOrEqual(GRAPH_MAX_EDGE_LABEL_CHARS);
    expect(label.endsWith("...")).toBe(true);
    expect(graphError(new Error("x".repeat(2_000))).length).toBeLessThanOrEqual(1_000);
  });
});
