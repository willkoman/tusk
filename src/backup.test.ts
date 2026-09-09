import { describe, it, expect } from "vitest";
import {
  backupBlocker,
  backupPayload,
  backupProgressLine,
  defaultBackupOptions,
  defaultRestoreOptions,
  engineMismatch,
  formatBytes,
  formatElapsed,
  parseBackupHeader,
  restoreProgressLine,
  restoreResultLine,
  supportsSingleTransaction,
  type BackupOptions,
  type RestoreSummary,
} from "./backup";

const HEADER = [
  "-- Tusk backup",
  "-- tusk-version: 0.9.8",
  "-- engine: postgres",
  "-- database: shop",
  "-- generated: 2026-09-08T10:11:12Z",
  "-- scope: database",
  "-- content: schema+data",
  "-- include-drop: no",
  "-- single-transaction: yes",
  "--",
  "-- Replay with Tusk (Restore from file…) or this engine's CLI client.",
  "",
  "BEGIN;",
].join("\n");

describe("backup options", () => {
  it("defaults single-transaction on for transactional-DDL engines only", () => {
    expect(supportsSingleTransaction("postgres")).toBe(true);
    expect(supportsSingleTransaction("duckdb")).toBe(true);
    expect(supportsSingleTransaction("sqlite")).toBe(true);
    expect(supportsSingleTransaction("mysql")).toBe(false);
    expect(defaultBackupOptions("mysql").singleTransaction).toBe(false);
    expect(defaultBackupOptions("postgres").singleTransaction).toBe(true);
  });

  it("drops selections the scope does not use from the payload", () => {
    const base: BackupOptions = {
      ...defaultBackupOptions("postgres"),
      schemas: ["public", "audit"],
      tables: [{ schema: "public", name: "users" }],
    };
    expect(backupPayload("conn-1", "/tmp/a.sql", base).options).toMatchObject({
      scope: "database",
      schemas: [],
      tables: [],
    });
    expect(backupPayload("conn-1", "/tmp/a.sql", { ...base, scope: "schemas" }).options.schemas).toEqual([
      "public",
      "audit",
    ]);
    const tables = backupPayload("conn-1", "/tmp/a.sql", { ...base, scope: "tables" }).options;
    expect(tables.tables).toEqual([{ schema: "public", name: "users" }]);
    expect(tables.schemas).toEqual([]);
  });

  it("keeps the connection id and path beside the options", () => {
    const payload = backupPayload("conn-7", "/tmp/dump.sql", defaultBackupOptions("sqlite"));
    expect(payload.connectionId).toBe("conn-7");
    expect(payload.path).toBe("/tmp/dump.sql");
  });

  it("blocks an empty selection with a reason", () => {
    const o = defaultBackupOptions("postgres");
    expect(backupBlocker(o)).toBe("");
    expect(backupBlocker({ ...o, scope: "schemas" })).toMatch(/schema/);
    expect(backupBlocker({ ...o, scope: "tables" })).toMatch(/table/);
    expect(backupBlocker({ ...o, scope: "tables", tables: [{ schema: "s", name: "t" }] })).toBe("");
  });

  it("defaults restore to stop-on-error", () => {
    expect(defaultRestoreOptions()).toEqual({ stopOnError: true, singleTransaction: false });
  });
});

