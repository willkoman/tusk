import { createEffect, createMemo, on, onCleanup, onMount } from "solid-js";
import { addDrawer, wake } from "./frameLoop";
import {
  CHART_PAD,
  SPARK_PAD,
  minMaxRows,
  niceScale,
  plotRect,
  renderEnd,
  stepMs,
  timeAt,
  timeTickStep,
  timeTicks,
  xOf,
  type Rect,
} from "./layout";
import { EVENT_KINDS, formatCompact, type EventKind, type SeriesBuffer } from "./model";
import type { MonitorSession } from "./session";
import { prefersReducedMotion } from "./visibility";

/**
 * How one column of a ring is drawn. `area`s stack in order (the first at the
 * bottom) when the chart is stacked; `line`s are drawn over them; a `ceiling` is a
 * dashed limit line (max_connections) that only enters the axis once the data is
 * within half of it — otherwise sixteen sessions under a 500 ceiling draw as a
 * flat line at the bottom.
 */
export type SeriesSpec = {
  label: string;
  /** A CSS custom property holding the colour (a design-system token). */
  color: string;
  kind: "area" | "line" | "ceiling";
  dashed?: boolean;
};

const SPARK_WINDOW_MS = 60_000;

/** One colour role per event kind, for markers and the events lane. */
export const EVENT_COLORS: Record<EventKind, string> = {
  checkpoint: "--chart-7",
  "checkpoint-requested": "--warn",
  deadlock: "--danger",
  conflict: "--chart-2",
  "temp-file": "--chart-3",
  reset: "--muted",
};

/** A drag narrower than this many pixels is a click, not a range. */
const SCRUB_MIN_PX = 6;
const GROW_TAU_MS = 70;
const SHRINK_TAU_MS = 120;
const SHRINK_HOLD_MS = 1500;

/**
 * One canvas time-series chart, drawn straight from a ring inside the shared frame
 * loop — no reactive state on the hot path.
 *
 * - Smooth scroll: x maps `now - t` and `now` advances every frame, so the chart
 *   glides instead of stepping per sample (with prefers-reduced-motion it steps).
 * - Decimation past one row per pixel: stacked charts keep each bucket's tallest
 *   row, lines keep each series' min and max (a spike survives), buckets are by
 *   absolute time so nothing shimmers as it scrolls, and gaps always survive.
 * - Stable axes: the maximum eases toward a nice value and shrinks only after a hold.
 * - Colours come from design tokens, re-read when the theme changes.
 * - The crosshair is the session's: hovering any chart moves it on all of them.
 */
