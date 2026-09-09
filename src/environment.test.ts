import { describe, expect, it } from "vitest";
import {
  ENVIRONMENTS,
  connectionDisplayName,
  environmentClass,
  isProduction,
  parseEnvironment,
  serializeEnvironment,
} from "./environment";

describe("parseEnvironment", () => {
  it("accepts every known tag, case- and whitespace-insensitively", () => {
    for (const e of ENVIRONMENTS) {
      expect(parseEnvironment(e)).toBe(e);
      expect(parseEnvironment(e.toUpperCase())).toBe(e);
      expect(parseEnvironment(`  ${e} `)).toBe(e);
    }
  });

  it("degrades anything it does not know to none", () => {
    // A tag can only ever make a connection look louder, never safer, so an
    // unreadable field loses the tag rather than inventing one.
    for (const bad of [null, undefined, 42, {}, [], "", "production", "PROD ONLY", "qa"]) {
      expect(parseEnvironment(bad)).toBe("none");
    }
  });
});

describe("serializeEnvironment", () => {
  it("stores an untagged profile as null, not the string none", () => {
    expect(serializeEnvironment("none")).toBeNull();
    expect(serializeEnvironment("prod")).toBe("prod");
    expect(serializeEnvironment("staging")).toBe("staging");
  });

  it("round-trips through parse", () => {
    for (const e of ENVIRONMENTS) expect(parseEnvironment(serializeEnvironment(e))).toBe(e);
  });
});

describe("isProduction / environmentClass", () => {
  it("marks only prod as production", () => {
    expect(isProduction("prod")).toBe(true);
    expect(isProduction("staging")).toBe(false);
    expect(isProduction("dev")).toBe(false);
    expect(isProduction("none")).toBe(false);
  });

  it("emits no class for an untagged connection", () => {
    expect(environmentClass("none")).toBe("");
    expect(environmentClass("prod")).toBe("env-prod");
    expect(environmentClass("dev")).toBe("env-dev");
  });
});

describe("connectionDisplayName", () => {
  it("uses the database name alone until qualification is asked for", () => {
    expect(connectionDisplayName("app", "db.internal", false)).toBe("app");
  });

  it("prefixes the origin when two labels would otherwise collide", () => {
    expect(connectionDisplayName("postgres", "db.internal", true)).toBe("db.internal/postgres");
  });

  it("falls back to whichever half exists", () => {
    expect(connectionDisplayName("", "db.internal", true)).toBe("db.internal");
    expect(connectionDisplayName("app", "", true)).toBe("app");
    expect(connectionDisplayName("  ", "  ", true)).toBe("");
  });
});
