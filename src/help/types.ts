// In-app knowledge base content model. Topics are static data (src/help/content.ts),
// rendered by HelpDialog. Inline markdown in `md`/`items`/table cells supports
// **bold**, `code`, *italic*, [[kbd:Mod-Enter]] keyboard chips (CodeMirror chord
// syntax, rendered via displayKey) and [[topic:id|label]] cross-topic links.

import type { IconName } from "../Icons";

/** Animated illustration ids — each maps to a component in demos.tsx. */
export type DemoId =
  | "grid-stream"
  | "panels"
  | "grid-edit"
  | "autocomplete"
  | "hover-card"
  | "sort-filter"
  | "jump-count"
  | "erd-mini"
  | "plan-heat"
  | "slack-approve";

export type KeyRow = {
  /** ActionId from src/actions.ts — renders the LIVE current binding. */
  action?: string;
  /** Literal CodeMirror-style chord for non-registry keys (e.g. "Alt-N"). */
  combo?: string;
  does: string;
};

export type Block =
  | { k: "p"; md: string }
  | { k: "h"; text: string; id: string }
  | { k: "code"; text: string; caption?: string }
  | { k: "list"; items: string[]; ordered?: boolean }
  | { k: "table"; head: string[]; rows: string[][] }
  | { k: "tip"; md: string; kind: "tip" | "warn" }
  | { k: "keys"; rows: KeyRow[] }
  | { k: "demo"; id: DemoId; caption?: string };

export type Topic = {
  id: string;
  title: string;
  /** One sentence shown under the title in the nav. */
  blurb: string;
  icon: IconName;
  blocks: Block[];
};
