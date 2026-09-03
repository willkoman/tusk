// The one model control in Settings → AI. Per provider it answers two questions from a
// single list: which models the pickers (chat header, Slack mirror) offer — the
// checkbox — and which of them is the provider's default — the ★. The list is the
// provider's LIVE catalog whenever it can be fetched (Refresh re-fetches), else the
// shipped fallback ids, in catalog order with no tiers or editorial ranking.
//
// Searchable (same fuzzy ranking as the header picker), select-all-shown / clear, a chip
// per chosen model with its own ✕, and a typed id can be added as a model when the
// endpoint serves something its /models list doesn't name. An empty selection means
// "offer everything", which the summary line says in words rather than an empty box.

import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { fuzzyRank, highlight } from "./fuzzy";

type Row = { model: string; indices: number[] };

export function ModelMultiPicker(props: {
  /** Every model the provider offers: live catalog when available, else the shipped fallback. */
  catalog: string[];
  /** Whether `catalog` came from the provider (true) or the shipped fallback (false). */
  live: boolean;
  loading: boolean;
  error: string;
  /** Why Refresh is unavailable (no key yet, origin unapproved…); empty = it works. */
  refreshBlocked: string;
  /** Current allowlist; empty = all models shown. */
  selected: string[];
  /** The provider's default model (its remembered model); may be blank. */
  defaultModel: string;
  onChange: (models: string[]) => void;
  onDefault: (model: string) => void;
  onRefresh: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  let listEl: HTMLDivElement | undefined;

  const selectedSet = createMemo(() => new Set(props.selected));
  const catalogSet = createMemo(() => new Set(props.catalog));
  const searching = () => !!query().trim();
  const typed = () => query().trim();

  /** Flat, score-ordered rows while searching; catalog order otherwise. */
  const rows = createMemo<Row[]>(() => {
    if (searching()) {
      return fuzzyRank(query(), props.catalog, (m) => m).map((r) => ({ model: r.item, indices: r.indices }));
    }
    return props.catalog.map((model) => ({ model, indices: [] }));
  });
  /** A typed id the catalog doesn't list exactly can be added as a model outright. */
  const canAddTyped = () => searching() && !catalogSet().has(typed()) && !selectedSet().has(typed()) && typed().length <= 500;
  /** Render order flattened for keyboard navigation (the add row trails the matches). */
  const flat = createMemo(() => {
    const ids = rows().map((r) => r.model);
    if (canAddTyped()) ids.push(typed());
    return ids;
  });
  const flatIndex = createMemo(() => {
    const m = new Map<string, number>();
    flat().forEach((id, i) => m.set(id, i));
    return m;
  });
  /** Chosen ids the catalog no longer lists (only meaningful against a live catalog). */
  const stale = createMemo(() => {
    if (!props.live) return [];
    const have = catalogSet();
    return props.selected.filter((m) => !have.has(m));
  });

  createEffect(() => { query(); setCursor(0); });
  createEffect(() => {
    cursor();
    queueMicrotask(() => listEl?.querySelector<HTMLElement>(".mmp-row.on")?.scrollIntoView({ block: "nearest" }));
  });

  /** Catalog order for anything in the catalog; unknown (stale/typed) ids trail. */
  const ordered = (set: Set<string>) =>
    props.catalog.filter((m) => set.has(m)).concat([...set].filter((m) => !catalogSet().has(m)));
  function toggle(model: string) {
    const set = new Set(props.selected);
    if (set.has(model)) set.delete(model);
    else set.add(model);
    props.onChange(ordered(set));
  }
  function addTyped() {
    const id = typed();
    if (!canAddTyped()) return;
    const set = new Set(props.selected);
    set.add(id);
    props.onChange(ordered(set));
    if (!props.defaultModel) props.onDefault(id);
    setQuery("");
  }
  function selectShown() {
    const set = new Set(props.selected);
    for (const r of rows()) set.add(r.model);
    props.onChange(ordered(set));
  }
  function clearAll() {
    props.onChange([]);
  }
  function activate(model: string) {
    if (canAddTyped() && model === typed()) addTyped();
    else toggle(model);
  }
  function onKey(e: KeyboardEvent) {
    const n = flat().length;
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => (n ? (c + 1) % n : 0)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => (n ? (c - 1 + n) % n : 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const m = flat()[cursor()]; if (m) activate(m); }
    else if (e.key === "Escape") { e.preventDefault(); setQuery(""); }
  }

  const shownCount = () => rows().length;
  const allShownSelected = () => shownCount() > 0 && rows().every((r) => selectedSet().has(r.model));
  const isDefault = (m: string) => !!props.defaultModel && m === props.defaultModel;

  return (
    <div class="mmp">
      <div class="mmp-bar">
        <input
          class="mp-search"
          placeholder={props.catalog.length ? "Search, or type a model id…" : "Type a model id…"}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onKey}
        />
        <button class="ghost" disabled={allShownSelected() || shownCount() === 0} onClick={selectShown} title="Offer every model in the list below">
          {searching() ? "Select matches" : "Select all"}
        </button>
        <button class="ghost" disabled={props.selected.length === 0} onClick={clearAll} title="Offer every model the provider lists">Clear</button>
        <button
          class="ghost"
          disabled={props.loading || !!props.refreshBlocked}
          onClick={() => props.onRefresh()}
          title={props.refreshBlocked || "Fetch the provider's current model list"}
        >
          {props.loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div class="mmp-meta">
        <span>
          {props.selected.length === 0
            ? `All ${props.catalog.length} models offered`
            : `${props.selected.length} of ${props.catalog.length} offered`}
          {" · default: "}
          <Show when={props.defaultModel} fallback={<em>none — ★ a model</em>}>
            <code>{props.defaultModel}</code>
          </Show>
        </span>
        <span class="spacer" />
        <span>{props.live ? "live catalog" : props.refreshBlocked ? `shipped list — ${props.refreshBlocked}` : "shipped list — Refresh loads the live catalog"}</span>
      </div>
      <Show when={props.error}><div class="error">{props.error}</div></Show>
      <Show when={stale().length}>
        <div class="ai-note">
          {stale().length} chosen model{stale().length === 1 ? " is" : "s are"} not in the provider's current list and will not be offered: {stale().join(", ")}
        </div>
      </Show>
      <div class="mmp-list" ref={listEl}>
        <Show when={flat().length} fallback={
          <div class="mp-empty">{props.loading ? "Loading…" : "No models. Refresh to load the provider's list, or type a model id."}</div>
        }>
          <For each={rows()}>
            {(r) => (
              <div
                class="mmp-row"
                classList={{ on: flatIndex().get(r.model) === cursor(), sel: selectedSet().has(r.model), def: isDefault(r.model) }}
                onMouseEnter={() => setCursor(flatIndex().get(r.model) ?? 0)}
                onClick={() => toggle(r.model)}
              >
                <input
                  type="checkbox"
                  tabIndex={-1}
                  checked={selectedSet().has(r.model)}
                  title={selectedSet().has(r.model) ? "Offered in the pickers" : "Not offered"}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggle(r.model)}
                />
                <span class="mp-model">
                  <Show when={r.indices.length} fallback={r.model}>
                    <For each={highlight(r.model, r.indices)}>
                      {(part) => (part.hit ? <b>{part.text}</b> : <>{part.text}</>)}
                    </For>
                  </Show>
                </span>
                <button
                  class="mmp-star"
                  classList={{ on: isDefault(r.model) }}
                  tabIndex={-1}
                  title={isDefault(r.model) ? "Default model" : "Make this the default model"}
                  onClick={(e) => { e.stopPropagation(); if (!isDefault(r.model)) props.onDefault(r.model); }}
                >
                  {isDefault(r.model) ? "★ default" : "☆"}
                </button>
              </div>
            )}
          </For>
          <Show when={canAddTyped()}>
            <div
              class="mmp-row mmp-add"
              classList={{ on: flatIndex().get(typed()) === cursor() }}
              onMouseEnter={() => setCursor(flatIndex().get(typed()) ?? 0)}
              onClick={addTyped}
            >
              <span class="mmp-add-icon">＋</span>
              <span class="mp-model">Add <code>{typed()}</code> as a model id</span>
            </div>
          </Show>
        </Show>
      </div>
      <Show when={props.selected.length}>
        <div class="mmp-chips">
          <For each={props.selected}>
            {(m) => (
              <span class="mmp-chip" classList={{ off: stale().includes(m), def: isDefault(m) }} title={isDefault(m) ? `${m} — default` : m}>
                <Show when={isDefault(m)}><span class="mmp-chip-star">★</span></Show>
                <span>{m}</span>
                <button title={`Stop offering ${m}`} onClick={() => toggle(m)}>✕</button>
              </span>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
