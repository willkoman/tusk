import { afterEach, describe, expect, it } from "vitest";
import { renderCondition, renderWhere, activeConditionCount } from "./filterSql";
import {
  classResolver,
  emptyFilter,
  makeCondition,
  makeGroup,
  type FilterOperator,
  type FilterTree,
} from "./filterModel";
import { setSqlDialect } from "../sql/ident";

afterEach(() => setSqlDialect("postgres"));

// MSSQL is staged: its driver lands on another branch, so `ident` still emits
// double quotes for it here. Everything filterSql itself decides (ILIKE mapping,
// boolean literals, text casts) already has its branch.
const DIALECTS = ["postgres", "duckdb", "sqlite", "mysql", "mssql"] as const;
type D = (typeof DIALECTS)[number];

const COLUMNS = ["id", "name", "qty", "flag", "made_at"];
const CLASS_OF = classResolver({ id: "int4", name: "text", qty: "numeric", flag: "boolean", made_at: "timestamp" });

const hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");
const id = (d: D, n: string) =>
  d === "mysql" ? `\`${n}\`` : d === "mssql" ? `[${n.replace(/]/g, "]]")}]` : `"${n}"`;
const str = (d: D, s: string) => {
  if (d === "mysql") return s === "" ? "''" : `_utf8mb4 X'${hex(s)}'`;
  if (d === "mssql") return `N'${s.replace(/'/g, "''")}'`;
  if (d === "postgres" && s.includes("\\")) return `E'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  return `'${s.replace(/'/g, "''")}'`;
};
const cast = (d: D, n: string) => {
  const q = id(d, n);
  if (d === "mysql") return `CAST(${q} AS CHAR)`;
  if (d === "sqlite") return `CAST(${q} AS TEXT)`;
  if (d === "mssql") return `CAST(${q} AS VARCHAR(MAX))`;
  return `${q}::text`;
};
const ci = (d: D, expr: string, pattern: string, tail = "") => {
  if (d === "postgres" || d === "duckdb") return `${expr} ILIKE ${pattern}${tail}`;
  if (d === "mysql" || d === "sqlite") return `${expr} LIKE ${pattern}${tail}`;
  return `LOWER(${expr}) LIKE LOWER(${pattern})${tail}`;
};

function render(d: D, op: FilterOperator, column: string, values: string[] = [], columns = COLUMNS): string {
  setSqlDialect(d);
  return renderCondition(makeCondition(column, op, values), { columns, dialect: d, classOf: CLASS_OF });
}

describe("comparison operators across every dialect", () => {
  it("emits quoted identifiers and typed literals", () => {
    for (const d of DIALECTS) {
      expect(render(d, "eq", "name", ["abc"])).toBe(`${id(d, "name")} = ${str(d, "abc")}`);
      expect(render(d, "ne", "name", ["abc"])).toBe(`${id(d, "name")} <> ${str(d, "abc")}`);
      expect(render(d, "lt", "qty", ["5"])).toBe(`${id(d, "qty")} < 5`);
      expect(render(d, "le", "qty", ["5"])).toBe(`${id(d, "qty")} <= 5`);
      expect(render(d, "gt", "qty", ["5"])).toBe(`${id(d, "qty")} > 5`);
      expect(render(d, "ge", "qty", ["-2.5e3"])).toBe(`${id(d, "qty")} >= -2.5e3`);
    }
  });

  it("only strictly numeric text is emitted unquoted for number columns", () => {
    for (const d of DIALECTS) {
      expect(render(d, "eq", "qty", ["12"])).toBe(`${id(d, "qty")} = 12`);
      expect(render(d, "eq", "qty", [" 12 "])).toBe(`${id(d, "qty")} = 12`);
      expect(render(d, "eq", "qty", ["12.5"])).toBe(`${id(d, "qty")} = 12.5`);
      // Not numeric ⇒ quoted, never spliced in raw.
      for (const bad of ["1 OR 1=1", "0x10", "1;DROP", "NULL", "1,2", ""])
        if (bad !== "") expect(render(d, "eq", "qty", [bad])).toBe(`${id(d, "qty")} = ${str(d, bad)}`);
      // Non-number columns always quote, even for digits.
      expect(render(d, "eq", "name", ["12"])).toBe(`${id(d, "name")} = ${str(d, "12")}`);
    }
  });

  it("between / not between", () => {
    for (const d of DIALECTS) {
      expect(render(d, "between", "qty", ["1", "9"])).toBe(`${id(d, "qty")} BETWEEN 1 AND 9`);
      expect(render(d, "notBetween", "qty", ["1", "9"])).toBe(`${id(d, "qty")} NOT BETWEEN 1 AND 9`);
      expect(render(d, "between", "made_at", ["2024-01-01", "2024-12-31"])).toBe(
        `${id(d, "made_at")} BETWEEN ${str(d, "2024-01-01")} AND ${str(d, "2024-12-31")}`,
      );
      expect(render(d, "between", "qty", ["1"])).toBe("");
    }
  });

  it("in / not in split the list honoring quotes", () => {
    for (const d of DIALECTS) {
      expect(render(d, "in", "qty", ["1, 2 ,3"])).toBe(`${id(d, "qty")} IN (1, 2, 3)`);
      expect(render(d, "notIn", "name", ["'a,b', c"])).toBe(
        `${id(d, "name")} NOT IN (${str(d, "a,b")}, ${str(d, "c")})`,
      );
      expect(render(d, "in", "name", ["  "])).toBe("");
    }
  });
});

