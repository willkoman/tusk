import { createMemo, createSignal, For } from "solid-js";
import { Dialog, DialogFooter } from "../Dialog";
import { SqlField } from "../SqlField";
import { createIndex } from "../sql/ddl";
import type { NodeDescriptor } from "../Tree";

export function IndexForm(props: {
  ctx: NodeDescriptor; // kind === "table"
  columns: string[];
  onClose: () => void;
  onRun: (sql: string) => Promise<{ ok: boolean; error?: string }>;
  onEditAsSql: (sql: string) => void;
}) {
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
    <Dialog title={`Add index · ${props.ctx.name}`} onClose={props.onClose}>
      <label>
        Name (optional — server auto-names if blank)
        <input value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="idx_name" />
      </label>
      <div class="field-label">Columns (click to add, in order)</div>
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
      <label>
        Method
        <select value={method()} onChange={(e) => setMethod(e.currentTarget.value)}>
          <For each={["btree", "hash", "gin", "gist", "brin", "spgist"]}>{(m) => <option value={m}>{m}</option>}</For>
        </select>
      </label>
      <label class="checkbox">
        <input type="checkbox" checked={unique()} onChange={(e) => setUnique(e.currentTarget.checked)} />
        UNIQUE
      </label>
      <label>
        WHERE (partial index, optional)
        <SqlField value={where()} columns={props.columns} onChange={setWhere} placeholder="e.g. active" />
      </label>
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
    </Dialog>
  );
}
