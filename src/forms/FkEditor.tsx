import { createMemo, createSignal, For, Show, createEffect, on, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon } from "../Icons";
import type { FkSpec } from "../sql/ddl";
import { ddlCaps } from "../sql/ddlCaps";

/** One table the FK can point at, as the loaded shallow tree knows it. */
export type RefTable = { schema: string; name: string; columns: { name: string; data_type?: string }[] };
/** Referenced-column detail, fetched lazily for the chosen table. */
export type RefColumn = { name: string; data_type: string; isKey: boolean; keyLabel?: string };

export const REF_ACTIONS = ["", "NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"];

/** The editable state of one foreign key. `pairs` keeps local↔referenced columns
 *  aligned so a composite key can never go half-defined. */
export type FkDraft = {
  name: string;
  refSchema: string;
  refTable: string;
  pairs: { local: string; ref: string }[];
  onDelete: string;
  onUpdate: string;
  deferrable: boolean;
  initiallyDeferred: boolean;
};

export const emptyFk = (): FkDraft => ({
  name: "",
  refSchema: "",
  refTable: "",
  pairs: [{ local: "", ref: "" }],
  onDelete: "",
  onUpdate: "",
  deferrable: false,
  initiallyDeferred: false,
});

/** A complete draft as an `FkSpec`, or null while it is still half-filled. */
export function fkSpecOf(d: FkDraft): FkSpec | null {
  const pairs = d.pairs.filter((p) => p.local.trim() && p.ref.trim());
  if (!d.refTable || !pairs.length) return null;
  return {
    name: d.name.trim() || undefined,
    columns: pairs.map((p) => p.local),
    refSchema: d.refSchema,
    refTable: d.refTable,
    refColumns: pairs.map((p) => p.ref),
    onDelete: d.onDelete || undefined,
    onUpdate: d.onUpdate || undefined,
    deferrable: d.deferrable || undefined,
    initiallyDeferred: d.initiallyDeferred || undefined,
  };
}

/** Loose type comparison for the mismatch warning: exact match, or the same family
 *  (both integer-ish / both text-ish / both timestamp-ish). Deliberately generous —
 *  this is a hint, never a block, and a false alarm is worse than a missed one. */
export function typesCompatible(a: string, b: string): boolean {
  const norm = (t: string) => t.trim().toLowerCase().replace(/\s*\(.*\)$/, "").replace(/\s+/g, " ");
  const x = norm(a);
  const y = norm(b);
  if (!x || !y || x === y) return true;
  const family = (t: string): string => {
    if (/^(big|small|tiny|medium)?(int|integer|serial|bigserial|smallserial|int2|int4|int8|hugeint|ubigint|uinteger)/.test(t)) return "int";
    if (/^(numeric|decimal|real|double|float|money|dec)/.test(t)) return "num";
    if (/(char|text|string|clob|varchar|uuid|enum)/.test(t)) return "text";
    if (/^(timestamp|datetime|date|time)/.test(t)) return "time";
    if (/^(bool)/.test(t)) return "bool";
    if (/(binary|blob|bytea)/.test(t)) return "bin";
    return t;
  };
  return family(x) === family(y);
}

/**
 * Searchable referenced-table + referenced-column picker for a foreign key.
 *
 * Tables come from the already-loaded shallow tree (no roundtrip). Columns of the
 * CHOSEN table are fetched lazily through `loadColumns` so key columns can be listed
 * first and marked — `list_schema` knows the column names but not which are keys.
 */
