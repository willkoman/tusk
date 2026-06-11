import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, on } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "../Dialog";
import { Icon } from "../Icons";
import { highlightSql } from "../ai/sqlHighlight";
import { PanZoomCanvas } from "../viz/PanZoomCanvas";
import { type PanZoom } from "../viz/panzoom";
import { layoutErd, type ErdNode } from "./erdLayout";

// "DDL & relationships" viewer (explorer right-click): left = reconstructed
// CREATE DDL (highlighted, copy / open-in-editor); right = FK graph in two
// scopes — 1-hop neighborhood (column-level edge labels, click to re-center)
// and a whole-schema ERD (deterministic layered layout, click → neighborhood).
// Read-only; all data via object_ddl / table_relationships /
// schema_relationships (best-effort per driver — empty results render an
// honest empty state, errors render a calm note).

export type FkEdge = {
  constraint: string;
  srcSchema: string;
  srcTable: string;
  srcCols: string[];
  dstSchema: string;
  dstTable: string;
  dstCols: string[];
};
type Relationships = { outbound: FkEdge[]; inbound: FkEdge[] };
type ErdColumn = { name: string; dataType: string; isPk: boolean; isFk: boolean };
type ErdTable = { schema: string; name: string; columns: ErdColumn[] };
type SchemaGraph = { tables: ErdTable[]; edges: FkEdge[] };
type DetailCol = { name: string; data_type: string; is_pk: boolean; is_fk: boolean };

const errMsg = (e: unknown): string =>
  e instanceof Object && "message" in e ? String((e as { message: unknown }).message) : String(e);

// Deterministic per-table hue (14 well-spaced steps — collisions possible on
// big schemas but adjacent hubs almost never collide). Edges take the color of
// the table they POINT AT, so every bundle converging on a hub reads as one
// stream; the matching chip sits on that table's card header.
const HUES = [210, 12, 130, 268, 35, 175, 322, 56, 232, 95, 290, 152, 20, 200];
function tableHue(name: string): number {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  return HUES[Math.abs(h) % HUES.length];
}
const edgeColor = (name: string) => `hsl(${tableHue(name)}, 60%, 52%)`;

/** Spread same-anchor edges by a few px so parallel lines never coincide. */
const fanOffset = (idx: number, count: number, step = 8, max = 28) =>
  count <= 1 ? 0 : Math.max(-max, Math.min(max, (idx - (count - 1) / 2) * step));

// ---- neighborhood geometry ----
const NB_W = 200; // neighbor card
const NB_H = 44;
const CTR_W = 250; // center card
const COL_ROW_H = 19;
const CTR_HEAD = 34;
const GAP_Y = 22;
const COL_X = 330; // horizontal distance between columns
const MAX_COLS = 14;

// ---- ERD geometry (must match the .erd-card CSS metrics) ----
const ERD_W = 240;
const ERD_HEAD = 32;
const ERD_ROW = 19;
const ERD_MAX_ROWS = 12;
const erdCardH = (t: ErdTable) => {
  const keys = t.columns.filter((c) => c.isPk || c.isFk);
  const rows = Math.min(keys.length, ERD_MAX_ROWS);
  const more = keys.length > ERD_MAX_ROWS || keys.length === 0 ? 1 : 0;
  return ERD_HEAD + (rows + more) * ERD_ROW + 8;
};

