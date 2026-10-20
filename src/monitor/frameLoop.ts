/**
 * The ONE animation clock every monitor canvas draws from.
 *
 * The phase-0 spike measured where the CPU goes: not into drawing (well under a
 * millisecond a frame) but into WebView2 compositing each redraw, about 0.3% of a
 * core per redraw a second. Two findings shape this loop:
 *
 * 1. Pace by distance scrolled, not by vsync. Each canvas says how many ms its
 *    scroll needs to move two pixels (`stepMs`); the loop sleeps on a timer until the
 *    soonest of them and draws then. A 1-minute window redraws ~6 times a second,
 *    a 1-hour window barely at all.
 * 2. Draw everything on one schedule. Charts that drift a few ms apart cost a
 *    composite each, so a frame draws every canvas that is due within `MERGE_MS` of
 *    it: the charts (same window, same width, same step) always land together, and
 *    a tile's sparkline, whose own step is longer, rides along on whichever chart
 *    frame comes nearest instead of costing a composite of its own. A canvas that
 *    is not due is left alone — redrawing an unchanged canvas still costs its layer.
 *
 * A drawer returns true while it is animating (an easing axis), which asks for a
 * frame every `EASE_FRAME_MS` until it settles. `wake()` draws everything promptly
 * (resize, theme, hover, data while nothing scrolls). The loop runs only while something is registered, the page is
 * visible and the window is not minimized (`setSuspended`: WebView2 reports a
 * minimized window as visible and keeps its timers running).
 */

export type Drawer = {
  /** Paint at `now` (performance.now); return true while easing (drawn again soon). */
  draw: (now: number) => boolean;
  /** How long until this canvas next needs a frame on its own (Infinity = only on wake). */
  stepMs: () => number;
};

/** Each registered canvas and when it is next due (performance.now; Infinity = idle). */
const drawers = new Map<Drawer, number>();
let raf = 0;
let timer: ReturnType<typeof setTimeout> | 0 = 0;
let dirty = false;
let suspended = false;

/**
 * An easing axis animates at this frame spacing, not every vsync: a 250 ms ease is
 * then ~6 composites instead of 15, and still reads as motion.
 */
const EASE_FRAME_MS = 40;
/** A canvas due within this long of a frame draws in it (see 2. above). */
const MERGE_MS = 150;

const STATS_CAPACITY = 4096;
const durations = new Float64Array(STATS_CAPACITY);
const stamps = new Float64Array(STATS_CAPACITY);
let recorded = 0;

const pageHidden = () => typeof document !== "undefined" && document.visibilityState !== "visible";
const halted = () => suspended || pageHidden();

function frame(now: number) {
  raf = 0;
  const start = performance.now();
  const forced = dirty;
  dirty = false;
  let drew = false;
  for (const [d, at] of drawers) {
    if (!forced && at > now + MERGE_MS) continue;
    const easing = d.draw(now);
    drawers.set(d, now + (easing ? EASE_FRAME_MS : Math.max(0, d.stepMs())));
    drew = true;
  }
  if (drew) {
    durations[recorded % STATS_CAPACITY] = performance.now() - start;
    stamps[recorded % STATS_CAPACITY] = now;
    recorded++;
  }
  schedule();
}

function schedule() {
  if (raf || timer || drawers.size === 0 || halted()) return;
  if (dirty) {
    raf = requestAnimationFrame(frame);
    return;
  }
  let next = Infinity;
  for (const at of drawers.values()) next = Math.min(next, at);
  if (!Number.isFinite(next)) return; // idle until woken
  const wait = next - performance.now();
  if (wait <= 12) raf = requestAnimationFrame(frame);
  else
    timer = setTimeout(() => {
      timer = 0;
      // Land on a vsync, not mid-frame.
      if (!halted() && drawers.size) raf = requestAnimationFrame(frame);
    }, wait - 8);
}

function stop() {
  if (raf) cancelAnimationFrame(raf);
  if (timer) clearTimeout(timer);
  raf = 0;
  timer = 0;
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (halted()) stop();
    else wake();
  });
}

/** Pause or resume all drawing for a reason the page cannot see (a minimized window). */
export function setSuspended(on: boolean): void {
  if (on === suspended) return;
  suspended = on;
  if (on) stop();
  else wake();
}

/** Register a canvas; returns the unregister. */
export function addDrawer(d: Drawer): () => void {
  drawers.set(d, 0);
  wake();
  return () => {
    drawers.delete(d);
    if (drawers.size === 0) stop();
  };
}

/** Draw every canvas on the next vsync. */
export function wake(): void {
  dirty = true;
  if (timer) {
    clearTimeout(timer);
    timer = 0;
  }
  schedule();
}

export type FrameStats = { frames: number; perSecond: number; mean: number; p50: number; p95: number; p99: number; max: number };

/** Script time per drawing frame (ms, all canvases together) and redraws per second. */
export function frameStats(): FrameStats {
  const n = Math.min(recorded, STATS_CAPACITY);
  if (n === 0) return { frames: 0, perSecond: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = Array.from(durations.subarray(0, n)).sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(n - 1, Math.floor(q * n))];
  const newest = stamps[(recorded - 1) % STATS_CAPACITY];
  const oldest = stamps[recorded > STATS_CAPACITY ? recorded % STATS_CAPACITY : 0];
  const span = (newest - oldest) / 1000;
  return {
    frames: recorded,
    perSecond: span > 0 ? (n - 1) / span : 0,
    mean: sorted.reduce((a, b) => a + b, 0) / n,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    max: sorted[n - 1],
  };
}

export function resetFrameStats(): void {
  recorded = 0;
}

// Measurement hook for the live smoke (docs/db-monitor-plan.md §8): read-only stats,
// no switches that change behaviour.
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__tuskMonitorFrames = { stats: frameStats, reset: resetFrameStats };
}
