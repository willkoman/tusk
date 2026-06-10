import { type Accessor, For, Show, createMemo, createSignal } from "solid-js";
import {
  ACTIONS,
  type ActionDef,
  type ActionId,
  type KeyOverrides,
  displayKey,
  effectiveKey,
  findConflict,
  normalizeKeyEvent,
} from "../actions";

// Searchable shortcut table grouped by category — doubles as the cheat-sheet.
// Click a binding chip to capture a new chord (Esc cancels, Backspace unbinds);
// a conflicting chord warns once and replaces on a second press. CodeMirror
// built-ins (search/fold/undo/completion) are listed read-only at the bottom.

const BUILTINS: { title: string; key: string }[] = [
  { title: "Find / replace (in editor)", key: "Mod-f" },
  { title: "Undo / redo", key: "Mod-z" },
  { title: "Fold / unfold", key: "Mod-Shift-[" },
  { title: "Accept completion", key: "Tab" },
  { title: "Indent selection", key: "Tab" },
];

export function ShortcutsPane(props: {
  keys: Accessor<KeyOverrides>;
  update: (patch: KeyOverrides) => void;
  resetAll: () => void;
}) {
  const [q, setQ] = createSignal("");
  const [capturing, setCapturing] = createSignal<ActionId | null>(null);
  const [conflict, setConflict] = createSignal<{ key: string; other: ActionId } | null>(null);

  const filtered = createMemo(() => {
    const needle = q().toLowerCase();
    return ACTIONS.filter((a) => !needle || a.title.toLowerCase().includes(needle) || a.category.toLowerCase().includes(needle));
  });
  const categories = createMemo(() => [...new Set(filtered().map((a) => a.category))]);

  const overridden = (id: ActionId) => id in props.keys();
  const titleOf = (id: ActionId) => ACTIONS.find((a) => a.id === id)?.title ?? id;

  const stopCapture = () => {
    setCapturing(null);
    setConflict(null);
  };

  const onCaptureKey = (e: KeyboardEvent, id: ActionId) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return stopCapture();
    if (e.key === "Backspace" || e.key === "Delete") {
      props.update({ [id]: null });
      return stopCapture();
    }
    const k = normalizeKeyEvent(e);
    if (!k) return; // bare modifier or plain printable — keep waiting
    const other = findConflict(k, id, props.keys());
    const pending = conflict();
    if (other && !(pending && pending.key === k)) {
      setConflict({ key: k, other }); // warn; same chord again confirms
      return;
    }
    if (other) props.update({ [other]: null, [id]: k });
    else props.update({ [id]: k });
    stopCapture();
  };

  return (
    <div class="shortcuts-pane">
      <div class="shortcuts-head">
        <input type="text" placeholder="Filter actions…" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
        <button class="ghost" onClick={() => { props.resetAll(); stopCapture(); }}>Reset all</button>
      </div>
      <For each={categories()}>
        {(cat) => (
          <div class="shortcuts-group">
            <div class="shortcuts-cat">{cat}</div>
            <For each={filtered().filter((a) => a.category === cat)}>
              {(a: ActionDef) => {
                const key = () => effectiveKey(a.id, props.keys());
                return (
                  <div class="shortcuts-row">
                    <span class="shortcuts-title">{a.title}</span>
                    <Show when={capturing() === a.id && conflict()}>
                      <span class="shortcuts-conflict">
                        bound to “{titleOf(conflict()!.other)}” — press again to replace
                      </span>
                    </Show>
                    <button
                      class="key-chip"
                      classList={{ capturing: capturing() === a.id, unbound: !key() }}
                      on:keydown={(e: KeyboardEvent) => capturing() === a.id && onCaptureKey(e, a.id)}
                      onBlur={() => capturing() === a.id && stopCapture()}
                      onClick={() => { setCapturing(a.id); setConflict(null); }}
                      title="Click, then press the new shortcut (Esc cancels, Backspace clears)"
                    >
                      {capturing() === a.id ? "press keys…" : key() ? displayKey(key()) : "unbound"}
                    </button>
                    <Show when={overridden(a.id)} fallback={<span class="shortcuts-resetslot" />}>
                      <button
                        class="icon shortcuts-reset"
                        title="Reset to default"
                        onClick={() => props.update({ [a.id]: undefined })}
                      >
                        ⟲
                      </button>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        )}
      </For>
      <div class="shortcuts-group">
        <div class="shortcuts-cat">Built-in (not rebindable)</div>
        <For each={BUILTINS}>
          {(b) => (
            <div class="shortcuts-row builtin">
              <span class="shortcuts-title">{b.title}</span>
              <span class="key-chip static">{displayKey(b.key)}</span>
              <span class="shortcuts-resetslot" />
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
