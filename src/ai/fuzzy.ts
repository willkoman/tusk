// Fuzzy matching for the model picker. A router like OpenRouter serves several hundred
// vendor-namespaced ids (`anthropic/claude-opus-4.8`), so the picker needs to find
// "opus48" and "ant opus" alike without the user scrolling.
//
// Deliberately dependency-free and pure: a matcher is exactly the kind of thing that
// silently regresses, and this one is unit-tested against the real id shapes.

/** Characters that begin a "word" in a model id: `anthropic/claude-opus-4.8`. */
const SEP = /[-_./:\s]/;

export type Match = { score: number; indices: number[] };

/** Score one whitespace-free term against `text`. `null` = the term isn't a subsequence. */
function scoreTerm(term: string, text: string): Match | null {
  const t = text.toLowerCase();
  const n = term.toLowerCase();
  if (!n) return { score: 0, indices: [] };

  // A contiguous substring always beats a scattered subsequence — `gpt-5` should rank
  // `gpt-5.4` above `g...p...t...5` spread across `openai/gpt-oss-120b`.
  const at = t.indexOf(n);
  if (at >= 0) {
    const indices = Array.from({ length: n.length }, (_, k) => at + k);
    let score = 1000 + n.length * 8 - at; // longer + earlier is better
    if (at === 0 || SEP.test(t[at - 1])) score += 300; // starts a word
    return { score, indices };
  }

  // Subsequence, rewarding consecutive runs and word starts so `co48` finds
  // `claude-opus-4-8` rather than some incidental letter scatter.
  const indices: number[] = [];
  let score = 0;
  let ti = 0;
  for (let ni = 0; ni < n.length; ni++) {
    const c = n[ni];
    // Prefer a match at a word boundary over the next raw occurrence.
    let hit = -1;
    for (let i = ti; i < t.length; i++) {
      if (t[i] !== c) continue;
      const boundary = i === 0 || SEP.test(t[i - 1]);
      if (hit < 0) hit = i;
      if (boundary) { hit = i; break; }
      if (i > ti + 12) break; // don't scan the whole tail for a boundary that isn't there
    }
    if (hit < 0) return null;
    const consecutive = indices.length > 0 && hit === indices[indices.length - 1] + 1;
    const boundary = hit === 0 || SEP.test(t[hit - 1]);
    score += 1 + (consecutive ? 12 : 0) + (boundary ? 16 : 0);
    score -= Math.min(hit - ti, 8); // gaps cost, but bounded
    indices.push(hit);
    ti = hit + 1;
  }
  return { score, indices };
}

/**
 * Score `query` against `text`. Multi-term (space-separated) is AND: every term must
 * match somewhere, so `ant opus` finds `anthropic/claude-opus-4.8`. An empty query
 * matches everything with score 0, which keeps the caller's sort stable.
 */
export function fuzzy(query: string, text: string): Match | null {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return { score: 0, indices: [] };
  let score = 0;
  const indices = new Set<number>();
  for (const term of terms) {
    const m = scoreTerm(term, text);
    if (!m) return null; // AND: one unmatched term rejects the candidate
    score += m.score;
    for (const i of m.indices) indices.add(i);
  }
  return { score, indices: [...indices].sort((a, b) => a - b) };
}

export type Ranked<T> = { item: T; score: number; indices: number[] };

/** Filter + rank, stable on ties so an unsearched list keeps its curated tier order. */
export function fuzzyRank<T>(query: string, items: T[], key: (t: T) => string): Ranked<T>[] {
  return items
    .map((item, i) => ({ item, i, m: fuzzy(query, key(item)) }))
    .filter((x): x is { item: T; i: number; m: Match } => x.m !== null)
    .sort((a, b) => b.m.score - a.m.score || a.i - b.i)
    .map((x) => ({ item: x.item, score: x.m.score, indices: x.m.indices }));
}

/** Split `text` into alternating plain/highlighted runs for rendering. */
export function highlight(text: string, indices: number[]): { text: string; hit: boolean }[] {
  if (!indices.length) return [{ text, hit: false }];
  const set = new Set(indices);
  const out: { text: string; hit: boolean }[] = [];
  let buf = "";
  let hit = set.has(0);
  for (let i = 0; i < text.length; i++) {
    const h = set.has(i);
    if (h !== hit) {
      if (buf) out.push({ text: buf, hit });
      buf = "";
      hit = h;
    }
    buf += text[i];
  }
  if (buf) out.push({ text: buf, hit });
  return out;
}
