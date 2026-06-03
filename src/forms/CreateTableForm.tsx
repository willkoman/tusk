import { createMemo, createSignal, For } from "solid-js";
import { Dialog, DialogFooter } from "../Dialog";
import { SqlField } from "../SqlField";
import { createTable, type ColumnSpec } from "../sql/ddl";

const emptyCol = (): ColumnSpec => ({ name: "", type: "text", nullable: true, default: "", primaryKey: false });

export function CreateTableForm(props: {
  schema: string;
  onClose: () => void;
  onRun: (sql: string) => Promise<{ ok: boolean; error?: string }>;
  onEditAsSql: (sql: string) => void;
}) {
  const [name, setName] = createSignal("");
  const [cols, setCols] = createSignal<ColumnSpec[]>([
    { name: "id", type: "bigint", nullable: false, default: "", primaryKey: true },
    emptyCol(),
  ]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const update = (i: number, patch: Partial<ColumnSpec>) =>
    setCols((cs) => cs.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  const addRow = () => setCols((cs) => [...cs, emptyCol()]);
  const removeRow = (i: number) => setCols((cs) => cs.filter((_, k) => k !== i));

  const valid = () => name().trim() !== "" && cols().some((c) => c.name.trim() && c.type.trim());
  const sql = createMemo(() =>
    valid() ? createTable({ schema: props.schema, name: name().trim(), columns: cols() }) : "",
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
    <Dialog title={`Create table · ${props.schema}`} onClose={props.onClose} width={580}>
      <label>
        Table name
        <input value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="table_name" autofocus />
      </label>
      <div class="col-builder">
        <div class="col-builder-head">
          <span>Name</span>
          <span>Type</span>
          <span class="cb-flag">Null</span>
          <span class="cb-flag">PK</span>
          <span>Default</span>
          <span class="cb-x" />
        </div>
        <For each={cols()}>
          {(c, i) => (
            <div class="col-builder-row">
              <input value={c.name} onInput={(e) => update(i(), { name: e.currentTarget.value })} placeholder="name" />
              <SqlField value={c.type} typesOnly onChange={(v) => update(i(), { type: v })} placeholder="type" />
              <input class="cb-flag" type="checkbox" checked={c.nullable} onChange={(e) => update(i(), { nullable: e.currentTarget.checked })} />
              <input class="cb-flag" type="checkbox" checked={c.primaryKey} onChange={(e) => update(i(), { primaryKey: e.currentTarget.checked })} />
              <SqlField value={c.default} columns={cols().map((x) => x.name).filter(Boolean)} onChange={(v) => update(i(), { default: v })} placeholder="(none)" />
              <button class="icon cb-x" title="Remove" onClick={() => removeRow(i())}>✕</button>
            </div>
          )}
        </For>
        <button class="ghost full" onClick={addRow}>＋ Add column</button>
      </div>
      <DialogFooter
        sql={sql()}
        error={error()}
        busy={busy()}
        disabled={!valid()}
        primaryLabel="Create table"
        onPrimary={apply}
        onEditAsSql={() => props.onEditAsSql(sql())}
        onCancel={props.onClose}
      />
    </Dialog>
  );
}
