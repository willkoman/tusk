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
  hiddenRuleCount,
  isComplete,
  isGroup,
  makeCondition,
  makeGroup,
  operatorsFor,
  parseList,
  quickFilterOf,
  removeNode,
  setGroupOp,
  setQuickFilter,
  updateCondition,
  type Condition,
  type FilterGroup,
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

describe("quick filters", () => {
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

  it("typing under an OR root re-roots as AND instead of widening the result", () => {
    // The header row means "AND this too". Appending into an OR root would make
    // every row matching the new text match the whole filter.
    const or: FilterTree = {
      ...emptyFilter(),
      op: "or",
      items: [makeCondition("qty", "gt", ["10"]), makeCondition("qty", "lt", ["2"])],
    };
    const t = setQuickFilter(or, "name", "abc");
    expect(t.op).toBe("and");
    expect(t.items.length).toBe(2);
    expect(isGroup(t.items[0])).toBe(true);
    expect((t.items[0] as FilterGroup).op).toBe("or");
    expect((t.items[0] as FilterGroup).items.length).toBe(2);
    expect(quickFilterOf(t, "name")).toBe("abc");
    // Nothing was lost: both original rules still render.
    expect(conditions(t).length).toBe(3);
    // A second quick filter simply joins the (now AND) root.
    const t2 = setQuickFilter(t, "qty", "9");
    expect(t2.op).toBe("and");
    expect(t2.items.length).toBe(3);
  });

  it("an empty OR root becomes AND rather than nesting an empty group", () => {
    const or: FilterTree = { ...emptyFilter(), op: "or" };
    const t = setQuickFilter(or, "name", "x");
    expect(t.op).toBe("and");
    expect(t.items.length).toBe(1);
  });

  it("hiddenRuleCount reports rules the one-line box cannot show", () => {
    const t: FilterTree = {
      ...emptyFilter(),
      items: [
        makeCondition("name", "contains", ["abc"]), // the quick filter itself
        makeCondition("name", "startsWith", ["z"]), // top level, other operator
        makeGroup("or", [makeCondition("name", "eq", ["q"]), makeCondition("qty", "gt", ["1"])]),
        makeCondition("qty", "eq", []), // incomplete — contributes no SQL
      ],
    };
    expect(hiddenRuleCount(t, "name")).toBe(2);
    expect(hiddenRuleCount(t, "qty")).toBe(1);
    expect(hiddenRuleCount(t, "absent")).toBe(0);
    expect(hiddenRuleCount(emptyFilter(), "name")).toBe(0);
  });
});

describe("tree edits are pure rebuilds", () => {
  // The FilterBuilder must therefore render its rows with `<Index>`: `<For>`
  // reconciles by reference, so it would dispose and recreate the input being
  // typed into on every keystroke.
  it("an edit replaces the condition AND every enclosing group object", () => {
    const inner = makeGroup("or", [makeCondition("name", "eq", ["a"])]);
    const root: FilterTree = { ...emptyFilter(), items: [inner] };
    const target = (inner.items[0] as Condition).id;
    const next = updateCondition(root, target, { values: ["ab"] });
    expect(next).not.toBe(root);
    expect(next.items[0]).not.toBe(inner);
    expect((next.items[0] as FilterGroup).items[0]).not.toBe(inner.items[0]);
    expect(((next.items[0] as FilterGroup).items[0] as Condition).id).toBe(target);
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
