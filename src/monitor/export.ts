/**
 * Exporting what a Monitor chart shows: CSV of the samples in a time range, and a
 * PNG of the drawn chart. The CSV half is pure (vitest); the PNG half composes the
 * chart's own canvases, so the image is exactly what is on screen.
 */

import type { SeriesBuffer } from "./model";

/** What a chart card hands App for its export menu. */
export type ChartExport = {
  title: string;
  /** The chart's samples over the frozen range, else the visible window. */
  csv: () => string;
  /** Every Overview chart's samples over the same range (filled in by the tab). */
  allCsv?: () => string;
  png: () => Promise<Blob>;
};

/** One exported column: a buffer column and its header. */
export type CsvColumn = { buffer: SeriesBuffer; series: number; label: string };

/** At most this many rows per file (an hour at 1 s is 3,600). */
export const MAX_CSV_ROWS = 100_000;

function csvField(s: string): string {
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A finite number as plain text (no exponent for everyday magnitudes), or empty. */
export function csvNumber(v: number): string {
  if (!Number.isFinite(v)) return "";
  if (Number.isInteger(v)) return String(v);
  const rounded = Number(v.toPrecision(10));
  return Math.abs(rounded) >= 1e-6 || rounded === 0 ? String(rounded) : rounded.toExponential();
}

/**
 * Samples in `[t0, t1]` from every column, one row per distinct sample time (columns
 * from different buffers are joined on time; a column with no sample there is
 * empty). `toWall` maps a buffer time (performance.now() timebase) to epoch ms.
 */
export function chartCsv(columns: CsvColumn[], t0: number, t1: number, toWall: (t: number) => number): string {
  const rows = new Map<number, string[]>();
  columns.forEach((col, c) => {
    const b = col.buffer;
    for (let i = 0; i < b.size; i++) {
      const t = b.time(i);
      if (!(t >= t0 && t <= t1)) continue;
      let row = rows.get(t);
      if (!row) {
        if (rows.size >= MAX_CSV_ROWS) continue;
        row = new Array<string>(columns.length).fill("");
        rows.set(t, row);
      }
      row[c] = csvNumber(b.value(i, col.series));
    }
  });
  const lines = [["time", ...columns.map((c) => c.label)].map(csvField).join(",")];
  for (const t of [...rows.keys()].sort((a, b) => a - b)) {
    // A gap (every column empty) is a skipped tick: keep it, it is part of the record.
    lines.push([new Date(Math.round(toWall(t))).toISOString(), ...rows.get(t)!].join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** Data rows in a `chartCsv` file (lines after the header). */
export function csvSampleCount(csv: string): number {
  let n = 0;
  for (let i = csv.indexOf("\n"); i >= 0; i = csv.indexOf("\n", i + 1)) n++;
  return Math.max(0, n - 1);
}

/** A file-name-safe stem: `monitor-<connection>-<chart>-<yyyymmdd-hhmmss>`. */
export function exportStem(connection: string, chart: string, at: Date): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "chart";
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `monitor-${clean(connection)}-${clean(chart)}-${stamp}`;
}

/** Lowercase hex of a byte array (the IPC form of a PNG; see `write_image_file`). */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

export type PngLegendItem = { label: string; color: string; value: string };

/**
 * Draw a chart card as one PNG: title, the legend as on screen, then each pane's
 * canvas at its device-pixel size. Colours and fonts come from the card's computed
 * style, so the image follows the theme.
 */
export async function composeChartPng(card: HTMLElement, title: string, subtitle: string, legend: PngLegendItem[]): Promise<Blob> {
  const canvases = [...card.querySelectorAll<HTMLCanvasElement>("canvas")].filter((c) => c.width > 0 && c.height > 0);
  if (!canvases.length) throw new Error("The chart has nothing drawn yet");
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const style = getComputedStyle(card);
  const css = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const font = style.fontFamily || "sans-serif";
  const pad = Math.round(12 * dpr);
  const width = Math.max(...canvases.map((c) => c.width)) + pad * 2;
  const titleH = Math.round(22 * dpr);
  const legendH = legend.length ? Math.round(18 * dpr) : 0;
  const gap = Math.round(6 * dpr);
  const height = pad + titleH + legendH + gap + canvases.reduce((a, c) => a + c.height + gap, 0) + pad - gap;
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const g = out.getContext("2d");
  if (!g) throw new Error("Canvas is unavailable");
  g.fillStyle = css("--panel", "#1e1e1e");
  g.fillRect(0, 0, width, height);
  g.textBaseline = "middle";
  g.fillStyle = css("--text", "#ddd");
  g.font = `600 ${Math.round(13 * dpr)}px ${font}`;
  g.fillText(title, pad, pad + titleH / 2);
  if (subtitle) {
    const tw = g.measureText(title).width;
    g.font = `${Math.round(11 * dpr)}px ${font}`;
    g.fillStyle = css("--muted", "#999");
    g.fillText(subtitle, pad + tw + Math.round(10 * dpr), pad + titleH / 2);
  }
  let x = pad;
  const ly = pad + titleH + legendH / 2;
  g.font = `${Math.round(11 * dpr)}px ${font}`;
  for (const item of legend) {
    const sw = Math.round(10 * dpr);
    g.fillStyle = item.color;
    g.fillRect(x, ly - sw / 2, sw, sw);
    x += sw + Math.round(5 * dpr);
    const text = item.value ? `${item.label} ${item.value}` : item.label;
    g.fillStyle = css("--text", "#ddd");
    g.fillText(text, x, ly);
    x += g.measureText(text).width + Math.round(14 * dpr);
    if (x > width - pad) break;
  }
  let y = pad + titleH + legendH + gap;
  for (const c of canvases) {
    g.drawImage(c, pad, y);
    y += c.height + gap;
  }
  return await new Promise<Blob>((resolve, reject) =>
    out.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the image"))), "image/png"),
  );
}
