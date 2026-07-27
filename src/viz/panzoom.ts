import { createSignal, type Accessor } from "solid-js";

// Shared pan/zoom state for SVG+HTML canvases (plan tree, relationship graphs).
// Transform lives in LOCAL signals only — never per-frame writes into tab/app
// state (the ResultGrid scroll rule). Pointer Events + setPointerCapture work in
// both WKWebView and WebView2; the wheel listener must be attached non-passive.

export type Transform = { x: number; y: number; k: number };
export type BBox = { x: number; y: number; w: number; h: number };

const MIN_K = 0.15;
const MAX_K = 3;

export type PanZoom = {
  transform: Accessor<Transform>;
  /** Attach to the viewport element (wheel must be non-passive — use ref + addEventListener). */
  onWheel: (e: WheelEvent) => void;
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  /** Scale-to-fit a content bbox inside a viewport size (with padding). */
  fit: (bbox: BBox, vw: number, vh: number) => void;
  zoomBy: (factor: number, cx: number, cy: number) => void;
  reset: () => void;
  dragging: Accessor<boolean>;
};

export function createPanZoom(): PanZoom {
  const [transform, setTransform] = createSignal<Transform>({ x: 0, y: 0, k: 1 });
  const [dragging, setDragging] = createSignal(false);
  let panStart: { px: number; py: number; x: number; y: number } | null = null;

  const zoomBy = (factor: number, cx: number, cy: number) => {
    if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(cx) || !Number.isFinite(cy)) return;
    setTransform((t) => {
      const k = Math.min(MAX_K, Math.max(MIN_K, t.k * factor));
      if (k === t.k) return t;
      // Keep the point under the cursor stationary.
      const x = cx - ((cx - t.x) * k) / t.k;
      const y = cy - ((cy - t.y) * k) / t.k;
      return { x, y, k };
    });
  };

  return {
    transform,
    dragging,
    zoomBy,
    onWheel: (e: WheelEvent) => {
      e.preventDefault();
      if (!Number.isFinite(e.deltaY) || !Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    },
    onPointerDown: (e: PointerEvent) => {
      if (e.button !== 0 || !Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
      const t = transform();
      panStart = { px: e.clientX, py: e.clientY, x: t.x, y: t.y };
      setDragging(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: PointerEvent) => {
      if (!panStart || !Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
      const s = panStart;
      setTransform((t) => ({ ...t, x: s.x + (e.clientX - s.px), y: s.y + (e.clientY - s.py) }));
    },
    onPointerUp: (e: PointerEvent) => {
      panStart = null;
      setDragging(false);
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    },
    fit: (bbox: BBox, vw: number, vh: number) => {
      const pad = 32;
      if (
        !Number.isFinite(bbox.x) || !Number.isFinite(bbox.y) || !Number.isFinite(bbox.w) || !Number.isFinite(bbox.h) ||
        !Number.isFinite(vw) || !Number.isFinite(vh) || bbox.w <= 0 || bbox.h <= 0 || vw <= 0 || vh <= 0
      ) {
        setTransform({ x: pad, y: pad, k: 1 });
        return;
      }
      const k = Math.min(MAX_K, Math.max(MIN_K, Math.min((vw - pad * 2) / bbox.w, (vh - pad * 2) / bbox.h, 1)));
      setTransform({
        x: (vw - bbox.w * k) / 2 - bbox.x * k,
        y: (vh - bbox.h * k) / 2 - bbox.y * k,
        k,
      });
    },
    reset: () => setTransform({ x: 0, y: 0, k: 1 }),
  };
}
