import { describe, expect, it } from "vitest";
import { acceptPickedPath, judgePicker } from "./filePicker";

describe("acceptPickedPath", () => {
  it("accepts an absolute path naming a file", () => {
    expect(acceptPickedPath("C:\\Users\\me\\Documents\\query.sql")).toBe("C:\\Users\\me\\Documents\\query.sql");
    expect(acceptPickedPath("/home/me/query.sql")).toBe("/home/me/query.sql");
    expect(acceptPickedPath("\\\\server\\share\\query.sql")).toBe("\\\\server\\share\\query.sql");
    expect(acceptPickedPath("  C:/tmp/a.csv  ")).toBe("C:/tmp/a.csv");
  });

  it("rejects cancel, and anything that is not a chosen file", () => {
    expect(acceptPickedPath(null)).toBeNull();
    expect(acceptPickedPath(undefined)).toBeNull();
    expect(acceptPickedPath("")).toBeNull();
    expect(acceptPickedPath("   ")).toBeNull();
    // An array is a multi-select result; the save/open wrappers ask for one path.
    expect(acceptPickedPath(["C:\\a.sql"])).toBeNull();
    // A bare name means the dialog never resolved a real destination.
    expect(acceptPickedPath("Untitled 9.sql")).toBeNull();
    expect(acceptPickedPath("./out.csv")).toBeNull();
    // A directory is not a file to write.
    expect(acceptPickedPath("C:\\Users\\me\\Downloads\\")).toBeNull();
    expect(acceptPickedPath("/home/me/")).toBeNull();
  });
});

describe("judgePicker", () => {
  // The smoke defect: `save()` resolved to a default path in Downloads and no picker
  // window ever appeared. A dialog that is never shown never takes focus from the web
  // view, so the result is usable but unverified — the caller must confirm, never write.
  it("marks a result unverified when the picker never took focus", () => {
    expect(judgePicker("C:\\Users\\me\\Downloads\\Untitled 9.sql", false)).toEqual({
      path: "C:\\Users\\me\\Downloads\\Untitled 9.sql",
      verified: false,
    });
  });
  it("verifies a result from a picker that was actually shown", () => {
    expect(judgePicker("C:\\Users\\me\\Downloads\\Untitled 9.sql", true)).toEqual({
      path: "C:\\Users\\me\\Downloads\\Untitled 9.sql",
      verified: true,
    });
  });
  it("cancel is cancel either way — nothing to confirm", () => {
    expect(judgePicker(null, true)).toEqual({ path: null, verified: false });
    expect(judgePicker(null, false)).toEqual({ path: null, verified: false });
    // An unusable path is a cancel too, even if a dialog did appear.
    expect(judgePicker("Untitled 9.sql", true)).toEqual({ path: null, verified: false });
  });
});
