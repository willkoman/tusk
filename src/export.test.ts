import { describe, expect, it } from "vitest";
import {
  applyRememberedExportOptions,
  defaultExportOptions,
  EXPORT_CHUNK_LIMITS,
  exportRowsInChunks,
  rowChunks,
  rememberableExportOptions,
  sanitizeSheetName,
  tablesExportOptions,
} from "./export";

describe("Excel sheet names", () => {
  // PARITY PAIR with `sanitize_sheet` in src-tauri/src/export.rs, asserted there by
  // `sheet_names_are_sanitized_not_rejected`.
  it("replaces the characters Excel forbids and bounds the length", () => {
    expect(sanitizeSheetName("2024/Q1")).toBe("2024_Q1");
    expect(sanitizeSheetName("a[b]c:d*e?f/g\\h")).toBe("a_b_c_d_e_f_g_h");
    expect(sanitizeSheetName("x".repeat(40))).toBe("x".repeat(26));
    expect(sanitizeSheetName("")).toBe("Sheet1");
  });

  it("is applied to the default derived from the relation name", () => {
    // A table named `2024/Q1` used to fail EVERY export format, because the backend
    // validated the sheet name before it looked at the format.
    expect(defaultExportOptions("2024/Q1").xlsx.sheetName).toBe("2024_Q1");
  });
});

describe("remembered export options", () => {
  it("never restores Include CREATE TABLE", () => {
    const on = { ...defaultExportOptions("t"), format: "sql" as const };
    on.sql.includeCreate = true;
    const stored = rememberableExportOptions(on);
    expect(stored["sql.includeCreate"]).toBeUndefined();
    // Restoring it would re-tick the box without re-fetching the table's DDL, silently
    // writing the synthetic all-text CREATE with none of the promised note.
    const restored = applyRememberedExportOptions(defaultExportOptions("t"), {
      ...stored,
      "sql.includeCreate": true,
    });
    expect(restored.sql.includeCreate).toBe(false);
    expect(stored["sql.multiRow"]).toBe(false);
  });
});

describe("multi-table export options", () => {
  it("resets everything the tables dialog cannot show", () => {
    const remembered = {
      csv: {
        delimiter: "pipe",
        customDelimiter: ";",
        quote: "always",
        quoteChar: "'",
        nullMode: "custom",
        nullText: "\\N",
        lineEnding: "crlf",
        bom: true,
        header: false,
      },
    };
    const out = tablesExportOptions("csv", remembered);
    const defaults = defaultExportOptions("");
    // Exposed by the dialog, so remembered values still apply.
    expect(out.delimiter).toBe("pipe");
    expect(out.bom).toBe(true);
    expect(out.header).toBe(false);
    // Not exposed: a silently inherited setting would apply to every written file.
    expect(out.quote).toBe(defaults.quote);
    expect(out.quoteChar).toBe(defaults.quoteChar);
    expect(out.lineEnding).toBe(defaults.lineEnding);
    expect(out.nullMode).toBe(defaults.nullMode);
    expect(out.nullText).toBe(defaults.nullText);
    expect(out.sql.includeCreate).toBe(false);
  });

  it("falls back to the default delimiter when a custom one was remembered", () => {
    const out = tablesExportOptions("csv", { csv: { delimiter: "custom", customDelimiter: "~" } });
    expect(out.delimiter).toBe("comma");
    expect(out.customDelimiter).toBe("");
  });
});

describe("loaded-row export in chunks", () => {
  const limits = { maxRows: 3, maxCells: 100, maxUnits: 10 };

  it("keeps every row, in order, and bounds each chunk", () => {
    const rows = Array.from({ length: 8 }, (_, i) => [String(i), null]);
    const chunks = [...rowChunks(rows, limits)];
    expect(chunks.map((c) => c.length)).toEqual([3, 3, 2]);
    expect(chunks.flat()).toEqual(rows);
  });

  it("splits on text size and cell count, and sends an oversized row alone", () => {
    const rows = [["aaaa"], ["bbbb"], ["cccc"], ["x".repeat(25)], ["d"]];
    expect([...rowChunks(rows, limits)].map((c) => c.length)).toEqual([2, 1, 1, 1]);
    const wide = [Array(60).fill("1"), Array(60).fill("2")];
    expect([...rowChunks(wide, { ...limits, maxUnits: 1_000 })].map((c) => c.length)).toEqual([1, 1]);
    expect([...rowChunks([], limits)]).toEqual([]);
  });

  it("the default limits fit the backend's 64 MiB per message even in the worst UTF-8 case", () => {
    expect(EXPORT_CHUNK_LIMITS.maxUnits * 3).toBeLessThan(64 * 1024 * 1024);
    expect(EXPORT_CHUNK_LIMITS.maxRows).toBeLessThanOrEqual(200_000);
    expect(EXPORT_CHUNK_LIMITS.maxCells).toBeLessThanOrEqual(2_000_000);
  });

  it("drives begin, one append per chunk, then finish", async () => {
    const calls: string[] = [];
    const io = {
      begin: async () => { calls.push("begin"); return 7; },
      append: async (s: number, rows: (string | null)[][]) => { calls.push(`append ${s} ${rows.length}`); },
      finish: async (s: number, abort: boolean) => { calls.push(`finish ${s} ${abort}`); return 8; },
    };
    const rows = Array.from({ length: 8 }, (_, i) => [String(i)]);
    expect(await exportRowsInChunks(io, rows, limits)).toBe(8);
    expect(calls).toEqual(["begin", "append 7 3", "append 7 3", "append 7 2", "finish 7 false"]);
  });

  it("abandons the session when a chunk fails", async () => {
    const calls: string[] = [];
    const io = {
      begin: async () => 1,
      append: async () => { calls.push("append"); throw new Error("an export value exceeds the 1 MiB limit"); },
      finish: async (_s: number, abort: boolean) => { calls.push(`finish ${abort}`); return 0; },
    };
    await expect(exportRowsInChunks(io, [["a"]], limits)).rejects.toThrow("1 MiB");
    expect(calls).toEqual(["append", "finish true"]);
  });
});
