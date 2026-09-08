import { describe, expect, it } from "vitest";
import {
  addToGroup,
  allConditions,
  arityOf,
  assertWithinLimits,
  classResolver,
  classifyType,
  conditions,
  defaultOperatorFor,
  describeCondition,
  duplicateNode,
  emptyFilter,
  hasConditions,
  isComplete,
  makeCondition,
  makeGroup,
  normalizeFilters,
  operatorsFor,
  parseList,
  quickFilterOf,
  removeNode,
  setGroupOp,
  setQuickFilter,
  treeFromFlat,
  updateCondition,
  type FilterTree,
  MAX_CONDITIONS,
  MAX_VALUE_CHARS,
} from "./filterModel";

describe("classifyType", () => {
  it("maps engine type names to value classes", () => {
    for (const t of ["int", "int4", "integer", "bigint", "smallint", "numeric(10,2)", "decimal", "double precision", "real", "money", "tinyint", "mediumint", "serial", "bigserial", "float8", "NUMBER"])
      expect(classifyType(t)).toBe("number");
    for (const t of ["bool", "boolean", "BOOLEAN", " bool "]) expect(classifyType(t)).toBe("boolean");
    for (const t of ["date", "time", "timestamp", "timestamp with time zone", "timestamptz", "datetime", "datetime2", "smalldatetime", "year"])
      expect(classifyType(t)).toBe("datetime");
    for (const t of ["text", "varchar(20)", "character varying", "char", "nvarchar(max)", "citext", "string"])
      expect(classifyType(t)).toBe("text");
    for (const t of ["uuid", "jsonb", "bytea", "int[]", "geometry", "", null, undefined])
      expect(classifyType(t)).toBe("other");
  });

  it("classResolver matches names case-insensitively and defaults to other", () => {
    const cls = classResolver({ Total: "numeric", name: "text" });
    expect(cls("total")).toBe("number");
    expect(cls("NAME")).toBe("text");
    expect(cls("missing")).toBe("other");
    expect(classResolver(undefined)("anything")).toBe("other");
  });
});

describe("operator catalogue", () => {
  it("offers class-appropriate operators only", () => {
    const ids = (c: Parameters<typeof operatorsFor>[0]) => operatorsFor(c).map((o) => o.id);
    expect(ids("number")).toContain("between");
    expect(ids("number")).not.toContain("contains");
    expect(ids("text")).toContain("ilike");
    expect(ids("text")).toContain("isEmpty");
    expect(ids("boolean")).toEqual(["eq", "ne", "isTrue", "isFalse", "isNull", "isNotNull"]);
    expect(ids("datetime")).toContain("between");
    expect(ids("datetime")).not.toContain("startsWith");
    expect(ids("other")).toContain("contains");
  });

  it("knows arity and a sensible default per class", () => {
    expect(arityOf("between")).toBe(2);
    expect(arityOf("in")).toBe("list");
    expect(arityOf("isNull")).toBe(0);
    expect(arityOf("eq")).toBe(1);
    expect(defaultOperatorFor("text")).toBe("contains");
    expect(defaultOperatorFor("number")).toBe("eq");
    expect(defaultOperatorFor("boolean")).toBe("eq");
  });
});

describe("parseList", () => {
  it("splits on commas outside quotes", () => {
    expect(parseList("a, b ,c")).toEqual(["a", "b", "c"]);
    expect(parseList("'a,b', c")).toEqual(["a,b", "c"]);
    expect(parseList('"x, y", z')).toEqual(["x, y", "z"]);
    expect(parseList("' spaced ', trimmed ")).toEqual([" spaced ", "trimmed"]);
    expect(parseList("a,,b, ")).toEqual(["a", "b"]);
    expect(parseList("")).toEqual([]);
    expect(parseList("   ")).toEqual([]);
  });

  it("treats a doubled quote inside a quoted run as one quote", () => {
    expect(parseList("'o''brien', x")).toEqual(["o'brien", "x"]);
  });

  it("tolerates an unterminated quote", () => {
    expect(parseList("'abc")).toEqual(["abc"]);
  });
});

