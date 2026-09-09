import { describe, it, expect } from "vitest";
import { historyLabel, historyTag } from "./format";
import { transactionHistorySql } from "../transaction";

describe("historyTag", () => {
  it("drops the internal transaction id and revision", () => {
    expect(historyTag("Transaction tx-1@mtukt9le; revision 3; rollback")).toBe("Transaction rollback");
  });
  it("reads rollback_to as words", () => {
    expect(historyTag("Transaction tx-1@x; revision 9; rollback_to")).toBe("Transaction rollback to");
  });
  it("passes other markers through", () => {
    expect(historyTag("Explorer")).toBe("Explorer");
    expect(historyTag("Slack")).toBe("Slack");
  });
});

describe("historyLabel", () => {
  it("leaves an ordinary run alone", () => {
    expect(historyLabel("select 1\nfrom t")).toEqual({ tag: null, text: "select 1" });
  });

  it("shows the statement, not the provenance comment", () => {
    const stored = transactionHistorySql("ROLLBACK;", "tx-1@mtukt9le", 3, "rollback");
    expect(stored.split("\n")[0]).toBe("-- [Transaction tx-1@mtukt9le; revision 3; rollback]");
    expect(historyLabel(stored)).toEqual({ tag: "Transaction rollback", text: "ROLLBACK;" });
  });

  it("keeps the stored SQL untouched", () => {
    const stored = transactionHistorySql("UPDATE t SET a = 1;", "tx-2@abc", 7, "statement");
    historyLabel(stored);
    expect(stored).toContain("tx-2@abc");
    expect(stored).toContain("UPDATE t SET a = 1;");
  });

  it("uses a marker's own trailing detail when there is no SQL under it", () => {
    expect(historyLabel("-- [Backup] database/schema → C:\\dump.sql")).toEqual({
      tag: "Backup",
      text: "database/schema → C:\\dump.sql",
    });
  });

  it("skips blank lines under an Explorer marker", () => {
    expect(historyLabel("-- [Explorer]\n\nDROP INDEX \"public\".\"i\";")).toEqual({
      tag: "Explorer",
      text: 'DROP INDEX "public"."i";',
    });
  });

  it("bounds a pathological single line", () => {
    const label = historyLabel("x".repeat(5000));
    expect(label.text.length).toBeLessThanOrEqual(121);
  });

  it("is not fooled by a comment that is not a marker", () => {
    expect(historyLabel("-- just a note\nselect 1")).toEqual({ tag: null, text: "-- just a note" });
  });
});
