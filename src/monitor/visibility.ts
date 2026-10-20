/**
 * Is anybody looking? The monitor pauses its sampler (and its drawing) when not.
 *
 * Two signals, because one is not enough under Tauri: the spike found that WebView2
 * keeps `document.visibilityState === "visible"` while the window is minimized, so
 * the window's own minimized state is read too (`onResized` + `isMinimized()`).
 * Whether the Monitor tab itself is the active tab is the third input; App owns that.
 */

import { createSignal } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { setSuspended } from "./frameLoop";

const [minimized, setMinimized] = createSignal(false);
const [pageHidden, setPageHidden] = createSignal(typeof document !== "undefined" && document.visibilityState !== "visible");
const motionQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
const [reducedMotion, setReducedMotion] = createSignal(!!motionQuery?.matches);

/** The window is shown and the page visible. */
export const appVisible = () => !minimized() && !pageHidden();
/** Charts step once per sample instead of gliding. */
export const prefersReducedMotion = reducedMotion;

/**
 * Start watching. Returns the cleanup. Safe outside Tauri (the window events are
 * simply unavailable and the page-visibility half still works).
 */
export function watchAppVisibility(): () => void {
  let alive = true;
  let unlistenResize: (() => void) | null = null;
  const onVisibility = () => setPageHidden(document.visibilityState !== "visible");
  const onMotion = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
  document.addEventListener("visibilitychange", onVisibility);
  motionQuery?.addEventListener?.("change", onMotion);
  void (async () => {
    try {
      const win = getCurrentWindow();
      const check = () =>
        void win
          .isMinimized()
          .then((m) => {
            if (!alive) return;
            setMinimized(m);
            setSuspended(m);
          })
          .catch(() => {});
      const un = await win.onResized(check);
      if (!alive) un();
      else unlistenResize = un;
      check();
    } catch {
      /* not under Tauri */
    }
  })();
  return () => {
    alive = false;
    document.removeEventListener("visibilitychange", onVisibility);
    motionQuery?.removeEventListener?.("change", onMotion);
    unlistenResize?.();
    setSuspended(false);
  };
}