export function FkEditor(props: {
  /** Columns of the table the FK is defined ON. */
  localColumns: { name: string; data_type?: string }[];
  tables: RefTable[];
  value: FkDraft;
  onChange: (patch: Partial<FkDraft>) => void;
  /** Lazy per-table detail. Resolves to null when it can't be fetched. */
  loadColumns?: (schema: string, table: string) => Promise<RefColumn[] | null>;
  /** Hide the constraint-name field (CREATE TABLE names them itself). */
  hideName?: boolean;
}) {
  const caps = () => ddlCaps();
  const [search, setSearch] = createSignal("");
  const [open, setOpen] = createSignal(false);
  const [refCols, setRefCols] = createSignal<RefColumn[] | null>(null);
  const [loading, setLoading] = createSignal(false);
  // The list is portalled to the body: inside the dialog it was clipped by the
  // scrolling modal body and painted under the fields below it.
  const [anchor, setAnchor] = createSignal({ left: 0, top: 0, width: 0 });
  let searchEl: HTMLInputElement | undefined;
  const placeList = () => {
    const r = searchEl?.getBoundingClientRect();
    if (r) setAnchor({ left: r.left, top: r.bottom + 2, width: r.width });
  };
  createEffect(() => {
    if (!open()) return;
    placeList();
    window.addEventListener("resize", placeList);
    window.addEventListener("scroll", placeList, true);
    onCleanup(() => {
      window.removeEventListener("resize", placeList);
      window.removeEventListener("scroll", placeList, true);
    });
  });

  const chosen = () => (props.value.refTable ? `${props.value.refSchema}.${props.value.refTable}` : "");

  const matches = createMemo(() => {
    const q = search().trim().toLowerCase();
    const all = props.tables;
    const hit = q ? all.filter((t) => `${t.schema}.${t.name}`.toLowerCase().includes(q)) : all;
    return hit.slice(0, 200);
  });

  // Fetch the chosen table's columns whenever it changes; fall back to the shallow
  // tree's column names (unmarked) when no loader is wired or the fetch fails.
  createEffect(
    on(
      () => chosen(),
      async (key) => {
        setRefCols(null);
        if (!key) return;
        const t = props.tables.find((x) => `${x.schema}.${x.name}` === key);
        const fallback: RefColumn[] = (t?.columns ?? []).map((c) => ({
          name: c.name,
          data_type: c.data_type ?? "",
          isKey: false,
        }));
        if (!props.loadColumns) {
          setRefCols(fallback);
          return;
        }
        setLoading(true);
        const got = await props.loadColumns(props.value.refSchema, props.value.refTable).catch(() => null);
        setLoading(false);
        if (chosen() !== key) return; // a later pick won
        setRefCols(got && got.length ? got : fallback);
      },
    ),
  );

  /** Key columns first (they are what a FK can legally point at), then the rest. */
  const orderedRefCols = createMemo(() => {
    const cols = refCols() ?? [];
    return [...cols].sort((a, b) => Number(b.isKey) - Number(a.isKey));
  });

  const localType = (name: string) => props.localColumns.find((c) => c.name === name)?.data_type ?? "";
  const refType = (name: string) => (refCols() ?? []).find((c) => c.name === name)?.data_type ?? "";

  const mismatches = createMemo(() =>
    props.value.pairs
      .filter((p) => p.local && p.ref)
      .filter((p) => {
        const a = localType(p.local);
        const b = refType(p.ref);
        return !!a && !!b && !typesCompatible(a, b);
      })
      .map((p) => `${p.local} (${localType(p.local)}) → ${p.ref} (${refType(p.ref)})`),
  );

  const setPair = (i: number, patch: Partial<{ local: string; ref: string }>) =>
    props.onChange({ pairs: props.value.pairs.map((p, k) => (k === i ? { ...p, ...patch } : p)) });
  const addPair = () => props.onChange({ pairs: [...props.value.pairs, { local: "", ref: "" }] });
  const removePair = (i: number) =>
    props.onChange({ pairs: props.value.pairs.length > 1 ? props.value.pairs.filter((_, k) => k !== i) : props.value.pairs });

  return (
    <div class="fk-editor">
      <Show when={!props.hideName}>
        <label>
          Constraint name
          <input value={props.value.name} onInput={(e) => props.onChange({ name: e.currentTarget.value })} placeholder="fk_name" />
          <small class="field-hint">Leave blank to let the server name it.</small>
        </label>
      </Show>

      <div class="field-label">References table</div>
      <div class="ref-picker">
        <input
          class="ref-search"
          ref={searchEl}
          value={open() ? search() : chosen()}
          placeholder="search schema.table…"
          onFocus={() => {
            setSearch("");
            setOpen(true);
          }}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onInput={(e) => {
            setSearch(e.currentTarget.value);
            setOpen(true);
          }}
        />
        <Show when={open()}>
          <Portal>
            <div
              class="ref-list"
              style={{ left: `${anchor().left}px`, top: `${anchor().top}px`, width: `${anchor().width}px` }}
            >
              <Show when={matches().length} fallback={<div class="ref-empty">no matching table</div>}>
                <For each={matches()}>
                  {(t) => (
                    <button
                      class="ref-item"
                      classList={{ active: chosen() === `${t.schema}.${t.name}` }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        props.onChange({
                          refSchema: t.schema,
                          refTable: t.name,
                          pairs: props.value.pairs.map((p) => ({ ...p, ref: "" })),
                        });
                        setOpen(false);
                      }}
                    >
                      <span class="muted-hint">{t.schema}.</span>
                      {t.name}
                    </button>
                  )}
                </For>
              </Show>
            </div>
          </Portal>
        </Show>
      </div>

      <div class="field-label">
        Column pairs
        <Show when={loading()}>
          <span class="muted-hint">loading referenced columns…</span>
        </Show>
      </div>
      <div class="fk-pairs">
        <For each={props.value.pairs}>
          {(p, i) => (
            <div class="fk-pair-row">
              <select value={p.local} onChange={(e) => setPair(i(), { local: e.currentTarget.value })}>
                <option value="">— column —</option>
                <For each={props.localColumns}>{(c) => <option value={c.name}>{c.name}</option>}</For>
              </select>
              <span class="fk-arrow">→</span>
              <select
                value={p.ref}
                disabled={!props.value.refTable}
                onChange={(e) => setPair(i(), { ref: e.currentTarget.value })}
              >
                <option value="">— referenced —</option>
                <For each={orderedRefCols()}>
                  {(c) => (
                    <option value={c.name}>
                      {c.name}
                      {c.isKey ? ` · ${c.keyLabel ?? "key"}` : ""}
                    </option>
                  )}
                </For>
              </select>
              <button class="icon cb-x" title="Remove pair" onClick={() => removePair(i())}>
                <Icon name="close" />
              </button>
            </div>
          )}
        </For>
        <button class="ghost full" onClick={addPair}>
          <Icon name="plus" /> Add column pair
        </button>
      </div>

      <Show when={mismatches().length}>
        <div class="warn-note">Type mismatch: {mismatches().join(", ")}</div>
      </Show>

      <div class="seg">
        <label>
          ON DELETE
          <select value={props.value.onDelete} onChange={(e) => props.onChange({ onDelete: e.currentTarget.value })}>
            <For each={REF_ACTIONS}>{(a) => <option value={a}>{a || "(default)"}</option>}</For>
          </select>
        </label>
        <Show when={caps().onUpdateAction}>
          <label>
            ON UPDATE
            <select value={props.value.onUpdate} onChange={(e) => props.onChange({ onUpdate: e.currentTarget.value })}>
              <For each={REF_ACTIONS}>{(a) => <option value={a}>{a || "(default)"}</option>}</For>
            </select>
          </label>
        </Show>
      </div>

      <Show when={caps().deferrable}>
        <label class="checkbox">
          <input
            type="checkbox"
            checked={props.value.deferrable}
            onChange={(e) => props.onChange({ deferrable: e.currentTarget.checked })}
          />
          DEFERRABLE
        </label>
        <Show when={props.value.deferrable}>
          <label class="checkbox">
            <input
              type="checkbox"
              checked={props.value.initiallyDeferred}
              onChange={(e) => props.onChange({ initiallyDeferred: e.currentTarget.checked })}
            />
            INITIALLY DEFERRED
          </label>
        </Show>
      </Show>
    </div>
  );
}
