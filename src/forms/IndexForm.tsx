import { createMemo, createSignal, For, Show } from "solid-js";
import { Dialog, DialogFooter } from "../Dialog";
import { SqlField } from "../SqlField";
import { createIndex } from "../sql/ddl";
import { ddlCaps } from "../sql/ddlCaps";
import type { NodeDescriptor } from "../Tree";

export function IndexForm(props: {
  ctx: NodeDescriptor; // kind === "table"
  columns: string[];
  onClose: () => void;
  onRun: (sql: string) => Promise<{ ok: boolean; error?: string }>;
  onEditAsSql: (sql: string) => void;
}) {
  // Access method and partial WHERE are Postgres-only / engine-dependent — the caps
  // table decides whether the control is even offered (the builder drops them anyway).
  const caps = ddlCaps();
  const [selected, setSelected] = createSignal<string[]>([]);
  const [name, setName] = createSignal("");
  const [unique, setUnique] = createSignal(false);
  const [method, setMethod] = createSignal("btree");
  const [where, setWhere] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const toggle = (c: string) =>
    setSelected((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]));

  const sql = createMemo(() =>
    selected().length
      ? createIndex({
          schema: props.ctx.schema!,
          table: props.ctx.name,
          name: name(),
          unique: unique(),
          method: method(),
          columns: selected(),
          where: where(),
        })
      : "",
  );

  const apply = async () => {
    if (!sql()) return;
    setBusy(true);
    setError("");
    const r = await props.onRun(sql());
    setBusy(false);
    if (r.ok) props.onClose();
    else setError(r.error ?? "failed");
  };

  return (
    <Dialog
      title="Add index"
      subtitle={`${props.ctx.schema}.${props.ctx.name}`}
      size="md"
      onClose={props.onClose}
      footer={
        <DialogFooter
          sql={sql()}
          error={error()}
          busy={busy()}
          disabled={!sql()}
          primaryLabel="Create index"
          onPrimary={apply}
          onEditAsSql={() => props.onEditAsSql(sql())}
          onCancel={props.onClose}
        />
      }
    >
      <label>
        Name
        <input value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="idx_name" />
        <small class="field-hint">Leave blank to let the server name it.</small>
      </label>
      <div class="field-label">Columns</div>
      <div class="field-hint">Click to add, in order.</div>
      <div class="chip-picker">
        <For each={props.columns}>
          {(c) => (
            <button
              class="chip"
              classList={{ active: selected().includes(c) }}
              onClick={() => toggle(c)}
            >
              {selected().includes(c) ? `${selected().indexOf(c) + 1}. ` : ""}{c}
            </button>
          )}
        </For>
      </div>
      <Show when={caps.indexMethod}>
        <label>
          Method
          <select value={method()} onChange={(e) => setMethod(e.currentTarget.value)}>
            <For each={["btree", "hash", "gin", "gist", "brin", "spgist"]}>{(m) => <option value={m}>{m}</option>}</For>
          </select>
        </label>
      </Show>
      <label class="checkbox">
        <input type="checkbox" checked={unique()} onChange={(e) => setUnique(e.currentTarget.checked)} />
        UNIQUE
      </label>
      <Show when={caps.partialIndex}>
        <label>
          WHERE
          <SqlField value={where()} columns={props.columns} onChange={setWhere} placeholder="e.g. active" />
          <small class="field-hint">Indexes only the rows matching this expression.</small>
        </label>
      </Show>
    </Dialog>
  );
}
