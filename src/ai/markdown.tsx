import { For, Show, type JSX } from "solid-js";
import { clipWrite } from "../clipboard";

// Minimal, dependency-free markdown rendering for the AI chat — fenced code blocks
// (with Copy + "Open in editor"), inline `code` / **bold** / *italic*, headings, and
// bullet/numbered lists. Streaming-safe: an unclosed trailing ``` renders as an
// in-progress code block.

type Block = { type: "prose"; text: string } | { type: "code"; lang: string; code: string };

function parseBlocks(text: string): Block[] {
  const out: Block[] = [];
  const re = /```([\w+-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: "prose", text: text.slice(last, m.index) });
    out.push({ type: "code", lang: m[1] || "", code: m[2].replace(/\n$/, "") });
    last = re.lastIndex;
  }
  const tail = text.slice(last);
  const open = tail.indexOf("```"); // an unclosed fence still streaming
  if (open >= 0) {
    if (open > 0) out.push({ type: "prose", text: tail.slice(0, open) });
    const rest = tail.slice(open + 3);
    const nl = rest.indexOf("\n");
    out.push({ type: "code", lang: nl >= 0 ? rest.slice(0, nl) : "", code: nl >= 0 ? rest.slice(nl + 1) : "" });
  } else if (tail.trim()) {
    out.push({ type: "prose", text: tail });
  }
  return out;
}

function inline(text: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("`")) out.push(<code class="md-code">{t.slice(1, -1)}</code>);
    else if (t.startsWith("**")) out.push(<strong>{t.slice(2, -2)}</strong>);
    else out.push(<em>{t.slice(1, -1)}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Prose(props: { text: string }) {
  const lines = () => props.text.replace(/\n{3,}/g, "\n\n").split("\n");
  return (
    <For each={lines()}>
      {(line) => {
        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h) return <div class="md-h">{inline(h[2])}</div>;
        const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
        if (li) return <div class="md-li">{inline(li[1])}</div>;
        if (!line.trim()) return <div class="md-gap" />;
        return <div class="md-p">{inline(line)}</div>;
      }}
    </For>
  );
}

function CodeBlock(props: { lang: string; code: string; onInsert: (sql: string) => void }) {
  const lang = () => props.lang || "sql";
  const runnable = () => /sql/i.test(props.lang) || props.lang === "";
  return (
    <div class="ai-code">
      <div class="ai-code-head">
        <span class="ai-code-lang">{lang()}</span>
        <span class="spacer" />
        <button class="ai-code-btn" onClick={() => void clipWrite(props.code)}>Copy</button>
        <Show when={runnable() && props.code.trim()}>
          <button class="ai-code-btn primary" onClick={() => props.onInsert(props.code)}>▶ Open in editor</button>
        </Show>
      </div>
      <pre class="ai-code-body"><code>{props.code}</code></pre>
    </div>
  );
}

export function Markdown(props: { text: string; onInsertSql: (sql: string) => void }) {
  return (
    <div class="md">
      <For each={parseBlocks(props.text)}>
        {(b) => (b.type === "code" ? <CodeBlock lang={b.lang} code={b.code} onInsert={props.onInsertSql} /> : <Prose text={b.text} />)}
      </For>
    </div>
  );
}
