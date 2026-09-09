// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { FilterBuilder } from "./FilterBuilder";
import { emptyFilter, type FilterTree } from "../grid/filterModel";
import { setSqlDialect } from "../sql/ident";

// A DOM test, not a pure one, because the defect it pins lived in the compiled JSX: a
// `ref={props.selectRef}` on a row whose parent passes no `selectRef` made Solid ASSIGN
// the element to the getter-only props proxy, and the resulting TypeError took the whole
// app to the crash screen the moment a second condition existed. Only rendering the real
// component and clicking the real buttons can catch that.

afterEach(() => {
  cleanup();
  setSqlDialect("postgres");
});

function open(initial: FilterTree = emptyFilter()) {
  setSqlDialect("postgres");
  const view = render(() => (
    <FilterBuilder
      columns={["id", "title", "pages"]}
      types={{ id: "int4", title: "text", pages: "int4" }}
      dialect="postgres"
      initial={initial}
      onApply={() => {}}
      onOpenQuery={() => {}}
      onCopyWhere={() => {}}
      onClose={() => {}}
    />
  ));
  const buttons = (label: string) =>
    [...view.container.querySelectorAll("button.filter-add")].filter((b) =>
      (b.textContent ?? "").includes(label),
    ) as HTMLButtonElement[];
  return {
    ...view,
    rows: () => view.container.querySelectorAll(".filter-row").length,
    groups: () => view.container.querySelectorAll(".filter-group").length,
    addCondition: (at = 0) => fireEvent.click(buttons("Condition")[at]),
    addGroup: (at = 0) => fireEvent.click(buttons("Group")[at]),
  };
}

describe("FilterBuilder", () => {
  it("opens with one seeded condition", () => {
    const v = open();
    expect(v.rows()).toBe(1);
    expect(v.groups()).toBe(1);
  });

  it("adds a second condition without throwing", () => {
    const v = open();
    expect(() => v.addCondition()).not.toThrow();
    expect(v.rows()).toBe(2);
    // Both rows are live: the second one's column select is a real, usable control.
    const cols = v.container.querySelectorAll<HTMLSelectElement>("select.filter-col");
    expect(cols).toHaveLength(2);
    expect([...cols].every((s) => s.options.length === 3)).toBe(true);
  });

  it("adds a nested AND/OR group without throwing", () => {
    const v = open();
    expect(() => v.addGroup()).not.toThrow();
    expect(v.container.querySelectorAll(".filter-group.nested")).toHaveLength(1);
    // The group arrives seeded with its own condition, so two rows in total.
    expect(v.rows()).toBe(2);
    expect(v.groups()).toBe(2);
    // And a condition can be added INSIDE the nested group (the inner rows never got a
    // `selectRef` either, so this is the same crash from the other direction).
    expect(() => v.addCondition(1)).not.toThrow();
    expect(v.rows()).toBe(3);
  });

  it("renders a joined WHERE preview once both conditions have values", () => {
    const v = open();
    v.addCondition();
    const value = (i: number, text: string) =>
      fireEvent.input(v.container.querySelectorAll<HTMLInputElement>("input.filter-val")[i], {
        target: { value: text },
      });
    value(0, "1");
    value(1, "2");
    const preview = v.container.querySelector(".sql-preview")?.textContent ?? "";
    expect(preview).toContain("WHERE");
    expect(preview).toContain("AND");
  });
});
