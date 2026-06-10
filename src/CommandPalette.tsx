import { For, createMemo, createSignal, onMount } from "solid-js";
import { ACTIONS, type ActionCtx, type ActionId, type KeyOverrides, displayKey, effectiveKey } from "./actions";

// Mod+K command palette: fuzzy-search over the ACTIONS registry, ↑/↓/Enter/Esc.
// Own lightweight overlay (not Dialog — input-first focus, list nav, no chrome).
// Rows show each action's current binding, so the palette doubles as discovery.

/** Tiny subsequence scorer: consecutive-run + word-start bonuses, null = no match. */
function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi], ti);
    if (idx === -1) return null;
    streak = idx === ti ? streak + 1 : 1;
    score += streak * 2; // consecutive chars compound
    if (idx === 0 || t[idx - 1] === " " || t[idx - 1] === "-") score += 3; // word start
    ti = idx + 1;
  }
  return score - t.length * 0.01; // light tiebreak toward shorter titles
}

export function CommandPalette(props: {
  keys: KeyOverrides;
  ctx: ActionCtx;
  onRun: (id: ActionId) => void;
  onClose: () => void;
}) {
  const [q, setQ] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  let input: HTMLInputElement | undefined;

  onMount(() => input?.focus());

  const items = createMemo(() => {
    const available = ACTIONS.filter((a) => !a.enabled || a.enabled(props.ctx));
    const needle = q().trim();
    const scored = available
      .map((a) => ({ a, s: fuzzyScore(needle, `${a.category} ${a.title}`) }))
      .filter((x): x is { a: (typeof ACTIONS)[number]; s: number } => x.s !== null);
    scored.sort((x, y) => y.s - x.s);
    return scored.map((x) => x.a);
  });

  const clamp = (i: number) => Math.max(0, Math.min(items().length - 1, i));

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
      const it = items()[cursor()];
      if (it) {
        props.onClose();
        props.onRun(it.id);
      }
    }
  };

  return (
    <div class="palette-overlay" onClick={props.onClose}>
      <div class="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          type="text"
          placeholder="Type a command…"
          value={q()}
          on:keydown={onKey}
          onInput={(e) => {
            setQ(e.currentTarget.value);
            setCursor(0);
          }}
        />
        <div class="palette-list">
          <For each={items()} fallback={<div class="palette-empty">no matching commands</div>}>
            {(a, i) => (
              <div
                class="palette-item"
                classList={{ active: i() === cursor() }}
                onMouseEnter={() => setCursor(i())}
                onClick={() => {
                  props.onClose();
                  props.onRun(a.id);
                }}
              >
                <span class="palette-cat">{a.category}</span>
                <span class="palette-title">{a.title}</span>
                <span class="spacer" />
                <span class="palette-key">{displayKey(effectiveKey(a.id, props.keys))}</span>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