export function DdlGraphDialog(props: {
  connectionId: string;
  schema: string;
  /** null = opened from a schema node — straight into the whole-schema ERD. */
  name: string | null;
  kind: string; // table | view | matview
  onOpenSql: (sql: string) => void;
  onCopy: (text: string, note: string) => void;
  onClose: () => void;
}) {
  // Re-centerable focus (click a neighbor) — starts at the invoked relation,
  // or unset when opened on a schema (pick a card to drill in).
  const [center, setCenter] = createSignal<{ schema: string; name: string | null; kind: string }>({
    schema: props.schema,
    name: props.name,
    kind: props.kind,
  });
  const [scope, setScopeRaw] = createSignal<"neighborhood" | "schema">(props.name ? "neighborhood" : "schema");
  // The DDL pane is too narrow to be useful while the full-width ERD is up —
  // it auto-collapses entering schema scope (and expands back in neighborhood);
  // the rail/chevron overrides either way.
  const [ddlCollapsed, setDdlCollapsed] = createSignal(!props.name);
  const setScope = (s: "neighborhood" | "schema") => {
    setScopeRaw(s);
    setDdlCollapsed(s === "schema");
  };
  const [hoverEdge, setHoverEdge] = createSignal<string | null>(null);
  // Hovering a card lights up only its edges (everything else dims).
  const [hoverTable, setHoverTable] = createSignal<string | null>(null);

  const centered = () => (center().name ? center() : null); // table-scoped resources skip schema-only mode
  const [ddl] = createResource(centered, async (c) => {
    try {
      return { ok: await invoke<string>("object_ddl", { connectionId: props.connectionId, kind: c.kind, schema: c.schema, name: c.name }) };
    } catch (e) {
      return { err: errMsg(e) };
    }
  });
  const [rels] = createResource(centered, async (c) => {
    try {
      return await invoke<Relationships>("table_relationships", { connectionId: props.connectionId, schema: c.schema, name: c.name });
    } catch {
      return { outbound: [], inbound: [] } as Relationships;
    }
  });
  const [detail] = createResource(centered, async (c) => {
    try {
      const d = await invoke<{ columns: DetailCol[] }>("table_detail", { connectionId: props.connectionId, schema: c.schema, name: c.name });
      return d.columns;
    } catch {
      return [] as DetailCol[];
    }
  });
  const [erd] = createResource(
    () => (scope() === "schema" ? center().schema : null),
    async (schema) => {
      try {
        return await invoke<SchemaGraph>("schema_relationships", { connectionId: props.connectionId, schema });
      } catch (e) {
        return { tables: [], edges: [], err: errMsg(e) } as SchemaGraph & { err?: string };
      }
    },
  );

  const recenter = (schema: string, name: string) => {
    setScope("neighborhood");
    setCenter({ schema, name, kind: "table" });
  };

  // ---- neighborhood layout (deterministic 3-column) ----
  const hood = createMemo(() => {
    const r = rels();
    const cols = (detail() ?? []).slice(0, MAX_COLS);
    if (!r) return null;
    const self = (e: FkEdge) => e.srcTable === center().name && e.dstTable === center().name && e.srcSchema === e.dstSchema;
    const inbound = r.inbound.filter((e) => !self(e));
    const outbound = r.outbound.filter((e) => !self(e));
    const selfRefs = r.outbound.filter(self);
    const ctrH = CTR_HEAD + Math.max(1, cols.length + ((detail()?.length ?? 0) > MAX_COLS ? 1 : 0)) * COL_ROW_H + 8;
    const colH = (n: number) => n * NB_H + Math.max(0, n - 1) * GAP_Y;
    const totalH = Math.max(ctrH, colH(inbound.length), colH(outbound.length), NB_H);
    const stack = (n: number, i: number) => (totalH - colH(n)) / 2 + i * (NB_H + GAP_Y);
    // Fan indices: inbound edges sharing the same target column (usually the
    // PK) spread apart instead of entering at one point; same for outbound
    // edges leaving the same source column.
    const groupIdx = (list: FkEdge[], colOf: (e: FkEdge) => string) => {
      const groups = new Map<string, number>();
      const counts = new Map<string, number>();
      for (const e of list) counts.set(colOf(e), (counts.get(colOf(e)) ?? 0) + 1);
      return list.map((e) => {
        const k = colOf(e);
        const i = groups.get(k) ?? 0;
        groups.set(k, i + 1);
        return { fi: i, fn: counts.get(k)! };
      });
    };
    const inFan = groupIdx(inbound, (e) => e.dstCols[0] ?? "");
    const outFan = groupIdx(outbound, (e) => e.srcCols[0] ?? "");
    const inPos = inbound.map((e, i) => ({ e, x: 0, y: stack(inbound.length, i), ...inFan[i] }));
    const outPos = outbound.map((e, i) => ({ e, x: COL_X * 2, y: stack(outbound.length, i), ...outFan[i] }));
    const ctr = { x: COL_X, y: (totalH - ctrH) / 2, h: ctrH };
    const colY = (col: string) => {
      const i = cols.findIndex((c) => c.name === col);
      return i >= 0 ? ctr.y + CTR_HEAD + i * COL_ROW_H + COL_ROW_H / 2 : ctr.y + ctrH / 2;
    };
    return {
      inbound: inPos,
      outbound: outPos,
      selfRefs,
      ctr,
      cols,
      moreCols: Math.max(0, (detail()?.length ?? 0) - MAX_COLS),
      colY,
      bbox: { x: 0, y: 0, w: COL_X * 2 + NB_W, h: totalH },
    };
  });

  // ---- ERD layout ----
  const erdLayoutMemo = createMemo(() => {
    const g = erd();
    if (!g || !g.tables.length) return null;
    const nodes: ErdNode[] = g.tables.map((t) => ({ id: t.name, w: ERD_W, h: erdCardH(t) }));
    const l = layoutErd(nodes, g.edges.map((e) => ({ from: e.srcTable, to: e.dstTable })));
    return { ...l, graph: g };
  });

  // ---- ERD manual drag: click = drill in, click-DRAG = reposition (pinned
  // until moved again; cleared when the schema graph reloads). Dragging a
  // group's label strip moves the container AND every member table. Deltas
  // live on top of the computed layout, in canvas units (screen ÷ zoom k).
  const [nudges, setNudges] = createSignal<Map<string, { x: number; y: number }>>(new Map(), { equals: false });
  const [groupNudges, setGroupNudges] = createSignal<Map<number, { x: number; y: number }>>(new Map(), { equals: false });
  let erdPz: PanZoom | undefined;
  let dragRef: { kind: "table" | "group"; id: string; gi: number; members: string[]; startX: number; startY: number; lastX: number; lastY: number; moved: boolean } | null = null;

  createEffect(on(erd, () => {
    setNudges(new Map());
    setGroupNudges(new Map());
  }));

  const nudgeOf = (name: string) => nudges().get(name) ?? { x: 0, y: 0 };
  const epos = (l: { pos: Map<string, { x: number; y: number }> }, name: string) => {
    const p = l.pos.get(name);
    if (!p) return undefined;
    const n = nudgeOf(name);
    return { x: p.x + n.x, y: p.y + n.y };
  };

  const beginDrag = (e: PointerEvent, kind: "table" | "group", id: string, gi: number, members: string[]) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragRef = { kind, id, gi, members, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: PointerEvent) => {
    const d = dragRef;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return; // click tolerance
    d.moved = true;
    const k = erdPz?.transform().k ?? 1;
    const dx = (e.clientX - d.lastX) / k;
    const dy = (e.clientY - d.lastY) / k;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    const bump = <K,>(m: Map<K, { x: number; y: number }>, key: K) => {
      const c = m.get(key) ?? { x: 0, y: 0 };
      m.set(key, { x: c.x + dx, y: c.y + dy });
      return m;
    };
    if (d.kind === "group") {
      setGroupNudges((m) => bump(m, d.gi));
      setNudges((m) => {
        for (const member of d.members) bump(m, member);
        return m;
      });
    } else {
      setNudges((m) => bump(m, d.id));
    }
  };
  const endDrag = (e: PointerEvent, onClick?: () => void) => {
    const d = dragRef;
    dragRef = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (d && !d.moved) onClick?.(); // a true click, not a drag
  };

  // O(1) lookups for the render hot paths (93 tables × 100+ edges re-render on
  // every hover/drag frame — no linear scans inside <For> bodies).
  const erdTableByName = createMemo(() => new Map((erd()?.tables ?? []).map((t) => [t.name, t])));
  const erdAdj = createMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string) => (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b);
    for (const e of erd()?.edges ?? []) {
      add(e.srcTable, e.dstTable);
      add(e.dstTable, e.srcTable);
    }
    return m;
  });

  // Ubiquitous hubs: a table targeted by ≥35% of all edges (audit-style
  // created_by/updated_by FKs) would bury the diagram — its edges render
  // faint/thin by default and light up only on hover.
  const dampedHubs = createMemo(() => {
    const g = erd();
    if (!g) return new Set<string>();
    const inDeg = new Map<string, number>();
    for (const e of g.edges) inDeg.set(e.dstTable, (inDeg.get(e.dstTable) ?? 0) + 1);
    const threshold = Math.max(8, Math.ceil(g.tables.length * 0.35));
    return new Set([...inDeg].filter(([, n]) => n >= threshold).map(([t]) => t));
  });

  // Per-edge fan indices: edges sharing an anchor point (same destination PK
  // row, or same source column) get spread by a few px so they never coincide.
  const edgeKey = (e: FkEdge) => `${e.constraint}:${e.srcTable}`;
  const erdFan = createMemo(() => {
    const g = erd();
    const out = new Map<string, { si: number; sn: number; di: number; dn: number }>();
    if (!g) return out;
    // Two passes with counters — O(E), no per-edge indexOf.
    const dstCount = new Map<string, number>();
    const srcCount = new Map<string, number>();
    for (const e of g.edges) {
      dstCount.set(e.dstTable, (dstCount.get(e.dstTable) ?? 0) + 1);
      const sk = `${e.srcTable}:${e.srcCols[0] ?? ""}`;
      srcCount.set(sk, (srcCount.get(sk) ?? 0) + 1);
    }
    const dstSeen = new Map<string, number>();
    const srcSeen = new Map<string, number>();
    for (const e of g.edges) {
      const sk = `${e.srcTable}:${e.srcCols[0] ?? ""}`;
      const di = dstSeen.get(e.dstTable) ?? 0;
      const si = srcSeen.get(sk) ?? 0;
      dstSeen.set(e.dstTable, di + 1);
      srcSeen.set(sk, si + 1);
      out.set(edgeKey(e), { si, sn: srcCount.get(sk)!, di, dn: dstCount.get(e.dstTable)! });
    }
    return out;
  });
  const erdRowY = (t: ErdTable, col: string, topY: number): number => {
    const keys = t.columns.filter((c) => c.isPk || c.isFk).slice(0, ERD_MAX_ROWS);
    const i = keys.findIndex((c) => c.name === col);
    return i >= 0 ? topY + ERD_HEAD + i * ERD_ROW + ERD_ROW / 2 : topY + erdCardH(t) / 2;
  };

  const edgeLabel = (e: FkEdge) => `${e.srcCols.join(", ")} → ${e.dstCols.join(", ")}`;

  return (
    <Dialog
      title={center().name ? `DDL & relationships — ${center().schema}.${center().name}` : `Schema diagram — ${center().schema}`}
      width={Math.min(window.innerWidth - 64, 1280)}
      class="modal-tall"
      onClose={props.onClose}
    >
      <div class="relviz-body">
        <div class="relviz-ddl" classList={{ collapsed: ddlCollapsed() }}>
          <Show
            when={!ddlCollapsed()}
            fallback={
              <button class="relviz-rail" title="Expand the DDL pane" onClick={() => setDdlCollapsed(false)}>
                <Icon name="fileCode" />
                <span class="relviz-rail-label">DDL</span>
                <span class="relviz-rail-chev">»</span>
              </button>
            }
          >
            <div class="relviz-pane-head">
              <Icon name="fileCode" /> DDL
              <span class="spacer" />
              <button class="ghost" disabled={!ddl()?.ok} onClick={() => props.onCopy(ddl()!.ok!, "copied DDL")}>Copy</button>
              <button class="ghost" disabled={!ddl()?.ok} onClick={() => props.onOpenSql(ddl()!.ok!)}>Open in editor</button>
              <button class="icon" title="Collapse the DDL pane (full-width graph)" onClick={() => setDdlCollapsed(true)}>«</button>
            </div>
            <Switch>
              <Match when={!center().name}><div class="relviz-note">Click a table card to load its DDL.</div></Match>
              <Match when={ddl.loading}><div class="relviz-note">loading…</div></Match>
              <Match when={ddl()?.err}><div class="relviz-note">{ddl()!.err}</div></Match>
              <Match when={ddl()?.ok}>
                <pre class="ddl-code"><code><For each={highlightSql(ddl()!.ok!)}>{(t) => (t.cls ? <span class={t.cls}>{t.text}</span> : t.text)}</For></code></pre>
              </Match>
            </Switch>
          </Show>
        </div>

        <div class="relviz-graph">
          <div class="relviz-pane-head">
            <Icon name="link" /> Relationships
            <span class="seg relviz-seg">
              <button
                classList={{ active: scope() === "neighborhood" }}
                disabled={!center().name}
                title={center().name ? undefined : "Click a table card first"}
                onClick={() => setScope("neighborhood")}
              >
                Neighborhood
              </button>
              <button classList={{ active: scope() === "schema" }} onClick={() => setScope("schema")}>Whole schema</button>
            </span>
            <span class="spacer" />
            <Show when={scope() === "schema" && (erd()?.tables.length ?? 0) > 300}>
              <span class="relviz-warn">large schema — {erd()!.tables.length} tables</span>
            </Show>
            <Show when={scope() === "schema"}>
              <button
                class="ghost"
                disabled={nudges().size === 0 && groupNudges().size === 0}
                title="Discard manual repositioning, back to the computed layout"
                onClick={() => {
                  setNudges(new Map());
                  setGroupNudges(new Map());
                }}
              >
                Reset layout
              </button>
            </Show>
          </div>

          <Switch>
            <Match when={scope() === "neighborhood"}>
              <Show when={hood()} fallback={<div class="relviz-note">loading…</div>}>
                {(h) => (
                  <Show
                    when={h().inbound.length || h().outbound.length || h().selfRefs.length}
                    fallback={
                      <div class="relviz-empty">
                        <div class="relviz-center-solo">
                          <CenterCard name={center().name ?? ""} cols={h().cols} more={h().moreCols} />
                        </div>
                        No foreign-key relationships found for this relation.
                      </div>
                    }
                  >
                    <PanZoomCanvas bbox={h().bbox} fitKey={`${center().schema}.${center().name}:${Math.round(h().bbox.w)}x${Math.round(h().bbox.h)}:${ddlCollapsed() ? "c" : "e"}`}>
                      <svg class="viz-edges" width={h().bbox.w} height={h().bbox.h} viewBox={`0 0 ${Math.max(1, h().bbox.w)} ${Math.max(1, h().bbox.h)}`}>
                        <For each={h().inbound}>
                          {(n) => {
                            const y1 = n.y + NB_H / 2;
                            const y2 = h().colY(n.e.dstCols[0] ?? "") + fanOffset(n.fi, n.fn);
                            const x1 = NB_W;
                            const x2 = h().ctr.x;
                            const mx = (x1 + x2) / 2;
                            return (
                              <g classList={{ "edge-hover": hoverEdge() === n.e.constraint }}>
                                <path class="rel-edge" style={{ stroke: edgeColor(n.e.srcTable) }} d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} onMouseEnter={() => setHoverEdge(n.e.constraint)} onMouseLeave={() => setHoverEdge(null)} />
                                <text class="rel-edge-label" x={mx} y={(y1 + y2) / 2 - 5} text-anchor="middle">{edgeLabel(n.e)}</text>
                              </g>
                            );
                          }}
                        </For>
                        <For each={h().outbound}>
                          {(n) => {
                            const y1 = h().colY(n.e.srcCols[0] ?? "") + fanOffset(n.fi, n.fn);
                            const y2 = n.y + NB_H / 2;
                            const x1 = h().ctr.x + CTR_W;
                            const x2 = n.x;
                            const mx = (x1 + x2) / 2;
                            return (
                              <g classList={{ "edge-hover": hoverEdge() === n.e.constraint }}>
                                <path class="rel-edge" style={{ stroke: edgeColor(n.e.dstTable) }} d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} onMouseEnter={() => setHoverEdge(n.e.constraint)} onMouseLeave={() => setHoverEdge(null)} />
                                <text class="rel-edge-label" x={mx} y={(y1 + y2) / 2 - 5} text-anchor="middle">{edgeLabel(n.e)}</text>
                              </g>
                            );
                          }}
                        </For>
                      </svg>
                      <For each={h().inbound}>
                        {(n) => <NeighborCard edge={n.e} side="in" x={n.x} y={n.y} onClick={() => recenter(n.e.srcSchema, n.e.srcTable)} />}
                      </For>
                      <div style={{ position: "absolute", left: `${h().ctr.x}px`, top: `${h().ctr.y}px` }}>
                        <CenterCard name={center().name ?? ""} cols={h().cols} more={h().moreCols} selfRefs={h().selfRefs.length} />
                      </div>
                      <For each={h().outbound}>
                        {(n) => <NeighborCard edge={n.e} side="out" x={n.x} y={n.y} onClick={() => recenter(n.e.dstSchema, n.e.dstTable)} />}
                      </For>
                    </PanZoomCanvas>
                  </Show>
                )}
              </Show>
            </Match>

            <Match when={scope() === "schema"}>
              <Show when={!erd.loading} fallback={<div class="relviz-note">loading schema graph…</div>}>
                <Show when={erdLayoutMemo()} fallback={<div class="relviz-empty">No tables found in schema “{center().schema}”.</div>}>
                  {(l) => (
                    <PanZoomCanvas ref={(pz) => (erdPz = pz)} bbox={l().bbox} fitKey={`erd:${center().schema}:${Math.round(l().bbox.w)}x${Math.round(l().bbox.h)}:${ddlCollapsed() ? "c" : "e"}`}>
                      <For each={l().groups}>
                        {(gr, gi) => {
                          const gn = () => groupNudges().get(gi()) ?? { x: 0, y: 0 };
                          return (
                            <div class="erd-groupbox" style={{ left: `${gr.x + gn().x}px`, top: `${gr.y + gn().y}px`, width: `${gr.w}px`, height: `${gr.h}px` }}>
                              <div
                                class="erd-grouplabel"
                                title="Drag to move the whole family block"
                                onPointerDown={(e) => beginDrag(e, "group", gr.label, gi(), gr.members)}
                                onPointerMove={moveDrag}
                                onPointerUp={(e) => endDrag(e)}
                              >
                                {gr.label}
                              </div>
                            </div>
                          );
                        }}
                      </For>
                      <svg
                        class="viz-edges"
                        classList={{ "erd-dimming": !!hoverTable() }}
                        width={l().bbox.w}
                        height={l().bbox.h}
                        viewBox={`0 0 ${Math.max(1, l().bbox.w)} ${Math.max(1, l().bbox.h)}`}
                      >
                        <For each={l().graph.edges}>
                          {(e) => {
                            const st = erdTableByName().get(e.srcTable)!;
                            const dt = erdTableByName().get(e.dstTable)!;
                            const key = edgeKey(e);
                            const fan = erdFan().get(key) ?? { si: 0, sn: 1, di: 0, dn: 1 };
                            // Geometry is a memo over epos so edges FOLLOW manual
                            // drags live (a captured const would freeze them).
                            const geom = createMemo(() => {
                              const sp = epos(l(), e.srcTable);
                              const dp = epos(l(), e.dstTable);
                              if (!sp || !dp) return null;
                              const clamp = (y: number, top: number, h: number) => Math.max(top + 8, Math.min(top + h - 8, y));
                              const y1 = clamp(erdRowY(st, e.srcCols[0] ?? "", sp.y) + fanOffset(fan.si, fan.sn), sp.y, erdCardH(st));
                              const y2 = clamp(erdRowY(dt, e.dstCols[0] ?? "", dp.y) + fanOffset(fan.di, fan.dn), dp.y, erdCardH(dt));
                              // Vertically stacked cards (heavy x-overlap) get a
                              // right-side loop — the left/right S-curve degenerates
                              // into a near-vertical squiggle through the cards.
                              const xOverlap = Math.min(sp.x, dp.x) + ERD_W - Math.max(sp.x, dp.x);
                              if (xOverlap > ERD_W * 0.55) {
                                const x1 = sp.x + ERD_W;
                                const x2 = dp.x + ERD_W;
                                const cx = Math.max(x1, x2) + 46;
                                return { d: `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`, lx: cx, ly: (y1 + y2) / 2 - 5 };
                              }
                              const leftToRight = sp.x <= dp.x;
                              const x1 = sp.x + (leftToRight ? ERD_W : 0);
                              const x2 = dp.x + (leftToRight ? 0 : ERD_W);
                              const mx = (x1 + x2) / 2;
                              return { d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`, lx: mx, ly: (y1 + y2) / 2 - 5 };
                            });
                            const lit = () => hoverEdge() === key || hoverTable() === e.srcTable || hoverTable() === e.dstTable;
                            return (
                              <Show when={geom()}>
                                <g classList={{ "edge-hover": hoverEdge() === key, lit: lit() }}>
                                  <path
                                    class="rel-edge"
                                    classList={{ ubiq: dampedHubs().has(e.dstTable) && !lit() }}
                                    style={{ stroke: edgeColor(e.dstTable) }}
                                    d={geom()!.d}
                                    onMouseEnter={() => setHoverEdge(key)}
                                    onMouseLeave={() => setHoverEdge(null)}
                                  />
                                  <Show when={hoverEdge() === key || (hoverTable() !== null && lit())}>
                                    <text class="rel-edge-label" x={geom()!.lx} y={geom()!.ly} text-anchor="middle">{edgeLabel(e)}</text>
                                  </Show>
                                </g>
                              </Show>
                            );
                          }}
                        </For>
                      </svg>
                      <For each={l().graph.tables}>
                        {(t) => {
                          const p = () => epos(l(), t.name);
                          const keys = t.columns.filter((c) => c.isPk || c.isFk);
                          return (
                            <Show when={p()}>
                              <div
                                class="erd-card"
                                classList={{ focus: t.name === center().name, dimmed: !!hoverTable() && hoverTable() !== t.name && !erdAdj().get(t.name)?.has(hoverTable()!) }}
                                style={{ left: `${p()!.x}px`, top: `${p()!.y}px`, width: `${ERD_W}px` }}
                                onPointerDown={(e) => beginDrag(e, "table", t.name, -1, [])}
                                onPointerMove={moveDrag}
                                onPointerUp={(e) => endDrag(e, () => recenter(t.schema, t.name))}
                                onMouseEnter={() => setHoverTable(t.name)}
                                onMouseLeave={() => setHoverTable(null)}
                                title="Click: neighborhood view · drag: reposition"
                              >
                                <div class="erd-card-head"><span class="erd-hue" style={{ background: edgeColor(t.name) }} /><Icon name="table" /> {t.name}</div>
                                <For each={keys.slice(0, ERD_MAX_ROWS)}>
                                  {(c) => (
                                    <div class="erd-col">
                                      <span class="erd-col-ico">{c.isPk ? <Icon name="key" /> : <Icon name="link" />}</span>
                                      <span class="erd-col-name">{c.name}</span>
                                      <span class="erd-col-type">{c.dataType}</span>
                                    </div>
                                  )}
                                </For>
                                <Show when={keys.length > ERD_MAX_ROWS}><div class="erd-more">+{keys.length - ERD_MAX_ROWS} more keys</div></Show>
                                <Show when={keys.length === 0}><div class="erd-more">{t.columns.length} columns</div></Show>
                              </div>
                            </Show>
                          );
                        }}
                      </For>
                    </PanZoomCanvas>
                  )}
                </Show>
              </Show>
            </Match>
          </Switch>
        </div>
      </div>
    </Dialog>
  );
}

function CenterCard(props: { name: string; cols: DetailCol[]; more: number; selfRefs?: number }) {
  return (
    <div class="hood-center" style={{ width: `${CTR_W}px` }} onPointerDown={(e) => e.stopPropagation()}>
      <div class="hood-center-head"><Icon name="table" /> {props.name}{(props.selfRefs ?? 0) > 0 ? <span class="hood-self" title="Self-referencing foreign key">↺</span> : null}</div>
      <For each={props.cols}>
        {(c) => (
          <div class="erd-col" style={{ height: `${COL_ROW_H}px` }}>
            <span class="erd-col-ico">{c.is_pk ? <Icon name="key" /> : c.is_fk ? <Icon name="link" /> : <Icon name="dot" />}</span>
            <span class="erd-col-name">{c.name}</span>
            <span class="erd-col-type">{c.data_type}</span>
          </div>
        )}
      </For>
      <Show when={props.more > 0}><div class="erd-more">+{props.more} more columns</div></Show>
    </div>
  );
}

function NeighborCard(props: { edge: FkEdge; side: "in" | "out"; x: number; y: number; onClick: () => void }) {
  const name = () => (props.side === "in" ? props.edge.srcTable : props.edge.dstTable);
  const schema = () => (props.side === "in" ? props.edge.srcSchema : props.edge.dstSchema);
  return (
    <div
      class="hood-card"
      style={{ left: `${props.x}px`, top: `${props.y}px`, width: `${NB_W}px`, height: `${NB_H}px` }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={props.onClick}
      title={`${schema()}.${name()} — click to re-center`}
    >
      <div class="hood-card-name"><span class="erd-hue" style={{ background: edgeColor(name()) }} /><Icon name="table" /> {name()}</div>
      <div class="hood-card-sub">{props.side === "in" ? "references this" : "referenced"} · {props.edge.constraint}</div>
    </div>
  );
}
