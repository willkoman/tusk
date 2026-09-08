import { createMemo, createSignal, For, Show, onMount } from "solid-js";
import { Dialog, DialogFooter } from "../Dialog";
import { Icon } from "../Icons";
import {
  addToGroup,
  arityOf,
  classResolver,
  defaultOperatorFor,
  duplicateNode,
  emptyFilter,
  isGroup,
  makeCondition,
  makeGroup,
  operatorsFor,
  removeNode,
  setGroupOp,
  updateCondition,
  type ColumnClass,
  type Condition,
  type FilterGroup,
  type FilterOperator,
  type FilterTree,
} from "../grid/filterModel";
import { renderWhere } from "../grid/filterSql";

const CLASS_LABEL: Record<ColumnClass, string> = {
  text: "text",
  number: "num",
  boolean: "bool",
  datetime: "date",
  other: "any",
};

const DATE_HINT = "e.g. 2024-01-31 or 2024-01-31 09:30:00";

/**
 * Value slots for a fresh column/operator pair. Boolean `=`/`≠` seeds TRUE so
 * the rendered dropdown and the model agree (an empty value would silently
 * drop the condition while the UI showed a choice).
 */
function seedValues(cls: ColumnClass, op: FilterOperator, existing: string[]): string[] {
  const slots = arityOf(op);
  if (slots === 1 && cls === "boolean") return [existing[0] || "true"];
  return slots === 0 ? [] : existing.slice(0, slots === "list" ? 1 : slots);
}

/** A new condition for `column`, with its class-appropriate default operator. */
function newCondition(column: string, classOf: (c: string) => ColumnClass) {
  const cls = classOf(column);
  const op = defaultOperatorFor(cls);
  return makeCondition(column, op, seedValues(cls, op, []));
}

/**
 * Visual filter builder: AND/OR groups of typed conditions over the active
 * result's columns, with a live WHERE preview. It never runs SQL itself —
 * Apply hands the tree back to App, which re-streams the wrapped query.
 */
export function FilterBuilder(props: {
  columns: string[];
  /** column name → driver type, when the relation's detail is known. */
  types?: Record<string, string>;
  dialect: string;
  initial: FilterTree;
  /** Column the builder should pre-fill a first condition for. */
  prefill?: string;
  onApply: (tree: FilterTree) => void;
  onOpenQuery: (tree: FilterTree) => void;
  onCopyWhere: (where: string) => void;
  onClose: () => void;
}) {
  const classOf = createMemo(() => classResolver(props.types));
  const firstColumn = () => props.prefill ?? props.columns[0] ?? "";

  const seeded = (): FilterTree => {
    const base = props.initial ?? emptyFilter();
    if (!props.prefill && base.items.length) return base;
    if (!firstColumn()) return base;
    return { ...base, items: [...base.items, newCondition(firstColumn(), classOf())] };
  };

  const [tree, setTree] = createSignal<FilterTree>(seeded());
  let firstField: HTMLSelectElement | undefined;

  onMount(() => queueMicrotask(() => firstField?.focus()));

  // One memo carries both outcomes — the generator throws on an ambiguous column
  // name or an over-budget tree, and that message is what the footer shows.
  const rendered = createMemo<{ sql: string; error: string }>(() => {
    try {
      return { sql: renderWhere(tree(), { columns: props.columns, dialect: props.dialect, classOf: classOf() }), error: "" };
    } catch (e) {
      return { sql: "", error: e instanceof Error ? e.message : String(e) };
    }
  });
  const where = () => rendered().sql;
  const error = () => rendered().error;
  const preview = () => (where() ? `WHERE ${where()}` : "");

  const apply = () => {
    if (error()) return;
    props.onApply(tree());
    props.onClose();
  };

  const clear = () => setTree(emptyFilter());

  // Enter applies from anywhere in the form except a textarea; Esc is Dialog's.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    const t = e.target as HTMLElement | null;
    if (t && t.tagName === "TEXTAREA") return;
    if (t && t.tagName === "BUTTON") return; // let the button do its own thing
    e.preventDefault();
    apply();
  };

  return (
    <Dialog title="Filter rows" onClose={props.onClose} width={720}>
      <div class="filter-builder" onKeyDown={onKeyDown}>
        <Show
          when={props.columns.length}
          fallback={<div class="filter-empty">Run a query first — the builder filters the columns of a loaded result.</div>}
        >
          <GroupEditor
            group={tree()}
            depth={0}
            columns={props.columns}
            classOf={classOf()}
            firstRef={(el) => (firstField = el)}
            onChange={setTree}
            tree={tree}
          />
        </Show>
      </div>
      <DialogFooter
        sql={preview()}
        error={error()}
        disabled={!!error()}
        primaryLabel="Apply filter"
        onPrimary={apply}
        onEditAsSql={() => {
          props.onOpenQuery(tree());
          props.onClose();
        }}
        editAsSqlLabel="Open as query"
        extra={
          <>
            <button class="ghost" onClick={clear} disabled={!tree().items.length}>Clear</button>
            <button class="ghost" onClick={() => props.onCopyWhere(where())} disabled={!where()}>Copy WHERE</button>
          </>
        }
        onCancel={props.onClose}
      />
    </Dialog>
  );
}

