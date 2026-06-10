import { type JSX, onCleanup, onMount } from "solid-js";
import { createPanZoom, type BBox, type PanZoom } from "./panzoom";

// Shared pan/zoom shell: a clipping viewport with a transformed inner canvas —
// one absolutely-positioned SVG (edges, sized to the content bbox) underneath
// absolutely-positioned HTML cards (crisp text at any zoom; theme CSS vars
// apply naturally). The wheel listener is attached manually with
// `{passive:false}` so preventDefault actually stops page scroll in WebView2.

export function PanZoomCanvas(props: {
  /** Content bounding box — drives fit + the SVG layer size. */
  bbox: BBox;
  /** Re-fit when this key changes (new plan / new graph / scope switch). */
  fitKey: string;
  children: JSX.Element;
  /** Exposes the pan/zoom instance (for external fit/zoom buttons if needed). */
  ref?: (pz: PanZoom) => void;
}) {
  const pz = createPanZoom();
  let viewport: HTMLDivElement | undefined;
  let lastFitKey: string | undefined;
  props.ref?.(pz);

  const doFit = () => {
    if (viewport) pz.fit(props.bbox, viewport.clientWidth, viewport.clientHeight);
  };

  onMount(() => {
    const onWheel = (e: WheelEvent) => pz.onWheel(e);
    viewport!.addEventListener("wheel", onWheel, { passive: false });
    onCleanup(() => viewport?.removeEventListener("wheel", onWheel));
    doFit();
    lastFitKey = props.fitKey;
  });

  // Re-fit on a genuinely new content key (not on every bbox tweak — collapse
  // keeps the user's viewport).
  const maybeFit = () => {
    if (props.fitKey !== lastFitKey) {
      lastFitKey = props.fitKey;
      queueMicrotask(doFit);
    }
    return props.fitKey;
  };

  return (
    <div
      class="viz-viewport"
      ref={viewport}
      data-fit={maybeFit()}
      onPointerDown={pz.onPointerDown}
      onPointerMove={pz.onPointerMove}
      onPointerUp={pz.onPointerUp}
      onDblClick={doFit}
      classList={{ dragging: pz.dragging() }}
    >
      <div
        class="viz-canvas"
        style={{
          transform: `translate(${pz.transform().x}px, ${pz.transform().y}px) scale(${pz.transform().k})`,
        }}
      >
        {props.children}
      </div>
      <div class="viz-toolbar" onPointerDown={(e) => e.stopPropagation()}>
        <button class="icon" title="Fit (double-click background)" onClick={doFit}>⊡</button>
        <button class="icon" title="Zoom in" onClick={() => viewport && pz.zoomBy(1.25, viewport.clientWidth / 2, viewport.clientHeight / 2)}>＋</button>
        <button class="icon" title="Zoom out" onClick={() => viewport && pz.zoomBy(0.8, viewport.clientWidth / 2, viewport.clientHeight / 2)}>－</button>
      </div>
    </div>
  );
}
