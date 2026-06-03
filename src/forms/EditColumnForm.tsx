import { createMemo, createSignal } from "solid-js";
import { Dialog, DialogFooter } from "../Dialog";
import { SqlField } from "../SqlField";
import { editColumn } from "../sql/ddl";
import type { NodeDescriptor } from "../Tree";

/** Edit an existing column: rename / type / default / NOT NULL. Empty type = unchanged. */
export function EditColumnForm(props: {
  ctx: NodeDescriptor; // kind === "column", with .column set
  onClose: () => void;
  onRun: (sql: string) => Promise<{ ok: boolean; error?: string }>;
  onEditAsSql: (sql: string) => void;
}) {
  const col = props.ctx.column!;
  const [name, setName] = createSignal(col.name);
  const [type, setType] = createSignal("");
  const [using, setUsing] = createSignal("");
  const [def, setDef] = createSignal(col.default ?? "");
  const [notNull, setNotNull] = createSignal(!col.nullable);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const sql = createMemo(() =>
    editColumn(props.ctx.schema!, props.ctx.table!, col.name, {
      newName: name(),
      type: type(),
      using: using(),
      setDefault: def().trim() === (col.default ?? "").trim() ? undefined : def().trim() === "" ? null : def(),
      notNull: notNull() === !col.nullable ? undefined : notNull(),
    }),
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
    <Dialog title={`Edit column · ${col.name}`} onClose={props.onClose}>
      <label>
        Name
        <input value={name()} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label>
        Type <span class="muted-hint">(empty = keep {col.data_type})</span>
        <SqlField value={type()} typesOnly onChange={setType} placeholder={col.data_type} />
      </label>
      <label>
        USING (cast expression, optional)
        <SqlField value={using()} columns={[col.name]} onChange={setUsing} placeholder={`${col.name}::text`} />
      </label>
      <label>
        Default (empty = drop default)
        <SqlField value={def()} columns={[col.name]} onChange={setDef} placeholder="(none)" />
      </label>
      <label class="checkbox">
        <input type="checkbox" checked={notNull()} onChange={(e) => setNotNull(e.currentTarget.checked)} />
        NOT NULL
      </label>
      <DialogFooter
        sql={sql()}
        error={error()}
        busy={busy()}
        disabled={!sql().trim()}
        primaryLabel="Apply"
        onPrimary={apply}
        onEditAsSql={() => props.onEditAsSql(sql())}
        onCancel={props.onClose}
      />
    </Dialog>
  );
}
