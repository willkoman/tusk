import { describe, it, expect } from "vitest";
import {
  CONNECTION_COLORS,
  MAX_CONNECTIONS,
  connectionColor,
  connectionDot,
  connectionKindOf,
  connectionLabel,
  connectionLabels,
  connectionLimitError,
  connectionMatches,
  findConnection,
  makeConnectionState,
  mergeRememberedIds,
  nextColorIndex,
  nextRecoverySlot,
  patchConnection,
  recoverySlotKey,
  rememberedProfileIds,
  removeConnection,
  sanitizeRememberedIds,
  stepConnection,
  upsertConnection,
  type Connected,
  type ConnectionState,
} from "./connections";
import { IDLE_TRANSACTION } from "./transaction";

const conn = (id: string, over: Partial<Connected> = {}): Connected => ({
  id,
  version: "16.1",
  readOnly: false,
  driver: "postgres",
  generation: 1,
  key: `profile:${id}`,
  target: id,
  viaSsh: false,
  profileId: null,
  ...over,
});

const state = (id: string, over: Partial<ConnectionState> = {}, c: Partial<Connected> = {}): ConnectionState => ({
  ...makeConnectionState(conn(id, c), 0),
  ...over,
});

describe("connection list operations", () => {
  it("upserts by id, preserving open order", () => {
    const a = state("a");
    const b = state("b");
    let list = upsertConnection([], a);
    list = upsertConnection(list, b);
    expect(list.map((c) => c.conn.id)).toEqual(["a", "b"]);
    list = upsertConnection(list, { ...a, schemaLoading: true });
    expect(list.map((c) => c.conn.id)).toEqual(["a", "b"]);
    expect(list[0].schemaLoading).toBe(true);
  });

  it("patches only the addressed connection and returns the same list when absent", () => {
    const list = [state("a"), state("b")];
    const patched = patchConnection(list, "b", { schemaLoading: true });
    expect(patched[0].schemaLoading).toBe(false);
    expect(patched[1].schemaLoading).toBe(true);
    expect(patchConnection(list, "zz", { schemaLoading: true })).toBe(list);
  });

  it("removes and finds by id", () => {
    const list = [state("a"), state("b")];
    expect(removeConnection(list, "a").map((c) => c.conn.id)).toEqual(["b"]);
    expect(findConnection(list, "b")?.conn.id).toBe("b");
    expect(findConnection(list, null)).toBeNull();
    expect(findConnection(list, "nope")).toBeNull();
  });

  it("matches identity by id AND generation, so a reconnect invalidates a stale handle", () => {
    const list = [state("a")];
    expect(connectionMatches(list, { id: "a", generation: 1 })).toBe(true);
    expect(connectionMatches(list, { id: "a", generation: 2 })).toBe(false);
    expect(connectionMatches(list, { id: "b", generation: 1 })).toBe(false);
  });
});

describe("colours", () => {
  it("hands out the lowest free index and wraps the palette", () => {
    expect(nextColorIndex([])).toBe(0);
    const list = [state("a", { colorIndex: 0 }), state("b", { colorIndex: 2 })];
    expect(nextColorIndex(list)).toBe(1);
    expect(connectionColor(0)).toBe(CONNECTION_COLORS[0]);
    expect(connectionColor(CONNECTION_COLORS.length)).toBe(CONNECTION_COLORS[0]);
    expect(connectionColor(-1)).toBe(CONNECTION_COLORS[CONNECTION_COLORS.length - 1]);
  });
});

describe("state dot", () => {
  it("reports the most severe state first", () => {
    expect(connectionDot(state("a"))).toBe("idle");
    expect(connectionDot(state("a", { running: true }))).toBe("running");
    expect(connectionDot(state("a", { fetchingMore: true }))).toBe("running");
    expect(connectionDot(state("a", { loadingAll: true }))).toBe("running");
    expect(
      connectionDot(state("a", { running: true, transaction: { ...IDLE_TRANSACTION, state: "active", id: "tx1" } })),
    ).toBe("transaction");
    expect(
      connectionDot(state("a", { running: true, transaction: { ...IDLE_TRANSACTION, state: "failed", id: "tx1" } })),
    ).toBe("failed");
    expect(
      connectionDot(state("a", { transaction: { ...IDLE_TRANSACTION, state: "lost", id: "tx1" } })),
    ).toBe("lost");
  });
});

describe("labels", () => {
  it("prefers the server-reported database name over what was dialled", () => {
    const withTree = state("a", {
      tree: { database: "analytics", databases: [], schemas: [] } as never,
    }, { target: "typed_name" });
    expect(connectionLabel(withTree)).toBe("analytics");
    expect(connectionLabel(state("b", {}, { target: "typed_name" }))).toBe("typed_name");
    expect(connectionLabel(state("c", {}, { target: "", driver: "mysql" }))).toBe("MySQL");
  });

  it("disambiguates duplicate labels in open order", () => {
    const list = [
      state("a", {}, { target: "app" }),
      state("b", {}, { target: "app" }),
      state("c", {}, { target: "warehouse" }),
    ];
    const labels = connectionLabels(list);
    expect(labels.get("a")).toBe("app #1");
    expect(labels.get("b")).toBe("app #2");
    expect(labels.get("c")).toBe("warehouse");
  });
});

