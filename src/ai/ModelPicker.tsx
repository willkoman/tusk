// Searchable model picker for the AI panel header. A native <select> collapses under a
// router catalog (OpenRouter serves several hundred ids), so this is a combobox: type to
// fuzzy-filter across every configured provider, arrow keys to move, Enter to pick.
//
// With an empty query it lists each provider's models in catalog order under a provider
// heading — no tiers or editorial ranking, the order the provider (or your Settings → AI
// curation) gives. Typing flattens the list into score order, because a global ranking
// is what you want when you know the name.

import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { fuzzyRank, highlight } from "./fuzzy";
import { providerInfo, type AiProvider } from "./store";

export type ModelChoice = { provider: AiProvider; model: string };

/** One row of the flat, searched list. */
type Row = ModelChoice & { indices: number[]; label: string };

export function ModelPicker(props: {
  /** Providers that are set up, in display order. */
  providers: AiProvider[];
  /** Models available per provider (live catalog, else curated fallback). */
  modelsFor: (p: AiProvider) => string[];
  current: ModelChoice;
  onPick: (c: ModelChoice) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  let inputEl: HTMLInputElement | undefined;
  let listEl: HTMLDivElement | undefined;

  /** Every (provider, model) pair, once. Searched against `provider/model` so a vendor
   *  name narrows a router catalog even when the id doesn't carry one. */
  const all = createMemo<ModelChoice[]>(() =>
    props.providers.flatMap((p) => props.modelsFor(p).map((model) => ({ provider: p, model }))),
  );

  const searching = () => !!query().trim();

  /** Flat, score-ordered rows while searching. */
  const rows = createMemo<Row[]>(() => {
    if (!searching()) return [];
    const key = (c: ModelChoice) => `${providerInfo(c.provider).label} ${c.model}`;
    return fuzzyRank(query(), all(), key).map((r) => ({
      ...r.item,
      label: key(r.item),
      // Re-derive indices against the MODEL string alone: we scored a label that also held
      // the provider name, and its offsets don't map onto the text we render.
      indices: matchIndices(query(), r.item.model),
    }));
  });

  /** Grouped rows when not searching — one group per provider, catalog order. */
  const groups = createMemo(() =>
    props.providers.flatMap((p) => {
      const models = props.modelsFor(p);
      if (!models.length) return [];
      return [{ label: providerInfo(p).label, provider: p, models }];
    }),
  );

  /** Flattened order for keyboard nav, matching what's rendered. */
  const flat = createMemo<ModelChoice[]>(() =>
    searching() ? rows() : groups().flatMap((g) => g.models.map((model) => ({ provider: g.provider, model }))),
  );

  createEffect(() => { query(); setCursor(0); }); // a new query resets the highlight
  createEffect(() => {
    if (!open()) return;
    // Keep the cursor row visible as the user arrows through a long catalog.
    cursor();
    queueMicrotask(() => listEl?.querySelector<HTMLElement>(".mp-row.on")?.scrollIntoView({ block: "nearest" }));
  });

  function close() {
    setOpen(false);
    setQuery("");
  }
  function pick(c: ModelChoice) {
    props.onPick(c);
    close();
  }
  function onKey(e: KeyboardEvent) {
    const n = flat().length;
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => (n ? (c + 1) % n : 0)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => (n ? (c - 1 + n) % n : 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const c = flat()[cursor()]; if (c) pick(c); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  }

  const onDocKey = (e: KeyboardEvent) => { if (e.key === "Escape" && open()) close(); };
  document.addEventListener("keydown", onDocKey);
  onCleanup(() => document.removeEventListener("keydown", onDocKey));

  const isCurrent = (c: ModelChoice) => c.provider === props.current.provider && c.model === props.current.model;
  /** Row → flat index. A `findIndex` per row is O(n²), which is felt at exactly the
   *  catalog size this component exists for (OpenRouter ships ~300 ids). */
  const flatIndex = createMemo(() => {
    const m = new Map<string, number>();
    flat().forEach((c, i) => m.set(`${c.provider}|${c.model}`, i));
    return m;
  });
  const indexOf = (c: ModelChoice) => flatIndex().get(`${c.provider}|${c.model}`) ?? -1;

  return (
    <div class="mp">
      <button
        class="mp-btn"
        title="Model — click or type to search"
        onClick={() => { setOpen((v) => !v); queueMicrotask(() => inputEl?.focus()); }}
      >
        <span class="mp-btn-model">{props.current.model || "Select a model"}</span>
        <span class="mp-btn-caret">▾</span>
      </button>

      <Show when={open()}>
        {/* Full-screen catcher, same pattern as the run chooser. */}
        <div class="mp-overlay" onClick={close} />
        <div class="mp-pop">
          <input
            ref={inputEl}
            class="mp-search"
            placeholder="Search models…  (try “ant opus”, “gpt-5”, “oss”)"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={onKey}
          />
          <div class="mp-list" ref={listEl}>
            <Show when={searching()} fallback={
              <For each={groups()}>
                {(g) => (
                  <>
                    <div class="mp-group">{g.label}</div>
                    <For each={g.models}>
                      {(model) => {
                        const c = { provider: g.provider, model };
                        return (
                          <button
                            class="mp-row"
                            classList={{ on: indexOf(c) === cursor(), cur: isCurrent(c) }}
                            onMouseEnter={() => setCursor(indexOf(c))}
                            onClick={() => pick(c)}
                          >
                            <span class="mp-model">{model}</span>
                          </button>
                        );
                      }}
                    </For>
                  </>
                )}
              </For>
            }>
              <Show when={rows().length} fallback={<div class="mp-empty">No model matches “{query()}”.</div>}>
                <For each={rows()}>
                  {(r, i) => (
                    <button
                      class="mp-row"
                      classList={{ on: i() === cursor(), cur: isCurrent(r) }}
                      onMouseEnter={() => setCursor(i())}
                      onClick={() => pick(r)}
                    >
                      <span class="mp-model">
                        <For each={highlight(r.model, r.indices)}>
                          {(part) => (part.hit ? <b>{part.text}</b> : <>{part.text}</>)}
                        </For>
                      </span>
                      <span class="mp-prov">{providerInfo(r.provider).label}</span>
                    </button>
                  )}
                </For>
              </Show>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

/** Indices of `query`'s match within `model` alone (the label we scored also held the
 *  provider name, whose offsets don't map onto the rendered text). */
function matchIndices(query: string, model: string): number[] {
  const set = new Set<number>();
  for (const term of query.trim().split(/\s+/).filter(Boolean)) {
    const m = fuzzyRank(term, [model], (s) => s)[0];
    if (m) for (const i of m.indices) set.add(i);
  }
  return [...set].sort((a, b) => a - b);
}
