import { createMemo, createSignal, Show } from "solid-js";
import { Dialog, DialogFooter } from "../Dialog";

/** Destructive-op confirm (DROP / TRUNCATE): shows exact SQL + CASCADE / RESTART IDENTITY. */
export function ConfirmDialog(props: {
  title: string;
  primaryLabel: string;
  showCascade?: boolean;
  showRestartIdentity?: boolean;
  build: (o: { cascade: boolean; restartIdentity: boolean }) => string;
  onClose: () => void;
  onRun: (sql: string) => Promise<{ ok: boolean; error?: string }>;
  onEditAsSql: (sql: string) => void;
}) {
  const [cascade, setCascade] = createSignal(false);
  const [restartIdentity, setRestartIdentity] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const sql = createMemo(() => props.build({ cascade: cascade(), restartIdentity: restartIdentity() }));

  const apply = async () => {
    setBusy(true);
    setError("");
    const r = await props.onRun(sql());
    setBusy(false);
    if (r.ok) props.onClose();
    else setError(r.error ?? "failed");
  };

  return (
    <Dialog title={props.title} onClose={props.onClose}>
      <Show when={props.showCascade}>
        <label class="checkbox">
          <input type="checkbox" checked={cascade()} onChange={(e) => setCascade(e.currentTarget.checked)} />
          CASCADE (also drop dependent objects)
        </label>
      </Show>
      <Show when={props.showRestartIdentity}>
        <label class="checkbox">
          <input type="checkbox" checked={restartIdentity()} onChange={(e) => setRestartIdentity(e.currentTarget.checked)} />
          RESTART IDENTITY (reset owned sequences)
        </label>
      </Show>
      <DialogFooter
        sql={sql()}
        error={error()}
        busy={busy()}
        primaryLabel={props.primaryLabel}
        primaryDanger
        onPrimary={apply}
        onEditAsSql={() => props.onEditAsSql(sql())}
        onCancel={props.onClose}
      />
    </Dialog>
  );
}
