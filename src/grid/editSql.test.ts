import { afterEach, describe, expect, it } from "vitest";
import { buildCommitScript, type CommitInput } from "./editSql";
import { setSqlDialect } from "../sql/ident";
import { EMPTY_PENDING } from "../tabs";

afterEach(() => setSqlDialect("postgres"));

const base = (over: Partial<CommitInput> = {}): CommitInput => ({
  schema: "public",
  table: "users",
  columns: ["id", "email", "note"],
  isTableCol: [true, true, true],
  pkIdx: [0],
  rows: [
    ["1", "a@x.com", null],
    ["2", "b@x.com", "hi"],
  ],
  pending: { ...EMPTY_PENDING },
  ...over,
});

describe("buildCommitScript", () => {
  it("emits UPDATE, DELETE, INSERT in that order", () => {
    const out = buildCommitScript(base({
      pending: {
        cells: { 0: { 1: "new@x.com" } },
        deletes: [1],
        inserts: [{ 1: "c@x.com" }],
      },
    }));
    expect(out).toEqual([
      `UPDATE "public"."users" SET "email" = 'new@x.com' WHERE "id" = '1'`,
      `DELETE FROM "public"."users" WHERE "id" = '2'`,
      `INSERT INTO "public"."users" ("email") VALUES ('c@x.com')`,
    ]);
  });

  it("WHERE uses ORIGINAL values even when the PK cell was edited", () => {
    const out = buildCommitScript(base({
      pending: { cells: { 0: { 0: "99" } }, deletes: [], inserts: [] },
    }));
    expect(out).toEqual([`UPDATE "public"."users" SET "id" = '99' WHERE "id" = '1'`]);
  });

  it("NULL original PK compares with IS NULL; NULL edit writes NULL", () => {
    const out = buildCommitScript(base({
      pkIdx: [2],
      pending: { cells: { 0: { 1: null } }, deletes: [], inserts: [] },
    }));
    expect(out).toEqual([`UPDATE "public"."users" SET "email" = NULL WHERE "note" IS NULL`]);
  });

  it("composite PK AND-ed; quotes escaped", () => {
    const out = buildCommitScript(base({
      pkIdx: [0, 1],
      rows: [["1", "o'brien@x.com", null]],
      pending: { cells: {}, deletes: [0], inserts: [] },
    }));
    expect(out).toEqual([
      `DELETE FROM "public"."users" WHERE "id" = '1' AND "email" = 'o''brien@x.com'`,
    ]);
  });

  it("delete wins over edits on the same row", () => {
    const out = buildCommitScript(base({
      pending: { cells: { 1: { 1: "x@x.com" } }, deletes: [1], inserts: [] },
    }));
    expect(out).toEqual([`DELETE FROM "public"."users" WHERE "id" = '2'`]);
  });

  it("skips non-table columns and rows with no effective edits", () => {
    const out = buildCommitScript(base({
      isTableCol: [true, false, true],
      pending: { cells: { 0: { 1: "x" } }, deletes: [], inserts: [{ 1: "y" }] },
      dialect: "postgres",
    }));
    expect(out).toEqual([`INSERT INTO "public"."users" DEFAULT VALUES`]);
  });

  it("INSERT includes only touched cells; explicit NULL kept", () => {
    const out = buildCommitScript(base({
      pending: { cells: {}, deletes: [], inserts: [{ 1: "c@x.com", 2: null }] },
    }));
    expect(out).toEqual([`INSERT INTO "public"."users" ("email", "note") VALUES ('c@x.com', NULL)`]);
  });

  it("uses backticks + MySQL empty-insert form under the mysql dialect", () => {
    setSqlDialect("mysql");
    const out = buildCommitScript(base({
      pending: { cells: { 0: { 1: "z" } }, deletes: [], inserts: [{}] },
      dialect: "mysql",
    }));
    expect(out).toEqual([
      "UPDATE `public`.`users` SET `email` = _utf8mb4 X'7a' WHERE `id` = _utf8mb4 X'31'",
      "INSERT INTO `public`.`users` () VALUES ()",
    ]);
  });
});
