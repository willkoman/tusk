import { createMemo, createSignal } from "solid-js";
import { Dialog, DialogFooter } from "../Dialog";

export function DuplicateDialog(props: {
  title: string;
  defaultName: string;
  build: (newName: string, withData: boolean) => string;
  onClose: () => void;
  onRun: (sql: string) => Promise<{ ok: boolean; error?: string }>;
  onEditAsSql: (sql: string) => void;
}) {
  const [name, setName] = createSignal(props.defaultName);
  const [withData, setWithData] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const sql = createMemo(() => (name().trim() ? props.build(name().trim(), withData()) : ""));

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
    <Dialog title={props.title} onClose={props.onClose}>
      <label>
        New table name
        <input value={name()} onInput={(e) => setName(e.currentTarget.value)} autofocus />
      </label>
      <label class="checkbox">
        <input type="checkbox" checked={withData()} onChange={(e) => setWithData(e.currentTarget.checked)} />
        Copy data too (INSERT … SELECT)
      </label>
      <div class="import-info">Structure via LIKE … INCLUDING ALL — excludes foreign keys referencing it and triggers.</div>
      <DialogFooter
        sql={sql()}
        error={error()}
        busy={busy()}
        disabled={!name().trim()}
        primaryLabel="Duplicate"
        onPrimary={apply}
        onEditAsSql={() => props.onEditAsSql(sql())}
        onCancel={props.onClose}
      />
    </Dialog>
  );
}
