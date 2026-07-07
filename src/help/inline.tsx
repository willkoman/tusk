// Tiny inline-markdown renderer for KB prose. Flat (no nesting): scans for
// [[kbd:…]] / [[topic:id|label]] / `code` / **bold** / *italic* left-to-right.
// Unknown topic links degrade to plain text so stale content never breaks the UI.

import { type JSX } from "solid-js";
import { displayKey } from "../actions";

export type InlineCtx = {
  /** Navigate to another topic (undefined = links render as plain text). */
  onTopic?: (id: string) => void;
  /** Topic ids that exist — links to anything else degrade to text. */
  topicIds?: ReadonlySet<string>;
};

const TOKEN =
  /\[\[kbd:([^\]]+)\]\]|\[\[topic:([a-z0-9-]+)(?:\|([^\]]+))?\]\]|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g;

export function renderInline(md: string, ctx: InlineCtx): JSX.Element[] {
  const out: JSX.Element[] = [];
  let last = 0;
  // Per-call regex — the recursive call for **bold** would otherwise clobber the
  // shared lastIndex of a module-level /g regex.
  const re = new RegExp(TOKEN.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    if (m.index > last) out.push(md.slice(last, m.index));
    if (m[1]) {
      // Bare "Mod" = the platform modifier alone (displayKey needs a real chord).
      const label = m[1] === "Mod" ? (/mac/i.test(navigator.platform) ? "⌘" : "Ctrl") : displayKey(m[1]);
      out.push(<kbd class="kb-kbd">{label}</kbd>);
    } else if (m[2]) {
      const id = m[2];
      const label = m[3] ?? id;
      if (ctx.onTopic && (!ctx.topicIds || ctx.topicIds.has(id))) {
        out.push(
          <a class="kb-link" href="#" onClick={(e) => { e.preventDefault(); ctx.onTopic!(id); }}>
            {label}
          </a>,
        );
      } else {
        out.push(label);
      }
    } else if (m[4]) {
      out.push(<code class="kb-code">{m[4]}</code>);
    } else if (m[5]) {
      out.push(<strong>{renderInline(m[5], ctx)}</strong>);
    } else if (m[6]) {
      out.push(<em>{m[6]}</em>);
    }
    last = m.index + m[0].length;
  }
  if (last < md.length) out.push(md.slice(last));
  return out;
}
