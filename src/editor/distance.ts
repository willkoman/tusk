// Optimal string-alignment (restricted Damerau-Levenshtein) distance, used by the
// schema-aware linter to suggest the closest real identifier for a typo.
// Case-insensitive; capped length to keep the O(n·m) matrix bounded.

const MAX = 40;

export function damerau(a: string, b: string): number {
  a = a.toLowerCase().slice(0, MAX);
  b = b.toLowerCase().slice(0, MAX);
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  // Two-and-a-bit rolling rows (need row-2 for transpositions).
  let prev2: number[] = [];
  let prev: number[] = new Array(bl + 1);
  let cur: number[] = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= bl; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (
        i > 1 &&
        j > 1 &&
        ca === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
      ) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
    }
    prev2 = prev;
    prev = cur;
    cur = new Array(bl + 1);
  }
  return prev[bl];
}

/**
 * Closest candidate to `word`, or null when nothing is near enough. The threshold
 * scales with word length so short words demand near-exact matches (avoids noisy
 * suggestions) and longer words tolerate a typo or two.
 *
 * A candidate that STARTS WITH the word counts as one edit regardless of how
 * much longer it is ("master" → "master_id"): under-typing a real name is the
 * most common miss, and raw edit distance prices every missing character.
 */
export function closest(word: string, candidates: Iterable<string>): string | null {
  const w = word.toLowerCase();
  const limit = Math.min(3, Math.max(1, Math.ceil(w.length / 3)));
  let best: string | null = null;
  let bestD = limit + 1;
  for (const c of candidates) {
    let d = damerau(w, c);
    if (w.length >= 3 && c.toLowerCase().startsWith(w) && c.length - w.length <= 12) {
      d = Math.min(d, 1);
    }
    if (d < bestD) {
      bestD = d;
      best = c;
      if (d < 1) break;
    }
  }
  return best;
}
