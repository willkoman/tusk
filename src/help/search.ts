// Full-text search over the manual + the section splitter the accordion renders
// from. Pure (no DOM, no Solid) and vitest-covered in search.test.ts.

import type { Block, Topic } from "./types";

/** Strip the manual's inline markup down to plain text. */
export function stripInline(md: string): string {
  return md
    .replace(/\[\[kbd:([^\]]+)\]\]/g, "$1")
    .replace(/\[\[topic:[a-z0-9-]+\|([^\]]+)\]\]/g, "$1")
    .replace(/\[\[topic:([a-z0-9-]+)\]\]/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1");
}

/** Searchable plain text of one block ("" for blocks with nothing to match). */
export function blockText(b: Block): string {
  switch (b.k) {
    case "p": return stripInline(b.md);
    case "h": return b.text;
    case "code": return `${b.text} ${b.caption ?? ""}`;
    case "list": return b.items.map(stripInline).join(" ");
    case "table": return [...b.head, ...b.rows.flat()].map(stripInline).join(" ");
    case "tip": return stripInline(b.md);
    case "keys": return b.rows.map((r) => `${r.action ?? r.combo ?? ""} ${stripInline(r.does)}`).join(" ");
    case "demo": return b.caption ? stripInline(b.caption) : "";
  }
}

/** A topic split for the accordion: preamble blocks, then one group per h-block. */
export type Section = {
  /** null for the preamble (blocks before the first heading). */
  id: string | null;
  title: string | null;
  blocks: Block[];
  /** First paragraph, plain — shown as the collapsed-row preview. */
  preview: string;
};

export function splitSections(t: Topic): { preamble: Block[]; sections: Section[] } {
  const preamble: Block[] = [];
  const sections: Section[] = [];
  let cur: Section | null = null;
  for (const b of t.blocks) {
    if (b.k === "h") {
      cur = { id: b.id, title: b.text, blocks: [], preview: "" };
      sections.push(cur);
    } else if (cur) {
      cur.blocks.push(b);
      if (!cur.preview && b.k === "p") cur.preview = stripInline(b.md);
    } else {
      preamble.push(b);
    }
  }
  return { preamble, sections };
}

export type SearchEntry = {
  topicId: string;
  topicTitle: string;
  sectionId: string | null;
  sectionTitle: string | null;
  /** Original-case plain text (snippets); matching lowercases on the fly. */
  raw: string;
};

export function buildIndex(topics: Topic[]): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const t of topics) {
    const { preamble, sections } = splitSections(t);
    out.push({
      topicId: t.id,
      topicTitle: t.title,
      sectionId: null,
      sectionTitle: null,
      raw: `${t.blurb} ${preamble.map(blockText).join(" ")}`,
    });
    for (const s of sections) {
      out.push({
        topicId: t.id,
        topicTitle: t.title,
        sectionId: s.id,
        sectionTitle: s.title,
        raw: `${s.title} ${s.blocks.map(blockText).join(" ")}`,
      });
    }
  }
  return out;
}

export type SearchHit = {
  topicId: string;
  topicTitle: string;
  sectionId: string | null;
  sectionTitle: string | null;
  score: number;
  /** Snippet around the first match + highlight ranges within it. */
  snippet: string;
  ranges: [number, number][];
};

const SNIPPET_PAD = 64;
const MAX_HITS = 30;

/**
 * Multi-term AND search: every term must appear in the entry (title, section
 * title, or body). Title/section hits rank above body hits; body score grows
 * with occurrence count. Case-insensitive substring terms — no stemming.
 */
export function search(index: SearchEntry[], query: string): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  if (!terms.length) return [];
  const hits: SearchHit[] = [];
  for (const e of index) {
    const title = e.topicTitle.toLowerCase();
    const sec = (e.sectionTitle ?? "").toLowerCase();
    const body = e.raw.toLowerCase();
    let score = 0;
    let firstPos = -1;
    let ok = true;
    for (const term of terms) {
      const inTitle = title.includes(term);
      const inSec = sec.includes(term);
      const pos = body.indexOf(term);
      if (!inTitle && !inSec && pos === -1) { ok = false; break; }
      if (inTitle) score += 40;
      if (inSec) score += 25;
      if (pos !== -1) {
        // Occurrences capped so one spammy section can't drown title matches.
        let n = 0;
        for (let i = pos; i !== -1 && n < 5; i = body.indexOf(term, i + term.length)) n++;
        score += n * 4;
        if (firstPos === -1 || pos < firstPos) firstPos = pos;
      }
    }
    if (!ok) continue;
    // Snippet around the first body match (or the start when only titles match).
    const at = Math.max(0, firstPos === -1 ? 0 : firstPos - SNIPPET_PAD);
    const end = Math.min(e.raw.length, (firstPos === -1 ? 0 : firstPos) + SNIPPET_PAD * 2);
    const prefix = at > 0 ? "…" : "";
    const suffix = end < e.raw.length ? "…" : "";
    const window = e.raw.slice(at, end);
    const snippet = prefix + window + suffix;
    const lower = window.toLowerCase();
    const ranges: [number, number][] = [];
    for (const term of terms) {
      for (let i = lower.indexOf(term); i !== -1; i = lower.indexOf(term, i + term.length)) {
        ranges.push([prefix.length + i, prefix.length + i + term.length]);
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    hits.push({
      topicId: e.topicId,
      topicTitle: e.topicTitle,
      sectionId: e.sectionId,
      sectionTitle: e.sectionTitle,
      score,
      snippet,
      ranges,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, MAX_HITS);
}

/** Split `text` into plain/marked runs from (sorted, possibly overlapping) ranges. */
export function markRuns(text: string, ranges: [number, number][]): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let pos = 0;
  for (const [s, e] of ranges) {
    const start = Math.max(s, pos);
    if (e <= pos) continue; // swallowed by the previous (overlapping) range
    if (start > pos) out.push({ text: text.slice(pos, start), hit: false });
    out.push({ text: text.slice(start, e), hit: true });
    pos = e;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}
