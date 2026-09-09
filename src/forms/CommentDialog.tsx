import { createMemo, createSignal } from "solid-js";
import { Dialog, DialogFooter } from "../Dialog";

/** Edit a COMMENT ON … object. Empty text emits `IS NULL` (removes the comment). */
export function CommentDialog(props: {
  title: string;
  /** The object the comment belongs to, shown under the title. */
  subtitle?: string;
  current: string;
  build: (text: string | null) => string;
  onClose: () => void;
  onRun: (sql: string) => Promise<{ ok: boolean; error?: string }>;
  onEditAsSql: (sql: string) => void;
}) {
  const [text, setText] = createSignal(props.current);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const sql = createMemo(() => props.build(text().trim() === "" ? null : text()));

  const apply = async () => {
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
      footer={
        <DialogFooter
          sql={sql()}
          error={error()}
          busy={busy()}
          primaryLabel="Apply"
          onPrimary={apply}
          onEditAsSql={() => props.onEditAsSql(sql())}
          onCancel={props.onClose}
        />
      }
    >
      <label>
        Comment
        <textarea
          rows={3}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          style={{ resize: "vertical", "font-family": "inherit" }}
        />
        <small class="field-hint">Empty removes the comment.</small>
      </label>
    </Dialog>
  );
}
