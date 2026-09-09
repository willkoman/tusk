import { createMemo, createSignal } from "solid-js";
import { Dialog, DialogFooter } from "../Dialog";
import { createDatabase } from "../sql/ddl";

export function DatabaseForm(props: {
  onClose: () => void;
  onRun: (sql: string) => Promise<{ ok: boolean; error?: string }>;
  onEditAsSql: (sql: string) => void;
}) {
  const [name, setName] = createSignal("");
  const [owner, setOwner] = createSignal("");
  const [encoding, setEncoding] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const sql = createMemo(() => (name().trim() ? createDatabase(name().trim(), owner(), encoding()) : ""));

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
      title="Create database"
      size="md"
      onClose={props.onClose}
      onEnter={apply}
      footer={
        <DialogFooter
          sql={sql()}
          error={error()}
          busy={busy()}
          disabled={!sql()}
          primaryLabel="Create database"
          onPrimary={apply}
          onEditAsSql={() => props.onEditAsSql(sql())}
          onCancel={props.onClose}
        />
      }
    >
      <label>
        <span class="lbl">Name<span class="req">*</span></span>
        <input value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="database_name" />
      </label>
      <label>
        Owner
        <input value={owner()} onInput={(e) => setOwner(e.currentTarget.value)} placeholder="role" />
      </label>
      <label>
        Encoding
        <input value={encoding()} onInput={(e) => setEncoding(e.currentTarget.value)} placeholder="UTF8" />
      </label>
      <div class="import-info">Runs as a single statement, outside any transaction.</div>
    </Dialog>
  );
}
