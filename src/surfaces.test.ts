import { describe, expect, it } from "vitest";
import { closeSurfaces, shouldClose, type Surface, type SurfaceScope } from "./surfaces";

const focused: SurfaceScope = { kind: "focused" };
const lifecycle: SurfaceScope = { kind: "lifecycle" };
const global: SurfaceScope = { kind: "global" };
const boundA: SurfaceScope = { kind: "bound", connectionId: "A" };
const boundB: SurfaceScope = { kind: "bound", connectionId: "B" };
const busyA: SurfaceScope = { kind: "bound", connectionId: "A", busy: true };

describe("shouldClose", () => {
  it("a switch closes the focused surfaces and the idle ones bound to the connection left", () => {
    const sw = { kind: "switch" as const, from: "A" };
    expect(shouldClose(focused, false, sw)).toBe(true);
    expect(shouldClose(lifecycle, false, sw)).toBe(false);
    expect(shouldClose(global, false, sw)).toBe(false);
    expect(shouldClose(boundA, false, sw)).toBe(true);
    expect(shouldClose(boundB, false, sw)).toBe(false);
    expect(shouldClose(busyA, false, sw)).toBe(false);
  });

  it("a disconnect closes everything about that connection, busy or not, and every lifecycle question", () => {
    const dc = { kind: "disconnect" as const, connectionId: "A" };
    expect(shouldClose(focused, false, dc)).toBe(true);
    expect(shouldClose(lifecycle, false, dc)).toBe(true);
    expect(shouldClose(global, false, dc)).toBe(false);
    expect(shouldClose(boundA, false, dc)).toBe(true);
    expect(shouldClose(busyA, false, dc)).toBe(true);
    expect(shouldClose(boundB, false, dc)).toBe(false);
  });

  it("a transaction opening takes down only session surfaces on its connection", () => {
    const tx = { kind: "transaction" as const, connectionId: "A" };
    expect(shouldClose(focused, true, tx)).toBe(true);
    expect(shouldClose(focused, false, tx)).toBe(false);
    expect(shouldClose(boundA, true, tx)).toBe(true);
    expect(shouldClose(busyA, true, tx)).toBe(false);
    expect(shouldClose(boundB, true, tx)).toBe(false);
    expect(shouldClose(lifecycle, true, tx)).toBe(false);
    expect(shouldClose(global, true, tx)).toBe(false);
  });
});

describe("closeSurfaces", () => {
  function registry() {
    const closed: string[] = [];
    let ddlGraphConn: string | null = "A";
    let exportBusy = false;
    const surfaces: Surface[] = [
      { name: "menu", scope: () => focused, session: true, close: () => closed.push("menu") },
      { name: "cellView", scope: () => focused, close: () => closed.push("cellView") },
      { name: "confirmClose", scope: () => lifecycle, close: () => closed.push("confirmClose") },
      { name: "deleteProfile", scope: () => global, close: () => closed.push("deleteProfile") },
      { name: "ddlGraph", scope: () => (ddlGraphConn ? { kind: "bound", connectionId: ddlGraphConn } : null), session: true, close: () => { ddlGraphConn = null; closed.push("ddlGraph"); } },
      { name: "export", scope: () => ({ kind: "bound", connectionId: "A", busy: exportBusy }), close: () => closed.push("export") },
      { name: "importB", scope: () => ({ kind: "bound", connectionId: "B" }), session: true, close: () => closed.push("importB") },
    ];
    return { surfaces, closed, setExportBusy: (b: boolean) => { exportBusy = b; }, closeGraph: () => { ddlGraphConn = null; } };
  }

  it("a switch away from A closes A's idle surfaces and leaves B's alone", () => {
    const r = registry();
    expect(closeSurfaces(r.surfaces, { kind: "switch", from: "A" })).toEqual(["menu", "cellView", "ddlGraph", "export"]);
  });

  it("a busy export survives a switch but not a disconnect", () => {
    const r = registry();
    r.setExportBusy(true);
    expect(closeSurfaces(r.surfaces, { kind: "switch", from: "A" })).not.toContain("export");
    expect(closeSurfaces(r.surfaces, { kind: "disconnect", connectionId: "A" })).toContain("export");
  });

  it("disconnecting B leaves A's dialogs open but answers every lifecycle question", () => {
    const r = registry();
    expect(closeSurfaces(r.surfaces, { kind: "disconnect", connectionId: "B" })).toEqual(["menu", "cellView", "confirmClose", "importB"]);
  });

  it("a transaction on A dismisses only what acts on A's session", () => {
    const r = registry();
    expect(closeSurfaces(r.surfaces, { kind: "transaction", connectionId: "A" })).toEqual(["menu", "ddlGraph"]);
  });

  it("a closed surface is skipped, and closing is idempotent", () => {
    const r = registry();
    r.closeGraph();
    expect(closeSurfaces(r.surfaces, { kind: "switch", from: "A" })).toEqual(["menu", "cellView", "export"]);
    expect(closeSurfaces(r.surfaces, { kind: "switch", from: "A" })).toEqual(["menu", "cellView", "export"]);
  });
});
