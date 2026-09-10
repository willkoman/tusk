import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { Icon, type IconName } from "./Icons";

/** A leaf: the thing that runs. */
export type MenuAction = { label: string; icon?: IconName; danger?: boolean; disabled?: boolean; title?: string; key?: string; valid?: () => boolean; onClick: () => void };
/** One level of nesting: a group that opens its own panel. Groups never nest further. */
export type MenuGroup = { label: string; icon?: IconName; disabled?: boolean; title?: string; items: MenuItem[] };

/** A heading: a title line with an optional smaller detail line. Not focusable, never runs. */
export type MenuHead = { head: string; sub?: string };

export type MenuItem =
  /** `sep: "danger"` is the wider rule before a destructive group: extra space
   *  above it, so a mis-aimed click near a benign item cannot land on Drop. */
  | { sep: true | "danger" }
  | MenuHead
  | MenuAction
  | MenuGroup;

export type MenuState = { x: number; y: number; items: MenuItem[]; scope?: string } | null;

const isSep = (i: MenuItem): i is { sep: true | "danger" } => "sep" in i;
const isHead = (i: MenuItem): i is MenuHead => "head" in i;
const isGroup = (i: MenuItem): i is MenuGroup => "items" in i;
const isDead = (i: MenuAction | MenuGroup) => !!i.disabled || ("valid" in i && i.valid?.() === false);

/** Every leaf, one level deep — for the "target is gone" check. */
function leaves(items: MenuItem[]): MenuAction[] {
  const out: MenuAction[] = [];
  for (const it of items) {
    if (isSep(it) || isHead(it)) continue;
    if (isGroup(it)) out.push(...(it.items.filter((x) => !isSep(x) && !isHead(x) && !isGroup(x)) as MenuAction[]));
    else out.push(it);
  }
  return out;
}

/** Direct children only, so navigation stays inside the level that has focus. */
const enabledIn = (el: HTMLElement | undefined) =>
  el ? [...el.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]:not([aria-disabled="true"])')] : [];

