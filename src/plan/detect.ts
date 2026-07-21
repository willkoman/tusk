import { type ParsedPlan } from "./types";
import { parsePg } from "./parsePg";
import { parsePgText } from "./parsePgText";
import { parseMysql } from "./parseMysql";
import { parseSqlite } from "./parseSqlite";
import { parseDuck } from "./parseDuck";

// Single entry: decide whether a finished result is an EXPLAIN output and, if
// so, produce the best ParsedPlan for it. Returns null for "not a plan — show
// the grid" (incl. SQLite bytecode EXPLAIN and MySQL tabular EXPLAIN, which
// genuinely read better as a table). The leading-keyword gate makes this free
// for normal results.

const LEAD_COMMENTS = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/;

export function isExplainQuery(sql: string): boolean {
  return /^explain\b/i.test(sql.replace(LEAD_COMMENTS, ""));
}

type Snap = { lastQuery: string; columns: string[]; rows: (string | null)[][] };
const MAX_PLAN_INPUT_CHARS = 5_000_000;
const MAX_PLAN_TEXT_CHARS = 1_000_000;

/** Join a result's cells line-wise — the universal styled-text fallback. */
function textOf(rows: (string | null)[][], colIndex?: number): string {
  let out = "";
  outer: for (const row of rows) {
    const cells = colIndex !== undefined ? [row[colIndex] ?? ""] : row;
    for (let i = 0; i < cells.length; i++) {
      const prefix = i ? "  " : out ? "\n" : "";
      if (MAX_PLAN_TEXT_CHARS - out.length <= prefix.length) break outer;
      out += prefix;
      out += (cells[i] ?? "").slice(0, MAX_PLAN_TEXT_CHARS - out.length);
      if (out.length >= MAX_PLAN_TEXT_CHARS) break outer;
    }
  }
  return out.length >= MAX_PLAN_TEXT_CHARS ? `${out}\n… plan text truncated` : out;
}

function inputWithinLimit(rows: (string | null)[][]): boolean {
  let chars = 0;
  for (const row of rows) for (const cell of row) {
    chars += cell?.length ?? 0;
    if (chars > MAX_PLAN_INPUT_CHARS) return false;
  }
  return true;
}

function firstJsonCell(columns: string[], rows: (string | null)[][]): string | null {
  // EXPLAIN JSON arrives as one cell, but pretty-printed JSON can also be split
  // across rows of a single column — join the column and test the head.
  for (let c = 0; c < columns.length; c++) {
    const joined = rows.map((r) => r[c] ?? "").join("\n").trim();
    if (joined.startsWith("[") || joined.startsWith("{")) return joined;
  }
  return null;
}

export function detectPlan(engine: string | null | undefined, snap: Snap): ParsedPlan | null {
  if (!snap.rows.length || !snap.columns.length) return null;
  if (!isExplainQuery(snap.lastQuery)) return null;
  if (!inputWithinLimit(snap.rows)) return { kind: "text", text: textOf(snap.rows) };

  try {
    switch (engine) {
    case "sqlite": {
      const tree = parseSqlite(snap.columns, snap.rows);
      return tree; // bytecode EXPLAIN → null → grid (a listing, not a tree)
    }
    case "mysql": {
      if (snap.columns.length > 2) return null; // tabular EXPLAIN → grid is the right view
      const json = firstJsonCell(snap.columns, snap.rows);
      if (json) {
        const tree = parseMysql(json);
        if (tree) return tree;
      }
      return { kind: "text", text: textOf(snap.rows, 0) }; // EXPLAIN ANALYZE tree text etc.
    }
    case "duckdb": {
      const json = firstJsonCell(snap.columns, snap.rows);
      if (json) {
        const tree = parseDuck(json);
        if (tree) return tree;
      }
      // Box-art text: the plan body lives in the last column (explain_value).
      return { kind: "text", text: textOf(snap.rows, snap.columns.length - 1) };
    }
    default: {
      // postgres (and unknown engines that reached here via an EXPLAIN query)
      if (snap.columns.length !== 1) return null;
      const json = firstJsonCell(snap.columns, snap.rows);
      if (json) {
        const tree = parsePg(json);
        if (tree) return tree;
      }
      const lines = snap.rows.map((r) => r[0] ?? "");
      return parsePgText(lines) ?? { kind: "text", text: textOf(snap.rows, 0) };
    }
    }
  } catch {
    // Provider/database-controlled plan payloads must never take down the workbench.
    return { kind: "text", text: textOf(snap.rows) };
  }
}
