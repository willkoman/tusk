// How a history entry is LABELLED in the list. Pure + vitest-covered.
//
// Runs that did not come from the editor are stored with a provenance comment on
// the first line — `-- [Explorer]`, `-- [Export] csv → …`, `-- [Slack] asked by …`
// and, for anything inside a manual transaction, the full transaction identity.
// The stored SQL keeps all of it (Insert / Open in tab / Re-run replay the entry
// verbatim); the list shows a short tag and the statement itself instead of
// `-- [Transaction tx-1@mtukt9le; revision 3; rollback]`.

const MARKER = /^--\s*\[([^\]\n]+)\](.*)$/;
/** Longest label or detail put into the row. */
const MAX_LABEL = 120;

export type HistoryLabel = {
  /** Short provenance tag, or null for an ordinary editor run. */
  tag: string | null;
  /** What the row shows beside the tag: the statement, or the marker's own detail. */
  text: string;
};

/** Compact form of a marker's contents. */
export function historyTag(inner: string): string {
  const parts = inner.split(";").map((p) => p.trim()).filter(Boolean);
  if (parts.length && /^transaction\b/i.test(parts[0])) {
    const event = parts[parts.length - 1].replace(/_/g, " ");
    return cut(`Transaction ${event}`);
  }
  return cut(inner.trim());
}

/** Tag + first meaningful line for one stored history entry. */
export function historyLabel(sql: string): HistoryLabel {
  const lines = sql.split("\n");
  const m = MARKER.exec(lines[0] ?? "");
  if (!m) return { tag: null, text: cut((lines[0] ?? "").trim()) };
  const trailing = m[2].trim();
  const next = lines.slice(1).find((l) => l.trim() !== "")?.trim() ?? "";
  return { tag: historyTag(m[1]), text: cut(trailing || next) };
}

function cut(v: string): string {
  return v.length > MAX_LABEL ? `${v.slice(0, MAX_LABEL)}…` : v;
}
