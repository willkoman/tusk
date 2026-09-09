/**
 * One pointer-based drag-to-reorder primitive, shared by the editor tab strip
 * (App.tsx) and the result-grid header (ResultGrid.tsx) so both gestures feel
 * identical: a press-and-move threshold that leaves plain clicks alone, a ghost
 * clone that follows the pointer, an insertion bar that animates between slots,
 * edge auto-scroll, and Escape to cancel.
 *
 * The arithmetic half (threshold, slot, auto-scroll step, order commit) is pure and
 * covered by dnd.test.ts. `startPointerDrag` is the DOM shell around it: it owns the
 * ghost node, the window listeners and the cleanup, and reports slots back to the
 * caller — it never touches the caller's model. Nothing reorders until the drop, so
 * cancelling is "do not commit", not "undo".
 */

/** Pointer travel, in px, before a press becomes a drag. Clicks stay clicks. */
export const DRAG_THRESHOLD = 4;
/** Distance from a scroller's edge at which auto-scroll kicks in. */
export const AUTOSCROLL_EDGE = 36;
/** Auto-scroll speed, px per animation frame. */
export const AUTOSCROLL_STEP = 14;
/** Slack around the drop zone before a release counts as "dropped outside". */
export const DROP_MARGIN = 24;

/** Has the pointer travelled far enough for this press to be a drag? */
export function passedThreshold(dx: number, dy: number, threshold = DRAG_THRESHOLD): boolean {
  return Math.abs(dx) >= threshold || Math.abs(dy) >= threshold;
}

/**
 * Insertion slot for a position in the scroller's CONTENT coordinates.
 * `edges` holds n+1 boundaries for n items (edges[i] = left of item i, edges[n] =
 * right of the last one). The result is 0..n — the gap the indicator sits in.
 */
export function insertionSlot(edges: readonly number[], pos: number): number {
  const n = edges.length - 1;
  if (n <= 0) return 0;
  for (let i = 0; i < n; i++) if (pos < (edges[i] + edges[i + 1]) / 2) return i;
  return n;
}

/** Where a slot's indicator bar sits, in the same content coordinates. */
export function slotOffset(edges: readonly number[], slot: number): number {
  if (edges.length === 0) return 0;
  const i = Math.max(0, Math.min(edges.length - 1, slot));
  return edges[i];
}

/** Dropping into the slot on either side of an item leaves the order alone. */
export function isNoopMove(from: number, slot: number): boolean {
  return slot === from || slot === from + 1;
}

/**
 * Move item `from` into `slot`. Returns the SAME array reference when the move
 * changes nothing, so callers can skip a state write (and a persist) on a no-op.
 */
export function reorder<T>(list: readonly T[], from: number, slot: number): readonly T[] {
  if (from < 0 || from >= list.length) return list;
  if (slot < 0 || slot > list.length) return list;
  if (isNoopMove(from, slot)) return list;
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(slot > from ? slot - 1 : slot, 0, moved);
  return next;
}

/**
 * Signed scroll step for a pointer near a scroller's edge along one axis
 * (0 = no scroll). `min`/`max` are the scroller's viewport bounds in client
 * coordinates. The edge band shrinks on narrow scrollers so the two zones can
 * never span the whole viewport.
 */
export function autoScrollStep(
  pos: number,
  min: number,
  max: number,
  edge = AUTOSCROLL_EDGE,
  step = AUTOSCROLL_STEP,
): number {
  const span = max - min;
  if (span <= 0) return 0;
  const band = Math.min(edge, span / 3);
  if (pos < min + band) return -step;
  if (pos > max - band) return step;
  return 0;
}

/** Is a release inside the drop zone (its rect grown by `margin`)? */
export function insideDropZone(
  x: number,
  y: number,
  zone: { left: number; right: number; top: number; bottom: number },
  margin = DROP_MARGIN,
): boolean {
  return (
    x >= zone.left - margin && x <= zone.right + margin && y >= zone.top - margin && y <= zone.bottom + margin
  );
}

// --- pure state machine -----------------------------------------------------

export type DragPhase = "pending" | "dragging" | "dropped" | "cancelled";