describe("null / boolean / empty operators", () => {
  it("null checks are explicit on every dialect", () => {
    for (const d of DIALECTS) {
      expect(render(d, "isNull", "name")).toBe(`${id(d, "name")} IS NULL`);
      expect(render(d, "isNotNull", "name")).toBe(`${id(d, "name")} IS NOT NULL`);
    }
  });

  it("booleans use IS TRUE on PG/DuckDB and 0/1 elsewhere", () => {
    for (const d of DIALECTS) {
      const numeric = d === "mysql" || d === "sqlite" || d === "mssql";
      expect(render(d, "isTrue", "flag")).toBe(numeric ? `${id(d, "flag")} = 1` : `${id(d, "flag")} IS TRUE`);
      expect(render(d, "isFalse", "flag")).toBe(numeric ? `${id(d, "flag")} = 0` : `${id(d, "flag")} IS FALSE`);
      // `=` against a boolean column renders the engine's boolean literal.
      expect(render(d, "eq", "flag", ["true"])).toBe(`${id(d, "flag")} = ${numeric ? "1" : "TRUE"}`);
      expect(render(d, "eq", "flag", ["f"])).toBe(`${id(d, "flag")} = ${numeric ? "0" : "FALSE"}`);
      expect(render(d, "ne", "flag", ["1"])).toBe(`${id(d, "flag")} <> ${numeric ? "1" : "TRUE"}`);
    }
  });

  it("is empty compares against the empty string", () => {
    for (const d of DIALECTS) expect(render(d, "isEmpty", "name")).toBe(`${id(d, "name")} = ${str(d, "")}`);
  });
});

describe("LIKE-family operators", () => {
  it("contains / starts with / ends with stay case-insensitive per engine", () => {
    for (const d of DIALECTS) {
      expect(render(d, "contains", "name", ["ab"])).toBe(ci(d, id(d, "name"), str(d, "%ab%")));
      expect(render(d, "startsWith", "name", ["ab"])).toBe(ci(d, id(d, "name"), str(d, "ab%")));
      expect(render(d, "endsWith", "name", ["ab"])).toBe(ci(d, id(d, "name"), str(d, "%ab")));
    }
  });

  it("non-text columns are cast to text before matching", () => {
    for (const d of DIALECTS) {
      expect(render(d, "contains", "id", ["7"])).toBe(ci(d, cast(d, "id"), str(d, "%7%")));
      expect(render(d, "contains", "made_at", ["2024"])).toBe(ci(d, cast(d, "made_at"), str(d, "%2024%")));
    }
  });

  it("wildcards inside user text are escaped, with a dialect-correct ESCAPE clause", () => {
    const clause = (d: D) => (d === "mysql" ? " ESCAPE '\\\\'" : d === "postgres" ? " ESCAPE E'\\\\'" : " ESCAPE '\\'");
    for (const d of DIALECTS) {
      expect(render(d, "contains", "name", ["50%"])).toBe(ci(d, id(d, "name"), str(d, "%50\\%%"), clause(d)));
      expect(render(d, "startsWith", "name", ["a_b"])).toBe(ci(d, id(d, "name"), str(d, "a\\_b%"), clause(d)));
      expect(render(d, "endsWith", "name", ["c\\d"])).toBe(ci(d, id(d, "name"), str(d, "%c\\\\d"), clause(d)));
      // No special characters ⇒ no ESCAPE clause (keeps the common case clean).
      expect(render(d, "contains", "name", ["plain"])).not.toContain("ESCAPE");
    }
  });

  it("like / not like pass the pattern through; ilike maps to LOWER where unsupported", () => {
    for (const d of DIALECTS) {
      expect(render(d, "like", "name", ["a%b"])).toBe(`${id(d, "name")} LIKE ${str(d, "a%b")}`);
      expect(render(d, "notLike", "name", ["a%b"])).toBe(`${id(d, "name")} NOT LIKE ${str(d, "a%b")}`);
      expect(render(d, "ilike", "name", ["a%b"])).toBe(ci(d, id(d, "name"), str(d, "a%b")));
    }
    setSqlDialect("postgres");
    expect(render("postgres", "ilike", "name", ["x"])).toContain("ILIKE");
    expect(render("mssql", "ilike", "name", ["x"])).toBe(`LOWER([name]) LIKE LOWER(N'x')`);
    expect(render("sqlite", "ilike", "name", ["x"])).toBe(`"name" LIKE 'x'`);
  });

  it("quotes in user text are escaped, never able to close the literal", () => {
    expect(render("postgres", "eq", "name", ["o'brien"])).toBe(`"name" = 'o''brien'`);
    expect(render("postgres", "contains", "name", ["'; DROP TABLE t --"])).toBe(
      `"name" ILIKE '%''; DROP TABLE t --%'`,
    );
    setSqlDialect("mysql");
    expect(renderCondition(makeCondition("name", "eq", ["a\\'b"]), { columns: COLUMNS, dialect: "mysql", classOf: CLASS_OF }))
      .toBe(`\`name\` = _utf8mb4 X'${hex("a\\'b")}'`);
  });
});

