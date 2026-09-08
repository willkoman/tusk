// Structured result-grid filters. Pure + vitest-covered.
//
// A filter is a TREE: one root group (`and`/`or`) holding conditions and nested
// groups, so "AND of ORs" and "OR of ANDs" are both expressible. The flat
// `Filter[]` the per-column quick-filter row used before this is the degenerate
// case — a top-level AND of `contains` conditions — and `normalizeFilters`
// migrates it (and any older persisted shape) forward without dropping rules.
//
// Conditions reference a column by NAME, not by result index: the name is what
// SQL generation needs, it survives a re-run that reorders columns, and the
// Explorer can pre-build a filter from `table_detail` before any result exists.
// Ambiguity (two result columns with the same name) is rejected in filterSql,
// exactly as the old flat filter did.

import type { Filter } from "../tabs";

/** Value class a column's operator menu and literal rendering are driven by. */
export type ColumnClass = "text" | "number" | "boolean" | "datetime" | "other";

export type FilterOperator =
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "between"
  | "notBetween"
  | "in"
  | "notIn"
  | "like"
  | "notLike"
  | "ilike"
  | "startsWith"
  | "endsWith"
  | "contains"
  | "isNull"
  | "isNotNull"
  | "isTrue"
  | "isFalse"
  | "isEmpty";

/** How many value inputs an operator needs. "list" = one comma-separated field. */
export type Arity = 0 | 1 | 2 | "list";

export type Condition = {
  kind: "cond";
  /** Stable identity for React-less list editing (remove/duplicate/update by id). */
  id: string;
  column: string;
  operator: FilterOperator;
  values: string[];
};

export type FilterGroup = {
  kind: "group";
  id: string;
  op: "and" | "or";
  items: FilterNode[];
};

export type FilterNode = Condition | FilterGroup;
/** The root is always a group; a flat filter is a root AND of conditions. */
export type FilterTree = FilterGroup;

// --- adversarial bounds (a filter crosses into generated SQL) ---
export const MAX_CONDITIONS = 200;
export const MAX_DEPTH = 8;
export const MAX_VALUE_CHARS = 4096;
export const MAX_LIST_ITEMS = 500;

export const EMPTY_FILTER: FilterTree = Object.freeze({
  kind: "group",
  id: "root",
  op: "and",
  items: Object.freeze([]) as unknown as FilterNode[],
}) as FilterTree;

