import { describe, expect, it } from "vitest";
import {
  applyRememberedExportOptions,
  defaultExportOptions,
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
