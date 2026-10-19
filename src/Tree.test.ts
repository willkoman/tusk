// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { definitionKind, nodeKey, type NodeDescriptor } from "./Tree";
import { ddlCaps } from "./sql/ddlCaps";

const routine = (returns?: string): NodeDescriptor => ({ kind: "function", schema: "test", name: "tusk_both", returns });

describe("routine nodes", () => {
  it("keeps a MySQL procedure and function of one name apart", () => {
    // MySQL keeps them in separate namespaces, so the tree lists both under one name.
    expect(nodeKey(routine("procedure"))).not.toBe(nodeKey(routine("function")));
    expect(nodeKey({ kind: "table", schema: "s", name: "t" })).toBe("table|s||t");
  });

  it("asks object_ddl for the node's own routine type where the namespaces are split", () => {
    const mysql = ddlCaps("mysql").routineNamespaces;
    expect(mysql).toBe(true);
    expect(definitionKind(routine("procedure"), mysql)).toBe("procedure");
    expect(definitionKind(routine("function"), mysql)).toBe("function");
    expect(definitionKind(routine(undefined), mysql)).toBe("routine");
    expect(definitionKind({ kind: "view", schema: "s", name: "v" }, mysql)).toBe("view");
    // PostgreSQL's `returns` is a return type, and DuckDB's routines are macros: both
    // keep asking for "function", which their drivers resolve themselves.
    for (const dialect of ["postgres", "duckdb", "sqlite"]) {
      const split = ddlCaps(dialect).routineNamespaces;
      expect(split).toBe(false);
      expect(definitionKind(routine("integer"), split)).toBe("function");
      expect(definitionKind(routine("macro"), split)).toBe("function");
    }
  });
});
