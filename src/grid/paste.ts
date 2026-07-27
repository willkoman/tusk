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

const MAX_CLIPBOARD_CHARS = 10_000_000;
const MAX_CLIPBOARD_ROWS = 50_000;
const MAX_CLIPBOARD_COLS = 10_000;
const MAX_CLIPBOARD_CELLS = 250_000;
const MAX_CLIPBOARD_FIELD_CHARS = 1_000_000;

/**
 * Parse clipboard text into a row/column grid. Delimiter is auto-detected: TAB when
 * any tab is present (Excel / another grid), else comma. Quoted fields (`"…"` with
 * `""` escaping, embedded delimiters/newlines) are honored for both delimiters —
 * spreadsheets quote tab/newline-bearing cells the same way. Quotes are meaningful
 * only at FIELD START (Excel-style): a bare `"` mid-field is literal data, so
 * external clipboards like `5" pipe<TAB>x` paste instead of erroring.
 */
export function parseClipboardTable(text: string): string[][] {
  if (text === "") return [];
  if (text.length > MAX_CLIPBOARD_CHARS) throw new Error("clipboard data exceeds 10,000,000 characters");
  // A quote toggles "inside a quoted field" only when it can open one — at text
  // start or right after a field/row boundary. A quote glued to data (`5"`) is
  // literal and must not hide a real tab from delimiter detection.
  let sniffQuoted = false;
  let hasUnquotedTab = false;
  let prev = "";
  for (let d = 0; d < text.length; d++) {
    const ch = text[d];
    if (sniffQuoted) {
      if (ch === '"') {
        if (text[d + 1] === '"') d++;
        else sniffQuoted = false;
      }
    } else if (ch === '"' && (d === 0 || prev === "\t" || prev === "\n" || prev === "\r" || prev === ",")) {
      sniffQuoted = true;
    } else if (ch === "\t") {
      hasUnquotedTab = true;
      break;
    }
    prev = text[d];
  }
  const delim = hasUnquotedTab ? "\t" : ",";
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let afterQuote = false;
  let fieldStarted = false;
  let cells = 0;
  let i = 0;
  const pushField = () => {
    if (row.length >= MAX_CLIPBOARD_COLS) throw new Error("clipboard data has too many columns");
    row.push(field);
    field = "";
    fieldStarted = false;
    afterQuote = false;
  };
  const pushRow = () => {
    if (rows.length >= MAX_CLIPBOARD_ROWS) throw new Error("clipboard data has too many rows");
    pushField();
    cells += row.length;
    if (cells > MAX_CLIPBOARD_CELLS) throw new Error("clipboard data has too many cells");
    rows.push(row);
    row = [];
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
        afterQuote = true;
        i++;
        continue;
      }
      field += ch;
      if (field.length > MAX_CLIPBOARD_FIELD_CHARS) throw new Error("clipboard field is too large");
      i++;
      continue;
    }
    if (ch === '"') {
      if (!fieldStarted && field.length === 0) {
        inQuotes = true;
        fieldStarted = true;
        i++;
        continue;
      }
      // Bare quote mid-field (or trailing a closed quote) is literal data —
      // external clipboards are not strict CSV, and rejecting loses the paste.
      field += ch;
      if (field.length > MAX_CLIPBOARD_FIELD_CHARS) throw new Error("clipboard field is too large");
      fieldStarted = true;
      afterQuote = false;
      i++;
      continue;
    }
    if (ch === delim) {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r") {
      pushRow();
      i += text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    if (field.length > MAX_CLIPBOARD_FIELD_CHARS) throw new Error("clipboard field is too large");
    fieldStarted = true;
    i++;
  }
  if (inQuotes) throw new Error("clipboard data has an unterminated quoted field");
  if (fieldStarted || afterQuote || field !== "" || row.length) pushRow();
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
  /** Canonical loaded-row indices in current display order (identity when absent). */
  loadedOrder?: number[];
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
  if (!Number.isInteger(nLoaded) || nLoaded < 0 || !Number.isInteger(nInsExisting) || nInsExisting < 0)
    throw new Error("paste row identity is invalid");
  if (isTableCol.length !== resultColumns.length)
    throw new Error("paste column metadata no longer matches the result");
  if (table.length > MAX_CLIPBOARD_ROWS) throw new Error("clipboard data has too many rows");
  let inputCells = 0;
  for (const row of table) {
    if (row.length > MAX_CLIPBOARD_COLS) throw new Error("clipboard data has too many columns");
    inputCells += row.length;
    if (inputCells > MAX_CLIPBOARD_CELLS) throw new Error("clipboard data has too many cells");
  }
  const updates: PastePlan["updates"] = [];

  // --- header-mapped: first row names editable columns, ≥1 data row follows ---
  if (table.length >= 2) {
    const byName = new Map<string, number[]>();
    resultColumns.forEach((column, i) => {
      const key = column.toLowerCase();
      byName.set(key, [...(byName.get(key) ?? []), i]);
    });
    const header = table[0];
    // -2 = empty header cell (ignored), -1 = unmatched/non-table (disqualifies), ≥0 = column.
    const mapped = header.map((h) => {
      const t = h.trim().toLowerCase();
      if (t === "") return -2;
      const matches = (byName.get(t) ?? []).filter((i) => isTableCol[i]);
      return matches.length === 1 ? matches[0] : -1;
    });
    const named = mapped.filter((m) => m !== -2);
    if (named.length > 0 && named.every((m) => m >= 0)) {
      if (new Set(named).size !== named.length)
        throw new Error("clipboard header maps the same result column more than once");
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
  const loadedOrder = input.loadedOrder ?? Array.from({ length: nLoaded }, (_, i) => i);
  if (
    loadedOrder.length !== nLoaded ||
    new Set(loadedOrder).size !== nLoaded ||
    loadedOrder.some((i) => !Number.isInteger(i) || i < 0 || i >= nLoaded)
  ) throw new Error("paste row order no longer matches the loaded result");
  const loadedAnchor = anchor.kind === "loaded" ? loadedOrder.indexOf(anchor.i) : -1;
  if (anchor.kind === "loaded" && loadedAnchor < 0) throw new Error("paste anchor row is no longer loaded");
  if (anchor.kind === "insert" && (!Number.isInteger(anchor.i) || anchor.i < 0 || anchor.i > nInsExisting))
    throw new Error("paste anchor insert row no longer exists");
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
      const displayIdx = anchor.kind === "loaded" ? loadedAnchor + j : anchor.i + j;
      if (displayIdx >= 0 && displayIdx < base) {
        const idx = anchor.kind === "loaded" ? loadedOrder[displayIdx] : displayIdx;
        if (idx !== undefined) updates.push({ ref: { kind: anchor.kind, i: idx }, col, val });
      } else {
        const o = Math.max(0, displayIdx - base);
        if (!overflow.has(o)) overflow.set(o, {});
        overflow.get(o)![col] = val;
      }
      wrote++;
    }
    colCount = Math.max(colCount, wrote);
  }
  const inserts: InsertRow[] = [];
  let maxO = -1;
  for (const o of overflow.keys()) if (o > maxO) maxO = o;
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
      if (!inserts[u.ref.i]) throw new Error("paste target insert row no longer exists");
      inserts[u.ref.i][u.col] = u.val;
    } else {
      const r = u.ref.i;
      if (!loadedRows[r] || u.col < 0 || u.col >= loadedRows[r].length)
        throw new Error("paste target loaded cell no longer exists");
      const orig = loadedRows[r][u.col];
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
