import { ERD_LAYOUT_MAX_EDGES, ERD_LAYOUT_MAX_NODES } from "./erdLayout";

export type FkEdge = {
  constraint: string;
  srcSchema: string;
  srcTable: string;
  srcCols: string[];
  dstSchema: string;
  dstTable: string;
  dstCols: string[];
};

export type Relationships = { outbound: FkEdge[]; inbound: FkEdge[] };
export type ErdColumn = { name: string; dataType: string; isPk: boolean; isFk: boolean };
export type ErdTable = { schema: string; name: string; columns: ErdColumn[] };
export type SchemaGraph = { tables: ErdTable[]; edges: FkEdge[] };
export type DetailCol = { name: string; data_type: string; is_pk: boolean; is_fk: boolean };

export const ERD_MAX_TABLES = ERD_LAYOUT_MAX_NODES;
export const ERD_MAX_EDGES = ERD_LAYOUT_MAX_EDGES;
export const HOOD_MAX_EDGES = 500;
export const GRAPH_MAX_COLUMNS_PER_TABLE = 2_048;
export const GRAPH_MAX_TOTAL_COLUMNS = 50_000;
export const GRAPH_MAX_FK_COLUMNS = 64;
export const GRAPH_MAX_VALUE_CHARS = 512;
export const GRAPH_MAX_EDGE_LABEL_CHARS = 512;
const GRAPH_MAX_ERROR_CHARS = 1_000;

export type SchemaGraphLoad =
  | { kind: "ok"; graph: SchemaGraph }
  | { kind: "too-large"; tableCount: number }
  | { kind: "error"; message: string };