describe("groups", () => {
  const tree = (): FilterTree => ({
    ...emptyFilter(),
    items: [
      makeCondition("qty", "gt", ["10"]),
      makeGroup("or", [makeCondition("name", "eq", ["a"]), makeCondition("name", "eq", ["b"])]),
    ],
  });

  it("renders an AND of ORs with explicit parentheses", () => {
    expect(renderWhere(tree(), { columns: COLUMNS, dialect: "postgres", classOf: CLASS_OF })).toBe(
      `"qty" > 10 AND ("name" = 'a' OR "name" = 'b')`,
    );
  });

  it("renders an OR of ANDs", () => {
    const t: FilterTree = {
      ...emptyFilter(),
      op: "or",
      items: [
        makeGroup("and", [makeCondition("qty", "gt", ["1"]), makeCondition("qty", "lt", ["9"])]),
        makeCondition("flag", "isTrue"),
      ],
    };
    expect(renderWhere(t, { columns: COLUMNS, dialect: "postgres", classOf: CLASS_OF })).toBe(
      `("qty" > 1 AND "qty" < 9) OR "flag" IS TRUE`,
    );
  });

  it("drops incomplete conditions and collapses empty groups", () => {
    const t: FilterTree = {
      ...emptyFilter(),
      items: [
        makeCondition("qty", "gt", []),
        makeGroup("or", [makeCondition("name", "eq", [])]),
        makeCondition("name", "eq", ["a"]),
      ],
    };
    expect(renderWhere(t, { columns: COLUMNS, dialect: "postgres", classOf: CLASS_OF })).toBe(`"name" = 'a'`);
    expect(renderWhere(emptyFilter(), { columns: COLUMNS, dialect: "postgres" })).toBe("");
  });

  it("a single-child group needs no parentheses", () => {
    const t: FilterTree = { ...emptyFilter(), items: [makeGroup("or", [makeCondition("name", "eq", ["a"])])] };
    expect(renderWhere(t, { columns: COLUMNS, dialect: "postgres", classOf: CLASS_OF })).toBe(`"name" = 'a'`);
  });
});

describe("column resolution", () => {
  it("drops a condition whose column left the result", () => {
    expect(render("postgres", "eq", "ghost", ["1"])).toBe("");
  });

  it("throws on ambiguous (duplicate) column names, folding case off Postgres", () => {
    const dup = { columns: ["same", "same"], dialect: "postgres" };
    expect(() => renderCondition(makeCondition("same", "eq", ["1"]), dup)).toThrow(/duplicate/i);
    expect(() => renderCondition(makeCondition("same", "eq", ["1"]), { columns: ["same", "SAME"], dialect: "postgres" }))
      .not.toThrow();
    expect(() => renderCondition(makeCondition("same", "eq", ["1"]), { columns: ["same", "SAME"], dialect: "mysql" }))
      .toThrow(/duplicate/i);
  });

  it("matches the result column's own spelling", () => {
    setSqlDialect("mysql");
    expect(renderCondition(makeCondition("NAME", "eq", ["x"]), { columns: ["Name"], dialect: "mysql" }))
      .toBe("`Name` = _utf8mb4 X'78'");
  });

  it("activeConditionCount counts resolvable complete conditions", () => {
    const t: FilterTree = {
      ...emptyFilter(),
      items: [makeCondition("name", "eq", ["a"]), makeCondition("ghost", "eq", ["b"]), makeCondition("qty", "eq", [])],
    };
    expect(activeConditionCount(t, COLUMNS)).toBe(1);
  });
});

describe("bounds are enforced at render time", () => {
  it("refuses an over-budget tree", () => {
    const t: FilterTree = {
      ...emptyFilter(),
      items: Array.from({ length: 201 }, () => makeCondition("name", "eq", ["a"])),
    };
    expect(() => renderWhere(t, { columns: COLUMNS, dialect: "postgres" })).toThrow(/too many conditions/);
  });
});
