import { describe, expect, it } from "vitest";
import { blockText, buildIndex, markRuns, search, splitSections, stripInline } from "./search";
import type { Topic } from "./types";

const topic: Topic = {
  id: "results",
  title: "The result grid",
  blurb: "Streaming pages and copy.",
  icon: "table",
  blocks: [
    { k: "p", md: "Intro paragraph about **streaming** results." },
    { k: "h", text: "Streaming and the single cursor", id: "streaming" },
    { k: "p", md: "Pages of `1,000 rows` stream in via [[kbd:Mod-Enter]]." },
    { k: "tip", md: "Only one tab streams at a time.", kind: "warn" },
    { k: "h", text: "Copy formats", id: "copy" },
    { k: "list", items: ["Copy as **TSV**", "Copy as [[topic:import-export|CSV export]]"] },
    { k: "table", head: ["Format", "Notes"], rows: [["JSON", "array of objects"]] },
    { k: "keys", rows: [{ action: "run", does: "Run the query" }, { combo: "Alt-N", does: "Set NULL" }] },
  ],
};

describe("stripInline", () => {
  it("removes every inline marker but keeps the words", () => {
    expect(stripInline("**bold** `code` *it* [[kbd:Mod-.]] [[topic:erd|the ERD]] [[topic:plans]]"))
      .toBe("bold code it Mod-. the ERD plans");
  });
});

describe("splitSections", () => {
  it("separates the preamble from h-delimited sections with previews", () => {
    const { preamble, sections } = splitSections(topic);
    expect(preamble).toHaveLength(1);
    expect(sections.map((s) => s.id)).toEqual(["streaming", "copy"]);
    expect(sections[0].preview).toBe("Pages of 1,000 rows stream in via Mod-Enter.");
    expect(sections[1].blocks).toHaveLength(3);
  });
});

describe("blockText", () => {
  it("flattens tables and keys rows into searchable text", () => {
    expect(blockText(topic.blocks[6])).toContain("array of objects");
    expect(blockText(topic.blocks[7])).toContain("Set NULL");
  });
});

describe("search", () => {
  const index = buildIndex([topic]);

  it("finds a body term and reports its section", () => {
    const hits = search(index, "1,000 rows");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].sectionId).toBe("streaming");
    expect(hits[0].snippet).toContain("1,000 rows");
  });

  it("ANDs terms — both must appear in the same entry", () => {
    expect(search(index, "cursor JSON")).toHaveLength(0);
    expect(search(index, "copy JSON").length).toBeGreaterThan(0);
  });

  it("ranks a topic-title match above a body-only match", () => {
    const hits = search(index, "grid");
    expect(hits[0].topicId).toBe("results");
    expect(hits[0].score).toBeGreaterThanOrEqual(40);
  });

  it("ignores one-character terms and empty queries", () => {
    expect(search(index, "a")).toHaveLength(0);
    expect(search(index, "  ")).toHaveLength(0);
  });

  it("produces highlight ranges that match the snippet text", () => {
    const [hit] = search(index, "streams");
    for (const [s, e] of hit.ranges) {
      expect(hit.snippet.slice(s, e).toLowerCase()).toBe("streams");
    }
  });
});

describe("markRuns", () => {
  it("splits text into plain/hit runs and tolerates overlap", () => {
    const runs = markRuns("abcdef", [[1, 3], [2, 4]]);
    expect(runs.map((r) => r.text).join("")).toBe("abcdef");
    expect(runs.filter((r) => r.hit).map((r) => r.text).join("")).toBe("bcd");
  });
});
