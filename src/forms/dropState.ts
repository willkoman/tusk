// Pending-drop state for the Modify table dialog.
//
// A drop is an explicit per-row action, not a ticked box: the row flips into a
// "will be dropped" state that says so and offers Keep, and every pending drop is
// counted in its section heading, summarised in the footer, and named again in the
// Apply confirmation. The emitted SQL is unchanged — `dropIndexes` / `dropConstraints`
// are still the names collected here.

/** Names marked for dropping. Absent and `false` both mean "keep". */
export type DropSet = Readonly<Record<string, boolean>>;

export const isDropped = (set: DropSet, name: string): boolean => set[name] === true;

/** Returns the same object when nothing changes, so a re-render is not forced. */
export function setDropped(set: DropSet, name: string, dropped: boolean): DropSet {
  if (isDropped(set, name) === dropped) return set;
  const next = { ...set };
  if (dropped) next[name] = true;
  else delete next[name];
  return next;
}

export const toggleDropped = (set: DropSet, name: string): DropSet =>
  setDropped(set, name, !isDropped(set, name));

/** Dropped names in the order the section lists them (never in hash order). */
export const droppedNames = (set: DropSet, order: readonly string[]): string[] =>
  order.filter((n) => isDropped(set, n));

export const dropCount = (set: DropSet, order: readonly string[]): number =>
  droppedNames(set, order).length;

/** `"Constraints"` → `"Constraints (2 to drop)"`. */
export const sectionLabel = (label: string, count: number): string =>
  count > 0 ? `${label} (${count} to drop)` : label;

/** Everything a single Apply would destroy, by kind. */
export type DropTally = {
  columns: readonly string[];
  indexes: readonly string[];
  constraints: readonly string[];
};

export const emptyTally = (): DropTally => ({ columns: [], indexes: [], constraints: [] });

export const tallyTotal = (t: DropTally): number =>
  t.columns.length + t.indexes.length + t.constraints.length;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Footer line: `"Drops 1 index, 2 constraints"`. Empty when nothing is pending. */
export function dropSummary(t: DropTally): string {
  const parts: string[] = [];
  if (t.columns.length) parts.push(plural(t.columns.length, "column", "columns"));
  if (t.indexes.length) parts.push(plural(t.indexes.length, "index", "indexes"));
  if (t.constraints.length) parts.push(plural(t.constraints.length, "constraint", "constraints"));
  return parts.length ? `Drops ${parts.join(", ")}` : "";
}

/** Confirmation body: one line per kind, naming every object. */
export function dropLines(t: DropTally): string[] {
  const lines: string[] = [];
  if (t.columns.length) lines.push(`${t.columns.length === 1 ? "Column" : "Columns"}: ${t.columns.join(", ")}`);
  if (t.indexes.length) lines.push(`${t.indexes.length === 1 ? "Index" : "Indexes"}: ${t.indexes.join(", ")}`);
  if (t.constraints.length)
    lines.push(`${t.constraints.length === 1 ? "Constraint" : "Constraints"}: ${t.constraints.join(", ")}`);
  return lines;
}
