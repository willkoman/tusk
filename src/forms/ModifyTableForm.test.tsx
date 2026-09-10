// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { ModifyTableForm } from "./ModifyTableForm";
import { setSqlDialect } from "../sql/ident";
import type { NodeDescriptor, RelationDetail } from "../Tree";

// A DOM test because the thing under test is the INTERACTION: a checkbox that meant
// "drop this" was replaced with an explicit Drop → Keep pair, a live count in the
// section heading, a footer summary, and a confirmation that names every object.
// Only clicking the real buttons proves the pending state is reversible and that the
// confirmation lists what will actually be destroyed.

afterEach(() => {
  cleanup();
  setSqlDialect("postgres");
});

const detail = (): RelationDetail => ({
  name: "orders",
  kind: "table",
  comment: null,
  columns: [
    { name: "id", data_type: "int4", nullable: false, is_pk: true, is_fk: false, default: null, comment: null },
    { name: "note", data_type: "text", nullable: true, is_fk: false, is_pk: false, default: null, comment: null },
  ],
  indexes: [
    // Backed by the orders_pkey constraint, so it is listed once, under Constraints.
    { name: "orders_pkey", unique: true, primary: true, def: "", columns: ["id"] },
    // A primary index with no matching constraint: the row that cannot be dropped here.
    { name: "orders_rowid_idx", unique: true, primary: true, def: "", columns: ["id"] },
    { name: "orders_note_idx", unique: false, primary: false, def: "CREATE INDEX orders_note_idx ON orders(note)", columns: ["note"] },
  ],
  constraints: [
    { name: "orders_pkey", kind: "primary_key", def: "PRIMARY KEY (id)", columns: ["id"] },
    { name: "orders_note_chk", kind: "check", def: "CHECK (note <> '')", columns: ["note"] },
    { name: "orders_note_uq", kind: "unique", def: "UNIQUE (note)", columns: ["note"] },
  ],
  triggers: [],
  definition_read: true,
});

const ctx: NodeDescriptor = { kind: "table", schema: "public", name: "orders" };

function open() {
  setSqlDialect("postgres");
  const onRun = vi.fn(async () => ({ ok: true }));
  const onClose = vi.fn();
  const view = render(() => (
    <ModifyTableForm
      ctx={ctx}
      detail={detail()}
      schemas={["public"]}
      onClose={onClose}
      onRun={onRun}
      onEditAsSql={() => {}}
    />
  ));
  const rowFor = (name: string) =>
    [...document.querySelectorAll<HTMLElement>(".drop-row")].find(
      (r) => r.querySelector(".mono")?.textContent === name,
    )!;
  const button = (root: HTMLElement, label: string) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
  return {
    ...view,
    onRun,
    onClose,
    rowFor,
    button,
    /** Section headings, so the "· N to drop" counter can be asserted. */
    labels: () => [...document.querySelectorAll(".field-label")].map((e) => e.textContent ?? ""),
    summary: () => document.querySelector(".drop-summary")?.textContent ?? "",
    primary: () => {
      const all = [...document.querySelectorAll<HTMLButtonElement>(".modal-foot .form-actions button")];
      return all[all.length - 1];
    },
    confirmLines: () => [...document.querySelectorAll(".confirm-list li")].map((e) => e.textContent ?? ""),
  };
}

