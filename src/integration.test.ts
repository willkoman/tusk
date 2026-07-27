import { beforeEach, describe, expect, it } from "vitest";
import { aiStore, normalizeAiConfig } from "./ai/store";
import { defaultExportOptions } from "./export";
import { formatWithOptions, type Dataset } from "./formats";
import { slackHistoryKey, type SlackExecuted } from "./slackEvents";
import { setSqlDialect } from "./sql/ident";
import { tabsStore } from "./store";
import { makeTab, snapshotTabs } from "./tabs";
import { historyStore, makeEntryId } from "./history/store";
import { ACTIONS } from "./actions";
import { IDLE_TRANSACTION, acceptTransactionStatus, transactionHistorySql, type TransactionStatus } from "./transaction";

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
  setSqlDialect("postgres");
});

describe("cross-module integration contracts", () => {
  it("round-trips an unsaved live editor document through verified recovery", () => {
    const tab = makeTab({ sql: "SELECT 1", filePath: "query.sql", dirty: false });
    const snapshot = snapshotTabs([tab], tab.id, "UPDATE items SET active = false");
    expect(snapshot.tabs[0].dirty).toBe(true);
    expect(tabsStore.saveForClose("connection", snapshot).ok).toBe(true);

    const loaded = tabsStore.loadResult("connection");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok || !loaded.value) return;
    const restored = makeTab(loaded.value.tabs[0]);
    expect(restored.sql).toBe("UPDATE items SET active = false");
    expect(restored.dirty).toBe(true);
  });

  it("routes Slack audit history by source connection, not current connection", () => {
    const event: SlackExecuted = {
      sql: "SELECT 1",
      durationMs: 7,
      status: "ok",
      rows: 1,
      slackUser: "U1",
      connectionId: "conn-old",
      database: "analytics",
      connection: { id: "conn-old", database: "analytics", driver: "duckdb" },
    };
    const routes = new Map([
      ["conn-old", "profile:analytics"],
      ["conn-current", "profile:production"],
    ]);
    expect(slackHistoryKey(event, routes)).toBe("profile:analytics");
    expect(slackHistoryKey({ ...event, connection: { ...event.connection, id: "conn-current" } }, routes)).toBeNull();
  });

  it("keeps loaded export dialect and text bytes aligned with backend formatters", () => {
    const sqlData: Dataset = { columns: ["co`l"], rows: [["path\\name's"]] };
    const sql = {
      ...defaultExportOptions("ta`ble"),
      format: "sql" as const,
      sql: { table: "ta`ble", multiRow: false, includeCreate: true },
    };
    // Explicit source dialect wins even if the mutable editor dialect says Postgres.
    expect(formatWithOptions(sqlData, sql, "mysql")).toBe(
      "CREATE TABLE `ta``ble` (`co``l` text);\n" +
      "INSERT INTO `ta``ble` (`co``l`) VALUES (CONVERT(X'706174685c6e616d652773' USING utf8mb4));\n",
    );

    const markdown = { ...defaultExportOptions("x"), format: "markdown" as const, bom: true };
    expect(formatWithOptions({ columns: ["a|b"], rows: [["x\\|y\nz"]] }, markdown, "sqlite"))
      .toBe("\uFEFF| a\\|b |\n| --- |\n| x\\\\|y z |\n");

    const json = { ...defaultExportOptions("x"), format: "json" as const };
    expect(formatWithOptions({ columns: ["id", "ok"], rows: [["1", "t"]] }, { ...json, boolCols: [1] }, "postgres"))
      .toBe('[\n  {"id": "1","ok": true}\n]\n');
    expect(() => formatWithOptions({ columns: ["id", "id"], rows: [["1", "2"]] }, json, "postgres"))
      .toThrow(/unique column names/i);
  });

  it("publishes the canonical AI model map to every mounted consumer", () => {
    const seen: string[] = [];
    const stop = aiStore.subscribe((config) => seen.push(config.models.openai ?? ""));
    expect(aiStore.save(normalizeAiConfig({ provider: "openai", model: "gpt-test", models: {} }))).toBe(true);
    stop();
    expect(seen).toEqual(["gpt-test"]);
    expect(aiStore.load().models.openai).toBe("gpt-test");
  });

  it("applies a transaction revision even when the originating UI payload becomes stale", () => {
    const response: TransactionStatus = {
      state: "active",
      revision: 1,
      id: "tx-9",
      owner: "tab-a",
      mode: "explicit",
      health: "healthy",
    };
    const originRevision = IDLE_TRANSACTION.revision;
    const accepted = acceptTransactionStatus(IDLE_TRANSACTION, response, 4, 4);
    expect(accepted.accepted).toBe(true);
    expect(accepted.status).toEqual(response);
    expect(originRevision).not.toBe(accepted.status.revision);
    expect(acceptTransactionStatus(accepted.status, IDLE_TRANSACTION, 4, 4).accepted).toBe(false);
  });

  it("keeps transaction controls and repeated SQL from distinct transactions in history", () => {
    const key = `integration:transaction:${Date.now()}`;
    const base = { durationMs: 1, status: "ok" as const, rows: null, error: null, schema: null };
    const first = transactionHistorySql("SELECT 1", "tx-1@first", 2, "statement");
    const second = transactionHistorySql("SELECT 1", "tx-2@second", 2, "statement");
    const now = Date.now();
    historyStore.append(key, { ...base, id: makeEntryId(now), ts: now, sql: first });
    const entries = historyStore.append(key, { ...base, id: makeEntryId(now + 1), ts: now + 1, sql: second });
    expect(entries.slice(0, 2).map((entry) => entry.sql)).toEqual([second, first]);
    expect(ACTIONS.some((action) => action.id === "commitTransaction" && action.defaultKey)).toBe(true);
    expect(ACTIONS.some((action) => action.id === "rollbackTransaction" && action.defaultKey)).toBe(true);
  });
});
