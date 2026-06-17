// Clipboard-paste planning for in-grid editing. Pure + vitest-covered.
//
// Two shapes of paste are supported, chosen automatically:
//   • header-mapped — the clipboard's first row matches the result's column names
//     (every non-empty header cell names an editable table column). Each remaining
//     row becomes a NEW insert row, values mapped to columns BY NAME (column order
//     in the clipboard is irrelevant). This is the "paste a labeled table" case.
//   • positional — otherwise. The block is written starting at the anchor cell,
//     left-to-right across the visible (display-order) columns and top-to-bottom
//     across rows; rows past the end of the loaded/insert data become NEW insert
//     rows. Existing cells in range are overwritten.
//
// Value rule (both modes): a present-but-empty cell pastes as SQL NULL; a cell that
// is absent because the row is shorter than the header/columns is omitted entirely
// (so the column keeps its server default on INSERT). Non-table / unmapped columns
// are skipped.

import type { PendingEdits } from "../tabs";

/** Stable identity of a grid row across the grid↔App boundary (never a virtual index). */
export type RowRef = { kind: "loaded"; i: number } | { kind: "insert"; i: number };

/** A new insert row, sparse: origColIdx -> value (null = explicit NULL; absent = omitted). */
export type InsertRow = Record<number, string | null>;

export type PastePlan = {
  mode: "mapped" | "positional";
  /** Edits to rows that already exist (loaded snapshot rows or existing insert rows). */
  updates: { ref: RowRef; col: number; val: string | null }[];
  /** New insert rows to append, in order. */
  inserts: InsertRow[];
  /** Data rows consumed (excludes a detected header row). */
  rowCount: number;
  /** Most columns written in any single row. */
  colCount: number;
};

/**
 * Parse clipboard text into a row/column grid. Delimiter is auto-detected: TAB when
 * any tab is present (Excel / another grid), else comma. Quoted fields (`"…"` with
 * `""` escaping, embedded delimiters/newlines) are honored for both delimiters —
 * spreadsheets quote tab/newline-bearing cells the same way.
 */
export function parseClipboardTable(text: string): string[][] {
  if (text === "") return [];
  const delim = text.includes("\t") ? "\t" : ",";
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let started = false; // any char seen on the current row (so a blank line is still a row)
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    started = false;
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      started = true;
      i++;
      continue;
    }
    if (ch === delim) {
      started = true;
      pushField();
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    started = true;
    i++;
  }
  if (started || field !== "" || row.length) pushRow();
  // Drop a single trailing empty row (the artifact of a terminating newline).
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
  return rows;
}

export type PlanPasteInput = {
  table: string[][];
  /** Result columns, original order. */
  resultColumns: string[];
  /** Per ORIGINAL column: belongs to the editable target table. */
  isTableCol: boolean[];
  /** ORIGINAL column indices in display (visible) order. */
  displayOrigCols: number[];
  /** Index into `displayOrigCols` where positional paste starts. */
  anchorDisplayIdx: number;
  /** Row the paste is anchored at (positional mode). */
  anchor: RowRef;
  /** Count of loaded snapshot rows. */
  nLoaded: number;
  /** Count of existing pending insert rows. */
  nInsExisting: number;
};

/** Normalize a parsed cell to a stored value: "" → NULL, otherwise the raw string. */
const cellValue = (s: string): string | null => (s === "" ? null : s);

/**
 * Decide header-mapped vs positional and produce the concrete edits. Never mutates
 * input; the caller merges `updates`/`inserts` into the tab's pending edits.
 */
export function planPaste(input: PlanPasteInput): PastePlan {
  const { table, resultColumns, isTableCol, displayOrigCols, anchorDisplayIdx, anchor, nLoaded, nInsExisting } = input;
  const updates: PastePlan["updates"] = [];

  // --- header-mapped: first row names editable columns, ≥1 data row follows ---
  if (table.length >= 2) {
    const lc = resultColumns.map((c) => c.toLowerCase());
    const header = table[0];
    // -2 = empty header cell (ignored), -1 = unmatched/non-table (disqualifies), ≥0 = column.
    const mapped = header.map((h) => {
      const t = h.trim().toLowerCase();
      if (t === "") return -2;
      const idx = lc.indexOf(t);
      return idx >= 0 && isTableCol[idx] ? idx : -1;
    });
    const named = mapped.filter((m) => m !== -2);
    if (named.length > 0 && named.every((m) => m >= 0)) {
      const inserts: InsertRow[] = [];
      for (let j = 1; j < table.length; j++) {
        const r = table[j];
        const ins: InsertRow = {};
        for (let k = 0; k < mapped.length; k++) {
          const col = mapped[k];
          if (col < 0 || k >= r.length) continue; // unmapped, or absent (→ default)
          ins[col] = cellValue(r[k]);
        }
        inserts.push(ins);
      }
      return { mode: "mapped", updates, inserts, rowCount: inserts.length, colCount: named.length };
    }
  }

  // --- positional: block written from the anchor cell ---
  const origColAt = (k: number): number => {
    const oc = displayOrigCols[anchorDisplayIdx + k];
    return oc !== undefined && isTableCol[oc] ? oc : -1;
  };
  const base = anchor.kind === "loaded" ? nLoaded : nInsExisting;
  const overflow = new Map<number, InsertRow>();
  let colCount = 0;
  for (let j = 0; j < table.length; j++) {
    const r = table[j];
    let wrote = 0;
    for (let k = 0; k < r.length; k++) {
      const col = origColAt(k);
      if (col < 0) continue;
      const val = cellValue(r[k]);
      const idx = anchor.i + j;
      if (idx < base) {
        updates.push({ ref: { kind: anchor.kind, i: idx }, col, val });
      } else {
        const o = idx - base;
        if (!overflow.has(o)) overflow.set(o, {});
        overflow.get(o)![col] = val;
      }
      wrote++;
    }
    colCount = Math.max(colCount, wrote);
  }
  const inserts: InsertRow[] = [];
  const maxO = overflow.size ? Math.max(...overflow.keys()) : -1;
  for (let o = 0; o <= maxO; o++) inserts.push(overflow.get(o) ?? {});
  return { mode: "positional", updates, inserts, rowCount: table.length, colCount };
}

/**
 * Merge a paste plan into the tab's pending edits, returning a NEW PendingEdits
 * (inputs untouched). Loaded-row updates that restore the original snapshot value
 * drop the pending entry (no no-op write); new insert rows are appended in order.
 */
export function mergePaste(
  pending: PendingEdits,
  plan: PastePlan,
  loadedRows: (string | null)[][],
): PendingEdits {
  const cells: PendingEdits["cells"] = { ...pending.cells };
  const inserts = pending.inserts.map((x) => ({ ...x }));
  for (const u of plan.updates) {
    if (u.ref.kind === "insert") {
      if (inserts[u.ref.i]) inserts[u.ref.i][u.col] = u.val;
    } else {
      const r = u.ref.i;
      const orig = loadedRows[r]?.[u.col] ?? null;
      const rowEdits = { ...(cells[r] ?? {}) };
      if (u.val === orig) delete rowEdits[u.col];
      else rowEdits[u.col] = u.val;
      if (Object.keys(rowEdits).length) cells[r] = rowEdits;
      else delete cells[r];
    }
  }
  inserts.push(...plan.inserts.map((x) => ({ ...x })));
  return { ...pending, cells, inserts };
}
