// Animated illustrations for KB topics — pure CSS loops (keyframes in App.css,
// all prefixed .kbd-*). Each demo is a small self-contained vignette inside a
// shared mini-window frame; no timers, no state, cheap to keep mounted.

import { For, type JSX } from "solid-js";
import type { DemoId } from "./types";

function Frame(props: { children: JSX.Element; wide?: boolean }) {
  return (
    <div class="kbd-frame" classList={{ wide: !!props.wide }}>
      <div class="kbd-chrome"><i /><i /><i /></div>
      {props.children}
    </div>
  );
}

function MiniRow(props: { i: number; cls?: string; cells?: string[] }) {
  return (
    <div class={`kbd-row ${props.cls ?? ""}`} style={{ "animation-delay": `${props.i * 0.35}s` }}>
      <For each={props.cells ?? ["", "", ""]}>{(c) => <span class="kbd-cell">{c}</span>}</For>
    </div>
  );
}

/** Rows stream in one by one, scrollbar thumb crawls, streaming pill pulses. */
function GridStream() {
  return (
    <Frame>
      <div class="kbd-grid">
        <div class="kbd-row kbd-head"><span class="kbd-cell">id</span><span class="kbd-cell">email</span><span class="kbd-cell">plan</span></div>
        <For each={[0, 1, 2, 3, 4, 5]}>{(i) => <MiniRow i={i} cls="kbd-appear" />}</For>
      </div>
      <div class="kbd-scrollbar"><div class="kbd-thumb" /></div>
      <div class="kbd-pill kbd-pulse">streaming…</div>
    </Frame>
  );
}

/** App layout skeleton; the sidebar and results panels slide away and back. */
function Panels() {
  return (
    <Frame wide>
      <div class="kbd-layout">
        <div class="kbd-side kbd-slide-x" />
        <div class="kbd-main">
          <div class="kbd-editorpane" />
          <div class="kbd-resultpane kbd-slide-y" />
        </div>
      </div>
    </Frame>
  );
}

/** One cell gets edited (dirty amber), then the commit flash turns it green. */
function GridEdit() {
  return (
    <Frame>
      <div class="kbd-grid">
        <div class="kbd-row kbd-head"><span class="kbd-cell">id</span><span class="kbd-cell">name</span><span class="kbd-cell">active</span></div>
        <div class="kbd-row"><span class="kbd-cell">1</span><span class="kbd-cell">ada</span><span class="kbd-cell">t</span></div>
        <div class="kbd-row"><span class="kbd-cell">2</span><span class="kbd-cell kbd-editcell">gracee</span><span class="kbd-cell">t</span></div>
        <div class="kbd-row"><span class="kbd-cell">3</span><span class="kbd-cell">linus</span><span class="kbd-cell">f</span></div>
      </div>
      <div class="kbd-pill kbd-commit">Commit 1 change…</div>
    </Frame>
  );
}

/** Editor line with a completion popup; the highlight cycles through options. */
function Autocomplete() {
  return (
    <Frame>
      <div class="kbd-editor">
        <span class="kbd-kw">SELECT</span> * <span class="kbd-kw">FROM</span> us<span class="kbd-caret" />
      </div>
      <div class="kbd-popup">
        <div class="kbd-opt kbd-cycle" style={{ "animation-delay": "0s" }}>users <i>table</i></div>
        <div class="kbd-opt kbd-cycle" style={{ "animation-delay": "1.2s" }}>user_roles <i>table</i></div>
        <div class="kbd-opt kbd-cycle" style={{ "animation-delay": "2.4s" }}>user_events <i>table</i></div>
      </div>
    </Frame>
  );
}

/** Hovering an identifier pops an info card with columns + PK/FK marks. */
function HoverCard() {
  return (
    <Frame>
      <div class="kbd-editor">
        <span class="kbd-kw">FROM</span> <span class="kbd-hoverword">orders</span> o
      </div>
      <div class="kbd-card kbd-cardpop">
        <div class="kbd-cardtitle">orders <i>table · 12k rows</i></div>
        <div class="kbd-cardline"><b>id</b> uuid 🔑</div>
        <div class="kbd-cardline">user_id uuid ↗</div>
        <div class="kbd-cardline">total numeric</div>
      </div>
    </Frame>
  );
}