export type DragState = {
  phase: DragPhase;
  /** Index of the item under the pointer when the press started. */
  from: number;
  /** Current insertion slot; null until the threshold is passed, and after a cancel. */
  slot: number | null;
  startX: number;
  startY: number;
};

export function beginDrag(from: number, x: number, y: number): DragState {
  return { phase: "pending", from, slot: null, startX: x, startY: y };
}

/**
 * Feed a pointer move plus the slot the caller computed for it. Stays `pending`
 * (identical state) until the travel threshold is passed.
 */
export function advanceDrag(
  s: DragState,
  x: number,
  y: number,
  slot: number,
  threshold = DRAG_THRESHOLD,
): DragState {
  if (s.phase !== "pending" && s.phase !== "dragging") return s;
  if (s.phase === "pending" && !passedThreshold(x - s.startX, y - s.startY, threshold)) return s;
  if (s.phase === "dragging" && s.slot === slot) return s;
  return { ...s, phase: "dragging", slot };
}

/** Escape, a lost pointer, or a release outside the drop zone. Order is untouched. */
export function cancelDrag(s: DragState): DragState {
  return { ...s, phase: "cancelled", slot: null };
}

/** Release. A press that never passed the threshold cancels — the caller treats it as a click. */
export function dropDrag(s: DragState): DragState {
  if (s.phase !== "dragging" || s.slot === null) return cancelDrag(s);
  return { ...s, phase: "dropped" };
}

/** The committed order for a finished drag, or the input list for anything else. */
export function commitDrag<T>(s: DragState, list: readonly T[]): readonly T[] {
  if (s.phase !== "dropped" || s.slot === null) return list;
  return reorder(list, s.from, s.slot);
}

// --- DOM shell --------------------------------------------------------------

export type PointerDragOptions = {
  /** The pointerdown that started the press. */
  event: PointerEvent;
  /** Index of the pressed item among its siblings. */
  from: number;
  /** The pressed element — cloned into the ghost, so it must be on screen. */
  source: HTMLElement;
  /** Scroll container; also the coordinate space `edges` is measured in. */
  scroller: HTMLElement;
  /** Item boundaries in the scroller's content coordinates (n+1 values), re-read each frame. */
  edges: () => number[];
  /** A release outside this element (plus DROP_MARGIN) cancels. Defaults to `scroller`. */
  dropZone?: () => HTMLElement | undefined;
  /** Extra class for the ghost node, on top of the source's own classes. */
  ghostClass?: string;
  /** Fired once, when the press becomes a drag. */
  onStart?: () => void;
  /** Current insertion slot, or null when the drag ends without committing. */
  onSlot: (slot: number | null) => void;
  /** Commit: move `from` into `slot`. Never called for a no-op move. */
  onDrop: (from: number, slot: number) => void;
  /** Always last. `moved` is false when the press never became a drag (a click). */
  onEnd: (moved: boolean) => void;
};

export type PointerDragHandle = {
  /** Abort and clean up (unmount, replaced result, disconnect). */
  cancel: () => void;
};

/**
 * Arm a reorder drag from a pointerdown. Every listener lives on `window` and is
 * removed on end, so a drag can never outlive its gesture or leak across results.
 */
