import { createMemo, createSignal } from "solid-js";
import { Dialog, DialogFooter } from "../Dialog";

export function RenameDialog(props: {
  title: string;
  current: string;
  build: (newName: string) => string;
  onClose: () => void;
  onRun: (sql: string) => Promise<{ ok: boolean; error?: string }>;
  onEditAsSql: (sql: string) => void;
}) {
  const [name, setName] = createSignal(props.current);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const changed = () => name().trim() !== "" && name() !== props.current;
  const sql = createMemo(() => (changed() ? props.build(name().trim()) : ""));

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
        New name
        <input value={name()} onInput={(e) => setName(e.currentTarget.value)} autofocus />
      </label>
      <DialogFooter
        sql={sql()}
        error={error()}
        busy={busy()}
        disabled={!changed()}
        primaryLabel="Rename"
        onPrimary={apply}
        onEditAsSql={() => props.onEditAsSql(sql())}
        onCancel={props.onClose}
      />
    </Dialog>
  );
}
