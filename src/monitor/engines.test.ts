import { describe, expect, it } from "vitest";
import { engineProfile, isMonitorEngine, omitted, seriesLabel, viewFor } from "./engines";
import { EVENT_KINDS, TILE_KEYS, WAIT_TYPES } from "./model";

describe("monitor engine profiles", () => {
  it("only the network engines are monitored", () => {
    expect(isMonitorEngine("postgres")).toBe(true);
    expect(isMonitorEngine("mysql")).toBe(true);
    expect(isMonitorEngine("mssql")).toBe(true);
    expect(isMonitorEngine("duckdb")).toBe(false);
    expect(isMonitorEngine("sqlite")).toBe(false);
    expect(isMonitorEngine(null)).toBe(false);
  });

  it("every profile is complete and only names known tiles, events and wait buckets", () => {
    for (const engine of ["postgres", "mysql", "mssql"] as const) {
      const p = engineProfile(engine);
      expect(p.engine).toBe(engine);
      expect(p.waitLabels).toHaveLength(WAIT_TYPES.length);
      expect(p.views[0]).toBe("overview");
      expect(p.views).toContain("activity");
      for (const k of Object.keys(p.tiles)) expect(TILE_KEYS as readonly string[]).toContain(k);
      for (const e of p.events) expect(EVENT_KINDS as readonly string[]).toContain(e);
      for (const text of Object.values(p.charts)) {
        for (const pane of text?.omit ?? []) for (const k of pane) expect(k).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("PostgreSQL keeps every view, chart and series", () => {
    const pg = engineProfile("postgres");
    expect(pg.views).toHaveLength(7);
    expect(Object.keys(pg.charts)).toHaveLength(0);
    expect(pg.waitLabels).toEqual(WAIT_TYPES);
    expect(pg.signalSql("cancel", 42)).toBe("SELECT pg_cancel_backend(42)");
    expect(pg.signalSql("terminate", 42)).toBe("SELECT pg_terminate_backend(42)");
  });

  it("MySQL and SQL Server drop what they have no counter for", () => {
    const my = engineProfile("mysql");
    expect(viewFor(my, "statements")).toBe("overview");
    expect(viewFor(my, "locks")).toBe("locks");
    expect(viewFor(my, "activity")).toBe("activity");
    expect(omitted(my.charts.tuples, 1).has(0)).toBe(true);
    expect(seriesLabel(my.charts.tuples, 1, 1, "Returned")).toBe("Read");
    expect(seriesLabel(my.charts.tuples, 0, 0, "Inserted")).toBe("Inserted");
    expect(my.signalSql("cancel", 7)).toBe("KILL QUERY 7");
    expect(my.signalSql("terminate", 7)).toBe("KILL CONNECTION 7");
    expect(my.canCancel).toBe(true);
    expect(my.events).not.toContain("checkpoint");

    const ms = engineProfile("mssql");
    expect(ms.charts.tuples?.hidden).toBe(true);
    expect(omitted(ms.charts.tps, 0).has(1)).toBe(true);
    expect(ms.canCancel).toBe(false);
    expect(ms.signalSql("terminate", 57)).toBe("KILL 57");
    expect(ms.waitLabels[4]).toBe("Parallelism");
  });
});
