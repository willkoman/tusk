import { For, Show, createMemo, createSignal, type Accessor } from "solid-js";
import { type EditorPrefs } from "../editor/types";
import { PanZoomCanvas } from "../viz/PanZoomCanvas";
import { edgePath, layoutTree } from "./layout";
import { type ParsedPlan, type PlanNode, type PlanTree } from "./types";

// Styled, customizable plan visualization. kind:"text" renders as a monospace
// block (the universal fallback — never a broken view); kind:"tree" renders a
// pan/zoomable tidy tree of node cards with heat coloring, collapse, and a
// docked details panel. Raw output stays one Grid-toggle away in App.

const CARD_W = 196;
const cardH = (density: "compact" | "normal") => (density === "compact" ? 44 : 64);

/** Theme heat endpoints, read once per render pass from the live CSS vars. */
function heatColors(): { cold: [number, number, number]; hot: [number, number, number] } {
  const css = getComputedStyle(document.documentElement);
  const parse = (v: string, fb: [number, number, number]): [number, number, number] => {
    const m = /^#([0-9a-f]{6})$/i.exec(v.trim());
    if (!m) return fb;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  return {
    cold: parse(css.getPropertyValue("--heat-cold"), [100, 116, 139]),
    hot: parse(css.getPropertyValue("--heat-hot"), [239, 68, 68]),
  };
}

function fmtNum(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(0)}k`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(ms < 1 ? 3 : 1)}ms`);

/** 0..1 heat for a node under the chosen metric (sqrt — mid values stay visible). */
function heatOf(n: PlanNode, plan: PlanTree, metric: EditorPrefs["planHeat"]): number {
  // cost → time fallback when the engine has no costs (DuckDB/SQLite).
  const m = metric === "cost" && plan.maxSelfCost === 0 && plan.maxSelfTimeMs > 0 ? "time" : metric;
  let v = 0;
  let max = 0;
  if (m === "cost") {
    v = n.selfCost ?? 0;
    max = plan.maxSelfCost;
  } else if (m === "time") {
    v = n.selfTimeMs ?? 0;
    max = plan.maxSelfTimeMs;
  } else if (m === "rows") {
    v = n.actualRows ?? n.planRows ?? 0;
    max = plan.maxRows;
  }
  return max > 0 ? Math.sqrt(v / max) : 0;
}