describe("completeness", () => {
  it("requires every value slot", () => {
    expect(isComplete(makeCondition("a", "isNull"))).toBe(true);
    expect(isComplete(makeCondition("a", "eq", []))).toBe(false);
    expect(isComplete(makeCondition("a", "eq", ["x"]))).toBe(true);
    expect(isComplete(makeCondition("a", "between", ["1"]))).toBe(false);
    expect(isComplete(makeCondition("a", "between", ["1", "2"]))).toBe(true);
    expect(isComplete(makeCondition("a", "in", [" , "]))).toBe(false);
    expect(isComplete(makeCondition("a", "in", ["1,2"]))).toBe(true);
  });

  it("an empty string is a real value only for zero-arity operators", () => {
    expect(isComplete(makeCondition("a", "eq", [""]))).toBe(false);
    expect(isComplete(makeCondition("a", "isEmpty", []))).toBe(true);
  });
});

describe("tree edits are pure", () => {
  const base = (): FilterTree => {
    const t = emptyFilter();
    return { ...t, items: [makeCondition("a", "eq", ["1"]), makeGroup("or", [makeCondition("b", "eq", ["2"])])] };
  };

  it("removeNode does not mutate the input", () => {
    const t = base();
    const id = t.items[0].id;
    const next = removeNode(t, id);
    expect(t.items.length).toBe(2);
    expect(next.items.length).toBe(1);
    expect(next.items[0].kind).toBe("group");
  });

  it("removes a nested condition by id", () => {
    const t = base();
    const group = t.items[1] as ReturnType<typeof makeGroup>;
    const next = removeNode(t, group.items[0].id);
    expect(conditions(next).map((c) => c.column)).toEqual(["a"]);
  });

  it("addToGroup appends to the named group, root otherwise", () => {
    const t = base();
    const group = t.items[1] as ReturnType<typeof makeGroup>;
    const nested = addToGroup(t, group.id, makeCondition("c", "eq", ["3"]));
    expect(conditions(nested).map((c) => c.column)).toEqual(["a", "b", "c"]);
    const rooted = addToGroup(t, "nope", makeCondition("d", "eq", ["4"]));
    expect(rooted.items.length).toBe(3);
  });

  it("duplicateNode inserts a fresh-id copy right after the original", () => {
    const t = base();
    const id = t.items[0].id;
    const next = duplicateNode(t, id);
    expect(next.items.length).toBe(3);
    expect(next.items[1].id).not.toBe(id);
    expect((next.items[1] as { column: string }).column).toBe("a");
  });

  it("setGroupOp / updateCondition patch in place", () => {
    const t = base();
    expect(setGroupOp(t, t.id, "or").op).toBe("or");
    const patched = updateCondition(t, t.items[0].id, { operator: "gt", values: ["9"] });
    expect(conditions(patched)[0].operator).toBe("gt");
    expect(conditions(t)[0].operator).toBe("eq");
  });

  it("removing the root yields an empty tree", () => {
    expect(removeNode(base(), "root").items).toEqual([]);
  });
});

describe("conditions / hasConditions", () => {
  it("counts only complete conditions", () => {
    const t: FilterTree = { ...emptyFilter(), items: [makeCondition("a", "eq", []), makeCondition("b", "eq", ["1"])] };
    expect(conditions(t).map((c) => c.column)).toEqual(["b"]);
    expect(allConditions(t).length).toBe(2);
    expect(hasConditions(t)).toBe(true);
    expect(hasConditions(emptyFilter())).toBe(false);
    expect(hasConditions({ ...emptyFilter(), items: [makeCondition("a", "eq", [])] })).toBe(false);
  });
});

