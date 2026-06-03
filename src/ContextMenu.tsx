import { For, createSignal, onCleanup, onMount } from "solid-js";

export type MenuItem =
  | { sep: true }
  | { label: string; icon?: string; danger?: boolean; disabled?: boolean; onClick: () => void };

export type MenuState = { x: number; y: number; items: MenuItem[] } | null;

export function ContextMenu(props: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  let el: HTMLDivElement | undefined;
  // Start at the requested point, then clamp against the real rendered size so a
  // tall menu near the bottom/right edge stays fully on-screen.
  const [pos, setPos] = createSignal({ x: props.x, y: props.y });
  const onDocDown = (e: MouseEvent) => {
    if (el && !el.contains(e.target as Node)) props.onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => {
    if (el) {
      const r = el.getBoundingClientRect();
      const x = props.x + r.width > window.innerWidth ? Math.max(4, window.innerWidth - r.width - 4) : props.x;
      const y = props.y + r.height > window.innerHeight ? Math.max(4, window.innerHeight - r.height - 4) : props.y;
      if (x !== props.x || y !== props.y) setPos({ x, y });
    }
    // Defer so the click that opened the menu doesn't immediately dismiss it.
    setTimeout(() => {
      document.addEventListener("mousedown", onDocDown);
      document.addEventListener("keydown", onKey);
    });
  });
  onCleanup(() => {
    document.removeEventListener("mousedown", onDocDown);
    document.removeEventListener("keydown", onKey);
  });

  return (
    <div class="ctx-menu" ref={el} style={{ left: `${pos().x}px`, top: `${pos().y}px` }}>
      <For each={props.items}>
        {(it) =>
          "sep" in it ? (
            <div class="ctx-sep" />
          ) : (
            <div
              class="ctx-item"
              classList={{ danger: it.danger, "ctx-disabled": it.disabled }}
              onClick={() => {
                if (it.disabled) return;
                it.onClick();
                props.onClose();
              }}
            >
              <span class="ctx-icon">{it.icon ?? ""}</span>
              <span class="ctx-text">{it.label}</span>
            </div>
          )
        }
      </For>
    </div>
  );
}