export type ValueLoad<T> = { kind: "ok"; value: T } | { kind: "error"; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function text(value: unknown): string | null {
  return typeof value === "string" && value.length <= GRAPH_MAX_VALUE_CHARS ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > GRAPH_MAX_FK_COLUMNS) return null;
  const out: string[] = [];
  for (const item of value) {
    const s = text(item);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}

function edge(value: unknown): FkEdge | null {
  if (!isRecord(value)) return null;
  const constraint = text(value.constraint);
  const srcSchema = text(value.srcSchema);
  const srcTable = text(value.srcTable);
  const srcCols = stringList(value.srcCols);
  const dstSchema = text(value.dstSchema);
  const dstTable = text(value.dstTable);
  const dstCols = stringList(value.dstCols);
  if (constraint === null || srcSchema === null || srcTable === null || srcCols === null || dstSchema === null || dstTable === null || dstCols === null) return null;
  return { constraint, srcSchema, srcTable, srcCols, dstSchema, dstTable, dstCols };
}

function edgeList(value: unknown, limit: number): FkEdge[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  const out: FkEdge[] = [];
  for (const item of value) {
    const e = edge(item);
    if (!e) return null;
    out.push(e);
  }
  return out;
}

export function graphError(error: unknown): string {
  let raw: string;
  try {
    raw = isRecord(error) && "message" in error ? String(error.message) : String(error);
  } catch {
    raw = "Unknown graph error";
  }
  return raw.length <= GRAPH_MAX_ERROR_CHARS ? raw : `${raw.slice(0, GRAPH_MAX_ERROR_CHARS - 3)}...`;
}

export function graphDisplayText(value: string): string {
  return value.length <= GRAPH_MAX_VALUE_CHARS ? value : `${value.slice(0, GRAPH_MAX_VALUE_CHARS - 3)}...`;
}

export function readRelationships(value: unknown): ValueLoad<Relationships> {
  if (!isRecord(value) || !Array.isArray(value.outbound) || !Array.isArray(value.inbound)) {
    return { kind: "error", message: "Relationship response has an invalid shape." };
  }
  if (value.outbound.length + value.inbound.length > HOOD_MAX_EDGES) {
    return { kind: "error", message: `Relationship graph is too large (${value.outbound.length + value.inbound.length} edges, limit ${HOOD_MAX_EDGES}).` };
  }
  const outbound = edgeList(value.outbound, HOOD_MAX_EDGES);
  const inbound = edgeList(value.inbound, HOOD_MAX_EDGES);
  if (!outbound || !inbound) return { kind: "error", message: "Relationship response contains invalid or oversized values." };
  return { kind: "ok", value: { outbound, inbound } };
}

export function readDetailColumns(value: unknown): ValueLoad<DetailCol[]> {
  if (!isRecord(value) || !Array.isArray(value.columns) || value.columns.length > GRAPH_MAX_COLUMNS_PER_TABLE) {
    return { kind: "error", message: "Table detail response is invalid or too large." };
  }
  const columns: DetailCol[] = [];
  for (const item of value.columns) {
    if (!isRecord(item)) return { kind: "error", message: "Table detail response contains an invalid column." };
    const name = text(item.name);
    const dataType = text(item.data_type);
    const isPk = bool(item.is_pk);
    const isFk = bool(item.is_fk);
    if (name === null || dataType === null || isPk === null || isFk === null) {
      return { kind: "error", message: "Table detail response contains invalid or oversized values." };
    }
    columns.push({ name, data_type: dataType, is_pk: isPk, is_fk: isFk });
  }
  return { kind: "ok", value: columns };
}

export function readSchemaGraph(value: unknown): SchemaGraphLoad {
  if (!isRecord(value) || !Array.isArray(value.tables) || !Array.isArray(value.edges)) {
    return { kind: "error", message: "Schema graph response has an invalid shape." };
  }
  if (value.tables.length > ERD_MAX_TABLES) return { kind: "too-large", tableCount: value.tables.length };
  if (value.edges.length > ERD_MAX_EDGES) {
    return { kind: "error", message: `Schema graph is too large (${value.edges.length} edges, limit ${ERD_MAX_EDGES}).` };
  }

  const tables: ErdTable[] = [];
  const names = new Set<string>();
  let totalColumns = 0;
  for (const item of value.tables) {
    if (!isRecord(item) || !Array.isArray(item.columns) || item.columns.length > GRAPH_MAX_COLUMNS_PER_TABLE) {
      return { kind: "error", message: "Schema graph contains an invalid or oversized table." };
    }
    const schema = text(item.schema);
    const name = text(item.name);
    if (schema === null || name === null || names.has(name)) {
      return { kind: "error", message: "Schema graph contains invalid, oversized, or duplicate table names." };
    }
    names.add(name);
    totalColumns += item.columns.length;
    if (totalColumns > GRAPH_MAX_TOTAL_COLUMNS) {
      return { kind: "error", message: `Schema graph has too many columns (limit ${GRAPH_MAX_TOTAL_COLUMNS}).` };
    }
    const columns: ErdColumn[] = [];
    for (const rawCol of item.columns) {
      if (!isRecord(rawCol)) return { kind: "error", message: "Schema graph contains an invalid column." };
      const colName = text(rawCol.name);
      const dataType = text(rawCol.dataType);
      const isPk = bool(rawCol.isPk);
      const isFk = bool(rawCol.isFk);
      if (colName === null || dataType === null || isPk === null || isFk === null) {
        return { kind: "error", message: "Schema graph contains invalid or oversized column values." };
      }
      columns.push({ name: colName, dataType, isPk, isFk });
    }
    tables.push({ schema, name, columns });
  }

  const edges = edgeList(value.edges, ERD_MAX_EDGES);
  if (!edges) return { kind: "error", message: "Schema graph contains invalid or oversized relationships." };
  return { kind: "ok", graph: { tables, edges } };
}

export function edgeDisplayLabel(e: FkEdge): string {
  const value = `${e.srcCols.join(", ")} \u2192 ${e.dstCols.join(", ")}`;
  return value.length <= GRAPH_MAX_EDGE_LABEL_CHARS ? value : `${value.slice(0, GRAPH_MAX_EDGE_LABEL_CHARS - 3)}...`;
}

export function schemaGraphFallback(load: SchemaGraphLoad | undefined, schema: string): string {
  if (!load) return "Schema graph unavailable.";
  if (load.kind === "error") return load.message;
  if (load.kind === "too-large") return `Schema too large for the ERD (${load.tableCount} tables, limit ${ERD_MAX_TABLES}) \u2014 use the Neighborhood view per table.`;
  if (load.graph.tables.length) return "Schema graph could not be laid out safely.";
  return `No tables found in schema \u201c${graphDisplayText(schema)}\u201d.`;
}
