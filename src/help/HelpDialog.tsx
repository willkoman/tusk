// In-app knowledge base: grouped nav + full-text search + accordion topic pages.
// Content is static data (content.ts); the split/search cores are pure (search.ts).
// keys blocks render the LIVE binding for each ActionId, so a rebind in
// Settings → Shortcuts shows up here instantly.

import { For, Match, Show, Switch, createMemo, createSignal, onMount } from "solid-js";
import { Dialog } from "../Dialog";
import { Icon } from "../Icons";
import { ACTIONS, type ActionId, type KeyOverrides, displayKey, effectiveKey } from "../actions";
import { highlightSql } from "../ai/sqlHighlight";
import { TOPICS } from "./content";
import { DEMOS } from "./demos";
import { renderInline, type InlineCtx } from "./inline";
import { GROUPS, flatOrder } from "./nav";
import { buildIndex, markRuns, search, splitSections, type SearchHit } from "./search";
import type { Block } from "./types";

// Default export so App can lazy() this module — the KB content is ~170 KB of
// static data and must not weigh down the main chunk.
export default function HelpDialog(props: {
  initialTopic?: string | null;
  keys: KeyOverrides;
  onClose: () => void;
}) {
  const byId = new Map(TOPICS.map((t) => [t.id, t]));
  const ids = new Set(TOPICS.map((t) => t.id));
  const order = flatOrder().filter((id) => ids.has(id));
  const index = buildIndex(TOPICS);

  const [cur, setCur] = createSignal(
    props.initialTopic && ids.has(props.initialTopic) ? props.initialTopic : order[0] ?? "",
  );
  const [q, setQ] = createSignal("");
  // Open accordion sections, keyed "topicId/sectionId". Preamble is always shown.
  const [openSecs, setOpenSecs] = createSignal<Record<string, boolean>>({});
  // Section to flash-highlight after a search jump.
  const [flash, setFlash] = createSignal("");
  let pane: HTMLDivElement | undefined;
  let searchBox: HTMLInputElement | undefined;

  onMount(() => searchBox?.focus());

  const topic = createMemo(() => byId.get(cur()));
  const split = createMemo(() => {
    const t = topic();
    return t ? splitSections(t) : { preamble: [], sections: [] };
  });
  const hits = createMemo(() => search(index, q()));

  const secKey = (sid: string | null) => `${cur()}/${sid ?? ""}`;
  const isOpen = (sid: string | null) => !!openSecs()[secKey(sid)];
  const setSec = (sid: string | null, open: boolean) =>
    setOpenSecs((m) => ({ ...m, [secKey(sid)]: open }));
  const allOpen = createMemo(() => split().sections.every((s) => isOpen(s.id)));
  const setAll = (open: boolean) =>
    setOpenSecs((m) => {
      const next = { ...m };
      for (const s of split().sections) next[`${cur()}/${s.id ?? ""}`] = open;
      return next;
    });

  function goto(id: string, sectionId?: string | null) {
    if (!ids.has(id)) return;
    setCur(id);
    setQ("");
    if (sectionId) {
      setOpenSecs((m) => ({ ...m, [`${id}/${sectionId}`]: true }));
      setFlash(`${id}/${sectionId}`);
      requestAnimationFrame(() =>
        pane?.querySelector(`[data-sec="${sectionId}"]`)?.scrollIntoView({ block: "start" }),
      );
    } else {
      pane?.scrollTo({ top: 0 });
    }
  }
  const ictx = (): InlineCtx => ({ onTopic: goto, topicIds: ids });

  const prevNext = createMemo(() => {
    const i = order.indexOf(cur());
    return { prev: i > 0 ? byId.get(order[i - 1]) : undefined, next: i >= 0 ? byId.get(order[i + 1]) : undefined };
  });

  return (
    <Dialog title="Tusk manual" class="modal-tall" width={980} onClose={props.onClose}>
      <div class="kb-body">
        <nav class="kb-nav">
          <div class="kb-searchwrap">
            <span class="kb-searchicon"><Icon name="search" /></span>
            <input
              ref={searchBox}
              class="kb-search"
              placeholder="Search the manual…"
              value={q()}
              onInput={(e) => setQ(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && q()) {
                  e.stopPropagation();
                  setQ("");
                } else if (e.key === "Enter" && hits().length) {
                  const h = hits()[0];
                  goto(h.topicId, h.sectionId);
                }
              }}
            />
            <Show when={q()}>
              <button class="icon kb-searchclear" title="Clear" onClick={() => setQ("")}>✕</button>
            </Show>
          </div>
          <div class="kb-navscroll">
            <For each={GROUPS}>
              {(g) => (
                <Show when={g.ids.some((id) => ids.has(id))}>
                  <div class="kb-group">
                    <div class="kb-grouplabel">{g.label}</div>
                    <For each={g.ids.filter((id) => ids.has(id))}>
                      {(id) => {
                        const t = byId.get(id)!;
                        return (
                          <button
                            class="kb-navitem"
                            classList={{ active: id === cur() && !q() }}
                            title={t.blurb}
                            onClick={() => goto(id)}
                          >
                            <Icon name={t.icon} />
                            <span class="kb-navtitle">{t.title}</span>
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              )}
            </For>
          </div>
        </nav>

        <div class="kb-pane" ref={pane}>
          <Show
            when={!q()}
            fallback={
              <div class="kb-hits">
                <div class="kb-hitcount">
                  {hits().length ? `${hits().length} match${hits().length === 1 ? "" : "es"}` : "No matches"} for “{q()}”
                </div>
                <For each={hits()}>{(h) => <HitRow hit={h} onOpen={() => goto(h.topicId, h.sectionId)} />}</For>
              </div>
            }
          >
            <Show when={topic()} fallback={<div class="kb-empty">No topics yet.</div>}>
              {(t) => (
                <article class="kb-article">
                  <header class="kb-tophead">
                    <div>
                      <h1>{t().title}</h1>
                      <div class="kb-blurb">{t().blurb}</div>
                    </div>
                    <Show when={split().sections.length > 1}>
                      <button class="ghost kb-expandall" onClick={() => setAll(!allOpen())}>
                        {allOpen() ? "Collapse all" : "Expand all"}
                      </button>
                    </Show>
                  </header>
                  <For each={split().preamble}>{(b) => <BlockView b={b} ictx={ictx()} keys={props.keys} />}</For>
                  <For each={split().sections}>
                    {(s) => (
                      <section
                        class="kb-sec"
                        data-sec={s.id}
                        classList={{ open: isOpen(s.id), flash: flash() === `${cur()}/${s.id ?? ""}` }}
                        onAnimationEnd={() => setFlash("")}
                      >
                        <button class="kb-sechead" aria-expanded={isOpen(s.id)} onClick={() => setSec(s.id, !isOpen(s.id))}>
                          <span class="kb-secchev">{isOpen(s.id) ? "▾" : "▸"}</span>
                          <span class="kb-sectitle">{s.title}</span>
                          <Show when={!isOpen(s.id)}>
                            <span class="kb-secpreview">{s.preview}</span>
                          </Show>
                        </button>
                        <Show when={isOpen(s.id)}>
                          <div class="kb-secbody">
                            <For each={s.blocks}>{(b) => <BlockView b={b} ictx={ictx()} keys={props.keys} />}</For>
                          </div>
                        </Show>
                      </section>
                    )}
                  </For>
                  <footer class="kb-prevnext">
                    <Show when={prevNext().prev} fallback={<span />}>
                      {(p) => <button class="ghost" onClick={() => goto(p().id)}>← {p().title}</button>}
                    </Show>
                    <Show when={prevNext().next} fallback={<span />}>
                      {(n) => <button class="ghost" onClick={() => goto(n().id)}>{n().title} →</button>}
                    </Show>
                  </footer>
                </article>
              )}
            </Show>
          </Show>
        </div>
      </div>
    </Dialog>
  );
}

function HitRow(props: { hit: SearchHit; onOpen: () => void }) {
  return (
    <button class="kb-hit" onClick={props.onOpen}>
      <div class="kb-hitpath">
        <span class="kb-hittopic">{props.hit.topicTitle}</span>
        <Show when={props.hit.sectionTitle}>
          <span class="kb-hitsep">›</span>
          <span class="kb-hitsec">{props.hit.sectionTitle}</span>
        </Show>
      </div>
      <div class="kb-hitsnippet">
        <For each={markRuns(props.hit.snippet, props.hit.ranges)}>
          {(r) => (r.hit ? <mark class="kb-mark">{r.text}</mark> : r.text)}
        </For>
      </div>
    </button>
  );
}

function BlockView(props: { b: Block; ictx: InlineCtx; keys: KeyOverrides }) {
  const b = props.b;
  return (
    <Switch>
      <Match when={b.k === "p" ? b : undefined}>{(x) => <p>{renderInline(x().md, props.ictx)}</p>}</Match>
      <Match when={b.k === "h" ? b : undefined}>{(x) => <h2 id={`kb-${x().id}`}>{x().text}</h2>}</Match>
      <Match when={b.k === "code" ? b : undefined}>
        {(x) => (
          <figure class="kb-codeblock">
            <pre><code><For each={highlightSql(x().text)}>{(t) => <span class={t.cls}>{t.text}</span>}</For></code></pre>
            <Show when={x().caption}><figcaption>{x().caption}</figcaption></Show>
          </figure>
        )}
      </Match>
      <Match when={b.k === "list" ? b : undefined}>
        {(x) => {
          const items = <For each={x().items}>{(it) => <li>{renderInline(it, props.ictx)}</li>}</For>;
          return x().ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
        }}
      </Match>
      <Match when={b.k === "table" ? b : undefined}>
        {(x) => (
          <div class="kb-tablewrap">
            <table class="kb-table">
              <thead><tr><For each={x().head}>{(h) => <th>{renderInline(h, props.ictx)}</th>}</For></tr></thead>
              <tbody>
                <For each={x().rows}>
                  {(row) => <tr><For each={row}>{(c) => <td>{renderInline(c, props.ictx)}</td>}</For></tr>}
                </For>
              </tbody>
            </table>
          </div>
        )}
      </Match>
      <Match when={b.k === "tip" ? b : undefined}>
        {(x) => (
          <div class="kb-tip" classList={{ warn: x().kind === "warn" }}>
            <span class="kb-tipicon">{x().kind === "warn" ? "⚠" : "💡"}</span>
            <span>{renderInline(x().md, props.ictx)}</span>
          </div>
        )}
      </Match>
      <Match when={b.k === "keys" ? b : undefined}>
        {(x) => (
          <table class="kb-table kb-keys">
            <tbody>
              <For each={x().rows.filter((r) => r.combo || ACTIONS.some((a) => a.id === r.action))}>
                {(r) => {
                  const chord = () => r.combo ?? effectiveKey(r.action as ActionId, props.keys);
                  return (
                    <tr>
                      <td class="kb-keycell">
                        <Show when={chord()} fallback={<span class="kb-unbound">unbound</span>}>
                          <kbd class="kb-kbd">{displayKey(chord())}</kbd>
                        </Show>
                      </td>
                      <td>{renderInline(r.does, props.ictx)}</td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        )}
      </Match>
      <Match when={b.k === "demo" ? b : undefined}>
        {(x) => {
          const Demo = DEMOS[x().id];
          return (
            <Show when={Demo}>
              <figure class="kb-demo">
                <Demo />
                <Show when={x().caption}><figcaption>{x().caption}</figcaption></Show>
              </figure>
            </Show>
          );
        }}
      </Match>
    </Switch>
  );
}