describe("kind resolution", () => {
  it("prefers the backend-reported kind, then the dialled driver", () => {
    expect(connectionKindOf(state("a", { caps: { kind: "duckdb" } as never }, { driver: "postgres" }))).toBe("duckdb");
    expect(connectionKindOf(state("a", {}, { driver: "mysql" }))).toBe("mysql");
    expect(connectionKindOf(null)).toBe("postgres");
  });
});

describe("stepConnection", () => {
  it("wraps in both directions and no-ops below two connections", () => {
    const list = [state("a"), state("b"), state("c")];
    expect(stepConnection(list, "a", 1)).toBe("b");
    expect(stepConnection(list, "c", 1)).toBe("a");
    expect(stepConnection(list, "a", -1)).toBe("c");
    expect(stepConnection(list, "zz", 1)).toBe("a");
    expect(stepConnection([state("a")], "a", 1)).toBeNull();
    expect(stepConnection([], null, 1)).toBeNull();
  });
});

describe("open-connection cap", () => {
  it("refuses past MAX_CONNECTIONS with a message naming the limit", () => {
    const list = Array.from({ length: MAX_CONNECTIONS - 1 }, (_, i) => state(`c${i}`));
    expect(connectionLimitError(list)).toBe("");
    expect(connectionLimitError([...list, state("last")])).toContain(String(MAX_CONNECTIONS));
  });
});

describe("remembered sessions", () => {
  it("remembers profile ids only, in open order, without duplicates", () => {
    const list = [
      state("a", {}, { profileId: "p1" }),
      state("b", {}, { profileId: null }), // ad-hoc: never remembered
      state("c", {}, { profileId: "p2" }),
      state("d", {}, { profileId: "p1" }),
    ];
    expect(rememberedProfileIds(list)).toEqual(["p1", "p2"]);
  });

  it("sanitizes persisted ids: bounded, de-duplicated, strings only", () => {
    expect(sanitizeRememberedIds(null)).toEqual([]);
    expect(sanitizeRememberedIds("p1")).toEqual([]);
    expect(sanitizeRememberedIds(["p1", "p1", 7, "", null, "p2"])).toEqual(["p1", "p2"]);
    expect(sanitizeRememberedIds(["x".repeat(201), "ok"])).toEqual(["ok"]);
    expect(sanitizeRememberedIds(Array.from({ length: 100 }, (_, i) => `p${i}`))).toHaveLength(MAX_CONNECTIONS);
  });
});

describe("tab-recovery slots", () => {
  it("gives the first session the bare key and never lets two share one", () => {
    // Slot 0 must stay byte-identical to the pre-multi-connection key, so a single
    // session keeps reading and writing the snapshot every earlier version wrote.
    expect(recoverySlotKey("profile:p1", 0)).toBe("profile:p1");
    expect(recoverySlotKey("profile:p1", 1)).toBe("profile:p1#1");

    const inUse: string[] = [];
    // Open the SAME profile three times: each session must claim its own slot.
    for (const expected of ["profile:p1", "profile:p1#1", "profile:p1#2"]) {
      const slot = nextRecoverySlot(inUse, "profile:p1");
      const key = recoverySlotKey("profile:p1", slot);
      expect(key).toBe(expected);
      expect(inUse).not.toContain(key);
      inUse.push(key);
    }
    expect(new Set(inUse).size).toBe(inUse.length);

    // Another destination is unaffected, and a closed session frees its slot.
    expect(recoverySlotKey("profile:p2", nextRecoverySlot(inUse, "profile:p2"))).toBe("profile:p2");
    inUse.splice(1, 1); // close the second session
    expect(nextRecoverySlot(inUse, "profile:p1")).toBe(1);
  });

  it("stops handing out slots past the open-connection ceiling", () => {
    const inUse = Array.from({ length: MAX_CONNECTIONS }, (_, i) => recoverySlotKey("k", i));
    expect(nextRecoverySlot(inUse, "k")).toBe(MAX_CONNECTIONS);
  });
});

describe("merging the remembered session", () => {
  it("keeps profiles still waiting to be reopened when one connects", () => {
    // The bug: connecting A wrote ["a"] and erased B and C before the offer could be
    // accepted, so the remembered session destroyed itself on the first connect.
    expect(mergeRememberedIds(["a"], ["b", "c"])).toEqual(["a", "b", "c"]);
    expect(mergeRememberedIds([], ["a", "b"])).toEqual(["a", "b"]);
    expect(mergeRememberedIds(["a", "b"], [])).toEqual(["a", "b"]);
  });

  it("de-duplicates across both lists and stays bounded", () => {
    expect(mergeRememberedIds(["a", "b"], ["b", "c", "a"])).toEqual(["a", "b", "c"]);
    expect(mergeRememberedIds(["", "a"], [""])).toEqual(["a"]);
    const many = Array.from({ length: 40 }, (_, i) => `p${i}`);
    expect(mergeRememberedIds(many, ["extra"])).toHaveLength(MAX_CONNECTIONS);
  });
});