export function PlanView(props: {
  plan: Accessor<ParsedPlan>;
  prefs: Accessor<EditorPrefs>;
  /** Re-fit key — a new query/plan refits, a collapse doesn't. */
  fitKey: Accessor<string>;
}) {
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<number>>(new Set<number>(), { equals: false });
  const [selectedId, setSelectedId] = createSignal<number | null>(null);

  const tree = createMemo<PlanTree | null>(() => {
    const p = props.plan();
    return p.kind === "tree" ? p : null;
  });

  const layout = createMemo(() => {
    const t = tree();
    if (!t) return null;
    return layoutTree(t.root, {
      orientation: props.prefs().planOrientation,
      nodeW: CARD_W,
      nodeH: cardH(props.prefs().planDensity),
      gapMain: 46,
      gapCross: 18,
      collapsed: collapsed(),
    });
  });

  const byId = createMemo(() => {
    const m = new Map<number, PlanNode>();
    const t = tree();
    if (t) {
      const walk = (n: PlanNode) => {
        m.set(n.id, n);
        n.children.forEach(walk);
      };
      walk(t.root);
    }
    return m;
  });
  const selected = () => (selectedId() !== null ? byId().get(selectedId()!) ?? null : null);

  const toggleCollapse = (id: number) => {
    const next = new Set(collapsed());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
  };

  const hiddenCount = (n: PlanNode): number => {
    let c = 0;
    const walk = (x: PlanNode) => {
      c++;
      x.children.forEach(walk);
    };
    n.children.forEach(walk);
    return c;
  };

  return (
    <div class="plan-view">
      <Show
        when={tree()}
        fallback={<pre class="plan-text">{props.plan().kind === "text" ? (props.plan() as { text: string }).text : ""}</pre>}
      >
        {(t) => {
          const colors = heatColors();
          const H = () => cardH(props.prefs().planDensity);
          return (
            <>
              <div class="plan-head">
                <span class="plan-badge">{t().engine}</span>
                <Show when={t().planningMs !== undefined}><span class="plan-stat">planning {fmtMs(t().planningMs!)}</span></Show>
                <Show when={t().executionMs !== undefined}><span class="plan-stat">execution {fmtMs(t().executionMs!)}</span></Show>
                <Show when={!t().hasActual}><span class="plan-stat dim">estimates only</span></Show>
                <span class="spacer" />
                <span class="plan-stat dim">double-click background to fit · raw output under Grid</span>
              </div>
              <div class="plan-body">
                <PanZoomCanvas bbox={layout()!.bbox} fitKey={`${props.fitKey()}:${props.prefs().planOrientation}`}>
                  <svg
                    class="viz-edges"
                    width={layout()!.bbox.w}
                    height={layout()!.bbox.h}
                    viewBox={`0 0 ${Math.max(1, layout()!.bbox.w)} ${Math.max(1, layout()!.bbox.h)}`}
                  >
                    <For each={layout()!.edges}>
                      {(e) => (
                        <path
                          class="plan-edge"
                          d={edgePath(layout()!.pos.get(e.from)!, layout()!.pos.get(e.to)!, {
                            orientation: props.prefs().planOrientation,
                            nodeW: CARD_W,
                            nodeH: H(),
                          })}
                        />
                      )}
                    </For>
                  </svg>
                  <For each={layout()!.visible}>
                    {(n) => {
                      const p = () => layout()!.pos.get(n.id)!;
                      const heat = () => (props.prefs().planHeat === "off" ? 0 : heatOf(n, t(), props.prefs().planHeat));
                      const mix = () => {
                        const h = heat();
                        const c = colors.cold.map((cv, i) => Math.round(cv + (colors.hot[i] - cv) * h)) as [number, number, number];
                        return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
                      };
                      return (
                        <div
                          class="plan-card"
                          classList={{ selected: selectedId() === n.id, compact: props.prefs().planDensity === "compact" }}
                          style={{
                            left: `${p().x}px`,
                            top: `${p().y}px`,
                            width: `${CARD_W}px`,
                            height: `${H()}px`,
                            "border-left-color": heat() > 0.02 ? mix() : "var(--border)",
                            background: heat() > 0.02 ? `rgba(${colors.hot[0]}, ${colors.hot[1]}, ${colors.hot[2]}, ${(heat() * 0.16).toFixed(3)})` : undefined,
                          }}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => setSelectedId(selectedId() === n.id ? null : n.id)}
                        >
                          <div class="plan-card-title">
                            <span class="plan-card-label" title={n.label}>{n.label}</span>
                            <Show when={n.children.length > 0}>
                              <button
                                class="plan-collapse"
                                title={collapsed().has(n.id) ? "Expand subtree" : "Collapse subtree"}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleCollapse(n.id);
                                }}
                              >
                                {collapsed().has(n.id) ? `▸ ${hiddenCount(n)}` : "▾"}
                              </button>
                            </Show>
                          </div>
                          <Show when={n.object}><div class="plan-card-obj" title={n.object}>{n.object}</div></Show>
                          <Show when={props.prefs().planDensity !== "compact"}>
                            <div class="plan-card-stats">
                              <Show when={t().hasActual && n.totalTimeMs !== undefined} fallback={
                                <Show when={n.totalCost !== undefined}><span>cost {fmtNum(n.totalCost!)}</span></Show>
                              }>
                                <span>{fmtMs(n.totalTimeMs! * (n.loops ?? 1))}</span>
                              </Show>
                              <Show when={n.actualRows !== undefined} fallback={
                                <Show when={n.planRows !== undefined}><span>~{fmtNum(n.planRows!)} rows</span></Show>
                              }>
                                <span>{fmtNum(n.actualRows!)} rows{(n.loops ?? 1) > 1 ? ` ×${n.loops}` : ""}</span>
                              </Show>
                            </div>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </PanZoomCanvas>
                <Show when={selected()}>
                  {(sel) => (
                    <div class="plan-details" onPointerDown={(e) => e.stopPropagation()}>
                      <div class="plan-details-head">
                        <strong>{sel().label}</strong>
                        <span class="spacer" />
                        <button class="icon" onClick={() => setSelectedId(null)}>✕</button>
                      </div>
                      <div class="plan-details-body">
                        <Show when={sel().object}><div class="plan-detail-row"><span>Object</span><span>{sel().object}</span></div></Show>
                        <Show when={sel().selfCost !== undefined}><div class="plan-detail-row"><span>Self cost</span><span>{fmtNum(sel().selfCost!)}</span></div></Show>
                        <Show when={sel().selfTimeMs !== undefined}><div class="plan-detail-row"><span>Self time</span><span>{fmtMs(sel().selfTimeMs!)}</span></div></Show>
                        <For each={sel().props}>
                          {([k, v]) => (
                            <div class="plan-detail-row"><span>{k}</span><span>{v}</span></div>
                          )}
                        </For>
                      </div>
                    </div>
                  )}
                </Show>
              </div>
            </>
          );
        }}
      </Show>
    </div>
  );
}