describe("bounds", () => {
  it("rejects oversized trees and values", () => {
    const many: FilterTree = {
      ...emptyFilter(),
      items: Array.from({ length: MAX_CONDITIONS + 1 }, () => makeCondition("a", "eq", ["1"])),
    };
    expect(() => assertWithinLimits(many)).toThrow(/too many conditions/);
    const long: FilterTree = { ...emptyFilter(), items: [makeCondition("a", "eq", ["x".repeat(MAX_VALUE_CHARS + 1)])] };
    expect(() => assertWithinLimits(long)).toThrow(/too long/);
    let deep = makeGroup("and", [makeCondition("a", "eq", ["1"])]);
    for (let i = 0; i < 12; i++) deep = makeGroup("and", [deep]);
    expect(() => assertWithinLimits(deep)).toThrow(/nested too deeply/);
    expect(() => assertWithinLimits(emptyFilter())).not.toThrow();
  });
});

describe("migration + quick filters", () => {
  it("migrates the legacy flat filter shape without losing rules", () => {
    const t = treeFromFlat([{ col: 1, text: "abc" }, { col: 0, text: "  " }, { col: 9, text: "gone" }], ["id", "name"]);
    expect(t.op).toBe("and");
    expect(conditions(t).map((c) => [c.column, c.operator, c.values[0]])).toEqual([["name", "contains", "abc"]]);
  });

  it("normalizeFilters accepts flat arrays, trees, and junk", () => {
    expect(conditions(normalizeFilters([{ col: 0, text: "x" }], ["id"]))[0].column).toBe("id");
    const tree = normalizeFilters({ kind: "group", op: "or", items: [{ column: "a", operator: "gt", values: ["1"] }] });
    expect(tree.op).toBe("or");
    expect(conditions(tree)[0].operator).toBe("gt");
    expect(normalizeFilters(null).items).toEqual([]);
    expect(normalizeFilters("nope").items).toEqual([]);
    expect(normalizeFilters([{ nonsense: true }]).items).toEqual([]);
    // A bare condition object is promoted into a root AND.
    const promoted = normalizeFilters({ column: "a", operator: "eq", values: ["1"] });
    expect(promoted.op).toBe("and");
    expect(conditions(promoted).length).toBe(1);
    // An unknown operator degrades to the quick-filter contains rather than dropping.
    expect(conditions(normalizeFilters({ column: "a", operator: "hack", values: ["1"] }))[0].operator).toBe("contains");
  });

  it("quick filters read and write top-level contains conditions only", () => {
    let t = emptyFilter();
    t = setQuickFilter(t, "name", "abc");
    expect(quickFilterOf(t, "name")).toBe("abc");
    t = setQuickFilter(t, "name", "def");
    expect(t.items.length).toBe(1);
    expect(quickFilterOf(t, "name")).toBe("def");
    t = setQuickFilter(t, "name", "  ");
    expect(t.items.length).toBe(0);
    expect(quickFilterOf(t, "name")).toBe("");
  });

  it("a quick filter leaves builder conditions on the same column alone", () => {
    let t: FilterTree = { ...emptyFilter(), items: [makeCondition("name", "startsWith", ["z"])] };
    t = setQuickFilter(t, "name", "abc");
    expect(t.items.length).toBe(2);
    t = setQuickFilter(t, "name", "");
    expect(conditions(t).map((c) => c.operator)).toEqual(["startsWith"]);
  });

  it("a nested contains condition is not a quick filter", () => {
    const t: FilterTree = { ...emptyFilter(), items: [makeGroup("or", [makeCondition("name", "contains", ["x"])])] };
    expect(quickFilterOf(t, "name")).toBe("");
  });
});

describe("describeCondition", () => {
  it("renders readable chip labels per arity", () => {
    expect(describeCondition(makeCondition("qty", "isNull"))).toBe("qty is null");
    expect(describeCondition(makeCondition("qty", "ge", ["5"]))).toBe("qty ≥ 5");
    expect(describeCondition(makeCondition("qty", "between", ["1", "9"]))).toBe("qty between 1 and 9");
    expect(describeCondition(makeCondition("id", "in", ["1, 2,3"]))).toBe("id in (1, 2, 3)");
  });
});
