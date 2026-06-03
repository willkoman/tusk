import { createMemo, createSignal } from "solid-js";
import { Dialog, DialogFooter } from "../Dialog";
import { SqlField } from "../SqlField";
import { addColumn, type ColumnSpec } from "../sql/ddl";
import type { NodeDescriptor } from "../Tree";

/** Add a column to a table (visual form + live SQL preview). */
export function ColumnForm(props: {
  ctx: NodeDescriptor; // kind === "table"
  onClose: () => void;
  onRun: (sql: string) => Promise<{ ok: boolean; error?: string }>;
  onEditAsSql: (sql: string) => void;
}) {
  const [name, setName] = createSignal("");
  const [type, setType] = createSignal("text");
  const [nullable, setNullable] = createSignal(true);
  const [def, setDef] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const spec = (): ColumnSpec => ({
    name: name(),
    type: type(),
    nullable: nullable(),
    default: def(),
  });
  const sql = createMemo(() =>
    name().trim() && type().trim() ? addColumn(props.ctx.schema!, props.ctx.name, spec()) : "",
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
    <Dialog title={`Add column · ${props.ctx.name}`} onClose={props.onClose}>
      <label>
        Name
        <input value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="column_name" autofocus />
      </label>
      <label>
        Type
        <SqlField value={type()} typesOnly onChange={setType} placeholder="text" />
      </label>
      <label>
        Default (SQL expression)
        <SqlField value={def()} onChange={setDef} placeholder="e.g. now(), 0, 'active'" />
      </label>
      <label class="checkbox">
        <input type="checkbox" checked={nullable()} onChange={(e) => setNullable(e.currentTarget.checked)} />
        Nullable
      </label>
      <DialogFooter
        sql={sql()}
        error={error()}
        busy={busy()}
        disabled={!sql()}
        primaryLabel="Add column"
        onPrimary={apply}
        onEditAsSql={() => props.onEditAsSql(sql())}
        onCancel={props.onClose}
      />
    </Dialog>
  );
}
