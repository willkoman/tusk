import { describe, it, expect } from "vitest";
import {
  cellTitle,
  columnRenders,
  displayText,
  looksJson,
  prettyJson,
  typeBadge,
  MAX_CELL_TEXT,
} from "./cellRender";

const noTypes = () => undefined;
const noBools = () => false;

describe("typeBadge", () => {
  it("shortens the long SQL spellings", () => {
    expect(typeBadge("character varying(255)")).toBe("varchar");
    expect(typeBadge("timestamp with time zone")).toBe("timestamptz");
    expect(typeBadge("double precision")).toBe("float8");
    expect(typeBadge("integer")).toBe("int");
    expect(typeBadge("boolean")).toBe("bool");
  });

  it("keeps array markers and drops precision", () => {
    expect(typeBadge("numeric(10,2)")).toBe("numeric");
    expect(typeBadge("text[]")).toBe("text[]");
  });

  it("caps a very long type name", () => {
    expect(typeBadge("supercalifragilistic")).toBe("supercalifra");
  });

  it("is empty for an empty type", () => {
    expect(typeBadge("   ")).toBe("");
  });
});

describe("looksJson / prettyJson", () => {
  it("accepts objects and arrays only", () => {
    expect(looksJson('{"a":1}')).toBe(true);
    expect(looksJson("[1, 2]")).toBe(true);
    expect(looksJson("42")).toBe(false);
    expect(looksJson('"a string"')).toBe(false);
    expect(looksJson("{not json}")).toBe(false);
  });

  it("pretty-prints and returns null for non-JSON", () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson("hello")).toBeNull();
  });
});

describe("displayText / cellTitle", () => {
  it("passes short values through untouched", () => {
    expect(displayText("abc")).toEqual({ text: "abc", truncated: false });
    expect(cellTitle("abc")).toBe("");
  });

  it("elides long values and offers a bounded tooltip", () => {
    const long = "x".repeat(MAX_CELL_TEXT + 500);
    const shown = displayText(long);
    expect(shown.truncated).toBe(true);
    expect(shown.text.length).toBe(MAX_CELL_TEXT + 1);
    const title = cellTitle(long, 100);
    expect(title.length).toBe(101);
    expect(cellTitle(null)).toBe("");
  });
});

describe("columnRenders", () => {
  it("uses the driver type when it is known", () => {
    const out = columnRenders(
      ["id", "name", "created", "doc", "ok"],
      [["1", "a", "2024-01-01", "{}", "t"]],
      (i) => ["integer", "text", "timestamp with time zone", "jsonb", "boolean"][i],
      (i) => i === 4,
    );
    expect(out.map((r) => r.cls)).toEqual(["number", "text", "datetime", "json", "boolean"]);
    expect(out.map((r) => r.badge)).toEqual(["int", "text", "timestamptz", "jsonb", "bool"]);
    expect(out.every((r) => !r.inferred)).toBe(true);
  });

  it("infers numbers from values when no type is known", () => {
    const out = columnRenders(["n"], [["1"], ["2.5"], [null]], noTypes, noBools);
    expect(out[0]).toEqual({ cls: "number", badge: "num", badgeTitle: "numeric values", inferred: true });
  });

  it("keeps a column with one non-numeric value on text", () => {
    const out = columnRenders(["n"], [["1"], ["oops"]], noTypes, noBools);
    expect(out[0].cls).toBe("text");
    expect(out[0].badge).toBe("");
  });

  it("infers JSON only when every sampled value is JSON", () => {
    expect(columnRenders(["d"], [['{"a":1}'], ["[2]"]], noTypes, noBools)[0].cls).toBe("json");
    expect(columnRenders(["d"], [['{"a":1}'], ["plain"]], noTypes, noBools)[0].cls).toBe("text");
  });

  it("uses the grid's boolean detection when there is no type", () => {
    const out = columnRenders(["flag"], [["t"], ["f"]], noTypes, () => true);
    expect(out[0].cls).toBe("boolean");
    expect(out[0].inferred).toBe(true);
  });

  it("samples only the head of a large result", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => [String(i)]);
    rows[4999] = ["not a number"];
    expect(columnRenders(["n"], rows, noTypes, noBools, 100)[0].cls).toBe("number");
  });

  it("classifies an all-NULL column as text", () => {
    expect(columnRenders(["x"], [[null], [null]], noTypes, noBools)[0].cls).toBe("text");
  });
});
