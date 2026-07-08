import { describe, expect, it } from "vitest";
import { fuzzy, fuzzyRank, highlight } from "./fuzzy";

/** The shapes the picker actually sees: bare ids, vendor-namespaced router ids, locals. */
const MODELS = [
  "claude-opus-4-8", "claude-fable-5", "claude-sonnet-5", "claude-haiku-4-5",
  "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.3-codex",
  "gemini-3.5-flash", "gemini-3.1-pro-preview",
  "openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b",
  "anthropic/claude-opus-4.8", "deepseek/deepseek-v4-pro",
  "llama3.1:8b", "mistral:latest",
];
const rank = (q: string) => fuzzyRank(q, MODELS, (m) => m).map((r) => r.item);

describe("fuzzy matching", () => {
  it("an empty query keeps every item in its original order", () => {
    expect(rank("")).toEqual(MODELS);
    expect(rank("   ")).toEqual(MODELS);
  });

  it("excludes a candidate the query isn't even a subsequence of", () => {
    // `gpt-5` has no `5` available after `gpt-` in `openai/gpt-oss-120b`.
    const r = rank("gpt-5");
    expect(r[0]).toMatch(/^gpt-5/);
    expect(r).not.toContain("openai/gpt-oss-120b");
  });

  it("ranks an exact substring earlier in the id above the same substring later", () => {
    const r = rank("gpt");
    expect(r[0]).toMatch(/^gpt-/); // starts the id
    expect(r.indexOf("openai/gpt-oss-120b")).toBeGreaterThan(r.indexOf("gpt-5.5"));
  });

  it("prefers a contiguous substring over a scattered subsequence of the same query", () => {
    // "sonnet5" is contiguous nowhere, but "sonnet" is; against a scatter-only rival the
    // substring hit must win.
    const r = fuzzyRank("sonnet", ["claude-sonnet-5", "s-o-n-n-e-t-x"], (s) => s);
    expect(r[0].item).toBe("claude-sonnet-5");
  });

  it("ranks a word-start match above a mid-word one", () => {
    // "oss" starts a word in `gpt-oss-120b`; it appears mid-token nowhere else.
    expect(rank("oss")[0]).toMatch(/gpt-oss/);
  });

  it("matches an abbreviation across separators", () => {
    expect(rank("co48")).toContain("claude-opus-4-8");
    expect(rank("cs5")[0]).toBe("claude-sonnet-5");
  });

  it("multi-term is AND, so vendor + model narrows a router catalog", () => {
    const r = rank("ant opus");
    expect(r[0]).toBe("anthropic/claude-opus-4.8");
    expect(r).not.toContain("gpt-5.5"); // "ant" matches nothing there
  });

  it("rejects a query that is not a subsequence", () => {
    expect(fuzzy("zzz", "claude-opus-4-8")).toBeNull();
    expect(rank("zzz")).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(rank("OPUS")).toContain("claude-opus-4-8");
    expect(rank("Gemini")[0]).toMatch(/^gemini/);
  });

  it("handles ollama-style ids with a colon", () => {
    expect(rank("llama")[0]).toBe("llama3.1:8b");
    expect(rank("8b")).toContain("llama3.1:8b");
  });

  it("ties keep input order, so an unsearched tier list stays curated", () => {
    const items = ["a-x", "b-x", "c-x"];
    expect(fuzzyRank("", items, (s) => s).map((r) => r.item)).toEqual(items);
  });
});

describe("highlight", () => {
  it("splits into alternating plain/hit runs", () => {
    const m = fuzzy("opus", "claude-opus-4-8")!;
    expect(highlight("claude-opus-4-8", m.indices)).toEqual([
      { text: "claude-", hit: false },
      { text: "opus", hit: true },
      { text: "-4-8", hit: false },
    ]);
  });

  it("handles a hit at index 0 and an empty index list", () => {
    expect(highlight("abc", [0])).toEqual([{ text: "a", hit: true }, { text: "bc", hit: false }]);
    expect(highlight("abc", [])).toEqual([{ text: "abc", hit: false }]);
  });

  it("reassembles the original text exactly", () => {
    const text = "anthropic/claude-opus-4.8";
    const m = fuzzy("ant opus", text)!;
    expect(highlight(text, m.indices).map((p) => p.text).join("")).toBe(text);
  });
});
