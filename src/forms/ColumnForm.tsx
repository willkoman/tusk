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
    <Dialog
      title="Add column"
      subtitle={`${props.ctx.schema}.${props.ctx.name}`}
      size="md"
      onClose={props.onClose}
      onEnter={apply}
      footer={
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
      }
    >
      <label>
        Name<span class="req">*</span>
        <input value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="column_name" />
      </label>
      <label>
        Type<span class="req">*</span>
        <SqlField value={type()} typesOnly onChange={setType} placeholder="text" />
      </label>
      <label>
        Default
        <SqlField value={def()} onChange={setDef} placeholder="e.g. now(), 0, 'active'" />
        <small class="field-hint">A SQL expression.</small>
      </label>
      <label class="checkbox">
        <input type="checkbox" checked={nullable()} onChange={(e) => setNullable(e.currentTarget.checked)} />
        Nullable
      </label>
    </Dialog>
  );
}
