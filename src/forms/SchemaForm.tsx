import { createMemo, createSignal } from "solid-js";
import { Dialog, DialogFooter } from "../Dialog";
import { createSchema } from "../sql/ddl";

export function SchemaForm(props: {
  onClose: () => void;
  onRun: (sql: string) => Promise<{ ok: boolean; error?: string }>;
  onEditAsSql: (sql: string) => void;
}) {
  const [name, setName] = createSignal("");
  const [owner, setOwner] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const sql = createMemo(() => (name().trim() ? createSchema(name().trim(), owner()) : ""));

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
      title="Create schema"
      size="md"
      onClose={props.onClose}
      onEnter={apply}
      footer={
        <DialogFooter
          sql={sql()}
          error={error()}
          busy={busy()}
          disabled={!sql()}
          primaryLabel="Create schema"
          onPrimary={apply}
          onEditAsSql={() => props.onEditAsSql(sql())}
          onCancel={props.onClose}
        />
      }
    >
      <label>
        <span class="lbl">Name<span class="req">*</span></span>
        <input value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="schema_name" />
      </label>
      <label>
        Owner
        <input value={owner()} onInput={(e) => setOwner(e.currentTarget.value)} placeholder="role" />
      </label>
    </Dialog>
  );
}
