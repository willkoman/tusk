import { describe, expect, it } from "vitest";
import { interruptedResult, makeTab, pendingCount } from "./tabs";

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
    const patch = interruptedResult({ rows: [["1"], ["2"]], done: false }, "an import closed the result stream");
    expect(patch).toEqual({
      done: true,
      incomplete: "an import closed the result stream",
      status: "2 rows loaded · an import closed the result stream — re-run the query for the full result",
    });
  });

  it("leaves a finished snapshot untouched", () => {
    expect(interruptedResult({ rows: [["1"]], done: true }, "anything")).toBeNull();
  });
});
