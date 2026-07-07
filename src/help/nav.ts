// Manual navigation structure — groups over the topic ids in content.ts.
// Kept separate from content.ts because that file is regenerated wholesale.

export const GROUPS: { label: string; ids: string[] }[] = [
  { label: "Start here", ids: ["getting-started", "workspace", "whats-new"] },
  { label: "Writing SQL", ids: ["editor", "editor-intel", "shortcuts"] },
  { label: "Results & data", ids: ["results", "grid-editing", "import-export"] },
  { label: "Schema tools", ids: ["sidebar", "erd", "plans"] },
  { label: "Assistants", ids: ["ai", "slack"] },
  { label: "Trust & history", ids: ["history", "safety"] },
];

/** Flat topic-id order (drives prev/next footer links). */
export function flatOrder(): string[] {
  return GROUPS.flatMap((g) => g.ids);
}
