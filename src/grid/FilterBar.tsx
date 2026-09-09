import { For, Show } from "solid-js";
import { Icon } from "../Icons";
import {
  conditions,
  describeCondition,
  isGroup,
  type Condition,
  type FilterGroup,
  type FilterNode,
  type FilterTree,
} from "./filterModel";

/**
 * Slim bar above the grid summarising the active filter: one removable chip per
 * condition, nested groups bracketed and joined by their own operator, plus the
 * server's row count and Edit… / Clear all. Display only — every mutation goes
 * back through App so the wrapped query re-streams.
 */
export function FilterBar(props: {
  tree: () => FilterTree;
  /** Row-count text exactly as the result reports it (e.g. "1,204 rows"). */
  rowText: () => string;
  disabled?: () => boolean;
  onEdit: () => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const active = () => conditions(props.tree()).length;
  return (
    <Show when={active() > 0}>
      <div class="filter-bar">
        <span class="filter-bar-label"><Icon name="search" /> Filter</span>
        <div class="filter-bar-chips">
          <NodeChips node={props.tree()} top onRemove={props.onRemove} disabled={props.disabled} />
        </div>
        <span class="spacer" />
        <Show when={props.rowText()}>
          <span class="filter-bar-count">{props.rowText()}</span>
        </Show>
        <button class="ghost filter-bar-btn" disabled={props.disabled?.()} onClick={props.onEdit}>Edit…</button>
        <button class="ghost filter-bar-btn" disabled={props.disabled?.()} onClick={props.onClear}>Clear all</button>
      </div>
    </Show>
  );
}

function NodeChips(props: { node: FilterNode; top?: boolean; onRemove: (id: string) => void; disabled?: () => boolean }) {
  // Only nodes that contribute SQL get a chip — an incomplete row would read as
  // an active rule the result doesn't reflect.
  const shown = () => (isGroup(props.node) ? (props.node as FilterGroup).items.filter((i) => conditions(i).length > 0) : []);
  return (
    <Show
      when={isGroup(props.node)}
      fallback={<Chip cond={props.node as Condition} onRemove={props.onRemove} disabled={props.disabled} />}
    >
      <span class="filter-chip-group" classList={{ nested: !props.top }}>
        <For each={shown()}>
          {(item, i) => (
            <>
              <Show when={i() > 0}>
                <span class="filter-chip-join">{(props.node as FilterGroup).op === "or" ? "OR" : "AND"}</span>
              </Show>
              <NodeChips node={item} onRemove={props.onRemove} disabled={props.disabled} />
            </>
          )}
        </For>
      </span>
    </Show>
  );
}

function Chip(props: { cond: Condition; onRemove: (id: string) => void; disabled?: () => boolean }) {
  return (
    <span class="filter-chip" title={describeCondition(props.cond)}>
      <span class="filter-chip-text">{describeCondition(props.cond)}</span>
      <button
        class="icon filter-chip-x"
        title="Remove this condition"
        aria-label={`Remove filter ${describeCondition(props.cond)}`}
        disabled={props.disabled?.()}
        onClick={() => props.onRemove(props.cond.id)}
      >
        <Icon name="close" />
      </button>
    </span>
  );
}
