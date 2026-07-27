import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Icon, type IconName } from "./Icons";

export type MenuItem =
  | { sep: true }
  | { label: string; icon?: IconName; danger?: boolean; disabled?: boolean; title?: string; valid?: () => boolean; onClick: () => void };

export type MenuState = { x: number; y: number; items: MenuItem[]; scope?: string } | null;

export function ContextMenu(props: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  let el: HTMLDivElement | undefined;
  let priorFocus: HTMLElement | null = null;
  // Start at the requested point, then clamp against the real rendered size so a
  // tall menu near the bottom/right edge stays fully on-screen.
  const [pos, setPos] = createSignal({ x: props.x, y: props.y });
  const onDocDown = (e: MouseEvent) => {
    if (el && !el.contains(e.target as Node)) props.onClose();
  };
  const enabledItems = () => el
    ? [...el.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')]
    : [];
  const onMenuKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const items = enabledItems();
    if (!items.length) return;
    if (e.key === "Enter" || e.key === " ") {
      (document.activeElement as HTMLElement | null)?.click();
      return;
    }
    const current = items.indexOf(document.activeElement as HTMLElement);
    // With focus still on the container (no item yet), ArrowUp starts at the end.
    const base = current === -1 && e.key === "ArrowUp" ? 0 : current;
    const next = e.key === "Home" ? 0
      : e.key === "End" ? items.length - 1
      : (base + (e.key === "ArrowDown" ? 1 : items.length - 1) + items.length) % items.length;
    items[next].focus();
  };
  // Document-level fallback: dismiss only on keys that mean "leave the menu".
  // Closing on every unhandled key made stray typing/function keys eat the menu.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Tab") props.onClose();
  };
  const onViewportChange = () => props.onClose();
  let installTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    if (props.items.some((item) => !("sep" in item) && item.valid?.() === false)) props.onClose();
  });
  onMount(() => {
    priorFocus = document.activeElement as HTMLElement | null;
    if (el) {
      const r = el.getBoundingClientRect();
      const x = props.x + r.width > window.innerWidth ? Math.max(4, window.innerWidth - r.width - 4) : props.x;
      const y = props.y + r.height > window.innerHeight ? Math.max(4, window.innerHeight - r.height - 4) : props.y;
      if (x !== props.x || y !== props.y) setPos({ x, y });
    }
    // Defer so the click that opened the menu doesn't immediately dismiss it.
    installTimer = setTimeout(() => {
      document.addEventListener("mousedown", onDocDown);
      document.addEventListener("keydown", onKey);
      window.addEventListener("blur", onViewportChange);
      window.addEventListener("resize", onViewportChange);
      window.addEventListener("scroll", onViewportChange, true);
    });
    // Focus the container (not the first item): keyboard nav works immediately
    // via onMenuKey without visibly yanking selection on every right-click.
    queueMicrotask(() => el?.focus());
  });
  onCleanup(() => {
    clearTimeout(installTimer);
    document.removeEventListener("mousedown", onDocDown);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("blur", onViewportChange);
    window.removeEventListener("resize", onViewportChange);
    window.removeEventListener("scroll", onViewportChange, true);
    if (priorFocus?.isConnected) priorFocus.focus();
  });

  return (
    <div class="ctx-menu" ref={el} role="menu" aria-label="Actions" tabindex="-1" style={{ left: `${pos().x}px`, top: `${pos().y}px` }} onKeyDown={onMenuKey}>
      <For each={props.items}>
        {(it) =>
          "sep" in it ? (
            <div class="ctx-sep" role="separator" />
          ) : (
              <div
                class="ctx-item"
                role="menuitem"
                tabindex={it.disabled || it.valid?.() === false ? -1 : 0}
                aria-disabled={it.disabled || it.valid?.() === false ? "true" : "false"}
              classList={{ danger: it.danger, "ctx-disabled": it.disabled || it.valid?.() === false }}
              title={it.valid?.() === false ? "This menu target is no longer current" : it.title}
              onClick={() => {
                if (it.disabled || it.valid?.() === false) return;
                props.onClose();
                it.onClick();
              }}
            >
              <span class="ctx-icon"><Show when={it.icon}>{(n) => <Icon name={n()} />}</Show></span>
              <span class="ctx-text">{it.label}</span>
            </div>
          )
        }
      </For>
    </div>
  );
}
