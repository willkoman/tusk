import { createMemo, createSignal } from "solid-js";
import { Dialog, DialogFooter } from "../Dialog";

export function DuplicateDialog(props: {
  title: string;
  /** The source object, shown under the title. */
  subtitle?: string;
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
    <Dialog
      title={props.title}
      subtitle={props.subtitle}
      size="md"
      onClose={props.onClose}
      onEnter={apply}
      footer={
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
      }
    >
      <label>
        <span class="lbl">New table name<span class="req">*</span></span>
        <input value={name()} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label class="checkbox">
        <input type="checkbox" checked={withData()} onChange={(e) => setWithData(e.currentTarget.checked)} />
        Copy data too
      </label>
      <div class="import-info">Copies columns, defaults, constraints and indexes. Incoming foreign keys and triggers are not copied.</div>
    </Dialog>
  );
}
