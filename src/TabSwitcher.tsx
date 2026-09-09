import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { filterTabs, type TabColor } from "./tabs";

// "All tabs" popover (the ⌄ at the end of the tab strip, or the showAllTabs
// action). One filter box over every open tab, grouped by connection — the strip
// scrolls and hides tabs, this list never does.
//
// Shares the command palette's overlay/list classes so both surfaces stay in
// step; only the row internals are its own.

export type TabSwitcherItem = {
  id: string;
  /** Shown title (custom or automatic). */
  label: string;
  /** File path, or "" for an unsaved buffer. */
  detail: string;
  connectionId: string;
  connectionLabel: string;
  mascot: string;
  dirty: boolean;
  pinned: boolean;
  color: TabColor;
  active: boolean;
};

export function TabSwitcher(props: {
  items: TabSwitcherItem[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  let input: HTMLInputElement | undefined;

  onMount(() => input?.focus());

  const matches = createMemo(() => filterTabs(props.items, q()));

  /** Connection groups in first-seen order, so the list matches the strip. */
  const groups = createMemo(() => {
    const out: { id: string; label: string; mascot: string; items: TabSwitcherItem[] }[] = [];
    for (const it of matches()) {
      let g = out.find((x) => x.id === it.connectionId);
      if (!g) {
        g = { id: it.connectionId, label: it.connectionLabel, mascot: it.mascot, items: [] };
        out.push(g);
      }
      g.items.push(it);
    }
    return out;
  });

  /** Flat order the keyboard walks (matches the rendered order). */
  const flat = createMemo(() => groups().flatMap((g) => g.items));

  const clamp = (i: number) => Math.max(0, Math.min(flat().length - 1, i));

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(clamp(cursor() + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(clamp(cursor() - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = flat()[clamp(cursor())];
      if (pick) {
        props.onClose();
        props.onPick(pick.id);
      }
    }
  };

  return (
    <div class="palette-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class="palette tab-switcher" onKeyDown={onKey}>
        <input
          ref={(el) => (input = el)}
          value={q()}
          placeholder="Filter tabs"
          aria-label="Filter tabs"
          onInput={(e) => { setQ(e.currentTarget.value); setCursor(0); }}
        />
        <div class="palette-list">
          <Show when={flat().length} fallback={<div class="palette-empty">No matching tabs</div>}>
            <For each={groups()}>
              {(g) => (
                <>
                  <div class="ts-group">
                    <span>{g.mascot}</span>
                    <span class="ts-group-name">{g.label}</span>
                    <span class="ts-group-count">{g.items.length}</span>
                  </div>
                  <For each={g.items}>
                    {(it) => (
                      <div
                        class="palette-item ts-item"
                        classList={{ active: flat()[cursor()]?.id === it.id, current: it.active }}
                        role="button"
                        tabindex="-1"
                        onMouseEnter={() => setCursor(flat().findIndex((x) => x.id === it.id))}
                        onClick={() => { props.onClose(); props.onPick(it.id); }}
                      >
                        <span class="ts-mark" data-color={it.color || undefined} />
                        <Show when={it.pinned}><span class="ts-badge" title="Pinned">Pinned</span></Show>
                        <span class="ts-name">{it.label}</span>
                        <Show when={it.detail}><span class="ts-path">{it.detail}</span></Show>
                        <Show when={it.dirty}><span class="ts-dirty" title="Unsaved changes">●</span></Show>
                      </div>
                    )}
                  </For>
                </>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}
