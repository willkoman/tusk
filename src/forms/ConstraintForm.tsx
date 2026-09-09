import { createMemo, createSignal, For, Show } from "solid-js";
import { Dialog, DialogFooter } from "../Dialog";
import { SqlField } from "../SqlField";
import { addPrimaryKey, addUnique, addCheck, addForeignKey } from "../sql/ddl";
import { ddlCaps } from "../sql/ddlCaps";
import type { NodeDescriptor } from "../Tree";
import { emptyFk, fkSpecOf, FkEditor, type FkDraft, type RefColumn, type RefTable } from "./FkEditor";

type CType = "primary_key" | "unique" | "foreign_key" | "check";

export function ConstraintForm(props: {
  ctx: NodeDescriptor; // kind === "table"
  columns: string[];
  /** Column types where known, for the FK type-mismatch hint. */
  columnTypes?: Record<string, string>;
  tables: RefTable[];
  loadColumns?: (schema: string, table: string) => Promise<RefColumn[] | null>;
  onClose: () => void;
  onRun: (sql: string) => Promise<{ ok: boolean; error?: string }>;
  onEditAsSql: (sql: string) => void;
}) {
  const caps = ddlCaps();
  const [ctype, setCtype] = createSignal<CType>("primary_key");
  const [name, setName] = createSignal("");
  const [cols, setCols] = createSignal<string[]>([]);
  const [expr, setExpr] = createSignal("");
  const [fk, setFk] = createSignal<FkDraft>(emptyFk());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const toggle = (c: string) => setCols(cols().includes(c) ? cols().filter((x) => x !== c) : [...cols(), c]);
  const localColumns = () => props.columns.map((c) => ({ name: c, data_type: props.columnTypes?.[c] }));

  const sql = createMemo(() => {
    const s = props.ctx.schema!;
    const t = props.ctx.name;
    switch (ctype()) {
      case "primary_key":
        return cols().length ? addPrimaryKey(s, t, cols(), name()) : "";
      case "unique":
        return cols().length ? addUnique(s, t, cols(), name()) : "";
      case "check":
        return expr().trim() ? addCheck(s, t, expr(), name()) : "";
      case "foreign_key": {
        const spec = fkSpecOf(fk());
        return spec ? addForeignKey(s, t, spec) : "";
      }
    }
  });

  const apply = async () => {
    if (!sql()) return;
    setBusy(true);
    setError("");
    const r = await props.onRun(sql()!);
    setBusy(false);
    if (r.ok) props.onClose();
    else setError(r.error ?? "failed");
  };

  return (
    <Dialog
      title="Add constraint"
      subtitle={`${props.ctx.schema}.${props.ctx.name}`}
      size="md"
      onClose={props.onClose}
      footer={
        <DialogFooter
          sql={sql() ?? ""}
          error={error()}
          busy={busy()}
          disabled={!sql()}
          primaryLabel="Add constraint"
          onPrimary={apply}
          onEditAsSql={() => props.onEditAsSql(sql()!)}
          onCancel={props.onClose}
        />
      }
    >
      <label>
        Type
        <select value={ctype()} onChange={(e) => setCtype(e.currentTarget.value as CType)}>
          <option value="primary_key">PRIMARY KEY</option>
          <option value="unique">UNIQUE</option>
          <option value="foreign_key">FOREIGN KEY</option>
          <option value="check">CHECK</option>
        </select>
      </label>
      <Show when={ctype() === "unique" || ctype() === "check"}>
        <label>
          Name
          <input value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="constraint_name" />
          <small class="field-hint">Leave blank to let the server name it.</small>
        </label>
      </Show>

      <Show when={ctype() === "primary_key" || ctype() === "unique"}>
        <div class="field-label">Columns</div>
        <div class="chip-picker">
          <For each={props.columns}>
            {(c) => (
              <button class="chip" classList={{ active: cols().includes(c) }} onClick={() => toggle(c)}>
                {cols().includes(c) ? `${cols().indexOf(c) + 1}. ` : ""}{c}
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={ctype() === "check"}>
        <label>
          Expression
          <SqlField value={expr()} columns={props.columns} onChange={setExpr} placeholder="e.g. price > 0" />
        </label>
      </Show>

      <Show when={ctype() === "foreign_key"}>
        <FkEditor
          localColumns={localColumns()}
          tables={props.tables}
          loadColumns={props.loadColumns}
          value={fk()}
          onChange={(patch) => setFk({ ...fk(), ...patch })}
        />
      </Show>

      <Show when={!caps.addConstraint}>
        <div class="warn-note">{caps.label} adds constraints in CREATE TABLE only.</div>
      </Show>
    </Dialog>
  );
}