export function ContextMenu(props: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  let el: HTMLDivElement | undefined;
  let sub: HTMLDivElement | undefined;
  let priorFocus: HTMLElement | null = null;
  // Start at the requested point, then clamp against the real rendered size so a
  // tall menu near the bottom/right edge stays fully on-screen.
  const [pos, setPos] = createSignal({ x: props.x, y: props.y });
  // Index of the open submenu's parent item, and the point it opens from.
  const [openIdx, setOpenIdx] = createSignal<number | null>(null);
  const [subPos, setSubPos] = createSignal({ x: 0, y: 0 });
  const openGroup = (idx: number, parent: HTMLElement) => {
    const r = parent.getBoundingClientRect();
    setSubPos({ x: r.right - 3, y: r.top - 5 });
    setOpenIdx(idx);
  };
  /** The group row that owns the open submenu (index is into `props.items`). */
  const groupRow = (idx: number | null) =>
    idx === null ? null : el?.querySelector<HTMLElement>(`[data-group="1"][data-idx="${idx}"]`) ?? null;
  /** The live submenu element (the ref outlives the panel it pointed at). */
  const subEl = () => (openIdx() !== null && sub?.isConnected ? sub : undefined);
  const closeGroup = (refocus = false) => {
    const row = groupRow(openIdx());
    setOpenIdx(null);
    if (refocus) row?.focus();
  };

  // Clamp the open panel after it renders — Solid reuses the same element when the
  // pointer moves from one group to the next, so this cannot ride on the ref.
  createEffect(
    on(openIdx, (idx) => {
      if (idx === null) return;
      queueMicrotask(() => {
        const node = subEl();
        if (!node) return;
        const r = node.getBoundingClientRect();
        const parent = groupRow(idx)?.getBoundingClientRect();
        let { x, y } = subPos();
        if (r.right > window.innerWidth - 4 && parent) x = Math.max(4, parent.left - r.width + 3);
        if (r.bottom > window.innerHeight - 4) y = Math.max(4, window.innerHeight - r.height - 4);
        if (x !== subPos().x || y !== subPos().y) setSubPos({ x, y });
      });
    }),
  );

  const onDocDown = (e: MouseEvent) => {
    if (el && !el.contains(e.target as Node)) props.onClose();
  };
  const onMenuKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (openIdx() !== null) closeGroup(true);
      else props.onClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End", "Enter", " "].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const active = document.activeElement as HTMLElement | null;
    const panel = subEl();
    const inSub = !!panel && !!active && panel.contains(active);
    const items = enabledIn(inSub ? panel : el);
    const idx = active ? items.indexOf(active) : -1;
    const onGroup = !inSub && active?.dataset.group === "1" && active.getAttribute("aria-disabled") !== "true";

    // A group opens rightward (ArrowRight, Enter, Space) and hands focus to its
    // first entry; ArrowLeft and Escape hand it back.
    if (onGroup && (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ")) {
      openGroup(Number(active!.dataset.idx), active!);
      queueMicrotask(() => enabledIn(subEl())[0]?.focus());
      return;
    }
    if (e.key === "ArrowRight") return;
    if (e.key === "ArrowLeft") {
      if (inSub) closeGroup(true);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      active?.click();
      return;
    }
    if (!items.length) return;
    // With focus still on the container (no item yet), ArrowUp starts at the end.
    const base = idx === -1 && e.key === "ArrowUp" ? 0 : idx;
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
    if (leaves(props.items).some((item) => item.valid?.() === false)) props.onClose();
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

  const run = (it: MenuAction) => {
    if (isDead(it)) return;
    props.onClose();
    it.onClick();
  };

  const Row = (p: { it: MenuAction; onEnter?: () => void }) => (
    <div
      class="ctx-item"
      role="menuitem"
      tabindex={isDead(p.it) ? -1 : 0}
      aria-disabled={isDead(p.it) ? "true" : "false"}
      classList={{ danger: p.it.danger, "ctx-disabled": isDead(p.it) }}
      title={p.it.valid?.() === false ? "This menu target is no longer current" : p.it.title}
      onMouseEnter={() => p.onEnter?.()}
      onClick={() => run(p.it)}
    >
      <span class="ctx-icon"><Show when={p.it.icon}>{(n) => <Icon name={n()} />}</Show></span>
      <span class="ctx-text">{p.it.label}</span>
      <Show when={p.it.key}><span class="ctx-key">{p.it.key}</span></Show>
    </div>
  );
  const Head = (p: { it: MenuHead }) => (
    <div class="ctx-head" role="presentation">
      <span class="ctx-head-title">{p.it.head}</span>
      <Show when={p.it.sub}><span class="ctx-head-sub">{p.it.sub}</span></Show>
    </div>
  );

  return (
    <div class="ctx-menu" ref={el} role="menu" aria-label="Actions" tabindex="-1" style={{ left: `${pos().x}px`, top: `${pos().y}px` }} onKeyDown={onMenuKey}>
      <For each={props.items}>
        {(it, i) =>
          isSep(it) ? (
            <div class="ctx-sep" classList={{ "ctx-sep-danger": it.sep === "danger" }} role="separator" />
          ) : isHead(it) ? (
            <Head it={it} />
          ) : isGroup(it) ? (
            <div
              class="ctx-item ctx-group"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={openIdx() === i() ? "true" : "false"}
              data-group="1"
              data-idx={i()}
              tabindex={isDead(it) ? -1 : 0}
              aria-disabled={isDead(it) ? "true" : "false"}
              classList={{ "ctx-disabled": isDead(it), open: openIdx() === i() }}
              title={it.title}
              onMouseEnter={(e) => !isDead(it) && openGroup(i(), e.currentTarget)}
              onClick={(e) => !isDead(it) && openGroup(i(), e.currentTarget)}
            >
              <span class="ctx-icon"><Show when={it.icon}>{(n) => <Icon name={n()} />}</Show></span>
              <span class="ctx-text">{it.label}</span>
              <span class="ctx-more" aria-hidden="true"><Icon name="chevronRight" /></span>
            </div>
          ) : (
            <Row it={it} onEnter={() => setOpenIdx(null)} />
          )
        }
      </For>
      <Show when={openIdx() !== null && (props.items[openIdx()!] as MenuGroup)}>
        {(group) => (
          <div
            class="ctx-menu ctx-sub"
            ref={(node) => (sub = node)}
            role="menu"
            aria-label={group().label}
            style={{ left: `${subPos().x}px`, top: `${subPos().y}px` }}
          >
            <For each={group().items}>
              {(it) =>
                isSep(it) ? (
                  <div class="ctx-sep" classList={{ "ctx-sep-danger": it.sep === "danger" }} role="separator" />
                ) : isHead(it) ? (
                  <Head it={it} />
                ) : isGroup(it) ? null : (
                  <Row it={it} />
                )
              }
            </For>
          </div>
        )}
      </Show>
    </div>
  );
}
