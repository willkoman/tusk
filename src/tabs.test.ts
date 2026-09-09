import { describe, expect, it } from "vitest";
import {
  MAX_TAB_TITLE,
  clampPinSlot,
  cleanTabTitle,
  closeManyTargets,
  filterTabs,
  interruptedResult,
  makeTab,
  pendingCount,
  pinnedCount,
  shortTabLabel,
  sortPinned,
  tabLabel,
  type Tab,
} from "./tabs";

describe("tab identities", () => {
  it("starts editor and loaded-result generations independently", () => {
    const tab = makeTab();
    expect(tab.revision).toBe(0);
    expect(tab.result.generation).toBe(0);

    const restored = makeTab({ revision: 7, result: { ...tab.result, generation: 11 } });
    expect(restored.revision).toBe(7);
    expect(restored.result.generation).toBe(11);
  });

  it("counts sparse edits, deletes, and default-valued inserts", () => {
    expect(pendingCount({
      cells: { 1: { 2: "changed" }, 3: { 0: null } },
      deletes: [1],
      inserts: [{}, { 4: null }],
    })).toBe(4);
  });
});

describe("interruptedResult", () => {
  it("freezes a streaming snapshot as an explicitly incomplete result", () => {
    const patch = interruptedResult({ rows: [["1"], ["2"]], done: false }, "Import closed the result stream");
    expect(patch).toEqual({
      done: true,
      incomplete: "Import closed the result stream",
      status: "2 rows loaded. Import closed the result stream. Re-run for the full result.",
    });
  });

  it("leaves a finished snapshot untouched", () => {
    expect(interruptedResult({ rows: [["1"]], done: true }, "anything")).toBeNull();
  });
});

describe("tab titles", () => {
  it("prefers a custom title and falls back to the automatic one", () => {
    const auto = makeTab({ title: "orders.sql" });
    expect(tabLabel(auto)).toBe("orders.sql");
    expect(tabLabel({ ...auto, customTitle: "  Nightly rollup  " })).toBe("Nightly rollup");
  });

  it("clears the custom title when the typed one is blank", () => {
    expect(cleanTabTitle("   ")).toBe("");
    expect(cleanTabTitle(" Rollup ")).toBe("Rollup");
    expect(cleanTabTitle("x".repeat(400))).toHaveLength(MAX_TAB_TITLE);
  });

  it("shortens a pinned tab's label without an ellipsis", () => {
    expect(shortTabLabel("orders.sql")).toBe("orde");
    expect(shortTabLabel("etl")).toBe("etl");
    expect(shortTabLabel("Nightly rollup", 6)).toBe("Nightl");
  });
});

describe("pin ordering", () => {
  const t = (id: string, pinned = false) => ({ ...makeTab({ title: id }), id, pinned });

  it("moves pinned tabs to the head, keeping relative order in each group", () => {
    const list = [t("a"), t("b", true), t("c"), t("d", true)];
    expect(sortPinned(list).map((x) => x.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("returns the same reference when the invariant already holds", () => {
    const list = [t("b", true), t("a"), t("c")];
    expect(sortPinned(list)).toBe(list);
  });

  it("counts only the leading pinned run", () => {
    expect(pinnedCount([t("b", true), t("a"), t("d", true)])).toBe(1);
  });

  it("keeps a dragged tab inside its own group", () => {
    const list = [t("p1", true), t("p2", true), t("a"), t("b")];
    // A pinned tab can never land right of the boundary…
    expect(clampPinSlot(list, 0, 4)).toBe(2);
    expect(clampPinSlot(list, 0, 1)).toBe(1);
    // …and an unpinned one can never land inside the pinned group.
    expect(clampPinSlot(list, 3, 0)).toBe(2);
    expect(clampPinSlot(list, 3, 3)).toBe(3);
  });
});

describe("close-many targets", () => {
  const t = (id: string, over: Partial<Tab> = {}) => ({ ...makeTab({ title: id }), id, ...over });

  it("spares pinned tabs and the anchor", () => {
    const owned = [t("p", { pinned: true }), t("a"), t("b"), t("c")];
    expect(closeManyTargets(owned, "b", "others").map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("closes only what is right of the anchor", () => {
    const owned = [t("a"), t("b"), t("c"), t("d")];
    expect(closeManyTargets(owned, "b", "right").map((x) => x.id)).toEqual(["c", "d"]);
  });

  it("closes saved tabs, keeping dirty and pinned ones", () => {
    const owned = [t("p", { pinned: true }), t("a"), t("b", { dirty: true }), t("c")];
    expect(closeManyTargets(owned, "a", "saved").map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("targets nothing to the right of an anchor that is gone", () => {
    expect(closeManyTargets([t("a"), t("b")], "missing", "right")).toEqual([]);
  });
});

describe("filterTabs", () => {
  const items = [
    { label: "orders.sql", detail: "/work/orders.sql", connectionLabel: "prod" },
    { label: "Nightly rollup", detail: "", connectionLabel: "staging" },
  ];

  it("keeps everything for a blank needle", () => {
    expect(filterTabs(items, "  ")).toHaveLength(2);
  });

  it("matches title, path, and connection", () => {
    expect(filterTabs(items, "ROLL").map((x) => x.label)).toEqual(["Nightly rollup"]);
    expect(filterTabs(items, "/work").map((x) => x.label)).toEqual(["orders.sql"]);
    expect(filterTabs(items, "prod").map((x) => x.label)).toEqual(["orders.sql"]);
    expect(filterTabs(items, "nope")).toEqual([]);
  });
});
