import { createMemo, createSignal, For, Show } from "solid-js";
import { Dialog, DialogFooter } from "../Dialog";
import { SqlField } from "../SqlField";
import { addPrimaryKey, addUnique, addCheck, addForeignKey } from "../sql/ddl";
import type { NodeDescriptor } from "../Tree";

type CType = "primary_key" | "unique" | "foreign_key" | "check";
type RefTable = { schema: string; name: string; columns: { name: string }[] };

export function ConstraintForm(props: {
  ctx: NodeDescriptor; // kind === "table"
  columns: string[];
  tables: RefTable[];
  onClose: () => void;
  onRun: (sql: string) => Promise<{ ok: boolean; error?: string }>;
  onEditAsSql: (sql: string) => void;
}) {
  const [ctype, setCtype] = createSignal<CType>("primary_key");
  const [name, setName] = createSignal("");
  const [cols, setCols] = createSignal<string[]>([]);
  const [expr, setExpr] = createSignal("");
  const [refKey, setRefKey] = createSignal("");
  const [refCols, setRefCols] = createSignal<string[]>([]);
  const [onDelete, setOnDelete] = createSignal("");
  const [onUpdate, setOnUpdate] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const toggle = (sig: () => string[], set: (v: string[]) => void, c: string) =>
    set(sig().includes(c) ? sig().filter((x) => x !== c) : [...sig(), c]);

  const refTable = () => props.tables.find((t) => `${t.schema}.${t.name}` === refKey());

  const sql = createMemo(() => {
    const s = props.ctx.schema!;
    const t = props.ctx.name;
    switch (ctype()) {
      case "primary_key":
        return cols().length ? addPrimaryKey(s, t, cols()) : "";
      case "unique":
        return cols().length ? addUnique(s, t, cols(), name()) : "";
      case "check":
        return expr().trim() ? addCheck(s, t, expr(), name()) : "";
      case "foreign_key": {
        const rt = refTable();
        if (!cols().length || !rt || !refCols().length) return "";
        return addForeignKey(s, t, {
          columns: cols(),
          refSchema: rt.schema,
          refTable: rt.name,
          refColumns: refCols(),
          onDelete: onDelete() || undefined,
          onUpdate: onUpdate() || undefined,
          name: name(),
        });
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

  const actions = ["", "NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"];

  return (
    <Dialog title={`Add constraint · ${props.ctx.name}`} onClose={props.onClose} width={460}>
      <label>
        Type
        <select value={ctype()} onChange={(e) => setCtype(e.currentTarget.value as CType)}>
          <option value="primary_key">PRIMARY KEY</option>
          <option value="unique">UNIQUE</option>
          <option value="foreign_key">FOREIGN KEY</option>
          <option value="check">CHECK</option>
        </select>
      </label>
      <Show when={ctype() !== "primary_key"}>
        <label>
          Name (optional)
          <input value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="constraint_name" />
        </label>
      </Show>

      <Show when={ctype() !== "check"}>
        <div class="field-label">Columns</div>
        <div class="chip-picker">
          <For each={props.columns}>
            {(c) => (
              <button class="chip" classList={{ active: cols().includes(c) }} onClick={() => toggle(cols, setCols, c)}>
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
        <label>
          References table
          <select value={refKey()} onChange={(e) => { setRefKey(e.currentTarget.value); setRefCols([]); }}>
            <option value="">— pick —</option>
            <For each={props.tables}>{(t) => <option value={`${t.schema}.${t.name}`}>{t.schema}.{t.name}</option>}</For>
          </select>
        </label>
        <Show when={refTable()}>
          <div class="field-label">References columns</div>
          <div class="chip-picker">
            <For each={refTable()!.columns}>
              {(c) => (
                <button class="chip" classList={{ active: refCols().includes(c.name) }} onClick={() => toggle(refCols, setRefCols, c.name)}>
                  {refCols().includes(c.name) ? `${refCols().indexOf(c.name) + 1}. ` : ""}{c.name}
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="seg">
          <label>
            ON DELETE
            <select value={onDelete()} onChange={(e) => setOnDelete(e.currentTarget.value)}>
              <For each={actions}>{(a) => <option value={a}>{a || "(default)"}</option>}</For>
            </select>
          </label>
          <label>
            ON UPDATE
            <select value={onUpdate()} onChange={(e) => setOnUpdate(e.currentTarget.value)}>
              <For each={actions}>{(a) => <option value={a}>{a || "(default)"}</option>}</For>
            </select>
          </label>
        </div>
      </Show>

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
    </Dialog>
  );
}
