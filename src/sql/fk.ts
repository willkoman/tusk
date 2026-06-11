// Foreign-key edge shape shared by the relationship views and the FK-aware
// JOIN completion. Mirrors `relgraph.rs FkEdge` (serde camelCase).
export type FkEdge = {
  constraint: string;
  srcSchema: string;
  srcTable: string;
  srcCols: string[];
  dstSchema: string;
  dstTable: string;
  dstCols: string[];
};