describe("header parsing", () => {
  it("reads every field of a Tusk dump preamble", () => {
    expect(parseBackupHeader(HEADER)).toEqual({
      tuskVersion: "0.9.8",
      engine: "postgres",
      database: "shop",
      generated: "2026-09-08T10:11:12Z",
      scope: "database",
      content: "schema+data",
    });
  });

  it("returns null for a file that is not a Tusk dump", () => {
    expect(parseBackupHeader("-- PostgreSQL database dump\nSET x = 1;")).toBeNull();
    expect(parseBackupHeader("")).toBeNull();
    expect(parseBackupHeader("CREATE TABLE t (a int);")).toBeNull();
  });

  it("tolerates a truncated or field-less preamble", () => {
    expect(parseBackupHeader("-- Tusk backup\n-- engine: mysql")).toEqual({
      tuskVersion: "",
      engine: "mysql",
      database: "",
      generated: "",
      scope: "",
      content: "",
    });
    // A value containing a colon keeps everything after the first one.
    expect(parseBackupHeader("-- Tusk backup\n-- generated: 2026-09-08T10:11:12Z")?.generated).toBe(
      "2026-09-08T10:11:12Z",
    );
  });

  it("warns only on a real engine mismatch", () => {
    const header = parseBackupHeader(HEADER);
    expect(engineMismatch(header, "postgres")).toBe("");
    expect(engineMismatch(header, "mysql")).toMatch(/postgres/);
    expect(engineMismatch(header, "mysql")).toMatch(/mysql/);
    expect(engineMismatch(null, "mysql")).toBe("");
    expect(engineMismatch(header, undefined)).toBe("");
  });
});

describe("progress formatting", () => {
  it("scales bytes and rejects nonsense", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024 * 3.5)).toBe("3.5 MB");
    expect(formatBytes(1024 * 1024 * 1024 * 2)).toBe("2.0 GB");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(4500)).toBe("4s");
    expect(formatElapsed(65_000)).toBe("1m 5s");
  });

  it("describes each backup phase", () => {
    expect(backupProgressLine(null)).toBe("Starting…");
    expect(
      backupProgressLine({ phase: "data", object: "public.users", tablesDone: 1, tablesTotal: 4, rows: 1200, bytes: 2048 }),
    ).toBe("Data · public.users (1/4 tables) · 1,200 rows · 2.0 KB");
    expect(
      backupProgressLine({ phase: "constraints", object: "foreign keys", tablesDone: 4, tablesTotal: 4, rows: 9, bytes: 10 }),
    ).toMatch(/^Foreign keys/);
    expect(
      backupProgressLine({ phase: "done", object: "", tablesDone: 4, tablesTotal: 4, rows: 9, bytes: 10 }),
    ).toBe("Finished — 9 rows, 10 B");
  });

  it("describes restore progress with an unknown total", () => {
    expect(restoreProgressLine(null)).toBe("Starting…");
    expect(
      restoreProgressLine({ statementsDone: 12, statementsTotal: null, current: "CREATE TABLE users", rowsCopied: 0, bytesRead: 4096 }),
    ).toBe("12 statements · 4.0 KB read · CREATE TABLE users");
    expect(
      restoreProgressLine({ statementsDone: 40, statementsTotal: 40, current: "", rowsCopied: 500, bytesRead: 0 }),
    ).toBe("40 / 40 statements · 500 rows copied · 0 B read");
  });

  it("summarizes a finished restore", () => {
    const base: RestoreSummary = {
      statementsOk: 10,
      statementsFailed: 0,
      rowsCopied: 25,
      bytesRead: 100,
      firstError: null,
      cancelled: false,
      singleTransaction: true,
      committed: true,
    };
    expect(restoreResultLine(base)).toBe("10 statements ran, 25 rows copied, committed");
    expect(restoreResultLine({ ...base, statementsFailed: 2, committed: false })).toBe(
      "10 statements ran, 2 failed, 25 rows copied, rolled back, nothing applied",
    );
    expect(restoreResultLine({ ...base, cancelled: true, committed: false })).toMatch(/cancelled/);
    expect(restoreResultLine({ ...base, statementsOk: 0, rowsCopied: 0, committed: false })).toBe(
      "0 statements ran, rolled back, nothing applied",
    );

    // Without a wrapper there is nothing to commit: statements that ran are durable,
    // so the line must not imply a rollback that never happened.
    const loose: RestoreSummary = { ...base, singleTransaction: false, committed: false };
    expect(restoreResultLine(loose)).toBe("10 statements ran, 25 rows copied");
    expect(restoreResultLine({ ...loose, statementsOk: 0, rowsCopied: 0 })).toBe(
      "0 statements ran, nothing applied",
    );
    expect(restoreResultLine({ ...loose, cancelled: true })).toBe(
      "10 statements ran, 25 rows copied, cancelled",
    );
  });
});
