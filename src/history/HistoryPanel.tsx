import { type Accessor, For, Show, createMemo, createSignal } from "solid-js";
import { Icon } from "../Icons";
import { highlightSql } from "../ai/sqlHighlight";
import { type HistoryEntry } from "./store";

// Right-side query-history panel (AiPanel layout pattern). Reverse-chron list
// with status/duration, substring search, expand-to-full-SQL, and per-entry
// Insert / Open-in-tab / Re-run. Recording happens in App's executeQuery; this
// panel is pure display.

function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

export function HistoryPanel(props: {
  entries: Accessor<HistoryEntry[]>;
  onInsert: (sql: string) => void;
  onOpenTab: (sql: string, schema: string | null) => void;
  onRerun: (sql: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = createSignal("");
  const [openId, setOpenId] = createSignal<string | null>(null);
  const [confirmClear, setConfirmClear] = createSignal(false);

  const filtered = createMemo(() => {
    const needle = q().toLowerCase();
    const list = props.entries();
    return needle ? list.filter((e) => e.sql.toLowerCase().includes(needle)) : list;
  });

  return (
    <div class="hist-panel">
      <div class="hist-head">
        <Icon name="clock" />
        <span class="hist-title">Query history</span>
        <span class="spacer" />
        <Show
          when={confirmClear()}
          fallback={
            <button class="icon" title="Clear history" disabled={!props.entries().length} onClick={() => setConfirmClear(true)}>
              <Icon name="trash" />
            </button>
          }
        >
          <button class="ghost hist-confirm" onClick={() => { props.onClear(); setConfirmClear(false); }}>Clear all?</button>
          <button class="icon" onClick={() => setConfirmClear(false)}><Icon name="close" /></button>
        </Show>
        <button class="icon" title="Close" onClick={props.onClose}><Icon name="close" /></button>
      </div>
      <input class="hist-search" type="text" placeholder="Search history…" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
      <div class="hist-list">
        <Show when={filtered().length} fallback={<div class="hist-empty">{props.entries().length ? "no matches" : "no queries yet"}</div>}>
          <For each={filtered()}>
            {(e) => (
              <div class="hist-entry" classList={{ open: openId() === e.id }}>
                <div class="hist-row" onClick={() => setOpenId(openId() === e.id ? null : e.id)}>
                  <span class="hist-dot" classList={{ ok: e.status === "ok", err: e.status === "error", cancelled: e.status === "cancelled" }} />
                  <span class="hist-sql-line">{e.sql.split("\n")[0]}</span>
                  <span class="hist-meta">{fmtMs(e.durationMs)} · {relTime(e.ts)}</span>
                </div>
                <Show when={openId() === e.id}>
                  <pre class="hist-full"><code><For each={highlightSql(e.sql)}>{(t) => (t.cls ? <span class={t.cls}>{t.text}</span> : t.text)}</For></code></pre>
                  <Show when={e.error}>
                    <div class="hist-error">{e.error}</div>
                  </Show>
                  <div class="hist-actions">
                    <Show when={e.rows != null}>
                      <span class="hist-meta">{e.rows} rows</span>
                    </Show>
                    <span class="spacer" />
                    <button class="ghost" onClick={() => props.onInsert(e.sql)}>Insert</button>
                    <button class="ghost" onClick={() => props.onOpenTab(e.sql, e.schema)}>Open in tab</button>
                    <button class="run" onClick={() => props.onRerun(e.sql)}>Re-run</button>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
