/**
 * The live layout viewport.
 *
 * Every viewport-dependent size in the app (panel clamps, the editor↔results
 * split, dialog widths) reads this signal instead of calling `window.innerWidth`
 * once at mount. A one-shot read plus a `resize` listener is not enough: the
 * WebView can finish its first layout at the pre-show window bounds and then
 * settle to the configured size without reporting a `resize`, which leaves every
 * measured value stale until the user drags the window.
 *
 * The signal is fed by a `ResizeObserver` on the document element AND the
 * `resize` event, and it is re-read after the first paints. When a settle
 * arrives that the WebView never reported, `resize` is dispatched so listeners
 * outside this module (CodeMirror, the grid, third-party widgets) re-measure too.
 *
 * Module-level on purpose: the app is a single window, and threading a size
 * through every consumer buys nothing. `sizeOf`/`changed` are pure and tested.
 */

import { createSignal } from "solid-js";

export type ViewportSize = { w: number; h: number };

/** Fallbacks for a non-browser environment (tests, SSR). */
const FALLBACK: ViewportSize = { w: 1280, h: 800 };

/** The layout viewport of `win`, preferring the documentElement's client box. */
export function sizeOf(win: (Window & typeof globalThis) | undefined): ViewportSize {
  if (!win) return { ...FALLBACK };
  const el = win.document?.documentElement;
  const w = win.innerWidth || el?.clientWidth || FALLBACK.w;
  const h = win.innerHeight || el?.clientHeight || FALLBACK.h;
  return { w, h };
}

/** Whether two sizes differ. Kept explicit so the signal never notifies on a no-op. */
export function changed(a: ViewportSize, b: ViewportSize): boolean {
  return a.w !== b.w || a.h !== b.h;
}

const browserWindow = typeof window === "undefined" ? undefined : window;

let last = sizeOf(browserWindow);
const [size, setSize] = createSignal<ViewportSize>(last, { equals: (a, b) => !changed(a, b) });

let observing = false;

/**
 * Re-read the viewport. `viaEvent` marks a read that a real `resize` already
 * announced, so the synthetic event is only dispatched for a change the WebView
 * itself never reported.
 */
export function syncViewport(viaEvent = false): void {
  if (!browserWindow) return;
  const next = sizeOf(browserWindow);
  if (!changed(last, next)) return;
  last = next;
  setSize(next);
  if (!viaEvent) browserWindow.dispatchEvent(new Event("resize"));
}

function observe(): void {
  if (observing || !browserWindow) return;
  observing = true;
  browserWindow.addEventListener("resize", () => syncViewport(true));
  browserWindow.addEventListener("orientationchange", () => syncViewport(true));
  if (typeof ResizeObserver !== "undefined" && browserWindow.document?.documentElement) {
    new ResizeObserver(() => syncViewport()).observe(browserWindow.document.documentElement);
  }
  // The first paints are where a pre-show size settles; check both of them.
  browserWindow.requestAnimationFrame?.(() => {
    syncViewport();
    browserWindow.requestAnimationFrame?.(() => syncViewport());
  });
}

/** The live viewport. Reading it registers the observers on first use. */
export function viewport(): ViewportSize {
  observe();
  return size();
}

export const viewportW = (): number => viewport().w;
export const viewportH = (): number => viewport().h;
