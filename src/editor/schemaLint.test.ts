import { describe, expect, it } from "vitest";
import { schemaDiagnostics } from "./schemaLint";
import { lex } from "./lexer";
import { buildIndex, type Table } from "../sql/aliases";

// Pure-core tests for the schema-aware lint — heavy on FALSE-POSITIVE guards:
// a wrong squiggle destroys trust faster than a missed one.

const TABLES: Table[] = [
  {
    schema: "public",
    name: "users",
    columns: [
      { name: "id", data_type: "int" },
      { name: "email", data_type: "text" },
      { name: "created_at", data_type: "timestamptz" },
    ],
  },
  {
    schema: "public",
    name: "orders",
    columns: [
      { name: "id", data_type: "int" },
      { name: "user_id", data_type: "int" },
      { name: "total", data_type: "numeric" },
    ],
  },
];
const IDX = buildIndex(TABLES);
const FUNCS: ReadonlySet<string> = new Set(["count", "sum", "lower", "now", "jsonb_path_query", "my_proc"]);
const NO_FUNCS: ReadonlySet<string> = new Set();

function diag(sql: string, funcs: ReadonlySet<string> = FUNCS) {
  const { spans, stmts } = lex(sql);
  return schemaDiagnostics(sql, spans, stmts, IDX, funcs);
}
const msgs = (sql: string, funcs?: ReadonlySet<string>) => diag(sql, funcs).map((d) => d.message);

describe("schemaDiagnostics — detections", () => {
  it("flags unknown qualified columns with a suggestion", () => {
    const out = diag("SELECT u.emial FROM users u");
    expect(out.length).toBe(1);
    expect(out[0].message).toContain('no column "emial"');
    expect(out[0].suggestion).toBe("email");
  });

  it("flags unknown tables", () => {
    expect(msgs("SELECT * FROM userz")[0]).toContain('unknown table "userz"');
  });

  it("flags unknown bare columns in a fully-resolved statement", () => {
    const out = diag("SELECT emial FROM users");
    expect(out.length).toBe(1);
    expect(out[0].message).toContain('unknown identifier "emial"');
    expect(out[0].suggestion).toBe("email");
  });

  it("suggests via prefix: under-typed column names resolve to the real one", () => {
    // "created" → "created_at" is 3 raw edits (over the damerau threshold) but
    // a prefix of the real column — must still suggest.
    const out = diag("SELECT created FROM users");
    expect(out.length).toBe(1);
    expect(out[0].suggestion).toBe("created_at");
    const q = diag("SELECT u.created FROM users u");
    expect(q[0].suggestion).toBe("created_at");
  });

  it("flags misspelled mid-statement keywords via the bare-identifier check", () => {
    const out = diag("SELECT id FORM users");
    // FORM: not a keyword, not a column → flagged, suggests FROM. ("users"
    // is no longer a table ref since FROM is mangled — that's fine, one
    // precise squiggle on the actual typo.)
    const hit = out.find((d) => d.message.includes('"FORM"'));
    expect(hit).toBeTruthy();
    expect(hit!.suggestion).toBe("FROM");
  });

  it("flags unknown functions when the catalog is loaded", () => {
    const out = diag("SELECT cont(id) FROM users");
    const hit = out.find((d) => d.message.includes('unknown function "cont"'));
    expect(hit).toBeTruthy();
    expect(hit!.suggestion).toBe("count");
  });

  it("flags unknown procs in CALL statements", () => {
    const out = diag("CALL my_prok(1)");
    expect(out.some((d) => d.message.includes('unknown function "my_prok"'))).toBe(true);
  });
});

describe("schemaDiagnostics — false-positive guards", () => {
  it("clean realistic query produces zero diagnostics", () => {
    expect(
      msgs(
        "SELECT u.id, lower(u.email) AS mail, count(*) FROM users u JOIN orders o ON o.user_id = u.id WHERE u.created_at > now() GROUP BY u.id, mail ORDER BY mail DESC LIMIT 10",
      ),
    ).toEqual([]);
  });

  it("function lint is OFF with an empty catalog", () => {
    expect(msgs("SELECT totally_made_up_fn(id) FROM users", NO_FUNCS)).toEqual([]);
  });

  it("EXTRACT fields / INTERVAL units / CAST targets are not columns", () => {
    expect(msgs("SELECT EXTRACT(YEAR FROM created_at), CAST(id AS bigint) FROM users WHERE created_at > now() - INTERVAL '1 day'")).toEqual([]);
  });

  it("SELECT-item aliases are usable in GROUP/ORDER BY", () => {
    expect(msgs("SELECT email AS contact FROM users ORDER BY contact")).toEqual([]);
  });

  it("CTE statements skip the bare-identifier check entirely", () => {
    expect(msgs("WITH recent AS (SELECT id, email FROM users) SELECT whatever_col FROM recent")).toEqual([]);
  });

  it("derived tables skip the bare-identifier check", () => {
    expect(msgs("SELECT sub_col FROM (SELECT id AS sub_col FROM users) x")).toEqual([]);
  });

  it("statements with an unresolved table skip bare-column checking (one squiggle, not two)", () => {
    const out = diag("SELECT email FROM userz");
    expect(out.length).toBe(1); // only the unknown-table warning
    expect(out[0].message).toContain("unknown table");
  });

  it("window definitions and USING refs are not flagged", () => {
    expect(msgs("SELECT email, sum(id) OVER w FROM users WINDOW w AS (ORDER BY created_at)")).toEqual([]);
  });

  it("dollar params, casts to custom types, and quoted identifiers are skipped", () => {
    expect(msgs('SELECT id FROM users WHERE email = $1 AND id = id::my_custom_domain AND "Weird Col" IS NULL')).toEqual([]);
  });

  it("DDL and utility statements never run the bare-identifier check", () => {
    expect(msgs("CREATE INDEX idx_x ON users (lower(email))")).toEqual([]);
    expect(msgs("GRANT SELECT ON users TO somebody")).toEqual([]);
  });

  it("schema-qualified function calls check the bare name", () => {
    expect(msgs("SELECT public.my_proc(1) FROM users")).toEqual([]);
    expect(msgs("SELECT other_catalog.mystery_fn(1) FROM users")).toEqual([]); // unknown schema → skip
  });
});
