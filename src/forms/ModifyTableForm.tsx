import { createMemo, createSignal, For, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Dialog, DialogFooter } from "../Dialog";
import { SqlField } from "../SqlField";
import { tableDiff } from "../sql/ddl";
import type { Column, NodeDescriptor, RelationDetail } from "../Tree";

type Row = {
  uid: number;
  orig: { name: string; type: string; nullable: boolean; default: string; comment: string } | null;
  name: string;
  type: string;
  nullable: boolean;
  default: string;
  comment: string;
  isPk: boolean;
  origPk: boolean;
  dropped: boolean;
};

let uid = 1;
const fromColumn = (c: Column): Row => ({
  uid: uid++,
  orig: { name: c.name, type: c.data_type, nullable: c.nullable, default: c.default ?? "", comment: c.comment ?? "" },
  name: c.name,
  type: c.data_type,
  nullable: c.nullable,
  default: c.default ?? "",
  comment: c.comment ?? "",
  isPk: c.is_pk,
  origPk: c.is_pk,
  dropped: false,
});
const newRow = (): Row => ({
  uid: uid++,
  orig: null,
  name: "",
  type: "text",
  nullable: true,
  default: "",
  comment: "",
  isPk: false,
  origPk: false,
  dropped: false,
});

/** DataGrip-style table modifier: edit columns (rename/type/null/default/PK/comment),
 *  add/drop columns, drop existing indexes/constraints, rename + comment the table.
 *  The diff → ALTER script (see `tableDiff` in sql/ddl.ts) is the live preview. */
export function ModifyTableForm(props: {
  ctx: NodeDescriptor;
  detail: RelationDetail;
  onClose: () => void;
  onRun: (sql: string) => Promise<{ ok: boolean; error?: string }>;
  onEditAsSql: (sql: string) => void;
}) {
  const schema = props.ctx.schema!;
  const table = props.ctx.name;
  const [cols, setCols] = createStore<Row[]>(props.detail.columns.map(fromColumn));
  const [tableName, setTableName] = createSignal(table);
  const [tableComment, setTableComment] = createSignal(props.detail.comment ?? "");
  const [dropIdx, setDropIdx] = createSignal<Record<string, boolean>>({});
  const [dropCon, setDropCon] = createSignal<Record<string, boolean>>({});
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const colNames = () => cols.filter((r) => !r.dropped && r.name.trim()).map((r) => r.name.trim());
  const addRow = () => setCols(produce((c) => c.push(newRow())));
  const removeRow = (i: number) => {
    const r = cols[i];
    if (r.orig) setCols(i, "dropped", !r.dropped);
    else setCols(produce((c) => c.splice(i, 1)));
  };

  const sql = createMemo(() =>
    tableDiff({
      schema,
      table,
      newName: tableName(),
      newComment: tableComment(),
      origComment: props.detail.comment ?? "",
      pkName: props.detail.constraints.find((c) => c.kind === "primary_key")?.name,
      columns: cols.map((r) => ({
        orig: r.orig,
        name: r.name,
        type: r.type,
        nullable: r.nullable,
        default: r.default,
        comment: r.comment,
        isPk: r.isPk,
        origPk: r.origPk,
        dropped: r.dropped,
      })),
      dropIndexes: props.detail.indexes.filter((ix) => dropIdx()[ix.name]).map((ix) => ix.name),
      dropConstraints: props.detail.constraints.filter((c) => dropCon()[c.name]).map((c) => c.name),
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
    <Dialog title={`Modify table · ${table}`} onClose={props.onClose} width={Math.min(window.innerWidth - 80, 1100)}>
      <div class="modify-head">
        <label>Table name<input value={tableName()} onInput={(e) => setTableName(e.currentTarget.value)} /></label>
        <label>Comment<input value={tableComment()} onInput={(e) => setTableComment(e.currentTarget.value)} placeholder="(none)" /></label>
      </div>

      <div class="field-label">Columns</div>
      <div class="col-builder modify-cols">
        <div class="col-builder-head modify-row">
          <span>Name</span>
          <span>Type</span>
          <span class="cb-flag">Null</span>
          <span class="cb-flag">PK</span>
          <span>Default</span>
          <span>Comment</span>
          <span class="cb-x" />
        </div>
        <For each={cols}>
          {(c, i) => (
            <div class="col-builder-row modify-row" classList={{ "row-dropped": c.dropped, "row-new": !c.orig }}>
              <input value={c.name} disabled={c.dropped} onInput={(e) => setCols(i(), "name", e.currentTarget.value)} placeholder="name" />
              <SqlField value={c.type} typesOnly onChange={(v) => setCols(i(), "type", v)} placeholder="type" />
              <input class="cb-flag" type="checkbox" disabled={c.dropped} checked={c.nullable} onChange={(e) => setCols(i(), "nullable", e.currentTarget.checked)} />
              <input class="cb-flag" type="checkbox" disabled={c.dropped} checked={c.isPk} onChange={(e) => setCols(i(), "isPk", e.currentTarget.checked)} />
              <SqlField value={c.default} columns={colNames()} onChange={(v) => setCols(i(), "default", v)} placeholder="(none)" />
              <input value={c.comment} disabled={c.dropped} onInput={(e) => setCols(i(), "comment", e.currentTarget.value)} placeholder="(none)" />
              <button class="icon cb-x" title={c.orig ? (c.dropped ? "Keep" : "Drop column") : "Remove"} onClick={() => removeRow(i())}>
                {c.orig && c.dropped ? "↺" : "✕"}
              </button>
            </div>
          )}
        </For>
        <button class="ghost full" onClick={addRow}>＋ Add column</button>
      </div>

      <Show when={props.detail.indexes.length}>
        <div class="field-label">Indexes</div>
        <div class="drop-list">
          <For each={props.detail.indexes}>
            {(ix) => (
              <label class="checkbox drop-row" classList={{ "row-dropped": dropIdx()[ix.name] }}>
                <input
                  type="checkbox"
                  disabled={ix.primary}
                  checked={!!dropIdx()[ix.name]}
                  onChange={(e) => setDropIdx({ ...dropIdx(), [ix.name]: e.currentTarget.checked })}
                />
                <span class="mono">{ix.name}</span>
                <span class="muted-hint">{ix.primary ? "pk (managed above)" : ix.unique ? "unique" : "drop"}</span>
              </label>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.detail.constraints.length}>
        <div class="field-label">Constraints</div>
        <div class="drop-list">
          <For each={props.detail.constraints}>
            {(c) => (
              <label class="checkbox drop-row" classList={{ "row-dropped": dropCon()[c.name] }}>
                <input
                  type="checkbox"
                  checked={!!dropCon()[c.name]}
                  onChange={(e) => setDropCon({ ...dropCon(), [c.name]: e.currentTarget.checked })}
                />
                <span class="mono">{c.name}</span>
                <span class="muted-hint">{c.kind.replace("_", " ")}</span>
              </label>
            )}
          </For>
        </div>
      </Show>

      <DialogFooter
        sql={sql()}
        error={error()}
        busy={busy()}
        disabled={!sql()}
        primaryLabel="Apply changes"
        onPrimary={apply}
        onEditAsSql={() => props.onEditAsSql(sql())}
        onCancel={props.onClose}
      />
    </Dialog>
  );
}