describe("ModifyTableForm — constraint drops", () => {
  it("has no checkbox in the drop lists any more", () => {
    const v = open();
    expect(document.querySelectorAll(".drop-row input[type=checkbox]")).toHaveLength(0);
    expect(v.button(v.rowFor("orders_note_chk"), "Drop")).toBeTruthy();
  });

  it("Drop → Keep → Drop is reversible and counted", () => {
    const v = open();
    const row = () => v.rowFor("orders_note_chk");
    expect(row().classList.contains("row-dropped")).toBe(false);
    expect(v.labels().some((l) => l.includes("Constraints (1 to drop)"))).toBe(false);

    fireEvent.click(v.button(row(), "Drop"));
    expect(row().classList.contains("row-dropped")).toBe(true);
    expect(v.labels()).toContain("Constraints (1 to drop)");
    expect(v.summary()).toBe("Drops 1 constraint");

    // Keep undoes it completely: no pending state, no count, no footer line.
    fireEvent.click(v.button(row(), "Keep"));
    expect(row().classList.contains("row-dropped")).toBe(false);
    expect(v.labels()).toContain("Constraints");
    expect(v.summary()).toBe("");

    fireEvent.click(v.button(row(), "Drop"));
    expect(row().classList.contains("row-dropped")).toBe(true);
    expect(v.summary()).toBe("Drops 1 constraint");
  });

  it("counts indexes and constraints separately and summarises both", () => {
    const v = open();
    fireEvent.click(v.button(v.rowFor("orders_note_idx"), "Drop"));
    fireEvent.click(v.button(v.rowFor("orders_note_chk"), "Drop"));
    fireEvent.click(v.button(v.rowFor("orders_note_uq"), "Drop"));
    expect(v.labels()).toContain("Indexes (1 to drop)");
    expect(v.labels()).toContain("Constraints (2 to drop)");
    expect(v.summary()).toBe("Drops 1 index, 2 constraints");
  });

  it("a primary index offers no Drop action, and a constraint-backed one is not listed twice", () => {
    const v = open();
    const pk = v.rowFor("orders_rowid_idx");
    expect([...pk.querySelectorAll("button")]).toHaveLength(0);
    expect(pk.textContent).toContain("Managed in Columns");
    // orders_pkey appears once — as a constraint, not also as an index.
    const named = [...document.querySelectorAll(".drop-row .mono")].filter(
      (e) => e.textContent === "orders_pkey",
    );
    expect(named).toHaveLength(1);
  });

  it("Apply confirms first and names every object, and does not run until confirmed", () => {
    const v = open();
    fireEvent.click(v.button(v.rowFor("orders_note_idx"), "Drop"));
    fireEvent.click(v.button(v.rowFor("orders_note_chk"), "Drop"));
    fireEvent.click(v.button(v.rowFor("orders_note_uq"), "Drop"));

    fireEvent.click(v.primary());
    expect(v.onRun).not.toHaveBeenCalled();
    expect(v.confirmLines()).toEqual([
      "Index: orders_note_idx",
      "Constraints: orders_note_chk, orders_note_uq",
    ]);
    expect([...document.querySelectorAll(".danger-lead")].map((e) => e.textContent)).toContain(
      "These objects are dropped and cannot be recovered.",
    );
  });

  it("runs straight away when nothing is pending a drop", () => {
    const v = open();
    // Renaming the table is a change with no drop in it.
    const nameInput = document.querySelector<HTMLInputElement>(".modify-head input")!;
    fireEvent.input(nameInput, { target: { value: "orders_v2" } });
    expect(v.summary()).toBe("");
    fireEvent.click(v.primary());
    expect(document.querySelectorAll(".confirm-list")).toHaveLength(0);
    expect(v.onRun).toHaveBeenCalledTimes(1);
  });
});

describe("ModifyTableForm — the column row", () => {
  const colFor = (name: string) =>
    [...document.querySelectorAll<HTMLElement>(".cb-col")].find(
      (c) => c.querySelector<HTMLInputElement>(".cb-line1 input")?.value === name,
    )!;

  it("gives every column a default and a comment cell of its own", () => {
    open();
    for (const name of ["id", "note"]) {
      const labels = [...colFor(name).querySelectorAll(".cb-sub-label")].map((e) => e.textContent);
      expect(labels).toEqual(["Default", "Comment"]);
    }
  });

  it("orders the fields name → type → flags → default → comment", () => {
    open();
    // The type field's option caret is deliberately out of the tab order, so it
    // is excluded here exactly as the browser excludes it.
    const fields = [...colFor("note").querySelectorAll('input,button:not([tabindex="-1"]),.sql-field')].map((e) =>
      e.classList.contains("sql-field") ? "sql" : (e as HTMLInputElement).type || "button",
    );
    // The order handle is hidden on PostgreSQL, so the row opens on the name;
    // the two `sql` slots are the type and the default (CodeMirror fields).
    expect(fields).toEqual(["text", "sql", "checkbox", "checkbox", "sql", "text", "submit"]);
    // The Type field is a picker, not free text: it shows the list caret.
    const typeField = colFor("note").querySelector(".cb-line1 .sql-field")!;
    expect(typeField.querySelector(".sql-field-caret")).toBeTruthy();
    expect(typeField.querySelector('.sql-field-caret[tabindex="-1"]')).toBeTruthy();
    // The Default field stays free text — no caret.
    expect(colFor("note").querySelector(".cb-line2 .sql-field-caret")).toBeNull();
    const line2 = colFor("note").querySelector(".cb-line2")!;
    const actions = colFor("note").querySelector(".cb-actions")!;
    // Line 2 precedes the actions in the DOM, which is what fixes the Tab order.
    expect(line2.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("marks only the cells that differ from the catalog", () => {
    open();
    const note = colFor("note");
    expect(note.querySelectorAll(".cb-changed")).toHaveLength(0);
    fireEvent.input(note.querySelector(".cb-line1 input")!, { target: { value: "notes" } });
    const marked = [...colFor("notes").querySelectorAll(".cb-changed")];
    expect(marked).toHaveLength(1);
    expect((marked[0] as HTMLInputElement).value).toBe("notes");
  });

  it("keeps a dropped column readable and reversible", () => {
    const v = open();
    const note = colFor("note");
    fireEvent.click(v.button(note, "Drop"));
    expect(colFor("note").classList.contains("row-dropped")).toBe(true);
    fireEvent.click(v.button(colFor("note"), "Keep"));
    expect(colFor("note").classList.contains("row-dropped")).toBe(false);
  });
});
