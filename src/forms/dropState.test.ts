import { describe, expect, it } from "vitest";
import {
  dropCount,
  dropLines,
  dropSummary,
  droppedNames,
  emptyTally,
  isDropped,
  sectionLabel,
  setDropped,
  tallyTotal,
  toggleDropped,
} from "./dropState";

describe("drop set", () => {
  it("starts empty and marks one name", () => {
    const a = {};
    expect(isDropped(a, "ix_a")).toBe(false);
    const b = setDropped(a, "ix_a", true);
    expect(isDropped(b, "ix_a")).toBe(true);
    // The original is untouched — the state is a value, not a mutable record.
    expect(isDropped(a, "ix_a")).toBe(false);
  });

  it("keeping removes the key rather than storing false", () => {
    const dropped = setDropped({}, "ix_a", true);
    const kept = setDropped(dropped, "ix_a", false);
    expect(isDropped(kept, "ix_a")).toBe(false);
    expect(Object.keys(kept)).toEqual([]);
  });

  it("returns the same object when nothing changes", () => {
    const s = setDropped({}, "ix_a", true);
    expect(setDropped(s, "ix_a", true)).toBe(s);
    expect(setDropped(s, "ix_b", false)).toBe(s);
  });

  it("toggles both ways", () => {
    let s = toggleDropped({}, "c1");
    expect(isDropped(s, "c1")).toBe(true);
    s = toggleDropped(s, "c1");
    expect(isDropped(s, "c1")).toBe(false);
    s = toggleDropped(s, "c1");
    expect(isDropped(s, "c1")).toBe(true);
  });

  it("lists dropped names in the section's order, not insertion order", () => {
    let s = setDropped({}, "z", true);
    s = setDropped(s, "a", true);
    expect(droppedNames(s, ["a", "m", "z"])).toEqual(["a", "z"]);
    expect(dropCount(s, ["a", "m", "z"])).toBe(2);
  });

  it("ignores names the section no longer lists", () => {
    const s = setDropped({}, "gone", true);
    expect(droppedNames(s, ["a", "b"])).toEqual([]);
    expect(dropCount(s, ["a", "b"])).toBe(0);
  });
});

describe("section label", () => {
  it("is the bare label with nothing pending", () => {
    expect(sectionLabel("Constraints", 0)).toBe("Constraints");
  });
  it("counts the pending drops", () => {
    expect(sectionLabel("Constraints", 2)).toBe("Constraints (2 to drop)");
    expect(sectionLabel("Indexes", 1)).toBe("Indexes (1 to drop)");
  });
});

describe("dropSummary", () => {
  it("is empty with nothing pending", () => {
    expect(dropSummary(emptyTally())).toBe("");
    expect(tallyTotal(emptyTally())).toBe(0);
  });

  it("names the kinds in a fixed order and pluralises each", () => {
    expect(dropSummary({ columns: [], indexes: ["ix"], constraints: ["a", "b"] })).toBe(
      "Drops 1 index, 2 constraints",
    );
    expect(dropSummary({ columns: ["c"], indexes: [], constraints: [] })).toBe("Drops 1 column");
    expect(dropSummary({ columns: ["c", "d"], indexes: ["i", "j"], constraints: ["k"] })).toBe(
      "Drops 2 columns, 2 indexes, 1 constraint",
    );
  });

  it("totals every kind", () => {
    expect(tallyTotal({ columns: ["c"], indexes: ["i"], constraints: ["k", "l"] })).toBe(4);
  });
});

describe("dropLines", () => {
  it("names every object, one line per kind", () => {
    expect(dropLines({ columns: [], indexes: ["ix_a"], constraints: ["c1", "c2"] })).toEqual([
      "Index: ix_a",
      "Constraints: c1, c2",
    ]);
  });
  it("is empty with nothing pending", () => {
    expect(dropLines(emptyTally())).toEqual([]);
  });
});