/** Header sort arrow flips and the rows visibly reorder; a filter row appears. */
function SortFilter() {
  return (
    <Frame>
      <div class="kbd-grid">
        <div class="kbd-row kbd-head"><span class="kbd-cell">name</span><span class="kbd-cell">total <b class="kbd-sortglyph">▲</b></span></div>
        <div class="kbd-row kbd-filterrow"><span class="kbd-cell kbd-filtercell">filter…</span><span class="kbd-cell kbd-filtercell" /></div>
        <div class="kbd-row kbd-swap-a"><span class="kbd-cell">ada</span><span class="kbd-cell">120</span></div>
        <div class="kbd-row kbd-swap-b"><span class="kbd-cell">grace</span><span class="kbd-cell">840</span></div>
        <div class="kbd-row"><span class="kbd-cell">linus</span><span class="kbd-cell">410</span></div>
      </div>
    </Frame>
  );
}

/** The scroll thumb jumps to the end and a row-count pill lands. */
function JumpCount() {
  return (
    <Frame>
      <div class="kbd-grid">
        <For each={[0, 1, 2, 3, 4]}>{() => <div class="kbd-row"><span class="kbd-cell" /><span class="kbd-cell" /><span class="kbd-cell" /></div>}</For>
      </div>
      <div class="kbd-scrollbar"><div class="kbd-thumb kbd-thumbjump" /></div>
      <div class="kbd-pill kbd-countpill">1,204,481 rows</div>
    </Frame>
  );
}

/** Three FK-linked table cards; edges draw in, the hub card pulses. */
function ErdMini() {
  return (
    <Frame wide>
      <svg class="kbd-erd" viewBox="0 0 240 110">
        <path class="kbd-edge" d="M78 40 C 100 40, 110 55, 132 55" />
        <path class="kbd-edge" style={{ "animation-delay": "0.6s" }} d="M78 82 C 100 82, 110 66, 132 62" />
        <g class="kbd-erdcard kbd-pulse-soft"><rect x="132" y="42" width="76" height="28" rx="4" /><text x="140" y="60">users</text></g>
        <g class="kbd-erdcard"><rect x="10" y="26" width="68" height="28" rx="4" /><text x="18" y="44">orders</text></g>
        <g class="kbd-erdcard"><rect x="10" y="68" width="68" height="28" rx="4" /><text x="18" y="86">sessions</text></g>
      </svg>
    </Frame>
  );
}

/** A plan tree with heat-colored nodes; the hottest one throbs. */
function PlanHeat() {
  return (
    <Frame wide>
      <svg class="kbd-plan" viewBox="0 0 240 110">
        <path class="kbd-planedge" d="M120 26 C 120 40, 70 44, 70 58" />
        <path class="kbd-planedge" d="M120 26 C 120 40, 170 44, 170 58" />
        <path class="kbd-planedge" d="M170 82 C 170 90, 170 88, 170 92" />
        <g><rect class="kbd-plannode heat1" x="84" y="8" width="72" height="20" rx="4" /><text x="94" y="22">Hash Join</text></g>
        <g><rect class="kbd-plannode heat0" x="34" y="58" width="72" height="20" rx="4" /><text x="44" y="72">Index Scan</text></g>
        <g><rect class="kbd-plannode heat3 kbd-throb" x="134" y="58" width="72" height="20" rx="4" /><text x="144" y="72">Seq Scan</text></g>
      </svg>
    </Frame>
  );
}

/** Slack thread: question → SQL proposal card → Approve click → table reply. */
function SlackApprove() {
  return (
    <Frame wide>
      <div class="kbd-slack">
        <div class="kbd-msg">how many signups this week?</div>
        <div class="kbd-proposal">
          <code>SELECT count(*) FROM users …</code>
          <div class="kbd-btns">
            <span class="kbd-approve kbd-clickflash">Approve</span>
            <span class="kbd-reject">Reject</span>
          </div>
        </div>
        <div class="kbd-msg kbd-reply kbd-appear" style={{ "animation-delay": "2.2s" }}>▦ 1 row · count = 3,182</div>
      </div>
    </Frame>
  );
}

export const DEMOS: Record<DemoId, () => JSX.Element> = {
  "grid-stream": GridStream,
  panels: Panels,
  "grid-edit": GridEdit,
  autocomplete: Autocomplete,
  "hover-card": HoverCard,
  "sort-filter": SortFilter,
  "jump-count": JumpCount,
  "erd-mini": ErdMini,
  "plan-heat": PlanHeat,
  "slack-approve": SlackApprove,
};