export function TimeSeries(props: {
  session: MonitorSession;
  buffer: SeriesBuffer;
  series: readonly SeriesSpec[];
  stacked?: boolean;
  hidden?: () => ReadonlySet<number>;
  format?: (v: number) => string;
  /** Whole-number axis (session counts). */
  integer?: boolean;
  /** Byte values: steps in whole KiB/MiB/GiB. */
  binary?: boolean;
  /** Axis labels, when the legend's format is too wide for the gutter. */
  axisFormat?: (v: number) => string;
  height: number;
  /** A tile sparkline: no axes, a fixed 60 s window, one series filled. */
  spark?: { series: number; color: () => string };
  /** Event kinds drawn as vertical markers over the series (checkpoints on WAL). */
  markers?: readonly EventKind[];
  /** The events lane: one row per event kind, no series and no y axis. */
  lane?: boolean;
  label: string;
}) {
  let canvas!: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null = null;
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let palette: string[] = [];
  let sparkColor = "";
  let gridColor = "";
  let labelColor = "";
  let crossColor = "";
  let panelColor = "";
  let eventPalette: Record<string, string> = {};
  let font = "";
  let yMax = 0;
  let shrinkSince = 0;
  // Scrolled out of view: not drawn at all (an unseen redraw still costs a composite).
  let onScreen = true;
  let lastNow = 0;
  // Geometry of the last paint, for pointer mapping.
  let geo: { r: Rect; tStart: number; windowMs: number } | null = null;
  const fmt = (v: number) => (props.format ?? formatCompact)(v);
  const width = props.buffer.width;
  // Scratch, reused every frame.
  let cum = new Float64Array(0);
  const timeLabels = new Map<number, string>();

  const readTheme = () => {
    if (!canvas) return;
    const cs = getComputedStyle(canvas);
    const token = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    palette = props.series.map((s) => token(s.color, "gray"));
    sparkColor = props.spark ? token(props.spark.color(), "gray") : "";
    gridColor = token("--guide", "rgba(128,128,128,0.2)");
    labelColor = token("--muted", "gray");
    crossColor = token("--text", "gray");
    panelColor = token("--panel", "black");
    eventPalette = Object.fromEntries(EVENT_KINDS.map((k) => [k, token(EVENT_COLORS[k], "gray")]));
    font = `10px ${token("--mono", "monospace")}`;
    wake();
  };

  const resize = (w: number, h: number) => {
    dpr = window.devicePixelRatio || 1;
    cssW = w;
    cssH = h;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    // Resizing the backing store clears it: repaint on the next frame.
    wake();
  };

  const wallLabel = (t: number, wallOffset: number) => {
    const wallMs = Math.round((t + wallOffset) / 1000) * 1000;
    let s = timeLabels.get(wallMs);
    if (s === undefined) {
      s = new Date(wallMs).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
      if (timeLabels.size > 128) timeLabels.clear();
      timeLabels.set(wallMs, s);
    }
    return s;
  };

  const windowMs = () => (props.spark ? SPARK_WINDOW_MS : props.session.windowMs());
  const mode = () => (prefersReducedMotion() ? "step" : "smooth");
  const isHidden = (k: number) => !!props.hidden?.().has(k);

  const draw = (now: number): boolean => {
    if (!ctx || cssW <= 0 || cssH <= 0 || !onScreen) return false;
    if ((window.devicePixelRatio || 1) !== dpr) resize(cssW, cssH);
    const dt = lastNow ? Math.min(100, now - lastNow) : 16;
    lastNow = now;
    const s = props.session;
    const buf = props.buffer;
    const spark = props.spark;
    // A scrubbed range freezes the charts on it; a tile's sparkline stays live.
    const frozenRange = spark ? null : s.range();
    const paused = spark ? s.userPaused() : s.frozen();
    const win = frozenRange ? Math.max(1, frozenRange.t1 - frozenRange.t0) : windowMs();
    const r = plotRect(cssW, cssH, spark ? SPARK_PAD : CHART_PAD);
    const tEnd = frozenRange ? frozenRange.t1 : renderEnd(now, s.data.last, s.intervalMs(), mode(), paused);
    const tStart = tEnd - win;
    geo = { r, tStart, windowMs: win };
    const msPerPx = win / r.w;
    if (props.lane) return drawLane(r, tStart, tEnd, win);

    // ---- choose rows: everything in view, or decimated past ~1 row per pixel ----
    // One row either side of the window so lines run to the edges.
    const i0 = Math.max(0, buf.lowerBound(tStart) - 1);
    const i1 = Math.min(buf.size, buf.lowerBound(tEnd) + 1);
    const areaIdx: number[] = [];
    const lineIdx: number[] = [];
    let ceilingIdx = -1;
    if (spark) lineIdx.push(spark.series);
    else
      props.series.forEach((sp, k) => {
        if (isHidden(k)) return;
        if (sp.kind === "ceiling") ceilingIdx = k;
        else if (sp.kind === "area" && props.stacked) areaIdx.push(k);
        else lineIdx.push(k);
      });
    const decimate = i1 - i0 > r.w * 1.5;
    let areaRows: number[] = [];
    if (areaIdx.length) {
      if (!decimate) areaRows = range(i0, i1);
      else {
        // Each absolute-time bucket keeps its tallest row; a gap row wins so the
        // break survives.
        let bucket = Number.NaN;
        let best = -1;
        let bestTotal = -Infinity;
        for (let i = i0; i < i1; i++) {
          const b = Math.floor(buf.time(i) / msPerPx);
          if (b !== bucket) {
            if (best >= 0) areaRows.push(best);
            bucket = b;
            best = -1;
            bestTotal = -Infinity;
          }
          let total = 0;
          for (const k of areaIdx) total += buf.value(i, k);
          if (total !== total) total = Infinity;
          if (total > bestTotal) {
            bestTotal = total;
            best = i;
          }
        }
        if (best >= 0) areaRows.push(best);
      }
    }
    const lineRows = (k: number) => (decimate ? minMaxRows((i) => buf.time(i), (i) => buf.value(i, k), i0, i1, msPerPx) : range(i0, i1));

    // Cumulative sums for the stack, per chosen row.
    if (cum.length < areaRows.length * width) cum = new Float64Array(areaRows.length * width * 2);
    let peak = 0;
    for (let p = 0; p < areaRows.length; p++) {
      let acc = 0;
      for (const k of areaIdx) {
        acc += buf.value(areaRows[p], k);
        cum[p * width + k] = acc;
      }
      if (acc > peak) peak = acc;
    }
    const lines = lineIdx.map((k) => ({ k, rows: lineRows(k) }));
    for (const { k, rows } of lines) for (const i of rows) {
      const v = buf.value(i, k);
      if (v > peak) peak = v;
    }
    let ceiling = Number.NaN;
    if (ceilingIdx >= 0 && i1 > 0) ceiling = buf.value(i1 - 1, ceilingIdx);
    if (ceiling === ceiling && peak >= ceiling * 0.5) peak = Math.max(peak, ceiling);

    // ---- y axis: ease toward a nice maximum, shrink only after a hold -----------
    const scale = niceScale(peak * 1.05, spark ? 1 : 4, props.integer, props.binary);
    const target = scale.max;
    let animating = false;
    // Sparklines snap: a tiny axis easing on every sample would cost a composite a
    // frame for nothing anyone can see.
    if (spark || prefersReducedMotion() || yMax === 0) yMax = target;
    else if (target > yMax) {
      yMax += (target - yMax) * (1 - Math.exp(-dt / GROW_TAU_MS));
      shrinkSince = 0;
    } else if (target < yMax) {
      if (!shrinkSince) shrinkSince = now;
      if (now - shrinkSince > SHRINK_HOLD_MS) yMax += (target - yMax) * (1 - Math.exp(-dt / SHRINK_TAU_MS));
    } else shrinkSince = 0;
    if (Math.abs(target - yMax) <= target * 0.002) yMax = target;
    else animating = target > yMax || now - shrinkSince > SHRINK_HOLD_MS;
    const yOf = (v: number) => r.yBot - (v / yMax) * r.h;
    const x = (t: number) => xOf(t, tStart, win, r);

    // ---- paint -----------------------------------------------------------------
    const c = ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, cssW, cssH);
    c.lineWidth = 1;
    if (!spark) {
      c.font = font;
      c.strokeStyle = gridColor;
      c.fillStyle = labelColor;
      c.textBaseline = "middle";
      c.textAlign = "right";
      c.beginPath();
      for (let v = 0; v <= yMax * 1.0001; v += scale.step) {
        const y = Math.round(yOf(v)) + 0.5;
        if (y < r.yTop - 0.5) break;
        c.moveTo(r.x0, y);
        c.lineTo(r.x1, y);
        c.fillText((props.axisFormat ?? fmt)(v), r.x0 - 5, y);
      }
      // Vertical gridlines on wall-clock time, so they scroll with the data.
      const wallOffset = Date.now() - performance.now();
      const step = timeTickStep(win, r.w);
      c.textAlign = "center";
      c.textBaseline = "alphabetic";
      for (const t of timeTicks(tStart, tEnd, step, wallOffset)) {
        const xx = Math.round(x(t)) + 0.5;
        c.moveTo(xx, r.yTop);
        c.lineTo(xx, r.yBot);
        if (xx > r.x0 + 26 && xx < r.x1 - 26) c.fillText(wallLabel(t, wallOffset), xx, cssH - 3);
      }
      c.stroke();
    }

    c.save();
    c.beginPath();
    c.rect(r.x0, r.yTop - 1, r.w, r.h + 1);
    c.clip();
    c.lineJoin = "round";

    // Stacked bands: each fills between its own cumulative top and the one beneath,
    // so translucent fills never compound, then a full-colour edge along its top.
    for (let a = 0; a < areaIdx.length; a++) {
      const k = areaIdx[a];
      const below = a > 0 ? areaIdx[a - 1] : -1;
      const top = (p: number) => cum[p * width + k];
      const base = (p: number) => (below < 0 ? 0 : cum[p * width + below]);
      c.fillStyle = palette[k];
      c.strokeStyle = palette[k];
      for (const [from, to] of segments(areaRows.length, (p) => top(p) === top(p))) {
        c.beginPath();
        for (let p = from; p < to; p++) {
          const xx = x(buf.time(areaRows[p]));
          if (p === from) c.moveTo(xx, yOf(top(p)));
          else c.lineTo(xx, yOf(top(p)));
        }
        for (let p = to - 1; p >= from; p--) c.lineTo(x(buf.time(areaRows[p])), yOf(base(p)));
        c.closePath();
        c.globalAlpha = 0.55;
        c.fill();
        c.globalAlpha = 1;
        c.beginPath();
        for (let p = from; p < to; p++) {
          const xx = x(buf.time(areaRows[p]));
          if (p === from) c.moveTo(xx, yOf(top(p)));
          else c.lineTo(xx, yOf(top(p)));
        }
        c.stroke();
      }
    }

    for (const { k, rows } of lines) {
      const color = spark ? sparkColor : palette[k];
      c.strokeStyle = color;
      c.lineWidth = spark ? 1.25 : 1.5;
      c.setLineDash(!spark && props.series[k]?.dashed ? [4, 3] : []);
      for (const [from, to] of segments(rows.length, (p) => buf.value(rows[p], k) === buf.value(rows[p], k))) {
        c.beginPath();
        for (let p = from; p < to; p++) {
          const xx = x(buf.time(rows[p]));
          const yy = yOf(buf.value(rows[p], k));
          if (p === from) c.moveTo(xx, yy);
          else c.lineTo(xx, yy);
        }
        c.stroke();
        if (spark) {
          // A soft fill under the sparkline.
          c.lineTo(x(buf.time(rows[to - 1])), r.yBot);
          c.lineTo(x(buf.time(rows[from])), r.yBot);
          c.closePath();
          c.fillStyle = color;
          c.globalAlpha = 0.16;
          c.fill();
          c.globalAlpha = 1;
        }
      }
    }
    c.setLineDash([]);

    if (ceiling === ceiling && ceiling <= yMax) {
      const y = Math.round(yOf(ceiling)) + 0.5;
      c.strokeStyle = palette[ceilingIdx] ?? labelColor;
      c.setLineDash([5, 4]);
      c.beginPath();
      c.moveTo(r.x0, y);
      c.lineTo(r.x1, y);
      c.stroke();
      c.setLineDash([]);
    }
    if (!spark && props.markers?.length) {
      const kinds = new Set<EventKind>(props.markers);
      for (const ev of s.data.events.between(tStart, tEnd)) {
        if (!kinds.has(ev.kind)) continue;
        const xx = Math.round(x(ev.t)) + 0.5;
        c.strokeStyle = eventPalette[ev.kind];
        c.globalAlpha = 0.5;
        c.setLineDash([2, 3]);
        c.beginPath();
        c.moveTo(xx, r.yTop);
        c.lineTo(xx, r.yBot);
        c.stroke();
        c.setLineDash([]);
        c.globalAlpha = 1;
        c.fillStyle = eventPalette[ev.kind];
        c.beginPath();
        c.moveTo(xx - 4, r.yTop);
        c.lineTo(xx + 4, r.yTop);
        c.lineTo(xx, r.yTop + 5);
        c.closePath();
        c.fill();
      }
    }
    c.restore();

    if (!spark) drawScrub(r, tStart, win);

    // The shared crosshair.
    const hover = s.hoverT();
    if (!spark && hover !== null && hover >= tStart && hover <= tEnd) {
      const xx = Math.round(x(hover)) + 0.5;
      c.strokeStyle = crossColor;
      c.globalAlpha = 0.45;
      c.beginPath();
      c.moveTo(xx, r.yTop);
      c.lineTo(xx, r.yBot);
      c.stroke();
      c.globalAlpha = 1;
      const label = wallLabel(hover, Date.now() - performance.now());
      c.font = font;
      const w = c.measureText(label).width + 8;
      const lx = Math.min(Math.max(xx - w / 2, r.x0), r.x1 - w);
      c.fillStyle = panelColor;
      c.fillRect(lx, r.yTop, w, 13);
      c.fillStyle = crossColor;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(label, lx + w / 2, r.yTop + 7);
    }
    return animating;
  };

  /** The drag selection in progress, shaded on every chart. */
  const drawScrub = (r: Rect, tStart: number, win: number) => {
    const sc = props.session.scrub();
    if (!sc || !ctx) return;
    const a = Math.max(r.x0, Math.min(r.x1, xOf(Math.min(sc.a, sc.b), tStart, win, r)));
    const b = Math.max(r.x0, Math.min(r.x1, xOf(Math.max(sc.a, sc.b), tStart, win, r)));
    ctx.fillStyle = crossColor;
    ctx.globalAlpha = 0.12;
    ctx.fillRect(a, r.yTop, Math.max(1, b - a), r.h);
    ctx.globalAlpha = 0.6;
    ctx.fillRect(a, r.yTop, 1, r.h);
    ctx.fillRect(b, r.yTop, 1, r.h);
    ctx.globalAlpha = 1;
  };

  /** The events lane: a row per kind, a mark per interval it happened in. */
  const drawLane = (r: Rect, tStart: number, tEnd: number, win: number): boolean => {
    const c = ctx!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, cssW, cssH);
    const rows = EVENT_KINDS.length;
    // Rows follow EVENT_KINDS; the legend under the lane names them.
    const rowH = r.h / rows;
    c.lineWidth = 1;
    for (let k = 0; k < rows; k++) {
      const y = Math.round(r.yTop + rowH * (k + 1)) + 0.5;
      c.strokeStyle = gridColor;
      c.beginPath();
      c.moveTo(r.x0, y);
      c.lineTo(r.x1, y);
      c.stroke();
    }
    for (const ev of props.session.data.events.between(tStart, tEnd)) {
      const k = EVENT_KINDS.indexOf(ev.kind);
      const xx = xOf(ev.t, tStart, win, r);
      const radius = Math.min(rowH / 2 - 1, 2.5 + Math.log2(ev.count));
      c.fillStyle = eventPalette[ev.kind];
      c.beginPath();
      c.arc(xx, r.yTop + rowH * (k + 0.5), Math.max(2, radius), 0, Math.PI * 2);
      c.fill();
    }
    drawScrub(r, tStart, win);
    const hover = props.session.hoverT();
    if (hover !== null && hover >= tStart && hover <= tEnd) {
      const xx = Math.round(xOf(hover, tStart, win, r)) + 0.5;
      c.strokeStyle = crossColor;
      c.globalAlpha = 0.45;
      c.beginPath();
      c.moveTo(xx, r.yTop);
      c.lineTo(xx, r.yBot);
      c.stroke();
      c.globalAlpha = 1;
    }
    return false;
  };

  const drawer = {
    draw,
    stepMs: () => {
      const s = props.session;
      const paused = props.spark ? s.userPaused() : s.frozen();
      if (!onScreen || paused || prefersReducedMotion() || !geo) return Infinity;
      return stepMs(windowMs(), geo.r.w);
    },
  };

  /** The time under the pointer, clamped to the plot (a drag may leave it). */
  const pointerTime = (e: PointerEvent, clamp: boolean): number | null => {
    if (!geo) return null;
    const rect = canvas.getBoundingClientRect();
    let x = e.clientX - rect.left;
    if (clamp) x = Math.max(geo.r.x0, Math.min(geo.r.x1, x));
    return timeAt(x, geo.tStart, geo.windowMs, geo.r);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (props.spark || !geo) return;
    const dragging = props.session.scrub() !== null;
    const t = pointerTime(e, dragging);
    if (dragging && t !== null) props.session.moveScrub(t);
    props.session.setHover(t);
  };
  const onPointerLeave = () => {
    if (!props.spark && props.session.scrub() === null) props.session.setHover(null);
  };
  // Drag across any chart to freeze every chart on that range.
  const onPointerDown = (e: PointerEvent) => {
    if (props.spark || e.button !== 0 || !geo) return;
    const t = pointerTime(e, false);
    if (t === null) return;
    canvas.setPointerCapture(e.pointerId);
    props.session.beginScrub(t);
  };
  const onPointerUp = (e: PointerEvent) => {
    if (props.spark || props.session.scrub() === null || !geo) return;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    props.session.endScrub((geo.windowMs / geo.r.w) * SCRUB_MIN_PX);
  };

  // A tile's tone (amber/red) changes its sparkline colour. Memoized: the tone is
  // recomputed every sample, and re-reading the theme (a style recalc plus a full
  // redraw) each time cost more than all the scrolling together.
  const sparkToken = createMemo(() => props.spark?.color());
  createEffect(on(sparkToken, () => readTheme(), { defer: true }));

  onMount(() => {
    ctx = canvas.getContext("2d");
    readTheme();
    const rect = canvas.getBoundingClientRect();
    resize(rect.width, rect.height);
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) resize(r.width, r.height);
    });
    ro.observe(canvas);
    const io = new IntersectionObserver((entries) => {
      const seen = entries[entries.length - 1]?.isIntersecting ?? true;
      if (seen === onScreen) return;
      onScreen = seen;
      if (seen) wake();
    });
    io.observe(canvas);
    // Theme switches rewrite attributes on <html>; the accent is inline style there.
    const mo = new MutationObserver(readTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-mode", "style", "class"] });
    const off = addDrawer(drawer);
    onCleanup(() => {
      off();
      ro.disconnect();
      io.disconnect();
      mo.disconnect();
    });
  });

  return (
    <canvas
      ref={canvas}
      class="monitor-canvas"
      classList={{ spark: !!props.spark }}
      style={{ height: `${props.height}px` }}
      role="img"
      aria-label={props.label}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}

function range(from: number, to: number): number[] {
  const out = new Array<number>(Math.max(0, to - from));
  for (let i = from; i < to; i++) out[i - from] = i;
  return out;
}

/** Runs of consecutive indices [from, to) where `ok` holds — drawn as separate paths. */
function segments(n: number, ok: (p: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let p = 0; p < n; p++) {
    if (ok(p)) {
      if (start < 0) start = p;
    } else if (start >= 0) {
      out.push([start, p]);
      start = -1;
    }
  }
  if (start >= 0) out.push([start, n]);
  return out;
}
