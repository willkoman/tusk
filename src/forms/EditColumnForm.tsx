import { createMemo, createSignal, Show } from "solid-js";
import { Dialog, DialogFooter } from "../Dialog";
import { SqlField } from "../SqlField";
import { editColumn, scriptNote } from "../sql/ddl";
import { ddlCaps } from "../sql/ddlCaps";
import type { NodeDescriptor } from "../Tree";

/** Edit an existing column: rename / type / default / NOT NULL. Empty type = unchanged. */
export function EditColumnForm(props: {
  ctx: NodeDescriptor; // kind === "column", with .column set
  onClose: () => void;
  onRun: (sql: string) => Promise<{ ok: boolean; error?: string }>;
  onEditAsSql: (sql: string) => void;
}) {
  const caps = ddlCaps();
  const col = props.ctx.column!;
  const [name, setName] = createSignal(col.name);
  const [type, setType] = createSignal("");
  const [using, setUsing] = createSignal("");
  const [def, setDef] = createSignal(col.default ?? "");
  const [notNull, setNotNull] = createSignal(!col.nullable);
  const [comment, setComment] = createSignal(col.comment ?? "");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const sql = createMemo(() =>
    editColumn(props.ctx.schema!, props.ctx.table!, col.name, {
      newName: name(),
      type: type(),
      using: using(),
      setDefault: def().trim() === (col.default ?? "").trim() ? undefined : def().trim() === "" ? null : def(),
      notNull: notNull() === !col.nullable ? undefined : notNull(),
      comment: comment() === (col.comment ?? "") ? undefined : comment() === "" ? null : comment(),
      // MySQL's MODIFY COLUMN replaces the whole definition, so hand the builder the
      // column as it stands — otherwise a type change silently drops the default,
      // the comment and AUTO_INCREMENT.
      target: {
        name: col.name,
        type: col.data_type,
        nullable: col.nullable,
        default: def(),
        comment: comment(),
        identity: col.identity ?? false,
      },
    }),
  );
  const note = createMemo(() => (sql() ? scriptNote(sql(), caps) : ""));

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
      title="Edit column"
      subtitle={`${props.ctx.schema}.${props.ctx.table}.${col.name}`}
      size="md"
      onClose={props.onClose}
      footer={
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
      }
    >
      <label>
        <span class="lbl">Name<span class="req">*</span></span>
        <input value={name()} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label>
        Type
        <SqlField value={type()} typesOnly onChange={setType} placeholder={col.data_type} />
        <small class="field-hint">Empty keeps {col.data_type}.</small>
      </label>
      <Show when={caps.usingClause}>
        <label>
          USING
          <SqlField value={using()} columns={[col.name]} onChange={setUsing} placeholder={`${col.name}::text`} />
          <small class="field-hint">Cast expression for the type change.</small>
        </label>
      </Show>
      <label>
        Default
        <SqlField value={def()} columns={[col.name]} onChange={setDef} placeholder="(none)" />
        <small class="field-hint">Empty drops the default.</small>
      </label>
      <Show when={caps.comments !== "none"}>
        <label>
          Comment
          <input value={comment()} onInput={(e) => setComment(e.currentTarget.value)} placeholder="(none)" />
        </label>
      </Show>
      <label class="checkbox">
        <input type="checkbox" checked={notNull()} onChange={(e) => setNotNull(e.currentTarget.checked)} />
        NOT NULL
      </label>
      <Show when={caps.changeType === "rebuild"}>
        <div class="warn-note">
          Only the rename applies on {caps.label}. Use <b>Modify table…</b> for type, NOT NULL or default.
        </div>
      </Show>
      <Show when={note()}>
        <div class="muted-hint script-note">{note()}</div>
      </Show>
    </Dialog>
  );
}