/** One AND/OR group: its join toggle, its rows, and its add buttons. */
function GroupEditor(props: {
  group: FilterGroup;
  depth: number;
  columns: string[];
  classOf: (column: string) => ColumnClass;
  firstRef?: (el: HTMLSelectElement) => void;
  tree: () => FilterTree;
  onChange: (tree: FilterTree) => void;
}) {
  const setOp = (op: "and" | "or") => props.onChange(setGroupOp(props.tree(), props.group.id, op));
  const addCondition = () => {
    const col = props.columns[0] ?? "";
    props.onChange(addToGroup(props.tree(), props.group.id, newCondition(col, props.classOf)));
  };
  const addGroup = () => {
    const col = props.columns[0] ?? "";
    const inner = makeGroup(props.group.op === "and" ? "or" : "and", [newCondition(col, props.classOf)]);
    props.onChange(addToGroup(props.tree(), props.group.id, inner));
  };

  return (
    <div class="filter-group" classList={{ nested: props.depth > 0 }}>
      <div class="filter-group-head">
        <div class="filter-join" role="group" aria-label="Join">
          <button class="chip" classList={{ active: props.group.op === "and" }} onClick={() => setOp("and")}>AND</button>
          <button class="chip" classList={{ active: props.group.op === "or" }} onClick={() => setOp("or")}>OR</button>
        </div>
        <span class="filter-join-hint">
          {props.group.op === "and" ? "every condition must match" : "any condition may match"}
        </span>
        <span class="spacer" />
        <button class="ghost filter-add" onClick={addCondition}><Icon name="plus" /> Condition</button>
        <Show when={props.depth < 4}>
          <button class="ghost filter-add" onClick={addGroup}><Icon name="plus" /> Group</button>
        </Show>
        <Show when={props.depth > 0}>
          <button
            class="icon"
            title="Remove group"
            aria-label="Remove group"
            onClick={() => props.onChange(removeNode(props.tree(), props.group.id))}
          >
            <Icon name="close" />
          </button>
        </Show>
      </div>
      <Show when={props.group.items.length} fallback={<div class="filter-empty">No conditions — every row matches.</div>}>
        <For each={props.group.items}>
          {(item, i) => (
            <div class="filter-item">
              <span class="filter-joiner">{i() === 0 ? "" : props.group.op === "and" ? "AND" : "OR"}</span>
              <Show
                when={isGroup(item)}
                fallback={
                  <ConditionRow
                    cond={item as Condition}
                    columns={props.columns}
                    classOf={props.classOf}
                    selectRef={props.depth === 0 && i() === 0 ? props.firstRef : undefined}
                    tree={props.tree}
                    onChange={props.onChange}
                  />
                }
              >
                <GroupEditor
                  group={item as FilterGroup}
                  depth={props.depth + 1}
                  columns={props.columns}
                  classOf={props.classOf}
                  tree={props.tree}
                  onChange={props.onChange}
                />
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

/** One condition row: column · type badge · operator · value input(s) · actions. */
function ConditionRow(props: {
  cond: Condition;
  columns: string[];
  classOf: (column: string) => ColumnClass;
  selectRef?: (el: HTMLSelectElement) => void;
  tree: () => FilterTree;
  onChange: (tree: FilterTree) => void;
}) {
  const cls = () => props.classOf(props.cond.column);
  const ops = () => operatorsFor(cls());
  const patch = (p: Partial<Omit<Condition, "kind" | "id">>) =>
    props.onChange(updateCondition(props.tree(), props.cond.id, p));

  const onColumn = (name: string) => {
    const next = props.classOf(name);
    // The operator menu is class-driven: keep the current operator when it still
    // applies, otherwise fall back rather than leave an impossible combination.
    const keep = operatorsFor(next).some((o) => o.id === props.cond.operator);
    const op = keep ? props.cond.operator : defaultOperatorFor(next);
    patch({ column: name, operator: op, values: seedValues(next, op, keep ? props.cond.values : []) });
  };
  const onOperator = (op: FilterOperator) => patch({ operator: op, values: seedValues(cls(), op, props.cond.values) });
  const setValue = (i: number, v: string) => {
    const values = [...props.cond.values];
    while (values.length <= i) values.push("");
    values[i] = v;
    patch({ values });
  };

  return (
    <div class="filter-row">
      <select
        class="filter-col"
        ref={props.selectRef}
        value={props.cond.column}
        onChange={(e) => onColumn(e.currentTarget.value)}
        aria-label="Column"
      >
        <Show when={!props.columns.includes(props.cond.column)}>
          <option value={props.cond.column}>{props.cond.column} (missing)</option>
        </Show>
        <For each={props.columns}>{(c) => <option value={c}>{c}</option>}</For>
      </select>
      <span class="chip-ro filter-class" title={`value class: ${cls()}`}>{CLASS_LABEL[cls()]}</span>
      <select
        class="filter-op"
        value={props.cond.operator}
        onChange={(e) => onOperator(e.currentTarget.value as FilterOperator)}
        aria-label="Operator"
      >
        <For each={ops()}>{(o) => <option value={o.id}>{o.label}</option>}</For>
      </select>
      <ValueInputs cond={props.cond} cls={cls()} onValue={setValue} />
      <span class="spacer" />
      <button
        class="icon"
        title="Duplicate condition"
        aria-label="Duplicate condition"
        onClick={() => props.onChange(duplicateNode(props.tree(), props.cond.id))}
      >
        <Icon name="duplicate" />
      </button>
      <button
        class="icon"
        title="Remove condition"
        aria-label="Remove condition"
        onClick={() => props.onChange(removeNode(props.tree(), props.cond.id))}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}

function ValueInputs(props: { cond: Condition; cls: ColumnClass; onValue: (i: number, v: string) => void }) {
  const arity = () => arityOf(props.cond.operator);
  const val = (i: number) => props.cond.values[i] ?? "";
  const hint = () => (props.cls === "datetime" ? DATE_HINT : "value");

  return (
    <Show when={arity() !== 0} fallback={<span class="filter-novalue">no value</span>}>
      <Show when={arity() !== "list"} fallback={
        <input
          class="filter-val wide"
          value={val(0)}
          placeholder="a, b, c — quote values containing commas"
          onInput={(e) => props.onValue(0, e.currentTarget.value)}
          aria-label="Values"
        />
      }>
        <Show when={props.cls === "boolean"} fallback={
          <>
            <input
              class="filter-val"
              value={val(0)}
              placeholder={hint()}
              onInput={(e) => props.onValue(0, e.currentTarget.value)}
              aria-label="Value"
            />
            <Show when={arity() === 2}>
              <span class="filter-and">and</span>
              <input
                class="filter-val"
                value={val(1)}
                placeholder={hint()}
                onInput={(e) => props.onValue(1, e.currentTarget.value)}
                aria-label="Second value"
              />
            </Show>
          </>
        }>
          <select
            class="filter-val"
            value={val(0) || "true"}
            onChange={(e) => props.onValue(0, e.currentTarget.value)}
            aria-label="Value"
          >
            <option value="true">TRUE</option>
            <option value="false">FALSE</option>
          </select>
        </Show>
      </Show>
    </Show>
  );
}