/** Fresh empty root group (never share a mutable tree between tabs). */
export function emptyFilter(): FilterTree {
  return { kind: "group", id: "root", op: "and", items: [] };
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}${++seq}`;

export function makeCondition(column: string, operator: FilterOperator = "contains", values: string[] = []): Condition {
  return { kind: "cond", id: nextId("c"), column, operator, values };
}

export function makeGroup(op: "and" | "or" = "or", items: FilterNode[] = []): FilterGroup {
  return { kind: "group", id: nextId("g"), op, items };
}

// --- operator catalogue -----------------------------------------------------

export type OperatorDef = {
  id: FilterOperator;
  label: string;
  arity: Arity;
  classes: ColumnClass[];
};

const ORDERED: ColumnClass[] = ["text", "number", "datetime", "other"];
const ALL: ColumnClass[] = ["text", "number", "boolean", "datetime", "other"];
const TEXTUAL: ColumnClass[] = ["text", "other"];

export const OPERATORS: readonly OperatorDef[] = [
  { id: "eq", label: "=", arity: 1, classes: ALL },
  { id: "ne", label: "≠", arity: 1, classes: ALL },
  { id: "lt", label: "<", arity: 1, classes: ORDERED },
  { id: "le", label: "≤", arity: 1, classes: ORDERED },
  { id: "gt", label: ">", arity: 1, classes: ORDERED },
  { id: "ge", label: "≥", arity: 1, classes: ORDERED },
  { id: "between", label: "between", arity: 2, classes: ORDERED },
  { id: "notBetween", label: "not between", arity: 2, classes: ORDERED },
  { id: "in", label: "in", arity: "list", classes: ORDERED },
  { id: "notIn", label: "not in", arity: "list", classes: ORDERED },
  { id: "contains", label: "contains", arity: 1, classes: TEXTUAL },
  { id: "startsWith", label: "starts with", arity: 1, classes: TEXTUAL },
  { id: "endsWith", label: "ends with", arity: 1, classes: TEXTUAL },
  { id: "like", label: "like", arity: 1, classes: TEXTUAL },
  { id: "notLike", label: "not like", arity: 1, classes: TEXTUAL },
  { id: "ilike", label: "ilike", arity: 1, classes: TEXTUAL },
  { id: "isEmpty", label: "is empty", arity: 0, classes: TEXTUAL },
  { id: "isTrue", label: "is true", arity: 0, classes: ["boolean"] },
  { id: "isFalse", label: "is false", arity: 0, classes: ["boolean"] },
  { id: "isNull", label: "is null", arity: 0, classes: ALL },
  { id: "isNotNull", label: "is not null", arity: 0, classes: ALL },
];

const BY_ID = new Map(OPERATORS.map((o) => [o.id, o]));

export function operatorDef(op: FilterOperator): OperatorDef | undefined {
  return BY_ID.get(op);
}

export function arityOf(op: FilterOperator): Arity {
  return BY_ID.get(op)?.arity ?? 1;
}

/** Operators offered for a column class, in menu order. */
export function operatorsFor(cls: ColumnClass): OperatorDef[] {
  return OPERATORS.filter((o) => o.classes.includes(cls));
}

/** The operator to fall back to when a column change makes the current one invalid. */
export function defaultOperatorFor(cls: ColumnClass): FilterOperator {
  return cls === "text" || cls === "other" ? "contains" : "eq";
}

// --- column classification --------------------------------------------------

const NUMBER_TYPES =
  /^(small|big|medium|tiny)?(int|integer|serial)\d*$|^(numeric|decimal|dec|real|double|float|money|number|smallmoney|fixed)/;
const DATE_TYPES = /^(date|time|timestamp|datetime|datetime2|smalldatetime|datetimeoffset|year|timestamptz|timetz)/;
const TEXT_TYPES = /^(char|character|varchar|nvarchar|nchar|text|ntext|string|citext|name|clob|varchar2)/;

/**
 * Map a driver-reported type name to a value class. Unknown/structured types
 * (uuid, json, arrays, enums, bytea…) fall to "other", which offers the
 * conservative operator set and casts to text for LIKE-family matching.
 */
export function classifyType(dataType: string | null | undefined): ColumnClass {
  if (!dataType) return "other";
  const t = dataType.trim().toLowerCase().replace(/^"|"$/g, "");
  if (/^bool(ean)?$/.test(t)) return "boolean";
  // Arrays/composites keep no scalar ordering we can rely on — treat as "other".
  if (t.endsWith("[]") || t.startsWith("_")) return "other";
  // "double precision", "timestamp with time zone", "character varying"…
  const head = t.split(/[\s(<[]/)[0];
  if (NUMBER_TYPES.test(head)) return "number";
  if (DATE_TYPES.test(head)) return "datetime";
  if (TEXT_TYPES.test(head)) return "text";
  return "other";
}

/** Class resolver over a name→type map (case-insensitive, as SQL name matching is). */
export function classResolver(types: Record<string, string> | undefined): (column: string) => ColumnClass {
  if (!types) return () => "other";
  const lower = new Map(Object.entries(types).map(([k, v]) => [k.toLowerCase(), v]));
  return (column) => classifyType(lower.get(column.toLowerCase()));
}

// --- value parsing ----------------------------------------------------------

/**
 * Split a comma-separated `in` list, honoring single/double quotes so
 * `'a,b', c` yields ["a,b", "c"]. Quotes are stripping delimiters, not literal
 * text; doubled quotes inside a quoted run are one quote. Blank entries drop.
 */
export function parseList(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        if (input[i + 1] === quote) {
          cur += ch;
          i++;
        } else quote = null;
      } else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = true;
      continue;
    }
    if (ch === ",") {
      const v = quoted ? cur : cur.trim();
      if (v !== "") out.push(v);
      cur = "";
      quoted = false;
      continue;
    }
    cur += ch;
  }
  const last = quoted ? cur : cur.trim();
  if (last !== "") out.push(last);
  return out.slice(0, MAX_LIST_ITEMS);
}

// --- completeness -----------------------------------------------------------

/** A condition contributes SQL only when its operator's value slots are filled. */
export function isComplete(cond: Condition): boolean {
  const arity = arityOf(cond.operator);
  if (arity === 0) return true;
  if (arity === "list") return parseList(cond.values[0] ?? "").length > 0;
  for (let i = 0; i < arity; i++) if ((cond.values[i] ?? "") === "") return false;
  return true;
}

export function isGroup(node: FilterNode): node is FilterGroup {
  return node.kind === "group";
}

/** Complete conditions anywhere in the tree, in document order. */
export function conditions(node: FilterNode): Condition[] {
  if (!isGroup(node)) return isComplete(node) ? [node] : [];
  return node.items.flatMap(conditions);
}

/** Every condition (complete or not) — used for bounds checks and UI counts. */
export function allConditions(node: FilterNode): Condition[] {
  return isGroup(node) ? node.items.flatMap(allConditions) : [node];
}

export function hasConditions(tree: FilterTree): boolean {
  return conditions(tree).length > 0;
}

export function depthOf(node: FilterNode): number {
  return isGroup(node) ? 1 + node.items.reduce((m, i) => Math.max(m, depthOf(i)), 0) : 1;
}

/** Throws when a tree exceeds the generation bounds (size, nesting, value length). */
export function assertWithinLimits(tree: FilterTree): void {
  const all = allConditions(tree);
  if (all.length > MAX_CONDITIONS) throw new Error(`filter has too many conditions (max ${MAX_CONDITIONS})`);
  if (depthOf(tree) > MAX_DEPTH) throw new Error(`filter groups are nested too deeply (max ${MAX_DEPTH})`);
  for (const c of all)
    for (const v of c.values)
      if (v.length > MAX_VALUE_CHARS) throw new Error(`filter value is too long (max ${MAX_VALUE_CHARS} characters)`);
}

// --- pure tree edits --------------------------------------------------------

function mapNode(node: FilterNode, fn: (n: FilterNode) => FilterNode | null): FilterNode | null {
  const replaced = fn(node);
  if (replaced === null) return null;
  if (!isGroup(replaced)) return replaced;
  const items = replaced.items.map((i) => mapNode(i, fn)).filter((i): i is FilterNode => i !== null);
  return { ...replaced, items };
}

/** Replace the node with `id` (returning null from `fn` removes it). */
export function updateNode(tree: FilterTree, id: string, fn: (node: FilterNode) => FilterNode | null): FilterTree {
  const next = mapNode(tree, (n) => (n.id === id ? fn(n) : n));
  return (next as FilterTree | null) ?? emptyFilter();
}

export function removeNode(tree: FilterTree, id: string): FilterTree {
  if (tree.id === id) return emptyFilter();
  return updateNode(tree, id, () => null);
}

/** Append a node to the group with `groupId` (root when it isn't found). */
export function addToGroup(tree: FilterTree, groupId: string, node: FilterNode): FilterTree {
  let placed = false;
  const next = mapNode(tree, (n) => {
    if (n.id === groupId && isGroup(n)) {
      placed = true;
      return { ...n, items: [...n.items, node] };
    }
    return n;
  }) as FilterTree;
  return placed ? next : { ...next, items: [...next.items, node] };
}

function cloneWithNewIds(node: FilterNode): FilterNode {
  return isGroup(node)
    ? { ...node, id: nextId("g"), items: node.items.map(cloneWithNewIds) }
    : { ...node, id: nextId("c"), values: [...node.values] };
}

/** Insert a fresh-id copy of `id` directly after it in its parent. */
export function duplicateNode(tree: FilterTree, id: string): FilterTree {
  const inGroup = (g: FilterGroup): FilterGroup => {
    const at = g.items.findIndex((i) => i.id === id);
    let items = g.items.map((i) => (isGroup(i) ? inGroup(i) : i));
    if (at >= 0) {
      items = [...items];
      items.splice(at + 1, 0, cloneWithNewIds(g.items[at]));
    }
    return { ...g, items };
  };
  return inGroup(tree);
}

export function setGroupOp(tree: FilterTree, id: string, op: "and" | "or"): FilterTree {
  return updateNode(tree, id, (n) => (isGroup(n) ? { ...n, op } : n));
}

export function updateCondition(tree: FilterTree, id: string, patch: Partial<Omit<Condition, "kind" | "id">>): FilterTree {
  return updateNode(tree, id, (n) => (isGroup(n) ? n : { ...n, ...patch }));
}

// --- flat-filter interop / migration ---------------------------------------

/** The quick-filter row's operator: the old flat filter's case-insensitive contains. */
export const QUICK_OPERATOR: FilterOperator = "contains";

/** Legacy `Filter[]` (column index + contains text) → a root AND of conditions. */
export function treeFromFlat(filters: Filter[], columns: string[]): FilterTree {
  const items: FilterNode[] = [];
  for (const f of filters) {
    const name = columns[f.col];
    if (name == null || f.text.trim() === "") continue;
    items.push(makeCondition(name, QUICK_OPERATOR, [f.text]));
  }
  return { kind: "group", id: "root", op: "and", items };
}

/** Either shape accepted at the boundaries so old call sites keep compiling. */
export type FilterInput = Filter[] | FilterTree;

export function toFilterTree(input: FilterInput, columns: string[]): FilterTree {
  return Array.isArray(input) ? treeFromFlat(input, columns) : input;
}

const isOperator = (v: unknown): v is FilterOperator => typeof v === "string" && BY_ID.has(v as FilterOperator);

function normalizeNode(value: unknown, depth: number): FilterNode | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.kind === "group" || Array.isArray(v.items)) {
    if (depth >= MAX_DEPTH) return null;
    const items = Array.isArray(v.items)
      ? v.items.map((i) => normalizeNode(i, depth + 1)).filter((i): i is FilterNode => i !== null)
      : [];
    return { kind: "group", id: typeof v.id === "string" ? v.id : nextId("g"), op: v.op === "or" ? "or" : "and", items };
  }
  if (typeof v.column !== "string") return null;
  const operator = isOperator(v.operator) ? v.operator : QUICK_OPERATOR;
  const values = Array.isArray(v.values)
    ? v.values.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, MAX_VALUE_CHARS))
    : [];
  return { kind: "cond", id: typeof v.id === "string" ? v.id : nextId("c"), column: v.column, operator, values };
}

/**
 * Accept anything a previous version may have stored in a grid view — the flat
 * `Filter[]`, a tree, or junk — and return a usable tree. Saved rules survive
 * the shape change; unrecognizable entries are dropped rather than thrown.
 */
export function normalizeFilters(value: unknown, columns: string[] = []): FilterTree {
  if (Array.isArray(value)) {
    // Legacy flat shape: [{ col, text }].
    if (value.every((v) => v && typeof v === "object" && typeof (v as Filter).col === "number"))
      return treeFromFlat(value as Filter[], columns);
    const items = value.map((v) => normalizeNode(v, 1)).filter((i): i is FilterNode => i !== null);
    return { kind: "group", id: "root", op: "and", items };
  }
  const node = normalizeNode(value, 0);
  if (!node) return emptyFilter();
  if (!isGroup(node)) return { kind: "group", id: "root", op: "and", items: [node] };
  return { ...node, id: node.id || "root" };
}

// --- per-column quick filters (the header filter row) -----------------------

/** Text of the top-level quick (`contains`) condition on `column`, or "". */
export function quickFilterOf(tree: FilterTree, column: string): string {
  for (const item of tree.items)
    if (!isGroup(item) && item.column === column && item.operator === QUICK_OPERATOR) return item.values[0] ?? "";
  return "";
}

/** Set/clear the top-level quick condition for one column, leaving the rest alone. */
export function setQuickFilter(tree: FilterTree, column: string, text: string): FilterTree {
  const items = tree.items.filter((i) => isGroup(i) || i.column !== column || i.operator !== QUICK_OPERATOR);
  if (text.trim() !== "") items.push(makeCondition(column, QUICK_OPERATOR, [text]));
  return { ...tree, items };
}

// --- labels -----------------------------------------------------------------

/** Human chip label: `status = 'active'`-ish, no quoting rules, display only. */
export function describeCondition(cond: Condition): string {
  const label = operatorDef(cond.operator)?.label ?? cond.operator;
  const arity = arityOf(cond.operator);
  if (arity === 0) return `${cond.column} ${label}`;
  if (arity === 2) return `${cond.column} ${label} ${cond.values[0] ?? ""} and ${cond.values[1] ?? ""}`;
  if (arity === "list") return `${cond.column} ${label} (${parseList(cond.values[0] ?? "").join(", ")})`;
  return `${cond.column} ${label} ${cond.values[0] ?? ""}`;
}