export function startPointerDrag(o: PointerDragOptions): PointerDragHandle {
  const doc = o.source.ownerDocument;
  const win = doc.defaultView ?? window;
  const pointerId = o.event.pointerId;
  const srcRect = o.source.getBoundingClientRect();
  const grabX = o.event.clientX - srcRect.left;
  const grabY = o.event.clientY - srcRect.top;

  let state = beginDrag(o.from, o.event.clientX, o.event.clientY);
  let ghost: HTMLElement | null = null;
  let raf = 0;
  let ptr = { x: o.event.clientX, y: o.event.clientY };
  let becameDrag = false;
  let finished = false;

  const contentX = (clientX: number) =>
    clientX - o.scroller.getBoundingClientRect().left + o.scroller.scrollLeft;

  function makeGhost() {
    const clone = o.source.cloneNode(true) as HTMLElement;
    const cs = win.getComputedStyle(o.source);
    clone.classList.add("dnd-ghost");
    if (o.ghostClass) clone.classList.add(o.ghostClass);
    clone.removeAttribute("title");
    // The source may be absolutely positioned inside a virtualized pane; pin the
    // clone to the viewport at its measured size so it matches font and box exactly.
    clone.style.cssText +=
      `;position:fixed;left:0;top:0;margin:0;box-sizing:border-box` +
      `;width:${srcRect.width}px;height:${srcRect.height}px` +
      `;font:${cs.font};pointer-events:none`;
    doc.body.appendChild(clone);
    ghost = clone;
    moveGhost();
  }

  function moveGhost() {
    if (!ghost) return;
    // A 1.5° lift reads as "picked up" without making the label hard to follow.
    ghost.style.transform = `translate3d(${ptr.x - grabX}px, ${ptr.y - grabY}px, 0) rotate(1.5deg)`;
  }

  function recompute() {
    const next = advanceDrag(state, ptr.x, ptr.y, insertionSlot(o.edges(), contentX(ptr.x)));
    if (next === state) return;
    const starting = state.phase === "pending" && next.phase === "dragging";
    state = next;
    if (starting) {
      becameDrag = true;
      doc.body.classList.add("dnd-dragging");
      makeGhost();
      o.onStart?.();
    }
    o.onSlot(state.slot);
  }

  function tick() {
    raf = 0;
    if (state.phase !== "dragging") return;
    const b = o.scroller.getBoundingClientRect();
    const dx = autoScrollStep(ptr.x, b.left, b.right);
    if (dx) {
      const before = o.scroller.scrollLeft;
      o.scroller.scrollLeft = before + dx;
      if (o.scroller.scrollLeft !== before) recompute();
    }
    if (dx) raf = win.requestAnimationFrame(tick);
  }

  function onMove(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    ptr = { x: e.clientX, y: e.clientY };
    recompute();
    moveGhost();
    if (state.phase === "dragging" && !raf) raf = win.requestAnimationFrame(tick);
  }

  function onUp(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    const zone = (o.dropZone?.() ?? o.scroller).getBoundingClientRect();
    state = insideDropZone(e.clientX, e.clientY, zone) ? dropDrag(state) : cancelDrag(state);
    finish();
  }

  function onCancel(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    state = cancelDrag(state);
    finish();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    if (state.phase === "dragging") e.preventDefault();
    state = cancelDrag(state);
    finish();
  }

  function abort() {
    state = cancelDrag(state);
    finish();
  }

  function finish() {
    if (finished) return;
    finished = true;
    win.cancelAnimationFrame(raf);
    raf = 0;
    ghost?.remove();
    ghost = null;
    doc.body.classList.remove("dnd-dragging");
    win.removeEventListener("pointermove", onMove);
    win.removeEventListener("pointerup", onUp);
    win.removeEventListener("pointercancel", onCancel);
    win.removeEventListener("keydown", onKey, true);
    win.removeEventListener("blur", abort);
    try {
      if (o.source.hasPointerCapture?.(pointerId)) o.source.releasePointerCapture(pointerId);
    } catch {
      /* the element may already be gone (virtualized pane) */
    }
    o.onSlot(null);
    if (state.phase === "dropped" && state.slot !== null && !isNoopMove(state.from, state.slot)) {
      o.onDrop(state.from, state.slot);
    }
    o.onEnd(becameDrag);
  }

  try {
    o.source.setPointerCapture?.(pointerId);
  } catch {
    /* capture is an optimization; the window listeners are the source of truth */
  }
  win.addEventListener("pointermove", onMove);
  win.addEventListener("pointerup", onUp);
  win.addEventListener("pointercancel", onCancel);
  win.addEventListener("keydown", onKey, true);
  win.addEventListener("blur", abort);

  return { cancel: abort };
}

/**
 * Item boundaries (n+1 values) for a row of elements, in their scroller's content
 * coordinates — the space `insertionSlot` and the indicator both work in.
 */
export function measureEdges(items: readonly HTMLElement[], scroller: HTMLElement): number[] {
  if (items.length === 0) return [];
  const base = scroller.getBoundingClientRect().left - scroller.scrollLeft;
  const edges = items.map((el) => el.getBoundingClientRect().left - base);
  const last = items[items.length - 1].getBoundingClientRect();
  edges.push(last.left - base + last.width);
  return edges;
}
