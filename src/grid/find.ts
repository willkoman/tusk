// Find in loaded rows: a client-side scan of what the grid already holds. Pure +
// vitest-covered.
//
// This is NOT the filter builder: it never re-runs the query, never reaches the
// server, and can only see rows that have streamed in. The UI says so ("Find
// (loaded rows)"), because a match count over a partially loaded result would
// otherwise read as a count over the whole table.

export type GridMatch = { r: number; dc: number };

export type FindResult = {
  matches: GridMatch[];
  /** The scan stopped at a ceiling; `matches` is a prefix, not the whole set. */
  truncated: boolean;
};

/** Ceilings: a find must never freeze the UI thread on a wide, fully loaded result. */
export const FIND_MAX_MATCHES = 5_000;
export const FIND_MAX_CELLS = 2_000_000;

export const EMPTY_FIND: FindResult = { matches: [], truncated: false };

/**
 * Case-insensitive substring scan in display order (row-major), so "next match"
 * walks the grid the way the eye does. `cell` reads the DISPLAYED value, so
 * pending edits, insert rows and boolean words are matched as shown.
 */
export function findMatches(
  nRows: number,
  nCols: number,
  needle: string,
  cell: (r: number, dc: number) => string | null,
  limits: { maxMatches?: number; maxCells?: number } = {},
): FindResult {
  const q = needle.toLowerCase();
  if (!q || nRows <= 0 || nCols <= 0) return EMPTY_FIND;
  const maxMatches = limits.maxMatches ?? FIND_MAX_MATCHES;
  const maxCells = limits.maxCells ?? FIND_MAX_CELLS;
  const matches: GridMatch[] = [];
  let scanned = 0;
  for (let r = 0; r < nRows; r++) {
    for (let dc = 0; dc < nCols; dc++) {
      if (++scanned > maxCells) return { matches, truncated: true };
      const v = cell(r, dc);
      if (v !== null && v.toLowerCase().includes(q)) {
        matches.push({ r, dc });
        if (matches.length >= maxMatches) return { matches, truncated: true };
      }
    }
  }
  return { matches, truncated: false };
}

/** Next/previous match index, wrapping. Returns -1 when there is nothing to step to. */
export function stepMatch(count: number, current: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return dir === 1 ? 0 : count - 1;
  return (current + dir + count) % count;
}

/**
 * First match at or after a cell, so opening Find from a scrolled position lands
 * on the nearest match instead of jumping back to row 0. -1 when there is none
 * after it (the caller wraps to 0).
 */
export function matchAtOrAfter(matches: readonly GridMatch[], r: number, dc: number): number {
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (m.r > r || (m.r === r && m.dc >= dc)) return i;
  }
  return matches.length ? 0 : -1;
}

/** Lookup set for painting: `${r}:${dc}` of every match. */
export function matchSet(matches: readonly GridMatch[]): Set<string> {
  const out = new Set<string>();
  for (const m of matches) out.add(`${m.r}:${m.dc}`);
  return out;
}
